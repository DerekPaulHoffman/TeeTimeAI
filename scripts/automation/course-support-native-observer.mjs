import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKER_PERMISSION_PROFILE, assertFullAccessAcknowledgement, courseSupportWorkerAppServerEnvironment,
  createWorkerAppServer, isApprovalRequest, readWorkerCliVersion,
} from "./course-support-worker-launcher.mjs";

const QUALIFIED_CLI_VERSION = "codex-cli 0.160.1";
export const QUALIFIED_EXECUTABLE_DIGEST = "9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
function failure(code) { return Object.assign(new Error(code), { code }); }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
const OBSERVED_FLAGS = ["activeTurnId", "activeTurn", "pendingTurn", "pendingApproval", "approvalRequired", "needsAttention", "error",
  "approvalRequests", "approvalRequestCount", "pendingApprovalCount", "activeFlags", "attentionFlags", "pendingTurns", "pendingApprovals", "queuedMessages"];
function actualFields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("INVALID_READ_ONLY_RPC_RESULT");
  return Object.fromEntries(names.filter(name => Object.hasOwn(value, name)).map(name => [name, value[name]]));
}
function compactNativeResult(method, result) {
  const flags = actualFields(result, OBSERVED_FLAGS);
  if (method === "initialize") return { ...actualFields(result, ["userAgent", "platformFamily", "platformOs"]), ...flags };
  if (method === "permissionProfile/list") {
    if (!Array.isArray(result.data)) throw failure("INVALID_READ_ONLY_RPC_RESULT");
    return { ...flags, data: result.data.map(profile => actualFields(profile, ["id", "allowed"])) };
  }
  if (method === "thread/read") return { ...flags, thread: { ...actualFields(result.thread,
    ["id", "cwd", "updatedAt", "cliVersion", "ephemeral", ...OBSERVED_FLAGS]),
    status: actualFields(result.thread.status, ["type", ...OBSERVED_FLAGS]) } };
  if (method === "thread/turns/list") {
    if (!Array.isArray(result.data) || result.data.some(turn => !Array.isArray(turn.items) || turn.items.length !== 0)) {
      throw failure("UNEXPECTED_LOADED_NATIVE_TURN_ITEMS");
    }
    return { ...flags, ...actualFields(result, ["nextCursor", "backwardsCursor"]), data: result.data.map(turn => actualFields(turn,
      ["id", "status", "error", "itemsView", "items", "startedAt", "completedAt", "durationMs", ...OBSERVED_FLAGS])) };
  }
  throw failure("UNEXPECTED_NATIVE_OBSERVER_METHOD");
}
function sameCheckout(a, b) {
  const normalize = value => typeof value === "string" && win32.isAbsolute(value) && !value.startsWith("\\\\") &&
    !value.split(/[\\/]/u).includes("..") ? win32.normalize(value).replace(/[\\/]+$/u, "").toLowerCase() : null;
  const left = normalize(a); const right = normalize(b);
  return left !== null && left === right && /\\\.codex\\worktrees\\[^\\]+\\[^\\]+$/u.test(left);
}
export function observeOriginalProcess(pid, execute = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw failure("ORIGINAL_PROCESS_ID_REQUIRED");
  const script = "$taskProcess=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue; if($taskProcess){'present'}else{'absent'}";
  const state = execute("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
  if (!["absent", "present"].includes(state)) throw failure("ORIGINAL_PROCESS_STATE_UNAVAILABLE");
  return state;
}

/**
 * Creates only a read-only observer process, never an original-worker turn.
 * @param {{ receiptPath: string, observationPath: string, expectedThreadId: string, expectedCheckout: string,
 * clientFactory?: (options: any) => any, inspectProcess?: (pid: number) => string,
 * inspectCli?: (path: string) => string, readBytes?: (path: string) => Buffer,
 * clock?: () => Date, environmentFactory?: (cwd: string) => Record<string, string>,
 * inspectExecutableDigest?: (path: string) => string }} options
 * @returns {Promise<unknown>}
 */
export async function observeCourseSupportNativeCompletion({
  receiptPath, observationPath, expectedThreadId, expectedCheckout,
  terminalFailure = false,
  priorContinuationReceiptPath = null, expectedTerminalTurnId = null, expectedContinuationKey = null,
  clientFactory = createWorkerAppServer, inspectProcess = observeOriginalProcess,
  inspectCli = readWorkerCliVersion, readBytes = readFileSync, clock = () => new Date(),
  environmentFactory = courseSupportWorkerAppServerEnvironment,
  inspectExecutableDigest = path => digest(readBytes(path)),
}) {
  if (![receiptPath, observationPath, expectedCheckout].every(value => typeof value === "string" && isAbsolute(value)) ||
      resolve(receiptPath).toLowerCase() === resolve(observationPath).toLowerCase() || !UUID.test(expectedThreadId ?? "")) {
    throw failure("EXACT_ORIGINAL_OBSERVER_ARGUMENTS_REQUIRED");
  }
  if ([observationPath, observationPath + ".events.private.jsonl", observationPath + ".stderr.private.log"].some(existsSync)) {
    throw failure("NEW_PRIVATE_OBSERVATION_PATH_REQUIRED");
  }
  const originalBytes = readBytes(receiptPath);
  const original = JSON.parse(originalBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  if (original.schemaVersion !== 1 || (terminalFailure ?
      !["STOPPED", "COMPLETED"].includes(original.status) ||
      (original.status === "COMPLETED" && original.turnStatus !== "completed") || !UUID.test(original.turnId ?? "") :
      original.status !== "COMPLETED" || original.turnStatus !== "completed") ||
      original.threadId !== expectedThreadId || !sameCheckout(original.cwd, expectedCheckout) ||
      original.nativeIdentityVerified !== true || original.approvalRequests !== 0 || original.cliVersion !== QUALIFIED_CLI_VERSION ||
      !isAbsolute(original.cliPath ?? "")) throw failure("EXACT_TERMINAL_ORIGINAL_RECEIPT_REQUIRED");
  assertFullAccessAcknowledgement(original, expectedCheckout);
  let prior = null;
  if (priorContinuationReceiptPath) {
    if (!terminalFailure || !isAbsolute(priorContinuationReceiptPath) || !UUID.test(expectedTerminalTurnId ?? "") ||
        !/^[a-f0-9]{64}$/u.test(expectedContinuationKey ?? "")) throw failure("EXACT_PRIOR_CONTINUATION_REQUIRED");
    prior = JSON.parse(readBytes(priorContinuationReceiptPath).toString("utf8").replace(/^\uFEFF/u, ""));
    if (prior.schemaVersion !== 1 || !["STOPPED", "COMPLETED"].includes(prior.status) ||
        (prior.status === "COMPLETED" && prior.turnStatus !== "completed") ||
        prior.threadId !== original.threadId ||
        prior.turnId !== expectedTerminalTurnId || prior.continuationKey !== expectedContinuationKey ||
        prior.originalTurnId !== original.turnId && !UUID.test(prior.originalTurnId ?? "") ||
        prior.nativeIdentityVerified !== true || prior.approvalRequests !== 0 ||
        !Number.isSafeInteger(prior.runnerPid) || !Number.isSafeInteger(prior.serverPid)) {
      throw failure("PRIOR_CONTINUATION_RECEIPT_UNPROVED");
    }
  } else if (expectedTerminalTurnId || expectedContinuationKey) throw failure("EXACT_PRIOR_CONTINUATION_REQUIRED");
  const version = inspectCli(original.cliPath);
  const executableDigest = inspectExecutableDigest(original.cliPath);
  if (version !== original.cliVersion || executableDigest !== QUALIFIED_EXECUTABLE_DIGEST) throw failure("ORIGINAL_PINNED_CLI_CHANGED");
  const environment = environmentFactory(original.cwd);
  if (environment.CODEX_THREAD_ID || Object.keys(environment).some(key => /DATABASE_URL|RESEND|CLERK|GOOGLE|VERCEL|AUTOMATION_API_KEY|CRON_SECRET|EMAIL_ACTION_SECRET/iu.test(key))) {
    throw failure("PRODUCT_OR_NATIVE_IDENTITY_ENV_PRESENT");
  }
  const state = { version: 1, source: "original_codex_read_only_observer", phase: "INITIALIZE",
    ...(terminalFailure ? { terminalFailure: true } : {}),
    ...(prior ? { priorContinuationTurnId: expectedTerminalTurnId, priorContinuationKey: expectedContinuationKey,
      priorContinuationReceiptPath, priorContinuationReceiptDigestBefore: digest(readBytes(priorContinuationReceiptPath)) } : {}),
    observedAt: clock().toISOString(), threadId: original.threadId, cliVersion: version, cliExecutableDigest: executableDigest,
    launcherReceiptDigestBefore: digest(originalBytes), observerApprovalRequestCount: 0, rpcCalls: [] };
  const observeProcesses = () => {
    const processes = [original.launcherPid, original.serverPid, ...(prior ? [prior.runnerPid, prior.serverPid] : [])]
      .map(pid => ({ pid, state: inspectProcess(pid) }));
    if (new Set(processes.map(process => process.pid)).size !== processes.length ||
        processes.some(process => process.state !== "absent")) {
      throw failure("ORIGINAL_LAUNCHER_OR_SERVER_NOT_ENDED");
    }
    return { observedAt: clock().toISOString(), processes };
  };
  state.processObservationBefore = observeProcesses();
  mkdirSync(dirname(observationPath), { recursive: true, mode: 0o700 });
  // A new exclusive output prevents historical observations being overwritten.
  writeFileSync(observationPath, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  let client, fatal;
  const request = async (method, params) => {
    const result = await client.request(method, params);
    if (fatal) throw fatal;
    state.rpcCalls.push({ method, params, result: compactNativeResult(method, result) });
    return result;
  };
  try {
    client = clientFactory({ cliPath: original.cliPath, cwd: original.cwd, environment, timeoutMs: 30_000,
      eventPath: observationPath + ".events.private.jsonl", stderrPath: observationPath + ".stderr.private.log",
      onFailure(error) { fatal ??= error; }, onMessage(message) {
        if (isApprovalRequest(message)) {
          state.observerApprovalRequestCount += 1;
          fatal ??= failure("UNEXPECTED_OBSERVER_APPROVAL_REQUEST");
        }
      } });
    await request("initialize", { clientInfo: { name: "course_support_worker_launcher", version: "1.0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const profiles = await request("permissionProfile/list", { cwd: original.cwd });
    if (!profiles?.data?.some(profile => profile.id === WORKER_PERMISSION_PROFILE && profile.allowed === true)) throw failure("FULL_ACCESS_PROFILE_NOT_ALLOWED");
    const read = await request("thread/read", { threadId: original.threadId, includeTurns: false });
    if (read.thread?.id !== original.threadId || !sameCheckout(read.thread?.cwd, original.cwd)) throw failure("ORIGINAL_NATIVE_IDENTITY_MISMATCH");
    const page = await request("thread/turns/list", { threadId: original.threadId, limit: 1, itemsView: "notLoaded", sortDirection: "desc" });
    if (!Array.isArray(page?.data) || page.data.length !== 1 || (terminalFailure ?
        page.data[0]?.id !== (expectedTerminalTurnId ?? original.turnId) ||
        !["failed", "interrupted", "completed"].includes(page.data[0]?.status) ||
        (page.data[0]?.status === "completed" ? page.data[0]?.error !== null :
          (prior ? prior.status !== "STOPPED" : original.status !== "STOPPED")) :
        page.data[0]?.status !== "completed" || page.data[0]?.error !== null)) {
      throw failure("LATEST_DURABLE_TURN_NOT_TERMINAL");
    }
    state.launcherReceiptDigestAfter = digest(readBytes(receiptPath));
    if (prior) state.priorContinuationReceiptDigestAfter = digest(readBytes(priorContinuationReceiptPath));
    state.processObservationAfter = observeProcesses();
    if (state.launcherReceiptDigestBefore !== state.launcherReceiptDigestAfter || inspectExecutableDigest(original.cliPath) !== executableDigest) {
      throw failure("ORIGINAL_RECEIPT_OR_EXECUTABLE_CHANGED");
    }
    if (prior && state.priorContinuationReceiptDigestBefore !== state.priorContinuationReceiptDigestAfter) {
      throw failure("PRIOR_CONTINUATION_RECEIPT_CHANGED");
    }
    if (fatal) throw fatal;
    state.phase = "READ_ONLY_OBSERVATION_COMPLETE";
  } catch (error) {
    state.phase = "STOPPED"; state.errorCode = error.code ?? "NATIVE_READ_ONLY_OBSERVER_FAILED";
    throw error;
  } finally {
    await client?.close();
    if (fatal && state.phase === "READ_ONLY_OBSERVATION_COMPLETE") state.phase = "STOPPED";
    state.finishedAt = clock().toISOString();
    writeFileSync(observationPath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  }
  if (fatal) throw fatal;
  return state;
}

export function readNativeObserverArguments(args) {
  const names = new Set(["--receipt", "--observation", "--thread-id", "--checkout", "--terminal-failure",
    "--prior-continuation-receipt", "--expected-terminal-turn-id", "--expected-continuation-key"]);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!names.has(name) || !value || value.startsWith("--") || name in values) throw failure("INVALID_NATIVE_OBSERVER_ARGUMENTS");
    values[name] = value;
  }
  if (["--receipt", "--observation", "--thread-id", "--checkout"].some(name => !values[name]) ||
      (values["--terminal-failure"] !== undefined && values["--terminal-failure"] !== "true")) throw failure("REQUIRED_NATIVE_OBSERVER_ARGUMENT_MISSING");
  return { receiptPath: values["--receipt"], observationPath: values["--observation"], expectedThreadId: values["--thread-id"], expectedCheckout: values["--checkout"],
    terminalFailure: values["--terminal-failure"] === "true",
    priorContinuationReceiptPath: values["--prior-continuation-receipt"] ?? null,
    expectedTerminalTurnId: values["--expected-terminal-turn-id"] ?? null,
    expectedContinuationKey: values["--expected-continuation-key"] ?? null };
}
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  observeCourseSupportNativeCompletion(readNativeObserverArguments(process.argv.slice(2))).then(() => {
    process.stdout.write(JSON.stringify({ outcome: "read_only_observation_complete", privateReceiptWritten: true }) + "\n");
  }).catch(error => {
    process.stderr.write((error.code ?? "NATIVE_READ_ONLY_OBSERVER_FAILED") + "; preserve the original worker and receipts.\n");
    process.exitCode = 1;
  });
}
