import { describe, expect, it } from "vitest";

import {
  activeSearchInspectionQuery,
  extractImprovementRunMemory,
  latestCurrentActionableProbes,
  summarizeCourseDiscoveryOutcomes,
  summarizeWebsiteEventCounts
} from "../../../scripts/automation/inspect-state";

describe("extractImprovementRunMemory", () => {
  it("keeps the hourly decision trail without repeating the embedded prompt", () => {
    expect(
      extractImprovementRunMemory(
        JSON.stringify({
          lifecycle: "closeout",
          provenance: { branch: "automation/hourly-example" },
          candidate: { summary: "Expose durable hourly memory." },
          nextPrompt: "Very large repeated operating prompt",
          audit: {
            selectedCategory: "test_developer_tooling",
            candidateRanking: ["1. test_developer_tooling: durable memory"],
            evidenceTrackResults: {
              operations_errors: "healthy",
              product_quality: "inspector gap reproduced"
            },
            coverageBlockers: ["Discord history unavailable"],
            commitSha: "abc123",
            deploymentId: "dpl_example",
            changedBehavior: "Inspector exposes prior hourly decisions.",
            measuredResult: "Three hourly runs are visible.",
            learning: ["Frequent workflow checks crowd the global recent window."],
            blockers: [],
            nextRotationTargets: ["Rotate to dashboard keyboard coverage."]
          }
        })
      )
    ).toEqual({
      lifecycle: "closeout",
      branch: "automation/hourly-example",
      candidateSummary: "Expose durable hourly memory.",
      selectedCategory: "test_developer_tooling",
      candidateRanking: ["1. test_developer_tooling: durable memory"],
      evidenceTrackResults: {
        operations_errors: "healthy",
        product_quality: "inspector gap reproduced"
      },
      coverageBlockers: ["Discord history unavailable"],
      commitSha: "abc123",
      deploymentId: "dpl_example",
      changedBehavior: "Inspector exposes prior hourly decisions.",
      measuredResult: "Three hourly runs are visible.",
      learning: ["Frequent workflow checks crowd the global recent window."],
      blockers: [],
      nextRotationTargets: ["Rotate to dashboard keyboard coverage."],
      fallbackSummary: null
    });
  });

  it("falls back safely for older unstructured notes", () => {
    expect(extractImprovementRunMemory("older plain-text run note")).toMatchObject({
      candidateSummary: null,
      learning: [],
      nextRotationTargets: [],
      fallbackSummary: "older plain-text run note"
    });
  });
});

describe("activeSearchInspectionQuery", () => {
  it("keeps same-day and stale active searches visible", () => {
    expect(activeSearchInspectionQuery.where).toEqual({ status: "ACTIVE" });
    expect(activeSearchInspectionQuery.where).not.toHaveProperty("date");
  });
});

describe("latestCurrentActionableProbes", () => {
  it("keeps legacy blocked-policy probes actionable", () => {
    const probes = latestCurrentActionableProbes([
      {
        teeSearchId: "search-1",
        courseId: "course-1",
        outcome: "BLOCKED_POLICY",
        course: {
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED"
        }
      }
    ]);

    expect(probes).toHaveLength(1);
  });

  it("does not surface a current corroborated technical final", () => {
    const probes = latestCurrentActionableProbes([
      {
        teeSearchId: "search-1",
        courseId: "course-1",
        outcome: "BLOCKED_AUTH",
        course: {
          automationEligibility: "BLOCKED",
          automationReason: "CAPTCHA_OR_QUEUE",
          bookingMethod: "PUBLIC_ONLINE",
          intelligenceVerifiedAt: new Date("2026-07-16T12:00:00.000Z"),
          intelligenceReviewAt: new Date("2099-08-16T00:00:00.000Z"),
          intelligenceConfidence: 0.95
        }
      }
    ]);

    expect(probes).toEqual([]);
  });

  it("keeps current unresolved adapter and fetch failures", () => {
    const probes = latestCurrentActionableProbes([
      {
        teeSearchId: "search-1",
        courseId: "course-1",
        outcome: "NO_MATCH",
        course: {
          automationEligibility: "ALLOWED"
        }
      },
      {
        teeSearchId: "search-2",
        courseId: "course-2",
        outcome: "NEEDS_ADAPTER",
        course: {
          automationEligibility: "UNKNOWN"
        }
      },
      {
        teeSearchId: "search-3",
        courseId: "course-3",
        outcome: "FETCH_FAILED",
        course: {
          automationEligibility: "ALLOWED"
        }
      }
    ]);

    expect(probes.map((probe) => probe.outcome)).toEqual([
      "NEEDS_ADAPTER",
      "FETCH_FAILED"
    ]);
  });
});

describe("summarizeWebsiteEventCounts", () => {
  it("keeps public funnel evidence separate from automation traffic", () => {
    expect(
      summarizeWebsiteEventCounts([
        {
          trafficClass: "AUTOMATION",
          name: "course_discovery_completed",
          _count: { _all: 8 }
        },
        {
          trafficClass: "PUBLIC",
          name: "course_discovery_completed",
          _count: { _all: 2 }
        },
        {
          trafficClass: "PUBLIC",
          name: "page_viewed",
          _count: { _all: 12 }
        }
      ])
    ).toEqual({
      AUTOMATION: {
        course_discovery_completed: 8
      },
      PUBLIC: {
        course_discovery_completed: 2,
        page_viewed: 12
      }
    });
  });
});

describe("summarizeCourseDiscoveryOutcomes", () => {
  it("turns discovery parameters into traffic-class-separated outcome buckets", () => {
    expect(
      summarizeCourseDiscoveryOutcomes([
        {
          trafficClass: "PUBLIC",
          name: "course_discovery_completed",
          metadata: { resultCount: 5, demo: false }
        },
        {
          trafficClass: "PUBLIC",
          name: "course_discovery_completed",
          metadata: { resultCount: 0, demo: false }
        },
        {
          trafficClass: "PUBLIC",
          name: "course_discovery_failed",
          metadata: { stage: "GEOCODE", responseStatus: 404 }
        },
        {
          trafficClass: "AUTOMATION",
          name: "course_discovery_completed",
          metadata: { resultCount: 3, demo: true }
        },
        {
          trafficClass: "AUTOMATION",
          name: "course_discovery_failed",
          metadata: { stage: "DISCOVERY" }
        }
      ])
    ).toEqual({
      AUTOMATION: {
        completedWithResults: 1,
        completedEmpty: 0,
        demoCompletions: 1,
        failedGeocode: 0,
        failedDiscovery: 1,
        failureStatuses: {
          "DISCOVERY:unknown": 1
        }
      },
      PUBLIC: {
        completedWithResults: 1,
        completedEmpty: 1,
        demoCompletions: 0,
        failedGeocode: 1,
        failedDiscovery: 0,
        failureStatuses: {
          "GEOCODE:404": 1
        }
      }
    });
  });

  it("ignores malformed discovery metadata", () => {
    expect(
      summarizeCourseDiscoveryOutcomes([
        {
          trafficClass: "PUBLIC",
          name: "course_discovery_completed",
          metadata: null
        },
        {
          trafficClass: "PUBLIC",
          name: "course_discovery_failed",
          metadata: { stage: "UNKNOWN", responseStatus: 500 }
        }
      ])
    ).toEqual({
      PUBLIC: {
        completedWithResults: 0,
        completedEmpty: 0,
        demoCompletions: 0,
        failedGeocode: 0,
        failedDiscovery: 0,
        failureStatuses: {}
      }
    });
  });
});
