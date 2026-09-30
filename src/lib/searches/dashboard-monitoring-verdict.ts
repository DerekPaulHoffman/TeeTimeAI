import type { CourseAlertSupport } from "@/lib/courses/intelligence";
import {
  getCustomerMonitoringStatus,
  type CustomerMonitoringStatusInput
} from "@/lib/customer-monitoring-status";
import { getDashboardCourseAction } from "@/lib/searches/dashboard-course-action";

export type DashboardMonitoringVerdictInput = {
  alertSupport: CourseAlertSupport | null;
  bookingPhone?: string | null;
  automationEligibility: string;
  automationReason: string;
  latestProbe?: {
    outcome:
      | "MATCH_FOUND"
      | "NO_MATCH"
      | "BLOCKED_POLICY"
      | "BLOCKED_AUTH"
      | "BLOCKED_TOOLING"
      | "FETCH_FAILED"
      | "NEEDS_ADAPTER"
      | "MANUAL_DIRECT"
      | "IDENTITY_FINAL"
      | "IDENTITY_RECHECK";
    observedAt: Date;
  };
  upcomingBookingWindow: unknown;
  supportIncidentStatus?:
    | "AUTO_INVESTIGATING"
    | "NEEDS_HUMAN"
    | "RESOLVED"
    | null;
  monitoringState?: CustomerMonitoringStatusInput["monitoringState"];
  monitoringStateChangedAt?: Date | null;
  humanReviewReason?: string | null;
  incidentEscalatedAt?: Date | null;
  escalationDeadlineAt?: Date | null;
  automationPlaybookExhausted?: boolean | null;
  automationStalledAtEndpoint?: boolean | null;
  now?: Date;
  firstTimeLookup: boolean;
  alertStatus?: string;
};

export function getDashboardMonitoringVerdict(
  input: DashboardMonitoringVerdictInput
) {
  const active = !input.alertStatus || input.alertStatus === "ACTIVE";
  const lifecycleDetail = active
    ? "Your alert remains active."
    : input.alertStatus === "PAUSED"
      ? "This alert is paused. Resume it to check your saved request."
      : "This alert has ended and is no longer checking for tee times.";
  const customerStatus = getCustomerMonitoringStatus({
    outcome: input.latestProbe?.outcome,
    monitoringState: input.monitoringState,
    monitoringStateChangedAt: input.monitoringStateChangedAt,
    outcomeObservedAt: input.latestProbe?.observedAt,
    incidentStatus: input.supportIncidentStatus,
    humanReviewReason: input.humanReviewReason,
    incidentEscalatedAt: input.incidentEscalatedAt,
    escalationDeadlineAt: input.escalationDeadlineAt,
    automationPlaybookExhausted: input.automationPlaybookExhausted,
    automationStalledAtEndpoint: input.automationStalledAtEndpoint,
    now: input.now,
    automationReason: input.automationReason,
    directActionAvailable: Boolean(input.alertSupport)
  });

  if (
    customerStatus !== "NEEDS_HUMAN_REVIEW" &&
    customerStatus !== "FINAL_DIRECT_ACTION" &&
    input.upcomingBookingWindow &&
    (!input.latestProbe || input.latestProbe.outcome === "NO_MATCH")
  ) {
    return {
      label: active ? "Checks start when booking opens" : "Booking opens later",
      detail: active
        ? "We will begin checking at the course's useful booking release time."
        : lifecycleDetail,
      emoji: "📅",
      icon: "scheduled" as const,
      className: "is-detail"
    };
  }

  if (customerStatus === "MONITORED" &&
    (input.latestProbe?.outcome === "MATCH_FOUND" || input.latestProbe?.outcome === "NO_MATCH")) {
    return {
      label: "Tee-time alerts available",
      detail: "The latest check completed successfully.",
      emoji: "✅",
      icon: "watching" as const,
      className: "is-public"
    };
  }

  if (customerStatus === "NEEDS_HUMAN_REVIEW") {
    return {
      label: "Manual review needed",
      detail: active
        ? "Manual review needed; your alert remains active. Use the official site for current tee times while we review this course."
        : `Manual review needed. ${lifecycleDetail} Use the official site for current tee times.`,
      emoji: "👀",
      icon: "unavailable" as const,
      className: "is-official-site-only"
    };
  }

  if (customerStatus === "RETRYING_AUTOMATICALLY" ||
    (customerStatus === "MONITORED" && input.latestProbe &&
      ["FETCH_FAILED", "NEEDS_ADAPTER", "BLOCKED_TOOLING"].includes(input.latestProbe.outcome))) {
    return {
      label: active ? "Automatic checks are still retrying"
        : input.alertStatus === "PAUSED" ? "Alert paused" : "Alert ended",
      detail: active
        ? "Your alert remains active. Use the official site for current tee times while Tee Time Spot keeps trying."
        : `${lifecycleDetail} Use the official site for current tee times.`,
      emoji: "🔄",
      icon: "unavailable" as const,
      className: "is-official-site-only"
    };
  }

  if (customerStatus === "FINAL_DIRECT_ACTION") {
    if (input.alertSupport) {
      return {
        ...getDashboardCourseAction(input.alertSupport, input.bookingPhone),
        icon: "unavailable" as const,
        className: "is-official-site-only"
      };
    }
    return {
      label: "Check the official course site",
      detail: "Use the official course site for current availability and booking.",
      emoji: "🌐",
      icon: "unavailable" as const,
      className: "is-official-site-only"
    };
  }

  if (input.latestProbe?.outcome === "IDENTITY_RECHECK") {
    return {
      label: "Confirming course details",
      detail:
        `We are confirming that this listing is a public golf course. ${lifecycleDetail}`,
      emoji: "⏳",
      icon: "scheduled" as const,
      className: "is-detail"
    };
  }

  if (!active) {
    return {
      label: input.alertStatus === "PAUSED" ? "Alert paused" : "Alert ended",
      detail: lifecycleDetail,
      emoji: "⏸️",
      icon: "scheduled" as const,
      className: "is-detail",
    };
  }

  return {
    label: input.firstTimeLookup
      ? "Checking this course for the first time"
      : "Alert availability pending",
    detail:
      input.automationEligibility === "ALLOWED"
        ? "The first check is starting now and will confirm the current result."
        : input.firstTimeLookup
          ? "Tee Time Spot hasn't checked this course before. We'll email whether alerts are available after the first check, usually within 10 minutes."
          : "We'll email whether tee-time alerts are available after the first check, usually within 10 minutes.",
    emoji: "⏳",
    icon: "scheduled" as const,
    className: "is-detail"
  };
}
