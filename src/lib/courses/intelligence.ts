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
      return "Check and book directly";
    case "ACCOUNT_REQUIRED":
    case "ACCOUNT_SELF_SERVICE":
      return "Sign in on official website";
    case "ACCOUNT_STAFF_PROVISIONED":
      return "Contact the course first";
    case "CAPTCHA_OR_QUEUE":
      return "Check the official website";
    case "PHONE_ONLY":
      return "Call the course";
    case "CONTACT_COURSE":
      return "Contact the course";
    case "WALK_IN_ONLY":
      return "Check with the course in person";
    default:
      return "Check the official website";
  }
}

export function getAlertSupportDescription(alertSupport: CourseAlertSupport) {
  switch (alertSupport) {
    case "DIRECT_ONLINE":
      return "Tee Time Spot cannot check this course automatically. Please use the official booking page to view current tee times and book directly.";
    case "ACCOUNT_REQUIRED":
      return "This course only shows tee times after golfers sign in. Tee Time Spot does not use golfer accounts, so please sign in on the official website to check availability.";
    case "ACCOUNT_SELF_SERVICE":
      return "This course only shows tee times after golfers sign in. Please create or use your own account on the official website to check availability.";
    case "ACCOUNT_STAFF_PROVISIONED":
      return "The course requires staff to set up your online booking access. Please contact the course directly to get started.";
    case "CAPTCHA_OR_QUEUE":
      return "This course's booking website prevents Tee Time Spot from checking availability automatically. Please use the official booking page to view current tee times and book directly.";
    case "PHONE_ONLY":
      return "This course does not show tee-time availability online. Please call the course directly to check availability and book.";
    case "CONTACT_COURSE":
      return "This course asks golfers to contact them directly for availability and booking.";
    case "WALK_IN_ONLY":
      return "This course handles tee times in person. Please visit or contact the course for current availability.";
    default:
      return "Tee Time Spot cannot check this course automatically yet. Please use the official website for current booking information.";
  }
}

export function getAlertSupportSavedStatus(
  courseName: string,
  alertSupport: CourseAlertSupport
) {
  switch (alertSupport) {
    case "DIRECT_ONLINE":
      return `Check and book ${courseName} on its official website`;
    case "ACCOUNT_REQUIRED":
    case "ACCOUNT_SELF_SERVICE":
      return `Sign in on ${courseName}'s official website to check tee times`;
    case "ACCOUNT_STAFF_PROVISIONED":
      return `Contact ${courseName} before booking online`;
    case "CAPTCHA_OR_QUEUE":
      return `Check ${courseName} on its official website`;
    case "PHONE_ONLY":
      return `Call ${courseName} for tee-time availability`;
    case "CONTACT_COURSE":
      return `Contact ${courseName} directly`;
    case "WALK_IN_ONLY":
      return `${courseName} handles tee times in person`;
    default:
      return `Check ${courseName} on its official website`;
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
    return getAlertSupportDescription(support);
  }

  switch (input.automationReason) {
    case "AUTOMATION_PROHIBITED":
      return "We're confirming how this course handles online booking. Please use the official website for current availability.";
    case "TEMPORARILY_UNAVAILABLE":
      return "We couldn't complete the latest check. We'll try again automatically. Please use the official website for current availability.";
    case "UNSUPPORTED_PLATFORM":
      return "Tee Time Spot cannot check this course automatically yet. Please use the official booking page to view current tee times and book directly.";
    case "NO_ONLINE_BOOKING":
      return "This course does not show tee-time availability online. Please contact the course directly.";
    default:
      return "Tee Time Spot cannot check this course automatically yet. Please use the official website for current booking information.";
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
