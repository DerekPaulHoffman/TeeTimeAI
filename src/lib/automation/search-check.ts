import { createHash } from "node:crypto";

import {
  finishAutomationRun,
  getActiveSearchForAutomation,
  listAvailableMatchAlerts,
  listPendingMatchAlerts,
  markMatchAlertSent,
  markMatchAlertSuppressed,
  markMissingMatchesUnavailable,
  markSearchStatusEmailSent,
  recordCourseProbe,
  recordCourseProbeIfChanged,
  recordTeeTimeMatch,
  runWithSearchCheckLease,
  startAutomationRun
} from "@/lib/automation/db-service";
import { getBestProbeUrl, shouldQueueBrowserProbe } from "@/lib/automation/browser-discovery";
import { evaluateAutomationPolicy } from "@/lib/automation/policy";
import { fetchCpsSlots, isCpsMetadata } from "@/lib/adapters/cps";
import { fetchForeupSlots, isForeupMetadata } from "@/lib/adapters/foreup";
import { fetchTeeItUpSlots, isTeeItUpMetadata } from "@/lib/adapters/teeitup";
import { fetchTeesnapSlots, isTeesnapMetadata } from "@/lib/adapters/teesnap";
import { sendSearchStatusEmail, sendTeeTimeAlert } from "@/lib/email/alerts";
import {
  buildSearchStatusSnapshot,
  getSearchStatusEmailKind,
  summarizeSearchStatusAvailability,
  type SearchStatusCourseReport
} from "@/lib/email/search-status";
import { summarizeCourseSlotPrices } from "@/lib/pricing/course-prices";
import {
  dedupeMatches,
  filterSlotsForSearch,
  parseCourseLocalDateTime,
  rankMatches
} from "@/lib/tee-times/matching";

const PROMPT_VERSION = "tee-time-spot-event-driven-check-v1";

type AutomationCourse = {
  id: string;
  name: string;
  timeZone: string;
  website: string | null;
  detectedBookingUrl: string | null;
  automationEligibility: "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
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
};

export type SearchCheckCourseResult = SearchStatusCourseReport;

export type SearchCheckResult = {
  searchId: string;
  outcome: "success" | "not_active" | "busy" | "failed";
  courseResults: SearchCheckCourseResult[];
  availableMatches: number;
  newlyAlertedMatches: number;
  statusEmailOutcome?: "sent" | "dry_run" | "skipped" | "failed";
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
        newlyAlertedMatches: 0
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
  const search = await getActiveSearchForAutomation(searchId);
  if (!search) {
    return {
      searchId,
      outcome: "not_active",
      courseResults: [],
      availableMatches: 0,
      newlyAlertedMatches: 0
    };
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
  let newlyAlertedMatches = 0;

  for (const preference of search.preferences) {
    const course = preference.course as AutomationCourse;
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
      courseResults.push({
        courseId: course.id,
        courseName: course.name,
        timeZone: course.timeZone,
        outcome: "BLOCKED_POLICY",
        availableMatches: 0,
        message: policy.reason,
        bookingUrl: course.detectedBookingUrl ?? course.website ?? undefined
      });
      continue;
    }

    if (!hasSupportedAdapter(course)) {
      const browserProbeUrl = getBestProbeUrl(course);
      const browserProbeQueued = shouldQueueBrowserProbe(course);
      const message = browserProbeQueued
        ? `No supported adapter yet for ${course.detectedPlatform}; queued for browser probe.`
        : `No supported adapter yet for ${course.detectedPlatform}`;
      await recordCourseProbe({
        searchId: search.id,
        courseId: course.id,
        automationRunId,
        outcome: "NEEDS_ADAPTER",
        message,
        rawSummary: {
          nextAction: browserProbeQueued ? "automation:browser-probe" : "manual_course_setup",
          browserProbeUrl
        }
      });
      courseResults.push({
        courseId: course.id,
        courseName: course.name,
        timeZone: course.timeZone,
        outcome: "NEEDS_ADAPTER",
        availableMatches: 0,
        message,
        bookingUrl: course.detectedBookingUrl ?? course.website ?? undefined
      });
      continue;
    }

    try {
      const rawSlots = await fetchCourseSlots(course, search.date, search.players);
      const availability = summarizeSearchStatusAvailability(searchWindow, rawSlots);
      const pricing = summarizeCourseSlotPrices(rawSlots);
      const currentMatches = rankMatches(
        searchWindow,
        dedupeMatches(filterSlotsForSearch(searchWindow, rawSlots), [])
      );
      const normalizedCurrentMatches = currentMatches.map((match) => ({
        match,
        startsAt: parseCourseLocalDateTime(match.startsAt, course.timeZone)
      }));

      for (const { match, startsAt } of normalizedCurrentMatches) {
        await recordTeeTimeMatch({
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
          ...(pricing ? { pricing } : {})
        }
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
        availability,
        matchingTimes: currentMatches.map((match) => ({
          startsAt: match.startsAt,
          availableSpots: match.availableSpots,
          priceCents: match.priceCents,
          holes: match.holes
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
      courseResults.push({
        courseId: course.id,
        courseName: course.name,
        timeZone: course.timeZone,
        outcome: "FETCH_FAILED",
        availableMatches: 0,
        message,
        bookingUrl: course.detectedBookingUrl ?? course.website ?? undefined
      });
    }
  }

  newlyAlertedMatches = await sendPendingMatchAlerts(searchId);

  let statusEmailOutcome: SearchCheckResult["statusEmailOutcome"] = "skipped";
  try {
    statusEmailOutcome = await deliverSearchStatusReport({
      search,
      searchWindow,
      courseResults,
      checkedAt: new Date()
    });
  } catch (error) {
    statusEmailOutcome = "failed";
    console.error("[email:status-failed]", {
      searchId: search.id,
      message: error instanceof Error ? error.message : "Unknown status email failure"
    });
  }

  return {
    searchId,
    outcome: "success",
    courseResults,
    availableMatches: courseResults.reduce((total, course) => total + course.availableMatches, 0),
    newlyAlertedMatches,
    statusEmailOutcome
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
  checkedAt: Date;
}): Promise<NonNullable<SearchCheckResult["statusEmailOutcome"]>> {
  const kind = getSearchStatusEmailKind(input.search.statusEmailSentAt, input.checkedAt);
  if (!kind) {
    return "skipped";
  }

  const snapshot = buildSearchStatusSnapshot(input.courseResults);
  const recipients = getAlertRecipients(
    input.search.user.email,
    input.search.additionalEmails
  );
  const periodKey =
    kind === "setup"
      ? "setup"
      : `daily-${input.search.statusEmailSentAt?.getTime() ?? "initial"}`;
  const deliveries = await Promise.all(
    recipients.map((recipient) =>
      sendSearchStatusEmail({
        searchId: input.search.id,
        to: recipient,
        kind,
        targetDate: input.searchWindow.date,
        startTime: input.searchWindow.startTime,
        endTime: input.searchWindow.endTime,
        players: input.searchWindow.players,
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

async function sendPendingMatchAlerts(searchId: string) {
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
          courseName: match.course.name,
          courseTimeZone: match.course.timeZone,
          startsAt: match.startsAt,
          availableSpots: match.availableSpots,
          bookingUrl: match.bookingUrl,
          priceCents: match.priceCents,
          holes: match.holes,
          isNew: pendingIds.has(match.id)
        })),
        userTimeZone: search.userTimeZone,
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
    (course.detectedPlatform === "CUSTOM" &&
      (isCpsMetadata(course.bookingMetadata) || isTeesnapMetadata(course.bookingMetadata)))
  );
}

function fetchCourseSlots(course: AutomationCourse, date: Date, players: number) {
  if (course.detectedPlatform === "FOREUP" && isForeupMetadata(course.bookingMetadata)) {
    return fetchForeupSlots({ courseId: course.id, date, players, metadata: course.bookingMetadata });
  }
  if (course.detectedPlatform === "TEEITUP" && isTeeItUpMetadata(course.bookingMetadata)) {
    return fetchTeeItUpSlots({ courseId: course.id, date, metadata: course.bookingMetadata });
  }
  if (course.detectedPlatform === "CUSTOM" && isCpsMetadata(course.bookingMetadata)) {
    return fetchCpsSlots({
      courseId: course.id,
      date,
      players,
      timeZone: course.timeZone,
      metadata: course.bookingMetadata
    });
  }
  if (course.detectedPlatform === "CUSTOM" && isTeesnapMetadata(course.bookingMetadata)) {
    return fetchTeesnapSlots({ courseId: course.id, date, players, metadata: course.bookingMetadata });
  }
  return Promise.resolve([]);
}
