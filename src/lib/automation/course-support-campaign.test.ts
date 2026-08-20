import { describe, expect, it, vi } from "vitest";

import {
  createParkedCourseCampaignAttemptLedgerFingerprint,
  createParkedCourseCampaignAudit,
  createParkedCourseCampaignMembershipDigest,
  inspectActiveParkedCourseCampaign,
  loadParkedCourseCampaignMembers,
  parseParkedCourseCampaignAudit,
  runParkedCourseCampaignCommand,
  summarizeCampaignEvidenceCategories,
  summarizeParkedCourseCampaignProgress,
  type ParkedCourseCampaignMember,
  type ParkedCourseCampaignMemberObservation
} from "./course-support-campaign";

const capturedAt = new Date("2026-08-20T12:00:00.000Z");

function member(
  ordinal: number,
  overrides: Partial<ParkedCourseCampaignMember> = {}
): ParkedCourseCampaignMember {
  return {
    courseId: `course-${ordinal}`,
    incidentId: `incident-${ordinal}`,
    cycle: 3,
    revision: 7,
    monitoringRevision: 11,
    monitoringFailureFingerprint: "SOURCE:MISSING",
    kind: "NEEDS_ADAPTER",
    providerFamilyKey: "SOURCE_MISSING",
    failureClass: "MISSING_SOURCE",
    failureFingerprint: "SOURCE:MISSING",
    providerSnapshotFingerprint: "a".repeat(64),
    attemptLedgerFingerprint: "b".repeat(64),
    playbookConclusion: "UNRESOLVED_EXHAUSTED",
    latestProbeAt: "2026-08-19T12:00:00.000Z",
    latestDiscoveryAt: "2026-08-19T13:00:00.000Z",
    ...overrides
  };
}

function observation(
  ordinal: number,
  overrides: Partial<ParkedCourseCampaignMemberObservation> = {}
): ParkedCourseCampaignMemberObservation {
  return {
    courseId: `course-${ordinal}`,
    incidentId: `incident-${ordinal}`,
    cycle: 4,
    status: "AUTO_INVESTIGATING",
    activeBatchId: null,
    confirmedAt: new Date("2026-08-20T12:01:00.000Z"),
    resolution: null,
    resolvedAt: null,
    decisionAt: null,
    monitoringState: "AUTO_INVESTIGATING",
    monitoringStateChangedAt: new Date("2026-08-20T12:05:00.000Z"),
    latestProbe: null,
    campaignTerminalEvidenceAt: new Date("2026-08-20T12:05:00.000Z"),
    campaignTerminalRuntimeVersion: "release-1",
    campaignTerminalAutomatedFinal: true,
    currentlyParked: false,
    humanReviewCycles: [],
    ...overrides
  };
}

function campaignDependencies(input: {
  members: ParkedCourseCampaignMember[];
  allMembers?: ParkedCourseCampaignMember[];
  globalParkedCount?: number;
  observations?: ParkedCourseCampaignMemberObservation[];
}) {
  const createdRuns: Array<Record<string, unknown>> = [];
  return {
    createdRuns,
    dependencies: {
      loadLatestCampaign: vi.fn().mockResolvedValue(null),
      loadActiveCampaign: vi.fn().mockResolvedValue(null),
      loadParkedMembers: vi.fn().mockResolvedValue(input.members),
      loadAllParkedMembers: vi
        .fn()
        .mockResolvedValue(input.allMembers ?? input.members),
      loadGlobalParkedCount: vi
        .fn()
        .mockResolvedValue(
          input.globalParkedCount ?? (input.allMembers ?? input.members).length
        ),
      loadMemberObservations: vi.fn().mockResolvedValue(input.observations ?? []),
      createCampaign: vi.fn(async (audit) => {
        const run = {
          id: "campaign-run-1",
          status: "RUNNING" as const,
          completedAt: null,
          outcome: null,
          audit
        };
        createdRuns.push(run);
        return run;
      }),
      completeCampaign: vi.fn().mockResolvedValue(true),
      withTransitionLease: vi.fn(async (worker) => ({
        acquired: true as const,
        value: await worker()
      }))
    }
  };
}

describe("parked course campaign", () => {
  it("captures a stale monitoring fingerprint only with matching durable incident proof", async () => {
    const parkedAt = new Date("2026-08-19T12:00:00.000Z");
    const parkedRow = {
      id: "incident-1",
      courseId: "course-1",
      cycle: 3,
      revision: 7,
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger: null,
      humanReviewReason: "AUTOMATION_STALLED",
      status: "NEEDS_HUMAN",
      activeRealSearchCount: 0,
      escalatedAt: parkedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents: [
        {
          incidentId: "incident-1",
          eventType: "HUMAN_REVIEW_REQUESTED",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: parkedAt,
          audit: {
            cycle: 3,
            customerState: "NEEDS_HUMAN_REVIEW",
            parkedUntilMaterialChange: true,
            automationStalled: true
          }
        }
      ],
      course: {
        timeZone: "America/New_York",
        isPublic: true,
        website: null,
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        bookingMethod: "UNKNOWN",
        bookingWindowDaysAhead: null,
        bookingReleaseTimeLocal: null,
        bookingWindowSource: null,
        bookingWindowConfidence: null,
        bookingWindowEvidenceUrl: null,
        automationEligibility: "UNKNOWN",
        automationReason: "NONE",
        monitoringMode: "STANDARD",
        bookingAccessMode: "UNKNOWN",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
        bookingMetadata: null,
        layoutHoleCounts: [],
        layoutHolesVerifiedAt: null,
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 11,
          failureFingerprint: "SOURCE:LEGACY",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null
        },
        probes: [],
        automationDiscoveries: []
      }
    };
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([parkedRow])
      .mockResolvedValueOnce([
        {
          ...parkedRow,
          monitoringEvents: [
            {
              ...parkedRow.monitoringEvents[0],
              failureFingerprint: "SOURCE:OTHER"
            }
          ]
        }
      ]);

    const snapshots = await loadParkedCourseCampaignMembers({
      courseSupportIncident: { findMany }
    } as never);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      failureFingerprint: "SOURCE:MISSING",
      monitoringFailureFingerprint: "SOURCE:LEGACY"
    });
    expect(snapshots[0]).not.toHaveProperty("activeRealSearchCount");
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt: parkedAt,
      members: snapshots
    });
    expect(parseParkedCourseCampaignAudit(audit)).toEqual(audit);
    expect(
      parseParkedCourseCampaignAudit({
        ...audit,
        members: [{ ...audit.members[0], activeRealSearchCount: 0 }]
      })
    ).toBeNull();
    await expect(
      loadParkedCourseCampaignMembers({
        courseSupportIncident: { findMany }
      } as never)
    ).resolves.toEqual([]);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          course: expect.objectContaining({
            preferences: {
              none: {
                teeSearch: {
                  status: "ACTIVE",
                  trafficClass: { notIn: expect.arrayContaining(["AUTOMATION", "TEST"]) }
                }
              }
            }
          })
        })
      })
    );
  });

  it("hashes attempt ledgers canonically so object key order is not material", () => {
    expect(
      createParkedCourseCampaignAttemptLedgerFingerprint({
        version: 1,
        nested: { beta: 2, alpha: 1 }
      })
    ).toBe(
      createParkedCourseCampaignAttemptLedgerFingerprint({
        nested: { alpha: 1, beta: 2 },
        version: 1
      })
    );
  });

  it("creates a deterministic immutable membership digest and rejects tampering", () => {
    const members = [member(2), member(1)];
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 2,
      capturedAt,
      members
    });

    expect(audit.members.map((entry) => entry.courseId)).toEqual(["course-1", "course-2"]);
    expect(audit.schemaVersion).toBe(2);
    expect(audit.membershipDigest).toBe(createParkedCourseCampaignMembershipDigest(members));
    expect(audit.aggregateEvidenceCategories).toEqual({
      sourceMissingCount: 2,
      sourceConflictCount: 0,
      providerSpecificCount: 0,
      priorProbeCount: 2,
      priorDiscoveryCount: 2,
      noPriorEvidenceCount: 0
    });
    expect(summarizeCampaignEvidenceCategories(audit.members)).toEqual(
      audit.aggregateEvidenceCategories
    );
    expect(parseParkedCourseCampaignAudit(audit)).toEqual(audit);
    expect(
      createParkedCourseCampaignMembershipDigest([
        member(1, { monitoringFailureFingerprint: "SOURCE:LEGACY" })
      ])
    ).not.toBe(createParkedCourseCampaignMembershipDigest([member(1)]));
    expect(
      parseParkedCourseCampaignAudit({
        ...audit,
        members: [{ ...audit.members[0], revision: 8 }, audit.members[1]]
      })
    ).toBeNull();
    expect(
      parseParkedCourseCampaignAudit({
        ...audit,
        aggregateEvidenceCategories: {
          ...audit.aggregateEvidenceCategories,
          sourceMissingCount: 1
        }
      })
    ).toBeNull();
  });

  it("keeps a count-mismatched dry run read-only and returns its snapshot digest", async () => {
    const { dependencies } = campaignDependencies({
      members: [member(1), member(2)]
    });

    const result = await runParkedCourseCampaignCommand(
      { apply: false, expectedCount: 112, now: capturedAt },
      dependencies
    );

    expect(result).toMatchObject({
      mode: "dry-run",
      campaignState: "PREVIEW",
      expectedCount: 112,
      capturedCount: 2,
      countMatches: false
    });
    expect(result.membershipDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(dependencies.createCampaign).not.toHaveBeenCalled();
    expect(dependencies.withTransitionLease).not.toHaveBeenCalled();
  });

  it("requires the exact dry-run digest before creating one durable run", async () => {
    const members = Array.from({ length: 112 }, (_, index) => member(index + 1));
    const { dependencies } = campaignDependencies({ members });
    const membershipDigest = createParkedCourseCampaignMembershipDigest(members);

    await expect(
      runParkedCourseCampaignCommand(
        {
          apply: true,
          expectedCount: 112,
          expectedDigest: "0".repeat(64),
          now: capturedAt
        },
        dependencies
      )
    ).rejects.toThrow("changed after dry run");
    expect(dependencies.createCampaign).not.toHaveBeenCalled();

    const result = await runParkedCourseCampaignCommand(
      {
        apply: true,
        expectedCount: 112,
        expectedDigest: membershipDigest,
        now: capturedAt
      },
      dependencies
    );

    expect(result).toMatchObject({
      mode: "apply",
      campaignState: "ACTIVE",
      capturedCount: 112,
      membershipDigest
    });
    expect(dependencies.createCampaign).toHaveBeenCalledTimes(1);
  });

  it("rejects changing the immutable production baseline count", async () => {
    const { dependencies } = campaignDependencies({ members: [member(1)] });

    await expect(
      runParkedCourseCampaignCommand(
        { apply: false, expectedCount: 111, now: capturedAt },
        dependencies
      )
    ).rejects.toThrow("immutable baseline of 112");
    expect(dependencies.loadParkedMembers).not.toHaveBeenCalled();
  });

  it("reports exclusive progress buckets and append-only human intervention", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 5,
      capturedAt,
      members: [member(1), member(2), member(3), member(4), member(5)]
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 7,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "HEALTHY",
          latestProbe: {
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-20T12:50:00.000Z"),
            runtimeVersion: "release-1",
            rawSummary: null
          }
        }),
        observation(2, {
          status: "RESOLVED",
          resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
          resolvedAt: new Date("2026-08-20T14:00:00.000Z"),
          decisionAt: new Date("2026-08-20T13:50:00.000Z"),
          monitoringState: "FINAL_TECHNICAL",
          humanReviewCycles: [4]
        }),
        observation(3, {
          currentlyParked: true,
          cycle: 3,
          status: "NEEDS_HUMAN"
        }),
        observation(4)
      ]
    });

    expect(progress).toMatchObject({
      totalCount: 5,
      terminalCount: 2,
      readyCount: 1,
      activeCount: 1,
      engineeringBlockerCount: 1,
      currentResultMissingCount: 0,
      terminalWithin24HoursCount: 2,
      automaticWithin24HoursCount: 1,
      humanReviewCount: 1,
      remainingGlobalParkedCount: 7
    });
    expect(
      progress.terminalCount +
        progress.readyCount +
        progress.activeCount +
        progress.engineeringBlockerCount +
        progress.currentResultMissingCount
    ).toBe(progress.totalCount);
  });

  it("does not accept a resolution from the captured parked cycle as fresh proof", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)]
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          cycle: 3,
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "HEALTHY"
        })
      ]
    });

    expect(progress.terminalCount).toBe(0);
    expect(progress.engineeringBlockerCount).toBe(1);
  });

  it("requires fresh campaign-tagged terminal evidence and a runtime probe for recovery", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)]
    });
    const base = observation(1, {
      status: "RESOLVED",
      resolution: "MONITORING_RESTORED",
      resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
      monitoringState: "HEALTHY",
      latestProbe: {
        outcome: "NO_MATCH",
        observedAt: new Date("2026-08-20T12:50:00.000Z"),
        runtimeVersion: "release-1",
        rawSummary: null
      }
    });

    for (const changed of [
      { ...base, campaignTerminalEvidenceAt: null },
      { ...base, campaignTerminalEvidenceAt: new Date("2026-08-20T11:59:59.000Z") },
      { ...base, campaignTerminalRuntimeVersion: "release-2" },
      { ...base, latestProbe: null },
      {
        ...base,
        latestProbe: {
          outcome: "NO_MATCH",
          observedAt: new Date("2026-08-20T12:50:00.000Z"),
          runtimeVersion: null,
          rawSummary: null
        }
      },
      {
        ...base,
        latestProbe: {
          outcome: "NO_MATCH",
          observedAt: new Date("2026-08-20T12:00:30.000Z"),
          runtimeVersion: "release-1",
          rawSummary: null
        }
      }
    ]) {
      const progress = summarizeParkedCourseCampaignProgress({
        audit,
        remainingGlobalParkedCount: 0,
        observations: [changed]
      });
      expect(progress.terminalCount).toBe(0);
      expect(progress.engineeringBlockerCount).toBe(1);
    }
  });

  it("keeps the campaign running when atomic completion revalidation declines", async () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)]
    });
    const { dependencies } = campaignDependencies({
      members: [],
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "HEALTHY",
          latestProbe: {
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-20T12:50:00.000Z"),
            runtimeVersion: "release-1",
            rawSummary: null
          }
        })
      ]
    });
    dependencies.loadActiveCampaign.mockResolvedValue({
      id: "campaign-run-1",
      status: "RUNNING",
      completedAt: null,
      outcome: null,
      audit
    });
    dependencies.completeCampaign.mockResolvedValue(false);

    const result = await inspectActiveParkedCourseCampaign(
      { completeIfDone: true },
      dependencies
    );

    expect(result).toMatchObject({ status: "RUNNING", terminalCount: 1, totalCount: 1 });
    expect(dependencies.completeCampaign).toHaveBeenCalledTimes(1);
  });

  it("does not complete while generic parked waiting remains outside the baseline", async () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)]
    });
    const { dependencies } = campaignDependencies({
      members: [member(2)],
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "HEALTHY",
          latestProbe: {
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-20T12:50:00.000Z"),
            runtimeVersion: "release-1",
            rawSummary: null
          }
        })
      ]
    });
    dependencies.loadActiveCampaign.mockResolvedValue({
      id: "campaign-run-1",
      status: "RUNNING",
      completedAt: null,
      outcome: null,
      audit
    });

    const result = await inspectActiveParkedCourseCampaign(
      { completeIfDone: true },
      dependencies
    );

    expect(result).toMatchObject({
      status: "RUNNING",
      terminalCount: 1,
      totalCount: 1,
      remainingGlobalParkedCount: 1
    });
    expect(dependencies.completeCampaign).not.toHaveBeenCalled();
  });

  it("counts a revision-churned captured row in the global parked invariant", async () => {
    const captured = member(1);
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [captured]
    });
    const current = member(1, { revision: 9, monitoringRevision: 13 });
    const { dependencies } = campaignDependencies({
      members: [],
      allMembers: [current],
      observations: [
        observation(1, {
          cycle: 3,
          status: "NEEDS_HUMAN",
          currentlyParked: true
        })
      ]
    });
    dependencies.loadActiveCampaign.mockResolvedValue({
      id: "campaign-run-1",
      status: "RUNNING",
      completedAt: null,
      outcome: null,
      audit
    });

    const result = await inspectActiveParkedCourseCampaign(
      { completeIfDone: true },
      dependencies
    );

    expect(result).toMatchObject({
      status: "RUNNING",
      readyCount: 1,
      remainingGlobalParkedCount: 1
    });
    expect(dependencies.loadAllParkedMembers).toHaveBeenCalledTimes(1);
    expect(dependencies.loadGlobalParkedCount).toHaveBeenCalledTimes(1);
    expect(dependencies.completeCampaign).not.toHaveBeenCalled();
  });

  it("does not count an operator-tagged final as automatic when decisionAt is absent", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)]
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          decisionAt: null,
          monitoringState: "FINAL_MANUAL",
          campaignTerminalAutomatedFinal: false
        })
      ]
    });

    expect(progress).toMatchObject({
      terminalCount: 1,
      automaticWithin24HoursCount: 0,
      humanReviewCount: 1
    });
  });

  it("keeps append-only human cycle evidence from regaining automatic credit", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)]
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          decisionAt: null,
          monitoringState: "FINAL_MANUAL",
          campaignTerminalAutomatedFinal: true,
          humanReviewCycles: [4]
        })
      ]
    });

    expect(progress).toMatchObject({
      terminalCount: 1,
      automaticWithin24HoursCount: 0,
      humanReviewCount: 1
    });
  });

  it.each([
    { campaignTerminalRuntimeVersion: null },
    { campaignTerminalAutomatedFinal: null }
  ])("rejects a factual final without complete terminal provenance", (missing) => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)]
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "FINAL_MANUAL",
          ...missing
        })
      ]
    });

    expect(progress).toMatchObject({ terminalCount: 0, engineeringBlockerCount: 1 });
  });

  it("measures the 24-hour endpoint from durable terminal evidence", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)]
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "FINAL_MANUAL",
          campaignTerminalEvidenceAt: new Date("2026-08-21T12:00:01.000Z")
        })
      ]
    });

    expect(progress).toMatchObject({
      terminalCount: 1,
      terminalWithin24HoursCount: 0,
      automaticWithin24HoursCount: 0
    });
  });
});
