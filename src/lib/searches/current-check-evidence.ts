import { getProviderExecutionEvidenceObservedAt } from "@/lib/automation/provider-execution-evidence";
import { readAlertGenerationStartedAt } from "@/lib/searches/generation-clock";

type CurrentCheckSearch = {
  mode?: string;
  alertGeneration?: number;
  createdAt?: Date;
  statusEmailSnapshot?: unknown;
  lastCheckedAt?: Date | null;
  lastCheckOutcome?: string | null;
  preferences: Array<{ course: { id: string }; offeringId?: string | null }>;
};

type SearchProbe = {
  offeringId?: string | null;
  courseId: string;
  observedAt: Date;
  outcome: string;
  rawSummary?: unknown;
};

// The durable generation clock is read before its private envelope is removed
// from the owner-facing projection. Missing legacy clocks are not current proof.
export function projectCurrentCheckEvidence<
  T extends CurrentCheckSearch & { probes: SearchProbe[] },
>(search: T) {
  const startedAt =
    typeof search.alertGeneration === "number" && Number.isInteger(search.alertGeneration)
      && search.alertGeneration >= 0 && search.createdAt instanceof Date
      ? readAlertGenerationStartedAt({
          alertGeneration: search.alertGeneration,
          createdAt: search.createdAt,
          statusEmailSnapshot: search.statusEmailSnapshot,
        })
      : null;
  const selectedCourses = new Set(
    (search.preferences ?? []).map((preference) => preference.course.id),
  );
  const currentTimestamp = (value: Date | null | undefined) =>
    Boolean(startedAt && value instanceof Date &&
      Number.isFinite(value.getTime()) && value >= startedAt);

  return {
    ...search,
    lastCheckedAt: currentTimestamp(search.lastCheckedAt)
      ? search.lastCheckedAt ?? null
      : null,
    lastCheckOutcome: currentTimestamp(search.lastCheckedAt)
      ? search.lastCheckOutcome ?? null
      : null,
    probes: (search.probes ?? []).filter((probe) => {
      if (!selectedCourses.has(probe.courseId) || !currentTimestamp(probe.observedAt)) {
        return false;
      }
      if (search.mode === "SIMULATOR") {
        if (!probe.offeringId || !search.preferences.some(preference => preference.offeringId === probe.offeringId)) return false;
        if (probe.outcome !== "MATCH_FOUND" && probe.outcome !== "NO_MATCH") return true;
        const summary = probe.rawSummary && typeof probe.rawSummary === "object" && !Array.isArray(probe.rawSummary)
          ? probe.rawSummary as { mode?: unknown; providerObservedAt?: unknown; bookingNotOpen?: unknown; opensAt?: unknown } : null;
        if (summary?.mode !== "SIMULATOR") return false;
        if (summary.bookingNotOpen === true) return typeof summary.opensAt === "string" && Date.parse(summary.opensAt) > Date.now();
        return typeof summary.providerObservedAt === "string" && currentTimestamp(new Date(summary.providerObservedAt));
      }
      if (probe.outcome !== "MATCH_FOUND" && probe.outcome !== "NO_MATCH") {
        return true;
      }
      // A newly persisted cached result can still describe an older request.
      // Operational booking-window guidance comes from the reusable course facts.
      return currentTimestamp(getProviderExecutionEvidenceObservedAt({
        rawSummary: probe.rawSummary,
        probeObservedAt: probe.observedAt,
      }));
    }),
  };
}
