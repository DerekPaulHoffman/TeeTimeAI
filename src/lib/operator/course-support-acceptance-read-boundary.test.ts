import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCEPTANCE_READ_LIMITS, AcceptanceReadFence, createBoundedAcceptanceReadClient } from "./course-support-acceptance-read-boundary";
import { AcceptanceBytePreflightFence } from "./course-support-acceptance-read-size-boundary";

const { preflightBytes, byteOptions } = vi.hoisted(() => ({ preflightBytes: vi.fn(), byteOptions: { tick: undefined as (() => void) | undefined } }));
vi.mock("./course-support-acceptance-read-size-boundary", async (importOriginal) => ({
  ...await importOriginal<typeof import("./course-support-acceptance-read-size-boundary")>(),
  createAcceptanceBytePreflight: (_database: unknown, options: { tick: () => void }) => {
    byteOptions.tick = options.tick;
    return preflightBytes;
  },
}));
beforeEach(() => { preflightBytes.mockReset().mockResolvedValue(undefined); });

function fixture() {
  const models = Object.fromEntries([
    "automationRun", "course", "courseSupportIncident", "courseSupportBatch", "courseSupportBatchIncident",
    "courseMonitoringEvent", "courseProbe", "coursePreference", "localReaderAgent", "localReaderJob",
    "teeSearch", "courseSupportVerificationRequest",
  ].map((name) => [name, { count: vi.fn(async () => 0), findMany: vi.fn(async () => [] as unknown[]),
    findFirst: vi.fn(async () => null as unknown), findUnique: vi.fn(async () => null as unknown),
    groupBy: vi.fn(async () => [] as unknown[]) }]));
  return { models, read: createBoundedAcceptanceReadClient(models as unknown as Prisma.TransactionClient) };
}

describe("bounded native acceptance read client", () => {
  it("precounts exact selectors and preserves native ordering/distinct without adding take", async () => {
    const { models, read } = fixture();
    const query = { where: { courseId: { in: ["private-course"] } },
      distinct: ["courseId"] as ["courseId"], orderBy: { observedAt: "desc" as const }, select: { courseId: true } };
    models.courseProbe.count.mockResolvedValue(7);
    models.courseProbe.findMany.mockResolvedValue([{ courseId: "private-course" }]);
    await expect(read.courseProbe.findMany(query)).resolves.toEqual([{ courseId: "private-course" }]);
    expect(models.courseProbe.count).toHaveBeenCalledExactlyOnceWith({ where: query.where });
    expect(models.courseProbe.findMany).toHaveBeenCalledExactlyOnceWith(query);
    expect(models.courseProbe.count.mock.invocationCallOrder[0]).toBeLessThan(models.courseProbe.findMany.mock.invocationCallOrder[0]);
    expect(preflightBytes).toHaveBeenCalledExactlyOnceWith("courseProbe", "findMany", query);
    expect(preflightBytes.mock.invocationCallOrder[0]).toBeLessThan(models.courseProbe.findMany.mock.invocationCallOrder[0]);
  });
  it.each([
    ["courseSupportIncident", ACCEPTANCE_READ_LIMITS.incidentRows],
    ["course", ACCEPTANCE_READ_LIMITS.courseRows], ["courseSupportBatch", ACCEPTANCE_READ_LIMITS.batchRows],
    ["courseProbe", ACCEPTANCE_READ_LIMITS.evidenceRows],
  ])("rejects oversized %s before fetching evidence", async (model, limit) => {
    const { models, read } = fixture();
    models[model].count.mockResolvedValue(limit as number + 1);
    await expect((read as unknown as typeof models)[model].findMany({ where: {} } as never)).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "TOP_LEVEL_ROWS",
    });
    expect(models[model].findMany).not.toHaveBeenCalled();
  });
  it("retains a bounded native take without reading an unbounded replacement", async () => {
    const { models, read } = fixture();
    models.courseMonitoringEvent.count.mockResolvedValue(100_000);
    const query = { take: 1, orderBy: { occurredAt: "desc" as const } };
    await read.courseMonitoringEvent.findMany(query);
    expect(models.courseMonitoringEvent.findMany).toHaveBeenCalledExactlyOnceWith(query);
    expect(models.courseMonitoringEvent.groupBy).not.toHaveBeenCalled();
  });
  it("counts unbounded nested current-cycle history with its exact parent relation", async () => {
    const { models, read } = fixture();
    const query = { where: { id: "private-incident" }, select: { monitoringEvents: {
      where: { occurredAt: { gte: new Date("2026-09-01T00:00:00Z") } }, select: { audit: true },
    } } };
    models.courseMonitoringEvent.count.mockResolvedValue(ACCEPTANCE_READ_LIMITS.evidenceRows + 1);
    await expect(read.courseSupportIncident.findMany(query)).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "INCIDENT_HISTORY_ROWS",
    });
    expect(models.courseMonitoringEvent.count).toHaveBeenCalledExactlyOnceWith({ where: { AND: [
      query.select.monitoringEvents.where, { incident: { is: query.where } },
    ] } });
    expect(models.courseSupportIncident.findMany).not.toHaveBeenCalled();
  });
  it("rejects excessive per-incident history before both direct and nested full reads", async () => {
    const { models, read } = fixture();
    models.courseMonitoringEvent.groupBy.mockResolvedValue([{ _count: { _all: ACCEPTANCE_READ_LIMITS.incidentRows + 1 } }]);
    await expect(read.courseMonitoringEvent.findMany({ where: { incidentId: { not: null } } })).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "INCIDENT_HISTORY_GROUPS",
    });
    await expect(read.courseSupportIncident.findMany({ select: { monitoringEvents: { select: { audit: true } } } })).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "INCIDENT_HISTORY_GROUPS",
    });
    expect(models.courseMonitoringEvent.findMany).not.toHaveBeenCalled();
    expect(models.courseSupportIncident.findMany).not.toHaveBeenCalled();
  });
  it("fences unbounded verification requests inside retained batch history", async () => {
    const { models, read } = fixture();
    models.courseSupportVerificationRequest.count.mockResolvedValue(ACCEPTANCE_READ_LIMITS.evidenceRows + 1);
    await expect(read.courseSupportIncident.findUnique({ where: { id: "private" }, select: {
      batchIncidents: { take: 20, select: { verificationRequests: { select: { id: true } } } },
    } })).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "VERIFICATION_REQUEST_ROWS" });
    expect(models.courseSupportIncident.findUnique).not.toHaveBeenCalled();
  });
  it("fences unbounded selected-course preferences before the parent read", async () => {
    const { models, read } = fixture();
    models.coursePreference.count.mockResolvedValue(ACCEPTANCE_READ_LIMITS.evidenceRows + 1);
    await expect(read.courseSupportIncident.findMany({ select: { course: { select: {
      preferences: { where: { teeSearch: { status: "ACTIVE" } }, select: { id: true } },
    } } } })).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "NESTED_PREFERENCE_ROWS" });
    expect(models.courseSupportIncident.findMany).not.toHaveBeenCalled();
  });
  it("rejects transferred evidence byte and cumulative array bounds", async () => {
    const { models, read } = fixture();
    models.automationRun.findFirst.mockResolvedValue({ audit: "x".repeat(ACCEPTANCE_READ_LIMITS.evidenceBytes + 1) });
    await expect(read.automationRun.findFirst()).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "TRANSFER_BYTES" });
    const next = fixture();
    next.models.courseSupportIncident.findMany.mockResolvedValue([{ monitoringEvents: Array(ACCEPTANCE_READ_LIMITS.evidenceRows + 1).fill(null) }]);
    await expect(next.read.courseSupportIncident.findMany()).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "TRANSFER_ARRAY_ITEMS",
    });
  });
  it("bounds native query count and refuses mutations/raw execution", async () => {
    const { models, read } = fixture();
    expect(() => read.course.updateMany).toThrow("READ_FAILED");
    expect(() => read.$executeRawUnsafe).toThrow("READ_FAILED");
    for (let index = 0; index < ACCEPTANCE_READ_LIMITS.queryCount; index++) await read.teeSearch.count();
    await expect(read.teeSearch.count()).rejects.toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", boundary: "QUERY_OPERATIONS" });
    expect(models.teeSearch.count).toHaveBeenCalledTimes(ACCEPTANCE_READ_LIMITS.queryCount);
  });
  it("rejects malformed count evidence without echoing private query arguments", async () => {
    const { models, read } = fixture();
    models.course.count.mockResolvedValue(-1);
    await expect(read.course.findMany({ where: { name: "private" } })).rejects.toMatchObject({ message: "READ_FAILED", boundary: null });
    expect(models.course.findMany).not.toHaveBeenCalled();
  });
  it("rejects a byte preflight fence before native hydration and keeps its fixed reason", async () => {
    const { models, read } = fixture();
    preflightBytes.mockRejectedValue(new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "WHOLE_ROW_BYTES"));
    await expect(read.automationRun.findFirst({ select: { audit: true } })).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "WHOLE_ROW_BYTES",
    });
    expect(models.automationRun.findFirst).not.toHaveBeenCalled();
  });

  it("keeps a real operation-budget fence through the byte-preflight tick seam", async () => {
    const { models, read } = fixture();
    for (let index = 0; index < ACCEPTANCE_READ_LIMITS.queryCount - 1; index++) await read.teeSearch.count();
    preflightBytes.mockImplementation(async () => { byteOptions.tick!(); byteOptions.tick!(); });
    await expect(read.automationRun.findFirst({ select: { audit: true } })).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "QUERY_OPERATIONS",
    });
    expect(models.teeSearch.count).toHaveBeenCalledTimes(ACCEPTANCE_READ_LIMITS.queryCount - 1);
    expect(models.automationRun.findFirst).not.toHaveBeenCalled();
  });

  it("tags the existing transfer-depth fence without retaining nested evidence", async () => {
    const { models, read } = fixture();
    const evidence = Array.from({ length: 129 }).reduce<unknown>((nested) => ({ child: nested }), null);
    models.automationRun.findFirst.mockResolvedValue(evidence);
    await expect(read.automationRun.findFirst()).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "TRANSFER_DEPTH",
    });
  });

  it("keeps constructor defaults opaque and rejects non-fixed runtime boundary input", () => {
    expect(new AcceptanceReadFence("READ_FAILED")).toMatchObject({ message: "READ_FAILED", boundary: null });
    expect(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "private-query" as never)).toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: null,
    });
  });
});
