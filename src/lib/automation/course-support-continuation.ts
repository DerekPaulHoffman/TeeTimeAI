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

// Keep the original supported poll contract unchanged.
const waitThreadsNativeCompletionSchema = z.object({
  version: z.literal(1), source: z.literal("codex_app.wait_threads"),
  threadId: reference, observedAt: instant, cursor: reference,
  threadStatus: z.enum(["idle", "notLoaded", "completed"]),
  latestTurn: z.object({ id: reference, status: z.literal("completed"), error: z.null() }).strict(),
  activeTurnId: z.null(), approvalRequestCount: z.literal(0),
}).strict();
export const COURSE_SUPPORT_INVENTORY_COMPLETION_SOURCE = "codex_app.list_threads+codex_native.thread_turns_list";
const inventoryNativeCompletionSchema = z.object({
  version: z.literal(1), source: z.literal(COURSE_SUPPORT_INVENTORY_COMPLETION_SOURCE),
  threadId: reference, observedAt: instant, threadStatus: z.enum(["idle", "notLoaded"]),
  hostId: z.literal("local"), projectId: reference, inventoryUpdatedAt: z.number().int().nonnegative(),
  nativeUpdatedAt: z.number().int().nonnegative().optional(),
  nativeLatestTurnCompletedAt: z.number().int().nonnegative().optional(),
  completionTimestampSource: z.enum(["NATIVE_THREAD_METADATA", "NATIVE_LATEST_COMPLETED_TURN"]).optional(),
  launcherReceiptDigest: digest, checkoutIdentityDigest: digest, observationDigest: digest,
  latestTurn: z.object({ id: reference, status: z.literal("completed"), error: z.null() }).strict(),
}).strict();
const terminalInventoryNativeCompletionSchema = inventoryNativeCompletionSchema.extend({
  source: z.literal("codex_app.list_threads+codex_native.terminal_turn"),
  priorContinuationTurnId: reference.optional(), priorContinuationKey: digest.optional(),
  priorContinuationReceiptDigest: digest.optional(),
  latestTurn: z.object({ id: reference, status: z.enum(["completed", "failed", "interrupted"]),
    error: z.union([z.null(), z.object({ message: z.string().min(1) }).passthrough()]) }).strict(),
}).strict().refine(value => value.latestTurn.status !== "completed" || value.latestTurn.error === null);
export const courseSupportNativeCompletionSchema = z.discriminatedUnion("source", [
  waitThreadsNativeCompletionSchema, inventoryNativeCompletionSchema, terminalInventoryNativeCompletionSchema,
]);
export type CourseSupportNativeCompletion = z.infer<typeof courseSupportNativeCompletionSchema>;

const completedReadinessSchema = z.object({
  version: z.literal(1), source: z.literal("original_native_launcher_receipt"),
  threadId: reference, observedAt: instant, launcherReceiptDigest: digest,
  checkoutIdentityDigest: digest, privateOriginalChild: z.literal(true),
  approvalPolicy: z.literal("never"), sandboxMode: z.literal("danger-full-access"),
  nativeIdentityVerified: z.literal(true), noApprovalRequired: z.literal(true),
  sameProfile: z.literal(true), runtimeReady: z.literal(true), toolingReleaseSha: sha,
}).strict();
const stoppedReadinessSchema = completedReadinessSchema.extend({
  source: z.literal("original_native_stopped_launcher_receipt"), originalTurnId: reference,
  ownedStageDigest: digest,
}).strict();
export const courseSupportContinuationReadinessSchema = z.discriminatedUnion("source", [completedReadinessSchema, stoppedReadinessSchema]);
export type CourseSupportContinuationReadiness = z.infer<typeof courseSupportContinuationReadinessSchema>;

const scopeSchema = z.enum(["RESUME_ALLOWED_RESEARCH", "DIAGNOSE_REVIEWED_TOOLING_UPDATE", "RESUME_ORIGINAL_OWNED_STAGE"]);
export type CourseSupportContinuationScope = z.infer<typeof scopeSchema>;
const receiptSchema = z.object({
  version: z.literal(1), policyVersion: z.literal(COURSE_SUPPORT_CONTINUATION_POLICY_VERSION),
  key: digest, checkpointDigest: digest, sourceFingerprint: digest,
  nativeCompletionDigest: digest, readinessDigest: digest, parentThreadId: reference,
  childThreadId: reference, attempt: z.number().int().min(1).max(COURSE_SUPPORT_CONTINUATION_MAX_ATTEMPTS),
  tickRef: reference, requestedAt: instant, scope: scopeSchema,
  status: z.enum(["PENDING", "SENT"]), sentAt: instant.nullable(),
  nativeTurnId: reference.optional(), nativeReceiptPath: z.string().min(1).optional(),
}).strict().refine(receipt => (receipt.status === "SENT") === (receipt.sentAt !== null) &&
  Boolean(receipt.nativeTurnId) === Boolean(receipt.nativeReceiptPath) &&
  (receipt.status === "SENT" || !receipt.nativeTurnId));
const ledgerSchema = z.object({ version: z.literal(1), receipts: z.array(receiptSchema).max(8) }).strict()
  .refine(ledger => new Set(ledger.receipts.map(receipt => receipt.key)).size === ledger.receipts.length)
  .refine(ledger => ledger.receipts.every((receipt, index) => receipt.attempt ===
    ledger.receipts.slice(0, index + 1).filter(entry => entry.sourceFingerprint === receipt.sourceFingerprint).length));
export type CourseSupportContinuationLedger = z.infer<typeof ledgerSchema>;

export function latestConfirmedNativeContinuation(ledgerValue: unknown) {
  const receipts = readCourseSupportContinuationLedger(ledgerValue).receipts;
  const native = [...receipts].reverse().find(receipt => receipt.status === "SENT");
  return native?.nativeTurnId ? { turnId: native.nativeTurnId, key: native.key, receiptPath: native.nativeReceiptPath! } : null;
}

export type CourseSupportContinuationCheckpoint = {
  kind: "SETTLED_FAILURE" | "EXPIRED_UNFINISHED_READ" | "EXPIRED_SETTLED_PUBLIC_READ" | "EXPIRED_OWNED_STAGE";
  observedAt: string;
  readCount: number;
  requestId: string | null;
  failure: SimulatorSupportFailure | null;
  allowedResearchRouteCount: number;
  providerReadInFlight: boolean;
  claimLeaseExpired?: boolean;
  researchOnlyClaim?: boolean;
  ownedStage?: {
    phase: "IMPLEMENTING" | "VERIFYING"; claimedAt: string; plannedPaths: string[];
    releaseSha: string | null; deployment: unknown; recheckQueuedAt: string | null;
    verificationCycle: number; sourceFingerprint: string; originalSourceFingerprint: string;
    offeringRevision: number; branch: string;
  };
  publicReadEvidence?: { sourceFingerprint: string; accessControlsObserved: true; accessControls: Array<"CAPTCHA_OR_CHALLENGE" | "ACCOUNT_REQUIRED" | "QUEUE">;
    method: "HTTP" | "BROWSER"; renderComplete?: boolean; httpStatus: number };
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
  expectedClaim: z.object({ token: z.string().uuid(), revision: z.number().int().positive() }).strict().optional(),
  reviewedToolingRepair: z.object({
    policyVersion: z.literal(COURSE_SUPPORT_CONTINUATION_POLICY_VERSION), releaseSha: sha,
    source: z.literal("git"), state: z.literal("READY"), branch: z.literal("main"),
    aliases: z.array(z.string().max(253)).max(10), deployedAt: instant,
  }).strict().optional(),
}).strict();

export const courseSupportContinuationSentRequestSchema = z.object({
  continuationKey: digest, childThreadId: reference,
  toolReceipt: z.discriminatedUnion("source", [
    z.object({ source: z.literal("codex_app.send_message_to_thread"), threadId: reference, accepted: z.literal(true) }).strict(),
    z.object({ source: z.literal("codex_native.turn_start"), threadId: reference, turnId: reference,
      receiptPath: z.string().min(1), accepted: z.literal(true) }).strict(),
  ]),
}).strict();

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Continuation observation is unavailable.");
  return value as Record<string, unknown>;
}

function assertObservedInactiveFlags(value: Record<string, unknown>, terminalTurn = false) {
  for (const key of ["activeTurnId", "activeTurn", "pendingTurn", "pendingApproval", "approvalRequired", "needsAttention", "error"]) {
    if (terminalTurn && key === "error") continue;
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

const qualifiedObserverCliVersion = "codex-cli 0.160.1";
const qualifiedObserverExecutableDigest = "9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d";
const observedProcessesSchema = z.object({ observedAt: instant,
  processes: z.array(z.object({ pid: z.number().int().positive(), state: z.enum(["absent", "present", "unknown"]) }).strict()).min(2).max(4),
}).strict();
const nativeObserverSchema = z.object({
  version: z.literal(1), source: z.literal("original_codex_read_only_observer"),
  terminalFailure: z.literal(true).optional(),
  phase: z.literal("READ_ONLY_OBSERVATION_COMPLETE"), observedAt: instant, finishedAt: instant,
  threadId: reference, cliVersion: z.literal(qualifiedObserverCliVersion),
  cliExecutableDigest: z.literal(qualifiedObserverExecutableDigest),
  launcherReceiptDigestBefore: digest, launcherReceiptDigestAfter: digest,
  priorContinuationTurnId: reference.optional(), priorContinuationKey: digest.optional(),
  priorContinuationReceiptPath: z.string().min(1).optional(),
  priorContinuationReceiptDigestBefore: digest.optional(), priorContinuationReceiptDigestAfter: digest.optional(),
  observerApprovalRequestCount: z.literal(0),
  processObservationBefore: observedProcessesSchema, processObservationAfter: observedProcessesSchema,
  rpcCalls: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.unknown()), result: z.unknown() }).strict()).length(4),
}).strict();

function inventoryObservation(value: unknown, expectedThreadId: string) {
  const observation = object(value);
  const snapshot = object(observation.snapshot);
  if (observation.source !== "codex_app.list_threads" || !instant.safeParse(observation.observedAt).success ||
      observation.observedAtNote !== undefined || snapshot.observedAtNote !== undefined ||
      snapshot.schemaVersion !== 4 || !Array.isArray(snapshot.unavailableHosts) || snapshot.unavailableHosts.length !== 0 ||
      !Array.isArray(snapshot.unavailableSources) || snapshot.unavailableSources.length !== 0) {
    throw new Error("The supported app inventory observation is unavailable.");
  }
  // Only the complete supported inventory proves a unique original entry.
  // A selected entry cannot reveal missing or duplicate native identities.
  if (!Array.isArray(snapshot.pinnedThreads) || !Array.isArray(snapshot.threads) || snapshot.thread !== undefined) {
    throw new Error("The complete supported app inventory is required.");
  }
  const matches = [...snapshot.pinnedThreads, ...snapshot.threads]
    .map(object).filter(entry => entry.id === expectedThreadId);
  if (matches.length !== 1) throw new Error("Original app inventory identity is ambiguous.");
  const thread = matches[0];
  if (thread.id !== expectedThreadId || thread.kind !== "codex" || thread.hostId !== "local" ||
      !["idle", "notLoaded"].includes(thread.status as string) || !reference.safeParse(thread.projectId).success ||
      !Number.isSafeInteger(thread.updatedAt) || (thread.updatedAt as number) < 0) {
    throw new Error("The original app inventory does not prove an inactive worker.");
  }
  assertObservedInactiveFlags(snapshot);
  assertObservedInactiveFlags(thread);
  return { observedAt: observation.observedAt as string, snapshot, thread,
    checkout: normalizedPrivateCheckout(thread.cwd) };
}

/** App inventory supplies global status; the cold native server only supplies durable history. */
export function projectCourseSupportInventoryNativeCompletion(input: {
  inventoryBefore: unknown; inventoryAfter: unknown; nativeObservation: unknown;
  launcherReceiptBytes: string | Uint8Array; expectedThreadId: string; expectedCheckout: string;
  expectedProjectId: string; now: Date; terminalFailure?: boolean; expectedTerminalTurnId?: string;
  expectedNativeContinuation?: { turnId: string; key: string; receiptPath: string } | null;
}): z.infer<typeof inventoryNativeCompletionSchema> | z.infer<typeof terminalInventoryNativeCompletionSchema> {
  const before = inventoryObservation(input.inventoryBefore, input.expectedThreadId);
  const after = inventoryObservation(input.inventoryAfter, input.expectedThreadId);
  const native = nativeObserverSchema.parse(input.nativeObservation);
  const bytes = typeof input.launcherReceiptBytes === "string" ? Buffer.from(input.launcherReceiptBytes, "utf8") : Buffer.from(input.launcherReceiptBytes);
  const receipt = object(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")));
  const terminalFailure = input.terminalFailure === true;
  const prior = input.expectedNativeContinuation;
  const launcherReceiptDigest = createHash("sha256").update(bytes).digest("hex");
  const checkout = normalizedPrivateCheckout(input.expectedCheckout);
  const times = [before.observedAt, native.observedAt, native.finishedAt, after.observedAt];
  if (!reference.safeParse(input.expectedProjectId).success || native.threadId !== input.expectedThreadId ||
      (terminalFailure ? native.terminalFailure !== true ||
        !["STOPPED", "COMPLETED"].includes(receipt.status as string) ||
        (receipt.status === "COMPLETED" && receipt.turnStatus !== "completed") ||
        !reference.safeParse(receipt.turnId).success : native.terminalFailure !== undefined || receipt.status !== "COMPLETED") ||
      receipt.threadId !== input.expectedThreadId || receipt.cliVersion !== qualifiedObserverCliVersion ||
      normalizedPrivateCheckout(receipt.cwd) !== checkout || before.checkout !== checkout || after.checkout !== checkout ||
      before.thread.projectId !== input.expectedProjectId || after.thread.projectId !== input.expectedProjectId ||
      before.thread.updatedAt !== after.thread.updatedAt || before.thread.status !== after.thread.status ||
      native.launcherReceiptDigestBefore !== launcherReceiptDigest || native.launcherReceiptDigestAfter !== launcherReceiptDigest ||
      (prior ? native.priorContinuationTurnId !== prior.turnId || native.priorContinuationKey !== prior.key ||
        native.priorContinuationReceiptPath !== prior.receiptPath ||
        native.priorContinuationReceiptDigestBefore !== native.priorContinuationReceiptDigestAfter :
        native.priorContinuationTurnId !== undefined || native.priorContinuationKey !== undefined) ||
      !times.every(value => fresh(value, input.now)) || times.some((value, index) => index > 0 && Date.parse(value) < Date.parse(times[index - 1]))) {
    throw new Error("The original worker completion observations are stale, changed or unbracketed.");
  }
  for (const processes of [native.processObservationBefore, native.processObservationAfter]) {
    if (!fresh(processes.observedAt, input.now) || Date.parse(processes.observedAt) < Date.parse(native.observedAt) ||
        Date.parse(processes.observedAt) > Date.parse(native.finishedAt)) throw new Error("Original process observation is stale or outside the native read.");
    for (const pid of [receipt.launcherPid, receipt.serverPid]) {
      if (!Number.isSafeInteger(pid) || processes.processes.filter(process => process.pid === pid).length !== 1 ||
          processes.processes.find(process => process.pid === pid)?.state !== "absent") {
        throw new Error("The original launcher and server have not both ended.");
      }
    }
    if (prior && (processes.processes.length !== 4 ||
        processes.processes.slice(2).some(process => process.state !== "absent"))) {
      throw new Error("Prior native continuation processes have not ended.");
    }
  }
  const [initialize, profiles, read, turns] = native.rpcCalls;
  z.object({ method: z.literal("initialize"), params: z.object({
    clientInfo: z.object({ name: z.literal("course_support_worker_launcher"), version: z.literal("1.0") }).strict(),
    capabilities: z.object({ experimentalApi: z.literal(true) }).strict(),
  }).strict(), result: z.unknown() }).strict().parse(initialize);
  z.object({ method: z.literal("permissionProfile/list"), params: z.object({ cwd: z.string() }).strict(), result: z.unknown() }).strict().parse(profiles);
  z.object({ method: z.literal("thread/read"), params: z.object({ threadId: z.literal(input.expectedThreadId), includeTurns: z.literal(false) }).strict(), result: z.unknown() }).strict().parse(read);
  z.object({ method: z.literal("thread/turns/list"), params: z.object({ threadId: z.literal(input.expectedThreadId),
    limit: z.literal(1), itemsView: z.literal("notLoaded"), sortDirection: z.literal("desc") }).strict(), result: z.unknown() }).strict().parse(turns);
  if (normalizedPrivateCheckout(profiles.params.cwd) !== checkout ||
      !Array.isArray(object(profiles.result).data) || !(object(profiles.result).data as unknown[])
        .some(value => { const profile = object(value); return profile.id === ":danger-full-access" && profile.allowed === true; })) {
    throw new Error("The original full-access profile is unavailable.");
  }
  const nativeThread = object(object(read.result).thread);
  const nativeStatus = object(nativeThread.status);
  const page = object(turns.result);
  if (!Array.isArray(page.data) || page.data.length !== 1) throw new Error("The latest durable original turn is unavailable.");
  const latestTurn = object(page.data[0]);
  const metadataMatches = nativeThread.updatedAt === after.thread.updatedAt;
  // Pinned initial turns can retain creation-time thread metadata while the app
  // inventory advances to the durable turn completion time. Match that actual
  // completed turn explicitly; never approximate or rewrite either timestamp.
  const turnTimestampMatches = Number.isSafeInteger(nativeThread.updatedAt) && (nativeThread.updatedAt as number) >= 0 &&
    Number.isSafeInteger(latestTurn.startedAt) && Number.isSafeInteger(latestTurn.completedAt) &&
    (nativeThread.updatedAt as number) <= (latestTurn.startedAt as number) &&
    (latestTurn.startedAt as number) <= (latestTurn.completedAt as number) &&
    (latestTurn.completedAt as number) <= Math.floor(input.now.getTime() / 1000) &&
    latestTurn.completedAt === after.thread.updatedAt;
  if (nativeThread.id !== input.expectedThreadId || normalizedPrivateCheckout(nativeThread.cwd) !== checkout ||
      !(metadataMatches || turnTimestampMatches) || nativeThread.cliVersion !== "0.160.1" || nativeThread.ephemeral !== false ||
      !["idle", "notLoaded"].includes(nativeStatus.type as string) || (terminalFailure ?
        !["failed", "interrupted", "completed"].includes(latestTurn.status as string) ||
        latestTurn.id !== (input.expectedTerminalTurnId ?? receipt.turnId) ||
        (!prior && latestTurn.status !== "completed" && receipt.status !== "STOPPED") ||
        (latestTurn.status === "completed" ? latestTurn.error !== null :
          latestTurn.error !== undefined && latestTurn.error !== null &&
          (typeof latestTurn.error !== "object" || typeof object(latestTurn.error).message !== "string")) :
        latestTurn.status !== "completed" || latestTurn.error !== null) ||
      latestTurn.itemsView !== "notLoaded" || !Array.isArray(latestTurn.items) || latestTurn.items.length !== 0 ||
      !reference.safeParse(latestTurn.id).success) throw new Error("The native read does not prove the latest completed original turn.");
  for (const value of [object(read.result), nativeThread, nativeStatus, page]) assertObservedInactiveFlags(value);
  assertObservedInactiveFlags(latestTurn, terminalFailure);
  const projected = { version: 1, source: terminalFailure ? "codex_app.list_threads+codex_native.terminal_turn" : COURSE_SUPPORT_INVENTORY_COMPLETION_SOURCE,
    threadId: input.expectedThreadId, observedAt: after.observedAt, threadStatus: after.thread.status,
    hostId: after.thread.hostId, projectId: after.thread.projectId, inventoryUpdatedAt: after.thread.updatedAt,
    nativeUpdatedAt: nativeThread.updatedAt,
    ...(Number.isSafeInteger(latestTurn.completedAt) && (latestTurn.completedAt as number) >= 0 ? { nativeLatestTurnCompletedAt: latestTurn.completedAt } : {}),
    completionTimestampSource: metadataMatches ? "NATIVE_THREAD_METADATA" : "NATIVE_LATEST_COMPLETED_TURN",
    launcherReceiptDigest, checkoutIdentityDigest: hash(checkout),
    ...(prior ? { priorContinuationTurnId: prior.turnId, priorContinuationKey: prior.key,
      priorContinuationReceiptDigest: native.priorContinuationReceiptDigestBefore } : {}),
    observationDigest: hash({ before: input.inventoryBefore, native: input.nativeObservation, after: input.inventoryAfter }),
    latestTurn: terminalFailure ? { id: latestTurn.id, status: latestTurn.status, error: latestTurn.error ?? null } :
      { id: latestTurn.id, status: "completed", error: null } };
  return terminalFailure ? terminalInventoryNativeCompletionSchema.parse(projected) : inventoryNativeCompletionSchema.parse(projected);
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
  stoppedStage?: CourseSupportContinuationCheckpoint;
  changedPaths?: string[];
  expectedTerminalTurnId?: string;
  expectedNativeContinuation?: { turnId: string; key: string; receiptPath: string } | null;
}): CourseSupportContinuationReadiness {
  const bytes = typeof input.launcherReceiptBytes === "string" ? Buffer.from(input.launcherReceiptBytes, "utf8") : Buffer.from(input.launcherReceiptBytes);
  if (bytes.length < 2 || bytes.length > 32_768 || !fresh(input.observedAt, input.now)) throw new Error("Original launcher receipt is unavailable or stale.");
  const receipt = object(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")));
  const checkout = normalizedPrivateCheckout(input.expectedCheckout);
  const stage = input.stoppedStage;
  const stopped = stage?.kind === "EXPIRED_OWNED_STAGE" && stage.ownedStage !== undefined;
  if (stage && !stopped) throw new Error("Stopped readiness requires the original owned stage.");
  if (stopped) {
    const planned = stage.ownedStage!.plannedPaths;
    const changed = input.changedPaths;
    if (!Array.isArray(changed) || changed.some(path => typeof path !== "string" || !path || path.includes("\\") ||
        path.startsWith("/") || path.split("/").includes("..") || !planned.includes(path))) {
      throw new Error("Original dirty checkout has unregistered or post-release changes.");
    }
  }
  const sandbox = object(receipt.sandbox);
  const profile = object(receipt.activePermissionProfile);
  if ((stopped ? !["STOPPED", "COMPLETED"].includes(receipt.status as string) ||
      (receipt.status === "COMPLETED" && receipt.turnStatus !== "completed") || !reference.safeParse(receipt.turnId).success :
      receipt.status !== "COMPLETED" || receipt.turnStatus !== "completed") || receipt.threadId !== input.expectedThreadId ||
      receipt.nativeIdentityVerified !== true || receipt.approvalRequests !== 0 || receipt.approvalPolicy !== "never" ||
      sandbox.type !== "dangerFullAccess" || profile.id !== ":danger-full-access" ||
      normalizedPrivateCheckout(receipt.cwd) !== checkout ||
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
      !["ownCurrentCheckout", ...(stopped ? [] : ["nativeIdentityPresent"]), "linkedWorktree", "namedWorkerBranch", ...(stopped ? [] : ["clean"]),
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
  return courseSupportContinuationReadinessSchema.parse({ version: 1, source: stopped ? "original_native_stopped_launcher_receipt" : "original_native_launcher_receipt",
    threadId: input.expectedThreadId, observedAt: input.observedAt,
    launcherReceiptDigest: createHash("sha256").update(bytes).digest("hex"), checkoutIdentityDigest: hash(checkout),
    privateOriginalChild: true, approvalPolicy: "never", sandboxMode: "danger-full-access",
    nativeIdentityVerified: true, noApprovalRequired: true, sameProfile: true, runtimeReady: true,
    ...(stopped ? { originalTurnId: receipt.turnId, ownedStageDigest: checkpointDigest(stage) } : {}),
    toolingReleaseSha: tooling.commitSha });
}

export function buildCourseSupportContinuationRequest(input: Parameters<typeof projectCourseSupportContinuationReadiness>[0] & {
  reviewedToolingDiagnosis: boolean;
  expectedClaim?: { token: string; revision: number };
} & ({ nativeSnapshot: unknown; nativeInventoryObservation?: never } | { nativeSnapshot?: never;
  nativeInventoryObservation: { inventoryBefore: unknown; inventoryAfter: unknown; nativeObservation: unknown; expectedProjectId: string };
})) {
  if (("nativeSnapshot" in input) === ("nativeInventoryObservation" in input)) throw new Error("Supply exactly one native completion source.");
  const readiness = projectCourseSupportContinuationReadiness(input);
  const inventory = input.nativeInventoryObservation;
  const nativeCompletion = inventory ? projectCourseSupportInventoryNativeCompletion({ ...inventory,
    launcherReceiptBytes: input.launcherReceiptBytes, expectedThreadId: input.expectedThreadId,
    expectedCheckout: input.expectedCheckout, now: input.now, terminalFailure: input.stoppedStage?.kind === "EXPIRED_OWNED_STAGE",
    expectedTerminalTurnId: input.expectedTerminalTurnId,
    expectedNativeContinuation: input.expectedNativeContinuation }) : projectCourseSupportNativeCompletion({ snapshot: input.nativeSnapshot,
      expectedThreadId: input.expectedThreadId, observedAt: input.observedAt, now: input.now });
  const tooling = readyToolingSchema.parse(input.toolingDeploymentProof);
  return courseSupportContinuationRequestSchema.parse({ policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION,
    readiness, nativeCompletion, ...(input.expectedClaim ? { expectedClaim: input.expectedClaim } : {}),
    ...(input.reviewedToolingDiagnosis ? { reviewedToolingRepair: {
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
    requestId: checkpoint.requestId, failure: checkpoint.failure,
    ...(checkpoint.ownedStage ? { ownedStage: checkpoint.ownedStage } : {}),
    ...(checkpoint.publicReadEvidence ? { publicReadEvidence: checkpoint.publicReadEvidence } : {}) });
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

function hasSettledPublicEvidence(checkpoint: CourseSupportContinuationCheckpoint) {
  const proof = checkpoint.publicReadEvidence;
  return checkpoint.failure === null && Boolean(checkpoint.requestId && z.string().uuid().safeParse(checkpoint.requestId).success) &&
    checkpoint.readCount < 6 && checkpoint.allowedResearchRouteCount > 0 && Boolean(proof &&
      digest.safeParse(proof.sourceFingerprint).success && proof.accessControlsObserved === true && Array.isArray(proof.accessControls) && proof.accessControls.length === 0 &&
      Number.isInteger(proof.httpStatus) && proof.httpStatus >= 200 && proof.httpStatus < 300 &&
      (proof.method === "HTTP" || proof.method === "BROWSER" && proof.renderComplete === true));
}

function hasRejectedStylesheetCheckpoint(checkpoint: CourseSupportContinuationCheckpoint) {
  const failure = checkpoint.failure;
  return checkpoint.kind === "SETTLED_FAILURE" && checkpoint.claimLeaseExpired === true && checkpoint.researchOnlyClaim === true &&
    Boolean(checkpoint.requestId && z.string().uuid().safeParse(checkpoint.requestId).success) &&
    checkpoint.readCount < 6 && checkpoint.allowedResearchRouteCount > 0 &&
    failure?.stage === "PUBLIC_READ" && failure.category === "ACCESS" && failure.code === "UNSAFE_PUBLIC_URL" &&
    failure.researchResourceKind === "SECONDARY_STYLESHEET";
}

function hasTransportCappedScriptCheckpoint(checkpoint: CourseSupportContinuationCheckpoint) {
  const failure = checkpoint.failure;
  return checkpoint.kind === "SETTLED_FAILURE" && checkpoint.claimLeaseExpired === true && checkpoint.researchOnlyClaim === true &&
    Boolean(checkpoint.requestId && z.string().uuid().safeParse(checkpoint.requestId).success) &&
    checkpoint.readCount < 6 && checkpoint.allowedResearchRouteCount > 0 &&
    failure?.stage === "PUBLIC_READ" && failure.category === "BUDGET" && failure.code === "PUBLIC_BODY_LIMIT" &&
    failure.researchPhase === "HTTP_READ" && failure.researchResourceKind === "SECONDARY_SCRIPT" &&
    // This is the recorded historical transport constructor, not an inferred
    // aggregate limit or a default for legacy failures with missing provenance.
    failure.sourceLocation === "src/lib/automation/address-pinned-public-fetch.ts:49";
}

function hasReviewedSecondaryCheckpoint(checkpoint: CourseSupportContinuationCheckpoint) {
  return hasRejectedStylesheetCheckpoint(checkpoint) || hasTransportCappedScriptCheckpoint(checkpoint);
}

/** Read-only candidates still require fresh native and exact-release proof. */
export function isCourseSupportContinuationCandidateCheckpoint(checkpoint: CourseSupportContinuationCheckpoint) {
  if (checkpoint.kind === "EXPIRED_OWNED_STAGE") return checkpoint.providerReadInFlight === false &&
    checkpoint.claimLeaseExpired === true && checkpoint.ownedStage !== undefined &&
    ["IMPLEMENTING", "VERIFYING"].includes(checkpoint.ownedStage.phase) &&
    (checkpoint.ownedStage.plannedPaths.length > 0 || checkpoint.ownedStage.releaseSha !== null);
  if (checkpoint.providerReadInFlight || !Number.isInteger(checkpoint.readCount) || checkpoint.readCount < 1 || checkpoint.readCount > 6) return false;
  if (checkpoint.kind === "EXPIRED_UNFINISHED_READ") return checkpoint.failure === null && Boolean(checkpoint.requestId);
  if (checkpoint.kind === "EXPIRED_SETTLED_PUBLIC_READ") return hasSettledPublicEvidence(checkpoint);
  const failure = checkpoint.failure;
  return failure?.stage === "PUBLIC_READ" && (
    failure.category === "NETWORK" && retryableNetworkCodes.has(failure.code) && checkpoint.readCount < 6 && checkpoint.allowedResearchRouteCount > 0 ||
    failure.category === "TOOLING" && ["REQUIRED_FILE_MISSING", "INVALID_TOOL_DATA"].includes(failure.code) ||
    hasReviewedSecondaryCheckpoint(checkpoint)
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
  if (input.checkpoint.kind === "EXPIRED_OWNED_STAGE" &&
      ledger.receipts.some(receipt => receipt.status === "SENT") && !latestConfirmedNativeContinuation(ledger)) {
    return { candidate: false as const, reason: "ORIGINAL_NATIVE_TURN_LINEAGE_UNPROVED" };
  }
  if (ledger.receipts.length >= 8) return { candidate: false as const, reason: "CONTINUATION_HISTORY_BOUND_EXCEEDED" };
  const sourceReceipts = ledger.receipts.filter(receipt => receipt.sourceFingerprint === input.sourceFingerprint);
  if (sourceReceipts.some(receipt => receipt.checkpointDigest === checkpointDigest(input.checkpoint)) &&
      !(input.checkpoint.kind === "EXPIRED_OWNED_STAGE" && latestConfirmedNativeContinuation(ledger))) {
    return { candidate: false as const, reason: "CHECKPOINT_ALREADY_REQUESTED" };
  }
  const diagnostic = input.checkpoint.kind === "EXPIRED_UNFINISHED_READ" || input.checkpoint.failure?.category === "TOOLING" ||
    hasReviewedSecondaryCheckpoint(input.checkpoint);
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
      (checkpoint.kind !== "EXPIRED_OWNED_STAGE" && (!Number.isInteger(checkpoint.readCount) || checkpoint.readCount < 1 || checkpoint.readCount > 6 ||
      !Number.isInteger(checkpoint.allowedResearchRouteCount) || checkpoint.allowedResearchRouteCount < 0)) ||
      !Number.isFinite(Date.parse(checkpoint.observedAt)) || Date.parse(checkpoint.observedAt) > now.getTime()) {
    return { eligible: false, reason: "INVALID_CHECKPOINT" };
  }
  if (checkpoint.providerReadInFlight) return { eligible: false, reason: "PROVIDER_READ_STILL_ACTIVE" };
  if (checkpoint.kind === "EXPIRED_OWNED_STAGE") {
    if (!isCourseSupportContinuationCandidateCheckpoint(checkpoint)) return { eligible: false, reason: "ORIGINAL_OWNED_STAGE_NOT_CURRENT" };
    return { eligible: true, scope: "RESUME_ORIGINAL_OWNED_STAGE", checkpointDigest: checkpointDigest(checkpoint) };
  }
  const failure = checkpoint.failure;
  if (checkpoint.kind === "EXPIRED_SETTLED_PUBLIC_READ" && hasSettledPublicEvidence(checkpoint) &&
      Date.parse(checkpoint.observedAt) >= now.getTime() - 30 * 60_000) {
    return { eligible: true, scope: "RESUME_ALLOWED_RESEARCH", checkpointDigest: checkpointDigest(checkpoint) };
  }
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
  // A stylesheet rejection or the recorded transport script cap is not evidence
  // that the calendar requires access. A later reviewed repair may permit one
  // different server-selected route while retaining the hard failure and limits.
  const reviewedSecondary = hasReviewedSecondaryCheckpoint(checkpoint);
  if ((knownTooling || legacyUnfinished || reviewedSecondary) && repair?.policyVersion === COURSE_SUPPORT_CONTINUATION_POLICY_VERSION &&
      repair.releaseSha === input.currentMainSha && repair.source === "git" && repair.state === "READY" &&
      repair.branch === "main" && ["teetimespot.com", "www.teetimespot.com"].every(alias => repair.aliases.includes(alias)) &&
      Number.isFinite(Date.parse(repair.deployedAt)) && Date.parse(repair.deployedAt) <= now.getTime() &&
      (!reviewedSecondary || Date.parse(repair.deployedAt) > Date.parse(checkpoint.observedAt))) {
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
  if (input.checkpoint.kind === "EXPIRED_OWNED_STAGE" &&
      ledger.receipts.some(receipt => receipt.status === "SENT") && !latestConfirmedNativeContinuation(ledger)) {
    return { reserved: false as const, reason: "ORIGINAL_NATIVE_TURN_LINEAGE_UNPROVED" };
  }
  if (![input.assignmentRef, input.childThreadId, input.parentThreadId].every(value => reference.safeParse(value).success) ||
      input.childThreadId === input.parentThreadId || !digest.safeParse(input.sourceFingerprint).success ||
      !input.currentSource || !input.originalPrivateChild ||
      input.checkpoint.kind === "EXPIRED_OWNED_STAGE" && input.checkpoint.ownedStage?.sourceFingerprint !== input.sourceFingerprint ||
      input.checkpoint.kind === "EXPIRED_SETTLED_PUBLIC_READ" && input.checkpoint.publicReadEvidence?.sourceFingerprint !== input.sourceFingerprint) return { reserved: false as const, reason: "ORIGINAL_SOURCE_OR_OWNER_NOT_CURRENT" };
  const native = courseSupportNativeCompletionSchema.safeParse(input.nativeCompletion);
  const readiness = courseSupportContinuationReadinessSchema.safeParse(input.readiness);
  if (!native.success || !readiness.success || native.data.threadId !== input.childThreadId ||
      readiness.data.threadId !== input.childThreadId || readiness.data.toolingReleaseSha !== input.currentMainSha ||
      !fresh(native.data.observedAt, input.now) || !fresh(readiness.data.observedAt, input.now)) {
    return { reserved: false as const, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" };
  }
  if (input.checkpoint.kind === "EXPIRED_OWNED_STAGE" ?
      native.data.source !== "codex_app.list_threads+codex_native.terminal_turn" ||
      readiness.data.source !== "original_native_stopped_launcher_receipt" ||
      native.data.latestTurn.id !== (latestConfirmedNativeContinuation(ledger)?.turnId ?? readiness.data.originalTurnId) ||
      (latestConfirmedNativeContinuation(ledger) ?
        native.data.priorContinuationKey !== latestConfirmedNativeContinuation(ledger)?.key ||
        native.data.priorContinuationTurnId !== latestConfirmedNativeContinuation(ledger)?.turnId ||
        !native.data.priorContinuationReceiptDigest :
        native.data.priorContinuationTurnId !== undefined) ||
      readiness.data.ownedStageDigest !== checkpointDigest(input.checkpoint) :
      native.data.latestTurn.status !== "completed" || readiness.data.source !== "original_native_launcher_receipt") {
    return { reserved: false as const, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" };
  }
  if (native.data.source !== "codex_app.wait_threads" &&
      (native.data.launcherReceiptDigest !== readiness.data.launcherReceiptDigest ||
       native.data.checkoutIdentityDigest !== readiness.data.checkoutIdentityDigest)) {
    return { reserved: false as const, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" };
  }
  const assessment = assessCourseSupportContinuationCheckpoint(input);
  if (!assessment.eligible) return { reserved: false as const, reason: assessment.reason };
  const key = hash({ policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION, assignmentRef: input.assignmentRef,
    childThreadId: input.childThreadId, sourceFingerprint: input.sourceFingerprint, checkpointDigest: assessment.checkpointDigest,
    ...(input.checkpoint.kind === "EXPIRED_OWNED_STAGE" ? { terminalTurnId: native.data.latestTurn.id } : {}) });
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
  const sent = courseSupportContinuationSentRequestSchema.shape.toolReceipt.parse(input.toolReceipt);
  const receipt = ledger.receipts.find(entry => entry.key === input.key);
  if (!receipt || receipt.parentThreadId !== input.parentThreadId || receipt.childThreadId !== input.childThreadId ||
      sent.threadId !== input.childThreadId || Date.parse(receipt.requestedAt) > input.now.getTime()) {
    throw new Error("Continuation send receipt does not match the original native worker.");
  }
  if (receipt.status === "SENT") return ledger;
  return { version: 1 as const, receipts: ledger.receipts.map(entry => entry.key === input.key ?
    { ...entry, status: "SENT" as const, sentAt: input.now.toISOString(),
      ...(sent.source === "codex_native.turn_start" ? { nativeTurnId: sent.turnId, nativeReceiptPath: sent.receiptPath } : {}) } : entry) };
}
