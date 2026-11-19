import type { Prisma } from "@prisma/client";
import { z } from "zod";

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
