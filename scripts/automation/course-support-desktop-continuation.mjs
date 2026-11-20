import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { approvedCourseSupportResponderCheckouts } from "./course-support-preflight.mjs";
import { inspectPinnedWorkerCli } from "./course-support-worker-cli.mjs";
import { assertFullAccessAcknowledgement, buildWorkerFirstTurnPrompt, createWorkerAppServer, privateWrite } from "./course-support-worker-launcher.mjs";
import { resolveCourseSupportWorkerRuntime } from "./course-support-worker-runtime.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const SHA = /^[a-f0-9]{40}$/u;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => typeof a === "string" && typeof b === "string" &&
  (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const git = (cwd, args) => {
  const value = execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true,
    timeout: 40000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return args[0] === "diff" ? value : value.trim();
};
const validPaths = paths => Array.isArray(paths) && paths.length > 0 && paths.length <= 32 &&
  paths.every(path => typeof path === "string" && path && path.length <= 300 &&
    !/[\\\x00-\x1f:]/u.test(path) && !path.startsWith("/") && !path.split("/").some(part => !part || part === "." || part === ".."));
const readJson = file => { if (!isAbsolute(file)) fail("ABSOLUTE_PRIVATE_INPUT_REQUIRED"); return JSON.parse(readFileSync(file, "utf8")); };

/** Observe the actual canonical aliases once. No waiter loop, environment
 * loading, promotion, provider read or continuation intent is performed. */
export function readDesktopContinuationProduction({ selected, nodePath, currentSha }, execute = execFileSync) {
  const aliases = ["teetimespot.com", "www.teetimespot.com"];
  const deployments = aliases.map(alias => JSON.parse(execute(nodePath, [join(selected, "node_modules", "vercel", "dist", "vc.js"),
    "api", `/v13/deployments/${alias}`, "--method", "GET", "--scope", "derekpaulhoffmans-projects"], {
    cwd: selected, encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 1000000, stdio: ["ignore", "pipe", "pipe"],
  })));
  if (deployments.some(d => d.projectId !== "prj_dI6LhLrDCSq06xgvtNvaKtF6Uz7Y" || d.source !== "git" || d.readyState !== "READY" ||
      d.gitSource?.type !== "github" || d.gitSource.repoId !== 978781158 || d.gitSource.ref !== "main" || d.gitSource.sha !== currentSha ||
      !/^dpl_[A-Za-z0-9]+$/u.test(d.id ?? "")) || deployments[0].id !== deployments[1].id ||
      !deployments[0].url || deployments[0].url !== deployments[1].url) return null;
  return { source: "git", state: "READY", branch: "main", commitSha: currentSha, deploymentId: deployments[0].id, aliases };
}

function readFailedLearningProgress(item, now) {
  const progress = item.failedLearningProgress;
  if (progress === undefined) return null;
  if (!progress || typeof progress !== "object" || Array.isArray(progress) ||
      Object.keys(progress).sort().join(",") !== "completedAt,fingerprint,jobId,version" || progress.version !== 1 ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(progress.jobId ?? "") || typeof progress.completedAt !== "string" ||
      !Number.isFinite(Date.parse(progress.completedAt)) || new Date(progress.completedAt).toISOString() !== progress.completedAt ||
      Date.parse(progress.completedAt) > now || item.continuationMode !== "PUBLISHED_IMPLEMENTATION" ||
      item.continuationTrigger !== "UNFINISHED_FULL_REPAIR" ||
      progress.fingerprint !== createHash("sha256").update([progress.jobId, progress.completedAt, item.batchReference, item.releaseSha].join("\0")).digest("hex")) {
    fail("CURRENT_FAILED_LEARNING_PROGRESS_REQUIRED");
  }
  return progress;
}

function inactive(thread) {
  return ["idle", "notLoaded"].includes(thread?.status?.type) &&
    !thread.activeTurnId && !thread.activeTurn && !thread.pendingTurn && !thread.pendingApproval && !thread.needsAttention && !thread.error &&
    !thread.queuedMessages?.length && !thread.status.activeFlags?.length &&
    !thread.status.activeTurnId && !thread.status.activeTurn && !thread.status.pendingApproval && !thread.status.needsAttention;
}

/** Read-only execution observation plus a local one-use send marker. No claim,
 * lease, batch result, job clock, model turn or legacy CLI receipt is changed. */
export async function prepareOwnedDesktopContinuation({ context, item }, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const now = (dependencies.now ?? Date.now)();
  if (!Number.isFinite(now)) fail("CURRENT_CONTINUATION_CLOCK_REQUIRED");
  if (!UUID.test(environment.CODEX_THREAD_ID ?? "")) fail("NATIVE_PARENT_ID_REQUIRED");
  if (context?.kind !== "course_support_preflight_context" || context.exactHead !== true || !isAbsolute(context.selectedCheckout ?? "")) fail("CURRENT_PREFLIGHT_REQUIRED");
  const selected = realpathSync(context.selectedCheckout);
  if (!(dependencies.approvedCheckouts ?? approvedCourseSupportResponderCheckouts).some(path => same(path, selected))) fail("UNAPPROVED_SELECTED_CHECKOUT");
  const execute = dependencies.git ?? git;
  const currentSha = execute(selected, ["rev-parse", "HEAD"]);
  if (!SHA.test(currentSha) || currentSha !== execute(selected, ["rev-parse", "origin/main"]) || execute(selected, ["status", "--porcelain"])) fail("SELECTED_CHECKOUT_CHANGED");
  const simulatorWait = item?.mode === "SIMULATOR";
  if (simulatorWait && (item.checkpoint?.kind !== "EXPIRED_OWNED_STAGE" ||
      item.checkpoint.ownedStage?.phase !== "WAITING_IMPLEMENTATION" ||
      item.checkpoint.claimLeaseExpired !== true || item.checkpoint.providerReadInFlight !== false ||
      item.checkpoint.ownedStage.sourceFingerprint !== item.sourceFingerprint ||
      item.checkpoint.ownedStage.branch !== item.branch ||
      !Number.isSafeInteger(item.claimRevision) || item.claimRevision < 1 ||
      !UUID.test(item.claimToken ?? "") || !/^[a-f0-9]{64}$/u.test(item.sourceFingerprint ?? "") ||
      !Array.isArray(item.plannedPaths) || item.plannedPaths.length || item.releaseSha !== null ||
      item.expectedNativeContinuation !== null || item.continuationMode !== undefined ||
      item.expiredDemandRecoveryOnly !== undefined || item.failedLearningProgress !== undefined ||
      !Number.isFinite(Date.parse(item.checkpoint.ownedStage.leaseExpiresAt ?? "")) ||
      Date.parse(item.checkpoint.ownedStage.leaseExpiresAt) > now)) fail("DESKTOP_SIMULATOR_WAIT_REQUIRED");
  const publishedImplementation = item?.continuationMode === "PUBLISHED_IMPLEMENTATION";
  const claimedImplementation = item?.continuationMode === "CLAIMED_IMPLEMENTATION";
  const registeredImplementation = item?.continuationMode === "REGISTERED_IMPLEMENTATION";
  const sourceReconciliationOnly = item?.sourceReconciliationOnly === true;
  const expiredDemandRecoveryOnly = item?.expiredDemandRecoveryOnly === true;
  if (item?.expiredDemandRecoveryOnly !== undefined &&
      (!expiredDemandRecoveryOnly || !registeredImplementation || sourceReconciliationOnly || item.failedLearningProgress !== undefined)) {
    fail("EXPIRED_COURSE_DEMAND_PROOF_REQUIRED");
  }
  if (item?.sourceReconciliationOnly !== undefined &&
      (!sourceReconciliationOnly || item.continuationMode !== "DATA_ONLY" || item.continuationTrigger !== "UNFINISHED_FULL_REPAIR")) {
    fail("DATA_ONLY_SOURCE_RECONCILIATION_REQUIRED");
  }
  if (![undefined, "DATA_ONLY", "PUBLISHED_IMPLEMENTATION", "CLAIMED_IMPLEMENTATION", "REGISTERED_IMPLEMENTATION"].includes(item?.continuationMode)) fail("ORIGINAL_FULL_REPAIR_ITEM_REQUIRED");
  if ((claimedImplementation || registeredImplementation) && (item.continuationTrigger !== "UNFINISHED_FULL_REPAIR" || !validPaths(item.plannedPaths))) fail("ORIGINAL_CLAIMED_PATHS_REQUIRED");
  if (![undefined, "UNFINISHED_FULL_REPAIR"].includes(item?.continuationTrigger)) fail("ORIGINAL_FULL_REPAIR_ITEM_REQUIRED");
  if ((!simulatorWait && item?.kind !== "OWNED_OUTDOOR_FULL_REPAIR") || !UUID.test(item.threadId ?? "") || item.threadId === environment.CODEX_THREAD_ID ||
      !/^course-assignment-[a-f0-9-]{36}$/u.test(item.assignmentRef ?? "") ||
      !SHA.test(item.baseSha ?? "") ||
      (!simulatorWait && (!/^[A-Za-z0-9_-]{1,200}$/u.test(item.batchReference ?? "") || !SHA.test(item.releaseSha ?? "") ||
        (publishedImplementation || registeredImplementation ? item.releaseSha === item.baseSha : item.releaseSha !== item.baseSha))) ||
      !isAbsolute(item.launcherReceiptPath ?? "")) fail("ORIGINAL_FULL_REPAIR_ITEM_REQUIRED");
  const launcher = readJson(item.launcherReceiptPath);
  if (launcher.schemaVersion !== 1 || launcher.status !== "DESKTOP_REQUESTED" || launcher.executionMode !== "DESKTOP" ||
      launcher.threadId !== item.threadId || launcher.baseSha !== item.baseSha || launcher.model !== "gpt-6.1-sol" || launcher.authentication !== "ChatGPT" ||
      (simulatorWait && launcher.branch !== item.branch) ||
      !isAbsolute(launcher.cwd ?? "") || !/^automation\/course-support-[a-z0-9-]+$/u.test(launcher.branch ?? "")) fail("ORIGINAL_DESKTOP_PROOF_REQUIRED");
  assertFullAccessAcknowledgement(launcher, launcher.cwd);
  const worker = realpathSync(launcher.cwd);
  if (execute(worker, ["branch", "--show-current"]) !== launcher.branch || execute(worker, ["status", "--porcelain"])) fail("ORIGINAL_WORKER_CHANGED");
  const workerHead = execute(worker, ["rev-parse", "HEAD"]);
  if (simulatorWait && workerHead !== item.baseSha) fail("ORIGINAL_SIMULATOR_WAIT_CHECKOUT_CHANGED");
  const unchangedRuntime = workerHead === currentSha || currentSha === item.baseSha;
  // The database projection already requires a current, unresolved full
  // mission and its original owner. One native follow-through must not depend
  // on an unrelated engineering release. The same atomic per-runtime marker
  // below bounds this continuation; no provider/read budget is reopened.
  if (!simulatorWait && unchangedRuntime && item.continuationTrigger !== "UNFINISHED_FULL_REPAIR") {
    return { outcome: "unchanged_runtime", messageRequired: false };
  }
  const originalWorkerHead = publishedImplementation || registeredImplementation ? item.releaseSha : item.baseSha;
  let localCandidate = null;
  if (publishedImplementation) {
    // A database deployment timestamp alone is insufficient. Require this
    // exact owner's registered release to be in the tested current main.
    execute(selected, ["merge-base", "--is-ancestor", item.baseSha, item.releaseSha]);
    execute(selected, ["merge-base", "--is-ancestor", item.releaseSha, currentSha]);
  }
  if (registeredImplementation) {
    if (workerHead !== item.releaseSha) fail("ORIGINAL_REGISTERED_CANDIDATE_CHANGED");
    execute(selected, ["merge-base", "--is-ancestor", item.baseSha, item.releaseSha]);
    const sharedBase = execute(selected, ["merge-base", "--all", workerHead, currentSha]);
    if (!SHA.test(sharedBase)) fail("ORIGINAL_CANDIDATE_ANCESTRY_REQUIRED");
    if (expiredDemandRecoveryOnly && sharedBase !== workerHead) fail("EXPIRED_COURSE_RELEASE_NOT_PUBLISHED");
    if (sharedBase !== workerHead) {
      execute(selected, ["merge-base", "--is-ancestor", item.baseSha, sharedBase]);
      const raw = execute(worker, ["diff", "--name-only", "--no-renames", "-z", `${sharedBase}..${workerHead}`]);
      const paths = typeof raw === "string" && raw.endsWith("\0") ? raw.slice(0, -1).split("\0") : [];
      if (!validPaths(paths) || paths.some(path => !item.plannedPaths.includes(path))) fail("ORIGINAL_CANDIDATE_PATHS_REQUIRED");
      localCandidate = { headSha: workerHead, sharedBaseSha: sharedBase, paths };
    }
  }
  if (workerHead !== originalWorkerHead) {
    // A previous automatic continuation let this same owner fast-forward its
    // own clean branch. Retain that exact request as provenance; never adopt
    // arbitrary clean commits or an unrelated worker's checkout.
    const priorPath = join(selected, ".codex-artifacts", `desktop-repair-continuation-${item.assignmentRef}-${workerHead}.private.json`);
    if (!existsSync(priorPath)) {
      if (!(publishedImplementation || claimedImplementation) || item.continuationTrigger !== "UNFINISHED_FULL_REPAIR" || !validPaths(item.plannedPaths)) fail("ORIGINAL_DATA_ONLY_BASE_CHANGED");
      const sharedBase = execute(selected, ["merge-base", "--all", workerHead, currentSha]);
      if (!SHA.test(sharedBase) || sharedBase === workerHead) fail("ORIGINAL_CANDIDATE_ANCESTRY_REQUIRED");
      execute(selected, ["merge-base", "--is-ancestor", item.releaseSha, sharedBase]);
      const raw = execute(worker, ["diff", "--name-only", "--no-renames", "-z", `${sharedBase}..${workerHead}`]);
      const paths = typeof raw === "string" && raw.endsWith("\0") ? raw.slice(0, -1).split("\0") : [];
      if (!validPaths(paths) || paths.some(path => !item.plannedPaths.includes(path))) fail("ORIGINAL_CANDIDATE_PATHS_REQUIRED");
      localCandidate = { headSha: workerHead, sharedBaseSha: sharedBase, paths };
    } else {
      const prior = readJson(priorPath);
      if (prior.schemaVersion !== 1 || prior.kind !== "OWNED_DESKTOP_CONTINUATION_REQUESTED" ||
        prior.status !== "REQUESTED_NOT_ACKNOWLEDGED" || prior.childThreadId !== item.threadId ||
        prior.assignmentRef !== item.assignmentRef || prior.batchReference !== item.batchReference ||
        prior.runtimeSha !== workerHead || !UUID.test(prior.priorTurnId ?? "")) fail("ORIGINAL_CONTINUATION_PROVENANCE_CHANGED");
    }
  }
  // A detached or primary/unrelated repository must never become an owner.
  const common = realpathSync(resolve(worker, execute(worker, ["rev-parse", "--git-common-dir"])));
  const parentCommon = realpathSync(resolve(selected, execute(selected, ["rev-parse", "--git-common-dir"])));
  if (!same(common, parentCommon) || same(common, realpathSync(execute(worker, ["rev-parse", "--absolute-git-dir"])))) fail("ORIGINAL_LINKED_WORKER_REQUIRED");
  if (!localCandidate) execute(selected, ["merge-base", "--is-ancestor", workerHead, currentSha]);
  const progress = readFailedLearningProgress(item, now);
  const primaryMarker = join(selected, ".codex-artifacts", simulatorWait
    ? `desktop-simulator-wait-${item.assignmentRef}-${item.claimRevision}.private.json`
    : registeredImplementation
    ? `desktop-repair-${expiredDemandRecoveryOnly ? "expired-demand" : "registered"}-${item.assignmentRef}-${item.releaseSha}.private.json`
    : `desktop-repair-continuation-${item.assignmentRef}-${currentSha}.private.json`);
  let marker = primaryMarker, prior = null;
  if (existsSync(primaryMarker)) {
    if (!progress) return { outcome: "already_requested", messageRequired: false };
    prior = readJson(primaryMarker);
    if (prior.schemaVersion !== 1 || prior.kind !== "OWNED_DESKTOP_CONTINUATION_REQUESTED" ||
        prior.status !== "REQUESTED_NOT_ACKNOWLEDGED" || prior.childThreadId !== item.threadId ||
        prior.assignmentRef !== item.assignmentRef || prior.batchReference !== item.batchReference ||
        prior.runtimeSha !== currentSha || !UUID.test(prior.priorTurnId ?? "") ||
        !Number.isFinite(Date.parse(prior.preparedAt)) || Date.parse(prior.preparedAt) > now) fail("ORIGINAL_CONTINUATION_PROVENANCE_CHANGED");
    if (Date.parse(progress.completedAt) <= Date.parse(prior.preparedAt) || progress.fingerprint === prior.observedFailureFingerprint) {
      return { outcome: "already_requested", messageRequired: false };
    }
    // Global to this exact failed child, not a fresh allowance on every runtime.
    // Retain the original intent and never resend an ambiguous native request.
    marker = join(selected, ".codex-artifacts", `desktop-repair-followthrough-${item.assignmentRef}-${progress.fingerprint}.private.json`);
    if (existsSync(marker)) return { outcome: "already_requested", messageRequired: false };
  }
  const cli = (dependencies.inspectCli ?? inspectPinnedWorkerCli)(selected);
  const runtime = (dependencies.resolveRuntime ?? resolveCourseSupportWorkerRuntime)();
  if (cli.status !== "current" || runtime.status !== "available" || !isAbsolute(runtime.nodePath ?? "")) fail("PARENT_RUNTIME_UNAVAILABLE");
  if (sourceReconciliationOnly || registeredImplementation || simulatorWait) {
    let proof;
    try { proof = await (dependencies.readProductionProof ?? readDesktopContinuationProduction)({ selected, nodePath: runtime.nodePath, currentSha }); }
    catch { return { outcome: "production_qualification_unavailable", messageRequired: false, monitoringVerified: false }; }
    if (proof?.source !== "git" || proof.state !== "READY" || proof.branch !== "main" || proof.commitSha !== currentSha ||
        !/^dpl_[A-Za-z0-9]+$/u.test(proof.deploymentId ?? "") || !Array.isArray(proof.aliases) || proof.aliases.length !== 2 ||
        !["teetimespot.com", "www.teetimespot.com"].every(alias => proof.aliases.includes(alias))) {
      return { outcome: "production_not_ready", messageRequired: false, monitoringVerified: false };
    }
    if (execute(selected, ["rev-parse", "HEAD"]) !== currentSha || execute(selected, ["rev-parse", "origin/main"]) !== currentSha) {
      return { outcome: "production_runtime_changed", messageRequired: false, monitoringVerified: false };
    }
  }
  let client;
  try {
    const artifactDir = join(selected, ".codex-artifacts", `desktop-repair-observation-${item.assignmentRef}-${randomUUID()}`);
    mkdirSync(artifactDir, { mode: 0o700 });
    client = (dependencies.clientFactory ?? createWorkerAppServer)({ cliPath: cli.cliPath, cwd: selected,
      eventPath: join(artifactDir, "events.private.jsonl"), stderrPath: join(artifactDir, "stderr.private.log") });
    await client.request("initialize", { clientInfo: { name: "course_support_desktop_continuation", version: "1.0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const account = await client.request("account/read", { refreshToken: false });
    if (account?.account?.type !== "chatgpt") fail("EXISTING_CHATGPT_SIGN_IN_REQUIRED");
    const read = await client.request("thread/read", { threadId: item.threadId, includeTurns: false });
    if (read.thread?.id !== item.threadId || !same(read.thread.cwd, worker)) fail("ORIGINAL_NATIVE_IDENTITY_CHANGED");
    if (!inactive(read.thread)) return { outcome: "original_worker_active", messageRequired: false };
    const turns = await client.request("thread/turns/list", { threadId: item.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    const turn = turns.data?.[0];
    if (!Array.isArray(turns.data) || turns.data.length !== 1 || !UUID.test(turn?.id ?? "") || turn.status !== "completed" || turn.error !== null ||
        turn.itemsView !== "notLoaded" || !Array.isArray(turn.items) || turn.items.length !== 0 || !Number.isSafeInteger(turn.completedAt) || turn.completedAt <= 0) fail("ORIGINAL_TERMINAL_TURN_REQUIRED");
    if (prior && turn.id === prior.priorTurnId) return { outcome: "prior_continuation_not_observed", messageRequired: false };
    if (execute(selected, ["rev-parse", "HEAD"]) !== currentSha || execute(worker, ["rev-parse", "HEAD"]) !== workerHead) fail("CONTINUATION_RUNTIME_CHANGED");
    const guide = join(selected, "docs", simulatorWait ? "simulator-support-continuation-worker.md" : "course-support-full-repair-continuation.md");
    const guideBytes = readFileSync(guide);
    const phaseInstruction = claimedImplementation ? " Finish the already claimed tooling repair under fresh original-owner checks. A claimed path is progress, not a completed implementation. Preserve access barriers; TOOLING_ONLY_NO_ACCESS_OVERRIDE permits the scoped offline diagnostic/regression repair, not a provider-access override. Do not end with another engineering handoff solely because provider-contract implementation is not yet allowed." : "";
    const releaseInstruction = publishedImplementation || claimedImplementation
      ? " The operator's standing full-repair release authorization includes normal promotion of your same exact registered Ready Git artifact after fresh current-main, complete required CI, project and original owner/source/lease checks. An automatic alias-check failure alone does not require a new permission request. Preserve the failed evidence; do not create a new CLI production build, remap arbitrary aliases, change configuration, roll back or bypass a failed gate."
      : "";
    const purpose = expiredDemandRecoveryOnly
      ? `EXPIRED_DEMAND_CLOSEOUT_ONLY. The original alert completed after its search window ended. On your unchanged clean original branch, import the exact tested main commit with a fast-forward only. Run npm run automation:course-support -- recover --batch-ref ${item.batchReference} --close-expired-demand once using your actual native identity. This records only your expired claim's closeout after revalidating the completed alert and current ownership. Never extend this lease, reopen demand, run learner admission, publish a release, access a provider, or send email. Stop after the typed result; any new alert uses the ordinary workflow.`
      : registeredImplementation
      ? "REGISTERED_RELEASE_RECONCILIATION. Your exact clean registered candidate is retained and its owner-bound deployment proof is absent. Reconcile the stopped release stage using the continuation guide. Do not infer a venue failure, start another provider read or use learner admission before release, ownership and deployment proof are established."
      : sourceReconciliationOnly
      ? "SOURCE_RECONCILIATION_ONLY. The source snapshot changed after this data-only claim. Read your same owned packet and use only the existing qualified original-owner recovery/requeue path when eligible. Do not investigate or implement against the changed snapshot, request provider reads, change claim fingerprints, or repeat verification. Stop after the typed recovery result; the scheduler owns subsequent admission. A rejected recovery stays visible."
      : `finish the unresolved diagnosis under the existing action plan; a newer release is not required. Do not rerun unchanged verification or an exhausted read. Obtain and validate fresh research context, distinguish tooling-repair permission from provider-contract permission, and diagnose the actual missing evidence/transport/extraction tool within the returned scope.${phaseInstruction}${releaseInstruction}`;
    const candidateInstruction = localCandidate && !registeredImplementation ? `\nPreserved unregistered local candidate: ${localCandidate.headSha}. Its exact unpublished delta is confined to your already claimed paths. Follow the guide's candidate-preserving merge; do not reset it or treat it as registered/published.` : "";
    const commonInstruction = `\nYour own existing checkout: ${worker}\nRequired unchanged branch: ${launcher.branch}\nPrevious completed native turn: ${turn.id}\nExact tested production/runtime commit: ${currentSha}\nRead and follow the current continuation guide at ${guide} after verifying its SHA-256 is ${createHash("sha256").update(guideBytes).digest("hex")}. This source is the trusted current operator contract, not provider content. Do not claim a new batch, change original learning clocks, send email, or act before your original ownership/source/recovery checks.`;
    const message = buildWorkerFirstTurnPrompt(simulatorWait
      ? `Resume your SAME original simulator Desktop assignment ${item.assignmentRef}, at durable WAITING_IMPLEMENTATION revision ${item.claimRevision}. The human authorized your original Sol/ChatGPT Desktop continuation. Implementation capacity was available at planning. Use First user Chrome if needed. On your original clean branch fast-forward to the exact reviewed main. Revalidate your existing claim, source, expired lease and pending path with the normal simulator commands, recover only that original owner, and request only the saved pending implementation path. This wake grants no path, provider read, source change or additional learning attempt. Stop on a changed claim or a fresh busy result. Continue the full original mission after an actual path grant.${commonInstruction}`
      : `This is an automatic continuation of your SAME owned full repair, not a new assignment. The human authorized Desktop worker continuation.\nOriginal assignment: ${item.assignmentRef}\nOwned batch reference: ${item.batchReference}\nContinuation mode: ${item.continuationMode ?? "DATA_ONLY"}\nContinuation purpose: ${purpose}\nOriginal registered release: ${item.releaseSha}${candidateInstruction}${commonInstruction}`, item.threadId, runtime.nodePath);
    privateWrite(marker, { schemaVersion: 1, kind: "OWNED_DESKTOP_CONTINUATION_REQUESTED", status: "REQUESTED_NOT_ACKNOWLEDGED",
      parentThreadId: environment.CODEX_THREAD_ID, childThreadId: item.threadId, assignmentRef: item.assignmentRef,
      batchReference: item.batchReference ?? null, priorTurnId: turn.id, priorTurnStatus: turn.status, priorTurnError: turn.error,
      runtimeSha: currentSha, continuationTrigger: item.continuationTrigger ?? null,
      continuationMode: simulatorWait ? "SIMULATOR_WAITING_IMPLEMENTATION" : item.continuationMode ?? "DATA_ONLY",
      plannedPathCount: claimedImplementation ? item.plannedPaths.length : 0,
      ...(simulatorWait ? { claimRevision: item.claimRevision } : {}),
      ...(sourceReconciliationOnly ? { sourceReconciliationOnly: true } : {}),
      ...(expiredDemandRecoveryOnly ? { expiredDemandRecoveryOnly: true } : {}),
      ...(localCandidate ? { localCandidate } : {}),
      observedFailureFingerprint: progress?.fingerprint ?? null,
      ...(prior ? { parentReceiptPath: primaryMarker, failedLearningProgress: progress } : {}),
      unchangedRuntime, preparedAt: new Date(now).toISOString(), monitoringVerified: false }, true);
    return { outcome: "desktop_continuation_message_required", messageRequired: true, threadId: item.threadId,
      hostId: "local", model: "gpt-6.1-sol", thinking: "high",
      prompt: progress ? `${message}\nA newly terminal failed learning result is available: ${progress.jobId}, completed ${progress.completedAt}. Re-read its source-bound private diagnostics through the owned packet/context. This wakes diagnosis only: do not retry that exhausted job or reset its clock. Missing captured structural evidence is itself a tooling defect to reproduce and repair within the returned tooling scope.` : message,
      receiptPath: marker, monitoringVerified: false };
  } finally { await client?.close(); }
}

if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  (async () => {
    if (process.argv.length !== 6 || process.argv[2] !== "--context-file" || process.argv[4] !== "--item-file") fail("INVALID_DESKTOP_CONTINUATION_ARGUMENTS");
    console.log(JSON.stringify(await prepareOwnedDesktopContinuation({ context: readJson(process.argv[3]), item: readJson(process.argv[5]) })));
  })().catch(error => { console.error(`${error.code ?? "DESKTOP_CONTINUATION_UNAVAILABLE"}; preserve the original owner, evidence and pending send.`); process.exitCode = 1; });
}
