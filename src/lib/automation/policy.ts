import type {
  AutomationReason,
  BookingMethod
} from "@/lib/courses/intelligence";

type AutomationEligibility = "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
type IntendedAction = "ALERT_ONLY";

const MANUAL_BOOKING_METHODS = new Set<BookingMethod>([
  "PHONE_ONLY",
  "CONTACT_COURSE",
  "WALK_IN"
]);
const TECHNICAL_ACCESS_REASONS = new Set<AutomationReason>([
  "ACCOUNT_REQUIRED",
  "CAPTCHA_OR_QUEUE"
]);
const CURRENT_INTELLIGENCE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

type PolicyInput = {
  automationEligibility?: AutomationEligibility;
  termsText?: string | null;
  intendedAction?: IntendedAction;
};

type PolicyResult = {
  allowed: boolean;
  reason: string;
};

export type MonitoringGateInput = {
  isPublic?: boolean | null;
  invalidCourse?: boolean;
  finalClassification?: boolean;
  bookingMethod?: BookingMethod | string | null;
  automationEligibility?: AutomationEligibility | string | null;
  automationReason?: AutomationReason | string | null;
  intelligenceVerifiedAt?: Date | string | null;
  intelligenceReviewAt?: Date | string | null;
  intelligenceConfidence?: number | null;
  now?: Date;
};

export type MonitoringDisposition =
  | "ACTIONABLE"
  | "MANUAL_FINAL"
  | "TECHNICAL_FINAL"
  | "IDENTITY_FINAL"
  | "IDENTITY_RECHECK";

export type MonitoringGateResult = {
  disposition: MonitoringDisposition;
  adapterAllowed: boolean;
  requiresRevalidation: boolean;
  currentEvidence: boolean;
  reason: string;
};

export function evaluateAutomationPolicy(input: PolicyInput): PolicyResult {
  return {
    allowed: true,
    reason:
      input.intendedAction === "ALERT_ONLY" || !input.intendedAction
        ? "Provider policy text does not block alert-only reads of public tee-time availability."
        : "Provider policy text does not block reads of public tee-time availability."
  };
}

export function evaluateMonitoringGate(
  input: MonitoringGateInput
): MonitoringGateResult {
  const currentEvidence = hasCurrentMonitoringIntelligence(input);
  const bookingMethod = input.bookingMethod ?? "UNKNOWN";
  const automationReason = input.automationReason ?? "NONE";

  if (input.invalidCourse) {
    return {
      disposition: "IDENTITY_FINAL",
      adapterAllowed: false,
      requiresRevalidation: false,
      currentEvidence,
      reason: "The persisted identity is not a playable golf course."
    };
  }

  if (input.isPublic === false) {
    const hasReviewSchedule =
      input.intelligenceVerifiedAt !== undefined &&
      input.intelligenceVerifiedAt !== null &&
      input.intelligenceReviewAt !== undefined &&
      input.intelligenceReviewAt !== null &&
      input.intelligenceConfidence !== undefined &&
      input.intelligenceConfidence !== null;
    if (!hasReviewSchedule) {
      return {
        disposition: "IDENTITY_FINAL",
        adapterAllowed: false,
        requiresRevalidation: false,
        currentEvidence: false,
        reason:
          "The persisted private identity predates scheduled revalidation and remains final until operator review."
      };
    }
    const currentIdentityEvidence = hasCurrentCourseIdentityIntelligence(input);
    return {
      disposition: currentIdentityEvidence ? "IDENTITY_FINAL" : "IDENTITY_RECHECK",
      adapterAllowed: false,
      requiresRevalidation: !currentIdentityEvidence,
      currentEvidence: currentIdentityEvidence,
      reason: currentIdentityEvidence
        ? "Current verified evidence identifies this as a private course."
        : "The private-course identity review is due and requires fresh official evidence."
    };
  }

  const coherentManualFinal =
    isCoherentManualDisposition(input) && currentEvidence;
  if (coherentManualFinal) {
    return {
      disposition: "MANUAL_FINAL",
      adapterAllowed: false,
      requiresRevalidation: false,
      currentEvidence,
      reason: `The current booking method is ${bookingMethod}.`
    };
  }

  if (
    TECHNICAL_ACCESS_REASONS.has(automationReason as AutomationReason) &&
    input.automationEligibility === "BLOCKED" &&
    currentEvidence
  ) {
    return {
      disposition: "TECHNICAL_FINAL",
      adapterAllowed: false,
      requiresRevalidation: false,
      currentEvidence,
      reason:
        automationReason === "ACCOUNT_REQUIRED"
          ? "Current corroborated evidence shows that availability requires an account."
          : "Current corroborated evidence shows that availability is behind a captcha or queue."
    };
  }

  const storedBlock = input.automationEligibility === "BLOCKED";
  const stalePreciseReason =
    automationReason === "NO_ONLINE_BOOKING" ||
    TECHNICAL_ACCESS_REASONS.has(automationReason as AutomationReason);
  return {
    disposition: "ACTIONABLE",
    adapterAllowed: true,
    requiresRevalidation:
      storedBlock ||
      automationReason === "AUTOMATION_PROHIBITED" ||
      stalePreciseReason,
    currentEvidence,
    reason:
      automationReason === "AUTOMATION_PROHIBITED"
        ? "Booking-policy text is legacy evidence and cannot block public read-only monitoring."
        : stalePreciseReason
          ? "The stored technical or manual reason is not supported by current verified evidence."
          : storedBlock
            ? "A generic stored block is insufficient without a current precise reason."
            : "No current terminal monitoring disposition applies."
  };
}

export function isCoherentManualDisposition(
  input: Pick<
    MonitoringGateInput,
    "bookingMethod" | "automationEligibility" | "automationReason"
  >
) {
  return (
    MANUAL_BOOKING_METHODS.has((input.bookingMethod ?? "UNKNOWN") as BookingMethod) &&
    input.automationEligibility === "BLOCKED" &&
    input.automationReason === "NO_ONLINE_BOOKING"
  );
}

export function hasCurrentMonitoringIntelligence(
  input: Pick<
    MonitoringGateInput,
    | "intelligenceVerifiedAt"
    | "intelligenceReviewAt"
    | "intelligenceConfidence"
    | "now"
  >
) {
  const now = input.now ?? new Date();
  const verifiedAt = parseDate(input.intelligenceVerifiedAt);
  const reviewAt = parseDate(input.intelligenceReviewAt);
  if (
    !verifiedAt ||
    verifiedAt.getTime() > now.getTime() + 60_000 ||
    now.getTime() - verifiedAt.getTime() > CURRENT_INTELLIGENCE_MAX_AGE_MS ||
    (input.intelligenceConfidence ?? 0) < 0.8
  ) {
    return false;
  }
  return Boolean(reviewAt && reviewAt.getTime() > now.getTime());
}

function hasCurrentCourseIdentityIntelligence(
  input: Pick<
    MonitoringGateInput,
    | "intelligenceVerifiedAt"
    | "intelligenceReviewAt"
    | "intelligenceConfidence"
    | "now"
  >
) {
  const now = input.now ?? new Date();
  const verifiedAt = parseDate(input.intelligenceVerifiedAt);
  const reviewAt = parseDate(input.intelligenceReviewAt);
  return Boolean(
    verifiedAt &&
      verifiedAt.getTime() <= now.getTime() + 60_000 &&
      reviewAt &&
      reviewAt.getTime() > now.getTime() &&
      (input.intelligenceConfidence ?? 0) >= 0.8
  );
}

function parseDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
