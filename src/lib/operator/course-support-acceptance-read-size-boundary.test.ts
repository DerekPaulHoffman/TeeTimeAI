import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AcceptanceBytePreflightFence, createAcceptanceBytePreflight } from "./course-support-acceptance-read-size-boundary";
import { createAcceptanceReadCost } from "./course-support-acceptance-read-cost";

function fixture(input: { maxBytes?: number; maxIdentityItems?: number } = {}) {
  const models = Object.fromEntries(Prisma.dmmf.datamodel.models.map((model) => [
    model.name[0].toLowerCase() + model.name.slice(1),
    {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  ]));
  const sql = vi.fn(async (query: Prisma.Sql) => [{ bytes: weightedBytes(query, () => 10n), matchedRows: BigInt(selectedIds(query).length) }]);
  const tick = vi.fn();
  const transaction = { ...models, $queryRaw: sql } as unknown as Prisma.TransactionClient;
  return {
    models, sql, tick, transaction,
    preflight: createAcceptanceBytePreflight(transaction, { tick, maxBytes: input.maxBytes ?? 16_777_216,
      maxIdentityItems: input.maxIdentityItems }),
  };
}

function selectedIdentityWeights(query: Prisma.Sql) {
  const parameters = query.text.match(/JOIN \(VALUES ([\s\S]+?)\) AS acceptance_weight\(identity, occurrences\)/u)?.[1];
  if (!parameters || !/^\(\$\d+::text, \$\d+::bigint\)(?:,\s*\(\$\d+::text, \$\d+::bigint\))*$/u.test(parameters)) {
    throw new Error("Unexpected weighted identity scope.");
  }
  const pairs = [...parameters.matchAll(/\(\$(\d+)::text, \$(\d+)::bigint\)/gu)].map((match) => {
    const identity = query.values[Number(match[1]) - 1];
    const occurrences = query.values[Number(match[2]) - 1];
    if (typeof identity !== "string" || typeof occurrences !== "bigint" || occurrences < 1n) {
      throw new Error("Unexpected weighted identity parameters.");
    }
    return { identity, occurrences };
  });
  if (pairs.length === 0 || new Set(pairs.map(({ identity }) => identity)).size !== pairs.length) {
    throw new Error("Unexpected weighted identity cardinality.");
  }
  return pairs;
}

function selectedIds(query: Prisma.Sql) {
  return selectedIdentityWeights(query).map(({ identity }) => identity);
}

function weightedBytes(query: Prisma.Sql, bytesForIdentity: (identity: string) => bigint) {
  return selectedIdentityWeights(query).reduce((bytes, { identity, occurrences }) =>
    bytes + bytesForIdentity(identity) * occurrences, 0n);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function selectedFields(query: Prisma.Sql) {
  return [...query.text.matchAll(/\$(\d+)::text,\s*acceptance_row\."([A-Za-z_][A-Za-z0-9_]*)"/gu)]
    .map((match) => ({ key: query.values[Number(match[1]) - 1], column: match[2] }));
}

function batchOccurrenceFixture(occurrences: readonly [number, number], maxBytes: number) {
  const actual = fixture({ maxBytes });
  const rows = occurrences.flatMap((count, batch) => Array.from({ length: count }, (_, entry) => ({
    id: `private-entry-${batch}-${entry}`,
    batch: { id: batch === 0 ? "private-shared-batch" : "private-singleton-batch" },
  })));
  const query = {
    where: { result: "FINAL_DISPOSITION", verifiedAt: { not: null },
      batch: { status: { in: ["SUCCEEDED", "PARTIAL"] } } },
    orderBy: [{ batch: { completedAt: "desc" } }, { id: "desc" }],
    select: { id: true, batch: { select: { summary: true } } },
  };
  actual.models.courseSupportBatchIncident.count.mockResolvedValue(rows.length);
  actual.models.courseSupportBatch.count.mockResolvedValue(2);
  actual.models.courseSupportBatchIncident.findMany.mockResolvedValue(rows);
  actual.sql.mockImplementation(async (statement) => [{
    bytes: weightedBytes(statement, (identity) => identity === "private-singleton-batch" ? 100n : 10n),
    matchedRows: BigInt(selectedIds(statement).length),
  }]);
  // Every root element retains its relation-key/array envelope and its own
  // scalar bytes; each related batch payload is charged on every appearance.
  const envelopeBytes = 2 + rows.length - 1 + rows.length * (Buffer.byteLength(JSON.stringify("batch"), "utf8") + 2);
  const expectedBytes = 2 * (envelopeBytes + rows.length * 10 + occurrences[0] * 10 + occurrences[1] * 100);
  return { ...actual, rows, query, envelopeBytes, expectedBytes };
}

describe("native acceptance database byte preflight", () => {
  it("uses current generated-client single-ID/list metadata for a complete compatible read", async () => {
    const { models, sql, preflight } = fixture();
    models.course.findMany.mockResolvedValue([{ id: "private-course", monitoringStatus: { courseId: "private-course" } }]);

    await preflight("course", "findMany", { select: { monitoringStatus: { select: { state: true } } } });

    expect(sql).toHaveBeenCalledTimes(2);
    expect(models.course.findMany).toHaveBeenCalledExactlyOnceWith({ select: {
      id: true, monitoringStatus: { select: { courseId: true } },
    } });
  });
  it("retains deterministic root scopes while covering physical nested-list scopes with selected identities", async () => {
    const { models, sql, preflight } = fixture();
    const where = { id: { in: ["private-incident"] }, cycle: 4 };
    const query = { where, orderBy: [{ id: "asc" }], select: {
      attemptLedger: true,
      batchIncidents: { where: { cycle: 4 }, take: 21, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { proofSnapshot: true, verificationRequests: { where: { status: "QUEUED" }, select: { evidence: true } } } },
      course: { select: { bookingMetadata: true, preferences: { where: { teeSearch: { status: "ACTIVE" } }, select: { id: true } },
        monitoringStatus: { select: { state: true } } } },
    } };
    models.courseSupportIncident.findMany.mockResolvedValue([{ id: "private-incident",
      batchIncidents: [{ id: "private-entry", verificationRequests: [{ id: "private-request" }] }],
      course: { id: "private-course", preferences: [{ id: "private-preference" }],
        monitoringStatus: { courseId: "private-course" } },
    }]);

    await preflight("courseSupportIncident", "findMany", query);

    expect(models.courseSupportIncident.findMany).toHaveBeenCalledExactlyOnceWith({ where,
      orderBy: [{ id: "asc" }], select: { id: true,
        batchIncidents: { where: { cycle: 4 }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, verificationRequests: { where: { status: "QUEUED" }, select: { id: true } } } },
        course: { select: { id: true, preferences: { where: { teeSearch: { status: "ACTIVE" } }, select: { id: true } },
          monitoringStatus: { select: { courseId: true } } } },
      } });
    expect(sql).toHaveBeenCalledTimes(6);
    const statements = sql.mock.calls.map(([statement]) => statement);
    expect(statements.every((statement) => statement.text.includes("SUM((octet_length(") && statement.text.includes("jsonb_build_object(") &&
      statement.text.includes("* acceptance_weight.occurrences"))).toBe(true);
    expect(statements.every((statement) => !statement.text.includes("private-"))).toBe(true);
    expect(statements.find((statement) => statement.text.includes('FROM "CourseMonitoringStatus"'))?.text)
      .toMatch(/acceptance_row\."courseId"::text = acceptance_weight\.identity/u);
    expect(models.courseSupportVerificationRequest.count).toHaveBeenCalledWith({ where: { AND: [
      { status: "QUEUED" }, { batchIncident: { is: { AND: [{ cycle: 4 }, { incident: { is: where } }] } } },
    ] } });
    expect(query.select).toHaveProperty("attemptLedger", true);
    expect(query.select.batchIncidents.take).toBe(21);
  });

  it("rejects oversized selected nested JSON before the full native evidence query", async () => {
    const { models, sql, transaction, preflight } = fixture({ maxBytes: 100 });
    const query = { where: { id: "private-incident" }, select: {
      monitoringEvents: { select: { audit: true } },
    } };
    models.courseSupportIncident.findMany.mockResolvedValue([{ id: "private-incident",
      monitoringEvents: [{ id: "private-event" }],
    }]);
    sql.mockImplementation(async (statement) => [{
      bytes: statement.text.includes('FROM "CourseMonitoringEvent"') ? 51n : 0n,
      matchedRows: 1n,
    }]);

    await expect((async () => {
      await preflight("courseSupportIncident", "findMany", query);
      return transaction.courseSupportIncident.findMany(query);
    })()).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES" });

    expect(models.courseSupportIncident.findMany).toHaveBeenCalledTimes(1);
    expect(models.courseSupportIncident.findMany.mock.calls[0][0].select).toEqual({
      id: true, monitoringEvents: { select: { id: true } },
    });
  });

  it("preserves distinct keys while covering ordered distinct's physical history without a native tie-breaker", async () => {
    const { models, preflight } = fixture();
    const query = { where: { courseId: "private-course" }, distinct: ["courseId"],
      orderBy: [{ observedAt: "desc" }, { id: "desc" }], take: 1, select: { outcome: true } };
    models.courseProbe.findMany.mockResolvedValue([{ id: "private-probe", courseId: "private-course" }]);

    await preflight("courseProbe", "findMany", query);

    expect(models.courseProbe.findMany).toHaveBeenCalledExactlyOnceWith({
      where: query.where, orderBy: query.orderBy, select: { id: true, courseId: true },
    });
    expect(query.select).toEqual({ outcome: true });
    expect(query.take).toBe(1);
    expect(query.distinct).toEqual(["courseId"]);
  });

  it("preserves pure top-level ID-ordered SQL pagination", async () => {
    const { models, preflight } = fixture();
    const query = { where: { courseId: "private-course" }, orderBy: [{ observedAt: "desc" }, { id: "desc" }],
      take: 1, skip: 1, cursor: { id: "private-cursor" }, select: { rawSummary: true } };
    models.courseProbe.findMany.mockResolvedValue([{ id: "private-probe" }]);

    await preflight("courseProbe", "findMany", query);

    expect(models.courseProbe.findMany).toHaveBeenCalledExactlyOnceWith({ ...query, select: { id: true } });
    expect(query.select).toEqual({ rawSummary: true });
  });

  it("refuses an oversized older payload before ID-ordered distinct and memory pagination can discard it", async () => {
    const { models, sql, transaction, preflight } = fixture();
    const history = [{ id: "private-newer-probe", courseId: "private-course" },
      { id: "private-older-probe", courseId: "private-course" }];
    const query = { where: { courseId: "private-course" }, orderBy: [{ observedAt: "desc" }, { id: "desc" }],
      distinct: ["courseId"], take: 1, skip: 1, cursor: { id: "private-newer-probe" }, select: { rawSummary: true } };
    models.courseProbe.count.mockResolvedValue(2);
    models.courseProbe.findMany.mockImplementation(async (args) => args.distinct ? history.slice(0, 1) : history);
    const olderPayload = { retainedObservation: "x".repeat(16_777_217) };
    sql.mockImplementation(async (statement) => [{
      bytes: weightedBytes(statement, (identity) => identity === "private-older-probe"
        ? BigInt(Buffer.byteLength(JSON.stringify({ rawSummary: olderPayload }), "utf8")) : 10n),
      matchedRows: BigInt(selectedIds(statement).length),
    }]);

    await expect((async () => {
      await preflight("courseProbe", "findMany", query);
      return transaction.courseProbe.findMany(query);
    })()).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES" });

    expect(models.courseProbe.findMany).toHaveBeenCalledExactlyOnceWith({
      where: query.where, orderBy: query.orderBy, select: { id: true, courseId: true },
    });
    expect(selectedIds(sql.mock.calls[0][0])).toEqual(history.map(({ id }) => id));
    expect(selectedFields(sql.mock.calls[0][0])).toEqual([{ key: "rawSummary", column: "rawSummary" }]);
    expect(query).toMatchObject({ distinct: ["courseId"], take: 1, skip: 1,
      cursor: { id: "private-newer-probe" }, select: { rawSummary: true } });
  });

  it("bounds all physical rows of ID-ordered distinct before fetching identities", async () => {
    const { models, sql, preflight } = fixture();
    models.courseProbe.count.mockResolvedValue(16_385);
    const query = { where: { courseId: "private-course" }, orderBy: [{ observedAt: "desc" }, { id: "desc" }],
      distinct: ["courseId"], take: 1, select: { rawSummary: true } };

    await expect(preflight("courseProbe", "findMany", query)).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "IDENTITY_PRECOUNT_ITEMS",
    });

    expect(models.courseProbe.count).toHaveBeenCalledExactlyOnceWith({ where: query.where });
    expect(models.courseProbe.findMany).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
    expect(query.take).toBe(1);
  });

  it("refuses an oversized sixth audit in the physical history behind ID-ordered parking pagination", async () => {
    const { models, sql, transaction, preflight } = fixture();
    const events = Array.from({ length: 6 }, (_, index) => ({ id: `private-parking-${index}` }));
    const query = { where: { id: "private-incident" }, select: {
      monitoringEvents: { where: { eventType: "HUMAN_REVIEW_REQUESTED" },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 5, select: { audit: true } },
    } };
    models.courseMonitoringEvent.count.mockResolvedValue(6);
    models.courseSupportIncident.findMany.mockImplementation(async (args) => [{ id: "private-incident",
      monitoringEvents: events.slice(0, args.select.monitoringEvents.take ?? events.length),
    }]);
    const olderAudit = { retainedProof: "x".repeat(16_777_217) };
    sql.mockImplementation(async (statement) => [{
      bytes: weightedBytes(statement, (identity) => identity === "private-parking-5"
        ? BigInt(Buffer.byteLength(JSON.stringify({ audit: olderAudit }), "utf8")) : 10n),
      matchedRows: BigInt(selectedIds(statement).length),
    }]);

    await expect((async () => {
      await preflight("courseSupportIncident", "findMany", query);
      return transaction.courseSupportIncident.findMany(query);
    })()).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES" });

    expect(models.courseSupportIncident.findMany).toHaveBeenCalledExactlyOnceWith({ where: query.where, select: {
      id: true, monitoringEvents: { where: query.select.monitoringEvents.where,
        orderBy: query.select.monitoringEvents.orderBy, select: { id: true } },
    } });
    const auditSizing = sql.mock.calls.find(([statement]) => statement.text.includes('FROM "CourseMonitoringEvent"'))![0];
    expect(selectedIds(auditSizing)).toEqual(events.map(({ id }) => id));
    expect(selectedFields(auditSizing)).toEqual([{ key: "audit", column: "audit" }]);
    expect(query.select.monitoringEvents.take).toBe(5);
    expect(query.select.monitoringEvents.select).toEqual({ audit: true });
  });

  it("bounds raw ID-ordered nested history before fetching identities rather than counting only five winners", async () => {
    const { models, sql, preflight } = fixture();
    models.courseMonitoringEvent.count.mockResolvedValue(16_385);
    const where = { id: "private-incident" };

    await expect(preflight("courseSupportIncident", "findMany", { where, select: {
      monitoringEvents: { where: { eventType: "HUMAN_REVIEW_REQUESTED" },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 5, select: { audit: true } },
    } })).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "IDENTITY_PRECOUNT_ITEMS" });

    expect(models.courseMonitoringEvent.count).toHaveBeenCalledExactlyOnceWith({ where: { AND: [
      { eventType: "HUMAN_REVIEW_REQUESTED" }, { incident: { is: where } },
    ] } });
    expect(models.courseSupportIncident.findMany).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([
    { take: 5 },
    { take: 5, skip: 1 },
    { take: 5, cursor: { id: "private-cursor" } },
    { take: 5, distinct: ["eventType"] },
  ])("covers the whole physical metadata scope for ID-ordered nested pagination %j", async (pagination) => {
    const { models, sql, preflight } = fixture();
    const query = { where: { isPublic: true }, orderBy: { id: "asc" }, take: 2, select: {
      supportIncident: { select: { monitoringEvents: {
        where: { eventType: "HUMAN_REVIEW_REQUESTED" }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        ...pagination, select: { id: true, eventType: true, occurredAt: true },
      } } },
    } };
    const events = Array.from({ length: 6 }, (_, index) => ({ id: `private-metadata-${index}`,
      ...("distinct" in pagination ? { eventType: "HUMAN_REVIEW_REQUESTED" } : {}),
    }));
    models.courseMonitoringEvent.count.mockResolvedValue(6);
    models.course.findMany.mockResolvedValue([{ id: "private-course", supportIncident: {
      id: "private-incident", monitoringEvents: events,
    } }]);

    await preflight("course", "findMany", query);

    expect(models.course.findMany).toHaveBeenCalledExactlyOnceWith({ where: query.where, orderBy: query.orderBy, take: 2, select: {
      id: true, supportIncident: { select: { id: true, monitoringEvents: {
        where: query.select.supportIncident.select.monitoringEvents.where,
        orderBy: query.select.supportIncident.select.monitoringEvents.orderBy,
        select: { id: true, ...("distinct" in pagination ? { eventType: true } : {}) },
      } } },
    } });
    const metadataSizing = sql.mock.calls.find(([statement]) => statement.text.includes('FROM "CourseMonitoringEvent"'))![0];
    expect(selectedIdentityWeights(metadataSizing)).toEqual(events.map(({ id }) => ({ identity: id, occurrences: 1n })));
    expect(selectedFields(metadataSizing)).toEqual([
      { key: "id", column: "id" }, { key: "eventType", column: "eventType" }, { key: "occurredAt", column: "occurredAt" },
    ]);
    expect(metadataSizing.text).not.toContain('acceptance_row."audit"');
    expect(query.select.supportIncident.select.monitoringEvents).toMatchObject(pagination);
    expect(query.take).toBe(2);
  });

  it("conservatively covers a nested list even when the root is a unique parent", async () => {
    const { models, preflight } = fixture();
    models.course.findUnique.mockResolvedValue({ id: "private-course", localReaderJobs: [{ id: "private-job" }] });
    const query = { where: { id: "private-course" }, select: { localReaderJobs: {
      where: { status: "COMPLETED" }, orderBy: [{ completedAt: "desc" }, { id: "desc" }], take: 1, select: { result: true },
    } } };

    await preflight("course", "findUnique", query);

    expect(models.course.findUnique).toHaveBeenCalledExactlyOnceWith({ where: query.where, select: {
      id: true, localReaderJobs: { where: query.select.localReaderJobs.where,
        orderBy: query.select.localReaderJobs.orderBy, select: { id: true } },
    } });
    expect(query.select.localReaderJobs.take).toBe(1);
  });

  it("covers every candidate for timestamp-tied distinct and nested take selections", async () => {
    const { models, preflight } = fixture();
    models.courseProbe.count.mockResolvedValue(2);
    models.courseProbe.findMany.mockResolvedValue([
      { id: "small-tied-probe", courseId: "private-course" },
      { id: "large-tied-probe", courseId: "private-course" },
    ]);
    const query = { where: { courseId: "private-course" }, orderBy: { observedAt: "desc" },
      distinct: ["courseId"], take: 1, skip: 1, cursor: { id: "private-cursor" }, select: { rawSummary: true } };
    await preflight("courseProbe", "findMany", query);
    expect(models.courseProbe.findMany).toHaveBeenCalledExactlyOnceWith({
      where: query.where, orderBy: query.orderBy, select: { id: true, courseId: true },
    });
    models.course.findMany.mockResolvedValue([{ id: "private-course", localReaderJobs: [{ id: "private-job" }] }]);
    await preflight("course", "findMany", { select: { localReaderJobs: {
      where: { status: "COMPLETED" }, orderBy: { completedAt: "desc" }, take: 1, select: { result: true },
    } } });
    expect(models.course.findMany).toHaveBeenCalledExactlyOnceWith({ select: { id: true, localReaderJobs: {
      where: { status: "COMPLETED" }, orderBy: { completedAt: "desc" }, select: { id: true },
    } } });
    expect(query).toHaveProperty("take", 1);
    expect(query).toHaveProperty("distinct", ["courseId"]);
    expect(query).toHaveProperty("skip", 1);
    expect(query).toHaveProperty("cursor", { id: "private-cursor" });
  });

  it("rejects repeated descendants of a shared to-one row before the identity query", async () => {
    const { models, sql, preflight } = fixture({ maxIdentityItems: 7 });
    models.coursePreference.count.mockResolvedValue(2);
    models.teeSearch.count.mockResolvedValue(1);
    models.courseProbe.count.mockResolvedValue(2);

    await expect(preflight("coursePreference", "findMany", { select: {
      teeSearch: { select: { probes: { select: { rawSummary: true } } } },
    } })).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "IDENTITY_PRECOUNT_ITEMS" });

    expect(models.courseProbe.count).toHaveBeenCalledTimes(1);
    expect(models.coursePreference.findMany).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("rejects an unbounded tied candidate superset before the identity query", async () => {
    const { models, sql, preflight } = fixture({ maxIdentityItems: 3 });
    models.localReaderJob.count.mockResolvedValue(4);

    await expect(preflight("localReaderJob", "findFirst", {
      where: { status: "COMPLETED" }, orderBy: { completedAt: "desc" }, select: { result: true },
    })).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "IDENTITY_PRECOUNT_ITEMS" });

    expect(models.localReaderJob.findMany).not.toHaveBeenCalled();
    expect(models.localReaderJob.findFirst).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("bounds a broadened nested candidate scope before fetching any identities", async () => {
    const { models, sql, preflight } = fixture({ maxIdentityItems: 3 });
    models.localReaderJob.count.mockResolvedValue(3);

    await expect(preflight("course", "findMany", { where: { id: "private-course" }, select: {
      localReaderJobs: { where: { status: "COMPLETED" }, take: 1, orderBy: { completedAt: "desc" }, select: { result: true } },
    } })).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "IDENTITY_PRECOUNT_ITEMS" });

    expect(models.localReaderJob.count).toHaveBeenCalledExactlyOnceWith({ where: { AND: [
      { status: "COMPLETED" }, { course: { is: { id: "private-course" } } },
    ] } });
    expect(models.course.findMany).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("parameterizes private IDs and uses only generated table/ID identifiers", async () => {
    const { models, sql, preflight } = fixture();
    const privateId = "private' UNION SELECT secret --";
    models.courseMonitoringStatus.findUnique.mockResolvedValue({ courseId: privateId });

    await preflight("courseMonitoringStatus", "findUnique", { where: { courseId: privateId }, select: { state: true } });

    expect(selectedIds(sql.mock.calls[0][0])).toEqual([privateId]);
    expect(selectedFields(sql.mock.calls[0][0])).toEqual([{ key: "state", column: "state" }]);
    expect(sql.mock.calls[0][0].text).not.toContain(privateId);
    expect(sql.mock.calls[0][0].text).toContain('FROM "CourseMonitoringStatus"');
    expect(sql.mock.calls[0][0].text).toContain('acceptance_row."courseId"::text');
    expect(selectedIdentityWeights(sql.mock.calls[0][0])).toEqual([{ identity: privateId, occurrences: 1n }]);
  });

  it("accounts conservatively for repeated related identities and cumulative queries", async () => {
    const { models, preflight } = fixture({ maxBytes: 250 });
    models.courseSupportBatchIncident.count.mockResolvedValue(2);
    models.courseSupportBatchIncident.findMany.mockResolvedValue([
      { id: "private-entry-a", batch: { id: "private-batch", ownerAutomationRun: { id: "private-run" } } },
      { id: "private-entry-b", batch: { id: "private-batch", ownerAutomationRun: { id: "private-run" } } },
    ]);
    const query = { select: { batch: { select: { ownerAutomationRun: { select: { notes: true } } } } } };
    await preflight("courseSupportBatchIncident", "findMany", query);
    models.course.findMany.mockResolvedValue([{ id: "private-course" }]);

    await expect(preflight("course", "findMany", {})).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES" });
  });

  it("charges a shared batch five times and a larger singleton only once in the native relation scope", async () => {
    const expected = batchOccurrenceFixture([5, 1], 16_777_216);
    const actual = batchOccurrenceFixture([5, 1], expected.expectedBytes);
    const unchangedQuery = structuredClone(actual.query);

    await actual.preflight("courseSupportBatchIncident", "findMany", actual.query);

    expect(actual.models.courseSupportBatchIncident.findMany).toHaveBeenCalledExactlyOnceWith({
      ...actual.query, select: { id: true, batch: { select: { id: true } } },
    });
    expect(actual.query).toEqual(unchangedQuery);
    expect(actual.sql).toHaveBeenCalledTimes(2);
    const batchStatement = actual.sql.mock.calls.map(([statement]) => statement)
      .find((statement) => statement.text.includes('FROM "CourseSupportBatch"'))!;
    expect(selectedIdentityWeights(batchStatement)).toEqual([
      { identity: "private-shared-batch", occurrences: 5n },
      { identity: "private-singleton-batch", occurrences: 1n },
    ]);
    expect(selectedFields(batchStatement)).toEqual([{ key: "summary", column: "summary" }]);
    expect(batchStatement.text).toContain("* acceptance_weight.occurrences");
    expect(batchStatement.text).not.toContain("private-");
    expect(2 * (actual.envelopeBytes + actual.rows.length * 10 + 5 * (10 + 100))).toBeGreaterThan(actual.expectedBytes);

    const under = batchOccurrenceFixture([5, 1], actual.expectedBytes - 1);
    await expect((async () => {
      await under.preflight("courseSupportBatchIncident", "findMany", under.query);
      return under.transaction.courseSupportBatchIncident.findMany(under.query as never);
    })()).rejects.toMatchObject({ reason: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES" });
    expect(under.models.courseSupportBatchIncident.findMany).toHaveBeenCalledTimes(1);
  });

  it.each([1, 3])("retains the same conservative total for uniform identity multiplicity %i", async (occurrences) => {
    const expected = batchOccurrenceFixture([occurrences, occurrences], 16_777_216);
    const actual = batchOccurrenceFixture([occurrences, occurrences], expected.expectedBytes);
    expect(actual.expectedBytes).toBe(2 * (actual.envelopeBytes + actual.rows.length * 10 + occurrences * (10 + 100)));
    await actual.preflight("courseSupportBatchIncident", "findMany", actual.query);
    const under = batchOccurrenceFixture([occurrences, occurrences], expected.expectedBytes - 1);
    await expect(under.preflight("courseSupportBatchIncident", "findMany", under.query)).rejects.toMatchObject({
      reason: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES",
    });
  });

  it("charges every duplicate again across repeated hydrations without a cumulative budget reset", async () => {
    const expected = batchOccurrenceFixture([5, 1], 16_777_216);
    const actual = batchOccurrenceFixture([5, 1], expected.expectedBytes * 2);
    await actual.preflight("courseSupportBatchIncident", "findMany", actual.query);
    await actual.preflight("courseSupportBatchIncident", "findMany", actual.query);
    expect(actual.sql).toHaveBeenCalledTimes(4);
    await expect(actual.preflight("courseSupportBatchIncident", "findMany", actual.query)).rejects.toMatchObject({
      reason: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES",
    });
    expect(actual.models.courseSupportBatchIncident.findMany).toHaveBeenCalledTimes(3);
  });

  it("requires distinct matched identities rather than total occurrence weight", async () => {
    const actual = batchOccurrenceFixture([5, 1], 16_777_216);
    actual.sql.mockImplementation(async (statement) => [{
      bytes: weightedBytes(statement, () => 10n),
      matchedRows: statement.text.includes('FROM "CourseSupportBatch"') ? 6n : BigInt(selectedIds(statement).length),
    }]);
    await expect(actual.preflight("courseSupportBatchIncident", "findMany", actual.query)).rejects.toMatchObject({
      reason: "READ_FAILED", boundary: null,
    });
  });

  it("accepts an absent unique row without querying row bytes", async () => {
    const { models, sql, preflight } = fixture();
    models.course.count.mockResolvedValue(0);

    await preflight("course", "findUnique", { where: { id: "missing-private-course" } });

    expect(models.course.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: "missing-private-course" }, select: { id: true } });
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([
    ["unknownDelegate", {}, "READ_FAILED", null],
    ["courseBookingFact", {}, "READ_FAILED", null],
    ["course", { select: { supportIncident: { select: { course: { select: { id: true } } } } } }, "EVIDENCE_BOUND_EXCEEDED", "IDENTITY_PLAN_DEPTH_OR_CYCLE"],
  ])("fails closed on unsupported metadata or a cyclic relation path for %s", async (model, query, message, boundary) => {
    const { models, sql, preflight } = fixture();
    await expect(preflight(model as string, "findMany", query)).rejects.toMatchObject({ message, boundary });
    expect(models.course.count).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("rejects malformed identities and aggregate evidence with opaque errors", async () => {
    const first = fixture();
    first.models.course.findMany.mockResolvedValue([{ id: "private-course", notes: "secret-private-notes" }]);
    await expect(first.preflight("course", "findMany", {})).rejects.toMatchObject({ message: "READ_FAILED", boundary: null });
    expect(first.sql).not.toHaveBeenCalled();
    const second = fixture();
    second.models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    second.sql.mockResolvedValue([{ bytes: 10n, matchedRows: 0n }]);
    await expect(second.preflight("course", "findMany", {})).rejects.toMatchObject({ message: "READ_FAILED", boundary: null });
    const third = fixture();
    third.models.course.findMany.mockRejectedValue(new Error("private-connection-details"));
    await expect(third.preflight("course", "findMany", {})).rejects.toMatchObject({ message: "READ_FAILED", boundary: null });
  });

  it.each(["P2028", "57014"])("preserves fixed timeout classification for native %s without private details", async (code) => {
    const { models, preflight } = fixture();
    models.course.count.mockRejectedValue(Object.assign(new Error("private-provider-connection"), { code }));

    const error = await preflight("course", "findMany", {}).catch((error) => error);
    expect(error).toMatchObject({ message: "READ_TIMEOUT", code });
    expect(error).not.toHaveProperty("readCost");
  });

  it("tags oversized identity result arrays before row-byte or native evidence reads", async () => {
    const { models, sql, preflight } = fixture({ maxIdentityItems: 1 });
    models.course.findMany.mockResolvedValue([{ id: "private-course-a" }, { id: "private-course-b" }]);
    await expect(preflight("course", "findMany", {})).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "IDENTITY_RESULT_ITEMS",
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it("tags oversized nested identity result arrays before byte reads", async () => {
    const { models, sql, preflight } = fixture({ maxIdentityItems: 2 });
    models.course.findMany.mockResolvedValue([{ id: "private-course", probes: [
      { id: "private-probe-a" }, { id: "private-probe-b" },
    ] }]);
    await expect(preflight("course", "findMany", { select: { probes: { select: { outcome: true } } } })).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "IDENTITY_RESULT_ITEMS",
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([false, true])("tags oversized identity values without retaining the value (distinct=%s)", async (distinct) => {
    const { models, sql, preflight } = fixture();
    if (distinct) models.courseProbe.findMany.mockResolvedValue([{ id: "private-probe", courseId: "private-course".repeat(100) }]);
    else models.courseProbe.findMany.mockResolvedValue([{ id: "private-probe".repeat(100) }]);
    await expect(preflight("courseProbe", "findMany", distinct ? { distinct: ["courseId"] } : {})).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "IDENTITY_VALUE_BYTES",
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it("preserves a recognized tick fence but rejects lookalike reason/boundary evidence", async () => {
    const actual = fixture();
    actual.tick.mockImplementation(() => { throw new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "QUERY_OPERATIONS"); });
    await expect(actual.preflight("course", "findMany", {})).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "QUERY_OPERATIONS",
    });
    expect(actual.models.course.count).not.toHaveBeenCalled();

    const forged = fixture();
    forged.models.course.count.mockRejectedValue(Object.assign(new Error("private-query-details"), {
      reason: "EVIDENCE_BOUND_EXCEEDED", boundary: "WHOLE_ROW_BYTES",
    }));
    await expect(forged.preflight("course", "findMany", {})).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: null,
    });
    expect(forged.models.course.findMany).not.toHaveBeenCalled();
    expect(forged.sql).not.toHaveBeenCalled();
  });

  it("keeps constructor defaults opaque and rejects non-fixed runtime boundary input", () => {
    expect(new AcceptanceBytePreflightFence("READ_FAILED")).toMatchObject({ message: "READ_FAILED", boundary: null, readCost: null });
    expect(new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "private-query" as never)).toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: null,
    });
  });

  it("detaches and freezes only validated cost snapshots on the selected-evidence fence", () => {
    const valid = createAcceptanceReadCost({ queryCategory: "PARKED_SNAPSHOT", component: "SELECTED_SCALARS",
      limitBytes: 23n, cumulativeBeforeComponentBytes: 4n, componentChargeBytes: 20n,
      attemptedCumulativeBytes: 24n, hydrationObservedBytes: 24n })!;
    const input = { ...valid };
    const error = new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES", input);
    input.queryCategory = "CAMPAIGN_RECORD";
    expect(error.readCost).toEqual(valid);
    expect(error.readCost).not.toBe(input);
    expect(Object.isFrozen(error.readCost)).toBe(true);
    expect(new AcceptanceBytePreflightFence("READ_FAILED", "SELECTED_EVIDENCE_BYTES", valid).readCost).toBeNull();
    expect(new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "QUERY_OPERATIONS", valid).readCost).toBeNull();
    expect(new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES",
      { ...valid, privateId: "private-course" } as never).readCost).toBeNull();
  });

  it("accepts exact equality and captures the unchanged scalar operands only when the limit is exceeded", async () => {
    const exact = fixture({ maxBytes: 24 });
    exact.models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    await exact.preflight("course", "findMany", { select: { id: true } }, "PARKED_SNAPSHOT");
    expect(exact.sql).toHaveBeenCalledTimes(1);

    const exceeded = fixture({ maxBytes: 23 });
    exceeded.models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    const error = await exceeded.preflight("course", "findMany", { select: { id: true } }).catch((error) => error);
    expect(error).toBeInstanceOf(AcceptanceBytePreflightFence);
    expect(error.readCost).toEqual({ version: 1, queryCategory: "UNCLASSIFIED", component: "SELECTED_SCALARS",
      basis: "OBSERVED_CONSERVATIVE_LOWER_BOUND", complete: false, saturated: false,
      limitBytes: 23, cumulativeBeforeComponentBytes: 4, componentChargeBytes: 20,
      attemptedCumulativeBytes: 24, hydrationObservedBytes: 24 });
    expect(exceeded.sql).toHaveBeenCalledTimes(1);
  });

  it("captures the total local structural envelope before its commit and stops before scalar reads", async () => {
    const actual = fixture({ maxBytes: 40 });
    actual.models.course.findMany.mockResolvedValueOnce([{ id: "private-first-course" }])
      .mockResolvedValueOnce([{ id: "private-next-course", preferences: [] }]);
    await actual.preflight("course", "findMany", { select: { id: true } });
    const error = await actual.preflight("course", "findMany",
      { select: { preferences: { select: { id: true } } } }, "PARKED_SNAPSHOT").catch((error) => error);
    expect(error.readCost).toEqual({ version: 1, queryCategory: "PARKED_SNAPSHOT", component: "STRUCTURAL_ENVELOPE",
      basis: "OBSERVED_CONSERVATIVE_LOWER_BOUND", complete: false, saturated: false,
      limitBytes: 40, cumulativeBeforeComponentBytes: 24, componentChargeBytes: 34,
      attemptedCumulativeBytes: 58, hydrationObservedBytes: 34 });
    expect(actual.sql).toHaveBeenCalledTimes(1); // Only the earlier successful hydration.
  });

  it("includes completed local scalar components without presenting the prefix as complete evidence", async () => {
    const actual = fixture({ maxBytes: 180 });
    actual.models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    actual.models.courseSupportIncident.findMany.mockResolvedValue([{ id: "private-incident",
      monitoringEvents: [{ id: "private-event" }] }]);
    actual.sql.mockImplementation(async (statement) => [{
      bytes: statement.text.includes('FROM "CourseMonitoringEvent"') ? 51n : 10n, matchedRows: 1n,
    }]);
    await actual.preflight("course", "findMany", { select: { id: true } });
    const error = await actual.preflight("courseSupportIncident", "findMany", { select: {
      monitoringEvents: { select: { audit: true } },
    } }, "MEMBER_OBSERVATIONS").catch((error) => error);
    expect(error.readCost).toMatchObject({ queryCategory: "MEMBER_OBSERVATIONS", component: "SELECTED_SCALARS", complete: false,
      limitBytes: 180, cumulativeBeforeComponentBytes: 92, componentChargeBytes: 102,
      attemptedCumulativeBytes: 194, hydrationObservedBytes: 170 });
    expect(JSON.stringify(error.readCost)).not.toContain("private-");
    expect(actual.sql).toHaveBeenCalledTimes(3);
  });

  it("keeps the first concurrent fence and immutable cost while in-flight reads settle without new work", async () => {
    const actual = fixture({ maxBytes: 40 });
    actual.models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    actual.models.automationRun.findMany.mockResolvedValue([{ id: "private-run" }]);
    const firstAggregate = deferred<Array<{ bytes: bigint; matchedRows: bigint }>>();
    const secondAggregate = deferred<Array<{ bytes: bigint; matchedRows: bigint }>>();
    actual.sql.mockImplementation((statement) => statement.text.includes('FROM "Course"')
      ? firstAggregate.promise : secondAggregate.promise);
    const first = actual.preflight("course", "findMany", { select: { id: true } }, "PARKED_SNAPSHOT").catch((error) => error);
    const second = actual.preflight("automationRun", "findMany", { select: { id: true } }, "CAMPAIGN_RECORD").catch((error) => error);
    await vi.waitFor(() => expect(actual.sql).toHaveBeenCalledTimes(2));
    firstAggregate.resolve([{ bytes: 20n, matchedRows: 1n }]);
    const error = await first;
    expect(error.readCost).toMatchObject({ queryCategory: "PARKED_SNAPSHOT", cumulativeBeforeComponentBytes: 8,
      componentChargeBytes: 40, attemptedCumulativeBytes: 48, hydrationObservedBytes: 44 });
    const snapshot = error.readCost;
    const tickCount = actual.tick.mock.calls.length;
    const later = await actual.preflight("courseProbe", "findMany", {}, "CURRENT_CYCLE_HISTORY").catch((error) => error);
    expect(later).toBe(error);
    expect(actual.models.courseProbe.count).not.toHaveBeenCalled();
    expect(actual.models.courseProbe.findMany).not.toHaveBeenCalled();
    secondAggregate.resolve([{ bytes: 1_000n, matchedRows: 1n }]);
    expect(await second).toBe(error);
    expect(error.readCost).toBe(snapshot);
    expect(error.readCost.attemptedCumulativeBytes).toBe(48);
    expect(actual.tick).toHaveBeenCalledTimes(tickCount);
    expect(actual.sql).toHaveBeenCalledTimes(2);
  });

  it("latches a recognized tick fence without manufacturing byte cost or issuing subsequent queries", async () => {
    const actual = fixture();
    const error = new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "QUERY_OPERATIONS");
    actual.tick.mockImplementation(() => { throw error; });
    const first = await actual.preflight("course", "findMany", {}, "PARKED_SNAPSHOT").catch((failure) => failure);
    expect(first).toBe(error);
    expect(first.readCost).toBeNull();
    actual.tick.mockReset();
    const later = await actual.preflight("automationRun", "findMany", {}, "CAMPAIGN_RECORD").catch((failure) => failure);
    expect(later).toBe(error);
    expect(actual.tick).not.toHaveBeenCalled();
    expect(actual.models.automationRun.count).not.toHaveBeenCalled();
    expect(actual.sql).not.toHaveBeenCalled();
  });

  it("does not start identity or scalar queries after an already in-flight count settles past the first fence", async () => {
    const actual = fixture({ maxBytes: 23 });
    actual.models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    const pendingCount = deferred<number>();
    actual.models.automationRun.count.mockImplementation(() => pendingCount.promise);
    const first = actual.preflight("course", "findMany", { select: { id: true } }, "PARKED_SNAPSHOT").catch((error) => error);
    const second = actual.preflight("automationRun", "findMany", { select: { id: true } }, "CAMPAIGN_RECORD").catch((error) => error);
    const error = await first;
    expect(actual.models.automationRun.count).toHaveBeenCalledTimes(1);
    const tickCount = actual.tick.mock.calls.length;
    pendingCount.resolve(1);
    expect(await second).toBe(error);
    expect(actual.models.automationRun.findMany).not.toHaveBeenCalled();
    expect(actual.tick).toHaveBeenCalledTimes(tickCount);
    expect(actual.sql).toHaveBeenCalledTimes(1);
  });

  it("sizes only selected scalar columns and excludes false or undefined fields", async () => {
    const { models, sql, preflight } = fixture({ maxBytes: 100 });
    models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    sql.mockImplementation(async (statement) => [{
      bytes: selectedFields(statement).some(({ key }) => key === "bookingMetadata") ? 1_000_000n : 10n,
      matchedRows: BigInt(selectedIds(statement).length),
    }]);
    const query = { select: { id: true, bookingMetadata: false, policyNotes: undefined } };
    await preflight("course", "findMany", query);
    expect(selectedFields(sql.mock.calls[0][0])).toEqual([{ key: "id", column: "id" }]);
    expect(sql.mock.calls[0][0].text).not.toContain("to_jsonb(acceptance_row)");
    expect(query.select).toEqual({ id: true, bookingMetadata: false, policyNotes: undefined });

    await expect(preflight("course", "findMany", { select: { bookingMetadata: true } })).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES",
    });
  });

  it.each([{}, { select: null }, { include: null }, { select: null, include: null }])("sizes every default scalar for nullable/default selectors %s", async (query) => {
    const { models, sql, preflight } = fixture({ maxBytes: 100 });
    models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    sql.mockImplementation(async (statement) => [{
      bytes: selectedFields(statement).some(({ key }) => key === "bookingMetadata") ? 1_000_000n : 10n,
      matchedRows: BigInt(selectedIds(statement).length),
    }]);
    await expect(preflight("course", "findMany", query)).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES",
    });
    const nativeScalars = Prisma.dmmf.datamodel.models.find((model) => model.name === "Course")!.fields
      .filter((field) => field.kind !== "object").map((field) => field.name).sort();
    expect(selectedFields(sql.mock.calls[0][0]).map(({ key }) => key).sort()).toEqual(nativeScalars);
  });

  it("retains default and relation:true selections alongside nullable native selectors", async () => {
    const { models, sql, preflight } = fixture();
    models.courseSupportIncident.findMany.mockResolvedValue([{ id: "private-incident", course: { id: "private-course" } }]);
    const query = { select: null, include: { course: true } };
    await preflight("courseSupportIncident", "findMany", query);
    for (const modelName of ["CourseSupportIncident", "Course"]) {
      const statement = sql.mock.calls.map(([query]) => query).find((query) => query.text.includes(`FROM "${modelName}"`))!;
      const nativeScalars = Prisma.dmmf.datamodel.models.find((model) => model.name === modelName)!.fields
        .filter((field) => field.kind !== "object").map((field) => field.name).sort();
      expect(selectedFields(statement).map(({ key }) => key).sort()).toEqual(nativeScalars);
      const chunks = statement.text.split("jsonb_build_object(").slice(1);
      expect(chunks.every((chunk) => [...chunk.matchAll(/\$\d+::text,/gu)].length <= 50)).toBe(true);
    }
    expect(query.select).toBeNull();
    expect(query.include.course).toBe(true);
  });

  it("unions projections when one native model and identity occur through different branches", async () => {
    const { models, sql, preflight } = fixture({ maxBytes: 500 });
    models.course.findMany.mockResolvedValue([{ id: "private-course", probes: [
      { id: "private-probe", automationRun: { id: "private-owner" } },
    ], supportIncident: { id: "private-incident", batchIncidents: [
      { id: "private-entry", batch: { id: "private-batch", ownerAutomationRun: { id: "private-owner" } } },
    ] } }]);
    sql.mockImplementation(async (statement) => [{
      bytes: weightedBytes(statement, () => statement.text.includes('FROM "AutomationRun"') ? 150n : 10n),
      matchedRows: BigInt(selectedIds(statement).length),
    }]);
    await expect(preflight("course", "findMany", { select: {
      probes: { select: { automationRun: { select: { audit: true } } } },
      supportIncident: { select: { batchIncidents: { select: {
        batch: { select: { ownerAutomationRun: { select: { notes: true } } } },
      } } } },
    } })).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES" });
    const ownerStatement = sql.mock.calls.map(([statement]) => statement).find((statement) => statement.text.includes('FROM "AutomationRun"'))!;
    expect(selectedFields(ownerStatement).map(({ key }) => key).sort()).toEqual(["audit", "notes"]);
    expect(selectedIds(ownerStatement)).toEqual(["private-owner"]);
  });

  it.each(["list", "null", "count"] as const)("charges %s structural envelopes before full evidence hydration", async (kind) => {
    const { models, sql, preflight } = fixture({ maxBytes: 32 });
    const query = kind === "list" ? { select: { preferences: { select: { id: true } } } }
      : kind === "null" ? { select: { supportIncident: { select: { id: true } } } }
        : { select: { _count: { select: { preferences: true } } } };
    models.course.findMany.mockResolvedValue([kind === "list" ? { id: "private-course", preferences: [] }
      : kind === "null" ? { id: "private-course", supportIncident: null } : { id: "private-course" }]);
    await expect(preflight("course", "findMany", query)).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES",
    });
    expect(sql).not.toHaveBeenCalled();
    expect(models.course.findMany).toHaveBeenCalledTimes(1); // Identity projection only.
  });

  it("pads floating point, DateTime, enum and scalar-list serialization without returning values", async () => {
    const { models, sql, preflight } = fixture();
    models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    await preflight("course", "findMany", { select: {
      rating: true, createdAt: true, detectedPlatform: true, layoutHoleCounts: true,
    } });
    const statement = sql.mock.calls[0][0];
    expect(selectedFields(statement).map(({ key }) => key).sort()).toEqual(["createdAt", "detectedPlatform", "layoutHoleCounts", "rating"]);
    expect(statement.values.filter((value) => value === 32)).toHaveLength(2);
    expect(statement.text).toContain('acceptance_row."layoutHoleCounts"');
    expect(statement.text).toContain('::bigint * 1::bigint');
    expect(statement.text).not.toContain("private-course");
  });

  it.each([
    { select: { name: { unknown: true } } }, { include: { name: true } },
    { select: { _count: { select: { name: true } } } },
    { select: { _count: { select: { preferences: { unknown: true } } } } },
    { omit: { bookingMetadata: true } },
  ])("fails closed on unrecognized scalar/count/omit shapes %s", async (query) => {
    const { models, sql, preflight } = fixture();
    await expect(preflight("course", "findMany", query)).rejects.toMatchObject({ message: "READ_FAILED", boundary: null });
    expect(models.course.count).not.toHaveBeenCalled();
    expect(models.course.findMany).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("charges repeated selected payloads again rather than caching byte credit across queries", async () => {
    const { models, sql, preflight } = fixture({ maxBytes: 40 });
    models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    const query = { select: { id: true } };
    await preflight("course", "findMany", query);
    await expect(preflight("course", "findMany", query)).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES",
    });
    expect(sql).toHaveBeenCalledTimes(2);
    expect(models.course.findMany).toHaveBeenCalledTimes(2);
  });
});
