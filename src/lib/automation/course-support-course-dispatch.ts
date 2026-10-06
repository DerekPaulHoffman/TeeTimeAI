import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isSearchWindowActive } from "./date-boundary";
import { getSyntheticMultiCycleExpiresAt } from "./synthetic-test-window";
import { listSimulatorSupportDispatchCandidates } from "./simulator-support-incidents";
import { isCurrentSimulatorSupportSource, isValidSimulatorSupportClaim, SIMULATOR_SUPPORT_SOURCE_SELECT, type SimulatorSupportClaim } from "./simulator-support-policy";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import type { SimulatorResearchState } from "./simulator-support-research-policy";
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
  simulatorClaim?: SimulatorSupportClaim;
  simulatorResearch?: SimulatorResearchState;
  target: {
    mode?: "SIMULATOR";
    offeringId?: string;
    offeringSourceFingerprint?: string;
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

export function parseCourseDispatchAudit(value: unknown): CourseDispatchAudit | null {
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
      (["RESERVED", "STARTING"].includes(audit.state ?? "") && audit.childThreadId !== null)) return null;
  if (audit.target.mode !== undefined && audit.target.mode !== "SIMULATOR") return null;
  if (audit.target.mode === "SIMULATOR" &&
      (typeof audit.target.offeringId !== "string" || !audit.target.offeringId || !/^[a-f0-9]{64}$/i.test(audit.target.offeringSourceFingerprint ?? "") ||
       (audit.state === "CONSUMED" && !isValidSimulatorSupportClaim(audit.simulatorClaim)))) return null;
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
  selectionKey?: string;
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
    const sources = input.sourceSearchesByCourse.get(candidate.selectionKey ?? candidate.courseId) ?? [];
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
  if (runs.length === 64 || dispatchRuns.some((run) => !parseCourseDispatchAudit(run.audit))) {
    throw new Error("Course dispatch history reached the bounded read limit.");
  }
  return dispatchRuns.map((run) => ({ ...run, parsed: parseCourseDispatchAudit(run.audit) }));
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
    if (audit.target.mode === "SIMULATOR") {
      const incident = baseChanged ? null : await tx.simulatorSupportIncident.findUnique({ where: { id: audit.target.incidentId }, include: { offering: { include: { course: { select: { timeZone: true } } } } } });
      const searches = incident ? await tx.teeSearch.findMany({ where: { id: { in: audit.target.searchRefs.map(ref => ref.id) } }, select: SIMULATOR_SUPPORT_SOURCE_SELECT }) : [];
      const stale = !incident || incident.status !== "AUTO_INVESTIGATING" || incident.offeringId !== audit.target.offeringId ||
        incident.updatedAt.toISOString() !== audit.target.updatedAt ||
        getSimulatorOfferingSourceFingerprint(incident.offering) !== audit.target.offeringSourceFingerprint ||
        searches.length !== audit.target.searchRefs.length || searches.some(search => {
          const ref = audit.target.searchRefs.find(candidate => candidate.id === search.id);
          return !ref || !isCurrentSimulatorSupportSource({ search, ref, offeringId: incident.offeringId, trafficClass: audit.target.trafficClass, timeZone: incident.offering.course.timeZone, now });
        });
      if (stale) {
        const updated: CourseDispatchAudit = { ...audit, state: "CANCELLED" };
        await tx.automationRun.update({ where: { id: run.id }, data: { audit: updated as unknown as Prisma.InputJsonValue, status: "COMPLETED", completedAt: now, outcome: "stale_simulator_assignment" } });
        run.status = "COMPLETED"; run.parsed = updated;
      }
      continue;
    }
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
        where: { courseId: audit.target.courseId, teeSearchId: { in: audit.target.searchRefs.map((ref) => ref.id) }, teeSearch: { mode: "OUTDOOR" } },
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
  const maxStarts = input.maxStarts ?? 5;
  if (!Number.isInteger(maxStarts) || maxStarts < 1 || maxStarts > 15) {
    throw new Error("Course dispatch maxStarts must be from 1 through 15.");
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
      (["RESERVED", "STARTING", "BOUND"].includes(run.parsed?.state ?? "") ||
       (run.parsed?.target.mode === "SIMULATOR" && run.parsed.state === "CONSUMED")));
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
      const outdoorCandidates = await listCourseSupportDispatchCandidates(now, tx);
      const simulatorCandidates = (await listSimulatorSupportDispatchCandidates(now, tx)).map(candidate => ({ ...candidate, selectionKey: `simulator:${candidate.offeringId}` }));
      const candidates = [...outdoorCandidates, ...simulatorCandidates];
      const candidateCourses = [...new Set(candidates.map((candidate) => candidate.courseId))];
      const [courses, preferences] = await Promise.all([
        tx.course.findMany({ where: { id: { in: candidateCourses } }, select: { id: true, timeZone: true } }),
        tx.coursePreference.findMany({
          where: {
            courseId: { in: candidateCourses },
            teeSearch: {
              status: "ACTIVE",
              mode: "OUTDOOR",
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
      for (const candidate of simulatorCandidates) sourceSearchesByCourse.set(candidate.selectionKey, candidate.sources);
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
            ...("mode" in candidate && candidate.mode === "SIMULATOR" ? {
              mode: "SIMULATOR" as const, offeringId: candidate.offeringId,
              offeringSourceFingerprint: candidate.offeringSourceFingerprint,
            } : {}),
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
      reservedCount: runs.filter(run => run.status === "RUNNING" &&
        (["RESERVED", "STARTING", "BOUND"].includes(run.parsed?.state ?? "") ||
         (run.parsed?.target.mode === "SIMULATOR" && run.parsed.state === "CONSUMED"))).length,
      attention: {
        startingCount: runs.filter((run) => run.status === "RUNNING" && run.parsed?.state === "STARTING").length,
        boundCount: runs.filter((run) => run.status === "RUNNING" && run.parsed?.state === "BOUND").length,
        expiredBatchCount: activeBatches.filter((batch) => batch.leaseExpiresAt <= now).length +
          live.filter(run => run.parsed?.simulatorClaim && new Date(run.parsed.simulatorClaim.leaseExpiresAt) <= now).length,
      },
      eligibleCount,
      launchItems: runs.filter((run) => run.parsed?.tickRef === tick && run.status === "RUNNING" && ["RESERVED", "STARTING", "BOUND"].includes(run.parsed?.state ?? ""))
        .map((run) => ({ assignmentRef: run.parsed!.assignmentRef, state: run.parsed!.state,
          ...(run.parsed!.target.mode === "SIMULATOR" ? { mode: "SIMULATOR" as const } : {}) })),
    };
  }));
}

async function transition(input: { ownerThreadId: string; assignmentRef: string; childThreadId?: string; confirmedNotCreated?: boolean; next: DispatchState }) {
  assertIdentity(input.ownerThreadId);
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

export function bindCourseSupportCourseDispatch(input: { ownerThreadId: string; assignmentRef: string; childThreadId: string }) {
  if (!input.childThreadId.trim()) throw new Error("Course dispatch requires the native child task id.");
  if (input.childThreadId === input.ownerThreadId) throw new Error("Course dispatch child must be a distinct native task.");
  return transition({ ...input, next: "BOUND" });
}

export function cancelCourseSupportCourseDispatch(input: { ownerThreadId: string; assignmentRef: string; confirmedNotCreated?: boolean }) {
  return transition({ ...input, next: "CANCELLED" });
}

export async function loadBoundCourseSupportDispatchAssignment(input: { assignmentRef: string; childThreadId: string; mode?: "SIMULATOR" }) {
  if (!input.childThreadId.trim()) throw new Error("Course dispatch requires the native child task id.");
  const runs = await readRuns(prisma);
  const audit = runs.find((run) => run.parsed?.assignmentRef === input.assignmentRef)?.parsed;
  if (!audit || audit.state !== "BOUND" || audit.childThreadId !== input.childThreadId || audit.target.mode !== input.mode) {
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
  return { outcome: "bound" as const, assignmentRef: audit.assignmentRef, baseSha: audit.baseSha, state: audit.state, tickRef: audit.tickRef,
    ...(audit.target.mode === "SIMULATOR" ? { mode: "SIMULATOR" as const } : {}) };
}

export async function listLiveCourseSupportDispatchReservations(tx: Prisma.TransactionClient) {
  const runs = await readRuns(tx);
  return runs.filter((run) => run.status === "RUNNING" &&
    (["RESERVED", "STARTING", "BOUND"].includes(run.parsed?.state ?? "") ||
     (run.parsed?.target.mode === "SIMULATOR" && run.parsed.state === "CONSUMED")))
    .map((run) => ({ runId: run.id, audit: run.parsed! }));
}

export async function consumeBoundCourseSupportDispatchAssignment(
  tx: Prisma.TransactionClient,
  input: { assignmentRef: string; childThreadId: string; baseSha: string; now: Date },
) {
  const live = await listLiveCourseSupportDispatchReservations(tx);
  const assignment = live.find((entry) => entry.audit.assignmentRef === input.assignmentRef);
  if (!assignment || assignment.audit.target.mode === "SIMULATOR" || assignment.audit.state !== "BOUND" ||
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

export async function hasSimulatorSupportImplementationOwnership(tx: Prisma.TransactionClient, exceptAssignmentRef?: string) {
  const live = await listLiveCourseSupportDispatchReservations(tx);
  return live.some(({ audit }) => audit.assignmentRef !== exceptAssignmentRef && audit.target.mode === "SIMULATOR" &&
    audit.state === "CONSUMED" && (audit.simulatorClaim?.plannedPaths.length ?? 0) > 0);
}
