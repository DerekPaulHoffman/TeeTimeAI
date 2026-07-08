type AutomationEligibility = "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
type IntendedAction = "ALERT_ONLY";

type PolicyInput = {
  automationEligibility?: AutomationEligibility;
  termsText?: string | null;
  intendedAction?: IntendedAction;
};

type PolicyResult = {
  allowed: boolean;
  reason: string;
};

const prohibitionPatterns = [
  /\bno\s+(?:bots?|robots?|scripts?|automated|automation)\b/i,
  /\bautomated\s+(?:access|retrieval|requests?|booking|reservation|tee\s*time)\b/i,
  /\bbots?,?\s+scripts?,?\s+or\s+automated\b/i,
  /\bprohibit(?:ed|s)?\s+(?:automated|automation|bots?|scripts?)\b/i
];

export function evaluateAutomationPolicy(input: PolicyInput): PolicyResult {
  if (input.automationEligibility === "BLOCKED") {
    return {
      allowed: false,
      reason: "Course is explicitly marked as blocked for automation."
    };
  }

  const termsText = input.termsText ?? "";
  if (prohibitionPatterns.some((pattern) => pattern.test(termsText))) {
    return {
      allowed: false,
      reason: "Course terms appear to prohibit automated retrieval."
    };
  }

  return {
    allowed: true,
    reason:
      input.intendedAction === "ALERT_ONLY" || !input.intendedAction
        ? "Alert-only public tee-sheet checks are allowed until a blocker is known."
        : "Public tee-sheet checks are allowed until a blocker is known."
  };
}
