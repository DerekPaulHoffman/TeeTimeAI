import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPinnedWorkerCli } from "./course-support-worker-cli.mjs";
import { courseSupportWorkerAppServerEnvironment, createWorkerAppServer, isApprovalRequest } from "./course-support-worker-launcher.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const MINIMUM_AGE_MS = 30 * 60_000;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const samePath = (a, b) => typeof a === "string" && typeof b === "string" &&
  (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** Original launcher receipts select only generated workers, never arbitrary chats. */
export function readCourseChatCleanupCandidates(checkout) {
  const root = join(checkout, ".codex-artifacts");
  const entries = readdirSync(root, { withFileTypes: true }).filter(entry =>
    entry.isDirectory() && /^course-dispatch-course-assignment-[a-f0-9-]{36}$/iu.test(entry.name));
  if (entries.length > 2000) fail("CLEANUP_RECEIPT_INVENTORY_LIMIT");
  const candidates = [];
  for (const entry of entries) {
    try {
      const receipt = JSON.parse(readFileSync(join(root, entry.name, "supervisor", "launcher.receipt.private.json"), "utf8"));
      if (receipt.schemaVersion === 1 && receipt.status === "COMPLETED" && receipt.turnStatus === "completed" &&
          receipt.nativeIdentityVerified === true && receipt.approvalRequests === 0 &&
          UUID.test(receipt.threadId ?? "") && UUID.test(receipt.turnId ?? "") &&
          isAbsolute(receipt.cwd ?? "") && /^automation\/course-support-[a-z0-9][a-z0-9-]*$/u.test(receipt.branch ?? "") &&
          Number.isFinite(Date.parse(receipt.completedAt))) candidates.push(receipt);
    } catch { /* Missing, partial, failed and ambiguous receipts stay visible. */ }
  }
  return candidates.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
}

function inactive(thread) {
  return ["idle", "notLoaded"].includes(thread?.status?.type) &&
    !thread.activeTurnId && !thread.activeTurn && !thread.pendingTurn && !thread.pendingApproval && !thread.needsAttention && !thread.error &&
    !thread.status.activeTurnId && !thread.status.activeTurn && !thread.status.pendingApproval && !thread.status.needsAttention;
}

/** Read-only selection. The parent uses the supported archive tool on returned IDs. */
export async function inspectCourseChatCleanup({ client, candidates, protectedThreadIds, now = new Date(), limit = 10 }) {
  if (!Array.isArray(protectedThreadIds) || protectedThreadIds.some(id => !UUID.test(id)) ||
      !Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isFinite(now.getTime())) fail("INVALID_CLEANUP_SCOPE");
  const protectedIds = new Set(protectedThreadIds);
  const eligible = [], seen = new Set();
  let inspected = 0, retained = 0;
  const old = candidates.filter(receipt => !protectedIds.has(receipt.threadId) &&
    now.getTime() - Date.parse(receipt.completedAt) >= MINIMUM_AGE_MS);
  if (old.length === 0) return { outcome: "cleanup_inspected", inspected, retained, eligible };
  // Exclude already-archived logs before spending the bounded inspection
  // budget, otherwise the oldest archived receipts would starve all later work.
  const active = new Map(), cursors = new Set();
  let cursor = null;
  for (let pageNumber = 0; ; pageNumber += 1) {
    if (pageNumber >= 20 || (cursor && cursors.has(cursor))) fail("CLEANUP_NATIVE_INVENTORY_LIMIT");
    if (cursor) cursors.add(cursor);
    const page = await client.request("thread/list", { cwd: [...new Set(old.map(receipt => receipt.cwd))], archived: false, useStateDbOnly: true, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) fail("CLEANUP_NATIVE_INVENTORY_UNAVAILABLE");
    for (const thread of page.data) active.set(thread.id, thread);
    cursor = page.nextCursor;
    if (cursor == null) break;
    if (typeof cursor !== "string" || !cursor) fail("CLEANUP_NATIVE_INVENTORY_UNAVAILABLE");
  }
  for (const receipt of old) {
    if (inspected >= limit) break;
    if (seen.has(receipt.threadId)) continue;
    seen.add(receipt.threadId);
    const thread = active.get(receipt.threadId);
    if (!thread || !samePath(thread.cwd, receipt.cwd) || !inactive(thread)) continue;
    inspected += 1;
    try {
      const read = await client.request("thread/read", { threadId: receipt.threadId, includeTurns: false });
      if (read.thread?.id !== receipt.threadId || !samePath(read.thread.cwd, receipt.cwd) || !inactive(read.thread)) { retained += 1; continue; }
      const page = await client.request("thread/turns/list", { threadId: receipt.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      const turn = page.data?.[0];
      if (!Array.isArray(page.data) || page.data.length !== 1 || turn.id !== receipt.turnId || turn.status !== "completed" || turn.error !== null ||
          turn.itemsView !== "notLoaded" || !Array.isArray(turn.items) || turn.items.length !== 0 ||
          !Number.isSafeInteger(turn.completedAt) || turn.completedAt <= 0 || now.getTime() - turn.completedAt * 1000 < MINIMUM_AGE_MS) { retained += 1; continue; }
      // Native archive can cascade to descendants. Never select a parent with
      // another chat beneath it, even if that descendant is currently idle.
      const descendants = await client.request("thread/list", { ancestorThreadId: receipt.threadId, archived: false, useStateDbOnly: true, limit: 1 });
      if (!Array.isArray(descendants.data) || descendants.data.length !== 0 || descendants.nextCursor != null) { retained += 1; continue; }
      eligible.push({ threadId: receipt.threadId, turnId: turn.id, completedAt: turn.completedAt });
    } catch { fail("CLEANUP_NATIVE_OBSERVATION_FAILED"); }
  }
  return { outcome: "cleanup_inspected", inspected, retained, eligible };
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--selected-checkout" || !isAbsolute(args[1]) ||
      args[2] !== "--protected-thread-ids-file" || !isAbsolute(args[3])) fail("INVALID_CLEANUP_ARGUMENTS");
  const checkout = resolve(args[1]);
  const protectedThreadIds = JSON.parse(readFileSync(args[3], "utf8").replace(/^\uFEFF/u, ""));
  if (!Array.isArray(protectedThreadIds) || protectedThreadIds.some(id => !UUID.test(id))) fail("INVALID_CLEANUP_SCOPE");
  const cli = inspectPinnedWorkerCli(checkout);
  if (cli.status !== "current") fail("CLEANUP_PINNED_CLI_UNAVAILABLE");
  const output = join(checkout, ".codex-artifacts", `chat-cleanup-${Date.now()}-${process.pid}`);
  mkdirSync(output, { mode: 0o700 });
  let fatal, client;
  try {
    client = createWorkerAppServer({ cliPath: cli.cliPath, cwd: checkout,
      environment: courseSupportWorkerAppServerEnvironment(checkout),
      eventPath: join(output, "events.private.jsonl"), stderrPath: join(output, "stderr.private.log"),
      onFailure(error) { fatal ??= error; }, onMessage(message) { if (isApprovalRequest(message)) fatal ??= new Error("UNEXPECTED_CLEANUP_APPROVAL"); } });
    await client.request("initialize", { clientInfo: { name: "course_support_chat_cleanup", version: "1.0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const result = await inspectCourseChatCleanup({ client, candidates: readCourseChatCleanupCandidates(checkout), protectedThreadIds });
    if (fatal) fail("CLEANUP_NATIVE_OBSERVATION_FAILED");
    console.log(JSON.stringify(result));
  } finally { await client?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(() => { console.error("CLEANUP_UNAVAILABLE; retain all unverifiable chats."); process.exitCode = 1; });
}
