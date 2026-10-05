import type { WebsiteTrafficClass } from "@prisma/client";

import {
  claimScheduledSearchCheck,
  completeExpiredSyntheticSearch,
  completeScheduledSearchCheck,
  failScheduledSearchCheck,
  getSearchScheduleTiming
} from "@/lib/automation/db-service";
import { shouldSleepTechnicalFinalSearch } from "@/lib/automation/course-monitoring";
import { runSearchCheck } from "@/lib/automation/search-check";
import {
  getBookingWindowForTargetDate,
  type CourseBookingWindowFields
} from "@/lib/courses/booking-window";
import {
  getObservedInventoryReleaseForTargetDate,
  type CourseObservedInventoryHorizonFields,
} from "@/lib/courses/inventory-horizon";
import { isSyntheticWebsiteTrafficClass } from "@/lib/engagement/traffic-class";
import { calculateSearchWindowEnd } from "@/lib/automation/date-boundary";
import { getSyntheticMultiCycleExpiresAt } from "@/lib/automation/synthetic-test-window";
import { getSimulatorBookingOpening } from "@/lib/simulators/booking-window";

export { SYNTHETIC_MULTI_CYCLE_LIFETIME_MS } from "@/lib/automation/synthetic-test-window";

const FAILED_CHECK_RETRY_MINUTES = 5;
const SUPPORT_DISCOVERY_RETRY_MINUTES = 15;

export async function executeScheduledSearchCheck(searchId: string, scheduleVersion: number) {
  const claimed = await claimScheduledSearchCheck(searchId, scheduleVersion);
  if (!claimed) {
    return { outcome: "stopped", nextCheckAt: null };
  }

  const timing = await getSearchScheduleTiming(searchId, scheduleVersion);
  if (!timing) {
    return { outcome: "stopped", nextCheckAt: null };
  }

  let checkStartedAt: Date | null = null;
  try {
    const now = new Date();
    const syntheticExpiresAt = getSyntheticMultiCycleExpiresAt(timing, now);
    if (syntheticExpiresAt && now >= syntheticExpiresAt) {
      const completed = await completeExpiredSyntheticSearch({
        searchId,
        scheduleVersion,
        leaseToken: claimed.token,
        outcome: "synthetic multi-cycle test lifetime ended"
      });
      return {
        outcome: completed ? "completed" : "stopped",
        nextCheckAt: null,
        availableMatches: 0,
        newlyAlertedMatches: 0,
        courseResults: []
      };
    }

    const searchExpiresAt = calculateSearchWindowEnd(
      timing.date,
      timing.endTime,
      timing.preferences.map((preference) => preference.course.timeZone),
      timing.userTimeZone
    );
    if (now >= searchExpiresAt) {
      await completeScheduledSearchCheck({
        searchId,
        scheduleVersion,
        leaseToken: claimed.token,
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

    checkStartedAt = new Date();
    const result = await runSearchCheck(searchId, "workflow", claimed);
    const schedulingNow = new Date();
    const refreshedTiming = await getSearchScheduleTiming(searchId, scheduleVersion);
    const completeSyntheticSearch =
      result.outcome === "success" &&
      isSyntheticWebsiteTrafficClass(timing.trafficClass) &&
      !timing.syntheticMultiCycle;
    const schedulingCourses =
      refreshedTiming?.preferences.map((preference) => preference.course) ??
      timing.preferences.map((preference) => preference.course);
    const simulator = timing.mode === "SIMULATOR";
    const nextCheckAt = completeSyntheticSearch
      ? null
      : simulator
      ? capAtSyntheticExpiration(calculateNextSimulatorCheckAt({
          date: timing.date, cadenceMinutes: timing.cadenceMinutes, now: schedulingNow,
          searchExpiresAt, preferences: (refreshedTiming ?? timing).preferences,
          supportRetryNeeded: result.supportRetryNeeded, supportRetryAt: result.supportRetryAt,
          checkStartedAt
        }), syntheticExpiresAt)
      : capAtSyntheticExpiration(
          capAtSearchEndpoint(
            calculateNextCheckAt(
              timing.date,
              timing.cadenceMinutes,
              schedulingNow,
              searchExpiresAt,
              schedulingCourses,
              result.supportRetryNeeded,
              checkStartedAt,
              {
                supportRetryAt: result.supportRetryAt,
                sleepUntilExpiration:
                  shouldSleepTechnicalFinalSearch(schedulingCourses)
              }
            ),
            schedulingCourses,
            timing.trafficClass,
            checkStartedAt,
            schedulingNow
          ),
          syntheticExpiresAt
        );
    const completion = await completeScheduledSearchCheck({
      searchId,
      scheduleVersion,
      leaseToken: claimed.token,
      outcome: completeSyntheticSearch
        ? `${summarizeCheckOutcome(result)}; synthetic one-check complete`
        : summarizeCheckOutcome(result),
      nextCheckAt,
      ...(completeSyntheticSearch ? { completeSearch: true } : {})
    });
    return {
      outcome: result.outcome,
      nextCheckAt: completion?.nextCheckAt?.toISOString() ?? null,
      availableMatches: result.availableMatches,
      newlyAlertedMatches: result.newlyAlertedMatches,
      courseResults: result.courseResults
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown search check failure";
    const failedAt = new Date();
    const defaultRetryAt = new Date(
      failedAt.getTime() + FAILED_CHECK_RETRY_MINUTES * 60 * 1000
    );
    const endpointWakeAt = timing.mode === "SIMULATOR" ? null : selectSearchEndpointWakeAt(
      timing.preferences.map((preference) => preference.course),
      timing.trafficClass,
      checkStartedAt ?? failedAt,
      failedAt
    );
    const retryAt =
      endpointWakeAt && endpointWakeAt < defaultRetryAt
        ? endpointWakeAt
        : defaultRetryAt;
    const nextCheckAt = capAtSyntheticExpiration(
      retryAt,
      getSyntheticMultiCycleExpiresAt(timing, failedAt)
    ) ?? retryAt;
    const failed = await failScheduledSearchCheck({
      searchId,
      scheduleVersion,
      leaseToken: claimed.token,
      message,
      nextCheckAt
    });
    if (failed.count !== 1) {
      return {
        outcome: "stopped",
        nextCheckAt: null,
        availableMatches: 0,
        newlyAlertedMatches: 0,
        courseResults: []
      };
    }
    const persistedNextCheckAt = failed.nextCheckAt ?? nextCheckAt;
    return {
      outcome: "failed",
      nextCheckAt: persistedNextCheckAt.toISOString(),
      availableMatches: 0,
      newlyAlertedMatches: 0,
      courseResults: []
    };
  }
}

/** Simulator release facts belong to its offering, never the venue's outdoor tee sheet. */
export function calculateNextSimulatorCheckAt(input: {
  date: Date; cadenceMinutes: number; now: Date; searchExpiresAt: Date; checkStartedAt: Date;
  preferences: Array<{ course: { timeZone: string }; offering?: Parameters<typeof getSimulatorBookingOpening>[1] | null }>;
  supportRetryNeeded?: boolean; supportRetryAt?: Date | null;
}) {
  if (input.now >= input.searchExpiresAt) return null;
  const openings = input.preferences.map(preference => preference.offering
    ? getSimulatorBookingOpening(input.date.toISOString().slice(0, 10), preference.offering, preference.course.timeZone)
    : null);
  if (openings.some(opening => opening && opening > input.checkStartedAt && opening <= input.now)) return input.now;
  const future = openings.filter((opening): opening is Date => Boolean(opening && opening > input.now));
  const ready = openings.length === 0 || openings.some(opening => !opening || opening <= input.now);
  const cadence = input.now.getTime() + input.cadenceMinutes * 60_000;
  const next = new Date(Math.min(input.searchExpiresAt.getTime(), ...future.map(opening => opening.getTime()), ...(ready ? [cadence] : [])));
  return applySupportDiscoveryRetry(next, Boolean(input.supportRetryNeeded), input.now, input.searchExpiresAt, input.checkStartedAt, input.supportRetryAt);
}

export function selectSearchEndpointWakeAt(
  courses: Array<{
    supportIncident?: {
      status: string;
      humanReviewReason: string | null;
      escalationDeadlineAt: Date | null;
    } | null;
  }>,
  trafficClass: WebsiteTrafficClass,
  checkStartedAt: Date,
  now = new Date()
) {
  if (isSyntheticWebsiteTrafficClass(trafficClass)) {
    return null;
  }
  const deadlines = courses.flatMap((course) => {
    const incident = course.supportIncident;
    return incident?.status === "AUTO_INVESTIGATING" &&
      !incident.humanReviewReason &&
      incident.escalationDeadlineAt
      ? [incident.escalationDeadlineAt]
      : [];
  });
  const deadline = deadlines
    .filter((candidate) => candidate > checkStartedAt)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return deadline && deadline <= now ? now : deadline ?? null;
}

function capAtSyntheticExpiration(
  nextCheckAt: Date | null,
  syntheticExpiresAt: Date | null
) {
  if (!nextCheckAt || !syntheticExpiresAt) {
    return nextCheckAt;
  }
  return nextCheckAt < syntheticExpiresAt ? nextCheckAt : syntheticExpiresAt;
}

function capAtSearchEndpoint(
  nextCheckAt: Date | null,
  courses: Parameters<typeof selectSearchEndpointWakeAt>[0],
  trafficClass: WebsiteTrafficClass,
  checkStartedAt: Date,
  now: Date
) {
  if (!nextCheckAt) {
    return null;
  }
  const endpointWakeAt = selectSearchEndpointWakeAt(
    courses,
    trafficClass,
    checkStartedAt,
    now
  );
  return endpointWakeAt && endpointWakeAt < nextCheckAt
    ? endpointWakeAt
    : nextCheckAt;
}

export function calculateNextCheckAt(
  date: Date,
  cadenceMinutes: number,
  now = new Date(),
  searchExpiresAt = endOfSearchDate(date),
  courses: Array<CourseBookingWindowFields & CourseObservedInventoryHorizonFields> = [],
  supportRetryNeeded = false,
  checkStartedAt = now,
  options?: {
    supportRetryAt?: Date | null;
    sleepUntilExpiration?: boolean;
  }
) {
  if (now >= searchExpiresAt) {
    return null;
  }
  if (options?.sleepUntilExpiration) {
    return searchExpiresAt;
  }

  const schedulingCourses = courses.length > 0 ? courses : [{ timeZone: "America/New_York" }];
  const sourceBackedBookingWindowOpenings = schedulingCourses.map((course) => {
    const publishedOpening =
      course.bookingWindowSource && course.bookingWindowEvidenceUrl?.trim()
        ? getBookingWindowForTargetDate(date, course)?.opensAt ?? null
        : null;
    const observedOpening = getObservedInventoryReleaseForTargetDate(date, course)?.opensAt ?? null;
    if (!publishedOpening) return observedOpening;
    if (!observedOpening) return publishedOpening;
    return publishedOpening > observedOpening ? publishedOpening : observedOpening;
  });
  const hasUnknownBookingWindow = sourceBackedBookingWindowOpenings.some(
    (opensAt) => opensAt === null
  );
  const bookingWindowOpenings = sourceBackedBookingWindowOpenings.filter(
    (opensAt): opensAt is Date => opensAt !== null
  );
  const nextBookingWindowOpening = Math.min(
    ...bookingWindowOpenings.filter((opensAt) => opensAt > now).map((opensAt) => opensAt.getTime())
  );
  const hasCourseReadyToCheck =
    hasUnknownBookingWindow || bookingWindowOpenings.some((opensAt) => opensAt <= now);
  const releaseCrossedDuringCheck = bookingWindowOpenings.some(
    (opensAt) => opensAt > checkStartedAt && opensAt <= now
  );
  if (releaseCrossedDuringCheck) {
    return now < searchExpiresAt ? now : searchExpiresAt;
  }
  if (!hasCourseReadyToCheck && Number.isFinite(nextBookingWindowOpening)) {
    return applySupportDiscoveryRetry(
      new Date(Math.min(nextBookingWindowOpening, searchExpiresAt.getTime())),
      supportRetryNeeded,
      now,
      searchExpiresAt,
      checkStartedAt,
      options?.supportRetryAt
    );
  }

  const cadenceWakeAt = now.getTime() + cadenceMinutes * 60 * 1000;
  const nextUsefulWakeAt = Number.isFinite(nextBookingWindowOpening)
    ? Math.min(cadenceWakeAt, nextBookingWindowOpening)
    : cadenceWakeAt;
  const next = new Date(nextUsefulWakeAt);
  return applySupportDiscoveryRetry(
    next < searchExpiresAt ? next : searchExpiresAt,
    supportRetryNeeded,
    now,
    searchExpiresAt,
    checkStartedAt,
    options?.supportRetryAt
  );
}

function applySupportDiscoveryRetry(
  normalNextCheckAt: Date,
  supportRetryNeeded: boolean,
  now: Date,
  searchExpiresAt: Date,
  checkStartedAt: Date,
  requestedRetryAt?: Date | null
) {
  if (!supportRetryNeeded) {
    return normalNextCheckAt;
  }
  const defaultRetryAt = now.getTime() + SUPPORT_DISCOVERY_RETRY_MINUTES * 60 * 1000;
  const supportRetryAt = new Date(
    Math.min(
      requestedRetryAt &&
      requestedRetryAt >= checkStartedAt &&
      requestedRetryAt <= now
        ? now.getTime()
        : requestedRetryAt && requestedRetryAt > now
          ? requestedRetryAt.getTime()
          : defaultRetryAt,
      searchExpiresAt.getTime()
    )
  );
  return supportRetryAt < normalNextCheckAt ? supportRetryAt : normalNextCheckAt;
}

export { calculateSearchWindowEnd } from "@/lib/automation/date-boundary";

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
