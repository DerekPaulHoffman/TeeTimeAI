import { describe, expect, it } from "vitest";

import { createParkedCourseCampaignAudit } from "@/lib/automation/course-support-campaign";

import {
  buildOperatorCourseSupportCampaignSummary,
  loadOperatorCourseSupportCampaign,
  summarizeFutureAutomaticResolution,
  summarizeRepeatProviderImplementations,
  summarizeRollingHumanReview
} from "./course-support-campaign";

const capturedAt = new Date("2026-08-20T12:00:00.000Z");
type CampaignFixture = Parameters<
  typeof buildOperatorCourseSupportCampaignSummary
>[0]["campaign"];
type ImplementationBatchFixture = Parameters<
  typeof summarizeRepeatProviderImplementations
>[0]["batches"][number];
type FutureIncidentFixture = Parameters<
  typeof summarizeFutureAutomaticResolution
>[0]["incidents"][number];

describe("operator course-support campaign aggregation", () => {
  it("passes a rolling human-review rate at the five-percent boundary", () => {
    const events = [
      endpointEvent({
        id: "human-1",
        incidentId: "incident-human",
        eventType: "HUMAN_REVIEW_REQUESTED",
        audit: { cycle: 2 }
      }),
      ...Array.from({ length: 19 }, (_, index) =>
        endpointEvent({
          id: `auto-${index}`,
          incidentId: `incident-auto-${index}`,
          eventType: "RECOVERED",
          audit: { automatedFinal: true, cycle: 1 }
        })
      )
    ];

    expect(summarizeRollingHumanReview(events)).toEqual({
      windowDays: 30,
      humanReviewCount: 1,
      endpointCount: 20,
      ratePercent: 5,
      targetPercent: 5,
      ambiguousEndpointCount: 0,
      status: "PASS"
    });
  });

  it("fails a rolling human-review rate over five percent", () => {
    const events = [
      endpointEvent({
        id: "human-1",
        incidentId: "incident-human-1",
        eventType: "HUMAN_REVIEW_REQUESTED",
        audit: { cycle: 2 }
      }),
      endpointEvent({
        id: "human-2",
        incidentId: "incident-human-2",
        eventType: "HUMAN_REVIEW_REQUESTED",
        audit: { cycle: 3 }
      }),
      ...Array.from({ length: 18 }, (_, index) =>
        endpointEvent({
          id: `auto-${index}`,
          incidentId: `incident-auto-${index}`,
          eventType: index === 0 ? "STATE_CHANGED" : "RECOVERED",
          audit: { automatedFinal: true, cycle: 1 }
        })
      )
    ];

    expect(summarizeRollingHumanReview(events)).toMatchObject({
      humanReviewCount: 2,
      endpointCount: 20,
      ratePercent: 10,
      status: "FAIL"
    });
  });

  it("returns no data when there are no valid endpoint events", () => {
    expect(
      summarizeRollingHumanReview([
        endpointEvent({
          id: "ordinary-check",
          incidentId: "incident-1",
          eventType: "CHECK_FAILED",
          audit: { cycle: 1 }
        }),
        endpointEvent({
          id: "detached-event",
          incidentId: null,
          eventType: "RECOVERED"
        })
      ])
    ).toEqual({
      windowDays: 30,
      humanReviewCount: 0,
      endpointCount: 0,
      ratePercent: null,
      targetPercent: 5,
      ambiguousEndpointCount: 0,
      status: "NO_DATA"
    });
  });

  it("counts explicit nonautomatic or operator finals as human review", () => {
    const result = summarizeRollingHumanReview([
      endpointEvent({
        id: "explicit-human",
        incidentId: "incident-1",
        eventType: "STATE_CHANGED",
        audit: { automatedFinal: false, cycle: 1 }
      }),
      endpointEvent({
        id: "operator-human",
        incidentId: "incident-2",
        eventType: "STATE_CHANGED",
        audit: { automatedFinal: true, cycle: 1 },
        source: "OPERATOR_CLI"
      })
    ]);

    expect(result).toMatchObject({
      humanReviewCount: 2,
      endpointCount: 2,
      ratePercent: 100,
      status: "FAIL"
    });
  });

  it("marks terminal endpoints without explicit safe provenance unknown", () => {
    const result = summarizeRollingHumanReview([
      endpointEvent({
        id: "legacy-state-final",
        incidentId: "incident-1",
        eventType: "STATE_CHANGED",
        audit: { automatedFinal: true, cycle: 1 },
        runtimeVersion: null
      })
    ]);

    expect(result).toMatchObject({
      endpointCount: 1,
      ratePercent: null,
      ambiguousEndpointCount: 1,
      status: "UNKNOWN"
    });
  });

  it("marks terminal endpoints with mismatched release provenance unknown", () => {
    const result = summarizeRollingHumanReview([
      endpointEvent({
        id: "mismatched-release-final",
        incidentId: "incident-1",
        eventType: "RECOVERED",
        audit: { automatedFinal: true, cycle: 1 },
        deploymentSha: "b".repeat(40),
        runtimeVersion: "a".repeat(40)
      })
    ]);

    expect(result).toMatchObject({
      endpointCount: 1,
      ratePercent: null,
      ambiguousEndpointCount: 1,
      status: "UNKNOWN"
    });
  });

  it("ignores an unscoped nonterminal state change before an automatic endpoint", () => {
    const result = summarizeRollingHumanReview([
      endpointEvent({
        id: "ordinary-degradation",
        incidentId: "incident-1",
        eventType: "STATE_CHANGED",
        toState: "AUTO_INVESTIGATING",
        audit: null,
        runtimeVersion: null
      }),
      endpointEvent({
        id: "automatic-final",
        incidentId: "incident-1",
        eventType: "RECOVERED",
        audit: { automatedFinal: true, cycle: 2 }
      })
    ]);

    expect(result).toEqual({
      windowDays: 30,
      humanReviewCount: 0,
      endpointCount: 1,
      ratePercent: 0,
      targetPercent: 5,
      ambiguousEndpointCount: 0,
      status: "PASS"
    });
  });

  it("associates pre-window human evidence with an in-window endpoint cycle", () => {
    const result = summarizeRollingHumanReview([
      endpointEvent({
        id: "earlier-human",
        incidentId: "incident-1",
        eventType: "HUMAN_REVIEW_REQUESTED",
        audit: { cycle: 3 },
        countsAsEndpoint: false
      }),
      endpointEvent({
        id: "in-window-final",
        incidentId: "incident-1",
        eventType: "STATE_CHANGED",
        audit: { automatedFinal: true, cycle: 3 }
      })
    ]);

    expect(result).toMatchObject({
      humanReviewCount: 1,
      endpointCount: 1,
      ratePercent: 100,
      status: "FAIL"
    });
  });

  it("does not credit automation when pre-window human evidence lacks cycle scope", () => {
    const result = summarizeRollingHumanReview([
      endpointEvent({
        id: "legacy-human",
        incidentId: "incident-1",
        eventType: "HUMAN_REVIEW_REQUESTED",
        countsAsEndpoint: false
      }),
      endpointEvent({
        id: "in-window-final",
        incidentId: "incident-1",
        eventType: "STATE_CHANGED",
        audit: { automatedFinal: true, cycle: 3 }
      })
    ]);

    expect(result).toMatchObject({
      endpointCount: 1,
      ratePercent: null,
      ambiguousEndpointCount: 1,
      status: "UNKNOWN"
    });
  });

  it("deduplicates repeated human-review events for the same incident cycle", () => {
    const result = summarizeRollingHumanReview([
      endpointEvent({
        id: "human-1",
        incidentId: "incident-1",
        eventType: "HUMAN_REVIEW_REQUESTED",
        audit: { cycle: 4 }
      }),
      endpointEvent({
        id: "human-duplicate",
        incidentId: "incident-1",
        eventType: "HUMAN_REVIEW_REQUESTED",
        audit: { cycle: 4 }
      })
    ]);

    expect(result).toMatchObject({
      humanReviewCount: 1,
      endpointCount: 1,
      ratePercent: 100,
      ambiguousEndpointCount: 0,
      status: "FAIL"
    });
  });

  it("coarsens legacy endpoints per incident and reports their rate as unknown", () => {
    const result = summarizeRollingHumanReview([
      endpointEvent({
        id: "human-with-cycle",
        incidentId: "incident-1",
        eventType: "HUMAN_REVIEW_REQUESTED",
        audit: { cycle: 4 }
      }),
      endpointEvent({
        id: "legacy-auto",
        incidentId: "incident-1",
        eventType: "RECOVERED"
      }),
      endpointEvent({
        id: "legacy-auto-duplicate",
        incidentId: "incident-1",
        eventType: "RECOVERED"
      })
    ]);

    expect(result).toEqual({
      windowDays: 30,
      humanReviewCount: 1,
      endpointCount: 1,
      ratePercent: null,
      targetPercent: 5,
      ambiguousEndpointCount: 1,
      status: "UNKNOWN"
    });
  });

  it("passes future unfamiliar courses with exact automatic terminal evidence within 24 hours", () => {
    const result = summarizeFutureAutomaticResolution({
      campaignCapturedAt: capturedAt,
      campaignIncidentCycles: [],
      incidents: [futureIncident()],
      now: new Date("2026-08-21T12:00:00.000Z")
    });

    expect(result).toEqual({
      windowDays: 30,
      eligibleCount: 1,
      automaticCount: 1,
      nonAutomaticCount: 0,
      pendingCount: 0,
      unknownCount: 0,
      ratePercent: 100,
      targetPercent: 95,
      status: "PASS"
    });
  });

  it("fails future unfamiliar courses resolved after the 24-hour deadline", () => {
    const result = summarizeFutureAutomaticResolution({
      campaignCapturedAt: capturedAt,
      campaignIncidentCycles: [],
      incidents: [
        futureIncident({
          resolvedAt: new Date("2026-08-21T14:01:00.000Z"),
          terminalEvents: [
            futureTerminalEvent({ occurredAt: new Date("2026-08-21T14:01:00.000Z") })
          ]
        })
      ],
      now: new Date("2026-08-21T15:00:00.000Z")
    });

    expect(result).toMatchObject({
      eligibleCount: 1,
      automaticCount: 0,
      nonAutomaticCount: 1,
      ratePercent: 0,
      status: "FAIL"
    });
  });

  it("counts human decisions and operator-provenance finals as nonautomatic", () => {
    const result = summarizeFutureAutomaticResolution({
      campaignCapturedAt: capturedAt,
      campaignIncidentCycles: [],
      incidents: [
        futureIncident({
          id: "future-human",
          courseId: "future-human-course",
          decisionAt: new Date("2026-08-20T15:00:00.000Z"),
          decisionActorId: "private-operator",
          resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION"
        }),
        futureIncident({
          id: "future-operator",
          courseId: "future-operator-course",
          terminalEvents: [futureTerminalEvent({ source: "OPERATOR_DASHBOARD" })]
        })
      ],
      now: new Date("2026-08-21T12:00:00.000Z")
    });

    expect(result).toMatchObject({
      eligibleCount: 2,
      automaticCount: 0,
      nonAutomaticCount: 2,
      unknownCount: 0,
      ratePercent: 0,
      status: "FAIL"
    });
  });

  it("reports future acceptance unknown when terminal provenance is missing", () => {
    const result = summarizeFutureAutomaticResolution({
      campaignCapturedAt: capturedAt,
      campaignIncidentCycles: [],
      incidents: [
        futureIncident({
          terminalEvents: [
            futureTerminalEvent({ audit: { cycle: 1 } })
          ]
        })
      ],
      now: new Date("2026-08-21T12:00:00.000Z")
    });

    expect(result).toMatchObject({
      eligibleCount: 1,
      automaticCount: 0,
      unknownCount: 1,
      ratePercent: null,
      status: "UNKNOWN"
    });
  });

  it("does not count a nonterminal state change as a future automatic endpoint", () => {
    const result = summarizeFutureAutomaticResolution({
      campaignCapturedAt: capturedAt,
      campaignIncidentCycles: [],
      incidents: [
        futureIncident({
          status: "AUTO_INVESTIGATING",
          resolution: null,
          resolvedAt: null,
          terminalEvents: [
            futureTerminalEvent({
              eventType: "STATE_CHANGED",
              toState: "AUTO_INVESTIGATING"
            })
          ]
        })
      ],
      now: new Date("2026-08-20T16:00:00.000Z")
    });

    expect(result).toMatchObject({
      eligibleCount: 1,
      automaticCount: 0,
      pendingCount: 1,
      status: "IN_PROGRESS"
    });
  });

  it.each([
    { deploymentSha: null, runtimeVersion: "a".repeat(40) },
    { deploymentSha: "a".repeat(40), runtimeVersion: null },
    { deploymentSha: "b".repeat(40), runtimeVersion: "a".repeat(40) }
  ])(
    "reports future acceptance unknown for incomplete or mismatched runtime proof %#",
    ({ deploymentSha, runtimeVersion }) => {
    const result = summarizeFutureAutomaticResolution({
      campaignCapturedAt: capturedAt,
      campaignIncidentCycles: [],
      incidents: [
        futureIncident({
          terminalEvents: [
            futureTerminalEvent({ deploymentSha, runtimeVersion })
          ]
        })
      ],
      now: new Date("2026-08-21T12:00:00.000Z")
    });

    expect(result).toMatchObject({ unknownCount: 1, ratePercent: null, status: "UNKNOWN" });
    }
  );

  it("keeps a completed future cycle after the durable incident row reopens", () => {
    const result = summarizeFutureAutomaticResolution({
      campaignCapturedAt: capturedAt,
      campaignIncidentCycles: [],
      incidents: [
        futureIncident({
          cycle: 2,
          status: "AUTO_INVESTIGATING",
          resolution: null,
          confirmedAt: new Date("2026-08-21T10:00:00.000Z"),
          lastSeenAt: new Date("2026-08-21T10:00:00.000Z"),
          resolvedAt: null,
          terminalEvents: [futureTerminalEvent()]
        })
      ],
      now: new Date("2026-08-21T12:00:00.000Z")
    });

    expect(result).toMatchObject({
      eligibleCount: 2,
      automaticCount: 1,
      pendingCount: 1,
      status: "IN_PROGRESS"
    });
  });

  it("keeps a human-final future cycle after the durable incident row reopens", () => {
    const result = summarizeFutureAutomaticResolution({
      campaignCapturedAt: capturedAt,
      campaignIncidentCycles: [],
      incidents: [
        futureIncident({
          cycle: 2,
          status: "AUTO_INVESTIGATING",
          resolution: null,
          confirmedAt: new Date("2026-08-21T10:00:00.000Z"),
          lastSeenAt: new Date("2026-08-21T10:00:00.000Z"),
          resolvedAt: null,
          terminalEvents: [
            futureTerminalEvent({
              eventType: "HUMAN_DECISION",
              source: "OPERATOR_DASHBOARD",
              operatorActorId: "private-operator",
              runtimeVersion: null,
              deploymentSha: null,
              audit: {
                action: "set_course_outcome",
                automatedFinal: false,
                confirmedAt: "2026-08-20T14:00:00.000Z",
                cycle: 1
              }
            })
          ]
        })
      ],
      now: new Date("2026-08-21T12:00:00.000Z")
    });

    expect(result).toMatchObject({
      eligibleCount: 2,
      automaticCount: 0,
      nonAutomaticCount: 1,
      pendingCount: 1,
      unknownCount: 0,
      status: "FAIL"
    });
  });

  it("never lets another incident with the same cycle and timestamp satisfy an unresolved course", () => {
    const result = summarizeFutureAutomaticResolution({
      campaignCapturedAt: capturedAt,
      campaignIncidentCycles: [],
      incidents: [
        futureIncident({
          id: "unresolved-incident",
          courseId: "unresolved-course",
          status: "AUTO_INVESTIGATING",
          resolution: null,
          resolvedAt: null,
          terminalEvents: []
        }),
        futureIncident({ id: "resolved-incident", courseId: "resolved-course" })
      ],
      now: new Date("2026-08-21T15:00:00.000Z")
    });

    expect(result).toMatchObject({
      eligibleCount: 2,
      automaticCount: 1,
      nonAutomaticCount: 1,
      pendingCount: 0,
      status: "FAIL"
    });
  });

  it("returns no data when no future unfamiliar course is eligible", () => {
    expect(
      summarizeFutureAutomaticResolution({
        campaignCapturedAt: capturedAt,
        campaignIncidentCycles: [],
        incidents: [],
        now: new Date("2026-08-21T12:00:00.000Z")
      })
    ).toMatchObject({
      eligibleCount: 0,
      ratePercent: null,
      status: "NO_DATA"
    });
  });

  it("excludes a never-confirmed transient failure that recovered automatically", () => {
    expect(
      summarizeFutureAutomaticResolution({
        campaignCapturedAt: capturedAt,
        campaignIncidentCycles: [],
        incidents: [
          futureIncident({
            confirmedAt: null,
            terminalEvents: [
              futureTerminalEvent({
                audit: { automatedFinal: true, confirmedAt: null, cycle: 1 }
              })
            ]
          })
        ],
        now: new Date("2026-08-21T12:00:00.000Z")
      })
    ).toMatchObject({ eligibleCount: 0, status: "NO_DATA" });
  });

  it("reports a human endpoint with missing durable confirmation as unknown", () => {
    expect(
      summarizeFutureAutomaticResolution({
        campaignCapturedAt: capturedAt,
        campaignIncidentCycles: [],
        incidents: [
          futureIncident({
            status: "NEEDS_HUMAN",
            resolution: null,
            confirmedAt: null,
            resolvedAt: null,
            terminalEvents: []
          })
        ],
        now: new Date("2026-08-21T12:00:00.000Z")
      })
    ).toMatchObject({ eligibleCount: 1, unknownCount: 1, status: "UNKNOWN" });
  });

  it("excludes the campaign admission cycle derived from the captured parked cycle", () => {
    expect(
      summarizeFutureAutomaticResolution({
        campaignCapturedAt: capturedAt,
        campaignIncidentCycles: [{ incidentId: "future-incident", cycle: 1 }],
        incidents: [
          futureIncident({
            cycle: 2,
            terminalEvents: [
              futureTerminalEvent({
                audit: {
                  automatedFinal: true,
                  confirmedAt: "2026-08-20T14:00:00.000Z",
                  cycle: 2
                }
              })
            ]
          })
        ],
        now: new Date("2026-08-21T12:00:00.000Z")
      })
    ).toMatchObject({ eligibleCount: 0, status: "NO_DATA" });
  });

  it("includes a later material-change cycle on a baseline course", () => {
    expect(
      summarizeFutureAutomaticResolution({
        campaignCapturedAt: capturedAt,
        campaignIncidentCycles: [{ incidentId: "future-incident", cycle: 1 }],
        incidents: [
          futureIncident({
            cycle: 3,
            confirmedAt: new Date("2026-08-21T10:00:00.000Z"),
            lastSeenAt: new Date("2026-08-21T11:00:00.000Z"),
            resolvedAt: new Date("2026-08-21T11:00:00.000Z"),
            terminalEvents: [
              futureTerminalEvent({
                occurredAt: new Date("2026-08-21T11:00:00.000Z"),
                audit: {
                  automatedFinal: true,
                  confirmedAt: "2026-08-21T10:00:00.000Z",
                  cycle: 3
                }
              })
            ]
          })
        ],
        now: new Date("2026-08-21T12:00:00.000Z")
      })
    ).toMatchObject({
      eligibleCount: 1,
      automaticCount: 1,
      nonAutomaticCount: 0,
      unknownCount: 0,
      ratePercent: 100,
      status: "PASS"
    });
  });

  it("counts each deployed implementation batch once without campaign membership", () => {
    const result = summarizeRepeatProviderImplementations({
      batches: [implementationBatch()]
    });

    expect(result).toEqual({
      repeatImplementationCount: 0,
      implementationBatchCount: 1,
      implementationGroupCount: 1,
      status: "PASS"
    });
  });

  it("fails when a future nonmember provider-fingerprint group is implemented twice", () => {
    const result = summarizeRepeatProviderImplementations({
      batches: [
        implementationBatch(),
        implementationBatch({ releaseSha: "release-sha-2" })
      ]
    });

    expect(result).toEqual({
      repeatImplementationCount: 1,
      implementationBatchCount: 2,
      implementationGroupCount: 1,
      status: "FAIL"
    });
  });

  it("does not combine implementations for different failure fingerprints", () => {
    const result = summarizeRepeatProviderImplementations({
      batches: [
        implementationBatch(),
        implementationBatch({
          failureFingerprint: "second-private-fingerprint",
          releaseSha: "release-sha-2"
        })
      ]
    });

    expect(result).toMatchObject({
      repeatImplementationCount: 0,
      implementationBatchCount: 2,
      implementationGroupCount: 2,
      status: "PASS"
    });
  });

  it("returns unknown for deployed implementation evidence without a runtime path", () => {
    const result = summarizeRepeatProviderImplementations({
      batches: [
        implementationBatch({
          summary: implementationSummary("docs/course-support.md")
        })
      ]
    });

    expect(result).toEqual({
      repeatImplementationCount: 0,
      implementationBatchCount: 0,
      implementationGroupCount: 0,
      status: "UNKNOWN"
    });
  });

  it("ignores undeployed work", () => {
    const result = summarizeRepeatProviderImplementations({
      batches: [implementationBatch({ deployedAt: null })]
    });

    expect(result).toMatchObject({
      repeatImplementationCount: 0,
      implementationBatchCount: 0,
      status: "PASS"
    });
  });

  it("evaluates automatic resolution as in progress, failed, passed, or unknown", () => {
    const rollingHumanReview = summarizeRollingHumanReview([]);
    const repeatImplementations = summarizeRepeatProviderImplementations({
      batches: []
    });

    expect(
      buildOperatorCourseSupportCampaignSummary({
        campaign: campaignInspection(),
        now: new Date("2026-08-20T18:00:00.000Z"),
        repeatImplementations,
        rollingHumanReview
      }).automaticWithin24Hours.status
    ).toBe("IN_PROGRESS");
    expect(
      buildOperatorCourseSupportCampaignSummary({
        campaign: campaignInspection({
          expectedCount: 20,
          totalCount: 20,
          terminalCount: 19,
          pendingCount: 1,
          readyCount: 1,
          monitoredCount: 19,
          terminalWithin24HoursCount: 19,
          automaticWithin24HoursCount: 19
        }),
        now: new Date("2026-08-20T18:00:00.000Z"),
        repeatImplementations,
        rollingHumanReview
      }).automaticWithin24Hours
    ).toMatchObject({ targetPercent: 95, status: "PASS" });
    expect(
      buildOperatorCourseSupportCampaignSummary({
        campaign: campaignInspection({
          expectedCount: 20,
          totalCount: 20,
          terminalCount: 19,
          pendingCount: 1,
          readyCount: 1,
          monitoredCount: 19,
          terminalWithin24HoursCount: 19,
          automaticWithin24HoursCount: 17
        }),
        now: new Date("2026-08-20T18:00:00.000Z"),
        repeatImplementations,
        rollingHumanReview
      }).automaticWithin24Hours.status
    ).toBe("FAIL");
    expect(
      buildOperatorCourseSupportCampaignSummary({
        campaign: campaignInspection({
          status: "COMPLETED",
          terminalCount: 2,
          pendingCount: 0,
          readyCount: 0,
          monitoredCount: 2,
          terminalWithin24HoursCount: 2,
          automaticWithin24HoursCount: 2
        }),
        now: new Date("2026-08-21T13:00:00.000Z"),
        repeatImplementations,
        rollingHumanReview
      }).automaticWithin24Hours.status
    ).toBe("PASS");
    expect(
      buildOperatorCourseSupportCampaignSummary({
        campaign: campaignInspection(),
        now: new Date("2026-08-21T12:00:00.000Z"),
        repeatImplementations,
        rollingHumanReview
      }).automaticWithin24Hours.status
    ).toBe("FAIL");
    expect(
      buildOperatorCourseSupportCampaignSummary({
        campaign: campaignInspection({ pendingCount: 1 }),
        now: new Date("2026-08-20T18:00:00.000Z"),
        repeatImplementations,
        rollingHumanReview
      }).automaticWithin24Hours.status
    ).toBe("UNKNOWN");
  });

  it("does not report campaign progress complete when a later course is globally parked", () => {
    const summary = buildOperatorCourseSupportCampaignSummary({
      campaign: campaignInspection({
        status: "COMPLETED",
        terminalCount: 2,
        pendingCount: 0,
        readyCount: 0,
        monitoredCount: 2,
        terminalWithin24HoursCount: 2,
        automaticWithin24HoursCount: 2,
        remainingGlobalParkedCount: 1
      }),
      now: new Date("2026-08-21T13:00:00.000Z"),
      repeatImplementations: summarizeRepeatProviderImplementations({ batches: [] }),
      rollingHumanReview: summarizeRollingHumanReview([])
    });

    expect(summary.progress).toMatchObject({
      terminalCount: 2,
      totalCount: 2,
      remainingGlobalParkedCount: 1,
      status: "IN_PROGRESS"
    });
  });

  it("returns only aggregate campaign data from the loader", async () => {
    const audit = createParkedCourseCampaignAudit({
      capturedAt,
      expectedCount: 2,
      members: [campaignMember(1), campaignMember(2)]
    });
    const result = await loadOperatorCourseSupportCampaign(
      { now: new Date("2026-08-20T18:00:00.000Z") },
      {
        inspectLatestCampaign: async () =>
          campaignInspection({ membershipDigest: audit.membershipDigest }),
        loadCampaignAudit: async () => audit,
        loadRollingEndpointEvents: async () => [],
        loadFutureUnfamiliarIncidents: async () => [
          futureIncident({
            id: "private-future-incident",
            courseId: "private-future-course"
          })
        ],
        loadImplementationBatches: async () => [
          implementationBatch({
            providerFamilyKey: "private-provider-family",
            failureFingerprint: "private-fingerprint"
          })
        ]
      }
    );

    expect(result).toMatchObject({
      expectedCount: 2,
      currentResults: {
        resultCount: 2,
        accountedCount: 2,
        totalCount: 2,
        bucketInvariantStatus: "PASS",
        status: "PASS"
      },
      futureAutomaticWithin24Hours: {
        eligibleCount: 1,
        automaticCount: 1,
        status: "PASS"
      },
      repeatImplementations: { implementationBatchCount: 1, status: "PASS" }
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      "private-run-id",
      audit.membershipDigest,
      audit.members[0].courseId,
      audit.members[0].incidentId,
      "private-future-course",
      "private-future-incident",
      "private-provider-family",
      "private-fingerprint",
      "src/lib/availability/private-reader.ts",
      "release-sha-1"
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});

function endpointEvent(input: {
  id: string;
  incidentId: string | null;
  eventType: string;
  audit?: unknown;
  countsAsEndpoint?: boolean;
  deploymentSha?: string | null;
  occurredAt?: Date | null;
  operatorActorId?: string | null;
  runtimeVersion?: string | null;
  source?: string | null;
  toState?: string | null;
}) {
  return {
    id: input.id,
    incidentId: input.incidentId,
    eventType: input.eventType,
    toState:
      input.toState === undefined && input.eventType === "STATE_CHANGED"
        ? "FINAL_TECHNICAL"
        : (input.toState ?? null),
    source: input.source === undefined ? "COURSE_SUPPORT_RESPONDER" : input.source,
    operatorActorId: input.operatorActorId ?? null,
    runtimeVersion:
      input.runtimeVersion === undefined &&
      (input.eventType === "RECOVERED" || input.eventType === "STATE_CHANGED")
        ? "a".repeat(40)
        : (input.runtimeVersion ?? null),
    deploymentSha:
      input.deploymentSha === undefined &&
      (input.eventType === "RECOVERED" || input.eventType === "STATE_CHANGED")
        ? "a".repeat(40)
        : (input.deploymentSha ?? null),
    occurredAt:
      input.occurredAt === undefined
        ? new Date("2026-08-20T15:00:00.000Z")
        : input.occurredAt,
    countsAsEndpoint: input.countsAsEndpoint ?? true,
    audit: input.audit ?? null
  };
}

function futureIncident(
  overrides: Partial<FutureIncidentFixture> = {}
): FutureIncidentFixture {
  return {
    id: "future-incident",
    courseId: "future-course",
    cycle: 1,
    status: "RESOLVED",
    resolution: "MONITORING_RESTORED",
    confirmedAt: new Date("2026-08-20T14:00:00.000Z"),
    lastSeenAt: new Date("2026-08-20T15:00:00.000Z"),
    resolvedAt: new Date("2026-08-20T15:00:00.000Z"),
    decisionAt: null,
    decisionActorId: null,
    terminalEvents: [futureTerminalEvent()],
    ...overrides
  };
}

function futureTerminalEvent(
  overrides: Partial<FutureIncidentFixture["terminalEvents"][number]> = {}
): FutureIncidentFixture["terminalEvents"][number] {
  return {
    eventType: "RECOVERED",
    toState: null,
    source: "COURSE_SUPPORT_RESPONDER",
    operatorActorId: null,
    runtimeVersion: "a".repeat(40),
    deploymentSha: "a".repeat(40),
    occurredAt: new Date("2026-08-20T15:00:00.000Z"),
    audit: {
      automatedFinal: true,
      confirmedAt: "2026-08-20T14:00:00.000Z",
      cycle: 1
    },
    ...overrides
  };
}

function campaignMember(index: number) {
  return {
    courseId: `private-course-${index}`,
    incidentId: `private-incident-${index}`,
    cycle: 1,
    revision: 0,
    monitoringRevision: 0,
    monitoringFailureFingerprint: "legacy-private-fingerprint",
    kind: "NEEDS_ADAPTER",
    providerFamilyKey: "private-provider-family",
    failureClass: "SOURCE_MISSING",
    failureFingerprint: "private-fingerprint",
    providerSnapshotFingerprint: "1".repeat(64),
    attemptLedgerFingerprint: "2".repeat(64),
    playbookConclusion: "CONTINUE",
    latestProbeAt: null,
    latestDiscoveryAt: null
  };
}

function campaignInspection(overrides: Partial<CampaignFixture> = {}): CampaignFixture {
  return {
    runId: "private-run-id",
    status: "RUNNING" as const,
    capturedAt: capturedAt.toISOString(),
    expectedCount: 2,
    totalCount: 2,
    terminalCount: 0,
    pendingCount: 2,
    readyCount: 2,
    activeCount: 0,
    monitoredCount: 0,
    bookingNotOpenCount: 0,
    factualLimitationCount: 0,
    technicalLimitationCount: 0,
    sourceUnverifiedCount: 0,
    engineeringBlockerCount: 0,
    currentResultMissingCount: 0,
    humanReviewCount: 0,
    terminalWithin24HoursCount: 0,
    automaticWithin24HoursCount: 0,
    remainingGlobalParkedCount: 2,
    membershipDigest: "0".repeat(64),
    ...overrides
  };
}

function implementationBatch(
  overrides: Partial<ImplementationBatchFixture> = {}
): ImplementationBatchFixture {
  const base = baseImplementationBatch();
  const releaseSha = overrides.releaseSha === undefined ? base.releaseSha : overrides.releaseSha;
  return {
    ...base,
    ...overrides,
    summary:
      overrides.summary ??
      implementationSummary(
        "src/lib/availability/private-reader.ts",
        releaseSha ?? "missing-release-sha"
      )
  };
}

function baseImplementationBatch() {
  return {
    providerFamilyKey: "provider-family",
    failureFingerprint: "failure-fingerprint",
    baseSha: "base-sha",
    releaseSha: "release-sha-1",
    deployedAt: new Date("2026-08-20T14:00:00.000Z"),
    summary: implementationSummary("src/lib/availability/private-reader.ts")
  };
}

function implementationSummary(runtimePath: string, releaseSha = "release-sha-1") {
  return {
    remediation: { requiresImplementationPath: true },
    releaseProvenance: {
      schemaVersion: 1,
      fromSha: "base-sha",
      toSha: releaseSha,
      branch: "feature/private-reader",
      committedPaths: [runtimePath],
      descendantVerified: true
    }
  };
}
