import { describe, expect, it } from "vitest";

import { selectImprovementCandidate } from "./improvement";

describe("selectImprovementCandidate", () => {
  it("selects pending alerts before broader improvement work", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 3,
      pendingAlerts: [
        {
          id: "match-1",
          courseName: "Tashua Knolls",
          firstSeenAt: "2026-07-09T12:00:00.000Z"
        }
      ],
      actionableProbes: []
    });

    expect(candidate).toEqual({
      outcome: "success",
      kind: "pending_alert",
      summary: "Drain 1 pending tee-time alert before selecting new product work.",
      referenceId: "match-1"
    });
  });

  it("maps adapter probes to a needs_adapter terminal outcome", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 1,
      pendingAlerts: [],
      actionableProbes: [
        {
          id: "probe-1",
          outcome: "NEEDS_ADAPTER",
          courseName: "Example Golf",
          platform: "GOLFNOW",
          observedAt: "2026-07-09T12:00:00.000Z",
          message: "No supported adapter yet for GOLFNOW"
        }
      ]
    });

    expect(candidate).toMatchObject({
      outcome: "needs_adapter",
      kind: "adapter_gap",
      referenceId: "probe-1"
    });
  });

  it("returns no_op when there is no active queue", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 0,
      pendingAlerts: [],
      actionableProbes: []
    });

    expect(candidate).toEqual({
      outcome: "no_op",
      kind: "empty_queue",
      summary: "No active tee-time searches need polling or improvement work."
    });
  });
});
