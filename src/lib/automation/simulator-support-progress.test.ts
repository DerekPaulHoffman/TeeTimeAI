import { describe, expect, it } from "vitest";
import { evaluateSimulatorSupportProgress, type SimulatorSupportProgressInput, type SimulatorSupportProgressProbe } from "./simulator-support-progress";
import type { SimulatorEngineeringVerificationState } from "./simulator-support-engineering-verification-policy";

const now = new Date("2026-10-06T15:00:00Z");
const releaseSha = "b".repeat(40);
const sourceFingerprint = "a".repeat(64);
const deployedAt = "2026-10-06T14:45:00Z";
const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: releaseSha,
  deployedAt, deploymentId: "dpl_test", deploymentUrl: "https://test.vercel.app", source: "git" as const, state: "READY" as const };

function input(): SimulatorSupportProgressInput {
  return { now, sourceFingerprint, owner: { leaseValid: true, demandCurrent: true, sourceCurrent: true },
    offering: { publicAccessStatus: "PUBLIC", monitoringState: "HEALTHY", automationEligibility: "ALLOWED" },
    claim: { token: "owner", revision: 1, phase: "VERIFYING", claimedAt: "2026-10-06T14:40:00Z",
      leaseExpiresAt: "2026-10-06T15:10:00Z", sourceFingerprint, originalSourceFingerprint: sourceFingerprint,
      offeringRevision: 1, plannedPaths: [], releaseSha, branch: "feature/simulator-alerts", deployment: proof,
      recheckQueuedAt: "2026-10-06T14:50:00Z", verificationCycle: 1 },
    probes: [], searches: [{ id: "search", status: "ACTIVE", checkStatus: "WAITING", checkLeaseToken: null,
      checkLeaseExpiresAt: null, lastCheckedAt: new Date("2026-10-06T15:00:00Z"), nextCheckAt: new Date("2026-10-06T16:00:00Z") }] };
}

function probe(id: string, minute: number, runId = id): SimulatorSupportProgressProbe {
  const observedAt = new Date(`2026-10-06T14:${String(minute).padStart(2, "0")}:00Z`);
  return { id, teeSearchId: "search", automationRunId: runId, observedAt, outcome: "NO_MATCH", runtimeVersion: releaseSha,
    rawSummary: { mode: "SIMULATOR", sourceFingerprint, providerObservedAt: observedAt.toISOString() },
    automationRun: { kind: "SEARCH_CHECK", status: "COMPLETED", outcome: "failed", errors: null,
      completedAt: new Date(observedAt.getTime() + 30_000) } };
}

describe("simulator support progress", () => {
  function engineeringState(): SimulatorEngineeringVerificationState {
    return { schemaVersion: 1, sourceFingerprint, runtimeVersion: releaseSha, deploymentId: proof.deploymentId,
      startedAt: "2026-10-06T14:50:00Z", readsUsed: 2, inFlight: null, observations: [56, 58].map((minute, index) => ({
        requestId: `read_${index}`, revision: index + 2, requestedDate: "2026-10-07", startedAt: `2026-10-06T14:${minute}:00Z`,
        expiresAt: `2026-10-06T14:${minute + 1}:30Z`, completedAt: `2026-10-06T14:${minute}:20Z`,
        providerObservedAt: `2026-10-06T14:${minute}:10Z`, outcome: "NO_MATCH", complete: true, slotCount: 0, failureCode: null,
      })) };
  }
  it("keeps independent no-send engineering evidence separate from expired customer searches", () => {
    const state = input(); state.engineeringVerification = engineeringState(); state.searches = [];
    state.claim.recheckQueuedAt = null; state.claim.verificationCycle = 0;
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "COMPLETE", verificationKind: "ENGINEERING_ONLY",
      customerAcceptance: false, freshSuccessfulChecks: 2, readyForCompletion: true, latestProbe: null });
    state.customerDemandPresent = true;
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "RETRY_ENGINEERING", customerAcceptance: false, readyForCompletion: false,
      reasons: expect.arrayContaining(["NORMAL_CUSTOMER_CHECK_REQUIRED"]) });
  });
  it("reports finite retry for failed reads and explicit repair for expired reservations without hidden revision advances", () => {
    const state = input(); state.engineeringVerification = engineeringState(); state.searches = [];
    state.engineeringVerification.observations[1].complete = false;
    state.engineeringVerification.observations[1].failureCode = "SCHEMA_CHANGED";
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "RETRY_ENGINEERING", readyForCompletion: false });
    const pending = state.engineeringVerification.observations.pop()!;
    state.engineeringVerification.inFlight = { requestId: pending.requestId, revision: pending.revision, requestedDate: pending.requestedDate,
      startedAt: pending.startedAt, expiresAt: pending.expiresAt };
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "REPAIR", reasons: expect.arrayContaining(["ENGINEERING_READ_EXPIRED"]) });
    expect(state.claim.revision).toBe(1);
  });
  it("allows a first fresh read after an actually registered new source or release while retaining old failure evidence", () => {
    const state = input(); state.engineeringVerification = engineeringState(); state.claim.releaseSha = "c".repeat(40);
    state.claim.deployment = { ...proof, commitSha: state.claim.releaseSha, deploymentId: "dpl_repaired" };
    state.engineeringVerification.observations[1].complete = false;
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "VERIFY_ENGINEERING", freshSuccessfulChecks: 0, readyForCompletion: false,
      reasons: expect.arrayContaining(["FIRST_ENGINEERING_READ_NEEDED"]) });
    expect(state.engineeringVerification.observations).toHaveLength(2);
    state.claim.sourceFingerprint = "d".repeat(64); state.sourceFingerprint = state.claim.sourceFingerprint;
    expect(evaluateSimulatorSupportProgress(state).nextAction).toBe("VERIFY_ENGINEERING");
  });
  it("waits without treating a queued or running check as a success", () => {
    const state = input();
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "WAIT_FOR_CHECK", freshSuccessfulChecks: 0, firstCheckReady: false });
    state.offering.monitoringState = "UNKNOWN";
    state.offering.automationEligibility = "UNKNOWN";
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "WAIT_FOR_CHECK", offeringReady: false });
    state.probes = [{ ...probe("old-failure", 48), outcome: "FETCH_FAILED" }];
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "WAIT_FOR_CHECK",
      reasons: expect.arrayContaining(["NO_FRESH_CHECK_YET"]) });
    state.probes = [probe("new", 58)];
    state.probes[0].automationRun!.status = "RUNNING";
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "WAIT_FOR_CHECK", latestProbe: { scheduledCheckFinished: false } });
    state.probes[0].automationRun!.status = "COMPLETED";
    state.searches[0].checkStatus = "CHECKING";
    expect(evaluateSimulatorSupportProgress(state).firstCheckReady).toBe(false);
  });

  it("allows a second recheck only after a fresh exact-source observation and finished scheduler", () => {
    const state = input();
    state.probes = [probe("first", 58)];
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "RECHECK_SECOND", firstCheckReady: true,
      freshSuccessfulChecks: 1, readyForCompletion: false });
    state.probes[0].rawSummary = { mode: "SIMULATOR", sourceFingerprint, providerObservedAt: "2026-10-06T14:40:00Z" };
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "REPAIR", firstCheckReady: false });
  });

  it("requires two different completed runs and preserves the newest-observation failure fence", () => {
    const state = input();
    state.claim.verificationCycle = 2;
    state.probes = [probe("second", 59), probe("first", 58)];
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "COMPLETE", readyForCompletion: true,
      freshSuccessfulChecks: 2, qualifyingProbeIds: ["second", "first"], currentDeploymentReadbackRequired: true });
    state.probes[0].automationRunId = "first";
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "WAIT_FOR_CHECK", freshSuccessfulChecks: 1 });
    state.probes[0] = { ...probe("failure", 59), outcome: "FETCH_FAILED" };
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "REPAIR", freshSuccessfulChecks: 0 });
    state.probes = [probe("new-success", 59), { ...probe("middle-failure", 58), outcome: "FETCH_FAILED" }, probe("old-success", 57)];
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "REPAIR", freshSuccessfulChecks: 1 });
  });

  it("rejects stale, unrelated and non-provider observations and fatal run errors", () => {
    const state = input();
    const baseline = probe("latest", 58);
    const cases: Array<[string, SimulatorSupportProgressProbe]> = [
      ["old runtime", { ...baseline, runtimeVersion: "c".repeat(40) }],
      ["outdoor", { ...baseline, rawSummary: { mode: "OUTDOOR", sourceFingerprint, providerObservedAt: baseline.observedAt.toISOString() } }],
      ["booking not open", { ...baseline, rawSummary: { mode: "SIMULATOR", sourceFingerprint, bookingNotOpen: true } }],
      ["stale provider", { ...baseline, rawSummary: { mode: "SIMULATOR", sourceFingerprint, providerObservedAt: "2026-10-06T14:20:00Z" } }],
      ["fatal run", { ...baseline, automationRun: { ...baseline.automationRun!, errors: { message: "fatal" } } }],
      ["running", { ...baseline, automationRun: { ...baseline.automationRun!, status: "RUNNING" } }],
    ];
    for (const [name, invalid] of cases) {
      state.probes = [invalid];
      expect(evaluateSimulatorSupportProgress(state).firstCheckReady, name).toBe(false);
    }
  });

  it("counts repeated resource probes from one run only once", () => {
    const state = input();
    state.claim.verificationCycle = 2;
    state.probes = [probe("resource-two", 59, "same-run"), probe("resource-one", 58, "same-run")];
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ freshSuccessfulChecks: 1, readyForCompletion: false,
      nextAction: "WAIT_FOR_CHECK" });
  });

  it("waits after queuing the second check when the first offering succeeded in an aggregate failed run", () => {
    const state = input();
    state.claim.verificationCycle = 2;
    state.probes = [probe("first", 58)];
    state.searches[0].checkStatus = "QUEUED";
    state.searches[0].lastCheckedAt = new Date("2026-10-06T14:58:30Z");
    expect(state.probes[0].automationRun).toMatchObject({ outcome: "failed", errors: null });
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "WAIT_FOR_CHECK", readyForCompletion: false,
      latestProbe: { outcome: "NO_MATCH", scheduledCheckFinished: false } });
  });

  it("keeps owner, source, release and public-health gates independent", () => {
    const state = input();
    state.probes = [probe("second", 59), probe("first", 58)];
    state.owner.leaseValid = false;
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "REPAIR", readyForCompletion: false, reasons: expect.arrayContaining(["OWNER_LEASE_STALE"]) });
    state.owner.leaseValid = true;
    state.owner.demandCurrent = false;
    expect(evaluateSimulatorSupportProgress(state).readyForCompletion).toBe(false);
    state.owner.demandCurrent = true;
    state.sourceFingerprint = "c".repeat(64);
    expect(evaluateSimulatorSupportProgress(state)).toMatchObject({ nextAction: "REPAIR", sourceCurrent: false });
    state.sourceFingerprint = sourceFingerprint;
    state.offering.monitoringState = "NEEDS_ADAPTER";
    expect(evaluateSimulatorSupportProgress(state).offeringReady).toBe(false);
    state.offering.monitoringState = "HEALTHY";
    state.claim.deployment = { ...proof, aliases: ["teetimespot.com"] };
    expect(evaluateSimulatorSupportProgress(state).releaseReady).toBe(false);
  });
});
