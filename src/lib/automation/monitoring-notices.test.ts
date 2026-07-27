import { describe, expect, it } from "vitest";

import {
  buildMonitoringNoticeGroupKey,
  getMonitoringProviderLabel,
  planMonitoringNotices,
  type MonitoringNoticeCandidate
} from "./monitoring-notices";

const degradedAt = new Date("2026-07-27T14:00:00.000Z");

function candidate(input: {
  courseId: string;
  providerFamilyKey?: string;
  outcome?: "FETCH_FAILED" | "NO_MATCH" | "MATCH_FOUND";
  previousState?: "HEALTHY" | "DEGRADED_RETRYING" | "AUTO_INVESTIGATING";
  currentState?: "HEALTHY" | "DEGRADED_RETRYING" | "AUTO_INVESTIGATING";
  firstDegradedAt?: Date | null;
  failureFingerprint?: string | null;
}): MonitoringNoticeCandidate {
  const firstDegradedAt =
    input.firstDegradedAt === undefined ? degradedAt : input.firstDegradedAt;
  return {
    providerFamilyKey: input.providerFamilyKey ?? "CHRONOGOLF",
    result: {
      courseId: input.courseId,
      courseName: `Course ${input.courseId}`,
      outcome: input.outcome ?? "FETCH_FAILED",
      availableMatches: input.outcome === "MATCH_FOUND" ? 1 : 0
    },
    previous: input.previousState
      ? {
          state: input.previousState,
          firstDegradedAt,
          failureFingerprint: "chronogolf-network"
        }
      : null,
    current: input.currentState
      ? {
          state: input.currentState,
          firstDegradedAt:
            input.currentState === "HEALTHY" ? null : firstDegradedAt,
          failureFingerprint:
            input.currentState === "HEALTHY"
              ? null
              : (input.failureFingerprint ?? "chronogolf-network")
        }
      : null
  };
}

describe("customer monitoring notice policy", () => {
  it("keeps one isolated failure quiet", () => {
    const plan = planMonitoringNotices({
      candidates: [
        candidate({
          courseId: "one",
          previousState: "HEALTHY",
          currentState: "DEGRADED_RETRYING"
        })
      ],
      reachedOutages: [],
      ownerRecipient: "owner@example.com"
    });

    expect(plan.outageCourses).toEqual([]);
    expect(plan.recoveryCourses).toEqual([]);
  });

  it("announces a repeated confirmed outage once", () => {
    const current = candidate({
      courseId: "one",
      previousState: "DEGRADED_RETRYING",
      currentState: "AUTO_INVESTIGATING"
    });
    const first = planMonitoringNotices({
      candidates: [current],
      reachedOutages: [],
      ownerRecipient: "owner@example.com"
    });
    const duplicate = planMonitoringNotices({
      candidates: [current],
      reachedOutages: [
        {
          courseId: "one",
          recipient: "owner@example.com",
          sentAt: new Date("2026-07-27T14:05:00.000Z")
        }
      ],
      ownerRecipient: "owner@example.com"
    });

    expect(first.outageCourses.map((course) => course.courseId)).toEqual(["one"]);
    expect(duplicate.outageCourses).toEqual([]);
  });

  it("corroborates the same provider failure across two courses", () => {
    const candidates = ["one", "two"].map((courseId) =>
      candidate({
        courseId,
        currentState: "DEGRADED_RETRYING",
        failureFingerprint: "chronogolf-5xx"
      })
    );

    expect(
      planMonitoringNotices({
        candidates,
        reachedOutages: [],
        ownerRecipient: "owner@example.com"
      }).outageCourses.map((course) => course.courseId)
    ).toEqual(["one", "two"]);
  });

  it("uses provider-wide corroboration from another active search", () => {
    const current = candidate({
      courseId: "one",
      currentState: "DEGRADED_RETRYING",
      failureFingerprint: "chronogolf-5xx"
    });

    expect(
      planMonitoringNotices({
        candidates: [current],
        reachedOutages: [],
        ownerRecipient: "owner@example.com",
        corroboratedFailureKeys: ["CHRONOGOLF:chronogolf-5xx"]
      }).outageCourses.map((course) => course.courseId)
    ).toEqual(["one"]);
  });

  it("notifies recovery only after this episode reached the owner", () => {
    const recovered = candidate({
      courseId: "one",
      outcome: "NO_MATCH",
      previousState: "AUTO_INVESTIGATING",
      currentState: "HEALTHY"
    });
    const plan = planMonitoringNotices({
      candidates: [recovered],
      reachedOutages: [
        {
          courseId: "one",
          recipient: "owner@example.com",
          sentAt: new Date("2026-07-27T14:05:00.000Z")
        },
        {
          courseId: "one",
          recipient: "friend@example.com",
          sentAt: new Date("2026-07-27T14:06:00.000Z")
        },
        {
          courseId: "one",
          recipient: "old@example.com",
          sentAt: new Date("2026-07-27T13:00:00.000Z")
        }
      ],
      ownerRecipient: "owner@example.com"
    });

    expect(plan.recoveryCourses.map((course) => course.courseId)).toEqual(["one"]);
    expect(plan.recoveryRecipients).toEqual([
      "friend@example.com",
      "owner@example.com"
    ]);
  });

  it("does not send a recovery notice when only another recipient saw the outage", () => {
    const plan = planMonitoringNotices({
      candidates: [
        candidate({
          courseId: "one",
          outcome: "MATCH_FOUND",
          previousState: "AUTO_INVESTIGATING",
          currentState: "HEALTHY"
        })
      ],
      reachedOutages: [
        {
          courseId: "one",
          recipient: "friend@example.com",
          sentAt: new Date("2026-07-27T14:05:00.000Z")
        }
      ],
      ownerRecipient: "owner@example.com"
    });

    expect(plan.recoveryCourses).toEqual([]);
    expect(plan.recoveryRecipients).toEqual([]);
  });

  it("uses a stable episode key and a customer-facing provider name", () => {
    const candidates = [
      candidate({
        courseId: "two",
        currentState: "AUTO_INVESTIGATING"
      }),
      candidate({
        courseId: "one",
        currentState: "AUTO_INVESTIGATING"
      })
    ];

    expect(
      buildMonitoringNoticeGroupKey("outage", candidates, ["one", "two"])
    ).toBe(
      buildMonitoringNoticeGroupKey("outage", [...candidates].reverse(), [
        "two",
        "one"
      ])
    );
    expect(getMonitoringProviderLabel(candidates, ["one", "two"])).toBe(
      "Chronogolf"
    );
  });
});
