import {
  claimScheduledSearchCheck,
  completeScheduledSearchCheck,
  failScheduledSearchCheck,
  getSearchScheduleTiming
} from "@/lib/automation/db-service";
import { runSearchCheck } from "@/lib/automation/search-check";
import { normalizeTimeZone, zonedDateTimeToDate } from "@/lib/timezones";

const BOOKING_WINDOW_LEAD_DAYS = 14;
const FAILED_CHECK_RETRY_MINUTES = 5;

export async function executeScheduledSearchCheck(searchId: string, scheduleVersion: number) {
  const claimed = await claimScheduledSearchCheck(searchId, scheduleVersion);
  if (!claimed) {
    return { outcome: "stopped", nextCheckAt: null };
  }

  const timing = await getSearchScheduleTiming(searchId, scheduleVersion);
  if (!timing) {
    return { outcome: "stopped", nextCheckAt: null };
  }

  try {
    const searchExpiresAt = calculateSearchWindowEnd(
      timing.date,
      timing.endTime,
      timing.preferences.map((preference) => preference.course.timeZone),
      timing.userTimeZone
    );
    if (new Date() >= searchExpiresAt) {
      await completeScheduledSearchCheck({
        searchId,
        scheduleVersion,
        outcome: "search window ended",
        nextCheckAt: null,
        completeSearch: true
      });
      return {
        outcome: "completed",
        nextCheckAt: null,
        availableMatches: 0,
        newlyAlertedMatches: 0,
        courseResults: []
      };
    }

    const result = await runSearchCheck(searchId, "workflow");
    const nextCheckAt = calculateNextCheckAt(
      timing.date,
      timing.cadenceMinutes,
      new Date(),
      searchExpiresAt
    );
    await completeScheduledSearchCheck({
      searchId,
      scheduleVersion,
      outcome: summarizeCheckOutcome(result),
      nextCheckAt
    });
    return {
      outcome: result.outcome,
      nextCheckAt: nextCheckAt?.toISOString() ?? null,
      availableMatches: result.availableMatches,
      newlyAlertedMatches: result.newlyAlertedMatches,
      courseResults: result.courseResults
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown search check failure";
    const nextCheckAt = new Date(Date.now() + FAILED_CHECK_RETRY_MINUTES * 60 * 1000);
    await failScheduledSearchCheck({ searchId, scheduleVersion, message, nextCheckAt });
    return {
      outcome: "failed",
      nextCheckAt: nextCheckAt.toISOString(),
      availableMatches: 0,
      newlyAlertedMatches: 0,
      courseResults: []
    };
  }
}

export function calculateNextCheckAt(
  date: Date,
  cadenceMinutes: number,
  now = new Date(),
  searchExpiresAt = endOfSearchDate(date)
) {
  if (now >= searchExpiresAt) {
    return null;
  }

  const bookingWindowOpensAt = new Date(date);
  bookingWindowOpensAt.setDate(bookingWindowOpensAt.getDate() - BOOKING_WINDOW_LEAD_DAYS);
  if (now < bookingWindowOpensAt) {
    return bookingWindowOpensAt;
  }

  const next = new Date(now.getTime() + cadenceMinutes * 60 * 1000);
  return next < searchExpiresAt ? next : searchExpiresAt;
}

export function calculateSearchWindowEnd(
  date: Date,
  endTime: string,
  courseTimeZones: string[],
  fallbackTimeZone: string
) {
  const dateValue = date.toISOString().slice(0, 10);
  const timeZones = courseTimeZones.length > 0 ? courseTimeZones : [fallbackTimeZone];
  return new Date(
    Math.max(
      ...timeZones.map((timeZone) =>
        zonedDateTimeToDate(
          `${dateValue}T${endTime}:00`,
          normalizeTimeZone(timeZone, fallbackTimeZone)
        ).getTime()
      )
    )
  );
}

function endOfSearchDate(date: Date) {
  const searchExpiresAt = new Date(date);
  searchExpiresAt.setDate(searchExpiresAt.getDate() + 1);
  return searchExpiresAt;
}

function summarizeCheckOutcome(result: Awaited<ReturnType<typeof runSearchCheck>>) {
  if (result.outcome !== "success") {
    return result.outcome;
  }

  const failedCourses = result.courseResults.filter((course) => course.outcome === "FETCH_FAILED");
  return JSON.stringify({
    availableMatches: result.availableMatches,
    newlyAlertedMatches: result.newlyAlertedMatches,
    failedCourses: failedCourses.map((course) => course.courseName)
  });
}
