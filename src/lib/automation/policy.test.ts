import { describe, expect, it } from "vitest";

import {
  evaluateAutomationPolicy,
  evaluateMonitoringGate
} from "./policy";

describe("evaluateAutomationPolicy", () => {
  it("does not treat a booking automation prohibition as a public read blocker", () => {
    const result = evaluateAutomationPolicy({
      automationEligibility: "ALLOWED",
      termsText: "No bots, scripts, or automated tee time booking may access this service.",
      intendedAction: "ALERT_ONLY"
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toMatch(/does not block/i);
  });

  it("revalidates a stored block instead of trusting it as a policy decision", () => {
    const result = evaluateAutomationPolicy({
      automationEligibility: "BLOCKED",
      termsText: "Automated reservations are prohibited.",
      intendedAction: "ALERT_ONLY"
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toMatch(/public tee-time availability/i);
  });

  it("keeps policy-only and generic blocked state actionable", () => {
    expect(
      evaluateMonitoringGate({
        automationEligibility: "BLOCKED",
        automationReason: "AUTOMATION_PROHIBITED",
        bookingMethod: "PUBLIC_ONLINE"
      })
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
    expect(
      evaluateMonitoringGate({
        bookingMethod: "UNKNOWN",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        intelligenceVerifiedAt: new Date("2026-07-16T11:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        now: new Date("2026-07-16T12:00:00.000Z")
      })
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
    expect(
      evaluateMonitoringGate({
        automationEligibility: "BLOCKED",
        automationReason: "NONE",
        bookingMethod: "PUBLIC_ONLINE"
      })
    ).toMatchObject({ disposition: "ACTIONABLE", requiresRevalidation: true });
  });

  it("requires current verified evidence for account or captcha finals", () => {
    const base = {
      automationEligibility: "BLOCKED" as const,
      automationReason: "ACCOUNT_REQUIRED" as const,
      bookingMethod: "PUBLIC_ONLINE" as const,
      intelligenceConfidence: 0.95,
      now: new Date("2026-07-16T12:00:00.000Z")
    };

    expect(evaluateMonitoringGate(base)).toMatchObject({
      disposition: "ACTIONABLE",
      adapterAllowed: true
    });
    expect(
      evaluateMonitoringGate({
        ...base,
        intelligenceVerifiedAt: new Date("2026-07-16T11:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z")
      })
    ).toMatchObject({ disposition: "TECHNICAL_FINAL", adapterAllowed: false });
  });

  it("requires a coherent current classification for manual finals", () => {
    expect(
      evaluateMonitoringGate({ bookingMethod: "PHONE_ONLY", isPublic: true })
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
    expect(
      evaluateMonitoringGate({
        bookingMethod: "PHONE_ONLY",
        isPublic: true,
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        intelligenceVerifiedAt: new Date("2026-07-16T11:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        now: new Date("2026-07-16T12:00:00.000Z")
      })
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
    expect(
      evaluateMonitoringGate({
        bookingMethod: "PHONE_ONLY",
        isPublic: true,
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        intelligenceVerifiedAt: new Date("2026-07-16T11:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        now: new Date("2026-07-16T12:00:00.000Z")
      })
    ).toMatchObject({ disposition: "MANUAL_FINAL", adapterAllowed: false });
    expect(
      evaluateMonitoringGate({
        bookingMethod: "WALK_IN",
        automationEligibility: "ALLOWED",
        automationReason: "NO_ONLINE_BOOKING",
        finalClassification: true,
        intelligenceVerifiedAt: new Date("2026-07-16T11:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        now: new Date("2026-07-16T12:00:00.000Z")
      })
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
  });

  it("rejects stale or invalid terminal review dates", () => {
    const base = {
      bookingMethod: "CONTACT_COURSE" as const,
      automationEligibility: "BLOCKED" as const,
      automationReason: "NO_ONLINE_BOOKING" as const,
      intelligenceVerifiedAt: new Date("2026-07-16T11:00:00.000Z"),
      intelligenceConfidence: 0.95,
      now: new Date("2026-07-16T12:00:00.000Z")
    };

    expect(
      evaluateMonitoringGate({ ...base, intelligenceReviewAt: "not-a-date" })
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
    expect(
      evaluateMonitoringGate({
        ...base,
        intelligenceReviewAt: new Date("2026-07-15T00:00:00.000Z")
      })
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
  });

  it("keeps private identities out of adapter execution", () => {
    expect(evaluateMonitoringGate({ isPublic: false })).toMatchObject({
      disposition: "IDENTITY_FINAL",
      adapterAllowed: false
    });
  });
});
