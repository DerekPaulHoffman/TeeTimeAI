import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/automation/course-support-batches", () => ({ inspectCourseSupportQueue: vi.fn() }));
vi.mock("@/lib/automation/course-support-customer-recovery", () => ({ refreshPendingCustomerRecoveries: vi.fn() }));
vi.mock("@/lib/automation/course-support-course-dispatch", () => ({
  beginCourseSupportCourseDispatch: vi.fn(),
  bindCourseSupportCourseDispatch: vi.fn(),
  cancelCourseSupportCourseDispatch: vi.fn(),
  getCourseSupportCourseDispatchAssignment: vi.fn(),
  planCourseSupportCourseDispatch: vi.fn(),
}));

import {
  courseDispatchMayInspectLegacy,
  formatCourseDispatchFailure,
  planCourseDispatchCycle,
  readDispatchArguments,
  selectCourseDispatchLegacyHandoff,
} from "../../../scripts/automation/course-support-dispatch";

type AcquiredPlan = Extract<Parameters<typeof courseDispatchMayInspectLegacy>[0], { acquired: true }>;
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
  it("reports a redacted hard failure while retaining the assignment stop instruction", () => {
    const secret = "postgres://customer:private-password@private-host/database";
    const result = formatCourseDispatchFailure(new Error(`Unhandled operation ${secret}`));
    expect(result).not.toContain(secret);
    expect(result).not.toContain("private-password");
    expect(JSON.parse(result.split("\n")[0])).toMatchObject({ outcome: "course_dispatch_failed",
      failure: { category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" }, preserveAssignment: true });
    expect(result).toContain("Course dispatch failed; preserve assignment state and stop this launch.");
  });
  it("bounds a scheduled launch without accepting an assignment selector", () => {
    expect(readDispatchArguments(["plan", "--scheduled-cycle", "--max-starts", "15"])).toMatchObject({
      command: "plan", maxStarts: 15, scheduledCycle: true,
    });
    for (const value of ["0", "16", "1.5", "NaN", "Infinity"]) {
      expect(() => readDispatchArguments(["plan", "--max-starts", value])).toThrow();
    }
    expect(() => readDispatchArguments(["plan", "--assignment-ref", "opaque-ref"])).toThrow();
    expect(() => readDispatchArguments(["plan", "--scheduled-cycle", "--scheduled-cycle"])).toThrow();
  });

  it("requires a real child binding selector only for the binding command", () => {
    expect(readDispatchArguments(["bind", "--assignment-ref", "opaque-ref", "--child-thread", "native-child"])).toMatchObject({
      command: "bind", assignmentRef: "opaque-ref", childThreadId: "native-child",
    });
    expect(() => readDispatchArguments(["bind", "--assignment-ref", "opaque-ref"])).toThrow();
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--child-thread", "native-child"])).toThrow();
    expect(() => readDispatchArguments(["bind", "--assignment-ref", "opaque-ref", "--child-thread", "native-child", "--child-thread", "other-child"])).toThrow();
  });

  it("requires explicit evidence of no native start before cancellation", () => {
    expect(() => readDispatchArguments(["cancel", "--assignment-ref", "opaque-ref"])).toThrow();
    expect(readDispatchArguments(["cancel", "--assignment-ref", "opaque-ref", "--confirmed-not-started"])).toMatchObject({ command: "cancel" });
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--confirmed-not-started"])).toThrow();
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--scheduled-cycle"])).toThrow();
  });

  it("rejects unknown flags and missing assignment references before any operation", () => {
    for (const command of ["start", "bind", "assignment", "cancel"]) {
      expect(() => readDispatchArguments([command])).toThrow();
    }
    expect(() => readDispatchArguments(["start", "--assignment-ref"])).toThrow();
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--apply"])).toThrow();
  });

  it("allows only a bounded private receipt for same-worker continuation commands", () => {
    for (const command of ["continue", "continued"]) {
      expect(readDispatchArguments([command, "--assignment-ref", "original-assignment", "--receipt-file", "private.json"]))
        .toMatchObject({ command, assignmentRef: "original-assignment", receiptFile: "private.json" });
      expect(() => readDispatchArguments([command, "--assignment-ref", "original-assignment"])).toThrow();
      expect(() => readDispatchArguments([command, "--assignment-ref", "original-assignment", "--receipt-file", "private.json", "--child-thread", "replacement"]))
        .toThrow();
      expect(() => readDispatchArguments([command, "--assignment-ref", "original-assignment", "--receipt-file", "private.json", "--scheduled-cycle"]))
        .toThrow();
      expect(() => readDispatchArguments([command, "--assignment-ref", "original-assignment", "--receipt-file", "private.json", "--receipt-file", "another.json"]))
        .toThrow();
    }
    expect(() => readDispatchArguments(["plan", "--receipt-file", "private.json"])).toThrow();
    expect(() => readDispatchArguments(["assignment", "--assignment-ref", "original-assignment", "--receipt-file", "private.json"])).toThrow();
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
      { continuationItems: [{ mode: "SIMULATOR", assignmentRef: "original-assignment", threadId: "original-child" }] },
      { continuationAttentionCount: 1 },
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
