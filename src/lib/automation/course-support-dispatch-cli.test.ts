import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/automation/course-support-batches", () => ({ inspectCourseSupportQueue: vi.fn() }));
vi.mock("@/lib/automation/course-support-customer-recovery", () => ({ refreshPendingCustomerRecoveries: vi.fn() }));
vi.mock("@/lib/automation/course-support-course-dispatch", () => ({
  beginCourseSupportCourseDispatch: vi.fn(),
  bindCourseSupportCourseDispatch: vi.fn(),
  cancelCourseSupportCourseDispatch: vi.fn(),
  getCourseSupportCourseDispatchAssignment: vi.fn(),
  planCourseSupportCourseDispatch: vi.fn(),
  listCourseSupportStartupReceiptBindings: vi.fn(),
  reconcileCourseSupportStartupTerminal: vi.fn(),
}));

import {
  courseDispatchMayInspectLegacy,
  bindCourseDispatchReceipt,
  planCourseDispatchCycle,
  readDispatchArguments,
  reconcileCourseDispatchReceipt,
  reconcileCourseDispatchStartups,
  selectCourseDispatchLegacyHandoff,
} from "../../../scripts/automation/course-support-dispatch";

type AcquiredPlan = Extract<Parameters<typeof courseDispatchMayInspectLegacy>[0], { acquired: true }>;
const absoluteWorkerReceipt = join(tmpdir(), "private", "worker.receipt.json");
const emptyPlan = {
  acquired: true,
  value: {
    launchItems: [], reservedCount: 0, eligibleCount: 0,
    attention: { startingCount: 0, boundCount: 0, expiredBatchCount: 0 },
  },
} as AcquiredPlan;

function legacyInspection(overrides: Record<string, unknown>) {
  return {
    handoff: { action: "STOP", source: "NO_ACTIONABLE_WORK" },
    ownedByCurrentTask: false,
    dueRealCount: 0,
    candidateHistoryEvidenceStatus: "COMPLETE",
    activeWriter: null,
    expiredBatch: null,
    ...overrides,
  } as Parameters<typeof selectCourseDispatchLegacyHandoff>[0];
}

describe("course dispatcher command authority", () => {
  it("bounds a scheduled launch without accepting an assignment selector", () => {
    expect(readDispatchArguments(["plan", "--scheduled-cycle", "--max-starts", "5"])).toMatchObject({
      command: "plan", maxStarts: 5, scheduledCycle: true,
    });
    for (const value of ["0", "6", "15", "16", "1.5", "NaN", "Infinity"]) {
      expect(() => readDispatchArguments(["plan", "--max-starts", value])).toThrow();
    }
    expect(() => readDispatchArguments(["plan", "--assignment-ref", "opaque-ref"])).toThrow();
    expect(() => readDispatchArguments(["plan", "--scheduled-cycle", "--scheduled-cycle"])).toThrow();
  });

  it("requires a real child binding selector only for the binding command", () => {
    expect(readDispatchArguments(["bind", "--legacy-bind", "--assignment-ref", "opaque-ref", "--child-thread", "native-child"])).toMatchObject({
      command: "bind", assignmentRef: "opaque-ref", childThreadId: "native-child",
    });
    expect(() => readDispatchArguments(["bind", "--assignment-ref", "opaque-ref"])).toThrow();
    expect(() => readDispatchArguments(["bind", "--assignment-ref", "opaque-ref", "--child-thread", "native-child"])).toThrow("--receipt");
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--child-thread", "native-child"])).toThrow();
    expect(() => readDispatchArguments(["bind", "--assignment-ref", "opaque-ref", "--child-thread", "native-child", "--child-thread", "other-child"])).toThrow();
  });

  it("requires explicit evidence of no native start before cancellation", () => {
    expect(() => readDispatchArguments(["cancel", "--assignment-ref", "opaque-ref"])).toThrow();
    expect(readDispatchArguments(["cancel", "--assignment-ref", "opaque-ref", "--confirmed-not-started"])).toMatchObject({ command: "cancel" });
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--confirmed-not-started"])).toThrow();
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--scheduled-cycle"])).toThrow();
  });

  it("requires an absolute validated receipt with no caller-fabricated identities or outcomes", () => {
    for (const command of ["bind", "reconcile-startup"]) {
      expect(readDispatchArguments([command, "--receipt", absoluteWorkerReceipt])).toMatchObject({ command, receiptPath: absoluteWorkerReceipt });
      expect(() => readDispatchArguments([command, "--receipt", "relative.receipt.json"])).toThrow("absolute");
      for (const flags of [
        ["--assignment-ref", "other"], ["--child-thread", "other"], ["--legacy-bind"],
        ["--scheduled-cycle"], ["--max-starts", "5"], ["--confirmed-not-started"], ["--outcome", "failed"],
      ]) expect(() => readDispatchArguments([command, "--receipt", absoluteWorkerReceipt, ...flags])).toThrow();
    }
    expect(() => readDispatchArguments(["reconcile-startup"])).toThrow();
    expect(() => readDispatchArguments(["plan", "--receipt", absoluteWorkerReceipt])).toThrow();
  });

  it("rejects unknown flags and missing assignment references before any operation", () => {
    for (const command of ["start", "bind", "assignment", "cancel"]) {
      expect(() => readDispatchArguments([command])).toThrow();
    }
    expect(() => readDispatchArguments(["start", "--assignment-ref"])).toThrow();
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--apply"])).toThrow();
  });
});

describe("validated local native startup receipts", () => {
  const receiptPath = absoluteWorkerReceipt;
  const assignmentRef = "course-assignment-019ca000-0000-4000-8000-000000000001";
  const childThreadId = "019ca000-0000-4000-8000-000000000002";
  const preparedReceiptSha256 = "a".repeat(64);
  const proof = { outcome: "READY", assignmentRef, childThreadId, preparedReceiptSha256 } as
    Extract<Awaited<ReturnType<NonNullable<Parameters<typeof reconcileCourseDispatchStartups>[1]>["read"]>>, { outcome: "READY" }>;

  it("derives the exact binding and prepared digest from the receipt reader", async () => {
    const read = vi.fn(async () => ({ assignmentRef, childThreadId, preparedReceiptSha256 }));
    const bind = vi.fn();
    await bindCourseDispatchReceipt("real-parent", receiptPath, { read, bind });
    expect(read).toHaveBeenCalledWith(resolve(receiptPath));
    expect(bind).toHaveBeenCalledWith({ ownerThreadId: "real-parent", assignmentRef, childThreadId,
      startupReceipt: { schemaVersion: 1, receiptPath: resolve(receiptPath), preparedReceiptSha256 } });
    await expect(bindCourseDispatchReceipt("real-parent", "relative.json", { read, bind })).rejects.toThrow("absolute");
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("keeps a live or ambiguous receipt occupied without attempting reconciliation", async () => {
    const reconcile = vi.fn();
    expect(await reconcileCourseDispatchReceipt("later-parent", receiptPath, {
      read: vi.fn(async () => ({ outcome: "NOT_TERMINAL" as const })), reconcile,
    })).toEqual({ outcome: "startup_unproven", retiredCount: 0 });
    expect(reconcile).not.toHaveBeenCalled();
    await expect(reconcileCourseDispatchReceipt("later-parent", "relative.json", {
      read: vi.fn(), reconcile,
    })).rejects.toThrow("absolute");
  });

  it("reports only aggregate attention for legacy, unreadable, changed and refused proofs", async () => {
    const bindings = Array.from({ length: 5 }, (_, index) => ({ assignmentRef, childThreadId,
      schemaVersion: 1 as const, preparedReceiptSha256, receiptPath: join(tmpdir(), "private", `${index}.json`) }));
    const read = vi.fn().mockResolvedValueOnce(proof)
      .mockResolvedValueOnce({ outcome: "NOT_TERMINAL" })
      .mockRejectedValueOnce(new Error("private path"))
      .mockResolvedValueOnce({ ...proof, childThreadId: "changed" })
      .mockResolvedValueOnce(proof);
    const reconcile = vi.fn().mockResolvedValueOnce({ acquired: true, value: { retiredCount: 1 } })
      .mockRejectedValueOnce(new Error("claim authority changed"));
    const result = await reconcileCourseDispatchStartups("later-parent", {
      list: vi.fn(async () => ({ bindings, legacyBoundCount: 2 })), read, reconcile,
    });
    expect(result).toEqual({ inspectedCount: 5, retiredCount: 1, unknownOrLegacyCount: 3,
      invalidReceiptCount: 2, reconciliationRefusedCount: 1 });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain(assignmentRef);
  });

  it("sweeps terminal occupied work before a zero-capacity plan decides new reservations", async () => {
    const events: string[] = [];
    const startup = { inspectedCount: 15, retiredCount: 5, unknownOrLegacyCount: 10,
      invalidReceiptCount: 0, reconciliationRefusedCount: 0 };
    const occupiedPlan = { ...emptyPlan, value: { ...emptyPlan.value, reservedCount: 5,
      attention: { startingCount: 0, boundCount: 10, expiredBatchCount: 0 } } };
    const refresh = vi.fn(), inspect = vi.fn();
    const result = await planCourseDispatchCycle({ ownerThreadId: "later-parent", baseSha: "a".repeat(40), scheduledCycle: true }, {
      reconcile: vi.fn(async parent => { expect(parent).toBe("later-parent"); events.push("reconcile"); return startup; }),
      plan: vi.fn(async input => { expect(input.maxStarts).toBeUndefined(); events.push("plan"); return occupiedPlan; }), refresh, inspect,
    } as Parameters<typeof planCourseDispatchCycle>[1]);
    expect(events).toEqual(["reconcile", "plan"]);
    expect(result).toMatchObject({ acquired: true, value: { startupReconciliation: startup, reservedCount: 5 } });
    expect(refresh).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe("course dispatcher legacy service fallback", () => {
  it("uses one scheduled CLI cycle and runs legacy inspection only after the settled plan", async () => {
    const events: string[] = [];
    const dependencies = {
      plan: vi.fn(async () => { events.push("plan"); return emptyPlan; }),
      refresh: vi.fn(async () => { events.push("recovery"); return {
        inspectedCount: 1, completedCount: 0, pendingCount: 1,
      }; }),
      inspect: vi.fn(async () => { events.push("inspect"); return legacyInspection({
        outcome: "ready", dueEngineeringCount: 1,
        handoff: { action: "CLAIM", source: "ORDINARY_DISPATCH", maxCourses: 1, selection: "ATOMIC_SERVER_SIDE" },
      }); }),
    };
    const result = await planCourseDispatchCycle({
      ownerThreadId: "parent", baseSha: "a".repeat(40), scheduledCycle: true,
    }, dependencies as Parameters<typeof planCourseDispatchCycle>[1]);
    expect(events).toEqual(["plan", "recovery", "inspect"]);
    expect(dependencies.inspect).toHaveBeenCalledWith({
      requestingThreadId: "parent", admissionRuntimeVersion: "a".repeat(40),
      completeParkedCampaignIfDone: true,
    });
    expect(result).toMatchObject({ acquired: true, value: { legacyInspection: {
      handoff: { action: "CLAIM", maxCourses: 1 },
      customerRecovery: { pendingCount: 1 },
    } } });
  });

  it("does not run legacy inspection or customer recovery while native work needs attention", async () => {
    const refresh = vi.fn();
    const inspect = vi.fn();
    const pending = { ...emptyPlan, value: { ...emptyPlan.value, reservedCount: 1,
      attention: { startingCount: 1, boundCount: 0, expiredBatchCount: 0 } } };
    const result = await planCourseDispatchCycle({
      ownerThreadId: "parent", baseSha: "a".repeat(40), scheduledCycle: true,
    }, { plan: vi.fn(async () => pending), refresh, inspect } as Parameters<typeof planCourseDispatchCycle>[1]);
    expect(result).toBe(pending);
    expect(refresh).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("leaves an unacquired writer lease untouched without inspecting or refreshing", async () => {
    const refresh = vi.fn();
    const inspect = vi.fn();
    const busy = { acquired: false } as Parameters<typeof courseDispatchMayInspectLegacy>[0];
    const result = await planCourseDispatchCycle({
      ownerThreadId: "parent", baseSha: "a".repeat(40), scheduledCycle: true,
    }, { plan: vi.fn(async () => busy), refresh, inspect } as Parameters<typeof planCourseDispatchCycle>[1]);
    expect(courseDispatchMayInspectLegacy(busy)).toBe(false);
    expect(result).toBe(busy);
    expect(refresh).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("only inspects after an empty, settled plan with no active-future candidate", () => {
    expect(courseDispatchMayInspectLegacy(emptyPlan)).toBe(true);
    for (const changed of [
      { launchItems: [{ assignmentRef: "private", state: "RESERVED" }] },
      { reservedCount: 1 }, { eligibleCount: 1 },
      { attention: { startingCount: 1, boundCount: 0, expiredBatchCount: 0 } },
      { attention: { startingCount: 0, boundCount: 1, expiredBatchCount: 0 } },
    ]) {
      expect(courseDispatchMayInspectLegacy({ ...emptyPlan, value: { ...emptyPlan.value, ...changed } } as typeof emptyPlan)).toBe(false);
    }
  });

  it("keeps existing owner and expired legacy batch references exact", () => {
    expect(selectCourseDispatchLegacyHandoff(legacyInspection({
      handoff: { action: "RESUME", source: "OWNED_BATCH" },
      ownedByCurrentTask: true, activeWriter: { batchRef: "owned-batch" },
    }))).toEqual({ action: "RESUME", source: "OWNED_BATCH", batchRef: "owned-batch" });
    expect(selectCourseDispatchLegacyHandoff(legacyInspection({
      handoff: { action: "RECOVER", source: "EXPIRED_BATCH" },
      expiredBatch: { batchRef: "expired-legacy", dispatchAssigned: false },
    }))).toEqual({ action: "RECOVER", source: "EXPIRED_BATCH", batchRef: "expired-legacy" });
    expect(selectCourseDispatchLegacyHandoff(legacyInspection({
      handoff: { action: "RECOVER", source: "EXPIRED_BATCH" },
      expiredBatch: { batchRef: "assigned-worker", dispatchAssigned: true },
    }))).toBeNull();
  });

  it("admits requestless historical background and parked campaign one course at a time", () => {
    for (const source of ["ORDINARY_DISPATCH", "PARKED_CAMPAIGN"]) {
      expect(selectCourseDispatchLegacyHandoff(legacyInspection({
        handoff: { action: "CLAIM", source, maxCourses: 1, selection: "ATOMIC_SERVER_SIDE" },
      }))).toEqual({ action: "CLAIM", source, maxCourses: 1, selection: "ATOMIC_SERVER_SIDE" });
    }
  });

  it("never emits a grouped active-alert claim or a claim without complete admission evidence", () => {
    const handoff = { action: "CLAIM", source: "ORDINARY_DISPATCH", maxCourses: 5, selection: "ATOMIC_SERVER_SIDE" };
    expect(selectCourseDispatchLegacyHandoff(legacyInspection({ handoff, dueRealCount: 1 }))).toBeNull();
    expect(selectCourseDispatchLegacyHandoff(legacyInspection({
      handoff: { ...handoff, maxCourses: 1 }, dueRealCount: 1,
    }))).toBeNull();
    expect(selectCourseDispatchLegacyHandoff(legacyInspection({
      handoff: { ...handoff, maxCourses: 1 }, candidateHistoryEvidenceStatus: "AGGREGATE_BOUND_EXCEEDED",
    }))).toBeNull();
  });
});
