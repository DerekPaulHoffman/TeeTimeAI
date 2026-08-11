import type { MonitoringDisposition } from "@/lib/automation/policy";

export const CUSTOMER_MONITORING_STATUSES = [
  "CHECKING",
  "MONITORED",
  "RETRYING_AUTOMATICALLY",
  "NEEDS_HUMAN_REVIEW",
  "FINAL_DIRECT_ACTION"
] as const;

export type CustomerMonitoringStatus =
  (typeof CUSTOMER_MONITORING_STATUSES)[number];

export type CustomerMonitoringStatusInput = {
  outcome?: string | null;
  monitoringDisposition?: MonitoringDisposition | null;
  monitoringState?:
    | "UNKNOWN"
    | "HEALTHY"
    | "DEGRADED_RETRYING"
    | "AUTO_INVESTIGATING"
    | "ENGINEERING_VERIFICATION_NEEDED"
    | "REVALIDATING_FINAL"
    | "FINAL_MANUAL"
    | "FINAL_TECHNICAL"
    | "FINAL_IDENTITY"
    | null;
  incidentStatus?: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED" | null;
  humanReviewReason?: string | null;
  escalationDeadlineAt?: Date | null;
  now?: Date;
  supportStatus?: "IN_OPERATOR_QUEUE" | "NEEDS_HUMAN_REVIEW" | null;
  automationReason?: string | null;
  directActionAvailable?: boolean;
};

const FINAL_MONITORING_STATES = new Set([
  "FINAL_MANUAL",
  "FINAL_TECHNICAL",
  "FINAL_IDENTITY"
]);

const FINAL_MONITORING_DISPOSITIONS = new Set<MonitoringDisposition>([
  "MANUAL_FINAL",
  "TECHNICAL_FINAL",
  "IDENTITY_FINAL"
]);

const MONITORED_OUTCOMES = new Set(["MATCH_FOUND", "NO_MATCH"]);
const DIRECT_ACTION_OUTCOMES = new Set([
  "MANUAL_DIRECT",
  "IDENTITY_FINAL",
  "BLOCKED_AUTH"
]);
const RETRYING_OUTCOMES = new Set([
  "NEEDS_ADAPTER",
  "FETCH_FAILED",
  "BLOCKED_TOOLING"
]);

export function getCustomerMonitoringStatus(
  input: CustomerMonitoringStatusInput
): CustomerMonitoringStatus {
  const escalationDeadlineReached = Boolean(
    input.incidentStatus === "AUTO_INVESTIGATING" &&
      input.escalationDeadlineAt &&
      input.escalationDeadlineAt.getTime() <= (input.now ?? new Date()).getTime()
  );
  if (
    (input.monitoringState && FINAL_MONITORING_STATES.has(input.monitoringState)) ||
    (input.monitoringDisposition &&
      FINAL_MONITORING_DISPOSITIONS.has(input.monitoringDisposition)) ||
    (input.outcome && DIRECT_ACTION_OUTCOMES.has(input.outcome))
  ) {
    return "FINAL_DIRECT_ACTION";
  }

  if (
    input.monitoringState === "ENGINEERING_VERIFICATION_NEEDED" ||
    input.incidentStatus === "NEEDS_HUMAN" ||
    input.humanReviewReason === "AUTOMATION_STALLED" ||
    escalationDeadlineReached ||
    input.supportStatus === "NEEDS_HUMAN_REVIEW"
  ) {
    return "NEEDS_HUMAN_REVIEW";
  }

  if (input.directActionAvailable === true) {
    return "FINAL_DIRECT_ACTION";
  }

  if (
    input.monitoringState === "HEALTHY" ||
    (input.outcome && MONITORED_OUTCOMES.has(input.outcome))
  ) {
    return "MONITORED";
  }

  if (
    input.monitoringState === "DEGRADED_RETRYING" ||
    input.monitoringState === "AUTO_INVESTIGATING" ||
    input.incidentStatus === "AUTO_INVESTIGATING" ||
    input.automationReason === "TEMPORARILY_UNAVAILABLE" ||
    (input.outcome && RETRYING_OUTCOMES.has(input.outcome))
  ) {
    return "RETRYING_AUTOMATICALLY";
  }

  return "CHECKING";
}

export function isCustomerMonitoringStatusReportable(
  status: CustomerMonitoringStatus
) {
  return CUSTOMER_MONITORING_STATUSES.includes(status);
}

export function isCustomerMonitoringStatusFinalized(
  status: CustomerMonitoringStatus
) {
  return status !== "CHECKING";
}

export function isEffectiveCustomerMonitoring(
  status: CustomerMonitoringStatus
) {
  return status === "MONITORED";
}

export function isFactualCustomerFinality(status: CustomerMonitoringStatus) {
  return status === "FINAL_DIRECT_ACTION";
}
