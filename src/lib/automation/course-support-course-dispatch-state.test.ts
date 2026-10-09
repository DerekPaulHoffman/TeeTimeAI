import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAbsolute } from "node:path";
import type { CourseDispatchAudit } from "./course-support-course-dispatch";
import { createSimulatorSupportIntentDigest } from "./simulator-support-policy";

// Reproduce the deployed POSIX reader even when local feedback runs on Windows.
// The serialized receipt remains a fact of the original native host.
vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>();
  const emulated = { ...actual, isAbsolute: actual.posix.isAbsolute };
  return { ...emulated, default: emulated };
});

type StoredRun = {
  id: string;
  promptVersion: string;
  status: string;
  startedAt: Date;
  audit: CourseDispatchAudit;
};
type SourceSearch = {
  id: string; mode: "OUTDOOR" | "SIMULATOR"; status: string; date: Date; endTime: string; userTimeZone: string;
  scheduleVersion: number; alertGeneration: number; trafficClass: string;
  syntheticMultiCycle: boolean; syntheticTestWindow: null; createdAt: Date;
  userId: string; user: { id: string; clerkUserId: string; email: string; pendingEmail: string | null };
  alertEmail: string | null; additionalEmails: string[]; startTime: string; players: number;
  requestedLayoutHoles: number | null; cadenceMinutes: number;
  durationMinutes: number | null; checkStatus: string; checkLeaseExpiresAt: Date | null;
  remediationDispatchKey: string | null; remediationDispatchVersion: number | null;
  preferences: { courseId: string; offeringId: string | null; rank: number }[];
};
type Candidate = {
  incidentId: string; courseId: string; cycle: number; providerFamilyKey: string;
  failureFingerprint: string; updatedAt: string; activeRealSearchCount: number;
};

const store = vi.hoisted(() => {
  const runs: StoredRun[] = [];
  const candidates: Candidate[] = [];
  const sources = new Map<string, SourceSearch>();
  const courseTimeZones = new Map<string, string>();
  const batches: { id: string; summary: unknown; leaseExpiresAt: Date; incidents: { courseId: string }[] }[] = [];
  let sequence = 0;
  let leaseTail = Promise.resolve();
  let transitionDenials = 0;
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
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.flatMap(id => courseTimeZones.has(id) ? [{ id, timeZone: courseTimeZones.get(id)! }] : [])),
      findUnique: vi.fn(async () => ({ timeZone: "America/New_York" })),
    },
    teeSearch: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        const requested = new Set(args.where.id.in);
        const found = new Map([...sources.values()].filter(search => requested.has(search.id)).map(search => [search.id, search]));
        return [...found.values()];
      }),
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
  const lease = vi.fn(async (operation: (context: { deadlineAt: Date; timeoutMs: number }) => Promise<unknown>, options?: { timeout: number }) => {
    if (options && transitionDenials-- > 0) return { acquired: false as const };
    const prior = leaseTail;
    let release!: () => void;
    leaseTail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { const value = await operation({ deadlineAt: new Date(Date.now() + (options?.timeout ?? 60_000)), timeoutMs: options?.timeout ?? 60_000 });
      return options ? { acquired: true as const, value } : value; } finally { release(); }
  });
  return { runs, candidates, sources, courseTimeZones, batches, tx, transaction, lease,
    denyTransitions(count: number) { transitionDenials = count; },
    reset() { sequence = 0; leaseTail = Promise.resolve(); transitionDenials = 0; } };
});

vi.mock("@/lib/prisma", () => ({ prisma: { ...store.tx, $transaction: store.transaction } }));
vi.mock("./course-support-batches", () => ({
  MAX_CONCURRENT_COURSE_SUPPORT_BATCHES: 15,
  runWithCourseSupportWriterTransitionLease: store.lease,
  withCourseSupportWriteConflictRetry: (operation: () => Promise<unknown>) => operation(),
  listCourseSupportDispatchCandidates: async () => store.candidates,
}));
vi.mock("./simulator-support-incidents", () => ({ listSimulatorSupportDispatchCandidates: async () => [] }));

import {
  beginCourseSupportCourseDispatch,
  bindCourseSupportCourseDispatch,
  cancelCourseSupportCourseDispatch,
  consumeBoundCourseSupportDispatchAssignment,
  getCourseSupportCourseDispatchAssignment,
  listLiveCourseSupportDispatchReservations,
  loadBoundCourseSupportDispatchAssignment,
  parseCourseDispatchAudit,
  planCourseSupportCourseDispatch,
} from "./course-support-course-dispatch";

const now = new Date("2026-10-05T13:40:05.000Z");
const baseSha = "a".repeat(40);

function persistedNativeAudit(): CourseDispatchAudit {
  const fingerprint = "b".repeat(64);
  return { schemaVersion: 1, tickRef: "saved-tick", assignmentRef: "saved-assignment", state: "CONSUMED",
    ownerThreadId: "original-parent", childThreadId: "original-child", baseSha,
    reservedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    launcherReceiptPath: "C:\\private\\original-native\\launcher.receipt.private.json",
    target: { mode: "SIMULATOR", offeringId: "saved-offering", offeringSourceFingerprint: fingerprint,
      incidentId: "saved-incident", courseId: "saved-course", cycle: 1, providerFamilyKey: "SIM",
      failureFingerprint: fingerprint, updatedAt: now.toISOString(), trafficClass: "SYNTHETIC",
      searchRefs: [{ id: "saved-search", scheduleVersion: 1, alertGeneration: 0 }] },
    simulatorClaim: { token: "synthetic-original-owner", revision: 11, phase: "VERIFYING", claimedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 900_000).toISOString(), sourceFingerprint: fingerprint,
      originalSourceFingerprint: fingerprint, offeringRevision: 1, plannedPaths: [], releaseSha: baseSha,
      branch: "fix/check-public-rentals", deployment: null, recheckQueuedAt: null, verificationCycle: 0 },
  };
}

describe("persisted native receipt paths across reader operating systems", () => {
  beforeEach(() => { store.runs.length = 0; store.reset(); vi.clearAllMocks(); });

  it("parses the actual serialized Windows receipt provenance under a POSIX reader without rewriting it", () => {
    const saved = JSON.parse(JSON.stringify(persistedNativeAudit())) as CourseDispatchAudit;
    expect(isAbsolute(saved.launcherReceiptPath!)).toBe(false);
    expect(parseCourseDispatchAudit(saved)).toEqual(saved);
    expect(saved.launcherReceiptPath).toBe("C:\\private\\original-native\\launcher.receipt.private.json");
  });

  it("keeps the consumed owner reachable through the deployed live-assignment read before verification reserves anything", async () => {
    const audit = JSON.parse(JSON.stringify(persistedNativeAudit())) as CourseDispatchAudit;
    const row = { id: "saved-run", promptVersion: "course-support-course-dispatch-v1",
      status: "RUNNING", startedAt: now, audit };
    store.runs.push(row);
    const before = structuredClone(store.runs);
    await expect(listLiveCourseSupportDispatchReservations(store.tx as unknown as
      Parameters<typeof listLiveCourseSupportDispatchReservations>[0])).resolves.toEqual([{ runId: row.id, audit }]);
    expect(store.runs).toEqual(before);
    expect(store.tx.automationRun.update).not.toHaveBeenCalled();
  });

  it.each([
    "C:\\private\\original-native\\launcher.receipt.private.json",
    "C:/private/original-native/launcher.receipt.private.json",
    "\\\\native-host\\private-share\\original-native\\launcher.receipt.private.json",
    "/private/original-native/launcher.receipt.private.json",
  ])("retains genuine absolute originating-host provenance: %s", launcherReceiptPath => {
    const audit = { ...persistedNativeAudit(), launcherReceiptPath };
    expect(parseCourseDispatchAudit(audit)).toEqual(audit);
  });

  it.each([
    "", "private/launcher.receipt.private.json", "private\\launcher.receipt.private.json",
    "C:private\\launcher.receipt.private.json", "https://example.test/launcher.receipt.private.json",
    "C:\\private\\launcher.receipt.json", "/private/launcher.receipt.json",
    null, 42, {}, [],
  ])("rejects relative, wrong-suffix or non-string stored path: %j", launcherReceiptPath => {
    expect(parseCourseDispatchAudit({ ...persistedNativeAudit(), launcherReceiptPath })).toBeNull();
  });

  it("keeps the existing serialized identity, fingerprint, revision and source bounds", () => {
    const audit = persistedNativeAudit();
    expect(parseCourseDispatchAudit({ ...audit, launcherReceiptPath: undefined })).toEqual({ ...audit, launcherReceiptPath: undefined });
    for (const invalid of [
      { ...audit, childThreadId: null }, { ...audit, baseSha: "invalid" },
      { ...audit, target: { ...audit.target, cycle: 0 } },
      { ...audit, target: { ...audit.target, offeringSourceFingerprint: "invalid" } },
      { ...audit, target: { ...audit.target, searchRefs: Array.from({ length: 4 }, (_, i) =>
        ({ id: "search-" + i, scheduleVersion: 1, alertGeneration: 0 })) } },
      { ...audit, simulatorClaim: { ...audit.simulatorClaim!, revision: 0 } },
    ]) expect(parseCourseDispatchAudit(invalid)).toBeNull();
  });

  it("does not grant a POSIX executor local bind authority for a Windows filesystem path", () => {
    const receipt = persistedNativeAudit().launcherReceiptPath!;
    expect(() => bindCourseSupportCourseDispatch({ ownerThreadId: "original-parent",
      assignmentRef: "saved-assignment", childThreadId: "original-child", launcherReceiptPath: receipt }))
      .toThrow("Original launcher receipt path is invalid");
    expect(store.lease).not.toHaveBeenCalled();
  });
});

function populate(count: number, trafficClass = "PUBLIC", offset = 0, searchPrefix = "alert") {
  for (let index = 0; index < count; index += 1) {
    const courseNumber = index + offset;
    const courseId = `course-${courseNumber}`;
    store.courseTimeZones.set(courseId, "America/New_York");
    store.candidates.push({
      incidentId: `incident-${index}`, courseId, cycle: 1,
      providerFamilyKey: "family", failureFingerprint: "fingerprint",
      updatedAt: now.toISOString(), activeRealSearchCount: trafficClass === "PUBLIC" ? 1 : 0,
    });
    store.sources.set(courseId, {
      id: `${searchPrefix}-${Math.floor(courseNumber / 5)}`, mode: "OUTDOOR", status: "ACTIVE",
      date: new Date("2026-10-06T00:00:00.000Z"), endTime: "20:00",
      userTimeZone: "America/New_York", scheduleVersion: 1, alertGeneration: 0,
      trafficClass, syntheticMultiCycle: trafficClass === "TEST", syntheticTestWindow: null,
      createdAt: now,
      userId: "user-1", user: { id: "user-1", clerkUserId: "clerk-1", email: "owner@example.com", pendingEmail: null },
      alertEmail: "owner@example.com", additionalEmails: [], startTime: "06:00", players: 2,
      requestedLayoutHoles: null, cadenceMinutes: 15, durationMinutes: null,
      checkStatus: "WAITING", checkLeaseExpiresAt: null, remediationDispatchKey: null, remediationDispatchVersion: null,
      preferences: [],
    });
  }
  for (const search of store.sources.values()) {
    if (!search.id.startsWith(`${searchPrefix}-`)) continue;
    search.preferences = store.candidates
      .filter(candidate => Math.floor(Number(candidate.courseId.split("-")[1]) / 5) === Number(search.id.split("-")[1]))
      .map((candidate, rank) => ({ courseId: candidate.courseId, offeringId: null, rank: rank + 1 }));
  }
}

describe("durable course dispatch state and transaction boundaries", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    store.runs.length = 0; store.candidates.length = 0; store.sources.clear(); store.courseTimeZones.clear(); store.batches.length = 0;
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

  it("retains an expired implementation claim's slot and alert budget until its provenance is handed off", async () => {
    populate(15);
    const simulatorSource: SourceSearch = {
      ...store.sources.get("course-0")!, id: "sim-search", mode: "SIMULATOR", durationMinutes: 60,
      preferences: [{ courseId: "sim-course", offeringId: "sim-offering", rank: 1 }],
    };
    store.sources.set("sim-course", simulatorSource);
    store.courseTimeZones.set("sim-course", "America/New_York");
    const intentDigest = createSimulatorSupportIntentDigest(simulatorSource as unknown as Parameters<typeof createSimulatorSupportIntentDigest>[0]);
    store.runs.push({ id: "simulator-owner", promptVersion: "course-support-course-dispatch-v1", status: "RUNNING", startedAt: now,
      audit: { schemaVersion: 1, tickRef: "previous", assignmentRef: "simulator-assignment", state: "CONSUMED", ownerThreadId: "parent", childThreadId: "sim-child", baseSha,
        reservedAt: now.toISOString(), expiresAt: now.toISOString(), target: { mode: "SIMULATOR", offeringId: "sim-offering", offeringSourceFingerprint: "a".repeat(64),
          incidentId: "sim-incident", courseId: "sim-course", cycle: 1, providerFamilyKey: "SIM", failureFingerprint: "a".repeat(64), updatedAt: now.toISOString(),
          trafficClass: "REAL", searchRefs: [{ id: "sim-search", scheduleVersion: 1, alertGeneration: 0, intentDigest }] },
        simulatorClaim: { token: "owned", revision: 1, phase: "IMPLEMENTING", claimedAt: now.toISOString(), leaseExpiresAt: now.toISOString(), sourceFingerprint: "a".repeat(64), originalSourceFingerprint: "a".repeat(64),
          offeringRevision: 0, plannedPaths: ["src/lib/simulators/providers/owned.ts"], releaseSha: null, branch: "automation/course-support-sim", deployment: null, recheckQueuedAt: null, verificationCycle: 0 } } });
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now, maxStarts: 15 });
    expect(plan.launchItems).toHaveLength(10);
    expect(plan.reservedCount).toBe(11);
    expect(plan.attention.expiredBatchCount).toBe(1);
    expect(store.runs[0].audit.state).toBe("CONSUMED");
    expect(new Set(store.runs.flatMap(run => run.audit.target.searchRefs.map(ref => ref.id))).size).toBe(3);
  });

  it("binds once after two writer refusals without replaying the native child", async () => {
    populate(1);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = plan.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    store.denyTransitions(2);
    const updateCount = store.tx.automationRun.update.mock.calls.length;
    const binding = bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef, childThreadId: "child-a" });
    await vi.advanceTimersByTimeAsync(75);
    await vi.advanceTimersByTimeAsync(150);
    expect(await binding).toMatchObject({ acquired: true, value: { state: "BOUND" } });
    expect(store.tx.automationRun.update.mock.calls.length - updateCount).toBe(1);
    expect(store.runs[0].audit.childThreadId).toBe("child-a");
  });

  it("rechecks database authority after waiting and rejects an expired bind", async () => {
    populate(1);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = plan.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    store.runs[0].audit.launchStartedAt = new Date(now.getTime() - 15 * 60_000 + 50).toISOString();
    store.denyTransitions(1);
    const binding = bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef, childThreadId: "late-child" });
    const rejected = expect(binding).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(75);
    await rejected;
    expect(store.runs[0].audit.state).toBe("STARTING");
    expect(store.runs[0].audit.childThreadId).toBeNull();
  });

  it("keeps ended uncertain STARTING owners in physical slots without charging active alert cohorts", async () => {
    populate(15, "PUBLIC", 100, "ended");
    await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now, maxStarts: 15 });
    const historical = ["ended-20", "ended-21", "ended-22"].map(id =>
      store.runs.find(run => run.audit.target.searchRefs[0].id === id)!);
    expect(historical.every(Boolean)).toBe(true);
    for (const run of historical) {
      await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: run.audit.assignmentRef });
      run.audit.tickRef = "previous";
      run.startedAt = new Date(now.getTime() - 10 * 60_000);
    }
    store.runs.splice(0, store.runs.length, ...historical);
    store.candidates.length = 0;
    for (const [courseId, search] of store.sources) {
      if (!courseId.startsWith("course-1")) continue;
      if (search.id === "ended-20") search.status = "COMPLETED";
      if (search.id === "ended-21") search.status = "CANCELLED";
      if (search.id === "ended-22") search.date = new Date("2026-10-04T00:00:00.000Z");
    }
    populate(15, "PUBLIC", 0, "fresh");
    expect(store.sources.get("course-110")!.preferences).toHaveLength(5);
    expect(store.sources.get("course-110")!.status).toBe("ACTIVE");

    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-b", baseSha, now, maxStarts: 15 });
    expect(historical.map(run => run.audit.state)).toEqual(["STARTING", "STARTING", "STARTING"]);
    expect(plan.attention.startingCount).toBe(3);
    expect(plan.occupiedCourseCount).toBe(15);
    expect(plan.launchItems).toHaveLength(12);
    expect(new Set(plan.launchItems.map(item => store.runs.find(run => run.audit.assignmentRef === item.assignmentRef)!.audit.target.searchRefs[0].id)))
      .toEqual(new Set(["fresh-0", "fresh-1", "fresh-2"]));
    expect(store.runs.filter(run => run.audit.state === "STARTING")).toHaveLength(3);
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

  it("expires an abandoned startup on a later tick and fences its late binding", async () => {
    populate(1);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = plan.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    const later = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-b", baseSha, now: new Date(now.getTime() + 20 * 60_000) });
    expect(store.runs).toHaveLength(2);
    expect(store.runs[0].audit.state).toBe("EXPIRED");
    expect(store.runs[0].audit.launchStartedAt).toBe(now.toISOString());
    expect(later.attention.startingCount).toBe(0);
    expect(later.launchItems).toHaveLength(1);
    await expect(getCourseSupportCourseDispatchAssignment({ assignmentRef, childThreadId: "prospective-child" })).rejects.toThrow();
    await expect(bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef, childThreadId: "prospective-child" })).rejects.toThrow();
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
    expect(store.runs[0].audit.state).toBe("EXPIRED");
    expect(next.launchItems).toHaveLength(1);
    expect(next.launchItems[0].assignmentRef).not.toBe(assignmentRef);
    expect(store.runs[1].audit.baseSha).toBe(newBaseSha);
    await expect(loadBoundCourseSupportDispatchAssignment({ assignmentRef, childThreadId: "child-a" })).rejects.toThrow();
  });

  it("revokes unclaimed startup authority when the base advances while retaining its audit", async () => {
    populate(1);
    const first = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const assignmentRef = first.launchItems[0].assignmentRef;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef });
    const later = new Date(now.getTime() + 10 * 60_000);
    const next = await planCourseSupportCourseDispatch({
      ownerThreadId: "parent-b", baseSha: "b".repeat(40), now: later,
    });
    expect(store.runs).toHaveLength(2);
    expect(store.runs[0].audit.state).toBe("EXPIRED");
    expect(store.runs[0].audit.ownerThreadId).toBe("parent-a");
    expect(next.attention.startingCount).toBe(0);
    expect(next.launchItems).toHaveLength(1);
  });

  it("rejects late binding and claiming at the deadline before a planner runs", async () => {
    populate(2);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-a", baseSha, now });
    const [starting, bound] = plan.launchItems;
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: starting.assignmentRef });
    await beginCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: bound.assignmentRef });
    await bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: bound.assignmentRef, childThreadId: "child-a" });
    const deadline = new Date(now.getTime() + 15 * 60_000);
    vi.setSystemTime(deadline);
    await expect(bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: starting.assignmentRef, childThreadId: "late-child" })).rejects.toThrow("expired");
    await expect(bindCourseSupportCourseDispatch({ ownerThreadId: "parent-a", assignmentRef: bound.assignmentRef, childThreadId: "child-a" })).rejects.toThrow("expired");
    await expect(loadBoundCourseSupportDispatchAssignment({ assignmentRef: bound.assignmentRef, childThreadId: "child-a" })).rejects.toThrow();
    await expect(consumeBoundCourseSupportDispatchAssignment(store.tx as never, { assignmentRef: bound.assignmentRef, childThreadId: "child-a", baseSha, now: deadline })).rejects.toThrow();
    const next = await planCourseSupportCourseDispatch({ ownerThreadId: "parent-b", baseSha, now: deadline });
    expect(next.launchItems).toHaveLength(2);
    expect(store.runs.slice(0, 2).map(run => run.audit.state)).toEqual(["EXPIRED", "EXPIRED"]);
    expect(store.runs.find(run => run.audit.assignmentRef === bound.assignmentRef)?.audit.childThreadId).toBe("child-a");
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
