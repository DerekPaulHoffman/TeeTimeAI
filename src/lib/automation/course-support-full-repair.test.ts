import { describe, expect, it } from "vitest";
import { allowsRetainedFullRepairResearch, fullRepairContinuationMode, fullRepairReadProgressMatchesClaim, hasStoppedFullRepairVerification, isDataOnlyFullRepair, shouldContinueOwnedFullRepair } from "./course-support-full-repair";

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
  it.each([
    { status: "COMPLETE" }, { status: "CLAIMED" }, { status: "VERIFYING" }, { plannedPaths: [] },
    { plannedPaths: null }, { plannedPaths: [null] }, { plannedPaths: Array(33).fill("claimed.ts") },
    { releaseSha: null }, { releaseSha: "unregistered" }, { releaseSha: "b".repeat(40) },
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
