import {
  claimScheduledSearchCheck,
  completeScheduledSearchCheck,
  failScheduledSearchCheck,
  getSearchScheduleTiming
} from "@/lib/automation/db-service";
import { runSearchCheck } from "@/lib/automation/search-check";
import {
  getBookingWindowForTargetDate,
  type CourseBookingWindowFields
} from "@/lib/courses/booking-window";
import { normalizeTimeZone, zonedDateTimeToDate } from "@/lib/timezones";

const FALLBACK_BOOKING_WINDOW_LEAD_DAYS = 14;
const FAILED_CHECK_RETRY_MINUTES = 5;
const SUPPORT_DISCOVERY_RETRY_MINUTES = 30;

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
    const refreshedTiming = await getSearchScheduleTiming(searchId, scheduleVersion);
    const nextCheckAt = calculateNextCheckAt(
      timing.date,
      timing.cadenceMinutes,
      new Date(),
      searchExpiresAt,
      refreshedTiming?.preferences.map((preference) => preference.course) ??
        timing.preferences.map((preference) => preference.course),
      result.supportRetryNeeded
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
  searchExpiresAt = endOfSearchDate(date),
  courses: CourseBookingWindowFields[] = [],
  supportRetryNeeded = false
) {
  if (now >= searchExpiresAt) {
    return null;
  }

  const schedulingCourses = courses.length > 0 ? courses : [{ timeZone: "America/New_York" }];
  const bookingWindowOpenings = schedulingCourses.map((course) => {
    const learnedWindow = getBookingWindowForTargetDate(date, course);
    if (learnedWindow) {
      return learnedWindow.opensAt;
    }
    return getBookingWindowForTargetDate(date, {
      timeZone: course.timeZone,
      bookingWindowDaysAhead: FALLBACK_BOOKING_WINDOW_LEAD_DAYS
    })!.opensAt;
  });
  const nextBookingWindowOpening = Math.min(
    ...bookingWindowOpenings
      .filter((opensAt) => opensAt > now)
      .map((opensAt) => opensAt.getTime())
  );
  const hasCourseReadyToCheck = bookingWindowOpenings.some((opensAt) => opensAt <= now);
  if (!hasCourseReadyToCheck && Number.isFinite(nextBookingWindowOpening)) {
    return applySupportDiscoveryRetry(
      new Date(Math.min(nextBookingWindowOpening, searchExpiresAt.getTime())),
      supportRetryNeeded,
      now,
      searchExpiresAt
    );
  }

  const next = new Date(now.getTime() + cadenceMinutes * 60 * 1000);
  return applySupportDiscoveryRetry(
    next < searchExpiresAt ? next : searchExpiresAt,
    supportRetryNeeded,
    now,
    searchExpiresAt
  );
}

function applySupportDiscoveryRetry(
  normalNextCheckAt: Date,
  supportRetryNeeded: boolean,
  now: Date,
  searchExpiresAt: Date
) {
  if (!supportRetryNeeded) {
    return normalNextCheckAt;
  }
  const supportRetryAt = new Date(
    Math.min(
      now.getTime() + SUPPORT_DISCOVERY_RETRY_MINUTES * 60 * 1000,
      searchExpiresAt.getTime()
    )
  );
  return supportRetryAt < normalNextCheckAt ? supportRetryAt : normalNextCheckAt;
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
