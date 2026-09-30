import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCEPTANCE_READ_LIMITS, AcceptanceReadFence, createBoundedAcceptanceReadClient } from "./course-support-acceptance-read-boundary";
import { AcceptanceBytePreflightFence } from "./course-support-acceptance-read-size-boundary";
import type { AcceptanceReadCost } from "./course-support-acceptance-read-cost";

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

function costSnapshot(queryCategory: AcceptanceReadCost["queryCategory"] = "CURRENT_CYCLE_HISTORY"): AcceptanceReadCost {
  return { version: 1, queryCategory, component: "SELECTED_SCALARS", basis: "OBSERVED_CONSERVATIVE_LOWER_BOUND",
    complete: false, limitBytes: ACCEPTANCE_READ_LIMITS.evidenceBytes,
    cumulativeBeforeComponentBytes: ACCEPTANCE_READ_LIMITS.evidenceBytes - 10, componentChargeBytes: 11,
    attemptedCumulativeBytes: ACCEPTANCE_READ_LIMITS.evidenceBytes + 1, hydrationObservedBytes: 11, saturated: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function databaseCallCount(models: ReturnType<typeof fixture>["models"]) {
  return Object.values(models).reduce((total, model) => total + Object.values(model)
    .reduce((calls, method) => calls + method.mock.calls.length, 0), 0);
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
    expect(preflightBytes).toHaveBeenCalledExactlyOnceWith("courseProbe", "findMany", query, "UNCLASSIFIED");
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
    const nested = fixture();
    nested.models.courseMonitoringEvent.groupBy.mockResolvedValue([{ _count: { _all: ACCEPTANCE_READ_LIMITS.incidentRows + 1 } }]);
    await expect(nested.read.courseSupportIncident.findMany({ select: { monitoringEvents: { select: { audit: true } } } })).rejects.toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "INCIDENT_HISTORY_GROUPS",
    });
    expect(models.courseMonitoringEvent.findMany).not.toHaveBeenCalled();
    expect(nested.models.courseSupportIncident.findMany).not.toHaveBeenCalled();
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
    const forbidden = fixture();
    expect(() => forbidden.read.course.updateMany).toThrow("READ_FAILED");
    expect(() => forbidden.read.$executeRawUnsafe).toThrow("READ_FAILED");
    expect(databaseCallCount(forbidden.models)).toBe(0);
    const { models, read } = fixture();
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
    let firstTickFence: unknown;
    preflightBytes.mockImplementation(async () => {
      try { byteOptions.tick!(); byteOptions.tick!(); }
      catch (error) {
        firstTickFence = error;
        // An unfamiliar root class may be mapped opaquely by the byte helper.
        throw new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED");
      }
    });
    const result = await read.automationRun.findFirst({ select: { audit: true } }).catch((error: unknown) => error);
    expect(result).toBe(firstTickFence);
    expect(result).toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: "QUERY_OPERATIONS",
      readCost: null,
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
    expect(new AcceptanceReadFence("READ_FAILED")).toMatchObject({ message: "READ_FAILED", boundary: null, readCost: null });
    expect(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "private-query" as never)).toMatchObject({
      message: "EVIDENCE_BOUND_EXCEEDED", boundary: null,
    });
  });

  it("detaches and freezes valid selected-byte cost while all other fence kinds remain opaque", () => {
    const input = { ...costSnapshot() };
    const fence = new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES", input);
    expect(fence.readCost).toEqual(input);
    expect(fence.readCost).not.toBe(input);
    expect(Object.isFrozen(fence.readCost)).toBe(true);
    input.componentChargeBytes = 999;
    expect(fence.readCost?.componentChargeBytes).toBe(11);
    for (const [reason, boundary] of [
      ["READ_FAILED", "SELECTED_EVIDENCE_BYTES"], ["EVIDENCE_BOUND_EXCEEDED", "TRANSFER_BYTES"],
      ["EVIDENCE_BOUND_EXCEEDED", null],
    ] as const) expect(new AcceptanceReadFence(reason, boundary, costSnapshot()).readCost).toBeNull();
    expect(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES",
      { ...costSnapshot(), recipient: "private-recipient" } as never).readCost).toBeNull();
  });

  it("propagates only a recognized valid byte-cost snapshot before native hydration", async () => {
    const { models, read } = fixture();
    const cost = costSnapshot("CAMPAIGN_RECORD");
    preflightBytes.mockRejectedValue(new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES", cost));
    const error = await read.automationRun.findFirst({ select: { id: true, audit: true } }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AcceptanceReadFence);
    expect(error).toMatchObject({ boundary: "SELECTED_EVIDENCE_BYTES", readCost: cost });
    expect(Object.isFrozen((error as AcceptanceReadFence).readCost)).toBe(true);
    expect(preflightBytes).toHaveBeenCalledWith("automationRun", "findFirst", { select: { id: true, audit: true } }, "CAMPAIGN_RECORD");
    expect(models.automationRun.findFirst).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toMatch(/private-|recipient|https:/u);
  });

  it("rejects invalid or forged runtime cost without promoting lookalike failures", async () => {
    const invalid = fixture();
    const byteFence = new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES", costSnapshot());
    Object.defineProperty(byteFence, "readCost", { value: { ...costSnapshot(), queryCategory: "private-category" } });
    preflightBytes.mockRejectedValueOnce(byteFence);
    await expect(invalid.read.automationRun.findFirst()).rejects.toMatchObject({
      boundary: "SELECTED_EVIDENCE_BYTES", readCost: null,
    });
    expect(invalid.models.automationRun.findFirst).not.toHaveBeenCalled();

    const forged = fixture();
    const lookalike = Object.assign(new Error("private-error"), { reason: "EVIDENCE_BOUND_EXCEEDED",
      boundary: "SELECTED_EVIDENCE_BYTES", readCost: costSnapshot() });
    preflightBytes.mockRejectedValueOnce(lookalike);
    await expect(forged.read.automationRun.findFirst()).rejects.toBe(lookalike);
    expect(lookalike).not.toBeInstanceOf(AcceptanceReadFence);
    expect(forged.models.automationRun.findFirst).not.toHaveBeenCalled();
  });

  it("captures its category before an awaited count without changing native arguments", async () => {
    const { models, read } = fixture();
    const count = deferred<number>();
    models.courseSupportIncident.count.mockReturnValueOnce(count.promise);
    const query = { where: { id: "private-incident", cycle: 3 }, take: 1,
      select: { id: true, cycle: true, batchIncidents: { where: { cycle: 3 }, take: 21, select: { id: true } } } };
    const result = read.courseSupportIncident.findMany(query);
    expect(preflightBytes).not.toHaveBeenCalled();
    query.select.id = false;
    count.resolve(0);
    await result;
    expect(preflightBytes).toHaveBeenCalledExactlyOnceWith("courseSupportIncident", "findMany", query, "CURRENT_CYCLE_HISTORY");
    expect(models.courseSupportIncident.findMany).toHaveBeenCalledExactlyOnceWith(query);
  });

  it("keeps the first concurrent attribution and stops every later dispatch and tick", async () => {
    const { models, read } = fixture();
    const first = deferred<void>();
    const second = deferred<void>();
    const enteredSecond = deferred<void>();
    preflightBytes.mockImplementation((_delegate, _method, _args, category) => {
      if (category === "CAMPAIGN_RECORD") return first.promise;
      enteredSecond.resolve();
      return second.promise;
    });
    const firstResult = read.automationRun.findFirst({ select: { id: true, audit: true } }).catch((error: unknown) => error);
    const secondResult = read.courseSupportBatchIncident.findMany({ select: { proofSnapshot: true,
      verifiedIncidentUpdatedAt: true, batch: { select: { summary: true } } } }).catch((error: unknown) => error);
    await enteredSecond.promise;
    first.reject(new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES", costSnapshot("CAMPAIGN_RECORD")));
    const error = await firstResult;
    const callsAtFence = databaseCallCount(models);
    const preflightsAtFence = preflightBytes.mock.calls.length;
    second.reject(new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES", costSnapshot("LEGACY_TERMINAL_HISTORY")));
    expect(await secondResult).toBe(error);
    expect(error).toMatchObject({ readCost: { queryCategory: "CAMPAIGN_RECORD" } });
    await expect(read.course.count()).rejects.toBe(error);
    await expect(read.course.findMany()).rejects.toBe(error);
    let tickError: unknown;
    try { byteOptions.tick!(); } catch (value) { tickError = value; }
    expect(tickError).toBe(error);
    expect(databaseCallCount(models)).toBe(callsAtFence);
    expect(preflightBytes).toHaveBeenCalledTimes(preflightsAtFence);
    expect(models.automationRun.findFirst).not.toHaveBeenCalled();
    expect(models.courseSupportBatchIncident.findMany).not.toHaveBeenCalled();
  });

  it("lets an already in-flight native call settle but forbids any subsequent database work", async () => {
    const { models, read } = fixture();
    const count = deferred<number>();
    models.teeSearch.count.mockReturnValueOnce(count.promise);
    const pending = read.teeSearch.count().catch((error: unknown) => error);
    preflightBytes.mockRejectedValueOnce(new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES", costSnapshot()));
    const error = await read.automationRun.findFirst().catch((value: unknown) => value);
    const callsAtFence = databaseCallCount(models);
    count.resolve(0);
    expect(await pending).toBe(error);
    await expect(read.teeSearch.count()).rejects.toBe(error);
    expect(databaseCallCount(models)).toBe(callsAtFence);
    expect(models.teeSearch.count).toHaveBeenCalledTimes(1);
  });
});
