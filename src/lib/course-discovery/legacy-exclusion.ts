import { Prisma, type CourseDiscoveryJob } from "@prisma/client";
import { isSearchWindowActive } from "@/lib/automation/date-boundary";
import { getSyntheticMultiCycleExpiresAt } from "@/lib/automation/synthetic-test-window";
import { isCanonicalLegacyOutdoorOffering } from "@/lib/searches/course-monitoring-target";
import { activeDiscoveryPilotSearchIds, isCourseDiscoveryEnabled, isGeneralDiscoveryEnabled } from "./config";

type Target = { courseId: string; offeringId?: string | null };
type Reader = Pick<Prisma.TransactionClient, "coursePreference" | "courseDiscoveryPilotEnrollment" | "teeSearch" |
  "courseDiscoveryJob" | "course" | "courseOffering" | "courseAccessRecipe" | "courseProbe">;
function key(target: Target) { return target.offeringId ? `offering:${target.offeringId}` : `course:${target.courseId}`; }

/** An off pilot does not add database reads to the existing responder. */
export async function discoveryPilotTargetKeys(reader: Reader, now: Date) {
  if (!isCourseDiscoveryEnabled()) return new Set<string>();
  const general = isGeneralDiscoveryEnabled();
  const preferences = await reader.coursePreference.findMany({ where: {
    teeSearchId: { in: await activeDiscoveryPilotSearchIds(process.env, reader) }, teeSearch: { status: "ACTIVE" },
  }, select: { courseId: true, offeringId: true,
    course: { select: { timeZone: true, isPublic: true, monitoringMode: true } },
    offering: { select: { id: true, courseId: true, kind: true, active: true, publicAccessStatus: true } },
    teeSearch: {
    select: { status: true, mode: true, date: true, endTime: true, userTimeZone: true, createdAt: true,
      trafficClass: true, syntheticMultiCycle: true, syntheticTestWindow: true, alertGeneration: true },
  } } });
  const eligible = preferences.map(preference => {
    const { teeSearch, courseId, offeringId, offering } = preference;
    return teeSearch.mode === "OUTDOOR" && isCanonicalLegacyOutdoorOffering(courseId, offeringId, offering)
      ? { ...preference, offeringId: null, offering: null } : preference;
  }).filter(preference => {
    const search = preference.teeSearch;
    const synthetic = search.trafficClass === "TEST" || search.trafficClass === "AUTOMATION";
    const expiry = getSyntheticMultiCycleExpiresAt(search, now);
    // The general recipe loader rejects these sources. Keep their alerts in
    // their own monitoring lane without blocking the remaining dispatch queue.
    if (general) {
      const { course, offering, courseId, offeringId } = preference;
      if (offeringId) {
        if (!offering || offering.courseId !== courseId || offering.kind !== "SIMULATOR" ||
          !offering.active || offering.publicAccessStatus === "NOT_PUBLIC") return false;
      } else if (course.isPublic === false || course.monitoringMode === "LOCAL_READER_ONLY") return false;
    }
    return search.status === "ACTIVE" && (search.mode === "SIMULATOR") === Boolean(preference.offeringId) &&
      (!synthetic || search.syntheticMultiCycle && expiry !== null && expiry > now) &&
      isSearchWindowActive({ date: search.date, endTime: search.endTime, courseTimeZones: [preference.course.timeZone], fallbackTimeZone: search.userTimeZone, now });
  });
  const targets = new Map(eligible.map(target => [key(target), target]));
  // Pilot ownership intentionally covers the entire enrolled acceptance scope.
  if (!general) return new Set(targets.keys());
  if (!targets.size) return new Set<string>();
  const jobs = await reader.courseDiscoveryJob.findMany({ where: {
    activeTargetKey: { in: [...targets.keys()] }, status: { in: ["QUEUED", "RUNNING"] },
  }, select: { activeTargetKey: true, status: true } });
  const owned = new Set(jobs.filter(job => job.activeTargetKey && targets.has(job.activeTargetKey) &&
    (job.status === "QUEUED" || job.status === "RUNNING")).map(job => job.activeTargetKey!));
  // service imports the legacy ownership fence; defer this reverse dependency
  // until module initialization has completed and retain this exact reader.
  const { getActiveAccessRecipeInTransaction } = await import("./service");
  for (const [targetKey, target] of targets) {
    if (!owned.has(targetKey) && await getActiveAccessRecipeInTransaction(reader, {
      courseId: target.courseId, ...(target.offeringId ? { offeringId: target.offeringId } : {}),
    })) {
      const { currentDiscoveryEngineeringHandoff } = await import("./engineering-repair");
      if (!await currentDiscoveryEngineeringHandoff(reader, target, now)) owned.add(targetKey);
    }
  }
  return owned;
}

export async function excludeDiscoveryPilotTargets<T extends Target>(candidates: T[], reader: Reader, now: Date) {
  if (!isCourseDiscoveryEnabled() || candidates.length === 0) return candidates;
  const keys = await discoveryPilotTargetKeys(reader, now);
  return candidates.filter(candidate => !keys.has(key(candidate)));
}

export async function assertNotDiscoveryPilotTarget(reader: Reader, target: Target, now: Date) {
  if (!isCourseDiscoveryEnabled()) return;
  if ((await discoveryPilotTargetKeys(reader, now)).has(key(target))) throw new Error("This target is assigned to the course discovery pilot.");
}

/** Existing legacy ownership is never stolen when a target joins the pilot. */
export async function hasLegacyDiscoveryOwner(reader: Pick<Prisma.TransactionClient, "courseSupportBatch" | "automationRun">, target: Target) {
  return legacyDiscoveryOwnerConflict(reader, target);
}

/** Only a current reciprocal server-issued recovery link can share its own
 * coding owner's read lane. Ordinary admission retains the full exclusion. */
export async function discoveryJobLegacyOwnership(reader: Prisma.TransactionClient,
  job: Pick<CourseDiscoveryJob, "id" | "status" | "attempts" | "firstPickedUpAt" | "deadlineAt" | "result" | "targetKey" | "courseId" | "offeringId" | "sourceFingerprint" | "baseRecipeId">,
  now: Date) {
  const { learningRepairReadOwner } = await import("./learning-repair-recovery");
  const owner = await learningRepairReadOwner(reader, job, now);
  if (owner.kind === "INVALID") return { blocked: true, repairAuthorityLost: true };
  return { blocked: await legacyDiscoveryOwnerConflict(reader, job,
    owner.kind === "OWNED_REPAIR" ? owner : undefined), repairAuthorityLost: false };
}

async function legacyDiscoveryOwnerConflict(reader: Pick<Prisma.TransactionClient, "courseSupportBatch" | "automationRun">,
  target: Target, originalOwner?: { batchId: string; ownerThreadId: string; incidentId: string; cycle: number;
    assignmentRef: string | null; baseSha: string; observedAt: number; simulatorOfferingId?: string }) {
  const batch = await reader.courseSupportBatch.findFirst({ where: {
    ...(originalOwner && !originalOwner.simulatorOfferingId ? { id: { not: originalOwner.batchId } } : {}),
    status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] }, incidents: { some: { courseId: target.courseId } },
  }, select: { id: true } });
  if (batch) return true;
  const runs = await reader.automationRun.findMany({ where: {
    promptVersion: "course-support-course-dispatch-v1", status: "RUNNING",
    audit: { path: ["target", target.offeringId ? "offeringId" : "courseId"], equals: target.offeringId ?? target.courseId },
  }, select: { id: true, audit: true }, take: 16 });
  if (runs.length >= 16) throw new Error("Legacy ownership is unavailable.");
  const parser = originalOwner ? (await import("@/lib/automation/course-support-course-dispatch")).parseCourseDispatchAudit : null;
  return runs.some(run => {
    const audit = run.audit as Record<string, unknown> | null;
    if (!audit || !["RESERVED", "STARTING", "BOUND", "CONSUMED"].includes(String(audit.state))) throw new Error("Legacy ownership is unavailable.");
    const source = audit.target as Record<string, unknown> | undefined;
    if (!source) throw new Error("Legacy ownership is unavailable.");
    const matches = target.offeringId ? source.offeringId === target.offeringId : !source.offeringId && source.courseId === target.courseId;
    // The read job does not adopt another assignment or coding claim. Only
    // this batch's exact already-consumed native owner is a shared lane.
    const parsed = parser?.(audit);
    const consumedAt = Date.parse(parsed?.consumedAt ?? "");
    const shared = Boolean(originalOwner?.assignmentRef && parsed && parsed.state === "CONSUMED" &&
      parsed.childThreadId === originalOwner.ownerThreadId && parsed.assignmentRef === originalOwner.assignmentRef &&
      parsed.target.incidentId === originalOwner.incidentId && parsed.target.cycle === originalOwner.cycle &&
      parsed.baseSha === originalOwner.baseSha &&
      (originalOwner.simulatorOfferingId ? parsed.target.mode === "SIMULATOR" &&
        parsed.target.offeringId === originalOwner.simulatorOfferingId && run.id === originalOwner.batchId
        : parsed.target.mode === undefined && !parsed.target.offeringId) &&
      parsed.controlledRetryOf === undefined && Number.isFinite(consumedAt) &&
      consumedAt >= Date.parse(parsed.reservedAt) && consumedAt <= originalOwner.observedAt);
    return matches && !shared;
  });
}
