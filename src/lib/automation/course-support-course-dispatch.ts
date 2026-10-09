import { randomUUID } from "node:crypto";
import { isAbsolute, posix, win32 } from "node:path";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isSearchWindowActive } from "./date-boundary";
import { getSyntheticMultiCycleExpiresAt } from "./synthetic-test-window";
import { listSimulatorSupportDispatchCandidates, validateSimulatorEngineeringAuthority } from "./simulator-support-incidents";
import { createSimulatorSupportIntentDigest, isCurrentSimulatorSupportSource, isValidSimulatorEngineeringAuthority, isValidSimulatorSupportClaim, SIMULATOR_SUPPORT_SOURCE_SELECT, type SimulatorEngineeringAuthority, type SimulatorSupportClaim, type SimulatorSupportSource } from "./simulator-support-policy";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { readSimulatorResearchFailureMemory, type SimulatorResearchFailureMemory, type SimulatorResearchState } from "./simulator-support-research-policy";
import {
  confirmCourseSupportContinuationSent,
  COURSE_SUPPORT_CONTINUATION_POLICY_VERSION,
  COURSE_SUPPORT_CONTINUATION_TICK_MS,
  assessCourseSupportContinuationCandidate,
  readCourseSupportContinuationLedger,
  latestConfirmedNativeContinuation,
  reserveCourseSupportContinuationReceipt,
  type CourseSupportContinuationCheckpoint,
  type CourseSupportContinuationLedger,
  type CourseSupportReviewedToolingRepair,
} from "./course-support-continuation";
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
import { retryCourseSupportWriterAdmission } from "./course-support-writer-admission";
import { assertCourseSupportWriterCommitHeadroom, assertCourseSupportWriterTransactionStart, courseSupportWriterTransactionOptions } from "./course-support-writer-budget";
import type { PostgresAdvisoryLeaseContext } from "./lease";

export const COURSE_DISPATCH_PROMPT_VERSION = "course-support-course-dispatch-v1";
const RESERVATION_MS = 10 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
export const COURSE_SUPPORT_STARTUP_TIMEOUT_MS = 15 * 60 * 1000;

/** Unclaimed launch authority is finite even if the native process disappears. */
export function isCourseSupportLaunchAuthorityCurrent(audit: CourseDispatchAudit, now: Date) {
  const deadline = audit.state === "RESERVED" ? Date.parse(audit.expiresAt) :
    audit.state === "STARTING" ? Date.parse(audit.launchStartedAt ?? audit.reservedAt) + COURSE_SUPPORT_STARTUP_TIMEOUT_MS :
    audit.state === "BOUND" ? Date.parse(audit.boundAt ?? audit.launchStartedAt ?? audit.reservedAt) + COURSE_SUPPORT_STARTUP_TIMEOUT_MS : NaN;
  return Number.isFinite(deadline) && deadline > now.getTime();
}

type DispatchState = "RESERVED" | "STARTING" | "BOUND" | "CONSUMED" | "CANCELLED" | "EXPIRED";
export type CourseDispatchAudit = {
  schemaVersion: 1;
  tickRef: string;
  assignmentRef: string;
  state: DispatchState;
  ownerThreadId: string;
  childThreadId: string | null;
  launcherReceiptPath?: string;
  baseSha: string;
  reservedAt: string;
  expiresAt: string;
  launchStartedAt?: string;
  boundAt?: string;
  consumedAt?: string;
  simulatorClaim?: SimulatorSupportClaim;
  simulatorResearch?: SimulatorResearchState;
  simulatorResearchPriorFailures?: SimulatorResearchFailureMemory;
  simulatorContinuation?: CourseSupportContinuationLedger;
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
    engineeringAuthority?: SimulatorEngineeringAuthority;
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
      (audit.launchStartedAt !== undefined && !Number.isFinite(Date.parse(audit.launchStartedAt))) ||
      (audit.boundAt !== undefined && !Number.isFinite(Date.parse(audit.boundAt))) ||
      !Number.isFinite(Date.parse(audit.target.updatedAt)) ||
      audit.target.searchRefs.length < 1 || audit.target.searchRefs.length > 3 ||
      audit.target.searchRefs.some((ref) => !ref || typeof ref.id !== "string" || !ref.id ||
        !Number.isInteger(ref.scheduleVersion) || ref.scheduleVersion < 0 ||
        !Number.isInteger(ref.alertGeneration) || ref.alertGeneration < 0 ||
        (ref.intentDigest !== undefined &&
          (typeof ref.intentDigest !== "string" || !/^[a-f0-9]{64}$/i.test(ref.intentDigest)))) ||
      new Set(audit.target.searchRefs.map((ref) => ref.id)).size !== audit.target.searchRefs.length ||
      (["BOUND", "CONSUMED"].includes(audit.state ?? "") && (typeof audit.childThreadId !== "string" || !audit.childThreadId)) ||
      (["RESERVED", "STARTING"].includes(audit.state ?? "") && audit.childThreadId !== null)) return null;
  if (audit.target.mode !== undefined && audit.target.mode !== "SIMULATOR") return null;
  // Neon retains the original native host's path; a deployed reader may use another OS.
  // This parses provenance only. Local binding and artifact access retain their own guards.
  if (audit.launcherReceiptPath !== undefined && (typeof audit.launcherReceiptPath !== "string" ||
      !(posix.isAbsolute(audit.launcherReceiptPath) || win32.isAbsolute(audit.launcherReceiptPath)) ||
      !audit.launcherReceiptPath.endsWith("launcher.receipt.private.json"))) return null;
  if (audit.target.mode === "SIMULATOR" &&
      (typeof audit.target.offeringId !== "string" || !audit.target.offeringId || !/^[a-f0-9]{64}$/i.test(audit.target.offeringSourceFingerprint ?? "") ||
       (audit.state === "CONSUMED" && !isValidSimulatorSupportClaim(audit.simulatorClaim)))) return null;
  if (audit.target.engineeringAuthority !== undefined &&
      (audit.target.mode !== "SIMULATOR" || audit.target.trafficClass !== "SYNTHETIC" ||
       !isValidSimulatorEngineeringAuthority(audit.target.engineeringAuthority) ||
       audit.target.engineeringAuthority.sourceFingerprint !== audit.target.offeringSourceFingerprint)) return null;
  if (audit.simulatorContinuation !== undefined) {
    try { readCourseSupportContinuationLedger(audit.simulatorContinuation); } catch { return null; }
    if (audit.target.mode !== "SIMULATOR" || audit.state !== "CONSUMED") return null;
  }
  if (audit.simulatorResearchPriorFailures !== undefined) {
    try { readSimulatorResearchFailureMemory(audit.simulatorResearchPriorFailures); } catch { return null; }
    if (audit.target.mode !== "SIMULATOR" || audit.state !== "CONSUMED") return null;
  }
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

type PriorDispatchSource = {
  courseId: string;
  mode?: "SIMULATOR";
  offeringId?: string;
  trafficClass?: "REAL" | "SYNTHETIC";
  ref: CourseDispatchSourceRef;
};

export function collectCurrentCourseDispatchSourceUsage(input: {
  priorSources: readonly PriorDispatchSource[];
  searches: ReadonlyMap<string, SimulatorSupportSource>;
  courseTimeZones: ReadonlyMap<string, string>;
  now: Date;
}) {
  const coursesBySearch = new Map<string, Set<string>>();
  for (const prior of input.priorSources) {
    const search = input.searches.get(prior.ref.id);
    const timeZone = input.courseTimeZones.get(prior.courseId);
    if (!search || !timeZone) continue;
    const trafficClass = prior.trafficClass ??
      (["TEST", "AUTOMATION"].includes(search.trafficClass) ? "SYNTHETIC" : "REAL");
    const current = prior.mode === "SIMULATOR"
      ? Boolean(prior.offeringId && search.preferences.some(preference =>
        preference.courseId === prior.courseId && preference.offeringId === prior.offeringId) && isCurrentSimulatorSupportSource({
        search, ref: prior.ref, offeringId: prior.offeringId, trafficClass, timeZone, now: input.now,
      }))
      : search.preferences.some(preference => preference.courseId === prior.courseId) &&
        isCurrentCourseDispatchSource({
          search, ref: prior.ref, trafficClass, courseTimeZone: timeZone, now: input.now,
        });
    if (!current) continue;
    const courses = coursesBySearch.get(search.id) ?? new Set<string>();
    courses.add(prior.courseId);
    coursesBySearch.set(search.id, courses);
  }
  return {
    priorSearchIds: new Set(coursesBySearch.keys()),
    priorSearchCounts: new Map([...coursesBySearch].map(([id, courses]) => [id, courses.size])),
  };
}

function readBatchDispatchSourceRefs(summary: unknown): CourseDispatchSourceRef[] {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return [];
  const refs = (summary as Record<string, unknown>).dispatchSourceSearchRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((ref): ref is CourseDispatchSourceRef => Boolean(
    ref && typeof ref === "object" && typeof ref.id === "string" && ref.id &&
    Number.isInteger(ref.scheduleVersion) && ref.scheduleVersion >= 0 &&
    Number.isInteger(ref.alertGeneration) && ref.alertGeneration >= 0 &&
    (ref.intentDigest === undefined || (typeof ref.intentDigest === "string" && /^[a-f0-9]{64}$/i.test(ref.intentDigest))),
  ));
}

export function selectCourseDispatchTargets<T extends {
  courseId: string;
  activeRealSearchCount: number;
  selectionKey?: string;
  engineeringAuthority?: SimulatorEngineeringAuthority;
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
  const selected: { candidate: T; source?: CourseDispatchSourceRef & { trafficClass: string } }[] = [];
  let eligibleCount = 0;
  const ordered = [...input.candidates].sort((a, b) =>
    Number(b.activeRealSearchCount > 0) - Number(a.activeRealSearchCount > 0) ||
    Number(Boolean(a.engineeringAuthority)) - Number(Boolean(b.engineeringAuthority)) ||
    a.courseId.localeCompare(b.courseId));
  for (const candidate of ordered) {
    if (seen.has(candidate.courseId)) continue;
    if (candidate.engineeringAuthority) {
      seen.add(candidate.courseId);
      eligibleCount += 1;
      if (selected.length < input.maxStarts) selected.push({ candidate });
      continue;
    }
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

async function transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, writerLease?: PostgresAdvisoryLeaseContext) {
  return withCourseSupportWriteConflictRetry(() =>
    prisma.$transaction(async tx => {
      if (writerLease) assertCourseSupportWriterTransactionStart(writerLease);
      const result = await operation(tx);
      if (writerLease) assertCourseSupportWriterCommitHeadroom(writerLease);
      return result;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      ...(writerLease ? courseSupportWriterTransactionOptions(writerLease) : { timeout: 15_000 }),
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
    if (run.status !== "RUNNING" || !run.parsed || !["RESERVED", "STARTING", "BOUND"].includes(run.parsed.state)) continue;
    const baseChanged = run.parsed.baseSha !== currentBaseSha;
    if (!baseChanged && isCourseSupportLaunchAuthorityCurrent(run.parsed, now)) continue;
    const previousState = run.parsed.state;
    const audit: CourseDispatchAudit = { ...run.parsed, state: "EXPIRED" };
    await tx.automationRun.update({
      where: { id: run.id },
      data: { audit: audit as unknown as Prisma.InputJsonValue, status: "COMPLETED", completedAt: now,
        outcome: baseChanged ? "base_changed_before_claim" : previousState === "RESERVED" ? "reservation_expired" :
          previousState === "STARTING" ? "worker_startup_expired" : "worker_claim_expired" },
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
      const searches = incident && !audit.target.engineeringAuthority ? await tx.teeSearch.findMany({ where: { id: { in: audit.target.searchRefs.map(ref => ref.id) } }, select: SIMULATOR_SUPPORT_SOURCE_SELECT }) : [];
      let stale = !incident || incident.status !== "AUTO_INVESTIGATING" || incident.offeringId !== audit.target.offeringId ||
        incident.updatedAt.toISOString() !== audit.target.updatedAt ||
        getSimulatorOfferingSourceFingerprint(incident.offering) !== audit.target.offeringSourceFingerprint ||
        (!audit.target.engineeringAuthority && searches.length !== audit.target.searchRefs.length) || searches.some(search => {
          const ref = audit.target.searchRefs.find(candidate => candidate.id === search.id);
          return !ref || !isCurrentSimulatorSupportSource({ search, ref, offeringId: incident.offeringId, trafficClass: audit.target.trafficClass, timeZone: incident.offering.course.timeZone, now });
        });
      if (!stale && incident && audit.target.engineeringAuthority) {
        try { await validateSimulatorEngineeringAuthority(tx, audit.target.engineeringAuthority, audit.target, now); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("Simulator engineering authority")) throw error;
          stale = true;
        }
        const real = await tx.teeSearch.findMany({ where: { mode: "SIMULATOR", status: "ACTIVE", trafficClass: { notIn: ["TEST", "AUTOMATION"] },
          preferences: { some: { offeringId: incident.offeringId } } }, select: SIMULATOR_SUPPORT_SOURCE_SELECT, take: 1024 });
        if (real.length === 1024) throw new Error("Simulator engineering priority read reached its bounded limit.");
        stale ||= real.some(search => isCurrentSimulatorSupportSource({ search, ref: { id: search.id, scheduleVersion: search.scheduleVersion,
          alertGeneration: search.alertGeneration, intentDigest: createSimulatorSupportIntentDigest(search) }, offeringId: incident.offeringId,
          trafficClass: "REAL", timeZone: incident.offering.course.timeZone, now }));
      }
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
    const { reconcileExpiredSimulatorResearchExecutions } = await import("./simulator-support-ownership");
    await reconcileExpiredSimulatorResearchExecutions(tx, now, runs);
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
      const priorSources: PriorDispatchSource[] = [
        ...[...live, ...sameTick].filter(run => !run.parsed!.target.engineeringAuthority).flatMap(run => run.parsed!.target.searchRefs.map(ref => ({
          courseId: run.parsed!.target.courseId,
          mode: run.parsed!.target.mode,
          offeringId: run.parsed!.target.offeringId,
          trafficClass: run.parsed!.target.trafficClass,
          ref,
        }))),
        ...activeBatches.flatMap(batch => batch.incidents.flatMap(incident =>
          readBatchDispatchSourceRefs(batch.summary).map(ref => ({ courseId: incident.courseId, ref })))),
      ];
      const [priorSearches, priorCourses] = await Promise.all([
        tx.teeSearch.findMany({
          where: { id: { in: [...new Set(priorSources.map(source => source.ref.id))] } },
          select: SIMULATOR_SUPPORT_SOURCE_SELECT,
        }),
        tx.course.findMany({
          where: { id: { in: [...new Set(priorSources.map(source => source.courseId))] } },
          select: { id: true, timeZone: true },
        }),
      ]);
      // An uncertain native launch still owns its physical slot. Only current,
      // active-future demand consumes the separate three-alert cohort budget.
      const priorUsage = collectCurrentCourseDispatchSourceUsage({
        priorSources,
        searches: new Map(priorSearches.map(search => [search.id, search])),
        courseTimeZones: new Map(priorCourses.map(course => [course.id, course.timeZone])),
        now,
      });
      const selection = selectCourseDispatchTargets({
        candidates,
        sourceSearchesByCourse,
        occupiedCourses,
        ...priorUsage,
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
              ...(candidate.engineeringAuthority ? { engineeringAuthority: candidate.engineeringAuthority } : {}),
            } : {}),
            incidentId: candidate.incidentId,
            courseId: candidate.courseId,
            cycle: candidate.cycle,
            providerFamilyKey: candidate.providerFamilyKey,
            failureFingerprint: candidate.failureFingerprint,
            updatedAt: candidate.updatedAt,
            searchRefs: "engineeringSearchRefs" in candidate && candidate.engineeringAuthority ? candidate.engineeringSearchRefs! : [{
              id: source!.id,
              scheduleVersion: source!.scheduleVersion,
              alertGeneration: source!.alertGeneration,
              intentDigest: source!.intentDigest,
            }],
            trafficClass: !source || ["TEST", "AUTOMATION"].includes(source.trafficClass) ? "SYNTHETIC" : "REAL",
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
    const continuation = await collectCourseSupportContinuationCandidates({ ownerThreadId: input.ownerThreadId, now, runs, tx });
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
      continuationItems: continuation.continuationItems,
      continuationAttentionCount: continuation.attentionCount,
      continuationEligibleCount: continuation.continuationItems.length,
      launchItems: runs.filter((run) => run.parsed?.tickRef === tick && run.status === "RUNNING" && ["RESERVED", "STARTING", "BOUND"].includes(run.parsed?.state ?? ""))
        .map((run) => ({ assignmentRef: run.parsed!.assignmentRef, state: run.parsed!.state,
          ...(run.parsed!.target.mode === "SIMULATOR" ? { mode: "SIMULATOR" as const } : {}) })),
    };
  }));
}

async function transition(input: { ownerThreadId: string; assignmentRef: string; childThreadId?: string; launcherReceiptPath?: string; confirmedNotCreated?: boolean; next: DispatchState }) {
  assertIdentity(input.ownerThreadId);
  return retryCourseSupportWriterAdmission((timeout) => runWithCourseSupportWriterTransitionLease(async writerLease => transaction(async (tx) => {
    const transitionNow = await getCourseDispatchDatabaseNow(tx);
    const runs = await readRuns(tx);
    const run = runs.find((entry) => entry.parsed?.assignmentRef === input.assignmentRef);
    const audit = run?.parsed;
    if (!run || !audit || audit.ownerThreadId !== input.ownerThreadId || run.status !== "RUNNING") {
      throw new Error("Course dispatch assignment is unavailable.");
    }
    if (input.next !== "CANCELLED" && !isCourseSupportLaunchAuthorityCurrent(audit, transitionNow)) {
      throw new Error("Course dispatch launch authority expired.");
    }
    if (input.next === "BOUND" && audit.state === "BOUND" &&
        audit.childThreadId === input.childThreadId) {
      if (input.launcherReceiptPath && audit.launcherReceiptPath !== input.launcherReceiptPath) throw new Error("Original launcher receipt changed after binding.");
      return { assignmentRef: audit.assignmentRef, state: audit.state, baseSha: audit.baseSha };
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
      ...(input.next === "BOUND" && input.launcherReceiptPath ? { launcherReceiptPath: input.launcherReceiptPath } : {}),
    };
    await tx.automationRun.update({
      where: { id: run.id },
      data: {
        audit: updated as unknown as Prisma.InputJsonValue,
        ...(input.next === "CANCELLED" ? { status: "COMPLETED", completedAt: transitionNow, outcome: "cancelled_before_start" } : {}),
      },
    });
    return { assignmentRef: updated.assignmentRef, state: updated.state, baseSha: updated.baseSha };
  }, writerLease), { timeout }));
}

export function beginCourseSupportCourseDispatch(input: { ownerThreadId: string; assignmentRef: string }) {
  return transition({ ...input, next: "STARTING" });
}

export function bindCourseSupportCourseDispatch(input: { ownerThreadId: string; assignmentRef: string; childThreadId: string; launcherReceiptPath?: string }) {
  if (!input.childThreadId.trim()) throw new Error("Course dispatch requires the native child task id.");
  if (input.childThreadId === input.ownerThreadId) throw new Error("Course dispatch child must be a distinct native task.");
  if (input.launcherReceiptPath && (!isAbsolute(input.launcherReceiptPath) ||
      !input.launcherReceiptPath.endsWith("launcher.receipt.private.json"))) throw new Error("Original launcher receipt path is invalid.");
  return transition({ ...input, next: "BOUND" });
}

export function cancelCourseSupportCourseDispatch(input: { ownerThreadId: string; assignmentRef: string; confirmedNotCreated?: boolean }) {
  return transition({ ...input, next: "CANCELLED" });
}

export async function loadBoundCourseSupportDispatchAssignment(input: { assignmentRef: string; childThreadId: string; mode?: "SIMULATOR" }) {
  if (!input.childThreadId.trim()) throw new Error("Course dispatch requires the native child task id.");
  const runs = await readRuns(prisma);
  const audit = runs.find((run) => run.parsed?.assignmentRef === input.assignmentRef)?.parsed;
  if (!audit || audit.state !== "BOUND" || audit.childThreadId !== input.childThreadId || audit.target.mode !== input.mode ||
      !isCourseSupportLaunchAuthorityCurrent(audit, await getCourseDispatchDatabaseNow(prisma))) {
    throw new Error("Course dispatch assignment is not bound to this task.");
  }
  return audit;
}

export async function getCourseSupportCourseDispatchAssignment(input: { assignmentRef: string; childThreadId: string }) {
  if (!input.childThreadId.trim()) throw new Error("Course dispatch requires the native child task id.");
  const runs = await readRuns(prisma);
  const audit = runs.find((run) => run.parsed?.assignmentRef === input.assignmentRef)?.parsed;
  if (audit && !isCourseSupportLaunchAuthorityCurrent(audit, await getCourseDispatchDatabaseNow(prisma))) {
    throw new Error("Course dispatch launch authority expired.");
  }
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
      assignment.audit.baseSha !== input.baseSha ||
      !isCourseSupportLaunchAuthorityCurrent(assignment.audit, input.now)) {
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

/** Private references only; RUNNING is never proof of a native turn. */
async function collectCourseSupportContinuationCandidates(input: {
  ownerThreadId: string; now: Date; runs: Awaited<ReturnType<typeof readRuns>>; tx: Prisma.TransactionClient;
}) {
  const continuationItems: Array<{ mode: "SIMULATOR"; assignmentRef: string; threadId: string;
    originalParentThreadId: string; branch: string; baseSha: string;
    launcherReceiptPath?: string; claimToken?: string; claimRevision?: number; sourceFingerprint?: string;
    plannedPaths?: string[]; releaseSha?: string | null; checkpoint?: CourseSupportContinuationCheckpoint;
    expectedNativeContinuation?: { turnId: string; key: string; receiptPath: string } | null }> = [];
  let attentionCount = 0;
  if (!input.runs.some(run => run.status === "RUNNING" && run.parsed?.target.mode === "SIMULATOR" && run.parsed.state === "CONSUMED")) {
    return { continuationItems, attentionCount };
  }
  const { readSimulatorSupportContinuationContext } = await import("./simulator-support-ownership");
  for (const run of input.runs) {
    const audit = run.parsed;
    if (run.status !== "RUNNING" || !audit || audit.target.mode !== "SIMULATOR" || audit.state !== "CONSUMED") continue;
    if (!audit.childThreadId || audit.childThreadId === input.ownerThreadId) { attentionCount += 1; continue; }
    const ledger = readCourseSupportContinuationLedger(audit.simulatorContinuation);
    if (ledger.receipts.some(receipt => receipt.status === "PENDING")) { attentionCount += 1; continue; }
    try {
      const context = await readSimulatorSupportContinuationContext(input.tx, audit, input.now);
      if (!context.checkpoint || !assessCourseSupportContinuationCandidate({
        checkpoint: { ...context.checkpoint, providerReadInFlight: context.providerReadInFlight },
        ledger, sourceFingerprint: audit.simulatorClaim!.sourceFingerprint,
      }).candidate) { attentionCount += 1; continue; }
      if (context.checkpoint.kind === "EXPIRED_OWNED_STAGE" && !audit.launcherReceiptPath) { attentionCount += 1; continue; }
      continuationItems.push({ mode: "SIMULATOR", assignmentRef: audit.assignmentRef, threadId: audit.childThreadId,
        originalParentThreadId: audit.ownerThreadId, branch: audit.simulatorClaim!.branch, baseSha: audit.baseSha,
        ...(context.checkpoint.kind === "EXPIRED_OWNED_STAGE" ? {
          launcherReceiptPath: audit.launcherReceiptPath, claimToken: audit.simulatorClaim!.token,
          claimRevision: audit.simulatorClaim!.revision, sourceFingerprint: audit.simulatorClaim!.sourceFingerprint,
          plannedPaths: audit.simulatorClaim!.plannedPaths, releaseSha: audit.simulatorClaim!.releaseSha,
          expectedNativeContinuation: latestConfirmedNativeContinuation(ledger),
          checkpoint: { ...context.checkpoint, providerReadInFlight: context.providerReadInFlight },
        } : {}) });
    } catch { attentionCount += 1; }
  }
  return { continuationItems, attentionCount };
}

export async function reserveCourseSupportContinuation(input: {
  ownerThreadId: string;
  assignmentRef: string;
  policyVersion: typeof COURSE_SUPPORT_CONTINUATION_POLICY_VERSION;
  currentMainSha: string;
  nativeCompletion: unknown;
  readiness: unknown;
  expectedClaim?: { token: string; revision: number };
  reviewedToolingRepair?: CourseSupportReviewedToolingRepair;
}) {
  assertIdentity(input.ownerThreadId, input.currentMainSha);
  if (input.policyVersion !== COURSE_SUPPORT_CONTINUATION_POLICY_VERSION) {
    throw new Error("Continuation requires the current human-approved same-worker policy.");
  }
  return runWithCourseSupportWriterTransitionLease(() => transaction(async tx => {
    const now = await getCourseDispatchDatabaseNow(tx);
    const runs = await readRuns(tx);
    const row = runs.find(run => run.parsed?.assignmentRef === input.assignmentRef);
    const audit = row?.parsed;
    if (!row || row.status !== "RUNNING" || !audit || audit.target.mode !== "SIMULATOR" ||
        audit.state !== "CONSUMED" || !audit.childThreadId || audit.childThreadId === input.ownerThreadId ||
        !audit.simulatorClaim) return { reserved: false as const, reason: "ORIGINAL_ASSIGNMENT_NOT_CURRENT" };
    if (input.expectedClaim && (audit.simulatorClaim.token !== input.expectedClaim.token ||
        audit.simulatorClaim.revision !== input.expectedClaim.revision)) {
      return { reserved: false as const, reason: "ORIGINAL_CLAIM_REVISION_CHANGED" };
    }
    const { readSimulatorSupportContinuationContext } = await import("./simulator-support-ownership");
    const context = await readSimulatorSupportContinuationContext(tx, audit, now);
    if (!context.checkpoint || context.currentClaimRevision !== audit.simulatorClaim.revision) {
      return { reserved: false as const, reason: "ORIGINAL_CHECKPOINT_NOT_CURRENT" };
    }
    if (context.checkpoint.kind === "EXPIRED_OWNED_STAGE" && !input.expectedClaim) {
      return { reserved: false as const, reason: "ORIGINAL_CLAIM_PROOF_REQUIRED" };
    }
    const tick = `continuation-${Math.floor(now.getTime() / COURSE_SUPPORT_CONTINUATION_TICK_MS)}`;
    // A worker may finish after its continuation was reserved. Its older dispatch
    // run must still consume this tick, even when readRuns no longer includes it.
    const previousTickReceipt = await tx.automationRun.findFirst({
      where: { promptVersion: COURSE_DISPATCH_PROMPT_VERSION,
        audit: { path: ["simulatorContinuation", "receipts"], array_contains: [{ tickRef: tick }] } },
      select: { id: true },
    });
    const tickAlreadyUsed = Boolean(previousTickReceipt) || runs.some(run => readCourseSupportContinuationLedger(run.parsed?.simulatorContinuation)
      .receipts.some(receipt => receipt.tickRef === tick));
    const result = reserveCourseSupportContinuationReceipt({
      assignmentRef: audit.assignmentRef, childThreadId: audit.childThreadId,
      parentThreadId: input.ownerThreadId, sourceFingerprint: audit.simulatorClaim.sourceFingerprint,
      currentMainSha: input.currentMainSha, currentSource: context.currentSource, originalPrivateChild: true,
      nativeCompletion: input.nativeCompletion, readiness: input.readiness,
      checkpoint: { ...context.checkpoint, providerReadInFlight: context.providerReadInFlight },
      ledger: audit.simulatorContinuation, tickAlreadyUsed, reviewedToolingRepair: input.reviewedToolingRepair, now,
    });
    if (!result.reserved) return result;
    await tx.automationRun.update({ where: { id: row.id }, data: {
      audit: { ...audit, simulatorContinuation: result.ledger } as unknown as Prisma.InputJsonValue,
    } });
    return { reserved: true as const, mode: "SIMULATOR" as const, assignmentRef: audit.assignmentRef,
      threadId: audit.childThreadId, continuationKey: result.receipt.key, scope: result.receipt.scope };
  }));
}

export async function recordCourseSupportContinuationSent(input: {
  ownerThreadId: string; assignmentRef: string; continuationKey: string; childThreadId: string; toolReceipt: unknown;
}) {
  assertIdentity(input.ownerThreadId);
  return runWithCourseSupportWriterTransitionLease(() => transaction(async tx => {
    const now = await getCourseDispatchDatabaseNow(tx);
    const row = await tx.automationRun.findFirst({
      where: { promptVersion: COURSE_DISPATCH_PROMPT_VERSION,
        audit: { path: ["assignmentRef"], equals: input.assignmentRef } },
      select: { id: true, audit: true },
    });
    const audit = parseCourseDispatchAudit(row?.audit);
    if (!row || !audit || audit.target.mode !== "SIMULATOR" || audit.state !== "CONSUMED" ||
        audit.childThreadId !== input.childThreadId) throw new Error("Continuation no longer refers to the original native worker.");
    const ledger = confirmCourseSupportContinuationSent({ ledger: audit.simulatorContinuation, key: input.continuationKey,
      parentThreadId: input.ownerThreadId, childThreadId: input.childThreadId, toolReceipt: input.toolReceipt, now });
    await tx.automationRun.update({ where: { id: row.id }, data: {
      audit: { ...audit, simulatorContinuation: ledger } as unknown as Prisma.InputJsonValue,
    } });
    return { outcome: "same_worker_message_recorded" as const, assignmentRef: audit.assignmentRef,
      threadId: audit.childThreadId, monitoringVerified: false as const };
  }));
}
