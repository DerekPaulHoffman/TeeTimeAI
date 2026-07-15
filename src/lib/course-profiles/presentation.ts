type BookingWindowCourse = {
  bookingWindowDaysAhead: number | null;
  bookingReleaseTimeLocal: string | null;
  bookingWindowEvidenceUrl: string | null;
  detectedBookingUrl: string | null;
  website: string | null;
};

export function getBookingWindowPresentation(course: BookingWindowCourse) {
  const officialBookingUrl = course.detectedBookingUrl ?? course.website;
  if (course.bookingWindowDaysAhead === null) {
    return {
      title: "Advance booking schedule",
      copy: officialBookingUrl
        ? "Confirm on the official booking page."
        : "Confirm availability and booking rules directly with the course.",
      sourceUrl: officialBookingUrl,
      sourceLabel: officialBookingUrl ? "Open the official booking page" : null
    };
  }

  const time = course.bookingReleaseTimeLocal
    ? ` at ${course.bookingReleaseTimeLocal} course-local time`
    : "";
  return {
    title: `${course.bookingWindowDaysAhead}-day booking window`,
    copy: `Public tee times open up to ${course.bookingWindowDaysAhead} days ahead${time}. Check the official booking page for current availability and any player-specific rules.`,
    sourceUrl: officialBookingUrl ?? course.bookingWindowEvidenceUrl,
    sourceLabel: officialBookingUrl ? "Open the official booking page" : "View official booking details"
  };
}

export function getPublicFacilityFacts(facts: string[]) {
  return facts
    .filter((fact) => !/tee times?.*(?:days? ahead|reserved .* days|advance-booking)/i.test(fact))
    .map((fact) => {
      const directFact = fact
        .replace(/^The official site describes the course as /i, "The course is ")
        .replace(/^The official course policy describes (.+) as (.+)$/i, "$1 is $2")
        .replace(/^The course describes itself as /i, "The course is ")
        .replace(/^(.+?) identifies itself as /i, "$1 is ");
      return `${directFact.charAt(0).toUpperCase()}${directFact.slice(1)}`;
    });
}

export function getUnsupportedAlertCopy(reason: string) {
  const copy: Record<string, string> = {
    NO_ONLINE_BOOKING: "Automatic tee time alerts are not available because this course does not offer public online booking.",
    ACCOUNT_REQUIRED: "Automatic tee time alerts are not available because the booking flow requires a golfer account.",
    AUTOMATION_PROHIBITED: "Automatic tee time alerts are not available for this course under the provider's access rules.",
    CAPTCHA_OR_QUEUE: "Automatic tee time alerts are not available because the booking flow uses a captcha, queue, or other access control."
  };
  return copy[reason] ?? "Automatic tee time alerts are not currently available for this course.";
}
