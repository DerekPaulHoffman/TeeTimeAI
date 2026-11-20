import { createHash } from "node:crypto";
import type { CourseDiscoveryJob, Prisma } from "@prisma/client";
import { hasReciprocalLearningRepairLink, readLearningExecutionRuntime, readLearningRepairRecoveryOf } from "@/lib/course-discovery/learning-repair-recovery";

export type FailedLearningProgress = { version: 1; jobId: string; completedAt: string; fingerprint: string };
type Job = Pick<CourseDiscoveryJob, "id" | "courseId" | "offeringId" | "targetKey" | "baseRecipeId" | "sourceFingerprint" |
  "status" | "outcome" | "attempts" | "firstPickedUpAt" | "deadlineAt" | "completedAt" | "request" | "result">;
type Expected = {
  batchId: string; batchReference: string; ownerThreadId: string; releaseSha: string;
  deployedAt: Date; courseId: string; incidentId: string; cycle: number; sourceFingerprint: string;
  offeringId?: string; simulatorAssignmentRef?: string;
  searchRefs: readonly { id: string; alertGeneration: number }[]; now: Date;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const time = (value: Date | null) => value instanceof Date ? value.getTime() : NaN;

/** A new settled result can wake the same diagnostic owner once. It is never
 * another learner attempt, a lease, provider permission or monitoring proof. */
export function projectOwnedFailedLearningProgress(child: Job, parent: Job, expected: Expected): FailedLearningProgress | null {
  const link = readLearningRepairRecoveryOf(child.result);
  const completed = time(child.completedAt), picked = time(child.firstPickedUpAt), deadline = time(child.deadlineAt);
  const offeringId = expected.offeringId ?? null;
  const kind = offeringId ? "SIMULATOR" : "OUTDOOR";
  if (!link || !Number.isFinite(time(expected.now)) || !Number.isFinite(time(expected.deployedAt)) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(child.id) ||
    child.targetKey !== (offeringId ? `offering:${offeringId}` : `course:${expected.courseId}`) ||
    !["FAILED", "TIMED_OUT"].includes(child.status) || !child.outcome || !Number.isSafeInteger(child.attempts) || child.attempts < 1 || child.attempts > 2 ||
    !Number.isFinite(completed) || !Number.isFinite(picked) || deadline - picked !== 900_000 ||
    completed < picked || completed > expected.now.getTime() || Date.parse(link.requestedAt) > picked ||
    expected.deployedAt.getTime() > Date.parse(link.requestedAt) ||
    child.offeringId !== offeringId || parent.offeringId !== offeringId || child.courseId !== expected.courseId ||
    parent.courseId !== child.courseId || Boolean(offeringId) !== Boolean(expected.simulatorAssignmentRef) ||
    link.simulatorAssignmentRef !== expected.simulatorAssignmentRef ||
    child.targetKey !== parent.targetKey || child.baseRecipeId !== parent.baseRecipeId ||
    child.sourceFingerprint !== expected.sourceFingerprint || parent.sourceFingerprint !== child.sourceFingerprint ||
    link.sourceFingerprint !== child.sourceFingerprint || link.jobId !== child.id || link.originalJobId !== parent.id ||
    link.batchId !== expected.batchId || link.ownerThreadId !== expected.ownerThreadId || link.releaseSha !== expected.releaseSha ||
    link.incidentId !== expected.incidentId || link.cycle !== expected.cycle ||
    !["FAILED", "TIMED_OUT"].includes(parent.status) || time(parent.firstPickedUpAt) !== Date.parse(link.originalFirstPickedUpAt) ||
    time(parent.deadlineAt) !== Date.parse(link.originalDeadlineAt) || !hasReciprocalLearningRepairLink(parent.result, link) ||
    readLearningExecutionRuntime(child.result) !== link.runtimeVersion) return null;
  const request = record(parent.request), target = record(request?.target), demand = record(request?.demand);
  const childRequest = record(child.request), childTarget = record(childRequest?.target), childDemand = record(childRequest?.demand);
  if (target?.kind !== kind || target.courseId !== expected.courseId || (target.offeringId ?? null) !== offeringId ||
    childTarget?.kind !== kind || childTarget.courseId !== expected.courseId || (childTarget.offeringId ?? null) !== offeringId ||
    childDemand?.searchId !== demand?.searchId || childDemand?.alertGeneration !== demand?.alertGeneration ||
    !expected.searchRefs.some(ref => ref.id === demand?.searchId && ref.alertGeneration === demand.alertGeneration)) return null;
  const completedAt = child.completedAt!.toISOString();
  return { version: 1, jobId: child.id, completedAt,
    fingerprint: createHash("sha256").update([child.id, completedAt, expected.batchReference, expected.releaseSha].join("\0")).digest("hex") };
}

export async function readOwnedFailedLearningProgress(reader: Pick<Prisma.TransactionClient, "courseDiscoveryJob">,
  expected: Expected): Promise<FailedLearningProgress | null> {
  const children = await reader.courseDiscoveryJob.findMany({ where: {
    courseId: expected.courseId, offeringId: expected.offeringId ?? null, status: { in: ["FAILED", "TIMED_OUT"] },
    AND: [{ result: { path: ["learningRecoveryOf", "batchId"], equals: expected.batchId } },
      { result: { path: ["learningRecoveryOf", "releaseSha"], equals: expected.releaseSha } }],
  }, take: 2 });
  // A registered implementation has at most one reciprocal child. Ambiguity
  // never manufactures another continuation or selects a convenient failure.
  if (children.length !== 1) return null;
  const link = readLearningRepairRecoveryOf(children[0].result);
  if (!link) return null;
  const parent = await reader.courseDiscoveryJob.findUnique({ where: { id: link.originalJobId } });
  return parent ? projectOwnedFailedLearningProgress(children[0], parent, expected) : null;
}
