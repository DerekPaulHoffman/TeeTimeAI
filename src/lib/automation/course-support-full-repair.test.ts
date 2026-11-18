import { describe, expect, it } from "vitest";
import { fullRepairReadProgressMatchesClaim, isDataOnlyFullRepair, shouldContinueOwnedFullRepair } from "./course-support-full-repair";

describe("full repair retains the original owner after negative verification", () => {
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
