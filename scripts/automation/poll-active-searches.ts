import "./load-local-env";

import {
  finishAutomationRun,
  listActiveSearchesForAutomation,
  listPendingMatchAlerts,
  markMatchAlertSuppressed,
  markMatchAlertSent,
  recordCourseProbe,
  recordTeeTimeMatch,
  runWithAutomationPollLease,
  startAutomationRun
} from "@/lib/automation/db-service";
import { getBestProbeUrl, shouldQueueBrowserProbe } from "@/lib/automation/browser-discovery";
import { evaluateAutomationPolicy } from "@/lib/automation/policy";
import { fetchCpsSlots, isCpsMetadata } from "@/lib/adapters/cps";
import { fetchForeupSlots, isForeupMetadata } from "@/lib/adapters/foreup";
import { fetchTeeItUpSlots, isTeeItUpMetadata } from "@/lib/adapters/teeitup";
import { sendTeeTimeAlert } from "@/lib/email/alerts";
import { dedupeMatches, filterSlotsForSearch, rankMatches } from "@/lib/tee-times/matching";

const PROMPT_VERSION = "tee-time-spot-local-codex-loop-v1";

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

type AutomationPreference = {
  rank: number;
  course: AutomationCourse;
};

type AutomationMatch = {
  sourceId: string;
  courseId: string;
  startsAt: Date;
};

type AutomationSearch = {
  id: string;
  date: Date;
  startTime: string;
  endTime: string;
  players: number;
  additionalEmails: string[];
  user: {
    email: string;
  };
  preferences: AutomationPreference[];
  matches: AutomationMatch[];
};

async function main() {
  const run = await startAutomationRun(PROMPT_VERSION);
  const notes: string[] = [];

  try {
    const lease = await runWithAutomationPollLease(async () => {
      const searches = (await listActiveSearchesForAutomation()) as AutomationSearch[];
      const drainedPendingAlerts = await sendPendingMatchAlerts();

      for (const search of searches) {
        const searchWindow = {
          date: search.date.toISOString().slice(0, 10),
          startTime: search.startTime,
          endTime: search.endTime,
          players: search.players,
          preferredCourses: search.preferences.map((preference: AutomationPreference) => ({
            courseId: preference.course.id,
            rank: preference.rank
          }))
        };

        for (const preference of search.preferences) {
          const course = preference.course;
          const policy = evaluateAutomationPolicy({
            automationEligibility: course.automationEligibility,
            termsText: course.policyNotes,
            intendedAction: "ALERT_ONLY"
          });

          if (!policy.allowed) {
            await recordCourseProbe({
              searchId: search.id,
              courseId: course.id,
              automationRunId: run.id,
              outcome: "BLOCKED_POLICY",
              message: policy.reason
            });
            continue;
          }

          if (!hasSupportedAdapter(course)) {
            const browserProbeUrl = getBestProbeUrl(course);
            const browserProbeQueued = shouldQueueBrowserProbe(course);
            await recordCourseProbe({
              searchId: search.id,
              courseId: course.id,
              automationRunId: run.id,
              outcome: "NEEDS_ADAPTER",
              message: browserProbeQueued
                ? `No supported adapter yet for ${course.detectedPlatform}; queued for browser probe.`
                : `No supported adapter yet for ${course.detectedPlatform}`,
              rawSummary: {
                nextAction: browserProbeQueued ? "automation:browser-probe" : "manual_course_setup",
                browserProbeUrl
              }
            });
            continue;
          }

          try {
            const rawSlots = await fetchCourseSlots(course, search.date, search.players);
            const matches = rankMatches(
              searchWindow,
              dedupeMatches(
                filterSlotsForSearch(searchWindow, rawSlots),
                search.matches.map((match: AutomationMatch) => ({
                  sourceId: match.sourceId,
                  courseId: match.courseId,
                  startsAt: match.startsAt.toISOString()
                }))
              )
            );

            if (matches.length === 0) {
              await recordCourseProbe({
                searchId: search.id,
                courseId: course.id,
                automationRunId: run.id,
                outcome: "NO_MATCH",
                message: "No new qualifying tee times in the requested window"
              });
              continue;
            }

            for (const match of matches) {
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

              await recordCourseProbe({
                searchId: search.id,
                courseId: course.id,
                automationRunId: run.id,
                outcome: "MATCH_FOUND",
                message: `Found ${match.startsAt}`,
                evidenceUrl: match.evidenceUrl
              });

              if (record.alertStatus !== "PENDING") {
                continue;
              }

              await deliverMatchAlert({
                id: record.id,
                recipients: getAlertRecipients(search.user.email, search.additionalEmails),
                courseName: course.name,
                startsAt: record.startsAt,
                availableSpots: record.availableSpots,
                bookingUrl: record.bookingUrl
              });
            }
          } catch (error) {
            await recordCourseProbe({
              searchId: search.id,
              courseId: course.id,
              automationRunId: run.id,
              outcome: "FETCH_FAILED",
              message: error instanceof Error ? error.message : "Unknown adapter error"
            });
          }
        }
      }

      return {
        searches: searches.length,
        drainedPendingAlerts
      };
    });

    if (!lease.acquired) {
      notes.push("Skipped because another automation poller holds the Postgres advisory lease.");
      await finishAutomationRun(run.id, { outcome: "no_op", notes: notes.join("\n") });
      return;
    }

    notes.push(`Processed ${lease.value.searches} active searches.`);
    if (lease.value.drainedPendingAlerts > 0) {
      notes.push(`Drained ${lease.value.drainedPendingAlerts} pending match alerts before polling.`);
    }
    await finishAutomationRun(run.id, { outcome: "success", notes: notes.join("\n") });
  } catch (error) {
    await finishAutomationRun(run.id, {
      outcome: "failed",
      errors:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { message: "Unknown polling failure" },
      notes: error instanceof Error ? error.stack ?? error.message : "Unknown polling failure"
    });
    throw error;
  }
}

async function sendPendingMatchAlerts() {
  const pendingMatches = await listPendingMatchAlerts();
  let sent = 0;

  for (const match of pendingMatches) {
    await deliverMatchAlert({
      id: match.id,
      recipients: getAlertRecipients(match.teeSearch.user.email, match.teeSearch.additionalEmails),
      courseName: match.course.name,
      startsAt: match.startsAt,
      availableSpots: match.availableSpots,
      bookingUrl: match.bookingUrl
    });
    sent += 1;
  }

  return sent;
}

async function deliverMatchAlert(input: {
  id: string;
  recipients: string[];
  courseName: string;
  startsAt: Date;
  availableSpots: number;
  bookingUrl: string;
}) {
  const deliveries = [];

  for (const recipient of input.recipients) {
    deliveries.push(
      await sendTeeTimeAlert({
        to: recipient,
        courseName: input.courseName,
        startsAt: input.startsAt,
        availableSpots: input.availableSpots,
        bookingUrl: input.bookingUrl,
        idempotencyKey: `tee-time-match-${input.id}-${recipient}`
      })
    );
  }

  if (deliveries.every((delivery) => delivery.deliveryStatus === "dry_run")) {
    await markMatchAlertSuppressed(input.id);
    return deliveries;
  }

  await markMatchAlertSent(input.id);
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
    return fetchForeupSlots({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata
    });
  }

  if (course.detectedPlatform === "TEEITUP" && isTeeItUpMetadata(course.bookingMetadata)) {
    return fetchTeeItUpSlots({
      courseId: course.id,
      date,
      metadata: course.bookingMetadata
    });
  }

  if (course.detectedPlatform === "CUSTOM" && isCpsMetadata(course.bookingMetadata)) {
    return fetchCpsSlots({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata
    });
  }

  return Promise.resolve([]);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
