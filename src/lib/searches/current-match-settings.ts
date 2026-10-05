import { getCourseLayoutCompatibility, normalizeRequestedLayoutHoles } from "@/lib/courses/course-layout";
import { filterSlotsForSearch } from "@/lib/tee-times/matching";
import { isValidTimeZone } from "@/lib/timezones";
import { MAX_COURSE_PREFERENCES, MAX_PLAYERS_PER_SEARCH } from "@/lib/validation/search-constraints";

export type CurrentMatchSearchSettings = {
  date: Date;
  startTime: string;
  endTime: string;
  players: number;
  requestedLayoutHoles?: number | null;
  preferences: Array<{ rank: number; course: { id: string }; offeringId?: string | null }>;
};

export type CurrentMatchSettings = {
  startsAt: Date;
  availableSpots: number;
  course: {
    id: string;
    timeZone: string;
    layoutHoleCounts: number[];
    layoutHolesVerifiedAt?: Date | null;
  };
};

export function matchesCurrentSearchSettings(
  search: CurrentMatchSearchSettings,
  match: CurrentMatchSettings,
) {
  if (!(search.date instanceof Date) || !Number.isFinite(search.date.getTime())
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(search.startTime)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(search.endTime)
    || search.endTime <= search.startTime
    || !Number.isInteger(search.players) || search.players < 1 || search.players > MAX_PLAYERS_PER_SEARCH
    || !Array.isArray(search.preferences)
    || search.preferences.length > MAX_COURSE_PREFERENCES
    || search.preferences.some(preference => typeof preference?.course?.id !== "string" || !preference.course.id
      || !Number.isInteger(preference.rank) || preference.rank < 1 || preference.rank > MAX_COURSE_PREFERENCES)
    || !(match.startsAt instanceof Date) || !Number.isFinite(match.startsAt.getTime())
    || !Number.isInteger(match.availableSpots) || match.availableSpots < 0
    || typeof match.course?.id !== "string" || !match.course.id || !isValidTimeZone(match.course.timeZone)
    || !Array.isArray(match.course.layoutHoleCounts)) {
    return false;
  }
  const date = search.date.toISOString().slice(0, 10);
  if (search.date.toISOString() !== `${date}T00:00:00.000Z`) {
    return false;
  }
  const requestedLayoutHoles = normalizeRequestedLayoutHoles(search.requestedLayoutHoles);
  if (search.requestedLayoutHoles != null && requestedLayoutHoles === null) {
    return false;
  }
  if (match.course.layoutHolesVerifiedAt
    && getCourseLayoutCompatibility(match.course.layoutHoleCounts, requestedLayoutHoles) === "incompatible") {
    return false;
  }

  // Persisted slots are absolute instants. Restore the provider's local clock
  // before reusing the same date/player/window matcher as a live course check.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: match.course.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(match.startsAt);
  const byType = new Map(parts.map(part => [part.type, part.value]));
  const localStartsAt = `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}T${byType.get("hour")}:${byType.get("minute")}`;
  return filterSlotsForSearch({
    date,
    startTime: search.startTime,
    endTime: search.endTime,
    players: search.players,
    preferredCourses: search.preferences.map(preference => ({
      courseId: preference.course.id, rank: preference.rank,
    })),
  }, [{ courseId: match.course.id, startsAt: localStartsAt, availableSpots: match.availableSpots }]).length === 1;
}
