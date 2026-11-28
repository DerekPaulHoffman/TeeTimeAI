import { readAlertGenerationStartedAt } from "@/lib/searches/generation-clock";
import { parseCourseLocalWindowEnd } from "@/lib/searches/window-end";

export const COURSE_SETUP_TARGET_MS = 15 * 60 * 1000;

export function getCourseSetupDeadline(
  search: Parameters<typeof readAlertGenerationStartedAt>[0] & {
    date: Date;
    endTime: string;
  },
  timeZone: string,
) {
  // Legacy rows without a generation marker cannot prove a newer start.
  const startedAt = readAlertGenerationStartedAt(search) ?? search.createdAt;
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
