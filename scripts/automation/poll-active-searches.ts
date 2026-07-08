import "./load-local-env";

import {
  finishAutomationRun,
  listActiveSearchesForAutomation,
  markMatchAlertSent,
  recordCourseProbe,
  recordTeeTimeMatch,
  runWithAutomationPollLease,
  startAutomationRun
} from "@/lib/automation/db-service";
import { evaluateAutomationPolicy } from "@/lib/automation/policy";
import { fetchForeupSlots, isForeupMetadata } from "@/lib/adapters/foreup";
import { sendTeeTimeAlert } from "@/lib/email/alerts";
import { dedupeMatches, filterSlotsForSearch, rankMatches } from "@/lib/tee-times/matching";

const PROMPT_VERSION = "tee-time-spot-local-codex-loop-v1";

type AutomationCourse = {
  id: string;
  name: string;
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

          if (course.detectedPlatform !== "FOREUP" || !isForeupMetadata(course.bookingMetadata)) {
            await recordCourseProbe({
              searchId: search.id,
              courseId: course.id,
              automationRunId: run.id,
              outcome: "NEEDS_ADAPTER",
              message: `No supported adapter yet for ${course.detectedPlatform}`
            });
            continue;
          }

          try {
            const rawSlots = await fetchForeupSlots({
              courseId: course.id,
              date: search.date,
              players: search.players,
              metadata: course.bookingMetadata
            });
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

              await sendTeeTimeAlert({
                to: search.user.email,
                courseName: course.name,
                startsAt: record.startsAt,
                availableSpots: record.availableSpots,
                bookingUrl: record.bookingUrl,
                idempotencyKey: `tee-time-match-${record.id}`
              });
              await markMatchAlertSent(record.id);
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

      return searches.length;
    });

    if (!lease.acquired) {
      notes.push("Skipped because another automation poller holds the Postgres advisory lease.");
      await finishAutomationRun(run.id, { outcome: "no_op", notes: notes.join("\n") });
      return;
    }

    notes.push(`Processed ${lease.value} active searches.`);
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

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
