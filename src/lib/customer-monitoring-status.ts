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
  monitoringStateChangedAt?: Date | null;
  incidentStatus?: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED" | null;
  humanReviewReason?: string | null;
  incidentEscalatedAt?: Date | null;
  outcomeObservedAt?: Date | null;
  escalationDeadlineAt?: Date | null;
  automationPlaybookExhausted?: boolean | null;
  automationStalledAtEndpoint?: boolean | null;
  now?: Date;
  supportStatus?: "IN_OPERATOR_QUEUE" | "NEEDS_HUMAN_REVIEW" | null;
  automationReason?: string | null;
  directActionAvailable?: boolean;
};

export type AutomationStalledEndpointEvent = {
  incidentId?: string | null;
  eventType?: string | null;
  occurredAt?: Date | null;
  audit?: unknown;
};

export type AutomationStalledEndpointProofInput = {
  incidentId?: string | null;
  incidentCycle?: number | null;
  incidentStatus?: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED" | null;
  humanReviewReason?: string | null;
  incidentEscalatedAt?: Date | null;
  escalationDeadlineAt?: Date | null;
  monitoringState?: CustomerMonitoringStatusInput["monitoringState"];
  endpointEvents?: readonly AutomationStalledEndpointEvent[] | null;
};

export function hasDurableWaitForMaterialChangeProof(
  input: AutomationStalledEndpointProofInput
) {
  if (
    !input.incidentId ||
    !Number.isInteger(input.incidentCycle) ||
    input.incidentStatus !== "NEEDS_HUMAN" ||
    !input.humanReviewReason ||
    input.monitoringState !== "ENGINEERING_VERIFICATION_NEEDED" ||
    !input.incidentEscalatedAt
  ) {
    return false;
  }
  const incidentEscalatedAt = input.incidentEscalatedAt;

  return Boolean(
    input.endpointEvents?.some((event) => {
      if (
        event.incidentId !== input.incidentId ||
        event.eventType !== "HUMAN_REVIEW_REQUESTED" ||
        !event.occurredAt ||
        event.occurredAt < incidentEscalatedAt ||
        !event.audit ||
        typeof event.audit !== "object" ||
        Array.isArray(event.audit)
      ) {
        return false;
      }
      const audit = event.audit as Record<string, unknown>;
      const automationStalledParking =
        input.humanReviewReason === "AUTOMATION_STALLED" &&
        audit.automationStalled === true;
      const explicitTechnicalParking =
        audit.humanReviewReason === input.humanReviewReason &&
        audit.automaticRetrySuppressed === true;
      return (
        audit.cycle === input.incidentCycle &&
        audit.customerState === "NEEDS_HUMAN_REVIEW" &&
        audit.parkedUntilMaterialChange === true &&
        (automationStalledParking || explicitTechnicalParking)
      );
    })
  );
}

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

export function hasDurableAutomationStalledEndpointProof(
  input: AutomationStalledEndpointProofInput
) {
  if (hasDurableWaitForMaterialChangeProof(input)) {
    return true;
  }
  if (
    !input.incidentId ||
    !Number.isInteger(input.incidentCycle) ||
    !["AUTO_INVESTIGATING", "NEEDS_HUMAN"].includes(input.incidentStatus ?? "") ||
    input.humanReviewReason !== "AUTOMATION_STALLED" ||
    input.monitoringState !== "ENGINEERING_VERIFICATION_NEEDED" ||
    !input.incidentEscalatedAt ||
    !input.escalationDeadlineAt ||
    input.incidentEscalatedAt < input.escalationDeadlineAt
  ) {
    return false;
  }

  const endpointAt = input.incidentEscalatedAt.getTime();
  const escalationDeadlineAt = input.escalationDeadlineAt;
  const deadlineIso = escalationDeadlineAt.toISOString();
  return Boolean(
    input.endpointEvents?.some((event) => {
      if (
        event.incidentId !== input.incidentId ||
        event.eventType !== "HUMAN_REVIEW_REQUESTED" ||
        !event.occurredAt ||
        event.occurredAt.getTime() !== endpointAt ||
        event.occurredAt < escalationDeadlineAt ||
        !event.audit ||
        typeof event.audit !== "object" ||
        Array.isArray(event.audit)
      ) {
        return false;
      }
      const audit = event.audit as Record<string, unknown>;
      return (
        audit.cycle === input.incidentCycle &&
        audit.customerState === "NEEDS_HUMAN_REVIEW" &&
        audit.automationStalled === true &&
        audit.playbookExhausted === false &&
        audit.escalationDeadlineAt === deadlineIso
      );
    })
  );
}

export function getCustomerMonitoringStatus(
  input: CustomerMonitoringStatusInput
): CustomerMonitoringStatus {
  const escalationDeadlineReached = Boolean(
    input.incidentStatus === "AUTO_INVESTIGATING" &&
    input.escalationDeadlineAt &&
    input.escalationDeadlineAt.getTime() <= (input.now ?? new Date()).getTime()
  );
  const unresolvedHumanReview = Boolean(
    input.incidentEscalatedAt &&
    input.incidentStatus &&
    input.incidentStatus !== "RESOLVED"
  );
  const automationHumanReviewProven =
    input.automationPlaybookExhausted === true ||
    input.automationStalledAtEndpoint === true;
  const unprovenAutomationEscalation = Boolean(
    !automationHumanReviewProven &&
    (input.monitoringState === "ENGINEERING_VERIFICATION_NEEDED" ||
      input.incidentStatus === "NEEDS_HUMAN" ||
      Boolean(input.humanReviewReason) ||
      unresolvedHumanReview ||
      escalationDeadlineReached ||
      input.supportStatus === "NEEDS_HUMAN_REVIEW")
  );
  const automationEscalationAnchors = [
    input.incidentEscalatedAt,
    input.monitoringState === "ENGINEERING_VERIFICATION_NEEDED" ||
    input.monitoringState === "AUTO_INVESTIGATING" ||
    input.monitoringState === "DEGRADED_RETRYING"
      ? input.monitoringStateChangedAt
      : null,
    escalationDeadlineReached ? input.escalationDeadlineAt : null
  ].filter((value): value is Date => value instanceof Date);
  const latestAutomationEscalationAt = automationEscalationAnchors.sort(
    (left, right) => right.getTime() - left.getTime()
  )[0];
  const freshMonitoredOutcome = Boolean(
    input.outcome &&
    MONITORED_OUTCOMES.has(input.outcome) &&
    input.outcomeObservedAt &&
    latestAutomationEscalationAt &&
    input.outcomeObservedAt >= latestAutomationEscalationAt
  );
  const freshHealthyState = Boolean(
    input.monitoringState === "HEALTHY" &&
    input.monitoringStateChangedAt &&
    input.incidentEscalatedAt &&
    input.monitoringStateChangedAt >= input.incidentEscalatedAt
  );
  if (
    (input.monitoringState &&
      FINAL_MONITORING_STATES.has(input.monitoringState)) ||
    (input.monitoringDisposition &&
      FINAL_MONITORING_DISPOSITIONS.has(input.monitoringDisposition)) ||
    (input.outcome && DIRECT_ACTION_OUTCOMES.has(input.outcome))
  ) {
    return "FINAL_DIRECT_ACTION";
  }

  // A fresh persisted success closes the customer-visible outage even when
  // incident closeout is still catching up behind the successful check.
  if (
    input.monitoringState === "HEALTHY" &&
    (!unresolvedHumanReview || freshHealthyState)
  ) {
    return "MONITORED";
  }
  if (unresolvedHumanReview && freshMonitoredOutcome) {
    return "MONITORED";
  }
  if (
    input.incidentStatus === "RESOLVED" &&
    input.outcome &&
    MONITORED_OUTCOMES.has(input.outcome)
  ) {
    return "MONITORED";
  }

  if (
    !unprovenAutomationEscalation &&
    (input.monitoringState === "ENGINEERING_VERIFICATION_NEEDED" ||
      input.incidentStatus === "NEEDS_HUMAN" ||
      input.supportStatus === "NEEDS_HUMAN_REVIEW" ||
      Boolean(input.humanReviewReason) ||
      unresolvedHumanReview ||
      escalationDeadlineReached)
  ) {
    return "NEEDS_HUMAN_REVIEW";
  }

  if (input.directActionAvailable === true) {
    return "FINAL_DIRECT_ACTION";
  }

  if (
    input.outcome &&
    MONITORED_OUTCOMES.has(input.outcome) &&
    (!unprovenAutomationEscalation || freshMonitoredOutcome)
  ) {
    return "MONITORED";
  }

  if (
    unprovenAutomationEscalation ||
    input.monitoringState === "DEGRADED_RETRYING" ||
    input.monitoringState === "AUTO_INVESTIGATING" ||
    input.incidentStatus === "AUTO_INVESTIGATING" ||
    input.supportStatus === "IN_OPERATOR_QUEUE" ||
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
