import { describe, expect, it } from "vitest";
import { shouldContinueOwnedFullRepair } from "./course-support-full-repair";

describe("full repair retains the original owner after negative verification", () => {
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
