// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const delegate = () => ({
    findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(),
    create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
    upsert: vi.fn(), deleteMany: vi.fn(),
  });
  return {
    $transaction: vi.fn(), $queryRaw: vi.fn(), $queryRawUnsafe: vi.fn(),
    course: delegate(), courseProbe: delegate(), courseMonitoringStatus: delegate(),
    courseMonitoringEvent: delegate(), courseSupportIncident: delegate(),
    courseSupportBatch: delegate(), courseSupportBatchIncident: delegate(),
    courseSupportBatchSearch: delegate(), courseSupportVerificationRequest: delegate(),
    courseAutomationDiscovery: delegate(), coursePreference: delegate(),
    teeSearch: delegate(), teeTimeMatch: delegate(), automationRun: delegate(),
    localReaderJob: delegate(), providerRequestLease: delegate(),
  };
});
// Substitute only the external database boundary. The success writer, responder
// closeout, proof validators, campaign loader, and acceptance assessor are real.
vi.mock("@/lib/prisma", () => ({ prisma: database }));

import { recordCourseMonitoringSuccess } from "./course-monitoring";
import { closeoutCourseSupportBatch, isDurableTerminalProof } from "./course-support-batches";
import {
  createParkedCourseCampaignAudit, loadCampaignMemberObservations,
  summarizeParkedCourseCampaignProgress,
} from "./course-support-campaign";
import {
  createCourseSupportSearchExecutionFenceInput, persistCourseSupportSearchExecutionFence,
  readCourseSupportSearchExecutionFence,
} from "./course-support-search-execution-fence";

type Row = Record<string, unknown>;
type Model = Exclude<keyof typeof database, "$transaction" | "$queryRaw" | "$queryRawUnsafe">;
type Query = { where?: Row; select?: Row; include?: Row; orderBy?: Row | Row[]; take?: number; data?: Row };
type Relation = { model: Model; rows: Row[]; many: boolean };
let rows: Record<Model, Row[]>;
const clone = <T,>(value: T): T => structuredClone(value);
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value)
  ? value as Row : {};
const capturedAt = new Date("2026-09-05T20:00:00.000Z");
const confirmedAt = new Date("2026-09-05T21:00:00.000Z");
const deployedAt = new Date("2026-09-05T21:02:00.000Z");
const lastFailureAt = new Date("2026-09-05T21:03:00.000Z");
const observedAt = new Date("2026-09-05T21:05:00.000Z");
const verifiedAt = new Date("2026-09-05T21:06:00.000Z");
const now = new Date("2026-09-05T21:07:00.000Z");
const runtimeVersion = "a".repeat(40);
const courseId = "restored-acceptance-course";
const incidentId = "restored-acceptance-incident";
const batchId = "restored-acceptance-batch";
const campaignId = "restored-acceptance-campaign";
let audit: ReturnType<typeof createParkedCourseCampaignAudit>;

function relation(model: Model, row: Row, key: string): Relation | null {
  const linked = (target: Model, field: string, value: unknown, many: boolean): Relation =>
    ({ model: target, rows: rows[target].filter((item) => item[field] === value), many });
  if (model === "course") {
    if (key === "monitoringStatus") return linked("courseMonitoringStatus", "courseId", row.id, false);
    if (key === "probes") return linked("courseProbe", "courseId", row.id, true);
    if (key === "automationDiscoveries") return linked("courseAutomationDiscovery", "courseId", row.id, true);
    if (key === "preferences") return linked("coursePreference", "courseId", row.id, true);
    if (key === "monitoringEvents") return linked("courseMonitoringEvent", "courseId", row.id, true);
  }
  if (model === "courseSupportIncident") {
    if (key === "course") return linked("course", "id", row.courseId, false);
    if (key === "monitoringEvents") return linked("courseMonitoringEvent", "incidentId", row.id, true);
    if (key === "batchIncidents") return linked("courseSupportBatchIncident", "incidentId", row.id, true);
  }
  if (model === "courseSupportBatch" && key === "incidents") {
    return linked("courseSupportBatchIncident", "batchId", row.id, true);
  }
  if (model === "courseSupportBatchIncident") {
    if (key === "batch") return linked("courseSupportBatch", "id", row.batchId, false);
    if (key === "course") return linked("course", "id", row.courseId, false);
    if (key === "incident") return linked("courseSupportIncident", "id", row.incidentId, false);
    if (key === "verificationRequests") return linked("courseSupportVerificationRequest", "batchIncidentId", row.id, true);
  }
  if (model === "courseProbe" && key === "teeSearch") return linked("teeSearch", "id", row.teeSearchId, false);
  return null;
}

function equal(actual: unknown, expected: unknown): boolean {
  return actual instanceof Date && expected instanceof Date
    ? actual.getTime() === expected.getTime() : actual === expected;
}

function scalarMatches(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object" || expected instanceof Date || Array.isArray(expected)) {
    return equal(actual, expected);
  }
  const filter = object(expected);
  if (Array.isArray(filter.path)) {
    return equal(filter.path.reduce<unknown>((value, key) => object(value)[String(key)], actual), filter.equals);
  }
  return Object.entries(filter).every(([op, value]) => {
    if (op === "equals") return equal(actual, value);
    if (op === "not") return !scalarMatches(actual, value);
    if (op === "in" && Array.isArray(value)) return value.some((item) => equal(actual, item));
    if (op === "notIn" && Array.isArray(value)) return !value.some((item) => equal(actual, item));
    if (actual instanceof Date && value instanceof Date) {
      if (op === "gte") return actual >= value;
      if (op === "gt") return actual > value;
      if (op === "lte") return actual <= value;
      if (op === "lt") return actual < value;
    }
    throw new Error(`UNSUPPORTED_FIXTURE_FILTER:${op}`);
  });
}

function matches(model: Model, row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND" || key === "OR" || key === "NOT") {
      const clauses = Array.isArray(expected) ? expected : [expected];
      const results = clauses.map((clause) => matches(model, row, object(clause)));
      return key === "OR" ? results.some(Boolean) : key === "NOT" ? results.every((result) => !result) : results.every(Boolean);
    }
    const linked = relation(model, row, key);
    if (linked) {
      if (expected === null) return linked.rows.length === 0;
      const filter = object(expected);
      if ("some" in filter) return linked.rows.some((item) => matches(linked.model, item, object(filter.some)));
      if ("none" in filter) return linked.rows.every((item) => !matches(linked.model, item, object(filter.none)));
      if ("is" in filter) return linked.rows.some((item) => matches(linked.model, item, object(filter.is)));
      return linked.rows.some((item) => matches(linked.model, item, filter));
    }
    if (!(key in row)) throw new Error(`MISSING_FIXTURE_FILTER_FIELD:${model}.${key}`);
    return scalarMatches(row[key], expected);
  });
}

function selectRows(model: Model, source: Row[], query: Query = {}): Row[] {
  const selected = source.filter((row) => matches(model, row, query.where));
  const order = query.orderBy ? (Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy]) : [];
  selected.sort((left, right) => {
    for (const entry of order) {
      for (const [key, direction] of Object.entries(entry)) {
        if (typeof direction !== "string") throw new Error("UNSUPPORTED_FIXTURE_NESTED_ORDER");
        const a = left[key] instanceof Date ? (left[key] as Date).getTime() : left[key];
        const b = right[key] instanceof Date ? (right[key] as Date).getTime() : right[key];
        if (a === b) continue;
        if ((typeof a !== "string" && typeof a !== "number") || (typeof b !== "string" && typeof b !== "number")) {
          throw new Error(`INVALID_FIXTURE_ORDER:${model}.${key}`);
        }
        return (a < b ? -1 : 1) * (direction === "desc" ? -1 : 1);
      }
    }
    return 0;
  });
  return selected.slice(0, query.take).map((row) => {
    const result: Row = query.select ? {} : clone(row);
    for (const [key, shape] of Object.entries(query.select ?? query.include ?? {})) {
      if (shape === false) continue;
      const linked = relation(model, row, key);
      if (linked) {
        const related = selectRows(linked.model, linked.rows, object(shape) as Query);
        result[key] = linked.many ? related : related[0] ?? null;
      } else {
        if (!(key in row)) throw new Error(`MISSING_FIXTURE_SELECT_FIELD:${model}.${key}`);
        result[key] = clone(row[key]);
      }
    }
    return result;
  });
}

function applyData(model: Model, row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!(key in row)) throw new Error(`MISSING_FIXTURE_WRITE_FIELD:${model}.${key}`);
    const increment = object(value).increment;
    if (increment !== undefined) {
      if (typeof row[key] !== "number" || typeof increment !== "number") throw new Error("INVALID_FIXTURE_INCREMENT");
      row[key] += increment;
    } else row[key] = clone(value);
  }
}

function installDatabase() {
  for (const model of Object.keys(rows) as Model[]) {
    const delegate = database[model];
    delegate.findMany.mockImplementation(async (query: Query = {}) => selectRows(model, rows[model], query));
    delegate.findFirst.mockImplementation(async (query: Query = {}) => selectRows(model, rows[model], query)[0] ?? null);
    delegate.findUnique.mockImplementation(async (query: Query = {}) => {
      const found = selectRows(model, rows[model], query);
      if (found.length > 1) throw new Error("FIXTURE_NONUNIQUE");
      return found[0] ?? null;
    });
    delegate.count.mockImplementation(async (query: Query = {}) => rows[model].filter((row) => matches(model, row, query.where)).length);
    delegate.updateMany.mockImplementation(async (query: Query) => {
      const selected = rows[model].filter((row) => matches(model, row, query.where));
      for (const row of selected) applyData(model, row, query.data ?? {});
      return { count: selected.length };
    });
    delegate.update.mockImplementation(async (query: Query) => {
      const selected = rows[model].filter((row) => matches(model, row, query.where));
      if (selected.length !== 1) throw new Error("FIXTURE_CAS_MISMATCH");
      applyData(model, selected[0], query.data ?? {});
      return selectRows(model, selected, { select: query.select, include: query.include })[0];
    });
    delegate.upsert.mockImplementation(async (query: Query) => {
      const selected = rows[model].filter((row) => matches(model, row, query.where));
      if (selected.length !== 1) throw new Error("UNEXPECTED_FIXTURE_UPSERT_CREATE");
      return clone(selected[0]);
    });
    delegate.create.mockImplementation(async ({ data }: { data: Row }) => {
      if (model !== "courseMonitoringEvent") throw new Error(`UNEXPECTED_FIXTURE_CREATE:${model}`);
      const row = {
        id: `restored-event-${rows[model].length}`, incidentId: null,
        runtimeVersion: null, deploymentSha: null, outcome: null,
        idempotencyKey: null, audit: null, ...clone(data),
      };
      if (row.idempotencyKey && rows[model].some((prior) => prior.idempotencyKey === row.idempotencyKey)) throw new Error("FIXTURE_DUPLICATE_EVENT");
      rows[model].push(row);
      return clone(row);
    });
    delegate.createMany.mockImplementation(async ({ data }: { data: Row[] }) => {
      for (const row of data) await delegate.create({ data: row });
      return { count: data.length };
    });
    delegate.deleteMany.mockImplementation(async (query: Query) => {
      const retained = rows[model].filter((row) => !matches(model, row, query.where));
      const count = rows[model].length - retained.length;
      rows[model] = retained;
      return { count };
    });
  }
  database.$transaction.mockImplementation(async (worker: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    const original = clone(rows);
    try { return await worker(database as unknown as Prisma.TransactionClient); }
    catch (error) { rows = original; throw error; }
  });
  database.$queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (!sql.includes("pg_advisory_xact_lock")) throw new Error("UNEXPECTED_FIXTURE_SQL");
    return [{ locked: true }];
  });
  database.$queryRaw.mockImplementation(async (query: { sql: string; values: unknown[] }) => {
    const sql = query.sql.replace(/\s+/gu, " ").trim();
    if (/^SELECT "id" FROM "Course" WHERE "id" IN \(.+\) ORDER BY "id" FOR UPDATE$/u.test(sql)) {
      expect(query.values).toEqual([courseId]);
      const locked = rows.course.filter((course) => query.values.includes(course.id));
      expect(locked).toHaveLength(1);
      return locked.map((course) => ({ id: course.id }));
    }
    if (sql === 'SELECT search."id" FROM "TeeSearch" AS search WHERE FALSE ORDER BY search."id" FOR UPDATE') {
      expect(query.values).toEqual([]);
      return [];
    }
    const dispatchRead = /^SELECT dispatch\."teeSearchId" FROM "CourseSupportBatchSearch" AS dispatch WHERE dispatch\."batchId" = \? ORDER BY dispatch\."teeSearchId", dispatch\."id"$/u;
    const dispatchLock = /^SELECT dispatch\."id" FROM "CourseSupportBatchSearch" AS dispatch WHERE dispatch\."batchId" = \? ORDER BY dispatch\."id" FOR UPDATE$/u;
    const preferenceLock = /^SELECT preference\."id" FROM "CoursePreference" AS preference WHERE preference\."teeSearchId" IN \( SELECT dispatch\."teeSearchId" FROM "CourseSupportBatchSearch" AS dispatch WHERE dispatch\."batchId" = \? AND dispatch\."teeSearchId" IS NOT NULL \) ORDER BY preference\."teeSearchId", preference\."courseId", preference\."id" FOR UPDATE$/u;
    const probeLock = /^SELECT probe\."id" FROM "CourseProbe" AS probe WHERE probe\."teeSearchId" IN \( SELECT dispatch\."teeSearchId" FROM "CourseSupportBatchSearch" AS dispatch WHERE dispatch\."batchId" = \? AND dispatch\."teeSearchId" IS NOT NULL \) AND probe\."observedAt" >= \? ORDER BY probe\."teeSearchId", probe\."observedAt", probe\."id" FOR UPDATE$/u;
    if (dispatchRead.test(sql) || dispatchLock.test(sql) || preferenceLock.test(sql) || probeLock.test(sql)) {
      expect(query.values).toEqual(probeLock.test(sql) ? [batchId, deployedAt] : [batchId]);
      // This fixture has no affected searches; reject additions rather than
      // silently pretending their real membership/child lock returned no rows.
      expect(rows.courseSupportBatchSearch).toEqual([]);
      return [];
    }
    throw new Error("UNEXPECTED_FIXTURE_SQL");
  });
}

async function setup() {
  rows = {
    course: [], courseProbe: [], courseMonitoringStatus: [], courseMonitoringEvent: [],
    courseSupportIncident: [], courseSupportBatch: [], courseSupportBatchIncident: [],
    courseSupportBatchSearch: [], courseSupportVerificationRequest: [], courseAutomationDiscovery: [],
    coursePreference: [], teeSearch: [], teeTimeMatch: [], automationRun: [],
    localReaderJob: [], providerRequestLease: [],
  };
  rows.course.push({
    id: courseId, name: "Offline acceptance fixture", googlePlaceId: null,
    address: null, latitude: null, longitude: null, timeZone: "America/New_York",
    isPublic: true, website: "https://official.example/", detectedBookingUrl: "https://official.example/tee-times",
    detectedPlatform: "UNKNOWN", providerFamilyKey: "official.example", monitoringMode: "AUTOMATIC",
    bookingMethod: "PUBLIC_ONLINE", bookingAccessMode: "PUBLIC_SIGNED_OUT", bookingMetadata: null,
    bookingApiEndpoint: null, automationEligibility: "ALLOWED", automationReason: "NONE",
    intelligenceVerifiedAt: null, intelligenceReviewAt: null, intelligenceConfidence: null,
    policyNotes: null, bookingWindowDaysAhead: null, bookingReleaseTimeLocal: null,
    bookingWindowSource: null, bookingWindowEvidenceUrl: null, bookingWindowVerifiedAt: null,
    bookingWindowConfidence: null, bookingWindowNotes: null, layoutHoleCounts: [],
    layoutHolesVerifiedAt: null, updatedAt: lastFailureAt,
  });
  rows.courseMonitoringStatus.push({
    courseId, state: "AUTO_INVESTIGATING", revision: 2, stateChangedAt: confirmedAt,
    lastSuccessfulAt: null, lastFailureAt, consecutiveFailures: 1,
    failureFingerprint: "fixture-failure", firstDegradedAt: confirmedAt,
    nextAutomaticAttemptAt: now, revalidationRequestedAt: null,
  });
  rows.courseSupportIncident.push({
    id: incidentId, courseId, cycle: 2, revision: 2, status: "AUTO_INVESTIGATING",
    kind: "FETCH_FAILED", providerFamilyKey: "official.example", failureClass: "NETWORK",
    failureFingerprint: "fixture-failure", confirmedAt, firstSeenAt: capturedAt,
    lastSeenAt: lastFailureAt, updatedAt: lastFailureAt, activeBatchId: batchId,
    engineeringOnly: true, activeRealSearchCount: 0, attemptCount: 0,
    attemptLedger: null, escalatedAt: null, escalationDeadlineAt: null,
    resolution: null, resolutionMessage: null, resolvedAt: null, decisionAt: null,
    decisionActorId: null, decisionNote: null, decisionEvidenceUrl: null,
    decisionIdempotencyKey: null, nextAction: null, nextAttemptAt: now, nextReminderAt: null,
  });
  rows.courseProbe.push({
    id: "restored-acceptance-probe", courseId, teeSearchId: "restored-acceptance-search", automationRunId: null,
    outcome: "NO_MATCH", observedAt, runtimeVersion, message: "Offline successful provider observation.",
    evidenceUrl: null, rawSummary: { providerExecution: true },
  });
  rows.teeSearch.push({ id: "restored-acceptance-search", status: "COMPLETED", trafficClass: "PUBLIC" });
  rows.courseSupportBatch.push({
    id: batchId, status: "VERIFYING", revision: 2, baseSha: runtimeVersion, releaseSha: runtimeVersion,
    createdAt: confirmedAt, completedAt: null, deployedAt,
    ownerThreadId: "offline-acceptance-owner", ownerAutomationRunId: null,
    leaseToken: "offline-acceptance-lease", leaseExpiresAt: new Date("2026-09-05T22:00:00.000Z"),
    heartbeatAt: verifiedAt, recheckDispatchKey: null,
    recheckDispatchStartedAt: deployedAt, recheckDispatchedAt: deployedAt,
    summary: { recheckDispatch: {
      attempted: true, dispatchError: false, detachedVerificationDispatchError: false,
      schedulerHealthComplete: true, courseOutcomeHealthComplete: true,
      affectedSearchCount: 0, currentAffectedSearchCount: 0, queuedCount: 0,
      queueFailureCount: 0, directStartCount: 0, healthySchedulerCount: 0,
      freshSearchCheckCount: 0, restoredCourseCount: 1, provenRunnableCourseCount: 1,
      affectedCourseSearchPairCount: 0, healthyCourseSearchPairCount: 0,
      schedulerHealthObservedAt: now.toISOString(),
    } },
  });
  rows.courseSupportBatchIncident.push({
    id: "restored-acceptance-entry", batchId, courseId, incidentId, cycle: 2,
    result: "RESTORED", createdAt: confirmedAt, updatedAt: verifiedAt,
    preProbeId: null, postProbeId: "restored-acceptance-probe", message: "Fresh provider proof recorded.",
    verifiedAt, verifiedIncidentUpdatedAt: lastFailureAt,
    proofSnapshot: {
      kind: "PROVIDER_PROBE", outcome: "NO_MATCH", providerExecution: true,
      runtimeVersion, observedAt: observedAt.toISOString(), freshSearchCheckedAt: observedAt.toISOString(),
    },
  });
  audit = createParkedCourseCampaignAudit({
    capturedAt, expectedCount: 1,
    members: [{ courseId, incidentId, cycle: 1, revision: 1, monitoringRevision: 1,
      monitoringFailureFingerprint: "fixture-failure", kind: "FETCH_FAILED",
      providerFamilyKey: "official.example", failureClass: "NETWORK", failureFingerprint: "fixture-failure",
      providerSnapshotFingerprint: "b".repeat(64), attemptLedgerFingerprint: "c".repeat(64),
      playbookConclusion: "UNRESOLVED_EXHAUSTED", latestProbeAt: null, latestDiscoveryAt: null }],
  });
  installDatabase();
  const batch = rows.courseSupportBatch[0];
  const fenceInput = createCourseSupportSearchExecutionFenceInput({
    batchId, courseIds: [courseId], summary: batch.summary, recheckDispatchKey: null,
    recheckDispatchStartedAt: deployedAt, recheckDispatchedAt: deployedAt, now,
  });
  object(batch.summary).searchExecutionFence = persistCourseSupportSearchExecutionFence(
    await readCourseSupportSearchExecutionFence(database as unknown as Prisma.TransactionClient, fenceInput), now,
  );
}

async function successThenHealthy(successRuntime = runtimeVersion) {
  const result = await recordCourseMonitoringSuccess({
    courseId, outcome: "NO_MATCH", providerObservedAt: observedAt,
    runtimeVersion: successRuntime, source: "SEARCH_WORKFLOW", now: observedAt,
  });
  expect(result).toMatchObject({ state: "HEALTHY", sourceEvidenceAccepted: true });
  expect(rows.courseSupportIncident[0]).toMatchObject({ status: "AUTO_INVESTIGATING", activeBatchId: batchId });
  expect(rows.courseMonitoringEvent.filter((event) => event.eventType === "RECOVERED")).toHaveLength(1);
  expect(object(rows.courseMonitoringEvent.find((event) => event.eventType === "RECOVERED")?.audit))
    .not.toHaveProperty("freshRuntimeProof");
}

async function closeout(mode: "WATCH_SETTLED" | "EARLY_RETRY" = "WATCH_SETTLED") {
  if (mode === "WATCH_SETTLED") {
    const entry = rows.courseSupportBatchIncident[0];
    expect(isDurableTerminalProof({
      ...entry, normalizedResult: entry.result, incident: rows.courseSupportIncident[0],
    } as Parameters<typeof isDurableTerminalProof>[0], rows.courseSupportBatch[0] as Parameters<typeof isDurableTerminalProof>[1]))
      .toBe(true);
  }
  const result = await closeoutCourseSupportBatch({
    batchId, leaseToken: "offline-acceptance-lease", ownerThreadId: "offline-acceptance-owner",
    verificationWatchMode: mode, now,
  });
  expect(result).toMatchObject({ durableCloseoutRecorded: true, terminalCount: 1, retryCount: 0 });
  expect(rows.courseSupportIncident[0]).toMatchObject({ status: "RESOLVED", resolution: "MONITORING_RESTORED", activeBatchId: null });
  return result;
}

async function strictRead() {
  const observations = await loadCampaignMemberObservations(audit, new Set(), campaignId, database as unknown as Prisma.TransactionClient);
  return { observations, progress: summarizeParkedCourseCampaignProgress({ audit, observations, remainingGlobalParkedCount: 0 }) };
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", runtimeVersion);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }));
  await setup();
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("native restored closeout to original-cohort acceptance", () => {
  it("accepts exact fresh RESTORED proof while changing a nonhealthy monitoring state", async () => {
    await closeout();
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 1, monitoredCount: 1, engineeringBlockerCount: 0 });
  });

  it("accepts exact fresh RESTORED proof after the native success writer already made the course healthy", async () => {
    await successThenHealthy();
    const authoritative = clone(rows.courseMonitoringStatus[0]);
    const priorEvents = clone(rows.courseMonitoringEvent);
    await closeout();
    expect(rows.courseMonitoringStatus[0]).toEqual(authoritative);
    expect(rows.courseMonitoringEvent.slice(0, priorEvents.length)).toEqual(priorEvents);
    expect(rows.courseMonitoringEvent.slice(priorEvents.length)).toEqual([
      expect.objectContaining({
        eventType: "RECOVERED", source: "COURSE_SUPPORT_RESPONDER",
        fromState: "HEALTHY", toState: "HEALTHY", occurredAt: observedAt,
        runtimeVersion, deploymentSha: runtimeVersion,
        audit: expect.objectContaining({ freshRuntimeProof: true, reconfirmedExistingSuccess: true }),
      }),
    ]);
    // Neither a changed state timestamp nor a manufactured marker is injected.
    // The real closeout must append its own independently validated receipt.
    const { observations, progress } = await strictRead();
    expect.soft(observations[0].campaignTerminalFreshRuntimeProof).toBe(true);
    expect.soft(progress).toMatchObject({ terminalCount: 1, monitoredCount: 1, engineeringBlockerCount: 0 });
  });

  it("preserves an authoritative EARLY_RETRY ownership release without inventing an exact proof receipt", async () => {
    await successThenHealthy();
    const authoritative = clone(rows.courseMonitoringStatus[0]);
    const events = clone(rows.courseMonitoringEvent);
    Object.assign(rows.courseSupportBatchIncident[0], { result: "PENDING", proofSnapshot: null, verifiedAt: null, verifiedIncidentUpdatedAt: null, postProbeId: null });
    await closeout("EARLY_RETRY");
    expect(rows.courseMonitoringStatus[0]).toEqual(authoritative);
    expect(rows.courseMonitoringEvent).toEqual(events);
    expect((await strictRead()).progress.terminalCount).toBe(0);
  });

  it("does not duplicate the fresh receipt when the same closed batch is replayed", async () => {
    await successThenHealthy();
    await closeout();
    const closed = clone(rows);
    await expect(closeoutCourseSupportBatch({
      batchId, leaseToken: "offline-acceptance-lease", ownerThreadId: "offline-acceptance-owner",
      verificationWatchMode: "WATCH_SETTLED", now,
    })).resolves.toMatchObject({ durableCloseoutRecorded: false });
    expect(rows).toEqual(closed);
    expect(rows.courseMonitoringEvent.filter((event) => object(event.audit).freshRuntimeProof === true)).toHaveLength(1);
  });

  it("does not receipt an older success against a newer authoritative success time", async () => {
    await successThenHealthy();
    const newerObservedAt = new Date(observedAt.getTime() + 30_000);
    await recordCourseMonitoringSuccess({
      courseId, outcome: "NO_MATCH", providerObservedAt: newerObservedAt,
      runtimeVersion, source: "SEARCH_WORKFLOW", now: newerObservedAt,
    });
    const authoritative = clone(rows.courseMonitoringStatus[0]);
    const events = clone(rows.courseMonitoringEvent);
    await closeout();
    expect(rows.courseMonitoringStatus[0]).toEqual(authoritative);
    expect(rows.courseMonitoringEvent).toEqual(events);
    expect((await strictRead()).progress.terminalCount).toBe(0);
  });

  it("does not publish a receipt when monitoring persistence cannot supply its CAS", async () => {
    await successThenHealthy();
    const authoritative = clone(rows.courseMonitoringStatus[0]);
    const events = clone(rows.courseMonitoringEvent);
    const createMany = database.courseMonitoringEvent.createMany;
    Reflect.deleteProperty(database.courseMonitoringEvent, "createMany");
    try {
      await closeout();
      expect(database.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
      expect(rows.courseMonitoringStatus[0]).toEqual(authoritative);
      expect(rows.courseMonitoringEvent).toEqual(events);
    } finally {
      Reflect.set(database.courseMonitoringEvent, "createMany", createMany);
    }
    expect((await strictRead()).progress.terminalCount).toBe(0);
  });

  it("rolls back incident and batch closeout without a receipt when the authoritative CAS loses", async () => {
    await successThenHealthy();
    const original = clone(rows);
    database.courseMonitoringStatus.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(closeoutCourseSupportBatch({
      batchId, leaseToken: "offline-acceptance-lease", ownerThreadId: "offline-acceptance-owner",
      verificationWatchMode: "WATCH_SETTLED", now,
    })).rejects.toThrow("Course monitoring changed during responder closeout");
    expect(database.courseMonitoringStatus.updateMany).toHaveBeenCalledWith({
      where: { courseId, state: "HEALTHY", revision: 3, lastSuccessfulAt: observedAt },
      data: { revision: { increment: 0 } },
    });
    expect(rows).toEqual(original);
  });

  it("does not attribute a successful observation from another runtime to the batch release", async () => {
    const otherRuntime = "d".repeat(40);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", otherRuntime);
    rows.courseProbe[0].runtimeVersion = otherRuntime;
    object(rows.courseSupportBatchIncident[0].proofSnapshot).runtimeVersion = otherRuntime;
    await successThenHealthy(otherRuntime);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", runtimeVersion);
    const authoritative = clone(rows.courseMonitoringStatus[0]);
    const events = clone(rows.courseMonitoringEvent);
    // The normal provider-success reconciliation may close this incident, but
    // cannot turn another deployment's success into this release's receipt.
    await closeoutCourseSupportBatch({
      batchId, leaseToken: "offline-acceptance-lease", ownerThreadId: "offline-acceptance-owner",
      verificationWatchMode: "WATCH_SETTLED", now,
    });
    expect(rows.courseMonitoringStatus[0]).toEqual(authoritative);
    expect(rows.courseMonitoringEvent).toEqual(events);
    expect((await strictRead()).progress.terminalCount).toBe(0);
  });
});
