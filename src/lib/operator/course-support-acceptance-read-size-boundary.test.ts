import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AcceptanceBytePreflightFence, createAcceptanceBytePreflight } from "./course-support-acceptance-read-size-boundary";

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
  const sql = vi.fn(async (query: Prisma.Sql) => [{ bytes: 10n, matchedRows: BigInt(selectedIds(query).length) }]);
  const tick = vi.fn();
  const transaction = { ...models, $queryRaw: sql } as unknown as Prisma.TransactionClient;
  return {
    models, sql, tick, transaction,
    preflight: createAcceptanceBytePreflight(transaction, { tick, maxBytes: input.maxBytes ?? 16_777_216,
      maxIdentityItems: input.maxIdentityItems }),
  };
}

function selectedIds(query: Prisma.Sql) {
  const parameters = query.text.match(/::text IN \(([^)]+)\)/u)?.[1] ?? "";
  return [...parameters.matchAll(/\$(\d+)/gu)].map((match) => query.values[Number(match[1]) - 1]);
}

function selectedFields(query: Prisma.Sql) {
  return [...query.text.matchAll(/\$(\d+)::text,\s*acceptance_row\."([A-Za-z_][A-Za-z0-9_]*)"/gu)]
    .map((match) => ({ key: query.values[Number(match[1]) - 1], column: match[2] }));
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
  it("retains deterministic native scopes and recursively projects only selected identities", async () => {
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
        batchIncidents: { where: { cycle: 4 }, take: 21, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, verificationRequests: { where: { status: "QUEUED" }, select: { id: true } } } },
        course: { select: { id: true, preferences: { where: { teeSearch: { status: "ACTIVE" } }, select: { id: true } },
          monitoringStatus: { select: { courseId: true } } } },
      } });
    expect(sql).toHaveBeenCalledTimes(6);
    const statements = sql.mock.calls.map(([statement]) => statement);
    expect(statements.every((statement) => statement.text.includes("SUM(octet_length(") && statement.text.includes("jsonb_build_object("))).toBe(true);
    expect(statements.every((statement) => !statement.text.includes("private-"))).toBe(true);
    expect(statements.find((statement) => statement.text.includes('FROM "CourseMonitoringStatus"'))?.text)
      .toMatch(/acceptance_row\."courseId"::text IN \(\$\d+\)/u);
    expect(models.courseSupportVerificationRequest.count).toHaveBeenCalledWith({ where: { AND: [
      { status: "QUEUED" }, { batchIncident: { is: { AND: [{ cycle: 4 }, { incident: { is: where } }] } } },
    ] } });
    expect(query.select).toHaveProperty("attemptLedger", true);
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

  it("preserves distinct fields and deterministic selection without adding a native tie-breaker", async () => {
    const { models, preflight } = fixture();
    const query = { where: { courseId: "private-course" }, distinct: ["courseId"],
      orderBy: [{ observedAt: "desc" }, { id: "desc" }], take: 1, select: { outcome: true } };
    models.courseProbe.findMany.mockResolvedValue([{ id: "private-probe", courseId: "private-course" }]);

    await preflight("courseProbe", "findMany", query);

    expect(models.courseProbe.findMany).toHaveBeenCalledExactlyOnceWith({ ...query, select: { id: true, courseId: true } });
    expect(query.select).toEqual({ outcome: true });
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

    await expect(preflight("course", "findMany", {})).rejects.toMatchObject({ message: "READ_TIMEOUT", code });
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
    expect(new AcceptanceBytePreflightFence("READ_FAILED")).toMatchObject({ message: "READ_FAILED", boundary: null });
    expect(new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "private-query" as never)).toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: null,
    });
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
      bytes: statement.text.includes('FROM "AutomationRun"') ? 150n : 10n,
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
