import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { courseSupportWorkerRuntimeEnvironment, resolveCourseSupportWorkerRuntime } from "./course-support-worker-runtime.mjs";

export const WORKER_PERMISSION_PROFILE = ":danger-full-access";
export const WORKER_RPC_TIMEOUT_MS = 40_000;
export const WORKER_TURN_TIMEOUT_MS = 24 * 60 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ASSIGNMENT_REF = /^course-assignment-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function failure(code) { return Object.assign(new Error(code), { code }); }
function classifiedFailure(code, stage, error) {
  const result = failure(code);
  result.failureStage = stage;
  result.failureErrno = typeof error?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(error.code) ? error.code : null;
  return result;
}
function absoluteFile(path) {
  if (typeof path !== "string" || !isAbsolute(path) || !statSync(path).isFile()) throw failure("ABSOLUTE_FILE_REQUIRED");
  return realpathSync(path);
}
function samePath(a, b) {
  const normalize = (path) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(a) === normalize(b);
}
export function privateWrite(path, value, exclusive = false) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) {
    try { return writeFileSync(path, text, { flag: "wx", mode: 0o600 }); }
    catch (error) { throw classifiedFailure("RECEIPT_WRITE_FAILED", "receipt_create", error); }
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { flag: "wx", mode: 0o600 }); }
  catch (error) { throw classifiedFailure("RECEIPT_WRITE_FAILED", "receipt_temporary", error); }
  try {
    for (let attempt = 0; attempt < 9; attempt++) {
      try { renameSync(temporary, path); return; }
      catch (error) {
        if (!["EPERM", "EBUSY"].includes(error?.code) || attempt === 8) {
          throw classifiedFailure("RECEIPT_WRITE_FAILED", "receipt_replace", error);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } finally { try { unlinkSync(temporary); } catch { /* Renamed or cleanup unavailable. */ } }
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
  if (!/^codex-cli 0\.160\.0$/.test(version)) throw failure("UNVERIFIED_CODEX_CLI_VERSION");
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
  let shutdownAt = null;
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
  child.on("close", () => { stopped = true; shutdownAt = new Date().toISOString(); fail(failure("APP_SERVER_CLOSED")); });
  child.stdin.on("error", () => fail(failure("APP_SERVER_INPUT_FAILED")));
  child.stderr.on("data", (chunk) => {
    try { appendFileSync(stderrPath, chunk, { mode: 0o600 }); }
    catch (error) { fail(classifiedFailure("PRIVATE_EVENT_LOG_FAILED", "stderr_append", error)); }
  });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch (error) { fail(classifiedFailure("INVALID_APP_SERVER_MESSAGE", "stdout_parse", error)); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      fail(classifiedFailure("INVALID_APP_SERVER_MESSAGE", "stdout_shape")); return;
    }
    try { appendFileSync(eventPath, `${JSON.stringify(message)}\n`, { mode: 0o600 }); }
    catch (error) { fail(classifiedFailure("PRIVATE_EVENT_LOG_FAILED", "event_append", error)); return; }
    try { onMessage(message); }
    catch (error) {
      fail(error?.code === "RECEIPT_WRITE_FAILED" ? error : classifiedFailure("APP_SERVER_MESSAGE_HANDLER_FAILED", "on_message", error));
      return;
    }
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
      child.stdin.end();
      if (!stopped) await new Promise((resolveClose) => {
        let afterKillTimer;
        const timer = setTimeout(() => {
          child.kill();
          afterKillTimer = setTimeout(resolveClose, 3_000);
        }, 3_000);
        child.once("close", () => {
          clearTimeout(timer); clearTimeout(afterKillTimer); resolveClose();
        });
      });
      if (stopped) reader.close();
      return { appServerShutdownConfirmed: stopped, appServerShutdownAt: shutdownAt };
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
  const { receiptPath, assignmentRef, title, historyMode = "legacy", clientFactory = createWorkerAppServer,
    inspectCheckout = assertOwnedWorkerCheckout, inspectCli = readWorkerCliVersion } = options;
  if (typeof receiptPath !== "string" || !isAbsolute(receiptPath) || !ASSIGNMENT_REF.test(assignmentRef ?? "") ||
      !["legacy", "paginated"].includes(historyMode)) throw failure("INVALID_PREPARE_OPTIONS");
  const cliPath = absoluteFile(options.cliPath);
  const checkout = inspectCheckout(options.cwd);
  const cliVersion = inspectCli(cliPath);
  const receipt = {
    schemaVersion: 1, status: "PREPARING", assignmentRef, threadId: null, ...checkout, cliPath, cliVersion,
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
    receipt.failureStage = error.failureStage ?? null;
    receipt.failureErrno = error.failureErrno ?? null;
    privateWrite(receiptPath, receipt); throw error;
  } finally { await client?.close(); }
}

export function readPreparedWorkerReceipt(receiptPath) {
  const path = absoluteFile(receiptPath);
  const bytes = readFileSync(path);
  const receipt = JSON.parse(bytes.toString("utf8"));
  if (receipt.schemaVersion !== 1 || receipt.status !== "PREPARED" ||
      !ASSIGNMENT_REF.test(receipt.assignmentRef ?? "") || !UUID.test(receipt.threadId ?? "") ||
      existsSync(`${path}.first-turn-started`) ||
      receipt.turnId != null || receipt.nativeIdentityVerified !== false || receipt.approvalRequests !== 0 ||
      receipt.approvalPolicy !== "never" || receipt.sandbox?.type !== "dangerFullAccess" ||
      receipt.activePermissionProfile?.id !== WORKER_PERMISSION_PROFILE) throw failure("UNUSED_PREPARED_RECEIPT_REQUIRED");
  return { assignmentRef: receipt.assignmentRef, childThreadId: receipt.threadId,
    preparedReceiptSha256: createHash("sha256").update(bytes).digest("hex") };
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
  const { receiptPath, promptPath, assignmentRef, clientFactory = createWorkerAppServer,
    inspectCheckout = assertOwnedWorkerCheckout, inspectCli = readWorkerCliVersion,
    turnTimeoutMs = WORKER_TURN_TIMEOUT_MS, nodePath = process.execPath } = options;
  const preparedBytes = readFileSync(absoluteFile(receiptPath));
  const receipt = JSON.parse(preparedBytes.toString("utf8"));
  if (receipt.schemaVersion !== 1 || receipt.status !== "PREPARED" || !UUID.test(receipt.threadId ?? "") ||
      !ASSIGNMENT_REF.test(assignmentRef ?? "") || receipt.assignmentRef !== assignmentRef ||
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
  const promptSha256 = createHash("sha256").update(prompt).digest("hex");
  const preparedReceiptSha256 = createHash("sha256").update(preparedBytes).digest("hex");
  const firstTurnStartedAt = new Date().toISOString();
  const markerBody = { schemaVersion: 1, assignmentRef, threadId: receipt.threadId,
    preparedReceiptSha256, promptSha256, firstTurnStartedAt };
  const markerPath = `${receiptPath}.first-turn-started`;
  privateWrite(markerPath, markerBody, true);
  receipt.status = "RUN_PREPARING"; receipt.launcherPid = process.pid;
  receipt.promptSha256 = promptSha256;
  receipt.preparedReceiptSha256 = preparedReceiptSha256;
  receipt.firstTurnStartedAt = firstTurnStartedAt;
  receipt.firstTurnMarkerSha256 = createHash("sha256").update(readFileSync(markerPath)).digest("hex");
  receipt.turnTerminalConfirmed = false;
  receipt.interruptAcknowledged = false;
  receipt.appServerShutdownConfirmed = false;
  privateWrite(receiptPath, receipt);
  let client;
  let fatal = null;
  let completed = null;
  let wake;
  const completion = new Promise((resolveCompletion) => { wake = resolveCompletion; });
  const interrupt = async () => {
    if (receipt.turnId) {
      try {
        await client?.request("turn/interrupt", { threadId: receipt.threadId, turnId: receipt.turnId });
        receipt.interruptAcknowledged = true;
        receipt.interruptAcknowledgedAt = new Date().toISOString();
        privateWrite(receiptPath, receipt);
      } catch { /* An unacknowledged interrupt cannot prove termination. */ }
    }
  };
  const timer = setTimeout(() => { fatal = failure("WORKER_TURN_TIMEOUT"); wake(); }, turnTimeoutMs);
  try {
    client = clientFactory({ ...receipt, onFailure(error) { fatal ??= error; wake(); }, onMessage(message) {
      if (isApprovalRequest(message)) {
        receipt.approvalRequests += 1; fatal = failure("UNEXPECTED_APPROVAL_REQUEST"); wake();
      }
      if (message.method === "turn/started" && message.params?.threadId === receipt.threadId) {
        if (typeof message.params?.turn?.id === "string" && message.params.turn.id && !receipt.turnId) {
          receipt.turnId = message.params.turn.id; receipt.status = "RUNNING"; privateWrite(receiptPath, receipt);
        }
      }
      const identity = message.params?.threadId === receipt.threadId && message.params?.turnId === receipt.turnId
        ? hasNativeIdentityProof(message) : null;
      if (identity === true && !receipt.nativeIdentityVerified) {
        receipt.nativeIdentityVerified = true; privateWrite(receiptPath, receipt);
      }
      if (identity === false) { fatal = failure("NATIVE_THREAD_IDENTITY_MISMATCH"); wake(); }
      if (message.method === "turn/completed" && message.params?.threadId === receipt.threadId &&
          message.params?.turn?.id === receipt.turnId &&
          ["completed", "failed", "interrupted"].includes(message.params?.turn?.status)) {
        completed = message.params.turn;
        receipt.turnTerminalConfirmed = true;
        receipt.turnCompletedAt = new Date().toISOString();
        receipt.turnStatus = completed.status ?? "unknown";
        privateWrite(receiptPath, receipt);
        wake();
      }
      if (isApprovalRequest(message)) privateWrite(receiptPath, receipt);
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
    await interrupt();
    receipt.status = receipt.turnTerminalConfirmed ? "STOPPED" : "STOP_UNCONFIRMED";
    receipt.stoppedAt = new Date().toISOString();
    receipt.failureCode = error.code ?? "WORKER_LAUNCH_FAILED";
    receipt.failureStage = error.failureStage ?? null;
    receipt.failureErrno = error.failureErrno ?? null;
    privateWrite(receiptPath, receipt); throw error;
  } finally {
    clearTimeout(timer);
    const closed = await client?.close();
    receipt.appServerShutdownConfirmed = closed?.appServerShutdownConfirmed === true;
    receipt.appServerShutdownAt = closed?.appServerShutdownAt ?? null;
    if (receipt.status === "STOP_UNCONFIRMED" && receipt.turnTerminalConfirmed) receipt.status = "STOPPED";
    privateWrite(receiptPath, receipt);
    if (receipt.turnTerminalConfirmed && receipt.appServerShutdownConfirmed) {
      privateWrite(`${receiptPath}.terminal.private.json`, {
        schemaVersion: 1, assignmentRef: receipt.assignmentRef, threadId: receipt.threadId,
        turnId: receipt.turnId, preparedReceiptSha256: receipt.preparedReceiptSha256,
        promptSha256: receipt.promptSha256,
        firstTurnMarkerSha256: receipt.firstTurnMarkerSha256,
        turnCompletedAt: receipt.turnCompletedAt,
        turnStatus: receipt.turnStatus,
        appServerShutdownAt: receipt.appServerShutdownAt,
      }, true);
    }
  }
}

export function readTerminalWorkerReceipt(receiptPath) {
  const path = absoluteFile(receiptPath);
  const bytes = readFileSync(path);
  const receipt = JSON.parse(bytes.toString("utf8"));
  const diagnostic = { outcome: "NOT_TERMINAL", assignmentRef: null, childThreadId: null };
  if (receipt.schemaVersion !== 1 || !ASSIGNMENT_REF.test(receipt.assignmentRef ?? "") || !UUID.test(receipt.threadId ?? "")) return diagnostic;
  const markerPath = `${path}.first-turn-started`;
  const terminalPath = `${path}.terminal.private.json`;
  let marker, terminal, markerBytes;
  try {
    markerBytes = readFileSync(markerPath);
    marker = JSON.parse(markerBytes.toString("utf8"));
    terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
  } catch { return diagnostic; }
  const markerSha = createHash("sha256").update(markerBytes).digest("hex");
  const firstTurnAt = Date.parse(marker.firstTurnStartedAt);
  const completedAt = Date.parse(receipt.turnCompletedAt);
  const shutdownAt = Date.parse(receipt.appServerShutdownAt);
  if (marker.schemaVersion !== 1 || marker.assignmentRef !== receipt.assignmentRef ||
      typeof receipt.eventPath !== "string" || !samePath(receipt.eventPath, `${path}.events.private.jsonl`) ||
      marker.threadId !== receipt.threadId || marker.promptSha256 !== receipt.promptSha256 ||
      marker.preparedReceiptSha256 !== receipt.preparedReceiptSha256 ||
      receipt.firstTurnMarkerSha256 !== markerSha || terminal.schemaVersion !== 1 ||
      terminal.assignmentRef !== receipt.assignmentRef || terminal.threadId !== receipt.threadId ||
      terminal.preparedReceiptSha256 !== receipt.preparedReceiptSha256 ||
      terminal.turnId !== receipt.turnId || terminal.promptSha256 !== receipt.promptSha256 ||
      terminal.firstTurnMarkerSha256 !== markerSha || terminal.turnCompletedAt !== receipt.turnCompletedAt ||
      terminal.turnStatus !== receipt.turnStatus || terminal.appServerShutdownAt !== receipt.appServerShutdownAt ||
      !receipt.turnTerminalConfirmed || !receipt.appServerShutdownConfirmed ||
      !receipt.turnCompletedAt || !receipt.appServerShutdownAt || !receipt.turnId ||
      !/^[a-f0-9]{64}$/i.test(receipt.preparedReceiptSha256 ?? "") ||
      !Number.isFinite(firstTurnAt) || !Number.isFinite(completedAt) || !Number.isFinite(shutdownAt) ||
      firstTurnAt > completedAt || completedAt > shutdownAt ||
      !["completed", "failed", "interrupted"].includes(receipt.turnStatus) ||
      !["STOPPED", "COMPLETED", "TURN_FAILED"].includes(receipt.status)) return diagnostic;
  // A mutually consistent receipt and marker are not enough. Require the
  // original app-server event log to contain this exact native terminal event.
  let nativeTerminalEvent = false;
  try {
    const eventPath = absoluteFile(receipt.eventPath);
    const size = statSync(eventPath).size;
    const length = Math.min(size, 2 * 1024 * 1024);
    const fd = openSync(eventPath, "r");
    const tail = Buffer.alloc(length);
    try { if (readSync(fd, tail, 0, length, size - length) !== length) return diagnostic; }
    finally { closeSync(fd); }
    const lines = tail.toString("utf8").split("\n");
    if (size > length) lines.shift(); // The first line may begin inside a JSON event.
    for (const line of lines) {
      if (!line || !line.includes('"turn/completed"')) continue;
      const event = JSON.parse(line);
      if (event.method === "turn/completed" && event.params?.threadId === receipt.threadId &&
          event.params?.turn?.id === receipt.turnId && event.params.turn.status === receipt.turnStatus) {
        nativeTerminalEvent = true; break;
      }
    }
  } catch { return diagnostic; }
  if (!nativeTerminalEvent) return diagnostic;
  return {
    outcome: "READY", assignmentRef: receipt.assignmentRef, childThreadId: receipt.threadId,
    turnId: receipt.turnId, firstTurnStartedAt: marker.firstTurnStartedAt,
    terminalAt: receipt.turnCompletedAt, terminationKind: "MATCHED_TURN_COMPLETED",
    receiptSha256: createHash("sha256").update(bytes).digest("hex"),
    preparedReceiptSha256: receipt.preparedReceiptSha256,
    promptSha256: receipt.promptSha256, firstTurnMarkerSha256: markerSha,
    turnStatus: receipt.turnStatus, appServerShutdownAt: receipt.appServerShutdownAt,
    nativeIdentityVerified: receipt.nativeIdentityVerified === true, approvalRequests: receipt.approvalRequests,
  };
}

export function readWorkerLauncherArguments(args) {
  const [command, ...rest] = args;
  if (!["prepare", "run"].includes(command)) throw failure("USE_PREPARE_OR_RUN");
  const values = new Set(command === "prepare" ? ["--codex", "--cwd", "--receipt", "--title", "--history-mode", "--assignment-ref"]
    : ["--receipt", "--prompt-file", "--node", "--turn-timeout-ms", "--assignment-ref"]);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]; const value = rest[index + 1];
    if (!values.has(key) || !value || value.startsWith("--") || key in options) throw failure("INVALID_LAUNCHER_ARGUMENTS");
    options[key] = value;
  }
  if (!options["--receipt"] || !ASSIGNMENT_REF.test(options["--assignment-ref"] ?? "") ||
      (command === "prepare" && (!options["--codex"] || !options["--cwd"])) ||
      (command === "run" && !options["--prompt-file"])) throw failure("REQUIRED_LAUNCHER_ARGUMENT_MISSING");
  const timeoutText = options["--turn-timeout-ms"];
  const turnTimeoutMs = timeoutText == null ? undefined : Number(timeoutText);
  if (timeoutText != null && (!/^\d+$/.test(timeoutText) || !Number.isSafeInteger(turnTimeoutMs) ||
      turnTimeoutMs < 1 || turnTimeoutMs > WORKER_TURN_TIMEOUT_MS)) throw failure("INVALID_FIRST_TURN_LIMITS");
  return { command, assignmentRef: options["--assignment-ref"], cliPath: options["--codex"], cwd: options["--cwd"], receiptPath: options["--receipt"],
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
