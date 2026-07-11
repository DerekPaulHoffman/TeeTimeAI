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
  const existingKeys = new Set(existingMatches.map(matchKey));
  return slots.filter((slot) => !existingKeys.has(matchKey(slot)));
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
  timeZone = "America/New_York"
) {
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
    return new Date(value);
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) {
    return new Date(value);
  }

  const [, year, month, day, hour, minute, second = "0"] = match;
  const utcGuess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  const zonedParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(utcGuess));
  const byType = new Map(zonedParts.map((part) => [part.type, part.value]));
  const zonedGuess = Date.UTC(
    Number(byType.get("year")),
    Number(byType.get("month")) - 1,
    Number(byType.get("day")),
    Number(byType.get("hour")),
    Number(byType.get("minute")),
    Number(byType.get("second"))
  );

  return new Date(utcGuess - (zonedGuess - utcGuess));
}

function matchKey(match: ExistingMatchKey) {
  return `${match.courseId}:${match.sourceId}`;
}
