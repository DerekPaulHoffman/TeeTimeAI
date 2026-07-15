export type SearchPreference = {
  courseId: string;
  rank: number;
};

export type SearchWindow = {
  date: string;
  startTime: string;
  endTime: string;
  players: number;
  preferredCourses: SearchPreference[];
};

export type TeeTimeSlot = {
  sourceId: string;
  courseId: string;
  startsAt: string;
  availableSpots: number;
  bookingUrl: string;
  priceCents?: number;
  holes?: number;
  bookableHoleCounts?: Array<9 | 18>;
  priceOptions?: Array<{
    holes: 9 | 18;
    priceCents: number;
  }>;
  evidenceUrl?: string;
};

export type ExistingMatchKey = Pick<TeeTimeSlot, "sourceId" | "courseId"> & {
  startsAt?: string;
};

export function filterSlotsForSearch(search: SearchWindow, slots: TeeTimeSlot[]) {
  const preferredCourseIds = new Set(search.preferredCourses.map((preference) => preference.courseId));

  return slots.filter((slot) => {
    if (!preferredCourseIds.has(slot.courseId)) {
      return false;
    }

    if (slot.availableSpots < search.players) {
      return false;
    }

    const date = slot.startsAt.slice(0, 10);
    if (date !== search.date) {
      return false;
    }

    const localTime = slot.startsAt.slice(11, 16);
    return localTime >= search.startTime && localTime < search.endTime;
  });
}

export function dedupeMatches(slots: TeeTimeSlot[], existingMatches: ExistingMatchKey[]) {
  const observedKeys = new Set(existingMatches.map(matchKey));
  return slots.filter((slot) => {
    const key = matchKey(slot);
    if (observedKeys.has(key)) {
      return false;
    }

    observedKeys.add(key);
    return true;
  });
}

export function rankMatches(search: SearchWindow, slots: TeeTimeSlot[]) {
  const rankByCourse = new Map(
    search.preferredCourses.map((preference) => [preference.courseId, preference.rank])
  );

  return [...slots].sort((a, b) => {
    const rankA = rankByCourse.get(a.courseId) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rankByCourse.get(b.courseId) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.startsAt.localeCompare(b.startsAt);
  });
}

export function parseCourseLocalDateTime(
  value: string,
  timeZone = DEFAULT_TIME_ZONE
) {
  return zonedDateTimeToDate(value, timeZone);
}

function matchKey(match: ExistingMatchKey) {
  return `${match.courseId}:${match.sourceId}`;
}
import { DEFAULT_TIME_ZONE, zonedDateTimeToDate } from "@/lib/timezones";
