import { createHash } from "node:crypto";

import type {
  CourseMonitoringMode,
  CourseMonitoringState
} from "@prisma/client";

import {
  finishAutomationRun,
  getActiveSearchForAutomation,
  heartbeatSearchCheckLease,
  isSearchCheckLeaseCurrent,
  listAvailableMatchAlerts,
  listPendingMatchAlerts,
  listSearchCourseVerdictsSince,
  markCourseBookingWindowChecked,
  markMissingMatchesUnavailable,
  markSearchStatusEmailSent,
  recordCourseBookingFacts,
  recordCourseBookingWindowEvidence,
  recordCourseProbe,
  recordCourseProbeIfChanged,
  recordTeeTimeMatch,
  runWithSearchCheckLease,
  startAutomationRun,
  type SearchCheckLease
} from "@/lib/automation/db-service";
import {
  ACTIVE_DEMAND_ESCALATION_MS,
  CUSTOMER_ENDPOINT_DELIVERY_HEADROOM_MS,
  FIRST_FAILURE_RETRY_MS,
  getCourseMonitoringRetryAt,
  reconcileCourseMonitoringDeadlines,
  recordCourseMonitoringFinalClassification,
  recordCourseMonitoringSuccess
} from "@/lib/automation/course-monitoring";
import {
  assessAutomationPlaybook,
  isAutomationHumanReviewProofCurrentOrPrior,
  isAutomationPlaybookExhausted
} from "@/lib/automation/course-monitoring-playbook";
import {
  getBestProbeUrl,
  shouldQueueBrowserProbe
} from "@/lib/automation/browser-discovery";
import {
  classifyProviderFailure,
  resolveProviderCapability
} from "@/lib/automation/provider-capabilities";
import {
  fetchCourseTeeSheet,
  type AutomationCourseProviderRead,
  type CourseTeeSheetResult
} from "@/lib/automation/course-provider-read";
import {
  evaluateMonitoringGate,
  isCoherentManualDisposition
} from "@/lib/automation/policy";
import { runProviderFamilyTasks } from "@/lib/automation/provider-concurrency";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import {
  getFreshLocalReaderObservation,
  getLocalReaderCourseKey,
  queueLocalReaderJob
} from "@/lib/local-reader/service";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { prepareSearchMonitoring } from "@/lib/automation/search-monitoring-discovery";
import {
  SEARCH_PLAYBOOK_FINGERPRINTS,
  ensureSearchPlaybookOfficialIdentity,
  loadSearchPlaybookRuntime,
  recordSearchPlaybookAttempt,
  recordSearchPlaybookAttemptResult,
  recordSearchPlaybookTransition,
  skipSearchPlaybookStage,
  type SearchPlaybookRuntime
} from "@/lib/automation/search-playbook-runtime";
import {
  reportCourseSupportIssue
} from "@/lib/automation/support-incidents";
import {
  getBookingWindowForTargetDate,
  getBookingWindowFromEvidence,
  shouldRetryBookingWindowDiscovery,
  shouldRefreshBookingWindow,
  type BookingWindowEvidenceSource,
  type TargetBookingWindow
} from "@/lib/courses/booking-window";
import type {
  AutomationReason,
  BookingAccessMode,
  BookingMethod
} from "@/lib/courses/intelligence";
import {
  getCourseLayoutCompatibility,
  getCourseLayoutLabel
} from "@/lib/courses/course-layout";
import { sendSearchStatusEmail, sendTeeTimeAlert } from "@/lib/email/alerts";
import {
  areSearchStatusEmailsEnabled,
  isSearchEmailDeliveryEnabled
} from "@/lib/email/delivery-policy";
import {
  drainSearchEmailDeliveryGroup,
  finalizeSearchEmailDeliveryGroup,
  getPendingStatusEmailReplacement,
  getSafeOfficialBookingUrl,
  hydrateMatchAlertPayload,
  hydrateSearchStatusEmailPayload,
  listReachedMonitoringFinals,
  listReachedMonitoringOutages,
  listRetryableSearchEmailDeliveryGroups,
  prepareRecipientMatchDeliveryGroups,
  prepareSearchEmailDeliveryGroup,
  satisfyPendingDailyStatusReplacementWithMatch,
  toSearchEmailJson
} from "@/lib/email/search-delivery-outbox";
import {
  buildSearchStatusSnapshot,
  getSearchStatusEmailKind,
  isInitialSearchStatusReportReady,
  summarizeSearchStatusAvailability,
  type SearchStatusCourseReport,
  type SearchStatusEmailKind,
  type SearchStatusTransitionKind
} from "@/lib/email/search-status";
import {
  buildMonitoringStatusNoticeGroupKey,
  getMonitoringStatusProviderLabel,
  planMonitoringStatusNotices,
  type MonitoringStatusNoticeCandidate
} from "@/lib/email/monitoring-status-notices";
import {
  getCustomerMonitoringStatus,
  hasDurableAutomationStalledEndpointProof
} from "@/lib/customer-monitoring-status";
import {
  preserveAlertGenerationClockInStatusSnapshot,
  readAlertGenerationStartedAt
} from "@/lib/searches/generation-clock";
import { buildCourseFactLine } from "@/lib/email/course-facts";
import {
  buildCoursePriceEstimate,
  buildObservedBookableHoleSummary,
  summarizeBookableHoleCounts,
  summarizeCourseSlotPrices
} from "@/lib/pricing/course-prices";
import {
  dedupeMatches,
  filterSlotsForSearch,
  parseCourseLocalDateTime,
  rankMatches
} from "@/lib/tee-times/matching";

const PROMPT_VERSION = "tee-time-spot-event-driven-check-v1";
const HUMAN_REVIEW_CUSTOMER_MESSAGE =
  "Tee Time Spot finished its automatic checks for this course and is waiting for a monitoring review. Other selected courses will continue to be checked.";
const FIRST_TIME_LOOKUP_CREATION_WINDOW_MS = 2 * 60 * 1000;
const SHORT_SEARCH_RETRY_FAILURES = new Set([
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "UNKNOWN"
]);
const SUCCESSFUL_COURSE_VERDICTS = new Set([
  "MATCH_FOUND",
  "NO_MATCH",
  "BOOKING_NOT_OPEN"
]);

type AutomationCourse = AutomationCourseProviderRead & {
  name: string;
  address: string | null;
  phone: string | null;
  bookingPhone: string | null;
  isPublic: boolean | null;
  bookingMethod: BookingMethod;
  automationEligibility: "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
  automationReason: AutomationReason;
  monitoringMode: CourseMonitoringMode;
  bookingAccessMode: BookingAccessMode;
  intelligenceVerifiedAt: Date | null;
  intelligenceReviewAt: Date | null;
  intelligenceConfidence: number | null;
  policyNotes: string | null;
  bookingWindowDaysAhead: number | null;
  bookingReleaseTimeLocal: string | null;
  bookingWindowSource: BookingWindowEvidenceSource | null;
  bookingWindowConfidence: number | null;
  bookingWindowCheckedAt: Date | null;
  bookingWindowObservedAt: Date | null;
  layoutHoleCounts: number[];
  layoutHolesVerifiedAt: Date | null;
  monitoringStatus: {
    state: CourseMonitoringState;
    firstDegradedAt: Date | null;
    failureFingerprint: string | null;
    nextAutomaticAttemptAt: Date | null;
    revalidationRequestedAt: Date | null;
    stateChangedAt: Date;
  } | null;
  supportIncident?: {
    id: string;
    cycle: number;
    status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED";
    attemptLedger: unknown;
    humanReviewReason: string | null;
    escalatedAt?: Date | null;
    escalationDeadlineAt: Date | null;
    firstSeenAt: Date;
    monitoringEvents?: Array<{
      incidentId: string | null;
      eventType: string;
      occurredAt: Date;
      audit: unknown;
    }>;
  } | null;
};

export type SearchCheckCourseResult = SearchStatusCourseReport;

export type SearchCheckResult = {
  searchId: string;
  outcome: "success" | "not_active" | "busy" | "failed";
  courseResults: SearchCheckCourseResult[];
  availableMatches: number;
  newlyAlertedMatches: number;
  supportRetryNeeded: boolean;
  supportRetryAt: Date | null;
  statusEmailOutcome?:
    "sent" | "dry_run" | "skipped" | "covered_by_match_alert" | "failed";
};

export class SearchCheckLeaseLostError extends Error {
  constructor() {
    super("Search check lease is no longer current");
    this.name = "SearchCheckLeaseLostError";
  }
}

async function maintainSearchCheckLease(lease?: SearchCheckLease) {
  if (!lease) {
    return;
  }
  const current =
    lease.expiresAt.getTime() - Date.now() < 5 * 60 * 1000
      ? await heartbeatSearchCheckLease(lease)
      : await isSearchCheckLeaseCurrent(lease);
  if (!current) {
    throw new SearchCheckLeaseLostError();
  }
}

export async function runSearchCheck(
  searchId: string,
  trigger = "scheduled",
  existingLease?: SearchCheckLease
) {
  const run = await startAutomationRun(PROMPT_VERSION);

  try {
    const execution = existingLease
      ? {
          acquired: true as const,
          value: await checkSearch(searchId, run.id, existingLease)
        }
      : await runWithSearchCheckLease(searchId, (lease) =>
          checkSearch(searchId, run.id, lease)
        );
    if (!execution.acquired) {
      const result: SearchCheckResult = {
        searchId,
        outcome: "busy",
        courseResults: [],
        availableMatches: 0,
        newlyAlertedMatches: 0,
        supportRetryNeeded: false,
        supportRetryAt: null
      };
      await finishAutomationRun(run.id, {
        outcome: "no_op",
        notes: JSON.stringify({
          trigger,
          searchRef: createSearchLogReference(searchId),
          outcome: "busy"
        })
      });
      return result;
    }

    await finishAutomationRun(run.id, {
      outcome: execution.value.outcome,
      notes: JSON.stringify(buildSearchCheckAudit(trigger, execution.value))
    });
    return execution.value;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown search check failure";
    const safeMessage = sanitizeResponderText(message);
    await finishAutomationRun(run.id, {
      outcome: "failed",
      errors: {
        name: error instanceof Error ? error.name : "Error",
        message: safeMessage
      },
      notes: safeMessage
    });
    throw error;
  }
}

async function checkSearch(
  searchId: string,
  automationRunId: string,
  lease: SearchCheckLease
): Promise<SearchCheckResult> {
  const loadedSearch = await getActiveSearchForAutomation(searchId);
  if (!loadedSearch) {
    return {
      searchId,
      outcome: "not_active",
      courseResults: [],
      availableMatches: 0,
      newlyAlertedMatches: 0,
      supportRetryNeeded: false,
      supportRetryAt: null
    };
  }
  let search = loadedSearch;
  const customerStatusObservedAt = new Date();
  const generationStartedAt = readAlertGenerationStartedAt({
    alertGeneration: search.alertGeneration,
    createdAt: search.createdAt,
    statusEmailSnapshot: search.statusEmailSnapshot
  });
  const customerEndpointStartedAt =
    generationStartedAt ?? customerStatusObservedAt;
  const searchCourseIds = search.preferences.map(
    (preference) => preference.course.id
  );
  const currentGenerationVerdicts = await listSearchCourseVerdictsSince({
    searchId: search.id,
    courseIds: searchCourseIds,
    observedAtOrAfter: customerEndpointStartedAt
  });
  const currentGenerationVerdictByCourse = new Map(
    currentGenerationVerdicts.map((verdict) => [verdict.courseId, verdict])
  );
  const initialDeadlineReconciliation =
    await reconcileCourseMonitoringDeadlines({
      courseIds: searchCourseIds,
      now: customerStatusObservedAt,
      source: "SEARCH_WORKFLOW"
    });
  if (
    initialDeadlineReconciliation.escalated > 0 ||
    initialDeadlineReconciliation.retrying > 0
  ) {
    search = (await getActiveSearchForAutomation(searchId)) ?? search;
  }

  let monitoringRetryCourseIds = new Set<string>();
  let monitoringDeferredCourseIds = new Set<string>();
  let monitoringPreparationFailed = false;
  let monitoringPreparation = {
    attemptedCourseIds: [] as string[],
    appliedCourseIds: [] as string[],
    failedCourseIds: [] as string[],
    deferredCourseIds: [] as string[],
    retryCourseIds: [] as string[]
  };
  try {
    const officialDiscoveryCourseIds = search.preferences.flatMap(
      (preference) => {
        const incident = preference.course.supportIncident;
        if (!incident || incident.status === "RESOLVED") {
          return [];
        }
        return assessAutomationPlaybook(
          incident.attemptLedger,
          incident.cycle
        ).nextStage === "OFFICIAL_HTTP_DISCOVERY"
          ? [preference.course.id]
          : [];
      }
    );
    const preparation = await prepareSearchMonitoring(
      search,
      undefined,
      new Date(),
      officialDiscoveryCourseIds.length > 0
        ? {
            includeCourseIds: officialDiscoveryCourseIds,
            forceFreshCourseIds: officialDiscoveryCourseIds
          }
        : undefined
    );
    monitoringPreparation = preparation;
    await maintainSearchCheckLease(lease);
    monitoringRetryCourseIds = new Set(preparation.retryCourseIds);
    monitoringDeferredCourseIds = new Set(preparation.deferredCourseIds);
    if (preparation.appliedCourseIds.length > 0) {
      search = (await getActiveSearchForAutomation(searchId)) ?? search;
    }
  } catch (error) {
    monitoringPreparationFailed = true;
    console.error("[monitoring:discovery-failed]", {
      searchRef: createSearchLogReference(searchId),
      message:
        error instanceof Error
          ? error.message
          : "Unknown discovery preparation failure"
    });
  }

  const monitoringBeforeCheck = new Map(
    search.preferences.map((preference) => [
      preference.course.id,
      preference.course.monitoringStatus
        ? {
            state: preference.course.monitoringStatus.state,
            firstDegradedAt:
              preference.course.monitoringStatus.firstDegradedAt,
            failureFingerprint:
              preference.course.monitoringStatus.failureFingerprint,
            stateChangedAt:
              preference.course.monitoringStatus.stateChangedAt
          }
        : null
    ])
  );
  const getCourseFailureEpisodeStartedAt = (course: {
    id: string;
    supportIncident?: { status: string; firstSeenAt?: Date | null } | null;
  }) => {
    const priorVerdict = currentGenerationVerdictByCourse.get(course.id);
    if (!priorVerdict) {
      return customerEndpointStartedAt;
    }
    const previousMonitoring = monitoringBeforeCheck.get(course.id) ?? null;
    if (SUCCESSFUL_COURSE_VERDICTS.has(priorVerdict.outcome)) {
      return customerStatusObservedAt;
    }
    if (previousMonitoring?.firstDegradedAt) {
      return previousMonitoring.firstDegradedAt;
    }
    if (
      course.supportIncident?.status !== undefined &&
      course.supportIncident.status !== "RESOLVED"
    ) {
      return course.supportIncident.firstSeenAt ?? customerStatusObservedAt;
    }
    return (
      priorVerdict.failureEpisodeStartedAt ?? customerEndpointStartedAt
    );
  };

  const searchWindow = {
    date: search.date.toISOString().slice(0, 10),
    startTime: search.startTime,
    endTime: search.endTime,
    players: search.players,
    preferredCourses: search.preferences.map((preference) => ({
      courseId: preference.course.id,
      rank: preference.rank
    }))
  };
  const courseResults: SearchCheckCourseResult[] = [];
  const observedBookingFactsByCourse = new Map<
    string,
    {
      pricing: ReturnType<typeof summarizeCourseSlotPrices>;
      bookableHoleCounts: ReturnType<typeof summarizeBookableHoleCounts>;
      observedAt: Date;
    }
  >();
  const supportIssues: Array<{
    courseId: string;
    incidentId: string | null;
    status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "UNRECORDED";
    ownerAlerted: boolean;
  }> = [];
  let newlyAlertedMatches = 0;
  const runtimeVersion = getAutomationRuntimeVersion();
  const requestedLayoutHoles =
    search.requestedLayoutHoles === 9 || search.requestedLayoutHoles === 18
      ? search.requestedLayoutHoles
      : null;

  await runProviderFamilyTasks(
    search.preferences,
    (preference) =>
      resolveProviderCapability(preference.course as AutomationCourse)
        .providerFamilyKey,
    async (preference) => {
      await maintainSearchCheckLease(lease);
      const course = preference.course as AutomationCourse;
      const customerBookingUrl = getCustomerBookingUrl(course);
      const persistedPlaybookAssessment = course.supportIncident
        ? assessAutomationPlaybook(
            course.supportIncident.attemptLedger,
            course.supportIncident.cycle
          )
        : null;
      const persistedPlaybookExhausted = course.supportIncident
        ? isAutomationPlaybookExhausted(
            course.supportIncident.attemptLedger,
            course.supportIncident.cycle
          )
        : null;
      if (
        persistedPlaybookAssessment?.conclusion === "FACTUAL_FINAL" &&
        persistedPlaybookAssessment.factualDisposition
      ) {
        const identityFinal =
          persistedPlaybookAssessment.factualDisposition === "IDENTITY_FINAL";
        const outcome = identityFinal ? "IDENTITY_FINAL" : "MANUAL_DIRECT";
        const monitoringDisposition = identityFinal
          ? "IDENTITY_FINAL"
          : "MANUAL_FINAL";
        const message = getFinalMonitoringMessage(
          course,
          monitoringDisposition
        );
        await markMissingMatchesUnavailable({
          searchId: search.id,
          alertGeneration: search.alertGeneration,
          checkLeaseToken: lease.token,
          courseId: course.id,
          date: searchWindow.date,
          timeZone: course.timeZone,
          confirmedMatches: []
        });
        await recordCourseProbeIfChanged({
          searchId: search.id,
          courseId: course.id,
          observedAtOrAfter: customerEndpointStartedAt,
          automationRunId,
          runtimeVersion,
          outcome,
          message,
          rawSummary: {
            monitoringDisposition,
            playbookConclusion: "FACTUAL_FINAL",
            factualDisposition:
              persistedPlaybookAssessment.factualDisposition
          }
        });
        await recordCourseMonitoringFinalClassification({
          courseId: course.id,
          state: identityFinal ? "FINAL_IDENTITY" : "FINAL_MANUAL",
          outcome,
          message,
          runtimeVersion
        });
        courseResults.push({
          courseId: course.id,
          courseName: course.name,
          timeZone: course.timeZone,
          outcome,
          availableMatches: 0,
          message,
          bookingUrl: identityFinal ? undefined : customerBookingUrl,
          phone: identityFinal
            ? undefined
            : (course.bookingPhone ?? course.phone ?? undefined),
          bookingMethod: course.bookingMethod,
          bookingAccessMode: course.bookingAccessMode,
          bookingAccess: identityFinal
            ? undefined
            : getCourseBookingAccess(course),
          automationReason: course.automationReason,
          monitoringDisposition
        });
        return;
      }
      const waitingForHumanReview =
        getCustomerMonitoringStatus({
          monitoringState: course.monitoringStatus?.state ?? null,
          incidentStatus: course.supportIncident?.status ?? null,
          humanReviewReason:
            course.supportIncident?.humanReviewReason ?? null,
          escalationDeadlineAt:
            course.supportIncident?.escalationDeadlineAt ?? null,
          automationPlaybookExhausted: persistedPlaybookExhausted,
          automationStalledAtEndpoint:
            hasAutomationStalledEndpointProof(course),
          now: customerStatusObservedAt
        }) === "NEEDS_HUMAN_REVIEW";
      if (waitingForHumanReview) {
        const message = HUMAN_REVIEW_CUSTOMER_MESSAGE;
        await markMissingMatchesUnavailable({
          searchId: search.id,
          alertGeneration: search.alertGeneration,
          checkLeaseToken: lease.token,
          courseId: course.id,
          date: searchWindow.date,
          timeZone: course.timeZone,
          confirmedMatches: []
        });
        await recordCourseProbeIfChanged({
          searchId: search.id,
          courseId: course.id,
          observedAtOrAfter: customerEndpointStartedAt,
          automationRunId,
          runtimeVersion,
          outcome: "NEEDS_ADAPTER",
          message,
          rawSummary: {
            monitoringDisposition: "HUMAN_REVIEW_PENDING"
          }
        });
        courseResults.push({
          courseId: course.id,
          courseName: course.name,
          timeZone: course.timeZone,
          outcome: "NEEDS_ADAPTER",
          availableMatches: 0,
          message,
          bookingUrl: customerBookingUrl,
          phone: course.bookingPhone ?? course.phone ?? undefined,
          bookingMethod: course.bookingMethod,
          bookingAccessMode: course.bookingAccessMode,
          bookingAccess: getCourseBookingAccess(course),
          supportStatus: "NEEDS_HUMAN_REVIEW"
        });
        return;
      }
      const localReaderAllowed =
        course.monitoringMode !== "SERVER_ONLY" &&
        course.monitoringMode !== "CONTACT_ONLY";
      const localReaderEligible =
        localReaderAllowed &&
        getLocalReaderCourseKey(customerBookingUrl) !== null;
      const localReaderOnly = course.monitoringMode === "LOCAL_READER_ONLY";
      const providerFamilyKey =
        resolveProviderCapability(course).providerFamilyKey;
      const supportedAdapterAvailable = hasSupportedAdapter(course);
      const monitoringGate =
        course.monitoringStatus?.state === "FINAL_MANUAL" &&
        isCoherentManualDisposition(course)
          ? {
              disposition: "MANUAL_FINAL" as const,
              adapterAllowed: false,
              requiresRevalidation: false,
              currentEvidence: true,
              reason:
                "A durable operator decision confirmed the manual booking method."
            }
          : evaluateMonitoringGate(course);
      let playbookRuntime = await loadSearchPlaybookRuntime({
        courseId: course.id,
        runtimeVersion,
        context: course.supportIncident ?? null
      });
      if (playbookRuntime?.assessment.nextStage === "OFFICIAL_IDENTITY") {
        if (
          monitoringGate.disposition === "MANUAL_FINAL" ||
          monitoringGate.disposition === "IDENTITY_FINAL"
        ) {
          playbookRuntime = await recordSearchPlaybookTransition(
            playbookRuntime,
            {
              stage: "OFFICIAL_IDENTITY",
              transition: "FACTUAL_FINAL",
              readPath: "OFFICIAL_IDENTITY",
              evidenceKind: "OFFICIAL_SOURCE",
              failureFingerprint:
                monitoringGate.disposition === "MANUAL_FINAL"
                  ? SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_IDENTITY_MANUAL_FINAL
                  : SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_IDENTITY_IDENTITY_FINAL,
              factualDisposition:
                monitoringGate.disposition === "MANUAL_FINAL"
                  ? "MANUAL_DIRECT"
                  : "IDENTITY_FINAL",
              note: "Current authoritative course facts support a direct final action."
            }
          );
        } else {
          playbookRuntime = customerBookingUrl
            ? await ensureSearchPlaybookOfficialIdentity(playbookRuntime)
            : await recordSearchPlaybookAttempt(playbookRuntime, {
              stage: "OFFICIAL_IDENTITY",
              transition: "FAILED_TERMINAL",
              readPath: "OFFICIAL_IDENTITY",
              evidenceKind: "OFFICIAL_SOURCE",
              failureFingerprint:
                SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_IDENTITY_MISSING,
              failureClass: "MISSING_SOURCE",
              note: "No current official booking destination was available."
            });
        }
      }
      if (localReaderOnly && playbookRuntime) {
        playbookRuntime = await skipPlaybookStagesBeforeLocalReader(
          playbookRuntime
        );
      }
      if (
        playbookRuntime?.assessment.nextStage ===
        "OFFICIAL_HTTP_DISCOVERY"
      ) {
        playbookRuntime = await recordOfficialDiscoveryResult({
          runtime: playbookRuntime,
          courseId: course.id,
          preparation: monitoringPreparation,
          preparationFailed: monitoringPreparationFailed
        });
        if (
          playbookRuntime.assessment.nextStage ===
          "OFFICIAL_HTTP_DISCOVERY"
        ) {
          monitoringRetryCourseIds.add(course.id);
          courseResults.push(
            buildPlaybookPendingCourseReport(
              course,
              "Official booking-source discovery will retry before any browser or local-reader check."
            )
          );
          return;
        }
      }
      if (
        playbookRuntime?.assessment.nextStage === "HTTP_ADAPTER_RETRY" &&
        !supportedAdapterAvailable
      ) {
        playbookRuntime = await skipSearchPlaybookStage(playbookRuntime, {
          stage: "HTTP_ADAPTER_RETRY",
          readPath: "TYPED_PROVIDER_ADAPTER",
          evidenceKind: "TOOLING",
          failureFingerprint:
            SEARCH_PLAYBOOK_FINGERPRINTS.STAGE_NOT_APPLICABLE,
          skipReason: "NO_RUNNABLE_ADAPTER",
          note: "Official HTTP discovery did not produce a runnable typed adapter."
        });
      }
      if (
        playbookRuntime?.assessment.nextStage ===
        "RENDERED_BROWSER_DISCOVERY"
      ) {
        courseResults.push(
          buildPlaybookPendingCourseReport(
            course,
            "A signed-out rendered-browser review is the next monitoring step."
          )
        );
        return;
      }
      if (
        playbookRuntime?.assessment.nextStage === "BROWSER_ADAPTER_RETRY" &&
        !supportedAdapterAvailable
      ) {
        playbookRuntime = await skipSearchPlaybookStage(playbookRuntime, {
          stage: "BROWSER_ADAPTER_RETRY",
          readPath: "TYPED_PROVIDER_ADAPTER",
          evidenceKind: "TOOLING",
          failureFingerprint:
            SEARCH_PLAYBOOK_FINGERPRINTS.STAGE_NOT_APPLICABLE,
          skipReason: "NO_RUNNABLE_ADAPTER",
          note: "Rendered-browser discovery did not produce a runnable typed adapter."
        });
      }
      if (
        playbookRuntime?.assessment.nextStage === "LOCAL_READER" &&
        !localReaderEligible
      ) {
        playbookRuntime = await skipSearchPlaybookStage(playbookRuntime, {
          stage: "LOCAL_READER",
          readPath: "LOCAL_READER",
          evidenceKind: "TOOLING",
          failureFingerprint:
            SEARCH_PLAYBOOK_FINGERPRINTS.STAGE_NOT_APPLICABLE,
          skipReason: "NO_LOCAL_READER_CAPABILITY",
          note: "No verified local-reader capability exists for this booking page."
        });
        courseResults.push({
          ...buildPlaybookPendingCourseReport(
            course,
            "Manual review is needed because no verified public-page reader is available."
          ),
          outcome: "NEEDS_ADAPTER",
          supportStatus:
            course.supportIncident?.status === "NEEDS_HUMAN"
              ? "NEEDS_HUMAN_REVIEW"
              : "IN_OPERATOR_QUEUE"
        });
        return;
      }
      if (
        playbookRuntime?.assessment.nextStage === "INDEPENDENT_CONFIRMATION"
      ) {
        courseResults.push({
          ...buildPlaybookPendingCourseReport(
            course,
            "An independent signed-out confirmation is required before monitoring can be finalized."
          ),
          outcome: "NEEDS_ADAPTER",
          supportStatus:
            course.supportIncident?.status === "NEEDS_HUMAN"
              ? "NEEDS_HUMAN_REVIEW"
              : "IN_OPERATOR_QUEUE"
        });
        return;
      }

      const engineerApprovedTechnicalFinal =
        course.monitoringStatus?.state === "FINAL_TECHNICAL";
      const technicalRevalidationRunning =
        course.monitoringStatus?.state === "REVALIDATING_FINAL";
      const automatedTechnicalClassification =
        monitoringGate.disposition === "TECHNICAL_FINAL" &&
        !engineerApprovedTechnicalFinal &&
        !technicalRevalidationRunning;
      const localReaderCanOverrideGate =
        localReaderEligible &&
        playbookRuntime?.assessment.nextStage === "LOCAL_READER" &&
        !engineerApprovedTechnicalFinal &&
        monitoringGate.disposition === "TECHNICAL_FINAL" &&
        (localReaderOnly || course.automationReason === "CAPTCHA_OR_QUEUE");
      const incompleteOpenFactualCycle = Boolean(
        playbookRuntime &&
          (monitoringGate.disposition === "MANUAL_FINAL" ||
            monitoringGate.disposition === "IDENTITY_FINAL") &&
          playbookRuntime.assessment.conclusion !== "FACTUAL_FINAL"
      );
      if (incompleteOpenFactualCycle) {
        const message =
          "Current course facts changed while monitoring review was in progress; a fresh identity cycle is required before final classification.";
        const supportIssue = await reportCourseSupportIssue({
          course,
          searchId: search.id,
          episodeStartedAt: getCourseFailureEpisodeStartedAt(course),
          kind: "NEEDS_ADAPTER",
          message,
          readPath: "OFFICIAL_LINK_VERIFICATION",
          nextAction:
            "Start a fresh current-cycle official identity review before applying a direct final disposition."
        });
        supportIssues.push({ courseId: course.id, ...supportIssue });
        monitoringRetryCourseIds.add(course.id);
        await recordCourseProbeIfChanged({
          searchId: search.id,
          courseId: course.id,
          observedAtOrAfter: customerEndpointStartedAt,
          automationRunId,
          runtimeVersion,
          outcome: "IDENTITY_RECHECK",
          message,
          rawSummary: {
            monitoringDisposition: "IDENTITY_RECHECK",
            playbookConclusion: playbookRuntime?.assessment.conclusion
          }
        });
        courseResults.push({
          courseId: course.id,
          courseName: course.name,
          timeZone: course.timeZone,
          outcome: "IDENTITY_RECHECK",
          availableMatches: 0,
          message,
          supportStatus: supportIssue.incidentId
            ? supportIssue.status === "NEEDS_HUMAN"
              ? "NEEDS_HUMAN_REVIEW"
              : "IN_OPERATOR_QUEUE"
            : undefined
        });
        return;
      }
      if (
        monitoringGate.disposition !== "ACTIONABLE" &&
        !localReaderCanOverrideGate &&
        !automatedTechnicalClassification &&
        !technicalRevalidationRunning
      ) {
        const outcome =
          monitoringGate.disposition === "TECHNICAL_FINAL"
            ? "BLOCKED_AUTH"
            : monitoringGate.disposition === "MANUAL_FINAL"
              ? "MANUAL_DIRECT"
              : monitoringGate.disposition === "IDENTITY_FINAL"
                ? "IDENTITY_FINAL"
                : "IDENTITY_RECHECK";
        const identityBlocked =
          monitoringGate.disposition === "IDENTITY_FINAL" ||
          monitoringGate.disposition === "IDENTITY_RECHECK";
        const message = getFinalMonitoringMessage(
          course,
          monitoringGate.disposition
        );
        await markMissingMatchesUnavailable({
          searchId: search.id,
          alertGeneration: search.alertGeneration,
          checkLeaseToken: lease.token,
          courseId: course.id,
          date: searchWindow.date,
          timeZone: course.timeZone,
          confirmedMatches: []
        });
        await recordCourseProbeIfChanged({
          searchId: search.id,
          courseId: course.id,
          observedAtOrAfter: customerEndpointStartedAt,
          automationRunId,
          runtimeVersion,
          outcome,
          message,
          rawSummary: {
            monitoringDisposition: monitoringGate.disposition,
            automationReason: course.automationReason
          }
        });
        if (monitoringGate.disposition !== "IDENTITY_RECHECK") {
          if (monitoringGate.disposition === "MANUAL_FINAL") {
            await recordCourseMonitoringFinalClassification({
              courseId: course.id,
              state: "FINAL_MANUAL",
              outcome: "MANUAL_DIRECT",
              message,
              runtimeVersion
            });
          } else if (monitoringGate.disposition === "IDENTITY_FINAL") {
            await recordCourseMonitoringFinalClassification({
              courseId: course.id,
              state: "FINAL_IDENTITY",
              outcome: "IDENTITY_FINAL",
              message,
              runtimeVersion
            });
          }
        }
        courseResults.push({
          courseId: course.id,
          courseName: course.name,
          timeZone: course.timeZone,
          outcome,
          availableMatches: 0,
          message,
          bookingUrl: identityBlocked
            ? undefined
            : getCustomerBookingUrl(course),
          phone: identityBlocked
            ? undefined
            : (course.bookingPhone ?? course.phone ?? undefined),
          bookingMethod: course.bookingMethod,
          bookingAccessMode: course.bookingAccessMode,
          bookingAccess: identityBlocked
            ? undefined
            : getCourseBookingAccess(course),
          automationReason: course.automationReason,
          monitoringDisposition: monitoringGate.disposition
        });
        return;
      }

      if (
        requestedLayoutHoles &&
        course.layoutHolesVerifiedAt &&
        getCourseLayoutCompatibility(
          course.layoutHoleCounts,
          requestedLayoutHoles
        ) === "incompatible"
      ) {
        const message = `${course.name} is verified as ${getCourseLayoutLabel(
          course.layoutHoleCounts
        )} and does not match the requested ${requestedLayoutHoles}-hole physical course layout.`;
        await markMissingMatchesUnavailable({
          searchId: search.id,
          alertGeneration: search.alertGeneration,
          checkLeaseToken: lease.token,
          courseId: course.id,
          date: searchWindow.date,
          timeZone: course.timeZone,
          confirmedMatches: []
        });
        await recordCourseProbeIfChanged({
          searchId: search.id,
          courseId: course.id,
          observedAtOrAfter: customerEndpointStartedAt,
          automationRunId,
          runtimeVersion,
          outcome: "NO_MATCH",
          message
        });
        courseResults.push({
          courseId: course.id,
          courseName: course.name,
          timeZone: course.timeZone,
          outcome: "NO_MATCH",
          availableMatches: 0,
          message,
          bookingUrl: getCustomerBookingUrl(course),
          phone: course.bookingPhone ?? course.phone ?? undefined,
          bookingMethod: course.bookingMethod,
          bookingAccessMode: course.bookingAccessMode,
          bookingAccess: getCourseBookingAccess(course)
        });
        return;
      }

      if (localReaderOnly && !localReaderEligible) {
        const message =
          "This course is configured for rendered-page monitoring, but its booking page is not allowlisted.";
        await recordCourseProbeIfChanged({
          searchId: search.id,
          courseId: course.id,
          observedAtOrAfter: customerEndpointStartedAt,
          automationRunId,
          runtimeVersion,
          outcome: "BLOCKED_TOOLING",
          message,
          rawSummary: {
            monitoringMode: course.monitoringMode,
            nextAction: "repair-local-reader-configuration"
          }
        });
        const supportIssue = await reportCourseSupportIssue({
          course,
          searchId: search.id,
          episodeStartedAt: getCourseFailureEpisodeStartedAt(course),
          kind: "BLOCKED_TOOLING",
          message,
          readPath: "LOCAL_READER_CONFIGURATION",
          nextAction:
            "Correct the exact local-reader allowlist or return the course to automatic monitoring."
        });
        supportIssues.push({ courseId: course.id, ...supportIssue });
        courseResults.push({
          courseId: course.id,
          courseName: course.name,
          timeZone: course.timeZone,
          outcome: "NEEDS_ADAPTER",
          availableMatches: 0,
          message,
          bookingUrl: customerBookingUrl,
          phone: course.bookingPhone ?? course.phone ?? undefined,
          bookingMethod: course.bookingMethod,
          bookingAccessMode: course.bookingAccessMode,
          bookingAccess: getCourseBookingAccess(course),
          supportStatus: supportIssue.incidentId
            ? supportIssue.status === "NEEDS_HUMAN"
              ? "NEEDS_HUMAN_REVIEW"
              : "IN_OPERATOR_QUEUE"
            : undefined
        });
        return;
      }

      if (
        !supportedAdapterAvailable &&
        !localReaderOnly &&
        playbookRuntime?.assessment.nextStage !== "LOCAL_READER"
      ) {
        if (
          monitoringPreparationFailed ||
          monitoringDeferredCourseIds.has(course.id)
        ) {
          monitoringRetryCourseIds.add(course.id);
          const message =
            "Official booking-source review is queued and will retry shortly before monitoring support is classified.";
          await recordCourseProbeIfChanged({
            searchId: search.id,
            courseId: course.id,
            observedAtOrAfter: customerEndpointStartedAt,
            automationRunId,
            runtimeVersion,
            outcome: "NEEDS_ADAPTER",
            message,
            rawSummary: {
              nextAction: "official-source-discovery-retry"
            }
          });
          courseResults.push({
            courseId: course.id,
            courseName: course.name,
            timeZone: course.timeZone,
            outcome: "NEEDS_ADAPTER",
            availableMatches: 0,
            message,
            bookingUrl: getCustomerBookingUrl(course),
            phone: course.bookingPhone ?? course.phone ?? undefined,
            bookingMethod: course.bookingMethod,
            bookingAccessMode: course.bookingAccessMode,
            bookingAccess: getCourseBookingAccess(course)
          });
          return;
        }
        const browserProbeUrl = getBestProbeUrl(course);
        const browserProbeQueued = shouldQueueBrowserProbe(course);
        const message = browserProbeQueued
          ? "Official booking surface inspected; no reusable public read-only monitoring connection was confirmed."
          : "No public booking surface is currently available for automated monitoring.";
        await recordCourseProbeIfChanged({
          searchId: search.id,
          courseId: course.id,
          observedAtOrAfter: customerEndpointStartedAt,
          automationRunId,
          runtimeVersion,
          outcome: "NEEDS_ADAPTER",
          message,
          rawSummary: {
            nextAction: "automation:adapter-remediation",
            browserProbeUrl
          }
        });
        const supportIssue = await reportCourseSupportIssue({
          course,
          searchId: search.id,
          episodeStartedAt: getCourseFailureEpisodeStartedAt(course),
          kind: "NEEDS_ADAPTER",
          message,
          readPath: browserProbeQueued
            ? "SIGNED_OUT_BROWSER_DISCOVERY"
            : "OFFICIAL_LINK_VERIFICATION",
          nextAction: browserProbeQueued
            ? `Build or extend a reusable public read-only adapter from the completed official-site discovery for ${browserProbeUrl}, then verify this search.`
            : "Autonomously classify the official booking method, find a public read-only retrieval path if one exists, and verify this search."
        });
        supportIssues.push({ courseId: course.id, ...supportIssue });
        let missingAdapterPlaybook = await loadSearchPlaybookRuntime({
          courseId: course.id,
          incidentId: supportIssue.incidentId,
          runtimeVersion
        });
        if (
          missingAdapterPlaybook?.assessment.nextStage ===
          "OFFICIAL_IDENTITY"
        ) {
          missingAdapterPlaybook = customerBookingUrl
            ? await ensureSearchPlaybookOfficialIdentity(
                missingAdapterPlaybook
              )
            : await recordSearchPlaybookAttempt(missingAdapterPlaybook, {
                stage: "OFFICIAL_IDENTITY",
                transition: "FAILED_TERMINAL",
                readPath: "OFFICIAL_IDENTITY",
                evidenceKind: "OFFICIAL_SOURCE",
                failureFingerprint:
                  SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_IDENTITY_MISSING,
                failureClass: "MISSING_SOURCE",
                note: "No current official booking destination was available."
              });
        }
        if (
          missingAdapterPlaybook?.assessment.nextStage === "TYPED_ADAPTER"
        ) {
          await skipSearchPlaybookStage(missingAdapterPlaybook, {
            stage: "TYPED_ADAPTER",
            readPath: "TYPED_PROVIDER_ADAPTER",
            evidenceKind: "TOOLING",
            failureFingerprint:
              SEARCH_PLAYBOOK_FINGERPRINTS.STAGE_NOT_APPLICABLE,
            skipReason: "NO_RUNNABLE_ADAPTER",
            note: "No existing runnable typed adapter was available."
          });
        }
        courseResults.push({
          courseId: course.id,
          courseName: course.name,
          timeZone: course.timeZone,
          outcome: "NEEDS_ADAPTER",
          availableMatches: 0,
          message,
          bookingUrl: getCustomerBookingUrl(course),
          phone: course.bookingPhone ?? course.phone ?? undefined,
          bookingMethod: course.bookingMethod,
          bookingAccessMode: course.bookingAccessMode,
          bookingAccess: getCourseBookingAccess(course),
          supportStatus: supportIssue.incidentId
            ? supportIssue.status === "NEEDS_HUMAN"
              ? "NEEDS_HUMAN_REVIEW"
              : "IN_OPERATOR_QUEUE"
            : undefined
        });
        return;
      }

      const checkStartedAt = new Date();
      const storedBookingWindow = getBookingWindowForTargetDate(
        search.date,
        course
      );
      const refreshBookingWindow =
        shouldRefreshBookingWindow(
          course.bookingWindowObservedAt,
          checkStartedAt
        ) &&
        shouldRetryBookingWindowDiscovery(
          course.bookingWindowCheckedAt,
          checkStartedAt
        );
      if (
        storedBookingWindow &&
        storedBookingWindow.opensAt > checkStartedAt &&
        !refreshBookingWindow
      ) {
        await recordBookingWindowWaitingProbe({
          searchId: search.id,
          courseId: course.id,
          observedAtOrAfter: customerEndpointStartedAt,
          automationRunId,
          runtimeVersion,
          targetDate: searchWindow.date,
          bookingWindow: storedBookingWindow
        });
        courseResults.push(
          buildBookingWindowCourseReport(course, storedBookingWindow)
        );
        return;
      }

      let providerRequestStarted = false;
      const activePlaybookStage = getRunnableSearchPlaybookStage(
        playbookRuntime
      );
      const browserAdapterRetryCompletedAt =
        playbookRuntime?.assessment.stages.find(
          (stage) => stage.stage === "BROWSER_ADAPTER_RETRY"
        )?.completedAt ?? null;
      const localReaderNotBefore =
        activePlaybookStage === "LOCAL_READER" && browserAdapterRetryCompletedAt
          ? new Date(browserAdapterRetryCompletedAt)
          : undefined;
      try {
        const localReaderShouldRun =
          localReaderEligible &&
          playbookRuntime?.assessment.nextStage === "LOCAL_READER";
        const localReaderObservation = localReaderShouldRun
          ? await getFreshLocalReaderObservation({
              searchId: search.id,
              courseId: course.id,
              targetDate: searchWindow.date,
              players: search.players,
              bookingUrl: customerBookingUrl!,
              ...(localReaderNotBefore ? { notBefore: localReaderNotBefore } : {})
            })
          : null;
        if (
          localReaderObservation &&
          !localReaderObservation.teeSheet &&
          ["ACCESS_CHALLENGE", "PAGE_MISMATCH", "READER_ERROR"].includes(
            localReaderObservation.status
          ) &&
          playbookRuntime?.assessment.nextStage === "LOCAL_READER"
        ) {
          const accessChallenge =
            localReaderObservation.status === "ACCESS_CHALLENGE";
          playbookRuntime = await recordSearchPlaybookAttemptResult(
            playbookRuntime,
            accessChallenge
              ? {
                  stage: "LOCAL_READER",
                  transition: "TECHNICAL_LIMITATION",
                  readPath: "LOCAL_READER",
                  evidenceKind: "LOCAL_READER_RESULT",
                  failureFingerprint:
                    SEARCH_PLAYBOOK_FINGERPRINTS.LOCAL_READER_CHALLENGE,
                  technicalReason: "CAPTCHA_OR_QUEUE",
                  note: "The signed-out local reader observed an access challenge.",
                  observedAt: localReaderObservation.observedAt
                }
              : {
                  stage: "LOCAL_READER",
                  transition: "FAILED_TERMINAL",
                  readPath: "LOCAL_READER",
                  evidenceKind: "LOCAL_READER_RESULT",
                  failureFingerprint:
                    SEARCH_PLAYBOOK_FINGERPRINTS.LOCAL_READER_TERMINAL,
                  failureClass:
                    localReaderObservation.status === "PAGE_MISMATCH"
                      ? "SCHEMA"
                      : "UNKNOWN",
                  note: "The bounded local-reader attempt ended without a tee sheet.",
                  observedAt: localReaderObservation.observedAt
                }
          );
          const message = accessChallenge
            ? "The public booking page requires an independent signed-out confirmation before monitoring can be finalized."
            : "The public-page reader ended without a usable tee sheet; manual review is the next step.";
          await recordCourseProbeIfChanged({
            searchId: search.id,
            courseId: course.id,
            observedAtOrAfter: customerEndpointStartedAt,
            automationRunId,
            runtimeVersion: localReaderObservation.readerVersion,
            outcome: "FETCH_FAILED",
            message,
            rawSummary: {
              providerExecution: "LOCAL_BROWSER_READER",
              readerStatus: localReaderObservation.status,
              playbookConclusion: playbookRuntime.assessment.conclusion
            }
          });
          courseResults.push({
            ...buildPlaybookPendingCourseReport(course, message),
            outcome: "FETCH_FAILED",
            supportStatus:
              course.supportIncident?.status === "NEEDS_HUMAN"
                ? "NEEDS_HUMAN_REVIEW"
                : "IN_OPERATOR_QUEUE"
          });
          return;
        }
        const localTeeSheet = localReaderObservation?.teeSheet ?? null;
        let teeSheet: CourseTeeSheetResult | null = localTeeSheet;
        let providerExecutionLabel = "LOCAL_BROWSER_READER";
        if (!teeSheet && localReaderShouldRun) {
          throw new Error("The required local-reader result is not ready.");
        }
        if (!teeSheet && !supportedAdapterAvailable) {
          throw new Error(
            "No reusable server adapter is available for this course."
          );
        }
        if (!teeSheet) {
          const providerExecution = await runWithProviderRequestLease(
              providerFamilyKey,
              () => {
                providerRequestStarted = true;
                return fetchCourseTeeSheet(
                  course,
                  search.date,
                  search.players,
                  refreshBookingWindow
                );
              }
            );
          if (!providerExecution.acquired) {
              monitoringRetryCourseIds.add(course.id);
              courseResults.push({
                courseId: course.id,
                courseName: course.name,
                timeZone: course.timeZone,
                outcome: "FETCH_FAILED",
                availableMatches: 0,
                message:
                  "This provider check was deferred by the global concurrency guard and will retry.",
                bookingUrl: getCustomerBookingUrl(course),
                phone: course.bookingPhone ?? course.phone ?? undefined,
                bookingMethod: course.bookingMethod,
                bookingAccessMode: course.bookingAccessMode,
                bookingAccess: getCourseBookingAccess(course)
              });
            return;
          }
          teeSheet = providerExecution.value;
          providerExecutionLabel = "RUNNABLE_PROVIDER_CHECK";
        }
        await maintainSearchCheckLease(lease);
        const rawSlots = teeSheet.slots;
        let bookingWindow = storedBookingWindow;
        if (teeSheet.bookingWindowEvidence) {
          await recordCourseBookingWindowEvidence({
            courseId: course.id,
            evidence: teeSheet.bookingWindowEvidence,
            observedAt: checkStartedAt
          });
          bookingWindow = getBookingWindowFromEvidence(
            search.date,
            course.timeZone,
            teeSheet.bookingWindowEvidence
          );
        } else if (refreshBookingWindow) {
          await markCourseBookingWindowChecked(course.id, checkStartedAt);
        }
        if (bookingWindow && bookingWindow.opensAt > checkStartedAt) {
          await recordBookingWindowWaitingProbe({
            searchId: search.id,
            courseId: course.id,
            observedAtOrAfter: customerEndpointStartedAt,
            automationRunId,
            runtimeVersion,
            targetDate: searchWindow.date,
            bookingWindow,
            providerExecution: true
          });
          await recordSearchPlaybookSuccess(
            playbookRuntime,
            activePlaybookStage,
            providerExecutionLabel
          );
          await recordCourseMonitoringSuccess({
            courseId: course.id,
            outcome: "NO_MATCH",
            message: "Fresh public monitoring confirmed the booking release window.",
            runtimeVersion
          });
          courseResults.push(
            buildBookingWindowCourseReport(course, bookingWindow)
          );
          return;
        }
        const safeRawSlots = rawSlots.flatMap((slot) => {
          const bookingUrl = getSafeOfficialBookingUrl(slot.bookingUrl);
          return bookingUrl ? [{ ...slot, bookingUrl }] : [];
        });
        const unsafeBookingUrlCount = rawSlots.length - safeRawSlots.length;
        const availability = summarizeSearchStatusAvailability(
          searchWindow,
          safeRawSlots
        );
        const bookableHoleCounts = summarizeBookableHoleCounts(safeRawSlots);
        const pricing = summarizeCourseSlotPrices(safeRawSlots);
        await recordCourseBookingFacts({
          courseId: course.id,
          pricing,
          bookableHoleCounts,
          observedAt: checkStartedAt
        });
        observedBookingFactsByCourse.set(course.id, {
          pricing,
          bookableHoleCounts,
          observedAt: checkStartedAt
        });
        const currentMatches = rankMatches(
          searchWindow,
          dedupeMatches(filterSlotsForSearch(searchWindow, safeRawSlots), [])
        );
        const normalizedCurrentMatches = currentMatches.map((match) => ({
          match,
          startsAt: parseCourseLocalDateTime(match.startsAt, course.timeZone)
        }));
        const persistedMatchStates: Array<{
          matchId?: string;
          isPending: boolean;
        }> = [];

        for (const { match, startsAt } of normalizedCurrentMatches) {
          const persistedMatch = await recordTeeTimeMatch({
            searchId: search.id,
            courseId: course.id,
            sourceId: match.sourceId,
            startsAt,
            availableSpots: match.availableSpots,
            bookingUrl: match.bookingUrl,
            priceCents: match.priceCents,
            holes: match.holes,
            evidenceUrl: match.evidenceUrl
          });
          persistedMatchStates.push({
            matchId: persistedMatch?.id,
            isPending: persistedMatch?.alertStatus === "PENDING"
          });
        }

        await markMissingMatchesUnavailable({
          searchId: search.id,
          alertGeneration: search.alertGeneration,
          checkLeaseToken: lease.token,
          courseId: course.id,
          date: searchWindow.date,
          timeZone: course.timeZone,
          confirmedMatches: normalizedCurrentMatches.map(
            ({ match, startsAt }) => ({
              sourceId: match.sourceId,
              startsAt
            })
          )
        });

        if (unsafeBookingUrlCount > 0) {
          const unsafeBookingMessage =
            "The provider returned a non-direct or unsafe booking destination; unsafe rows were excluded.";
          const supportIssue = await reportCourseSupportIssue({
            course,
            searchId: search.id,
            episodeStartedAt: getCourseFailureEpisodeStartedAt(course),
            kind: "FETCH_FAILED",
            message: unsafeBookingMessage,
            readPath: "ADAPTER_OUTPUT_VALIDATION",
            error: new Error(unsafeBookingMessage),
            nextAction:
              "Verify the provider adapter returns only direct public booking destinations."
          });
          supportIssues.push({ courseId: course.id, ...supportIssue });
          if (safeRawSlots.length === 0) {
            await recordCourseProbe({
              searchId: search.id,
              courseId: course.id,
              automationRunId,
              runtimeVersion,
              outcome: "FETCH_FAILED",
              message: unsafeBookingMessage,
              rawSummary: {
                providerExecution: providerExecutionLabel,
                unsafeBookingUrlCount
              }
            });
            courseResults.push({
              courseId: course.id,
              courseName: course.name,
              timeZone: course.timeZone,
              outcome: "FETCH_FAILED",
              availableMatches: 0,
              message: unsafeBookingMessage,
              bookingUrl: getCustomerBookingUrl(course),
              phone: course.bookingPhone ?? course.phone ?? undefined,
              bookingMethod: course.bookingMethod,
              bookingAccessMode: course.bookingAccessMode,
              bookingAccess: getCourseBookingAccess(course)
            });
            return;
          }
        }

        const outcome = currentMatches.length > 0 ? "MATCH_FOUND" : "NO_MATCH";
        await recordCourseProbe({
          searchId: search.id,
          courseId: course.id,
          observedAtOrAfter: customerEndpointStartedAt,
          automationRunId,
          runtimeVersion,
          outcome,
          message:
            currentMatches.length > 0
              ? `Confirmed ${currentMatches.length} qualifying tee times.`
              : "No qualifying tee times in the requested window",
          rawSummary: {
            providerExecution: providerExecutionLabel,
            ...availability,
            ...(bookableHoleCounts.length > 0 ? { bookableHoleCounts } : {}),
            ...(pricing ? { pricing } : {}),
            ...(unsafeBookingUrlCount > 0 ? { unsafeBookingUrlCount } : {})
          }
        });
        if (unsafeBookingUrlCount === 0) {
          await recordSearchPlaybookSuccess(
            playbookRuntime,
            activePlaybookStage,
            providerExecutionLabel
          );
          await recordCourseMonitoringSuccess({
            courseId: course.id,
            outcome,
            message:
              currentMatches.length > 0
                ? "Fresh public monitoring found matching availability."
                : "Fresh public monitoring completed with no matching availability.",
            runtimeVersion
          });
        }
        courseResults.push({
          courseId: course.id,
          courseName: course.name,
          timeZone: course.timeZone,
          outcome,
          availableMatches: currentMatches.length,
          bookingUrl:
            safeRawSlots[0]?.bookingUrl ?? getCustomerBookingUrl(course),
          phone: course.bookingPhone ?? course.phone ?? undefined,
          bookingMethod: safeRawSlots[0]?.bookingUrl
            ? "PUBLIC_ONLINE"
            : course.bookingMethod,
          bookingAccessMode: safeRawSlots[0]?.bookingUrl
            ? "PUBLIC_SIGNED_OUT"
            : course.bookingAccessMode,
          bookingAccess: safeRawSlots[0]?.bookingUrl
            ? "BOOKING_PAGE"
            : getCourseBookingAccess(course),
          availability,
          matchingTimes: currentMatches.map((match, index) => ({
            ...(persistedMatchStates[index]?.matchId
              ? { matchId: persistedMatchStates[index].matchId }
              : {}),
            startsAt: match.startsAt,
            availableSpots: match.availableSpots,
            priceCents: match.priceCents,
            holes: match.holes,
            bookableHoleCounts: match.bookableHoleCounts,
            isNew: persistedMatchStates[index]?.isPending === true
          }))
        });
      } catch (error) {
        await maintainSearchCheckLease(lease);
        let message =
          error instanceof Error ? error.message : "Unknown adapter error";
        const providerFailure = classifyProviderFailure({ error });
        const localReaderStageActive =
          localReaderEligible && activePlaybookStage === "LOCAL_READER";
        const localReaderJob =
          customerBookingUrl && localReaderStageActive
            ? await queueLocalReaderJob({
                searchId: search.id,
                courseId: course.id,
                scheduleVersion: search.scheduleVersion,
                targetDate: searchWindow.date,
                players: search.players,
                bookingUrl: customerBookingUrl,
                ...(localReaderNotBefore
                  ? { notBefore: localReaderNotBefore }
                  : {})
              })
            : null;
        const localReaderQueueDisposition =
          localReaderJob?.queueDisposition ?? "ACTIVE";
        const localReaderTerminalObservation =
          localReaderQueueDisposition === "TERMINAL";
        const localReaderTerminalFailure =
          localReaderQueueDisposition === "RETRYING_AFTER_TERMINAL_FAILURE" ||
          localReaderTerminalObservation;
        if (localReaderJob) {
          if (localReaderQueueDisposition === "ACTIVE") {
            if (
              playbookRuntime?.assessment.nextStage === "LOCAL_READER"
            ) {
              const readerStage = playbookRuntime.assessment.stages.find(
                (stage) => stage.stage === "LOCAL_READER"
              );
              if (readerStage?.status !== "STARTED") {
                await recordSearchPlaybookTransition(playbookRuntime, {
                stage: "LOCAL_READER",
                transition: "STARTED",
                readPath: "LOCAL_READER",
                evidenceKind: "LOCAL_READER_RESULT",
                failureFingerprint:
                  SEARCH_PLAYBOOK_FINGERPRINTS.LOCAL_READER_ATTEMPT,
                note: "A bounded signed-out local-reader attempt was queued."
                });
              }
            }
            monitoringRetryCourseIds.add(course.id);
            courseResults.push({
              courseId: course.id,
              courseName: course.name,
              timeZone: course.timeZone,
              outcome: "CHECK_PENDING",
              availableMatches: 0,
              message: "A fresh public-page tee-time check is in progress.",
              bookingUrl: getCustomerBookingUrl(course),
              phone: course.bookingPhone ?? course.phone ?? undefined,
              bookingMethod: course.bookingMethod,
              bookingAccessMode: course.bookingAccessMode,
              bookingAccess: getCourseBookingAccess(course)
            });
            return;
          }
          if (
            localReaderQueueDisposition === "RETRYING_AFTER_TERMINAL_FAILURE"
          ) {
            message =
              "The local public-page reader did not complete within its bounded check window; independent confirmation is required.";
          } else if (localReaderTerminalObservation) {
            message =
              localReaderJob.readerResultStatus === "ACCESS_CHALLENGE"
                ? "The public booking page requires direct access, so the signed-out reader stopped safely."
                : localReaderJob.readerResultStatus === "PAGE_MISMATCH"
                  ? "The public booking page no longer matches the verified reader layout."
                  : "The signed-out public-page reader completed with an error.";
          }
        }
        await recordCourseProbe({
            searchId: search.id,
            courseId: course.id,
            observedAtOrAfter: customerEndpointStartedAt,
            automationRunId,
          runtimeVersion,
          outcome: "FETCH_FAILED",
          message,
          rawSummary: providerRequestStarted
            ? { providerExecution: "RUNNABLE_PROVIDER_CHECK" }
            : undefined
        });
        const supportIssue = await reportCourseSupportIssue({
          course,
          searchId: search.id,
          episodeStartedAt: getCourseFailureEpisodeStartedAt(course),
          kind:
            localReaderTerminalFailure || localReaderStageActive
              ? "READER_CANDIDATE"
              : "FETCH_FAILED",
          message,
          error,
          readPath: localReaderTerminalObservation
            ? "LOCAL_READER_TERMINAL"
            : localReaderTerminalFailure
              ? "LOCAL_READER_ALLOWLIST"
              : localReaderOnly
                ? "LOCAL_READER_ONLY"
                : providerRequestStarted
                  ? "TYPED_PROVIDER_ADAPTER"
                  : "PUBLIC_PROVIDER_PRECHECK",
          nextAction: localReaderOnly
            ? "Keep the local reader enabled; this course intentionally skips server adapters and browser discovery."
            : localReaderEligible && !supportedAdapterAvailable
              ? "Build and test an exact fail-closed local reader parser and allowlist. If the installed extension bundle must change, request that precise pull and reload action."
              : "Inspect the adapter failure, repair or reclassify the course, and verify with a focused search check."
        });
        supportIssues.push({ courseId: course.id, ...supportIssue });
        let currentPlaybook = await loadSearchPlaybookRuntime({
          courseId: course.id,
          incidentId: supportIssue.incidentId,
          runtimeVersion
        });
        if (currentPlaybook?.assessment.nextStage === "OFFICIAL_IDENTITY") {
          currentPlaybook = customerBookingUrl
            ? await ensureSearchPlaybookOfficialIdentity(currentPlaybook)
            : await recordSearchPlaybookAttempt(currentPlaybook, {
                stage: "OFFICIAL_IDENTITY",
                transition: "FAILED_TERMINAL",
                readPath: "OFFICIAL_IDENTITY",
                evidenceKind: "OFFICIAL_SOURCE",
                failureFingerprint:
                  SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_IDENTITY_MISSING,
                failureClass: "MISSING_SOURCE",
                note: "No current official booking destination was available."
              });
        }
        if (localReaderOnly && currentPlaybook) {
          currentPlaybook = await skipPlaybookStagesBeforeLocalReader(
            currentPlaybook
          );
        }
        const failedStage = getRunnableSearchPlaybookStage(currentPlaybook);
        if (currentPlaybook && failedStage) {
          const stageAssessment = currentPlaybook.assessment.stages.find(
            (stage) => stage.stage === failedStage
          );
          const firstTypedFailure =
            failedStage === "TYPED_ADAPTER" &&
            (stageAssessment?.attemptCount ?? 0) === 0;
          if (
            failedStage === "LOCAL_READER" &&
            localReaderTerminalObservation &&
            localReaderJob?.readerResultStatus === "ACCESS_CHALLENGE"
          ) {
            await recordSearchPlaybookAttemptResult(currentPlaybook, {
              stage: "LOCAL_READER",
              transition: "TECHNICAL_LIMITATION",
              readPath: "LOCAL_READER",
              evidenceKind: "LOCAL_READER_RESULT",
              failureFingerprint:
                SEARCH_PLAYBOOK_FINGERPRINTS.LOCAL_READER_CHALLENGE,
              technicalReason: "CAPTCHA_OR_QUEUE",
              note: "The signed-out local reader observed an access challenge."
            });
          } else if (failedStage === "LOCAL_READER") {
            await recordSearchPlaybookAttemptResult(currentPlaybook, {
              stage: "LOCAL_READER",
              transition: "FAILED_TERMINAL",
              readPath: "LOCAL_READER",
              evidenceKind: "LOCAL_READER_RESULT",
              failureFingerprint:
                SEARCH_PLAYBOOK_FINGERPRINTS.LOCAL_READER_TERMINAL,
              failureClass: "UNKNOWN",
              note: "The bounded local-reader attempt ended without a tee sheet."
            });
          } else {
            await recordSearchPlaybookAttempt(currentPlaybook, {
              stage: failedStage,
              transition: firstTypedFailure
                ? "FAILED_RETRYABLE"
                : "FAILED_TERMINAL",
              readPath: "TYPED_PROVIDER_ADAPTER",
              evidenceKind: "PROVIDER_RESPONSE",
              failureFingerprint:
                failedStage === "TYPED_ADAPTER"
                  ? SEARCH_PLAYBOOK_FINGERPRINTS.TYPED_ADAPTER_ATTEMPT
                  : failedStage === "HTTP_ADAPTER_RETRY"
                    ? SEARCH_PLAYBOOK_FINGERPRINTS.HTTP_ADAPTER_RETRY
                    : SEARCH_PLAYBOOK_FINGERPRINTS.BROWSER_ADAPTER_RETRY,
              failureClass: providerFailure.failureClass,
              note: "The bounded typed-adapter attempt did not return a usable tee sheet."
            });
          }
          if (firstTypedFailure) {
            monitoringRetryCourseIds.add(course.id);
          }
        } else if (SHORT_SEARCH_RETRY_FAILURES.has(providerFailure.failureClass)) {
          monitoringRetryCourseIds.add(course.id);
        }
        courseResults.push({
          courseId: course.id,
          courseName: course.name,
          timeZone: course.timeZone,
          outcome: "FETCH_FAILED",
          availableMatches: 0,
          message,
          bookingUrl: getCustomerBookingUrl(course),
          phone: course.bookingPhone ?? course.phone ?? undefined,
          bookingMethod: course.bookingMethod,
          bookingAccessMode: course.bookingAccessMode,
          bookingAccess: getCourseBookingAccess(course),
          supportStatus: supportIssue.incidentId
            ? supportIssue.status === "NEEDS_HUMAN"
              ? "NEEDS_HUMAN_REVIEW"
              : "IN_OPERATOR_QUEUE"
            : undefined
        });
      }
    }
  );

  const preferenceContext = new Map(
    search.preferences.map((preference) => {
      const observedFacts = observedBookingFactsByCourse.get(
        preference.course.id
      );
      const storedPriceEstimate = buildCoursePriceEstimate({
        bookingFacts: preference.course.bookingFacts,
        probes: [],
        matches: []
      });
      const storedHoleSummary = buildObservedBookableHoleSummary({
        bookingFacts: preference.course.bookingFacts,
        probes: [],
        matches: []
      });
      return [
        preference.course.id,
        {
          rank: preference.rank,
          distanceMeters: preference.distanceMetersAtSelection ?? undefined,
          courseAddress: preference.course.address ?? undefined,
          isPublic: preference.course.isPublic,
          rating: preference.course.rating ?? undefined,
          ratingObservedAt: preference.course.ratingObservedAt?.toISOString(),
          layoutHoleCounts: preference.course.layoutHoleCounts,
          layoutHolesVerifiedAt:
            preference.course.layoutHolesVerifiedAt?.toISOString(),
          priceEstimate: observedFacts?.pricing ?? storedPriceEstimate,
          bookableHoleSummary:
            observedFacts && observedFacts.bookableHoleCounts.length > 0
              ? {
                  holeCounts: observedFacts.bookableHoleCounts,
                  observedAt: observedFacts.observedAt.toISOString()
                }
              : storedHoleSummary,
          courseGuideUrl:
            preference.course.profile &&
            ["PUBLISHED", "STALE"].includes(preference.course.profile.status)
              ? `/courses/${preference.course.profile.canonicalSlug}`
              : undefined,
          firstTimeLookup: isFirstTimeCourseLookup(
            search.createdAt,
            preference.course.createdAt
          )
        }
      ] as const;
    })
  );
  for (const courseResult of courseResults) {
    const context = preferenceContext.get(courseResult.courseId);
    courseResult.rank = context?.rank;
    courseResult.distanceMeters = context?.distanceMeters;
    courseResult.courseAddress = context?.courseAddress;
    courseResult.isPublic = context?.isPublic ?? undefined;
    courseResult.rating = context?.rating;
    courseResult.ratingObservedAt = context?.ratingObservedAt;
    courseResult.layoutHoleCounts = context?.layoutHoleCounts;
    courseResult.layoutHolesVerifiedAt = context?.layoutHolesVerifiedAt;
    courseResult.priceEstimate = context?.priceEstimate;
    courseResult.bookableHoleCounts = context?.bookableHoleSummary.holeCounts;
    courseResult.bookableHoleCountsObservedAt =
      context?.bookableHoleSummary.observedAt;
    courseResult.courseGuideUrl = context?.courseGuideUrl;
    courseResult.firstTimeLookup = context?.firstTimeLookup;
    courseResult.factLine = buildCourseFactLine(courseResult);
  }
  courseResults.sort((left, right) => (left.rank ?? 99) - (right.rank ?? 99));

  const retryCalculationStartedAt = new Date();
  const deadlineReconciliation = await reconcileCourseMonitoringDeadlines({
    courseIds: searchCourseIds,
    now: retryCalculationStartedAt,
    source: "SEARCH_WORKFLOW"
  });
  if (
    deadlineReconciliation.escalated > 0 ||
    deadlineReconciliation.retrying > 0
  ) {
    search = (await getActiveSearchForAutomation(searchId)) ?? search;
  }
  const persistedSupportRetryAt = await getCourseMonitoringRetryAt(
    supportIssues.map((issue) => issue.courseId),
    {
      transientRetryCourseIds: [...monitoringRetryCourseIds],
      now: retryCalculationStartedAt
    }
  );
  const unrecordedSupportRetryNeeded = supportIssues.some(
    (issue) => issue.status === "UNRECORDED"
  );
  let supportRetryAt =
    [
      ...(persistedSupportRetryAt ? [persistedSupportRetryAt] : []),
      ...(unrecordedSupportRetryNeeded
        ? [
            new Date(
              retryCalculationStartedAt.getTime() + FIRST_FAILURE_RETRY_MS
            )
          ]
        : [])
    ].sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  let supportRetryNeeded = supportRetryAt !== null;

  await maintainSearchCheckLease(lease);
  const checkedAt = new Date();
  applyCustomerMonitoringProjection(search, courseResults, checkedAt);
  const statusEmailsEnabled = areSearchStatusEmailsEnabled();
  const statusKindBeforeRetry = statusEmailsEnabled
    ? getEnabledSearchStatusEmailKind(
        getSearchStatusEmailKind(
          search.statusEmailSentAt,
          checkedAt,
          search.userTimeZone
        )
      )
    : null;
  const retriedDeliveries = await retryExistingSearchEmailDeliveryGroups({
    searchId: search.id,
    alertGeneration: search.alertGeneration,
    lease,
    assertCurrent: () => maintainSearchCheckLease(lease)
  });
  const retriedMatchCoveredDaily =
    statusKindBeforeRetry === "daily" &&
    retriedDeliveries.ownerSentMatchCount > 0;
  if (retriedMatchCoveredDaily) {
    const updated = await markSearchStatusEmailSent({
      searchId: search.id,
      alertGeneration: search.alertGeneration,
      checkLeaseToken: lease.token,
      sentAt: checkedAt,
      snapshot: preserveAlertGenerationClockInStatusSnapshot({
        alertGeneration: search.alertGeneration,
        currentStatusEmailSnapshot: search.statusEmailSnapshot,
        courseSnapshot: toSearchEmailJson(
          buildSearchStatusSnapshot(courseResults)
        )
      })
    });
    if (updated.count !== 1) {
      throw new SearchCheckLeaseLostError();
    }
    newlyAlertedMatches += retriedDeliveries.ownerSentMatchCount;
  }
  let pendingStatusReplacement = statusEmailsEnabled
    ? await getPendingStatusEmailReplacement({
        searchId: search.id,
        alertGeneration: search.alertGeneration
      })
    : null;
  if (
    pendingStatusReplacement &&
    !isSearchEmailDeliveryEnabled(pendingStatusReplacement.kind)
  ) {
    pendingStatusReplacement = null;
  }
  if (retriedMatchCoveredDaily && pendingStatusReplacement?.kind === "DAILY") {
    const satisfied = await satisfyPendingDailyStatusReplacementWithMatch({
      searchId: search.id,
      alertGeneration: search.alertGeneration,
      checkLeaseToken: lease.token,
      groups: pendingStatusReplacement.groups,
      now: checkedAt
    });
    if (!satisfied.current) {
      throw new SearchCheckLeaseLostError();
    }
    pendingStatusReplacement = null;
  }
  search = (await getActiveSearchForAutomation(searchId)) ?? search;
  applyCustomerMonitoringProjection(search, courseResults, checkedAt);
  await maintainSearchCheckLease(lease);
  let monitoringNoticeOutcome: SearchCheckResult["statusEmailOutcome"] =
    "skipped";
  if (
    statusEmailsEnabled &&
    !pendingStatusReplacement &&
    search.statusEmailSentAt
  ) {
    try {
      const delivered = await deliverMonitoringStatusNotices({
        search,
        searchWindow,
        courseResults,
        monitoringBeforeCheck,
        ownerMatchCourseIds: retriedDeliveries.ownerSentMatchCourseIds,
        checkedAt,
        lease,
        assertCurrent: () => maintainSearchCheckLease(lease)
      });
      monitoringNoticeOutcome = delivered.outcome;
      newlyAlertedMatches += delivered.ownerSentMatchCount;
      if (
        delivered.nextConsolidationAt &&
        (!supportRetryAt || delivered.nextConsolidationAt < supportRetryAt)
      ) {
        supportRetryAt = delivered.nextConsolidationAt;
        supportRetryNeeded = true;
      }
      search = (await getActiveSearchForAutomation(searchId)) ?? search;
      applyCustomerMonitoringProjection(search, courseResults, checkedAt);
    } catch (error) {
      if (error instanceof SearchCheckLeaseLostError) {
        throw error;
      }
      monitoringNoticeOutcome = "failed";
      console.error("[email:monitoring-status-failed]", {
        searchRef: createSearchLogReference(search.id),
        message:
          error instanceof Error
            ? error.message
            : "Unknown monitoring status email failure"
      });
    }
  }
  await maintainSearchCheckLease(lease);
  const statusEmailKind = statusEmailsEnabled
    ? pendingStatusReplacement
      ? pendingStatusReplacement.kind === "SETUP"
        ? "setup"
        : "daily"
      : getEnabledSearchStatusEmailKind(
          getSearchStatusEmailKind(
            search.statusEmailSentAt,
            checkedAt,
            search.userTimeZone
          )
        )
    : null;
  let statusEmailOutcome: SearchCheckResult["statusEmailOutcome"] =
    retriedMatchCoveredDaily
      ? "covered_by_match_alert"
      : monitoringNoticeOutcome;

  if (pendingStatusReplacement) {
    try {
      const pendingMatches = await listPendingMatchAlerts(
        searchId,
        getCurrentMatchIds(courseResults)
      );
      const coveredPendingMatchIds = getCoveredPendingMatchIds(
        pendingMatches,
        courseResults
      );
      const coveredMatchIds = coveredPendingMatchIds;
      const coveredPendingMatchIdSet = new Set(coveredPendingMatchIds);
      statusEmailOutcome = await deliverSearchStatusReport({
        search,
        searchWindow,
        courseResults,
        checkedAt,
        kind: statusEmailKind ?? "daily",
        coveredMatchIds,
        coveredMatchRefs: pendingMatches
          .filter((match) => coveredPendingMatchIdSet.has(match.id))
          .map((match) => ({
            matchId: match.id,
            availabilityCycle: match.availabilityCycle
          })),
        supersededStatusGroups: pendingStatusReplacement.groups,
        lease,
        assertCurrent: () => maintainSearchCheckLease(lease)
      });
      newlyAlertedMatches =
        coveredMatchIds.length > 0 &&
        (statusEmailOutcome === "sent" || statusEmailOutcome === "dry_run")
          ? coveredMatchIds.length
          : 0;
    } catch (error) {
      statusEmailOutcome = "failed";
      console.error("[email:status-replacement-failed]", {
        searchRef: createSearchLogReference(search.id),
        message:
          error instanceof Error
            ? error.message
            : "Unknown status email failure"
      });
    }
  } else if (
    statusEmailKind === "setup" &&
    !isInitialSearchStatusReportReady(courseResults, search.preferences.length)
  ) {
    const matchDelivery = await sendPendingMatchAlerts(searchId, {
      searchWindow,
      courseResults,
      checkedAt,
      requestedLayoutHoles,
      satisfiesStatusReport: false,
      lease,
      assertCurrent: () => maintainSearchCheckLease(lease)
    });
    newlyAlertedMatches += matchDelivery.ownerSentMatchCount;
    statusEmailOutcome = "skipped";
  } else if (statusEmailKind === "setup") {
    try {
      const setupPendingMatches = await listPendingMatchAlerts(
        searchId,
        getCurrentMatchIds(courseResults)
      );
      const coveredPendingMatchIds = getCoveredPendingMatchIds(
        setupPendingMatches,
        courseResults
      );
      const coveredPendingMatchIdSet = new Set(coveredPendingMatchIds);
      statusEmailOutcome = await deliverSearchStatusReport({
        search,
        searchWindow,
        courseResults,
        checkedAt,
        kind: statusEmailKind,
        coveredMatchIds: coveredPendingMatchIds,
        coveredMatchRefs: setupPendingMatches
          .filter((match) => coveredPendingMatchIdSet.has(match.id))
          .map((match) => ({
            matchId: match.id,
            availabilityCycle: match.availabilityCycle
          })),
        lease,
        assertCurrent: () => maintainSearchCheckLease(lease)
      });
      newlyAlertedMatches =
        statusEmailOutcome === "sent" || statusEmailOutcome === "dry_run"
          ? coveredPendingMatchIds.length
          : 0;
    } catch (error) {
      statusEmailOutcome = "failed";
      console.error("[email:status-failed]", {
        searchRef: createSearchLogReference(search.id),
        message:
          error instanceof Error
            ? error.message
            : "Unknown status email failure"
      });
    }
  } else {
    const matchDelivery = await sendPendingMatchAlerts(searchId, {
      searchWindow,
      courseResults,
      checkedAt,
      requestedLayoutHoles,
      satisfiesStatusReport: statusEmailKind === "daily",
      lease,
      assertCurrent: () => maintainSearchCheckLease(lease)
    });
    newlyAlertedMatches += matchDelivery.ownerSentMatchCount;

    if (
      statusEmailKind === "daily" &&
      (newlyAlertedMatches > 0 || matchDelivery.hasDurableMatchObligation)
    ) {
      statusEmailOutcome = "covered_by_match_alert";
    } else if (statusEmailKind === "daily") {
      try {
        statusEmailOutcome = await deliverSearchStatusReport({
          search,
          searchWindow,
          courseResults,
          checkedAt,
          kind: statusEmailKind,
          lease,
          assertCurrent: () => maintainSearchCheckLease(lease)
        });
      } catch (error) {
        statusEmailOutcome = "failed";
        console.error("[email:status-failed]", {
          searchRef: createSearchLogReference(search.id),
          message:
            error instanceof Error
              ? error.message
              : "Unknown status email failure"
        });
      }
    }
  }

  return {
    searchId,
    outcome: "success",
    courseResults,
    availableMatches: courseResults.reduce(
      (total, course) => total + course.availableMatches,
      0
    ),
    newlyAlertedMatches,
    supportRetryNeeded,
    supportRetryAt,
    statusEmailOutcome
  };
}

function getEnabledSearchStatusEmailKind(
  kind: SearchStatusEmailKind | null
): SearchStatusEmailKind | null {
  if (!kind) {
    return null;
  }
  return isSearchEmailDeliveryEnabled(kind === "setup" ? "SETUP" : "DAILY")
    ? kind
    : null;
}

function getCoveredPendingMatchIds(
  pendingMatches: Array<{
    id: string;
    course: { id: string };
  }>,
  courseResults: SearchCheckCourseResult[]
) {
  const pendingMatchIds = new Set(pendingMatches.map((match) => match.id));
  return [
    ...new Set(
      courseResults.flatMap((course) =>
        (course.matchingTimes ?? [])
          .map((match) => match.matchId)
          .filter(
            (matchId): matchId is string =>
              typeof matchId === "string" && pendingMatchIds.has(matchId)
          )
      )
    )
  ];
}

function getCurrentMatchIds(courseResults: SearchCheckCourseResult[]) {
  return [
    ...new Set(
      courseResults.flatMap((course) =>
        (course.matchingTimes ?? []).flatMap((time) =>
          typeof time.matchId === "string" ? [time.matchId] : []
        )
      )
    )
  ];
}

async function retryExistingSearchEmailDeliveryGroups(input: {
  searchId: string;
  alertGeneration: number;
  lease: SearchCheckLease;
  assertCurrent: () => Promise<void>;
}) {
  const seen = new Set<string>();
  let ownerSentMatchCount = 0;
  const ownerSentMatchCourseIds = new Set<string>();
  for (let pass = 0; pass < 100; pass += 1) {
    const groups = await listRetryableSearchEmailDeliveryGroups({
      searchId: input.searchId,
      alertGeneration: input.alertGeneration
    });
    const group = groups.find(
      (candidate) => !seen.has(`${candidate.kind}\u0000${candidate.groupKey}`)
    );
    if (!group) {
      return {
        ownerSentMatchCount,
        ownerSentMatchCourseIds: [...ownerSentMatchCourseIds]
      };
    }
    seen.add(`${group.kind}\u0000${group.groupKey}`);
    await input.assertCurrent();
    let deliveryError: unknown;
    const groupMatchCourseIds = new Set<string>();
    try {
      await drainSearchEmailDeliveryGroup({
        searchId: input.searchId,
        alertGeneration: input.alertGeneration,
        checkLeaseToken: input.lease.token,
        kind: group.kind,
        groupKey: group.groupKey,
        send: async ({
          recipient,
          idempotencyKey,
          payload,
          assertCurrentDelivery
        }) => {
          await input.assertCurrent();
          if (group.kind === "MATCH") {
            const alert = await hydrateMatchAlertPayload({
              searchId: input.searchId,
              alertGeneration: input.alertGeneration,
              payload
            });
            for (const match of alert.matches) {
              if (match.courseId) {
                groupMatchCourseIds.add(match.courseId);
              }
            }
            await input.assertCurrent();
            await assertCurrentDelivery();
            return sendTeeTimeAlert({
              searchId: input.searchId,
              to: recipient,
              ...alert,
              stableIdempotencyKey: idempotencyKey
            });
          }
          const report = await hydrateSearchStatusEmailPayload(payload);
          await input.assertCurrent();
          await assertCurrentDelivery();
          return sendSearchStatusEmail({
            searchId: input.searchId,
            to: recipient,
            ...report,
            stableIdempotencyKey: idempotencyKey
          });
        }
      });
    } catch (error) {
      if (error instanceof SearchCheckLeaseLostError) {
        throw error;
      }
      deliveryError = error;
    }
    await input.assertCurrent();
    try {
      const finalized = await finalizeSearchEmailDeliveryGroup({
        searchId: input.searchId,
        alertGeneration: input.alertGeneration,
        kind: group.kind,
        groupKey: group.groupKey
      });
      const ownerFinalized =
        finalized.finalized ||
        ("ownerFinalized" in finalized && finalized.ownerFinalized === true);
      if (
        group.kind === "MATCH" &&
        group.ownerRetryable === true &&
        finalized.finalized &&
        finalized.ownerSent &&
        (finalized.sentMatchCount ?? 0) > 0
      ) {
        ownerSentMatchCount += finalized.sentMatchCount ?? 0;
        for (const courseId of groupMatchCourseIds) {
          ownerSentMatchCourseIds.add(courseId);
        }
      }
      if (ownerFinalized) {
        if (!finalized.finalized) {
          console.warn("[email:additional-recipient-retry-pending]", {
            searchRef: createSearchLogReference(input.searchId),
            kind: group.kind
          });
        }
        continue;
      }
    } catch (error) {
      if (error instanceof SearchCheckLeaseLostError) {
        throw error;
      }
      deliveryError ??= error;
    }
    if (deliveryError) {
      console.warn("[email:existing-delivery-pending]", {
        searchRef: createSearchLogReference(input.searchId),
        kind: group.kind
      });
    }
  }
  console.warn("[email:delivery-retry-pass-limit]", {
    searchRef: createSearchLogReference(input.searchId)
  });
  return {
    ownerSentMatchCount,
    ownerSentMatchCourseIds: [...ownerSentMatchCourseIds]
  };
}

function getCourseBookingAccess(
  course: AutomationCourse
): SearchStatusCourseReport["bookingAccess"] {
  if (course.bookingMethod === "PHONE_ONLY") {
    return "PHONE_ONLY";
  }
  if (course.bookingMethod === "CONTACT_COURSE") {
    return "CONTACT_COURSE";
  }
  if (course.bookingMethod === "WALK_IN") {
    return "WALK_IN";
  }
  if (getSafeOfficialBookingUrl(course.detectedBookingUrl)) {
    return "BOOKING_PAGE";
  }
  if (getSafeOfficialBookingUrl(course.website)) {
    return "OFFICIAL_SITE";
  }
  return course.bookingPhone || course.phone ? "PHONE_ONLY" : undefined;
}

function getCustomerBookingUrl(course: AutomationCourse) {
  return (
    getSafeOfficialBookingUrl(course.detectedBookingUrl) ??
    getSafeOfficialBookingUrl(course.website)
  );
}

function hasAutomationStalledEndpointProof(course: AutomationCourse) {
  const incident = course.supportIncident;
  if (!incident) {
    return false;
  }
  return hasDurableAutomationStalledEndpointProof({
    incidentId: incident.id,
    incidentCycle: incident.cycle,
    incidentStatus: incident.status,
    humanReviewReason: incident.humanReviewReason,
    incidentEscalatedAt: incident.escalatedAt ?? null,
    escalationDeadlineAt: incident.escalationDeadlineAt,
    monitoringState: course.monitoringStatus?.state ?? null,
    endpointEvents: incident.monitoringEvents
  });
}

function getLiveCustomerMonitoringStatus(
  course: AutomationCourse,
  result: SearchCheckCourseResult,
  observedAt: Date
) {
  return getCustomerMonitoringStatus({
    outcome: result.outcome,
    monitoringDisposition: result.monitoringDisposition,
    monitoringState: course.monitoringStatus?.state ?? null,
    monitoringStateChangedAt:
      course.monitoringStatus?.stateChangedAt ?? null,
    incidentStatus: course.supportIncident?.status ?? null,
    humanReviewReason: course.supportIncident?.humanReviewReason ?? null,
    incidentEscalatedAt: course.supportIncident?.escalatedAt ?? null,
    outcomeObservedAt: observedAt,
    escalationDeadlineAt: course.supportIncident?.escalationDeadlineAt ?? null,
    automationPlaybookExhausted: course.supportIncident
      ? isAutomationHumanReviewProofCurrentOrPrior(
          course.supportIncident.attemptLedger,
          course.supportIncident.cycle
        )
      : null,
    automationStalledAtEndpoint:
      hasAutomationStalledEndpointProof(course),
    now: observedAt,
    automationReason: result.automationReason
  });
}

function applyCustomerMonitoringProjection(
  search: NonNullable<Awaited<ReturnType<typeof getActiveSearchForAutomation>>>,
  courseResults: SearchCheckCourseResult[],
  observedAt: Date
) {
  const resultByCourse = new Map(
    courseResults.map((result) => [result.courseId, result])
  );
  for (const preference of search.preferences) {
    const result = resultByCourse.get(preference.course.id);
    if (!result) continue;
    const customerStatus = getLiveCustomerMonitoringStatus(
      preference.course,
      result,
      observedAt
    );
    if (preference.course.supportIncident) {
      result.automationPlaybookExhausted =
        isAutomationHumanReviewProofCurrentOrPrior(
          preference.course.supportIncident.attemptLedger,
          preference.course.supportIncident.cycle
        );
      result.automationStalledAtEndpoint =
        hasAutomationStalledEndpointProof(preference.course);
    }
    if (
      customerStatus === "NEEDS_HUMAN_REVIEW" &&
      result.supportStatus !== "NEEDS_HUMAN_REVIEW"
    ) {
      if (result.outcome === "CHECK_PENDING") {
        result.outcome = "NEEDS_ADAPTER";
      }
      result.message = HUMAN_REVIEW_CUSTOMER_MESSAGE;
      result.supportStatus = "NEEDS_HUMAN_REVIEW";
    } else if (customerStatus === "RETRYING_AUTOMATICALLY") {
      if (result.message === HUMAN_REVIEW_CUSTOMER_MESSAGE) {
        delete result.message;
      }
      result.supportStatus = "IN_OPERATOR_QUEUE";
    } else if (
      customerStatus !== "NEEDS_HUMAN_REVIEW" &&
      result.supportStatus === "NEEDS_HUMAN_REVIEW"
    ) {
      delete result.supportStatus;
      if (result.message === HUMAN_REVIEW_CUSTOMER_MESSAGE) {
        delete result.message;
      }
    }
  }
}

type RunnableSearchPlaybookStage =
  | "TYPED_ADAPTER"
  | "HTTP_ADAPTER_RETRY"
  | "BROWSER_ADAPTER_RETRY"
  | "LOCAL_READER";

function getRunnableSearchPlaybookStage(
  runtime: SearchPlaybookRuntime | null
): RunnableSearchPlaybookStage | null {
  const stage = runtime?.assessment.nextStage;
  return stage === "TYPED_ADAPTER" ||
    stage === "HTTP_ADAPTER_RETRY" ||
    stage === "BROWSER_ADAPTER_RETRY" ||
    stage === "LOCAL_READER"
    ? stage
    : null;
}

async function skipPlaybookStagesBeforeLocalReader(
  runtime: SearchPlaybookRuntime
) {
  const stages = [
    {
      stage: "TYPED_ADAPTER",
      readPath: "TYPED_PROVIDER_ADAPTER"
    },
    { stage: "OFFICIAL_HTTP_DISCOVERY", readPath: "OFFICIAL_HTTP" },
    {
      stage: "HTTP_ADAPTER_RETRY",
      readPath: "TYPED_PROVIDER_ADAPTER"
    },
    {
      stage: "RENDERED_BROWSER_DISCOVERY",
      readPath: "RENDERED_BROWSER"
    },
    {
      stage: "BROWSER_ADAPTER_RETRY",
      readPath: "TYPED_PROVIDER_ADAPTER"
    }
  ] as const;
  for (const stage of stages) {
    if (runtime.assessment.nextStage !== stage.stage) {
      continue;
    }
    await skipSearchPlaybookStage(runtime, {
      stage: stage.stage,
      readPath: stage.readPath,
      evidenceKind: "TOOLING",
      failureFingerprint:
        SEARCH_PLAYBOOK_FINGERPRINTS.STAGE_NOT_APPLICABLE,
      skipReason: "MONITORING_MODE_EXCLUDED",
      note: "Explicit local-reader-only monitoring excludes this stage."
    });
  }
  return runtime;
}

async function recordOfficialDiscoveryResult(input: {
  runtime: SearchPlaybookRuntime;
  courseId: string;
  preparation: {
    attemptedCourseIds: string[];
    appliedCourseIds: string[];
    failedCourseIds: string[];
    deferredCourseIds: string[];
  };
  preparationFailed: boolean;
}) {
  if (input.runtime.assessment.nextStage !== "OFFICIAL_HTTP_DISCOVERY") {
    return input.runtime;
  }
  if (
    input.preparationFailed ||
    input.preparation.deferredCourseIds.includes(input.courseId)
  ) {
    const priorAttemptCount =
      input.runtime.assessment.stages.find(
        (stage) => stage.stage === "OFFICIAL_HTTP_DISCOVERY"
      )?.attemptCount ?? 0;
    const retryExhausted = priorAttemptCount >= 1;
    return recordSearchPlaybookAttempt(input.runtime, {
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: retryExhausted ? "FAILED_TERMINAL" : "FAILED_RETRYABLE",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint:
        SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_HTTP_DISCOVERY,
      failureClass: "UNKNOWN",
      note: retryExhausted
        ? "The bounded official HTTP discovery retry was unavailable; continue to rendered-browser discovery."
        : "Official HTTP discovery was deferred and will retry once."
    });
  }
  if (input.preparation.failedCourseIds.includes(input.courseId)) {
    return recordSearchPlaybookAttempt(input.runtime, {
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "FAILED_TERMINAL",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint:
        SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_HTTP_DISCOVERY,
      failureClass: "UNKNOWN",
      note: "Bounded official HTTP discovery completed without runnable metadata."
    });
  }
  if (
    input.preparation.attemptedCourseIds.includes(input.courseId) ||
    input.preparation.appliedCourseIds.includes(input.courseId)
  ) {
    return recordSearchPlaybookAttempt(input.runtime, {
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint:
        SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_HTTP_DISCOVERY,
      note: "Bounded official HTTP and provider-configuration discovery completed."
    });
  }
  return skipSearchPlaybookStage(input.runtime, {
    stage: "OFFICIAL_HTTP_DISCOVERY",
    readPath: "OFFICIAL_HTTP",
    evidenceKind: "TOOLING",
    failureFingerprint:
      SEARCH_PLAYBOOK_FINGERPRINTS.STAGE_NOT_APPLICABLE,
    skipReason: "NO_PROVIDER_METADATA",
    note: "No safe official HTTP discovery source was available."
  });
}

async function recordSearchPlaybookSuccess(
  runtime: SearchPlaybookRuntime | null,
  stage: RunnableSearchPlaybookStage | null,
  providerExecution: string
) {
  if (!runtime || !stage || runtime.assessment.nextStage !== stage) {
    return runtime;
  }
  const localReader = stage === "LOCAL_READER";
  return recordSearchPlaybookAttemptResult(runtime, {
    stage,
    transition: "SUCCEEDED",
    readPath: localReader ? "LOCAL_READER" : "TYPED_PROVIDER_ADAPTER",
    evidenceKind: localReader ? "LOCAL_READER_RESULT" : "PROVIDER_RESPONSE",
    failureFingerprint: localReader
      ? SEARCH_PLAYBOOK_FINGERPRINTS.LOCAL_READER_ATTEMPT
      : stage === "TYPED_ADAPTER"
        ? SEARCH_PLAYBOOK_FINGERPRINTS.TYPED_ADAPTER_ATTEMPT
        : stage === "HTTP_ADAPTER_RETRY"
          ? SEARCH_PLAYBOOK_FINGERPRINTS.HTTP_ADAPTER_RETRY
          : SEARCH_PLAYBOOK_FINGERPRINTS.BROWSER_ADAPTER_RETRY,
    note: `Fresh public monitoring succeeded through ${providerExecution}.`
  });
}

function buildPlaybookPendingCourseReport(
  course: AutomationCourse,
  message: string
): SearchCheckCourseResult {
  return {
    courseId: course.id,
    courseName: course.name,
    timeZone: course.timeZone,
    outcome: "CHECK_PENDING",
    availableMatches: 0,
    message,
    automationPlaybookExhausted: course.supportIncident
      ? isAutomationHumanReviewProofCurrentOrPrior(
          course.supportIncident.attemptLedger,
          course.supportIncident.cycle
        )
      : undefined,
    automationStalledAtEndpoint:
      hasAutomationStalledEndpointProof(course),
    bookingUrl: getCustomerBookingUrl(course),
    phone: course.bookingPhone ?? course.phone ?? undefined,
    bookingMethod: course.bookingMethod,
    bookingAccessMode: course.bookingAccessMode,
    bookingAccess: getCourseBookingAccess(course)
  };
}

async function deliverMonitoringStatusNotices(input: {
  search: NonNullable<Awaited<ReturnType<typeof getActiveSearchForAutomation>>>;
  searchWindow: {
    date: string;
    startTime: string;
    endTime: string;
    players: number;
  };
  courseResults: SearchCheckCourseResult[];
  monitoringBeforeCheck: Map<
    string,
    {
      state: CourseMonitoringState;
      firstDegradedAt: Date | null;
      failureFingerprint: string | null;
      stateChangedAt: Date;
    } | null
  >;
  ownerMatchCourseIds: string[];
  checkedAt: Date;
  lease: SearchCheckLease;
  assertCurrent: () => Promise<void>;
}) {
  const resultByCourse = new Map(
    input.courseResults.map((result) => [result.courseId, result])
  );
  const candidates: MonitoringStatusNoticeCandidate[] =
    input.search.preferences.flatMap((preference) => {
      const result = resultByCourse.get(preference.course.id);
      if (!result) {
        return [];
      }
      const previous =
        input.monitoringBeforeCheck.get(preference.course.id) ?? null;
      const current = preference.course.monitoringStatus;
      const previousStatus = getCustomerMonitoringStatus({
        monitoringState: previous?.state ?? null
      });
      const currentStatus = getLiveCustomerMonitoringStatus(
        preference.course,
        result,
        input.checkedAt
      );
      const customerResult =
        currentStatus === "NEEDS_HUMAN_REVIEW" &&
        result.supportStatus !== "NEEDS_HUMAN_REVIEW"
          ? {
              ...result,
              message: HUMAN_REVIEW_CUSTOMER_MESSAGE,
              supportStatus: "NEEDS_HUMAN_REVIEW" as const
            }
          : result;
      const endpointDeadlineAt =
        preference.course.supportIncident?.escalatedAt ??
        preference.course.supportIncident?.escalationDeadlineAt ??
        null;
      const endpointEpisodeStartedAt = endpointDeadlineAt
        ? new Date(
            endpointDeadlineAt.getTime() -
              (ACTIVE_DEMAND_ESCALATION_MS -
                CUSTOMER_ENDPOINT_DELIVERY_HEADROOM_MS)
          )
        : null;
      return [
        {
          providerFamilyKey: resolveProviderCapability(
            preference.course as AutomationCourse
          ).providerFamilyKey,
          result: customerResult,
          previousStatus,
          currentStatus,
          endpointDeadlineAt,
          episodeStartedAt:
            currentStatus === "FINAL_DIRECT_ACTION"
              ? preference.course.supportIncident?.firstSeenAt ??
                previous?.firstDegradedAt ??
                input.search.createdAt ??
                current?.stateChangedAt ??
                previous?.stateChangedAt ??
                null
              : currentStatus === "RETRYING_AUTOMATICALLY" ||
                  currentStatus === "NEEDS_HUMAN_REVIEW"
              ? endpointEpisodeStartedAt ??
                current?.firstDegradedAt ??
                previous?.firstDegradedAt ??
                null
              : previous?.firstDegradedAt ?? null
        }
      ];
    });
  const [reachedOutages, reachedFinals] = await Promise.all([
    listReachedMonitoringOutages({
      searchId: input.search.id,
      alertGeneration: input.search.alertGeneration
    }),
    listReachedMonitoringFinals({
      searchId: input.search.id,
      alertGeneration: input.search.alertGeneration
    })
  ]);
  const ownerRecipient = input.search.alertEmail ?? input.search.user.email;
  const alertRecipients = getAlertRecipients(
    ownerRecipient,
    input.search.additionalEmails
  );
  const authorizedRecipientSet = new Set(alertRecipients);
  const plan = planMonitoringStatusNotices({
    candidates,
    reachedOutages,
    reachedFinals,
    ownerRecipient,
    now: input.checkedAt
  });
  const ownerMatchCourseIds = new Set(input.ownerMatchCourseIds);
  const recoveryCourses = plan.recoveryCourses.filter(
    (course) =>
      !(
        course.outcome === "MATCH_FOUND" &&
        ownerMatchCourseIds.has(course.courseId)
      )
  );
  const currentStatusByCourse = new Map(
    candidates.map((candidate) => [
      candidate.result.courseId,
      candidate.currentStatus
    ])
  );
  const customerResultByCourse = new Map(
    candidates.map((candidate) => [candidate.result.courseId, candidate.result])
  );
  const customerSnapshotCourseResults = input.courseResults.map(
    (result) => customerResultByCourse.get(result.courseId) ?? result
  );
  const humanReviewCourses = plan.outageCourses.filter(
    (course) =>
      currentStatusByCourse.get(course.courseId) === "NEEDS_HUMAN_REVIEW"
  );
  const consolidatedStatusCourses = [
    ...new Map(
      [...plan.finalCourses, ...humanReviewCourses].map((course) => [
        course.courseId,
        course
      ])
    ).values()
  ];
  const outageCourses = plan.outageCourses.filter(
    (course) =>
      currentStatusByCourse.get(course.courseId) !== "NEEDS_HUMAN_REVIEW"
  );
  let outcome: NonNullable<SearchCheckResult["statusEmailOutcome"]> = "skipped";
  let ownerSentMatchCount = 0;

  const deliver = async (
    kind: SearchStatusTransitionKind,
    courses: SearchCheckCourseResult[],
    recipients: string[]
  ) => {
    if (courses.length === 0) {
      return;
    }
    const courseIds = courses.map((course) => course.courseId);
    const pendingMatches =
      kind === "recovery"
        ? await listPendingMatchAlerts(
            input.search.id,
            getCurrentMatchIds(courses)
          )
        : [];
    const coveredMatchIds = getCoveredPendingMatchIds(pendingMatches, courses);
    const coveredMatchIdSet = new Set(coveredMatchIds);
    const deliveryRecipients =
      kind === "recovery"
        ? coveredMatchIds.length > 0
          ? alertRecipients
          : recipients.filter((recipient) =>
              authorizedRecipientSet.has(recipient.trim().toLowerCase())
            )
        : recipients;
    const delivered = await deliverSearchStatusReport({
      search: input.search,
      searchWindow: input.searchWindow,
      courseResults: courses,
      snapshotCourseResults: customerSnapshotCourseResults,
      checkedAt: input.checkedAt,
      kind,
      providerLabel: getMonitoringStatusProviderLabel(candidates, courseIds),
      periodKey: buildMonitoringStatusNoticeGroupKey(
        kind,
        candidates,
        courseIds,
        {
          reachedOutages,
          ownerRecipient
        }
      ),
      recipients: deliveryRecipients,
      coveredMatchIds,
      coveredMatchRefs: pendingMatches
        .filter((match) => coveredMatchIdSet.has(match.id))
        .map((match) => ({
          matchId: match.id,
          availabilityCycle: match.availabilityCycle
        })),
      lease: input.lease,
      assertCurrent: input.assertCurrent
    });
    if (
      kind === "recovery" &&
      (delivered === "sent" || delivered === "dry_run")
    ) {
      ownerSentMatchCount += coveredMatchIds.length;
    }
    if (
      delivered === "sent" ||
      (delivered === "dry_run" && outcome !== "sent") ||
      (delivered === "failed" && outcome === "skipped")
    ) {
      outcome = delivered;
    }
  };

  await deliver("recovery", recoveryCourses, plan.recoveryRecipients);
  await deliver(
    "status-update",
    consolidatedStatusCourses,
    alertRecipients
  );
  await deliver(
    "outage",
    outageCourses,
    alertRecipients
  );

  return {
    outcome,
    ownerSentMatchCount,
    nextConsolidationAt: plan.nextConsolidationAt
  };
}

async function deliverSearchStatusReport(input: {
  search: NonNullable<Awaited<ReturnType<typeof getActiveSearchForAutomation>>>;
  searchWindow: {
    date: string;
    startTime: string;
    endTime: string;
    players: number;
  };
  courseResults: SearchCheckCourseResult[];
  snapshotCourseResults?: SearchCheckCourseResult[];
  checkedAt: Date;
  kind: SearchStatusEmailKind | SearchStatusTransitionKind;
  providerLabel?: string;
  periodKey?: string;
  recipients?: string[];
  coveredMatchIds?: string[];
  coveredMatchRefs?: Array<{ matchId: string; availabilityCycle: number }>;
  supersededStatusGroups?: Array<{
    kind: "SETUP" | "DAILY";
    groupKey: string;
  }>;
  lease: SearchCheckLease;
  assertCurrent?: () => Promise<void>;
}): Promise<NonNullable<SearchCheckResult["statusEmailOutcome"]>> {
  const snapshot = buildSearchStatusSnapshot(
    input.snapshotCourseResults ?? input.courseResults
  );
  const persistedStatusReport = toSearchEmailJson({
    kind: input.kind,
    providerLabel: input.providerLabel,
    targetDate: input.searchWindow.date,
    startTime: input.searchWindow.startTime,
    endTime: input.searchWindow.endTime,
    players: input.searchWindow.players,
    requestedLayoutHoles:
      input.search.requestedLayoutHoles === 9 ||
      input.search.requestedLayoutHoles === 18
        ? input.search.requestedLayoutHoles
        : null,
    userTimeZone: input.search.userTimeZone,
    previousSnapshot: input.search.statusEmailSnapshot,
    courses: input.courseResults
  });
  const recipients =
    input.recipients ??
    getAlertRecipients(
      input.search.alertEmail ?? input.search.user.email,
      input.search.additionalEmails
    );
  const availableMatches = await listAvailableMatchAlerts(
    input.search.id,
    getCurrentMatchIds(input.courseResults)
  );
  // The persisted field keeps its legacy name, but it represents every opening
  // covered by the email. The renderer still shows a concise top set and an
  // explicit "more tee times" count for the rest.
  const displayMatchIds = [
    ...new Set([
      ...getCoveredPendingMatchIds(availableMatches, input.courseResults),
      ...(input.coveredMatchIds ?? [])
    ])
  ];
  const basePeriodKey =
    input.periodKey ??
    (input.kind === "setup"
      ? `setup-${createEmailSnapshotKey(persistedStatusReport)}`
      : `${input.kind}-${
          input.search.statusEmailSentAt?.getTime() ?? "initial"
        }-${createEmailSnapshotKey(persistedStatusReport)}`);
  const replacementSuffix = input.supersededStatusGroups?.length
    ? `-replacement-${createEmailSnapshotKey(
        input.supersededStatusGroups
          .map((group) => `${group.kind}:${group.groupKey}`)
          .sort()
      )}`
    : "";
  const periodKey = `${basePeriodKey}${replacementSuffix}`;
  await input.assertCurrent?.();
  const deliveryKind =
    input.kind === "setup"
      ? "SETUP"
      : input.kind === "daily"
        ? "DAILY"
        : input.kind === "status-update"
          ? "MONITORING_STATUS_UPDATE"
        : input.kind === "outage"
          ? "MONITORING_OUTAGE"
          : "MONITORING_RECOVERY";
  const prepared = await prepareSearchEmailDeliveryGroup({
    searchId: input.search.id,
    alertGeneration: input.search.alertGeneration,
    checkLeaseToken: input.lease.token,
    kind: deliveryKind,
    groupKey: periodKey,
    recipients,
    ownerRecipient: input.search.alertEmail ?? input.search.user.email,
    supersededStatusGroups: input.supersededStatusGroups,
    payload: {
      schemaVersion: 2,
      checkedAt: input.checkedAt.toISOString(),
      statusSnapshot: snapshot,
      statusReport: persistedStatusReport,
      displayMatchIds,
      matchIds: input.coveredMatchIds ?? [],
      matchRefs: input.coveredMatchRefs ?? []
    }
  });
  if (!prepared.prepared) {
    throw new SearchCheckLeaseLostError();
  }
  for (const continuation of prepared.continuationGroups ?? []) {
    try {
      await drainSearchEmailDeliveryGroup({
        searchId: input.search.id,
        alertGeneration: input.search.alertGeneration,
        checkLeaseToken: input.lease.token,
        kind: "MATCH",
        groupKey: continuation.groupKey,
        send: async ({
          recipient,
          idempotencyKey,
          payload,
          assertCurrentDelivery
        }) => {
          await input.assertCurrent?.();
          const alert = await hydrateMatchAlertPayload({
            searchId: input.search.id,
            alertGeneration: input.search.alertGeneration,
            payload
          });
          await input.assertCurrent?.();
          await assertCurrentDelivery();
          return sendTeeTimeAlert({
            searchId: input.search.id,
            to: recipient,
            ...alert,
            stableIdempotencyKey: idempotencyKey
          });
        }
      });
      await finalizeSearchEmailDeliveryGroup({
        searchId: input.search.id,
        alertGeneration: input.search.alertGeneration,
        kind: "MATCH",
        groupKey: continuation.groupKey
      });
    } catch (error) {
      if (error instanceof SearchCheckLeaseLostError) {
        throw error;
      }
      console.warn("[email:status-match-continuation-pending]", {
        searchRef: createSearchLogReference(input.search.id)
      });
    }
  }
  await drainSearchEmailDeliveryGroup({
    searchId: input.search.id,
    alertGeneration: input.search.alertGeneration,
    checkLeaseToken: input.lease.token,
    kind: deliveryKind,
    groupKey: periodKey,
    send: async ({
      recipient,
      idempotencyKey,
      payload,
      assertCurrentDelivery
    }) => {
      await input.assertCurrent?.();
      const report = await hydrateSearchStatusEmailPayload(payload);
      await input.assertCurrent?.();
      await assertCurrentDelivery();
      return sendSearchStatusEmail({
        searchId: input.search.id,
        to: recipient,
        ...report,
        stableIdempotencyKey: idempotencyKey
      });
    }
  });

  await input.assertCurrent?.();
  const finalized = await finalizeSearchEmailDeliveryGroup({
    searchId: input.search.id,
    alertGeneration: input.search.alertGeneration,
    kind: deliveryKind,
    groupKey: periodKey
  });
  if (!finalized.finalized) {
    throw new Error(
      "Search status email delivery group did not reach a terminal state"
    );
  }

  if (finalized.ownerSent || finalized.ownerDeliveryOutcome === "SENT") {
    return "sent";
  }
  if (finalized.ownerDeliveryOutcome === "DRY_RUN") {
    return "dry_run";
  }
  if (finalized.ownerDeliveryOutcome === "PRIOR_REACHED") {
    return "skipped";
  }
  return "failed";
}

async function sendPendingMatchAlerts(
  searchId: string,
  input: {
    searchWindow: {
      date: string;
      startTime: string;
      endTime: string;
      players: number;
    };
    courseResults: SearchCheckCourseResult[];
    checkedAt: Date;
    requestedLayoutHoles: 9 | 18 | null;
    satisfiesStatusReport: boolean;
    lease: SearchCheckLease;
    assertCurrent?: () => Promise<void>;
  }
) {
  const currentMatchIds = new Set(getCurrentMatchIds(input.courseResults));
  const pendingMatches = await listPendingMatchAlerts(searchId, [
    ...currentMatchIds
  ]);
  if (pendingMatches.length === 0) {
    return { ownerSentMatchCount: 0, hasDurableMatchObligation: false };
  }
  const search = pendingMatches[0].teeSearch;

  const allAvailableMatches = await listAvailableMatchAlerts(searchId, [
    ...currentMatchIds
  ]);
  const availableMatches = allAvailableMatches.filter((match) =>
    currentMatchIds.has(match.id)
  );
  const currentAvailableIds = new Set(
    availableMatches.map((match) => match.id)
  );
  const currentPendingMatches = pendingMatches.filter((match) =>
    currentAvailableIds.has(match.id)
  );
  if (availableMatches.length === 0 || currentPendingMatches.length === 0) {
    return { ownerSentMatchCount: 0, hasDurableMatchObligation: false };
  }

  const currentPendingIds = new Set(
    currentPendingMatches.map((match) => match.id)
  );
  const reportMatches = availableMatches.map((match) => {
    const courseResult = input.courseResults.find(
      (course) => course.courseId === match.course.id
    );
    return {
      matchId: match.id,
      courseId: match.course.id,
      courseName: match.course.name,
      courseRank: courseResult?.rank,
      courseAddress:
        courseResult?.courseAddress ?? match.course.address ?? undefined,
      courseTimeZone: match.course.timeZone,
      startsAt: match.startsAt,
      availableSpots: match.availableSpots,
      bookingUrl: match.bookingUrl,
      priceCents: match.priceCents,
      holes: match.holes,
      bookableHoleCounts:
        courseResult?.matchingTimes?.find((time) => time.matchId === match.id)
          ?.bookableHoleCounts ?? [],
      factLine:
        courseResult?.factLine ?? buildCourseFactLine(courseResult ?? {}),
      courseGuideUrl: courseResult?.courseGuideUrl,
      isNew: currentPendingIds.has(match.id)
    };
  });
  const coveredMatches = reportMatches;
  const coveredPendingMatches = currentPendingMatches;
  if (coveredPendingMatches.length === 0) {
    return { ownerSentMatchCount: 0, hasDurableMatchObligation: false };
  }

  const primaryAlertEmail = search.alertEmail ?? search.user.email;
  const recipients = getAlertRecipients(
    primaryAlertEmail,
    search.additionalEmails
  );
  const batchKey = buildMatchDeliveryGroupKey(coveredPendingMatches);
  await input.assertCurrent?.();
  const prepared = await prepareRecipientMatchDeliveryGroups({
    searchId,
    alertGeneration: search.alertGeneration,
    checkLeaseToken: input.lease.token,
    sourceGroupKey: batchKey,
    recipients,
    ownerRecipient: primaryAlertEmail,
    payload: {
      schemaVersion: 2,
      checkedAt: input.checkedAt.toISOString(),
      matchIds: coveredPendingMatches.map((match) => match.id),
      matchRefs: coveredPendingMatches.map((match) => ({
        matchId: match.id,
        availabilityCycle: match.availabilityCycle
      })),
      displayMatchIds: coveredMatches.map((match) => match.matchId),
      satisfiesStatusReport: input.satisfiesStatusReport,
      statusSnapshot: buildSearchStatusSnapshot(input.courseResults),
      matchReport: toSearchEmailJson({
        targetDate: input.searchWindow.date,
        startTime: input.searchWindow.startTime,
        endTime: input.searchWindow.endTime,
        players: input.searchWindow.players,
        requestedLayoutHoles: input.requestedLayoutHoles,
        userTimeZone: search.userTimeZone,
        matches: coveredMatches.map((match) => ({
          ...match,
          startsAt: match.startsAt.toISOString()
        }))
      })
    }
  });
  if (!prepared.prepared) {
    throw new SearchCheckLeaseLostError();
  }
  let ownerSentMatchCount = 0;
  let hasDurableMatchObligation = prepared.hasExistingObligation;
  const ownerRecipient = primaryAlertEmail.trim().toLowerCase();
  for (const group of prepared.groups) {
    try {
      const deliveries = await drainSearchEmailDeliveryGroup({
        searchId,
        alertGeneration: search.alertGeneration,
        checkLeaseToken: input.lease.token,
        kind: "MATCH",
        groupKey: group.groupKey,
        send: async ({
          recipient,
          idempotencyKey,
          payload,
          assertCurrentDelivery
        }) => {
          await input.assertCurrent?.();
          const alert = await hydrateMatchAlertPayload({
            searchId,
            alertGeneration: search.alertGeneration,
            payload
          });
          await input.assertCurrent?.();
          await assertCurrentDelivery();
          return sendTeeTimeAlert({
            searchId,
            to: recipient,
            ...alert,
            stableIdempotencyKey: idempotencyKey
          });
        }
      });
      await input.assertCurrent?.();
      const finalized = await finalizeSearchEmailDeliveryGroup({
        searchId,
        alertGeneration: search.alertGeneration,
        kind: "MATCH",
        groupKey: group.groupKey
      });
      if (
        deliveries.some((delivery) => delivery.status === "SENT") ||
        (finalized.retainedMatchCount ?? 0) > 0 ||
        finalized.ownerDeliveryOutcome === "AMBIGUOUS"
      ) {
        hasDurableMatchObligation = true;
      }
      if (
        group.recipient === ownerRecipient &&
        finalized.finalized &&
        finalized.ownerSent &&
        deliveries.length > 0
      ) {
        ownerSentMatchCount += finalized.sentMatchCount;
      }
    } catch (error) {
      if (error instanceof SearchCheckLeaseLostError) {
        throw error;
      }
      hasDurableMatchObligation = true;
      console.warn("[email:match-recipient-pending]", {
        searchRef: createSearchLogReference(searchId)
      });
    }
  }

  return { ownerSentMatchCount, hasDurableMatchObligation };
}

export function buildMatchDeliveryGroupKey(
  matches: Array<{ id: string; availabilityCycle: number }>
) {
  return createHash("sha256")
    .update(
      matches
        .map((match) => `${match.id}:${match.availabilityCycle}`)
        .sort()
        .join(":")
    )
    .digest("hex")
    .slice(0, 24);
}

function getAlertRecipients(
  primaryEmail: string,
  additionalEmails: string[] = []
) {
  return [
    ...new Set(
      [primaryEmail, ...additionalEmails].map((email) =>
        email.trim().toLowerCase()
      )
    )
  ];
}

function createEmailSnapshotKey(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function createSearchLogReference(searchId: string) {
  return createHash("sha256").update(searchId).digest("hex").slice(0, 16);
}

function isFirstTimeCourseLookup(
  searchCreatedAt: Date | undefined,
  courseCreatedAt: Date | undefined
) {
  if (
    !(searchCreatedAt instanceof Date) ||
    !(courseCreatedAt instanceof Date)
  ) {
    return false;
  }
  return (
    Math.abs(courseCreatedAt.getTime() - searchCreatedAt.getTime()) <=
    FIRST_TIME_LOOKUP_CREATION_WINDOW_MS
  );
}

function buildSearchCheckAudit(trigger: string, result: SearchCheckResult) {
  const courseOutcomes = result.courseResults.reduce<Record<string, number>>(
    (counts, course) => {
      counts[course.outcome] = (counts[course.outcome] ?? 0) + 1;
      return counts;
    },
    {}
  );
  return {
    trigger: sanitizeResponderText(trigger),
    searchRef: createSearchLogReference(result.searchId),
    outcome: result.outcome,
    checkedCourses: result.courseResults.length,
    courseOutcomes,
    availableMatches: result.availableMatches,
    newlyAlertedMatches: result.newlyAlertedMatches,
    supportRetryNeeded: result.supportRetryNeeded,
    supportRetryAt: result.supportRetryAt?.toISOString() ?? null,
    statusEmailOutcome: result.statusEmailOutcome
  };
}

function hasSupportedAdapter(course: AutomationCourse) {
  return resolveProviderCapability(course).isRunnable;
}

function getFinalMonitoringMessage(
  course: AutomationCourse,
  disposition: ReturnType<typeof evaluateMonitoringGate>["disposition"]
) {
  if (disposition === "IDENTITY_RECHECK") {
    return `${course.name}'s public-course identity review is due. Automatic availability monitoring remains paused while we verify public access.`;
  }
  if (disposition === "IDENTITY_FINAL") {
    return `${course.name} is not a playable public course eligible for monitoring.`;
  }
  if (disposition === "TECHNICAL_FINAL") {
    return course.automationReason === "ACCOUNT_REQUIRED"
      ? `${course.name} requires an account before tee-time availability can be viewed.`
      : `${course.name} currently places tee-time availability behind a captcha, queue, or equivalent access control.`;
  }
  if (course.bookingMethod === "PHONE_ONLY") {
    return `${course.name} currently accepts tee-time requests by phone.`;
  }
  if (course.bookingMethod === "CONTACT_COURSE") {
    return `${course.name} currently directs golfers to contact the course for availability.`;
  }
  if (course.bookingMethod === "WALK_IN") {
    return `${course.name} currently uses walk-in or first-come availability.`;
  }
  return `${course.name} has current verified evidence that no online booking surface is available.`;
}

async function recordBookingWindowWaitingProbe(input: {
  searchId: string;
  courseId: string;
  observedAtOrAfter: Date;
  automationRunId: string;
  runtimeVersion: string;
  targetDate: string;
  bookingWindow: TargetBookingWindow;
  providerExecution?: boolean;
}) {
  await recordCourseProbeIfChanged({
    searchId: input.searchId,
    courseId: input.courseId,
    observedAtOrAfter: input.observedAtOrAfter,
    automationRunId: input.automationRunId,
    runtimeVersion: input.runtimeVersion,
    outcome: "NO_MATCH",
    message: input.bookingWindow.exactTime
      ? `Booking for ${input.targetDate} opens at ${input.bookingWindow.opensAt.toISOString()}.`
      : `Booking for ${input.targetDate} is expected to open on ${input.bookingWindow.releaseDate}; the exact release time is not published.`,
    rawSummary: {
      ...(input.providerExecution
        ? { providerExecution: "RUNNABLE_PROVIDER_CHECK" }
        : {}),
      bookingWindow: {
        releaseDate: input.bookingWindow.releaseDate,
        releaseTimeLocal: input.bookingWindow.releaseTimeLocal,
        timeZone: input.bookingWindow.timeZone,
        source: input.bookingWindow.source,
        confidence: input.bookingWindow.confidence,
        evidenceUrl: input.bookingWindow.evidenceUrl
      }
    }
  });
}

function buildBookingWindowCourseReport(
  course: AutomationCourse,
  bookingWindow: TargetBookingWindow
): SearchCheckCourseResult {
  return {
    courseId: course.id,
    courseName: course.name,
    timeZone: course.timeZone,
    outcome: "NO_MATCH",
    availableMatches: 0,
    bookingUrl: getCustomerBookingUrl(course),
    phone: course.bookingPhone ?? course.phone ?? undefined,
    bookingMethod: course.bookingMethod,
    bookingAccessMode: course.bookingAccessMode,
    bookingAccess: getCourseBookingAccess(course),
    bookingWindow: {
      releaseDate: bookingWindow.releaseDate,
      releaseTimeLocal: bookingWindow.releaseTimeLocal ?? undefined,
      opensAt: bookingWindow.opensAt.toISOString(),
      timeZone: bookingWindow.timeZone,
      exactTime: bookingWindow.exactTime
    }
  };
}
