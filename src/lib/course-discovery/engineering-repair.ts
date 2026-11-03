import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { reportCourseSupportIssue } from "@/lib/automation/support-incidents";
import { reconcileSimulatorSupportIncidentFailure } from "@/lib/automation/simulator-support-incidents";
import { isCourseDiscoveryEnabled, isGeneralDiscoveryEnabled } from "./config";
import { currentDiscoveryEngineeringFailure } from "./service";
import { hasLegacyDiscoveryOwner } from "./legacy-exclusion";

const receiptSchema = z.object({ version: z.literal(1), state: z.literal("QUEUED"),
  incidentId: z.string().min(1).max(128), queuedAt: z.string().datetime(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
type Reader = Parameters<typeof currentDiscoveryEngineeringFailure>[0];
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const safeCode = (v: unknown) => typeof v === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(v) ? v : null;

/** Closed hints only. Model checkpoints explain a failure, never establish
 * monitoring eligibility, completeness, access requirements or write authority. */
export function discoveryFailureDiagnosis(job: { outcome: string | null; checkpoint: unknown }) {
  const checkpoint = object(job.checkpoint), progress = object(checkpoint.stagehandProgress), failure = object(checkpoint.stagehandFailure);
  const code = safeCode(failure.code), phase = safeCode(progress.phase);
  const category = job.outcome === "DEADLINE" ? "DEADLINE_EXCEEDED" : job.outcome === "UNSUPPORTED" ? "MISSING_READER_CAPABILITY" :
    code === "GUARDED_HOST" ? "BROWSER_TRANSPORT_REJECTED" : code === "ADAPTER_CONFIGURATION_CHANGED" ? "SAVED_METHOD_SOURCE_CHANGED" :
      code === "BROWSER_UNAVAILABLE" ? "LOCAL_BROWSER_UNAVAILABLE" : phase === "INDEPENDENT_REPLAY" ? "REPLAY_VALIDATION_FAILED" : "READER_OR_RUNTIME_FAILURE";
  return { category, code, phase, evidenceAuthority: false as const };
}

export function discoveryEngineeringReceipt(result: unknown) {
  const parsed = receiptSchema.safeParse(object(result).engineeringHandoff);
  return parsed.success ? parsed.data : null;
}

/** A current, server-issued link permits the existing coding responder to own
 * implementation while ordinary saved-method execution can still recover. */
export async function currentDiscoveryEngineeringHandoff(reader: Reader, target: { courseId: string; offeringId?: string | null }, now: Date) {
  if (!isCourseDiscoveryEnabled() || !isGeneralDiscoveryEnabled()) return null;
  const rows = await reader.courseDiscoveryJob.findMany({ where: { courseId: target.courseId, offeringId: target.offeringId ?? null,
    status: { in: ["FAILED", "TIMED_OUT"] }, result: { path: ["engineeringHandoff", "state"], equals: "QUEUED" } },
  orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 17 });
  if (rows.length === 17) throw new Error("Discovery engineering handoff history reached its bounded limit.");
  for (const row of rows) {
    const receipt = discoveryEngineeringReceipt(row.result);
    if (!receipt || receipt.sourceFingerprint !== row.sourceFingerprint) continue;
    const current = await currentDiscoveryEngineeringFailure(reader, row.id, now);
    if (current) return { ...current, receipt };
  }
  return null;
}

export async function discoveryEngineeringContext(reader: Reader, target: { courseId: string; offeringId?: string | null }, incidentId: string, now: Date) {
  const current = await currentDiscoveryEngineeringHandoff(reader, target, now);
  if (!current || current.receipt.incidentId !== incidentId) return null;
  const { job } = current;
  return { version: 1, jobId: job.id, sourceFingerprint: job.sourceFingerprint, baseRecipeId: job.baseRecipeId,
    originalFirstPickupAt: job.firstPickedUpAt!.toISOString(), originalDeadlineAt: job.deadlineAt!.toISOString(),
    completedAt: job.completedAt!.toISOString(), attempts: job.attempts, outcome: job.outcome,
    originalDeadlineExpired: now > job.deadlineAt!, diagnosis: discoveryFailureDiagnosis(job),
    instruction: "Diagnose and repair reusable code under the existing assignment, path, implementation and release gates. Reproduce the failure, add a regression, verify fresh public inventory and independent model-disabled replay. Keep this original job terminal; recovery after its deadline does not pass the original fifteen-minute contract." };
}

/** Existing scheduled coding dispatch is the sole consumer. A restart or a
 * failed queue write retries this idempotent link without retrying discovery,
 * resetting an incident cooldown, sending email or changing customer intent. */
export async function reconcileDiscoveryEngineeringHandoffs(now = new Date()) {
  if (!isCourseDiscoveryEnabled() || !isGeneralDiscoveryEnabled()) return { examined: 0, queued: 0 };
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT j.id FROM "CourseDiscoveryJob" j JOIN "TeeSearch" s ON s.id=j.request->'demand'->>'searchId'
    WHERE j.status IN ('FAILED','TIMED_OUT') AND j.outcome IN ('TOOL_FAILURE','UNSUPPORTED','DEADLINE')
      AND j."firstPickedUpAt" IS NOT NULL AND j."completedAt" <= ${now} AND s.status='ACTIVE'
      AND j.request->'demand'->>'alertGeneration'=s."alertGeneration"::text
      AND s.date >= (${now}::timestamptz - interval '1 day')::date
      AND COALESCE(j.result->'engineeringHandoff'->>'state','') NOT IN ('QUEUED','OBSOLETE')
    ORDER BY j."completedAt",j.id LIMIT 16`);
  let queued = 0;
  for (const candidate of candidates) {
    const current = await prisma.$transaction(async tx => {
      const failure = await currentDiscoveryEngineeringFailure(tx, candidate.id, now);
      if (!failure) {
        const obsolete = await tx.courseDiscoveryJob.findUnique({ where: { id: candidate.id } });
        if (obsolete && ["FAILED", "TIMED_OUT"].includes(obsolete.status) && !discoveryEngineeringReceipt(obsolete.result)) {
          await tx.courseDiscoveryJob.updateMany({ where: { id: obsolete.id, status: obsolete.status, updatedAt: obsolete.updatedAt },
            data: { result: { ...object(obsolete.result), engineeringHandoff: { version: 1, state: "OBSOLETE", observedAt: now.toISOString(),
              reason: "SOURCE_DEMAND_OR_SUCCESS_SUPERSEDED_FAILURE" } } as Prisma.InputJsonValue } });
        }
        return null;
      }
      if (discoveryEngineeringReceipt(failure.job.result) ||
          await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: failure.job.targetKey } }) ||
          await hasLegacyDiscoveryOwner(tx, failure.request.target)) return null;
      return failure;
    });
    if (!current) continue;
    const { job, source, request } = current;
    let incidentId: string | null = null;
    if (job.offeringId) {
      incidentId = await prisma.$transaction(async tx => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "Course" WHERE id=${job.courseId} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "CourseOffering" WHERE id=${job.offeringId} FOR UPDATE`);
        if (!await currentDiscoveryEngineeringFailure(tx, job.id, now) ||
            await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: job.targetKey } }) ||
            await hasLegacyDiscoveryOwner(tx, request.target)) return null;
        const existing = await tx.simulatorSupportIncident.findUnique({ where: { offeringId: job.offeringId! } });
        // Attach evidence to the existing episode without changing its reason,
        // final disposition or future retry. The normal reconciler may reopen
        // a resolved episode, but must not reset an unresolved one's cooldown.
        if (existing && existing.status !== "RESOLVED") return existing.status === "AUTO_INVESTIGATING" ? existing.id : null;
        await reconcileSimulatorSupportIncidentFailure(tx, { offeringId: job.offeringId!, reason: "DISCOVERY_CODE_REPAIR",
          evidenceUrl: source.identity.officialUrl, now, eligible: true });
        const incident = await tx.simulatorSupportIncident.findUnique({ where: { offeringId: job.offeringId! } });
        return incident?.status === "AUTO_INVESTIGATING" ? incident.id : null;
      });
    } else {
      const issue = await reportCourseSupportIssue({ course: source.course, searchId: request.demand.searchId,
        kind: "NEEDS_ADAPTER", message: "The public reader could not produce a verified reusable method; code diagnosis is required.",
        nextAction: "Inspect the discoveryEngineeringFailure packet, reproduce its failure, and repair reusable monitoring under the normal implementation and release gates.",
        readPath: "DISCOVERY_CODE_REPAIR", now, failureObservedAt: job.completedAt!, episodeStartedAt: job.firstPickedUpAt!,
        onBeforeSourceWrite: async tx => { if (!await currentDiscoveryEngineeringFailure(tx, job.id, now) ||
          await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: job.targetKey } }) ||
          await hasLegacyDiscoveryOwner(tx, request.target)) throw new Error("Discovery engineering source or ownership changed."); } });
      incidentId = issue.status === "AUTO_INVESTIGATING" ? issue.incidentId : null;
    }
    if (!incidentId) continue;
    const linked = await prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Course" WHERE id=${job.courseId} FOR UPDATE`);
      const fresh = await currentDiscoveryEngineeringFailure(tx, job.id, now);
      if (!fresh || discoveryEngineeringReceipt(fresh.job.result) ||
          await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: job.targetKey } }) ||
          await hasLegacyDiscoveryOwner(tx, request.target)) return false;
      const incident = job.offeringId ? await tx.simulatorSupportIncident.findUnique({ where: { id: incidentId! } }) :
        await tx.courseSupportIncident.findUnique({ where: { id: incidentId! } });
      if (!incident || incident.status !== "AUTO_INVESTIGATING" ||
          (job.offeringId ? !("offeringId" in incident) || incident.offeringId !== job.offeringId : !("courseId" in incident) || incident.courseId !== job.courseId)) return false;
      const receipt = receiptSchema.parse({ version: 1, state: "QUEUED", incidentId, queuedAt: now.toISOString(), sourceFingerprint: job.sourceFingerprint });
      const result = { ...object(fresh.job.result), engineeringHandoff: receipt } as Prisma.InputJsonValue;
      const changed = await tx.courseDiscoveryJob.updateMany({ where: { id: job.id, status: job.status, updatedAt: fresh.job.updatedAt,
        sourceFingerprint: job.sourceFingerprint }, data: { result } });
      return changed.count === 1;
    });
    if (linked) queued++;
  }
  return { examined: candidates.length, queued };
}
