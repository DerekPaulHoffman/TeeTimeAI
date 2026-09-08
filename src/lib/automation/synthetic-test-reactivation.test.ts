import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), courseLock: vi.fn(), deliveryLock: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/automation/course-monitoring", () => ({ acquireCourseMonitoringWriteLockInTransaction: mocks.courseLock }));
vi.mock("@/lib/email/search-delivery-outbox", () => ({ lockSearchForAlertMutation: mocks.deliveryLock }));

import { reactivateSyntheticTestSearch } from "./synthetic-test-reactivation";
import { getSyntheticMultiCycleExpiresAt } from "./synthetic-test-window";

const now = new Date("2026-09-08T00:30:00.000Z");
const runtimeVersion = "a".repeat(40);
const input = {
  searchId: "test-search", actorId: "operator-test", idempotencyKey: "one-observation",
  expectedScheduleVersion: 7, expectedAlertGeneration: 3,
  expectedUpdatedAt: "2026-09-01T00:00:00.000Z", date: "2026-09-09",
};

function fixture() {
  return {
    id: input.searchId, userId: "test-owner", status: "PAUSED", trafficClass: "TEST",
    syntheticMultiCycle: true, syntheticTestWindow: null as unknown,
    createdAt: new Date("2026-08-01T00:00:00.000Z"), updatedAt: new Date(input.expectedUpdatedAt),
    date: new Date("2026-08-02T00:00:00.000Z"), startTime: "06:00", endTime: "18:00",
    userTimeZone: "America/New_York", players: 2, scheduleVersion: 7, alertGeneration: 3,
    checkStatus: "STOPPED", workflowRunId: null as string | null,
    checkLeaseToken: null as string | null, checkLeaseExpiresAt: null as Date | null,
    preferences: [{ courseId: "course-one", rank: 1,
      course: { timeZone: "America/New_York", supportIncident: null as { activeBatchId: string | null } | null } }],
  };
}

let search = fixture();
let clock = now;
let receipt: Record<string, unknown> | null;
let readCount: number;
let onSearchRead: ((count: number) => void) | null;
const tx = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  teeSearch: { findUnique: vi.fn(), updateMany: vi.fn() },
  automationRun: { findUnique: vi.fn(), create: vi.fn() },
  localReaderJob: { findFirst: vi.fn() },
  courseSupportVerificationRequest: { findFirst: vi.fn() },
  searchEmailDelivery: { findFirst: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("NETWORK_FORBIDDEN"); }));
  search = fixture(); clock = now; receipt = null; readCount = 0; onSearchRead = null;
  tx.$executeRaw.mockResolvedValue(0);
  tx.$queryRaw.mockImplementation((parts: TemplateStringsArray) => Promise.resolve(
    parts.join("").includes("clock_timestamp") ? [{ now: new Date(clock) }] : [{ id: "course-one" }],
  ));
  tx.teeSearch.findUnique.mockImplementation(() => {
    onSearchRead?.(++readCount);
    return Promise.resolve(structuredClone(search));
  });
  tx.teeSearch.updateMany.mockImplementation(({ where, data }) => {
    if (search.status !== where.status || search.scheduleVersion !== where.scheduleVersion ||
        search.alertGeneration !== where.alertGeneration || search.updatedAt.getTime() !== where.updatedAt.getTime()) {
      return Promise.resolve({ count: 0 });
    }
    Object.assign(search, structuredClone(data));
    return Promise.resolve({ count: 1 });
  });
  tx.automationRun.findUnique.mockImplementation(() => Promise.resolve(structuredClone(receipt)));
  tx.automationRun.create.mockImplementation(({ data }) => {
    if (receipt) throw new Error("UNIQUE_RECEIPT");
    receipt = structuredClone(data);
    return Promise.resolve(receipt);
  });
  tx.localReaderJob.findFirst.mockResolvedValue(null);
  tx.courseSupportVerificationRequest.findFirst.mockResolvedValue(null);
  tx.searchEmailDelivery.findFirst.mockResolvedValue(null);
  mocks.courseLock.mockResolvedValue(undefined);
  mocks.deliveryLock.mockResolvedValue({ alertGeneration: 3 });
  mocks.transaction.mockImplementation(async (work) => {
    const prior = structuredClone({ search, receipt });
    try { return await work(tx); }
    catch (error) { search = prior.search; receipt = prior.receipt; throw error; }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("explicit synthetic reactivation", () => {
  it("dry-runs one expired existing search without locks, writes or provider calls", async () => {
    const original = structuredClone(search);
    const result = await reactivateSyntheticTestSearch(input, { runtimeVersion });
    expect(result).toMatchObject({ outcome: "ready", applied: false, replayed: false,
      scheduleVersion: 8, alertGeneration: 4, expiresAt: "2026-09-08T01:30:00.000Z",
      providerCalls: 0, emailSendCalls: 0, workflowStartCalls: 0 });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(mocks.courseLock).not.toHaveBeenCalled();
    expect(mocks.deliveryLock).not.toHaveBeenCalled();
    expect(tx.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(tx.automationRun.create).not.toHaveBeenCalled();
    expect(search).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("atomically renews only the explicit generation, preserving original evidence and preferences", async () => {
    const original = structuredClone(search);
    const result = await reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true });
    expect(result.outcome).toBe("queued_for_recovery");
    expect(search).toMatchObject({ status: "ACTIVE", checkStatus: "QUEUED",
      date: new Date("2026-09-09T00:00:00.000Z"), nextCheckAt: now,
      scheduleVersion: 8, alertGeneration: 4, syntheticMultiCycle: true, trafficClass: "TEST",
      createdAt: original.createdAt, preferences: original.preferences });
    expect(mocks.deliveryLock).toHaveBeenCalledWith(tx, { searchId: input.searchId, userId: original.userId, now });
    expect(mocks.courseLock).toHaveBeenCalledWith(tx, "course-one");
    expect(tx.localReaderJob.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ teeSearchId: input.searchId }, { courseId: { in: ["course-one"] } }],
        status: { in: ["PENDING", "LEASED"] } }, select: { id: true },
    });
    const data = tx.teeSearch.updateMany.mock.calls[0][0].data;
    for (const field of ["createdAt", "preferences", "probes", "matches", "emailDeliveries", "trafficClass", "syntheticMultiCycle", "alertEmail", "additionalEmails"]) {
      expect(data).not.toHaveProperty(field);
    }
    expect(data.statusEmailSnapshot).toEqual({ schemaVersion: 1, kind: "ALERT_GENERATION_START",
      alertGeneration: 4, generationStartedAt: now.toISOString() });
    expect(receipt).toMatchObject({ status: "COMPLETED", startedAt: now, completedAt: now,
      audit: { kind: "EXPLICIT_SYNTHETIC_REACTIVATION", providerExecution: false,
        customerDeliveryProof: false, queuedForDeployedRecovery: true,
        previous: { createdAt: original.createdAt.toISOString(), scheduleVersion: 7, alertGeneration: 3 } } });
    expect(getSyntheticMultiCycleExpiresAt({ ...search, trafficClass: "TEST" }, now)).toEqual(new Date(result.expiresAt));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays only the same committed operation without renewing time or resetting a scheduled generation", async () => {
    const first = await reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true });
    const originalReceipt = structuredClone(receipt);
    clock = new Date(now.getTime() + 60000);
    const window = search.syntheticTestWindow as Record<string, unknown>;
    search.syntheticTestWindow = { expiresAt: window.expiresAt, activatedAt: window.activatedAt,
      alertGeneration: window.alertGeneration, schemaVersion: window.schemaVersion };
    search.scheduleVersion = 9; // A native recovery launch may advance the schedule only.
    const result = await reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true });
    expect(result).toEqual({ ...first, outcome: "already_applied", applied: false, replayed: true });
    expect(tx.teeSearch.updateMany).toHaveBeenCalledOnce();
    expect(tx.automationRun.create).toHaveBeenCalledOnce();
    expect(receipt).toEqual(originalReceipt);
    expect(search.scheduleVersion).toBe(9);
  });

  it.each(["expired", "paused", "edited", "changed-window", "changed-date", "non-synthetic"])("does not revive a stale %s replay", async (change) => {
    await reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true });
    if (change === "expired") clock = new Date(now.getTime() + 3600000);
    if (change === "paused") search.status = "PAUSED";
    if (change === "edited") search.alertGeneration += 1;
    if (change === "changed-window") search.syntheticTestWindow = null;
    if (change === "changed-date") search.date = new Date("2026-09-10T00:00:00.000Z");
    if (change === "non-synthetic") search.syntheticMultiCycle = false;
    await expect(reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true })).rejects.toThrow("no longer current");
    expect(tx.teeSearch.updateMany).toHaveBeenCalledOnce();
    expect(tx.automationRun.create).toHaveBeenCalledOnce();
  });

  it("rejects changed input under the same idempotency key", async () => {
    await reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true });
    await expect(reactivateSyntheticTestSearch({ ...input, date: "2026-09-10" }, { runtimeVersion, apply: true })).rejects.toThrow("idempotency");
    expect(tx.teeSearch.updateMany).toHaveBeenCalledOnce();
  });

  it.each(["PUBLIC", "UNCLASSIFIED"])("never renews %s demand", async (trafficClass) => {
    search.trafficClass = trafficClass;
    await expect(reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true })).rejects.toThrow("paused multi-cycle");
    expect(tx.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it.each(["not-paused", "one-check", "version", "generation", "updated", "workflow", "lease-token", "lease-clock", "checking", "course-owner", "empty", "too-many"])("rejects unsafe %s state", async (change) => {
    if (change === "not-paused") search.status = "COMPLETED";
    if (change === "one-check") search.syntheticMultiCycle = false;
    if (change === "version") search.scheduleVersion += 1;
    if (change === "generation") search.alertGeneration += 1;
    if (change === "updated") search.updatedAt = now;
    if (change === "workflow") search.workflowRunId = "pending-workflow";
    if (change === "lease-token") search.checkLeaseToken = "pending-lease";
    if (change === "lease-clock") search.checkLeaseExpiresAt = new Date(now.getTime() + 60000);
    if (change === "checking") search.checkStatus = "CHECKING";
    if (change === "course-owner") search.preferences[0].course.supportIncident = { activeBatchId: "owned" };
    if (change === "empty") search.preferences = [];
    if (change === "too-many") search.preferences = Array.from({ length: 6 }, (_, index) => ({ ...fixture().preferences[0], courseId: `course-${index}`, rank: index + 1 }));
    await expect(reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true })).rejects.toThrow();
    expect(tx.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(tx.automationRun.create).not.toHaveBeenCalled();
  });

  it.each(["reader", "verification", "delivery"])("preserves pending %s ownership", async (kind) => {
    if (kind === "reader") tx.localReaderJob.findFirst.mockResolvedValue({ id: "busy" });
    if (kind === "verification") tx.courseSupportVerificationRequest.findFirst.mockResolvedValue({ id: "busy" });
    if (kind === "delivery") tx.searchEmailDelivery.findFirst.mockResolvedValue({ id: "busy" });
    await expect(reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true })).rejects.toThrow("still pending");
    expect(mocks.deliveryLock).not.toHaveBeenCalled();
    expect(tx.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("rechecks state and database time after the native locks", async () => {
    onSearchRead = (count) => { if (count === 2) search.scheduleVersion += 1; };
    await expect(reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true })).rejects.toThrow("state changed");
    expect(tx.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("fails the final CAS without recording success", async () => {
    tx.teeSearch.updateMany.mockResolvedValue({ count: 0 });
    await expect(reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true })).rejects.toThrow("compare-and-set");
    expect(tx.automationRun.create).not.toHaveBeenCalled();
    expect(search.status).toBe("PAUSED");
  });

  it("rolls back the lifecycle write when the immutable receipt cannot be recorded", async () => {
    tx.automationRun.create.mockRejectedValue(new Error("WRITE_FAILED"));
    await expect(reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true })).rejects.toThrow("WRITE_FAILED");
    expect(search.status).toBe("PAUSED");
    expect(search.scheduleVersion).toBe(7);
    expect(search.syntheticTestWindow).toBeNull();
  });

  it("uses a fresh database clock after waiting, not the initial operator clock", async () => {
    mocks.deliveryLock.mockImplementation(() => { clock = new Date("2026-09-10T00:30:00.000Z"); });
    await expect(reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true })).rejects.toThrow("not future");
    expect(tx.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it.each([0, 1081, 1.5])("rejects invalid %s minute windows before opening a transaction", async (durationMinutes) => {
    await expect(reactivateSyntheticTestSearch({ ...input, durationMinutes }, { runtimeVersion, apply: true })).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("validates the future calendar date in every selected course time zone", async () => {
    search.preferences.push({ courseId: "course-two", rank: 2,
      course: { timeZone: "Pacific/Kiritimati", supportIncident: null } });
    clock = new Date("2026-09-08T12:00:00.000Z"); // Already Sep 9 locally for the second course.
    await expect(reactivateSyntheticTestSearch(input, { runtimeVersion, apply: true })).rejects.toThrow("not future");
    expect(tx.teeSearch.updateMany).not.toHaveBeenCalled();
  });
});
