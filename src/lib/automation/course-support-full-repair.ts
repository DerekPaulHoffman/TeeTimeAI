import type { Prisma } from "@prisma/client";

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
  mode: ReturnType<typeof fullRepairContinuationMode> | "REGISTERED_IMPLEMENTATION"; result: string;
  claimedFingerprint: string; currentFingerprint: string;
}) {
  if (!input.mode || !/^[a-f0-9]{64}$/u.test(input.claimedFingerprint) ||
      !/^[a-f0-9]{64}$/u.test(input.currentFingerprint)) return null;
  if (input.claimedFingerprint === input.currentFingerprint) return "CONTINUE_REPAIR" as const;
  return input.mode === "DATA_ONLY" && input.result === "STALE_EVIDENCE"
    ? "RECONCILE_SOURCE" as const : null;
}

export function interruptedRegisteredFullRepairPaths(input: {
  status: string; result: string; baseSha: string; releaseSha: string | null; deployedAt: Date | null;
  leaseExpiresAt: Date; now: Date; recheckDispatchKey: string | null;
  recheckDispatchStartedAt: Date | null; recheckDispatchedAt: Date | null;
  summary: Record<string, unknown>;
}) {
  const { summary } = input;
  const provenance = summary.releaseProvenance as Record<string, unknown> | null;
  const paths = summary.plannedPaths;
  const eligible = input.status === "VERIFYING" && input.result === "PENDING" && input.deployedAt === null &&
    input.leaseExpiresAt <= input.now && input.releaseSha !== input.baseSha && /^[a-f0-9]{40}$/u.test(input.releaseSha ?? "") &&
    input.recheckDispatchKey === null && input.recheckDispatchStartedAt === null && input.recheckDispatchedAt === null &&
    summary.searchExecutionFence === null && summary.recheckDispatch === null &&
    Array.isArray(paths) && paths.length > 0 && paths.every(path => typeof path === "string" && path.length > 0) &&
    provenance?.schemaVersion === 1 && provenance.descendantVerified === true && provenance.toSha === input.releaseSha &&
    typeof provenance.fromSha === "string" && /^[a-f0-9]{40}$/u.test(provenance.fromSha) && provenance.fromSha !== input.releaseSha &&
    typeof summary.branch === "string" && provenance.branch === summary.branch && Array.isArray(provenance.committedPaths) &&
    provenance.committedPaths.length > 0 && provenance.committedPaths.length <= 32 &&
    provenance.committedPaths.every(path => typeof path === "string" && paths.includes(path));
  // The original claim can accumulate paths over multiple releases. The
  // local controller only needs the proven delta for this registered commit.
  return eligible ? provenance.committedPaths as string[] : null;
}

export function fullRepairReadProgressMatchesClaim(input: {
  fullRepair: boolean; claimedEventCount: number; runtimeVersion: string | null;
  batchCreatedAt: Date; now: Date;
  releaseHistory?: unknown;
  olderReleaseWindows?: unknown;
  legacyBaseVerification?: Awaited<ReturnType<typeof readLegacyFullRepairBaseVerification>>;
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
    const legacy = input.legacyBaseVerification;
    const ownedRuntime = event.runtimeVersion === input.runtimeVersion ||
      Boolean(previous && observedAt >= previous.deployedAt && observedAt < previous.supersededAt) ||
      Boolean(legacy && event.runtimeVersion === legacy.releaseSha && observedAt >= legacy.startedAt && observedAt <= legacy.completedAt);
    return ownedRuntime && observedAt >= input.batchCreatedAt && observedAt <= input.now &&
      ["STARTED", "COMPLETED", "NOT_APPLICABLE", "FAILED_RETRYABLE"].includes(event.transition) &&
      event.factualDisposition === undefined && event.technicalReason === undefined;
  });
}

/** Old versions retained only twenty detailed entries. The original base's
 * exact verified deployment and settled detached request can prove the much
 * narrower time when that request actually ran. This is a read-only witness:
 * it never reconstructs a missing release transition or reopens a request. */
export async function readLegacyFullRepairBaseVerification(
  db: Pick<Prisma.TransactionClient, "courseMonitoringEvent" | "courseSupportVerificationRequest">,
  input: { batchId: string; batchReference: string; entryId: string; courseId: string; incidentId: string;
    baseSha: string; runtimeVersion: string | null; providerSnapshotFingerprint: string;
    batchCreatedAt: Date; now: Date; releaseHistory?: unknown; olderReleaseWindows?: unknown },
) {
  if (!/^[a-f0-9]{40}$/u.test(input.baseSha) || input.baseSha === input.runtimeVersion ||
      !Array.isArray(input.releaseHistory) || input.releaseHistory.length !== 20) return null;
  const older = Array.isArray(input.olderReleaseWindows) ? input.olderReleaseWindows : [];
  const history = [...older, ...input.releaseHistory];
  if (history.some(entry => entry?.releaseSha === input.baseSha) || !fullRepairPreviousRuntimeWindows(input).size) return null;
  const firstSupersession = new Date(history[0]?.supersededAt);
  if (!Number.isFinite(firstSupersession.getTime())) return null;
  const [deployment, verification] = await Promise.all([
    db.courseMonitoringEvent.findUnique({
      where: { idempotencyKey: `course-support-deployment:${input.batchId}:${input.entryId}:${input.baseSha}` },
      select: { courseId: true, incidentId: true, eventType: true, source: true, deploymentSha: true,
        runtimeVersion: true, occurredAt: true, audit: true },
    }),
    db.courseSupportVerificationRequest.findUnique({
      where: { batchIncidentId_releaseSha: { batchIncidentId: input.entryId, releaseSha: input.baseSha } },
      select: { courseId: true, status: true, lastError: true, outcome: true, runtimeVersion: true, startedAt: true,
        completedAt: true, deadlineAt: true, createdAt: true, providerSnapshotFingerprint: true, evidence: true },
    }),
  ]);
  const audit = deployment?.audit as Record<string, unknown> | null | undefined;
  if (!deployment || deployment.courseId !== input.courseId || deployment.incidentId !== input.incidentId ||
      deployment.eventType !== "DEPLOYMENT_VERIFIED" || deployment.source !== "DEPLOYMENT" ||
      deployment.deploymentSha !== input.baseSha || deployment.runtimeVersion !== input.baseSha ||
      audit?.batchRef !== input.batchReference || !verification || verification.courseId !== input.courseId ||
      verification.runtimeVersion !== input.baseSha || verification.providerSnapshotFingerprint !== input.providerSnapshotFingerprint ||
      verification.outcome !== "FETCH_FAILED" ||
      !(verification.status === "SUCCEEDED" || verification.status === "STALE" && verification.lastError === "active_demand")) return null;
  const { createdAt, startedAt, completedAt, deadlineAt } = verification;
  const evidence = verification.evidence as Record<string, unknown> | null;
  if (!startedAt || !completedAt || ![deployment.occurredAt, createdAt, startedAt, completedAt, deadlineAt].every(date => Number.isFinite(date.getTime())) ||
      createdAt < input.batchCreatedAt || deployment.occurredAt > createdAt || createdAt > startedAt ||
      startedAt > completedAt || completedAt >= firstSupersession || completedAt > deadlineAt || completedAt > input.now ||
      evidence?.schemaVersion !== 1 || evidence.kind !== "PROVIDER_VERIFICATION" || evidence.outcome !== "FETCH_FAILED" ||
      evidence.releaseSha !== input.baseSha || evidence.runtimeVersion !== input.baseSha ||
      evidence.providerSnapshotFingerprint !== input.providerSnapshotFingerprint || typeof evidence.observedAt !== "string") return null;
  const observedAt = Date.parse(evidence.observedAt);
  if (!(observedAt >= startedAt.getTime() && observedAt <= completedAt.getTime())) return null;
  return { releaseSha: input.baseSha, startedAt, completedAt };
}

/** The server owns this same batch's append-only registered release history.
 * Only a complete registered chain ending at the current release can explain
 * earlier non-final reads; undeployed entries supply no read window.
 * It grants no new read or implementation authority. */
const releaseWindowLimit = 100;

/** Keep only provenance needed to validate old reads when the detailed
 * verification history rolls over. Do not reinterpret any of those results. */
export function retainOlderFullRepairReleaseWindows(olderWindows: unknown, evicted: readonly unknown[]) {
  if (olderWindows !== undefined && !Array.isArray(olderWindows)) {
    throw new Error("The earlier repair release history is malformed.");
  }
  const windows = [...(olderWindows ?? []), ...evicted.map(raw => {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.releaseSha !== "string" || typeof entry.supersededBy !== "string" ||
        typeof entry.supersededAt !== "string" || (entry.deployedAt !== null && typeof entry.deployedAt !== "string")) {
      throw new Error("The repair release cannot be archived without its provenance.");
    }
    return { releaseSha: entry.releaseSha, deployedAt: entry.deployedAt,
      supersededAt: entry.supersededAt, supersededBy: entry.supersededBy };
  })];
  if (windows.length > releaseWindowLimit) {
    throw new Error("The earlier repair release history is full. No release proof was discarded.");
  }
  return windows;
}

function fullRepairPreviousRuntimeWindows(input: { runtimeVersion: string | null; releaseHistory?: unknown; olderReleaseWindows?: unknown; now: Date }) {
  const windows = new Map<string, { deployedAt: Date; supersededAt: Date }>();
  const registered = new Set<string>();
  const older = input.olderReleaseWindows === undefined ? [] : input.olderReleaseWindows;
  if (!Array.isArray(input.releaseHistory) || input.releaseHistory.length === 0 || input.releaseHistory.length > releaseWindowLimit ||
      !Array.isArray(older) || older.length > releaseWindowLimit) return windows;
  const history = [...older, ...input.releaseHistory];
  let priorSupersededAt: Date | null = null;
  for (let index = 0; index < history.length; index++) {
    const entry = history[index];
    const next = history[index + 1];
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
