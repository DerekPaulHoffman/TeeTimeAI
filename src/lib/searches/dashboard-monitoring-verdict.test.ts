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
  it("does not describe reusable healthy course evidence as this request's completed check", () => {
    const verdict = getDashboardMonitoringVerdict({ ...base, monitoringState: "HEALTHY" });
    expect(verdict.detail).not.toContain("completed successfully");
    expect(verdict.icon).toBe("scheduled");
  });

  it("shows the current booking release before a check of edited settings exists", () => {
    const verdict = getDashboardMonitoringVerdict({ ...base, monitoringState: "HEALTHY", upcomingBookingWindow: { opensAt: "later" } });
    expect(verdict.label).toBe("Checks start when booking opens");
  });

  it("preserves current observed availability over contradictory booking-release metadata", () => {
    const verdict = getDashboardMonitoringVerdict({ ...base, monitoringState: "HEALTHY", upcomingBookingWindow: { opensAt: "later" }, latestProbe: { outcome: "MATCH_FOUND", observedAt: new Date() } });
    expect(verdict.label).toBe("Tee-time alerts available");
  });

  it("does not use reusable healthy state to override this request's current failure", () => {
    const verdict = getDashboardMonitoringVerdict({ ...base, monitoringState: "HEALTHY", latestProbe: { outcome: "FETCH_FAILED", observedAt: new Date() } });
    expect(verdict.label).toBe("Automatic checks are still retrying");
    expect(verdict.detail).not.toContain("completed successfully");
  });

  it.each(["PAUSED", "COMPLETED", "CANCELLED"])("never describes a %s alert as active or starting checks", (alertStatus) => {
    for (const input of [{}, { monitoringState: "AUTO_INVESTIGATING" as const }, { supportIncidentStatus: "NEEDS_HUMAN" as const, automationPlaybookExhausted: true }, { upcomingBookingWindow: { opensAt: "later" } }]) {
      const verdict = getDashboardMonitoringVerdict({ ...base, ...input, alertStatus });
      expect(verdict.detail).not.toMatch(/remains active|first check is starting|will begin checking/);
      expect(verdict.detail).toMatch(/paused|has ended/);
    }
  });
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
      supportIncidentStatus: "NEEDS_HUMAN",
      automationPlaybookExhausted: true
    });

    expect(verdict.label).toBe("Manual review needed");
    expect(verdict.detail).toContain(
      "Manual review needed; your alert remains active"
    );
    expect(verdict.detail).toContain("official site");
    expect(verdict.detail).not.toMatch(/engineering|adapter|automation incident/i);
  });

  it("shows an unexhausted stall only after its durable endpoint proof", () => {
    const unproven = getDashboardMonitoringVerdict({
      ...base,
      latestProbe: { outcome: "NEEDS_ADAPTER", observedAt: new Date() },
      supportIncidentStatus: "AUTO_INVESTIGATING",
      humanReviewReason: "AUTOMATION_STALLED",
      automationPlaybookExhausted: false
    });

    expect(unproven.label).toBe("Automatic checks are still retrying");
    expect(unproven.detail).toContain("Your alert remains active");

    const proven = getDashboardMonitoringVerdict({
      ...base,
      latestProbe: { outcome: "NEEDS_ADAPTER", observedAt: new Date() },
      monitoringState: "ENGINEERING_VERIFICATION_NEEDED",
      supportIncidentStatus: "AUTO_INVESTIGATING",
      humanReviewReason: "AUTOMATION_STALLED",
      automationPlaybookExhausted: false,
      automationStalledAtEndpoint: true
    });
    expect(proven.label).toBe("Manual review needed");
    expect(proven.detail).toContain("official site");
  });

  it("shows manual review at the deadline before the watchdog writes its reason", () => {
    const deadline = new Date("2026-08-10T14:30:00.000Z");
    const verdict = getDashboardMonitoringVerdict({
      ...base,
      latestProbe: { outcome: "NEEDS_ADAPTER", observedAt: deadline },
      supportIncidentStatus: "AUTO_INVESTIGATING",
      escalationDeadlineAt: deadline,
      automationPlaybookExhausted: true,
      now: deadline
    });

    expect(verdict.label).toBe("Manual review needed");
    expect(verdict.detail).toContain(
      "Manual review needed; your alert remains active"
    );
  });

  it("keeps an escalated revalidation in manual review until durable success", () => {
    const escalatedAt = new Date("2026-08-10T14:30:00.000Z");
    const revalidating = getDashboardMonitoringVerdict({
      ...base,
      latestProbe: { outcome: "NEEDS_ADAPTER", observedAt: escalatedAt },
      monitoringState: "AUTO_INVESTIGATING",
      supportIncidentStatus: "AUTO_INVESTIGATING",
      incidentEscalatedAt: escalatedAt,
      automationPlaybookExhausted: true
    });
    expect(revalidating.label).toBe("Manual review needed");

    const staleHealthy = getDashboardMonitoringVerdict({
      ...base,
      upcomingBookingWindow: { opensAt: "later" },
      latestProbe: {
        outcome: "NO_MATCH",
        observedAt: new Date("2026-08-10T14:29:00.000Z")
      },
      monitoringState: "HEALTHY",
      monitoringStateChangedAt: new Date("2026-08-10T14:29:00.000Z"),
      supportIncidentStatus: "AUTO_INVESTIGATING",
      incidentEscalatedAt: escalatedAt,
      automationPlaybookExhausted: true
    });
    expect(staleHealthy.label).toBe("Manual review needed");

    const recovered = getDashboardMonitoringVerdict({
      ...base,
      latestProbe: {
        outcome: "NO_MATCH",
        observedAt: new Date("2026-08-10T14:31:00.000Z")
      },
      monitoringState: "HEALTHY",
      monitoringStateChangedAt: new Date("2026-08-10T14:31:00.000Z"),
      supportIncidentStatus: "AUTO_INVESTIGATING",
      incidentEscalatedAt: escalatedAt
    });
    expect(recovered.label).toBe("Tee-time alerts available");
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
