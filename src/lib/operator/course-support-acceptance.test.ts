import { describe, expect, it, vi } from "vitest";

import {
  createParkedCourseCampaignAudit,
  type ParkedCourseCampaignMember,
} from "@/lib/automation/course-support-campaign";

import {
  attachCourseSupportAcceptanceProjection,
  loadCourseSupportAcceptanceProjection,
  parseCourseSupportAcceptanceProjection,
  type CourseSupportAcceptanceObservedCampaign,
} from "./course-support-acceptance";
import type {
  OperatorCourseSupportCampaign,
  OperatorFutureAutomaticResolution,
  OperatorRepeatImplementations,
  OperatorRollingHumanReview,
} from "./course-support-campaign";

const capturedAt = new Date("2026-08-20T12:00:00.000Z");

describe("course-support acceptance projection", () => {
  it("keeps fleet attention and engineering counts distinct from cohort blockers", async () => {
    const audit = campaignAudit();
    const loadFreshGlobalParkedCount = vi.fn(async () => 0);
    const projection = await loadCourseSupportAcceptanceProjection(
      {
        now: new Date("2026-08-22T12:00:00.000Z"),
        observedCampaign: observedCampaign(audit, {
          status: "RUNNING",
          terminalCount: 111,
          pendingCount: 1,
          monitoredCount: 111,
          engineeringBlockerCount: 1,
          terminalWithin24HoursCount: 111,
          automaticWithin24HoursCount: 111,
        }),
      },
      dependencies(audit, {
        fleetCounts: fleetCounts({ action: 3, watch: 5, engineeringNeeded: 1 }),
        loadFreshGlobalParkedCount,
        latestRecord: latestCampaignRecord(audit, { status: "RUNNING" }),
        summary: campaignSummary({
          engineeringBlockerCount: 1,
          lifecycleStatus: "RUNNING",
        }),
      }),
    );

    expect(projection).toMatchObject({
      status: "IN_PROGRESS",
      fleet: {
        attention: { actionCount: 3, watchCount: 5, totalCount: 8 },
        engineeringNeededCount: 1,
      },
      latestCampaign: {
        currentResults: { engineeringBlockerCount: 1 },
      },
    });
    expect(parseCourseSupportAcceptanceProjection(projection)).toEqual(
      projection,
    );
    expect(loadFreshGlobalParkedCount).not.toHaveBeenCalled();
  });

  it("reports all eight attention courses and a failed diagnostic baseline without making either an acceptance gate", async () => {
    const audit = campaignAudit();
    const projection = await loadCourseSupportAcceptanceProjection(
      { observedCampaign: observedCampaign(audit) },
      dependencies(audit, {
        fleetCounts: fleetCounts({ action: 3, watch: 5 }),
        summary: campaignSummary({ baselineStatus: "FAIL" }),
      }),
    );

    expect(projection).toMatchObject({
      status: "PASS",
      reason: "ALL_GATES_PASS",
      fleet: {
        attention: { actionCount: 3, watchCount: 5, totalCount: 8 },
        engineeringNeededCount: 0,
      },
      latestCampaign: {
        baselineAutomaticWithin24Hours: { status: "FAIL" },
        currentResults: { engineeringBlockerCount: 0 },
      },
    });
    expect(parseCourseSupportAcceptanceProjection(projection)).toEqual(
      projection,
    );
  });

  it.each([
    ["PASS", "PASS"],
    ["FAIL", "FAIL"],
    ["IN_PROGRESS", "IN_PROGRESS"],
    ["NO_DATA", "UNKNOWN"],
    ["UNKNOWN", "UNKNOWN"],
  ] as const)(
    "maps future automatic status %s without treating missing evidence as pass",
    async (futureStatus, expectedStatus) => {
      const audit = campaignAudit();
      const projection = await loadCourseSupportAcceptanceProjection(
        { observedCampaign: observedCampaign(audit) },
        dependencies(audit, {
          summary: campaignSummary({
            futureAutomaticWithin24Hours: futureAutomatic(futureStatus),
          }),
        }),
      );

      expect(projection.status).toBe(expectedStatus);
      expect(parseCourseSupportAcceptanceProjection(projection)).toEqual(
        projection,
      );
    },
  );

  it.each([
    ["PASS", "PASS"],
    ["FAIL", "FAIL"],
    ["NO_DATA", "UNKNOWN"],
    ["UNKNOWN", "UNKNOWN"],
  ] as const)(
    "maps rolling human-review status %s at the exact five-percent boundary",
    async (humanStatus, expectedStatus) => {
      const audit = campaignAudit();
      const projection = await loadCourseSupportAcceptanceProjection(
        { observedCampaign: observedCampaign(audit) },
        dependencies(audit, {
          summary: campaignSummary({
            rollingHumanReview: rollingHumanReview(humanStatus),
          }),
        }),
      );

      expect(projection.status).toBe(expectedStatus);
      if (projection.operational) {
        expect(projection.operational.rollingHumanReview).toMatchObject({
          humanReviewCount:
            humanStatus === "FAIL" ? 2 : humanStatus === "NO_DATA" ? 0 : 1,
          endpointCount:
            humanStatus === "NO_DATA"
              ? 0
              : humanStatus === "UNKNOWN"
                ? 1
                : 20,
          targetPercent: 5,
          status: humanStatus,
        });
      }
      expect(parseCourseSupportAcceptanceProjection(projection)).toEqual(
        projection,
      );
    },
  );

  it.each([
    ["PASS", "PASS"],
    ["FAIL", "FAIL"],
    ["UNKNOWN", "UNKNOWN"],
  ] as const)(
    "requires repeat-implementation status %s to pass independently",
    async (repeatStatus, expectedStatus) => {
      const audit = campaignAudit();
      const projection = await loadCourseSupportAcceptanceProjection(
        { observedCampaign: observedCampaign(audit) },
        dependencies(audit, {
          summary: campaignSummary({
            repeatImplementations: repeatImplementations(repeatStatus),
          }),
        }),
      );

      expect(projection.status).toBe(expectedStatus);
      expect(parseCourseSupportAcceptanceProjection(projection)).toEqual(
        projection,
      );
    },
  );

  it("round-trips coherent UNKNOWN current results with one missing member result", async () => {
    const audit = campaignAudit();
    const projection = await loadCourseSupportAcceptanceProjection(
      {
        observedCampaign: observedCampaign(audit, {
          status: "RUNNING",
          terminalCount: 111,
          pendingCount: 1,
          monitoredCount: 111,
          currentResultMissingCount: 1,
          terminalWithin24HoursCount: 111,
          automaticWithin24HoursCount: 111,
        }),
      },
      dependencies(audit, {
        latestRecord: latestCampaignRecord(audit, { status: "RUNNING" }),
        summary: campaignSummary({
          currentResultMissingCount: 1,
          lifecycleStatus: "RUNNING",
        }),
      }),
    );

    expect(projection).toMatchObject({
      status: "UNKNOWN",
      reason: "ACCEPTANCE_EVIDENCE_UNAVAILABLE",
      latestCampaign: {
        lifecycleStatus: "RUNNING",
        progress: {
          terminalCount: 111,
          pendingCount: 1,
          status: "IN_PROGRESS",
        },
        currentResults: {
          resultCount: 111,
          accountedCount: 112,
          missingCount: 1,
          monitoredCount: 111,
          bucketInvariantStatus: "PASS",
          status: "UNKNOWN",
        },
      },
    });
    expect(parseCourseSupportAcceptanceProjection(projection)).toEqual(
      projection,
    );
  });

  it("keeps a completed 112-course baseline visible and refreshes generic waiting", async () => {
    const audit = campaignAudit();
    const loadCampaignSummary = vi.fn(
      async (input: {
        campaignInspection: { remainingGlobalParkedCount: number };
      }) =>
        campaignSummary({
          remainingGlobalParkedCount:
            input.campaignInspection.remainingGlobalParkedCount,
        }),
    );
    const projection = await loadCourseSupportAcceptanceProjection(
      { observedCampaign: null },
      dependencies(audit, {
        latestRecord: latestCampaignRecord(audit, {
          notes: completedNotes(audit),
          status: "COMPLETED",
        }),
        loadCampaignSummary,
        loadFreshGlobalParkedCount: vi.fn(async () => 1),
      }),
    );

    expect(loadCampaignSummary).toHaveBeenCalledTimes(1);
    expect(projection).toMatchObject({
      status: "IN_PROGRESS",
      latestCampaign: {
        lifecycleStatus: "COMPLETED",
        capturedAt: capturedAt.toISOString(),
        expectedCount: 112,
        totalCount: 112,
        membershipDigest: audit.membershipDigest,
        progress: {
          terminalCount: 112,
          remainingGlobalParkedCount: 1,
          status: "IN_PROGRESS",
        },
      },
    });
    if (projection.latestCampaign) {
      const categories = projection.latestCampaign.aggregateEvidenceCategories;
      expect(
        categories.sourceMissingCount +
          categories.sourceConflictCount +
          categories.providerSpecificCount,
      ).toBe(112);
      expect(
        categories.priorProbeCount + categories.priorDiscoveryCount,
      ).toBeGreaterThan(112 - categories.noPriorEvidenceCount);
    }
    expect(parseCourseSupportAcceptanceProjection(projection)).toEqual(
      projection,
    );
  });

  it("fails closed on malformed latest closeout progress without falling back", async () => {
    const audit = campaignAudit();
    const loadCampaignSummary = vi.fn(async () => campaignSummary());
    const projection = await loadCourseSupportAcceptanceProjection(
      { observedCampaign: null },
      dependencies(audit, {
        latestRecord: latestCampaignRecord(audit, {
          notes: JSON.stringify({ lifecycle: "closeout", progress: {} }),
          status: "COMPLETED",
        }),
        loadCampaignSummary,
      }),
    );

    expect(projection).toMatchObject({
      status: "UNKNOWN",
      reason: "LATEST_CAMPAIGN_UNAVAILABLE",
      latestCampaign: null,
      operational: null,
    });
    expect(loadCampaignSummary).not.toHaveBeenCalled();
  });

  it("fails closed when the provider evidence partition does not match membership", async () => {
    const audit = campaignAudit();
    const malformedAudit = {
      ...audit,
      aggregateEvidenceCategories: {
        ...audit.aggregateEvidenceCategories,
        providerSpecificCount:
          audit.aggregateEvidenceCategories.providerSpecificCount - 1,
      },
    };
    const projection = await loadCourseSupportAcceptanceProjection(
      { observedCampaign: observedCampaign(audit) },
      dependencies(audit, {
        latestRecord: latestCampaignRecord(malformedAudit),
      }),
    );

    expect(projection).toMatchObject({
      status: "UNKNOWN",
      reason: "LATEST_CAMPAIGN_UNAVAILABLE",
    });
  });

  it("fails closed when a coherent latest campaign is not the exact 112-course baseline", async () => {
    const audit = campaignAudit(111);
    const projection = await loadCourseSupportAcceptanceProjection(
      { observedCampaign: observedCampaign(audit) },
      dependencies(audit),
    );

    expect(projection).toMatchObject({
      status: "UNKNOWN",
      reason: "LATEST_CAMPAIGN_UNAVAILABLE",
      latestCampaign: null,
    });
  });

  it("fails closed when aggregate campaign results do not match the immutable audit", async () => {
    const audit = campaignAudit();
    const mismatchedSummary = campaignSummary();
    mismatchedSummary.expectedCount = 111;
    const projection = await loadCourseSupportAcceptanceProjection(
      { observedCampaign: observedCampaign(audit) },
      dependencies(audit, { summary: mismatchedSummary }),
    );

    expect(projection).toMatchObject({
      status: "UNKNOWN",
      reason: "LATEST_CAMPAIGN_UNAVAILABLE",
      latestCampaign: null,
    });
  });

  it("preserves the authoritative handoff when acceptance reads fail", async () => {
    const inspection = {
      outcome: "ready",
      handoff: { action: "CLAIM", source: "ORDINARY_DISPATCH" },
      observedAt: "2026-08-22T12:00:00.000Z",
      parkedCampaign: null,
    };
    const result = await attachCourseSupportAcceptanceProjection(
      inspection,
      async () => {
        throw new Error("private course and provider details");
      },
    );

    expect(result.handoff).toBe(inspection.handoff);
    expect(result).toMatchObject({
      outcome: "ready",
      acceptanceProjection: {
        status: "UNKNOWN",
        reason: "ACCEPTANCE_READ_FAILED",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private course");
  });

  it("returns only aggregate acceptance evidence while retaining the membership digest", async () => {
    const audit = campaignAudit();
    const projection = await loadCourseSupportAcceptanceProjection(
      { observedCampaign: observedCampaign(audit) },
      dependencies(audit),
    );
    const serialized = JSON.stringify(projection);

    expect(serialized).toContain(audit.membershipDigest);
    for (const privateValue of [
      audit.members[0]?.courseId,
      audit.members[0]?.incidentId,
      "private-run-id",
      "private-provider.example",
      "private-course-name",
      "private@example.com",
      "https://private.example/course",
      "src/lib/availability/private-reader.ts",
      "a".repeat(40),
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("rejects well-shaped projections with incoherent derived evidence", async () => {
    const audit = campaignAudit();
    const projection = await loadCourseSupportAcceptanceProjection(
      { observedCampaign: observedCampaign(audit) },
      dependencies(audit),
    );
    if (!projection.latestCampaign || !projection.operational) {
      throw new Error("Expected an available acceptance projection.");
    }
    expect(parseCourseSupportAcceptanceProjection(projection)).toEqual(
      projection,
    );

    const incoherentProjections = [
      {
        ...projection,
        latestCampaign: {
          ...projection.latestCampaign,
          aggregateEvidenceCategories: {
            ...projection.latestCampaign.aggregateEvidenceCategories,
            providerSpecificCount:
              projection.latestCampaign.aggregateEvidenceCategories
                .providerSpecificCount - 1,
          },
        },
      },
      {
        ...projection,
        latestCampaign: {
          ...projection.latestCampaign,
          progress: {
            ...projection.latestCampaign.progress,
            pendingCount: 1,
          },
        },
      },
      {
        ...projection,
        latestCampaign: {
          ...projection.latestCampaign,
          progress: {
            ...projection.latestCampaign.progress,
            terminalCount: 111,
            pendingCount: 1,
            status: "IN_PROGRESS" as const,
          },
          currentResults: {
            ...projection.latestCampaign.currentResults,
            monitoredCount: 111,
            activeCount: 1,
          },
          baselineAutomaticWithin24Hours: {
            ...projection.latestCampaign.baselineAutomaticWithin24Hours,
            automaticCount: 111,
          },
        },
      },
      {
        ...projection,
        latestCampaign: {
          ...projection.latestCampaign,
          currentResults: {
            ...projection.latestCampaign.currentResults,
            resultCount: 111,
          },
        },
      },
      {
        ...projection,
        operational: {
          ...projection.operational,
          futureAutomaticWithin24Hours: {
            ...projection.operational.futureAutomaticWithin24Hours,
            ratePercent: 96,
          },
        },
      },
      {
        ...projection,
        operational: {
          ...projection.operational,
          rollingHumanReview: {
            ...projection.operational.rollingHumanReview,
            ratePercent: 4,
          },
        },
      },
      {
        ...projection,
        status: "UNKNOWN" as const,
        reason: "ACCEPTANCE_EVIDENCE_UNAVAILABLE" as const,
        operational: {
          ...projection.operational,
          rollingHumanReview: {
            ...projection.operational.rollingHumanReview,
            humanReviewCount: 21,
            endpointCount: 20,
            ratePercent: null,
            ambiguousEndpointCount: 1,
            status: "UNKNOWN" as const,
          },
        },
      },
      {
        ...projection,
        operational: {
          ...projection.operational,
          repeatImplementations: {
            ...projection.operational.repeatImplementations,
            repeatImplementationCount: 1,
            status: "FAIL" as const,
          },
        },
      },
    ];

    for (const incoherent of incoherentProjections) {
      expect(parseCourseSupportAcceptanceProjection(incoherent)).toBeNull();
    }
  });
});

function campaignAudit(expectedCount = 112) {
  const members = Array.from({ length: expectedCount }, (_, index) =>
    campaignMember(index),
  );
  return createParkedCourseCampaignAudit({
    capturedAt,
    expectedCount: members.length,
    members,
  });
}

function campaignMember(index: number): ParkedCourseCampaignMember {
  return {
    courseId: `private-course-${String(index).padStart(3, "0")}`,
    incidentId: `private-incident-${String(index).padStart(3, "0")}`,
    cycle: 1,
    revision: 1,
    monitoringRevision: 1,
    monitoringFailureFingerprint: null,
    kind: "FETCH_FAILED",
    providerFamilyKey:
      index < 10
        ? "SOURCE_MISSING"
        : index < 12
          ? "SOURCE_CONFLICT"
          : `private-provider-${index}.example`,
    failureClass: "UNSUPPORTED_FAMILY",
    failureFingerprint: `${index}`.padStart(64, "0"),
    providerSnapshotFingerprint: `${index + 1}`.padStart(64, "0"),
    attemptLedgerFingerprint: `${index + 2}`.padStart(64, "0"),
    playbookConclusion: "UNRESOLVED_EXHAUSTED",
    latestProbeAt: index % 2 === 0 ? "2026-08-19T12:00:00.000Z" : null,
    latestDiscoveryAt: index % 3 === 0 ? "2026-08-19T13:00:00.000Z" : null,
  };
}

type TestFleetCounts = {
  action: number;
  watch: number;
  parked: number;
  limitations: number;
  unchecked: number;
  working: number;
  dueNow: number;
  inProgress: number;
  recoveryRequired: number;
  scheduledRetry: number;
  engineeringNeeded: number;
  needsHuman: number;
};

function fleetCounts(
  overrides: Partial<TestFleetCounts> = {},
): TestFleetCounts {
  return {
    action: 0,
    watch: 0,
    parked: 0,
    limitations: 0,
    unchecked: 0,
    working: 112,
    dueNow: 0,
    inProgress: 0,
    recoveryRequired: 0,
    scheduledRetry: 0,
    engineeringNeeded: 0,
    needsHuman: 0,
    ...overrides,
  };
}

function observedCampaign(
  audit: ReturnType<typeof campaignAudit>,
  overrides: Partial<CourseSupportAcceptanceObservedCampaign> = {},
): CourseSupportAcceptanceObservedCampaign {
  return {
    status: "COMPLETED",
    capturedAt: audit.capturedAt,
    expectedCount: audit.expectedCount,
    terminalCount: audit.expectedCount,
    pendingCount: 0,
    readyCount: 0,
    activeCount: 0,
    monitoredCount: audit.expectedCount,
    bookingNotOpenCount: 0,
    factualLimitationCount: 0,
    technicalLimitationCount: 0,
    sourceUnverifiedCount: 0,
    engineeringBlockerCount: 0,
    currentResultMissingCount: 0,
    humanReviewCount: 0,
    terminalWithin24HoursCount: audit.expectedCount,
    automaticWithin24HoursCount: audit.expectedCount,
    remainingGlobalParkedCount: 0,
    membershipDigest: audit.membershipDigest,
    ...overrides,
  };
}

function campaignSummary(
  overrides: {
    baselineStatus?: OperatorCourseSupportCampaign["automaticWithin24Hours"]["status"];
    currentResultMissingCount?: number;
    engineeringBlockerCount?: number;
    futureAutomaticWithin24Hours?: OperatorFutureAutomaticResolution;
    lifecycleStatus?: OperatorCourseSupportCampaign["status"];
    remainingGlobalParkedCount?: number;
    repeatImplementations?: OperatorRepeatImplementations;
    rollingHumanReview?: OperatorRollingHumanReview;
  } = {},
): OperatorCourseSupportCampaign {
  const currentResultMissingCount = overrides.currentResultMissingCount ?? 0;
  const engineeringBlockerCount = overrides.engineeringBlockerCount ?? 0;
  const remainingGlobalParkedCount = overrides.remainingGlobalParkedCount ?? 0;
  const terminalCount =
    112 - currentResultMissingCount - engineeringBlockerCount;
  const pendingCount = 112 - terminalCount;
  return {
    status:
      overrides.lifecycleStatus ??
      (pendingCount > 0 ? "RUNNING" : "COMPLETED"),
    capturedAt,
    expectedCount: 112,
    progress: {
      terminalCount,
      totalCount: 112,
      pendingCount,
      remainingGlobalParkedCount,
      status:
        terminalCount === 112 && remainingGlobalParkedCount === 0
          ? "COMPLETE"
          : "IN_PROGRESS",
    },
    currentResults: {
      resultCount: 112 - currentResultMissingCount,
      accountedCount: 112,
      totalCount: 112,
      missingCount: currentResultMissingCount,
      monitoredCount: terminalCount,
      bookingNotOpenCount: 0,
      factualLimitationCount: 0,
      technicalLimitationCount: 0,
      sourceUnverifiedCount: 0,
      readyCount: 0,
      activeCount: 0,
      engineeringBlockerCount,
      campaignHumanReviewCount: 0,
      bucketInvariantStatus: "PASS",
      status: currentResultMissingCount === 0 ? "PASS" : "UNKNOWN",
    },
    automaticWithin24Hours: {
      automaticCount:
        overrides.baselineStatus === undefined ||
        overrides.baselineStatus === "PASS"
          ? terminalCount
          : 100,
      totalCount: 112,
      deadlineAt: new Date("2026-08-21T12:00:00.000Z"),
      targetPercent: 95,
      status: overrides.baselineStatus ?? "PASS",
    },
    futureAutomaticWithin24Hours:
      overrides.futureAutomaticWithin24Hours ?? futureAutomatic("PASS"),
    rollingHumanReview:
      overrides.rollingHumanReview ?? rollingHumanReview("PASS"),
    repeatImplementations:
      overrides.repeatImplementations ?? repeatImplementations("PASS"),
  };
}

function futureAutomatic(
  status: OperatorFutureAutomaticResolution["status"],
): OperatorFutureAutomaticResolution {
  if (status === "NO_DATA") {
    return {
      windowDays: 30,
      eligibleCount: 0,
      automaticCount: 0,
      nonAutomaticCount: 0,
      pendingCount: 0,
      unknownCount: 0,
      ratePercent: null,
      targetPercent: 95,
      status,
    };
  }
  if (status === "IN_PROGRESS") {
    return {
      windowDays: 30,
      eligibleCount: 20,
      automaticCount: 18,
      nonAutomaticCount: 1,
      pendingCount: 1,
      unknownCount: 0,
      ratePercent: 90,
      targetPercent: 95,
      status,
    };
  }
  if (status === "UNKNOWN") {
    return {
      windowDays: 30,
      eligibleCount: 20,
      automaticCount: 18,
      nonAutomaticCount: 1,
      pendingCount: 0,
      unknownCount: 1,
      ratePercent: null,
      targetPercent: 95,
      status,
    };
  }
  return {
    windowDays: 30,
    eligibleCount: 20,
    automaticCount: status === "FAIL" ? 18 : 19,
    nonAutomaticCount: status === "FAIL" ? 2 : 1,
    pendingCount: 0,
    unknownCount: 0,
    ratePercent: status === "FAIL" ? 90 : 95,
    targetPercent: 95,
    status,
  };
}

function rollingHumanReview(
  status: OperatorRollingHumanReview["status"],
): OperatorRollingHumanReview {
  return {
    windowDays: 30,
    humanReviewCount: status === "FAIL" ? 2 : status === "NO_DATA" ? 0 : 1,
    endpointCount:
      status === "NO_DATA" ? 0 : status === "UNKNOWN" ? 1 : 20,
    ratePercent:
      status === "NO_DATA" || status === "UNKNOWN"
        ? null
        : status === "FAIL"
          ? 10
          : 5,
    targetPercent: 5,
    ambiguousEndpointCount: status === "UNKNOWN" ? 1 : 0,
    status,
  };
}

function repeatImplementations(
  status: OperatorRepeatImplementations["status"],
): OperatorRepeatImplementations {
  return {
    repeatImplementationCount: status === "FAIL" ? 1 : 0,
    implementationBatchCount: 2,
    implementationGroupCount: status === "FAIL" ? 1 : 2,
    status,
  };
}

function latestCampaignRecord(
  audit: unknown,
  overrides: Partial<{
    id: string;
    status: string;
    notes: string | null;
  }> = {},
) {
  return {
    id: "private-run-id",
    status: "COMPLETED",
    audit,
    notes: null,
    ...overrides,
  };
}

function completedNotes(audit: ReturnType<typeof campaignAudit>) {
  const { status: _status, ...progress } = observedCampaign(audit);
  void _status;
  return JSON.stringify({
    schemaVersion: 2,
    lifecycle: "closeout",
    outcome: "completed",
    progress: {
      ...progress,
      totalCount: audit.expectedCount,
    },
    customerDataIncluded: false,
  });
}

function dependencies(
  audit: ReturnType<typeof campaignAudit>,
  overrides: Partial<{
    fleetCounts: ReturnType<typeof fleetCounts>;
    latestRecord: ReturnType<typeof latestCampaignRecord> | null;
    loadCampaignSummary: ReturnType<typeof vi.fn>;
    loadFreshGlobalParkedCount: ReturnType<typeof vi.fn>;
    summary: OperatorCourseSupportCampaign;
  }> = {},
) {
  return {
    loadCourseFleetCounts: vi.fn(
      async () => overrides.fleetCounts ?? fleetCounts(),
    ),
    loadLatestCampaignRecord: vi.fn(async () =>
      overrides.latestRecord === undefined
        ? latestCampaignRecord(audit)
        : overrides.latestRecord,
    ),
    loadFreshGlobalParkedCount:
      overrides.loadFreshGlobalParkedCount ?? vi.fn(async () => 0),
    loadCampaignSummary:
      overrides.loadCampaignSummary ??
      vi.fn(async () => overrides.summary ?? campaignSummary()),
  };
}
