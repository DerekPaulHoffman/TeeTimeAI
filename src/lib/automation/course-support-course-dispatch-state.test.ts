import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseDispatchAudit } from "./course-support-course-dispatch";

type StoredRun = {
  id: string;
  promptVersion: string;
  status: string;
  startedAt: Date;
  audit: CourseDispatchAudit;
};
type SourceSearch = {
  id: string; status: string; date: Date; endTime: string; userTimeZone: string;
  scheduleVersion: number; alertGeneration: number; trafficClass: string;
  syntheticMultiCycle: boolean; syntheticTestWindow: null; createdAt: Date;
  userId: string; user: { id: string; clerkUserId: string; email: string; pendingEmail: string | null };
  alertEmail: string | null; additionalEmails: string[]; startTime: string; players: number;
  requestedLayoutHoles: number | null; cadenceMinutes: number;
  preferences: { courseId: string; rank: number }[];
};
type Candidate = {
  incidentId: string; courseId: string; cycle: number; providerFamilyKey: string;
  failureFingerprint: string; updatedAt: string; activeRealSearchCount: number;
};

const store = vi.hoisted(() => {
  const runs: StoredRun[] = [];
  const candidates: Candidate[] = [];
  const sources = new Map<string, SourceSearch>();
  const batches: { id: string; summary: unknown; leaseExpiresAt: Date; incidents: { courseId: string }[] }[] = [];
  let sequence = 0;
  let leaseTail = Promise.resolve();
  const automationRun = {
    findMany: vi.fn(async (args: { where: { promptVersion: string; OR: { startedAt?: { gte: Date }; status?: string }[] } }) => {
      const since = args.where.OR.find(entry => entry.startedAt)?.startedAt?.gte;
      return runs.filter(run => run.promptVersion === args.where.promptVersion &&
        (run.status === "RUNNING" || Boolean(since && run.startedAt >= since)));
    }),
    create: vi.fn(async (args: { data: Omit<StoredRun, "id"> }) => {
      const row = { ...args.data, id: `reservation-${++sequence}` };
      runs.push(row);
      return { id: row.id };
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<StoredRun> }) => {
      const row = runs.find(entry => entry.id === args.where.id);
      if (!row) throw new Error("Missing test reservation.");
      Object.assign(row, args.data);
      return row;
    }),
    findFirst: vi.fn(async (args: { where: { audit: { equals: string } } }) =>
      runs.find(run => run.audit.childThreadId === args.where.audit.equals) ?? null),
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ now: new Date() }]),
    automationRun,
    courseSupportBatch: { findMany: vi.fn(async () => batches) },
    course: {
      findMany: vi.fn(async () => candidates.map(candidate => ({ id: candidate.courseId, timeZone: "America/New_York" }))),
      findUnique: vi.fn(async () => ({ timeZone: "America/New_York" })),
    },
    coursePreference: {
      findMany: vi.fn(async (args: { where: { courseId: { in: string[] } | string; teeSearchId?: { in: string[] } } }) => {
        const ids = typeof args.where.courseId === "string" ? [args.where.courseId] : args.where.courseId.in;
        return ids.flatMap(courseId => {
          const teeSearch = sources.get(courseId);
          return teeSearch && (!args.where.teeSearchId || args.where.teeSearchId.in.includes(teeSearch.id))
            ? [{ courseId, teeSearch }] : [];
        });
      }),
    },
    courseSupportIncident: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const candidate = candidates.find(entry => entry.incidentId === args.where.id);
        return candidate ? { ...candidate, updatedAt: new Date(candidate.updatedAt), activeBatchId: null } : null;
      }),
    },
  };
  const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
    const before = structuredClone(runs);
    try { return await operation(tx); }
    catch (error) { runs.splice(0, runs.length, ...before); throw error; }
  });
  const lease = vi.fn(async (operation: () => Promise<unknown>) => {
    const prior = leaseTail;
    let release!: () => void;
    leaseTail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  });
  return { runs, candidates, sources, batches, tx, transaction, lease, reset() { sequence = 0; leaseTail = Promise.resolve(); } };
});

vi.mock("@/lib/prisma", () => ({ prisma: { ...store.tx, $transaction: store.transaction } }));
vi.mock("./course-support-batches", () => ({
  MAX_CONCURRENT_COURSE_SUPPORT_BATCHES: 15,
  runWithCourseSupportWriterTransitionLease: store.lease,
  withCourseSupportWriteConflictRetry: (operation: () => Promise<unknown>) => operation(),
  listCourseSupportDispatchCandidates: async () => store.candidates,
}));

import {
  beginCourseSupportCourseDispatch,
  bindCourseSupportCourseDispatch,
  cancelCourseSupportCourseDispatch,
  consumeBoundCourseSupportDispatchAssignment,
  getCourseSupportCourseDispatchAssignment,
  loadBoundCourseSupportDispatchAssignment,
  planCourseSupportCourseDispatch,
} from "./course-support-course-dispatch";

const now = new Date("2026-10-05T13:40:05.000Z");
const baseSha = "a".repeat(40);
function populate(count: number, trafficClass = "PUBLIC") {
  for (let index = 0; index < count; index += 1) {
    const courseId = `course-${index}`;
    store.candidates.push({
      incidentId: `incident-${index}`, courseId, cycle: 1,
      providerFamilyKey: "family", failureFingerprint: "fingerprint",
      updatedAt: now.toISOString(), activeRealSearchCount: trafficClass === "PUBLIC" ? 1 : 0,
    });
    store.sources.set(courseId, {
      id: `alert-${Math.floor(index / 5)}`, status: "ACTIVE",
      date: new Date("2026-10-06T00:00:00.000Z"), endTime: "20:00",
      userTimeZone: "America/New_York", scheduleVersion: 1, alertGeneration: 0,
      trafficClass, syntheticMultiCycle: trafficClass === "TEST", syntheticTestWindow: null,
      createdAt: now,
      userId: "user-1", user: { id: "user-1", clerkUserId: "clerk-1", email: "owner@example.com", pendingEmail: null },
      alertEmail: "owner@example.com", additionalEmails: [], startTime: "06:00", players: 2,
      requestedLayoutHoles: null, cadenceMinutes: 15, preferences: [],
    });
  }
  for (const search of store.sources.values()) {
    search.preferences = store.candidates
      .filter(candidate => Math.floor(Number(candidate.courseId.split("-")[1]) / 5) === Number(search.id.split("-")[1]))
      .map((candidate, rank) => ({ courseId: candidate.courseId, rank: rank + 1 }));
  }
}

describe("durable course dispatch state and transaction boundaries", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    store.runs.length = 0; store.candidates.length = 0; store.sources.clear(); store.batches.length = 0;
    store.reset(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
  });

  it("serializes overlapping plans and never reserves a sixteenth course or a fourth alert", async () => {
    populate(20);
    const plans = await Promise.all([
      planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now, maxStarts: 15 }),
      planCourseSupportCourseDispatch({ ownerThreadId: "parent-b", baseSha, now, maxStarts: 15 }),
    ]);
    expect(store.runs).toHaveLength(15);
    expect(new Set(store.runs.map(run => run.audit.target.courseId)).size).toBe(15);
    expect(new Set(store.runs.map(run => run.audit.target.searchRefs[0].id)).size).toBe(3);
    expect(plans[1].reservedCount).toBe(15);
    expect(store.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it("does not refill a replayed tick after its reservations were cancelled", async () => {
    populate(5);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now, maxStarts: 5 });
    for (const item of plan.launchItems) await cancelCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: item.assignmentRef });
    await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now, maxStarts: 5 });
    expect(store.runs).toHaveLength(5);
    expect(store.runs.every(run => run.audit.state === "CANCELLED")).toBe(true);
  });

  it("counts every course in an existing grouped batch against the fifteen-course ceiling", async () => {
    populate(15);
    store.batches.push({
      id: "legacy-batch", summary: {}, leaseExpiresAt: new Date(now.getTime() + 60_000),
      incidents: Array.from({ length: 5 }, (_, index) => ({ courseId: `legacy-course-${index}` })),
    });
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now, maxStarts: 15 });
    expect(plan.activeCount).toBe(1);
    expect(plan.activeCourseCount).toBe(5);
    expect(plan.launchItems).toHaveLength(10);
    expect(plan.occupiedCourseCount).toBe(15);
  });

  it("rejects expired unlaunched reservations before native creation can begin", async () => {
    populate(1);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    vi.setSystemTime(new Date(now.getTime() + 10 * 60_000));
    await expect(beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: plan.launchItems[0].assignmentRef })).rejects.toThrow();
    expect(store.runs[0].audit.state).toBe("RESERVED");
  });

  it("fails closed on a malformed live reservation instead of hiding its occupied slot", async () => {
    store.runs.push({ id: "invalid", promptVersion: "course-support-course-dispatch-v1", status: "RUNNING", startedAt: now, audit: {} as CourseDispatchAudit });
    await expect(planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now })).rejects.toThrow();
    expect(store.tx.automationRun.create).not.toHaveBeenCalled();
  });

  it("retains unknown STARTING across later ticks without launching another course worker", async () => {
    populate(1);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = plan.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    const later = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-b", baseSha, now: new Date(now.getTime() + 20 * 60_000) });
    expect(store.runs).toHaveLength(1);
    expect(later.attention.startingCount).toBe(1);
    expect(later.launchItems).toEqual([]);
    expect(await getCourseSupportCourseDispatchAssignment({ assignmentRef, childThreadId: "prospective-child" })).toEqual({ outcome: "awaiting_binding", assignmentRef, state: "STARTING" });
    await expect(loadBoundCourseSupportDispatchAssignment({ assignmentRef, childThreadId: "prospective-child" })).rejects.toThrow();
  });

  it("replaces a known bound assignment after the base advances without changing its alert", async () => {
    populate(1);
    const first = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = first.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    await bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef, childThreadId: "child-a" });
    const later = new Date(now.getTime() + 10 * 60_000);
    vi.setSystemTime(later);
    const newBaseSha = "b".repeat(40);
    const next = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-b", baseSha: newBaseSha, now: later });
    expect(store.runs[0].audit.state).toBe("CANCELLED");
    expect(next.launchItems).toHaveLength(1);
    expect(next.launchItems[0].assignmentRef).not.toBe(assignmentRef);
    expect(store.runs[1].audit.baseSha).toBe(newBaseSha);
    await expect(loadBoundCourseSupportDispatchAssignment({ assignmentRef, childThreadId: "child-a" })).rejects.toThrow();
  });

  it("retains an unknown native STARTING outcome across a base advance", async () => {
    populate(1);
    const first = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = first.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    const later = new Date(now.getTime() + 10 * 60_000);
    const next = await planCourseSupportCourseDispatch({
      ownerThreadId: "parent-b", baseSha: "b".repeat(40), now: later,
    });
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].audit.state).toBe("STARTING");
    expect(next.attention.startingCount).toBe(1);
    expect(next.launchItems).toEqual([]);
  });

  it("expires an unlaunched reservation when the base advances before its timer", async () => {
    populate(1);
    const first = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const later = new Date(now.getTime() + 60_000);
    const next = await planCourseSupportCourseDispatch({
      ownerThreadId: "parent-b", baseSha: "b".repeat(40), now: later,
    });
    expect(store.runs[0].audit.state).toBe("EXPIRED");
    expect(next.launchItems).toHaveLength(1);
    expect(next.launchItems[0].assignmentRef).not.toBe(first.launchItems[0].assignmentRef);
  });

  it("requires exact native child binding and never binds one chat to two courses", async () => {
    populate(2);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const [first, second] = plan.launchItems;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: first.assignmentRef });
    await expect(beginCourseSupportCourseDispatch({ ownerThreadId: "wrong-parent", assignmentRef: second.assignmentRef })).rejects.toThrow();
    expect(() => bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: first.assignmentRef, childThreadId: "parent-a" })).toThrow();
    await bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: first.assignmentRef, childThreadId: "child-a" });
    await expect(loadBoundCourseSupportDispatchAssignment({ assignmentRef: first.assignmentRef, childThreadId: "wrong-child" })).rejects.toThrow();
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: second.assignmentRef });
    await expect(bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: second.assignmentRef, childThreadId: "child-a" })).rejects.toThrow();
    expect(store.runs.find(run => run.audit.assignmentRef === second.assignmentRef)?.audit.state).toBe("STARTING");
  });

  it("rolls reservation consumption back when the containing batch claim transaction fails", async () => {
    populate(1);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = plan.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    await bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef, childThreadId: "child-a" });
    await expect(store.transaction(async tx => {
      await consumeBoundCourseSupportDispatchAssignment(tx as never, { assignmentRef, childThreadId: "child-a", baseSha, now });
      throw new Error("batch write failed");
    })).rejects.toThrow("batch write failed");
    expect(store.runs[0].audit.state).toBe("BOUND");
    await store.transaction(tx => consumeBoundCourseSupportDispatchAssignment(tx as never, { assignmentRef, childThreadId: "child-a", baseSha, now }));
    expect(store.runs[0].audit.state).toBe("CONSUMED");
    expect(store.runs[0].status).toBe("COMPLETED");
    await expect(consumeBoundCourseSupportDispatchAssignment(store.tx as never, { assignmentRef, childThreadId: "child-a", baseSha, now })).rejects.toThrow();
  });

  it("revokes bound work when its alert generation changes instead of falling back to another course", async () => {
    populate(1);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = plan.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    await bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef, childThreadId: "child-a" });
    store.sources.get("course-0")!.alertGeneration += 1;
    await planCourseSupportCourseDispatch({ ownerThreadId: "parent-b", baseSha, now });
    expect(store.runs[0].audit.state).toBe("CANCELLED");
    await expect(loadBoundCourseSupportDispatchAssignment({ assignmentRef, childThreadId: "child-a" })).rejects.toThrow();
  });

  it("keeps a bound worker through schedule-only recovery from version two to four", async () => {
    populate(1);
    store.sources.get("course-0")!.scheduleVersion = 2;
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = plan.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    await bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef, childThreadId: "child-a" });
    store.sources.get("course-0")!.scheduleVersion = 4;
    const later = new Date(now.getTime() + 10 * 60_000);
    await planCourseSupportCourseDispatch({ ownerThreadId: "parent-b", baseSha, now: later });
    expect(store.runs[0].audit.state).toBe("BOUND");
    expect(store.runs[0].audit.target.searchRefs[0].intentDigest).toMatch(/^[0-9a-f]{64}$/);
    await expect(loadBoundCourseSupportDispatchAssignment({ assignmentRef, childThreadId: "child-a" }))
      .resolves.toMatchObject({ assignmentRef, state: "BOUND" });
  });

  it("admits an opted-in synthetic source without reclassifying it and excludes it after its lifetime", async () => {
    populate(1, "TEST");
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    expect(plan.launchItems).toHaveLength(1);
    expect(store.runs[0].audit.target.trafficClass).toBe("SYNTHETIC");
    expect(store.sources.get("course-0")!.trafficClass).toBe("TEST");
    store.runs.length = 0;
    const expired = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-b", baseSha, now: new Date(now.getTime() + 18 * 60 * 60_000) });
    expect(expired.launchItems).toEqual([]);
  });
});
