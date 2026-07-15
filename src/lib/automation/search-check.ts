import { createHash } from "node:crypto";

import {
  finishAutomationRun,
  getActiveSearchForAutomation,
  listAvailableMatchAlerts,
  listPendingMatchAlerts,
  markCourseBookingWindowChecked,
  markMatchAlertSent,
  markMatchAlertSuppressed,
  markMissingMatchesUnavailable,
  markSearchStatusEmailSent,
  recordCourseBookingWindowEvidence,
  recordCourseProbe,
  recordCourseProbeIfChanged,
  recordTeeTimeMatch,
  runWithSearchCheckLease,
  startAutomationRun
} from "@/lib/automation/db-service";
import { getBestProbeUrl, shouldQueueBrowserProbe } from "@/lib/automation/browser-discovery";
import { evaluateAutomationPolicy } from "@/lib/automation/policy";
import { prepareSearchMonitoring } from "@/lib/automation/search-monitoring-discovery";
import {
  notifyCourseSupportIssueBatch,
  reportCourseSupportIssue,
  resolveCourseSupportIncident
} from "@/lib/automation/support-incidents";
import { fetchCpsSlots, isCpsMetadata } from "@/lib/adapters/cps";
import { fetchChelseaTeeSheet, isChelseaMetadata } from "@/lib/adapters/chelsea";
import { fetchChronogolfSlots, isChronogolfMetadata } from "@/lib/adapters/chronogolf";
import { fetchForeupTeeSheet, isForeupMetadata } from "@/lib/adapters/foreup";
import { fetchTeeItUpTeeSheet, isTeeItUpMetadata } from "@/lib/adapters/teeitup";
import { fetchTeesnapTeeSheet, isTeesnapMetadata } from "@/lib/adapters/teesnap";
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

type AutomationCourse = {
  id: string;
  name: string;
  address: string | null;
  timeZone: string;
  phone: string | null;
  bookingPhone: string | null;
  website: string | null;
  detectedBookingUrl: string | null;
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

export async function runSearchCheck(searchId: string, trigger = "scheduled") {
  const run = await startAutomationRun(PROMPT_VERSION);

  try {
    const lease = await runWithSearchCheckLease(searchId, () => checkSearch(searchId, run.id));
    if (!lease.acquired) {
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
        notes: `Search ${searchId} already has a check in progress. Trigger: ${trigger}.`
      });
      return result;
    }

    await finishAutomationRun(run.id, {
      outcome: lease.value.outcome,
      notes: JSON.stringify({ trigger, ...lease.value })
    });
    return lease.value;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown search check failure";
    await finishAutomationRun(run.id, {
      outcome: "failed",
      errors: { message },
      notes: error instanceof Error ? error.stack ?? message : message
    });
    throw error;
  }
}

async function checkSearch(searchId: string, automationRunId: string): Promise<SearchCheckResult> {
  let search = await getActiveSearchForAutomation(searchId);
  if (!search) {
    return {
      searchId,
      outcome: "not_active",
      courseResults: [],
      availableMatches: 0,
      newlyAlertedMatches: 0,
      supportRetryNeeded: false
    };
  }

  let monitoringRetryCourseIds = new Set<string>();
  try {
    const preparation = await prepareSearchMonitoring(search);
    monitoringRetryCourseIds = new Set(preparation.retryCourseIds);
    if (preparation.appliedCourseIds.length > 0) {
      search = (await getActiveSearchForAutomation(searchId)) ?? search;
    }
  } catch (error) {
    console.error("[monitoring:discovery-failed]", {
      searchId,
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

  for (const preference of search.preferences) {
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
        bookingUrl: course.detectedBookingUrl ?? course.website ?? undefined,
        phone: course.bookingPhone ?? course.phone ?? undefined,
        bookingMethod: course.bookingMethod,
        bookingAccess: getCourseBookingAccess(course)
      });
      continue;
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
        bookingUrl: course.detectedBookingUrl ?? course.website ?? undefined,
        phone: course.bookingPhone ?? course.phone ?? undefined,
        bookingMethod: course.bookingMethod,
        bookingAccess: getCourseBookingAccess(course)
      });
      continue;
    }

    if (!hasSupportedAdapter(course)) {
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
        bookingUrl: course.detectedBookingUrl ?? course.website ?? undefined,
        phone: course.bookingPhone ?? course.phone ?? undefined,
        bookingMethod: course.bookingMethod,
        bookingAccess: getCourseBookingAccess(course),
        supportStatus: supportIssue.ownerAlerted ? "TEAM_ALERTED" : "PENDING_ALERT"
      });
      continue;
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
      continue;
    }

    try {
      const teeSheet = await fetchCourseTeeSheet(
        course,
        search.date,
        search.players,
        refreshBookingWindow
      );
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
      if (rawSlots.length === 0 && bookingWindow && bookingWindow.opensAt > checkStartedAt) {
        await recordBookingWindowWaitingProbe({
          searchId: search.id,
          courseId: course.id,
          automationRunId,
          targetDate: searchWindow.date,
          bookingWindow
        });
        await resolveCourseSupportIncident({
          courseId: course.id,
          resolution: "MONITORING_RESTORED",
          message: `${course.name} returned a verified booking-window release for ${searchWindow.date}.`
        });
        courseResults.push(buildBookingWindowCourseReport(course, bookingWindow));
        continue;
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
          isNew: persistedPendingStates[index] === true
        }))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown adapter error";
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
        bookingUrl: course.detectedBookingUrl ?? course.website ?? undefined,
        phone: course.bookingPhone ?? course.phone ?? undefined,
        bookingMethod: course.bookingMethod,
        bookingAccess: getCourseBookingAccess(course),
        supportStatus: supportIssue.ownerAlerted ? "TEAM_ALERTED" : "PENDING_ALERT"
      });
    }
  }

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

  let batchNotification = { notifiedIncidentIds: [] as string[] };
  try {
    batchNotification = await notifyCourseSupportIssueBatch(
      supportIssues
        .map((issue) => issue.incidentId)
        .filter((incidentId): incidentId is string => Boolean(incidentId))
    );
  } catch (error) {
    console.error("[email:operator-summary-queue-failed]", {
      searchId,
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
  const supportRetryNeeded = supportIssues.some(
    (issue) =>
      issue.status === "UNRECORDED" || monitoringRetryCourseIds.has(issue.courseId)
  );

  const checkedAt = new Date();
  const statusEmailKind = getSearchStatusEmailKind(
    search.statusEmailSentAt,
    checkedAt,
    search.userTimeZone
  );
  let statusEmailOutcome: SearchCheckResult["statusEmailOutcome"] = "skipped";

  if (statusEmailKind === "setup") {
    try {
      statusEmailOutcome = await deliverSearchStatusReport({
        search,
        searchWindow,
        courseResults,
        checkedAt,
        kind: statusEmailKind
      });
      newlyAlertedMatches = await settlePendingMatchesCoveredByStatusReport(
        searchId,
        statusEmailOutcome
      );
    } catch (error) {
      statusEmailOutcome = "failed";
      console.error("[email:status-failed]", {
        searchId: search.id,
        message: error instanceof Error ? error.message : "Unknown status email failure"
      });
    }
  } else {
    newlyAlertedMatches = await sendPendingMatchAlerts(searchId, {
      searchWindow,
      courseResults,
      checkedAt,
      requestedLayoutHoles
    });

    if (statusEmailKind === "daily" && newlyAlertedMatches > 0) {
      await markSearchStatusReportSatisfied({
        searchId: search.id,
        checkedAt,
        courseResults
      });
      statusEmailOutcome = "covered_by_match_alert";
    } else if (statusEmailKind === "daily") {
      try {
        statusEmailOutcome = await deliverSearchStatusReport({
          search,
          searchWindow,
          courseResults,
          checkedAt,
          kind: statusEmailKind
        });
      } catch (error) {
        statusEmailOutcome = "failed";
        console.error("[email:status-failed]", {
          searchId: search.id,
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
  if (course.detectedBookingUrl) {
    return "BOOKING_PAGE";
  }
  if (course.website) {
    return "OFFICIAL_SITE";
  }
  return course.bookingPhone || course.phone ? "PHONE_ONLY" : undefined;
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
}): Promise<NonNullable<SearchCheckResult["statusEmailOutcome"]>> {
  const snapshot = buildSearchStatusSnapshot(input.courseResults);
  const recipients = getAlertRecipients(
    input.search.user.email,
    input.search.additionalEmails
  );
  const periodKey =
    input.kind === "setup"
      ? "setup"
      : `daily-${input.search.statusEmailSentAt?.getTime() ?? "initial"}`;
  const deliveries = await Promise.all(
    recipients.map((recipient) =>
      sendSearchStatusEmail({
        searchId: input.search.id,
        to: recipient,
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
        checkedAt: input.checkedAt,
        courses: input.courseResults,
        previousSnapshot: input.search.statusEmailSnapshot,
        idempotencyKey: `tee-search-status-${input.search.id}-${periodKey}-${recipient}`
      })
    )
  );

  await markSearchStatusEmailSent({
    searchId: input.search.id,
    sentAt: input.checkedAt,
    snapshot
  });

  return deliveries.every((delivery) => delivery.deliveryStatus === "dry_run")
    ? "dry_run"
    : "sent";
}

async function markSearchStatusReportSatisfied(input: {
  searchId: string;
  checkedAt: Date;
  courseResults: SearchCheckCourseResult[];
}) {
  await markSearchStatusEmailSent({
    searchId: input.searchId,
    sentAt: input.checkedAt,
    snapshot: buildSearchStatusSnapshot(input.courseResults)
  });
}

async function settlePendingMatchesCoveredByStatusReport(
  searchId: string,
  statusEmailOutcome: "sent" | "dry_run" | "skipped" | "covered_by_match_alert" | "failed"
) {
  const pendingMatches = await listPendingMatchAlerts(searchId);
  if (pendingMatches.length === 0) {
    return 0;
  }

  if (statusEmailOutcome === "dry_run") {
    await Promise.all(pendingMatches.map((match) => markMatchAlertSuppressed(match.id)));
  } else if (statusEmailOutcome === "sent") {
    await Promise.all(pendingMatches.map((match) => markMatchAlertSent(match.id)));
  } else {
    return 0;
  }

  return pendingMatches.length;
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
  }
) {
  const pendingMatches = await listPendingMatchAlerts(searchId);
  if (pendingMatches.length === 0) {
    return 0;
  }

  const availableMatches = await listAvailableMatchAlerts(searchId);
  if (availableMatches.length === 0) {
    await Promise.all(pendingMatches.map((match) => markMatchAlertSuppressed(match.id)));
    return 0;
  }

  const pendingIds = new Set(pendingMatches.map((match) => match.id));
  const search = pendingMatches[0].teeSearch;
  const courseContext = new Map(
    input.courseResults.map((course) => [course.courseId, course])
  );
  const recipients = getAlertRecipients(search.user.email, search.additionalEmails);
  const batchKey = createHash("sha256")
    .update(pendingMatches.map((match) => match.id).sort().join(":"))
    .digest("hex")
    .slice(0, 24);
  const deliveries = await Promise.all(
    recipients.map((recipient) =>
      sendTeeTimeAlert({
        searchId,
        to: recipient,
        matches: availableMatches.map((match) => ({
          courseId: match.course.id,
          courseName: match.course.name,
          courseRank: courseContext.get(match.course.id)?.rank,
          courseAddress:
            courseContext.get(match.course.id)?.courseAddress ??
            match.course.address ??
            undefined,
          courseTimeZone: match.course.timeZone,
          startsAt: match.startsAt,
          availableSpots: match.availableSpots,
          bookingUrl: match.bookingUrl,
          priceCents: match.priceCents,
          holes: match.holes,
          isNew: pendingIds.has(match.id)
        })),
        userTimeZone: search.userTimeZone,
        targetDate: input.searchWindow.date,
        startTime: input.searchWindow.startTime,
        endTime: input.searchWindow.endTime,
        players: input.searchWindow.players,
        requestedLayoutHoles: input.requestedLayoutHoles,
        checkedAt: input.checkedAt,
        idempotencyKey: `tee-time-match-batch-${batchKey}-${recipient}`
      })
    )
  );

  if (deliveries.every((delivery) => delivery.deliveryStatus === "dry_run")) {
    await Promise.all(pendingMatches.map((match) => markMatchAlertSuppressed(match.id)));
  } else {
    await Promise.all(pendingMatches.map((match) => markMatchAlertSent(match.id)));
  }

  return pendingMatches.length;
}

function getAlertRecipients(primaryEmail: string, additionalEmails: string[] = []) {
  return [...new Set([primaryEmail, ...additionalEmails].map((email) => email.trim().toLowerCase()))];
}

function hasSupportedAdapter(course: AutomationCourse) {
  return (
    (course.detectedPlatform === "FOREUP" && isForeupMetadata(course.bookingMetadata)) ||
    (course.detectedPlatform === "TEEITUP" && isTeeItUpMetadata(course.bookingMetadata)) ||
    (course.detectedPlatform === "CHRONOGOLF" && isChronogolfMetadata(course.bookingMetadata)) ||
    (course.detectedPlatform === "CUSTOM" &&
      (isCpsMetadata(course.bookingMetadata) ||
        isChelseaMetadata(course.bookingMetadata) ||
        isTeesnapMetadata(course.bookingMetadata)))
  );
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
  if (course.detectedPlatform === "FOREUP" && isForeupMetadata(course.bookingMetadata)) {
    return fetchForeupTeeSheet({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata,
      discoverBookingWindow
    });
  }
  if (course.detectedPlatform === "TEEITUP" && isTeeItUpMetadata(course.bookingMetadata)) {
    return fetchTeeItUpTeeSheet({ courseId: course.id, date, metadata: course.bookingMetadata });
  }
  if (course.detectedPlatform === "CHRONOGOLF" && isChronogolfMetadata(course.bookingMetadata)) {
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
  if (course.detectedPlatform === "CUSTOM" && isCpsMetadata(course.bookingMetadata)) {
    return fetchCpsSlots({
      courseId: course.id,
      date,
      players,
      timeZone: course.timeZone,
      metadata: course.bookingMetadata
    }).then((slots) => ({
      slots,
      targetDateStatus: slots.length > 0 ? "OPEN" as const : "UNKNOWN" as const,
      bookingWindowEvidence: null
    }));
  }
  if (course.detectedPlatform === "CUSTOM" && isChelseaMetadata(course.bookingMetadata)) {
    return fetchChelseaTeeSheet({
      courseId: course.id,
      date,
      players,
      timeZone: course.timeZone,
      metadata: course.bookingMetadata
    });
  }
  if (course.detectedPlatform === "CUSTOM" && isTeesnapMetadata(course.bookingMetadata)) {
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
    bookingUrl: course.detectedBookingUrl ?? course.website ?? undefined,
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
