import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  lineageFindFirst: vi.fn(),
  deploymentEventsFindMany: vi.fn(),
  deploymentRunFindFirst: vi.fn(),
  batchFindUnique: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    courseMonitoringEvent: {
      findFirst: prismaMocks.lineageFindFirst,
      findMany: prismaMocks.deploymentEventsFindMany,
    },
    automationRun: {
      findFirst: prismaMocks.deploymentRunFindFirst,
    },
    courseSupportBatch: {
      findUnique: prismaMocks.batchFindUnique,
      findMany: prismaMocks.findMany,
    },
  },
}));

import {
  aggregateCourseSupportAcceptanceHistory,
  buildCourseSupportAcceptanceHistoryMachineRecord,
  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_RECORD_TYPE,
  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_DELIVERIES_PER_SEARCH,
  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_LOCAL_READER_JOBS_PER_SEARCH,
  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_MATCHES_PER_SEARCH,
  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_PROBES_PER_SEARCH,
  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_REQUESTS_PER_INCIDENT,
  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_SEARCH_DISPATCHES_PER_BATCH,
  COURSE_SUPPORT_RELEASE_LINEAGE_FAILURE_CLASS,
  CourseSupportReleaseLineageError,
  getCourseSupportAcceptanceHistory,
  parseCourseSupportAcceptanceHistoryOptions,
  type CourseSupportAcceptanceHistoryBatch,
} from "./course-support-acceptance-history";
import { DELIVERY_SYNTHETIC_MULTI_CYCLE_DRY_RUN } from "@/lib/email/delivery-policy";

const releaseSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const deployedAt = new Date("2026-08-31T12:00:00.000Z");
const windowStartedAt = new Date("2026-08-31T12:00:00.000Z");
const windowEndedAt = new Date("2026-08-31T13:00:00.000Z");

describe("course-support acceptance history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.lineageFindFirst.mockResolvedValue({
      audit: {
        batchRef: "private-lineage-reference",
        customerDataIncluded: false,
      },
    });
    prismaMocks.batchFindUnique.mockResolvedValue({
      releaseSha,
      deployedAt,
      summary: null,
    });
    prismaMocks.deploymentEventsFindMany.mockResolvedValue([]);
    prismaMocks.deploymentRunFindFirst.mockResolvedValue(null);
  });

  it("aggregates exact-deployment reader, implementation, search, and orchestration proof", () => {
    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [completeEvidenceBatch()],
      }),
    ).toEqual({
      schemaVersion: 2,
      releaseSelection: "EXACT_DEPLOYMENT",
      windowBoundary: "HALF_OPEN",
      deployedAt: deployedAt.toISOString(),
      windowStartedAt: windowStartedAt.toISOString(),
      windowEndedAt: windowEndedAt.toISOString(),
      completedBatchCount: 1,
      localReaderSuccessCount: 1,
      localReaderSuccessUnavailableCount: 0,
      localReaderSuccessAvailability: "available",
      strictReusableSupportExecutionCount: 1,
      strictReusableSupportExecutionUnavailableCount: 0,
      strictReusableSupportExecutionAvailability: "available",
      nonVacuousSearchRecheckSuccessCount: 1,
      nonVacuousSearchRecheckUnavailableCount: 0,
      nonVacuousSearchRecheckAvailability: "available",
      orchestrationOnlyCount: 0,
      orchestrationOnlyUnavailableCount: 0,
      orchestrationOnlyAvailability: "available",
      syntheticCanaryDispatchCount: 1,
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 1,
      syntheticCanaryExternalSendAttemptCount: 0,
      syntheticCanaryExternalSendAttemptUnavailableCount: 0,
      syntheticCanaryExternalSendAttemptAvailability: "available",
      localReaderSearchResumeSuccessCount: 1,
      localReaderSearchResumeUnavailableCount: 0,
      localReaderSearchResumeAvailability: "available",
      syntheticCanaryLocalReaderResumeSuccessCount: 1,
    });
  });

  it("preserves valid empty evidence as explicit available zeroes", () => {
    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [],
      }),
    ).toMatchObject({
      completedBatchCount: 0,
      localReaderSuccessCount: 0,
      localReaderSuccessUnavailableCount: 0,
      localReaderSuccessAvailability: "available",
      strictReusableSupportExecutionCount: 0,
      strictReusableSupportExecutionUnavailableCount: 0,
      strictReusableSupportExecutionAvailability: "available",
      nonVacuousSearchRecheckSuccessCount: 0,
      nonVacuousSearchRecheckUnavailableCount: 0,
      nonVacuousSearchRecheckAvailability: "available",
      orchestrationOnlyCount: 0,
      orchestrationOnlyUnavailableCount: 0,
      orchestrationOnlyAvailability: "available",
      syntheticCanaryDispatchCount: 0,
      syntheticCanaryProviderSuccessCount: 0,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: 0,
      syntheticCanaryExternalSendAttemptUnavailableCount: 0,
      syntheticCanaryExternalSendAttemptAvailability: "available",
      localReaderSearchResumeSuccessCount: 0,
      localReaderSearchResumeUnavailableCount: 0,
      localReaderSearchResumeAvailability: "available",
      syntheticCanaryLocalReaderResumeSuccessCount: 0,
    });
  });

  it("fails each derived total closed when its durable envelope is unavailable", () => {
    const batch = completeEvidenceBatch();
    const request = batch.incidents[0].verificationRequests[0];
    request.evidence = {
      ...asRecord(request.evidence),
      adapterKey: undefined,
    };
    const summary = asRecord(batch.summary);
    const closeout = asRecord(summary.closeout);
    const attempts = closeout.remediationAttempts as Array<
      Record<string, unknown>
    >;
    delete attempts[0].actionExecution;
    delete summary.recheckDispatch;
    const decisionBasis = asRecord(closeout.decisionBasis);
    delete decisionBasis.orchestrationOnlyCount;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      completedBatchCount: 1,
      localReaderSuccessCount: null,
      localReaderSuccessUnavailableCount: 1,
      localReaderSuccessAvailability: "unavailable",
      strictReusableSupportExecutionCount: null,
      strictReusableSupportExecutionUnavailableCount: 1,
      strictReusableSupportExecutionAvailability: "unavailable",
      nonVacuousSearchRecheckSuccessCount: null,
      nonVacuousSearchRecheckUnavailableCount: 1,
      nonVacuousSearchRecheckAvailability: "unavailable",
      orchestrationOnlyCount: null,
      orchestrationOnlyUnavailableCount: 1,
      orchestrationOnlyAvailability: "unavailable",
    });
  });

  it("reports partial availability without turning known evidence into a false total", () => {
    const unavailableBatch = completeEvidenceBatch();
    unavailableBatch.completedAt = new Date("2026-08-31T12:40:00.000Z");
    const closeout = asRecord(asRecord(unavailableBatch.summary).closeout);
    delete asRecord(closeout.decisionBasis).orchestrationOnlyCount;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [completeEvidenceBatch(), unavailableBatch],
      }),
    ).toMatchObject({
      completedBatchCount: 2,
      orchestrationOnlyCount: null,
      orchestrationOnlyUnavailableCount: 1,
      orchestrationOnlyAvailability: "partial",
    });
  });

  it("does not count vacuous detached health as a search recheck", () => {
    const batch = completeEvidenceBatch();
    const dispatch = asRecord(asRecord(batch.summary).recheckDispatch);
    Object.assign(dispatch, {
      affectedSearchCount: 0,
      queuedCount: 0,
      currentAffectedSearchCount: 0,
      healthySchedulerCount: 0,
      freshSearchCheckCount: 0,
      affectedCourseSearchPairCount: 0,
      healthyCourseSearchPairCount: 0,
    });

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      nonVacuousSearchRecheckSuccessCount: 0,
      nonVacuousSearchRecheckUnavailableCount: 0,
      nonVacuousSearchRecheckAvailability: "available",
    });
  });

  it("does not count a recheck whose current affected cohort changed", () => {
    const batch = completeEvidenceBatch();
    const dispatch = asRecord(asRecord(batch.summary).recheckDispatch);
    Object.assign(dispatch, {
      currentAffectedSearchCount: 2,
      healthySchedulerCount: 2,
      freshSearchCheckCount: 2,
    });

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      nonVacuousSearchRecheckSuccessCount: 0,
      nonVacuousSearchRecheckUnavailableCount: 0,
      nonVacuousSearchRecheckAvailability: "available",
    });
  });

  it("fails local-reader attribution closed when a succeeded request has no completion time", () => {
    const batch = completeEvidenceBatch();
    batch.incidents[0].verificationRequests[0].completedAt = null;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      localReaderSuccessCount: null,
      localReaderSuccessUnavailableCount: 1,
      localReaderSuccessAvailability: "unavailable",
    });
  });

  it("does not attribute historical implementation execution to the selected release", () => {
    const batch = completeEvidenceBatch();
    delete asRecord(batch.summary).releaseProvenance;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      strictReusableSupportExecutionCount: null,
      strictReusableSupportExecutionUnavailableCount: 1,
      strictReusableSupportExecutionAvailability: "unavailable",
    });
  });

  it("uses bounded exact release-lineage and half-open history reads", async () => {
    prismaMocks.findMany.mockResolvedValue([completeEvidenceBatch()]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).resolves.toMatchObject({ completedBatchCount: 1 });

    expect(prismaMocks.lineageFindFirst).toHaveBeenCalledOnce();
    expect(prismaMocks.lineageFindFirst).toHaveBeenCalledWith({
      where: {
        eventType: "DEPLOYMENT_VERIFIED",
        source: "DEPLOYMENT",
        runtimeVersion: releaseSha,
        deploymentSha: releaseSha,
        occurredAt: deployedAt,
        audit: {
          path: ["customerDataIncluded"],
          equals: false,
        },
      },
      select: { audit: true },
    });
    expect(prismaMocks.batchFindUnique).toHaveBeenCalledOnce();
    expect(prismaMocks.batchFindUnique).toHaveBeenCalledWith({
      where: { reference: "private-lineage-reference" },
      select: {
        releaseSha: true,
        deployedAt: true,
        summary: true,
      },
    });
    expect(prismaMocks.deploymentEventsFindMany).toHaveBeenCalledWith({
      where: {
        eventType: "DEPLOYMENT_VERIFIED",
        source: "DEPLOYMENT",
        runtimeVersion: { not: releaseSha },
        deploymentSha: { not: releaseSha },
        occurredAt: { gt: deployedAt },
        audit: {
          path: ["customerDataIncluded"],
          equals: false,
        },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 1,
      select: {
        runtimeVersion: true,
        deploymentSha: true,
        occurredAt: true,
        audit: true,
      },
    });
    expect(prismaMocks.deploymentRunFindFirst).toHaveBeenCalledWith({
      where: {
        id: { startsWith: "cm_deploy_" },
        promptVersion: "course-monitoring-deployment-revalidation-v1",
        kind: "MAINTENANCE",
        status: "COMPLETED",
        outcome: "deployment_observed",
        runtimeVersion: { not: releaseSha },
        startedAt: { gt: deployedAt },
        auditSchemaVersion: 1,
        audit: {
          path: ["customerDataIncluded"],
          equals: false,
        },
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        runtimeVersion: true,
        startedAt: true,
        completedAt: true,
        audit: true,
      },
    });
    expect(prismaMocks.findMany).toHaveBeenCalledOnce();
    expect(prismaMocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          releaseSha,
          deployedAt,
          completedAt: { gte: windowStartedAt, lt: windowEndedAt },
        },
        orderBy: { completedAt: "asc" },
      }),
    );
    const query = prismaMocks.findMany.mock.calls[0]?.[0];
    expect(query.take).toBe(257);
    expect(query.select).not.toHaveProperty("id");
    expect(query.select.incidents.take).toBe(21);
    expect(query.select.incidents.select).not.toHaveProperty("courseId");
    expect(query.select.incidents.select.verificationRequests.take).toBe(
      COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_REQUESTS_PER_INCIDENT + 1,
    );
    expect(query.select.incidents.select.verificationRequests.orderBy).toEqual([
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    expect(query.select.searchDispatches.take).toBe(
      COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_SEARCH_DISPATCHES_PER_BATCH + 1,
    );
    expect(query.select.searchDispatches.select.searchRef).toBe(true);
    expect(query.select.searchDispatches.select.scheduleVersion).toBe(true);
    expect(query.select.searchDispatches.select).not.toHaveProperty("id");
    const deliveryQuery =
      query.select.searchDispatches.select.teeSearch.select.emailDeliveries;
    expect(deliveryQuery.where).toEqual({
      OR: [
        {
          createdAt: { gte: windowStartedAt, lt: windowEndedAt },
        },
        {
          updatedAt: { gte: windowStartedAt, lt: windowEndedAt },
        },
      ],
    });
    expect(deliveryQuery.take).toBe(
      COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_DELIVERIES_PER_SEARCH + 1,
    );
    expect(deliveryQuery.select).not.toHaveProperty("recipient");
    expect(deliveryQuery.select).not.toHaveProperty("groupKey");
    expect(deliveryQuery.select.payload).toBe(true);
    expect(deliveryQuery.select.alertGeneration).toBe(true);
    expect(deliveryQuery.select.kind).toBe(true);
    expect(deliveryQuery.select.createdAt).toBe(true);
    const matchQuery =
      query.select.searchDispatches.select.teeSearch.select.matches;
    expect(matchQuery.take).toBe(
      COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_MATCHES_PER_SEARCH + 1,
    );
    expect(matchQuery.select).not.toHaveProperty("bookingUrl");
    expect(matchQuery.select).not.toHaveProperty("sourceId");
    expect(matchQuery.select.availabilityCycle).toBe(true);
    const localReaderJobQuery =
      query.select.searchDispatches.select.teeSearch.select.localReaderJobs;
    expect(localReaderJobQuery.take).toBe(
      COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_LOCAL_READER_JOBS_PER_SEARCH + 1,
    );
    expect(localReaderJobQuery.select).not.toHaveProperty("id");
    expect(localReaderJobQuery.select).not.toHaveProperty("result");
    expect(localReaderJobQuery.select).not.toHaveProperty("bookingUrl");
    expect(localReaderJobQuery.select).not.toHaveProperty("teeSearchId");
    expect(localReaderJobQuery.select.resumeFromScheduleVersion).toBe(true);
    expect(localReaderJobQuery.select.resumeScheduleVersion).toBe(true);
    const probeQuery =
      query.select.searchDispatches.select.teeSearch.select.probes;
    expect(probeQuery.take).toBe(
      COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_PROBES_PER_SEARCH + 1,
    );
    expect(probeQuery.select).not.toHaveProperty("id");
    expect(probeQuery.select).not.toHaveProperty("message");
    expect(probeQuery.select).not.toHaveProperty("evidenceUrl");
    expect(probeQuery.select.automationRun.select.audit).toBe(true);
  });

  it("preserves explicit zeroes only after durable release lineage is proven", async () => {
    prismaMocks.findMany.mockResolvedValue([]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).resolves.toMatchObject({
      releaseSelection: "EXACT_DEPLOYMENT",
      completedBatchCount: 0,
      localReaderSuccessCount: 0,
      strictReusableSupportExecutionCount: 0,
      nonVacuousSearchRecheckSuccessCount: 0,
      orchestrationOnlyCount: 0,
    });
  });

  it.each([
    ["missing", null],
    ["missing audit", { audit: null }],
    ["missing private reference", { audit: { customerDataIncluded: false } }],
    [
      "empty private reference",
      { audit: { batchRef: " ", customerDataIncluded: false } },
    ],
    [
      "unsafe audit",
      {
        audit: {
          batchRef: "private-lineage-reference",
          customerDataIncluded: true,
        },
      },
    ],
  ])(
    "rejects %s release lineage before reading batch history",
    async (_label, lineage) => {
      prismaMocks.lineageFindFirst.mockResolvedValue(lineage);

      await expect(
        getCourseSupportAcceptanceHistory({
          releaseSha,
          deployedAt,
          windowStartedAt,
          windowEndedAt,
        }),
      ).rejects.toBeInstanceOf(CourseSupportReleaseLineageError);
      expect(prismaMocks.batchFindUnique).not.toHaveBeenCalled();
      expect(prismaMocks.findMany).not.toHaveBeenCalled();
    },
  );

  it("rejects an orphaned release-lineage batch reference", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue(null);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toBeInstanceOf(CourseSupportReleaseLineageError);
    expect(prismaMocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects a referenced batch whose current release pair is different", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      releaseSha: "c".repeat(40),
      deployedAt: new Date("2026-08-31T12:05:00.000Z"),
      summary: null,
    });

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toBeInstanceOf(CourseSupportReleaseLineageError);
    expect(prismaMocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects a retained old release whose full acceptance snapshot is no longer queryable", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      releaseSha: "c".repeat(40),
      deployedAt: new Date("2026-08-31T12:45:00.000Z"),
      summary: {
        releaseHistory: [retainedReleaseHistoryEntry()],
      },
    });
    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toBeInstanceOf(CourseSupportReleaseLineageError);
    expect(prismaMocks.deploymentEventsFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.deploymentRunFindFirst).not.toHaveBeenCalled();
    expect(prismaMocks.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong release pair",
      retainedReleaseHistoryEntry({ releaseSha: "d".repeat(40) }),
    ],
    [
      "noncanonical deployment time",
      retainedReleaseHistoryEntry({ deployedAt: "2026-08-31T12:00:00Z" }),
    ],
    [
      "malformed superseding release",
      retainedReleaseHistoryEntry({ supersededBy: "not-a-sha" }),
    ],
    [
      "malformed superseding time",
      retainedReleaseHistoryEntry({ supersededAt: "not-a-time" }),
    ],
  ])("rejects %s in retained release lineage", async (_label, historyEntry) => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      releaseSha: "c".repeat(40),
      deployedAt: new Date("2026-08-31T12:45:00.000Z"),
      summary: { releaseHistory: [historyEntry] },
    });

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toBeInstanceOf(CourseSupportReleaseLineageError);
    expect(prismaMocks.findMany).not.toHaveBeenCalled();
  });

  it("projects release-lineage failures without identifiers", () => {
    const record = buildCourseSupportAcceptanceHistoryMachineRecord({
      outcome: "command_failed",
      failure: {
        failureDomain: "DEPLOYMENT",
        failureClass: COURSE_SUPPORT_RELEASE_LINEAGE_FAILURE_CLASS,
        durableCloseoutRecorded: false,
        threadDisposition: "KEEP_VISIBLE",
        error: `${releaseSha}:private-lineage-reference`,
      },
    });

    expect(record).toMatchObject({
      outcome: "command_failed",
      acceptanceHistory: null,
      failure: {
        failureDomain: "DEPLOYMENT",
        failureClass: COURSE_SUPPORT_RELEASE_LINEAGE_FAILURE_CLASS,
        durableCloseoutRecorded: false,
        threadDisposition: "KEEP_VISIBLE",
      },
    });
    const output = JSON.stringify(record);
    expect(output).not.toContain(releaseSha);
    expect(output).not.toContain("private-lineage-reference");
  });

  it("fails closed when a malformed batch exceeds the bounded incident relation", async () => {
    const batch = completeEvidenceBatch();
    batch.incidents = Array.from({ length: 21 }, () => ({
      verificationRequests: [],
    }));
    prismaMocks.findMany.mockResolvedValue([batch]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toThrow("bounded incident limit");
  });

  it("fails closed when an incident exceeds the bounded verification-request relation", async () => {
    const batch = completeEvidenceBatch();
    const request = batch.incidents[0].verificationRequests[0];
    batch.incidents[0].verificationRequests = Array.from(
      {
        length: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_REQUESTS_PER_INCIDENT + 1,
      },
      () => ({ ...request }),
    );
    prismaMocks.findMany.mockResolvedValue([batch]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toThrow("bounded verification-request limit");
  });

  it("fails closed when the completed-batch window exceeds its hard bound", async () => {
    prismaMocks.findMany.mockResolvedValue(
      Array.from({ length: 257 }, completeEvidenceBatch),
    );

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toThrow("bounded completed-batch limit");
  });

  it("fails closed when a batch exceeds the bounded search-dispatch relation", async () => {
    const batch = completeEvidenceBatch();
    batch.searchDispatches = Array.from(
      {
        length:
          COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_SEARCH_DISPATCHES_PER_BATCH + 1,
      },
      () => ({ teeSearch: null }),
    );
    prismaMocks.findMany.mockResolvedValue([batch]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toThrow("bounded search-dispatch limit");
  });

  it("fails closed when a synthetic search exceeds the bounded delivery relation", async () => {
    const batch = completeEvidenceBatch();
    const teeSearch = batch.searchDispatches[0].teeSearch!;
    const delivery = teeSearch.emailDeliveries[0];
    teeSearch.emailDeliveries = Array.from(
      {
        length: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_DELIVERIES_PER_SEARCH + 1,
      },
      (_, index) => ({ ...delivery, id: `delivery-${index}` }),
    );
    prismaMocks.findMany.mockResolvedValue([batch]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toThrow("bounded delivery limit");
  });

  it("fails closed when a synthetic search exceeds the bounded match relation", async () => {
    const batch = completeEvidenceBatch();
    const teeSearch = batch.searchDispatches[0].teeSearch!;
    const match = teeSearch.matches[0];
    teeSearch.matches = Array.from(
      {
        length: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_MATCHES_PER_SEARCH + 1,
      },
      (_, index) => ({ ...match, id: `private-match-${index}` }),
    );
    prismaMocks.findMany.mockResolvedValue([batch]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toThrow("bounded match limit");
  });

  it("fails closed when a search exceeds the bounded local-reader-job relation", async () => {
    const batch = completeEvidenceBatch();
    const teeSearch = batch.searchDispatches[0].teeSearch!;
    const job = teeSearch.localReaderJobs[0];
    teeSearch.localReaderJobs = Array.from(
      {
        length:
          COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_LOCAL_READER_JOBS_PER_SEARCH +
          1,
      },
      () => ({ ...job }),
    );
    prismaMocks.findMany.mockResolvedValue([batch]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toThrow("bounded local-reader-job limit");
  });

  it("fails closed when a search exceeds the bounded probe relation", async () => {
    const batch = completeEvidenceBatch();
    const teeSearch = batch.searchDispatches[0].teeSearch!;
    const probe = teeSearch.probes[0];
    teeSearch.probes = Array.from(
      {
        length: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_PROBES_PER_SEARCH + 1,
      },
      () => ({ ...probe }),
    );
    prismaMocks.findMany.mockResolvedValue([batch]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).rejects.toThrow("bounded probe limit");
  });

  it("reports claimed synthetic delivery history unavailable without durable sender-boundary proof", () => {
    const batch = completeEvidenceBatch();
    const delivery = batch.searchDispatches[0].teeSearch!.emailDeliveries[0];
    delivery.lastError = "DELIVERY_DRY_RUN";

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryDispatchCount: 1,
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
      syntheticCanaryExternalSendAttemptAvailability: "unavailable",
    });
  });

  it("attributes provider success only to the exact synthetic search run, not batch-wide health", () => {
    const batch = completeEvidenceBatch();
    const unrelated = completeEvidenceBatch().searchDispatches[0];
    unrelated.searchRef = "2".repeat(64);
    unrelated.teeSearch!.emailDeliveries = [];
    unrelated.teeSearch!.matches = [];
    unrelated.teeSearch!.localReaderJobs = [];
    unrelated.teeSearch!.probes[0].rawSummary = {
      providerExecution: "RUNNABLE_PROVIDER_CHECK",
      providerObservedAt: "2026-08-31T12:19:00.000Z",
    };
    // This run belongs to the first dispatch even though its probe is exposed
    // through the second relation; the private search hash must reject it.
    unrelated.teeSearch!.probes[0].automationRun!.audit = {
      trigger: "workflow",
      searchRef: "1".repeat(16),
      outcome: "success",
      checkedCourses: 1,
      courseOutcomes: { MATCH_FOUND: 1 },
    };
    batch.searchDispatches = [batch.searchDispatches[0], unrelated];
    Object.assign(asRecord(asRecord(batch.summary).recheckDispatch), {
      affectedSearchCount: 2,
      queuedCount: 2,
      currentAffectedSearchCount: 2,
      healthySchedulerCount: 2,
      freshSearchCheckCount: 2,
      affectedCourseSearchPairCount: 2,
      healthyCourseSearchPairCount: 2,
    });

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      nonVacuousSearchRecheckSuccessCount: 1,
      syntheticCanaryDispatchCount: 2,
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 1,
    });
  });

  it("rejects provider and delivery proof from an older runtime", () => {
    const batch = completeEvidenceBatch();
    const probe = batch.searchDispatches[0].teeSearch!.probes[0];
    probe.runtimeVersion = "c".repeat(40);
    probe.automationRun!.runtimeVersion = "c".repeat(40);

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryProviderSuccessCount: 0,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
    });
  });

  it("rejects a successful run from a different dispatched schedule version", () => {
    const batch = completeEvidenceBatch();
    batch.searchDispatches[0].teeSearch!.scheduleVersion = 9;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryProviderSuccessCount: 0,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
    });
  });

  it("rejects provider evidence observed before the exact dispatch", () => {
    const batch = completeEvidenceBatch();
    const teeSearch = batch.searchDispatches[0].teeSearch!;
    teeSearch.localReaderJobs[0].claimedAt = new Date(
      "2026-08-31T12:09:00.000Z",
    );
    teeSearch.probes[0].rawSummary = {
      providerExecution: "LOCAL_BROWSER_READER",
      providerObservedAt: "2026-08-31T12:09:00.000Z",
    };

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryProviderSuccessCount: 0,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
    });
  });

  it("rejects a delivery from an unrelated alert generation", () => {
    const batch = completeEvidenceBatch();
    batch.searchDispatches[0].teeSearch!.emailDeliveries[0].alertGeneration = 2;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
    });
  });

  it("rejects a delivery that names an unrelated availability cycle", () => {
    const batch = completeEvidenceBatch();
    const payload = asRecord(
      batch.searchDispatches[0].teeSearch!.emailDeliveries[0].payload,
    );
    payload.matchRefs = [{ matchId: "private-match-id", availabilityCycle: 6 }];

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
    });
  });

  it("rejects an older delivery row settled during the exact check", () => {
    const batch = completeEvidenceBatch();
    const delivery = batch.searchDispatches[0].teeSearch!.emailDeliveries[0];
    delivery.createdAt = new Date("2026-08-31T12:18:00.000Z");

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
    });
  });

  it("rejects a delivery payload from a different check in the same runtime", () => {
    const batch = completeEvidenceBatch();
    asRecord(
      batch.searchDispatches[0].teeSearch!.emailDeliveries[0].payload,
    ).checkedAt = "2026-08-31T12:19:00.000Z";

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
    });
  });

  it("classifies SENT with zero attempts as contradictory, never not-claimed", () => {
    const batch = completeEvidenceBatch();
    const delivery = batch.searchDispatches[0].teeSearch!.emailDeliveries[0];
    delivery.status = "SENT";
    delivery.attemptCount = 0;
    delivery.lastError = null;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
      syntheticCanaryExternalSendAttemptAvailability: "unavailable",
    });
  });

  it("preserves exact unclaimed PENDING evidence as a known zero", () => {
    const batch = completeEvidenceBatch();
    const delivery = batch.searchDispatches[0].teeSearch!.emailDeliveries[0];
    delivery.status = "PENDING";
    delivery.attemptCount = 0;
    delivery.lastError = null;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: 0,
      syntheticCanaryExternalSendAttemptUnavailableCount: 0,
      syntheticCanaryExternalSendAttemptAvailability: "available",
    });
  });

  it("does not infer zero external attempts from a mutable bypass marker on a pre-release row", () => {
    const batch = completeEvidenceBatch();
    const delivery = batch.searchDispatches[0].teeSearch!.emailDeliveries[0];
    delivery.createdAt = new Date("2026-08-31T11:59:59.000Z");

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: true,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
      syntheticCanaryExternalSendAttemptAvailability: "unavailable",
    });
  });

  it("does not infer zero external attempts after the accepted release was superseded", () => {
    const batch = completeEvidenceBatch();

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        releaseRemainedCurrent: false,
        batches: [batch],
      }),
    ).toMatchObject({
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
      syntheticCanaryExternalSendAttemptAvailability: "unavailable",
    });
  });

  it("does not credit mutable sender state after a newer deployment from another batch", async () => {
    prismaMocks.deploymentEventsFindMany.mockResolvedValue([
      {
        runtimeVersion: "c".repeat(40),
        deploymentSha: "c".repeat(40),
        occurredAt: new Date("2026-08-31T12:40:00.000Z"),
        audit: { customerDataIncluded: false },
      },
    ]);
    prismaMocks.findMany.mockResolvedValue([completeEvidenceBatch()]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).resolves.toMatchObject({
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
      syntheticCanaryExternalSendAttemptAvailability: "unavailable",
    });
  });

  it("does not credit mutable sender state after a newer ordinary production deployment", async () => {
    const newerReleaseSha = "d".repeat(40);
    prismaMocks.deploymentRunFindFirst.mockResolvedValue({
      id: `cm_deploy_${newerReleaseSha}`,
      runtimeVersion: newerReleaseSha,
      startedAt: new Date("2026-08-31T12:45:00.000Z"),
      completedAt: new Date("2026-08-31T12:45:00.000Z"),
      audit: { customerDataIncluded: false },
    });
    prismaMocks.findMany.mockResolvedValue([completeEvidenceBatch()]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).resolves.toMatchObject({
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
      syntheticCanaryExternalSendAttemptAvailability: "unavailable",
    });
  });

  it("keeps a delivery created in-window visible and unavailable after a post-window mutation", async () => {
    const batch = completeEvidenceBatch();
    batch.searchDispatches[0].teeSearch!.emailDeliveries[0].updatedAt =
      new Date("2026-08-31T13:05:00.000Z");
    prismaMocks.findMany.mockResolvedValue([batch]);

    await expect(
      getCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
      }),
    ).resolves.toMatchObject({
      syntheticCanaryProviderSuccessCount: 1,
      syntheticCanarySenderBypassCount: 0,
      syntheticCanaryExternalSendAttemptCount: null,
      syntheticCanaryExternalSendAttemptUnavailableCount: 1,
      syntheticCanaryExternalSendAttemptAvailability: "unavailable",
    });
  });

  it("does not attribute provider success when the durable search-dispatch relation is incomplete", () => {
    const batch = completeEvidenceBatch();
    batch.searchDispatches = [];

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      nonVacuousSearchRecheckSuccessCount: 1,
      syntheticCanaryDispatchCount: 0,
      syntheticCanaryProviderSuccessCount: 0,
      localReaderSearchResumeSuccessCount: 0,
      syntheticCanaryLocalReaderResumeSuccessCount: 0,
    });
  });

  it("requires the exact completed reader source to be consumed by a later exact-release search run", () => {
    const batch = completeEvidenceBatch();
    const teeSearch = batch.searchDispatches[0].teeSearch!;
    teeSearch.localReaderJobs[0].resultExpiresAt = new Date(
      "2026-08-31T12:26:00.000Z",
    );

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      nonVacuousSearchRecheckSuccessCount: 1,
      localReaderSearchResumeSuccessCount: 0,
      syntheticCanaryLocalReaderResumeSuccessCount: 0,
    });
  });

  it("reports legacy consumed reader rows as unavailable instead of false zero proof", () => {
    const batch = completeEvidenceBatch();
    const job = batch.searchDispatches[0].teeSearch!.localReaderJobs[0];
    job.resumeFromScheduleVersion = null;
    job.resumeScheduleVersion = null;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      localReaderSearchResumeSuccessCount: null,
      localReaderSearchResumeUnavailableCount: 1,
      localReaderSearchResumeAvailability: "unavailable",
      syntheticCanaryLocalReaderResumeSuccessCount: null,
    });
  });

  it("fails resume proof closed when the persisted target equals its source", () => {
    const batch = completeEvidenceBatch();
    const job = batch.searchDispatches[0].teeSearch!.localReaderJobs[0];
    job.resumeScheduleVersion = job.resumeFromScheduleVersion;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      localReaderSearchResumeSuccessCount: null,
      localReaderSearchResumeUnavailableCount: 1,
      localReaderSearchResumeAvailability: "unavailable",
    });
  });

  it("does not count a stale reader source whose persisted resume began at a later generation", () => {
    const batch = completeEvidenceBatch();
    const job = batch.searchDispatches[0].teeSearch!.localReaderJobs[0];
    job.scheduleVersion = 6;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      localReaderSearchResumeSuccessCount: 0,
      localReaderSearchResumeUnavailableCount: 0,
      localReaderSearchResumeAvailability: "available",
      syntheticCanaryLocalReaderResumeSuccessCount: 0,
    });
  });

  it("does not count a successful search check from a different target generation", () => {
    const batch = completeEvidenceBatch();
    const audit = asRecord(
      batch.searchDispatches[0].teeSearch!.probes[0].automationRun!.audit,
    );
    audit.scheduleVersion = 9;

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      localReaderSearchResumeSuccessCount: 0,
      localReaderSearchResumeUnavailableCount: 0,
      localReaderSearchResumeAvailability: "available",
      syntheticCanaryLocalReaderResumeSuccessCount: 0,
    });
  });

  it("does not count a local-reader probe from a different runtime", () => {
    const batch = completeEvidenceBatch();
    const teeSearch = batch.searchDispatches[0].teeSearch!;
    teeSearch.probes[0].runtimeVersion = "c".repeat(40);

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      localReaderSearchResumeSuccessCount: 0,
      syntheticCanaryLocalReaderResumeSuccessCount: 0,
    });
  });

  it("does not count a search run that began before local-reader completion", () => {
    const batch = completeEvidenceBatch();
    const teeSearch = batch.searchDispatches[0].teeSearch!;
    teeSearch.probes[0].automationRun!.startedAt = new Date(
      "2026-08-31T12:15:00.000Z",
    );

    expect(
      aggregateCourseSupportAcceptanceHistory({
        releaseSha,
        deployedAt,
        windowStartedAt,
        windowEndedAt,
        batches: [batch],
      }),
    ).toMatchObject({
      localReaderSearchResumeSuccessCount: 0,
      syntheticCanaryLocalReaderResumeSuccessCount: 0,
    });
  });

  it("emits only a strict aggregate allowlist and never forwards identifiers", () => {
    const canaries = [
      "PRIVATE_COURSE_CANARY",
      "PRIVATE_PROVIDER_CANARY",
      "https://private.example/private-path",
      "private-search-reference",
      "private-batch-reference",
      "private-request-reference",
      "private-task-reference",
      "private-workflow-reference",
      "private-database-reference",
    ];
    const history = aggregateCourseSupportAcceptanceHistory({
      releaseSha,
      deployedAt,
      windowStartedAt,
      windowEndedAt,
      batches: [],
    });
    const record = buildCourseSupportAcceptanceHistoryMachineRecord({
      outcome: "ready",
      acceptanceHistory: {
        ...history,
        courseId: canaries[0],
        providerFamilyKey: canaries[1],
        url: canaries[2],
        searchRef: canaries[3],
        batchRef: canaries[4],
        requestRef: canaries[5],
        taskRef: canaries[6],
        workflowRef: canaries[7],
        databaseRef: canaries[8],
      },
      failure: {
        failureDomain: "ENV",
        failureClass: "DATABASE_URL_MISSING",
        nested: canaries,
      },
    });
    const output = JSON.stringify(record);

    expect(record.recordType).toBe(
      COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_RECORD_TYPE,
    );
    for (const canary of canaries) {
      expect(output).not.toContain(canary);
    }
    expect(output).not.toContain(releaseSha);
    expect(output).not.toContain("providerFamilyKey");
    expect(output).not.toContain("courseId");
  });

  it("validates a bounded exact window without echoing unknown arguments", () => {
    const options = parseCourseSupportAcceptanceHistoryOptions([
      "--machine",
      "--release-sha",
      releaseSha,
      "--deployed-at",
      deployedAt.toISOString(),
      "--window-started-at",
      windowStartedAt.toISOString(),
      "--window-ended-at",
      windowEndedAt.toISOString(),
    ]);
    expect(options).toEqual({
      machine: true,
      releaseSha,
      deployedAt,
      windowStartedAt,
      windowEndedAt,
    });

    const unknownCanary =
      "--PRIVATE_PROVIDER_COURSE_URL_SEARCH_BATCH_REQUEST_TASK_WORKFLOW_DATABASE";
    try {
      parseCourseSupportAcceptanceHistoryOptions([unknownCanary]);
      throw new Error("Expected parser rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Unknown acceptance-history option.",
      );
      expect((error as Error).message).not.toContain(unknownCanary);
    }
  });

  it("requires one machine flag and canonical timestamps in a bounded window", () => {
    const validArgs = [
      "--release-sha",
      releaseSha,
      "--deployed-at",
      deployedAt.toISOString(),
      "--window-started-at",
      windowStartedAt.toISOString(),
      "--window-ended-at",
      windowEndedAt.toISOString(),
    ];

    expect(() => parseCourseSupportAcceptanceHistoryOptions(validArgs)).toThrow(
      "acceptance-history requires exactly one --machine flag.",
    );
    expect(() =>
      parseCourseSupportAcceptanceHistoryOptions([
        "--machine",
        "--machine",
        ...validArgs,
      ]),
    ).toThrow("acceptance-history requires exactly one --machine flag.");
    expect(() =>
      parseCourseSupportAcceptanceHistoryOptions([
        "--machine",
        ...validArgs.map((value) =>
          value === deployedAt.toISOString() ? "2026-08-31T12:00:00Z" : value,
        ),
      ]),
    ).toThrow("--deployed-at must be an exact canonical UTC ISO timestamp.");
    expect(() =>
      parseCourseSupportAcceptanceHistoryOptions([
        "--machine",
        ...validArgs.slice(0, -1),
        "2026-09-01T12:00:00.001Z",
      ]),
    ).toThrow(
      "The acceptance window must be positive and no longer than 24 hours.",
    );
  });
});

function completeEvidenceBatch(): CourseSupportAcceptanceHistoryBatch {
  const observedAt = new Date("2026-08-31T12:20:00.000Z");
  return {
    baseSha,
    completedAt: new Date("2026-08-31T12:30:00.000Z"),
    releaseSha,
    deployedAt,
    summary: {
      plannedPaths: ["src/lib/providers/reusable-support.ts"],
      releaseProvenance: {
        schemaVersion: 1,
        fromSha: baseSha,
        toSha: releaseSha,
        branch: "automation/course-support-self-healing",
        committedPaths: ["src/lib/providers/reusable-support.ts"],
        descendantVerified: true,
      },
      searchExecutionFence: {
        schemaVersion: 1,
        settled: true,
      },
      recheckDispatch: {
        attempted: true,
        dispatchKeyPersisted: true,
        dispatchedAt: "2026-08-31T12:10:00.000Z",
        dispatchCompletedAt: "2026-08-31T12:11:00.000Z",
        affectedSearchCount: 1,
        queuedCount: 1,
        queueFailureCount: 0,
        directStartCount: 0,
        detachedVerificationDispatchError: false,
        detachedVerificationAssignedStageOrchestrationGapCount: 0,
        detachedVerificationPendingCount: 0,
        detachedVerificationRerunNeeded: false,
        dispatchError: false,
        currentAffectedSearchCount: 1,
        healthySchedulerCount: 1,
        freshSearchCheckCount: 1,
        restoredCourseCount: 1,
        provenRunnableCourseCount: 1,
        affectedCourseSearchPairCount: 1,
        healthyCourseSearchPairCount: 1,
        schedulerHealthObservedAt: "2026-08-31T12:27:00.000Z",
        schedulerHealthComplete: true,
        courseOutcomeHealthComplete: true,
      },
      closeout: {
        orchestrationOnlyCount: 0,
        decisionBasis: {
          schemaVersion: 3,
          orchestrationOnlyCount: 0,
        },
        remediationAttempts: [
          {
            actionExecution: {
              schemaVersion: 1,
              action: "IMPLEMENT_REUSABLE_SUPPORT",
              state: "EXECUTED",
              reason: "STRICT_RUNTIME_RELEASE_DEPLOYMENT_PROOF",
            },
          },
        ],
      },
    },
    incidents: [
      {
        verificationRequests: [
          {
            status: "SUCCEEDED",
            outcome: "NO_MATCH",
            runtimeVersion: releaseSha,
            startedAt: new Date("2026-08-31T12:15:00.000Z"),
            completedAt: observedAt,
            evidence: {
              schemaVersion: 1,
              kind: "PROVIDER_VERIFICATION",
              providerExecution: true,
              releaseSha,
              runtimeVersion: releaseSha,
              observedAt: observedAt.toISOString(),
              outcome: "NO_MATCH",
              adapterKey: "LOCAL_READER:INTERNAL",
            },
          },
        ],
      },
    ],
    searchDispatches: [
      {
        searchRef: "1".repeat(64),
        scheduleVersion: 7,
        teeSearch: {
          syntheticMultiCycle: true,
          scheduleVersion: 8,
          alertGeneration: 3,
          lastCheckedAt: new Date("2026-08-31T12:26:00.000Z"),
          emailDeliveries: [
            {
              id: "delivery-1",
              alertGeneration: 3,
              kind: "MATCH",
              payload: {
                schemaVersion: 2,
                checkedAt: "2026-08-31T12:22:00.000Z",
                matchIds: ["private-match-id"],
                matchRefs: [
                  {
                    matchId: "private-match-id",
                    availabilityCycle: 7,
                  },
                ],
              },
              status: "SUPPRESSED",
              attemptCount: 1,
              lastError: DELIVERY_SYNTHETIC_MULTI_CYCLE_DRY_RUN,
              createdAt: new Date("2026-08-31T12:23:00.000Z"),
              updatedAt: new Date("2026-08-31T12:24:00.000Z"),
            },
          ],
          matches: [
            {
              id: "private-match-id",
              courseId: "private-course-id",
              availabilityCycle: 7,
              lastConfirmedAt: new Date("2026-08-31T12:12:00.000Z"),
            },
          ],
          localReaderJobs: [
            {
              courseId: "private-course-id",
              scheduleVersion: 7,
              resumeFromScheduleVersion: 7,
              resumeScheduleVersion: 8,
              claimedAt: new Date("2026-08-31T12:12:00.000Z"),
              completedAt: new Date("2026-08-31T12:16:00.000Z"),
              resultExpiresAt: new Date("2026-08-31T12:16:00.000Z"),
              readerVersion: "reader-v1",
            },
          ],
          probes: [
            {
              courseId: "private-course-id",
              outcome: "MATCH_FOUND",
              observedAt: new Date("2026-08-31T12:20:00.000Z"),
              runtimeVersion: releaseSha,
              rawSummary: {
                providerExecution: "LOCAL_BROWSER_READER",
                providerObservedAt: "2026-08-31T12:12:00.000Z",
              },
              automationRun: {
                kind: "SEARCH_CHECK",
                status: "COMPLETED",
                runtimeVersion: releaseSha,
                startedAt: new Date("2026-08-31T12:17:00.000Z"),
                completedAt: new Date("2026-08-31T12:25:00.000Z"),
                outcome: "success",
                audit: {
                  trigger: "workflow",
                  searchRef: "1".repeat(16),
                  outcome: "success",
                  scheduleVersion: 8,
                  checkedCourses: 1,
                  courseOutcomes: { MATCH_FOUND: 1 },
                },
              },
            },
          ],
        },
      },
    ],
  };
}

function retainedReleaseHistoryEntry(overrides: Record<string, unknown> = {}) {
  return {
    releaseSha,
    deployedAt: deployedAt.toISOString(),
    recheckDispatchKey: null,
    recheckDispatchStartedAt: null,
    recheckDispatchedAt: null,
    recheckDispatch: null,
    incidentVerifications: [],
    supersededBy: "c".repeat(40),
    supersededAt: "2026-08-31T12:40:00.000Z",
    ...overrides,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
