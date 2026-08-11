import { describe, expect, it } from "vitest";

import {
  buildAlertFinalityReport,
  buildAlertFinalitySummary,
  isCurrentIncidentCycleForSearch
} from "./inspect-alert-finality";

const createdAt = new Date("2026-08-10T14:00:00.000Z");

function delivery(courses: Array<Record<string, unknown>>, sentMinutes = 5) {
  return {
    status: "SENT",
    sentAt: new Date(createdAt.getTime() + sentMinutes * 60 * 1000),
    payload: {
      statusReport: { courses },
      statusSnapshot: courses.map((course) => ({
        courseId: course.courseId,
        courseName: course.courseName,
        state: `${course.outcome}:test`,
        ...(course.customerStatus
          ? { customerStatus: course.customerStatus }
          : {})
      }))
    }
  };
}

function search(overrides: Record<string, unknown> = {}) {
  return {
    id: "search-1",
    createdAt,
    preferences: [
      {
        courseId: "course-1",
        course: { monitoringStatus: null, supportIncident: null }
      },
      {
        courseId: "course-2",
        course: { monitoringStatus: null, supportIncident: null }
      }
    ],
    probes: [],
    emailDeliveries: [],
    ...overrides
  } as Parameters<typeof buildAlertFinalityReport>[0];
}

describe("alert finality audit", () => {
  it("separates effective monitoring from automatic retry and report delivery", () => {
    const report = buildAlertFinalityReport(
      search({
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Monitored",
              outcome: "NO_MATCH",
              customerStatus: "MONITORED"
            },
            {
              courseId: "course-2",
              courseName: "Retrying",
              outcome: "FETCH_FAILED",
              customerStatus: "RETRYING_AUTOMATICALLY"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:06:00.000Z")
    );

    expect(report.reportDeliveryComplete).toBe(true);
    expect(report.customerStatusComplete).toBe(true);
    expect(report.effectiveMonitoringCourseCount).toBe(1);
    expect(report.automaticRetryCourseCount).toBe(1);
    expect(report.factualFinalityCourseCount).toBe(0);
    expect(report.effectiveOrFactualFinalityComplete).toBe(false);
    expect(report.metTenMinuteReportTarget).toBe(true);
    expect(report.metTenMinuteEffectiveOrFactualTarget).toBe(false);
  });

  it("counts manual review separately from factual finality", () => {
    const report = buildAlertFinalityReport(
      search({
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Human",
              outcome: "NEEDS_ADAPTER",
              customerStatus: "NEEDS_HUMAN_REVIEW"
            },
            {
              courseId: "course-2",
              courseName: "Phone",
              outcome: "MANUAL_DIRECT",
              monitoringDisposition: "MANUAL_FINAL",
              customerStatus: "FINAL_DIRECT_ACTION"
            }
          ])
        ]
      })
    );

    expect(report.humanReviewCourseCount).toBe(1);
    expect(report.factualFinalityCourseCount).toBe(1);
    expect(report.effectiveOrFactualFinalityComplete).toBe(false);
  });

  it("does not credit an old resolved incident to a new alert", () => {
    const oldIncident = {
      id: "incident-old",
      cycle: 1,
      status: "RESOLVED",
      firstAffectedSearchId: "search-old",
      firstSeenAt: new Date("2026-08-01T12:00:00.000Z"),
      lastSeenAt: new Date("2026-08-01T13:00:00.000Z")
    };
    const input = search({
      preferences: [
        {
          courseId: "course-1",
          course: { monitoringStatus: null, supportIncident: oldIncident }
        }
      ],
      emailDeliveries: [
        delivery([
          {
            courseId: "course-1",
            courseName: "Retrying",
            outcome: "FETCH_FAILED"
          }
        ])
      ]
    });

    expect(
      isCurrentIncidentCycleForSearch({
        searchId: input.id,
        searchCreatedAt: input.createdAt,
        incident: oldIncident,
        probes: input.probes,
        courseId: "course-1"
      })
    ).toBe(false);
    expect(buildAlertFinalityReport(input).issueRecordingComplete).toBe(false);
  });

  it("credits the current incident cycle when this search produced the failure", () => {
    const currentIncident = {
      id: "incident-current",
      cycle: 4,
      status: "AUTO_INVESTIGATING",
      firstAffectedSearchId: "search-old",
      firstSeenAt: new Date("2026-08-10T13:00:00.000Z"),
      lastSeenAt: new Date("2026-08-10T14:03:00.000Z")
    };
    const input = search({
      preferences: [
        {
          courseId: "course-1",
          course: { monitoringStatus: null, supportIncident: currentIncident }
        }
      ],
      probes: [
        {
          courseId: "course-1",
          outcome: "FETCH_FAILED",
          observedAt: new Date("2026-08-10T14:02:00.000Z")
        }
      ],
      emailDeliveries: [
        delivery([
          {
            courseId: "course-1",
            courseName: "Retrying",
            outcome: "FETCH_FAILED"
          }
        ])
      ]
    });

    expect(buildAlertFinalityReport(input).currentIncidentCycleCourseCount).toBe(
      1
    );
    expect(buildAlertFinalityReport(input).issueRecordingComplete).toBe(true);
  });

  it("marks a ten-minute-old checking report as stuck", () => {
    const report = buildAlertFinalityReport(
      search({
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Pending",
              outcome: "CHECK_PENDING",
              customerStatus: "CHECKING"
            },
            {
              courseId: "course-2",
              courseName: "Monitored",
              outcome: "NO_MATCH",
              customerStatus: "MONITORED"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:11:00.000Z")
    );

    expect(report.reportDeliveryComplete).toBe(true);
    expect(report.customerStatusComplete).toBe(false);
    expect(report.stuck).toBe(true);
  });

  it("reports p50 and p95 only from complete customer-status reports", () => {
    const summary = buildAlertFinalitySummary([
      search({
        id: "search-fast",
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "One",
              outcome: "NO_MATCH",
              customerStatus: "MONITORED"
            },
            {
              courseId: "course-2",
              courseName: "Two",
              outcome: "NO_MATCH",
              customerStatus: "MONITORED"
            }
          ], 4)
        ]
      }),
      search({
        id: "search-slow",
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "One",
              outcome: "NO_MATCH",
              customerStatus: "MONITORED"
            },
            {
              courseId: "course-2",
              courseName: "Two",
              outcome: "MANUAL_DIRECT",
              customerStatus: "FINAL_DIRECT_ACTION"
            }
          ], 8)
        ]
      })
    ]);

    expect(summary.deliverySeconds).toEqual({ p50: 240, p95: 480, maximum: 480 });
    expect(summary.tenMinuteReportSuccessCount).toBe(2);
  });
});
