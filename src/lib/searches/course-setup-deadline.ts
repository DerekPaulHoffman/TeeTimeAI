import { parseCourseLocalWindowEnd } from "@/lib/searches/window-end";

export const COURSE_SETUP_TARGET_MS = 15 * 60 * 1000;

type CourseSetupClock = { setupStartedAt?: Date | null; createdAt: Date };

export function readCourseSetupStartedAt(search: CourseSetupClock) {
  // Older rows cannot distinguish a change to availability criteria from an
  // alert-only edit. Creation is their earliest durable setup clock.
  return search.setupStartedAt ?? search.createdAt;
}

export function getCourseSetupDeadline(
  search: CourseSetupClock & { date: Date; endTime: string },
  timeZone: string,
) {
  const startedAt = readCourseSetupStartedAt(search);
  const setupDeadline = startedAt.getTime() + COURSE_SETUP_TARGET_MS;
  try {
    const windowEnd = parseCourseLocalWindowEnd(
      search.date.toISOString().slice(0, 10), search.endTime, timeZone,
    ).getTime();
    if (Number.isFinite(windowEnd)) {
      return new Date(Math.min(setupDeadline, windowEnd));
    }
  } catch {
    // Older rows with invalid window metadata still have a bounded setup time.
  }
  return new Date(setupDeadline);
}

export function hasReachedCourseSetupDeadline(deadline: Date | undefined, now: Date) {
  return Boolean(deadline && deadline <= now);
}
