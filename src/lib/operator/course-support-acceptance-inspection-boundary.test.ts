import { Prisma, type ProbeOutcome } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

const globalMocks = vi.hoisted(() => ({ escapedRead: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get() {
    globalMocks.escapedRead();
    throw new Error("Inspection must use the supplied read client.");
  } }),
}));

import {
  createParkedCourseCampaignAttemptLedgerFingerprint,
  createParkedCourseCampaignAudit,
  inspectLatestParkedCourseCampaign,
  PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT,
  PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
  type ParkedCourseCampaignMember,
} from "@/lib/automation/course-support-campaign";
import { buildCourseSupportProviderSnapshotFingerprint } from "@/lib/automation/course-support-verification";
import { localReaderResultSchema } from "@/lib/local-reader/contracts";
import { ACCEPTANCE_READ_LIMITS, createBoundedAcceptanceReadClient } from "./course-support-acceptance-read-boundary";
import { loadCourseSupportAcceptanceReasons } from "./course-support-acceptance-reasons";
import { loadCourseSupportAcceptanceProjection } from "./course-support-acceptance";
import { loadOperatorCourseFleetCounts } from "./course-fleet";
import { createOperatorCourseSupportCampaignDependencies, loadOperatorCourseSupportCampaign } from "./course-support-campaign";
import { parseAcceptanceReadCost, type AcceptanceReadQueryCategory } from "./course-support-acceptance-read-cost";

const CAPTURED_AT = new Date("2026-08-20T12:00:00.000Z");
const PARKED_AT = new Date("2026-08-20T13:00:00.000Z");
const NOW = new Date("2026-08-20T14:00:00.000Z");
const SOURCE_SHA = "a".repeat(40);
type Row = Record<string, unknown>;
type Query = { where?: Row; select?: Row; orderBy?: Row | Row[]; distinct?: string[]; take?: number; skip?: number; by?: string[] };

describe("full native campaign inspection through the acceptance read boundary", () => {
  it("reads all 112 nonempty current-cycle histories before enforcing the finite operation cap", async () => {
    const fixture = campaignDatabase();
    const read = createBoundedAcceptanceReadClient(fixture.transaction);

    const result = await inspectLatestParkedCourseCampaign(read, { now: NOW, admissionRuntimeVersion: SOURCE_SHA });

    expect(result).toMatchObject({
      status: "RUNNING", totalCount: 112, readyCount: 112, terminalCount: 0,
      engineeringBlockerCount: 0, remainingGlobalParkedCount: 112,
    });
    assertCompleteReloads(fixture);
    expect(fixture.operationCount()).toBeGreaterThan(256);
    expect(fixture.operationCount()).toBeLessThan(ACCEPTANCE_READ_LIMITS.queryCount);
    const completedOperations = fixture.operationCount();
    for (let operation = completedOperations; operation < ACCEPTANCE_READ_LIMITS.queryCount; operation++) {
      await read.teeSearch.count();
    }
    await expect(read.teeSearch.count()).rejects.toThrow(/^EVIDENCE_BOUND_EXCEEDED$/);
    expect(fixture.operationCount()).toBe(ACCEPTANCE_READ_LIMITS.queryCount);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("retains 112 bounded LOCAL_READER readiness inspections without inventing campaign recovery", async () => {
    const fixture = campaignDatabase({ readerCandidates: true });
    const read = createBoundedAcceptanceReadClient(fixture.transaction);

    const result = await inspectLatestParkedCourseCampaign(read, { now: NOW, admissionRuntimeVersion: SOURCE_SHA });

    expect(result).toMatchObject({
      status: "RUNNING", totalCount: 112, readyCount: 0, terminalCount: 0,
      engineeringBlockerCount: 112, remainingGlobalParkedCount: 112,
    });
    assertCompleteReloads(fixture);
    expect(fixture.calls.filter((call) => call.model === "teeSearch" && call.method === "count")).toHaveLength(112);
    expect(fixture.calls.filter((call) => call.model === "localReaderAgent" && call.method === "findMany" &&
      (call.args as Query).select?.capabilities === true)).toHaveLength(112);
    expect(fixture.operationCount()).toBeGreaterThan(2_048);
    expect(fixture.operationCount()).toBeLessThan(ACCEPTANCE_READ_LIMITS.queryCount);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it.each([false, true])("completes the full diagnostic with the unchanged native projection for 112 members (reader=%s)", async (readerCandidates) => {
    const fixture = campaignDatabase({ readerCandidates });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

    expect(result).toMatchObject({ schemaVersion: 4, readFence: null, readCost: null, status: "AVAILABLE", reason: "COMPLETE_NATIVE_TRACE",
      observedAt: NOW.toISOString(), evidenceReadComplete: true, customerDataIncluded: false,
      futureUnknown: { reconciliation: "MATCH" }, rollingAmbiguous: { reconciliation: "MATCH" } });
    assertCompleteReloads(fixture);
    expect(fixture.operationCount()).toBeGreaterThan(256);
    expect(fixture.operationCount()).toBeLessThan(ACCEPTANCE_READ_LIMITS.queryCount);
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 30_000,
    });
    expect(fixture.transactionControls.mock.calls).toEqual([
      ["SET TRANSACTION READ ONLY"], ["SET LOCAL statement_timeout = '25000ms'"],
    ]);

    const native = campaignDatabase({ readerCandidates });
    const inspection = (await inspectLatestParkedCourseCampaign(native.transaction, { now: NOW, admissionRuntimeVersion: SOURCE_SHA }))!;
    const { runId, totalCount, ...observedCampaign } = inspection;
    expect(totalCount).toBe(112);
    const expected = await loadCourseSupportAcceptanceProjection({ now: NOW, observedCampaign }, {
      loadCourseFleetCounts: (input) => loadOperatorCourseFleetCounts(input, native.transaction),
      loadLatestCampaignRecord: () => native.transaction.automationRun.findFirst({
        where: { id: runId }, select: { id: true, status: true, audit: true, notes: true },
      }),
      loadFreshGlobalParkedCount: () => native.transaction.courseSupportIncident.count({
        where: { status: "NEEDS_HUMAN", humanReviewReason: "AUTOMATION_STALLED", activeBatchId: null, nextAttemptAt: null },
      }),
      loadCampaignSummary: (input) => loadOperatorCourseSupportCampaign(input,
        createOperatorCourseSupportCampaignDependencies(native.transaction, { now: NOW, admissionRuntimeVersion: SOURCE_SHA })),
    });
    expect(result.acceptanceProjection).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(native.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("identifies a real byte preflight bound before any native campaign projection is published", async () => {
    const fixture = campaignDatabase();
    fixture.byteRead.mockImplementationOnce(async () => [{ now: NOW }]);
    fixture.byteRead.mockImplementationOnce(async () => [{
      bytes: BigInt(ACCEPTANCE_READ_LIMITS.evidenceBytes + 1), matchedRows: 1n,
    }]);
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);
    expect(result).toMatchObject({ schemaVersion: 4, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: "CAMPAIGN_INSPECTION", boundary: "SELECTED_EVIDENCE_BYTES" },
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null,
      evidenceReadComplete: false, customerDataIncluded: false });
    assertObservedReadCost(result, "CAMPAIGN_RECORD");
    expect(result.readCost?.componentChargeBytes).toBe(2 * (ACCEPTANCE_READ_LIMITS.evidenceBytes + 1));
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("completes the actual native inspection when a large historical error column is outside every requested projection", async () => {
    const fixture = campaignDatabase({ oversizedUnselectedRunErrors: true });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);
    expect(result).toMatchObject({ schemaVersion: 4, status: "AVAILABLE", reason: "COMPLETE_NATIVE_TRACE",
      readFence: null, readCost: null, evidenceReadComplete: true, customerDataIncluded: false });
    assertCompleteReloads(fixture);
    const byteStatements = fixture.calls.filter((call) => call.model === "$queryRaw").map((call) => call.args as Prisma.Sql);
    expect(byteStatements.some((statement) => statement.text.includes('FROM "AutomationRun"'))).toBe(true);
    expect(byteStatements.every((statement) => !statement.text.includes('acceptance_row."errors"'))).toBe(true);
    expect(fixture.calls.filter((call) => call.model === "automationRun" && call.method !== "count")
      .every((call) => !(call.args as Query).select?.errors)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("keeps unused older batch evidence outside the full 112-member native inspection and projection", async () => {
    const fixture = campaignDatabase({ oversizedUnselectedOlderBatchEvidence: true });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

    expect(result).toMatchObject({ schemaVersion: 4, status: "AVAILABLE", reason: "COMPLETE_NATIVE_TRACE",
      readFence: null, readCost: null, evidenceReadComplete: true, customerDataIncluded: false,
      futureUnknown: { reconciliation: "MATCH" }, rollingAmbiguous: { reconciliation: "MATCH" } });
    assertCompleteReloads(fixture);
    const snapshots = fixture.calls.filter((call) => call.model === "courseSupportIncident" && call.method === "findMany" &&
      (call.args as Query).where?.humanReviewReason === "AUTOMATION_STALLED");
    expect(snapshots).not.toHaveLength(0);
    expect(snapshots.every((call) => !Object.hasOwn((call.args as Query).select!, "batchIncidents"))).toBe(true);
    const byteStatements = fixture.calls.filter((call) => call.model === "$queryRaw").map((call) => call.args as Prisma.Sql);
    expect(byteStatements.every((statement) => statement.values.every((value) =>
      typeof value !== "string" || !value.startsWith("private-older-")))).toBe(true);

    const native = campaignDatabase();
    const inspection = (await inspectLatestParkedCourseCampaign(native.transaction, { now: NOW, admissionRuntimeVersion: SOURCE_SHA }))!;
    const { runId, totalCount, ...observedCampaign } = inspection;
    expect(totalCount).toBe(112);
    expect(inspection).toMatchObject({ readyCount: 112, terminalCount: 0, engineeringBlockerCount: 0 });
    const expected = await loadCourseSupportAcceptanceProjection({ now: NOW, observedCampaign }, {
      loadCourseFleetCounts: (input) => loadOperatorCourseFleetCounts(input, native.transaction),
      loadLatestCampaignRecord: () => native.transaction.automationRun.findFirst({
        where: { id: runId }, select: { id: true, status: true, audit: true, notes: true },
      }),
      loadFreshGlobalParkedCount: () => native.transaction.courseSupportIncident.count({
        where: { status: "NEEDS_HUMAN", humanReviewReason: "AUTOMATION_STALLED", activeBatchId: null, nextAttemptAt: null },
      }),
      loadCampaignSummary: (input) => loadOperatorCourseSupportCampaign(input,
        createOperatorCourseSupportCampaignDependencies(native.transaction, { now: NOW, admissionRuntimeVersion: SOURCE_SHA })),
    });
    expect(result.acceptanceProjection).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(native.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("still rejects oversized required current-cycle proof after inspecting every member's exact history scope", async () => {
    const fixture = campaignDatabase({ oversizedCurrentCycleProof: true });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

    expect(result).toMatchObject({ schemaVersion: 4, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: "CAMPAIGN_INSPECTION", boundary: "SELECTED_EVIDENCE_BYTES" },
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null,
      evidenceReadComplete: false, customerDataIncluded: false });
    assertObservedReadCost(result, "CURRENT_CYCLE_HISTORY");
    const reloads = fixture.calls.filter((call) => call.model === "courseSupportIncident" && call.method === "findMany" &&
      typeof (call.args as Query).where?.id === "string" &&
      (call.args as Query).select?.batchIncidents);
    const identityReloads = reloads.filter((call) =>
      (((call.args as Query).select?.batchIncidents as Query).select?.proofSnapshot) !== true);
    expect(identityReloads).toHaveLength(112);
    expect(new Set(identityReloads.map((call) => (call.args as Query).where!.id)).size).toBe(112);
    expect(reloads.some((call) => (call.args as Query).where!.id === "private-incident-112" &&
      (((call.args as Query).select?.batchIncidents as Query).select?.proofSnapshot) === true)).toBe(false);
    const byteStatements = fixture.calls.filter((call) => call.model === "$queryRaw").map((call) => call.args as Prisma.Sql);
    expect(byteStatements.some((statement) => statement.text.includes('acceptance_row."proofSnapshot"') &&
      statement.values.includes("private-entry-112"))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("keeps oversized legacy-ineligible ledgers outside all 112 native observations and the complete projection", async () => {
    const fixture = campaignDatabase({ resolvedObservations: "MODERN", oversizedObservationLedger: true });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

    expect(result).toMatchObject({ schemaVersion: 4, status: "AVAILABLE", reason: "COMPLETE_NATIVE_TRACE",
      readFence: null, readCost: null, evidenceReadComplete: true, customerDataIncluded: false });
    const observationReads = fixture.calls.filter((call) => call.model === "courseSupportIncident" && call.method === "findMany" &&
      (call.args as Query).select?.monitoringEvents && (call.args as Query).select?.confirmedAt === true &&
      Array.isArray(((call.args as Query).where?.id as Row | undefined)?.in));
    expect(observationReads).toHaveLength(1);
    expect(observationReads.every((call) => !Object.hasOwn((call.args as Query).select!, "attemptLedger"))).toBe(true);
    expect(observationReads.every((call) => ((call.args as Query).where?.id as Row).in instanceof Array &&
      new Set(((call.args as Query).where!.id as Row).in as string[]).size === 112)).toBe(true);
    const byteStatements = fixture.calls.filter((call) => call.model === "$queryRaw").map((call) => call.args as Prisma.Sql);
    expect(byteStatements.some((statement) => statement.text.includes('FROM "CourseSupportIncident"'))).toBe(true);
    expect(byteStatements.every((statement) => !statement.text.includes('acceptance_row."attemptLedger"'))).toBe(true);

    const native = campaignDatabase({ resolvedObservations: "MODERN" });
    const inspection = (await inspectLatestParkedCourseCampaign(native.transaction, { now: NOW, admissionRuntimeVersion: SOURCE_SHA }))!;
    const { runId, totalCount, ...observedCampaign } = inspection;
    expect(totalCount).toBe(112);
    expect(inspection).toMatchObject({ terminalCount: 112, sourceUnverifiedCount: 112, pendingCount: 0,
      automaticWithin24HoursCount: 112, engineeringBlockerCount: 0 });
    const expected = await loadCourseSupportAcceptanceProjection({ now: NOW, observedCampaign }, {
      loadCourseFleetCounts: (input) => loadOperatorCourseFleetCounts(input, native.transaction),
      loadLatestCampaignRecord: () => native.transaction.automationRun.findFirst({
        where: { id: runId }, select: { id: true, status: true, audit: true, notes: true },
      }),
      loadFreshGlobalParkedCount: () => native.transaction.courseSupportIncident.count({
        where: { status: "NEEDS_HUMAN", humanReviewReason: "AUTOMATION_STALLED", activeBatchId: null, nextAttemptAt: null },
      }),
      loadCampaignSummary: (input) => loadOperatorCourseSupportCampaign(input,
        createOperatorCourseSupportCampaignDependencies(native.transaction, { now: NOW, admissionRuntimeVersion: SOURCE_SHA })),
    });
    expect(result.acceptanceProjection).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(native.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("fences the full required legacy ledger after all 112 observation bindings without hydrating it or issuing later reads", async () => {
    // Exact legacy event metadata admits this read; no accepted legacy proof is fabricated.
    const fixture = campaignDatabase({ resolvedObservations: "LEGACY_LAST", oversizedObservationLedger: true });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

    expect(result).toMatchObject({ schemaVersion: 4, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: "CAMPAIGN_INSPECTION", boundary: "SELECTED_EVIDENCE_BYTES" },
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null,
      evidenceReadComplete: false, customerDataIncluded: false });
    assertObservedReadCost(result, "LEGACY_TERMINAL_HISTORY");
    const observationReads = fixture.calls.filter((call) => call.model === "courseSupportIncident" && call.method === "findMany" &&
      (call.args as Query).select?.monitoringEvents && (call.args as Query).select?.confirmedAt === true &&
      Array.isArray(((call.args as Query).where?.id as Row | undefined)?.in));
    expect(observationReads).toHaveLength(1);
    expect(((observationReads[0].args as Query).where!.id as Row).in).toHaveLength(112);
    expect((observationReads[0].args as Query).select).not.toHaveProperty("attemptLedger");
    expect(fixture.calls.some((call) => call.model === "courseSupportIncident" && call.method === "findMany" &&
      (call.args as Query).select?.attemptLedger === true && (call.args as Query).select?.updatedAt === true)).toBe(false);
    const ledgerStatements = fixture.calls.filter((call) => call.model === "$queryRaw" &&
      (call.args as Prisma.Sql).text.includes('acceptance_row."attemptLedger"'));
    expect(ledgerStatements).toHaveLength(1);
    expect((ledgerStatements[0].args as Prisma.Sql).values).toContain("private-incident-112");
    expect((ledgerStatements[0].args as Prisma.Sql).values).not.toContain("private-incident-111");
    expect(fixture.calls.at(-1)).toBe(ledgerStatements[0]);
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("excludes discovery copy evidence from the actual fleet read without shrinking the native campaign or course scope", async () => {
    const fixture = campaignDatabase({ fleetOnlyEvidence: "DISCOVERY", oversizedFleetOnlyEvidence: true });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

    expect(result).toMatchObject({ schemaVersion: 4, status: "AVAILABLE", reason: "COMPLETE_NATIVE_TRACE",
      readFence: null, readCost: null, evidenceReadComplete: true, customerDataIncluded: false });
    assertCompleteReloads(fixture);
    const fleetReads = fixture.calls.filter((call) => call.model === "course" && call.method === "findMany" &&
      (call.args as Query).select?.isPublic === true);
    expect(fleetReads).toHaveLength(1);
    expect(fleetReads[0].args).not.toHaveProperty("where");
    expect(fleetReads[0].args).not.toHaveProperty("take");
    expect((fleetReads[0].args as Query).select).not.toHaveProperty("automationDiscoveries");
    const byteStatements = fixture.calls.filter((call) => call.model === "$queryRaw").map((call) => call.args as Prisma.Sql);
    expect(byteStatements.some((statement) => statement.text.includes('FROM "Course"') &&
      statement.text.includes('acceptance_row."bookingMetadata"') &&
      statement.values.includes("private-fleet-only-course") &&
      statement.values.includes("private-course-112"))).toBe(true);
    expect(byteStatements.every((statement) => !statement.text.includes('FROM "CourseAutomationDiscovery"'))).toBe(true);
    // Native campaign preflight may still count its required timestamp-only
    // discovery scopes; no discovery evidence or noncampaign row is hydrated.
    expect(fixture.calls.some((call) => call.model === "courseAutomationDiscovery" && call.method !== "count")).toBe(false);

    const native = campaignDatabase({ fleetOnlyEvidence: "DISCOVERY" });
    const expected = await nativeAcceptanceProjection(native);
    expect(result.acceptanceProjection).toEqual(expected);
    expect(expected.fleet).toMatchObject({ attention: { actionCount: 1, watchCount: 0, totalCount: 1 }, engineeringNeededCount: 0 });
    expect(await loadOperatorCourseFleetCounts({ now: NOW }, native.transaction)).toMatchObject({ action: 1, parked: 112, needsHuman: 1 });
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(native.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it.each([
    ["BOOKING_METADATA", "Course", "bookingMetadata"],
    ["LOCAL_READER_RESULT", "LocalReaderJob", "result"],
    ["PARKING_AUDIT", "CourseMonitoringEvent", "audit"],
  ] as const)("keeps required %s evidence inside the actual FLEET byte fence with no later database calls", async (fleetOnlyEvidence, model, field) => {
    const fixture = campaignDatabase({ fleetOnlyEvidence, oversizedFleetOnlyEvidence: true });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

    expect(result).toMatchObject({ schemaVersion: 4, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: "FLEET", boundary: "SELECTED_EVIDENCE_BYTES" },
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null,
      evidenceReadComplete: false, customerDataIncluded: false });
    assertObservedReadCost(result, fleetOnlyEvidence === "LOCAL_READER_RESULT" ? "READER_EVIDENCE" : "UNCLASSIFIED");
    assertCompleteReloads(fixture);
    const sizedRequired = fixture.calls.filter((call) => call.model === "$queryRaw" &&
      (call.args as Prisma.Sql).text.includes(`FROM "${model}"`) &&
      (call.args as Prisma.Sql).text.includes(`acceptance_row."${field}"`) &&
      (call.args as Prisma.Sql).values.some((value) => typeof value === "string" && value.startsWith("private-fleet-only-")));
    expect(sizedRequired).toHaveLength(1);
    expect(fixture.calls.at(-1)).toBe(sizedRequired[0]);
    if (fleetOnlyEvidence === "BOOKING_METADATA") {
      expect(fixture.calls.some((call) => call.model === "course" && call.method === "findMany" &&
        (call.args as Query).select?.isPublic === true)).toBe(false);
    } else {
      expect(fixture.calls.some((call) => call.model === "course" && call.method === "findMany" &&
        (call.args as Query).select?.isPublic === true)).toBe(true);
      const delegate = fleetOnlyEvidence === "LOCAL_READER_RESULT" ? "localReaderJob" : "courseMonitoringEvent";
      expect(fixture.calls.some((call) => call.model === delegate && call.method === "findMany" &&
        (call.args as Query).select?.[field] === true)).toBe(false);
    }
    const native = campaignDatabase({ fleetOnlyEvidence });
    const expected = await nativeAcceptanceProjection(native);
    expect(expected).not.toBeNull();
    const counts = await loadOperatorCourseFleetCounts({ now: NOW }, native.transaction);
    expect(counts).toMatchObject(fleetOnlyEvidence === "PARKING_AUDIT"
      ? { parked: 113, action: 0, working: 0 }
      : fleetOnlyEvidence === "LOCAL_READER_RESULT"
        ? { parked: 112, action: 0, working: 1 }
        : { parked: 112, action: 1, working: 0 });
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(native.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it.each(["LOCAL_READER_RESULT", "PARKING_AUDIT"] as const)(
    "fetches only selected %s fleet payloads and retains any later required history fence",
    async (fleetOnlyEvidence) => {
      const fixture = campaignDatabase({ fleetOnlyEvidence, unusedFleetHistoryCount: 200 });
      const native = campaignDatabase({ fleetOnlyEvidence });
      const counts = await loadOperatorCourseFleetCounts({ now: NOW }, createBoundedAcceptanceReadClient(fixture.transaction));
      expect(counts).toEqual(await loadOperatorCourseFleetCounts({ now: NOW }, native.transaction));
      expect(fixture.unusedFleetPayloadRead).not.toHaveBeenCalled();

      const diagnostic = campaignDatabase({ fleetOnlyEvidence, unusedFleetHistoryCount: 200 });
      const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(diagnostic.transaction)) };
      const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

      if (fleetOnlyEvidence === "LOCAL_READER_RESULT") {
        expect(result).toMatchObject({ schemaVersion: 4, status: "AVAILABLE", reason: "COMPLETE_NATIVE_TRACE",
          readFence: null, readCost: null, evidenceReadComplete: true, customerDataIncluded: false });
        expect(result.acceptanceProjection).toEqual(await nativeAcceptanceProjection(native));
        expect(diagnostic.unusedFleetPayloadRead).not.toHaveBeenCalled();
      } else {
        // These older audits are unused by fleet counts, but rolling acceptance
        // still requires the complete cycle history. Keep that later refusal.
        expect(result).toMatchObject({ schemaVersion: 4, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
          readFence: { phase: "ROLLING_ENDPOINTS", boundary: "SELECTED_EVIDENCE_BYTES" },
          acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null,
          evidenceReadComplete: false, customerDataIncluded: false });
        expect(diagnostic.unusedFleetPayloadRead).toHaveBeenCalled();
      }
      assertCompleteReloads(diagnostic);
      const model = fleetOnlyEvidence === "LOCAL_READER_RESULT" ? "LocalReaderJob" : "CourseMonitoringEvent";
      const payload = fleetOnlyEvidence === "LOCAL_READER_RESULT" ? "result" : "audit";
      const metadataBytes = fixture.byteTotals.filter(({ statement }) => statement.text.includes(`FROM "${model}"`) &&
        !statement.text.includes(`acceptance_row."${payload}"`) && statement.values.includes("private-fleet-only-history-199"));
      expect(metadataBytes).toHaveLength(1);
      expect(metadataBytes[0].matchedRows).toBe(BigInt(fleetOnlyEvidence === "LOCAL_READER_RESULT" ? 201 : 313));
      const fullPayloadReads = fixture.calls.filter((call) => call.model === model[0].toLowerCase() + model.slice(1) &&
        call.method === "findMany" && (call.args as Query).select?.[payload] === true);
      expect(fullPayloadReads).toHaveLength(1);
      const ids = ((fullPayloadReads[0].args as Query).where!.id as Row).in as string[];
      expect(ids).toHaveLength(fleetOnlyEvidence === "LOCAL_READER_RESULT" ? 1 : 117);
      expect(ids).not.toContain("private-fleet-only-history-199");
      expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
      expect(fixture.mutation).not.toHaveBeenCalled();
      expect(diagnostic.mutation).not.toHaveBeenCalled();
      expect(globalMocks.escapedRead).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("keeps all 112 members and 5,000 historical probe outcomes while excluding display messages (successful tie first=%s)", async (successfulProbeTieFirst) => {
    const fixture = campaignDatabase({ historicalProbeCount: 5_000, successfulProbeTieFirst });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

    expect(result).toMatchObject({ schemaVersion: 4, status: "AVAILABLE", reason: "COMPLETE_NATIVE_TRACE",
      readFence: null, readCost: null, evidenceReadComplete: true, customerDataIncluded: false });
    assertCompleteReloads(fixture);
    expect(fixture.probeMessageRead).not.toHaveBeenCalled();
    const nativeProbes = fixture.calls.filter((call) => call.model === "courseProbe" && call.method === "findMany" &&
      (call.args as Query).select?.outcome === true);
    expect(nativeProbes).toHaveLength(1);
    expect(nativeProbes[0].args).toEqual({
      where: { courseId: { in: expect.arrayContaining(["private-course-112", "private-probe-working", "private-probe-failed", "private-probe-tied", "private-probe-missing"]) } },
      orderBy: { observedAt: "desc" }, distinct: ["courseId"],
      select: { courseId: true, outcome: true, observedAt: true },
    });
    expect(((nativeProbes[0].args as Query).where!.courseId as Row).in).toHaveLength(116);
    const probeBytes = fixture.byteTotals.filter(({ statement }) => statement.text.includes('FROM "CourseProbe"'));
    expect(probeBytes).toHaveLength(1);
    expect(probeBytes[0].matchedRows).toBe(5_000n);
    expect(probeBytes[0].statement.text).toContain('acceptance_row."outcome"');
    expect(probeBytes[0].statement.text).toContain('acceptance_row."observedAt"');
    expect(probeBytes[0].statement.text).not.toContain('acceptance_row."message"');

    // The old selection is applied before the native call. This independent
    // baseline reads every historical message before in-memory distinct.
    const native = campaignDatabase({ historicalProbeCount: 5_000, successfulProbeTieFirst });
    const expected = await nativeAcceptanceProjection(native, legacyProbeMessageReader(native.transaction));
    expect(native.probeMessageRead).toHaveBeenCalledTimes(5_000);
    expect(result.acceptanceProjection).toEqual(expected);
    const counts = await loadOperatorCourseFleetCounts({ now: NOW }, fixture.transaction);
    expect(counts).toEqual({ action: successfulProbeTieFirst ? 1 : 2, watch: 0, parked: 112, limitations: 0,
      unchecked: 1, working: successfulProbeTieFirst ? 2 : 1, dueNow: 0, inProgress: 0,
      recoveryRequired: 0, scheduledRetry: 0, engineeringNeeded: 0, needsHuman: successfulProbeTieFirst ? 1 : 2 });
    expect(fixture.probeMessageRead).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(native.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("measures the omitted historical message charge through the unchanged bounded reader", async () => {
    const current = campaignDatabase({ historicalProbeCount: 5_000 });
    const legacy = campaignDatabase({ historicalProbeCount: 5_000 });
    const currentCounts = await loadOperatorCourseFleetCounts({ now: NOW }, createBoundedAcceptanceReadClient(current.transaction));
    const legacyCounts = await loadOperatorCourseFleetCounts({ now: NOW }, legacyProbeMessageReader(createBoundedAcceptanceReadClient(legacy.transaction)));

    expect(currentCounts).toEqual(legacyCounts);
    expect(current.probeMessageRead).not.toHaveBeenCalled();
    // SQL sizing and then native projection both read the old selected field.
    expect(legacy.probeMessageRead).toHaveBeenCalledTimes(10_000);
    const currentBytes = current.byteTotals.filter(({ statement }) => statement.text.includes('FROM "CourseProbe"'));
    const legacyBytes = legacy.byteTotals.filter(({ statement }) => statement.text.includes('FROM "CourseProbe"'));
    expect(currentBytes).toHaveLength(1);
    expect(legacyBytes).toHaveLength(1);
    expect(currentBytes[0].matchedRows).toBe(5_000n);
    expect(legacyBytes[0].matchedRows).toBe(5_000n);
    // Each 500-character ASCII message adds 513 serialized bytes and the
    // fixture's conservative 32-byte selected-value padding. The 2x margin
    // remains in the real guard; this is an offline fixture measurement.
    expect(legacyBytes[0].bytes - currentBytes[0].bytes).toBe(2_725_000n);
    expect(2n * (legacyBytes[0].bytes - currentBytes[0].bytes)).toBe(5_450_000n);
    const legacyQuery = legacy.calls.find((call) => call.model === "courseProbe" && call.method === "findMany" &&
      (call.args as Query).select?.message === true)!.args as Query;
    const currentQuery = current.calls.find((call) => call.model === "courseProbe" && call.method === "findMany" &&
      (call.args as Query).select?.outcome === true)!.args as Query;
    expect(legacyQuery).toEqual({ ...currentQuery, select: { ...currentQuery.select, message: true } });
    expect(current.mutation).not.toHaveBeenCalled();
    expect(legacy.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("still fences the full required historical probe outcome and clock charge under cumulative byte pressure", async () => {
    const fixture = campaignDatabase({ historicalProbeCount: 5_000, requiredProbeBudgetPressure: true });
    const database = { $transaction: vi.fn(async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(fixture.transaction)) };
    const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], SOURCE_SHA);

    expect(result).toMatchObject({ schemaVersion: 4, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: "FLEET", boundary: "SELECTED_EVIDENCE_BYTES" }, acceptanceProjection: null,
      futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false, customerDataIncluded: false });
    assertObservedReadCost(result, "UNCLASSIFIED");
    assertCompleteReloads(fixture);
    const required = fixture.byteTotals.filter(({ statement }) => statement.text.includes('FROM "CourseProbe"'));
    expect(required).toHaveLength(1);
    expect(required[0].matchedRows).toBe(5_000n);
    expect(required[0].statement.text).toContain('acceptance_row."outcome"');
    expect(required[0].statement.text).toContain('acceptance_row."observedAt"');
    expect(required[0].statement.text).not.toContain('acceptance_row."message"');
    expect(result.readCost?.componentChargeBytes).toBe(Number(2n * required[0].bytes));
    expect((fixture.calls.at(-1)!.args as Prisma.Sql)).toBe(required[0].statement);
    expect(fixture.calls.some((call) => call.model === "courseProbe" && call.method === "findMany" &&
      (call.args as Query).select?.outcome === true)).toBe(false);
    expect(fixture.probeMessageRead).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private-|https:\/\//u);
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });

  it("still rejects historical probe scopes beyond the existing row limit before identity or native hydration", async () => {
    const fixture = campaignDatabase({ historicalProbeCount: ACCEPTANCE_READ_LIMITS.evidenceRows + 1 });
    const read = createBoundedAcceptanceReadClient(fixture.transaction);

    await expect(loadOperatorCourseFleetCounts({ now: NOW }, read)).rejects.toMatchObject({
      reason: "EVIDENCE_BOUND_EXCEEDED", boundary: "TOP_LEVEL_ROWS", readCost: null,
    });
    const probeReads = fixture.calls.filter((call) => call.model === "courseProbe");
    expect(probeReads.map(({ method }) => method)).toEqual(["count"]);
    expect(fixture.byteTotals.every(({ statement }) => !statement.text.includes('FROM "CourseProbe"'))).toBe(true);
    expect(fixture.probeMessageRead).not.toHaveBeenCalled();
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(globalMocks.escapedRead).not.toHaveBeenCalled();
  });
});

async function nativeAcceptanceProjection(fixture: ReturnType<typeof campaignDatabase>, fleetRead = fixture.transaction) {
  const inspection = (await inspectLatestParkedCourseCampaign(fixture.transaction, { now: NOW, admissionRuntimeVersion: SOURCE_SHA }))!;
  const { runId, totalCount, ...observedCampaign } = inspection;
  expect(totalCount).toBe(112);
  expect(inspection).toMatchObject({ readyCount: 112, terminalCount: 0, engineeringBlockerCount: 0 });
  return loadCourseSupportAcceptanceProjection({ now: NOW, observedCampaign }, {
    loadCourseFleetCounts: (input) => loadOperatorCourseFleetCounts(input, fleetRead),
    loadLatestCampaignRecord: () => fixture.transaction.automationRun.findFirst({
      where: { id: runId }, select: { id: true, status: true, audit: true, notes: true },
    }),
    loadFreshGlobalParkedCount: () => fixture.transaction.courseSupportIncident.count({
      where: { status: "NEEDS_HUMAN", humanReviewReason: "AUTOMATION_STALLED", activeBatchId: null, nextAttemptAt: null },
    }),
    loadCampaignSummary: (input) => loadOperatorCourseSupportCampaign(input,
      createOperatorCourseSupportCampaignDependencies(fixture.transaction, { now: NOW, admissionRuntimeVersion: SOURCE_SHA })),
  });
}

function legacyProbeMessageReader(database: Prisma.TransactionClient): Prisma.TransactionClient {
  return new Proxy(database, { get(target, key) {
    if (key !== "courseProbe") return Reflect.get(target, key);
    return new Proxy(target.courseProbe, { get(delegate, method) {
      if (method !== "findMany") return Reflect.get(delegate, method);
      return (args: Query) => delegate.findMany({ ...args, select: { ...args.select, message: true } } as never);
    } });
  } });
}

function assertObservedReadCost(result: { readCost: unknown }, queryCategory: AcceptanceReadQueryCategory) {
  const readCost = parseAcceptanceReadCost(result.readCost);
  expect(readCost).not.toBeNull();
  expect(result.readCost).toEqual(readCost);
  expect(readCost).toMatchObject({ version: 1, queryCategory, component: "SELECTED_SCALARS",
    basis: "OBSERVED_CONSERVATIVE_LOWER_BOUND", complete: false,
    limitBytes: ACCEPTANCE_READ_LIMITS.evidenceBytes, saturated: false });
  expect(readCost!.attemptedCumulativeBytes).toBeGreaterThan(ACCEPTANCE_READ_LIMITS.evidenceBytes);
  expect(readCost!.hydrationObservedBytes).toBeGreaterThanOrEqual(readCost!.componentChargeBytes);
}

function assertCompleteReloads(fixture: ReturnType<typeof campaignDatabase>) {
  const reloads = fixture.calls.filter((call) => call.model === "courseSupportIncident" && call.method === "findMany" &&
    typeof (call.args as Query).where?.id === "string" &&
    (call.args as Query).select?.batchIncidents);
  expect(reloads).toHaveLength(224); // ID-only preflight and untouched native read for each member.
  const nativeReloads = reloads.filter((call) =>
    (((call.args as Query).select?.batchIncidents as Query).select?.proofSnapshot) === true);
  expect(nativeReloads).toHaveLength(112);
  expect(new Set(nativeReloads.map((call) => (call.args as Query).where!.id)).size).toBe(112);
  expect(nativeReloads.every((call) => (call.args as Query).take === 1)).toBe(true);
  expect(nativeReloads.every((call) => ((call.args as Query).select?.batchIncidents as Query).take === 21)).toBe(true);
  expect(reloads.filter((call) => !nativeReloads.includes(call)).every((call) =>
    ((call.args as Query).select?.batchIncidents as Query).take === undefined)).toBe(true);
}

function campaignDatabase(input: {
  readerCandidates?: boolean;
  oversizedUnselectedRunErrors?: boolean;
  oversizedUnselectedOlderBatchEvidence?: boolean;
  oversizedCurrentCycleProof?: boolean;
  resolvedObservations?: "MODERN" | "LEGACY_LAST";
  oversizedObservationLedger?: boolean;
  fleetOnlyEvidence?: "DISCOVERY" | "BOOKING_METADATA" | "LOCAL_READER_RESULT" | "PARKING_AUDIT";
  oversizedFleetOnlyEvidence?: boolean;
  historicalProbeCount?: number;
  successfulProbeTieFirst?: boolean;
  requiredProbeBudgetPressure?: boolean;
  unusedFleetHistoryCount?: number;
} = {}) {
  const rows = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, [] as Row[]]));
  const probeMessageRead = vi.fn(() => "x".repeat(500));
  const unusedFleetPayloadRead = vi.fn((oversized: boolean) => ({
    privateUnusedHistory: "x".repeat(oversized ? ACCEPTANCE_READ_LIMITS.evidenceBytes + 1 : 512),
  }));
  const members: ParkedCourseCampaignMember[] = [];
  const cycle = input.readerCandidates ? 4 : 3;
  for (let ordinal = 1; ordinal <= PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT; ordinal++) {
    const courseId = `private-course-${ordinal}`;
    const incidentId = `private-incident-${ordinal}`;
    const ledger = input.readerCandidates ? readerStageLedger(cycle) : null;
    const course: Row = {
      id: courseId, name: "Private Course", timeZone: "America/New_York", isPublic: true,
      website: input.readerCandidates ? "https://private.cps.golf/" : null,
      detectedBookingUrl: input.readerCandidates ? "https://private.cps.golf/onlineresweb/search-teetime" : null,
      detectedPlatform: "UNKNOWN", providerFamilyKey: input.readerCandidates ? "CPS" : "SOURCE_MISSING",
      bookingMethod: input.readerCandidates ? "PUBLIC_ONLINE" : "UNKNOWN", bookingWindowDaysAhead: null,
      bookingReleaseTimeLocal: null, bookingWindowSource: null, bookingWindowConfidence: null,
      bookingWindowEvidenceUrl: null, automationEligibility: input.readerCandidates ? "ALLOWED" : "UNKNOWN",
      automationReason: "NONE", monitoringMode: "STANDARD", bookingAccessMode: input.readerCandidates ? "PUBLIC_SIGNED_OUT" : "UNKNOWN",
      intelligenceVerifiedAt: null, intelligenceReviewAt: null, intelligenceConfidence: null,
      bookingMetadata: null, layoutHoleCounts: [], layoutHolesVerifiedAt: null,
      preferences: [], probes: [], automationDiscoveries: [], localReaderJobs: [],
    };
    const status: Row = { courseId, course, state: "ENGINEERING_VERIFICATION_NEEDED", stateChangedAt: PARKED_AT,
      revision: 11, failureFingerprint: "SOURCE:MISSING", nextAutomaticAttemptAt: null, revalidationRequestedAt: null,
      reference: `private-status-${ordinal}`, lastSuccessfulAt: null, lastFailureAt: PARKED_AT };
    course.monitoringStatus = status;
    const incident: Row = {
      id: incidentId, courseId, course, cycle, revision: 7, kind: "NEEDS_ADAPTER", providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE", failureFingerprint: "SOURCE:MISSING", attemptLedger: ledger,
      humanReviewReason: "AUTOMATION_STALLED", status: "NEEDS_HUMAN", activeRealSearchCount: 0,
      activeBatchId: null, nextAttemptAt: null, escalatedAt: PARKED_AT, attemptCount: 1,
      confirmedAt: CAPTURED_AT, firstSeenAt: CAPTURED_AT, lastSeenAt: PARKED_AT, resolution: null, resolvedAt: null,
      engineeringOnly: false, latestMessage: null, nextAction: null, escalationDeadlineAt: null, activeBatch: null,
      resolutionMessage: null, resolutionNotifiedAt: null, decisionActorId: null, decisionAt: null,
      decisionNote: null, decisionEvidenceUrl: null, decisionIdempotencyKey: null,
      updatedAt: PARKED_AT,
    };
    course.supportIncident = incident;
    const event: Row = {
      id: `private-event-${ordinal}`, incidentId, courseId, incident, course,
      eventType: "HUMAN_REVIEW_REQUESTED", source: "RECOVERY_CRON", fromState: "AUTO_INVESTIGATING",
      toState: "ENGINEERING_VERIFICATION_NEEDED", occurredAt: PARKED_AT, outcome: "NEEDS_ADAPTER",
      runtimeVersion: SOURCE_SHA, deploymentSha: SOURCE_SHA, operatorActorId: null,
      failureFingerprint: "SOURCE:MISSING", readPath: "OFFICIAL_IDENTITY",
      audit: { cycle, customerState: "NEEDS_HUMAN_REVIEW", automationStalled: true,
        parkedUntilMaterialChange: true, playbookExhausted: false },
    };
    const ownerRun: Row = { id: `private-owner-${ordinal}`, promptVersion: "private-owner-v1", kind: "COURSE_SUPPORT",
      status: "FAILED", runtimeVersion: SOURCE_SHA, completedAt: PARKED_AT, outcome: "retryable_failed", notes: null };
    const batch: Row = {
      id: `private-batch-${ordinal}`, status: "RETRYABLE_FAILED", revision: 1,
      ownerAutomationRunId: ownerRun.id, ownerAutomationRun: ownerRun, baseSha: SOURCE_SHA,
      releaseSha: null, deployedAt: null, createdAt: CAPTURED_AT, updatedAt: PARKED_AT,
      recheckDispatchKey: null, recheckDispatchStartedAt: null, recheckDispatchedAt: null,
      completedAt: PARKED_AT, summary: null, activeIncidents: [],
    };
    const entry: Row = { id: `private-entry-${ordinal}`, batchId: batch.id, incidentId, courseId, cycle,
      result: "PENDING", preProbeId: null, postProbeId: null,
      proofSnapshot: input.oversizedCurrentCycleProof && ordinal === PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT
        ? { privateEvidence: "x".repeat(ACCEPTANCE_READ_LIMITS.evidenceBytes + 1) } : null,
      verifiedIncidentUpdatedAt: null, verifiedAt: null, createdAt: CAPTURED_AT, updatedAt: PARKED_AT,
      batch, incident, course };
    const request: Row = { id: `private-request-${ordinal}`, batchIncidentId: entry.id, batchIncident: entry, courseId,
      course, releaseSha: SOURCE_SHA, targetDateLocal: "2026-08-21", players: 1,
      providerSnapshotFingerprint: "b".repeat(64), providerSnapshotAt: CAPTURED_AT,
      discoveryAttemptedAt: null, discoveryVerifiedAt: null, createdAt: CAPTURED_AT, updatedAt: PARKED_AT,
      status: "QUEUED", revision: 0, attemptCount: 0, workflowRunId: null, startedAt: null,
      outcome: null, failureClass: null, evidence: null, lastError: null };
    incident.monitoringEvents = [event];
    incident.batchIncidents = [entry];
    batch.incidents = [entry];
    ownerRun.supportBatches = [batch];
    entry.verificationRequests = [request];
    for (const [model, value] of [["Course", course], ["CourseSupportIncident", incident], ["CourseMonitoringStatus", status],
      ["CourseMonitoringEvent", event], ["CourseSupportBatch", batch], ["CourseSupportBatchIncident", entry],
      ["CourseSupportVerificationRequest", request], ["AutomationRun", ownerRun]] as const) rows.get(model)!.push(value);
    if (input.oversizedUnselectedOlderBatchEvidence && ordinal === 1) {
      const privateEvidence = "x".repeat(ACCEPTANCE_READ_LIMITS.evidenceBytes + 1);
      const olderAt = new Date(CAPTURED_AT.getTime() - 60_000);
      const olderOwner: Row = { ...ownerRun, id: "private-older-owner", completedAt: olderAt,
        notes: privateEvidence };
      const olderBatch: Row = { ...batch, id: "private-older-batch", ownerAutomationRunId: olderOwner.id,
        ownerAutomationRun: olderOwner, createdAt: olderAt, updatedAt: olderAt, completedAt: olderAt,
        summary: { privateEvidence } };
      const olderEntry: Row = { ...entry, id: "private-older-entry", batchId: olderBatch.id,
        cycle: cycle - 1, createdAt: olderAt, updatedAt: olderAt, batch: olderBatch,
        proofSnapshot: { privateEvidence } };
      const olderRequest: Row = { ...request, id: "private-older-request", batchIncidentId: olderEntry.id,
        batchIncident: olderEntry, createdAt: olderAt, updatedAt: olderAt, providerSnapshotAt: olderAt,
        evidence: { privateEvidence }, lastError: privateEvidence };
      incident.batchIncidents = [entry, olderEntry];
      olderEntry.verificationRequests = [olderRequest];
      olderBatch.incidents = [olderEntry];
      olderOwner.supportBatches = [olderBatch];
      for (const [model, value] of [["CourseSupportBatch", olderBatch], ["CourseSupportBatchIncident", olderEntry],
        ["CourseSupportVerificationRequest", olderRequest], ["AutomationRun", olderOwner]] as const) rows.get(model)!.push(value);
    }
    members.push({ courseId, incidentId, cycle: 3, revision: 7, monitoringRevision: 11,
      monitoringFailureFingerprint: "SOURCE:MISSING", kind: "NEEDS_ADAPTER", providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE", failureFingerprint: "SOURCE:MISSING",
      providerSnapshotFingerprint: buildCourseSupportProviderSnapshotFingerprint(course as never),
      attemptLedgerFingerprint: createParkedCourseCampaignAttemptLedgerFingerprint(null),
      playbookConclusion: "INCOMPLETE", latestProbeAt: null, latestDiscoveryAt: null });
  }
  if (input.readerCandidates) rows.get("LocalReaderAgent")!.push({ id: "private-agent", deviceId: "private-device",
    readerVersion: "fixture-reader-v1", buildId: "fixture-build", capabilities: [{ key: "OFFICIAL_SOURCE_RENDERED", parserVersion: 1 }],
    lastSeenAt: NOW });
  const audit = createParkedCourseCampaignAudit({ expectedCount: 112, capturedAt: CAPTURED_AT, members });
  if (input.resolvedObservations) {
    const confirmedAt = new Date(CAPTURED_AT.getTime() + 60_000);
    const unusedLedger = input.oversizedObservationLedger
      ? { version: 1, events: [], privateEvidence: "x".repeat(ACCEPTANCE_READ_LIMITS.evidenceBytes + 1) } : null;
    for (const [index, incident] of rows.get("CourseSupportIncident")!.entries()) {
      const course = incident.course as Row;
      const status = course.monitoringStatus as Row;
      Object.assign(incident, { cycle: 4, status: "RESOLVED", humanReviewReason: null,
        confirmedAt, resolvedAt: PARKED_AT, resolution: "SOURCE_UNVERIFIED", attemptLedger: unusedLedger });
      Object.assign(status, { state: "FINAL_TECHNICAL", stateChangedAt: PARKED_AT });
      const event = (incident.monitoringEvents as Row[])[0];
      Object.assign(event, { eventType: "STATE_CHANGED", source: "COURSE_SUPPORT_RESPONDER",
        fromState: "AUTO_INVESTIGATING", toState: "FINAL_TECHNICAL", outcome: "SOURCE_UNVERIFIED",
        audit: { cycle: 4, confirmedAt: confirmedAt.toISOString(), automatedFinal: true,
          customerDataIncluded: false, finalKind: "source_unverified",
          ...(input.resolvedObservations === "LEGACY_LAST" && index === 111 ? {} : { freshRuntimeProof: true }),
          campaign: { kind: "PARKED_COHORT", runId: "private-campaign", membershipDigest: audit.membershipDigest, cycle: 4 } } });
    }
  }
  rows.get("AutomationRun")!.push({ id: "private-campaign", promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
    status: "RUNNING", completedAt: null, outcome: null, audit, notes: null, startedAt: CAPTURED_AT, supportBatches: [],
    errors: input.oversizedUnselectedRunErrors ? { message: `private-${"x".repeat(ACCEPTANCE_READ_LIMITS.evidenceBytes + 1)}` } : null });
  if (input.fleetOnlyEvidence) {
    const privateEvidence = input.oversizedFleetOnlyEvidence ? "x".repeat(ACCEPTANCE_READ_LIMITS.evidenceBytes + 1) : "bounded fixture";
    // This course is outside the immutable campaign but inside the complete
    // fleet and demand scopes; campaign members and their evidence are retained.
    const course: Row = { ...rows.get("Course")![0], id: "private-fleet-only-course", name: "Private Fleet-only Course",
      preferences: [], probes: [], automationDiscoveries: [], localReaderJobs: [], monitoringStatus: null, supportIncident: null };
    rows.get("Course")!.push(course);
    if (input.fleetOnlyEvidence !== "PARKING_AUDIT") {
      const search: Row = { id: "private-fleet-only-search", status: "ACTIVE", trafficClass: "PUBLIC", syntheticMultiCycle: false };
      const preference: Row = { id: "private-fleet-only-preference", courseId: course.id, course, teeSearchId: search.id,
        teeSearch: search, rank: 1 };
      course.preferences = [preference];
      search.preferences = [preference];
      rows.get("TeeSearch")!.push(search);
      rows.get("CoursePreference")!.push(preference);
    }
    if (input.fleetOnlyEvidence === "DISCOVERY") {
      const discovery: Row = { id: "private-fleet-only-discovery", courseId: course.id, course, status: "VERIFIED",
        detectedPlatform: "UNKNOWN", bookingMethod: "UNKNOWN", automationEligibility: "UNKNOWN", automationReason: "NONE",
        bookingAccessMode: "UNKNOWN", bookingUrl: null, confidence: 0.8, createdAt: PARKED_AT,
        evidence: { privateEvidence } };
      course.automationDiscoveries = [discovery];
      rows.get("CourseAutomationDiscovery")!.push(discovery);
    } else if (input.fleetOnlyEvidence === "BOOKING_METADATA") {
      course.bookingMetadata = { privateEvidence };
    } else if (input.fleetOnlyEvidence === "LOCAL_READER_RESULT") {
      const result = { jobId: "private-fleet-only-reader", courseKey: "cps:private.cps.golf", status: "NO_AVAILABILITY",
        observedAt: PARKED_AT.toISOString(), pageUrl: "https://private.cps.golf/onlineresweb/search-teetime",
        pageTitle: "Private fixture", slots: [], readerVersion: "fixture-reader-v1",
        ...(input.oversizedFleetOnlyEvidence ? { privateEvidence } : {}) };
      expect(localReaderResultSchema.safeParse(result).success).toBe(!input.oversizedFleetOnlyEvidence);
      const job: Row = { id: "private-fleet-only-reader", courseId: course.id, course, status: "COMPLETED", completedAt: PARKED_AT,
        updatedAt: PARKED_AT, result };
      const status: Row = { ...rows.get("CourseMonitoringStatus")![0], courseId: course.id, course,
        reference: "private-fleet-only-status", state: "HEALTHY", lastSuccessfulAt: null, lastFailureAt: null };
      course.localReaderJobs = [job];
      course.monitoringStatus = status;
      rows.get("LocalReaderJob")!.push(job);
      rows.get("CourseMonitoringStatus")!.push(status);
    } else {
      // Historical decision metadata makes this incident ineligible for the
      // initial global campaign snapshot. Fleet parking classification does not
      // omit such an incident: it still requires its exact durable event audit.
      const incident: Row = { ...rows.get("CourseSupportIncident")![0], id: "private-fleet-only-incident",
        courseId: course.id, course, decisionNote: "Retained historical context", batchIncidents: [] };
      const status: Row = { ...rows.get("CourseMonitoringStatus")![0], courseId: course.id, course,
        reference: "private-fleet-only-status" };
      const event: Row = { ...rows.get("CourseMonitoringEvent")![0], id: "private-fleet-only-event", courseId: course.id,
        course, incidentId: incident.id, incident, audit: { ...rows.get("CourseMonitoringEvent")![0].audit as Row, privateEvidence } };
      incident.monitoringEvents = [event];
      course.supportIncident = incident;
      course.monitoringStatus = status;
      rows.get("CourseSupportIncident")!.push(incident);
      rows.get("CourseMonitoringStatus")!.push(status);
      rows.get("CourseMonitoringEvent")!.push(event);
    }
    if (input.unusedFleetHistoryCount) {
      const reader = input.fleetOnlyEvidence === "LOCAL_READER_RESULT";
      const model = reader ? "LocalReaderJob" : "CourseMonitoringEvent";
      const selected = (reader ? course.localReaderJobs : (course.supportIncident as Row).monitoringEvents) as Row[];
      const current = selected[0];
      for (let index = 0; index < input.unusedFleetHistoryCount; index++) {
        const clock = new Date(PARKED_AT.getTime() - (index + 1) * 60_000);
        const older = { ...current, id: `private-fleet-only-history-${index}`, completedAt: clock, updatedAt: clock, occurredAt: clock };
        // Parking retains its five native winners; only sixth-and-older audits
        // are unused. Reader retains exactly its single native winner.
        if (reader || index >= 4) Object.defineProperty(older, reader ? "result" : "audit", {
          enumerable: true, get: () => unusedFleetPayloadRead(index === input.unusedFleetHistoryCount! - 1),
        });
        selected.push(older);
        rows.get(model)!.push(older);
      }
    }
  }
  if (input.historicalProbeCount) {
    const probeCourses = ["working", "failed", "tied", "missing"].map((kind) => {
      const course: Row = { ...rows.get("Course")![0], id: `private-probe-${kind}`, name: "Private Probe Course",
        detectedPlatform: "FOREUP", providerFamilyKey: "FOREUP", bookingMethod: "PUBLIC_ONLINE",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
        automationEligibility: "ALLOWED", bookingAccessMode: "PUBLIC_SIGNED_OUT",
        bookingMetadata: { scheduleId: 6654, bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
          ...(kind === "missing" && input.requiredProbeBudgetPressure ? { retainedEvidence: "x".repeat(6_400_000) } : {}) },
        preferences: [], probes: [], automationDiscoveries: [], localReaderJobs: [], monitoringStatus: null, supportIncident: null };
      const search: Row = { id: `private-probe-search-${kind}`, status: "ACTIVE", trafficClass: "PUBLIC", syntheticMultiCycle: false };
      const preference: Row = { id: `private-probe-preference-${kind}`, courseId: course.id, course, teeSearchId: search.id,
        teeSearch: search, rank: 1 };
      course.preferences = [preference];
      search.preferences = [preference];
      rows.get("Course")!.push(course);
      rows.get("TeeSearch")!.push(search);
      rows.get("CoursePreference")!.push(preference);
      return course;
    });
    for (let index = 0; index < input.historicalProbeCount; index++) {
      const latest = index < 4;
      const course = probeCourses[index === 0 ? 0 : index === 1 ? 1 : index < 4 ? 2 : index % 3];
      const observedAt = new Date(latest ? NOW.getTime() - (index < 2 ? index + 1 : 3) * 60_000
        : CAPTURED_AT.getTime() - (index + 1) * 60_000);
      const outcome = index === 0 ? "NO_MATCH" : index === 1 ? "FETCH_FAILED"
        : index < 4 ? (index === 2) === Boolean(input.successfulProbeTieFirst) ? "NO_MATCH" : "FETCH_FAILED"
          : (["NO_MATCH", "FETCH_FAILED", "NEEDS_ADAPTER", "BLOCKED_AUTH"] satisfies ProbeOutcome[])[index % 4];
      const probe: Row = { id: `private-history-probe-${index}`, courseId: course.id, course,
        teeSearchId: (course.preferences as Row[])[0].teeSearchId, outcome, observedAt, evidenceUrl: null };
      Object.defineProperty(probe, "message", { enumerable: true, get: probeMessageRead });
      (course.probes as Row[]).push(probe);
      rows.get("CourseProbe")!.push(probe);
    }
  }
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
  const byteTotals: Array<{ statement: Prisma.Sql; bytes: bigint; matchedRows: bigint }> = [];
  const mutation = vi.fn(() => { throw new Error("Read-only inspection cannot mutate."); });
  const transaction = Object.fromEntries(Prisma.dmmf.datamodel.models.map((model) => {
    const name = model.name[0].toLowerCase() + model.name.slice(1);
    const invoke = (method: string, args: Query = {}) => {
      calls.push({ model: name, method, args });
      const selected = selectedRows(rows.get(model.name)!, args);
      if (method === "count") return selected.length;
      if (method === "groupBy") {
        const fields = args.by!;
        const groups = new Map<string, { identity: Row; count: number }>();
        for (const row of selected) {
          const identity = Object.fromEntries(fields.map((field) => [field, row[field]]));
          const key = JSON.stringify(identity);
          const existing = groups.get(key);
          groups.set(key, { identity, count: (existing?.count ?? 0) + 1 });
        }
        return [...groups.values()].map(({ identity, count }) => ({ ...identity, _count: { _all: count } }));
      }
      // The pinned Prisma compiler projects fetched historical scalars before
      // applying this ordered query's in-memory distinct reduction.
      const result = model.name === "CourseProbe" && method === "findMany"
        ? selectedRows(selectedRows(rows.get(model.name)!, { ...args, distinct: undefined, take: undefined, skip: undefined })
          .map((row) => projection(row, args.select)), { distinct: args.distinct, take: args.take, skip: args.skip })
        : selected.map((row) => projection(row, args.select));
      return method === "findMany" ? result : result[0] ?? null;
    };
    return [name, { count: vi.fn(async (args) => invoke("count", args)), groupBy: vi.fn(async (args) => invoke("groupBy", args)),
      findMany: vi.fn(async (args) => invoke("findMany", args)), findFirst: vi.fn(async (args) => invoke("findFirst", args)),
      findUnique: vi.fn(async (args) => invoke("findUnique", args)), create: mutation, update: mutation, updateMany: mutation }];
  })) as Row;
  const byteRead = vi.fn(async (query: Prisma.Sql | TemplateStringsArray) => {
    if (Array.isArray(query)) {
      if (query.length !== 1 || query[0] !== "SELECT transaction_timestamp() AS now") throw new Error("Unexpected clock query.");
      return [{ now: NOW }];
    }
    const statement = query as Prisma.Sql;
    calls.push({ model: "$queryRaw", method: "bytes", args: statement });
    const name = statement.text.match(/FROM "([A-Za-z0-9_]+)" AS acceptance_row/u)?.[1];
    const id = statement.text.match(/acceptance_row\."([A-Za-z0-9_]+)"::text = acceptance_weight\.identity/u)?.[1];
    const metadata = Prisma.dmmf.datamodel.models.find((model) => model.name === name);
    if (!name || !id || !metadata || statement.text.includes("private-") ||
        !statement.text.includes("SUM((octet_length") || !statement.text.includes("* acceptance_weight.occurrences")) {
      throw new Error("Fixture accepts only parameterized byte SELECTs.");
    }
    const identityValues = statement.text.match(/JOIN \(VALUES\s*([\s\S]+?)\) AS acceptance_weight\(identity, occurrences\)/u)?.[1];
    const selectedFields = [...statement.text.matchAll(/\$(\d+)::text,\s*acceptance_row\."([A-Za-z0-9_]+)"/gu)]
      .map((match) => {
        const key = statement.values[Number(match[1]) - 1];
        if (typeof key !== "string") throw new Error("Fixture requires bound Prisma field names.");
        return { key, column: match[2] };
      });
    const emptyScalarProjection = selectedFields.length === 0 && statement.text.includes("'{}'::jsonb::text");
    if (!identityValues || (!emptyScalarProjection && !statement.text.includes("jsonb_build_object")) ||
        selectedFields.some(({ key, column }) => typeof key !== "string" ||
          !metadata.fields.some((field) => field.kind !== "object" && field.name === key && field.name === column))) {
      throw new Error("Fixture requires generated selected fields and a parameterized identity scope.");
    }
    const weightPairPattern = /\(\$(\d+)::text,\s*\$(\d+)::bigint\)/gu;
    const weightPairs = [...identityValues.matchAll(weightPairPattern)];
    if (identityValues.replace(weightPairPattern, "").replaceAll(",", "").trim()) {
      throw new Error("Fixture requires a complete parameterized VALUES scope.");
    }
    const weights = new Map(weightPairs.map((match) => {
      const identity = statement.values[Number(match[1]) - 1];
      const occurrences = Number(statement.values[Number(match[2]) - 1]);
      if (typeof identity !== "string" || !Number.isSafeInteger(occurrences) || occurrences < 1) {
        throw new Error("Fixture requires parameterized identities and positive occurrence weights.");
      }
      return [identity, occurrences] as const;
    }));
    if (weights.size === 0 || weights.size !== weightPairs.length) {
      throw new Error("Fixture requires distinct nonempty weighted identities.");
    }
    const selected = rows.get(name)!.filter((row) => weights.has(row[id] as string));
    const bytes = selected.reduce((total, row) => {
      const scalarProjection = Object.fromEntries(selectedFields.map(({ key, column }) => [key, row[column] ?? null]));
      // This in-memory SQL fixture overestimates typed padding. Real PostgreSQL
      // tests separately prove the generated SQL and its encoding upper bound.
      const padding = selectedFields.reduce((sum, { key }) =>
        sum + 32 * (Array.isArray(scalarProjection[key]) ? (scalarProjection[key] as unknown[]).length : 1), 0);
      return total + (Buffer.byteLength(JSON.stringify(scalarProjection), "utf8") + padding) * weights.get(row[id] as string)!;
    }, 0);
    const total = { bytes: BigInt(bytes), matchedRows: BigInt(selected.length) };
    byteTotals.push({ statement, ...total });
    return [total];
  });
  transaction.$queryRaw = byteRead;
  const transactionControls = vi.fn(async (command: string) => {
    if (!["SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '25000ms'"].includes(command)) return mutation();
    return 0;
  });
  transaction.$executeRawUnsafe = transactionControls;
  return { transaction: transaction as unknown as Prisma.TransactionClient, calls, mutation,
    transactionControls, byteRead, byteTotals, probeMessageRead, unusedFleetPayloadRead, operationCount: () => calls.length };
}

function selectedRows(rows: readonly Row[], query: Query): Row[] {
  let selected = rows.filter((row) => matches(row, query.where));
  const order = query.orderBy ? Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy] : [];
  selected.sort((left, right) => {
    for (const term of order) {
      for (const [key, direction] of Object.entries(term)) {
        const leftValue = left[key] instanceof Date ? (left[key] as Date).getTime() : left[key];
        const rightValue = right[key] instanceof Date ? (right[key] as Date).getTime() : right[key];
        if (typeof direction === "object") continue;
        const comparison = leftValue === rightValue ? 0 : (leftValue as string | number) < (rightValue as string | number) ? -1 : 1;
        if (comparison !== 0) return direction === "desc" ? -comparison : comparison;
      }
    }
    return 0;
  });
  if (query.distinct) {
    const seen = new Set<string>();
    selected = selected.filter((row) => {
      const key = JSON.stringify(query.distinct!.map((field) => row[field]));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (query.skip) selected = selected.slice(query.skip);
  if (query.take !== undefined) selected = selected.slice(0, query.take);
  return selected;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND" || key === "OR") {
      const conditions = Array.isArray(expected) ? expected : [expected];
      return key === "AND" ? conditions.every((condition) => matches(row, condition as Row))
        : conditions.some((condition) => matches(row, condition as Row));
    }
    const actual = row[key];
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected === null || typeof expected !== "object") return actual === expected;
    const condition = expected as Row;
    if ("is" in condition) return condition.is === null ? actual === null : Boolean(actual && matches(actual as Row, condition.is as Row));
    if ("some" in condition || "none" in condition) {
      if (!Array.isArray(actual)) throw new Error(`Fixture list missing: ${key}`);
      const found = (actual as Row[]).some((value) => matches(value, (condition.some ?? condition.none) as Row));
      return "some" in condition ? found : !found;
    }
    if ("in" in condition) return (condition.in as unknown[]).includes(actual);
    if ("notIn" in condition) return !(condition.notIn as unknown[]).includes(actual);
    if ("not" in condition) return actual !== condition.not;
    if ("gte" in condition || "lte" in condition) return (condition.gte === undefined || (actual as Date) >= (condition.gte as Date)) &&
      (condition.lte === undefined || (actual as Date) <= (condition.lte as Date));
    return Boolean(actual && matches(actual as Row, condition));
  });
}

function projection(row: Row, select?: Row): Row {
  if (!select) return row;
  return Object.fromEntries(Object.entries(select).filter(([, selected]) => selected !== false).map(([key, selected]) => {
    if (key === "_count") return [key, Object.fromEntries(Object.keys((selected as Query).select!).map((field) => [field, (row[field] as unknown[]).length]))];
    const value = row[key];
    if (typeof selected !== "object") return [key, value];
    if (value === null) return [key, null];
    if (value === undefined) throw new Error(`Fixture relation missing: ${key}`);
    if (Array.isArray(value)) {
      const query = selected as Query;
      // Model the pinned Query strategy's bulk relation read: select physical
      // child scalars before applying each parent's pagination/distinct.
      const physical = selectedRows(value as Row[], { ...query, take: undefined, skip: undefined, distinct: undefined })
        .map((related) => projection(related, query.select));
      return [key, selectedRows(physical, { take: query.take, skip: query.skip, distinct: query.distinct })];
    }
    return [key, projection(value as Row, (selected as Query).select)];
  }));
}

function readerStageLedger(cycle: number) {
  const stages = [["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"], ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"], ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"], ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"]];
  return { version: 1, events: stages.map(([stage, readPath], index) => ({ sequence: index + 1, cycle, stage,
    transition: "NOT_APPLICABLE", readPath, evidenceKind: "TOOLING", observedAt: CAPTURED_AT.toISOString(),
    failureFingerprint: "SOURCE:MISSING", runtimeVersion: SOURCE_SHA, skipReason: "NO_PROVIDER_METADATA" })) };
}
