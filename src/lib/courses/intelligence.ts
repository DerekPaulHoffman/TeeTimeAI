export type BookingMethod =
  | "UNKNOWN"
  | "PUBLIC_ONLINE"
  | "PHONE_ONLY"
  | "ONLINE_OR_PHONE"
  | "CONTACT_COURSE"
  | "WALK_IN";

export type AutomationReason =
  | "NONE"
  | "NO_ONLINE_BOOKING"
  | "UNSUPPORTED_PLATFORM"
  | "AUTOMATION_PROHIBITED"
  | "ACCOUNT_REQUIRED"
  | "CAPTCHA_OR_QUEUE"
  | "TEMPORARILY_UNAVAILABLE"
  | "OTHER";

export type BookingAccessMode =
  | "UNKNOWN"
  | "PUBLIC_SIGNED_OUT"
  | "ACCOUNT_REQUIRED"
  | "ACCOUNT_SELF_SERVICE"
  | "ACCOUNT_STAFF_PROVISIONED"
  | "PHONE_ONLY"
  | "CONTACT_COURSE"
  | "WALK_IN"
  | "CAPTCHA_OR_QUEUE";

export type CourseAlertSupport =
  | "DIRECT_ONLINE"
  | "ACCOUNT_REQUIRED"
  | "ACCOUNT_SELF_SERVICE"
  | "ACCOUNT_STAFF_PROVISIONED"
  | "CAPTCHA_OR_QUEUE"
  | "OFFICIAL_SITE_ONLY"
  | "PHONE_ONLY"
  | "CONTACT_COURSE"
  | "WALK_IN_ONLY";

export type CourseMonitoringSupport =
  | "AUTOMATIC"
  | "MANUAL_ONLY"
  | "UNCONFIRMED";

export function getCourseMonitoringSupport(input?: {
  automationEligibility: string;
}): CourseMonitoringSupport {
  if (input?.automationEligibility === "ALLOWED") {
    return "AUTOMATIC";
  }

  if (input?.automationEligibility === "BLOCKED") {
    return "MANUAL_ONLY";
  }

  return "UNCONFIRMED";
}

export function resolveBookingAccessMode(input: {
  automationEligibility?: string | null;
  automationReason?: AutomationReason | string | null;
  bookingMethod?: BookingMethod | null;
  bookingAccessMode?: BookingAccessMode | string | null;
}): BookingAccessMode {
  // A current successful signed-out adapter supersedes older access evidence.
  if (input.automationEligibility === "ALLOWED") {
    return "PUBLIC_SIGNED_OUT";
  }

  if (
    input.bookingAccessMode &&
    input.bookingAccessMode !== "UNKNOWN" &&
    isBookingAccessMode(input.bookingAccessMode)
  ) {
    return input.bookingAccessMode;
  }

  if (input.automationReason === "ACCOUNT_REQUIRED") {
    return "ACCOUNT_REQUIRED";
  }
  if (input.automationReason === "CAPTCHA_OR_QUEUE") {
    return "CAPTCHA_OR_QUEUE";
  }

  switch (input.bookingMethod) {
    case "PHONE_ONLY":
      return "PHONE_ONLY";
    case "CONTACT_COURSE":
      return "CONTACT_COURSE";
    case "WALK_IN":
      return "WALK_IN";
    default:
      return "UNKNOWN";
  }
}

export function getCourseAlertSupport(input: {
  automationEligibility: string;
  automationReason?: AutomationReason | string | null;
  bookingMethod?: BookingMethod | null;
  bookingAccessMode?: BookingAccessMode | string | null;
}): CourseAlertSupport | undefined {
  if (input.automationEligibility !== "BLOCKED") {
    return undefined;
  }

  switch (resolveBookingAccessMode(input)) {
    case "ACCOUNT_REQUIRED":
      return "ACCOUNT_REQUIRED";
    case "ACCOUNT_SELF_SERVICE":
      return "ACCOUNT_SELF_SERVICE";
    case "ACCOUNT_STAFF_PROVISIONED":
      return "ACCOUNT_STAFF_PROVISIONED";
    case "CAPTCHA_OR_QUEUE":
      return "CAPTCHA_OR_QUEUE";
    case "PHONE_ONLY":
      return "PHONE_ONLY";
    case "CONTACT_COURSE":
      return "CONTACT_COURSE";
    case "WALK_IN":
      return "WALK_IN_ONLY";
    case "PUBLIC_SIGNED_OUT":
      return "DIRECT_ONLINE";
    default:
      break;
  }

  switch (input.bookingMethod) {
    case "PUBLIC_ONLINE":
    case "ONLINE_OR_PHONE":
      return "DIRECT_ONLINE";
    default:
      return "OFFICIAL_SITE_ONLY";
  }
}

export function isManualOnlyAlertSupport(
  alertSupport?: CourseAlertSupport
) {
  return alertSupport !== undefined;
}

export function getAlertSupportLabel(alertSupport: CourseAlertSupport) {
  switch (alertSupport) {
    case "DIRECT_ONLINE":
      return "Book online directly";
    case "ACCOUNT_REQUIRED":
    case "ACCOUNT_SELF_SERVICE":
      return "Golfer account required";
    case "ACCOUNT_STAFF_PROVISIONED":
      return "First-time access setup";
    case "CAPTCHA_OR_QUEUE":
      return "Captcha or queue";
    case "PHONE_ONLY":
      return "Phone only";
    case "CONTACT_COURSE":
      return "Contact course";
    case "WALK_IN_ONLY":
      return "Walk-in only";
    default:
      return "Official site only";
  }
}

export function getAlertSupportDescription(alertSupport: CourseAlertSupport) {
  switch (alertSupport) {
    case "DIRECT_ONLINE":
      return "Use the course's official booking page to check availability and book.";
    case "ACCOUNT_REQUIRED":
      return "This public course requires a golfer account to view tee times. Tee Time Spot does not sign in to golfer accounts. Use the official site and contact the course if you need access.";
    case "ACCOUNT_SELF_SERVICE":
      return "This public course requires a golfer account to view tee times. Golfers can create or use their own account on the official booking page, but Tee Time Spot does not sign in to golfer accounts.";
    case "ACCOUNT_STAFF_PROVISIONED":
      return "This is a public course, but first-time online booking access must be set up by course staff. Contact the course to get access; Tee Time Spot does not sign in to golfer accounts.";
    case "CAPTCHA_OR_QUEUE":
      return "Availability is behind a captcha, queue, or similar access control. Tee Time Spot does not bypass those controls; check the official booking page directly.";
    case "PHONE_ONLY":
      return "The course does not publish a public online tee sheet. Call the course directly to check availability and book.";
    case "CONTACT_COURSE":
      return "The course requires golfers to contact it directly to check availability and arrange a tee time.";
    case "WALK_IN_ONLY":
      return "The course handles tee-time access in person. Visit the course for current availability and booking.";
    default:
      return "Tee Time Spot has not yet confirmed a safe public way to monitor this course. Check the course's official site for current booking information.";
  }
}

export function getAlertSupportSavedStatus(
  courseName: string,
  alertSupport: CourseAlertSupport
) {
  switch (alertSupport) {
    case "DIRECT_ONLINE":
      return `${courseName} can be booked online directly`;
    case "ACCOUNT_REQUIRED":
    case "ACCOUNT_SELF_SERVICE":
      return `${courseName} requires a golfer account`;
    case "ACCOUNT_STAFF_PROVISIONED":
      return `${courseName} requires first-time access setup by course staff`;
    case "CAPTCHA_OR_QUEUE":
      return `${courseName} uses a captcha or queue`;
    case "PHONE_ONLY":
      return `${courseName} takes tee-time requests by phone only`;
    case "CONTACT_COURSE":
      return `${courseName} requires direct contact`;
    case "WALK_IN_ONLY":
      return `${courseName} handles tee times in person`;
    default:
      return `${courseName} is available through its official site only`;
  }
}

export function getUnavailableAlertCoverageCopy(input: {
  automationReason?: AutomationReason | string | null;
  bookingMethod?: BookingMethod | null;
  bookingAccessMode?: BookingAccessMode | string | null;
}) {
  const support = getCourseAlertSupport({
    ...input,
    automationEligibility: "BLOCKED"
  });

  if (
    support &&
    support !== "DIRECT_ONLINE" &&
    support !== "OFFICIAL_SITE_ONLY"
  ) {
    return `Automatic tee time alerts are not available. ${getAlertSupportDescription(support)}`;
  }

  switch (input.automationReason) {
    case "AUTOMATION_PROHIBITED":
      return "Automatic tee time monitoring is being re-checked against the current public booking surface.";
    case "TEMPORARILY_UNAVAILABLE":
      return "The course's public booking source is temporarily unavailable. Tee Time Spot will retry; check the official site in the meantime.";
    case "UNSUPPORTED_PLATFORM":
      return "The official booking page is available, but Tee Time Spot has not yet added reliable monitoring for its tee sheet. Check the official page directly.";
    case "NO_ONLINE_BOOKING":
      return "Automatic tee time alerts are not available because the course does not publish a public online tee sheet. Check with the course directly.";
    default:
      return "Automatic tee time alerts are not currently available for this course. Check the course's official site for current booking information.";
  }
}

export function isCourseIntelligenceReviewDue(
  reviewAt: Date | string | null | undefined,
  now = new Date()
) {
  if (!reviewAt) {
    return false;
  }

  const date = reviewAt instanceof Date ? reviewAt : new Date(reviewAt);
  return !Number.isNaN(date.getTime()) && date <= now;
}

function isBookingAccessMode(value: string): value is BookingAccessMode {
  return [
    "UNKNOWN",
    "PUBLIC_SIGNED_OUT",
    "ACCOUNT_REQUIRED",
    "ACCOUNT_SELF_SERVICE",
    "ACCOUNT_STAFF_PROVISIONED",
    "PHONE_ONLY",
    "CONTACT_COURSE",
    "WALK_IN",
    "CAPTCHA_OR_QUEUE"
  ].includes(value);
}
