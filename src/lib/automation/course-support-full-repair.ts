/** A failed reader is an engineering mission, not a succession of verifier
 * assignments. Negative deployed evidence stays with the same lease owner. */
export function fullRepairContinuationMode(input: {
  status: string; baseSha: string; releaseSha: string | null; deployedAt: Date | null;
  plannedPaths: unknown; now: Date;
}) {
  if (!/^[a-f0-9]{40}$/u.test(input.baseSha) || !Number.isFinite(input.now.getTime()) ||
      !Array.isArray(input.plannedPaths) ||
      input.plannedPaths.some(path => typeof path !== "string" || !path)) return null;
  const paths = input.plannedPaths;
  const deployed = input.deployedAt instanceof Date && Number.isFinite(input.deployedAt.getTime()) && input.deployedAt <= input.now;
  // Claiming the first path moves VERIFYING to IMPLEMENTING. That useful
  // progress must not remove this same owner's native continuation route.
  // Local qualification separately proves any clean planned candidate; this
  // selector never registers its unpublished bytes or grants recovery.
  if (input.status === "IMPLEMENTING" && paths.length > 0 && paths.length <= 32 && paths.every(path => path.length <= 300) &&
      deployed) {
    if (input.releaseSha === input.baseSha) return "CLAIMED_IMPLEMENTATION" as const;
    if (/^[a-f0-9]{40}$/u.test(input.releaseSha ?? "")) return "PUBLISHED_IMPLEMENTATION" as const;
  }
  if (input.status !== "VERIFYING") return null;
  if (paths.length === 0 && input.releaseSha === input.baseSha) return "DATA_ONLY" as const;
  return paths.length > 0 && /^[a-f0-9]{40}$/u.test(input.releaseSha ?? "") && input.releaseSha !== input.baseSha && deployed
    ? "PUBLISHED_IMPLEMENTATION" as const : null;
}

/** A changed source with no implementation belongs to the original owner's
 * existing reconciliation path, never to research using the stale claim. */
export function fullRepairSourceContinuation(input: {
  mode: ReturnType<typeof fullRepairContinuationMode>; result: string;
  claimedFingerprint: string; currentFingerprint: string;
}) {
  if (!input.mode || !/^[a-f0-9]{64}$/u.test(input.claimedFingerprint) ||
      !/^[a-f0-9]{64}$/u.test(input.currentFingerprint)) return null;
  if (input.claimedFingerprint === input.currentFingerprint) return "CONTINUE_REPAIR" as const;
  return input.mode === "DATA_ONLY" && input.result === "STALE_EVIDENCE"
    ? "RECONCILE_SOURCE" as const : null;
}

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
 * Only a complete registered chain ending at the current release can explain
 * earlier non-final reads; undeployed entries supply no read window.
 * It grants no new read or implementation authority. */
function fullRepairPreviousRuntimeWindows(input: { runtimeVersion: string | null; releaseHistory?: unknown; now: Date }) {
  const windows = new Map<string, { deployedAt: Date; supersededAt: Date }>();
  const registered = new Set<string>();
  if (!Array.isArray(input.releaseHistory) || input.releaseHistory.length === 0 || input.releaseHistory.length > 100) return windows;
  let priorSupersededAt: Date | null = null;
  for (let index = 0; index < input.releaseHistory.length; index++) {
    const entry = input.releaseHistory[index];
    const next = input.releaseHistory[index + 1];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !/^[a-f0-9]{40}$/u.test(entry.releaseSha ?? "") || registered.has(entry.releaseSha) ||
        entry.releaseSha === input.runtimeVersion || entry.supersededBy !== (next?.releaseSha ?? input.runtimeVersion) ||
        (entry.deployedAt !== null && typeof entry.deployedAt !== "string") || typeof entry.supersededAt !== "string") return new Map();
    const supersededAt = new Date(entry.supersededAt);
    if (!Number.isFinite(supersededAt.getTime()) || supersededAt > input.now ||
        (priorSupersededAt && supersededAt < priorSupersededAt)) return new Map();
    registered.add(entry.releaseSha);
    if (entry.deployedAt !== null) {
      const deployedAt = new Date(entry.deployedAt);
      if (!Number.isFinite(deployedAt.getTime()) || deployedAt > supersededAt) return new Map();
      windows.set(entry.releaseSha, { deployedAt, supersededAt });
    }
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
  pendingVerificationStopped?: boolean;
}) {
  return input.reason === "FAILED_LEARNER_IMPLEMENTATION_HANDOFF" &&
    input.workMode === "IMPLEMENT_REUSABLE_SUPPORT" && ["VERIFYING", "IMPLEMENTING"].includes(input.batchStatus) &&
    (input.result === "STALE_EVIDENCE" || input.result === "PENDING" && input.pendingVerificationStopped === true) &&
    input.allowedActions.includes("INVESTIGATE_PUBLIC_SOURCE") &&
    input.allowedActions.includes("IMPLEMENT_REUSABLE_SUPPORT");
}

export function hasStoppedFullRepairVerification(input: { summary: unknown; batchCreatedAt: Date; deployedAt: Date | null; now: Date }) {
  if (!input.summary || typeof input.summary !== "object" || Array.isArray(input.summary) ||
      !input.deployedAt || !Number.isFinite(input.deployedAt.getTime())) return false;
  const checkpoints = (input.summary as Record<string, unknown>).ownerFailureCheckpoints;
  const checkpoint = Array.isArray(checkpoints) ? checkpoints.at(-1) : null;
  if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.stage !== "VERIFICATION" ||
      checkpoint.failureDomain !== "PRODUCTION_VERIFICATION" || checkpoint.reasonCode !== "VERIFICATION_TOOLING_FAILED" ||
      typeof checkpoint.recordedAt !== "string") return false;
  const recordedAt = new Date(checkpoint.recordedAt);
  return recordedAt >= input.batchCreatedAt && recordedAt >= input.deployedAt && recordedAt <= input.now;
}

/** Selection permits local qualification inspection only. It never asserts a
 * stopped provider operation or grants another verification/read attempt. */
export function allowsFullRepairReleaseQualificationInspection(input: {
  reason: string | null; workMode: string; batchStatus: string; result: string;
  allowedActions: readonly string[]; continuationMode: ReturnType<typeof fullRepairContinuationMode>;
}) {
  return input.reason === "FAILED_LEARNER_IMPLEMENTATION_HANDOFF" &&
    input.workMode === "IMPLEMENT_REUSABLE_SUPPORT" && input.batchStatus === "VERIFYING" && input.result === "PENDING" &&
    input.continuationMode === "PUBLISHED_IMPLEMENTATION" &&
    input.allowedActions.includes("INVESTIGATE_PUBLIC_SOURCE") && input.allowedActions.includes("IMPLEMENT_REUSABLE_SUPPORT");
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
