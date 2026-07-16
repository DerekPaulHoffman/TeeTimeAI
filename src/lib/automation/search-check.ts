import { createHash } from "node:crypto";

import {
  finishAutomationRun,
  getActiveSearchForAutomation,
  heartbeatSearchCheckLease,
  isSearchCheckLeaseCurrent,
  listAvailableMatchAlerts,
  listPendingMatchAlerts,
  markCourseBookingWindowChecked,
  markMissingMatchesUnavailable,
  recordCourseBookingWindowEvidence,
  recordCourseProbe,
  recordCourseProbeIfChanged,
  recordTeeTimeMatch,
  runWithSearchCheckLease,
  startAutomationRun,
  type SearchCheckLease
} from "@/lib/automation/db-service";
import { getBestProbeUrl, shouldQueueBrowserProbe } from "@/lib/automation/browser-discovery";
import { evaluateAutomationPolicy } from "@/lib/automation/policy";
import {
  classifyProviderFailure,
  resolveProviderCapability
} from "@/lib/automation/provider-capabilities";
import { runProviderFamilyTasks } from "@/lib/automation/provider-concurrency";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { prepareSearchMonitoring } from "@/lib/automation/search-monitoring-discovery";
import {
  notifyCourseSupportIssueBatch,
  reportCourseSupportIssue,
  resolveCourseSupportIncident
} from "@/lib/automation/support-incidents";
import { fetchCpsTeeSheet, isCpsMetadata } from "@/lib/adapters/cps";
import { fetchChelseaTeeSheet, isChelseaMetadata } from "@/lib/adapters/chelsea";
import { fetchChronogolfSlots, isChronogolfMetadata } from "@/lib/adapters/chronogolf";
import { fetchForeupTeeSheet, isForeupMetadata } from "@/lib/adapters/foreup";
import { fetchGolfBackTeeSheet, isGolfBackMetadata } from "@/lib/adapters/golfback";
import { fetchTeeItUpTeeSheet, isTeeItUpMetadata } from "@/lib/adapters/teeitup";
import { fetchTeesnapTeeSheet, isTeesnapMetadata } from "@/lib/adapters/teesnap";
import { fetchWebTracTeeSheet, isWebTracMetadata } from "@/lib/adapters/webtrac";
import {
  getBookingWindowForTargetDate,
  getBookingWindowFromEvidence,
  shouldRetryBookingWindowDiscovery,
  shouldRefreshBookingWindow,
  type BookingWindowEvidence,
  type BookingWindowEvidenceSource,
  type TargetBookingWindow
} from "@/lib/courses/booking-window";
import type { AutomationReason, BookingMethod } from "@/lib/courses/intelligence";
import {
  getCourseLayoutCompatibility,
  getCourseLayoutLabel
} from "@/lib/courses/course-layout";
import { sendSearchStatusEmail, sendTeeTimeAlert } from "@/lib/email/alerts";
import {
  drainSearchEmailDeliveryGroup,
  finalizeSearchEmailDeliveryGroup,
  getSafeOfficialBookingUrl,
  hydrateMatchAlertPayload,
  hydrateSearchStatusEmailPayload,
  listRetryableSearchEmailDeliveryGroups,
  prepareSearchEmailDeliveryGroup,
  suppressSearchEmailDeliveriesForMatches,
  toSearchEmailJson
} from "@/lib/email/search-delivery-outbox";
import {
  buildSearchStatusSnapshot,
  getSearchStatusEmailKind,
  summarizeSearchStatusAvailability,
  type SearchStatusCourseReport
} from "@/lib/email/search-status";
import {
  summarizeBookableHoleCounts,
  summarizeCourseSlotPrices
} from "@/lib/pricing/course-prices";
import {
  dedupeMatches,
  filterSlotsForSearch,
  parseCourseLocalDateTime,
  rankMatches
} from "@/lib/tee-times/matching";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

const PROMPT_VERSION = "tee-time-spot-event-driven-check-v1";
const SHORT_SEARCH_RETRY_FAILURES = new Set([
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "UNKNOWN"
]);

type AutomationCourse = {
  id: string;
  name: string;
  address: string | null;
  timeZone: string;
  phone: string | null;
  bookingPhone: string | null;
  website: string | null;
  detectedBookingUrl: string | null;
  providerFamilyKey: string;
  bookingMethod: BookingMethod;
  automationEligibility: "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
  automationReason: AutomationReason;
  policyNotes: string | null;
  detectedPlatform:
    | "UNKNOWN"
    | "FOREUP"
    | "GOLFNOW"
    | "TEEITUP"
    | "CHRONOGOLF"
    | "CLUB_CADDIE"
    | "CUSTOM";
  bookingMetadata: unknown;
  bookingWindowDaysAhead: number | null;
  bookingReleaseTimeLocal: string | null;
  bookingWindowSource: BookingWindowEvidenceSource | null;
  bookingWindowConfidence: number | null;
  bookingWindowEvidenceUrl: string | null;
  bookingWindowCheckedAt: Date | null;
  bookingWindowObservedAt: Date | null;
  layoutHoleCounts: number[];
  layoutHolesVerifiedAt: Date | null;
};

export type SearchCheckCourseResult = SearchStatusCourseReport;

export type SearchCheckResult = {
  searchId: string;
  outcome: "success" | "not_active" | "busy" | "failed";
  courseResults: SearchCheckCourseResult[];
  availableMatches: number;
  newlyAlertedMatches: number;
  supportRetryNeeded: boolean;
  statusEmailOutcome?: "sent" | "dry_run" | "skipped" | "covered_by_match_alert" | "failed";
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
      ? { acquired: true as const, value: await checkSearch(searchId, run.id, existingLease) }
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
        supportRetryNeeded: false
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
    const message = error instanceof Error ? error.message : "Unknown search check failure";
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
      supportRetryNeeded: false
    };
  }
  let search = loadedSearch;

  let monitoringRetryCourseIds = new Set<string>();
  let monitoringDeferredCourseIds = new Set<string>();
  let monitoringPreparationFailed = false;
  try {
    const preparation = await prepareSearchMonitoring(search);
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
      message: error instanceof Error ? error.message : "Unknown discovery preparation failure"
    });
  }

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
  const supportIssues: Array<{
    courseId: string;
    incidentId: string | null;
    status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "UNRECORDED";
    ownerAlerted: boolean;
  }> = [];
  let newlyAlertedMatches = 0;
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

    if (
      requestedLayoutHoles &&
      course.layoutHolesVerifiedAt &&
      getCourseLayoutCompatibility(course.layoutHoleCounts, requestedLayoutHoles) ===
        "incompatible"
    ) {
      const message = `${course.name} is verified as ${getCourseLayoutLabel(course.layoutHoleCounts)} and does not match the requested ${requestedLayoutHoles}-hole physical course layout.`;
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
        automationRunId,
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
        bookingAccess: getCourseBookingAccess(course)
      });
      return;
    }

    const policy = evaluateAutomationPolicy({
      automationEligibility: course.automationEligibility,
      termsText: course.policyNotes,
      intendedAction: "ALERT_ONLY"
    });

    if (!policy.allowed) {
      await recordCourseProbeIfChanged({
        searchId: search.id,
        courseId: course.id,
        automationRunId,
        outcome: "BLOCKED_POLICY",
        message: policy.reason
      });
      await resolveCourseSupportIncident({
        courseId: course.id,
        resolution: "DIRECT_BOOKING_CLASSIFIED",
        message: `${course.name} was conclusively classified for direct booking: ${policy.reason}`
      });
      courseResults.push({
        courseId: course.id,
        courseName: course.name,
        timeZone: course.timeZone,
        outcome: "BLOCKED_POLICY",
        availableMatches: 0,
        message: policy.reason,
        bookingUrl: getCustomerBookingUrl(course),
        phone: course.bookingPhone ?? course.phone ?? undefined,
        bookingMethod: course.bookingMethod,
        bookingAccess: getCourseBookingAccess(course)
      });
      return;
    }

    if (!hasSupportedAdapter(course)) {
      if (monitoringPreparationFailed || monitoringDeferredCourseIds.has(course.id)) {
        monitoringRetryCourseIds.add(course.id);
        const message =
          "Official booking-source review is queued and will retry shortly before monitoring support is classified.";
        await recordCourseProbeIfChanged({
          searchId: search.id,
          courseId: course.id,
          automationRunId,
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
          bookingAccess: getCourseBookingAccess(course)
        });
        return;
      }
      const browserProbeUrl = getBestProbeUrl(course);
      const browserProbeQueued = shouldQueueBrowserProbe(course);
      const message = browserProbeQueued
        ? "Official booking surface inspected; no reusable policy-safe monitoring connection was confirmed."
        : "No public booking surface is currently available for automated monitoring.";
      await recordCourseProbeIfChanged({
        searchId: search.id,
        courseId: course.id,
        automationRunId,
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
        kind: "NEEDS_ADAPTER",
        message,
        nextAction: browserProbeQueued
          ? `Build or extend a reusable policy-safe public adapter from the completed official-site discovery for ${browserProbeUrl}, then verify this search.`
          : "Autonomously classify the official booking method, find a policy-safe public retrieval path if one exists, and verify this search."
      });
      supportIssues.push({ courseId: course.id, ...supportIssue });
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
        bookingAccess: getCourseBookingAccess(course),
        supportStatus: supportIssue.ownerAlerted ? "TEAM_ALERTED" : "PENDING_ALERT"
      });
      return;
    }

    const checkStartedAt = new Date();
    const storedBookingWindow = getBookingWindowForTargetDate(search.date, course);
    const refreshBookingWindow =
      shouldRefreshBookingWindow(course.bookingWindowObservedAt, checkStartedAt) &&
      shouldRetryBookingWindowDiscovery(course.bookingWindowCheckedAt, checkStartedAt);
    if (
      storedBookingWindow &&
      storedBookingWindow.opensAt > checkStartedAt &&
      !refreshBookingWindow
    ) {
      await recordBookingWindowWaitingProbe({
        searchId: search.id,
        courseId: course.id,
        automationRunId,
        targetDate: searchWindow.date,
        bookingWindow: storedBookingWindow
      });
      courseResults.push(buildBookingWindowCourseReport(course, storedBookingWindow));
      return;
    }

    try {
      const providerExecution = await runWithProviderRequestLease(
        resolveProviderCapability(course).providerFamilyKey,
        () =>
          fetchCourseTeeSheet(
            course,
            search.date,
            search.players,
            refreshBookingWindow
          )
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
          bookingAccess: getCourseBookingAccess(course)
        });
        return;
      }
      const teeSheet = providerExecution.value;
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
          automationRunId,
          targetDate: searchWindow.date,
        bookingWindow,
        providerExecution: true
        });
        await resolveCourseSupportIncident({
          courseId: course.id,
          resolution: "MONITORING_RESTORED",
          message: `${course.name} returned a verified booking-window release for ${searchWindow.date}.`
        });
        courseResults.push(buildBookingWindowCourseReport(course, bookingWindow));
        return;
      }
      const availability = summarizeSearchStatusAvailability(searchWindow, rawSlots);
      const bookableHoleCounts = summarizeBookableHoleCounts(rawSlots);
      const pricing = summarizeCourseSlotPrices(rawSlots);
      const currentMatches = rankMatches(
        searchWindow,
        dedupeMatches(filterSlotsForSearch(searchWindow, rawSlots), [])
      );
      const normalizedCurrentMatches = currentMatches.map((match) => ({
        match,
        startsAt: parseCourseLocalDateTime(match.startsAt, course.timeZone)
      }));
      const persistedPendingStates: boolean[] = [];

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
        persistedPendingStates.push(persistedMatch?.alertStatus === "PENDING");
      }

      await markMissingMatchesUnavailable({
        searchId: search.id,
        alertGeneration: search.alertGeneration,
        checkLeaseToken: lease.token,
        courseId: course.id,
        date: searchWindow.date,
        timeZone: course.timeZone,
        confirmedMatches: normalizedCurrentMatches.map(({ match, startsAt }) => ({
          sourceId: match.sourceId,
          startsAt
        }))
      });

      const outcome = currentMatches.length > 0 ? "MATCH_FOUND" : "NO_MATCH";
      await recordCourseProbe({
        searchId: search.id,
        courseId: course.id,
        automationRunId,
        outcome,
        message:
          currentMatches.length > 0
            ? `Confirmed ${currentMatches.length} qualifying tee times.`
            : "No qualifying tee times in the requested window",
        rawSummary: {
          providerExecution: "RUNNABLE_PROVIDER_CHECK",
          ...availability,
          ...(bookableHoleCounts.length > 0 ? { bookableHoleCounts } : {}),
          ...(pricing ? { pricing } : {})
        }
      });
      await resolveCourseSupportIncident({
        courseId: course.id,
        resolution: "MONITORING_RESTORED",
        message: `${course.name} completed a policy-safe automated tee-sheet check with outcome ${outcome}.`
      });
      courseResults.push({
        courseId: course.id,
        courseName: course.name,
        timeZone: course.timeZone,
        outcome,
        availableMatches: currentMatches.length,
        bookingUrl:
          rawSlots[0]?.bookingUrl ??
          course.detectedBookingUrl ??
          course.website ??
          undefined,
        phone: course.bookingPhone ?? course.phone ?? undefined,
        bookingMethod: rawSlots[0]?.bookingUrl
          ? "PUBLIC_ONLINE"
          : course.bookingMethod,
        bookingAccess: rawSlots[0]?.bookingUrl
          ? "BOOKING_PAGE"
          : getCourseBookingAccess(course),
        availability,
        matchingTimes: currentMatches.map((match, index) => ({
          startsAt: match.startsAt,
          availableSpots: match.availableSpots,
          priceCents: match.priceCents,
          holes: match.holes,
          bookableHoleCounts: match.bookableHoleCounts,
          isNew: persistedPendingStates[index] === true
        }))
      });
    } catch (error) {
      await maintainSearchCheckLease(lease);
      const message = error instanceof Error ? error.message : "Unknown adapter error";
      if (SHORT_SEARCH_RETRY_FAILURES.has(classifyProviderFailure({ error }).failureClass)) {
        monitoringRetryCourseIds.add(course.id);
      }
      await recordCourseProbe({
        searchId: search.id,
        courseId: course.id,
        automationRunId,
        outcome: "FETCH_FAILED",
        message
      });
      const supportIssue = await reportCourseSupportIssue({
        course,
        searchId: search.id,
        kind: "FETCH_FAILED",
        message,
        error,
        nextAction: "Inspect the adapter failure, repair or reclassify the course, and verify with a focused search check."
      });
      supportIssues.push({ courseId: course.id, ...supportIssue });
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
        bookingAccess: getCourseBookingAccess(course),
        supportStatus: supportIssue.ownerAlerted ? "TEAM_ALERTED" : "PENDING_ALERT"
      });
    }
    }
  );

  const preferenceContext = new Map(
    search.preferences.map((preference) => [
      preference.course.id,
      {
        rank: preference.rank,
        courseAddress: preference.course.address ?? undefined
      }
    ])
  );
  for (const courseResult of courseResults) {
    const context = preferenceContext.get(courseResult.courseId);
    courseResult.rank = context?.rank;
    courseResult.courseAddress = context?.courseAddress;
  }
  courseResults.sort((left, right) => (left.rank ?? 99) - (right.rank ?? 99));

  let batchNotification = { notifiedIncidentIds: [] as string[] };
  try {
    batchNotification = await notifyCourseSupportIssueBatch(
      supportIssues
        .map((issue) => issue.incidentId)
        .filter((incidentId): incidentId is string => Boolean(incidentId))
    );
  } catch (error) {
    console.error("[email:operator-summary-queue-failed]", {
      searchRef: createSearchLogReference(searchId),
      message: error instanceof Error ? error.message : "Unknown operator summary failure"
    });
  }
  const notifiedIncidentIds = new Set(batchNotification.notifiedIncidentIds);
  for (const issue of supportIssues) {
    if (!issue.ownerAlerted && issue.incidentId && notifiedIncidentIds.has(issue.incidentId)) {
      const courseResult = courseResults.find((course) => course.courseId === issue.courseId);
      if (courseResult) {
        courseResult.supportStatus = "TEAM_ALERTED";
      }
    }
  }
  const supportRetryNeeded =
    monitoringRetryCourseIds.size > 0 ||
    supportIssues.some((issue) => issue.status === "UNRECORDED");

  await maintainSearchCheckLease(lease);
  await retryExistingSearchEmailDeliveryGroups({
    searchId: search.id,
    alertGeneration: search.alertGeneration,
    lease,
    assertCurrent: () => maintainSearchCheckLease(lease)
  });
  search = (await getActiveSearchForAutomation(searchId)) ?? search;
  const checkedAt = new Date();
  await maintainSearchCheckLease(lease);
  const statusEmailKind = getSearchStatusEmailKind(
    search.statusEmailSentAt,
    checkedAt,
    search.userTimeZone
  );
  let statusEmailOutcome: SearchCheckResult["statusEmailOutcome"] = "skipped";

  if (statusEmailKind === "setup") {
    try {
      const setupPendingMatches = await listPendingMatchAlerts(searchId);
      statusEmailOutcome = await deliverSearchStatusReport({
        search,
        searchWindow,
        courseResults,
        checkedAt,
        kind: statusEmailKind,
        coveredMatchIds: setupPendingMatches.map((match) => match.id),
        lease,
        assertCurrent: () => maintainSearchCheckLease(lease)
      });
      newlyAlertedMatches =
        statusEmailOutcome === "sent" || statusEmailOutcome === "dry_run"
          ? setupPendingMatches.length
          : 0;
    } catch (error) {
      statusEmailOutcome = "failed";
      console.error("[email:status-failed]", {
        searchRef: createSearchLogReference(search.id),
        message: error instanceof Error ? error.message : "Unknown status email failure"
      });
    }
  } else {
    newlyAlertedMatches = await sendPendingMatchAlerts(searchId, {
      searchWindow,
      courseResults,
      checkedAt,
      requestedLayoutHoles,
      satisfiesStatusReport: statusEmailKind === "daily",
      lease,
      assertCurrent: () => maintainSearchCheckLease(lease)
    });

    if (statusEmailKind === "daily" && newlyAlertedMatches > 0) {
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
          message: error instanceof Error ? error.message : "Unknown status email failure"
        });
      }
    }
  }

  return {
    searchId,
    outcome: "success",
    courseResults,
    availableMatches: courseResults.reduce((total, course) => total + course.availableMatches, 0),
    newlyAlertedMatches,
    supportRetryNeeded,
    statusEmailOutcome
  };
}

async function retryExistingSearchEmailDeliveryGroups(input: {
  searchId: string;
  alertGeneration: number;
  lease: SearchCheckLease;
  assertCurrent: () => Promise<void>;
}) {
  const groups = await listRetryableSearchEmailDeliveryGroups({
    searchId: input.searchId,
    alertGeneration: input.alertGeneration
  });
  let blockingError: unknown;
  for (const group of groups) {
    await input.assertCurrent();
    let deliveryError: unknown;
    try {
      await drainSearchEmailDeliveryGroup({
        searchId: input.searchId,
        alertGeneration: input.alertGeneration,
        checkLeaseToken: input.lease.token,
        kind: group.kind,
        groupKey: group.groupKey,
        send: async ({ recipient, idempotencyKey, payload }) => {
          await input.assertCurrent();
          if (group.kind === "MATCH") {
            const alert = await hydrateMatchAlertPayload({
              searchId: input.searchId,
              alertGeneration: input.alertGeneration,
              payload
            });
            return sendTeeTimeAlert({
              searchId: input.searchId,
              to: recipient,
              ...alert,
              stableIdempotencyKey: idempotencyKey
            });
          }
          const report = await hydrateSearchStatusEmailPayload(payload);
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
      if (ownerFinalized) {
        if (!finalized.finalized) {
          console.warn("[email:additional-recipient-retry-pending]", {
            searchRef: createSearchLogReference(input.searchId),
            kind: group.kind
          });
        }
        continue;
      }
      blockingError ??=
        deliveryError ??
        new Error("Existing search email delivery owner did not reach a terminal state");
    } catch (error) {
      if (error instanceof SearchCheckLeaseLostError) {
        throw error;
      }
      blockingError ??= deliveryError ?? error;
      continue;
    }
  }
  if (blockingError) {
    throw blockingError;
  }
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

async function deliverSearchStatusReport(input: {
  search: NonNullable<Awaited<ReturnType<typeof getActiveSearchForAutomation>>>;
  searchWindow: {
    date: string;
    startTime: string;
    endTime: string;
    players: number;
  };
  courseResults: SearchCheckCourseResult[];
  checkedAt: Date;
  kind: "setup" | "daily";
  coveredMatchIds?: string[];
  lease: SearchCheckLease;
  assertCurrent?: () => Promise<void>;
}): Promise<NonNullable<SearchCheckResult["statusEmailOutcome"]>> {
  const snapshot = buildSearchStatusSnapshot(input.courseResults);
  const persistedStatusReport = toSearchEmailJson({
    kind: input.kind,
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
  const recipients = getAlertRecipients(
    input.search.user.email,
    input.search.additionalEmails
  );
  const periodKey =
    input.kind === "setup"
      ? `setup-${createEmailSnapshotKey(persistedStatusReport)}`
      : `daily-${input.search.statusEmailSentAt?.getTime() ?? "initial"}-${createEmailSnapshotKey(persistedStatusReport)}`;
  await input.assertCurrent?.();
  const deliveryKind = input.kind === "setup" ? "SETUP" : "DAILY";
  const prepared = await prepareSearchEmailDeliveryGroup({
    searchId: input.search.id,
    alertGeneration: input.search.alertGeneration,
    checkLeaseToken: input.lease.token,
    kind: deliveryKind,
    groupKey: periodKey,
    recipients,
    ownerRecipient: input.search.user.email,
    payload: {
      schemaVersion: 2,
      checkedAt: input.checkedAt.toISOString(),
      statusSnapshot: snapshot,
      statusReport: persistedStatusReport,
      ...(input.coveredMatchIds ? { matchIds: input.coveredMatchIds } : {})
    }
  });
  if (!prepared.prepared) {
    throw new SearchCheckLeaseLostError();
  }
  const deliveries = await drainSearchEmailDeliveryGroup({
    searchId: input.search.id,
    alertGeneration: input.search.alertGeneration,
    checkLeaseToken: input.lease.token,
    kind: deliveryKind,
    groupKey: periodKey,
    send: async ({ recipient, idempotencyKey, payload }) => {
      await input.assertCurrent?.();
      const report = await hydrateSearchStatusEmailPayload(payload);
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
    throw new Error("Search status email delivery group did not reach a terminal state");
  }

  return deliveries.every((delivery) => delivery.status === "SUPPRESSED")
    ? "dry_run"
    : "sent";
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
  const pendingMatches = await listPendingMatchAlerts(searchId);
  if (pendingMatches.length === 0) {
    return 0;
  }
  const search = pendingMatches[0].teeSearch;

  const allAvailableMatches = await listAvailableMatchAlerts(searchId);
  const currentMatchKeys = new Set(
    input.courseResults.flatMap((course) =>
      (course.matchingTimes ?? []).map(
        (time) =>
          `${course.courseId}:${parseCourseLocalDateTime(time.startsAt, course.timeZone).getTime()}`
      )
    )
  );
  const availableMatches = allAvailableMatches.filter((match) =>
    currentMatchKeys.has(`${match.course.id}:${match.startsAt.getTime()}`)
  );
  const currentAvailableIds = new Set(availableMatches.map((match) => match.id));
  const stalePendingMatches = pendingMatches.filter(
    (match) => !currentAvailableIds.has(match.id)
  );
  if (stalePendingMatches.length > 0) {
    await input.assertCurrent?.();
    const suppression = await suppressSearchEmailDeliveriesForMatches({
      searchId,
      alertGeneration: search.alertGeneration,
      checkLeaseToken: input.lease.token,
      matchIds: stalePendingMatches.map((match) => match.id)
    });
    if (!suppression.current) {
      throw new SearchCheckLeaseLostError();
    }
  }
  const currentPendingMatches = pendingMatches.filter((match) =>
    currentAvailableIds.has(match.id)
  );
  if (availableMatches.length === 0 || currentPendingMatches.length === 0) {
    return 0;
  }

  const recipients = getAlertRecipients(search.user.email, search.additionalEmails);
  const batchKey = createHash("sha256")
    .update(currentPendingMatches.map((match) => match.id).sort().join(":"))
    .digest("hex")
    .slice(0, 24);
  await input.assertCurrent?.();
  const prepared = await prepareSearchEmailDeliveryGroup({
    searchId,
    alertGeneration: search.alertGeneration,
    checkLeaseToken: input.lease.token,
    kind: "MATCH",
    groupKey: batchKey,
    recipients,
    ownerRecipient: search.user.email,
    payload: {
      schemaVersion: 2,
      checkedAt: input.checkedAt.toISOString(),
      matchIds: currentPendingMatches.map((match) => match.id),
      displayMatchIds: availableMatches.map((match) => match.id),
      satisfiesStatusReport: input.satisfiesStatusReport,
      statusSnapshot: buildSearchStatusSnapshot(input.courseResults),
      matchReport: toSearchEmailJson({
        targetDate: input.searchWindow.date,
        startTime: input.searchWindow.startTime,
        endTime: input.searchWindow.endTime,
        players: input.searchWindow.players,
        requestedLayoutHoles: input.requestedLayoutHoles,
        userTimeZone: search.userTimeZone,
        matches: availableMatches.map((match) => ({
          matchId: match.id,
          courseId: match.course.id,
          courseName: match.course.name,
          courseRank: input.courseResults.find(
            (course) => course.courseId === match.course.id
          )?.rank,
          courseAddress:
            input.courseResults.find((course) => course.courseId === match.course.id)
              ?.courseAddress ?? match.course.address ?? undefined,
          courseTimeZone: match.course.timeZone,
          startsAt: match.startsAt.toISOString(),
          availableSpots: match.availableSpots,
          bookingUrl: match.bookingUrl,
          priceCents: match.priceCents,
          holes: match.holes,
          bookableHoleCounts:
            input.courseResults
              .find((course) => course.courseId === match.course.id)
              ?.matchingTimes?.find(
                (time) =>
                  parseCourseLocalDateTime(time.startsAt, match.course.timeZone).getTime() ===
                  match.startsAt.getTime()
              )?.bookableHoleCounts ?? [],
          isNew: currentPendingMatches.some((pending) => pending.id === match.id)
        }))
      })
    }
  });
  if (!prepared.prepared) {
    throw new SearchCheckLeaseLostError();
  }
  const deliveries = await drainSearchEmailDeliveryGroup({
    searchId,
    alertGeneration: search.alertGeneration,
    checkLeaseToken: input.lease.token,
    kind: "MATCH",
    groupKey: batchKey,
    send: async ({ recipient, idempotencyKey, payload }) => {
      await input.assertCurrent?.();
      const alert = await hydrateMatchAlertPayload({
        searchId,
        alertGeneration: search.alertGeneration,
        payload
      });
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
    groupKey: batchKey
  });
  if (!finalized.finalized || deliveries.length === 0) {
    throw new Error("Match email delivery group did not reach a terminal state");
  }

  return currentPendingMatches.length;
}

function getAlertRecipients(primaryEmail: string, additionalEmails: string[] = []) {
  return [...new Set([primaryEmail, ...additionalEmails].map((email) => email.trim().toLowerCase()))];
}

function createEmailSnapshotKey(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function createSearchLogReference(searchId: string) {
  return createHash("sha256").update(searchId).digest("hex").slice(0, 16);
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
    statusEmailOutcome: result.statusEmailOutcome
  };
}

function hasSupportedAdapter(course: AutomationCourse) {
  return resolveProviderCapability(course).isRunnable;
}

type CourseTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

function fetchCourseTeeSheet(
  course: AutomationCourse,
  date: Date,
  players: number,
  discoverBookingWindow: boolean
): Promise<CourseTeeSheetResult> {
  const providerFamily = resolveProviderCapability(course).providerFamilyKey;
  if (providerFamily === "FOREUP" && isForeupMetadata(course.bookingMetadata)) {
    const metadata = course.bookingWindowEvidenceUrl
      ? {
          ...course.bookingMetadata,
          bookingWindowEvidenceUrl: course.bookingWindowEvidenceUrl
        }
      : course.bookingMetadata;
    return fetchForeupTeeSheet({
      courseId: course.id,
      date,
      players,
      metadata,
      discoverBookingWindow
    });
  }
  if (providerFamily === "TEEITUP" && isTeeItUpMetadata(course.bookingMetadata)) {
    return fetchTeeItUpTeeSheet({ courseId: course.id, date, metadata: course.bookingMetadata });
  }
  if (providerFamily === "CHRONOGOLF" && isChronogolfMetadata(course.bookingMetadata)) {
    return fetchChronogolfSlots({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata
    }).then((slots) => ({
      slots,
      targetDateStatus: slots.length > 0 ? "OPEN" as const : "UNKNOWN" as const,
      bookingWindowEvidence: null
    }));
  }
  if (providerFamily === "CPS" && isCpsMetadata(course.bookingMetadata)) {
    return fetchCpsTeeSheet({
      courseId: course.id,
      date,
      players,
      timeZone: course.timeZone,
      metadata: course.bookingMetadata,
      discoverBookingWindow
    });
  }
  if (providerFamily === "CHELSEA" && isChelseaMetadata(course.bookingMetadata)) {
    return fetchChelseaTeeSheet({
      courseId: course.id,
      date,
      players,
      timeZone: course.timeZone,
      metadata: course.bookingMetadata
    });
  }
  if (providerFamily === "GOLFBACK" && isGolfBackMetadata(course.bookingMetadata)) {
    return fetchGolfBackTeeSheet({
      courseId: course.id,
      date,
      players,
      timeZone: course.timeZone,
      metadata: course.bookingMetadata,
      discoverBookingWindow
    });
  }
  if (providerFamily === "WEBTRAC" && isWebTracMetadata(course.bookingMetadata)) {
    return fetchWebTracTeeSheet({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata,
      discoverBookingWindow
    });
  }
  if (providerFamily === "TEESNAP" && isTeesnapMetadata(course.bookingMetadata)) {
    return fetchTeesnapTeeSheet({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata,
      discoverBookingWindow
    });
  }
  return Promise.resolve({
    slots: [],
    targetDateStatus: "UNKNOWN",
    bookingWindowEvidence: null
  });
}

async function recordBookingWindowWaitingProbe(input: {
  searchId: string;
  courseId: string;
  automationRunId: string;
  targetDate: string;
  bookingWindow: TargetBookingWindow;
  providerExecution?: boolean;
}) {
  await recordCourseProbeIfChanged({
    searchId: input.searchId,
    courseId: input.courseId,
    automationRunId: input.automationRunId,
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
