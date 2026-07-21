import type { CourseSupportFailureClass } from "@prisma/client";

import { fetchCourseTeeSheet } from "@/lib/automation/course-provider-read";
import {
  attachCourseSupportVerificationProviderSnapshot,
  completeCourseSupportVerificationRequest,
  failCourseSupportVerificationRequest,
  heartbeatCourseSupportVerificationRequest,
  markCourseSupportVerificationDiscoveryAttempted,
  markCourseSupportVerificationDiscoveryVerified
} from "@/lib/automation/course-support-verification";
import { prepareCourseSupportVerificationMonitoring } from "@/lib/automation/search-monitoring-discovery";
import {
  classifyProviderFailure,
  getProviderReadinessFailure,
  resolveProviderCapability
} from "@/lib/automation/provider-capabilities";
import { evaluateMonitoringGate } from "@/lib/automation/policy";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import { getSafeOfficialBookingUrl } from "@/lib/email/search-delivery-outbox";
import { prisma } from "@/lib/prisma";
import { filterSlotsForSearch } from "@/lib/tee-times/matching";

import type { CourseSupportVerificationWorkflowInput } from "./course-support-verification";

const TRANSIENT_PROVIDER_FAILURES = new Set<CourseSupportFailureClass>([
  "RATE_LIMIT",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "UNKNOWN"
]);
const TRANSIENT_RETRY_MS = 15 * 60 * 1000;
const LEASE_BUSY_RETRY_MS = 2 * 60 * 1000;
const VERIFICATION_RETRY_HORIZON_MS = 24 * 60 * 60 * 1000;

const providerCourseSelect = {
  id: true,
  timeZone: true,
  website: true,
  detectedBookingUrl: true,
  providerFamilyKey: true,
  detectedPlatform: true,
  bookingMetadata: true,
  bookingWindowEvidenceUrl: true,
  bookingMethod: true,
  automationEligibility: true,
  automationReason: true,
  isPublic: true,
  intelligenceVerifiedAt: true,
  intelligenceReviewAt: true,
  intelligenceConfidence: true
} as const;

export async function executeCourseSupportVerificationStep(
  input: CourseSupportVerificationWorkflowInput
) {
  "use step";

  const runtimeVersion = getAutomationRuntimeVersion();
  if (runtimeVersion !== input.runtimeVersion) {
    return { outcome: "runtime_mismatch" as const };
  }

  let revision = input.expectedRevision;
  const beforeDiscovery =
    await attachCourseSupportVerificationProviderSnapshot({
      requestId: input.requestId,
      expectedRevision: revision,
      leaseToken: input.leaseToken,
      runtimeVersion
    });
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
    runtimeVersion
  });
  if (!heartbeat.renewed) {
    return { outcome: "stopped" as const, reason: "lease_lost" as const };
  }

  const courseBeforeDiscovery = await prisma.course.findUnique({
    where: { id: ownedCourseId },
    select: providerCourseSelect
  });
  if (!courseBeforeDiscovery) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "MISSING_SOURCE",
      providerExecution: false,
      message: "Course-support verification source is no longer available."
    });
  }
  if (courseBeforeDiscovery.timeZone !== ownedIntent.timeZone) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message: "Course-support verification timezone changed during execution."
    });
  }
  const beforeDiscoveryGate = evaluateMonitoringGate(courseBeforeDiscovery);
  if (!beforeDiscoveryGate.adapterAllowed) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: getMonitoringGateFailureClass(courseBeforeDiscovery),
      providerExecution: false,
      message: "Current course evidence is a terminal monitoring disposition."
    });
  }
  if (
    beforeDiscovery.discoveryVerifiedAt &&
    !hasCoherentDiscoveryProof(
      beforeDiscovery.discoveryAttemptedAt,
      beforeDiscovery.discoveryVerifiedAt
    )
  ) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message: "Provider discovery proof is inconsistent."
    });
  }

  let discoveryCompletedThisRun = false;
  if (!beforeDiscovery.discoveryVerifiedAt) {
    let forceFreshDiscovery = false;
    if (!beforeDiscovery.discoveryAttemptedAt) {
      const attempted =
        await markCourseSupportVerificationDiscoveryAttempted({
          requestId: input.requestId,
          expectedRevision: revision,
          leaseToken: input.leaseToken,
          runtimeVersion
        });
      if (!attempted.marked) {
        return { outcome: "stopped" as const, reason: attempted.reason };
      }
      revision = attempted.revision;
      forceFreshDiscovery = true;
    }

    let discovery: Awaited<
      ReturnType<typeof prepareCourseSupportVerificationMonitoring>
    >;
    try {
      discovery = await prepareCourseSupportVerificationMonitoring(
        ownedCourseId,
        undefined,
        new Date(),
        { forceFresh: forceFreshDiscovery }
      );
    } catch {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "NETWORK",
        providerExecution: false,
        message: "Official-source verification discovery failed.",
        retryAt: new Date(Date.now() + TRANSIENT_RETRY_MS)
      });
    }

    if (discovery.deferredCourseIds.includes(ownedCourseId)) {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "RATE_LIMIT",
        providerExecution: false,
        message: "Official-source verification discovery was deferred.",
        retryAt: new Date(Date.now() + LEASE_BUSY_RETRY_MS)
      });
    }
    if (discovery.failedCourseIds.includes(ownedCourseId)) {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "NETWORK",
        providerExecution: false,
        message: "Official-source verification discovery failed.",
        retryAt: new Date(Date.now() + TRANSIENT_RETRY_MS)
      });
    }
    if (!discovery.attemptedCourseIds.includes(ownedCourseId)) {
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
          : undefined
      });
    }
    discoveryCompletedThisRun = true;
  }

  const afterDiscovery =
    await attachCourseSupportVerificationProviderSnapshot({
      requestId: input.requestId,
      expectedRevision: revision,
      leaseToken: input.leaseToken,
      runtimeVersion
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
      message: "Course-support verification ownership changed during discovery."
    });
  }
  const courseId = afterDiscovery.courseId;
  const intent = afterDiscovery.intent;

  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: providerCourseSelect
  });
  if (!course) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "MISSING_SOURCE",
      providerExecution: false,
      message: "Course-support verification source is no longer available."
    });
  }
  if (course.timeZone !== intent.timeZone) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message: "Course-support verification timezone changed during execution."
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
        message: "Provider discovery attempt ownership was not preserved."
      });
    }
    const verified = await markCourseSupportVerificationDiscoveryVerified({
      requestId: input.requestId,
      expectedRevision: revision,
      leaseToken: input.leaseToken,
      runtimeVersion
    });
    if (!verified.marked) {
      return { outcome: "stopped" as const, reason: verified.reason };
    }
    revision = verified.revision;
  } else if (
    !hasCoherentDiscoveryProof(
      afterDiscovery.discoveryAttemptedAt,
      afterDiscovery.discoveryVerifiedAt
    )
  ) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: "SCHEMA",
      providerExecution: false,
      message: "Provider discovery proof changed before verification completed.",
      retryAt: new Date(Date.now() + TRANSIENT_RETRY_MS)
    });
  }

  if (!afterDiscoveryGate.adapterAllowed) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: getMonitoringGateFailureClass(course),
      providerExecution: false,
      message: "Current course evidence is a terminal monitoring disposition."
    });
  }

  const capability = resolveProviderCapability(course);
  if (!capability.isRunnable) {
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass:
        getProviderReadinessFailure(capability) ?? "UNSUPPORTED_FAMILY",
      providerExecution: false,
      message: "No reusable public read-only provider adapter is runnable."
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
          true
        );
      }
    );
    if (!execution.acquired) {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "RATE_LIMIT",
        providerExecution: false,
        message: "Provider verification was deferred by the concurrency guard.",
        retryAt: new Date(Date.now() + LEASE_BUSY_RETRY_MS)
      });
    }

    const unsafeBookingUrlCount = execution.value.slots.filter(
      (slot) => !getSafeOfficialBookingUrl(slot.bookingUrl)
    ).length;
    if (unsafeBookingUrlCount > 0) {
      return failVerification({
        input,
        revision,
        runtimeVersion,
        failureClass: "SCHEMA",
        providerExecution: true,
        message: "The provider returned an unsafe booking destination."
      });
    }

    const matchingSlots = filterSlotsForSearch(
      {
        date: intent.targetDateLocal,
        startTime: intent.startTimeLocal,
        endTime: intent.endTimeLocal,
        players: intent.players,
        preferredCourses: [{ courseId, rank: 1 }]
      },
      execution.value.slots
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
        providerExecution: true
      }
    });
    return completed.completed
      ? { outcome: "completed" as const, providerOutcome: outcome }
      : { outcome: "stopped" as const, reason: completed.reason };
  } catch (error) {
    const failure = classifyProviderFailure({ error });
    const failedAt = new Date();
    return failVerification({
      input,
      revision,
      runtimeVersion,
      failureClass: failure.failureClass,
      providerExecution: providerExecutionStarted,
      httpStatus: failure.httpStatus,
      retryAfterSeconds: failure.retryAfterSeconds,
      message: "Public provider availability verification failed.",
      retryAt: TRANSIENT_PROVIDER_FAILURES.has(failure.failureClass)
        ? getTransientProviderRetryAt(failedAt, failure.retryAfterSeconds)
        : null
    });
  }
}

function hasCoherentDiscoveryProof(
  attemptedAt: Date | null,
  verifiedAt: Date | null
) {
  return Boolean(
    attemptedAt &&
      verifiedAt &&
      attemptedAt.getTime() <= verifiedAt.getTime()
  );
}

function getMonitoringGateFailureClass(
  course: {
    automationReason: string | null;
    isPublic: boolean | null;
  }
): CourseSupportFailureClass {
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
  retryAfterSeconds: number | null
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
  }
) {
  return (
    left.targetDateLocal === right.targetDateLocal &&
    left.startTimeLocal === right.startTimeLocal &&
    left.endTimeLocal === right.endTimeLocal &&
    left.timeZone === right.timeZone &&
    left.players === right.players
  );
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
      providerExecution: input.providerExecution
    }
  });
  return failed.failed
    ? { outcome: "failed" as const, retryable: failed.status === "RETRYABLE_FAILED" }
    : { outcome: "stopped" as const, reason: failed.reason };
}
