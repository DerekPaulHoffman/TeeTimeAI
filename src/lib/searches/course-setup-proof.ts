import { getProviderExecutionEvidenceObservedAt } from "@/lib/automation/provider-execution-evidence";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";

type CourseSetupProbe = {
  outcome: string;
  observedAt: Date;
  rawSummary?: unknown;
};

export type CourseSetupProof = {
  outcome: "MATCHES_AVAILABLE" | "NO_OPENINGS" | "BOOKING_NOT_OPEN" | "DIRECT_ACTION";
  evidenceAt: Date;
};

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
}

function isHash(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isDirectAction(outcome: string, summary: Record<string, unknown>) {
  return (outcome === "MANUAL_DIRECT" && summary.monitoringDisposition === "MANUAL_FINAL") ||
    (outcome === "IDENTITY_FINAL" && summary.monitoringDisposition === "IDENTITY_FINAL");
}

/** Classify a probe written under the current search and selected target fence. */
export function classifyCourseSetupProbe(input: {
  mode: "OUTDOOR" | "SIMULATOR";
  targetDate: string;
  setupStartedAt: Date;
  recordedAt: Date;
  probe: CourseSetupProbe;
}): CourseSetupProof | null {
  const { mode, targetDate, setupStartedAt, recordedAt, probe } = input;
  const summary = asRecord(probe.rawSummary);
  if (!summary || ![setupStartedAt, recordedAt, probe.observedAt].every(value => Number.isFinite(value.getTime())) ||
    probe.observedAt < setupStartedAt || probe.observedAt > recordedAt ||
    (summary.targetDate !== undefined && summary.targetDate !== targetDate)) return null;

  if (mode === "SIMULATOR") {
    if (summary.mode !== "SIMULATOR" || !isHash(summary.sourceFingerprint)) return null;
    if (summary.officialSiteOnly === true && isDirectAction(probe.outcome, summary)) {
      return { outcome: "DIRECT_ACTION", evidenceAt: probe.observedAt };
    }
    if (summary.bookingNotOpen === true) {
      const opensAt = readTimestamp(summary.opensAt);
      return probe.outcome === "NO_MATCH" && summary.targetDate === targetDate &&
        summary.bookingWindowVerified === true && opensAt && opensAt > recordedAt
        ? { outcome: "BOOKING_NOT_OPEN", evidenceAt: probe.observedAt }
        : null;
    }
    const providerObservedAt = readTimestamp(summary.providerObservedAt);
    if (!providerObservedAt || providerObservedAt.getTime() !== probe.observedAt.getTime()) return null;
    const { matchingSessions, durationMinutes } = summary;
    if (typeof matchingSessions !== "number" || !Number.isSafeInteger(matchingSessions) || matchingSessions < 0 ||
      (durationMinutes !== null && (typeof durationMinutes !== "number" || !Number.isSafeInteger(durationMinutes) || durationMinutes <= 0))) return null;
    if (probe.outcome === "MATCH_FOUND" && matchingSessions > 0) return { outcome: "MATCHES_AVAILABLE", evidenceAt: providerObservedAt };
    if (probe.outcome === "NO_MATCH" && matchingSessions === 0) return { outcome: "NO_OPENINGS", evidenceAt: providerObservedAt };
    return null;
  }

  if (summary.mode === "SIMULATOR") return null;
  if (isDirectAction(probe.outcome, summary)) return { outcome: "DIRECT_ACTION", evidenceAt: probe.observedAt };
  if (probe.outcome === "BLOCKED_AUTH" && summary.monitoringDisposition === "TECHNICAL_FINAL" &&
      summary.verifiedAccessRestriction === true) return { outcome: "DIRECT_ACTION", evidenceAt: probe.observedAt };
  if (probe.outcome !== "MATCH_FOUND" && probe.outcome !== "NO_MATCH") return null;

  const bookingWindow = asRecord(summary.bookingWindow);
  if (bookingWindow) {
    const opensAt = readTimestamp(bookingWindow.opensAt);
    const { source, evidenceUrl } = bookingWindow;
    return probe.outcome === "NO_MATCH" && summary.targetDate === targetDate && opensAt && opensAt > recordedAt &&
      (source === "PROVIDER_CONFIG" || source === "PROVIDER_MESSAGE" || source === "OFFICIAL_BOOKING_PAGE") &&
      getSafeCustomerBookingUrl(evidenceUrl)
      ? { outcome: "BOOKING_NOT_OPEN", evidenceAt: probe.observedAt }
      : null;
  }

  const evidenceAt = getProviderExecutionEvidenceObservedAt({ rawSummary: summary, probeObservedAt: probe.observedAt });
  if (!evidenceAt || evidenceAt < setupStartedAt) return null;
  const availability = asRecord(summary.publicAvailability);
  const verifiedSheet = availability?.date === targetDate && availability.confirmedAt === evidenceAt.toISOString() &&
    Array.isArray(availability.times) && (probe.outcome === "NO_MATCH" || availability.times.length > 0);
  const verifiedRecipe = summary.providerExecution === "RUNNABLE_PROVIDER_CHECK" && summary.complete === true &&
    typeof summary.recipeId === "string" && Boolean(summary.recipeId) &&
    typeof summary.recipeExecutionId === "string" && Boolean(summary.recipeExecutionId) &&
    isHash(summary.recipeHash) && summary.observedAt === evidenceAt.toISOString();
  if (!verifiedSheet && !verifiedRecipe) return null;
  return { outcome: probe.outcome === "MATCH_FOUND" ? "MATCHES_AVAILABLE" : "NO_OPENINGS", evidenceAt };
}
