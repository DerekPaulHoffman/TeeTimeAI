import { describe, expect, it } from "vitest";

import {
  getCustomerMonitoringStatus,
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
  });

  it("uses a distinct human-review state", () => {
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "NEEDS_HUMAN"
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        supportStatus: "NEEDS_HUMAN_REVIEW"
      })
    ).toBe("NEEDS_HUMAN_REVIEW");
    expect(
      getCustomerMonitoringStatus({
        outcome: "NEEDS_ADAPTER",
        incidentStatus: "AUTO_INVESTIGATING",
        humanReviewReason: "AUTOMATION_STALLED"
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
    ).toBe("NEEDS_HUMAN_REVIEW");
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
    expect(
      getCustomerMonitoringStatus({ directActionAvailable: true })
    ).toBe("FINAL_DIRECT_ACTION");
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
