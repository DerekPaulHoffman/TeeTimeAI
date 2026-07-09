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
      actionableProbes: [],
      learningSignals: []
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
      ],
      learningSignals: []
    });

    expect(candidate).toMatchObject({
      outcome: "needs_adapter",
      kind: "adapter_gap",
      referenceId: "probe-1"
    });
  });

  it("skips repeated stale adapter gaps and follows a living learning signal", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 2,
      pendingAlerts: [],
      actionableProbes: [
        {
          id: "probe-1",
          outcome: "NEEDS_ADAPTER",
          courseName: "Longshore Golf Course",
          platform: "UNKNOWN",
          observedAt: "2026-07-09T12:00:00.000Z",
          message: "No supported adapter yet for UNKNOWN"
        }
      ],
      learningSignals: [
        {
          key: "adapter:Longshore Golf Course",
          kind: "adapter_gap",
          summary: "Longshore was inspected twice with no reusable adapter learned.",
          lastSeenAt: "2026-07-09T12:00:00.000Z",
          repeats: 3,
          status: "stale",
          nextAction: "Only revisit if a new booking URL or platform signal appears."
        },
        {
          key: "research:waitlist-ux",
          kind: "research",
          summary: "Compare current tee-time waitlist products for onboarding friction.",
          lastSeenAt: "2026-07-09T12:00:00.000Z",
          repeats: 1,
          status: "open",
          nextAction: "Ship one measurable UX improvement if research finds a gap."
        }
      ]
    });

    expect(candidate).toMatchObject({
      outcome: "success",
      kind: "learning_followup",
      referenceId: "research:waitlist-ux"
    });
  });

  it("returns no_op when there is no active queue", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 0,
      pendingAlerts: [],
      actionableProbes: [],
      learningSignals: []
    });

    expect(candidate).toEqual({
      outcome: "no_op",
      kind: "empty_queue",
      summary: "No active tee-time searches need polling or improvement work."
    });
  });
});
