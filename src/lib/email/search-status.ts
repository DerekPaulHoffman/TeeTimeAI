import type { MonitoringDisposition } from "@/lib/automation/policy";
import type {
  AutomationReason,
  BookingAccessMode,
  BookingMethod
} from "@/lib/courses/intelligence";
import type { CoursePriceEstimate } from "@/lib/pricing/course-prices";
import {
  getAlertSupportDescription,
  getAlertSupportLabel,
  getCourseAlertSupport
} from "@/lib/courses/intelligence";
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
  isPublic?: boolean;
  rating?: number;
  ratingObservedAt?: string;
  layoutHoleCounts?: number[];
  layoutHolesVerifiedAt?: string;
  priceEstimate?: CoursePriceEstimate;
  bookableHoleCounts?: Array<9 | 18>;
  bookableHoleCountsObservedAt?: string;
  courseGuideUrl?: string;
  outcome:
    | "MATCH_FOUND"
    | "NO_MATCH"
    | "BLOCKED_POLICY"
    | "BLOCKED_AUTH"
    | "NEEDS_ADAPTER"
    | "FETCH_FAILED";
  availableMatches: number;
  message?: string;
  bookingUrl?: string;
  phone?: string;
  bookingMethod?: BookingMethod;
  automationReason?: AutomationReason;
  bookingAccessMode?: BookingAccessMode;
  monitoringDisposition?: MonitoringDisposition;
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
    matchId?: string;
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
  stableIdempotencyKey?: string;
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
  const hasAvailability = input.courses.some((course) => {
    const category = getBlockedMonitoringCategory(course);
    return (
      (course.matchingTimes?.length ?? 0) > 0 &&
      category !== "IDENTITY_FINAL" &&
      category !== "IDENTITY_RECHECK"
    );
  });
  const hasIdentityRecheckCourse = input.courses.some(
    (course) => getBlockedMonitoringCategory(course) === "IDENTITY_RECHECK"
  );
  const hasDirectOnlyCourse = input.courses.some(
    (course) => {
      const category = getBlockedMonitoringCategory(course);
      return (
        category === "MANUAL_FINAL" ||
        category === "TECHNICAL_FINAL" ||
        category === "IDENTITY_FINAL"
      );
    }
  );
  const hasWorkInProgressCourse = input.courses.some(
    (course) =>
      course.outcome === "NEEDS_ADAPTER" ||
      getBlockedMonitoringCategory(course) === "POLICY_REMEDIATION" ||
      getBlockedMonitoringCategory(course) === "IDENTITY_RECHECK"
  );
  const heading = input.kind === "setup"
    ? "Your tee-time alert is active"
    : "Your morning tee-time update";
  const intro = hasAvailability
    ? "We found tee times matching your search. Book what's available now — we'll keep watching and alert you the moment one of your priorities opens up."
    : input.kind === "setup"
      ? hasIdentityRecheckCourse
        ? "Your alert is set. Automatic monitoring is paused for any course whose public-course identity is being rechecked; we'll keep checking supported courses."
        : hasDirectOnlyCourse
          ? "Your alert is set. We'll keep checking supported courses; courses marked for direct booking are not automatically monitored."
          : hasWorkInProgressCourse
            ? "Your alert is set. We checked every selected course. Use the official link where monitoring is still being added."
            : "Your alert is set. We checked every selected course and will keep watching automatically."
      : changedCourses.length > 0
        ? `Changed since your last email: ${changedCourses.join(", ")}.`
        : hasIdentityRecheckCourse
          ? "No course status changed since your last email. Identity verification is still in progress, and automatic monitoring remains paused for that course."
          : hasDirectOnlyCourse
            ? "No course status changed since your last email. We're still checking supported courses."
            : "No course status changed since your last email. We're still checking.";
  const availabilityCourses = input.courses
    .map((course, index) => ({ course, fallbackRank: index + 1 }))
    .filter(({ course }) => {
      const category = getBlockedMonitoringCategory(course);
      return (
        (course.matchingTimes?.length ?? 0) > 0 &&
        category !== "IDENTITY_FINAL" &&
        category !== "IDENTITY_RECHECK"
      );
    })
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
  const blockedCategory = getBlockedMonitoringCategory(course);
  const identityBlocked =
    blockedCategory === "IDENTITY_FINAL" ||
    blockedCategory === "IDENTITY_RECHECK";
  const bookingAccess = identityBlocked ? undefined : getBookingAccess(course);
  const isAddingMonitoring =
    course.outcome === "NEEDS_ADAPTER" ||
    blockedCategory === "POLICY_REMEDIATION";
  const presentation = identityBlocked
    ? {
        badgeLabel: description.monitoringLabel.toUpperCase(),
        tone: "direct" as const,
        detail: `${description.stateLabel}. ${description.detail}`
      }
    : course.outcome === "MATCH_FOUND"
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
        : isAddingMonitoring
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
    bookingUrl: identityBlocked ? undefined : course.bookingUrl,
    bookingLinkLabel,
    phone: identityBlocked ? undefined : course.phone,
    factLine: buildCourseFactLine(course),
    courseGuideUrl: course.courseGuideUrl
  };
}

function buildCourseFactLine(course: SearchStatusCourseReport) {
  const facts: string[] = [];
  if (course.isPublic === true) facts.push("Public");
  if (typeof course.rating === "number") {
    facts.push(
      `${course.rating.toFixed(1)} rating${formatObservedSuffix(course.ratingObservedAt)}`
    );
  }
  const physicalHoles = course.layoutHoleCounts?.includes(18)
    ? 18
    : course.layoutHoleCounts?.includes(9)
      ? 9
      : undefined;
  const observedHoles = course.bookableHoleCounts?.includes(18)
    ? 18
    : course.bookableHoleCounts?.includes(9)
      ? 9
      : undefined;
  if (physicalHoles) {
    facts.push(`${physicalHoles}H verified layout`);
  } else if (observedHoles) {
    facts.push(
      `${observedHoles}H booking option${formatObservedSuffix(course.bookableHoleCountsObservedAt)}`
    );
  }
  const range =
    (physicalHoles === 9 ? course.priceEstimate?.nineHoles : undefined) ??
    (physicalHoles === 18 ? course.priceEstimate?.eighteenHoles : undefined) ??
    course.priceEstimate?.eighteenHoles ??
    course.priceEstimate?.nineHoles;
  if (range) {
    const minimum = formatEmailPrice(range.minPriceCents);
    const maximum = formatEmailPrice(range.maxPriceCents);
    facts.push(
      `${minimum === maximum ? minimum : `${minimum}–${maximum}`} last observed ${formatObservedDate(range.observedAt ?? course.priceEstimate?.observedAt)}`
    );
  }
  return facts.join(" · ");
}

function formatObservedSuffix(value: string | undefined) {
  return value ? ` (observed ${formatObservedDate(value)})` : "";
}

function formatObservedDate(value: string | undefined) {
  if (!value) return "earlier";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "earlier"
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatEmailPrice(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 100 === 0 ? 0 : 2
  }).format(value / 100);
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
  const blockedCategory = getBlockedMonitoringCategory(course);
  if (blockedCategory === "IDENTITY_RECHECK") {
    return {
      monitoringLabel: "Course identity recheck",
      stateLabel: "Monitoring paused while we verify public access",
      icon: "!",
      color: "#7f302a",
      badgeBackground: "#fbeae7",
      borderColor: "#ecc4bf",
      calloutBackground: "#fff5f3",
      calloutBorder: "#efc9c4",
      calloutText: "#7f302a",
      detail:
        "The prior course-identity review is due. Automatic availability checks remain paused until current official evidence confirms this is a public course."
    };
  }
  if (blockedCategory === "IDENTITY_FINAL") {
    return {
      monitoringLabel: "Not a public course",
      stateLabel: "Not eligible for tee-time monitoring",
      icon: "!",
      color: "#7f302a",
      badgeBackground: "#fbeae7",
      borderColor: "#ecc4bf",
      calloutBackground: "#fff5f3",
      calloutBorder: "#efc9c4",
      calloutText: "#7f302a",
      detail:
        "Current verified identity evidence shows this listing is private, is not a playable golf course, or is otherwise not a public course Tee Time Spot can monitor."
    };
  }
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

  if (blockedCategory === "POLICY_REMEDIATION") {
    return {
      monitoringLabel: "Official booking page",
      stateLabel: "Check this course directly for now",
      icon: "↗",
      color: "#c75c0a",
      badgeBackground: "#fff0e4",
      borderColor: "#f1c79e",
      calloutBackground: "#fff8f2",
      calloutBorder: "#f3cfad",
      calloutText: "#713706",
      detail:
        "This legacy policy-only or generic classification is being re-checked against the current public booking surface. Use the official link while we keep working to add monitoring."
    };
  }

  if (blockedCategory === "TECHNICAL_FINAL") {
    const alertSupport =
      getCourseAlertSupport({
        automationEligibility: "BLOCKED",
        automationReason: course.automationReason,
        bookingMethod: course.bookingMethod,
        bookingAccessMode: course.bookingAccessMode
      }) ??
      (course.automationReason === "ACCOUNT_REQUIRED"
        ? "ACCOUNT_REQUIRED"
        : "CAPTCHA_OR_QUEUE");
    return {
      monitoringLabel: getAlertSupportLabel(alertSupport),
      stateLabel: "Check this course directly for now",
      icon: "⚠",
      color: "#b66500",
      badgeBackground: "#fff0d6",
      borderColor: "#e8c987",
      calloutBackground: "#fff9eb",
      calloutBorder: "#edd39a",
      calloutText: "#734500",
      detail: getAlertSupportDescription(alertSupport)
    };
  }

  if (blockedCategory === "MANUAL_FINAL") {
    const alertSupport =
      getCourseAlertSupport({
        automationEligibility: "BLOCKED",
        automationReason: course.automationReason,
        bookingMethod: course.bookingMethod,
        bookingAccessMode: course.bookingAccessMode
      }) ?? "OFFICIAL_SITE_ONLY";
    return {
      monitoringLabel: getAlertSupportLabel(alertSupport),
      stateLabel: "Direct booking required",
      icon: "⚠",
      color: "#b66500",
      badgeBackground: "#fff0d6",
      borderColor: "#e8c987",
      calloutBackground: "#fff9eb",
      calloutBorder: "#edd39a",
      calloutText: "#734500",
      detail: getAlertSupportDescription(alertSupport)
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

function getBlockedMonitoringCategory(course: SearchStatusCourseReport) {
  if (course.monitoringDisposition === "IDENTITY_RECHECK") {
    return "IDENTITY_RECHECK" as const;
  }
  if (course.monitoringDisposition === "IDENTITY_FINAL") {
    return "IDENTITY_FINAL" as const;
  }
  if (
    course.monitoringDisposition === "TECHNICAL_FINAL" ||
    course.outcome === "BLOCKED_AUTH" ||
    course.automationReason === "ACCOUNT_REQUIRED" ||
    course.automationReason === "CAPTCHA_OR_QUEUE"
  ) {
    return "TECHNICAL_FINAL" as const;
  }
  if (course.outcome !== "BLOCKED_POLICY") {
    return null;
  }
  if (
    course.monitoringDisposition === "MANUAL_FINAL" ||
    (course.automationReason === "NO_ONLINE_BOOKING" &&
      ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(
        course.bookingMethod ?? ""
      ))
  ) {
    return "MANUAL_FINAL" as const;
  }
  return "POLICY_REMEDIATION" as const;
}

function getCourseState(course: SearchStatusCourseReport) {
  if (course.outcome !== "NO_MATCH") {
    if (course.outcome === "MATCH_FOUND") {
      return `${course.outcome}:${course.availableMatches}`;
    }
    return [
      course.outcome,
      course.monitoringDisposition ?? "UNSPECIFIED",
      course.automationReason ?? "NONE",
      course.bookingAccessMode ?? "UNKNOWN",
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
