import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { z } from "zod";

import type { SimulatorSupportFailure } from "./simulator-support-failure";

/** Human-approved recovery of an existing native worker, never a new launch. */
export const COURSE_SUPPORT_CONTINUATION_POLICY_VERSION = "same-native-worker-recovery-v1";
export const COURSE_SUPPORT_CONTINUATION_MAX_ATTEMPTS = 2;
export const COURSE_SUPPORT_CONTINUATION_TICK_MS = 10 * 60_000;
const RECEIPT_FRESHNESS_MS = 2 * 60_000;
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const instant = z.string().datetime();

// These are projections of the supported tool result, not database status.
export const courseSupportNativeCompletionSchema = z.object({
  version: z.literal(1), source: z.literal("codex_app.wait_threads"),
  threadId: reference, observedAt: instant, cursor: reference,
  threadStatus: z.enum(["idle", "notLoaded", "completed"]),
  latestTurn: z.object({ id: reference, status: z.literal("completed"), error: z.null() }).strict(),
  activeTurnId: z.null(), approvalRequestCount: z.literal(0),
}).strict();
export type CourseSupportNativeCompletion = z.infer<typeof courseSupportNativeCompletionSchema>;

export const courseSupportContinuationReadinessSchema = z.object({
  version: z.literal(1), source: z.literal("original_native_launcher_receipt"),
  threadId: reference, observedAt: instant, launcherReceiptDigest: digest,
  checkoutIdentityDigest: digest, privateOriginalChild: z.literal(true),
  approvalPolicy: z.literal("never"), sandboxMode: z.literal("danger-full-access"),
  nativeIdentityVerified: z.literal(true), noApprovalRequired: z.literal(true),
  sameProfile: z.literal(true), runtimeReady: z.literal(true), toolingReleaseSha: sha,
}).strict();
export type CourseSupportContinuationReadiness = z.infer<typeof courseSupportContinuationReadinessSchema>;

const scopeSchema = z.enum(["RESUME_ALLOWED_RESEARCH", "DIAGNOSE_REVIEWED_TOOLING_UPDATE"]);
export type CourseSupportContinuationScope = z.infer<typeof scopeSchema>;
const receiptSchema = z.object({
  version: z.literal(1), policyVersion: z.literal(COURSE_SUPPORT_CONTINUATION_POLICY_VERSION),
  key: digest, checkpointDigest: digest, sourceFingerprint: digest,
  nativeCompletionDigest: digest, readinessDigest: digest, parentThreadId: reference,
  childThreadId: reference, attempt: z.number().int().min(1).max(COURSE_SUPPORT_CONTINUATION_MAX_ATTEMPTS),
  tickRef: reference, requestedAt: instant, scope: scopeSchema,
  status: z.enum(["PENDING", "SENT"]), sentAt: instant.nullable(),
}).strict().refine(receipt => (receipt.status === "SENT") === (receipt.sentAt !== null));
const ledgerSchema = z.object({ version: z.literal(1), receipts: z.array(receiptSchema).max(8) }).strict()
  .refine(ledger => new Set(ledger.receipts.map(receipt => receipt.key)).size === ledger.receipts.length)
  .refine(ledger => ledger.receipts.every((receipt, index) => receipt.attempt ===
    ledger.receipts.slice(0, index + 1).filter(entry => entry.sourceFingerprint === receipt.sourceFingerprint).length));
export type CourseSupportContinuationLedger = z.infer<typeof ledgerSchema>;

export type CourseSupportContinuationCheckpoint = {
  kind: "SETTLED_FAILURE" | "EXPIRED_UNFINISHED_READ";
  observedAt: string;
  readCount: number;
  requestId: string | null;
  failure: SimulatorSupportFailure | null;
  allowedResearchRouteCount: number;
  providerReadInFlight: boolean;
};

export type CourseSupportReviewedToolingRepair = {
  policyVersion: typeof COURSE_SUPPORT_CONTINUATION_POLICY_VERSION;
  releaseSha: string;
  source: "git";
  state: "READY";
  branch: "main";
  aliases: string[];
  deployedAt: string;
};

export const courseSupportContinuationRequestSchema = z.object({
  policyVersion: z.literal(COURSE_SUPPORT_CONTINUATION_POLICY_VERSION),
  nativeCompletion: courseSupportNativeCompletionSchema,
  readiness: courseSupportContinuationReadinessSchema,
  reviewedToolingRepair: z.object({
    policyVersion: z.literal(COURSE_SUPPORT_CONTINUATION_POLICY_VERSION), releaseSha: sha,
    source: z.literal("git"), state: z.literal("READY"), branch: z.literal("main"),
    aliases: z.array(z.string().max(253)).max(10), deployedAt: instant,
  }).strict().optional(),
}).strict();

export const courseSupportContinuationSentRequestSchema = z.object({
  continuationKey: digest, childThreadId: reference,
  toolReceipt: z.object({ source: z.literal("codex_app.send_message_to_thread"),
    threadId: reference, accepted: z.literal(true) }).strict(),
}).strict();

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Continuation observation is unavailable.");
  return value as Record<string, unknown>;
}

function assertObservedInactiveFlags(value: Record<string, unknown>) {
  for (const key of ["activeTurnId", "activeTurn", "pendingTurn", "pendingApproval", "approvalRequired", "needsAttention", "error"]) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== false) throw new Error("Native continuation needs attention.");
  }
  for (const key of ["approvalRequests", "approvalRequestCount", "pendingApprovalCount"]) {
    if (value[key] !== undefined && value[key] !== 0) throw new Error("Native continuation approval state is not clear.");
  }
  for (const key of ["activeFlags", "attentionFlags", "pendingTurns", "pendingApprovals", "queuedMessages"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || (value[key] as unknown[]).length > 0)) {
      throw new Error("Native continuation has pending or active work.");
    }
  }
}

function assertTerminalNativeToolMarker(value: unknown, latestTurnId: unknown) {
  if (value === null) return;
  // A fresh supported poll retains this failed command marker even though the
  // native turn has completed. It is terminal tool evidence, not a live turn or
  // a classification of the provider failure. Other shapes remain unproved.
  const marker = z.object({
    id: z.string().regex(/^exec-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
    turnId: reference, type: z.literal("commandExecution"), name: z.literal("commandExecution"),
    status: z.literal("failed"),
  }).strict().parse(value);
  if (marker.turnId !== latestTurnId) throw new Error("Native command marker belongs to another turn.");
}

/** Project the supported compact poll, never a database RUNNING row. */
export function projectCourseSupportNativeCompletion(input: {
  snapshot: unknown; expectedThreadId: string; observedAt: string; now: Date;
}): CourseSupportNativeCompletion {
  const snapshot = object(input.snapshot);
  const thread = object(snapshot.thread);
  const status = object(thread.status);
  const latestTurn = object(snapshot.latestTurn);
  if (thread.id !== input.expectedThreadId || thread.hostId !== "local" ||
      !["idle", "notLoaded"].includes(status.type as string) || latestTurn.status !== "completed" ||
      latestTurn.error !== null || !reference.safeParse(latestTurn.id).success ||
      !reference.safeParse(snapshot.cursor).success ||
      !fresh(input.observedAt, input.now)) throw new Error("The supported native snapshot does not prove a completed original turn.");
  assertTerminalNativeToolMarker(snapshot.latestToolMarker, latestTurn.id);
  assertObservedInactiveFlags(snapshot);
  assertObservedInactiveFlags(thread);
  assertObservedInactiveFlags(status);
  assertObservedInactiveFlags(latestTurn);
  return courseSupportNativeCompletionSchema.parse({ version: 1, source: "codex_app.wait_threads",
    threadId: thread.id, observedAt: input.observedAt, cursor: snapshot.cursor, threadStatus: status.type,
    latestTurn: { id: latestTurn.id, status: "completed", error: null }, activeTurnId: null, approvalRequestCount: 0 });
}

function normalizedPrivateCheckout(value: unknown) {
  if (typeof value !== "string" || !win32.isAbsolute(value) || value.startsWith("\\\\") ||
      value.split(/[\\/]/u).includes("..")) throw new Error("Original managed checkout identity is unavailable.");
  const normalized = win32.normalize(value).replace(/[\\/]+$/u, "").toLowerCase();
  if (!/\\\.codex\\worktrees\\[^\\]+\\[^\\]+$/u.test(normalized)) {
    throw new Error("Continuation requires the original private managed checkout.");
  }
  return normalized;
}

const readyToolingSchema = z.object({
  source: z.literal("git"), state: z.literal("READY"), branch: z.literal("main"), commitSha: sha,
  deploymentId: reference, deploymentUrl: z.string().regex(/^https:\/\/[a-z0-9.-]+\.vercel\.app$/u),
  aliases: z.array(z.string().max(253)).max(10), deployedAt: instant,
});

/** All successful booleans are derived from actual receipts and observations. */
export function projectCourseSupportContinuationReadiness(input: {
  launcherReceiptBytes: string | Uint8Array;
  expectedThreadId: string;
  expectedCheckout: string;
  expectedBranch: string;
  expectedOriginalBaseSha: string;
  toolingDeploymentProof: unknown;
  processObservation: unknown;
  runtimeObservation: unknown;
  upstreamObservation: unknown;
  observedAt: string;
  now: Date;
}): CourseSupportContinuationReadiness {
  const bytes = typeof input.launcherReceiptBytes === "string" ? Buffer.from(input.launcherReceiptBytes, "utf8") : Buffer.from(input.launcherReceiptBytes);
  if (bytes.length < 2 || bytes.length > 32_768 || !fresh(input.observedAt, input.now)) throw new Error("Original launcher receipt is unavailable or stale.");
  const receipt = object(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")));
  const checkout = normalizedPrivateCheckout(input.expectedCheckout);
  const sandbox = object(receipt.sandbox);
  const profile = object(receipt.activePermissionProfile);
  if (receipt.status !== "COMPLETED" || receipt.threadId !== input.expectedThreadId ||
      receipt.nativeIdentityVerified !== true || receipt.approvalRequests !== 0 || receipt.approvalPolicy !== "never" ||
      sandbox.type !== "dangerFullAccess" || profile.id !== ":danger-full-access" ||
      receipt.turnStatus !== "completed" || normalizedPrivateCheckout(receipt.cwd) !== checkout ||
      receipt.branch !== input.expectedBranch || !/^automation\/course-support-[a-z0-9][a-z0-9-]*$/u.test(input.expectedBranch) ||
      receipt.baseSha !== input.expectedOriginalBaseSha || !sha.safeParse(input.expectedOriginalBaseSha).success) {
    throw new Error("Original native launcher identity or profile does not match.");
  }
  const processes = z.object({ observedAt: instant,
    processes: z.array(z.object({ pid: z.number().int().positive(), state: z.enum(["absent", "present", "unknown"]) }).strict()).min(2).max(4),
  }).strict().parse(input.processObservation);
  for (const pid of [receipt.launcherPid, receipt.serverPid]) {
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 ||
        processes.processes.filter(process => process.pid === pid).length !== 1 ||
        processes.processes.find(process => process.pid === pid)?.state !== "absent") {
      throw new Error("The original launcher and server have not both ended.");
    }
  }
  const runtime = object(input.runtimeObservation);
  const inspection = object(runtime.inspection);
  const guards = object(inspection.guards);
  const runtimeVersion = object(inspection.runtime);
  const client = object(inspection.client);
  const browser = object(inspection.browser);
  const smoke = object(runtime.browserSmoke);
  if (normalizedPrivateCheckout(runtime.checkout) !== checkout || !fresh(runtime.observedAt as string, input.now) ||
      !fresh(inspection.observedAt as string, input.now) || !fresh(processes.observedAt, input.now) ||
      !["ownCurrentCheckout", "nativeIdentityPresent", "linkedWorktree", "namedWorkerBranch", "clean",
        "selectedCheckoutDistinct", "sameRepository", "bindingMatches", "dependenciesPrivate"].every(key => guards[key] === true) ||
      runtimeVersion.status !== "available" || typeof runtimeVersion.nodeVersion !== "string" ||
      !/^v\d+\.\d+\.\d+$/u.test(runtimeVersion.nodeVersion) || typeof runtimeVersion.npmVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/u.test(runtimeVersion.npmVersion) || client.status !== "current" ||
      browser.moduleAvailable !== true || browser.executableAvailable !== true || smoke.status !== "current" ||
      !fresh(smoke.observedAt as string, input.now) || normalizedPrivateCheckout(smoke.checkout) !== checkout) {
    throw new Error("Original private runtime readiness is not proved.");
  }
  const tooling = readyToolingSchema.parse(input.toolingDeploymentProof);
  const upstream = z.object({ observedAt: instant, originalBaseSha: sha, originMainSha: sha,
    ancestorExitCode: z.literal(0) }).strict().parse(input.upstreamObservation);
  if (!fresh(upstream.observedAt, input.now) || upstream.originalBaseSha !== input.expectedOriginalBaseSha ||
      upstream.originMainSha !== tooling.commitSha || !["teetimespot.com", "www.teetimespot.com"].every(alias => tooling.aliases.includes(alias)) ||
      Date.parse(tooling.deployedAt) > input.now.getTime()) throw new Error("The exact reviewed Ready main tooling release is unavailable.");
  return courseSupportContinuationReadinessSchema.parse({ version: 1, source: "original_native_launcher_receipt",
    threadId: input.expectedThreadId, observedAt: input.observedAt,
    launcherReceiptDigest: createHash("sha256").update(bytes).digest("hex"), checkoutIdentityDigest: hash(checkout),
    privateOriginalChild: true, approvalPolicy: "never", sandboxMode: "danger-full-access",
    nativeIdentityVerified: true, noApprovalRequired: true, sameProfile: true, runtimeReady: true,
    toolingReleaseSha: tooling.commitSha });
}

export function buildCourseSupportContinuationRequest(input: Parameters<typeof projectCourseSupportContinuationReadiness>[0] & {
  nativeSnapshot: unknown; reviewedToolingDiagnosis: boolean;
}) {
  const readiness = projectCourseSupportContinuationReadiness(input);
  const nativeCompletion = projectCourseSupportNativeCompletion({ snapshot: input.nativeSnapshot,
    expectedThreadId: input.expectedThreadId, observedAt: input.observedAt, now: input.now });
  const tooling = readyToolingSchema.parse(input.toolingDeploymentProof);
  return courseSupportContinuationRequestSchema.parse({ policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION,
    readiness, nativeCompletion, ...(input.reviewedToolingDiagnosis ? { reviewedToolingRepair: {
      policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION, releaseSha: tooling.commitSha,
      source: tooling.source, state: tooling.state, branch: tooling.branch, aliases: tooling.aliases, deployedAt: tooling.deployedAt,
    } } : {}) });
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkpointDigest(checkpoint: CourseSupportContinuationCheckpoint) {
  // Re-reading a guide, refreshing readiness, or renewing a lease cannot create
  // a new attempt for the same settled failure.
  return hash({ kind: checkpoint.kind, observedAt: checkpoint.observedAt, readCount: checkpoint.readCount,
    requestId: checkpoint.requestId, failure: checkpoint.failure });
}

function completionDigest(receipt: CourseSupportNativeCompletion) {
  return hash({ threadId: receipt.threadId, turnId: receipt.latestTurn.id });
}

export function readCourseSupportContinuationLedger(value: unknown): CourseSupportContinuationLedger {
  return value === undefined ? { version: 1, receipts: [] } : ledgerSchema.parse(value);
}

function fresh(value: string, now: Date) {
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now.getTime() && at >= now.getTime() - RECEIPT_FRESHNESS_MS;
}

const retryableNetworkCodes = new Set([
  "PUBLIC_NETWORK_FAILED", "PUBLIC_READ_DEADLINE", "PUBLIC_READ_TIMEOUT", "PUBLIC_READ_ABORTED",
  "PUBLIC_FETCH_FAILED", "DNS_NOT_FOUND", "DNS_RETRYABLE", "CONNECTION_RESET", "CONNECTION_REFUSED",
  "CONNECTION_TIMEOUT", "BROWSER_DNS_FAILURE", "BROWSER_NETWORK_TIMEOUT", "BROWSER_CONNECTION_RESET",
  "BROWSER_CONNECTION_REFUSED", "BROWSER_CONNECTION_CLOSED", "BROWSER_OFFLINE",
]);

/** Read-only candidates still require fresh native and exact-release proof. */
export function isCourseSupportContinuationCandidateCheckpoint(checkpoint: CourseSupportContinuationCheckpoint) {
  if (checkpoint.providerReadInFlight || !Number.isInteger(checkpoint.readCount) || checkpoint.readCount < 1 || checkpoint.readCount > 6) return false;
  if (checkpoint.kind === "EXPIRED_UNFINISHED_READ") return checkpoint.failure === null && Boolean(checkpoint.requestId);
  const failure = checkpoint.failure;
  return failure?.stage === "PUBLIC_READ" && (
    failure.category === "NETWORK" && retryableNetworkCodes.has(failure.code) && checkpoint.readCount < 6 && checkpoint.allowedResearchRouteCount > 0 ||
    failure.category === "TOOLING" && ["REQUIRED_FILE_MISSING", "INVALID_TOOL_DATA"].includes(failure.code)
  );
}

/** Avoid repeated native/readiness work for a durably exhausted checkpoint. */
export function assessCourseSupportContinuationCandidate(input: {
  checkpoint: CourseSupportContinuationCheckpoint; ledger: unknown; sourceFingerprint: string;
}) {
  const ledger = readCourseSupportContinuationLedger(input.ledger);
  if (!digest.safeParse(input.sourceFingerprint).success || !isCourseSupportContinuationCandidateCheckpoint(input.checkpoint)) {
    return { candidate: false as const, reason: "FAILURE_REQUIRES_ATTENTION" };
  }
  if (ledger.receipts.some(receipt => receipt.status === "PENDING")) {
    return { candidate: false as const, reason: "PRIOR_SEND_UNCONFIRMED" };
  }
  if (ledger.receipts.length >= 8) return { candidate: false as const, reason: "CONTINUATION_HISTORY_BOUND_EXCEEDED" };
  const sourceReceipts = ledger.receipts.filter(receipt => receipt.sourceFingerprint === input.sourceFingerprint);
  if (sourceReceipts.some(receipt => receipt.checkpointDigest === checkpointDigest(input.checkpoint))) {
    return { candidate: false as const, reason: "CHECKPOINT_ALREADY_REQUESTED" };
  }
  const diagnostic = input.checkpoint.kind === "EXPIRED_UNFINISHED_READ" || input.checkpoint.failure?.category === "TOOLING";
  if (sourceReceipts.length >= COURSE_SUPPORT_CONTINUATION_MAX_ATTEMPTS || diagnostic &&
      sourceReceipts.some(receipt => receipt.scope === "DIAGNOSE_REVIEWED_TOOLING_UPDATE")) {
    return { candidate: false as const, reason: "CONTINUATION_BUDGET_EXHAUSTED" };
  }
  return { candidate: true as const };
}

export function assessCourseSupportContinuationCheckpoint(input: {
  checkpoint: CourseSupportContinuationCheckpoint;
  currentMainSha: string;
  reviewedToolingRepair?: CourseSupportReviewedToolingRepair;
  now: Date;
}): { eligible: true; scope: CourseSupportContinuationScope; checkpointDigest: string } |
  { eligible: false; reason: string } {
  const { checkpoint, reviewedToolingRepair: repair, now } = input;
  if (!Number.isFinite(now.getTime()) || !sha.safeParse(input.currentMainSha).success ||
      !Number.isInteger(checkpoint.readCount) || checkpoint.readCount < 1 || checkpoint.readCount > 6 ||
      !Number.isInteger(checkpoint.allowedResearchRouteCount) || checkpoint.allowedResearchRouteCount < 0 ||
      !Number.isFinite(Date.parse(checkpoint.observedAt)) || Date.parse(checkpoint.observedAt) > now.getTime()) {
    return { eligible: false, reason: "INVALID_CHECKPOINT" };
  }
  if (checkpoint.providerReadInFlight) return { eligible: false, reason: "PROVIDER_READ_STILL_ACTIVE" };
  const failure = checkpoint.failure;
  if (checkpoint.kind === "SETTLED_FAILURE" && failure?.stage === "PUBLIC_READ" &&
      failure.category === "NETWORK" && retryableNetworkCodes.has(failure.code) &&
      checkpoint.readCount < 6 && checkpoint.allowedResearchRouteCount > 0) {
    return { eligible: true, scope: "RESUME_ALLOWED_RESEARCH", checkpointDigest: checkpointDigest(checkpoint) };
  }
  // A lost pre-instrumentation exception is never labeled a network failure.
  // This one-time scope permits owner inspection, the reviewed tooling update,
  // and fresh recovery. The original worker may then make one untried,
  // server-selected diagnostic read through the unchanged public-source guards;
  // this does not repeat the failed route or turn UNKNOWN into a network fact.
  const knownTooling = checkpoint.kind === "SETTLED_FAILURE" && failure?.stage === "PUBLIC_READ" &&
    failure.category === "TOOLING" && ["REQUIRED_FILE_MISSING", "INVALID_TOOL_DATA"].includes(failure.code);
  const legacyUnfinished = checkpoint.kind === "EXPIRED_UNFINISHED_READ" && failure === null && Boolean(checkpoint.requestId);
  if ((knownTooling || legacyUnfinished) && repair?.policyVersion === COURSE_SUPPORT_CONTINUATION_POLICY_VERSION &&
      repair.releaseSha === input.currentMainSha && repair.source === "git" && repair.state === "READY" &&
      repair.branch === "main" && ["teetimespot.com", "www.teetimespot.com"].every(alias => repair.aliases.includes(alias)) &&
      Number.isFinite(Date.parse(repair.deployedAt)) && Date.parse(repair.deployedAt) <= now.getTime()) {
    return { eligible: true, scope: "DIAGNOSE_REVIEWED_TOOLING_UPDATE", checkpointDigest: checkpointDigest(checkpoint) };
  }
  return { eligible: false, reason: "FAILURE_REQUIRES_ATTENTION" };
}

export function reserveCourseSupportContinuationReceipt(input: {
  assignmentRef: string;
  childThreadId: string;
  parentThreadId: string;
  sourceFingerprint: string;
  currentMainSha: string;
  currentSource: boolean;
  originalPrivateChild: boolean;
  nativeCompletion: unknown;
  readiness: unknown;
  checkpoint: CourseSupportContinuationCheckpoint;
  ledger: unknown;
  tickAlreadyUsed: boolean;
  reviewedToolingRepair?: CourseSupportReviewedToolingRepair;
  now: Date;
}) {
  const ledger = readCourseSupportContinuationLedger(input.ledger);
  if (![input.assignmentRef, input.childThreadId, input.parentThreadId].every(value => reference.safeParse(value).success) ||
      input.childThreadId === input.parentThreadId || !digest.safeParse(input.sourceFingerprint).success ||
      !input.currentSource || !input.originalPrivateChild) return { reserved: false as const, reason: "ORIGINAL_SOURCE_OR_OWNER_NOT_CURRENT" };
  const native = courseSupportNativeCompletionSchema.safeParse(input.nativeCompletion);
  const readiness = courseSupportContinuationReadinessSchema.safeParse(input.readiness);
  if (!native.success || !readiness.success || native.data.threadId !== input.childThreadId ||
      readiness.data.threadId !== input.childThreadId || readiness.data.toolingReleaseSha !== input.currentMainSha ||
      !fresh(native.data.observedAt, input.now) || !fresh(readiness.data.observedAt, input.now)) {
    return { reserved: false as const, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" };
  }
  const assessment = assessCourseSupportContinuationCheckpoint(input);
  if (!assessment.eligible) return { reserved: false as const, reason: assessment.reason };
  const key = hash({ policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION, assignmentRef: input.assignmentRef,
    childThreadId: input.childThreadId, sourceFingerprint: input.sourceFingerprint, checkpointDigest: assessment.checkpointDigest });
  if (ledger.receipts.some(receipt => receipt.status === "PENDING")) {
    return { reserved: false as const, reason: "PRIOR_SEND_UNCONFIRMED" };
  }
  if (ledger.receipts.length >= 8) return { reserved: false as const, reason: "CONTINUATION_HISTORY_BOUND_EXCEEDED" };
  if (ledger.receipts.some(receipt => receipt.key === key || receipt.nativeCompletionDigest === completionDigest(native.data))) {
    return { reserved: false as const, reason: "CHECKPOINT_ALREADY_REQUESTED" };
  }
  const sourceReceipts = ledger.receipts.filter(receipt => receipt.sourceFingerprint === input.sourceFingerprint);
  if (sourceReceipts.length >= COURSE_SUPPORT_CONTINUATION_MAX_ATTEMPTS ||
      assessment.scope === "DIAGNOSE_REVIEWED_TOOLING_UPDATE" && sourceReceipts.some(receipt => receipt.scope === assessment.scope)) {
    return { reserved: false as const, reason: "CONTINUATION_BUDGET_EXHAUSTED" };
  }
  const tickRef = `continuation-${Math.floor(input.now.getTime() / COURSE_SUPPORT_CONTINUATION_TICK_MS)}`;
  if (input.tickAlreadyUsed || ledger.receipts.some(receipt => receipt.tickRef === tickRef)) {
    return { reserved: false as const, reason: "TICK_CONTINUATION_BUDGET_EXHAUSTED" };
  }
  const receipt: CourseSupportContinuationLedger["receipts"][number] = {
    version: 1, policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION, key,
    checkpointDigest: assessment.checkpointDigest, sourceFingerprint: input.sourceFingerprint,
    nativeCompletionDigest: completionDigest(native.data), readinessDigest: hash(readiness.data),
    parentThreadId: input.parentThreadId, childThreadId: input.childThreadId,
    attempt: sourceReceipts.length + 1, tickRef, requestedAt: input.now.toISOString(), scope: assessment.scope,
    status: "PENDING", sentAt: null,
  };
  return { reserved: true as const, receipt, ledger: { version: 1 as const, receipts: [...ledger.receipts, receipt] } };
}

/** Ambiguous tool failure leaves PENDING and cannot be automatically replayed. */
export function confirmCourseSupportContinuationSent(input: {
  ledger: unknown; key: string; parentThreadId: string; childThreadId: string;
  toolReceipt: unknown; now: Date;
}) {
  const ledger = readCourseSupportContinuationLedger(input.ledger);
  const sent = z.object({ source: z.literal("codex_app.send_message_to_thread"), threadId: reference,
    accepted: z.literal(true) }).strict().parse(input.toolReceipt);
  const receipt = ledger.receipts.find(entry => entry.key === input.key);
  if (!receipt || receipt.parentThreadId !== input.parentThreadId || receipt.childThreadId !== input.childThreadId ||
      sent.threadId !== input.childThreadId || Date.parse(receipt.requestedAt) > input.now.getTime()) {
    throw new Error("Continuation send receipt does not match the original native worker.");
  }
  if (receipt.status === "SENT") return ledger;
  return { version: 1 as const, receipts: ledger.receipts.map(entry => entry.key === input.key ?
    { ...entry, status: "SENT" as const, sentAt: input.now.toISOString() } : entry) };
}
