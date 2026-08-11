import { describe, expect, it } from "vitest";

import {
  buildMonitoringStatusNoticeGroupKey,
  MONITORING_STATUS_CONSOLIDATION_MS,
  planMonitoringStatusNotices,
  type MonitoringStatusNoticeCandidate
} from "./monitoring-status-notices";

function candidate(
  overrides: Partial<MonitoringStatusNoticeCandidate> = {}
): MonitoringStatusNoticeCandidate {
  return {
    providerFamilyKey: "CPS",
    previousStatus: "MONITORED",
    currentStatus: "RETRYING_AUTOMATICALLY",
    episodeStartedAt: new Date("2026-08-10T14:00:00.000Z"),
    result: {
      courseId: "course-1",
      courseName: "Pine Oaks",
      outcome: "FETCH_FAILED",
      availableMatches: 0,
      bookingUrl: "https://pineoaks.cps.golf/onlineresweb/search-teetime"
    },
    ...overrides
  };
}

describe("monitoring status notices", () => {
  it("waits 30 minutes so one status email can consolidate transient changes", () => {
    const planned = planMonitoringStatusNotices({
      candidates: [candidate()],
      reachedOutages: [],
      ownerRecipient: "owner@example.com",
      now: new Date(
        new Date("2026-08-10T14:00:00.000Z").getTime() +
          MONITORING_STATUS_CONSOLIDATION_MS -
          1
      )
    });

    expect(planned.outageCourses).toEqual([]);
    expect(planned.nextConsolidationAt).toEqual(
      new Date("2026-08-10T14:30:00.000Z")
    );
  });

  it("delivers one consolidated outage after the window and remains idempotent", () => {
    const input = candidate();
    const planned = planMonitoringStatusNotices({
      candidates: [input],
      reachedOutages: [],
      ownerRecipient: "owner@example.com",
      now: new Date("2026-08-10T14:30:00.000Z")
    });

    expect(planned.outageCourses).toEqual([input.result]);
    expect(
      buildMonitoringStatusNoticeGroupKey(
        "outage",
        [input],
        [input.result.courseId]
      )
    ).toBe(
      buildMonitoringStatusNoticeGroupKey(
        "outage",
        [input],
        [input.result.courseId]
      )
    );

    const repeated = planMonitoringStatusNotices({
      candidates: [input],
      reachedOutages: [
        {
          courseId: input.result.courseId,
          recipient: "owner@example.com",
          sentAt: new Date("2026-08-10T14:31:00.000Z"),
          customerStatus: "RETRYING_AUTOMATICALLY"
        }
      ],
      ownerRecipient: "owner@example.com",
      now: new Date("2026-08-10T15:00:00.000Z")
    });
    expect(repeated.outageCourses).toEqual([]);
  });

  it("recovers only recipients reached by the outage and keeps same-check matches", () => {
    const recovery = candidate({
      previousStatus: "RETRYING_AUTOMATICALLY",
      currentStatus: "MONITORED",
      result: {
        courseId: "course-1",
        courseName: "Pine Oaks",
        outcome: "MATCH_FOUND",
        availableMatches: 1,
        bookingUrl: "https://pineoaks.cps.golf/onlineresweb/search-teetime",
        matchingTimes: [
          {
            startsAt: "2026-08-12T08:10:00-04:00",
            availableSpots: 4,
            isNew: true
          }
        ]
      }
    });
    const planned = planMonitoringStatusNotices({
      candidates: [recovery],
      reachedOutages: [
        {
          courseId: "course-1",
          recipient: "OWNER@example.com",
          sentAt: new Date("2026-08-10T14:31:00.000Z"),
          customerStatus: "RETRYING_AUTOMATICALLY"
        },
        {
          courseId: "course-1",
          recipient: "friend@example.com",
          sentAt: new Date("2026-08-10T14:31:00.000Z"),
          customerStatus: "RETRYING_AUTOMATICALLY"
        }
      ],
      ownerRecipient: "owner@example.com",
      now: new Date("2026-08-10T15:00:00.000Z")
    });

    expect(planned.recoveryRecipients).toEqual([
      "friend@example.com",
      "owner@example.com"
    ]);
    expect(planned.recoveryCourses[0]?.matchingTimes).toHaveLength(1);
  });

  it("never sends recovery when the owner did not receive the outage", () => {
    const recovery = candidate({
      previousStatus: "NEEDS_HUMAN_REVIEW",
      currentStatus: "MONITORED",
      result: {
        courseId: "course-1",
        courseName: "Pine Oaks",
        outcome: "NO_MATCH",
        availableMatches: 0
      }
    });
    const planned = planMonitoringStatusNotices({
      candidates: [recovery],
      reachedOutages: [
        {
          courseId: "course-1",
          recipient: "friend@example.com",
          sentAt: new Date("2026-08-10T14:31:00.000Z"),
          customerStatus: "NEEDS_HUMAN_REVIEW"
        }
      ],
      ownerRecipient: "owner@example.com",
      now: new Date("2026-08-10T15:00:00.000Z")
    });

    expect(planned.recoveryCourses).toEqual([]);
    expect(planned.recoveryRecipients).toEqual([]);
  });

  it("does not let a reached automatic-retry update suppress later human review", () => {
    const retrying = candidate();
    const needsHuman = candidate({
      previousStatus: "RETRYING_AUTOMATICALLY",
      currentStatus: "NEEDS_HUMAN_REVIEW",
      result: {
        ...retrying.result,
        outcome: "NEEDS_ADAPTER",
        supportStatus: "NEEDS_HUMAN_REVIEW"
      }
    });
    const reachedRetry = {
      courseId: "course-1",
      recipient: "owner@example.com",
      sentAt: new Date("2026-08-10T14:10:00.000Z"),
      customerStatus: "RETRYING_AUTOMATICALLY" as const
    };

    const planned = planMonitoringStatusNotices({
      candidates: [needsHuman],
      reachedOutages: [reachedRetry],
      ownerRecipient: "owner@example.com",
      now: new Date("2026-08-10T14:30:00.000Z")
    });

    expect(planned.outageCourses).toEqual([needsHuman.result]);
    expect(
      buildMonitoringStatusNoticeGroupKey(
        "outage",
        [retrying],
        [retrying.result.courseId]
      )
    ).not.toBe(
      buildMonitoringStatusNoticeGroupKey(
        "outage",
        [needsHuman],
        [needsHuman.result.courseId]
      )
    );

    const repeated = planMonitoringStatusNotices({
      candidates: [needsHuman],
      reachedOutages: [
        reachedRetry,
        {
          ...reachedRetry,
          sentAt: new Date("2026-08-10T14:31:00.000Z"),
          customerStatus: "NEEDS_HUMAN_REVIEW"
        }
      ],
      ownerRecipient: "owner@example.com",
      now: new Date("2026-08-10T14:35:00.000Z")
    });
    expect(repeated.outageCourses).toEqual([]);
  });

  it("consolidates newly factual-final courses after 30 minutes", () => {
    const final = candidate({
      previousStatus: "RETRYING_AUTOMATICALLY",
      currentStatus: "FINAL_DIRECT_ACTION",
      result: {
        courseId: "course-final",
        courseName: "Pine Oaks",
        outcome: "MANUAL_DIRECT",
        availableMatches: 0,
        bookingUrl: "https://course.example/tee-times"
      }
    });
    const duplicate = {
      ...final,
      providerFamilyKey: "SOURCE_MISSING",
      previousStatus: "FINAL_DIRECT_ACTION" as const
    };

    const waiting = planMonitoringStatusNotices({
      candidates: [final, duplicate],
      reachedOutages: [],
      reachedFinals: [],
      ownerRecipient: "owner@example.com",
      now: new Date("2026-08-10T14:29:59.999Z")
    });
    expect(waiting.finalCourses).toEqual([]);
    expect(waiting.nextConsolidationAt).toEqual(
      new Date("2026-08-10T14:30:00.000Z")
    );

    const planned = planMonitoringStatusNotices({
      candidates: [final, duplicate],
      reachedOutages: [],
      reachedFinals: [],
      ownerRecipient: "owner@example.com",
      now: new Date("2026-08-10T14:30:00.000Z")
    });
    expect(planned.finalCourses).toEqual([final.result]);
    expect(
      buildMonitoringStatusNoticeGroupKey(
        "status-update",
        [final],
        [final.result.courseId]
      )
    ).toMatch(/^monitoring-status-update-/);
  });

  it("does not resend a factual-final status reached in the same episode", () => {
    const final = candidate({
      previousStatus: "RETRYING_AUTOMATICALLY",
      currentStatus: "FINAL_DIRECT_ACTION",
      result: {
        courseId: "course-final",
        courseName: "Pine Oaks",
        outcome: "IDENTITY_FINAL",
        availableMatches: 0
      }
    });

    const planned = planMonitoringStatusNotices({
      candidates: [final],
      reachedOutages: [],
      reachedFinals: [
        {
          courseId: final.result.courseId,
          recipient: "owner@example.com",
          sentAt: new Date("2026-08-10T14:31:00.000Z")
        }
      ],
      ownerRecipient: "owner@example.com",
      now: new Date("2026-08-10T15:00:00.000Z")
    });

    expect(planned.finalCourses).toEqual([]);
  });
});
