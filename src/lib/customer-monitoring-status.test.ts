import { describe, expect, it } from "vitest";

import {
  getCustomerMonitoringStatus,
  hasDurableAutomationStalledEndpointProof,
  hasDurableWaitForMaterialChangeProof,
  isCustomerMonitoringStatusFinalized,
  isCustomerMonitoringStatusReportable,
  isEffectiveCustomerMonitoring,
  isFactualCustomerFinality
} from "./customer-monitoring-status";

describe("customer monitoring status", () => {
  it("keeps an active public-page check in checking", () => {
    const status = getCustomerMonitoringStatus({ outcome: "CHECK_PENDING" });

    expect(status).toBe("CHECKING");
    expect(isCustomerMonitoringStatusReportable(status)).toBe(true);
    expect(isCustomerMonitoringStatusFinalized(status)).toBe(false);
  });

  it("treats successful signed-out observations as monitored", () => {
    for (const outcome of ["MATCH_FOUND", "NO_MATCH"]) {
      const status = getCustomerMonitoringStatus({ outcome });
      expect(status).toBe("MONITORED");
      expect(isEffectiveCustomerMonitoring(status)).toBe(true);
    }
  });

  it("keeps unsupported and failed reads retryable until human review is explicit", () => {
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "AUTO_INVESTIGATING"
      })
    ).toBe("RETRYING_AUTOMATICALLY");
    expect(getCustomerMonitoringStatus({ outcome: "FETCH_FAILED" })).toBe(
      "RETRYING_AUTOMATICALLY"
    );
    expect(
      getCustomerMonitoringStatus({
        automationReason: "TEMPORARILY_UNAVAILABLE"
      })
    ).toBe("RETRYING_AUTOMATICALLY");
    expect(
      getCustomerMonitoringStatus({
        outcome: "CHECK_PENDING",
        supportStatus: "IN_OPERATOR_QUEUE"
      })
    ).toBe("RETRYING_AUTOMATICALLY");
  });

  it("uses a distinct human-review state", () => {
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "NEEDS_HUMAN",
        automationPlaybookExhausted: true
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        supportStatus: "NEEDS_HUMAN_REVIEW",
        automationPlaybookExhausted: true
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "AUTO_INVESTIGATING",
        humanReviewReason: "AUTOMATION_STALLED",
        automationPlaybookExhausted: true
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
  });

  it("derives human review at the incident deadline before watchdog persistence", () => {
    const deadline = new Date("2026-08-10T14:30:00.000Z");

    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "AUTO_INVESTIGATING",
        escalationDeadlineAt: deadline,
        automationPlaybookExhausted: true,
        now: new Date("2026-08-10T14:29:59.999Z")
      })
    ).toBe("RETRYING_AUTOMATICALLY");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "AUTO_INVESTIGATING",
        escalationDeadlineAt: deadline,
        now: deadline
      })
    ).toBe("RETRYING_AUTOMATICALLY");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "AUTO_INVESTIGATING",
        escalationDeadlineAt: deadline,
        automationPlaybookExhausted: true,
        now: deadline
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
  });

  it("requires durable endpoint proof before an unexhausted automation stall becomes human review", () => {
    const deadline = new Date("2026-08-10T14:30:00.000Z");

    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        monitoringState: "ENGINEERING_VERIFICATION_NEEDED",
        incidentStatus: "AUTO_INVESTIGATING",
        humanReviewReason: "AUTOMATION_STALLED",
        incidentEscalatedAt: deadline,
        escalationDeadlineAt: deadline,
        automationPlaybookExhausted: false,
        now: deadline
      })
    ).toBe("RETRYING_AUTOMATICALLY");
    const stalled = getCustomerMonitoringStatus({
      outcome: "NEEDS_ADAPTER",
      monitoringState: "ENGINEERING_VERIFICATION_NEEDED",
      incidentStatus: "AUTO_INVESTIGATING",
      humanReviewReason: "AUTOMATION_STALLED",
      incidentEscalatedAt: deadline,
      escalationDeadlineAt: deadline,
      automationPlaybookExhausted: false,
      automationStalledAtEndpoint: true,
      now: deadline
    });
    expect(stalled).toBe("NEEDS_HUMAN_REVIEW");
    expect(isCustomerMonitoringStatusFinalized(stalled)).toBe(true);
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        monitoringState: "ENGINEERING_VERIFICATION_NEEDED",
        incidentStatus: "NEEDS_HUMAN",
        incidentEscalatedAt: deadline,
        supportStatus: "NEEDS_HUMAN_REVIEW"
      })
    ).toBe("RETRYING_AUTOMATICALLY");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "AUTO_INVESTIGATING",
        incidentEscalatedAt: deadline,
        automationPlaybookExhausted: false
      })
    ).toBe("RETRYING_AUTOMATICALLY");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "AUTO_INVESTIGATING",
        incidentEscalatedAt: deadline,
        automationPlaybookExhausted: true
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
  });

  it("recognizes only a current exact automation-stalled endpoint event", () => {
    const deadline = new Date("2026-08-10T14:30:00.000Z");
    const event = {
      incidentId: "incident-1",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: deadline,
      audit: {
        cycle: 3,
        customerState: "NEEDS_HUMAN_REVIEW",
        automationStalled: true,
        playbookExhausted: false,
        escalationDeadlineAt: deadline.toISOString()
      }
    };
    const input = {
      incidentId: "incident-1",
      incidentCycle: 3,
      incidentStatus: "AUTO_INVESTIGATING" as const,
      humanReviewReason: "AUTOMATION_STALLED",
      incidentEscalatedAt: deadline,
      escalationDeadlineAt: deadline,
      monitoringState: "ENGINEERING_VERIFICATION_NEEDED" as const,
      endpointEvents: [event]
    };

    expect(hasDurableAutomationStalledEndpointProof(input)).toBe(true);
    expect(
      hasDurableAutomationStalledEndpointProof({
        ...input,
        endpointEvents: [
          {
            ...event,
            occurredAt: new Date(deadline.getTime() - 1)
          }
        ]
      })
    ).toBe(false);
    expect(
      hasDurableAutomationStalledEndpointProof({
        ...input,
        incidentCycle: 4
      })
    ).toBe(false);
    expect(
      hasDurableAutomationStalledEndpointProof({
        ...input,
        endpointEvents: [
          {
            ...event,
            audit: { ...event.audit, automationStalled: false }
          }
        ]
      })
    ).toBe(false);
  });

  it("recognizes a current cycle-scoped material-change parking event", () => {
    const escalatedAt = new Date("2026-08-10T14:00:00.000Z");
    const parkedAt = new Date("2026-08-10T14:30:00.000Z");
    const event = {
      incidentId: "incident-1",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: parkedAt,
      audit: {
        cycle: 3,
        customerState: "NEEDS_HUMAN_REVIEW",
        automationStalled: true,
        parkedUntilMaterialChange: true
      }
    };
    const input = {
      incidentId: "incident-1",
      incidentCycle: 3,
      incidentStatus: "NEEDS_HUMAN" as const,
      humanReviewReason: "AUTOMATION_STALLED",
      incidentEscalatedAt: escalatedAt,
      escalationDeadlineAt: new Date("2026-08-10T20:00:00.000Z"),
      monitoringState: "ENGINEERING_VERIFICATION_NEEDED" as const,
      endpointEvents: [event]
    };

    expect(hasDurableWaitForMaterialChangeProof(input)).toBe(true);
    expect(hasDurableAutomationStalledEndpointProof(input)).toBe(true);
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        monitoringState: input.monitoringState,
        incidentStatus: input.incidentStatus,
        humanReviewReason: input.humanReviewReason,
        incidentEscalatedAt: input.incidentEscalatedAt,
        escalationDeadlineAt: input.escalationDeadlineAt,
        automationPlaybookExhausted: false,
        automationStalledAtEndpoint:
          hasDurableAutomationStalledEndpointProof(input),
        now: parkedAt
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
    expect(
      hasDurableWaitForMaterialChangeProof({
        ...input,
        incidentCycle: 4
      })
    ).toBe(false);
    expect(
      hasDurableWaitForMaterialChangeProof({
        ...input,
        endpointEvents: [
          {
            ...event,
            audit: { ...event.audit, parkedUntilMaterialChange: false }
          }
        ]
      })
    ).toBe(false);
  });

  it("recognizes explicit account-required parking without treating it as automation stalled", () => {
    const parkedAt = new Date("2026-08-18T17:30:00.000Z");
    const input = {
      incidentId: "incident-account",
      incidentCycle: 2,
      incidentStatus: "NEEDS_HUMAN" as const,
      humanReviewReason: "ACCOUNT_REQUIRED",
      incidentEscalatedAt: parkedAt,
      monitoringState: "ENGINEERING_VERIFICATION_NEEDED" as const,
      endpointEvents: [
        {
          incidentId: "incident-account",
          eventType: "HUMAN_REVIEW_REQUESTED",
          occurredAt: parkedAt,
          audit: {
            cycle: 2,
            customerState: "NEEDS_HUMAN_REVIEW",
            humanReviewReason: "ACCOUNT_REQUIRED",
            automaticRetrySuppressed: true,
            parkedUntilMaterialChange: true,
          },
        },
      ],
    };

    expect(hasDurableWaitForMaterialChangeProof(input)).toBe(true);
    expect(hasDurableAutomationStalledEndpointProof(input)).toBe(true);
  });

  it("does not let an older success mask an unproven automation incident", () => {
    const stateChangedAt = new Date("2026-08-10T14:20:00.000Z");

    expect(
      getCustomerMonitoringStatus({
        outcome: "NO_MATCH",
        outcomeObservedAt: new Date("2026-08-10T14:10:00.000Z"),
        monitoringState: "ENGINEERING_VERIFICATION_NEEDED",
        monitoringStateChangedAt: stateChangedAt,
        incidentStatus: "AUTO_INVESTIGATING",
        automationPlaybookExhausted: false
      })
    ).toBe("RETRYING_AUTOMATICALLY");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NO_MATCH",
        outcomeObservedAt: new Date("2026-08-10T14:21:00.000Z"),
        monitoringState: "ENGINEERING_VERIFICATION_NEEDED",
        monitoringStateChangedAt: stateChangedAt,
        incidentStatus: "AUTO_INVESTIGATING",
        automationPlaybookExhausted: false
      })
    ).toBe("MONITORED");
  });

  it("keeps human review customer-visible through unresolved internal revalidation", () => {
    const escalatedAt = new Date("2026-08-10T14:30:00.000Z");

    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "AUTO_INVESTIGATING",
        incidentEscalatedAt: escalatedAt,
        automationPlaybookExhausted: true,
        escalationDeadlineAt: new Date("2026-08-10T21:00:00.000Z"),
        now: new Date("2026-08-10T15:00:00.000Z")
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NO_MATCH",
        monitoringState: "HEALTHY",
        incidentStatus: "RESOLVED",
        incidentEscalatedAt: escalatedAt
      })
    ).toBe("MONITORED");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NO_MATCH",
        incidentStatus: "RESOLVED",
        incidentEscalatedAt: escalatedAt,
        supportStatus: "NEEDS_HUMAN_REVIEW"
      })
    ).toBe("MONITORED");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NO_MATCH",
        monitoringState: "AUTO_INVESTIGATING",
        incidentStatus: "AUTO_INVESTIGATING",
        incidentEscalatedAt: escalatedAt,
        automationPlaybookExhausted: true,
        outcomeObservedAt: new Date("2026-08-10T14:29:59.000Z")
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NO_MATCH",
        monitoringState: "HEALTHY",
        monitoringStateChangedAt: new Date("2026-08-10T14:29:00.000Z"),
        incidentStatus: "AUTO_INVESTIGATING",
        incidentEscalatedAt: escalatedAt,
        automationPlaybookExhausted: true,
        outcomeObservedAt: new Date("2026-08-10T14:29:00.000Z")
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NO_MATCH",
        monitoringState: "HEALTHY",
        monitoringStateChangedAt: new Date("2026-08-10T14:31:00.000Z"),
        incidentStatus: "AUTO_INVESTIGATING",
        incidentEscalatedAt: escalatedAt,
        outcomeObservedAt: new Date("2026-08-10T14:31:00.000Z")
      })
    ).toBe("MONITORED");
  });

  it("reserves factual finality for verified direct-action states", () => {
    for (const monitoringDisposition of [
      "MANUAL_FINAL",
      "TECHNICAL_FINAL",
      "IDENTITY_FINAL"
    ] as const) {
      const status = getCustomerMonitoringStatus({ monitoringDisposition });
      expect(status).toBe("FINAL_DIRECT_ACTION");
      expect(isFactualCustomerFinality(status)).toBe(true);
    }
    expect(getCustomerMonitoringStatus({ directActionAvailable: true })).toBe(
      "FINAL_DIRECT_ACTION"
    );
  });

  it("does not let a stale human incident override a durable final state", () => {
    expect(
      getCustomerMonitoringStatus({
        monitoringState: "FINAL_TECHNICAL",
        incidentStatus: "NEEDS_HUMAN"
      })
    ).toBe("FINAL_DIRECT_ACTION");
  });
});
