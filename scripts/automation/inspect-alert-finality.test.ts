import { describe, expect, it } from "vitest";

import {
  buildAlertFinalityReport,
  buildAlertFinalitySummary,
  isCurrentIncidentCycleForSearch
} from "./inspect-alert-finality";
import {
  appendAutomationPlaybookEvent,
  type AutomationPlaybookLedger,
  type AutomationPlaybookReadPath,
  type AutomationPlaybookStage
} from "../../src/lib/automation/course-monitoring-playbook";

const createdAt = new Date("2026-08-10T14:00:00.000Z");

function playbookLedgerThrough(
  stages: Array<[AutomationPlaybookStage, AutomationPlaybookReadPath]>
) {
  let ledger: AutomationPlaybookLedger | null = null;
  for (const [stage, readPath] of stages) {
    const failed =
      stage === "TYPED_ADAPTER" ||
      stage === "HTTP_ADAPTER_RETRY" ||
      stage === "BROWSER_ADAPTER_RETRY";
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage,
      transition: failed ? "FAILED_TERMINAL" : "NOT_APPLICABLE",
      readPath,
      evidenceKind: failed ? "PROVIDER_RESPONSE" : "TOOLING",
      failureFingerprint: `FINALITY:${stage}`,
      failureClass: failed ? "UNKNOWN" : undefined,
      skipReason: failed ? undefined : "MONITORING_MODE_EXCLUDED",
      runtimeVersion: "finality-test",
      observedAt: new Date("2026-08-10T14:20:00.000Z")
    });
  }
  return ledger;
}

function renderedBrowserPendingLedger() {
  return playbookLedgerThrough([
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"]
  ]);
}

function exhaustedLedger() {
  return playbookLedgerThrough([
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["LOCAL_READER", "LOCAL_READER"],
    ["INDEPENDENT_CONFIRMATION", "INDEPENDENT_CONFIRMATION"]
  ]);
}

function revalidatingLedger() {
  return appendAutomationPlaybookEvent(exhaustedLedger(), {
    cycle: 2,
    stage: "OFFICIAL_IDENTITY",
    transition: "NOT_APPLICABLE",
    readPath: "OFFICIAL_IDENTITY",
    evidenceKind: "TOOLING",
    failureFingerprint: "FINALITY:OFFICIAL_IDENTITY",
    skipReason: "MONITORING_MODE_EXCLUDED",
    runtimeVersion: "finality-test",
    observedAt: new Date("2026-08-10T14:25:00.000Z")
  });
}

function delivery(
  courses: Array<Record<string, unknown>>,
  sentMinutes = 5,
  kind = "SETUP"
) {
  return {
    alertGeneration: 0,
    createdAt: new Date(createdAt.getTime() + sentMinutes * 60 * 1000),
    kind,
    status: "SENT",
    sentAt: new Date(createdAt.getTime() + sentMinutes * 60 * 1000),
    payload: {
      checkedAt: new Date(
        createdAt.getTime() + Math.max(0, sentMinutes - 1) * 60 * 1000
      ).toISOString(),
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
    alertGeneration: 0,
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

  it("keeps setup delivery separate from a later factual-final endpoint", () => {
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "FINAL_MANUAL",
                stateChangedAt: new Date("2026-08-10T14:25:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "MANUAL_DIRECT",
            observedAt: new Date("2026-08-10T14:25:00.000Z")
          }
        ],
        emailDeliveries: [
          delivery(
            [
              {
                courseId: "course-1",
                courseName: "Retrying at setup",
                outcome: "FETCH_FAILED",
                customerStatus: "RETRYING_AUTOMATICALLY"
              }
            ],
            5
          ),
          delivery(
            [
              {
                courseId: "course-1",
                courseName: "Phone booking confirmed",
                outcome: "MANUAL_DIRECT",
                monitoringDisposition: "MANUAL_FINAL",
                customerStatus: "FINAL_DIRECT_ACTION"
              }
            ],
            30,
            "MONITORING_STATUS_UPDATE"
          )
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.automaticRetryCourseCount).toBe(1);
    expect(report.factualFinalityCourseCount).toBe(0);
    expect(report.currentAutomaticRetryCourseCount).toBe(0);
    expect(report.currentFactualFinalityCourseCount).toBe(1);
    expect(report.currentEndpointStateComplete).toBe(true);
    expect(report.currentEndpointStateSeconds).toBe(1500);
    expect(report.currentEndpointComplete).toBe(true);
    expect(report.currentEndpointSeconds).toBe(1800);
    expect(report.metThirtyMinuteEndpointTarget).toBe(true);
    expect(
      report.deliveredCurrentCustomerStatusCounts.FINAL_DIRECT_ACTION
    ).toBe(1);
    expect(report.monitoringStatusUpdateDeliveryCount).toBe(1);
    expect(report.latestStatusDeliveryKind).toBe("MONITORING_STATUS_UPDATE");
    expect(report.latestStatusDeliverySeconds).toBe(1800);
  });

  it("does not infer human review or a delivered endpoint from a deadline alone", () => {
    const incident = {
      id: "incident-deadline",
      cycle: 1,
      status: "AUTO_INVESTIGATING",
      attemptLedger: renderedBrowserPendingLedger(),
      humanReviewReason: "AUTOMATION_STALLED",
      firstAffectedSearchId: "search-1",
      firstSeenAt: new Date("2026-08-10T14:02:00.000Z"),
      lastSeenAt: new Date("2026-08-10T14:12:00.000Z"),
      escalationDeadlineAt: new Date("2026-08-10T14:30:00.000Z"),
      escalatedAt: new Date("2026-08-10T14:30:00.000Z")
    };
    const input = search({
      preferences: [
        {
          courseId: "course-1",
          course: {
            monitoringStatus: {
              state: "ENGINEERING_VERIFICATION_NEEDED",
              stateChangedAt: new Date("2026-08-10T14:30:00.000Z")
            },
            supportIncident: incident
          }
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
            outcome: "FETCH_FAILED",
            customerStatus: "RETRYING_AUTOMATICALLY"
          }
        ])
      ]
    });

    const beforeDeadline = buildAlertFinalityReport(
      input,
      new Date("2026-08-10T14:29:00.000Z")
    );
    const afterDeadline = buildAlertFinalityReport(
      input,
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(beforeDeadline.currentAutomaticRetryCourseCount).toBe(1);
    expect(beforeDeadline.currentEndpointComplete).toBe(false);
    expect(afterDeadline.currentHumanReviewCourseCount).toBe(0);
    expect(afterDeadline.currentAutomaticRetryCourseCount).toBe(1);
    expect(afterDeadline.currentEndpointStateComplete).toBe(false);
    expect(afterDeadline.currentEndpointComplete).toBe(false);
    expect(afterDeadline.currentEndpointSeconds).toBeNull();
    expect(afterDeadline.metThirtyMinuteEndpointTarget).toBe(false);
    expect(afterDeadline.endpointStuck).toBe(true);
  });

  it("counts an exact durable automation-stalled handoff as the delivered endpoint", () => {
    const endpointAt = new Date("2026-08-10T14:30:00.000Z");
    const incident = {
      id: "incident-stalled-endpoint",
      cycle: 1,
      status: "AUTO_INVESTIGATING",
      attemptLedger: renderedBrowserPendingLedger(),
      humanReviewReason: "AUTOMATION_STALLED",
      firstAffectedSearchId: "search-1",
      firstSeenAt: new Date("2026-08-10T14:02:00.000Z"),
      lastSeenAt: endpointAt,
      escalationDeadlineAt: endpointAt,
      escalatedAt: endpointAt,
      monitoringEvents: [
        {
          incidentId: "incident-stalled-endpoint",
          eventType: "HUMAN_REVIEW_REQUESTED",
          occurredAt: endpointAt,
          audit: {
            cycle: 1,
            customerState: "NEEDS_HUMAN_REVIEW",
            automationStalled: true,
            playbookExhausted: false,
            escalationDeadlineAt: endpointAt.toISOString()
          }
        }
      ]
    };
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "ENGINEERING_VERIFICATION_NEEDED",
                stateChangedAt: endpointAt
              },
              supportIncident: incident
            }
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
          delivery(
            [
              {
                courseId: "course-1",
                courseName: "Retrying at setup",
                outcome: "FETCH_FAILED",
                customerStatus: "RETRYING_AUTOMATICALLY"
              }
            ],
            5
          ),
          delivery(
            [
              {
                courseId: "course-1",
                courseName: "Engineering handoff",
                outcome: "FETCH_FAILED",
                supportStatus: "NEEDS_HUMAN_REVIEW",
                customerStatus: "NEEDS_HUMAN_REVIEW"
              }
            ],
            30,
            "MONITORING_STATUS_UPDATE"
          )
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.currentHumanReviewCourseCount).toBe(1);
    expect(report.currentAutomaticRetryCourseCount).toBe(0);
    expect(report.currentEndpointStateComplete).toBe(true);
    expect(report.currentEndpointStateSeconds).toBe(1800);
    expect(report.currentEndpointComplete).toBe(true);
    expect(report.currentEndpointSeconds).toBe(1800);
    expect(report.metThirtyMinuteEndpointTarget).toBe(true);
    expect(report.endpointStuck).toBe(false);
  });

  it("projects exact stalled proof for a delivered report missing a status snapshot", () => {
    const endpointAt = new Date("2026-08-10T14:30:00.000Z");
    const incident = {
      id: "incident-stalled-delivery-projection",
      cycle: 1,
      status: "AUTO_INVESTIGATING",
      attemptLedger: renderedBrowserPendingLedger(),
      humanReviewReason: "AUTOMATION_STALLED",
      firstAffectedSearchId: "search-1",
      firstSeenAt: new Date("2026-08-10T14:02:00.000Z"),
      lastSeenAt: endpointAt,
      escalationDeadlineAt: endpointAt,
      escalatedAt: endpointAt,
      monitoringEvents: [
        {
          incidentId: "incident-stalled-delivery-projection",
          eventType: "HUMAN_REVIEW_REQUESTED",
          occurredAt: endpointAt,
          audit: {
            cycle: 1,
            customerState: "NEEDS_HUMAN_REVIEW",
            automationStalled: true,
            playbookExhausted: false,
            escalationDeadlineAt: endpointAt.toISOString()
          }
        }
      ]
    };
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "ENGINEERING_VERIFICATION_NEEDED",
                stateChangedAt: endpointAt
              },
              supportIncident: incident
            }
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
          delivery(
            [
              {
                courseId: "course-1",
                courseName: "Engineering handoff",
                outcome: "FETCH_FAILED",
                supportStatus: "NEEDS_HUMAN_REVIEW"
              }
            ],
            30
          )
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.humanReviewCourseCount).toBe(1);
    expect(report.automaticRetryCourseCount).toBe(0);
    expect(report.currentHumanReviewCourseCount).toBe(1);
  });

  it("counts persisted and delivered human review as the customer endpoint", () => {
    const incident = {
      id: "incident-human-review",
      cycle: 1,
      status: "NEEDS_HUMAN",
      attemptLedger: exhaustedLedger(),
      humanReviewReason: "AUTOMATION_STALLED",
      firstAffectedSearchId: "search-1",
      firstSeenAt: new Date("2026-08-10T14:02:00.000Z"),
      lastSeenAt: new Date("2026-08-10T14:29:00.000Z"),
      escalationDeadlineAt: new Date("2026-08-10T14:30:00.000Z"),
      escalatedAt: new Date("2026-08-10T14:29:00.000Z")
    };
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: { monitoringStatus: null, supportIncident: incident }
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
          delivery(
            [
              {
                courseId: "course-1",
                courseName: "Human review",
                outcome: "FETCH_FAILED",
                customerStatus: "NEEDS_HUMAN_REVIEW"
              }
            ],
            30,
            "MONITORING_STATUS_UPDATE"
          )
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.currentHumanReviewCourseCount).toBe(1);
    expect(report.currentEndpointStateComplete).toBe(true);
    expect(report.currentEndpointStateSeconds).toBe(1740);
    expect(report.currentEndpointComplete).toBe(true);
    expect(report.currentEndpointSeconds).toBe(1800);
    expect(report.metThirtyMinuteEndpointTarget).toBe(true);
    expect(report.endpointStuck).toBe(false);
  });

  it("does not call a persisted human-review state customer-complete before delivery", () => {
    const incident = {
      id: "incident-human-review-undelivered",
      cycle: 1,
      status: "NEEDS_HUMAN",
      attemptLedger: exhaustedLedger(),
      humanReviewReason: "AUTOMATION_STALLED",
      firstAffectedSearchId: "search-1",
      firstSeenAt: new Date("2026-08-10T14:02:00.000Z"),
      lastSeenAt: new Date("2026-08-10T14:29:00.000Z"),
      escalatedAt: new Date("2026-08-10T14:29:00.000Z")
    };
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: { monitoringStatus: null, supportIncident: incident }
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
              courseName: "Still retrying in the last email",
              outcome: "FETCH_FAILED",
              customerStatus: "RETRYING_AUTOMATICALLY"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.currentHumanReviewCourseCount).toBe(1);
    expect(report.currentEndpointStateComplete).toBe(true);
    expect(report.currentEndpointComplete).toBe(false);
    expect(report.metThirtyMinuteEndpointTarget).toBe(false);
    expect(report.endpointStuck).toBe(true);
  });

  it("does not reuse a historical technical final for a new alert", () => {
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "FINAL_TECHNICAL",
                stateChangedAt: new Date("2026-08-01T14:00:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Stale technical final",
              outcome: "BLOCKED_AUTH",
              customerStatus: "FINAL_DIRECT_ACTION"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.currentFactualFinalityCourseCount).toBe(0);
    expect(report.currentCheckingCourseCount).toBe(1);
    expect(report.currentEndpointStateComplete).toBe(false);
    expect(report.currentEndpointComplete).toBe(false);
    expect(report.metThirtyMinuteEndpointTarget).toBe(false);
    expect(report.endpointStuck).toBe(true);
  });

  it("does not substitute a delivered monitored snapshot for current proof", () => {
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: { monitoringStatus: null, supportIncident: null }
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Delivered without durable proof",
              outcome: "NO_MATCH",
              customerStatus: "MONITORED"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.effectiveMonitoringCourseCount).toBe(1);
    expect(report.currentEffectiveMonitoringCourseCount).toBe(0);
    expect(report.currentCheckingCourseCount).toBe(1);
    expect(report.currentEndpointStateComplete).toBe(false);
    expect(report.currentEndpointComplete).toBe(false);
    expect(report.endpointStuck).toBe(true);
  });

  it("does not count a generic suppressed row as customer delivery", () => {
    const suppressedDelivery = {
      ...delivery([
        {
          courseId: "course-1",
          courseName: "Suppressed dry run",
          outcome: "NO_MATCH",
          customerStatus: "MONITORED"
        }
      ]),
      status: "SUPPRESSED"
    };
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "HEALTHY",
                stateChangedAt: new Date("2026-08-10T14:02:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-10T14:02:00.000Z")
          }
        ],
        emailDeliveries: [suppressedDelivery]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.reportDeliveryComplete).toBe(false);
    expect(report.setupDeliveryStatus).toBe("SUPPRESSED");
    expect(report.currentEffectiveMonitoringCourseCount).toBe(1);
    expect(report.currentEndpointStateComplete).toBe(true);
    expect(report.deliveredCurrentCustomerStatusCounts.CHECKING).toBe(1);
    expect(report.currentEndpointComplete).toBe(false);
    expect(report.metThirtyMinuteEndpointTarget).toBe(false);
    expect(report.endpointStuck).toBe(true);
  });

  it("isolates endpoint evidence to the current alert generation", () => {
    const priorSetup = {
      ...delivery([
        {
          courseId: "course-1",
          courseName: "Prior generation",
          outcome: "NO_MATCH",
          customerStatus: "MONITORED"
        }
      ]),
      alertGeneration: 1
    };
    const currentPendingSetup = {
      ...delivery(
        [
          {
            courseId: "course-1",
            courseName: "Current generation pending",
            outcome: "CHECK_PENDING",
            customerStatus: "CHECKING"
          }
        ],
        20
      ),
      alertGeneration: 2,
      status: "PENDING",
      sentAt: null
    };
    const report = buildAlertFinalityReport(
      search({
        alertGeneration: 2,
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "HEALTHY",
                stateChangedAt: new Date("2026-08-10T14:05:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-10T14:05:00.000Z")
          }
        ],
        emailDeliveries: [priorSetup, currentPendingSetup]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.reportDeliveryComplete).toBe(false);
    expect(report.setupDeliveryStatus).toBe("PENDING");
    expect(report.currentEffectiveMonitoringCourseCount).toBe(0);
    expect(report.currentCheckingCourseCount).toBe(1);
    expect(report.currentEndpointStateComplete).toBe(false);
    expect(report.currentEndpointComplete).toBe(false);
    expect(report.metThirtyMinuteEndpointTarget).toBe(false);
    expect(report.userTimingEligible).toBe(false);
    expect(report.timingOrigin).toBe("FIRST_CURRENT_GENERATION_CHECK");
    expect(report.endpointStuck).toBe(false);
  });

  it("counts a status snapshot delivered inside a simultaneous match email", () => {
    const matchDelivery = {
      alertGeneration: 0,
      createdAt: new Date("2026-08-10T14:25:00.000Z"),
      kind: "MATCH",
      status: "SENT",
      sentAt: new Date("2026-08-10T14:25:00.000Z"),
      payload: {
        checkedAt: "2026-08-10T14:20:00.000Z",
        satisfiesStatusReport: true,
        matchReport: {
          matches: [{ courseId: "course-1" }]
        },
        statusSnapshot: [
          {
            courseId: "course-1",
            customerStatus: "MONITORED"
          }
        ]
      }
    };
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "HEALTHY",
                stateChangedAt: new Date("2026-08-10T14:20:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "MATCH_FOUND",
            observedAt: new Date("2026-08-10T14:20:00.000Z")
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Retrying at setup",
              outcome: "FETCH_FAILED",
              customerStatus: "RETRYING_AUTOMATICALLY"
            }
          ]),
          matchDelivery
        ]
      }),
      new Date("2026-08-10T14:26:00.000Z")
    );

    expect(report.currentEffectiveMonitoringCourseCount).toBe(1);
    expect(report.currentEndpointStateComplete).toBe(true);
    expect(report.currentEndpointComplete).toBe(true);
    expect(report.currentEndpointSeconds).toBe(1500);
    expect(report.metThirtyMinuteEndpointTarget).toBe(true);
    expect(report.latestStatusDeliveryKind).toBe("MATCH");
  });

  it("does not treat hidden snapshot rows as customer-visible status updates", () => {
    const statusDelivery = {
      ...delivery(
        [
          {
            courseId: "course-1",
            courseName: "Visible final",
            outcome: "MANUAL_DIRECT",
            customerStatus: "FINAL_DIRECT_ACTION"
          }
        ],
        25,
        "MONITORING_STATUS_UPDATE"
      ),
      payload: {
        checkedAt: "2026-08-10T14:24:00.000Z",
        statusReport: {
          courses: [
            {
              courseId: "course-1",
              courseName: "Visible final",
              outcome: "MANUAL_DIRECT"
            }
          ]
        },
        statusSnapshot: [
          {
            courseId: "course-1",
            customerStatus: "FINAL_DIRECT_ACTION"
          },
          {
            courseId: "course-2",
            customerStatus: "MONITORED"
          }
        ]
      }
    };
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "FINAL_MANUAL",
                stateChangedAt: new Date("2026-08-10T14:24:00.000Z")
              },
              supportIncident: null
            }
          },
          {
            courseId: "course-2",
            course: {
              monitoringStatus: {
                state: "HEALTHY",
                stateChangedAt: new Date("2026-08-10T14:24:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "MANUAL_DIRECT",
            observedAt: new Date("2026-08-10T14:24:00.000Z")
          },
          {
            courseId: "course-2",
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-10T14:24:00.000Z")
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Retrying one",
              outcome: "FETCH_FAILED",
              customerStatus: "RETRYING_AUTOMATICALLY"
            },
            {
              courseId: "course-2",
              courseName: "Retrying two",
              outcome: "FETCH_FAILED",
              customerStatus: "RETRYING_AUTOMATICALLY"
            }
          ]),
          statusDelivery
        ]
      }),
      new Date("2026-08-10T14:26:00.000Z")
    );

    expect(report.currentEndpointStateComplete).toBe(true);
    expect(
      report.deliveredCurrentCustomerStatusCounts.FINAL_DIRECT_ACTION
    ).toBe(1);
    expect(report.deliveredCurrentCustomerStatusCounts.MONITORED).toBe(0);
    expect(report.currentEndpointComplete).toBe(false);
    expect(report.metThirtyMinuteEndpointTarget).toBe(false);
  });

  it("uses the newest-created delivery when sent timestamps tie", () => {
    const newerFinal = {
      ...delivery(
        [
          {
            courseId: "course-1",
            courseName: "Final status",
            outcome: "MANUAL_DIRECT",
            customerStatus: "FINAL_DIRECT_ACTION"
          }
        ],
        25,
        "MONITORING_STATUS_UPDATE"
      ),
      createdAt: new Date("2026-08-10T14:25:00.000Z")
    };
    const olderRetry = {
      ...delivery(
        [
          {
            courseId: "course-1",
            courseName: "Earlier retry",
            outcome: "FETCH_FAILED",
            customerStatus: "RETRYING_AUTOMATICALLY"
          }
        ],
        25,
        "MONITORING_STATUS_UPDATE"
      ),
      createdAt: new Date("2026-08-10T14:24:00.000Z")
    };
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "FINAL_MANUAL",
                stateChangedAt: new Date("2026-08-10T14:20:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "MANUAL_DIRECT",
            observedAt: new Date("2026-08-10T14:20:00.000Z")
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Setup retry",
              outcome: "FETCH_FAILED",
              customerStatus: "RETRYING_AUTOMATICALLY"
            }
          ]),
          newerFinal,
          olderRetry
        ]
      }),
      new Date("2026-08-10T14:26:00.000Z")
    );

    expect(
      report.deliveredCurrentCustomerStatusCounts.FINAL_DIRECT_ACTION
    ).toBe(1);
    expect(report.currentEndpointComplete).toBe(true);
    expect(report.currentEndpointSeconds).toBe(1500);
  });

  it("preserves durable identity finality across alerts", () => {
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "FINAL_IDENTITY",
                stateChangedAt: new Date("2026-08-01T14:00:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Not a public course",
              outcome: "IDENTITY_FINAL",
              customerStatus: "FINAL_DIRECT_ACTION"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:06:00.000Z")
    );

    expect(report.currentFactualFinalityCourseCount).toBe(1);
    expect(report.currentEndpointStateComplete).toBe(true);
    expect(report.currentEndpointComplete).toBe(true);
    expect(report.currentEndpointSeconds).toBe(300);
  });

  it("does not reuse a monitored setup snapshot after a current-cycle failure", () => {
    const incident = {
      id: "incident-current-failure",
      cycle: 1,
      status: "AUTO_INVESTIGATING",
      firstAffectedSearchId: "search-1",
      firstSeenAt: new Date("2026-08-10T14:12:00.000Z"),
      lastSeenAt: new Date("2026-08-10T14:12:00.000Z"),
      escalationDeadlineAt: new Date("2026-08-10T14:40:00.000Z")
    };
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: { monitoringStatus: null, supportIncident: incident }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "FETCH_FAILED",
            observedAt: new Date("2026-08-10T14:12:00.000Z")
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Initially monitored",
              outcome: "NO_MATCH",
              customerStatus: "MONITORED"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.effectiveMonitoringCourseCount).toBe(1);
    expect(report.deliveredCurrentCustomerStatusCounts.MONITORED).toBe(1);
    expect(report.currentEffectiveMonitoringCourseCount).toBe(0);
    expect(report.currentAutomaticRetryCourseCount).toBe(1);
    expect(report.currentEndpointComplete).toBe(false);
    expect(report.endpointStuck).toBe(true);
  });

  it("keeps an escalated current incident in human review during automatic revalidation", () => {
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "AUTO_INVESTIGATING",
                stateChangedAt: new Date("2026-08-10T14:20:00.000Z")
              },
              supportIncident: {
                id: "incident-revalidating",
                cycle: 2,
                status: "AUTO_INVESTIGATING",
                attemptLedger: revalidatingLedger(),
                firstAffectedSearchId: "search-1",
                firstSeenAt: new Date("2026-08-10T14:10:00.000Z"),
                lastSeenAt: new Date("2026-08-10T14:25:00.000Z"),
                escalatedAt: new Date("2026-08-10T14:29:00.000Z"),
                resolvedAt: null
              }
            }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "FETCH_FAILED",
            observedAt: new Date("2026-08-10T14:25:00.000Z")
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Revalidating",
              outcome: "FETCH_FAILED",
              customerStatus: "RETRYING_AUTOMATICALLY"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.currentHumanReviewCourseCount).toBe(1);
    expect(report.currentAutomaticRetryCourseCount).toBe(0);
    expect(report.currentEndpointStateSeconds).toBe(1740);
  });

  it("keeps a reused monitored endpoint complete across unchanged rechecks", () => {
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "HEALTHY",
                stateChangedAt: new Date("2026-08-01T14:02:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-10T14:02:00.000Z")
          },
          {
            courseId: "course-1",
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-10T14:15:00.000Z")
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Monitored",
              outcome: "NO_MATCH",
              customerStatus: "MONITORED"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.currentEffectiveMonitoringCourseCount).toBe(1);
    expect(report.currentEndpointStateSeconds).toBe(120);
    expect(report.currentEndpointComplete).toBe(true);
    expect(report.currentEndpointSeconds).toBe(300);
    expect(report.metThirtyMinuteEndpointTarget).toBe(true);
    expect(report.endpointStuck).toBe(false);
  });

  it("requires a new delivery after a monitored run is interrupted", () => {
    const report = buildAlertFinalityReport(
      search({
        preferences: [
          {
            courseId: "course-1",
            course: {
              monitoringStatus: {
                state: "HEALTHY",
                stateChangedAt: new Date("2026-08-01T14:02:00.000Z")
              },
              supportIncident: null
            }
          }
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-10T14:02:00.000Z")
          },
          {
            courseId: "course-1",
            outcome: "FETCH_FAILED",
            observedAt: new Date("2026-08-10T14:10:00.000Z")
          },
          {
            courseId: "course-1",
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-10T14:15:00.000Z")
          }
        ],
        emailDeliveries: [
          delivery([
            {
              courseId: "course-1",
              courseName: "Initially monitored",
              outcome: "NO_MATCH",
              customerStatus: "MONITORED"
            }
          ])
        ]
      }),
      new Date("2026-08-10T14:31:00.000Z")
    );

    expect(report.currentEffectiveMonitoringCourseCount).toBe(1);
    expect(report.currentEndpointStateSeconds).toBe(900);
    expect(report.currentEndpointComplete).toBe(false);
    expect(report.endpointStuck).toBe(true);
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

    expect(
      buildAlertFinalityReport(input).currentIncidentCycleCourseCount
    ).toBe(1);
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
          delivery(
            [
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
            ],
            4
          )
        ]
      }),
      search({
        id: "search-slow",
        emailDeliveries: [
          delivery(
            [
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
            ],
            8
          )
        ]
      })
    ]);

    expect(summary.deliverySeconds).toEqual({
      p50: 240,
      p95: 480,
      maximum: 480
    });
    expect(summary.tenMinuteReportSuccessCount).toBe(2);
  });
});
