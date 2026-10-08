import { createHash } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPinnedWorkerCli } from "./course-support-worker-cli.mjs";
import { approvedCourseSupportResponderCheckouts } from "./course-support-preflight.mjs";
import { WORKER_PERMISSION_PROFILE, assertFullAccessAcknowledgement, buildWorkerFirstTurnPrompt,
  createWorkerAppServer, hasNativeIdentityProof, isApprovalRequest, privateWrite, readWorkerCliVersion,
  retainPrimaryFailure } from "./course-support-worker-launcher.mjs";
import { courseSupportWorkerProductionCommand, courseSupportWorkerRuntimeEnvironment,
  resolveCourseSupportWorkerRuntime } from "./course-support-worker-runtime.mjs";
import { observeOriginalProcess, QUALIFIED_EXECUTABLE_DIGEST } from "./course-support-native-observer.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const SHA = /^[a-f0-9]{40}$/iu;
const DIGEST = /^[a-f0-9]{64}$/iu;
const SCRIPT = fileURLToPath(import.meta.url);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const readJson = path => { if (!isAbsolute(path) || !statSync(path).isFile()) fail("ABSOLUTE_PRIVATE_INPUT_REQUIRED"); return JSON.parse(readFileSync(path, "utf8")); };
const git = (cwd, args) => {
  const value = execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 40_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return args.includes("-z") ? value : value.trim();
};
function assertInactive(value, allowTerminalError = false) {
  if (!value || typeof value !== "object") fail("ORIGINAL_NATIVE_THREAD_NOT_INACTIVE");
  for (const key of ["activeTurnId", "activeTurn", "pendingTurn", "pendingApproval", "approvalRequired", "needsAttention", "error"]) {
    if (allowTerminalError && key === "error") continue;
    if (value[key] !== undefined && value[key] !== null && value[key] !== false) fail("ORIGINAL_NATIVE_THREAD_NOT_INACTIVE");
  }
  for (const key of ["approvalRequests", "approvalRequestCount", "pendingApprovalCount"]) {
    if (value[key] !== undefined && value[key] !== 0) fail("ORIGINAL_NATIVE_THREAD_NOT_INACTIVE");
  }
  for (const key of ["activeFlags", "attentionFlags", "pendingTurns", "pendingApprovals", "queuedMessages"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length)) fail("ORIGINAL_NATIVE_THREAD_NOT_INACTIVE");
  }
}

export function changedPaths(checkout, execute = git) {
  const porcelain = execute(checkout, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const entries = porcelain.split("\0").filter(Boolean);
  return entries.map(entry => {
    if (!/^[ MADRCU?!]{2} /u.test(entry) || /^[RC]/u.test(entry) || /^[RC]/u.test(entry.slice(1))) fail("UNKNOWN_OWNED_CHECKOUT_CHANGE");
    const path = entry.slice(3).replaceAll("\\", "/");
    if (!path || path.startsWith("/") || path.split("/").includes("..")) fail("UNKNOWN_OWNED_CHECKOUT_CHANGE");
    return path;
  });
}

function ownedChangeDigest(checkout, paths) {
  if (paths.length > 32) fail("OWNED_CHANGE_BOUND_EXCEEDED");
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    const file = resolve(checkout, path);
    if (!file.startsWith(resolve(checkout) + (process.platform === "win32" ? "\\" : "/"))) fail("UNKNOWN_OWNED_CHECKOUT_CHANGE");
    hash.update(path).update("\0");
    try {
      const size = statSync(file).size;
      if (size > 8_000_000) fail("OWNED_CHANGE_BOUND_EXCEEDED");
      hash.update(readFileSync(file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("<deleted>");
    }
  }
  return hash.digest("hex");
}

export function validateOriginalWorkerContinuation(input, dependencies = {}) {
  const { context, item, reservation, launcherReceiptPath, outputDir, parentThreadId } = input;
  const environment = dependencies.environment ?? process.env;
  if (!UUID.test(parentThreadId ?? "") || environment.CODEX_THREAD_ID !== parentThreadId) fail("NATIVE_PARENT_ID_MISMATCH");
  if (context?.kind !== "course_support_preflight_context" || context.exactHead !== true ||
      !isAbsolute(context.selectedCheckout ?? "") || context.workerCli?.status !== "current" ||
      !isAbsolute(context.workerCli.cliPath ?? "")) fail("CURRENT_PREFLIGHT_REQUIRED");
  const selected = realpathSync(context.selectedCheckout);
  if (!(dependencies.approvedCheckouts ?? approvedCourseSupportResponderCheckouts).some(path => {
    try { return same(realpathSync(path), selected); } catch { return false; }
  })) fail("UNAPPROVED_SELECTED_CHECKOUT");
  const approved = (dependencies.inspectCli ?? inspectPinnedWorkerCli)(selected);
  if (approved.status !== "current" || !same(approved.cliPath, context.workerCli.cliPath) ||
      approved.cliVersion !== context.workerCli.cliVersion) fail("PINNED_CLI_CONTEXT_CHANGED");
  const execute = dependencies.git ?? git;
  const head = execute(selected, ["rev-parse", "HEAD"]);
  if (!SHA.test(head) || head !== execute(selected, ["rev-parse", "origin/main"]) ||
      changedPaths(selected, execute).length) fail("SELECTED_CHECKOUT_CHANGED");
  if (item?.mode !== "SIMULATOR" || !UUID.test(item.threadId ?? "") ||
      !/^course-assignment-[a-f0-9-]+$/iu.test(item.assignmentRef ?? "") ||
      !UUID.test(item.claimToken ?? "") || !Number.isSafeInteger(item.claimRevision) || item.claimRevision < 1 ||
      !DIGEST.test(item.sourceFingerprint ?? "") || !SHA.test(item.baseSha ?? "") ||
      !/^automation\/course-support-[a-z0-9][a-z0-9-]*$/u.test(item.branch ?? "") ||
      !isAbsolute(item.launcherReceiptPath ?? "") || !same(item.launcherReceiptPath, launcherReceiptPath) ||
      !Array.isArray(item.plannedPaths) || item.plannedPaths.some(path => typeof path !== "string" || !path) ||
      item.checkpoint?.kind !== "EXPIRED_OWNED_STAGE" || item.checkpoint.claimLeaseExpired !== true ||
      item.checkpoint.ownedStage?.sourceFingerprint !== item.sourceFingerprint ||
      item.checkpoint.ownedStage?.branch !== item.branch ||
      JSON.stringify(item.checkpoint.ownedStage?.plannedPaths) !== JSON.stringify(item.plannedPaths) ||
      item.checkpoint.ownedStage?.releaseSha !== item.releaseSha ||
      item.threadId === parentThreadId) fail("ORIGINAL_OWNED_ITEM_REQUIRED");
  const response = reservation;
  if (response?.acquired !== true || response.value?.reserved !== true ||
      response.value.mode !== "SIMULATOR" || response.value.assignmentRef !== item.assignmentRef ||
      response.value.threadId !== item.threadId || response.value.scope !== "RESUME_ORIGINAL_OWNED_STAGE" ||
      !DIGEST.test(response.value.continuationKey ?? "")) fail("EXACT_CONTINUATION_RESERVATION_REQUIRED");
  const original = readJson(launcherReceiptPath);
  if (original.schemaVersion !== 1 || !["STOPPED", "COMPLETED"].includes(original.status) ||
      (original.status === "COMPLETED" && original.turnStatus !== "completed") || original.threadId !== item.threadId ||
      !UUID.test(original.turnId ?? "") || original.nativeIdentityVerified !== true || original.approvalRequests !== 0 ||
      original.approvalPolicy !== "never" || !isAbsolute(original.cwd ?? "") ||
      original.branch !== item.branch || original.baseSha !== item.baseSha ||
      original.cliVersion !== approved.cliVersion || !same(original.cliPath, approved.cliPath)) fail("ORIGINAL_STOPPED_RECEIPT_CHANGED");
  assertFullAccessAcknowledgement(original, original.cwd);
  const observeProcess = dependencies.observeProcess ?? observeOriginalProcess;
  if (!Number.isSafeInteger(original.launcherPid) || !Number.isSafeInteger(original.serverPid) ||
      original.launcherPid === original.serverPid || [original.launcherPid, original.serverPid].some(pid => observeProcess(pid) !== "absent")) {
    fail("ORIGINAL_LAUNCHER_OR_SERVER_NOT_ENDED");
  }
  const prior = item.expectedNativeContinuation;
  let priorStatus = null;
  let priorPids = [];
  if (prior !== null && prior !== undefined) {
    if (!UUID.test(prior.turnId ?? "") || !DIGEST.test(prior.key ?? "") || !isAbsolute(prior.receiptPath ?? "")) {
      fail("PRIOR_CONTINUATION_UNPROVED");
    }
    const priorReceipt = readJson(prior.receiptPath);
    if (priorReceipt.schemaVersion !== 1 || !["STOPPED", "COMPLETED"].includes(priorReceipt.status) ||
        (priorReceipt.status === "COMPLETED" && priorReceipt.turnStatus !== "completed") ||
        priorReceipt.threadId !== item.threadId || priorReceipt.turnId !== prior.turnId ||
        priorReceipt.continuationKey !== prior.key || priorReceipt.nativeIdentityVerified !== true ||
        priorReceipt.approvalRequests !== 0 || !Number.isSafeInteger(priorReceipt.runnerPid) ||
        !Number.isSafeInteger(priorReceipt.serverPid) ||
        [priorReceipt.runnerPid, priorReceipt.serverPid].some(pid => observeProcess(pid) !== "absent")) {
      fail("PRIOR_CONTINUATION_UNPROVED");
    }
    priorStatus = priorReceipt.status;
    priorPids = [priorReceipt.runnerPid, priorReceipt.serverPid];
  }
  const worker = realpathSync(original.cwd);
  if (same(worker, selected) || !same(execute(worker, ["rev-parse", "--show-toplevel"]), worker) ||
      execute(worker, ["branch", "--show-current"]) !== item.branch ||
      !same(realpathSync(resolve(worker, execute(worker, ["rev-parse", "--git-common-dir"]))),
        realpathSync(resolve(selected, execute(selected, ["rev-parse", "--git-common-dir"])))) ||
      execute(worker, ["merge-base", item.baseSha, head]) !== item.baseSha) fail("ORIGINAL_OWNED_CHECKOUT_CHANGED");
  const paths = changedPaths(worker, execute);
  if (paths.some(path => !item.plannedPaths.includes(path))) fail("UNKNOWN_OWNED_CHECKOUT_CHANGE");
  if (!isAbsolute(outputDir ?? "")) fail("PRIVATE_OUTPUT_REQUIRED");
  const output = realpathSync(outputDir);
  if (same(output, selected) || same(output, worker)) fail("PRIVATE_OUTPUT_REQUIRED");
  const runtime = (dependencies.runtime ?? resolveCourseSupportWorkerRuntime)();
  if (runtime.status !== "available") fail("CONTINUATION_RUNTIME_UNAVAILABLE");
  if ((dependencies.readCliVersion ?? readWorkerCliVersion)(approved.cliPath) !== original.cliVersion) fail("ORIGINAL_PINNED_CLI_CHANGED");
  if ((dependencies.readCliDigest ?? (path => createHash("sha256").update(readFileSync(path)).digest("hex")))(approved.cliPath) !==
      QUALIFIED_EXECUTABLE_DIGEST) fail("ORIGINAL_PINNED_CLI_CHANGED");
  return { selected, worker, output, head, item, original, priorStatus, priorPids,
    expectedTerminalTurnId: prior?.turnId ?? original.turnId,
    originalStatusDigest: ownedChangeDigest(worker, paths),
    runtime, approved, reservation: response.value, launcherReceiptPath };
}

export function originalWorkerContinuationPrompt(validated, read = readFileSync) {
  const template = read(join(validated.selected, "docs", "simulator-support-continuation-worker.md"), "utf8");
  const substitutions = { "<assignment-ref>": validated.item.assignmentRef, "<native-thread-id>": validated.item.threadId,
    "<selected-checkout>": validated.selected, "<continuation-scope>": validated.reservation.scope, "<tooling-sha>": validated.head };
  if (Object.keys(substitutions).some(key => !template.includes(key))) fail("INCOMPLETE_CONTINUATION_TEMPLATE");
  const prompt = Object.entries(substitutions).reduce((text, [key, value]) => text.replaceAll(key, value), template);
  if (/<(?:assignment-ref|native-thread-id|selected-checkout|continuation-scope|tooling-sha)>/u.test(prompt)) fail("UNFILLED_CONTINUATION_TEMPLATE");
  return `Original simulator claim token: ${validated.item.claimToken}; current revision at reservation: ${validated.item.claimRevision}. Independently inspect the exact current assignment and recover only this token/revision under the normal DB-time lease gates. Preserve registered paths, release SHA, deployment and recheck provenance.\n\n${prompt}`;
}

function productionContinued(validated, receiptFile, dependencies) {
  const command = courseSupportWorkerProductionCommand(validated.runtime, "automation:course-dispatch",
    ["continued", "--assignment-ref", validated.item.assignmentRef, "--receipt-file", receiptFile]);
  const result = (dependencies.spawnSync ?? spawnSync)(command.command, command.args, {
    cwd: validated.selected, shell: false, windowsHide: true, encoding: "utf8", timeout: 180_000,
    env: courseSupportWorkerRuntimeEnvironment(validated.runtime, validated.selected, process.env),
  });
  writeFileSync(join(validated.output, "continued.private.log"), `${result.stdout ?? ""}\n${result.stderr ?? ""}`, { flag: "wx", mode: 0o600 });
  if (result.status !== 0) fail("CONTINUATION_ACKNOWLEDGEMENT_FAILED");
  const responses = (result.stdout ?? "").trim().split(/\r?\n/u).flatMap(line => {
    try { const value = JSON.parse(line); return typeof value?.acquired === "boolean" ? [value] : []; } catch { return []; }
  });
  if (responses.length !== 1 || responses[0].acquired !== true ||
      responses[0].value?.assignmentRef !== validated.item.assignmentRef ||
      responses[0].value?.threadId !== validated.item.threadId ||
      responses[0].value?.outcome !== "same_worker_message_recorded") fail("CONTINUATION_ACKNOWLEDGEMENT_UNPROVED");
}

/** Exclusive marker and PENDING database receipt make a transport ambiguity non-replayable. */
export async function runOriginalWorkerContinuation(input, dependencies = {}) {
  const validated = (dependencies.validate ?? validateOriginalWorkerContinuation)(input, dependencies);
  const prompt = buildWorkerFirstTurnPrompt(originalWorkerContinuationPrompt(validated, dependencies.readFile),
    validated.item.threadId, validated.runtime.nodePath);
  if (Buffer.byteLength(prompt) > 256_000) fail("CONTINUATION_PROMPT_TOO_LARGE");
  closeSync(openSync(join(validated.output, "continuation.started.private"), "wx", 0o600));
  const receiptPath = join(validated.output, "continuation.receipt.private.json");
  const sendPath = join(validated.output, "continuation.sent.private.json");
  const receipt = { schemaVersion: 1, status: "INITIALIZING", assignmentRef: validated.item.assignmentRef,
    threadId: validated.item.threadId, scope: validated.reservation.scope,
    originalTurnId: validated.expectedTerminalTurnId ?? validated.original.turnId,
    runnerPid: process.pid,
    originalStatusDigest: validated.originalStatusDigest, continuationKey: validated.reservation.continuationKey,
    approvalRequests: 0, nativeIdentityVerified: false, createdAt: new Date().toISOString() };
  const save = () => privateWrite(receiptPath, receipt, false, dependencies.receiptIo);
  privateWrite(receiptPath, receipt, true, dependencies.receiptIo);
  let client, fatal = null, completed = null, wake;
  const completion = new Promise(resolveCompletion => { wake = resolveCompletion; });
  const timer = setTimeout(() => { fatal ??= Object.assign(new Error("CONTINUATION_TURN_TIMEOUT"), { code: "CONTINUATION_TURN_TIMEOUT" }); wake(); }, 24 * 60 * 60_000);
  try {
    const environment = dependencies.environment ?? process.env;
    client = (dependencies.clientFactory ?? createWorkerAppServer)({ cliPath: validated.approved.cliPath, cwd: validated.worker,
      eventPath: join(validated.output, "continuation.events.private.jsonl"), stderrPath: join(validated.output, "continuation.stderr.private.log"),
      onFailure(error) { fatal ??= error; wake(); }, onMessage(message) {
        let changed = false;
        if (isApprovalRequest(message)) { receipt.approvalRequests += 1; fatal ??= Object.assign(new Error("UNEXPECTED_APPROVAL_REQUEST"), { code: "UNEXPECTED_APPROVAL_REQUEST" }); wake(); changed = true; }
        if (message.method === "turn/started" && message.params?.threadId === receipt.threadId) {
          receipt.turnId = message.params.turn.id; changed = true;
        }
        const identity = message.params?.threadId === receipt.threadId && message.params?.turnId === receipt.turnId ? hasNativeIdentityProof(message) : null;
        if (identity === true) { receipt.nativeIdentityVerified = true; changed = true; }
        if (identity === false) { fatal ??= Object.assign(new Error("NATIVE_THREAD_IDENTITY_MISMATCH"), { code: "NATIVE_THREAD_IDENTITY_MISMATCH" }); wake(); }
        if (message.method === "turn/completed" && message.params?.threadId === receipt.threadId && message.params?.turn?.id === receipt.turnId) {
          completed = message.params.turn; wake();
        }
        if (changed) save();
      }, environment: (() => {
        const result = courseSupportWorkerRuntimeEnvironment(validated.runtime, validated.worker, environment);
        for (const name of ["CODEX_HOME", "HOME", "HOMEDRIVE", "HOMEPATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ"]) {
          if (typeof environment[name] === "string") result[name] = environment[name];
        }
        delete result.CODEX_THREAD_ID; return result;
      })() });
    receipt.serverPid = client.pid; save();
    await client.request("initialize", { clientInfo: { name: "course_support_worker_launcher", version: "1.0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const profiles = await client.request("permissionProfile/list", { cwd: validated.worker });
    if (!profiles?.data?.some(profile => profile.id === WORKER_PERMISSION_PROFILE && profile.allowed === true)) fail("FULL_ACCESS_PROFILE_NOT_ALLOWED");
    const read = await client.request("thread/read", { threadId: receipt.threadId, includeTurns: false });
    if (read.thread?.id !== receipt.threadId || !same(read.thread?.cwd ?? "", validated.worker) ||
        !["idle", "notLoaded"].includes(read.thread?.status?.type)) fail("ORIGINAL_NATIVE_THREAD_NOT_INACTIVE");
    for (const value of [read, read.thread, read.thread.status]) assertInactive(value);
    const turns = await client.request("thread/turns/list", { threadId: receipt.threadId, limit: 1, itemsView: "notLoaded", sortDirection: "desc" });
    if (turns?.data?.length !== 1 || turns.data[0]?.id !== receipt.originalTurnId ||
        !["failed", "interrupted", "completed"].includes(turns.data[0]?.status) ||
        (turns.data[0].status === "completed" ? turns.data[0].error !== null :
          (validated.item.expectedNativeContinuation ? validated.priorStatus !== "STOPPED" : validated.original.status !== "STOPPED"))) {
      fail("ORIGINAL_NATIVE_TERMINAL_TURN_CHANGED");
    }
    assertInactive(turns); assertInactive(turns.data[0], true);
    const resumed = await client.request("thread/resume", { threadId: receipt.threadId, cwd: validated.worker,
      approvalPolicy: "never", permissions: WORKER_PERMISSION_PROFILE, runtimeWorkspaceRoots: [validated.worker] });
    assertFullAccessAcknowledgement(resumed, validated.worker);
    if (resumed.thread?.id !== receipt.threadId || !["idle", "notLoaded"].includes(resumed.thread?.status?.type)) fail("ORIGINAL_NATIVE_IDENTITY_CHANGED");
    for (const value of [resumed, resumed.thread, resumed.thread.status]) assertInactive(value);
    const currentPaths = changedPaths(validated.worker, dependencies.git ?? git);
    if (currentPaths.some(path => !validated.item.plannedPaths.includes(path)) ||
        ownedChangeDigest(validated.worker, currentPaths) !== validated.originalStatusDigest) fail("UNKNOWN_OWNED_CHECKOUT_CHANGE");
    if ([validated.original.launcherPid, validated.original.serverPid, ...(validated.priorPids ?? [])]
      .some(pid => (dependencies.observeProcess ?? observeOriginalProcess)(pid) !== "absent")) fail("ORIGINAL_LAUNCHER_OR_SERVER_NOT_ENDED");
    receipt.status = "TURN_STARTING"; save();
    const started = await client.request("turn/start", { threadId: receipt.threadId, input: [{ type: "text", text: prompt }],
      cwd: validated.worker, approvalPolicy: "never", permissions: WORKER_PERMISSION_PROFILE,
      runtimeWorkspaceRoots: [validated.worker], turnTrigger: "course_support_assigned_worker" });
    if (!UUID.test(started?.turn?.id ?? "") || (receipt.turnId && receipt.turnId !== started.turn.id)) fail("CONTINUATION_TURN_ID_NOT_ACKNOWLEDGED");
    receipt.turnId = started.turn.id; receipt.status = "TURN_ACCEPTED"; save();
    const send = { continuationKey: validated.reservation.continuationKey, childThreadId: receipt.threadId,
      toolReceipt: { source: "codex_native.turn_start", threadId: receipt.threadId, turnId: receipt.turnId,
        receiptPath, accepted: true } };
    privateWrite(sendPath, send, true, dependencies.receiptIo);
    (dependencies.acknowledge ?? productionContinued)(validated, sendPath, dependencies);
    receipt.status = "SENT"; save();
    await completion;
    if (fatal) throw fatal;
    if (!receipt.nativeIdentityVerified || receipt.approvalRequests !== 0) fail("NATIVE_CONTINUATION_IDENTITY_UNPROVED");
    receipt.status = completed?.status === "completed" ? "COMPLETED" : "TURN_FAILED";
    receipt.turnStatus = completed?.status ?? "unknown"; receipt.completedAt = new Date().toISOString(); save();
    if (receipt.status !== "COMPLETED") fail("CONTINUATION_TURN_DID_NOT_COMPLETE");
    return { outcome: "completed", receiptPath, threadId: receipt.threadId };
  } catch (error) {
    if (receipt.turnId) await client?.request("turn/interrupt", { threadId: receipt.threadId, turnId: receipt.turnId }).catch(() => {});
    receipt.status = "STOPPED"; receipt.failureCode = error.code ?? "CONTINUATION_FAILED";
    try { save(); } catch (diagnosticError) { retainPrimaryFailure(error, diagnosticError); }
    throw error;
  } finally { clearTimeout(timer); await client?.close(); }
}

export function readContinuationArguments(args) {
  const detach = args[0] === "--detach";
  if (detach) args = args.slice(1);
  const names = ["--context-file", "--item-file", "--reservation-file", "--launcher-receipt", "--output-dir"];
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!names.includes(args[i]) || !args[i + 1] || values[args[i]]) fail("INVALID_CONTINUATION_ARGUMENTS");
    values[args[i]] = args[i + 1];
  }
  if (names.some(name => !values[name])) fail("REQUIRED_CONTINUATION_ARGUMENT_MISSING");
  return { detach, values };
}

if (process.argv[1] && same(SCRIPT, process.argv[1])) {
  (async () => {
    const { detach, values } = readContinuationArguments(process.argv.slice(2));
    const outputDir = values["--output-dir"];
    if (!isAbsolute(outputDir)) fail("PRIVATE_OUTPUT_REQUIRED");
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const input = { context: readJson(values["--context-file"]), item: readJson(values["--item-file"]),
      reservation: readJson(values["--reservation-file"]), launcherReceiptPath: values["--launcher-receipt"],
      outputDir, parentThreadId: process.env.CODEX_THREAD_ID };
    if (detach) {
      const validated = validateOriginalWorkerContinuation(input);
      const marker = join(outputDir, "continuation.dispatch.private"); closeSync(openSync(marker, "wx", 0o600));
      const stdout = openSync(join(outputDir, "continuation.stdout.private.log"), "wx", 0o600);
      const stderr = openSync(join(outputDir, "continuation.launch.stderr.private.log"), "wx", 0o600);
      const environment = courseSupportWorkerRuntimeEnvironment(validated.runtime, validated.selected, process.env);
      for (const name of ["CODEX_HOME", "HOME", "HOMEDRIVE", "HOMEPATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ"]) {
        if (typeof process.env[name] === "string") environment[name] = process.env[name];
      }
      const child = spawn(process.execPath, [SCRIPT, ...Object.entries(values).flat()], { cwd: validated.selected,
        env: environment, detached: true, windowsHide: true, shell: false, stdio: ["ignore", stdout, stderr] });
      await new Promise((resolveSpawn, rejectSpawn) => { child.once("spawn", resolveSpawn); child.once("error", rejectSpawn); });
      closeSync(stdout); closeSync(stderr); child.unref();
      process.stdout.write(JSON.stringify({ outcome: "dispatched", pid: child.pid, privateMarker: marker }) + "\n");
    } else {
      const result = await runOriginalWorkerContinuation(input);
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  })().catch(error => { process.stderr.write(`${error.code ?? "CONTINUATION_FAILED"}; preserve original ownership and receipts.\n`); process.exitCode = 1; });
}
