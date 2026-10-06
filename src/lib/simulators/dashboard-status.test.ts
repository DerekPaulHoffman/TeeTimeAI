import { describe, expect, it } from "vitest";
import { getSimulatorAlertSummary, getSimulatorDashboardStatus } from "./dashboard-status";
import { getSimulatorOfferingSourceFingerprint } from "./source-fingerprint";

const now = new Date("2026-10-06T18:00:00Z");
const observedAt = new Date("2026-10-06T17:59:00Z");

function fixture(outcome?: string) {
  const offering = {
    kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC", bookingUrl: "https://official.example/booking",
    evidenceUrl: "https://official.example/rentals", verifiedAt: observedAt, providerFamilyKey: "TEST",
    providerMetadata: { location: "first" }, maxPartySize: 6, supportedDurationsMinutes: [60],
    bookingWindowDaysAhead: null, bookingReleaseTimeLocal: null, monitoringMode: "AUTOMATIC",
    automationEligibility: "ALLOWED", monitoringState: "HEALTHY", monitoringVerifiedAt: observedAt,
    lastFailureAt: null as Date | null, observationToken: null as string | null,
  };
  return {
    offering, alertStatus: "ACTIVE", windowEnded: false, website: "https://official.example/venue", now,
    currentMatchCount: 0,
    ...(outcome ? { probe: { outcome, observedAt, rawSummary: {
      mode: "SIMULATOR", sourceFingerprint: getSimulatorOfferingSourceFingerprint(offering),
      providerObservedAt: observedAt.toISOString(),
    } } } : {}),
  };
}

describe("simulator dashboard status", () => {
  it("distinguishes the first pending check from persisted support work", () => {
    expect(getSimulatorDashboardStatus(fixture()).label).toBe("Simulator check pending");
    const input = fixture("NEEDS_ADAPTER");
    input.offering.monitoringState = "VERIFYING";
    expect(getSimulatorDashboardStatus(input).label).toBe("Adding alert support");
    input.offering.monitoringState = "DEGRADED_RETRYING";
    expect(getSimulatorDashboardStatus(input).label).toBe("Adding alert support");
  });

  it("shows retrying after a current fetch failure", () => {
    expect(getSimulatorDashboardStatus(fixture("FETCH_FAILED")).label).toBe("Availability check will retry");
  });

  it("uses the venue's official site while rental details are unknown", () => {
    const input = fixture("NEEDS_ADAPTER");
    const pending = { ...input, offering: { ...input.offering, publicAccessStatus: "UNVERIFIED", bookingUrl: null,
      evidenceUrl: null, verifiedAt: null, monitoringState: "VERIFYING", monitoringVerifiedAt: null } };
    pending.probe!.rawSummary.sourceFingerprint = getSimulatorOfferingSourceFingerprint(pending.offering);
    expect(getSimulatorDashboardStatus(pending)).toEqual({ kind: "ADDING_SUPPORT", label: "Adding alert support",
      officialUrl: input.website, officialLinkLabel: "Official site" });
    expect(getSimulatorDashboardStatus({ ...pending, offering: null, probe: undefined }).officialUrl).toBe(input.website);
    expect(getSimulatorDashboardStatus({ ...pending, offering: null, website: null }).officialUrl).toBeNull();
  });

  it("labels only verified rental URLs as official booking pages", () => {
    expect(getSimulatorDashboardStatus(fixture()).officialLinkLabel).toBe("Official booking page");
    const input = fixture();
    expect(getSimulatorDashboardStatus({ ...input, offering: { ...input.offering, verifiedAt: null } }).officialLinkLabel).toBe("Official site");
    expect(getSimulatorDashboardStatus({ ...input, offering: { ...input.offering, verifiedAt: new Date("2026-10-07T18:00:00Z") } }).officialLinkLabel).toBe("Official site");
  });

  it.each([
    "javascript:alert(1)", "http://192.168.1.4/rentals", "https://reader:secret@official.example/booking",
    "https://accountrecovery.official.example/booking", "https://official.example/member-portal/booking",
    "https://official.example/booking?access_token=private",
  ])("omits unsafe saved links and uses only a safe venue fallback: %s", (unsafeUrl) => {
    const input = fixture();
    input.offering.bookingUrl = unsafeUrl;
    const safeFallback = getSimulatorDashboardStatus(input);
    expect(safeFallback.officialUrl).toBe(input.website);
    expect(safeFallback.officialLinkLabel).toBe("Official site");
    expect(getSimulatorDashboardStatus({ ...input, website: unsafeUrl }).officialUrl).toBeNull();
    expect(getSimulatorDashboardStatus({ ...input, offering: null, website: unsafeUrl }).officialUrl).toBeNull();
  });

  it("shows matching sessions and no-match only with fresh source proof", () => {
    expect(getSimulatorDashboardStatus(fixture("NO_MATCH")).label).toBe("Checked · No matching sessions");
    expect(getSimulatorDashboardStatus({ ...fixture("MATCH_FOUND"), currentMatchCount: 1 }).label).toBe("Matching simulator sessions available");
    expect(getSimulatorDashboardStatus(fixture("MATCH_FOUND")).label).toBe("Simulator check pending");
  });

  it.each([
    { monitoringState: "VERIFYING" }, { observationToken: "another-read" }, { monitoringVerifiedAt: new Date("2026-10-06T17:00:00Z") },
    { lastFailureAt: now }, { automationEligibility: "UNKNOWN" }, { providerMetadata: { location: "changed" } },
  ])("does not turn stale, changed or unconfirmed proof into current availability: %j", (changes) => {
    const input = fixture("NO_MATCH");
    expect(getSimulatorDashboardStatus({ ...input, offering: { ...input.offering, ...changes } }).label).toBe("Simulator check pending");
  });

  it("does not reuse success or support outcomes from a different source", () => {
    for (const outcome of ["NO_MATCH", "MATCH_FOUND", "NEEDS_ADAPTER", "FETCH_FAILED"]) {
      const input = fixture(outcome);
      input.offering.providerMetadata = { location: "changed" };
      expect(getSimulatorDashboardStatus({ ...input, currentMatchCount: 1 }).label).toBe("Simulator check pending");
    }
    expect(getSimulatorDashboardStatus({ ...fixture("NO_MATCH"), now: new Date("2026-10-06T19:00:00Z") }).label).toBe("Simulator check pending");
  });

  it("uses only a future booking opening for booking-window guidance", () => {
    const input = fixture("NO_MATCH");
    Object.assign(input.probe!.rawSummary, { bookingNotOpen: true, opensAt: "2026-10-07T18:00:00Z" });
    expect(getSimulatorDashboardStatus(input).label).toBe("The public booking window has not opened yet.");
    Object.assign(input.probe!.rawSummary, { opensAt: "2026-10-05T18:00:00Z" });
    expect(getSimulatorDashboardStatus(input).label).toBe("Checked · No matching sessions");
  });

  it("requires current rental and source proof before claiming booking has not opened", () => {
    const input = fixture("NO_MATCH");
    Object.assign(input.probe!.rawSummary, { bookingNotOpen: true, opensAt: "2026-10-07T18:00:00Z" });
    input.offering.providerMetadata = { location: "changed" };
    expect(getSimulatorDashboardStatus(input).label).toBe("Simulator check pending");
    input.probe!.rawSummary.sourceFingerprint = getSimulatorOfferingSourceFingerprint(input.offering);
    expect(getSimulatorDashboardStatus(input).label).toBe("The public booking window has not opened yet.");
    expect(getSimulatorDashboardStatus({ ...input, offering: { ...input.offering, verifiedAt: null } }).label).toBe("Simulator check pending");
    Object.assign(input.probe!.rawSummary, { sourceFingerprint: undefined });
    expect(getSimulatorDashboardStatus(input).label).toBe("Simulator check pending");
  });

  it.each(["FINAL_TECHNICAL", "FINAL_IDENTITY"])("provides official-site guidance after %s", (monitoringState) => {
    const input = fixture("NEEDS_ADAPTER");
    input.offering.monitoringState = monitoringState;
    const status = getSimulatorDashboardStatus(input);
    expect(status.label).toContain("Check the official site");
    expect(status.label).not.toMatch(/pending|retry|Adding alert support/);
    expect(status.officialLinkLabel).toBe("Official site");
  });

  it("respects durable direct and identity outcomes", () => {
    expect(getSimulatorDashboardStatus(fixture("MANUAL_DIRECT")).label).toContain("Simulator alerts aren’t available here");
    expect(getSimulatorDashboardStatus(fixture("IDENTITY_FINAL")).label).toContain("Public simulator rentals aren’t available here");
    expect(getSimulatorDashboardStatus(fixture("MANUAL_DIRECT")).officialLinkLabel).toBe("Official site");
    expect(getSimulatorDashboardStatus(fixture("IDENTITY_FINAL")).officialLinkLabel).toBe("Official site");
  });

  it("uses verified venue status for a single simulator alert header", () => {
    expect(getSimulatorAlertSummary([getSimulatorDashboardStatus(fixture())])).toBe("Simulator check pending");
    expect(getSimulatorAlertSummary([getSimulatorDashboardStatus(fixture("NEEDS_ADAPTER"))])).toBe("Adding alert support");
    expect(getSimulatorAlertSummary([getSimulatorDashboardStatus(fixture("MANUAL_DIRECT"))])).toContain("Simulator alerts aren’t available");
    expect(getSimulatorAlertSummary([getSimulatorDashboardStatus(fixture("NO_MATCH"))])).toBe("Checked · No matching sessions");
    expect(getSimulatorAlertSummary([getSimulatorDashboardStatus({ ...fixture("MATCH_FOUND"), currentMatchCount: 1 })])).toBe("Matching simulator sessions available");
    expect(getSimulatorAlertSummary([getSimulatorDashboardStatus({ ...fixture("NO_MATCH"), alertStatus: "COMPLETED" })])).toBe("Checks stopped");
  });

  it("does not summarize mixed pending or unavailable venues as current monitoring", () => {
    const pending = getSimulatorDashboardStatus(fixture());
    const healthy = getSimulatorDashboardStatus(fixture("NO_MATCH"));
    const unavailable = getSimulatorDashboardStatus(fixture("MANUAL_DIRECT"));
    expect(getSimulatorAlertSummary([pending, healthy])).toBe("Simulator checks pending");
    expect(getSimulatorAlertSummary([unavailable, healthy])).toBe("Some simulator alerts unavailable");
    expect(getSimulatorAlertSummary([healthy, healthy])).toBe("Checked · No matching sessions");
    const scheduled = fixture("NO_MATCH");
    Object.assign(scheduled.probe!.rawSummary, { bookingNotOpen: true, opensAt: "2026-10-07T18:00:00Z" });
    expect(getSimulatorAlertSummary([getSimulatorDashboardStatus(scheduled), healthy])).toBe("Simulator checks pending");
  });

  it.each(["PAUSED", "COMPLETED", "CANCELLED"])("does not promise active checks for %s", (alertStatus) => {
    for (const outcome of ["NEEDS_ADAPTER", "FETCH_FAILED", "NO_MATCH", "MATCH_FOUND"]) {
      expect(getSimulatorDashboardStatus({ ...fixture(outcome), alertStatus, currentMatchCount: 1 }).label)
        .toBe(alertStatus === "PAUSED" ? "Notifications paused" : "Checks stopped");
    }
    expect(getSimulatorDashboardStatus({ ...fixture("NEEDS_ADAPTER"), alertStatus, windowEnded: true }).label).toBe("Search window ended");
  });
});
