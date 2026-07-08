import { describe, expect, it } from "vitest";

import { evaluateAutomationPolicy } from "./policy";

describe("evaluateAutomationPolicy", () => {
  it("skips courses with an explicit automation prohibition", () => {
    const result = evaluateAutomationPolicy({
      automationEligibility: "ALLOWED",
      termsText: "No bots, scripts, or automated tee time retrieval may access this service."
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/prohibit/i);
  });

  it("allows alert-only public tee sheet checks when no blocker is known", () => {
    const result = evaluateAutomationPolicy({
      automationEligibility: "UNKNOWN",
      termsText: "Book public tee times online.",
      intendedAction: "ALERT_ONLY"
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toMatch(/alert-only/i);
  });
});
