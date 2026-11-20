import { z } from "zod";
import type { CourseDiscoveryJob, Prisma } from "@prisma/client";
import { readCourseSupportRemediationClaimAttempt } from "@/lib/automation/course-support-claim-evidence";

const id = z.string().min(1).max(128);
/** An audit link, never authority by itself. The server must independently
 * re-read both jobs, the original failure, live batch and current demand. */
export const learningRepairRecoverySchema = z.object({
  version: z.literal(1), kind: z.literal("LATE_ENGINEERING_RECOVERY"),
  originalJobId: id, jobId: id, batchId: id, incidentId: id, ownerThreadId: id,
  simulatorAssignmentRef: id.optional(),
  cycle: z.number().int().positive(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  releaseSha: z.string().regex(/^[a-f0-9]{40}$/u),
  runtimeVersion: z.string().regex(/^[a-f0-9]{40}$/u), requestedAt: z.string().datetime(),
  originalFirstPickedUpAt: z.string().datetime(), originalDeadlineAt: z.string().datetime(),
}).strict().refine(value => value.originalJobId !== value.jobId &&
  Date.parse(value.originalDeadlineAt) - Date.parse(value.originalFirstPickedUpAt) === 900_000);
export type LearningRepairRecovery = z.infer<typeof learningRepairRecoverySchema>;
export const MAX_LEARNING_REPAIR_RECOVERIES = 16;
export const learningRecipeHandoffSchema = z.object({ version: z.literal(1),
  phase: z.literal("METHOD_REPLAYED_MONITORING_PENDING"), recovery: learningRepairRecoverySchema,
  recipeId: id, recipeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), handedOffAt: z.string().datetime(),
}).strict();
const historySchema = z.array(learningRepairRecoverySchema).max(MAX_LEARNING_REPAIR_RECOVERIES)
  .refine(links => new Set(links.map(link => link.jobId)).size === links.length &&
    new Set(links.map(link => `${link.batchId}:${link.releaseSha}`)).size === links.length);
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function readLearningRepairRecoveries(result: unknown): LearningRepairRecovery[] | null {
  if (result === null || result === undefined) return [];
  const record = object(result);
  if (!record) return null;
  if (!Object.hasOwn(record, "learningRecoveries")) return [];
  const parsed = historySchema.safeParse(record.learningRecoveries);
  return parsed.success ? parsed.data : null;
}

export function hasLearningRepairRecoveryMarker(result: unknown) {
  const record = object(result);
  return Boolean(record && Object.hasOwn(record, "learningRecoveryOf"));
}

export function readLearningRepairRecoveryOf(result: unknown): LearningRepairRecovery | null {
  const parsed = learningRepairRecoverySchema.safeParse(object(result)?.learningRecoveryOf);
  return parsed.success ? parsed.data : null;
}

export function readLearningExecutionRuntime(result: unknown) {
  const parsed = z.string().regex(/^[a-f0-9]{40}$/u).safeParse(object(result)?.executionRuntimeVersion);
  return parsed.success ? parsed.data : null;
}

export function readLearningRecipeHandoff(summary: unknown) {
  const parsed = learningRecipeHandoffSchema.safeParse(object(summary)?.learningRecoveryHandoff);
  return parsed.success ? parsed.data : null;
}

/** Match every persisted field, not just an arbitrary job/batch identifier. */
export function hasReciprocalLearningRepairLink(parentResult: unknown, child: LearningRepairRecovery) {
  const history = readLearningRepairRecoveries(parentResult);
  return history?.some(link => JSON.stringify(link) === JSON.stringify(child)) === true;
}

type Reader = Pick<Prisma.TransactionClient, "courseDiscoveryJob" | "courseSupportBatch" | "course" |
  "courseOffering" | "teeSearch" | "coursePreference" | "courseDiscoveryPilotEnrollment" | "courseProbe">;
type OwnedRead = { kind: "OWNED_REPAIR"; batchId: string; ownerThreadId: string; incidentId: string; cycle: number;
  assignmentRef: string | null; baseSha: string; observedAt: number; simulatorOfferingId?: string };

/** This is only the outdoor coding batch lane. Simulator ownership must use
 * its offering-scoped authority, never an outdoor course exemption. */
export async function loadOwnedOutdoorRepairBatch(reader: Pick<Reader, "courseSupportBatch">, input: {
  batchId: string; now: Date; allowExpiredDelegation?: boolean; allowCompletedMethodHandoff?: boolean;
}) {
  const batch = await reader.courseSupportBatch.findUnique({ where: { id: input.batchId }, select: {
    id: true, status: true, completedAt: true, createdAt: true, deployedAt: true,
    ownerThreadId: true, ownerAutomationRunId: true, leaseToken: true, leaseExpiresAt: true, baseSha: true, releaseSha: true, summary: true,
    incidents: { select: { incidentId: true, courseId: true, cycle: true,
      incident: { select: { status: true, resolution: true, courseId: true, activeBatchId: true, cycle: true, revision: true } } } },
  } });
  if (!batch || !batch.ownerThreadId || !batch.releaseSha ||
      !/^[a-f0-9]{40}$/u.test(batch.releaseSha) || !/^[a-f0-9]{40}$/u.test(batch.baseSha) ||
      batch.releaseSha === batch.baseSha || !batch.deployedAt || batch.deployedAt < batch.createdAt ||
      batch.deployedAt > input.now || batch.incidents.length !== 1) return null;
  const marker = readLearningRecipeHandoff(batch.summary);
  const completedHandoff = input.allowCompletedMethodHandoff === true && batch.status === "PARTIAL" &&
    batch.completedAt !== null && marker !== null && marker.recovery.batchId === batch.id &&
    marker.recovery.ownerThreadId === batch.ownerThreadId && marker.recovery.releaseSha === batch.releaseSha &&
    marker.handedOffAt === batch.completedAt.toISOString();
  const active = batch.status === "VERIFYING" && batch.completedAt === null && batch.leaseExpiresAt !== null &&
    (batch.leaseExpiresAt > input.now || input.allowExpiredDelegation === true);
  if (!active && !completedHandoff) return null;
  const entry = batch.incidents[0], summary = object(batch.summary), directive = object(summary?.remediation);
  if (!summary || !directive || directive.reason !== "FAILED_LEARNER_IMPLEMENTATION_HANDOFF" ||
      directive.workMode !== "IMPLEMENT_REUSABLE_SUPPORT" || !Array.isArray(summary.plannedPaths) ||
      !summary.plannedPaths.length || !summary.plannedPaths.every(path => typeof path === "string" && path.length > 0) ||
      (completedHandoff ? entry.incident.activeBatchId !== null ||
        !(entry.incident.status === "AUTO_INVESTIGATING" || entry.incident.status === "RESOLVED" && entry.incident.resolution === "MONITORING_RESTORED")
        : entry.incident.status !== "AUTO_INVESTIGATING" || entry.incident.activeBatchId !== batch.id) ||
      entry.courseId !== entry.incident.courseId || entry.cycle !== entry.incident.cycle) return null;
  const claim = readCourseSupportRemediationClaimAttempt({ summary: batch.summary,
    courseId: entry.courseId, expectedAttemptCount: 1 });
  if (!claim?.actionPlan || claim.actionPlan.primaryAction !== "IMPLEMENT_REUSABLE_SUPPORT" ||
      !claim.actionPlan.allowedActions.includes("INVESTIGATE_PUBLIC_SOURCE") ||
      !claim.actionPlan.allowedActions.includes("IMPLEMENT_REUSABLE_SUPPORT") ||
      claim.approach.workMode !== directive.workMode || claim.approach.strategyAction !== directive.strategyAction ||
      claim.approach.playbookStage !== directive.playbookStage) return null;
  return { batch, entry, recordedHandoff: completedHandoff ? marker : null };
}

export async function loadOwnedOutdoorLearningRepair(reader: Reader, input: {
  batchId: string; originalJobId: string; now: Date; allowExpiredDelegation?: boolean;
}) {
  const owned = await loadOwnedOutdoorRepairBatch(reader, input);
  if (!owned) return null;
  const { batch, entry } = owned;
  const { currentDiscoveryEngineeringFailure } = await import("./service");
  const failure = await currentDiscoveryEngineeringFailure(reader, input.originalJobId, input.now);
  if (!failure || failure.job.courseId !== entry.courseId || failure.job.offeringId !== null ||
      failure.request.target.kind !== "OUTDOOR" || failure.source.course.isPublic === false ||
      failure.source.course.monitoringMode === "LOCAL_READER_ONLY") return null;
  const { discoveryEngineeringReceipt } = await import("./engineering-repair");
  const receipt = discoveryEngineeringReceipt(failure.job.result);
  if (!receipt || receipt.incidentId !== entry.incidentId ||
      receipt.sourceFingerprint !== failure.job.sourceFingerprint) return null;
  return { batch, entry, failure };
}

/** Call only with the current job row read by claim/owned inside their
 * transaction. A checkpoint or caller-supplied receipt cannot grant this. */
export async function learningRepairReadOwner(reader: Reader & Pick<Prisma.TransactionClient, "automationRun" | "simulatorSupportIncident">,
  job: Pick<CourseDiscoveryJob, "id" | "status" | "attempts" | "firstPickedUpAt" | "deadlineAt" | "result" | "targetKey" | "courseId" | "offeringId" | "sourceFingerprint" | "baseRecipeId">,
  now: Date): Promise<{ kind: "ORDINARY" } | { kind: "INVALID" } |
    OwnedRead> {
  if (!hasLearningRepairRecoveryMarker(job.result)) return { kind: "ORDINARY" };
  const link = readLearningRepairRecoveryOf(job.result);
  if (!link || link.jobId !== job.id || link.sourceFingerprint !== job.sourceFingerprint ||
      Boolean(link.simulatorAssignmentRef) !== Boolean(job.offeringId) ||
      Date.parse(link.requestedAt) > now.getTime() || !["QUEUED", "RUNNING"].includes(job.status) ||
      job.status === "RUNNING" && readLearningExecutionRuntime(job.result) !== link.runtimeVersion) return { kind: "INVALID" };
  const delegated = job.attempts > 0 && job.attempts <= 2 && job.firstPickedUpAt !== null && job.deadlineAt !== null &&
    job.deadlineAt.getTime() - job.firstPickedUpAt.getTime() === 900_000 && job.deadlineAt > now &&
    readLearningExecutionRuntime(job.result) === link.runtimeVersion;
  if (job.offeringId && link.simulatorAssignmentRef) {
    const { loadSimulatorRecoveryClaim } = await import("@/lib/automation/simulator-full-repair");
    const owned = await loadSimulatorRecoveryClaim(reader, link.batchId, now, delegated);
    if (!owned || owned.audit.assignmentRef !== link.simulatorAssignmentRef ||
        owned.audit.childThreadId !== link.ownerThreadId || owned.claim.releaseSha !== link.releaseSha ||
        owned.audit.target.cycle !== link.cycle || owned.audit.target.offeringId !== job.offeringId ||
        owned.audit.target.courseId !== job.courseId || owned.audit.target.incidentId !== link.incidentId ||
        owned.failure.job.id !== link.originalJobId || owned.failure.job.targetKey !== job.targetKey ||
        owned.failure.job.baseRecipeId !== job.baseRecipeId || owned.failure.job.sourceFingerprint !== job.sourceFingerprint ||
        owned.failure.job.firstPickedUpAt!.toISOString() !== link.originalFirstPickedUpAt ||
        owned.failure.job.deadlineAt!.toISOString() !== link.originalDeadlineAt ||
        !hasReciprocalLearningRepairLink(owned.failure.job.result, link) ||
        Date.parse(owned.claim.deployment!.deployedAt) > Date.parse(link.requestedAt)) return { kind: "INVALID" };
    return { kind: "OWNED_REPAIR", batchId: link.batchId, ownerThreadId: link.ownerThreadId, incidentId: link.incidentId,
      assignmentRef: link.simulatorAssignmentRef, baseSha: owned.audit.baseSha, cycle: link.cycle, observedAt: now.getTime(),
      simulatorOfferingId: job.offeringId };
  }
  const owned = await loadOwnedOutdoorLearningRepair(reader, { batchId: link.batchId, originalJobId: link.originalJobId, now,
    allowExpiredDelegation: delegated });
  if (!owned || !hasReciprocalLearningRepairLink(owned.failure.job.result, link) ||
      owned.batch.ownerThreadId !== link.ownerThreadId || owned.batch.releaseSha !== link.releaseSha || owned.batch.deployedAt!.getTime() > Date.parse(link.requestedAt) ||
      owned.entry.incidentId !== link.incidentId || owned.entry.cycle !== link.cycle ||
      owned.failure.job.firstPickedUpAt!.toISOString() !== link.originalFirstPickedUpAt ||
      owned.failure.job.deadlineAt!.toISOString() !== link.originalDeadlineAt ||
      owned.failure.job.targetKey !== job.targetKey || owned.failure.job.courseId !== job.courseId ||
      owned.failure.job.sourceFingerprint !== job.sourceFingerprint || owned.failure.job.baseRecipeId !== job.baseRecipeId) return { kind: "INVALID" };
  const assignmentRef = object(owned.batch.summary)?.dispatchAssignmentRef;
  return { kind: "OWNED_REPAIR", batchId: owned.batch.id, ownerThreadId: owned.batch.ownerThreadId!,
    incidentId: owned.entry.incidentId, cycle: owned.entry.cycle,
    assignmentRef: typeof assignmentRef === "string" ? assignmentRef : null,
    baseSha: owned.batch.baseSha, observedAt: now.getTime() };
}
