import {
  getDashboardAvailabilityView,
  readDashboardAvailabilitySnapshot,
  type DashboardAvailabilityView
} from "@/lib/searches/dashboard-availability";
import {
  getDashboardMonitoringVerdict,
  type DashboardMonitoringVerdictInput
} from "@/lib/searches/dashboard-monitoring-verdict";

export type DashboardCourseStatus = DashboardAvailabilityView & {
  emoji: string;
  hasCurrentPublicInventory: boolean;
};

export function getDashboardCourseStatus(input: {
  availability: Parameters<typeof getDashboardAvailabilityView>[0];
  monitoring: DashboardMonitoringVerdictInput;
}): DashboardCourseStatus {
  const availability = getDashboardAvailabilityView(input.availability);
  const monitoring = getDashboardMonitoringVerdict(input.monitoring);
  const monitoringOverridesAvailability =
    monitoring.icon === "unavailable" ||
    Boolean(input.monitoring.upcomingBookingWindow);
  const active =
    !input.availability.alertStatus || input.availability.alertStatus === "ACTIVE";
  const snapshot = readDashboardAvailabilitySnapshot(input.availability.rawSummary);

  return {
    ...(monitoringOverridesAvailability
      ? {
          label: monitoring.label,
          detail: monitoring.detail,
          emoji: monitoring.emoji,
          tone: monitoring.icon === "unavailable"
            ? "unavailable" as const
            : "scheduled" as const
        }
      : {
          ...availability,
          emoji: getCourseStatusEmoji(availability.tone)
        }),
    hasCurrentPublicInventory:
      active &&
      !monitoringOverridesAvailability &&
      input.availability.outcome === "NO_MATCH" &&
      (snapshot?.visibleSlotCount ?? 0) > 0
  };
}

export function getDashboardAlertSummary(input: {
  alertStatus: string;
  qualifyingMatchCount: number;
  courseStatuses: readonly DashboardCourseStatus[];
}) {
  const active = input.alertStatus === "ACTIVE";
  const lifecycleLabel = active ? "Active" : input.alertStatus;
  const unavailableCount = input.courseStatuses.filter(
    (course) => course.tone === "unavailable"
  ).length;
  const pendingCount = input.courseStatuses.filter(
    (course) => course.tone === "pending"
  ).length;
  const scheduledCount = input.courseStatuses.filter(
    (course) => course.tone === "scheduled"
  ).length;
  const coverageNotice = active
    ? [
        unavailableCount > 0
          ? `Availability not confirmed for ${courseCountLabel(unavailableCount)}`
          : null,
        pendingCount > 0
          ? `${courseCountLabel(pendingCount)} awaiting a check`
          : null,
        scheduledCount > 0
          ? `${courseCountLabel(scheduledCount)} open for booking later`
          : null
      ].filter(Boolean).join(" · ") || null
    : null;

  if (input.qualifyingMatchCount > 0) {
    return {
      lifecycleLabel,
      headline: `${input.qualifyingMatchCount} matching ${
        input.qualifyingMatchCount === 1 ? "time" : "times"
      } ${active ? "now" : "at last check"}`,
      coverageNotice
    };
  }

  if (!active) {
    return {
      lifecycleLabel,
      headline: "No current check for these settings",
      coverageNotice: null
    };
  }

  if (input.courseStatuses.length === 0 ||
      pendingCount === input.courseStatuses.length) {
    return {
      lifecycleLabel,
      headline: "Waiting for a check of these settings",
      coverageNotice
    };
  }

  if (input.courseStatuses.length === 1) {
    return {
      lifecycleLabel,
      headline: input.courseStatuses[0].label,
      coverageNotice: null
    };
  }

  const unconfirmedCount = unavailableCount + pendingCount;
  const headline = unconfirmedCount > 0
    ? unconfirmedCount === input.courseStatuses.length
      ? "Current availability not confirmed"
      : "Some course availability is not confirmed"
    : scheduledCount > 0
      ? scheduledCount === input.courseStatuses.length
        ? "Booking not open yet"
        : "No matching times; some courses open later"
      : input.courseStatuses.some((course) => course.hasCurrentPublicInventory)
        ? "Other tee times listed; none match your request"
        : input.courseStatuses.some((course) => course.tone === "available")
          ? "No current matches confirmed"
          : "No matching times for your request";

  return { lifecycleLabel, headline, coverageNotice };
}

function courseCountLabel(count: number) {
  return `${count} ${count === 1 ? "course" : "courses"}`;
}

function getCourseStatusEmoji(tone: DashboardAvailabilityView["tone"]) {
  switch (tone) {
    case "matching": return "⛳";
    case "available": return "👀";
    case "scheduled": return "🕒";
    case "unavailable": return "⚠️";
    case "empty": return "🔎";
    case "pending": return "⏳";
  }
}
