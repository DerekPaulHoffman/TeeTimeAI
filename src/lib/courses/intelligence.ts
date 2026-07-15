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

export type CourseAlertSupport =
  | "DIRECT_ONLINE"
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

export function getCourseAlertSupport(input: {
  automationEligibility: string;
  bookingMethod?: BookingMethod | null;
}): CourseAlertSupport | undefined {
  if (input.automationEligibility !== "BLOCKED") {
    return undefined;
  }

  switch (input.bookingMethod) {
    case "PUBLIC_ONLINE":
    case "ONLINE_OR_PHONE":
      return "DIRECT_ONLINE";
    case "PHONE_ONLY":
      return "PHONE_ONLY";
    case "CONTACT_COURSE":
      return "CONTACT_COURSE";
    case "WALK_IN":
      return "WALK_IN_ONLY";
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
    case "PHONE_ONLY":
      return "Call the course directly to check availability and book.";
    case "CONTACT_COURSE":
      return "Contact the course directly to check availability and book.";
    case "WALK_IN_ONLY":
      return "This course requires booking or availability checks in person.";
    default:
      return "Check the course’s official site directly for availability and booking.";
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
