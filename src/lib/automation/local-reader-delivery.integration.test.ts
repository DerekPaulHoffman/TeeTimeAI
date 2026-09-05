import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Query = { where?: Row; data?: Row; create?: Row; update?: Row; orderBy?: Row | Row[]; take?: number };
type Sql = { strings: readonly string[]; values: unknown[] };

const boundary = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  send: vi.fn(),
  forbidden: vi.fn(() => { throw new Error("Unexpected external work in isolated delivery proof"); })
}));

vi.mock("@/lib/prisma", () => ({ prisma: boundary.prisma }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: boundary.send };
  }
}));
vi.mock("@/lib/email/delivery-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/delivery-policy")>()),
  areSearchStatusEmailsEnabled: () => false
}));
vi.mock("@/lib/automation/search-monitoring-discovery", () => ({
  prepareSearchMonitoring: async () => ({
    attemptedCourseIds: [], appliedCourseIds: [], failedCourseIds: [],
    deferredCourseIds: [], retryCourseIds: []
  })
}));
vi.mock("@/lib/automation/course-monitoring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automation/course-monitoring")>()),
  // Endpoint reconciliation is unrelated to this already restored reader path.
  reconcileCourseMonitoringDeadlines: async () => ({ escalated: 0, retrying: 0, humanReviewIncidentIds: [] })
}));

import { runSearchCheck } from "./search-check";
import { getFreshLocalReaderObservation } from "@/lib/local-reader/service";
import {
  drainSearchEmailDeliveryGroup,
  hydrateMatchAlertPayload,
  lockSearchForAlertMutation,
  prepareSearchEmailDeliveryGroup
} from "@/lib/email/search-delivery-outbox";
import { sendTeeTimeAlert } from "@/lib/email/alerts";

const now = new Date("2026-07-29T12:10:00Z");
const sourceAt = new Date("2026-07-29T12:09:00Z");
const completedAt = new Date("2026-07-29T12:09:20Z");
const priorSuccess = new Date("2026-07-28T12:00:00Z");
const bookingUrl = "https://fox.tenfore.golf/offline-fixture?date=2026-07-30";
// Reserved .example addresses exercise the real send wrapper, not its dry-run path.
const owner = "owner@delivery.example";
const friend = "friend@delivery.example";
const lease = {
  searchId: "offline-search", scheduleVersion: 2, token: "offline-check-token",
  expiresAt: new Date("2026-07-29T12:25:00Z")
};

let rows: Record<string, Row[]>;
let events: string[];
let sequence: number;

/**
 * One isolated persistence boundary, not a simulated domain service. All source
 * selection/consumption, match commit, recipient authority, outbox, and rendering
 * functions are real. Only database operations, Resend transport, unrelated
 * discovery/deadline work, and status-email policy are replaced. This starts
 * after an authenticated reader result has been stored; it does not prove the
 * browser, signature/result-submission API, real Postgres locks, or inbox delivery.
 * SQL/model reads return detached snapshots; writes apply the supplied predicates
 * and data. Unknown operations fail closed. Transactions roll back but this
 * single-process fixture does not model concurrent database transactions.
 */

const clone = <T,>(value: T): T => structuredClone(value);
function object(value: unknown): Row {
  return value && typeof value === "object" && !(value instanceof Date) ? value as Row : {};
}
function scalar(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}
function equal(left: unknown, right: unknown) {
  return scalar(left) === scalar(right);
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === "AND" || key === "OR" || key === "NOT") {
      const conditions = Array.isArray(expected) ? expected : [expected];
      const results = conditions.map((condition) => matches(row, object(condition)));
      return key === "AND" ? results.every(Boolean) : key === "OR" ? results.some(Boolean) : results.every((value) => !value);
    }
    const actual = row[key];
    if (expected === null || typeof expected !== "object" || expected instanceof Date) return equal(actual, expected);
    if (key.includes("_") && actual === undefined) return matches(row, object(expected));
    const operators = object(expected);
    return Object.entries(operators).every(([operator, value]) => {
      if (operator === "equals") return equal(actual, value);
      if (operator === "in") return (value as unknown[]).some((item) => equal(actual, item));
      if (operator === "notIn") return !(value as unknown[]).some((item) => equal(actual, item));
      if (operator === "not") return value !== null && typeof value === "object" ? !matches({ value: actual }, { value }) : !equal(actual, value);
      if (["gt", "gte", "lt", "lte"].includes(operator)) {
        if (actual === null || actual === undefined) return false;
        const left = scalar(actual) as number;
        const right = scalar(value) as number;
        return operator === "gt" ? left > right : operator === "gte" ? left >= right : operator === "lt" ? left < right : left <= right;
      }
      if (operator === "some" || operator === "none" || operator === "every") {
        const results = (actual as Row[]).map((item) => matches(item, object(value)));
        return operator === "some" ? results.some(Boolean) : operator === "none" ? results.every((result) => !result) : results.every(Boolean);
      }
      if (operator === "is") return matches(object(actual), object(value));
      if (operator === "isNot") return !matches(object(actual), object(value));
      if (actual && typeof actual === "object") return matches(object(actual), { [operator]: value });
      throw new Error(`Unhandled isolated persistence predicate: ${key}.${operator}`);
    });
  });
}

function project(model: string, row: Row): Row {
  if (model === "course") return {
    ...row,
    monitoringStatus: rows.courseMonitoringStatus.find((item) => item.courseId === row.id) ?? null,
    supportIncident: rows.courseSupportIncident.find((item) => item.courseId === row.id) ?? null,
    bookingFacts: []
  };
  if (model === "teeSearch") return {
    ...row, user: rows.user[0],
    preferences: [{ rank: 1, course: project("course", rows.course[0]) }],
    matches: rows.teeTimeMatch.map((match) => ({ ...match, course: project("course", rows.course[0]) }))
  };
  if (model === "teeTimeMatch") return {
    ...row, course: project("course", rows.course[0]), teeSearch: project("teeSearch", rows.teeSearch[0])
  };
  return row;
}

function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
      const update = object(value);
      if (Object.keys(update).length === 1 && "increment" in update) {
        row[key] = Number(row[key] ?? 0) + Number(update.increment);
        continue;
      }
    }
    row[key] = clone(value);
  }
}

function installModel(model: string) {
  function read(query: Query = {}) {
    let selected = rows[model].map((row) => project(model, row)).filter((row) => matches(row, query.where));
    const ordering = query.orderBy ? Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy] : [];
    selected = [...selected].sort((left, right) => {
      for (const order of ordering) for (const [key, direction] of Object.entries(order)) {
        if (!equal(left[key], right[key])) return ((scalar(left[key]) as number) < (scalar(right[key]) as number) ? -1 : 1) * (direction === "desc" ? -1 : 1);
      }
      return 0;
    });
    return clone(query.take === undefined ? selected : selected.slice(0, query.take));
  }
  function create(data: Row) {
    const defaults = model === "searchEmailDelivery" ? {
      status: "PENDING", attemptCount: 0, claimToken: null, claimExpiresAt: null,
      nextAttemptAt: null, sentAt: null, lastError: null
    } : model === "teeTimeMatch" ? {
      alertStatus: "PENDING", availabilityStatus: "AVAILABLE", availabilityCycle: 0,
      sentAt: null, unavailableAt: null, firstSeenAt: new Date(), lastSeenAt: new Date(),
      // These are the real database defaults, not invented provider timestamps.
      lastConfirmedAt: new Date()
    } : {};
    const row = { id: `${model}-${++sequence}`, createdAt: new Date(), updatedAt: new Date(), ...defaults, ...clone(data) };
    rows[model].push(row);
    events.push(`${model}:create`);
    return clone(project(model, row));
  }
  function update(query: Query) {
    const selected = rows[model].filter((row) => matches(project(model, row), query.where));
    for (const row of selected) {
      apply(row, query.data ?? {});
      events.push(model === "localReaderJob" && equal(row.resultExpiresAt, row.completedAt)
        ? "reader:consumed" : `${model}:update`);
    }
    return selected;
  }
  boundary.prisma[model] = {
    findMany: vi.fn(async (query: Query = {}) => read(query)),
    findFirst: vi.fn(async (query: Query = {}) => read(query)[0] ?? null),
    findUnique: vi.fn(async (query: Query) => read(query)[0] ?? null),
    count: vi.fn(async (query: Query = {}) => read(query).length),
    create: vi.fn(async (query: Query) => create(query.data ?? {})),
    createMany: vi.fn(async (query: { data: Row[] }) => ({ count: query.data.map(create).length })),
    update: vi.fn(async (query: Query) => {
      const selected = update(query);
      if (selected.length !== 1) throw new Error(`Isolated ${model} update did not match exactly one row`);
      return clone(project(model, selected[0]));
    }),
    updateMany: vi.fn(async (query: Query) => ({ count: update(query).length })),
    upsert: vi.fn(async (query: Query) => {
      if (read(query).length === 0) return create(query.create ?? {});
      return clone(project(model, update({ where: query.where, data: query.update })[0]));
    })
  };
}

function sqlText(sql: Sql) { return sql.strings.join(" ").replace(/\s+/g, " "); }
function installSql() {
  boundary.prisma.$transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
    const before = clone(rows);
    try { return await callback(boundary.prisma); }
    catch (error) { rows = before; throw error; }
  });
  boundary.prisma.$queryRawUnsafe = vi.fn(async (text: string, key: unknown) => {
    if (!text.includes("pg_advisory_xact_lock(hashtextextended($1::text, 0))") ||
      key !== `course-monitoring:${rows.course[0].id}`) throw new Error("Unhandled isolated raw SQL query");
    return [{ locked: true }];
  });
  boundary.prisma.$queryRaw = vi.fn(async (sql: Sql) => {
    const text = sqlText(sql), values = sql.values, search = rows.teeSearch[0];
    if (text.trim() === 'SELECT statement_timestamp() AS "currentTime"' && values.length === 0) return [{ currentTime: new Date() }];
    if (text.includes('WITH scoped AS') && text.includes('FROM "CourseProbe"') && text.includes('failure_episode')) {
      const scoped = rows.courseProbe.filter((row) => row.teeSearchId === values[0] &&
        values.slice(1, -1).includes(row.courseId) && (row.observedAt as Date) >= (values.at(-1) as Date));
      if (scoped.length > 0) throw new Error("Isolated initial verdict query unexpectedly contains prior probes");
      return [];
    }
    if (text.includes('FROM "ProviderRequestLease"') && text.includes('AS "observationStartedAt"') &&
      text.includes('AS "retryUntil"') && text.includes('AND "slot" =') && values.length === 4) {
      if (rows.providerRequestLease.length > 0) throw new Error("Unexpected provider lease in isolated reader fixture");
      return [];
    }
    if (text.includes('FROM "User"') && text.includes('FOR UPDATE') && values.length === 1) return values[0] === rows.user[0].id ? clone(rows.user) : [];
    if (text.includes('FROM "TeeSearch" AS search') && text.includes('FOR UPDATE OF search') && [1, 2].includes(values.length)) {
      if (values[0] !== search.id || (values.length > 1 && values[1] !== search.userId)) return [];
      return [clone({ ...search, ownerEmail: rows.user[0].email, ownerPendingEmail: rows.user[0].pendingEmail })];
    }
    if (text.includes('FROM "TeeSearch"') && text.includes('"checkLeaseToken"') && text.includes('"scheduleVersion"') &&
      text.includes('"status" = \'ACTIVE\'') && text.includes('FOR UPDATE') && values.length === 3) {
      // The real SQL checks status/version/token; its caller separately checks
      // lease expiry. Do not add authorization predicates absent from the SQL.
      return search.id === values[0] && search.status === "ACTIVE" && search.scheduleVersion === values[1] && search.checkLeaseToken === values[2]
        ? [{ id: search.id }] : [];
    }
    throw new Error(`Unhandled isolated SQL read: ${text.slice(0, 90)}`);
  });
  boundary.prisma.$executeRaw = vi.fn(async (sql: Sql) => {
    const text = sqlText(sql), values = sql.values, search = rows.teeSearch[0];
    if (text.includes('UPDATE "SearchEmailDelivery"') && text.includes('SET "claimExpiresAt" = statement_timestamp()') &&
      text.includes('AND "status" = \'SENDING\'') && text.includes('AND "claimExpiresAt" > statement_timestamp()')) {
      const byId = text.includes('WHERE "id"');
      if (values.length !== (byId ? 5 : 4)) throw new Error("Unexpected delivery claim SQL parameters");
      const [ttl, ...keys] = values;
      const [id, searchId, generation, token] = byId ? keys : [undefined, ...keys];
      const selected = rows.searchEmailDelivery.filter((row) =>
        (id === undefined || row.id === id) && row.teeSearchId === searchId && row.alertGeneration === generation &&
        row.status === "SENDING" && row.claimToken === token && (row.claimExpiresAt as Date) > new Date());
      for (const row of selected) row.claimExpiresAt = new Date(Date.now() + Number(ttl));
      return selected.length;
    }
    if (text.includes('UPDATE "TeeSearch"') && text.includes('SET "recheckRequestedAt" = CASE') && values.length === 4) {
      if (!equal(values[0], values[1])) throw new Error("Unexpected delivery retry SQL parameters");
      if (search.id !== values[2] || search.alertGeneration !== values[3] || search.status !== "ACTIVE") return 0;
      const retryAt = values[0] as Date;
      if (!search.recheckRequestedAt || retryAt < (search.recheckRequestedAt as Date)) search.recheckRequestedAt = clone(retryAt);
      return 1;
    }
    throw new Error(`Unhandled isolated SQL write: ${text.slice(0, 90)}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks();
  vi.stubGlobal("fetch", boundary.forbidden);
  vi.stubEnv("RESEND_API_KEY", "offline-transport-key");
  vi.stubEnv("ALERT_EMAIL_FROM", "alerts@delivery.example");
  vi.stubEnv("EMAIL_ACTION_SECRET", "offline-stop-link-secret");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  events = []; sequence = 0;
  rows = Object.fromEntries([
    "user", "teeSearch", "course", "courseMonitoringStatus", "courseMonitoringEvent",
    "courseSupportIncident", "courseBookingFact", "courseProbe", "teeTimeMatch",
    "localReaderJob", "searchEmailDelivery", "automationRun", "providerRequestLease"
  ].map((model) => [model, []]));
  rows.user.push({ id: "offline-user", email: owner, pendingEmail: null });
  rows.teeSearch.push({
    id: lease.searchId, userId: "offline-user", status: "ACTIVE", syntheticMultiCycle: false,
    trafficClass: "TEST", alertGeneration: 0, scheduleVersion: 2, checkStatus: "CHECKING",
    checkLeaseToken: lease.token, checkLeaseExpiresAt: lease.expiresAt,
    createdAt: new Date("2026-07-28T12:00:00Z"), date: new Date("2026-07-30T00:00:00Z"),
    startTime: "07:00", endTime: "10:00", players: 2, requestedLayoutHoles: null,
    userTimeZone: "America/New_York", additionalEmails: [friend], alertEmail: null,
    statusEmailSnapshot: null, statusEmailSentAt: null, recheckRequestedAt: null,
    workflowRunId: null
  });
  rows.course.push({
    id: "offline-course", name: "Offline public course", address: "Offline fixture",
    timeZone: "America/New_York", isPublic: true, website: bookingUrl,
    detectedBookingUrl: bookingUrl, detectedPlatform: "CUSTOM", providerFamilyKey: "TENFORE",
    bookingMethod: "PUBLIC_ONLINE", bookingAccessMode: "PUBLIC_SIGNED_OUT",
    automationEligibility: "ALLOWED", automationReason: "NONE", monitoringMode: "LOCAL_READER_ONLY",
    bookingMetadata: null, policyNotes: null, intelligenceVerifiedAt: new Date("2026-07-27T12:00:00Z"),
    phone: null, bookingPhone: null, layoutHoleCounts: [], bookableHoleCounts: [],
    bookingWindowDays: null, bookingWindowCheckedAt: now
  });
  rows.courseMonitoringStatus.push({
    courseId: "offline-course", state: "HEALTHY", stateChangedAt: priorSuccess, revision: 1,
    lastSuccessfulAt: priorSuccess, lastFailureAt: null, revalidationRequestedAt: null,
    nextAutomaticAttemptAt: null, firstDegradedAt: null, failureFingerprint: null, consecutiveFailures: 0
  });
  rows.courseSupportIncident.push({
    id: "offline-incident", courseId: "offline-course", cycle: 1, status: "RESOLVED",
    resolution: "MONITORING_RESTORED", attemptLedger: null, activeBatchId: null,
    lastSeenAt: priorSuccess, confirmedAt: priorSuccess, revision: 1, decisionAt: null
  });
  rows.localReaderJob.push({
    id: "offline-reader-job", teeSearchId: lease.searchId, courseId: "offline-course",
    courseKey: "tenfore:offline-fixture", purpose: "ALERT_CHECK", status: "COMPLETED",
    scheduleVersion: 1, resumeFromScheduleVersion: 1, resumeScheduleVersion: 2,
    targetDate: "2026-07-30", players: 2, bookingUrl,
    requiredCapabilityKey: "TENFORE_RENDERED", requiredParserVersion: 2,
    claimedAt: sourceAt, completedAt, resultExpiresAt: new Date("2026-07-29T12:19:20Z"),
    result: {
      jobId: "offline-reader-job", courseKey: "tenfore:offline-fixture", status: "AVAILABLE",
      evidenceAnchor: "SERVER_CLAIM", observedAt: sourceAt.toISOString(), pageUrl: bookingUrl,
      pageTitle: "Offline fixture", readerVersion: "tenfore-rendered-v2",
      slots: [{ startsAtLocal: "2026-07-30T08:10:00", timeLabel: "8:10 AM", holes: [18],
        minimumPlayers: 1, availableSpots: 4, priceCents: 4200, cartIncluded: false }]
    }
  });
  Object.keys(rows).forEach(installModel); installSql();
});

afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("completed reader source through ordinary match delivery", () => {
  it("delivers a newly created match using the consumed provider observation time", async () => {
    expect(rows.teeTimeMatch).toHaveLength(0);
    expect(rows.searchEmailDelivery).toHaveLength(0);
    boundary.send.mockImplementation(async () => {
      expect(rows.localReaderJob[0].resultExpiresAt).toEqual(completedAt);
      events.push("transport:accepted");
      return { data: { id: "offline-provider-acceptance" }, error: null };
    });
    const checked = await runSearchCheck(lease.searchId, "test", lease);
    expect(checked.courseResults[0].outcome).toBe("MATCH_FOUND");
    expect(rows.localReaderJob[0].resultExpiresAt).toEqual(completedAt);
    expect(rows.teeTimeMatch).toHaveLength(1);
    expect(rows.teeTimeMatch[0].firstSeenAt).toEqual(now);
    expect.soft(rows.teeTimeMatch[0].lastConfirmedAt).toEqual(sourceAt);
    expect(rows.courseMonitoringStatus[0].lastSuccessfulAt).toEqual(sourceAt);
    expect.soft(boundary.send).toHaveBeenCalledTimes(2);
    expect.soft(events.indexOf("reader:consumed")).toBeLessThan(events.indexOf("transport:accepted"));
    expect.soft(rows.searchEmailDelivery.map((row) => row.status)).toEqual(["SENT", "SENT"]);
    expect(boundary.forbidden).not.toHaveBeenCalled();
  });

  it("consumes the source before owner delivery and preserves independent retry and pause fences", async () => {
    const observation = await getFreshLocalReaderObservation({
      searchId: lease.searchId, courseId: "offline-course", scheduleVersion: 2,
      targetDate: "2026-07-30", players: 2, bookingUrl
    });
    expect(observation?.teeSheet?.slots).toHaveLength(1);
    const slot = observation!.teeSheet!.slots[0];
    rows.teeTimeMatch.push({
      id: "historical-match", teeSearchId: lease.searchId, courseId: "offline-course",
      sourceId: slot.sourceId, startsAt: new Date("2026-07-30T12:10:00Z"),
      bookingUrl, availableSpots: 4, priceCents: 4200, holes: 18,
      alertStatus: "PENDING", availabilityStatus: "AVAILABLE", availabilityCycle: 0,
      firstSeenAt: priorSuccess, lastSeenAt: priorSuccess, lastConfirmedAt: priorSuccess,
      sentAt: null, unavailableAt: null
    });
    const payload = {
      schemaVersion: 2 as const, checkedAt: now.toISOString(), matchIds: ["historical-match"],
      matchRefs: [{ matchId: "historical-match", availabilityCycle: 0 }],
      displayMatchIds: ["historical-match"], satisfiesStatusReport: false,
      matchReport: { targetDate: "2026-07-30", startTime: "07:00", endTime: "10:00", players: 2,
        requestedLayoutHoles: null, userTimeZone: "America/New_York", matches: [{
          matchId: "historical-match", courseId: "offline-course", courseName: "Offline public course",
          courseTimeZone: "America/New_York", startsAt: "2026-07-30T12:10:00.000Z", availableSpots: 4,
          bookingUrl, priceCents: 4200, holes: 18, bookableHoleCounts: [18], isNew: true
        }] }
    };
    const group = { searchId: lease.searchId, alertGeneration: 0, checkLeaseToken: lease.token,
      kind: "MATCH" as const, groupKey: "offline-existing-obligation" };
    expect(await prepareSearchEmailDeliveryGroup({ ...group, recipients: [owner, friend], ownerRecipient: owner, payload })).toMatchObject({ prepared: true });
    const beforeConsumptionSend = vi.fn();
    await expect(drainSearchEmailDeliveryGroup({ ...group, send: beforeConsumptionSend }))
      .rejects.toMatchObject({ code: "SEARCH_EMAIL_DELIVERY_DEFERRED" });
    expect(beforeConsumptionSend).not.toHaveBeenCalled();
    expect(rows.searchEmailDelivery.every((row) => row.attemptCount === 0)).toBe(true);
    expect(rows.localReaderJob[0].resultExpiresAt).not.toEqual(completedAt);

    const attempts: { recipient: string; key: string; snapshot: unknown }[] = [];
    boundary.send.mockImplementation(async (input: { to: string; subject: string; html: string }, options: { headers: { "Idempotency-Key": string } }) => {
      expect(rows.localReaderJob[0].resultExpiresAt).toEqual(completedAt);
      events.push(`transport:${input.to === owner ? "owner" : "additional"}`);
      attempts.push({ recipient: input.to, key: options.headers["Idempotency-Key"], snapshot: clone({ subject: input.subject, html: input.html }) });
      if (input.to === friend) return { data: null, error: { name: "application_error", message: "Offline additional-recipient transport failure" } };
      return { data: { id: "offline-provider-acceptance" }, error: null };
    });
    vi.setSystemTime(new Date(now.getTime() + 60_001));
    const checked = await runSearchCheck(lease.searchId, "test", lease);
    expect(checked.courseResults[0].outcome).toBe("MATCH_FOUND");
    expect(events.indexOf("reader:consumed")).toBeLessThan(events.indexOf("transport:owner"));
    expect(attempts.filter((attempt) => attempt.recipient === owner)).toHaveLength(1);
    expect(rows.searchEmailDelivery.find((row) => row.recipient === owner)?.status).toBe("SENT");
    const additional = rows.searchEmailDelivery.find((row) => row.recipient === friend)!;
    expect(additional.status).toBe("FAILED");
    const persistedPayload = clone(additional.payload);

    const retrySend = async (input: { recipient: string; idempotencyKey: string; payload: unknown; assertCurrentDelivery: () => Promise<void> }) => {
      const alert = await hydrateMatchAlertPayload({ searchId: lease.searchId, alertGeneration: 0, payload: input.payload });
      await input.assertCurrentDelivery();
      return sendTeeTimeAlert({ searchId: lease.searchId, to: input.recipient, ...alert, stableIdempotencyKey: input.idempotencyKey });
    };
    vi.setSystemTime(new Date((additional.nextAttemptAt as Date).getTime() + 1));
    await expect(drainSearchEmailDeliveryGroup({ ...group, send: retrySend })).rejects.toThrow("Offline additional-recipient transport failure");
    const friendAttempts = attempts.filter((attempt) => attempt.recipient === friend);
    expect(friendAttempts).toHaveLength(2);
    expect(friendAttempts[1]).toEqual(friendAttempts[0]);
    expect(rows.searchEmailDelivery.find((row) => row.recipient === friend)?.payload).toEqual(persistedPayload);
    expect(attempts.filter((attempt) => attempt.recipient === owner)).toHaveLength(1);

    const transaction = boundary.prisma as never;
    await lockSearchForAlertMutation(transaction, { searchId: lease.searchId, userId: "offline-user" });
    const searchModel = boundary.prisma.teeSearch as { update: (query: Query) => Promise<unknown> };
    await searchModel.update({ where: { id: lease.searchId }, data: {
      status: "PAUSED", alertGeneration: { increment: 1 }, scheduleVersion: { increment: 1 },
      checkStatus: "STOPPED", checkLeaseToken: null, checkLeaseExpiresAt: null
    } });
    const attemptCount = attempts.length;
    await drainSearchEmailDeliveryGroup({ ...group, send: retrySend });
    expect(attempts).toHaveLength(attemptCount);
    expect(rows.searchEmailDelivery.find((row) => row.recipient === friend)?.status).toBe("SUPPRESSED");
    expect(boundary.forbidden).not.toHaveBeenCalled();
  });
});
