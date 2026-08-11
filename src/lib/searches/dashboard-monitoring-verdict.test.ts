import { describe, expect, it } from "vitest";

import { getDashboardMonitoringVerdict } from "./dashboard-monitoring-verdict";

const base = {
  alertSupport: null,
  automationEligibility: "UNKNOWN",
  automationReason: "NONE",
  upcomingBookingWindow: null,
  firstTimeLookup: false
} as const;

describe("dashboard monitoring verdict", () => {
  it("shows successful checks as monitored", () => {
    expect(
      getDashboardMonitoringVerdict({
        ...base,
        latestProbe: { outcome: "NO_MATCH", observedAt: new Date() }
      }).label
    ).toBe("Tee-time alerts available");
  });

  it("shows automatic investigation as retrying, not final", () => {
    const verdict = getDashboardMonitoringVerdict({
      ...base,
      latestProbe: { outcome: "NEEDS_ADAPTER", observedAt: new Date() },
      supportIncidentStatus: "AUTO_INVESTIGATING"
    });

    expect(verdict.label).toBe("Automatic checks are still retrying");
    expect(verdict.detail).toContain("Your alert remains active");
    expect(verdict.detail).toContain("official site");
  });

  it("uses the required customer-safe manual-review copy", () => {
    const verdict = getDashboardMonitoringVerdict({
      ...base,
      latestProbe: { outcome: "NEEDS_ADAPTER", observedAt: new Date() },
      supportIncidentStatus: "NEEDS_HUMAN"
    });

    expect(verdict.label).toBe("Manual review needed");
    expect(verdict.detail).toContain(
      "Manual review needed; your alert remains active"
    );
    expect(verdict.detail).toContain("official site");
    expect(verdict.detail).not.toMatch(/engineering|adapter|automation incident/i);
  });

  it("shows an incomplete thirty-minute automation stall as manual review without falsely closing the incident", () => {
    const verdict = getDashboardMonitoringVerdict({
      ...base,
      latestProbe: { outcome: "NEEDS_ADAPTER", observedAt: new Date() },
      supportIncidentStatus: "AUTO_INVESTIGATING",
      humanReviewReason: "AUTOMATION_STALLED"
    });

    expect(verdict.label).toBe("Manual review needed");
    expect(verdict.detail).toContain(
      "Manual review needed; your alert remains active"
    );
  });

  it("shows manual review at the deadline before the watchdog writes its reason", () => {
    const deadline = new Date("2026-08-10T14:30:00.000Z");
    const verdict = getDashboardMonitoringVerdict({
      ...base,
      latestProbe: { outcome: "NEEDS_ADAPTER", observedAt: deadline },
      supportIncidentStatus: "AUTO_INVESTIGATING",
      escalationDeadlineAt: deadline,
      now: deadline
    });

    expect(verdict.label).toBe("Manual review needed");
    expect(verdict.detail).toContain(
      "Manual review needed; your alert remains active"
    );
  });

  it("keeps verified direct actions distinct from human review", () => {
    const verdict = getDashboardMonitoringVerdict({
      ...base,
      alertSupport: "PHONE_ONLY",
      bookingPhone: "555-0100",
      latestProbe: { outcome: "MANUAL_DIRECT", observedAt: new Date() }
    });

    expect(verdict.label).toBe("Call the course");
    expect(verdict.detail).toContain("555-0100");
  });

  it("shows course-snapshot direct guidance before the first probe", () => {
    const verdict = getDashboardMonitoringVerdict({
      ...base,
      alertSupport: "ACCOUNT_REQUIRED"
    });

    expect(verdict.label).toBe("Sign in on the official site");
  });
});
