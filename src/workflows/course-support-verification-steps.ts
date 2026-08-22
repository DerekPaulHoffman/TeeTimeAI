import type {
  AutomationEligibility,
  AutomationReason,
  BookingAccessMode,
  BookingMethod,
  BookingWindowSource,
  CourseMonitoringMode,
  CourseSupportFailureClass,
  DetectedPlatform,
} from "@prisma/client";

import { fetchCourseTeeSheet } from "@/lib/automation/course-provider-read";
import type { AutomationPlaybookFactualDisposition } from "@/lib/automation/course-monitoring-playbook";
import {
  loadCourseMonitoringPlaybookRuntime,
  recordRuntimePlaybookTransition,
  type CourseMonitoringPlaybookRuntime,
} from "@/lib/automation/course-monitoring-playbook-runtime";
import {
  attachCourseSupportVerificationProviderSnapshot,
  buildCourseSupportProviderSnapshotFingerprint,
  completeCourseSupportVerificationFactualFinal,
  completeCourseSupportVerificationRequest,
  failCourseSupportVerificationRequest,
  heartbeatCourseSupportVerificationRequest,
  markCourseSupportVerificationDiscoveryAttempted,
  markCourseSupportVerificationDiscoveryVerified,
} from "@/lib/automation/course-support-verification";
import { prepareCourseSupportVerificationMonitoring } from "@/lib/automation/search-monitoring-discovery";
import {
  classifyProviderFailure,
  getProviderReadinessFailure,
  normalizeProviderFamilyKey,
  resolveProviderCapability,
} from "@/lib/automation/provider-capabilities";
import { evaluateMonitoringGate } from "@/lib/automation/policy";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import { getSafeOfficialBookingUrl } from "@/lib/email/search-delivery-outbox";
import {
  getLocalReaderCourseKey,
  getLocalReaderCourseVerification,
  queueLocalReaderCourseVerification,
} from "@/lib/local-reader/service";
import { prisma } from "@/lib/prisma";
import { filterSlotsForSearch } from "@/lib/tee-times/matching";

import type { CourseSupportVerificationWorkflowInput } from "./course-support-verification-contracts";

const TRANSIENT_PROVIDER_FAILURES = new Set<CourseSupportFailureClass>([
  "RATE_LIMIT",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "UNKNOWN",
]);
const TRANSIENT_RETRY_MS = 15 * 60 * 1000;
const LEASE_BUSY_RETRY_MS = 2 * 60 * 1000;
const VERIFICATION_RETRY_HORIZON_MS = 24 * 60 * 60 * 1000;
const LOCAL_READER_FALLBACK_FAILURES = new Set<CourseSupportFailureClass>([
  "AUTH",
  "CHALLENGE",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
]);
const PLAYBOOK_RETRY_MS = 2 * 60 * 1000;
const PLAYBOOK_RETRYABLE_FAILURES = new Set<CourseSupportFailureClass>([
  "RATE_LIMIT",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "UNKNOWN",
]);

const providerCourseSelect = {
  id: true,
  timeZone: true,
  website: true,
  detectedBookingUrl: true,
  providerFamilyKey: true,
  detectedPlatform: true,
  bookingMetadata: true,
  bookingWindowEvidenceUrl: true,
  bookingWindowDaysAhead: true,
  bookingReleaseTimeLocal: true,
  bookingWindowSource: true,
  bookingWindowConfidence: true,
  bookingMethod: true,
  automationEligibility: true,
  automationReason: true,
  monitoringMode: true,
  bookingAccessMode: true,
  isPublic: true,
  intelligenceVerifiedAt: true,
  intelligenceReviewAt: true,
  intelligenceConfidence: true,
  layoutHoleCounts: true,
  layoutHolesVerifiedAt: true,
} as const;

export async function executeCourseSupportVerificationStep(
  input: CourseSupportVerificationWorkflowInput,
) {
  "use step";

  const runtimeVersion = getAutomationRuntimeVersion();
  if (runtimeVersion !== input.runtimeVersion) {
    return { outcome: "runtime_mismatch" as const };
  }

  let revision = input.expectedRevision;
  const beforeDiscovery = await attachCourseSupportVerificationProviderSnapshot(
    {
      requestId: input.requestId,
      expectedRevision: revision,
      leaseToken: input.leaseToken,
      runtimeVersion,
      purpose: "PRE_EXECUTION",
    },
  );
  if (!beforeDiscovery.attached) {
    return { outcome: "stopped" as const, reason: beforeDiscovery.reason };
  }
  revision = beforeDiscovery.revision;
  const ownedCourseId = beforeDiscovery.courseId;
  const ownedIntent = beforeDiscovery.intent;

  const heartbeat = await heartbeatCourseSupportVerificationRequest({
    requestId: input.requestId,
    expectedRevision: revision,
    leaseToken: input.leaseToken,
    runtimeVersion,
  });
  if (!heartbeat.renewed) {
    return { outcome: "stopped" as const, reason: "lease_lost" as const };
  }

  const courseBeforeDiscovery = await prisma.course.findUnique({
    where: { id: ownedCourseId },
    select: providerCourseSelect,
  });
  if (!courseBeforeDiscovery) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "MISSING_SOURCE",
      providerExecution: false,
      message: "Course-support verification source is no longer available.",
    });
  }
  if (courseBeforeDiscovery.timeZone !== ownedIntent.timeZone) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message: "Course-support verification timezone changed during execution.",
    });
  }
  if (beforeDiscovery.deferredFailureConfirmation === true) {
    const currentProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(courseBeforeDiscovery);
    const currentProviderFamilyKey = normalizeProviderFamilyKey(
      courseBeforeDiscovery.providerFamilyKey,
    );
    const currentGate = evaluateMonitoringGate(courseBeforeDiscovery);
    if (
      currentProviderSnapshotFingerprint !==
        beforeDiscovery.providerSnapshotFingerprint ||
      currentProviderFamilyKey !== beforeDiscovery.providerFamilyKeySnapshot
    ) {
      return {
        outcome: "stopped" as const,
        reason: "provider_snapshot_changed" as const,
      };
    }
    if (
      courseBeforeDiscovery.monitoringMode === "LOCAL_READER_ONLY" ||
      currentGate.disposition !== "ACTIONABLE" ||
      currentGate.adapterAllowed !== true
    ) {
      return {
        outcome: "stopped" as const,
        reason: "monitoring_not_actionable" as const,
      };
    }
    return executeDeferredFailureConfirmation({
      input,
      runtimeVersion,
      revision,
      course: courseBeforeDiscovery,
      intent: ownedIntent,
      discoveryAttemptedAt: beforeDiscovery.discoveryAttemptedAt,
    });
  }
  const playbookRuntime =
    await loadCourseMonitoringPlaybookRuntime(ownedCourseId);
  if (playbookRuntime) {
    return executeOrderedCourseSupportVerification({
      input,
      runtimeVersion,
      revision,
      course: courseBeforeDiscovery,
      ownedCourseId,
      ownedIntent,
      discoveryAttemptedAt: beforeDiscovery.discoveryAttemptedAt,
      discoveryVerifiedAt: beforeDiscovery.discoveryVerifiedAt,
      playbookRuntime,
    });
  }
  const beforeDiscoveryGate = evaluateMonitoringGate(courseBeforeDiscovery);
  const beforeDiscoveryBookingUrl =
    courseBeforeDiscovery.detectedBookingUrl ?? courseBeforeDiscovery.website;
  const beforeDiscoveryReaderEligible =
    courseBeforeDiscovery.monitoringMode !== "SERVER_ONLY" &&
    courseBeforeDiscovery.monitoringMode !== "CONTACT_ONLY" &&
    getLocalReaderCourseKey(beforeDiscoveryBookingUrl) !== null;
  const localReaderOnly =
    courseBeforeDiscovery.monitoringMode === "LOCAL_READER_ONLY";
  const persistedRunnableEvidence = canUsePersistedRunnableEvidence(
    courseBeforeDiscovery,
    beforeDiscoveryGate.adapterAllowed,
    beforeDiscoveryGate.currentEvidence,
  );
  if (localReaderOnly && !beforeDiscoveryReaderEligible) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "READER_PARSER_MISSING",
      providerExecution: false,
      message:
        "Local-reader-only monitoring is configured without an allowlisted reader.",
    });
  }
  if (!beforeDiscoveryGate.adapterAllowed && !localReaderOnly) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: getMonitoringGateFailureClass(courseBeforeDiscovery),
      providerExecution: false,
      message: "Current course evidence is a terminal monitoring disposition.",
    });
  }
  if (
    beforeDiscovery.discoveryVerifiedAt &&
    !hasCoherentDiscoveryProof(
      beforeDiscovery.discoveryAttemptedAt,
      beforeDiscovery.discoveryVerifiedAt,
    )
  ) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message: "Provider discovery proof is inconsistent.",
    });
  }

  let discoveryCompletedThisRun = false;
  if (!beforeDiscovery.discoveryVerifiedAt) {
    let forceFreshDiscovery = false;
    if (!beforeDiscovery.discoveryAttemptedAt) {
      const attempted = await markCourseSupportVerificationDiscoveryAttempted({
        requestId: input.requestId,
        expectedRevision: revision,
        leaseToken: input.leaseToken,
        runtimeVersion,
      });
      if (!attempted.marked) {
        return { outcome: "stopped" as const, reason: attempted.reason };
      }
      revision = attempted.revision;
      forceFreshDiscovery = true;
    }

    let discovery: Awaited<
      ReturnType<typeof prepareCourseSupportVerificationMonitoring>
    > | null = null;
    try {
      discovery = await prepareCourseSupportVerificationMonitoring(
        ownedCourseId,
        undefined,
        new Date(),
        { forceFresh: forceFreshDiscovery },
      );
    } catch {
      if (!persistedRunnableEvidence) {
        return failVerification({
          input,
          revision,
          runtimeVersion,
          failureClass: "NETWORK",
          providerExecution: false,
          message: "Official-source verification discovery failed.",
          retryAt: new Date(Date.now() + TRANSIENT_RETRY_MS),
        });
      }
      discoveryCompletedThisRun = true;
    }

    if (discovery?.deferredCourseIds.includes(ownedCourseId)) {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "RATE_LIMIT",
        providerExecution: false,
        message: "Official-source verification discovery was deferred.",
        retryAt: new Date(Date.now() + LEASE_BUSY_RETRY_MS),
      });
    }
    if (discovery?.failedCourseIds.includes(ownedCourseId)) {
      if (!persistedRunnableEvidence) {
        return failVerification({
          input,
          revision,
          runtimeVersion,
          failureClass: "NETWORK",
          providerExecution: false,
          message: "Official-source verification discovery failed.",
          retryAt: new Date(Date.now() + TRANSIENT_RETRY_MS),
        });
      }
      discoveryCompletedThisRun = true;
    }
    if (
      discovery &&
      !discovery.failedCourseIds.includes(ownedCourseId) &&
      !discovery.attemptedCourseIds.includes(ownedCourseId)
    ) {
      const cappedRetry = discovery.retryCourseIds.includes(ownedCourseId);
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: cappedRetry ? "RATE_LIMIT" : "MISSING_SOURCE",
        providerExecution: false,
        message: cappedRetry
          ? "Official-source verification discovery is waiting for its bounded retry window."
          : "No safe official source was attempted for provider verification.",
        retryAt: cappedRetry
          ? new Date(Date.now() + TRANSIENT_RETRY_MS)
          : undefined,
      });
    }
    if (discovery?.attemptedCourseIds.includes(ownedCourseId)) {
      discoveryCompletedThisRun = true;
    }
  }

  const afterDiscovery = await attachCourseSupportVerificationProviderSnapshot({
    requestId: input.requestId,
    expectedRevision: revision,
    leaseToken: input.leaseToken,
    runtimeVersion,
    purpose: "POST_DISCOVERY",
  });
  if (!afterDiscovery.attached) {
    return { outcome: "stopped" as const, reason: afterDiscovery.reason };
  }
  revision = afterDiscovery.revision;
  if (
    afterDiscovery.courseId !== ownedCourseId ||
    !sameVerificationIntent(afterDiscovery.intent, ownedIntent)
  ) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message:
        "Course-support verification ownership changed during discovery.",
    });
  }
  const courseId = afterDiscovery.courseId;
  const intent = afterDiscovery.intent;

  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: providerCourseSelect,
  });
  if (!course) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "MISSING_SOURCE",
      providerExecution: false,
      message: "Course-support verification source is no longer available.",
    });
  }
  if (course.timeZone !== intent.timeZone) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message: "Course-support verification timezone changed during execution.",
    });
  }
  if (course.monitoringMode !== courseBeforeDiscovery.monitoringMode) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message: "Course monitoring mode changed during verification.",
      retryAt: new Date(Date.now() + TRANSIENT_RETRY_MS),
    });
  }

  const afterDiscoveryGate = evaluateMonitoringGate(course);
  if (discoveryCompletedThisRun) {
    if (!afterDiscovery.discoveryAttemptedAt) {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "SCHEMA",
        providerExecution: false,
        message: "Provider discovery attempt ownership was not preserved.",
      });
    }
    const verified = await markCourseSupportVerificationDiscoveryVerified({
      requestId: input.requestId,
      expectedRevision: revision,
      leaseToken: input.leaseToken,
      runtimeVersion,
    });
    if (!verified.marked) {
      return { outcome: "stopped" as const, reason: verified.reason };
    }
    revision = verified.revision;
  } else if (
    !hasCoherentDiscoveryProof(
      afterDiscovery.discoveryAttemptedAt,
      afterDiscovery.discoveryVerifiedAt,
    )
  ) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message:
        "Provider discovery proof changed before verification completed.",
      retryAt: new Date(Date.now() + TRANSIENT_RETRY_MS),
    });
  }

  if (!afterDiscoveryGate.adapterAllowed && !localReaderOnly) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: getMonitoringGateFailureClass(course),
      providerExecution: false,
      message: "Current course evidence is a terminal monitoring disposition.",
    });
  }

  const capability = resolveProviderCapability(course);
  const bookingUrl = course.detectedBookingUrl ?? course.website;
  const localReaderEligible =
    course.monitoringMode !== "SERVER_ONLY" &&
    course.monitoringMode !== "CONTACT_ONLY" &&
    getLocalReaderCourseKey(bookingUrl) !== null;

  const handleLocalReaderVerification = async () => {
    const readerNotBefore = afterDiscovery.discoveryAttemptedAt ?? new Date(0);
    const readerVerification = await getLocalReaderCourseVerification({
      courseId,
      targetDate: intent.targetDateLocal,
      players: intent.players,
      bookingUrl: bookingUrl!,
      notBefore: readerNotBefore,
    });
    if (readerVerification?.status === "PENDING") {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "HTTP_5XX",
        providerExecution: false,
        message: "Signed local public-page verification is pending.",
        retryAt: new Date(Date.now() + LEASE_BUSY_RETRY_MS),
      });
    }
    if (readerVerification?.status === "COMPLETED") {
      const matchingSlots = filterSlotsForSearch(
        {
          date: intent.targetDateLocal,
          startTime: intent.startTimeLocal,
          endTime: intent.endTimeLocal,
          players: intent.players,
          preferredCourses: [{ courseId, rank: 1 }],
        },
        readerVerification.slots,
      );
      const outcome = matchingSlots.length > 0 ? "MATCH_FOUND" : "NO_MATCH";
      const completed = await completeCourseSupportVerificationRequest({
        requestId: input.requestId,
        expectedRevision: revision,
        leaseToken: input.leaseToken,
        runtimeVersion,
        observation: {
          outcome,
          observedAt: readerVerification.observedAt,
          adapterKey: `LOCAL_READER:${capability.providerFamilyKey}`,
          availabilityCount: matchingSlots.length,
          providerExecution: true,
        },
      });
      return completed.completed
        ? { outcome: "completed" as const, providerOutcome: outcome }
        : { outcome: "stopped" as const, reason: completed.reason };
    }
    if (readerVerification?.status === "TERMINAL") {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass:
          readerVerification.resultStatus === "ACCESS_CHALLENGE"
            ? "CHALLENGE"
            : readerVerification.resultStatus === "PAGE_MISMATCH"
              ? "SCHEMA"
              : "UNKNOWN",
        providerExecution: true,
        message:
          readerVerification.resultStatus === "ACCESS_CHALLENGE"
            ? "The signed local public-page reader stopped at a persistent access control."
            : readerVerification.resultStatus === "PAGE_MISMATCH"
              ? "The signed local public-page reader found an unexpected page layout."
              : "The signed local public-page reader completed with an error.",
      });
    }
    if (bookingUrl) {
      await queueLocalReaderCourseVerification({
        courseId,
        targetDate: intent.targetDateLocal,
        players: intent.players,
        bookingUrl,
        notBefore: readerNotBefore,
      });
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "HTTP_5XX",
        providerExecution: false,
        message: "The required signed local-reader result is not ready.",
        retryAt: new Date(Date.now() + LEASE_BUSY_RETRY_MS),
      });
    }
    return null;
  };

  if (localReaderOnly && localReaderEligible) {
    const readerResult = await handleLocalReaderVerification();
    if (readerResult) return readerResult;
  }

  if (!capability.isRunnable) {
    if (localReaderEligible) {
      const readerResult = await handleLocalReaderVerification();
      if (readerResult) return readerResult;
    }
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass:
        getProviderReadinessFailure(capability) ?? "UNSUPPORTED_FAMILY",
      providerExecution: false,
      message: "No reusable public read-only provider adapter is runnable.",
    });
  }

  let providerExecutionStarted = false;
  try {
    const execution = await runWithProviderRequestLease(
      capability.providerFamilyKey,
      () => {
        providerExecutionStarted = true;
        return fetchCourseTeeSheet(
          course,
          new Date(`${intent.targetDateLocal}T00:00:00.000Z`),
          intent.players,
          true,
        );
      },
    );
    if (!execution.acquired) {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "RATE_LIMIT",
        providerExecution: false,
        message: "Provider verification was deferred by the concurrency guard.",
        retryAt: new Date(Date.now() + LEASE_BUSY_RETRY_MS),
      });
    }

    const unsafeBookingUrlCount = execution.value.slots.filter(
      (slot) => !getSafeOfficialBookingUrl(slot.bookingUrl),
    ).length;
    if (unsafeBookingUrlCount > 0) {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "SCHEMA",
        providerExecution: true,
        message: "The provider returned an unsafe booking destination.",
      });
    }

    const matchingSlots = filterSlotsForSearch(
      {
        date: intent.targetDateLocal,
        startTime: intent.startTimeLocal,
        endTime: intent.endTimeLocal,
        players: intent.players,
        preferredCourses: [{ courseId, rank: 1 }],
      },
      execution.value.slots,
    );
    const outcome = matchingSlots.length > 0 ? "MATCH_FOUND" : "NO_MATCH";
    const completed = await completeCourseSupportVerificationRequest({
      requestId: input.requestId,
      expectedRevision: revision,
      leaseToken: input.leaseToken,
      runtimeVersion,
      observation: {
        outcome,
        observedAt: new Date(),
        adapterKey: capability.providerFamilyKey,
        availabilityCount: matchingSlots.length,
        providerExecution: true,
      },
    });
    return completed.completed
      ? { outcome: "completed" as const, providerOutcome: outcome }
      : { outcome: "stopped" as const, reason: completed.reason };
  } catch (error) {
    const failure = classifyProviderFailure({ error });
    const failedAt = new Date();
    if (
      bookingUrl &&
      localReaderEligible &&
      LOCAL_READER_FALLBACK_FAILURES.has(failure.failureClass)
    ) {
      const readerResult = await handleLocalReaderVerification();
      if (readerResult) return readerResult;
    }
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: failure.failureClass,
      providerExecution: providerExecutionStarted,
      httpStatus: failure.httpStatus,
      retryAfterSeconds: failure.retryAfterSeconds,
      message: "Public provider availability verification failed.",
      retryAt:
        LOCAL_READER_FALLBACK_FAILURES.has(failure.failureClass) &&
        localReaderEligible
          ? new Date(failedAt.getTime() + LEASE_BUSY_RETRY_MS)
          : TRANSIENT_PROVIDER_FAILURES.has(failure.failureClass)
            ? getTransientProviderRetryAt(failedAt, failure.retryAfterSeconds)
            : null,
    });
  }
}

async function executeDeferredFailureConfirmation(input: {
  input: CourseSupportVerificationWorkflowInput;
  revision: number;
  runtimeVersion: string;
  course: VerificationCourse;
  intent: VerificationIntent;
  discoveryAttemptedAt: Date | null;
}) {
  const capability = resolveProviderCapability(input.course);
  if (!capability.isRunnable) {
    return failVerification({
      input: input.input,
      revision: input.revision,
      runtimeVersion: input.runtimeVersion,
      failureClass:
        getProviderReadinessFailure(capability) ?? "UNSUPPORTED_FAMILY",
      providerExecution: false,
      message:
        "The exact deferred confirmation no longer has a runnable public adapter.",
    });
  }

  let revision = input.revision;
  let discoveryAttemptedAt = input.discoveryAttemptedAt;
  if (!discoveryAttemptedAt) {
    const attempted = await markCourseSupportVerificationDiscoveryAttempted({
      requestId: input.input.requestId,
      expectedRevision: revision,
      leaseToken: input.input.leaseToken,
      runtimeVersion: input.runtimeVersion,
      now: new Date(),
    });
    if (!attempted.marked) {
      return { outcome: "stopped" as const, reason: attempted.reason };
    }
    revision = attempted.revision;
    discoveryAttemptedAt = attempted.discoveryAttemptedAt;
  }

  let providerReadFailed = false;
  let providerReadError: unknown = null;
  let execution:
    | {
        acquired: true;
        value: Awaited<ReturnType<typeof fetchCourseTeeSheet>>;
      }
    | { acquired: false };
  try {
    execution = await runWithProviderRequestLease<
      Awaited<ReturnType<typeof fetchCourseTeeSheet>>
    >(capability.providerFamilyKey, async () => {
      try {
        return await fetchCourseTeeSheet(
          input.course,
          new Date(`${input.intent.targetDateLocal}T00:00:00.000Z`),
          input.intent.players,
          true,
        );
      } catch (error) {
        providerReadFailed = true;
        providerReadError = error;
        throw error;
      }
    });
  } catch (error) {
    if (!providerReadFailed) {
      throw error;
    }
    const failure = classifyProviderFailure({
      error: providerReadError,
    });
    const failedAt = new Date();
    return failVerification({
      input: input.input,
      revision,
      runtimeVersion: input.runtimeVersion,
      failureClass: failure.failureClass,
      providerExecution: true,
      httpStatus: failure.httpStatus,
      retryAfterSeconds: failure.retryAfterSeconds,
      retryAt: TRANSIENT_PROVIDER_FAILURES.has(failure.failureClass)
        ? getTransientProviderRetryAt(failedAt, failure.retryAfterSeconds)
        : null,
      message: "The exact deferred provider confirmation failed.",
    });
  }
  if (!execution.acquired) {
    return failVerification({
      input: input.input,
      revision,
      runtimeVersion: input.runtimeVersion,
      failureClass: "RATE_LIMIT",
      providerExecution: false,
      message:
        "The exact deferred confirmation could not acquire its provider read lease.",
      retryAt: new Date(Date.now() + LEASE_BUSY_RETRY_MS),
    });
  }
  if (
    execution.value.slots.some(
      (slot) => !getSafeOfficialBookingUrl(slot.bookingUrl),
    )
  ) {
    return failVerification({
      input: input.input,
      revision,
      runtimeVersion: input.runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: true,
      message:
        "The exact deferred confirmation returned an unsafe booking destination.",
    });
  }
  const matchingSlots = filterSlotsForSearch(
    {
      date: input.intent.targetDateLocal,
      startTime: input.intent.startTimeLocal,
      endTime: input.intent.endTimeLocal,
      players: input.intent.players,
      preferredCourses: [{ courseId: input.course.id, rank: 1 }],
    },
    execution.value.slots,
  );
  const outcome = matchingSlots.length > 0 ? "MATCH_FOUND" : "NO_MATCH";
  const observedAt = new Date();
  const verified = await markCourseSupportVerificationDiscoveryVerified({
    requestId: input.input.requestId,
    expectedRevision: revision,
    leaseToken: input.input.leaseToken,
    runtimeVersion: input.runtimeVersion,
    now: observedAt,
  });
  if (!verified.marked) {
    return { outcome: "stopped" as const, reason: verified.reason };
  }
  const completed = await completeCourseSupportVerificationRequest({
    requestId: input.input.requestId,
    expectedRevision: verified.revision,
    leaseToken: input.input.leaseToken,
    runtimeVersion: input.runtimeVersion,
    observation: {
      outcome,
      observedAt,
      adapterKey: capability.providerFamilyKey,
      availabilityCount: matchingSlots.length,
      providerExecution: true,
    },
  });
  return completed.completed
    ? { outcome: "completed" as const, providerOutcome: outcome }
    : { outcome: "stopped" as const, reason: completed.reason };
}

type VerificationCourse = {
  id: string;
  timeZone: string;
  website: string | null;
  detectedBookingUrl: string | null;
  providerFamilyKey: string;
  detectedPlatform: DetectedPlatform;
  bookingMetadata: unknown;
  bookingWindowEvidenceUrl: string | null;
  bookingWindowDaysAhead: number | null;
  bookingReleaseTimeLocal: string | null;
  bookingWindowSource: BookingWindowSource | null;
  bookingWindowConfidence: number | null;
  bookingMethod: BookingMethod;
  automationEligibility: AutomationEligibility;
  automationReason: AutomationReason;
  monitoringMode: CourseMonitoringMode;
  bookingAccessMode: BookingAccessMode;
  isPublic: boolean | null;
  intelligenceVerifiedAt: Date | null;
  intelligenceReviewAt: Date | null;
  intelligenceConfidence: number | null;
  layoutHoleCounts: number[];
  layoutHolesVerifiedAt: Date | null;
};

type VerificationIntent = {
  targetDateLocal: string;
  startTimeLocal: string;
  endTimeLocal: string;
  timeZone: string;
  players: number;
};

async function executeOrderedCourseSupportVerification(input: {
  input: CourseSupportVerificationWorkflowInput;
  runtimeVersion: string;
  revision: number;
  course: VerificationCourse;
  ownedCourseId: string;
  ownedIntent: VerificationIntent;
  discoveryAttemptedAt: Date | null;
  discoveryVerifiedAt: Date | null;
  playbookRuntime: CourseMonitoringPlaybookRuntime;
}) {
  let revision = input.revision;
  let course = input.course;
  let discoveryAttemptedAt = input.discoveryAttemptedAt;
  let discoveryVerifiedAt = input.discoveryVerifiedAt;
  const runtime = input.playbookRuntime;
  const localReaderOnly = course.monitoringMode === "LOCAL_READER_ONLY";

  if (
    runtime.assessment.conclusion === "FACTUAL_FINAL" &&
    runtime.assessment.factualDisposition
  ) {
    return completeFactualVerification({
      input: input.input,
      revision,
      runtimeVersion: input.runtimeVersion,
      disposition: runtime.assessment.factualDisposition,
      message: getFactualDispositionMessage(
        runtime.assessment.factualDisposition,
      ),
    });
  }
  if (
    discoveryVerifiedAt &&
    !hasCoherentDiscoveryProof(discoveryAttemptedAt, discoveryVerifiedAt)
  ) {
    return failVerification({
      input: input.input,
      revision,
      runtimeVersion: input.runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message: "Provider discovery proof is inconsistent.",
    });
  }
  if (runtime.assessment.conclusion === "MONITORING_RESTORED") {
    const succeededAdapter = runtime.assessment.stages.find(
      (candidate) =>
        isProviderAdapterPlaybookStage(candidate.stage) &&
        candidate.status === "SUCCEEDED",
    );
    if (
      succeededAdapter &&
      isProviderAdapterPlaybookStage(succeededAdapter.stage)
    ) {
      const recovery = await executePlaybookAdapterStage({
        input: input.input,
        revision,
        runtime,
        runtimeVersion: input.runtimeVersion,
        stage: succeededAdapter.stage,
        course,
        intent: input.ownedIntent,
        discoveryAttemptedAt,
        discoveryVerifiedAt,
        transitionMode: "REUSE_SUCCEEDED",
      });
      if (recovery.outcome === "returned") {
        return recovery.value;
      }
      return failVerification({
        input: input.input,
        revision: recovery.revision,
        runtimeVersion: input.runtimeVersion,
        failureClass: "SCHEMA",
        providerExecution: false,
        message:
          "The concluded adapter proof could not be recovered for this request.",
      });
    }
    const succeededLocalReader = runtime.assessment.stages.find(
      (candidate) =>
        candidate.stage === "LOCAL_READER" && candidate.status === "SUCCEEDED",
    );
    if (succeededLocalReader) {
      return recoverSucceededPlaybookLocalReader({
        input: input.input,
        revision,
        runtimeVersion: input.runtimeVersion,
        course,
        intent: input.ownedIntent,
        discoveryAttemptedAt,
        discoveryVerifiedAt,
        priorSucceededAt: succeededLocalReader.completedAt
          ? new Date(succeededLocalReader.completedAt)
          : null,
      });
    }
  }
  if (runtime.assessment.conclusion !== "INCOMPLETE") {
    return failVerification({
      input: input.input,
      revision,
      runtimeVersion: input.runtimeVersion,
      failureClass: "MISSING_SOURCE",
      providerExecution: false,
      message:
        "The current ordered verification cycle already has a truthful endpoint.",
    });
  }

  for (let guard = 0; guard < 12; guard += 1) {
    const stage = runtime.assessment.nextStage;
    if (!stage) {
      return failVerification({
        input: input.input,
        revision,
        runtimeVersion: input.runtimeVersion,
        failureClass: "MISSING_SOURCE",
        providerExecution: false,
        message:
          "The ordered verification cycle completed without runnable monitoring.",
      });
    }

    if (stage === "OFFICIAL_IDENTITY") {
      const factualDisposition = getCurrentFactualDisposition(course);
      if (factualDisposition) {
        await requireRecordedPlaybookTransition(runtime, {
          stage,
          transition: "FACTUAL_FINAL",
          readPath: "OFFICIAL_IDENTITY",
          evidenceKind: "OFFICIAL_SOURCE",
          factualDisposition: factualDisposition.disposition,
          runtimeVersion: input.runtimeVersion,
        });
        return completeFactualVerification({
          input: input.input,
          revision,
          runtimeVersion: input.runtimeVersion,
          disposition: factualDisposition.disposition,
          message: factualDisposition.message,
        });
      }
      await requireRecordedPlaybookTransition(runtime, {
        stage,
        transition: "COMPLETED",
        readPath: "OFFICIAL_IDENTITY",
        evidenceKind: "OFFICIAL_SOURCE",
        runtimeVersion: input.runtimeVersion,
      });
      continue;
    }

    if (
      localReaderOnly &&
      [
        "TYPED_ADAPTER",
        "OFFICIAL_HTTP_DISCOVERY",
        "HTTP_ADAPTER_RETRY",
        "RENDERED_BROWSER_DISCOVERY",
        "BROWSER_ADAPTER_RETRY",
      ].includes(stage)
    ) {
      await requireRecordedPlaybookTransition(runtime, {
        stage,
        transition: "NOT_APPLICABLE",
        readPath: getPlaybookReadPath(stage),
        evidenceKind: "TOOLING",
        skipReason: "MONITORING_MODE_EXCLUDED",
        runtimeVersion: input.runtimeVersion,
      });
      continue;
    }

    if (
      stage === "TYPED_ADAPTER" ||
      stage === "HTTP_ADAPTER_RETRY" ||
      stage === "BROWSER_ADAPTER_RETRY"
    ) {
      const adapterResult = await executePlaybookAdapterStage({
        input: input.input,
        revision,
        runtime,
        runtimeVersion: input.runtimeVersion,
        stage,
        course,
        intent: input.ownedIntent,
        discoveryAttemptedAt,
        discoveryVerifiedAt,
      });
      if (adapterResult.outcome === "returned") {
        return adapterResult.value;
      }
      revision = adapterResult.revision;
      discoveryAttemptedAt = adapterResult.discoveryAttemptedAt;
      discoveryVerifiedAt = adapterResult.discoveryVerifiedAt;
      continue;
    }

    if (stage === "OFFICIAL_HTTP_DISCOVERY") {
      const stageAssessment = runtime.assessment.stages.find(
        (candidate) => candidate.stage === stage,
      );
      if (!discoveryAttemptedAt) {
        const attempted = await markCourseSupportVerificationDiscoveryAttempted(
          {
            requestId: input.input.requestId,
            expectedRevision: revision,
            leaseToken: input.input.leaseToken,
            runtimeVersion: input.runtimeVersion,
          },
        );
        if (!attempted.marked) {
          return { outcome: "stopped" as const, reason: attempted.reason };
        }
        revision = attempted.revision;
        discoveryAttemptedAt = attempted.discoveryAttemptedAt;
        discoveryVerifiedAt = attempted.discoveryVerifiedAt;
      }

      let discovery: Awaited<
        ReturnType<typeof prepareCourseSupportVerificationMonitoring>
      > | null = null;
      let discoveryFailure: CourseSupportFailureClass | null = null;
      try {
        discovery = await prepareCourseSupportVerificationMonitoring(
          input.ownedCourseId,
          undefined,
          new Date(),
          { forceFresh: true },
        );
      } catch {
        discoveryFailure = "NETWORK";
      }
      if (discovery?.deferredCourseIds.includes(input.ownedCourseId)) {
        discoveryFailure = "RATE_LIMIT";
      } else if (discovery?.failedCourseIds.includes(input.ownedCourseId)) {
        discoveryFailure = "NETWORK";
      } else if (
        discovery &&
        !discovery.attemptedCourseIds.includes(input.ownedCourseId)
      ) {
        discoveryFailure = discovery.retryCourseIds.includes(
          input.ownedCourseId,
        )
          ? "RATE_LIMIT"
          : "MISSING_SOURCE";
      }

      if (discoveryFailure) {
        const retryable =
          PLAYBOOK_RETRYABLE_FAILURES.has(discoveryFailure) &&
          (stageAssessment?.attemptCount ?? 0) < 1;
        await requireRecordedPlaybookTransition(runtime, {
          stage,
          transition: retryable ? "FAILED_RETRYABLE" : "FAILED_TERMINAL",
          readPath: "OFFICIAL_HTTP",
          evidenceKind: "TOOLING",
          failureClass: discoveryFailure,
          runtimeVersion: input.runtimeVersion,
        });
        if (retryable) {
          return failVerification({
            input: input.input,
            revision,
            runtimeVersion: input.runtimeVersion,
            failureClass: discoveryFailure,
            providerExecution: false,
            message:
              "Official public-source discovery will receive its bounded retry.",
            retryAt: new Date(Date.now() + PLAYBOOK_RETRY_MS),
          });
        }
        continue;
      }

      const afterDiscovery =
        await attachCourseSupportVerificationProviderSnapshot({
          requestId: input.input.requestId,
          expectedRevision: revision,
          leaseToken: input.input.leaseToken,
          runtimeVersion: input.runtimeVersion,
          purpose: "POST_DISCOVERY",
        });
      if (!afterDiscovery.attached) {
        return { outcome: "stopped" as const, reason: afterDiscovery.reason };
      }
      revision = afterDiscovery.revision;
      discoveryAttemptedAt = afterDiscovery.discoveryAttemptedAt;
      discoveryVerifiedAt = afterDiscovery.discoveryVerifiedAt;
      if (
        afterDiscovery.courseId !== input.ownedCourseId ||
        !sameVerificationIntent(afterDiscovery.intent, input.ownedIntent)
      ) {
        return failVerification({
          input: input.input,
          revision,
          runtimeVersion: input.runtimeVersion,
          failureClass: "SCHEMA",
          providerExecution: false,
          message:
            "Course-support verification ownership changed during discovery.",
        });
      }
      const refreshedCourse = await prisma.course.findUnique({
        where: { id: input.ownedCourseId },
        select: providerCourseSelect,
      });
      if (!refreshedCourse) {
        return failVerification({
          input: input.input,
          revision,
          runtimeVersion: input.runtimeVersion,
          failureClass: "MISSING_SOURCE",
          providerExecution: false,
          message: "Course-support verification source is no longer available.",
        });
      }
      course = refreshedCourse;
      const verified = await markCourseSupportVerificationDiscoveryVerified({
        requestId: input.input.requestId,
        expectedRevision: revision,
        leaseToken: input.input.leaseToken,
        runtimeVersion: input.runtimeVersion,
      });
      if (!verified.marked) {
        return { outcome: "stopped" as const, reason: verified.reason };
      }
      revision = verified.revision;
      discoveryAttemptedAt = verified.discoveryAttemptedAt;
      discoveryVerifiedAt = verified.discoveryVerifiedAt;
      await requireRecordedPlaybookTransition(runtime, {
        stage,
        transition: "COMPLETED",
        readPath: "OFFICIAL_HTTP",
        evidenceKind: "OFFICIAL_SOURCE",
        runtimeVersion: input.runtimeVersion,
      });
      continue;
    }

    if (stage === "RENDERED_BROWSER_DISCOVERY") {
      return failVerification({
        input: input.input,
        revision,
        runtimeVersion: input.runtimeVersion,
        failureClass: "MISSING_METADATA",
        providerExecution: false,
        message: "Ordinary rendered-page discovery is the next ordered stage.",
        retryAt: new Date(Date.now() + PLAYBOOK_RETRY_MS),
      });
    }

    if (stage === "LOCAL_READER") {
      const bookingUrl = course.detectedBookingUrl ?? course.website;
      const localReaderEligible =
        course.monitoringMode !== "SERVER_ONLY" &&
        course.monitoringMode !== "CONTACT_ONLY" &&
        getLocalReaderCourseKey(bookingUrl) !== null;
      if (!localReaderEligible || !bookingUrl) {
        await requireRecordedPlaybookTransition(runtime, {
          stage,
          transition: "NOT_APPLICABLE",
          readPath: "LOCAL_READER",
          evidenceKind: "TOOLING",
          skipReason: "NO_LOCAL_READER_CAPABILITY",
          runtimeVersion: input.runtimeVersion,
        });
        continue;
      }

      if (!discoveryAttemptedAt) {
        const attempted = await markCourseSupportVerificationDiscoveryAttempted(
          {
            requestId: input.input.requestId,
            expectedRevision: revision,
            leaseToken: input.input.leaseToken,
            runtimeVersion: input.runtimeVersion,
            now: new Date(),
          },
        );
        if (!attempted.marked) {
          return { outcome: "stopped" as const, reason: attempted.reason };
        }
        revision = attempted.revision;
        discoveryAttemptedAt = attempted.discoveryAttemptedAt;
        discoveryVerifiedAt = attempted.discoveryVerifiedAt;
      }

      const browserStage = runtime.assessment.stages.find(
        (candidate) => candidate.stage === "RENDERED_BROWSER_DISCOVERY",
      );
      const browserAdapterRetryStage = runtime.assessment.stages.find(
        (candidate) => candidate.stage === "BROWSER_ADAPTER_RETRY",
      );
      const notBefore = [
        browserStage?.completedAt ? new Date(browserStage.completedAt) : null,
        browserAdapterRetryStage?.completedAt
          ? new Date(browserAdapterRetryStage.completedAt)
          : null,
        discoveryAttemptedAt,
      ].reduce<Date>(
        (latest, candidate) =>
          candidate && candidate.getTime() > latest.getTime()
            ? candidate
            : latest,
        new Date(0),
      );
      const readerVerification = await getLocalReaderCourseVerification({
        courseId: course.id,
        targetDate: input.ownedIntent.targetDateLocal,
        players: input.ownedIntent.players,
        bookingUrl,
        notBefore,
      });
      const currentReaderResult = Boolean(
        readerVerification &&
        readerVerification.status !== "PENDING" &&
        readerVerification.observedAt.getTime() >= notBefore.getTime(),
      );
      if (readerVerification?.status === "COMPLETED" && currentReaderResult) {
        if (
          readerVerification.slots.some(
            (slot) => !getSafeOfficialBookingUrl(slot.bookingUrl),
          )
        ) {
          return failVerification({
            input: input.input,
            revision,
            runtimeVersion: input.runtimeVersion,
            failureClass: "SCHEMA",
            providerExecution: true,
            message:
              "The signed local reader returned an unsafe booking destination.",
          });
        }
        const matchingSlots = filterSlotsForSearch(
          {
            date: input.ownedIntent.targetDateLocal,
            startTime: input.ownedIntent.startTimeLocal,
            endTime: input.ownedIntent.endTimeLocal,
            players: input.ownedIntent.players,
            preferredCourses: [{ courseId: course.id, rank: 1 }],
          },
          readerVerification.slots,
        );
        const outcome = matchingSlots.length > 0 ? "MATCH_FOUND" : "NO_MATCH";
        const verified = await markCourseSupportVerificationDiscoveryVerified({
          requestId: input.input.requestId,
          expectedRevision: revision,
          leaseToken: input.input.leaseToken,
          runtimeVersion: input.runtimeVersion,
          now: new Date(),
        });
        if (!verified.marked) {
          return { outcome: "stopped" as const, reason: verified.reason };
        }
        revision = verified.revision;
        discoveryAttemptedAt = verified.discoveryAttemptedAt;
        discoveryVerifiedAt = verified.discoveryVerifiedAt;
        if (
          !hasCoherentDiscoveryProof(discoveryAttemptedAt, discoveryVerifiedAt)
        ) {
          return {
            outcome: "stopped" as const,
            reason: "discovery_not_verified",
          };
        }
        await requireRecordedPlaybookTransition(runtime, {
          stage,
          transition: "SUCCEEDED",
          readPath: "LOCAL_READER",
          evidenceKind: "LOCAL_READER_RESULT",
          runtimeVersion: readerVerification.readerVersion,
          now: readerVerification.observedAt,
        });
        const completed = await completeCourseSupportVerificationRequest({
          requestId: input.input.requestId,
          expectedRevision: revision,
          leaseToken: input.input.leaseToken,
          runtimeVersion: input.runtimeVersion,
          observation: {
            outcome,
            observedAt: readerVerification.observedAt,
            adapterKey: `LOCAL_READER:${resolveProviderCapability(course).providerFamilyKey}`,
            availabilityCount: matchingSlots.length,
            providerExecution: true,
          },
        });
        return completed.completed
          ? { outcome: "completed" as const, providerOutcome: outcome }
          : { outcome: "stopped" as const, reason: completed.reason };
      }
      if (readerVerification?.status === "TERMINAL" && currentReaderResult) {
        if (readerVerification.resultStatus === "ACCESS_CHALLENGE") {
          await requireRecordedPlaybookTransition(runtime, {
            stage,
            transition: "TECHNICAL_LIMITATION",
            readPath: "LOCAL_READER",
            evidenceKind: "LOCAL_READER_RESULT",
            technicalReason: "CAPTCHA_OR_QUEUE",
            runtimeVersion: readerVerification.readerVersion,
            now: readerVerification.observedAt,
          });
          return failVerification({
            input: input.input,
            revision,
            runtimeVersion: input.runtimeVersion,
            failureClass: "CHALLENGE",
            providerExecution: true,
            message:
              "Independent current confirmation is required after the terminal signed-reader observation.",
            retryAt: new Date(Date.now() + PLAYBOOK_RETRY_MS),
          });
        }
        await requireRecordedPlaybookTransition(runtime, {
          stage,
          transition: "FAILED_TERMINAL",
          readPath: "LOCAL_READER",
          evidenceKind:
            readerVerification.resultStatus === "EXPIRED"
              ? "TOOLING"
              : "LOCAL_READER_RESULT",
          failureClass:
            readerVerification.resultStatus === "EXPIRED"
              ? "TIMEOUT"
              : readerVerification.resultStatus === "PAGE_MISMATCH"
                ? "SCHEMA"
                : "UNKNOWN",
          runtimeVersion:
            readerVerification.readerVersion ?? input.runtimeVersion,
          now: readerVerification.observedAt,
        });
        continue;
      }

      const currentLocalStage = runtime.assessment.stages.find(
        (candidate) => candidate.stage === stage,
      );
      if (currentLocalStage?.status !== "STARTED") {
        await requireRecordedPlaybookTransition(runtime, {
          stage,
          transition: "STARTED",
          readPath: "LOCAL_READER",
          evidenceKind: "TOOLING",
          runtimeVersion: input.runtimeVersion,
        });
      }
      if (readerVerification?.status !== "PENDING") {
        await queueLocalReaderCourseVerification({
          courseId: course.id,
          targetDate: input.ownedIntent.targetDateLocal,
          players: input.ownedIntent.players,
          bookingUrl,
          notBefore,
        });
      }
      return failVerification({
        input: input.input,
        revision,
        runtimeVersion: input.runtimeVersion,
        failureClass: "HTTP_5XX",
        providerExecution: false,
        message:
          "The signed local public-page verification is in its bounded window.",
        retryAt: new Date(Date.now() + PLAYBOOK_RETRY_MS),
      });
    }

    if (stage === "INDEPENDENT_CONFIRMATION") {
      return failVerification({
        input: input.input,
        revision,
        runtimeVersion: input.runtimeVersion,
        failureClass:
          runtime.localReaderTechnicalReason === "ACCOUNT_REQUIRED"
            ? "AUTH"
            : runtime.localReaderTechnicalReason
              ? "CHALLENGE"
              : "MISSING_SOURCE",
        providerExecution: false,
        message:
          "A fresh independent public-page observation is still required.",
        retryAt: new Date(Date.now() + PLAYBOOK_RETRY_MS),
      });
    }
  }

  return failVerification({
    input: input.input,
    revision,
    runtimeVersion: input.runtimeVersion,
    failureClass: "SCHEMA",
    providerExecution: false,
    message: "The ordered verification stage guard was exceeded.",
  });
}

function isProviderAdapterPlaybookStage(
  stage: string,
): stage is "TYPED_ADAPTER" | "HTTP_ADAPTER_RETRY" | "BROWSER_ADAPTER_RETRY" {
  return (
    stage === "TYPED_ADAPTER" ||
    stage === "HTTP_ADAPTER_RETRY" ||
    stage === "BROWSER_ADAPTER_RETRY"
  );
}

async function executePlaybookAdapterStage(input: {
  input: CourseSupportVerificationWorkflowInput;
  revision: number;
  runtime: CourseMonitoringPlaybookRuntime;
  runtimeVersion: string;
  stage: "TYPED_ADAPTER" | "HTTP_ADAPTER_RETRY" | "BROWSER_ADAPTER_RETRY";
  course: VerificationCourse;
  intent: VerificationIntent;
  discoveryAttemptedAt: Date | null;
  discoveryVerifiedAt: Date | null;
  transitionMode?: "RECORD" | "REUSE_SUCCEEDED";
}): Promise<
  | {
      outcome: "continued";
      revision: number;
      discoveryAttemptedAt: Date | null;
      discoveryVerifiedAt: Date | null;
    }
  | {
      outcome: "returned";
      value:
        | { outcome: "completed"; providerOutcome: "MATCH_FOUND" | "NO_MATCH" }
        | { outcome: "failed"; retryable: boolean }
        | { outcome: "stopped"; reason: string };
    }
> {
  const recoveryStartedWithAttempt = Boolean(input.discoveryAttemptedAt);
  const capability = resolveProviderCapability(input.course);
  if (!capability.isRunnable) {
    if (input.transitionMode === "REUSE_SUCCEEDED") {
      return {
        outcome: "returned",
        value: await failVerification({
          input: input.input,
          revision: input.revision,
          runtimeVersion: input.runtimeVersion,
          failureClass:
            getProviderReadinessFailure(capability) ?? "UNSUPPORTED_FAMILY",
          providerExecution: false,
          message:
            "The previously successful provider adapter is no longer runnable.",
        }),
      };
    }
    await requireRecordedPlaybookTransition(input.runtime, {
      stage: input.stage,
      transition: "NOT_APPLICABLE",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "TOOLING",
      skipReason: "NO_RUNNABLE_ADAPTER",
      runtimeVersion: input.runtimeVersion,
    });
    return {
      outcome: "continued",
      revision: input.revision,
      discoveryAttemptedAt: input.discoveryAttemptedAt,
      discoveryVerifiedAt: input.discoveryVerifiedAt,
    };
  }

  let revision = input.revision;
  let discoveryAttemptedAt = input.discoveryAttemptedAt;
  let discoveryVerifiedAt = input.discoveryVerifiedAt;
  if (!discoveryAttemptedAt) {
    const attempted = await markCourseSupportVerificationDiscoveryAttempted({
      requestId: input.input.requestId,
      expectedRevision: revision,
      leaseToken: input.input.leaseToken,
      runtimeVersion: input.runtimeVersion,
      now: new Date(),
    });
    if (!attempted.marked) {
      return {
        outcome: "returned",
        value: { outcome: "stopped", reason: attempted.reason },
      };
    }
    revision = attempted.revision;
    discoveryAttemptedAt = attempted.discoveryAttemptedAt;
    discoveryVerifiedAt = attempted.discoveryVerifiedAt;
  }

  let providerExecutionStarted = false;
  let failure: {
    failureClass: CourseSupportFailureClass;
    httpStatus: number | null;
    retryAfterSeconds: number | null;
  } | null = null;
  try {
    const execution = await runWithProviderRequestLease(
      capability.providerFamilyKey,
      () => {
        providerExecutionStarted = true;
        return fetchCourseTeeSheet(
          input.course,
          new Date(`${input.intent.targetDateLocal}T00:00:00.000Z`),
          input.intent.players,
          true,
        );
      },
    );
    if (!execution.acquired) {
      failure = {
        failureClass: "RATE_LIMIT",
        httpStatus: null,
        retryAfterSeconds: null,
      };
    } else if (
      execution.value.slots.some(
        (slot) => !getSafeOfficialBookingUrl(slot.bookingUrl),
      )
    ) {
      failure = {
        failureClass: "SCHEMA",
        httpStatus: null,
        retryAfterSeconds: null,
      };
    } else {
      const matchingSlots = filterSlotsForSearch(
        {
          date: input.intent.targetDateLocal,
          startTime: input.intent.startTimeLocal,
          endTime: input.intent.endTimeLocal,
          players: input.intent.players,
          preferredCourses: [{ courseId: input.course.id, rank: 1 }],
        },
        execution.value.slots,
      );
      const outcome = matchingSlots.length > 0 ? "MATCH_FOUND" : "NO_MATCH";
      const observedAt = new Date();
      const verified = await markCourseSupportVerificationDiscoveryVerified({
        requestId: input.input.requestId,
        expectedRevision: revision,
        leaseToken: input.input.leaseToken,
        runtimeVersion: input.runtimeVersion,
        now: observedAt,
      });
      if (!verified.marked) {
        return {
          outcome: "returned",
          value: { outcome: "stopped", reason: verified.reason },
        };
      }
      revision = verified.revision;
      discoveryAttemptedAt = verified.discoveryAttemptedAt;
      discoveryVerifiedAt = verified.discoveryVerifiedAt;
      if (
        !hasCoherentDiscoveryProof(discoveryAttemptedAt, discoveryVerifiedAt)
      ) {
        return {
          outcome: "returned",
          value: { outcome: "stopped", reason: "discovery_not_verified" },
        };
      }
      if (input.transitionMode !== "REUSE_SUCCEEDED") {
        await requireRecordedPlaybookTransition(input.runtime, {
          stage: input.stage,
          transition: "SUCCEEDED",
          readPath: "TYPED_PROVIDER_ADAPTER",
          evidenceKind: "PROVIDER_RESPONSE",
          runtimeVersion: input.runtimeVersion,
          now: observedAt,
        });
      }
      const completed = await completeCourseSupportVerificationRequest({
        requestId: input.input.requestId,
        expectedRevision: revision,
        leaseToken: input.input.leaseToken,
        runtimeVersion: input.runtimeVersion,
        observation: {
          outcome,
          observedAt,
          adapterKey: capability.providerFamilyKey,
          availabilityCount: matchingSlots.length,
          providerExecution: true,
        },
      });
      return {
        outcome: "returned",
        value: completed.completed
          ? { outcome: "completed", providerOutcome: outcome }
          : { outcome: "stopped", reason: completed.reason },
      };
    }
  } catch (error) {
    failure = classifyProviderFailure({ error });
  }

  if (input.transitionMode === "REUSE_SUCCEEDED") {
    const failedAt = new Date();
    const retryAt =
      !recoveryStartedWithAttempt &&
      PLAYBOOK_RETRYABLE_FAILURES.has(failure!.failureClass)
        ? getTransientProviderRetryAt(failedAt, failure!.retryAfterSeconds)
        : null;
    return {
      outcome: "returned",
      value: await failVerification({
        input: input.input,
        revision,
        runtimeVersion: input.runtimeVersion,
        failureClass: failure!.failureClass,
        providerExecution: providerExecutionStarted,
        httpStatus: failure!.httpStatus,
        retryAfterSeconds: retryAt ? failure!.retryAfterSeconds : undefined,
        message:
          "The current provider adapter could not reproduce its prior successful result.",
        retryAt,
      }),
    };
  }

  const stageAssessment = input.runtime.assessment.stages.find(
    (candidate) => candidate.stage === input.stage,
  );
  const retryable =
    PLAYBOOK_RETRYABLE_FAILURES.has(failure!.failureClass) &&
    (stageAssessment?.attemptCount ?? 0) < 1;
  await requireRecordedPlaybookTransition(input.runtime, {
    stage: input.stage,
    transition: retryable ? "FAILED_RETRYABLE" : "FAILED_TERMINAL",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: providerExecutionStarted ? "PROVIDER_RESPONSE" : "TOOLING",
    failureClass: failure!.failureClass,
    runtimeVersion: input.runtimeVersion,
  });
  if (!retryable) {
    return {
      outcome: "continued",
      revision,
      discoveryAttemptedAt,
      discoveryVerifiedAt,
    };
  }
  return {
    outcome: "returned",
    value: await failVerification({
      input: input.input,
      revision,
      runtimeVersion: input.runtimeVersion,
      failureClass: failure!.failureClass,
      providerExecution: providerExecutionStarted,
      httpStatus: failure!.httpStatus,
      retryAfterSeconds: failure!.retryAfterSeconds,
      message:
        "The typed public provider adapter will receive its bounded retry.",
      retryAt: new Date(Date.now() + PLAYBOOK_RETRY_MS),
    }),
  };
}

async function recoverSucceededPlaybookLocalReader(input: {
  input: CourseSupportVerificationWorkflowInput;
  revision: number;
  runtimeVersion: string;
  course: VerificationCourse;
  intent: VerificationIntent;
  discoveryAttemptedAt: Date | null;
  discoveryVerifiedAt: Date | null;
  priorSucceededAt: Date | null;
}) {
  const bookingUrl = input.course.detectedBookingUrl ?? input.course.website;
  if (
    !bookingUrl ||
    input.course.monitoringMode === "SERVER_ONLY" ||
    input.course.monitoringMode === "CONTACT_ONLY" ||
    getLocalReaderCourseKey(bookingUrl) === null
  ) {
    return failVerification({
      input: input.input,
      revision: input.revision,
      runtimeVersion: input.runtimeVersion,
      failureClass: "READER_PARSER_MISSING",
      providerExecution: false,
      message:
        "The previously successful signed local reader is no longer runnable.",
    });
  }

  const recoveryStartedWithAttempt = Boolean(input.discoveryAttemptedAt);
  let revision = input.revision;
  let discoveryAttemptedAt = input.discoveryAttemptedAt;
  let discoveryVerifiedAt = input.discoveryVerifiedAt;
  if (!discoveryAttemptedAt) {
    const attempted = await markCourseSupportVerificationDiscoveryAttempted({
      requestId: input.input.requestId,
      expectedRevision: revision,
      leaseToken: input.input.leaseToken,
      runtimeVersion: input.runtimeVersion,
      now: new Date(),
    });
    if (!attempted.marked) {
      return { outcome: "stopped" as const, reason: attempted.reason };
    }
    revision = attempted.revision;
    discoveryAttemptedAt = attempted.discoveryAttemptedAt;
    discoveryVerifiedAt = attempted.discoveryVerifiedAt;
  }
  if (!discoveryAttemptedAt) {
    return { outcome: "stopped" as const, reason: "discovery_not_attempted" };
  }

  const priorSucceededAt = input.priorSucceededAt?.getTime() ?? 0;
  const notBefore = new Date(
    Math.max(discoveryAttemptedAt.getTime(), priorSucceededAt + 1),
  );
  const readerVerification = await getLocalReaderCourseVerification({
    courseId: input.course.id,
    targetDate: input.intent.targetDateLocal,
    players: input.intent.players,
    bookingUrl,
    notBefore,
  });
  const currentReaderResult = Boolean(
    readerVerification &&
    readerVerification.status !== "PENDING" &&
    readerVerification.observedAt.getTime() >= notBefore.getTime(),
  );
  if (readerVerification?.status === "COMPLETED" && currentReaderResult) {
    if (
      readerVerification.slots.some(
        (slot) => !getSafeOfficialBookingUrl(slot.bookingUrl),
      )
    ) {
      return failVerification({
        input: input.input,
        revision,
        runtimeVersion: input.runtimeVersion,
        failureClass: "SCHEMA",
        providerExecution: true,
        message:
          "The signed local reader returned an unsafe booking destination.",
      });
    }
    const matchingSlots = filterSlotsForSearch(
      {
        date: input.intent.targetDateLocal,
        startTime: input.intent.startTimeLocal,
        endTime: input.intent.endTimeLocal,
        players: input.intent.players,
        preferredCourses: [{ courseId: input.course.id, rank: 1 }],
      },
      readerVerification.slots,
    );
    const outcome = matchingSlots.length > 0 ? "MATCH_FOUND" : "NO_MATCH";
    const verified = await markCourseSupportVerificationDiscoveryVerified({
      requestId: input.input.requestId,
      expectedRevision: revision,
      leaseToken: input.input.leaseToken,
      runtimeVersion: input.runtimeVersion,
      now: new Date(),
    });
    if (!verified.marked) {
      return { outcome: "stopped" as const, reason: verified.reason };
    }
    revision = verified.revision;
    discoveryAttemptedAt = verified.discoveryAttemptedAt;
    discoveryVerifiedAt = verified.discoveryVerifiedAt;
    if (!hasCoherentDiscoveryProof(discoveryAttemptedAt, discoveryVerifiedAt)) {
      return { outcome: "stopped" as const, reason: "discovery_not_verified" };
    }
    const completed = await completeCourseSupportVerificationRequest({
      requestId: input.input.requestId,
      expectedRevision: revision,
      leaseToken: input.input.leaseToken,
      runtimeVersion: input.runtimeVersion,
      observation: {
        outcome,
        observedAt: readerVerification.observedAt,
        adapterKey: `LOCAL_READER:${resolveProviderCapability(input.course).providerFamilyKey}`,
        availabilityCount: matchingSlots.length,
        providerExecution: true,
      },
    });
    return completed.completed
      ? { outcome: "completed" as const, providerOutcome: outcome }
      : { outcome: "stopped" as const, reason: completed.reason };
  }

  if (readerVerification?.status === "TERMINAL" && currentReaderResult) {
    return failVerification({
      input: input.input,
      revision,
      runtimeVersion: input.runtimeVersion,
      failureClass:
        readerVerification.resultStatus === "ACCESS_CHALLENGE"
          ? "CHALLENGE"
          : readerVerification.resultStatus === "PAGE_MISMATCH"
            ? "SCHEMA"
            : readerVerification.resultStatus === "EXPIRED"
              ? "TIMEOUT"
              : "UNKNOWN",
      providerExecution: true,
      message:
        "The current signed local reader could not reproduce its prior successful result.",
      retryAt: null,
    });
  }

  const retryAt = recoveryStartedWithAttempt
    ? null
    : new Date(Date.now() + PLAYBOOK_RETRY_MS);
  if (!recoveryStartedWithAttempt && readerVerification?.status !== "PENDING") {
    await queueLocalReaderCourseVerification({
      courseId: input.course.id,
      targetDate: input.intent.targetDateLocal,
      players: input.intent.players,
      bookingUrl,
      notBefore,
    });
  }
  return failVerification({
    input: input.input,
    revision,
    runtimeVersion: input.runtimeVersion,
    failureClass: "HTTP_5XX",
    providerExecution: false,
    message:
      "A fresh signed local-reader result is required to recover the concluded request.",
    retryAt,
  });
}

async function requireRecordedPlaybookTransition(
  runtime: CourseMonitoringPlaybookRuntime,
  input: Parameters<typeof recordRuntimePlaybookTransition>[1],
) {
  const recorded = await recordRuntimePlaybookTransition(runtime, input);
  if (!recorded.recorded) {
    throw new Error(
      `Ordered playbook transition was not recorded: ${recorded.reason}.`,
    );
  }
  return recorded.result;
}

function getPlaybookReadPath(
  stage: CourseMonitoringPlaybookRuntime["assessment"]["nextStage"],
) {
  if (stage === "OFFICIAL_IDENTITY") return "OFFICIAL_IDENTITY" as const;
  if (stage === "OFFICIAL_HTTP_DISCOVERY") return "OFFICIAL_HTTP" as const;
  if (stage === "RENDERED_BROWSER_DISCOVERY")
    return "RENDERED_BROWSER" as const;
  if (stage === "LOCAL_READER") return "LOCAL_READER" as const;
  if (stage === "INDEPENDENT_CONFIRMATION") {
    return "INDEPENDENT_CONFIRMATION" as const;
  }
  return "TYPED_PROVIDER_ADAPTER" as const;
}

function getCurrentFactualDisposition(course: VerificationCourse) {
  const currentEvidence = evaluateMonitoringGate(course).currentEvidence;
  if (!currentEvidence) return null;
  if (course.isPublic === false) {
    return {
      disposition: "IDENTITY_FINAL" as const,
      state: "FINAL_IDENTITY" as const,
      outcome: "IDENTITY_FINAL" as const,
      resolution: "IDENTITY_CLASSIFIED" as const,
      message:
        "Current authoritative identity evidence shows this is not a monitorable public course.",
    };
  }
  if (
    ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(
      course.bookingMethod,
    ) ||
    course.automationReason === "NO_ONLINE_BOOKING"
  ) {
    return {
      disposition: "MANUAL_DIRECT" as const,
      state: "FINAL_MANUAL" as const,
      outcome: "MANUAL_DIRECT" as const,
      resolution: "DIRECT_BOOKING_CLASSIFIED" as const,
      message:
        "Current official evidence shows the course requires direct customer action instead of online tee-time monitoring.",
    };
  }
  return null;
}

function hasCoherentDiscoveryProof(
  attemptedAt: Date | null,
  verifiedAt: Date | null,
) {
  return Boolean(
    attemptedAt && verifiedAt && attemptedAt.getTime() <= verifiedAt.getTime(),
  );
}

function canUsePersistedRunnableEvidence(
  course: {
    providerFamilyKey: string;
    detectedPlatform: string;
    detectedBookingUrl: string | null;
    website: string | null;
    bookingMetadata: unknown;
    bookingMethod: string;
    automationEligibility: string;
    automationReason: string;
    monitoringMode: string;
    isPublic: boolean | null;
    intelligenceVerifiedAt: Date | null;
    intelligenceConfidence: number | null;
  },
  adapterAllowed: boolean,
  currentEvidence: boolean,
) {
  const capability = resolveProviderCapability(course);
  return Boolean(
    adapterAllowed &&
    currentEvidence &&
    capability.isRunnable &&
    capability.metadataReady &&
    !capability.evidenceConflict &&
    course.isPublic !== false &&
    course.bookingMethod === "PUBLIC_ONLINE" &&
    course.automationEligibility === "ALLOWED" &&
    course.intelligenceVerifiedAt &&
    (course.intelligenceConfidence ?? 0) >= 0.9,
  );
}

function getMonitoringGateFailureClass(course: {
  automationReason: string | null;
  isPublic: boolean | null;
}): CourseSupportFailureClass {
  if (course.isPublic === false) {
    return "UNSUPPORTED_FAMILY";
  }
  if (course.automationReason === "ACCOUNT_REQUIRED") {
    return "AUTH";
  }
  if (course.automationReason === "CAPTCHA_OR_QUEUE") {
    return "CHALLENGE";
  }
  return "UNSUPPORTED_FAMILY";
}

function getTransientProviderRetryAt(
  now: Date,
  retryAfterSeconds: number | null,
) {
  const providerDelayMs =
    retryAfterSeconds === null
      ? 0
      : Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.ceil(retryAfterSeconds) * 1000
        : Number.POSITIVE_INFINITY;
  const delayMs = Math.max(TRANSIENT_RETRY_MS, providerDelayMs);
  if (delayMs > VERIFICATION_RETRY_HORIZON_MS) {
    return null;
  }
  return new Date(now.getTime() + delayMs);
}

function sameVerificationIntent(
  left: {
    targetDateLocal: string;
    startTimeLocal: string;
    endTimeLocal: string;
    timeZone: string;
    players: number;
  },
  right: {
    targetDateLocal: string;
    startTimeLocal: string;
    endTimeLocal: string;
    timeZone: string;
    players: number;
  },
) {
  return (
    left.targetDateLocal === right.targetDateLocal &&
    left.startTimeLocal === right.startTimeLocal &&
    left.endTimeLocal === right.endTimeLocal &&
    left.timeZone === right.timeZone &&
    left.players === right.players
  );
}

async function completeFactualVerification(input: {
  input: CourseSupportVerificationWorkflowInput;
  revision: number;
  runtimeVersion: string;
  disposition: AutomationPlaybookFactualDisposition;
  message: string;
}) {
  const completed = await completeCourseSupportVerificationFactualFinal({
    requestId: input.input.requestId,
    expectedRevision: input.revision,
    leaseToken: input.input.leaseToken,
    runtimeVersion: input.runtimeVersion,
    disposition: input.disposition,
    message: input.message,
  });
  return completed.completed
    ? {
        outcome: "completed" as const,
        providerOutcome: completed.outcome,
      }
    : { outcome: "stopped" as const, reason: completed.reason };
}

function getFactualDispositionMessage(
  disposition: AutomationPlaybookFactualDisposition,
) {
  return disposition === "IDENTITY_FINAL"
    ? "Current authoritative rendered-page evidence confirms a non-monitorable course identity."
    : "Current authoritative rendered-page evidence confirms direct customer action is required instead of online tee-time monitoring.";
}

async function failVerification(input: {
  input: CourseSupportVerificationWorkflowInput;
  revision: number;
  runtimeVersion: string;
  failureClass: CourseSupportFailureClass;
  providerExecution: boolean;
  message: string;
  httpStatus?: number | null;
  retryAfterSeconds?: number | null;
  retryAt?: Date | null;
}) {
  const failed = await failCourseSupportVerificationRequest({
    requestId: input.input.requestId,
    expectedRevision: input.revision,
    leaseToken: input.input.leaseToken,
    runtimeVersion: input.runtimeVersion,
    failureClass: input.failureClass,
    message: input.message,
    retryAt: input.retryAt,
    retryAfterSeconds: input.retryAfterSeconds,
    observation: {
      outcome: "FETCH_FAILED",
      observedAt: new Date(),
      httpStatus: input.httpStatus,
      providerExecution: input.providerExecution,
    },
  });
  return failed.failed
    ? {
        outcome: "failed" as const,
        retryable: failed.status === "RETRYABLE_FAILED",
      }
    : { outcome: "stopped" as const, reason: failed.reason };
}
