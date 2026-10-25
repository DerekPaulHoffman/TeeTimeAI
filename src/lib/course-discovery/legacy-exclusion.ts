import { Prisma } from "@prisma/client";
import { isSearchWindowActive } from "@/lib/automation/date-boundary";
import { getSyntheticMultiCycleExpiresAt } from "@/lib/automation/synthetic-test-window";
import { activeDiscoveryPilotSearchIds, isCourseDiscoveryEnabled, isGeneralDiscoveryEnabled } from "./config";

type Target = { courseId: string; offeringId?: string | null };
type Reader = Pick<Prisma.TransactionClient, "coursePreference" | "courseDiscoveryPilotEnrollment" | "teeSearch" |
  "courseDiscoveryJob" | "course" | "courseOffering" | "courseAccessRecipe">;
function key(target: Target) { return target.offeringId ? `offering:${target.offeringId}` : `course:${target.courseId}`; }

/** An off pilot does not add database reads to the existing responder. */
export async function discoveryPilotTargetKeys(reader: Reader, now: Date) {
  if (!isCourseDiscoveryEnabled()) return new Set<string>();
  const preferences = await reader.coursePreference.findMany({ where: {
    teeSearchId: { in: await activeDiscoveryPilotSearchIds(process.env, reader) }, teeSearch: { status: "ACTIVE" },
  }, select: { courseId: true, offeringId: true, course: { select: { timeZone: true } }, teeSearch: {
    select: { status: true, mode: true, date: true, endTime: true, userTimeZone: true, createdAt: true,
      trafficClass: true, syntheticMultiCycle: true, syntheticTestWindow: true, alertGeneration: true },
  } } });
  const eligible = preferences.filter(preference => {
    const search = preference.teeSearch;
    const synthetic = search.trafficClass === "TEST" || search.trafficClass === "AUTOMATION";
    const expiry = getSyntheticMultiCycleExpiresAt(search, now);
    return search.status === "ACTIVE" && (search.mode === "SIMULATOR") === Boolean(preference.offeringId) &&
      (!synthetic || search.syntheticMultiCycle && expiry !== null && expiry > now) &&
      isSearchWindowActive({ date: search.date, endTime: search.endTime, courseTimeZones: [preference.course.timeZone], fallbackTimeZone: search.userTimeZone, now });
  });
  const targets = new Map(eligible.map(target => [key(target), target]));
  // Pilot ownership intentionally covers the entire enrolled acceptance scope.
  if (!isGeneralDiscoveryEnabled()) return new Set(targets.keys());
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
    })) owned.add(targetKey);
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
  const batch = await reader.courseSupportBatch.findFirst({ where: {
    status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] }, incidents: { some: { courseId: target.courseId } },
  }, select: { id: true } });
  if (batch) return true;
  const runs = await reader.automationRun.findMany({ where: {
    promptVersion: "course-support-course-dispatch-v1", status: "RUNNING",
    audit: { path: ["target", target.offeringId ? "offeringId" : "courseId"], equals: target.offeringId ?? target.courseId },
  }, select: { audit: true }, take: 16 });
  if (runs.length >= 16) throw new Error("Legacy ownership is unavailable.");
  return runs.some(run => {
    const audit = run.audit as Record<string, unknown> | null;
    if (!audit || !["RESERVED", "STARTING", "BOUND", "CONSUMED"].includes(String(audit.state))) throw new Error("Legacy ownership is unavailable.");
    const source = audit.target as Record<string, unknown> | undefined;
    if (!source) throw new Error("Legacy ownership is unavailable.");
    return target.offeringId ? source.offeringId === target.offeringId : !source.offeringId && source.courseId === target.courseId;
  });
}
