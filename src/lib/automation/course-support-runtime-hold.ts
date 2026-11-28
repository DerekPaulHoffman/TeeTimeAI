import { z } from "zod";
import type { RuntimeUpdateDiagnostic } from "./course-support-runtime-update";

const HOLD_RECEIPT_MAX_AGE_MS = 60_000;
const DB_CLOCK_TOLERANCE_MS = 5_000;
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const sourceFingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(128);
const timestamp = z.string().datetime();
const blockedRuntime = z.discriminatedUnion("reasonCode", [
  z.object({ reasonCode: z.literal("MANAGED_RUNTIME_CHECKOUT_MISSING"), phase: z.literal("VALIDATE_MANAGED_CHECKOUT") }),
  z.object({ reasonCode: z.literal("DEPENDENCY_SCHEMA_OR_INSTALLED_READER_ROLLOUT_REQUIRED"), phase: z.literal("VALIDATE_SOURCE") }),
]);

export type CourseSupportLearningRuntimeBlocker = {
  kind: "WINDOWS_RUNTIME_BLOCKED";
  runtimeVersion: string;
  observedAt: Date;
  diagnostic: RuntimeUpdateDiagnostic;
};

export type CourseSupportLearningRuntimeReadyReceipt = {
  kind: "WINDOWS_RUNTIME_READY";
  runtimeVersion: string;
  observedAt: Date;
  heartbeatAt: Date;
};

const scope = z.object({
  runtimeVersion: sha, observedAt: timestamp, heldAt: timestamp, ownerThreadId: id, releaseSha: sha,
  incidentId: id, originalJobId: id, sourceFingerprint, cycle: z.number().int().positive(),
});
const runtimeHoldSchema = z.discriminatedUnion("reasonCode", [
  scope.extend({ version: z.literal(1), reasonCode: z.literal("MANAGED_RUNTIME_CHECKOUT_MISSING"), phase: z.literal("VALIDATE_MANAGED_CHECKOUT") }).strict(),
  scope.extend({ version: z.literal(1), reasonCode: z.literal("DEPENDENCY_SCHEMA_OR_INSTALLED_READER_ROLLOUT_REQUIRED"), phase: z.literal("VALIDATE_SOURCE") }).strict(),
]);
export type CourseSupportVerificationRuntimeHold = z.infer<typeof runtimeHoldSchema>;

export function readCourseSupportVerificationRuntimeHold(value: unknown) {
  const parsed = runtimeHoldSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isCourseSupportVerificationRuntimeHeld(value: unknown) {
  return readCourseSupportVerificationRuntimeHold(value) !== null;
}

function isFreshReceiptTime(value: Date, now: Date) {
  if (!(value instanceof Date)) return false;
  const age = now.getTime() - value.getTime();
  return age >= -DB_CLOCK_TOLERANCE_MS && age <= HOLD_RECEIPT_MAX_AGE_MS;
}

export function readPreAdmissionRuntimeBlocker(evidence: CourseSupportLearningRuntimeBlocker, now: Date) {
  if (evidence.kind !== "WINDOWS_RUNTIME_BLOCKED" || !sha.safeParse(evidence.runtimeVersion).success ||
      !isFreshReceiptTime(evidence.observedAt, now)) return null;
  const diagnostic = evidence.diagnostic;
  if (!diagnostic.attributed || diagnostic.apply !== true || diagnostic.acceptanceRestartProof !== false ||
      diagnostic.stateChanged !== false || diagnostic.mutationAttempted !== false || diagnostic.drainAttempted !== false ||
      diagnostic.taskStopAttempted !== false || diagnostic.runtimeUpdateAttempted !== false || diagnostic.taskStartAttempted !== false ||
      diagnostic.activationWriteAttempted !== false || diagnostic.taskStartRequests !== 0 || diagnostic.firstStoppedTaskResult !== null) return null;
  const parsed = blockedRuntime.safeParse(diagnostic);
  return parsed.success ? parsed.data : null;
}

export function isFreshRuntimeReadyReceipt(
  receipt: CourseSupportLearningRuntimeReadyReceipt, hold: CourseSupportVerificationRuntimeHold, now: Date,
) {
  return receipt.kind === "WINDOWS_RUNTIME_READY" && sha.safeParse(receipt.runtimeVersion).success &&
    isFreshReceiptTime(receipt.observedAt, now) && isFreshReceiptTime(receipt.heartbeatAt, now) &&
    receipt.heartbeatAt <= receipt.observedAt &&
    receipt.heartbeatAt.getTime() > Math.max(Date.parse(hold.heldAt), Date.parse(hold.observedAt));
}
