import { describe, expect, it } from "vitest";
import { assertSimulatorEngineeringRuntime, deriveSimulatorEngineeringVerificationDate, evaluateSimulatorEngineeringVerification,
  readSimulatorEngineeringVerificationState, type SimulatorEngineeringVerificationState } from "./simulator-support-engineering-verification-policy";
import type { SimulatorSupportClaim } from "./simulator-support-policy";

const now = new Date("2026-10-08T15:00:00Z"), sha = "a".repeat(40), source = "b".repeat(64);
const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: sha,
  deployedAt: "2026-10-08T14:00:00Z", deploymentId: "dpl_test", deploymentUrl: "https://test.vercel.app", source: "git" as const, state: "READY" as const };
const claim: SimulatorSupportClaim = { token: "owner", revision: 3, phase: "VERIFYING", claimedAt: "2026-10-08T14:10:00Z",
  leaseExpiresAt: "2026-10-08T15:10:00Z", sourceFingerprint: source, originalSourceFingerprint: source, offeringRevision: 0,
  plannedPaths: [], releaseSha: sha, branch: "fix/monitoring", deployment: proof, recheckQueuedAt: null, verificationCycle: 0 };
export function engineState(): SimulatorEngineeringVerificationState {
  return { schemaVersion: 1, sourceFingerprint: source, runtimeVersion: sha, deploymentId: "dpl_test", startedAt: "2026-10-08T14:50:00Z",
    readsUsed: 2, inFlight: null, observations: [50, 55].map((minute, index) => ({ requestId: `read_${index}`, revision: index + 3,
      requestedDate: "2026-10-09", startedAt: `2026-10-08T14:${minute}:00Z`, expiresAt: `2026-10-08T14:${minute + 2}:00Z`,
      completedAt: `2026-10-08T14:${minute}:20Z`, providerObservedAt: `2026-10-08T14:${minute}:10Z`,
      outcome: "NO_MATCH", complete: true, slotCount: 0, failureCode: null })) };
}
function evaluate(state = engineState()) { return evaluateSimulatorEngineeringVerification({ now, claim, sourceFingerprint: source, state }); }

describe("independent simulator engineering evidence", () => {
  it("requires two genuine distinct fresh complete observations on exact source/runtime/deployment", () => {
    expect(readSimulatorEngineeringVerificationState(engineState())).toBeDefined();
    expect(evaluate()).toMatchObject({ freshSuccessfulChecks: 2, releaseReady: true, firstCheckReady: true });
    for (const field of ["sourceFingerprint", "runtimeVersion", "deploymentId"] as const) {
      const state = engineState(); state[field] = field === "deploymentId" ? "dpl_other" : "c".repeat(field === "runtimeVersion" ? 40 : 64);
      expect(evaluate(state).freshSuccessfulChecks, field).toBe(0);
    }
  });
  it("rejects newer incomplete, restricted, schema or booking-window failures instead of reusing older successes", () => {
    for (const failureCode of ["INCOMPLETE_READ", "PUBLIC_SESSION_REQUIRED", "SCHEMA_CHANGED", "BOOKING_NOT_OPEN"]) {
      const state = engineState(); Object.assign(state.observations[1], { outcome: "FETCH_FAILED", complete: false, providerObservedAt: null, failureCode });
      expect(evaluate(state)).toMatchObject({ freshSuccessfulChecks: 0, firstCheckReady: false, failedObservation: true });
    }
    const state = engineState(); state.observations[1].complete = false;
    expect(evaluate(state).freshSuccessfulChecks).toBe(0);
  });
  it("does not count copied provider clocks, overlapping reads, stale or future provider data", () => {
    for (const invalid of ["duplicate", "overlap", "stale", "future", "after-deadline"]) {
      const state = engineState();
      if (invalid === "duplicate") state.observations[1].providerObservedAt = state.observations[0].providerObservedAt;
      if (invalid === "overlap") state.observations[1].startedAt = state.observations[0].startedAt;
      if (invalid === "stale") state.observations[1].providerObservedAt = "2026-10-08T14:20:00Z";
      if (invalid === "future") state.observations[1].providerObservedAt = "2026-10-08T15:01:00Z";
      if (invalid === "after-deadline") state.observations[1].completedAt = state.observations[1].expiresAt;
      expect(evaluate(state).freshSuccessfulChecks, invalid).toBeLessThan(2);
    }
  });
  it("reports expired interrupted reservations as repair rather than an endless wait without refunding reads", () => {
    const state = engineState(); const previous = state.observations.pop()!;
    state.inFlight = { requestId: previous.requestId, revision: previous.revision, requestedDate: previous.requestedDate,
      startedAt: previous.startedAt, expiresAt: previous.expiresAt };
    expect(readSimulatorEngineeringVerificationState(state)).toBeDefined();
    expect(evaluate(state)).toMatchObject({ inFlight: false, expiredReservation: true, failedObservation: true, freshSuccessfulChecks: 1 });
    expect(state.readsUsed).toBe(2);
  });
  it("fails closed on malformed or oversized proof and duplicate reservation identity", () => {
    for (const mutate of [
      (state: SimulatorEngineeringVerificationState) => { state.readsUsed = 3; },
      (state: SimulatorEngineeringVerificationState) => { state.observations[1].requestId = state.observations[0].requestId; },
      (state: SimulatorEngineeringVerificationState) => { state.observations[0].requestedDate = "2026-02-31"; },
      (state: SimulatorEngineeringVerificationState) => { state.observations[0].failureCode = "raw provider body"; },
      (state: SimulatorEngineeringVerificationState) => { state.readsUsed = 1; },
      (state: SimulatorEngineeringVerificationState) => { Object.assign(state, { providerBody: "private" }); },
      (state: SimulatorEngineeringVerificationState) => { Object.assign(state.observations[0], { token: "private" }); },
    ]) { const state = engineState(); mutate(state); expect(readSimulatorEngineeringVerificationState(state)).toBeUndefined(); }
  });
});

describe("server-derived engineering date and runtime", () => {
  const offering = { bookingWindowDaysAhead: 14, bookingReleaseTimeLocal: "08:00", verifiedAt: now, evidenceUrl: "https://public.example/booking" };
  it("uses venue-local tomorrow across midnight and DST without consulting an expired alert", () => {
    expect(deriveSimulatorEngineeringVerificationDate(new Date("2026-10-08T03:30:00Z"), "America/New_York", offering)).toBe("2026-10-08");
    expect(deriveSimulatorEngineeringVerificationDate(new Date("2026-11-01T03:30:00Z"), "America/New_York", offering)).toBe("2026-11-01");
    expect(deriveSimulatorEngineeringVerificationDate(new Date("2026-10-08T16:00:00Z"), "Asia/Tokyo", offering)).toBe("2026-10-10");
  });
  it("does not treat booking-not-open as successful empty availability", () => {
    expect(() => deriveSimulatorEngineeringVerificationDate(new Date("2026-10-08T11:00:00Z"), "America/New_York", { ...offering, bookingWindowDaysAhead: 0 })).toThrow("BOOKING_NOT_OPEN");
    expect(deriveSimulatorEngineeringVerificationDate(now, "America/New_York", { ...offering, bookingWindowDaysAhead: 0 })).toBe("2026-10-08");
  });
  it("requires actual production runtime and deployment identity beyond an alias or caller release", () => {
    const actual = { runtimeVersion: sha, deploymentId: "dpl_test", deploymentUrl: proof.deploymentUrl, environment: "production", host: "teetimespot.com" };
    expect(() => assertSimulatorEngineeringRuntime(actual, proof, now)).not.toThrow();
    for (const partial of [{ environment: "preview" }, { runtimeVersion: "local" }, { deploymentId: "dpl_other" },
      { deploymentUrl: "https://other.vercel.app" }, { host: "test.vercel.app" }]) {
      expect(() => assertSimulatorEngineeringRuntime({ ...actual, ...partial }, proof, now)).toThrow();
    }
  });
});
