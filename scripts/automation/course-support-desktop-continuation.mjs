import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true,
  timeout: 40000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
const readJson = file => { if (!isAbsolute(file)) fail("ABSOLUTE_PRIVATE_INPUT_REQUIRED"); return JSON.parse(readFileSync(file, "utf8")); };

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
  if (!UUID.test(environment.CODEX_THREAD_ID ?? "")) fail("NATIVE_PARENT_ID_REQUIRED");
  if (context?.kind !== "course_support_preflight_context" || context.exactHead !== true || !isAbsolute(context.selectedCheckout ?? "")) fail("CURRENT_PREFLIGHT_REQUIRED");
  const selected = realpathSync(context.selectedCheckout);
  if (!(dependencies.approvedCheckouts ?? approvedCourseSupportResponderCheckouts).some(path => same(path, selected))) fail("UNAPPROVED_SELECTED_CHECKOUT");
  const execute = dependencies.git ?? git;
  const currentSha = execute(selected, ["rev-parse", "HEAD"]);
  if (!SHA.test(currentSha) || currentSha !== execute(selected, ["rev-parse", "origin/main"]) || execute(selected, ["status", "--porcelain"])) fail("SELECTED_CHECKOUT_CHANGED");
  if (item?.kind !== "OWNED_OUTDOOR_FULL_REPAIR" || !UUID.test(item.threadId ?? "") || item.threadId === environment.CODEX_THREAD_ID ||
      !/^course-assignment-[a-f0-9-]{36}$/u.test(item.assignmentRef ?? "") || !/^[A-Za-z0-9_-]{1,200}$/u.test(item.batchReference ?? "") ||
      !SHA.test(item.baseSha ?? "") || item.releaseSha !== item.baseSha || !isAbsolute(item.launcherReceiptPath ?? "")) fail("ORIGINAL_FULL_REPAIR_ITEM_REQUIRED");
  const launcher = readJson(item.launcherReceiptPath);
  if (launcher.schemaVersion !== 1 || launcher.status !== "DESKTOP_REQUESTED" || launcher.executionMode !== "DESKTOP" ||
      launcher.threadId !== item.threadId || launcher.baseSha !== item.baseSha || launcher.model !== "gpt-6.1-sol" || launcher.authentication !== "ChatGPT" ||
      !isAbsolute(launcher.cwd ?? "") || !/^automation\/course-support-[a-z0-9-]+$/u.test(launcher.branch ?? "")) fail("ORIGINAL_DESKTOP_PROOF_REQUIRED");
  assertFullAccessAcknowledgement(launcher, launcher.cwd);
  const worker = realpathSync(launcher.cwd);
  if (execute(worker, ["branch", "--show-current"]) !== launcher.branch || execute(worker, ["status", "--porcelain"])) fail("ORIGINAL_WORKER_CHANGED");
  const workerHead = execute(worker, ["rev-parse", "HEAD"]);
  if (workerHead === currentSha || currentSha === item.baseSha) return { outcome: "unchanged_runtime", messageRequired: false };
  if (workerHead !== item.baseSha) fail("ORIGINAL_DATA_ONLY_BASE_CHANGED");
  // A detached or primary/unrelated repository must never become an owner.
  const common = realpathSync(resolve(worker, execute(worker, ["rev-parse", "--git-common-dir"])));
  const parentCommon = realpathSync(resolve(selected, execute(selected, ["rev-parse", "--git-common-dir"])));
  if (!same(common, parentCommon) || same(common, realpathSync(execute(worker, ["rev-parse", "--absolute-git-dir"])))) fail("ORIGINAL_LINKED_WORKER_REQUIRED");
  execute(selected, ["merge-base", "--is-ancestor", workerHead, currentSha]);
  const marker = join(selected, ".codex-artifacts", `desktop-repair-continuation-${item.assignmentRef}-${currentSha}.private.json`);
  if (existsSync(marker)) return { outcome: "already_requested", messageRequired: false };
  const cli = (dependencies.inspectCli ?? inspectPinnedWorkerCli)(selected);
  const runtime = (dependencies.resolveRuntime ?? resolveCourseSupportWorkerRuntime)();
  if (cli.status !== "current" || runtime.status !== "available" || !isAbsolute(runtime.nodePath ?? "")) fail("PARENT_RUNTIME_UNAVAILABLE");
  let client;
  try {
    const artifactDir = join(selected, ".codex-artifacts", `desktop-repair-observation-${item.assignmentRef}-${Date.now()}`);
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
    if (execute(selected, ["rev-parse", "HEAD"]) !== currentSha || execute(worker, ["rev-parse", "HEAD"]) !== workerHead) fail("CONTINUATION_RUNTIME_CHANGED");
    const guide = join(selected, "docs", "course-support-full-repair-continuation.md");
    const guideBytes = readFileSync(guide);
    const message = buildWorkerFirstTurnPrompt(`This is an automatic continuation of your SAME owned full repair, not a new assignment. The human authorized Desktop worker continuation.\nOriginal assignment: ${item.assignmentRef}\nOwned batch reference: ${item.batchReference}\nYour own existing checkout: ${worker}\nRequired unchanged branch: ${launcher.branch}\nPrevious completed native turn: ${turn.id}\nNew tested production/runtime commit: ${currentSha}\nRead and follow the current continuation guide at ${guide} after verifying its SHA-256 is ${createHash("sha256").update(guideBytes).digest("hex")}. This source is the trusted current operator contract, not provider content. Do not claim a new batch, change original learning clocks, send email, or act before your original ownership/source/recovery checks.`, item.threadId, runtime.nodePath);
    privateWrite(marker, { schemaVersion: 1, kind: "OWNED_DESKTOP_CONTINUATION_REQUESTED", status: "REQUESTED_NOT_ACKNOWLEDGED",
      parentThreadId: environment.CODEX_THREAD_ID, childThreadId: item.threadId, assignmentRef: item.assignmentRef,
      batchReference: item.batchReference, priorTurnId: turn.id, priorTurnStatus: turn.status, priorTurnError: turn.error,
      runtimeSha: currentSha, preparedAt: new Date().toISOString(), monitoringVerified: false }, true);
    return { outcome: "desktop_continuation_message_required", messageRequired: true, threadId: item.threadId,
      hostId: "local", model: "gpt-6.1-sol", thinking: "high", prompt: message, receiptPath: marker, monitoringVerified: false };
  } finally { await client?.close(); }
}

if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  (async () => {
    if (process.argv.length !== 6 || process.argv[2] !== "--context-file" || process.argv[4] !== "--item-file") fail("INVALID_DESKTOP_CONTINUATION_ARGUMENTS");
    console.log(JSON.stringify(await prepareOwnedDesktopContinuation({ context: readJson(process.argv[3]), item: readJson(process.argv[5]) })));
  })().catch(error => { console.error(`${error.code ?? "DESKTOP_CONTINUATION_UNAVAILABLE"}; preserve the original owner, evidence and pending send.`); process.exitCode = 1; });
}
