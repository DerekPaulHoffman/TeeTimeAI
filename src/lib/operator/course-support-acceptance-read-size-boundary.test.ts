import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { createAcceptanceBytePreflight } from "./course-support-acceptance-read-size-boundary";

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
  const sql = vi.fn(async (query: Prisma.Sql) => [{ bytes: 10n, matchedRows: BigInt(query.values.length) }]);
  const tick = vi.fn();
  const transaction = { ...models, $queryRaw: sql } as unknown as Prisma.TransactionClient;
  return {
    models, sql, tick, transaction,
    preflight: createAcceptanceBytePreflight(transaction, { tick, maxBytes: input.maxBytes ?? 16_777_216,
      maxIdentityItems: input.maxIdentityItems }),
  };
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
    expect(statements.every((statement) => statement.text.includes("SUM(octet_length(to_jsonb(acceptance_row)::text))"))).toBe(true);
    expect(statements.every((statement) => !statement.text.includes("private-"))).toBe(true);
    expect(statements.find((statement) => statement.text.includes('FROM "CourseMonitoringStatus"'))?.text)
      .toContain('acceptance_row."courseId"::text IN ($1)');
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
    })()).rejects.toThrow(/^EVIDENCE_BOUND_EXCEEDED$/);

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
    } })).rejects.toThrow(/^EVIDENCE_BOUND_EXCEEDED$/);

    expect(models.courseProbe.count).toHaveBeenCalledTimes(1);
    expect(models.coursePreference.findMany).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("rejects an unbounded tied candidate superset before the identity query", async () => {
    const { models, sql, preflight } = fixture({ maxIdentityItems: 3 });
    models.localReaderJob.count.mockResolvedValue(4);

    await expect(preflight("localReaderJob", "findFirst", {
      where: { status: "COMPLETED" }, orderBy: { completedAt: "desc" }, select: { result: true },
    })).rejects.toThrow(/^EVIDENCE_BOUND_EXCEEDED$/);

    expect(models.localReaderJob.findMany).not.toHaveBeenCalled();
    expect(models.localReaderJob.findFirst).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("bounds a broadened nested candidate scope before fetching any identities", async () => {
    const { models, sql, preflight } = fixture({ maxIdentityItems: 3 });
    models.localReaderJob.count.mockResolvedValue(3);

    await expect(preflight("course", "findMany", { where: { id: "private-course" }, select: {
      localReaderJobs: { where: { status: "COMPLETED" }, take: 1, orderBy: { completedAt: "desc" }, select: { result: true } },
    } })).rejects.toThrow(/^EVIDENCE_BOUND_EXCEEDED$/);

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

    expect(sql.mock.calls[0][0].values).toEqual([privateId]);
    expect(sql.mock.calls[0][0].text).not.toContain(privateId);
    expect(sql.mock.calls[0][0].text).toContain('FROM "CourseMonitoringStatus"');
    expect(sql.mock.calls[0][0].text).toContain('acceptance_row."courseId"::text');
  });

  it("accounts conservatively for repeated related identities and cumulative queries", async () => {
    const { models, preflight } = fixture({ maxBytes: 100 });
    models.courseSupportBatchIncident.count.mockResolvedValue(2);
    models.courseSupportBatchIncident.findMany.mockResolvedValue([
      { id: "private-entry-a", batch: { id: "private-batch", ownerAutomationRun: { id: "private-run" } } },
      { id: "private-entry-b", batch: { id: "private-batch", ownerAutomationRun: { id: "private-run" } } },
    ]);
    const query = { select: { batch: { select: { ownerAutomationRun: { select: { notes: true } } } } } };
    await preflight("courseSupportBatchIncident", "findMany", query);
    models.course.findMany.mockResolvedValue([{ id: "private-course" }]);

    await expect(preflight("course", "findMany", {})).rejects.toThrow(/^EVIDENCE_BOUND_EXCEEDED$/);
  });

  it("accepts an absent unique row without querying row bytes", async () => {
    const { models, sql, preflight } = fixture();
    models.course.count.mockResolvedValue(0);

    await preflight("course", "findUnique", { where: { id: "missing-private-course" } });

    expect(models.course.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: "missing-private-course" }, select: { id: true } });
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([
    ["unknownDelegate", {}],
    ["courseBookingFact", {}],
    ["course", { select: { supportIncident: { select: { course: { select: { id: true } } } } } }],
  ])("fails closed on unsupported metadata or a cyclic relation path for %s", async (model, query) => {
    const { models, sql, preflight } = fixture();
    await expect(preflight(model, "findMany", query)).rejects.toThrow(/^(READ_FAILED|EVIDENCE_BOUND_EXCEEDED)$/);
    expect(models.course.count).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("rejects malformed identities and aggregate evidence with opaque errors", async () => {
    const first = fixture();
    first.models.course.findMany.mockResolvedValue([{ id: "private-course", notes: "secret-private-notes" }]);
    await expect(first.preflight("course", "findMany", {})).rejects.toThrow(/^READ_FAILED$/);
    expect(first.sql).not.toHaveBeenCalled();
    const second = fixture();
    second.models.course.findMany.mockResolvedValue([{ id: "private-course" }]);
    second.sql.mockResolvedValue([{ bytes: 10n, matchedRows: 0n }]);
    await expect(second.preflight("course", "findMany", {})).rejects.toThrow(/^READ_FAILED$/);
    const third = fixture();
    third.models.course.findMany.mockRejectedValue(new Error("private-connection-details"));
    await expect(third.preflight("course", "findMany", {})).rejects.toThrow(/^READ_FAILED$/);
  });

  it.each(["P2028", "57014"])("preserves fixed timeout classification for native %s without private details", async (code) => {
    const { models, preflight } = fixture();
    models.course.count.mockRejectedValue(Object.assign(new Error("private-provider-connection"), { code }));

    await expect(preflight("course", "findMany", {})).rejects.toMatchObject({ message: "READ_TIMEOUT", code });
  });
});
