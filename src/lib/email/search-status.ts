import type { BookingMethod } from "@/lib/courses/intelligence";
import {
  renderCustomerEmail,
  type CustomerEmailMonitoringCourse
} from "@/lib/email/customer-email";
import type { EmailStopUrls } from "@/lib/email/search-actions";
import {
  DEFAULT_TIME_ZONE,
  normalizeTimeZone,
  zonedDateTimeToDate
} from "@/lib/timezones";

export type SearchStatusEmailKind = "setup" | "daily";

export type SearchStatusAvailability = {
  visibleSlotCount: number;
  playerEligibleSlotCount: number;
  closestBefore?: string;
  closestAfter?: string;
};

export type SearchStatusCourseReport = {
  courseId: string;
  courseName: string;
  rank?: number;
  courseAddress?: string;
  timeZone?: string;
  outcome: "MATCH_FOUND" | "NO_MATCH" | "BLOCKED_POLICY" | "NEEDS_ADAPTER" | "FETCH_FAILED";
  availableMatches: number;
  message?: string;
  bookingUrl?: string;
  phone?: string;
  bookingMethod?: BookingMethod;
  supportStatus?: "TEAM_ALERTED" | "PENDING_ALERT";
  bookingAccess?:
    | "BOOKING_PAGE"
    | "OFFICIAL_SITE"
    | "PHONE_ONLY"
    | "CONTACT_COURSE"
    | "WALK_IN";
  availability?: SearchStatusAvailability;
  bookingWindow?: {
    releaseDate: string;
    releaseTimeLocal?: string;
    opensAt: string;
    timeZone: string;
    exactTime: boolean;
  };
  matchingTimes?: Array<{
    startsAt: string;
    availableSpots: number;
    priceCents?: number;
    holes?: number;
    bookableHoleCounts?: Array<9 | 18>;
    isNew?: boolean;
  }>;
};

export type SearchStatusSnapshot = Array<{
  courseId: string;
  courseName: string;
  state: string;
}>;

export type SearchStatusEmailInput = {
  searchId: string;
  to: string;
  kind: SearchStatusEmailKind;
  targetDate: string;
  startTime: string;
  endTime: string;
  players: number;
  requestedLayoutHoles?: 9 | 18 | null;
  userTimeZone?: string;
  checkedAt: Date;
  courses: SearchStatusCourseReport[];
  previousSnapshot?: unknown;
  idempotencyKey?: string;
  stopUrls?: EmailStopUrls;
  assetBaseUrl?: string;
};

export const MORNING_STATUS_EMAIL_HOUR = 8;

export function summarizeSearchStatusAvailability(
  search: {
    date: string;
    startTime: string;
    endTime: string;
    players: number;
  },
  slots: Array<{ startsAt: string; availableSpots: number }>
): SearchStatusAvailability {
  const dateSlots = slots.filter((slot) => slot.startsAt.slice(0, 10) === search.date);
  const eligibleSlots = dateSlots
    .filter((slot) => slot.availableSpots >= search.players)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const before = eligibleSlots
    .filter((slot) => slot.startsAt.slice(11, 16) < search.startTime)
    .at(-1);
  const after = eligibleSlots.find(
    (slot) => slot.startsAt.slice(11, 16) >= search.endTime
  );

  return {
    visibleSlotCount: dateSlots.length,
    playerEligibleSlotCount: eligibleSlots.length,
    closestBefore: before?.startsAt,
    closestAfter: after?.startsAt
  };
}

export function getSearchStatusEmailKind(
  lastSentAt: Date | null,
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE
): SearchStatusEmailKind | null {
  if (!lastSentAt) {
    return "setup";
  }

  const normalizedTimeZone = normalizeTimeZone(timeZone, DEFAULT_TIME_ZONE);
  const currentLocalTime = getLocalDateAndHour(now, normalizedTimeZone);
  const lastSentLocalTime = getLocalDateAndHour(lastSentAt, normalizedTimeZone);

  if (
    currentLocalTime.date <= lastSentLocalTime.date ||
    currentLocalTime.hour < MORNING_STATUS_EMAIL_HOUR
  ) {
    return null;
  }

  return "daily";
}

export function buildSearchStatusSnapshot(
  courses: SearchStatusCourseReport[]
): SearchStatusSnapshot {
  return courses.map((course) => ({
    courseId: course.courseId,
    courseName: course.courseName,
    state: getCourseState(course)
  }));
}

export function getChangedCourseNames(
  current: SearchStatusSnapshot,
  previous: unknown
) {
  const previousSnapshot = parseSearchStatusSnapshot(previous);
  if (!previousSnapshot) {
    return current.map((course) => course.courseName);
  }

  const previousStateByCourse = new Map(
    previousSnapshot.map((course) => [course.courseId, course.state])
  );
  return current
    .filter((course) => previousStateByCourse.get(course.courseId) !== course.state)
    .map((course) => course.courseName);
}

export function renderSearchStatusHtml(input: SearchStatusEmailInput) {
  const currentSnapshot = buildSearchStatusSnapshot(input.courses);
  const changedCourses = getChangedCourseNames(currentSnapshot, input.previousSnapshot);
  const hasAvailability = input.courses.some(
    (course) => (course.matchingTimes?.length ?? 0) > 0
  );
  const hasDirectOnlyCourse = input.courses.some(
    (course) => course.outcome === "BLOCKED_POLICY"
  );
  const hasWorkInProgressCourse = input.courses.some(
    (course) => course.outcome === "NEEDS_ADAPTER"
  );
  const heading = input.kind === "setup"
    ? "Your tee-time alert is active"
    : "Your morning tee-time update";
  const intro = hasAvailability
    ? "We found tee times matching your search. Book what's available now — we'll keep watching and alert you the moment one of your priorities opens up."
    : input.kind === "setup"
      ? hasDirectOnlyCourse
        ? "Your alert is set. We'll keep checking supported courses; courses marked for direct booking are not automatically monitored."
        : hasWorkInProgressCourse
          ? "Your alert is set. We checked every selected course. Use the official link where monitoring is still being added."
          : "Your alert is set. We checked every selected course and will keep watching automatically."
      : changedCourses.length > 0
        ? `Changed since your last email: ${changedCourses.join(", ")}.`
        : hasDirectOnlyCourse
          ? "No course status changed since your last email. We're still checking supported courses."
          : "No course status changed since your last email. We're still checking.";
  const availabilityCourses = input.courses
    .map((course, index) => ({ course, fallbackRank: index + 1 }))
    .filter(({ course }) => (course.matchingTimes?.length ?? 0) > 0)
    .map(({ course, fallbackRank }) => ({
      courseId: course.courseId,
      courseName: course.courseName,
      rank: course.rank ?? fallbackRank,
      courseAddress: course.courseAddress,
      courseTimeZone: course.timeZone,
      bookingUrl: course.bookingUrl,
      times: course.matchingTimes ?? []
    }));
  const availabilityCourseIds = new Set(
    availabilityCourses.map((course) => course.courseId)
  );
  const monitoringCourses = input.courses
    .map((course, index) => ({ course, fallbackRank: index + 1 }))
    .filter(({ course }) => !availabilityCourseIds.has(course.courseId))
    .map(({ course, fallbackRank }) =>
      toMonitoringCourse(course, input.players, course.rank ?? fallbackRank)
    );

  return renderCustomerEmail({
    variant: input.kind === "setup" ? "setup" : "morning",
    heading,
    intro,
    preheader: input.kind === "setup"
      ? "Your Tee Time Spot alert is active."
      : "Your morning Tee Time Spot search update is ready.",
    summary: {
      targetDate: input.targetDate,
      startTime: input.startTime,
      endTime: input.endTime,
      players: input.players,
      requestedLayoutHoles: input.requestedLayoutHoles
    },
    availabilityCourses,
    monitoringCourses,
    checkedAt: input.checkedAt,
    userTimeZone: input.userTimeZone,
    stopUrls: input.stopUrls,
    assetBaseUrl: input.assetBaseUrl
  });
}

function toMonitoringCourse(
  course: SearchStatusCourseReport,
  players: number,
  rank: number
): CustomerEmailMonitoringCourse {
  const description = describeCourse(course, players);
  const bookingAccess = getBookingAccess(course);
  const presentation = course.outcome === "MATCH_FOUND"
    ? {
        badgeLabel: "FULLY MONITORED",
        tone: "monitored" as const,
        detail: `We're checking this course automatically. ${description.detail}`
      }
    : course.outcome === "NO_MATCH" && course.bookingWindow
      ? {
          badgeLabel: "SCHEDULED",
          tone: "scheduled" as const,
          detail: `${description.stateLabel}. ${description.detail}`
        }
      : course.outcome === "NO_MATCH"
        ? {
            badgeLabel: "FULLY MONITORED",
            tone: "monitored" as const,
            detail: `${description.stateLabel}. ${description.detail}`
          }
        : course.outcome === "NEEDS_ADAPTER"
          ? {
              badgeLabel: "ADDING MONITORING",
              tone: "adding" as const,
              detail: `${description.stateLabel}. ${description.detail}`
            }
          : course.outcome === "FETCH_FAILED"
            ? {
                badgeLabel: "CHECK RETRYING",
                tone: "retrying" as const,
                detail: `${description.stateLabel}. ${description.detail}`
              }
            : {
                badgeLabel: description.monitoringLabel.toUpperCase(),
                tone: "direct" as const,
                detail: `${description.stateLabel}. ${description.detail}`
              };
  const bookingLinkLabel = bookingAccess === "BOOKING_PAGE"
    ? "Open official booking page"
    : "Open official site";

  return {
    courseName: course.courseName,
    rank,
    courseAddress: course.courseAddress,
    badgeLabel: presentation.badgeLabel,
    detail: presentation.detail,
    tone: presentation.tone,
    bookingUrl: course.bookingUrl,
    bookingLinkLabel,
    phone: course.phone
  };
}

function getLocalDateAndHour(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year") ?? "0000";
  const month = values.get("month") ?? "00";
  const day = values.get("day") ?? "00";
  const hour = Number(values.get("hour") ?? "0");

  return {
    date: `${year}-${month}-${day}`,
    hour: hour === 24 ? 0 : hour
  };
}

function describeCourse(course: SearchStatusCourseReport, players: number) {
  if (course.outcome === "MATCH_FOUND") {
    return {
      monitoringLabel: "Fully monitored ✓",
      stateLabel: "Matching time visible",
      icon: "✓",
      color: "#147a52",
      badgeBackground: "#e8f4ec",
      borderColor: "#b8ddc8",
      calloutBackground: "#eef8f1",
      calloutBorder: "#c6e5d2",
      calloutText: "#285c43",
      detail: `${course.availableMatches} tee time${course.availableMatches === 1 ? " matches" : "s match"} your search right now.`
    };
  }

  if (course.outcome === "NO_MATCH" && course.bookingWindow) {
    const release = formatBookingWindowRelease(course.bookingWindow);
    return {
      monitoringLabel: "Scheduled",
      stateLabel: course.bookingWindow.exactTime
        ? `Booking opens ${release}`
        : `Booking expected to open ${release}`,
      icon: "◷",
      color: "#17647a",
      badgeBackground: "#e6f3f7",
      borderColor: "#b8dbe5",
      calloutBackground: "#eef8fb",
      calloutBorder: "#c5e2ea",
      calloutText: "#174152",
      detail: course.bookingWindow.exactTime
        ? "The course has not released tee times for your date yet. We’ll start checking at that time and email you when a matching spot appears."
        : "The course has not published an exact release time. We’ll begin checking that day and email you when a matching spot appears."
    };
  }

  if (course.outcome === "NEEDS_ADAPTER") {
    return {
      monitoringLabel: "Official site",
      stateLabel: "Check this course directly for now",
      icon: "↗",
      color: "#c75c0a",
      badgeBackground: "#fff0e4",
      borderColor: "#f1c79e",
      calloutBackground: "#fff8f2",
      calloutBorder: "#f3cfad",
      calloutText: "#713706",
      detail: course.bookingUrl
        ? "We checked this course’s official booking surface. Live availability is not currently available inside Tee Time Spot, so use the official link while we keep working to add monitoring."
        : course.phone
          ? "We checked this course’s public booking information. Call the course directly while we keep working to add monitoring."
          : "We checked the public course information, but no direct availability source was available."
    };
  }

  if (course.outcome === "FETCH_FAILED") {
    return {
      monitoringLabel: "Official site · retry scheduled",
      stateLabel: "Latest check incomplete",
      icon: "↻",
      color: "#a23a32",
      badgeBackground: "#fbeae7",
      borderColor: "#ecc4bf",
      calloutBackground: "#fff5f3",
      calloutBorder: "#efc9c4",
      calloutText: "#7f302a",
      detail: "This course’s latest availability check did not finish. We’ll retry automatically; its official page is available in the meantime."
    };
  }

  if (course.outcome === "BLOCKED_POLICY") {
    const bookingAccess = getBookingAccess(course);
    const monitoringLabel = bookingAccess === "PHONE_ONLY"
      ? "Phone only"
      : bookingAccess === "CONTACT_COURSE"
        ? "Contact course"
        : bookingAccess === "WALK_IN"
          ? "Walk-in only"
          : bookingAccess === "BOOKING_PAGE"
            ? "Book online directly"
            : "Official site only";
    const detail = bookingAccess === "PHONE_ONLY"
      ? "We can’t automatically monitor this course. Call the course to check availability and book directly."
      : bookingAccess === "CONTACT_COURSE"
        ? "We can’t automatically monitor this course. Contact the course directly to check availability and book."
        : bookingAccess === "WALK_IN"
          ? "We can’t automatically monitor this course. Check with the course in person for availability and booking."
          : bookingAccess === "BOOKING_PAGE"
            ? "We can’t automatically monitor this course and won’t bypass its account or access requirements. Use the official booking page to book directly."
            : `We can’t automatically monitor this course and won’t bypass its restrictions. Check the official site${course.phone ? " or call the course" : ""} to book directly.`;
    return {
      monitoringLabel,
      stateLabel: "Direct booking required",
      icon: "⚠",
      color: "#b66500",
      badgeBackground: "#fff0d6",
      borderColor: "#e8c987",
      calloutBackground: "#fff9eb",
      calloutBorder: "#edd39a",
      calloutText: "#734500",
      detail
    };
  }

  const availability = course.availability;
  if (!availability || availability.visibleSlotCount === 0) {
    return {
      ...fullyMonitoredDescription("Nothing visible for this date yet"),
      detail: "The course returned no public times for this date. Its booking window may not be open yet, or the visible inventory may currently be full. We’ll keep checking."
    };
  }

  if (availability.playerEligibleSlotCount === 0) {
    return {
      ...fullyMonitoredDescription("Not enough open spots"),
      detail: `Times are visible, but none currently have room for ${players} player${players === 1 ? "" : "s"}.`
    };
  }

  const timeZone = normalizeTimeZone(course.timeZone, DEFAULT_TIME_ZONE);
  const before = availability.closestBefore
    ? formatStartsAtTime(availability.closestBefore, timeZone)
    : null;
  const after = availability.closestAfter
    ? formatStartsAtTime(availability.closestAfter, timeZone)
    : null;
  const closest =
    before && after
      ? `The closest visible times are ${before} before your window and ${after} after it.`
      : before
        ? `The closest visible time is ${before}, before your window.`
        : after
          ? `The closest visible time is ${after}, after your window.`
          : "Times are visible, but none match your exact window.";

  return {
    ...fullyMonitoredDescription("No time in your window"),
    detail: closest
  };
}

function fullyMonitoredDescription(stateLabel: string) {
  return {
    monitoringLabel: "Fully monitored ✓",
    stateLabel,
    icon: "✓",
    color: "#147a52",
    badgeBackground: "#e8f4ec",
    borderColor: "#b8ddc8",
    calloutBackground: "#eef8f1",
    calloutBorder: "#c6e5d2",
    calloutText: "#285c43"
  };
}

function getBookingAccess(course: SearchStatusCourseReport) {
  if (course.bookingMethod === "PHONE_ONLY") {
    return "PHONE_ONLY";
  }
  if (course.bookingMethod === "CONTACT_COURSE") {
    return "CONTACT_COURSE";
  }
  if (course.bookingMethod === "WALK_IN") {
    return "WALK_IN";
  }
  if (
    course.bookingMethod === "PUBLIC_ONLINE" ||
    course.bookingMethod === "ONLINE_OR_PHONE"
  ) {
    return course.bookingUrl ? "BOOKING_PAGE" : course.bookingAccess;
  }
  if (course.bookingAccess) {
    return course.bookingAccess;
  }
  if (course.bookingUrl) {
    return "BOOKING_PAGE";
  }
  return course.phone ? "PHONE_ONLY" : undefined;
}

function getCourseState(course: SearchStatusCourseReport) {
  if (course.outcome !== "NO_MATCH") {
    if (course.outcome === "MATCH_FOUND") {
      return `${course.outcome}:${course.availableMatches}`;
    }
    return [
      course.outcome,
      course.bookingMethod ?? getBookingAccess(course) ?? "UNKNOWN"
    ].join(":");
  }
  if (!course.availability || course.availability.visibleSlotCount === 0) {
    if (course.bookingWindow) {
      return `NO_MATCH:BOOKING_WINDOW:${course.bookingWindow.opensAt}:${course.bookingWindow.exactTime}`;
    }
    return "NO_MATCH:DATE_NOT_VISIBLE";
  }
  if (course.availability.playerEligibleSlotCount === 0) {
    return `NO_MATCH:PLAYER_COUNT:${course.availability.visibleSlotCount}`;
  }
  return [
    "NO_MATCH:OUTSIDE_WINDOW",
    course.availability.closestBefore ?? "none",
    course.availability.closestAfter ?? "none"
  ].join(":");
}

function formatBookingWindowRelease(
  bookingWindow: NonNullable<SearchStatusCourseReport["bookingWindow"]>
) {
  if (!bookingWindow.exactTime) {
    return new Date(`${bookingWindow.releaseDate}T12:00:00.000Z`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
  }

  return new Date(bookingWindow.opensAt).toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: normalizeTimeZone(bookingWindow.timeZone, DEFAULT_TIME_ZONE),
    timeZoneName: "short"
  });
}

function parseSearchStatusSnapshot(value: unknown): SearchStatusSnapshot | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const snapshot = value.filter(
    (entry): entry is SearchStatusSnapshot[number] =>
      Boolean(
        entry &&
          typeof entry === "object" &&
          typeof (entry as SearchStatusSnapshot[number]).courseId === "string" &&
          typeof (entry as SearchStatusSnapshot[number]).courseName === "string" &&
          typeof (entry as SearchStatusSnapshot[number]).state === "string"
      )
  );
  return snapshot.length === value.length ? snapshot : null;
}

function formatStartsAtTime(value: string, timeZone: string) {
  return zonedDateTimeToDate(value, timeZone).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short"
  });
}

export { renderEmailStopControls } from "@/lib/email/customer-email";
