import { normalizeTimeZone, zonedDateTimeToDate } from "@/lib/timezones";

export const BOOKING_WINDOW_REFRESH_DAYS = 30;
export const BOOKING_WINDOW_RETRY_HOURS = 24;
export const MAX_BOOKING_WINDOW_DAYS_AHEAD = 90;

export type BookingWindowEvidenceSource =
  | "PROVIDER_CONFIG"
  | "PROVIDER_MESSAGE"
  | "OFFICIAL_BOOKING_PAGE";

export type BookingWindowEvidence = {
  daysAhead: number;
  releaseTimeLocal: string | null;
  source: BookingWindowEvidenceSource;
  confidence: number;
  evidenceUrl: string;
};

export type CourseBookingWindowFields = {
  timeZone?: string | null;
  bookingWindowDaysAhead?: number | null;
  bookingReleaseTimeLocal?: string | null;
  bookingWindowSource?: BookingWindowEvidenceSource | null;
  bookingWindowConfidence?: number | null;
  bookingWindowEvidenceUrl?: string | null;
  bookingWindowCheckedAt?: Date | null;
  bookingWindowObservedAt?: Date | null;
};

export type TargetBookingWindow = {
  releaseDate: string;
  releaseTimeLocal: string | null;
  opensAt: Date;
  timeZone: string;
  exactTime: boolean;
  source: BookingWindowEvidenceSource | null;
  confidence: number | null;
  evidenceUrl: string | null;
};

export function getBookingWindowForTargetDate(
  targetDate: Date | string,
  course: CourseBookingWindowFields,
  fallbackTimeZone = "America/New_York"
): TargetBookingWindow | null {
  const daysAhead = course.bookingWindowDaysAhead;
  if (
    !Number.isInteger(daysAhead) ||
    daysAhead == null ||
    daysAhead < 0 ||
    daysAhead > MAX_BOOKING_WINDOW_DAYS_AHEAD
  ) {
    return null;
  }

  const targetIsoDate = toIsoDate(targetDate);
  const releaseDate = addIsoDateDays(targetIsoDate, -daysAhead);
  const releaseTimeLocal = normalizeReleaseTime(course.bookingReleaseTimeLocal);
  const timeZone = normalizeTimeZone(course.timeZone, fallbackTimeZone);
  const opensAt = zonedDateTimeToDate(
    `${releaseDate}T${releaseTimeLocal ?? "00:00"}:00`,
    timeZone
  );

  return {
    releaseDate,
    releaseTimeLocal,
    opensAt,
    timeZone,
    exactTime: Boolean(releaseTimeLocal),
    source: course.bookingWindowSource ?? null,
    confidence: course.bookingWindowConfidence ?? null,
    evidenceUrl: course.bookingWindowEvidenceUrl ?? null
  };
}

export function getBookingWindowFromEvidence(
  targetDate: Date | string,
  timeZone: string,
  evidence: BookingWindowEvidence
) {
  return getBookingWindowForTargetDate(targetDate, {
    timeZone,
    bookingWindowDaysAhead: evidence.daysAhead,
    bookingReleaseTimeLocal: evidence.releaseTimeLocal,
    bookingWindowSource: evidence.source,
    bookingWindowConfidence: evidence.confidence,
    bookingWindowEvidenceUrl: evidence.evidenceUrl
  });
}

export function shouldRefreshBookingWindow(
  observedAt: Date | null | undefined,
  now = new Date()
) {
  if (!observedAt || Number.isNaN(observedAt.getTime())) {
    return true;
  }
  return now.getTime() - observedAt.getTime() >= BOOKING_WINDOW_REFRESH_DAYS * 24 * 60 * 60 * 1000;
}

export function shouldRetryBookingWindowDiscovery(
  checkedAt: Date | null | undefined,
  now = new Date()
) {
  if (!checkedAt || Number.isNaN(checkedAt.getTime())) {
    return true;
  }
  return now.getTime() - checkedAt.getTime() >= BOOKING_WINDOW_RETRY_HOURS * 60 * 60 * 1000;
}

export function parsePublicBookingWindowRule(
  value: string,
  evidenceUrl: string
): BookingWindowEvidence | null {
  const text = normalizeSourceText(value);
  const publicRule = text.match(
    /\bpublic\b[^.!?]{0,220}?\b(?:(?:can\s+)?book(?:\s+tee\s+times?)?|tee\s+time\s+reservations\s+can\s+be\s+made(?:\s+online)?)\s+(\d{1,2})\s+days?\s+in\s+advance\b([^.!?]{0,140})/i
  );
  const genericRule = !/\bpublic\b/i.test(text)
    ? text.match(
        /\b(?:(?:tee\s+times?\s+)?(?:can\s+be\s+)?book(?:ed)?|tee\s+time\s+reservations\s+can\s+be\s+made(?:\s+online)?)\s+(\d{1,2})\s+days?\s+in\s+advance\b([^.!?]{0,140})/i
      )
    : null;
  const ruleMatch = publicRule ?? genericRule;
  const daysAhead = Number(ruleMatch?.[1]);

  if (!Number.isInteger(daysAhead) || daysAhead < 0 || daysAhead > MAX_BOOKING_WINDOW_DAYS_AHEAD) {
    return null;
  }

  const timeMatch = (ruleMatch?.[2] ?? "").match(
    /\b(?:starting\s+|also\s+)?at\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i
  );

  return {
    daysAhead,
    releaseTimeLocal: normalizeReleaseTime(timeMatch?.[1] ?? null),
    source: "OFFICIAL_BOOKING_PAGE",
    confidence: publicRule ? 0.98 : 0.9,
    evidenceUrl
  };
}

export function parseBookingReleaseMessage(input: {
  message: string;
  targetDate: Date | string;
  timeZone: string;
  evidenceUrl: string;
}): BookingWindowEvidence | null {
  const match = normalizeSourceText(input.message).match(
    /available\s+to\s+book\s+from\s+(?:[a-z]+,\s+)?([a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))/i
  );
  if (!match) {
    return null;
  }

  const month = MONTHS.get(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  const releaseTimeLocal = normalizeReleaseTime(match[4]);
  if (month == null || !releaseTimeLocal) {
    return null;
  }

  const releaseDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const daysAhead = differenceInIsoCalendarDays(toIsoDate(input.targetDate), releaseDate);
  if (daysAhead < 0 || daysAhead > MAX_BOOKING_WINDOW_DAYS_AHEAD) {
    return null;
  }

  // Validate the provider's local wall-clock timestamp before persisting it.
  zonedDateTimeToDate(`${releaseDate}T${releaseTimeLocal}:00`, normalizeTimeZone(input.timeZone));

  return {
    daysAhead,
    releaseTimeLocal,
    source: "PROVIDER_MESSAGE",
    confidence: 1,
    evidenceUrl: input.evidenceUrl
  };
}

export function normalizeReleaseTime(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const match = value
    .trim()
    .replace(/\./g, "")
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) {
    return null;
  }
  if (meridiem === "am") {
    hour = hour === 12 ? 0 : hour;
  } else if (meridiem === "pm") {
    hour = hour === 12 ? 12 : hour + 12;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function formatBookingWindowRelease(window: TargetBookingWindow) {
  if (!window.exactTime) {
    return new Date(`${window.releaseDate}T12:00:00.000Z`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
  }

  return window.opensAt.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: window.timeZone,
    timeZoneName: "short"
  });
}

function normalizeSourceText(value: string) {
  return value
    .replace(/\\\//g, "/")
    .replace(/\\n|\\r|\\t/g, " ")
    .replace(/&#160;|&nbsp;|\u00a0/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDate(value: Date | string) {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function addIsoDateDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function differenceInIsoCalendarDays(later: string, earlier: string) {
  const [laterYear, laterMonth, laterDay] = later.split("-").map(Number);
  const [earlierYear, earlierMonth, earlierDay] = earlier.split("-").map(Number);
  return Math.round(
    (Date.UTC(laterYear, laterMonth - 1, laterDay) -
      Date.UTC(earlierYear, earlierMonth - 1, earlierDay)) /
      (24 * 60 * 60 * 1000)
  );
}

const MONTHS = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ].map((month, index) => [month, index + 1])
);
