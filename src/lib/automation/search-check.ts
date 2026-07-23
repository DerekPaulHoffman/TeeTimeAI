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
  getBestProbeUrl,
  shouldQueueBrowserProbe
} from "@/lib/automation/browser-discovery";
import {
  classifyProviderFailure,
  resolveProviderCapability
} from "@/lib/automation/provider-capabilities";
import {
  fetchCourseTeeSheet,
  type AutomationCourseProviderRead
} from "@/lib/automation/course-provider-read";
import { evaluateMonitoringGate } from "@/lib/automation/policy";
import { runProviderFamilyTasks } from "@/lib/automation/provider-concurrency";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { prepareSearchMonitoring } from "@/lib/automation/search-monitoring-discovery";
import {
  notifyCourseSupportIssueBatch,
  reportCourseSupportIssue,
  resolveCourseSupportIncident
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
import {
  sendSearchStatusEmail,
  sendTeeTimeAlert
} from "@/lib/email/alerts";
import {
  drainSearchEmailDeliveryGroup,
  finalizeSearchEmailDeliveryGroup,
  getPendingStatusEmailReplacement,
  getSafeOfficialBookingUrl,
  hydrateMatchAlertPayload,
  hydrateSearchStatusEmailPayload,
  listRetryableSearchEmailDeliveryGroups,
  prepareRecipientMatchDeliveryGroups,
  prepareSearchEmailDeliveryGroup,
  satisfyPendingDailyStatusReplacementWithMatch,
  toSearchEmailJson
} from "@/lib/email/search-delivery-outbox";
import {
  buildSearchStatusSnapshot,
  getSearchStatusEmailKind,
  summarizeSearchStatusAvailability,
  type SearchStatusCourseReport
} from "@/lib/email/search-status";
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
const SHORT_SEARCH_RETRY_FAILURES = new Set([
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "UNKNOWN"
]);

type AutomationCourse = AutomationCourseProviderRead & {
  name: string;
  address: string | null;
  phone: string | null;
  bookingPhone: string | null;
  isPublic: boolean;
  bookingMethod: BookingMethod;
  automationEligibility: "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
  automationReason: AutomationReason;
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

    const monitoringGate = evaluateMonitoringGate(course);
    if (monitoringGate.disposition !== "ACTIONABLE") {
      const technicalFinal = monitoringGate.disposition === "TECHNICAL_FINAL";
      const identityBlocked =
        monitoringGate.disposition === "IDENTITY_FINAL" ||
        monitoringGate.disposition === "IDENTITY_RECHECK";
      const outcome = technicalFinal ? "BLOCKED_AUTH" : "BLOCKED_POLICY";
      const message = getFinalMonitoringMessage(course, monitoringGate.disposition);
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
        outcome,
        message,
        rawSummary: {
          monitoringDisposition: monitoringGate.disposition,
          automationReason: course.automationReason
        }
      });
      if (monitoringGate.disposition !== "IDENTITY_RECHECK") {
        await resolveCourseSupportIncident({
          courseId: course.id,
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          message
        });
      }
      courseResults.push({
        courseId: course.id,
        courseName: course.name,
        timeZone: course.timeZone,
        outcome,
        availableMatches: 0,
        message,
        bookingUrl: identityBlocked ? undefined : getCustomerBookingUrl(course),
        phone: identityBlocked
          ? undefined
          : course.bookingPhone ?? course.phone ?? undefined,
        bookingMethod: course.bookingMethod,
        bookingAccessMode: course.bookingAccessMode,
        bookingAccess: identityBlocked ? undefined : getCourseBookingAccess(course),
        automationReason: course.automationReason,
        monitoringDisposition: monitoringGate.disposition
      });
      return;
    }

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
        bookingAccessMode: course.bookingAccessMode,
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
          ? `Build or extend a reusable public read-only adapter from the completed official-site discovery for ${browserProbeUrl}, then verify this search.`
          : "Autonomously classify the official booking method, find a public read-only retrieval path if one exists, and verify this search."
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
        bookingAccessMode: course.bookingAccessMode,
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

    let providerRequestStarted = false;
    try {
      const providerExecution = await runWithProviderRequestLease(
        resolveProviderCapability(course).providerFamilyKey,
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
      const safeRawSlots = rawSlots.flatMap((slot) => {
        const bookingUrl = getSafeOfficialBookingUrl(slot.bookingUrl);
        return bookingUrl ? [{ ...slot, bookingUrl }] : [];
      });
      const unsafeBookingUrlCount = rawSlots.length - safeRawSlots.length;
      const availability = summarizeSearchStatusAvailability(searchWindow, safeRawSlots);
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
        confirmedMatches: normalizedCurrentMatches.map(({ match, startsAt }) => ({
          sourceId: match.sourceId,
          startsAt
        }))
      });

      if (unsafeBookingUrlCount > 0) {
        const unsafeBookingMessage =
          "The provider returned a non-direct or unsafe booking destination; unsafe rows were excluded.";
        const supportIssue = await reportCourseSupportIssue({
          course,
          searchId: search.id,
          kind: "FETCH_FAILED",
          message: unsafeBookingMessage,
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
            outcome: "FETCH_FAILED",
            message: unsafeBookingMessage,
            rawSummary: {
              providerExecution: "RUNNABLE_PROVIDER_CHECK",
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
          ...(pricing ? { pricing } : {}),
          ...(unsafeBookingUrlCount > 0 ? { unsafeBookingUrlCount } : {})
        }
      });
      if (unsafeBookingUrlCount === 0) {
        await resolveCourseSupportIncident({
          courseId: course.id,
          resolution: "MONITORING_RESTORED",
          message: `${course.name} completed a public read-only tee-sheet check with outcome ${outcome}.`
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
      const message = error instanceof Error ? error.message : "Unknown adapter error";
      if (SHORT_SEARCH_RETRY_FAILURES.has(classifyProviderFailure({ error }).failureClass)) {
        monitoringRetryCourseIds.add(course.id);
      }
      await recordCourseProbe({
        searchId: search.id,
        courseId: course.id,
        automationRunId,
        outcome: "FETCH_FAILED",
        message,
        rawSummary: providerRequestStarted
          ? { providerExecution: "RUNNABLE_PROVIDER_CHECK" }
          : undefined
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
        bookingAccessMode: course.bookingAccessMode,
        bookingAccess: getCourseBookingAccess(course),
        supportStatus: supportIssue.ownerAlerted ? "TEAM_ALERTED" : "PENDING_ALERT"
      });
    }
    }
  );

  const preferenceContext = new Map(
    search.preferences.map((preference) => {
      const observedFacts = observedBookingFactsByCourse.get(preference.course.id);
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
        distanceMeters:
          preference.distanceMetersAtSelection ?? undefined,
        courseAddress: preference.course.address ?? undefined,
        isPublic: preference.course.isPublic,
        rating: preference.course.rating ?? undefined,
        ratingObservedAt:
          preference.course.ratingObservedAt?.toISOString(),
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
            : undefined
        }
      ] as const;
    })
  );
  for (const courseResult of courseResults) {
    const context = preferenceContext.get(courseResult.courseId);
    courseResult.rank = context?.rank;
    courseResult.distanceMeters = context?.distanceMeters;
    courseResult.courseAddress = context?.courseAddress;
    courseResult.isPublic = context?.isPublic;
    courseResult.rating = context?.rating;
    courseResult.ratingObservedAt = context?.ratingObservedAt;
    courseResult.layoutHoleCounts = context?.layoutHoleCounts;
    courseResult.layoutHolesVerifiedAt = context?.layoutHolesVerifiedAt;
    courseResult.priceEstimate = context?.priceEstimate;
    courseResult.bookableHoleCounts =
      context?.bookableHoleSummary.holeCounts;
    courseResult.bookableHoleCountsObservedAt =
      context?.bookableHoleSummary.observedAt;
    courseResult.courseGuideUrl = context?.courseGuideUrl;
    courseResult.factLine = buildCourseFactLine(courseResult);
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
  const checkedAt = new Date();
  const statusKindBeforeRetry = getSearchStatusEmailKind(
    search.statusEmailSentAt,
    checkedAt,
    search.userTimeZone
  );
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
      snapshot: toSearchEmailJson(buildSearchStatusSnapshot(courseResults))
    });
    if (updated.count !== 1) {
      throw new SearchCheckLeaseLostError();
    }
    newlyAlertedMatches += retriedDeliveries.ownerSentMatchCount;
  }
  let pendingStatusReplacement = await getPendingStatusEmailReplacement({
    searchId: search.id,
    alertGeneration: search.alertGeneration
  });
  if (
    retriedMatchCoveredDaily &&
    pendingStatusReplacement?.kind === "DAILY"
  ) {
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
  await maintainSearchCheckLease(lease);
  const statusEmailKind = pendingStatusReplacement
    ? pendingStatusReplacement.kind === "SETUP"
      ? "setup"
      : "daily"
    : getSearchStatusEmailKind(
        search.statusEmailSentAt,
        checkedAt,
        search.userTimeZone
      );
  let statusEmailOutcome: SearchCheckResult["statusEmailOutcome"] =
    retriedMatchCoveredDaily ? "covered_by_match_alert" : "skipped";

  if (pendingStatusReplacement) {
    try {
      const pendingMatches = await listPendingMatchAlerts(searchId);
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
        message: error instanceof Error ? error.message : "Unknown status email failure"
      });
    }
  } else if (statusEmailKind === "setup") {
    try {
      const setupPendingMatches = await listPendingMatchAlerts(searchId);
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
        message: error instanceof Error ? error.message : "Unknown status email failure"
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

async function retryExistingSearchEmailDeliveryGroups(input: {
  searchId: string;
  alertGeneration: number;
  lease: SearchCheckLease;
  assertCurrent: () => Promise<void>;
}) {
  const seen = new Set<string>();
  let ownerSentMatchCount = 0;
  for (let pass = 0; pass < 100; pass += 1) {
    const groups = await listRetryableSearchEmailDeliveryGroups({
      searchId: input.searchId,
      alertGeneration: input.alertGeneration
    });
    const group = groups.find(
      (candidate) => !seen.has(`${candidate.kind}\u0000${candidate.groupKey}`)
    );
    if (!group) {
      return { ownerSentMatchCount };
    }
    seen.add(`${group.kind}\u0000${group.groupKey}`);
    await input.assertCurrent();
    let deliveryError: unknown;
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
  return { ownerSentMatchCount };
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
  coveredMatchRefs?: Array<{ matchId: string; availabilityCycle: number }>;
  supersededStatusGroups?: Array<{
    kind: "SETUP" | "DAILY";
    groupKey: string;
  }>;
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
  const availableMatches = await listAvailableMatchAlerts(input.search.id);
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
    input.kind === "setup"
      ? `setup-${createEmailSnapshotKey(persistedStatusReport)}`
      : `daily-${input.search.statusEmailSentAt?.getTime() ?? "initial"}-${createEmailSnapshotKey(persistedStatusReport)}`;
  const replacementSuffix = input.supersededStatusGroups?.length
    ? `-replacement-${createEmailSnapshotKey(
        input.supersededStatusGroups
          .map((group) => `${group.kind}:${group.groupKey}`)
          .sort()
      )}`
    : "";
  const periodKey = `${basePeriodKey}${replacementSuffix}`;
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
    throw new Error("Search status email delivery group did not reach a terminal state");
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
  const pendingMatches = await listPendingMatchAlerts(searchId);
  if (pendingMatches.length === 0) {
    return { ownerSentMatchCount: 0, hasDurableMatchObligation: false };
  }
  const search = pendingMatches[0].teeSearch;

  const allAvailableMatches = await listAvailableMatchAlerts(searchId);
  const currentMatchIds = new Set(
    input.courseResults.flatMap((course) =>
      (course.matchingTimes ?? []).flatMap((time) =>
        typeof time.matchId === "string" ? [time.matchId] : []
      )
    )
  );
  const availableMatches = allAvailableMatches.filter((match) =>
    currentMatchIds.has(match.id)
  );
  const currentAvailableIds = new Set(availableMatches.map((match) => match.id));
  const currentPendingMatches = pendingMatches.filter((match) =>
    currentAvailableIds.has(match.id)
  );
  if (availableMatches.length === 0 || currentPendingMatches.length === 0) {
    return { ownerSentMatchCount: 0, hasDurableMatchObligation: false };
  }

  const currentPendingIds = new Set(currentPendingMatches.map((match) => match.id));
  const reportMatches = availableMatches.map((match) => {
    const courseResult = input.courseResults.find(
      (course) => course.courseId === match.course.id
    );
    return {
      matchId: match.id,
      courseId: match.course.id,
      courseName: match.course.name,
      courseRank: courseResult?.rank,
      courseAddress: courseResult?.courseAddress ?? match.course.address ?? undefined,
      courseTimeZone: match.course.timeZone,
      startsAt: match.startsAt,
      availableSpots: match.availableSpots,
      bookingUrl: match.bookingUrl,
      priceCents: match.priceCents,
      holes: match.holes,
      bookableHoleCounts:
        courseResult?.matchingTimes?.find(
          (time) => time.matchId === match.id
        )?.bookableHoleCounts ?? [],
      factLine: courseResult?.factLine ?? buildCourseFactLine(courseResult ?? {}),
      courseGuideUrl: courseResult?.courseGuideUrl,
      isNew: currentPendingIds.has(match.id)
    };
  });
  const coveredMatches = reportMatches;
  const coveredPendingMatches = currentPendingMatches;
  if (coveredPendingMatches.length === 0) {
    return { ownerSentMatchCount: 0, hasDurableMatchObligation: false };
  }

  const recipients = getAlertRecipients(search.user.email, search.additionalEmails);
  const batchKey = buildMatchDeliveryGroupKey(coveredPendingMatches);
  await input.assertCurrent?.();
  const prepared = await prepareRecipientMatchDeliveryGroups({
    searchId,
    alertGeneration: search.alertGeneration,
    checkLeaseToken: input.lease.token,
    sourceGroupKey: batchKey,
    recipients,
    ownerRecipient: search.user.email,
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
  const ownerRecipient = search.user.email.trim().toLowerCase();
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
