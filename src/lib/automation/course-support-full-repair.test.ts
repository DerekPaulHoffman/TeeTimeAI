import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { allowsRetainedFullRepairResearch, fullRepairContinuationMode, fullRepairSourceContinuation, fullRepairReadProgressMatchesClaim, hasStoppedFullRepairVerification, isDataOnlyFullRepair, readLegacyFullRepairBaseVerification, shouldContinueOwnedFullRepair } from "./course-support-full-repair";

describe("older repair with an evicted base release", () => {
  const sha = (sequence: number) => sequence.toString(16).padStart(40, "0");
  const stamp = (seconds: number) => new Date(Date.UTC(2026, 6, 15, 20, 0, seconds));
  const baseSha = sha(1), fingerprint = "a".repeat(64);
  const input = { batchId: "batch-id", batchReference: "batch-ref", entryId: "entry-id", courseId: "course-id",
    incidentId: "incident-id", baseSha, runtimeVersion: sha(22), providerSnapshotFingerprint: fingerprint,
    batchCreatedAt: stamp(1), now: stamp(100), releaseHistory: Array.from({ length: 20 }, (_, index) => ({
      releaseSha: sha(index + 2), deployedAt: index === 0 ? stamp(19).toISOString() : null,
      supersededAt: stamp(index + 20).toISOString(), supersededBy: sha(index + 3),
    })) };
  const deployment = { courseId: input.courseId, incidentId: input.incidentId, source: "DEPLOYMENT", eventType: "DEPLOYMENT_VERIFIED",
    deploymentSha: baseSha, runtimeVersion: baseSha, occurredAt: stamp(0), audit: { batchRef: input.batchReference } };
  const verification = { courseId: input.courseId, status: "STALE", lastError: "active_demand", outcome: "FETCH_FAILED", runtimeVersion: baseSha,
    createdAt: stamp(3), startedAt: stamp(4), completedAt: stamp(7), deadlineAt: stamp(18), providerSnapshotFingerprint: fingerprint,
    evidence: { schemaVersion: 1, kind: "PROVIDER_VERIFICATION", outcome: "FETCH_FAILED", releaseSha: baseSha,
      runtimeVersion: baseSha, observedAt: stamp(5).toISOString(), providerSnapshotFingerprint: fingerprint } };

  it("uses only the exact old execution window when the release history no longer contains the base", async () => {
    const findEvent = vi.fn().mockResolvedValue(deployment), findVerification = vi.fn().mockResolvedValue(verification);
    const db = { courseMonitoringEvent: { findUnique: findEvent }, courseSupportVerificationRequest: { findUnique: findVerification } } as unknown as Prisma.TransactionClient;
    const legacyBaseVerification = await readLegacyFullRepairBaseVerification(db, input);
    expect(legacyBaseVerification).toEqual({ releaseSha: baseSha, startedAt: stamp(4), completedAt: stamp(7) });
    expect(findEvent).toHaveBeenCalledWith(expect.objectContaining({ where: { idempotencyKey: `course-support-deployment:batch-id:entry-id:${baseSha}` } }));
    expect(findVerification).toHaveBeenCalledWith(expect.objectContaining({ where: { batchIncidentId_releaseSha: { batchIncidentId: "entry-id", releaseSha: baseSha } } }));
    const gate = { ...input, fullRepair: true, claimedEventCount: 0, legacyBaseVerification };
    const event = { observedAt: stamp(6).toISOString(), transition: "COMPLETED", runtimeVersion: baseSha };
    expect(fullRepairReadProgressMatchesClaim({ ...gate, events: [event] })).toBe(true);
    for (const changed of [{ observedAt: stamp(3).toISOString() }, { observedAt: stamp(8).toISOString() },
      { runtimeVersion: sha(24) }, { transition: "FAILED_FINAL" }, { technicalReason: "ACCOUNT_REQUIRED" }]) {
      expect(fullRepairReadProgressMatchesClaim({ ...gate, events: [{ ...event, ...changed }] })).toBe(false);
    }
    for (const changed of [{ courseId: "other" }, { runtimeVersion: sha(3) }, { startedAt: null },
      { lastError: "batch_release_changed" }, { completedAt: stamp(21) }, { evidence: null }]) {
      findVerification.mockResolvedValueOnce({ ...verification, ...changed });
      expect(await readLegacyFullRepairBaseVerification(db, input)).toBeNull();
    }
    findEvent.mockResolvedValueOnce(null);
    expect(await readLegacyFullRepairBaseVerification(db, input)).toBeNull();
    findEvent.mockResolvedValueOnce({ ...deployment, audit: { batchRef: "other" } });
    expect(await readLegacyFullRepairBaseVerification(db, input)).toBeNull();
    expect(await readLegacyFullRepairBaseVerification(db, { ...input, releaseHistory: input.releaseHistory.slice(1) })).toBeNull();
  });
});

describe("changed-source reconciliation for an unfinished data-only mission", () => {
  const input = { mode: "DATA_ONLY" as const, result: "STALE_EVIDENCE", claimedFingerprint: "a".repeat(64), currentFingerprint: "b".repeat(64) };
  it("keeps the original owner actionable without accepting the changed source for research", () => {
    const before = structuredClone(input);
    expect(fullRepairSourceContinuation(input)).toBe("RECONCILE_SOURCE");
    expect(input).toEqual(before);
    expect(fullRepairSourceContinuation({ ...input, currentFingerprint: input.claimedFingerprint })).toBe("CONTINUE_REPAIR");
  });
  it("does not reconcile source drift into code-bearing, unfinished or malformed authority", () => {
    for (const change of [{ mode: "CLAIMED_IMPLEMENTATION" as const }, { mode: "PUBLISHED_IMPLEMENTATION" as const },
      { mode: null }, { result: "PENDING" }, { result: "RESTORED" }, { claimedFingerprint: "unknown" },
      { currentFingerprint: "" }]) expect(fullRepairSourceContinuation({ ...input, ...change })).toBeNull();
  });
});

describe("unfinished original-owner implementation phase", () => {
  const phase = { status: "IMPLEMENTING", baseSha: "a".repeat(40), releaseSha: "a".repeat(40),
    plannedPaths: ["src/lib/course-discovery/public-source.ts"], deployedAt: new Date("2030-01-01T10:00:00Z"), now: new Date("2030-01-01T11:00:00Z") };
  it("retains the phase between negative verification, a claimed path and a future implementation", () => {
    const snapshot = structuredClone(phase);
    expect(fullRepairContinuationMode(phase)).toBe("CLAIMED_IMPLEMENTATION");
    expect(phase).toEqual(snapshot);
    expect(fullRepairContinuationMode({ ...phase, status: "VERIFYING", plannedPaths: [] })).toBe("DATA_ONLY");
    expect(fullRepairContinuationMode({ ...phase, status: "VERIFYING", releaseSha: "b".repeat(40) })).toBe("PUBLISHED_IMPLEMENTATION");
    expect(fullRepairContinuationMode({ ...phase, status: "VERIFYING", releaseSha: "b".repeat(40),
      plannedPaths: Array(33).fill("src/lib/already-published.ts") })).toBe("PUBLISHED_IMPLEMENTATION");
  });
  it("keeps the original follow-up implementation selectable after its registration heartbeat stops", () => {
    const followup = { ...phase, releaseSha: "b".repeat(40) }, before = structuredClone(followup);
    expect(fullRepairContinuationMode(followup)).toBe("PUBLISHED_IMPLEMENTATION");
    expect(followup).toEqual(before);
    for (const change of [{ status: "CLAIMED" }, { status: "COMPLETE" }, { plannedPaths: [] },
      { plannedPaths: Array(33).fill("claimed.ts") }, { releaseSha: "unregistered" }, { deployedAt: null },
      { deployedAt: new Date("2030-01-02T10:00:00Z") }]) {
      expect(fullRepairContinuationMode({ ...followup, ...change })).toBeNull();
    }
  });
  it.each([
    { status: "COMPLETE" }, { status: "CLAIMED" }, { status: "VERIFYING" }, { plannedPaths: [] },
    { plannedPaths: null }, { plannedPaths: [null] }, { plannedPaths: Array(33).fill("claimed.ts") },
    { releaseSha: null }, { releaseSha: "unregistered" },
    { deployedAt: null }, { deployedAt: new Date("invalid") }, { deployedAt: new Date("2030-01-02T10:00:00Z") },
  ])("does not invent continuation proof for %j", change => {
    expect(fullRepairContinuationMode({ ...phase, ...change })).toBeNull();
  });
});

describe("full repair retains the original owner after negative verification", () => {
  it("continues a zero-pass pending result only after its current deployed verification failure checkpoint", () => {
    const checkpoint = { schemaVersion: 1, stage: "VERIFICATION", failureDomain: "PRODUCTION_VERIFICATION",
      reasonCode: "VERIFICATION_TOOLING_FAILED", recordedAt: "2026-11-18T06:05:00Z" };
    const input = { summary: { ownerFailureCheckpoints: [checkpoint] }, batchCreatedAt: new Date("2026-11-18T06:00:00Z"),
      deployedAt: new Date("2026-11-18T06:01:00Z"), now: new Date("2026-11-18T06:10:00Z") };
    const mission = { reason: "FAILED_LEARNER_IMPLEMENTATION_HANDOFF", workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      batchStatus: "VERIFYING", result: "PENDING", allowedActions: ["IMPLEMENT_REUSABLE_SUPPORT", "INVESTIGATE_PUBLIC_SOURCE"] };
    expect(hasStoppedFullRepairVerification(input)).toBe(true);
    expect(allowsRetainedFullRepairResearch({ ...mission, pendingVerificationStopped: hasStoppedFullRepairVerification(input) })).toBe(true);
    expect(allowsRetainedFullRepairResearch(mission)).toBe(false);
    for (const changed of [{ ...checkpoint, recordedAt: "2026-11-18T05:59:00Z" },
      { ...checkpoint, recordedAt: "2026-11-18T06:00:30Z" }, { ...checkpoint, recordedAt: "2026-11-18T06:11:00Z" },
      { ...checkpoint, failureDomain: "NETWORK" }, { ...checkpoint, reasonCode: "OTHER" }])
      expect(hasStoppedFullRepairVerification({ ...input, summary: { ownerFailureCheckpoints: [changed] } })).toBe(false);
    expect(hasStoppedFullRepairVerification({ ...input, deployedAt: null })).toBe(false);
  });
  it("accepts only bounded non-factual same-runtime append-only read progress, without changing the claim", () => {
    const input = { fullRepair: true, claimedEventCount: 0, runtimeVersion: "a".repeat(40),
      batchCreatedAt: new Date("2026-11-18T06:00:00Z"), now: new Date("2026-11-18T06:10:00Z"),
      events: [{ observedAt: "2026-11-18T06:01:00Z", runtimeVersion: "a".repeat(40), transition: "NOT_APPLICABLE" }] };
    expect(fullRepairReadProgressMatchesClaim(input)).toBe(true);
    expect(input.claimedEventCount).toBe(0);
    for (const event of [{ ...input.events[0], runtimeVersion: "b".repeat(40) },
      { ...input.events[0], observedAt: "2026-11-18T05:59:00Z" }, { ...input.events[0], observedAt: "2026-11-18T06:11:00Z" },
      { ...input.events[0], transition: "FAILED_FINAL" }, { ...input.events[0], factualDisposition: "ACCOUNT_REQUIRED" }])
      expect(fullRepairReadProgressMatchesClaim({ ...input, events: [event] })).toBe(false);
    expect(fullRepairReadProgressMatchesClaim({ ...input, fullRepair: false })).toBe(false);
    expect(fullRepairReadProgressMatchesClaim({ ...input, claimedEventCount: 2 })).toBe(false);
  });
  it("does not require a code release until an optional-code full mission actually claims code", () => {
    const dataOnly = { reason: "FAILED_LEARNER_IMPLEMENTATION_HANDOFF", workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      requiresImplementationPath: false, plannedPaths: [], baseSha: "a".repeat(40), releaseSha: "a".repeat(40),
      allowedActions: ["IMPLEMENT_REUSABLE_SUPPORT", "INVESTIGATE_PUBLIC_SOURCE"] };
    expect(isDataOnlyFullRepair(dataOnly)).toBe(true);
    for (const change of [{ plannedPaths: ["src/lib/adapters/example.ts"] }, { releaseSha: "b".repeat(40) },
      { requiresImplementationPath: true }, { reason: "IMPLEMENTATION_REQUIRED" }, { allowedActions: ["IMPLEMENT_REUSABLE_SUPPORT"] }])
      expect(isDataOnlyFullRepair({ ...dataOnly, ...change })).toBe(false);
  });
  it("retains its own earlier read across a registered deployed repair release, without accepting unrelated or final evidence", () => {
    const before = "a".repeat(40), current = "b".repeat(40);
    const event = { observedAt: "2026-11-18T06:03:00Z", runtimeVersion: before, transition: "COMPLETED" };
    const history = { releaseSha: before, deployedAt: "2026-11-18T06:01:00Z", supersededAt: "2026-11-18T06:05:00Z", supersededBy: current };
    const input = { fullRepair: true, claimedEventCount: 0, runtimeVersion: current,
      batchCreatedAt: new Date("2026-11-18T06:00:00Z"), now: new Date("2026-11-18T06:10:00Z"),
      events: [event], releaseHistory: [history] };
    expect(fullRepairReadProgressMatchesClaim(input)).toBe(true);
    const unpublished = "d".repeat(40);
    const chain = [
      { releaseSha: "c".repeat(40), deployedAt: "2026-11-18T05:45:00Z", supersededAt: "2026-11-18T05:58:00Z", supersededBy: unpublished },
      { releaseSha: unpublished, deployedAt: null, supersededAt: "2026-11-18T06:00:00Z", supersededBy: before },
      history,
    ];
    expect(fullRepairReadProgressMatchesClaim({ ...input, releaseHistory: chain })).toBe(true);
    expect(fullRepairReadProgressMatchesClaim({ ...input, releaseHistory: chain,
      events: [{ ...event, runtimeVersion: unpublished }] })).toBe(false);
    for (const change of [
      { releaseHistory: [] }, { releaseHistory: [{ ...history, deployedAt: null }] },
      { releaseHistory: [{ ...history, supersededBy: "c".repeat(40) }] },
      { releaseHistory: [{ ...history, supersededAt: "2026-11-18T06:11:00Z" }] },
      { events: [{ ...event, observedAt: "2026-11-18T06:00:30Z" }] },
      { events: [{ ...event, observedAt: history.supersededAt }] },
      { events: [{ ...event, runtimeVersion: "c".repeat(40) }] },
      { events: [{ ...event, transition: "FAILED_FINAL", technicalReason: "ACCOUNT_REQUIRED" }] },
      { fullRepair: false },
    ]) expect(fullRepairReadProgressMatchesClaim({ ...input, ...change })).toBe(false);
    expect(input.claimedEventCount).toBe(0);
    expect(input.events).toEqual([event]);
  });
  const packet = { remediation: { reason: "FAILED_LEARNER_IMPLEMENTATION_HANDOFF" }, courses: [{
    result: "RETRY_SCHEDULED", terminalProofDurable: false,
    actionPlan: { allowedActions: ["IMPLEMENT_REUSABLE_SUPPORT", "INVESTIGATE_PUBLIC_SOURCE"] },
  }] };
  it("returns the failed release to the same coding owner instead of closing another unchanged retry", () => {
    expect(shouldContinueOwnedFullRepair(packet)).toBe(true);
    expect(shouldContinueOwnedFullRepair({ ...packet, courses: [{ ...packet.courses[0], result: "RESTORED" }] })).toBe(true);
  });
  it.each(["RESTORED", "FINAL_DISPOSITION"])("allows %s only with durable terminal proof", result => {
    expect(shouldContinueOwnedFullRepair({ ...packet, courses: [{ ...packet.courses[0], result, terminalProofDurable: true }] })).toBe(false);
  });
  it("never extends legacy, malformed, broadened or unauthorized assignments", () => {
    for (const input of [
      { ...packet, remediation: null }, { ...packet, remediation: { reason: "IMPLEMENTATION_REQUIRED" } },
      { ...packet, courses: [] }, { ...packet, courses: [...packet.courses, ...packet.courses] },
      { ...packet, courses: [{ ...packet.courses[0], actionPlan: null }] },
    ]) expect(shouldContinueOwnedFullRepair(input)).toBe(false);
  });
});
