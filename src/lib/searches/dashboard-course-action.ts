import type { CourseAlertSupport } from "@/lib/courses/intelligence";

export function getDashboardCourseAction(
  alertSupport: CourseAlertSupport,
  bookingPhone?: string | null
) {
  switch (alertSupport) {
    case "PHONE_ONLY":
      return {
        emoji: "📞",
        label: "Call the course",
        detail: bookingPhone
          ? `This course handles tee times by phone. Call ${bookingPhone} to check availability and book.`
          : "This course handles tee times by phone. Call the course to check availability and book."
      };
    case "CONTACT_COURSE":
    case "ACCOUNT_STAFF_PROVISIONED":
      return {
        emoji: "💬",
        label: "Contact the course",
        detail:
          alertSupport === "ACCOUNT_STAFF_PROVISIONED"
            ? "The course needs to set up your booking access. Contact the course directly to get started."
            : "This course asks golfers to contact them directly for current availability and booking."
      };
    case "WALK_IN_ONLY":
      return {
        emoji: "🚶",
        label: "Check with the course in person",
        detail:
          "This course handles tee times in person. Visit or contact the course for current availability."
      };
    case "ACCOUNT_REQUIRED":
    case "ACCOUNT_SELF_SERVICE":
      return {
        emoji: "🔐",
        label: "Sign in on the official site",
        detail:
          "This course shows tee times after golfers sign in. Use your own account on the official site to check availability."
      };
    case "DIRECT_ONLINE":
      return {
        emoji: "🌐",
        label: "Check the official booking page",
        detail:
          "View current tee times and book directly with the course on its official booking page."
      };
    case "CAPTCHA_OR_QUEUE":
      return {
        emoji: "🌐",
        label: "Check the official booking page",
        detail:
          "The course's booking site needs you to open it directly to view current tee times."
      };
    case "OFFICIAL_SITE_ONLY":
    default:
      return {
        emoji: "🌐",
        label: "Check the official course site",
        detail:
          "Use the official course site for current availability and booking information."
      };
  }
}
