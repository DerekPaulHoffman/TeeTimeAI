import { beforeEach, describe, expect, it, vi } from "vitest";

const globalMocks = vi.hoisted(() => ({
  latest: vi.fn(),
  incidents: vi.fn(),
  parkedCount: vi.fn(),
  terminalEntries: vi.fn(),
  checks: vi.fn(),
  deployments: vi.fn(),
  mutation: vi.fn(),
  runtime: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRun: {
      findFirst: globalMocks.latest,
      findMany: globalMocks.deployments,
      create: globalMocks.mutation,
      updateMany: globalMocks.mutation,
    },
    courseSupportIncident: {
      findMany: globalMocks.incidents,
      count: globalMocks.parkedCount,
      updateMany: globalMocks.mutation,
    },
    courseSupportBatchIncident: {
      findMany: globalMocks.terminalEntries,
      updateMany: globalMocks.mutation,
    },
    courseMonitoringEvent: {
      findMany: globalMocks.checks,
      create: globalMocks.mutation,
    },
    $transaction: globalMocks.mutation,
    $executeRawUnsafe: globalMocks.mutation,
  },
}));
vi.mock("./runtime-version", () => ({
  getAutomationRuntimeVersion: globalMocks.runtime,
}));

import {
  createParkedCourseCampaignAudit,
  inspectLatestParkedCourseCampaign,
  PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
  type ParkedCourseCampaignDatabase,
  type ParkedCourseCampaignMember,
} from "./course-support-campaign";

const CAPTURED_AT = new Date("2026-08-20T12:00:00.000Z");
const NOW = new Date("2026-08-20T14:00:00.000Z");
const ORIGINAL_RUNTIME = "a".repeat(40);
const CURRENT_RUNTIME = "b".repeat(40);
const CONFIRMED_AT = new Date("2026-08-20T12:01:00.000Z");
const TERMINAL_AT = new Date("2026-08-20T12:20:00.000Z");
const PROVIDER_OBSERVED_AT = new Date("2026-08-20T12:40:00.000Z");
const member: ParkedCourseCampaignMember = {
  courseId: "private-course",
  incidentId: "private-incident",
  cycle: 3,
  revision: 7,
  monitoringRevision: 11,
  monitoringFailureFingerprint: "SOURCE:MISSING",
  kind: "NEEDS_ADAPTER",
  providerFamilyKey: "SOURCE_MISSING",
  failureClass: "MISSING_SOURCE",
  failureFingerprint: "SOURCE:MISSING",
  providerSnapshotFingerprint: "c".repeat(64),
  attemptLedgerFingerprint: "d".repeat(64),
  playbookConclusion: "UNRESOLVED_EXHAUSTED",
  latestProbeAt: null,
  latestDiscoveryAt: null,
};
const audit = createParkedCourseCampaignAudit({
  expectedCount: 1,
  capturedAt: CAPTURED_AT,
  members: [member],
});
const storedRun = {
  id: "private-campaign",
  status: "RUNNING",
  completedAt: null,
  outcome: null,
  audit,
};

beforeEach(() => {
  vi.resetAllMocks();
  globalMocks.runtime.mockReturnValue(CURRENT_RUNTIME);
  globalMocks.mutation.mockImplementation(() => {
    throw new Error("Inspection must remain read-only.");
  });
});

describe("latest parked campaign transaction-bound inspection", () => {
  it("returns null through the supplied client without extra reads when no campaign exists", async () => {
    const { database, reads, mutation } = inspectionDatabase();
    reads.latest.mockResolvedValue(null);

    expect(await inspectLatestParkedCourseCampaign(database)).toBeNull();

    expect(reads.latest).toHaveBeenCalledExactlyOnceWith({
      where: { promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        completedAt: true,
        outcome: true,
        audit: true,
      },
    });
    expect(reads.incidents).not.toHaveBeenCalled();
    expect(reads.parkedCount).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(mutation);
  });

  it("retains native defaults and the complete read pipeline without completing a terminal campaign", async () => {
    const baseline = inspectionDatabase();
    globalMocks.latest.mockImplementation(baseline.reads.latest);
    globalMocks.incidents.mockImplementation(baseline.reads.incidents);
    globalMocks.parkedCount.mockImplementation(baseline.reads.parkedCount);
    globalMocks.terminalEntries.mockImplementation(baseline.reads.terminalEntries);
    globalMocks.checks.mockImplementation(baseline.reads.checks);
    globalMocks.deployments.mockImplementation(baseline.reads.deployments);
    const expected = await inspectLatestParkedCourseCampaign();
    expect(expected).toMatchObject({
      status: "RUNNING",
      totalCount: 1,
      terminalCount: 1,
      monitoredCount: 1,
      automaticWithin24HoursCount: 1,
      remainingGlobalParkedCount: 0,
    });
    const defaultQueries = baseline.reads.incidents.mock.calls.map(([query]) => query);
    vi.clearAllMocks();
    const { database, reads, mutation } = inspectionDatabase();

    const actual = await inspectLatestParkedCourseCampaign(database, {
      now: NOW,
      admissionRuntimeVersion: CURRENT_RUNTIME,
    });

    expect(actual).toEqual(expected);
    expect(reads.incidents.mock.calls.map(([query]) => query)).toEqual(defaultQueries);
    expect(reads.incidents).toHaveBeenCalledTimes(3);
    expect(reads.parkedCount).toHaveBeenCalledTimes(1);
    expect(reads.terminalEntries).toHaveBeenCalledTimes(1);
    expect(reads.checks).toHaveBeenCalledTimes(1);
    expect(reads.deployments).toHaveBeenCalledTimes(1);
    expect(globalMocks.runtime).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(mutation);
  });

  it("reads local-reader freshness with the supplied clock and optional transaction models", async () => {
    const { database, reads, mutation } = inspectionDatabase();
    const parked = parkedReaderRow();
    reads.incidents.mockImplementation(async (query) => {
      if (query.where.status === "NEEDS_HUMAN") return [parked];
      if (typeof query.where.id === "string") {
        return [{ id: parked.id, cycle: parked.cycle, batchIncidents: [] }];
      }
      return [];
    });
    reads.parkedCount.mockResolvedValue(1);

    const result = await inspectLatestParkedCourseCampaign(database, {
      now: NOW,
      admissionRuntimeVersion: CURRENT_RUNTIME,
    });

    expect(result).toMatchObject({ status: "RUNNING", terminalCount: 0 });
    expect(reads.incidents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "private-incident", cycle: 4 },
        take: 1,
      }),
    );
    expect(reads.searchCount).toHaveBeenCalledExactlyOnceWith({
      where: {
        status: "ACTIVE",
        preferences: { some: { courseId: "private-course" } },
      },
    });
    expect(reads.agents).toHaveBeenCalledExactlyOnceWith({
      where: {
        lastSeenAt: {
          gte: new Date("2026-08-20T13:55:00.000Z"),
          lte: NOW,
        },
      },
      orderBy: { deviceId: "asc" },
      take: 21,
      select: {
        deviceId: true,
        readerVersion: true,
        buildId: true,
        capabilities: true,
        lastSeenAt: true,
      },
    });
    expect(reads.jobs).not.toHaveBeenCalled();
    expect(globalMocks.runtime).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(mutation);
  });

  it("fails closed on an invalid stored audit before progress reads or any write", async () => {
    const { database, reads, mutation } = inspectionDatabase();
    reads.latest.mockResolvedValue({ ...storedRun, audit: { schemaVersion: 2 } });

    await expect(inspectLatestParkedCourseCampaign(database)).rejects.toThrow();

    expect(reads.incidents).not.toHaveBeenCalled();
    expect(reads.parkedCount).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(mutation);
  });
});

function inspectionDatabase() {
  const reads = {
    latest: vi.fn().mockResolvedValue(storedRun),
    incidents: vi.fn().mockImplementation(async (query) =>
      query.where.status === "NEEDS_HUMAN" ? [] : [resolvedObservationRow()],
    ),
    parkedCount: vi.fn().mockResolvedValue(0),
    terminalEntries: vi.fn().mockResolvedValue([]),
    checks: vi.fn().mockResolvedValue([
      {
        incidentId: member.incidentId,
        courseId: member.courseId,
        occurredAt: PROVIDER_OBSERVED_AT,
        runtimeVersion: CURRENT_RUNTIME,
        outcome: "NO_MATCH",
        audit: null,
      },
    ]),
    deployments: vi.fn().mockResolvedValue([
      {
        id: `cm_deploy_${CURRENT_RUNTIME}`,
        runtimeVersion: CURRENT_RUNTIME,
        startedAt: new Date("2026-08-20T12:30:00.000Z"),
      },
    ]),
    searchCount: vi.fn().mockResolvedValue(0),
    agents: vi.fn().mockResolvedValue([]),
    jobs: vi.fn().mockResolvedValue([]),
  };
  const mutation = vi.fn(() => {
    throw new Error("Transaction-bound inspection must not mutate.");
  });
  const database = {
    automationRun: {
      findFirst: reads.latest,
      findMany: reads.deployments,
      create: mutation,
      updateMany: mutation,
    },
    courseSupportIncident: {
      findMany: reads.incidents,
      count: reads.parkedCount,
      updateMany: mutation,
    },
    courseSupportBatchIncident: {
      findMany: reads.terminalEntries,
      updateMany: mutation,
    },
    courseMonitoringEvent: { findMany: reads.checks, create: mutation },
    teeSearch: { count: reads.searchCount, updateMany: mutation },
    localReaderAgent: { findMany: reads.agents, updateMany: mutation },
    localReaderJob: { findMany: reads.jobs, create: mutation },
    $transaction: mutation,
    $executeRawUnsafe: mutation,
  } as unknown as ParkedCourseCampaignDatabase;
  return { database, reads, mutation };
}

function expectNoGlobalReadsOrWrites(mutation: ReturnType<typeof vi.fn>) {
  for (const key of [
    "latest", "incidents", "parkedCount", "terminalEntries", "checks", "deployments", "mutation",
  ] as const) expect(globalMocks[key]).not.toHaveBeenCalled();
  expect(mutation).not.toHaveBeenCalled();
}

function resolvedObservationRow() {
  return {
    id: member.incidentId,
    courseId: member.courseId,
    cycle: 4,
    status: "RESOLVED",
    activeBatchId: null,
    confirmedAt: CONFIRMED_AT,
    firstSeenAt: CONFIRMED_AT,
    providerFamilyKey: member.providerFamilyKey,
    failureClass: member.failureClass,
    attemptCount: 1,
    activeRealSearchCount: 0,
    attemptLedger: null,
    resolution: "MONITORING_RESTORED",
    resolvedAt: TERMINAL_AT,
    decisionAt: null,
    monitoringEvents: [{
      id: "private-terminal",
      incidentId: member.incidentId,
      courseId: member.courseId,
      eventType: "RECOVERED",
      source: "COURSE_SUPPORT_RESPONDER",
      fromState: "AUTO_INVESTIGATING",
      toState: "HEALTHY",
      occurredAt: TERMINAL_AT,
      outcome: "NO_MATCH",
      runtimeVersion: ORIGINAL_RUNTIME,
      deploymentSha: ORIGINAL_RUNTIME,
      audit: {
        cycle: 4,
        confirmedAt: CONFIRMED_AT.toISOString(),
        automatedFinal: true,
        freshRuntimeProof: true,
      },
    }],
    course: {
      monitoringStatus: { state: "HEALTHY", stateChangedAt: TERMINAL_AT },
      probes: [{
        outcome: "NO_MATCH",
        observedAt: new Date("2026-08-20T12:41:00.000Z"),
        runtimeVersion: CURRENT_RUNTIME,
        rawSummary: {
          providerExecution: "RUNNABLE_PROVIDER_CHECK",
          providerObservedAt: PROVIDER_OBSERVED_AT.toISOString(),
        },
      }],
    },
  };
}

function parkedReaderRow() {
  const parkedAt = new Date("2026-08-20T13:00:00.000Z");
  const stages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
  ];
  return {
    id: member.incidentId,
    courseId: member.courseId,
    cycle: 4,
    revision: 9,
    kind: member.kind,
    providerFamilyKey: member.providerFamilyKey,
    failureClass: member.failureClass,
    failureFingerprint: member.failureFingerprint,
    attemptLedger: {
      version: 1,
      events: stages.map(([stage, readPath], index) => ({
        sequence: index + 1,
        cycle: 4,
        stage,
        transition: "NOT_APPLICABLE",
        readPath,
        evidenceKind: "TOOLING",
        observedAt: new Date(CAPTURED_AT.getTime() + index * 1_000).toISOString(),
        failureFingerprint: member.failureFingerprint,
        runtimeVersion: ORIGINAL_RUNTIME,
        skipReason: "NO_PROVIDER_METADATA",
      })),
    },
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
    monitoringEvents: [{
      id: "private-parked",
      incidentId: member.incidentId,
      eventType: "HUMAN_REVIEW_REQUESTED",
      source: "RECOVERY_CRON",
      failureFingerprint: member.failureFingerprint,
      readPath: "LOCAL_READER",
      occurredAt: parkedAt,
      audit: {
        cycle: 4,
        customerState: "NEEDS_HUMAN_REVIEW",
        automationStalled: true,
        parkedUntilMaterialChange: true,
        playbookExhausted: false,
      },
    }],
    batchIncidents: [],
    course: {
      name: "Private Course",
      timeZone: "America/New_York",
      isPublic: true,
      website: "https://private.cps.golf/",
      detectedBookingUrl: "https://private.cps.golf/onlineresweb/search-teetime",
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "CPS",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      monitoringMode: "STANDARD",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      bookingMetadata: null,
      preferences: [],
      monitoringStatus: {
        state: "ENGINEERING_VERIFICATION_NEEDED",
        revision: 13,
        failureFingerprint: member.failureFingerprint,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
      },
      probes: [],
      automationDiscoveries: [],
    },
  };
}
