import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isSearchWindowActive } from "./date-boundary";
import { getSyntheticMultiCycleExpiresAt } from "./synthetic-test-window";
import {
  COURSE_DISPATCH_SOURCE_SELECT,
  createCourseDispatchIntentDigest,
  isCurrentCourseDispatchSource,
  type CourseDispatchSourceRef,
} from "./course-support-dispatch-intent";
import {
  listCourseSupportDispatchCandidates,
  MAX_CONCURRENT_COURSE_SUPPORT_BATCHES,
  runWithCourseSupportWriterTransitionLease,
  withCourseSupportWriteConflictRetry,
} from "./course-support-batches";

export const COURSE_DISPATCH_PROMPT_VERSION = "course-support-course-dispatch-v1";
const RESERVATION_MS = 10 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
export const MAX_NEW_COURSE_WORKERS_PER_TICK = 5;

export type CourseDispatchStartupReceipt = {
  schemaVersion: 1;
  receiptPath: string;
  preparedReceiptSha256: string;
};

export type CourseDispatchStartupTerminalProof = {
  outcome: "READY";
  assignmentRef: string;
  childThreadId: string;
  turnId: string;
  terminationKind: "MATCHED_TURN_COMPLETED";
  turnStatus: "completed" | "failed" | "interrupted";
  firstTurnStartedAt: string;
  terminalAt: string;
  appServerShutdownAt: string;
  preparedReceiptSha256: string;
  receiptSha256: string;
  promptSha256: string;
  firstTurnMarkerSha256: string;
  nativeIdentityVerified: boolean;
  approvalRequests: number;
};

function validStartupReceipt(value: unknown): value is CourseDispatchStartupReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<CourseDispatchStartupReceipt>;
  return receipt.schemaVersion === 1 && typeof receipt.receiptPath === "string" &&
    receipt.receiptPath.length <= 4096 && /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(receipt.receiptPath) &&
    !/[\r\n\0]/.test(receipt.receiptPath) &&
    typeof receipt.preparedReceiptSha256 === "string" && /^[a-f0-9]{64}$/i.test(receipt.preparedReceiptSha256);
}

type DispatchState = "RESERVED" | "STARTING" | "BOUND" | "CONSUMED" | "CANCELLED" | "EXPIRED";
export type CourseDispatchAudit = {
  schemaVersion: 1;
  tickRef: string;
  assignmentRef: string;
  state: DispatchState;
  ownerThreadId: string;
  childThreadId: string | null;
  baseSha: string;
  reservedAt: string;
  expiresAt: string;
  launchStartedAt?: string;
  boundAt?: string;
  consumedAt?: string;
  startupReceipt?: CourseDispatchStartupReceipt;
  startupRetirement?: {
    schemaVersion: 1;
    reconcilerThreadId: string;
    reconciledAt: string;
    turnId: string;
    turnStatus: "completed" | "failed" | "interrupted";
    terminalAt: string;
    firstTurnMarkerSha256: string;
    terminalReceiptSha256: string;
  };
  target: {
    incidentId: string;
    courseId: string;
    cycle: number;
    providerFamilyKey: string;
    failureFingerprint: string;
    updatedAt: string;
    searchRefs: CourseDispatchSourceRef[];
    trafficClass: "REAL" | "SYNTHETIC";
  };
};

function parseAudit(value: unknown): CourseDispatchAudit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const audit = value as Partial<CourseDispatchAudit>;
  if (
    audit.schemaVersion !== 1 ||
    typeof audit.assignmentRef !== "string" ||
    typeof audit.tickRef !== "string" ||
    typeof audit.ownerThreadId !== "string" ||
    typeof audit.baseSha !== "string" ||
    !["RESERVED", "STARTING", "BOUND", "CONSUMED", "CANCELLED", "EXPIRED"].includes(audit.state ?? "") ||
    !audit.target ||
    typeof audit.target.incidentId !== "string" ||
    typeof audit.target.courseId !== "string" ||
    typeof audit.target.cycle !== "number" ||
    typeof audit.target.providerFamilyKey !== "string" ||
    typeof audit.target.failureFingerprint !== "string" ||
    typeof audit.target.updatedAt !== "string" ||
    !Array.isArray(audit.target.searchRefs)
  ) return null;
  if (!/^[a-f0-9]{40}$/i.test(audit.baseSha) ||
      !Number.isInteger(audit.target.cycle) || audit.target.cycle < 1 ||
      !audit.target.providerFamilyKey || !audit.target.failureFingerprint ||
      !["REAL", "SYNTHETIC"].includes(audit.target.trafficClass) ||
      !audit.ownerThreadId ||
      !Number.isFinite(Date.parse(audit.reservedAt ?? "")) ||
      !Number.isFinite(Date.parse(audit.expiresAt ?? "")) ||
      !Number.isFinite(Date.parse(audit.target.updatedAt)) ||
      audit.target.searchRefs.length < 1 || audit.target.searchRefs.length > 3 ||
      audit.target.searchRefs.some((ref) => !ref || typeof ref.id !== "string" || !ref.id ||
        !Number.isInteger(ref.scheduleVersion) || ref.scheduleVersion < 0 ||
        !Number.isInteger(ref.alertGeneration) || ref.alertGeneration < 0 ||
        (ref.intentDigest !== undefined &&
          (typeof ref.intentDigest !== "string" || !/^[a-f0-9]{64}$/i.test(ref.intentDigest)))) ||
      new Set(audit.target.searchRefs.map((ref) => ref.id)).size !== audit.target.searchRefs.length ||
      (audit.state === "BOUND" && !audit.childThreadId) ||
      (["RESERVED", "STARTING"].includes(audit.state ?? "") && audit.childThreadId !== null) ||
      (audit.startupReceipt !== undefined && !validStartupReceipt(audit.startupReceipt))) return null;
  return audit as CourseDispatchAudit;
}

function assertIdentity(ownerThreadId: string, baseSha?: string) {
  if (!ownerThreadId.trim()) throw new Error("Course dispatch requires a native parent task id.");
  if (baseSha !== undefined && !/^[a-f0-9]{40}$/i.test(baseSha)) {
    throw new Error("Course dispatch requires the exact base SHA.");
  }
}

function tickRef(now: Date) {
  return `course-${Math.floor(now.getTime() / TICK_MS)}`;
}

function countSearchIds(ids: readonly string[]) {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

export function selectCourseDispatchTargets<T extends {
  courseId: string;
  activeRealSearchCount: number;
}>(input: {
  candidates: readonly T[];
  sourceSearchesByCourse: ReadonlyMap<string, readonly (CourseDispatchSourceRef & { trafficClass: string })[]>;
  occupiedCourses: ReadonlySet<string>;
  priorSearchIds: ReadonlySet<string>;
  priorSearchCounts?: ReadonlyMap<string, number>;
  maxStarts: number;
}) {
  const admitted = new Set(input.priorSearchIds);
  const searchCounts = new Map(input.priorSearchCounts ?? []);
  const seen = new Set(input.occupiedCourses);
  const selected: { candidate: T; source: CourseDispatchSourceRef & { trafficClass: string } }[] = [];
  let eligibleCount = 0;
  const ordered = [...input.candidates].sort((a, b) =>
    Number(b.activeRealSearchCount > 0) - Number(a.activeRealSearchCount > 0) ||
    a.courseId.localeCompare(b.courseId));
  for (const candidate of ordered) {
    if (seen.has(candidate.courseId)) continue;
    const sources = input.sourceSearchesByCourse.get(candidate.courseId) ?? [];
    const source = sources.find((ref) => admitted.has(ref.id) && (searchCounts.get(ref.id) ?? 0) < 5) ??
      (admitted.size < 3 ? sources.find((ref) => (searchCounts.get(ref.id) ?? 0) < 5) : undefined);
    if (!source) continue;
    seen.add(candidate.courseId);
    admitted.add(source.id);
    searchCounts.set(source.id, (searchCounts.get(source.id) ?? 0) + 1);
    eligibleCount += 1;
    if (selected.length < input.maxStarts) selected.push({ candidate, source });
  }
  return { selected, eligibleCount, admittedSearchCount: admitted.size };
}

async function transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
  return withCourseSupportWriteConflictRetry(() =>
    prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15_000,
    }),
  );
}

async function getCourseDispatchDatabaseNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS "now"`,
  );
  if (!(row?.now instanceof Date) || !Number.isFinite(row.now.getTime())) {
    throw new Error("Course dispatch database time is unavailable.");
  }
  return row.now;
}

async function readRuns(tx: Prisma.TransactionClient, since?: Date) {
  const runs = await tx.automationRun.findMany({
    where: {
      promptVersion: COURSE_DISPATCH_PROMPT_VERSION,
      OR: [{ status: "RUNNING" }, ...(since ? [{ startedAt: { gte: since } }] : [])],
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: 64,
    select: { id: true, promptVersion: true, audit: true, status: true },
  });
  const dispatchRuns = runs.filter((run) => run.promptVersion === COURSE_DISPATCH_PROMPT_VERSION);
  if (runs.length === 64 || dispatchRuns.some((run) => !parseAudit(run.audit))) {
    throw new Error("Course dispatch history reached the bounded read limit.");
  }
  return dispatchRuns.map((run) => ({ ...run, parsed: parseAudit(run.audit) }));
}

async function expireUnlaunched(
  tx: Prisma.TransactionClient,
  now: Date,
  currentBaseSha: string,
  runs: Awaited<ReturnType<typeof readRuns>>,
) {
  for (const run of runs) {
    if (run.status !== "RUNNING" || run.parsed?.state !== "RESERVED") continue;
    const baseChanged = run.parsed.baseSha !== currentBaseSha;
    if (!baseChanged && new Date(run.parsed.expiresAt).getTime() > now.getTime()) continue;
    const audit: CourseDispatchAudit = { ...run.parsed, state: "EXPIRED" };
    await tx.automationRun.update({
      where: { id: run.id },
      data: { audit: audit as unknown as Prisma.InputJsonValue, status: "COMPLETED", completedAt: now,
        outcome: baseChanged ? "base_changed_before_launch" : "reservation_expired" },
    });
    run.status = "COMPLETED";
    run.parsed = audit;
  }
}

async function revokeStaleBound(
  tx: Prisma.TransactionClient,
  now: Date,
  currentBaseSha: string,
  runs: Awaited<ReturnType<typeof readRuns>>,
) {
  for (const run of runs) {
    const audit = run.parsed;
    if (run.status !== "RUNNING" || !audit || audit.state !== "BOUND") continue;
    const baseChanged = audit.baseSha !== currentBaseSha;
    const incident = baseChanged ? null : await tx.courseSupportIncident.findUnique({
      where: { id: audit.target.incidentId },
      select: {
        courseId: true, cycle: true, providerFamilyKey: true,
        failureFingerprint: true, updatedAt: true, activeBatchId: true,
      },
    });
    let stale = baseChanged || !incident || incident.courseId !== audit.target.courseId ||
      incident.cycle !== audit.target.cycle ||
      incident.providerFamilyKey !== audit.target.providerFamilyKey ||
      incident.failureFingerprint !== audit.target.failureFingerprint ||
      incident.updatedAt.toISOString() !== audit.target.updatedAt ||
      incident.activeBatchId !== null;
    if (!stale) {
      const searches = await tx.coursePreference.findMany({
        where: { courseId: audit.target.courseId, teeSearchId: { in: audit.target.searchRefs.map((ref) => ref.id) } },
        select: { teeSearch: { select: COURSE_DISPATCH_SOURCE_SELECT } },
      });
      const course = await tx.course.findUnique({ where: { id: audit.target.courseId }, select: { timeZone: true } });
      stale = !course || searches.length !== audit.target.searchRefs.length ||
        searches.some(({ teeSearch }) => {
          const ref = audit.target.searchRefs.find((entry) => entry.id === teeSearch.id);
          return !ref || !isCurrentCourseDispatchSource({
            ref, search: teeSearch, trafficClass: audit.target.trafficClass,
            courseTimeZone: course!.timeZone, now,
          });
        });
    }
    if (!stale) continue;
    const updated: CourseDispatchAudit = { ...audit, state: "CANCELLED" };
    await tx.automationRun.update({
      where: { id: run.id },
      data: { audit: updated as unknown as Prisma.InputJsonValue,
        status: "COMPLETED", completedAt: now,
        outcome: baseChanged ? "base_changed_before_claim" : "stale_bound_assignment" },
    });
    run.status = "COMPLETED";
    run.parsed = updated;
  }
}

export async function planCourseSupportCourseDispatch(input: {
  ownerThreadId: string;
  baseSha: string;
  now?: Date;
  maxStarts?: number;
}) {
  assertIdentity(input.ownerThreadId, input.baseSha);
  const maxStarts = input.maxStarts ?? MAX_NEW_COURSE_WORKERS_PER_TICK;
  if (!Number.isInteger(maxStarts) || maxStarts < 1 || maxStarts > MAX_NEW_COURSE_WORKERS_PER_TICK) {
    throw new Error("Course dispatch maxStarts must be from 1 through 5.");
  }
  return runWithCourseSupportWriterTransitionLease(async () => transaction(async (tx) => {
    const now = input.now ?? await getCourseDispatchDatabaseNow(tx);
    const runs = await readRuns(tx, new Date(Math.floor(now.getTime() / TICK_MS) * TICK_MS));
    await expireUnlaunched(tx, now, input.baseSha, runs);
    await revokeStaleBound(tx, now, input.baseSha, runs);
    const tick = tickRef(now);
    const sameTick = runs.filter((run) => run.parsed?.tickRef === tick);
    const activeBatches = await tx.courseSupportBatch.findMany({
      where: { status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] } },
      select: { id: true, leaseExpiresAt: true, summary: true, incidents: { select: { courseId: true } } },
    });
    const live = runs.filter((run) => run.status === "RUNNING" &&
      ["RESERVED", "STARTING", "BOUND"].includes(run.parsed?.state ?? ""));
    const occupiedCourses = new Set([
      ...activeBatches.flatMap((batch) => batch.incidents.length > 0
        ? batch.incidents.map((entry) => entry.courseId) : [batch.id]),
      ...live.map((run) => run.parsed!.target.courseId),
    ]);
    const activeCourseCount = new Set(activeBatches.flatMap((batch) =>
      batch.incidents.length > 0 ? batch.incidents.map((entry) => entry.courseId) : [batch.id])).size;
    const availableCapacity = Math.max(0, Math.min(
      MAX_CONCURRENT_COURSE_SUPPORT_BATCHES - occupiedCourses.size,
      MAX_CONCURRENT_COURSE_SUPPORT_BATCHES - activeBatches.length - live.length,
    ));
    const availableStarts = Math.max(0, Math.min(maxStarts - sameTick.length, availableCapacity));
    let eligibleCount = 0;
    // Count admissible active-future work even when this tick has exhausted its
    // launch budget. The legacy background fallback must not interpret a zero
    // launch list as evidence that no active-alert course is waiting.
    if (availableStarts > 0 || live.length === 0) {
      const candidates = await listCourseSupportDispatchCandidates(now, tx);
      const candidateCourses = [...new Set(candidates.map((candidate) => candidate.courseId))];
      const [courses, preferences] = await Promise.all([
        tx.course.findMany({ where: { id: { in: candidateCourses } }, select: { id: true, timeZone: true } }),
        tx.coursePreference.findMany({
          where: {
            courseId: { in: candidateCourses },
            teeSearch: {
              status: "ACTIVE",
              OR: [
                { trafficClass: { notIn: ["TEST", "AUTOMATION"] } },
                { trafficClass: "TEST", syntheticMultiCycle: true },
              ],
            },
          },
          select: {
            courseId: true,
            teeSearch: { select: COURSE_DISPATCH_SOURCE_SELECT },
          },
        }),
      ]);
      const timezoneByCourse = new Map(courses.map((course) => [course.id, course.timeZone]));
      const refsByCourse = new Map<string, typeof preferences>();
      for (const preference of preferences) {
        const timeZone = timezoneByCourse.get(preference.courseId);
        const syntheticExpiry = getSyntheticMultiCycleExpiresAt(preference.teeSearch, now);
        if ((syntheticExpiry && syntheticExpiry <= now) ||
          (preference.teeSearch.trafficClass === "TEST" && !syntheticExpiry) ||
          !timeZone || !isSearchWindowActive({
          date: preference.teeSearch.date,
          endTime: preference.teeSearch.endTime,
          courseTimeZones: [timeZone],
          fallbackTimeZone: preference.teeSearch.userTimeZone,
          now,
        })) continue;
        refsByCourse.set(preference.courseId, [...(refsByCourse.get(preference.courseId) ?? []), preference]);
      }
      const sourceSearchesByCourse = new Map([...refsByCourse].map(([courseId, refs]) =>
        [courseId, refs.map((ref) => ({
          id: ref.teeSearch.id,
          scheduleVersion: ref.teeSearch.scheduleVersion,
          alertGeneration: ref.teeSearch.alertGeneration,
          intentDigest: createCourseDispatchIntentDigest(ref.teeSearch),
          trafficClass: ref.teeSearch.trafficClass,
        }))] as const));
      const selection = selectCourseDispatchTargets({
        candidates,
        sourceSearchesByCourse,
        occupiedCourses,
        priorSearchIds: new Set([
          ...live.flatMap((run) => run.parsed?.target.searchRefs.map((ref) => ref.id) ?? []),
          ...sameTick.flatMap((run) => run.parsed?.target.searchRefs.map((ref) => ref.id) ?? []),
          ...activeBatches.flatMap((batch) => {
            const summary = batch.summary && typeof batch.summary === "object" && !Array.isArray(batch.summary)
              ? batch.summary as Record<string, unknown> : {};
            const refs = Array.isArray(summary.dispatchSourceSearchRefs) ? summary.dispatchSourceSearchRefs : [];
            return refs.flatMap((ref) => ref && typeof ref === "object" && "id" in ref &&
              typeof ref.id === "string" ? [ref.id] : []);
          }),
        ]),
        priorSearchCounts: countSearchIds([
          ...live.map((run) => run.parsed!).flatMap((audit) =>
            audit.target.searchRefs.map((ref) => ref.id)),
          ...activeBatches.flatMap((batch) => {
            const summary = batch.summary && typeof batch.summary === "object" && !Array.isArray(batch.summary)
              ? batch.summary as Record<string, unknown> : {};
            const refs = Array.isArray(summary.dispatchSourceSearchRefs) ? summary.dispatchSourceSearchRefs : [];
            return refs.flatMap((ref) => ref && typeof ref === "object" && "id" in ref &&
              typeof ref.id === "string" ? [ref.id] : []);
          }),
        ]),
        maxStarts: availableStarts,
      });
      eligibleCount = selection.eligibleCount;
      for (const { candidate, source } of selection.selected) {
        const audit: CourseDispatchAudit = {
          schemaVersion: 1,
          tickRef: tick,
          assignmentRef: `course-assignment-${randomUUID()}`,
          state: "RESERVED",
          ownerThreadId: input.ownerThreadId,
          childThreadId: null,
          baseSha: input.baseSha,
          reservedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + RESERVATION_MS).toISOString(),
          target: {
            incidentId: candidate.incidentId,
            courseId: candidate.courseId,
            cycle: candidate.cycle,
            providerFamilyKey: candidate.providerFamilyKey,
            failureFingerprint: candidate.failureFingerprint,
            updatedAt: candidate.updatedAt,
            searchRefs: [{
              id: source.id,
              scheduleVersion: source.scheduleVersion,
              alertGeneration: source.alertGeneration,
              intentDigest: source.intentDigest,
            }],
            trafficClass: ["TEST", "AUTOMATION"].includes(source.trafficClass) ? "SYNTHETIC" : "REAL",
          },
        };
        const run = await tx.automationRun.create({
          data: {
            promptVersion: COURSE_DISPATCH_PROMPT_VERSION,
            kind: "OTHER",
            status: "RUNNING",
            ownerThreadId: input.ownerThreadId,
            runtimeVersion: input.baseSha,
            auditSchemaVersion: 1,
            audit: audit as unknown as Prisma.InputJsonValue,
            startedAt: now,
          },
          select: { id: true },
        });
        runs.unshift({
          id: run.id,
          promptVersion: COURSE_DISPATCH_PROMPT_VERSION,
          audit: audit as unknown as Prisma.JsonValue,
          status: "RUNNING",
          parsed: audit,
        });
        occupiedCourses.add(candidate.courseId);
      }
    }
    return {
      tickRef: tick,
      activeCount: activeBatches.length,
      activeCourseCount,
      occupiedCourseCount: occupiedCourses.size,
      reservedCount: runs.filter((run) => run.status === "RUNNING" &&
        ["RESERVED", "STARTING", "BOUND"].includes(run.parsed?.state ?? "")).length,
      attention: {
        startingCount: runs.filter((run) => run.status === "RUNNING" && run.parsed?.state === "STARTING").length,
        boundCount: runs.filter((run) => run.status === "RUNNING" && run.parsed?.state === "BOUND").length,
        expiredBatchCount: activeBatches.filter((batch) => batch.leaseExpiresAt <= now).length,
      },
      eligibleCount,
      launchItems: runs.filter((run) => run.parsed?.tickRef === tick && run.status === "RUNNING")
        .map((run) => ({ assignmentRef: run.parsed!.assignmentRef, state: run.parsed!.state })),
    };
  }));
}

async function transition(input: { ownerThreadId: string; assignmentRef: string; childThreadId?: string; confirmedNotCreated?: boolean; startupReceipt?: CourseDispatchStartupReceipt; next: DispatchState }) {
  assertIdentity(input.ownerThreadId);
  if (input.startupReceipt !== undefined &&
      (input.next !== "BOUND" || !validStartupReceipt(input.startupReceipt))) {
    throw new Error("Course dispatch startup receipt is invalid.");
  }
  return runWithCourseSupportWriterTransitionLease(async () => transaction(async (tx) => {
    const transitionNow = await getCourseDispatchDatabaseNow(tx);
    const runs = await readRuns(tx);
    const run = runs.find((entry) => entry.parsed?.assignmentRef === input.assignmentRef);
    const audit = run?.parsed;
    if (!run || !audit || audit.ownerThreadId !== input.ownerThreadId || run.status !== "RUNNING") {
      throw new Error("Course dispatch assignment is unavailable.");
    }
    if (input.next === "BOUND" && audit.state === "BOUND" &&
        audit.childThreadId === input.childThreadId) {
      if (input.startupReceipt && (audit.startupReceipt?.receiptPath !== input.startupReceipt.receiptPath ||
          audit.startupReceipt?.preparedReceiptSha256 !== input.startupReceipt.preparedReceiptSha256)) {
        throw new Error("Course dispatch startup receipt changed after binding.");
      }
      return { assignmentRef: audit.assignmentRef, state: audit.state };
    }
    const allowed = input.next === "STARTING" ? audit.state === "RESERVED" &&
      new Date(audit.expiresAt).getTime() > transitionNow.getTime() :
      input.next === "BOUND" ? audit.state === "STARTING" && Boolean(input.childThreadId) :
      input.next === "CANCELLED" ? audit.state === "RESERVED" ||
        (audit.state === "STARTING" && input.confirmedNotCreated === true) : false;
    if (!allowed) throw new Error("Course dispatch assignment transition is invalid.");
    if (input.next === "BOUND") {
      const previousChildAssignment = await tx.automationRun.findFirst({
        where: {
          promptVersion: COURSE_DISPATCH_PROMPT_VERSION,
          audit: { path: ["childThreadId"], equals: input.childThreadId },
        },
        select: { id: true, audit: true },
      });
      if (previousChildAssignment && previousChildAssignment.id !== run.id) {
        throw new Error("Course dispatch child task already owns another assignment.");
      }
    }
    const transitionAt = transitionNow.toISOString();
    const updated: CourseDispatchAudit = {
      ...audit, state: input.next,
      childThreadId: input.childThreadId ?? audit.childThreadId,
      ...(input.next === "STARTING" ? { launchStartedAt: transitionAt } : {}),
      ...(input.next === "BOUND" ? { boundAt: transitionAt } : {}),
      ...(input.startupReceipt ? { startupReceipt: input.startupReceipt } : {}),
    };
    await tx.automationRun.update({
      where: { id: run.id },
      data: {
        audit: updated as unknown as Prisma.InputJsonValue,
        ...(input.next === "CANCELLED" ? { status: "COMPLETED", completedAt: transitionNow, outcome: "cancelled_before_start" } : {}),
      },
    });
    return { assignmentRef: updated.assignmentRef, state: updated.state };
  }));
}

export function beginCourseSupportCourseDispatch(input: { ownerThreadId: string; assignmentRef: string }) {
  return transition({ ...input, next: "STARTING" });
}

export function bindCourseSupportCourseDispatch(input: { ownerThreadId: string; assignmentRef: string; childThreadId: string; startupReceipt?: CourseDispatchStartupReceipt }) {
  if (!input.childThreadId.trim()) throw new Error("Course dispatch requires the native child task id.");
  if (input.childThreadId === input.ownerThreadId) throw new Error("Course dispatch child must be a distinct native task.");
  return transition({ ...input, next: "BOUND" });
}

export function cancelCourseSupportCourseDispatch(input: { ownerThreadId: string; assignmentRef: string; confirmedNotCreated?: boolean }) {
  return transition({ ...input, next: "CANCELLED" });
}

export async function loadBoundCourseSupportDispatchAssignment(input: { assignmentRef: string; childThreadId: string }) {
  if (!input.childThreadId.trim()) throw new Error("Course dispatch requires the native child task id.");
  const runs = await readRuns(prisma);
  const audit = runs.find((run) => run.parsed?.assignmentRef === input.assignmentRef)?.parsed;
  if (!audit || audit.state !== "BOUND" || audit.childThreadId !== input.childThreadId) {
    throw new Error("Course dispatch assignment is not bound to this task.");
  }
  return audit;
}

export async function getCourseSupportCourseDispatchAssignment(input: { assignmentRef: string; childThreadId: string }) {
  if (!input.childThreadId.trim()) throw new Error("Course dispatch requires the native child task id.");
  const runs = await readRuns(prisma);
  const audit = runs.find((run) => run.parsed?.assignmentRef === input.assignmentRef)?.parsed;
  if (audit?.state === "STARTING" && audit.childThreadId === null) {
    return { outcome: "awaiting_binding" as const, assignmentRef: audit.assignmentRef, state: audit.state };
  }
  if (!audit || audit.state !== "BOUND" || audit.childThreadId !== input.childThreadId) {
    throw new Error("Course dispatch assignment is not bound to this task.");
  }
  return { outcome: "bound" as const, assignmentRef: audit.assignmentRef, baseSha: audit.baseSha, state: audit.state, tickRef: audit.tickRef };
}

export async function listLiveCourseSupportDispatchReservations(tx: Prisma.TransactionClient) {
  const runs = await readRuns(tx);
  return runs.filter((run) => run.status === "RUNNING" &&
    ["RESERVED", "STARTING", "BOUND"].includes(run.parsed?.state ?? ""))
    .map((run) => ({ runId: run.id, audit: run.parsed! }));
}

/** Private local receipt references, never part of the aggregate dispatch plan. */
export async function listCourseSupportStartupReceiptBindings() {
  const runs = await readRuns(prisma);
  const bound = runs.filter((run) => run.status === "RUNNING" && run.parsed?.state === "BOUND");
  if (bound.length > MAX_CONCURRENT_COURSE_SUPPORT_BATCHES) {
    throw new Error("Course dispatch startup receipt bound exceeded.");
  }
  const bindings = bound.filter((run) => run.parsed!.startupReceipt).map((run) => ({
    assignmentRef: run.parsed!.assignmentRef,
    childThreadId: run.parsed!.childThreadId!,
    ...run.parsed!.startupReceipt!,
  }));
  return { bindings, legacyBoundCount: bound.length - bindings.length };
}

function assertStartupTerminalProof(proof: CourseDispatchStartupTerminalProof, now: Date) {
  const timestamps = [proof.firstTurnStartedAt, proof.terminalAt, proof.appServerShutdownAt];
  if (proof.outcome !== "READY" || proof.terminationKind !== "MATCHED_TURN_COMPLETED" ||
      !/^course-assignment-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(proof.assignmentRef) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(proof.childThreadId) ||
      typeof proof.turnId !== "string" || !proof.turnId.trim() || proof.turnId.length > 256 ||
      !["completed", "failed", "interrupted"].includes(proof.turnStatus) ||
      typeof proof.nativeIdentityVerified !== "boolean" || !Number.isSafeInteger(proof.approvalRequests) ||
      proof.approvalRequests < 0 ||
      [proof.preparedReceiptSha256, proof.receiptSha256, proof.promptSha256, proof.firstTurnMarkerSha256]
        .some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) ||
      timestamps.some((value) => typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value || Date.parse(value) > now.getTime()) ||
      Date.parse(proof.firstTurnStartedAt) > Date.parse(proof.terminalAt) ||
      Date.parse(proof.terminalAt) > Date.parse(proof.appServerShutdownAt)) {
    throw new Error("Course dispatch requires a positively completed native first-turn proof.");
  }
}

export async function reconcileCourseSupportStartupTerminal(input: {
  requestingThreadId: string;
  receiptPath: string;
  proof: CourseDispatchStartupTerminalProof;
}) {
  assertIdentity(input.requestingThreadId);
  if (input.requestingThreadId === input.proof.childThreadId) {
    throw new Error("Course dispatch startup reconciliation requires a distinct current parent.");
  }
  return runWithCourseSupportWriterTransitionLease(async () => transaction(async (tx) => {
    const now = await getCourseDispatchDatabaseNow(tx);
    assertStartupTerminalProof(input.proof, now);
    const run = await tx.automationRun.findFirst({
      where: { promptVersion: COURSE_DISPATCH_PROMPT_VERSION,
        audit: { path: ["assignmentRef"], equals: input.proof.assignmentRef } },
      select: { id: true, status: true, audit: true },
    });
    const audit = parseAudit(run?.audit);
    if (!run || !audit || audit.childThreadId !== input.proof.childThreadId ||
        !audit.startupReceipt || audit.startupReceipt.receiptPath !== input.receiptPath ||
        audit.startupReceipt.preparedReceiptSha256 !== input.proof.preparedReceiptSha256) {
      throw new Error("Course dispatch terminal proof does not match its original binding.");
    }
    if (audit.state === "CANCELLED" && audit.startupRetirement?.turnId === input.proof.turnId &&
        audit.startupRetirement.firstTurnMarkerSha256 === input.proof.firstTurnMarkerSha256) {
      return { outcome: "already_retired" as const, retiredCount: 0 };
    }
    if (run.status !== "RUNNING" || audit.state !== "BOUND" || !audit.boundAt ||
        !Number.isFinite(Date.parse(audit.boundAt)) || new Date(audit.boundAt).toISOString() !== audit.boundAt ||
        Date.parse(input.proof.firstTurnStartedAt) < Date.parse(audit.boundAt)) {
      throw new Error("Course dispatch startup is no longer an unclaimed bound first turn.");
    }
    const [incident, ownedOrActiveBatch, course, searches] = await Promise.all([
      tx.courseSupportIncident.findUnique({
        where: { id: audit.target.incidentId },
        select: { courseId: true, cycle: true, providerFamilyKey: true, failureFingerprint: true,
          updatedAt: true, activeBatchId: true },
      }),
      tx.courseSupportBatch.findFirst({
        where: { OR: [
          { ownerThreadId: input.proof.childThreadId },
          { status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
            incidents: { some: { courseId: audit.target.courseId } } },
        ] },
        select: { id: true },
      }),
      tx.course.findUnique({ where: { id: audit.target.courseId }, select: { timeZone: true } }),
      tx.coursePreference.findMany({
        where: { courseId: audit.target.courseId, teeSearchId: { in: audit.target.searchRefs.map((ref) => ref.id) } },
        select: { teeSearch: { select: COURSE_DISPATCH_SOURCE_SELECT } },
      }),
    ]);
    if (!incident || incident.courseId !== audit.target.courseId || incident.cycle !== audit.target.cycle ||
        incident.providerFamilyKey !== audit.target.providerFamilyKey ||
        incident.failureFingerprint !== audit.target.failureFingerprint ||
        incident.updatedAt.toISOString() !== audit.target.updatedAt || incident.activeBatchId ||
        ownedOrActiveBatch || !course || searches.length !== audit.target.searchRefs.length ||
        searches.some(({ teeSearch }) => {
          const ref = audit.target.searchRefs.find((entry) => entry.id === teeSearch.id);
          return !ref || !isCurrentCourseDispatchSource({ ref, search: teeSearch,
            trafficClass: audit.target.trafficClass, courseTimeZone: course!.timeZone, now });
        })) {
      throw new Error("Course dispatch source or claim authority changed before startup retirement.");
    }
    const retired: CourseDispatchAudit = { ...audit, state: "CANCELLED", startupRetirement: {
      schemaVersion: 1, reconcilerThreadId: input.requestingThreadId, reconciledAt: now.toISOString(),
      turnId: input.proof.turnId, turnStatus: input.proof.turnStatus, terminalAt: input.proof.terminalAt,
      firstTurnMarkerSha256: input.proof.firstTurnMarkerSha256, terminalReceiptSha256: input.proof.receiptSha256,
    } };
    const changed = await tx.automationRun.updateMany({
      where: { id: run.id, status: "RUNNING", audit: { equals: run.audit as Prisma.InputJsonValue } },
      data: { audit: retired as unknown as Prisma.InputJsonValue, status: "COMPLETED", completedAt: now,
        outcome: "native_first_turn_ended_before_claim" },
    });
    if (changed.count !== 1) throw new Error("Course dispatch claim raced startup retirement.");
    return { outcome: "startup_retired" as const, retiredCount: 1 };
  }));
}

export async function consumeBoundCourseSupportDispatchAssignment(
  tx: Prisma.TransactionClient,
  input: { assignmentRef: string; childThreadId: string; baseSha: string; now: Date },
) {
  const live = await listLiveCourseSupportDispatchReservations(tx);
  const assignment = live.find((entry) => entry.audit.assignmentRef === input.assignmentRef);
  if (!assignment || assignment.audit.state !== "BOUND" ||
      assignment.audit.childThreadId !== input.childThreadId ||
      assignment.audit.baseSha !== input.baseSha) {
    throw new Error("Course dispatch assignment changed before atomic claim.");
  }
  const next: CourseDispatchAudit = { ...assignment.audit, state: "CONSUMED", consumedAt: input.now.toISOString() };
  await tx.automationRun.update({
    where: { id: assignment.runId },
    data: {
      audit: next as unknown as Prisma.InputJsonValue,
      status: "COMPLETED",
      completedAt: input.now,
      outcome: "claimed",
    },
  });
  return next;
}
