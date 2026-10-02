export type KnownTeeTime = {
  startsAt: string;
  availableSpots: number;
  holes: number | null;
  priceCents: number | null;
  bookingUrl: string;
  confirmedAt: string;
};

export type ObservedTeeTime = {
  startsAt: Date;
  availableSpots: number;
  holes: number | null;
  priceCents: number | null;
  bookingUrl: string;
  lastConfirmedAt: Date;
  lastSeenAt: Date;
  availabilityStatus: string;
};

// These are recent observations, never a promise that a time is still bookable.
export const KNOWN_TIME_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function selectKnownTeeTimes(
  matches: ObservedTeeTime[],
  timeZone: string,
  date: string,
  now = new Date()
): KnownTeeTime[] {
  const latest = new Map<string, ObservedTeeTime>();
  for (const match of matches) {
    const key = `${match.startsAt.toISOString()}|${match.holes ?? ""}`;
    const previous = latest.get(key);
    if (!previous || match.lastSeenAt > previous.lastSeenAt ||
      (match.lastSeenAt.getTime() === previous.lastSeenAt.getTime() && match.availabilityStatus !== "AVAILABLE")) {
      latest.set(key, match);
    }
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  });
  return [...latest.values()].filter((match) => {
    const age = now.getTime() - match.lastConfirmedAt.getTime();
    if (match.availabilityStatus !== "AVAILABLE" || match.startsAt <= now ||
      age < 0 || age > KNOWN_TIME_MAX_AGE_MS || match.availableSpots < 1) return false;
    try {
      const url = new URL(match.bookingUrl);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    } catch { return false; }
    const parts = formatter.formatToParts(match.startsAt);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    return `${value("year")}-${value("month")}-${value("day")}` === date;
  }).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map((match) => ({
    startsAt: match.startsAt.toISOString(), availableSpots: match.availableSpots,
    holes: match.holes, priceCents: match.priceCents, bookingUrl: match.bookingUrl,
    confirmedAt: match.lastConfirmedAt.toISOString()
  }));
}
