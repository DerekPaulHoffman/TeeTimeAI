import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { assertSimulatorSupportDeployment } from "./simulator-support-policy";
import { readSimulatorResearchState } from "./simulator-support-research-policy";

const reference = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/u);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const directiveSchema = z.object({ version: z.literal(1), kind: z.literal("FAILED_LEARNER_FULL_REPAIR"),
  failedJobId: reference, learningSourceFingerprint: fingerprint, offeringSourceFingerprint: fingerprint,
  incidentId: reference }).strict();
export type SimulatorFullRepair = z.infer<typeof directiveSchema>;
export function readSimulatorFullRepair(value: unknown): SimulatorFullRepair | null {
  const parsed = directiveSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function currentSimulatorFullRepair(tx: Prisma.TransactionClient, target: {
  courseId: string; offeringId: string; incidentId: string; offeringSourceFingerprint: string;
}, now: Date): Promise<SimulatorFullRepair | null> {
  const { currentDiscoveryEngineeringHandoff } = await import("@/lib/course-discovery/engineering-repair");
  const handoff = await currentDiscoveryEngineeringHandoff(tx, target, now);
  if (!handoff || handoff.receipt.incidentId !== target.incidentId || handoff.job.courseId !== target.courseId ||
      handoff.job.offeringId !== target.offeringId || handoff.source.course.monitoringMode === "LOCAL_READER_ONLY") return null;
  return directiveSchema.parse({ version: 1, kind: "FAILED_LEARNER_FULL_REPAIR", failedJobId: handoff.job.id,
    learningSourceFingerprint: handoff.job.sourceFingerprint, offeringSourceFingerprint: target.offeringSourceFingerprint,
    incidentId: target.incidentId });
}

/** One consumed mission per exact failed learner, not one new chat per tick.
 * Startup reservations do not consume a repair that never claimed its source. */
export async function hasConsumedSimulatorFullRepair(tx: Prisma.TransactionClient, offeringId: string, directive: SimulatorFullRepair) {
  const rows = await tx.automationRun.findMany({ where: { promptVersion: "course-support-course-dispatch-v1", AND: [
    { audit: { path: ["target", "offeringId"], equals: offeringId } },
    { audit: { path: ["target", "fullRepair", "failedJobId"], equals: directive.failedJobId } },
    { audit: { path: ["state"], equals: "CONSUMED" } },
  ] }, select: { audit: true }, take: 2 });
  // Unknown consumed provenance is attention, never a reason to duplicate it.
  return rows.length > 0;
}

/** A published repair can delegate one late read to the normal learner.
 * Revalidate the native owner, offering and original demand on each use. */
export async function loadSimulatorRecoveryClaim(tx: Pick<Prisma.TransactionClient, "automationRun" | "simulatorSupportIncident" |
  "courseDiscoveryJob" | "course" | "courseOffering" | "teeSearch" | "coursePreference" | "courseDiscoveryPilotEnrollment" | "courseProbe">,
  runId: string, now: Date, allowExpiredDelegation = false) {
  const run = await tx.automationRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "RUNNING" || run.promptVersion !== "course-support-course-dispatch-v1") return null;
  const { parseCourseDispatchAudit } = await import("./course-support-course-dispatch");
  const audit = parseCourseDispatchAudit(run.audit);
  const claim = audit?.simulatorClaim;
  const repair = readSimulatorFullRepair(audit?.target.fullRepair);
  if (!audit || audit.state !== "CONSUMED" || !audit.childThreadId || audit.target.mode !== "SIMULATOR" ||
      audit.controlledRetryOf || audit.target.engineeringAuthority || !repair || !claim ||
      claim.phase !== "VERIFYING" || !claim.releaseSha || claim.releaseSha === audit.baseSha || !claim.deployment ||
      !claim.plannedPaths.length || (!allowExpiredDelegation && Date.parse(claim.leaseExpiresAt) <= now.getTime()) ||
      (audit as { simulatorRepairPending?: unknown }).simulatorRepairPending ||
      readSimulatorResearchState(audit.simulatorResearch, claim.sourceFingerprint).inFlight ||
      repair.offeringSourceFingerprint !== claim.sourceFingerprint || audit.target.incidentId !== repair.incidentId) return null;
  try { assertSimulatorSupportDeployment(claim.deployment, claim.releaseSha, now); }
  catch { return null; }
  const { currentDiscoveryEngineeringFailure } = await import("@/lib/course-discovery/service");
  const { discoveryEngineeringReceipt } = await import("@/lib/course-discovery/engineering-repair");
  const failure = await currentDiscoveryEngineeringFailure(tx, repair.failedJobId, now);
  const receipt = discoveryEngineeringReceipt(failure?.job.result);
  if (!failure || !receipt || failure.job.courseId !== audit.target.courseId ||
      !failure.source.offering || failure.source.offering.id !== audit.target.offeringId ||
      failure.source.course.monitoringMode === "LOCAL_READER_ONLY" ||
      failure.source.offering.publicAccessStatus === "NOT_PUBLIC" ||
      failure.job.sourceFingerprint !== repair.learningSourceFingerprint ||
      receipt.sourceFingerprint !== repair.learningSourceFingerprint || receipt.incidentId !== repair.incidentId ||
      !audit.target.searchRefs.some(ref => ref.id === failure.search.id && ref.alertGeneration === failure.search.alertGeneration))
    return null;
  const offering = await tx.courseOffering.findUnique({ where: { id: failure.source.offering.id } });
  const incident = await tx.simulatorSupportIncident.findUnique({ where: { id: repair.incidentId } });
  if (!offering || offering.monitoringMode === "LOCAL_READER_ONLY" || offering.monitoringRevision !== claim.offeringRevision ||
      getSimulatorOfferingSourceFingerprint(offering) !== claim.sourceFingerprint ||
      incident?.offeringId !== offering.id || incident.status !== "AUTO_INVESTIGATING") return null;
  return { audit, claim, failure };
}
