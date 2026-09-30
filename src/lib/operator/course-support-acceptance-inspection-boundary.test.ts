import { Prisma } from "@prisma/client";
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
import { ACCEPTANCE_READ_LIMITS, createBoundedAcceptanceReadClient } from "./course-support-acceptance-read-boundary";
import { loadCourseSupportAcceptanceReasons } from "./course-support-acceptance-reasons";
import { loadCourseSupportAcceptanceProjection } from "./course-support-acceptance";
import { loadOperatorCourseFleetCounts } from "./course-fleet";
import { createOperatorCourseSupportCampaignDependencies, loadOperatorCourseSupportCampaign } from "./course-support-campaign";

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

    expect(result).toMatchObject({ status: "AVAILABLE", reason: "COMPLETE_NATIVE_TRACE",
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
});

function assertCompleteReloads(fixture: ReturnType<typeof campaignDatabase>) {
  const reloads = fixture.calls.filter((call) => call.model === "courseSupportIncident" && call.method === "findMany" &&
    typeof (call.args as Query).where?.id === "string" &&
    ((call.args as Query).select?.batchIncidents as Query | undefined)?.take === 21);
  expect(reloads).toHaveLength(224); // ID-only preflight and untouched native read for each member.
  const nativeReloads = reloads.filter((call) =>
    (((call.args as Query).select?.batchIncidents as Query).select?.proofSnapshot) === true);
  expect(nativeReloads).toHaveLength(112);
  expect(new Set(nativeReloads.map((call) => (call.args as Query).where!.id)).size).toBe(112);
  expect(nativeReloads.every((call) => (call.args as Query).take === 1)).toBe(true);
}

function campaignDatabase(input: { readerCandidates?: boolean } = {}) {
  const rows = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, [] as Row[]]));
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
      result: "PENDING", preProbeId: null, postProbeId: null, proofSnapshot: null,
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
  rows.get("AutomationRun")!.push({ id: "private-campaign", promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
    status: "RUNNING", completedAt: null, outcome: null, audit, notes: null, startedAt: CAPTURED_AT, supportBatches: [] });
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
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
      const result = selected.map((row) => projection(row, args.select));
      return method === "findMany" ? result : result[0] ?? null;
    };
    return [name, { count: vi.fn(async (args) => invoke("count", args)), groupBy: vi.fn(async (args) => invoke("groupBy", args)),
      findMany: vi.fn(async (args) => invoke("findMany", args)), findFirst: vi.fn(async (args) => invoke("findFirst", args)),
      findUnique: vi.fn(async (args) => invoke("findUnique", args)), create: mutation, update: mutation, updateMany: mutation }];
  })) as Row;
  transaction.$queryRaw = vi.fn(async (query: Prisma.Sql | TemplateStringsArray) => {
    if (Array.isArray(query)) {
      if (query.length !== 1 || query[0] !== "SELECT transaction_timestamp() AS now") throw new Error("Unexpected clock query.");
      return [{ now: NOW }];
    }
    const statement = query as Prisma.Sql;
    calls.push({ model: "$queryRaw", method: "bytes", args: statement });
    const name = statement.text.match(/FROM "([A-Za-z0-9_]+)" AS acceptance_row/u)?.[1];
    const id = statement.text.match(/acceptance_row\."([A-Za-z0-9_]+)"::text IN/u)?.[1];
    const metadata = Prisma.dmmf.datamodel.models.find((model) => model.name === name);
    if (!name || !id || !metadata || statement.text.includes("private-") || !statement.text.includes("SUM(octet_length")) {
      throw new Error("Fixture accepts only parameterized byte SELECTs.");
    }
    const selected = rows.get(name)!.filter((row) => statement.values.includes(row[id] as string));
    const bytes = selected.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(Object.fromEntries(
      metadata.fields.filter((field) => field.kind !== "object" && field.name in row).map((field) => [field.name, row[field.name]]),
    )), "utf8"), 0);
    return [{ bytes: BigInt(bytes), matchedRows: BigInt(selected.length) }];
  });
  const transactionControls = vi.fn(async (command: string) => {
    if (!["SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '25000ms'"].includes(command)) return mutation();
    return 0;
  });
  transaction.$executeRawUnsafe = transactionControls;
  return { transaction: transaction as unknown as Prisma.TransactionClient, calls, mutation,
    transactionControls, operationCount: () => calls.length };
}

function selectedRows(rows: readonly Row[], query: Query): Row[] {
  let selected = rows.filter((row) => matches(row, query.where));
  const order = query.orderBy ? Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy] : [];
  selected.sort((left, right) => {
    for (const term of order) {
      for (const [key, direction] of Object.entries(term)) {
        const leftValue = left[key];
        const rightValue = right[key];
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
    if (expected === null || typeof expected !== "object" || expected instanceof Date) return actual === expected;
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
    if (Array.isArray(value)) return [key, selectedRows(value as Row[], selected as Query).map((related) => projection(related, (selected as Query).select))];
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
