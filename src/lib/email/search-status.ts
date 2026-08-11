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
  getCustomerMonitoringStatus,
  isCustomerMonitoringStatusReportable,
  type CustomerMonitoringStatus
} from "@/lib/customer-monitoring-status";
import {
  renderCustomerEmail,
  type CustomerEmailMonitoringCourse
} from "@/lib/email/customer-email";
import { buildCourseFactLine } from "@/lib/email/course-facts";
import type { EmailStopUrls } from "@/lib/email/search-actions";
import {
  DEFAULT_TIME_ZONE,
  normalizeTimeZone,
  zonedDateTimeToDate
} from "@/lib/timezones";

export type SearchStatusEmailKind = "setup" | "daily";
export type SearchStatusTransitionKind = "outage" | "recovery" | "status-update";

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
  distanceMeters?: number;
  layoutHoleCounts?: number[];
  layoutHolesVerifiedAt?: string;
  priceEstimate?: CoursePriceEstimate;
  bookableHoleCounts?: Array<9 | 18>;
  bookableHoleCountsObservedAt?: string;
  factLine?: string;
  courseGuideUrl?: string;
  outcome:
    | "MATCH_FOUND"
    | "NO_MATCH"
    | "CHECK_PENDING"
    | "BLOCKED_POLICY"
    | "BLOCKED_AUTH"
    | "NEEDS_ADAPTER"
    | "FETCH_FAILED"
    | "MANUAL_DIRECT"
    | "IDENTITY_FINAL"
    | "IDENTITY_RECHECK";
  availableMatches: number;
  message?: string;
  bookingUrl?: string;
  phone?: string;
  bookingMethod?: BookingMethod;
  automationReason?: AutomationReason;
  bookingAccessMode?: BookingAccessMode;
  monitoringDisposition?: MonitoringDisposition;
  supportStatus?: "IN_OPERATOR_QUEUE" | "NEEDS_HUMAN_REVIEW";
  firstTimeLookup?: boolean;
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
  customerStatus?: CustomerMonitoringStatus;
}>;

export type SearchStatusEmailInput = {
  searchId: string;
  to: string;
  kind: SearchStatusEmailKind | SearchStatusTransitionKind;
  targetDate: string;
  startTime: string;
  endTime: string;
  players: number;
  requestedLayoutHoles?: 9 | 18 | null;
  userTimeZone?: string;
  providerLabel?: string;
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
    state: getCourseState(course),
    customerStatus: getCustomerCourseMonitoringStatus(course)
  }));
}

export function isInitialSearchStatusReportReady(
  courses: SearchStatusCourseReport[],
  expectedCourseCount = courses.length
) {
  return (
    expectedCourseCount > 0 &&
    courses.length === expectedCourseCount &&
    new Set(courses.map((course) => course.courseId)).size ===
      expectedCourseCount &&
    courses.every((course) =>
      isCustomerMonitoringStatusReportable(
        getCustomerCourseMonitoringStatus(course)
      )
    )
  );
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
      getBlockedMonitoringCategory(course) === "POLICY_REMEDIATION" ||
      getBlockedMonitoringCategory(course) === "IDENTITY_RECHECK"
  );
  const hasUnavailableCourse = input.courses.some(
    (course) =>
      course.outcome === "NEEDS_ADAPTER" ||
      course.outcome === "FETCH_FAILED"
  );
  const hasHumanReviewCourse = input.courses.some(
    (course) =>
      getCustomerCourseMonitoringStatus(course) === "NEEDS_HUMAN_REVIEW"
  );
  const heading =
    input.kind === "setup"
      ? "Your tee-time alert is active"
      : input.kind === "daily"
        ? "Your morning tee-time update"
        : input.kind === "outage"
          ? hasHumanReviewCourse
            ? "Manual review needed"
            : "Automatic checks are still retrying"
          : input.kind === "status-update"
            ? "A course status has been confirmed"
          : hasAvailability
            ? "Automatic checks resumed — and tee times are available"
            : "Automatic checks resumed";
  const providerService = input.providerLabel
    ? `${input.providerLabel}'s public tee-time service`
    : "The public tee-time service";
  const intro =
    input.kind === "outage"
      ? hasHumanReviewCourse
        ? "Manual review needed; your alert remains active. Use the official site for current tee times while we review this course."
        : `${providerService} is not responding to our checks. Your alert remains active. Use the official site for current tee times while Tee Time Spot keeps trying.`
      : input.kind === "status-update"
        ? "We confirmed the current status for one or more courses. Your alert remains active for the other selected courses. See the confirmed course details below."
      : input.kind === "recovery"
        ? hasAvailability
          ? "A fresh public check succeeded. Automatic checks resumed, and matching tee times are available below."
          : "A fresh public check succeeded. Automatic checks resumed, and your alert remains active."
        : hasAvailability
      ? "We found tee times matching your search. Book what's available now — we'll keep watching and alert you the moment one of your priorities opens up."
      : input.kind === "setup"
        ? hasIdentityRecheckCourse
          ? "Your alert is set. We're confirming the details for one or more courses; we'll keep checking the courses that are ready."
          : hasDirectOnlyCourse
            ? "Your alert is set. We'll keep checking supported courses; courses marked for direct booking are not automatically monitored."
            : hasHumanReviewCourse
              ? "Your alert is set. Manual review is needed for one or more courses; your alert remains active. Use the official site for current tee times."
              : hasUnavailableCourse
                ? "Your alert is set. Every selected course has a result below. We'll monitor supported courses and keep retrying the others; use the official site for current tee times."
                : hasWorkInProgressCourse
                  ? "Your alert is set. We checked every selected course. Please use the official link for any course Tee Time Spot cannot check automatically yet."
                  : "Your alert is set. We checked every selected course and will keep watching automatically."
        : changedCourses.length > 0
          ? `Changed since your last email: ${changedCourses.join(", ")}.`
          : hasIdentityRecheckCourse
            ? "No course status changed since your last email. We're still confirming the details for one or more courses."
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
      factLine: course.factLine ?? buildCourseFactLine(course),
      courseGuideUrl: course.courseGuideUrl,
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
    variant:
      input.kind === "setup"
        ? "setup"
        : input.kind === "daily"
          ? "morning"
          : input.kind === "status-update"
            ? "outage"
            : input.kind,
    heading,
    intro,
    preheader:
      input.kind === "setup"
        ? "Your Tee Time Spot alert is active."
        : input.kind === "daily"
          ? "Your morning Tee Time Spot search update is ready."
          : input.kind === "status-update"
            ? "A course in your alert now has a confirmed current status."
          : input.kind === "outage"
            ? "Your alert remains active while automatic checks retry."
            : "Automatic checks have resumed for your alert.",
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
    assetBaseUrl: input.assetBaseUrl,
    showCadenceNote: input.kind === "daily"
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
  const customerStatus = getCustomerCourseMonitoringStatus(course);
  const bookingAccess = identityBlocked ? undefined : getBookingAccess(course);
  const isAddingMonitoring = blockedCategory === "POLICY_REMEDIATION";
  const presentation = identityBlocked
    ? {
        badgeLabel: description.monitoringLabel.toUpperCase(),
        tone: "direct" as const,
        detail: `${description.stateLabel}. ${description.detail}`
      }
    : course.outcome === "MATCH_FOUND"
      ? {
        badgeLabel: "TEE TIME FOUND",
        tone: "monitored" as const,
        detail: description.detail
      }
    : course.outcome === "NO_MATCH" && course.bookingWindow
      ? {
          badgeLabel: "SCHEDULED",
          tone: "scheduled" as const,
          detail: `${description.stateLabel}. ${description.detail}`
        }
      : course.outcome === "NO_MATCH"
        ? {
            badgeLabel: "CHECKING FOR TEE TIMES",
            tone: "monitored" as const,
            detail: `${description.stateLabel}. ${description.detail}`
          }
        : course.outcome === "CHECK_PENDING"
          ? {
              badgeLabel: "CHECKING NOW",
              tone: "scheduled" as const,
              detail: `${description.stateLabel}. ${description.detail}`
            }
        : customerStatus === "NEEDS_HUMAN_REVIEW"
          ? {
              badgeLabel: "MANUAL REVIEW NEEDED",
              tone: "direct" as const,
              detail: `${description.stateLabel}. ${description.detail}`
            }
        : isAddingMonitoring
          ? {
              badgeLabel: "CHECK OFFICIAL WEBSITE",
              tone: "adding" as const,
              detail: `${description.stateLabel}. ${description.detail}`
            }
          : customerStatus === "RETRYING_AUTOMATICALLY"
            ? {
                badgeLabel: "AUTOMATIC CHECKS RETRYING",
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
    factLine: course.factLine ?? buildCourseFactLine(course),
    courseGuideUrl: course.courseGuideUrl
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
  const blockedCategory = getBlockedMonitoringCategory(course);
  if (blockedCategory === "IDENTITY_RECHECK") {
    return {
      monitoringLabel: "Confirming course details",
      stateLabel: "Checking whether this listing is a public golf course",
      icon: "!",
      color: "#7f302a",
      badgeBackground: "#fbeae7",
      borderColor: "#ecc4bf",
      calloutBackground: "#fff5f3",
      calloutBorder: "#efc9c4",
      calloutText: "#7f302a",
      detail:
        "Tee Time Spot will begin checking for tee times after we confirm the course details."
    };
  }
  if (blockedCategory === "IDENTITY_FINAL") {
    return {
      monitoringLabel: "Not available for alerts",
      stateLabel: "This listing is not a public golf course we can check",
      icon: "!",
      color: "#7f302a",
      badgeBackground: "#fbeae7",
      borderColor: "#ecc4bf",
      calloutBackground: "#fff5f3",
      calloutBorder: "#efc9c4",
      calloutText: "#7f302a",
      detail:
        "Please choose another public golf course for your alert."
    };
  }
  if (course.outcome === "MATCH_FOUND") {
    return {
      monitoringLabel: "Tee time found",
      stateLabel: "A matching tee time is available",
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

  if (course.outcome === "CHECK_PENDING") {
    return {
      monitoringLabel: "Checking now",
      stateLabel: "A fresh public-page check is in progress",
      icon: "â—·",
      color: "#17647a",
      badgeBackground: "#e6f3f7",
      borderColor: "#b8dbe5",
      calloutBackground: "#eef8fb",
      calloutBorder: "#c5e2ea",
      calloutText: "#174152",
      detail:
        "Tee Time Spot is waiting for the current public-page check to finish. Your alert remains active."
    };
  }

  if (getCustomerCourseMonitoringStatus(course) === "NEEDS_HUMAN_REVIEW") {
    return {
      monitoringLabel: "Manual review needed",
      stateLabel: "Use the official site while we review this course",
      icon: "↗",
      color: "#a23a32",
      badgeBackground: "#fbeae7",
      borderColor: "#ecc4bf",
      calloutBackground: "#fff5f3",
      calloutBorder: "#efc9c4",
      calloutText: "#7f302a",
      detail:
        "Manual review needed; your alert remains active. Use the official site for current tee times while we review this course."
    };
  }

  if (course.outcome === "NEEDS_ADAPTER") {
    const firstLookupDetail = course.firstTimeLookup
      ? course.supportStatus === "IN_OPERATOR_QUEUE"
        ? "This is the first time Tee Time Spot has checked this course. Automatic checks are still retrying."
        : "This is the first time Tee Time Spot has checked this course, and the initial check needs more time."
      : null;
    return {
      monitoringLabel: "Automatic checks are still retrying",
      stateLabel: "Use the official site while we keep trying",
      icon: "↗",
      color: "#c75c0a",
      badgeBackground: "#fff0e4",
      borderColor: "#f1c79e",
      calloutBackground: "#fff8f2",
      calloutBorder: "#f3cfad",
      calloutText: "#713706",
      detail: course.bookingUrl
        ? `${firstLookupDetail ? `${firstLookupDetail} ` : ""}Your alert remains active. Use the official site for current tee times while Tee Time Spot keeps trying.`
        : course.phone
          ? `${firstLookupDetail ? `${firstLookupDetail} ` : ""}Your alert remains active. Call the course for current tee times while Tee Time Spot keeps trying.`
          : `${firstLookupDetail ? `${firstLookupDetail} ` : ""}Your alert remains active while Tee Time Spot keeps trying to confirm a reliable public source.`
    };
  }

  if (course.outcome === "FETCH_FAILED") {
    const firstLookupDetail = course.firstTimeLookup
      ? course.supportStatus === "IN_OPERATOR_QUEUE"
        ? "This is the first time Tee Time Spot has checked this course. Its monitoring gap is in our course coverage queue."
        : "This is the first time Tee Time Spot has checked this course, and the initial review needs more time."
      : null;
    return {
      monitoringLabel: "Automatic alerts temporarily unavailable",
      stateLabel: "Use the official site while we retry",
      icon: "↻",
      color: "#a23a32",
      badgeBackground: "#fbeae7",
      borderColor: "#ecc4bf",
      calloutBackground: "#fff5f3",
      calloutBorder: "#efc9c4",
      calloutText: "#7f302a",
      detail: `${firstLookupDetail ? `${firstLookupDetail} ` : ""}The public tee-time service isn't responding to our checks. Your alert remains active. Use the official site for current tee times while Tee Time Spot keeps trying.`
    };
  }

  if (blockedCategory === "POLICY_REMEDIATION") {
    return {
      monitoringLabel: "Check the official website",
      stateLabel: "We're confirming how this course handles online booking",
      icon: "↗",
      color: "#c75c0a",
      badgeBackground: "#fff0e4",
      borderColor: "#f1c79e",
      calloutBackground: "#fff8f2",
      calloutBorder: "#f3cfad",
      calloutText: "#713706",
      detail:
        "Please use the official link for current availability while we finish checking."
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
      stateLabel: "Please check this course directly",
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
      stateLabel: "Please check directly with the course",
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
    monitoringLabel: "Checking for tee times ✓",
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
  if (
    course.monitoringDisposition === "IDENTITY_RECHECK" ||
    course.outcome === "IDENTITY_RECHECK"
  ) {
    return "IDENTITY_RECHECK" as const;
  }
  if (
    course.monitoringDisposition === "IDENTITY_FINAL" ||
    course.outcome === "IDENTITY_FINAL"
  ) {
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
  if (course.outcome === "MANUAL_DIRECT") {
    return "MANUAL_FINAL" as const;
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

export function getCustomerCourseMonitoringStatus(
  course: SearchStatusCourseReport
) {
  return getCustomerMonitoringStatus({
    outcome: course.outcome,
    monitoringDisposition: course.monitoringDisposition,
    supportStatus: course.supportStatus
  });
}

function getCourseState(course: SearchStatusCourseReport) {
  if (course.outcome !== "NO_MATCH") {
    if (course.outcome === "MATCH_FOUND") {
      return `${course.outcome}:${course.availableMatches}`;
    }
    return [
      course.outcome,
      course.monitoringDisposition ?? "UNSPECIFIED",
      course.supportStatus ?? "NO_SUPPORT_STATUS",
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
