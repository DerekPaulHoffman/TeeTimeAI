import { describe, expect, it } from "vitest";

import {
  activeSearchInspectionQuery,
  latestCurrentActionableProbes,
  summarizeWebsiteEventCounts
} from "../../../scripts/automation/inspect-state";

describe("activeSearchInspectionQuery", () => {
  it("keeps same-day and stale active searches visible", () => {
    expect(activeSearchInspectionQuery.where).toEqual({ status: "ACTIVE" });
    expect(activeSearchInspectionQuery.where).not.toHaveProperty("date");
  });
});

describe("latestCurrentActionableProbes", () => {
  it("does not surface resolved blocked-policy probes for blocked courses", () => {
    const probes = latestCurrentActionableProbes([
      {
        teeSearchId: "search-1",
        courseId: "course-1",
        outcome: "BLOCKED_POLICY",
        course: {
          automationEligibility: "BLOCKED"
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
