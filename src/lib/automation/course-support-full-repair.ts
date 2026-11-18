/** A failed reader is an engineering mission, not a succession of verifier
 * assignments. Negative deployed evidence stays with the same lease owner. */
export function fullRepairReadProgressMatchesClaim(input: {
  fullRepair: boolean; claimedEventCount: number; runtimeVersion: string | null;
  batchCreatedAt: Date; now: Date;
  releaseHistory?: unknown;
  events: readonly { observedAt: string; runtimeVersion: string; transition: string;
    factualDisposition?: unknown; technicalReason?: unknown }[];
}) {
  if (!Number.isSafeInteger(input.claimedEventCount) || input.claimedEventCount < 0 ||
      input.claimedEventCount > input.events.length) return false;
  if (input.claimedEventCount === input.events.length) return true;
  if (!input.fullRepair || !/^[a-f0-9]{40}$/u.test(input.runtimeVersion ?? "") ||
      !Number.isFinite(input.batchCreatedAt?.getTime())) return false;
  const previousRuntimeWindows = fullRepairPreviousRuntimeWindows(input);
  return input.events.slice(input.claimedEventCount).every(event => {
    const observedAt = new Date(event.observedAt);
    const previous = previousRuntimeWindows.get(event.runtimeVersion);
    const ownedRuntime = event.runtimeVersion === input.runtimeVersion ||
      Boolean(previous && observedAt >= previous.deployedAt && observedAt < previous.supersededAt);
    return ownedRuntime && observedAt >= input.batchCreatedAt && observedAt <= input.now &&
      ["STARTED", "COMPLETED", "NOT_APPLICABLE", "FAILED_RETRYABLE"].includes(event.transition) &&
      event.factualDisposition === undefined && event.technicalReason === undefined;
  });
}

/** The server owns this same batch's append-only registered release history.
 * Only a complete deployed chain ending at the current release can explain
 * earlier non-final reads. It grants no new read or implementation authority. */
function fullRepairPreviousRuntimeWindows(input: { runtimeVersion: string | null; releaseHistory?: unknown; now: Date }) {
  const windows = new Map<string, { deployedAt: Date; supersededAt: Date }>();
  if (!Array.isArray(input.releaseHistory) || input.releaseHistory.length === 0 || input.releaseHistory.length > 100) return windows;
  let priorSupersededAt: Date | null = null;
  for (let index = 0; index < input.releaseHistory.length; index++) {
    const entry = input.releaseHistory[index];
    const next = input.releaseHistory[index + 1];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !/^[a-f0-9]{40}$/u.test(entry.releaseSha ?? "") || windows.has(entry.releaseSha) ||
        entry.releaseSha === input.runtimeVersion || entry.supersededBy !== (next?.releaseSha ?? input.runtimeVersion) ||
        typeof entry.deployedAt !== "string" || typeof entry.supersededAt !== "string") return new Map();
    const deployedAt = new Date(entry.deployedAt), supersededAt = new Date(entry.supersededAt);
    if (!Number.isFinite(deployedAt.getTime()) || !Number.isFinite(supersededAt.getTime()) ||
        deployedAt > supersededAt || supersededAt > input.now ||
        (priorSupersededAt && supersededAt < priorSupersededAt)) return new Map();
    windows.set(entry.releaseSha, { deployedAt, supersededAt });
    priorSupersededAt = supersededAt;
  }
  return windows;
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
