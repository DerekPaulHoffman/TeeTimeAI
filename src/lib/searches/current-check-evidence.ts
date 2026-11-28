import { getProviderExecutionEvidenceObservedAt } from "@/lib/automation/provider-execution-evidence";
import { readAlertGenerationStartedAt } from "@/lib/searches/generation-clock";
import { readCourseSetupStartedAt } from "@/lib/searches/course-setup-deadline";

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

function isSince(value: Date | null | undefined, startedAt: Date | null) {
  return Boolean(startedAt && value instanceof Date && Number.isFinite(value.getTime()) && value >= startedAt);
}

function isSuccessfulProbe<T extends SearchProbe>(probe: T): probe is T & { outcome: "MATCH_FOUND" | "NO_MATCH" } {
  return probe.outcome === "MATCH_FOUND" || probe.outcome === "NO_MATCH";
}

function hasCurrentProviderProof(probe: SearchProbe, mode: string | undefined, startedAt: Date | null) {
  if (mode !== "SIMULATOR") {
    // A newly persisted cached result can still describe an older request.
    return isSince(getProviderExecutionEvidenceObservedAt({
      rawSummary: probe.rawSummary,
      probeObservedAt: probe.observedAt,
    }), startedAt);
  }
  const summary = probe.rawSummary && typeof probe.rawSummary === "object" && !Array.isArray(probe.rawSummary)
    ? probe.rawSummary as Record<string, unknown> : null;
  if (summary?.mode !== "SIMULATOR") return false;
  if (summary.bookingNotOpen === true) return typeof summary.opensAt === "string" && Date.parse(summary.opensAt) > Date.now();
  return typeof summary.providerObservedAt === "string" && isSince(new Date(summary.providerObservedAt), startedAt);
}

// This evidence describes setup only. Delivery and current availability still
// require the exact alert generation. Edited legacy rows have no proof that an
// older check covered the current criteria, so they use only current evidence.
export function getCourseSetupProbe<T extends SearchProbe>(
  search: { mode?: string; alertGeneration: number; createdAt: Date; setupStartedAt?: Date | null },
  probe: T | undefined,
) {
  if (!probe || !isSuccessfulProbe(probe) || (!search.setupStartedAt && search.alertGeneration !== 0)) return undefined;
  const startedAt = readCourseSetupStartedAt(search);
  if (!isSince(probe.observedAt, startedAt) || !hasCurrentProviderProof(probe, search.mode, startedAt)) return undefined;
  const summary = search.mode === "SIMULATOR" ? probe.rawSummary as Record<string, unknown> : null;
  return {
    observedAt: probe.observedAt,
    outcome: probe.outcome,
    rawSummary: summary ? {
      mode: summary.mode,
      sourceFingerprint: summary.sourceFingerprint,
      providerObservedAt: summary.providerObservedAt,
      bookingNotOpen: summary.bookingNotOpen,
      opensAt: summary.opensAt,
    } : null,
  };
}

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
  const selectedCourses = new Map((search.preferences ?? []).map(preference => [preference.course.id, preference.offeringId]));
  const currentTimestamp = (value: Date | null | undefined) => isSince(value, startedAt);

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
      if (search.mode === "SIMULATOR" && (!probe.offeringId || probe.offeringId !== selectedCourses.get(probe.courseId))) return false;
      return !isSuccessfulProbe(probe) || hasCurrentProviderProof(probe, search.mode, startedAt);
    }),
  };
}
