import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { courseSupportWorkerRuntimeEnvironment, resolveCourseSupportWorkerRuntime } from "./course-support-worker-runtime.mjs";

export const WORKER_PERMISSION_PROFILE = ":danger-full-access";
export const WORKER_RPC_TIMEOUT_MS = 40_000;
export const WORKER_TURN_TIMEOUT_MS = 24 * 60 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VERIFIED_WORKER_CLI_VERSIONS = new Set(["codex-cli 0.160.0", "codex-cli 0.160.1"]);

function failure(code) { return Object.assign(new Error(code), { code }); }
function absoluteFile(path) {
  if (typeof path !== "string" || !isAbsolute(path) || !statSync(path).isFile()) throw failure("ABSOLUTE_FILE_REQUIRED");
  return realpathSync(path);
}
function samePath(a, b) {
  const normalize = (path) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(a) === normalize(b);
}
function privateWrite(path, value, exclusive = false) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) return writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
}

export function assertFullAccessAcknowledgement(result, cwd) {
  if (result?.approvalPolicy !== "never" || result?.sandbox?.type !== "dangerFullAccess" ||
      result?.activePermissionProfile?.id !== WORKER_PERMISSION_PROFILE ||
      !samePath(result.cwd ?? "", cwd)) throw failure("FULL_ACCESS_NOT_ACKNOWLEDGED");
  return result;
}

export function assertUnusedWorkerThread(thread, expectedId, historyMode) {
  if (!thread || thread.id !== expectedId || !UUID.test(thread.id) || thread.ephemeral !== false ||
      thread.historyMode !== historyMode || !Array.isArray(thread.turns) || thread.turns.length !== 0 ||
      (thread.status?.type !== "idle" && thread.status?.type !== "notLoaded")) {
    throw failure("PREPARED_THREAD_IS_NOT_UNUSED");
  }
}

export function assertOwnedWorkerCheckout(cwd, root = ROOT, git = execFileSync) {
  if (!isAbsolute(cwd)) throw failure("ABSOLUTE_WORKER_CHECKOUT_REQUIRED");
  const read = (checkout, args) => git("git", args, {
    cwd: checkout, encoding: "utf8", windowsHide: true, timeout: WORKER_RPC_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
  const canonical = realpathSync(cwd);
  const top = read(canonical, ["rev-parse", "--show-toplevel"]);
  const branch = read(canonical, ["branch", "--show-current"]);
  const baseSha = read(canonical, ["rev-parse", "HEAD"]);
  const currentMain = read(canonical, ["rev-parse", "origin/main"]);
  const common = realpathSync(resolve(canonical, read(canonical, ["rev-parse", "--git-common-dir"])));
  const rootCommon = realpathSync(resolve(root, read(root, ["rev-parse", "--git-common-dir"])));
  const gitDir = realpathSync(read(canonical, ["rev-parse", "--absolute-git-dir"]));
  if (!samePath(canonical, top) || !samePath(common, rootCommon) || samePath(common, gitDir) ||
      !/^automation\/course-support-[a-z0-9][a-z0-9-]*$/.test(branch) || !/^[a-f0-9]{40}$/i.test(baseSha) ||
      baseSha !== currentMain || read(canonical, ["status", "--porcelain"])) {
    throw failure("OWNED_CLEAN_LINKED_WORKTREE_REQUIRED");
  }
  return { cwd: canonical, branch, baseSha };
}

export function readWorkerCliVersion(cliPath, execute = execFileSync) {
  const version = execute(absoluteFile(cliPath), ["--version"], {
    encoding: "utf8", windowsHide: true, timeout: WORKER_RPC_TIMEOUT_MS,
  }).trim();
  if (!VERIFIED_WORKER_CLI_VERSIONS.has(version)) throw failure("UNVERIFIED_CODEX_CLI_VERSION");
  return version;
}

export function isApprovalRequest(message) {
  return typeof message?.method === "string" &&
    /requestApproval|execCommandApproval|applyPatchApproval|mcpServer\/elicitation\/request/.test(message.method);
}

export function courseSupportWorkerAppServerEnvironment(cwd, environment = process.env, runtime = resolveCourseSupportWorkerRuntime({ environment })) {
  const result = courseSupportWorkerRuntimeEnvironment(runtime, cwd, environment);
  // Codex reads its normal auth/config from these home locations. Product keys
  // remain absent; explicit production wrappers obtain them only after bootstrap.
  for (const key of ["CODEX_HOME", "HOME", "HOMEDRIVE", "HOMEPATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ"]) {
    if (typeof environment[key] === "string") result[key] = environment[key];
  }
  // The server supplies each worker's actual native identity itself.
  delete result.CODEX_THREAD_ID;
  return result;
}

export function createWorkerAppServer({ cliPath, cwd, eventPath, stderrPath, onMessage = () => {}, onFailure = () => {}, spawnProcess = spawn, timeoutMs = WORKER_RPC_TIMEOUT_MS, environment = courseSupportWorkerAppServerEnvironment(cwd) }) {
  const child = spawnProcess(cliPath, ["app-server", "--stdio"], {
    cwd, env: environment, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let sequence = 0;
  let stopped = false;
  let closing = false;
  let terminalError = null;
  const rejectPending = (error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const fail = (error) => {
    terminalError ??= error;
    rejectPending(terminalError);
    if (!closing) onFailure(terminalError);
  };
  child.on("error", () => fail(failure("APP_SERVER_PROCESS_FAILED")));
  child.on("close", () => { stopped = true; fail(failure("APP_SERVER_CLOSED")); });
  child.stdin.on("error", () => fail(failure("APP_SERVER_INPUT_FAILED")));
  child.stderr.on("data", (chunk) => {
    try { appendFileSync(stderrPath, chunk, { mode: 0o600 }); } catch { fail(failure("PRIVATE_EVENT_LOG_FAILED")); }
  });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
      if (!message || typeof message !== "object" || Array.isArray(message)) throw failure("INVALID_APP_SERVER_MESSAGE");
      appendFileSync(eventPath, `${JSON.stringify(message)}\n`, { mode: 0o600 });
      onMessage(message);
    } catch { fail(failure("INVALID_APP_SERVER_MESSAGE")); return; }
    if (isApprovalRequest(message)) { fail(failure("UNEXPECTED_APPROVAL_REQUEST")); return; }
    if (message.method == null && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(failure("APP_SERVER_RPC_REJECTED"), { rpcCode: message.error.code }));
      else request.resolve(message.result);
    } else if (message.method && message.id != null && !isApprovalRequest(message)) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "This worker launcher does not implement client-side tools." } })}\n`);
    }
  });
  return {
    pid: child.pid,
    notify(method, params) {
      if (terminalError) throw terminalError;
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    request(method, params) {
      if (stopped) return Promise.reject(failure("APP_SERVER_CLOSED"));
      if (terminalError && method !== "turn/interrupt") return Promise.reject(terminalError);
      const id = ++sequence;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(failure("APP_SERVER_RPC_TIMEOUT")); }, timeoutMs);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    async close() {
      closing = true;
      reader.close(); child.stdin.end();
      if (!stopped) await new Promise((resolveClose) => {
        const timer = setTimeout(() => { child.kill(); resolveClose(); }, 3_000);
        child.once("close", () => { clearTimeout(timer); resolveClose(); });
      });
    },
  };
}

async function initialize(client, cwd) {
  await client.request("initialize", {
    clientInfo: { name: "course_support_worker_launcher", version: "1.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  const profiles = await client.request("permissionProfile/list", { cwd });
  if (!profiles?.data?.some((profile) => profile.id === WORKER_PERMISSION_PROFILE && profile.allowed === true)) {
    throw failure("FULL_ACCESS_PROFILE_NOT_ALLOWED");
  }
}

async function readUnusedThread(client, receipt) {
  const read = await client.request("thread/read", { threadId: receipt.threadId, includeTurns: false });
  assertUnusedWorkerThread(read.thread, receipt.threadId, receipt.historyMode);
  const page = await client.request("thread/turns/list", { threadId: receipt.threadId, limit: 1, itemsView: "notLoaded" });
  if (!Array.isArray(page?.data) || page.data.length !== 0 || page.nextCursor != null) {
    throw failure("PREPARED_THREAD_IS_NOT_UNUSED");
  }
}

export async function prepareCourseSupportWorker(options) {
  // Installed 0.160 cannot page a cold empty paginated thread: it reports a
  // missing source rollout. Legacy is the compatibility default and still needs
  // live cold-start verification; explicit paginated attempts never auto-replace.
  const { receiptPath, title, historyMode = "legacy", clientFactory = createWorkerAppServer,
    inspectCheckout = assertOwnedWorkerCheckout, inspectCli = readWorkerCliVersion } = options;
  if (typeof receiptPath !== "string" || !isAbsolute(receiptPath) || !["legacy", "paginated"].includes(historyMode)) throw failure("INVALID_PREPARE_OPTIONS");
  const cliPath = absoluteFile(options.cliPath);
  const checkout = inspectCheckout(options.cwd);
  const cliVersion = inspectCli(cliPath);
  const receipt = {
    schemaVersion: 1, status: "PREPARING", threadId: null, ...checkout, cliPath, cliVersion,
    historyMode, eventPath: `${receiptPath}.events.private.jsonl`, stderrPath: `${receiptPath}.stderr.private.log`,
    createdAt: new Date().toISOString(), launcherPid: process.pid, nativeCreationPossible: false,
    approvalRequests: 0, nativeIdentityVerified: false,
  };
  privateWrite(receiptPath, receipt, true);
  let client;
  let approvalSeen = false;
  let transportFailure = null;
  try {
    client = clientFactory({ ...receipt, onFailure(error) { transportFailure = error; }, onMessage(message) {
      if (isApprovalRequest(message)) { approvalSeen = true; receipt.approvalRequests += 1; }
    } });
    receipt.serverPid = client.pid; privateWrite(receiptPath, receipt);
    await initialize(client, checkout.cwd);
    if (transportFailure) throw transportFailure;
    if (approvalSeen) throw failure("UNEXPECTED_APPROVAL_REQUEST");
    receipt.status = "CREATING"; receipt.nativeCreationPossible = true; privateWrite(receiptPath, receipt);
    const started = await client.request("thread/start", {
      cwd: checkout.cwd, ephemeral: false, historyMode, approvalPolicy: "never",
      permissions: WORKER_PERMISSION_PROFILE, runtimeWorkspaceRoots: [checkout.cwd],
      threadSource: "agent_created_thread",
    });
    if (UUID.test(started?.thread?.id ?? "")) receipt.threadId = started.thread.id;
    privateWrite(receiptPath, receipt);
    assertFullAccessAcknowledgement(started, checkout.cwd);
    assertUnusedWorkerThread(started.thread, receipt.threadId, historyMode);
    if (transportFailure) throw transportFailure;
    if (approvalSeen) throw failure("UNEXPECTED_APPROVAL_REQUEST");
    if (title) await client.request("thread/name/set", { threadId: receipt.threadId, name: title });
    if (transportFailure) throw transportFailure;
    if (approvalSeen) throw failure("UNEXPECTED_APPROVAL_REQUEST");
    receipt.status = "PREPARED";
    receipt.approvalPolicy = started.approvalPolicy;
    receipt.sandbox = started.sandbox;
    receipt.activePermissionProfile = started.activePermissionProfile;
    receipt.source = started.thread.source;
    privateWrite(receiptPath, receipt);
    return { outcome: "prepared", threadId: receipt.threadId, receiptPath };
  } catch (error) {
    receipt.status = receipt.nativeCreationPossible ? "CREATION_UNKNOWN" : "FAILED_BEFORE_CREATION";
    receipt.failureCode = error.code ?? "WORKER_PREPARATION_FAILED";
    privateWrite(receiptPath, receipt); throw error;
  } finally { await client?.close(); }
}

export function buildWorkerFirstTurnPrompt(prompt, threadId, nodePath) {
  if (!UUID.test(threadId) || !isAbsolute(nodePath) || !prompt.trim()) throw failure("INVALID_FIRST_TURN_INPUT");
  const script = `const actual=process.env.CODEX_THREAD_ID;const expected=${JSON.stringify(threadId)};console.log(JSON.stringify({courseWorkerNativeIdentity:{present:Boolean(actual),matchesExpected:actual===expected}}));if(actual!==expected)process.exitCode=76;`;
  const quote = process.platform === "win32" ? (value) => `'${value.replaceAll("'", "''")}'` : (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${process.platform === "win32" ? "& " : ""}${quote(nodePath)} -e ${quote(script)}`;
  return `Before any file write, provider operation, or production command, run this exact read-only native identity check as your first shell command:\n${command}\nStop immediately if it exits nonzero or matchesExpected is false. Never assign, replace, or fabricate CODEX_THREAD_ID. Complete every binding and ownership check required by the authorized instructions below before any provider or production operation. Do not send email.\n\n${prompt}`;
}

export function hasNativeIdentityProof(message) {
  if (message?.method !== "item/completed" || message.params?.item?.type !== "commandExecution") return null;
  for (const line of (message.params.item.aggregatedOutput ?? "").split(/\r?\n/u)) {
    try {
      const proof = JSON.parse(line).courseWorkerNativeIdentity;
      if (proof) return message.params.item.exitCode === 0 && proof.present === true && proof.matchesExpected === true;
    } catch { /* Other command output is not identity proof. */ }
  }
  return null;
}

export async function runPreparedCourseSupportWorker(options) {
  const { receiptPath, promptPath, clientFactory = createWorkerAppServer,
    inspectCheckout = assertOwnedWorkerCheckout, inspectCli = readWorkerCliVersion,
    turnTimeoutMs = WORKER_TURN_TIMEOUT_MS, nodePath = process.execPath } = options;
  const receipt = JSON.parse(readFileSync(absoluteFile(receiptPath), "utf8"));
  if (receipt.schemaVersion !== 1 || receipt.status !== "PREPARED" || !UUID.test(receipt.threadId ?? "") ||
      !["legacy", "paginated"].includes(receipt.historyMode) || receipt.nativeIdentityVerified !== false ||
      receipt.turnId != null || receipt.approvalRequests !== 0) throw failure("UNUSED_PREPARED_RECEIPT_REQUIRED");
  assertFullAccessAcknowledgement(receipt, receipt.cwd);
  const checkout = inspectCheckout(receipt.cwd);
  if (checkout.branch !== receipt.branch || checkout.baseSha !== receipt.baseSha ||
      inspectCli(receipt.cliPath) !== receipt.cliVersion) throw failure("WORKER_RECEIPT_RUNTIME_CHANGED");
  const prompt = readFileSync(absoluteFile(promptPath), "utf8");
  const firstPrompt = buildWorkerFirstTurnPrompt(prompt, receipt.threadId, absoluteFile(nodePath));
  if (Buffer.byteLength(firstPrompt) > 256_000 || !Number.isSafeInteger(turnTimeoutMs) ||
      turnTimeoutMs < 1 || turnTimeoutMs > WORKER_TURN_TIMEOUT_MS) {
    throw failure("INVALID_FIRST_TURN_LIMITS");
  }
  const marker = openSync(`${receiptPath}.first-turn-started`, "wx", 0o600); closeSync(marker);
  receipt.status = "RUN_PREPARING"; receipt.launcherPid = process.pid;
  receipt.promptSha256 = createHash("sha256").update(prompt).digest("hex");
  privateWrite(receiptPath, receipt);
  let client;
  let fatal = null;
  let completed = null;
  let wake;
  const completion = new Promise((resolveCompletion) => { wake = resolveCompletion; });
  const interrupt = async () => {
    if (receipt.turnId) await client?.request("turn/interrupt", { threadId: receipt.threadId, turnId: receipt.turnId }).catch(() => {});
  };
  const timer = setTimeout(() => { fatal = failure("WORKER_TURN_TIMEOUT"); wake(); }, turnTimeoutMs);
  try {
    client = clientFactory({ ...receipt, onFailure(error) { fatal ??= error; wake(); }, onMessage(message) {
      if (isApprovalRequest(message)) {
        receipt.approvalRequests += 1; fatal = failure("UNEXPECTED_APPROVAL_REQUEST"); wake();
      }
      if (message.method === "turn/started" && message.params?.threadId === receipt.threadId) {
        receipt.turnId = message.params.turn.id; receipt.status = "RUNNING";
      }
      const identity = message.params?.threadId === receipt.threadId && message.params?.turnId === receipt.turnId
        ? hasNativeIdentityProof(message) : null;
      if (identity === true) receipt.nativeIdentityVerified = true;
      if (identity === false) { fatal = failure("NATIVE_THREAD_IDENTITY_MISMATCH"); wake(); }
      if (message.method === "turn/completed" && message.params?.threadId === receipt.threadId &&
          message.params?.turn?.id === receipt.turnId) {
        completed = message.params.turn; wake();
      }
      privateWrite(receiptPath, receipt);
    } });
    receipt.serverPid = client.pid; privateWrite(receiptPath, receipt);
    await initialize(client, receipt.cwd);
    await readUnusedThread(client, receipt);
    const resumed = await client.request("thread/resume", {
      threadId: receipt.threadId, cwd: receipt.cwd, approvalPolicy: "never",
      permissions: WORKER_PERMISSION_PROFILE, runtimeWorkspaceRoots: [receipt.cwd],
    });
    assertFullAccessAcknowledgement(resumed, receipt.cwd);
    assertUnusedWorkerThread(resumed.thread, receipt.threadId, receipt.historyMode);
    await readUnusedThread(client, receipt);
    if (fatal) throw fatal;
    receipt.status = "TURN_STARTING"; privateWrite(receiptPath, receipt);
    const started = await client.request("turn/start", {
      threadId: receipt.threadId, input: [{ type: "text", text: firstPrompt }],
      cwd: receipt.cwd, approvalPolicy: "never", permissions: WORKER_PERMISSION_PROFILE,
      runtimeWorkspaceRoots: [receipt.cwd], turnTrigger: "course_support_assigned_worker",
    });
    if (typeof started?.turn?.id !== "string" || !started.turn.id ||
        (receipt.turnId && receipt.turnId !== started.turn.id)) throw failure("WORKER_TURN_ID_NOT_ACKNOWLEDGED");
    receipt.turnId = started.turn.id; privateWrite(receiptPath, receipt);
    await completion;
    if (fatal) throw fatal;
    if (!receipt.nativeIdentityVerified) throw failure("NATIVE_THREAD_IDENTITY_NOT_PROVED");
    receipt.status = completed?.status === "completed" ? "COMPLETED" : "TURN_FAILED";
    receipt.turnStatus = completed?.status ?? "unknown";
    receipt.completedAt = new Date().toISOString(); privateWrite(receiptPath, receipt);
    if (receipt.status !== "COMPLETED") throw failure("WORKER_TURN_DID_NOT_COMPLETE");
    return { outcome: "completed", nativeIdentityVerified: true, approvalRequests: receipt.approvalRequests };
  } catch (error) {
    await interrupt(); receipt.status = "STOPPED"; receipt.failureCode = error.code ?? "WORKER_LAUNCH_FAILED";
    privateWrite(receiptPath, receipt); throw error;
  } finally { clearTimeout(timer); await client?.close(); }
}

export function readWorkerLauncherArguments(args) {
  const [command, ...rest] = args;
  if (!["prepare", "run"].includes(command)) throw failure("USE_PREPARE_OR_RUN");
  const values = new Set(command === "prepare" ? ["--codex", "--cwd", "--receipt", "--title", "--history-mode"]
    : ["--receipt", "--prompt-file", "--node", "--turn-timeout-ms"]);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]; const value = rest[index + 1];
    if (!values.has(key) || !value || value.startsWith("--") || key in options) throw failure("INVALID_LAUNCHER_ARGUMENTS");
    options[key] = value;
  }
  if (!options["--receipt"] || (command === "prepare" && (!options["--codex"] || !options["--cwd"])) ||
      (command === "run" && !options["--prompt-file"])) throw failure("REQUIRED_LAUNCHER_ARGUMENT_MISSING");
  const timeoutText = options["--turn-timeout-ms"];
  const turnTimeoutMs = timeoutText == null ? undefined : Number(timeoutText);
  if (timeoutText != null && (!/^\d+$/.test(timeoutText) || !Number.isSafeInteger(turnTimeoutMs) ||
      turnTimeoutMs < 1 || turnTimeoutMs > WORKER_TURN_TIMEOUT_MS)) throw failure("INVALID_FIRST_TURN_LIMITS");
  return { command, cliPath: options["--codex"], cwd: options["--cwd"], receiptPath: options["--receipt"],
    title: options["--title"], historyMode: options["--history-mode"], promptPath: options["--prompt-file"], nodePath: options["--node"], turnTimeoutMs };
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  const main = async () => {
    const options = readWorkerLauncherArguments(process.argv.slice(2));
    const result = options.command === "prepare" ? await prepareCourseSupportWorker(options) : await runPreparedCourseSupportWorker(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  };
  main().catch((error) => {
    process.stderr.write(`${error.code ?? "WORKER_LAUNCH_FAILED"}; preserve the receipt and do not create a replacement automatically.\n`);
    process.exitCode = 1;
  });
}
