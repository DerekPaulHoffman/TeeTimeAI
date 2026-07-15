import { describe, expect, it } from "vitest";

import {
  selectSyntheticRemediationCandidates,
  summarizeSyntheticRemediationCoverage,
  type SyntheticRemediationSearch
} from "./synthetic-remediation";

const course = {
  id: "course-1",
  name: "Example Course",
  detectedPlatform: "UNKNOWN" as const,
  detectedBookingUrl: null,
  website: "https://example.com"
};

describe("selectSyntheticRemediationCandidates", () => {
  it("uses the newest per-course observation before filtering failures", () => {
    const searches: SyntheticRemediationSearch[] = [
      {
        id: "search-1",
        preferences: [{ course }],
        probes: [
          {
            courseId: course.id,
            outcome: "NEEDS_ADAPTER",
            observedAt: new Date("2026-07-15T10:00:00Z"),
            message: "Old failure"
          },
          {
            courseId: course.id,
            outcome: "NO_MATCH",
            observedAt: new Date("2026-07-15T11:00:00Z"),
            message: null
          }
        ]
      }
    ];

    expect(selectSyntheticRemediationCandidates(searches)).toEqual([]);
  });

  it("deduplicates a shared course while retaining affected preference count", () => {
    const searches: SyntheticRemediationSearch[] = [
      {
        id: "search-1",
        preferences: [{ course }],
        probes: [
          {
            courseId: course.id,
            outcome: "NEEDS_ADAPTER",
            observedAt: new Date("2026-07-15T10:00:00Z"),
            message: "Needs support"
          }
        ]
      },
      {
        id: "search-2",
        preferences: [{ course }],
        probes: [
          {
            courseId: course.id,
            outcome: "FETCH_FAILED",
            observedAt: new Date("2026-07-15T12:00:00Z"),
            message: "Latest fetch failed"
          }
        ]
      }
    ];

    expect(selectSyntheticRemediationCandidates(searches)).toMatchObject([
      {
        searchId: "search-2",
        kind: "FETCH_FAILED",
        message: "Latest fetch failed",
        affectedPreferenceCount: 2
      }
    ]);
  });

  it("includes unresolved evidence even when the source search is no longer active", () => {
    const searches: SyntheticRemediationSearch[] = [
      {
        id: "completed-search",
        preferences: [{ course }],
        probes: [
          {
            courseId: course.id,
            outcome: "NEEDS_ADAPTER",
            observedAt: new Date("2026-07-15T12:00:00Z"),
            message: null
          }
        ]
      }
    ];

    expect(selectSyntheticRemediationCandidates(searches)).toHaveLength(1);
  });

  it("accounts for every selected preference with its newest outcome", () => {
    const secondCourse = { ...course, id: "course-2", name: "Second Course" };
    const searches: SyntheticRemediationSearch[] = [
      {
        id: "search-1",
        preferences: [{ course }, { course: secondCourse }],
        probes: [
          {
            courseId: course.id,
            outcome: "NEEDS_ADAPTER",
            observedAt: new Date("2026-07-15T10:00:00Z"),
            message: null
          },
          {
            courseId: course.id,
            outcome: "NO_MATCH",
            observedAt: new Date("2026-07-15T11:00:00Z"),
            message: null
          }
        ]
      }
    ];

    expect(summarizeSyntheticRemediationCoverage(searches)).toEqual({
      selectedPreferences: 2,
      missingOutcomes: 1,
      latestOutcomeCounts: { NO_MATCH: 1 }
    });
  });
});
