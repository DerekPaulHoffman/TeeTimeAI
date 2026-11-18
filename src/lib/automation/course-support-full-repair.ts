/** A failed reader is an engineering mission, not a succession of verifier
 * assignments. Negative deployed evidence stays with the same lease owner. */
export function fullRepairReadProgressMatchesClaim(input: {
  fullRepair: boolean; claimedEventCount: number; runtimeVersion: string | null;
  batchCreatedAt: Date; now: Date;
  events: readonly { observedAt: string; runtimeVersion: string; transition: string;
    factualDisposition?: unknown; technicalReason?: unknown }[];
}) {
  if (!Number.isSafeInteger(input.claimedEventCount) || input.claimedEventCount < 0 ||
      input.claimedEventCount > input.events.length) return false;
  if (input.claimedEventCount === input.events.length) return true;
  if (!input.fullRepair || !/^[a-f0-9]{40}$/u.test(input.runtimeVersion ?? "") ||
      !Number.isFinite(input.batchCreatedAt?.getTime())) return false;
  return input.events.slice(input.claimedEventCount).every(event => {
    const observedAt = new Date(event.observedAt);
    return event.runtimeVersion === input.runtimeVersion && observedAt >= input.batchCreatedAt && observedAt <= input.now &&
      ["STARTED", "COMPLETED", "NOT_APPLICABLE", "FAILED_RETRYABLE"].includes(event.transition) &&
      event.factualDisposition === undefined && event.technicalReason === undefined;
  });
}

export function isDataOnlyFullRepair(input: {
  reason: string | null; workMode: string; requiresImplementationPath: boolean;
  plannedPaths: readonly string[]; baseSha: string; releaseSha: string | null;
  allowedActions: readonly string[];
}) {
  return input.reason === "FAILED_LEARNER_IMPLEMENTATION_HANDOFF" &&
    input.workMode === "IMPLEMENT_REUSABLE_SUPPORT" && !input.requiresImplementationPath &&
    input.plannedPaths.length === 0 && (!input.releaseSha || input.releaseSha === input.baseSha) &&
    input.allowedActions.includes("INVESTIGATE_PUBLIC_SOURCE") &&
    input.allowedActions.includes("IMPLEMENT_REUSABLE_SUPPORT");
}

export function allowsRetainedFullRepairResearch(input: {
  reason: string | null;
  workMode: string;
  batchStatus: string;
  result: string;
  allowedActions: readonly string[];
}) {
  return input.reason === "FAILED_LEARNER_IMPLEMENTATION_HANDOFF" &&
    input.workMode === "IMPLEMENT_REUSABLE_SUPPORT" && ["VERIFYING", "IMPLEMENTING"].includes(input.batchStatus) &&
    input.result === "STALE_EVIDENCE" &&
    input.allowedActions.includes("INVESTIGATE_PUBLIC_SOURCE") &&
    input.allowedActions.includes("IMPLEMENT_REUSABLE_SUPPORT");
}

export function shouldContinueOwnedFullRepair(packet: {
  remediation: { reason: string | null } | null;
  courses: readonly {
    result: string;
    terminalProofDurable: boolean;
    actionPlan: { allowedActions: readonly string[] } | null;
  }[];
}) {
  return packet.remediation?.reason === "FAILED_LEARNER_IMPLEMENTATION_HANDOFF" &&
    packet.courses.length === 1 &&
    packet.courses.every(course => course.actionPlan?.allowedActions.includes("INVESTIGATE_PUBLIC_SOURCE") &&
      course.actionPlan.allowedActions.includes("IMPLEMENT_REUSABLE_SUPPORT")) &&
    !packet.courses.every(course => course.terminalProofDurable &&
      (course.result === "RESTORED" || course.result === "FINAL_DISPOSITION"));
}
