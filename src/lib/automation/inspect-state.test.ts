import { describe, expect, it } from "vitest";

import { latestCurrentActionableProbes } from "../../../scripts/automation/inspect-state";

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
