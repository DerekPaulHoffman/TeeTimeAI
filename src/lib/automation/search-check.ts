import {
  finishAutomationRun,
  getActiveSearchForAutomation,
  listPendingMatchAlerts,
  markMatchAlertSent,
  markMatchAlertSuppressed,
  markMissingMatchesUnavailable,
  recordCourseProbe,
  recordTeeTimeMatch,
  runWithSearchCheckLease,
  startAutomationRun
} from "@/lib/automation/db-service";
import { getBestProbeUrl, shouldQueueBrowserProbe } from "@/lib/automation/browser-discovery";
import { evaluateAutomationPolicy } from "@/lib/automation/policy";
import { fetchCpsSlots, isCpsMetadata } from "@/lib/adapters/cps";
import { fetchForeupSlots, isForeupMetadata } from "@/lib/adapters/foreup";
import { fetchTeeItUpSlots, isTeeItUpMetadata } from "@/lib/adapters/teeitup";
import { sendTeeTimeAlert } from "@/lib/email/alerts";
import { dedupeMatches, filterSlotsForSearch, rankMatches } from "@/lib/tee-times/matching";

const PROMPT_VERSION = "tee-time-spot-event-driven-check-v1";

type AutomationCourse = {
  id: string;
  name: string;
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

export type SearchCheckCourseResult = {
  courseId: string;
  courseName: string;
  outcome:
    | "MATCH_FOUND"
    | "NO_MATCH"
    | "BLOCKED_POLICY"
    | "NEEDS_ADAPTER"
    | "FETCH_FAILED";
  availableMatches: number;
  message?: string;
};

export type SearchCheckResult = {
  searchId: string;
  outcome: "success" | "not_active" | "busy" | "failed";
  courseResults: SearchCheckCourseResult[];
  availableMatches: number;
  newlyAlertedMatches: number;
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

  await sendPendingMatchAlerts(searchId);

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
      await recordCourseProbe({
        searchId: search.id,
        courseId: course.id,
        automationRunId,
        outcome: "BLOCKED_POLICY",
        message: policy.reason
      });
      courseResults.push({
        courseId: course.id,
        courseName: course.name,
        outcome: "BLOCKED_POLICY",
        availableMatches: 0,
        message: policy.reason
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
        outcome: "NEEDS_ADAPTER",
        availableMatches: 0,
        message
      });
      continue;
    }

    try {
      const rawSlots = await fetchCourseSlots(course, search.date, search.players);
      const currentMatches = rankMatches(
        searchWindow,
        dedupeMatches(filterSlotsForSearch(searchWindow, rawSlots), [])
      );

      for (const match of currentMatches) {
        const record = await recordTeeTimeMatch({
          searchId: search.id,
          courseId: course.id,
          sourceId: match.sourceId,
          startsAt: new Date(match.startsAt),
          availableSpots: match.availableSpots,
          bookingUrl: match.bookingUrl,
          priceCents: match.priceCents,
          holes: match.holes,
          evidenceUrl: match.evidenceUrl
        });

        if (record.alertStatus === "PENDING") {
          await deliverMatchAlert({
            id: record.id,
            recipients: getAlertRecipients(search.user.email, search.additionalEmails),
            courseName: course.name,
            startsAt: record.startsAt,
            availableSpots: record.availableSpots,
            bookingUrl: record.bookingUrl
          });
          newlyAlertedMatches += 1;
        }
      }

      await markMissingMatchesUnavailable({
        searchId: search.id,
        courseId: course.id,
        date: search.date,
        confirmedSourceIds: [...new Set(currentMatches.map((match) => match.sourceId))]
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
            : "No qualifying tee times in the requested window"
      });
      courseResults.push({
        courseId: course.id,
        courseName: course.name,
        outcome,
        availableMatches: currentMatches.length
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
        outcome: "FETCH_FAILED",
        availableMatches: 0,
        message
      });
    }
  }

  return {
    searchId,
    outcome: "success",
    courseResults,
    availableMatches: courseResults.reduce((total, course) => total + course.availableMatches, 0),
    newlyAlertedMatches
  };
}

async function sendPendingMatchAlerts(searchId: string) {
  const pendingMatches = await listPendingMatchAlerts(searchId);
  for (const match of pendingMatches) {
    await deliverMatchAlert({
      id: match.id,
      recipients: getAlertRecipients(match.teeSearch.user.email, match.teeSearch.additionalEmails),
      courseName: match.course.name,
      startsAt: match.startsAt,
      availableSpots: match.availableSpots,
      bookingUrl: match.bookingUrl
    });
  }
}

async function deliverMatchAlert(input: {
  id: string;
  recipients: string[];
  courseName: string;
  startsAt: Date;
  availableSpots: number;
  bookingUrl: string;
}) {
  const deliveries = await Promise.all(
    input.recipients.map((recipient) =>
      sendTeeTimeAlert({
        to: recipient,
        courseName: input.courseName,
        startsAt: input.startsAt,
        availableSpots: input.availableSpots,
        bookingUrl: input.bookingUrl,
        idempotencyKey: `tee-time-match-${input.id}-${recipient}`
      })
    )
  );

  if (deliveries.every((delivery) => delivery.deliveryStatus === "dry_run")) {
    await markMatchAlertSuppressed(input.id);
  } else {
    await markMatchAlertSent(input.id);
  }

  return deliveries;
}

function getAlertRecipients(primaryEmail: string, additionalEmails: string[] = []) {
  return [...new Set([primaryEmail, ...additionalEmails].map((email) => email.trim().toLowerCase()))];
}

function hasSupportedAdapter(course: AutomationCourse) {
  return (
    (course.detectedPlatform === "FOREUP" && isForeupMetadata(course.bookingMetadata)) ||
    (course.detectedPlatform === "TEEITUP" && isTeeItUpMetadata(course.bookingMetadata)) ||
    (course.detectedPlatform === "CUSTOM" && isCpsMetadata(course.bookingMetadata))
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
    return fetchCpsSlots({ courseId: course.id, date, players, metadata: course.bookingMetadata });
  }
  return Promise.resolve([]);
}
