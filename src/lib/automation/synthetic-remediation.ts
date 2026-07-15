import type {
  CourseSupportIncidentKind,
  DetectedPlatform,
  ProbeOutcome
} from "@prisma/client";

export type SyntheticRemediationCourse = {
  id: string;
  name: string;
  detectedPlatform: DetectedPlatform;
  detectedBookingUrl: string | null;
  website: string | null;
};

export type SyntheticRemediationSearch = {
  id: string;
  preferences: Array<{ course: SyntheticRemediationCourse }>;
  probes: Array<{
    courseId: string;
    outcome: ProbeOutcome;
    observedAt: Date;
    message: string | null;
  }>;
};

export type SyntheticRemediationCandidate = {
  searchId: string;
  course: SyntheticRemediationCourse;
  kind: CourseSupportIncidentKind;
  message: string;
  nextAction: string;
  observedAt: Date;
  affectedPreferenceCount: number;
};

export type SyntheticRemediationCoverageSummary = {
  selectedPreferences: number;
  missingOutcomes: number;
  latestOutcomeCounts: Partial<Record<ProbeOutcome, number>>;
};

const INCIDENT_KIND_BY_OUTCOME: Partial<
  Record<ProbeOutcome, CourseSupportIncidentKind>
> = {
  NEEDS_ADAPTER: "NEEDS_ADAPTER",
  FETCH_FAILED: "FETCH_FAILED"
};

export function selectSyntheticRemediationCandidates(
  searches: SyntheticRemediationSearch[]
): SyntheticRemediationCandidate[] {
  const candidatesByCourse = new Map<string, SyntheticRemediationCandidate>();

  for (const search of searches) {
    const latestProbeByCourse = new Map<
      string,
      SyntheticRemediationSearch["probes"][number]
    >();
    for (const probe of search.probes) {
      const current = latestProbeByCourse.get(probe.courseId);
      if (!current || probe.observedAt > current.observedAt) {
        latestProbeByCourse.set(probe.courseId, probe);
      }
    }

    for (const preference of search.preferences) {
      const probe = latestProbeByCourse.get(preference.course.id);
      const kind = probe ? INCIDENT_KIND_BY_OUTCOME[probe.outcome] : undefined;
      if (!probe || !kind) {
        continue;
      }

      const existing = candidatesByCourse.get(preference.course.id);
      const affectedPreferenceCount = (existing?.affectedPreferenceCount ?? 0) + 1;
      if (existing && existing.observedAt >= probe.observedAt) {
        existing.affectedPreferenceCount = affectedPreferenceCount;
        continue;
      }

      candidatesByCourse.set(preference.course.id, {
        searchId: search.id,
        course: preference.course,
        kind,
        message:
          probe.message ??
          (kind === "FETCH_FAILED"
            ? "The latest policy-safe provider check failed."
            : "No reusable policy-safe monitoring connection is configured."),
        nextAction:
          kind === "FETCH_FAILED"
            ? "Reproduce the current policy-safe public fetch, repair or reclassify the reusable provider integration, and verify the course."
            : "Inspect the official booking surface, implement reusable policy-safe monitoring when possible, or persist a conclusive policy/contact/identity classification.",
        observedAt: probe.observedAt,
        affectedPreferenceCount
      });
    }
  }

  return [...candidatesByCourse.values()].sort(
    (left, right) => right.observedAt.getTime() - left.observedAt.getTime()
  );
}

export function summarizeSyntheticRemediationCoverage(
  searches: SyntheticRemediationSearch[]
): SyntheticRemediationCoverageSummary {
  const latestOutcomeCounts: Partial<Record<ProbeOutcome, number>> = {};
  let selectedPreferences = 0;
  let missingOutcomes = 0;

  for (const search of searches) {
    const latestProbeByCourse = new Map<
      string,
      SyntheticRemediationSearch["probes"][number]
    >();
    for (const probe of search.probes) {
      const current = latestProbeByCourse.get(probe.courseId);
      if (!current || probe.observedAt > current.observedAt) {
        latestProbeByCourse.set(probe.courseId, probe);
      }
    }

    for (const preference of search.preferences) {
      selectedPreferences += 1;
      const outcome = latestProbeByCourse.get(preference.course.id)?.outcome;
      if (!outcome) {
        missingOutcomes += 1;
        continue;
      }
      latestOutcomeCounts[outcome] = (latestOutcomeCounts[outcome] ?? 0) + 1;
    }
  }

  return { selectedPreferences, missingOutcomes, latestOutcomeCounts };
}
