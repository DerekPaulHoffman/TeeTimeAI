import { createHash, randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPinnedWorkerCli } from "./course-support-worker-cli.mjs";
import { approvedCourseSupportResponderCheckouts } from "./course-support-preflight.mjs";
import { assertOwnedWorkerCheckout, prepareCourseSupportWorker, runPreparedCourseSupportWorker } from "./course-support-worker-launcher.mjs";
import { courseSupportWorkerProductionCommand, courseSupportWorkerRuntimeEnvironment, resolveCourseSupportWorkerRuntime } from "./course-support-worker-runtime.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const scriptPath = fileURLToPath(import.meta.url);
const same = (a, b) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

function privateJson(path, value, exclusive = false) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) return writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function readJson(path) {
  if (!isAbsolute(path) || !statSync(path).isFile()) fail("ABSOLUTE_PRIVATE_INPUT_REQUIRED");
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(checkout, args) {
  return execFileSync("git", args, { cwd: checkout, encoding: "utf8", windowsHide: true, timeout: 40_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
}

export function validateSupervisorInput(input, dependencies = {}) {
  const { context, assignment, workerCheckout, outputDir, parentThreadId } = input;
  if (!UUID.test(parentThreadId ?? "")) fail("NATIVE_PARENT_ID_REQUIRED");
  if ((dependencies.environment ?? process.env).CODEX_THREAD_ID !== parentThreadId) fail("NATIVE_PARENT_ID_MISMATCH");
  if (context?.kind !== "course_support_preflight_context" || context.exactHead !== true ||
      context.workerCli?.status !== "current" || !isAbsolute(context.selectedCheckout ?? "") ||
      !isAbsolute(context.workerCli.cliPath ?? "")) fail("INVALID_PREFLIGHT_CONTEXT");
  if (assignment?.state !== "RESERVED" ||
      !/^course-assignment-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(assignment.assignmentRef ?? "") ||
      ![undefined, "SIMULATOR"].includes(assignment.mode)) fail("RESERVED_ASSIGNMENT_REQUIRED");
  if (!isAbsolute(workerCheckout ?? "") || !isAbsolute(outputDir ?? "")) fail("ABSOLUTE_WORKER_PATHS_REQUIRED");
  const selected = realpathSync(context.selectedCheckout);
  const worker = realpathSync(workerCheckout);
  const output = realpathSync(outputDir);
  if (!(dependencies.approvedCheckouts ?? approvedCourseSupportResponderCheckouts)
    .some((path) => { try { return same(realpathSync(path), selected); } catch { return false; } })) fail("UNAPPROVED_SELECTED_CHECKOUT");
  if (same(selected, worker) || same(output, selected) || same(output, worker)) fail("SEPARATE_PRIVATE_PATHS_REQUIRED");
  const approved = (dependencies.inspectCli ?? inspectPinnedWorkerCli)(selected);
  if (approved.status !== "current" || !same(approved.cliPath, context.workerCli.cliPath) ||
      approved.cliVersion !== context.workerCli.cliVersion) fail("PINNED_CLI_CONTEXT_CHANGED");
  const selectedHead = (dependencies.git ?? git)(selected, ["rev-parse", "HEAD"]);
  const selectedMain = (dependencies.git ?? git)(selected, ["rev-parse", "origin/main"]);
  if (!SHA.test(selectedHead) || selectedHead !== selectedMain ||
      (dependencies.git ?? git)(selected, ["status", "--porcelain"])) fail("SELECTED_CHECKOUT_CHANGED");
  const owned = (dependencies.inspectWorker ?? assertOwnedWorkerCheckout)(worker, selected);
  if (owned.baseSha !== selectedHead || !/^automation\/course-support-[a-z0-9][a-z0-9-]*$/.test(owned.branch)) fail("WORKER_BASE_CHANGED");
  const binding = readJson(join(selected, ".vercel", "project.json"));
  if (typeof binding.projectId !== "string" || !binding.projectId ||
      typeof binding.orgId !== "string" || !binding.orgId) fail("SELECTED_PROJECT_BINDING_REQUIRED");
  const runtime = (dependencies.resolveRuntime ?? resolveCourseSupportWorkerRuntime)();
  if (runtime.status !== "available" || !isAbsolute(runtime.nodePath) || !isAbsolute(runtime.npmCliPath)) fail("PARENT_RUNTIME_UNAVAILABLE");
  return { selected, worker, output, approved, owned, runtime, baseSha: selectedHead,
    assignmentRef: assignment.assignmentRef, mode: assignment.mode ?? "OUTDOOR", parentThreadId };
}

export function workerInstructions(mode, selected, assignmentRef, dependencies = {}) {
  const name = mode === "SIMULATOR" ? "simulator-support-assigned-worker.md" : "course-support-assigned-worker.md";
  const template = (dependencies.readFile ?? readFileSync)(join(selected, "docs", name), "utf8");
  if (!template.includes("<assignment-ref>") || !template.includes("<selected-checkout>")) fail("INCOMPLETE_WORKER_TEMPLATE");
  const result = template.replaceAll("<assignment-ref>", assignmentRef).replaceAll("<selected-checkout>", selected);
  if (result.includes("<assignment-ref>") || result.includes("<selected-checkout>")) fail("UNFILLED_WORKER_TEMPLATE");
  return result;
}

function productionDispatch(stage, args, validated, dependencies) {
  const command = courseSupportWorkerProductionCommand(validated.runtime, "automation:course-dispatch", args);
  const result = (dependencies.spawn ?? spawnSync)(command.command, command.args, {
    cwd: validated.selected, shell: false, windowsHide: true, encoding: "utf8", timeout: 180_000,
    env: courseSupportWorkerRuntimeEnvironment(validated.runtime, validated.selected, process.env),
  });
  const log = join(validated.output, `${stage}.private.log`);
  writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`, { flag: "wx", mode: 0o600 });
  if (result.status !== 0) fail(`DISPATCH_${stage.toUpperCase()}_FAILED`);
  const lines = (result.stdout ?? "").trim().split(/\r?\n/u);
  const responses = lines.flatMap((line) => {
    try { const parsed = JSON.parse(line); return typeof parsed?.acquired === "boolean" ? [parsed] : []; }
    catch { return []; }
  });
  if (responses.length !== 1) fail(`DISPATCH_${stage.toUpperCase()}_PROOF_MISSING`);
  const response = responses[0];
  if (response.acquired !== true || response.value?.assignmentRef !== validated.assignmentRef ||
      response.value?.state !== (stage === "start" ? "STARTING" : "BOUND") ||
      response.value?.baseSha !== validated.baseSha) {
    fail(`DISPATCH_${stage.toUpperCase()}_PROOF_MISMATCH`);
  }
  return response.value;
}

/** One invocation owns one durable assignment. An unknown creation is never replayed. */
export async function superviseCourseSupportWorker(input, dependencies = {}) {
  const validated = validateSupervisorInput(input, dependencies);
  const prompt = workerInstructions(validated.mode, validated.selected, validated.assignmentRef, dependencies);
  const marker = join(validated.output, "supervisor.started.private");
  closeSync(openSync(marker, "wx", 0o600));
  const receiptPath = join(validated.output, "supervisor.receipt.private.json");
  const launcherReceiptPath = join(validated.output, "launcher.receipt.private.json");
  const promptPath = join(validated.output, "worker.prompt.private.md");
  const receipt = { schemaVersion: 1, assignmentRef: validated.assignmentRef, mode: validated.mode,
    parentThreadId: validated.parentThreadId, selectedCheckout: validated.selected,
    workerCheckout: validated.worker, baseSha: validated.baseSha, workerBranch: validated.owned.branch,
    status: "VALIDATED", createdAt: new Date().toISOString() };
  privateJson(receiptPath, receipt, true);
  const save = (status, extra = {}) => { Object.assign(receipt, extra, { status, updatedAt: new Date().toISOString() }); privateJson(receiptPath, receipt); };
  try {
    save("START_REQUESTED");
    productionDispatch("start", ["start", "--assignment-ref", validated.assignmentRef], validated, dependencies);
    save("STARTING");
    save("PREPARE_REQUESTED");
    const prepared = await (dependencies.prepare ?? prepareCourseSupportWorker)({
      cliPath: validated.approved.cliPath, cwd: validated.worker, receiptPath: launcherReceiptPath,
      title: validated.mode === "SIMULATOR" ? "Resolve assigned simulator" : "Resolve assigned course",
    });
    if (prepared?.outcome !== "prepared" || !UUID.test(prepared.threadId ?? "") ||
        !same(prepared.receiptPath ?? "", launcherReceiptPath)) fail("NATIVE_PREPARATION_PROOF_MISSING");
    const launchReceipt = readJson(launcherReceiptPath);
    if (launchReceipt.status !== "PREPARED" || launchReceipt.threadId !== prepared.threadId ||
        launchReceipt.approvalPolicy !== "never" || launchReceipt.sandbox?.type !== "dangerFullAccess" ||
        launchReceipt.activePermissionProfile?.id !== ":danger-full-access" ||
        !same(launchReceipt.cwd ?? "", validated.worker)) fail("NATIVE_PREPARATION_PROOF_MISMATCH");
    save("PREPARED", { childThreadId: prepared.threadId });
    save("BIND_REQUESTED");
    productionDispatch("bind", ["bind", "--assignment-ref", validated.assignmentRef,
      "--child-thread", prepared.threadId], validated, dependencies);
    save("BOUND");
    writeFileSync(promptPath, prompt, { flag: "wx", mode: 0o600 });
    save("TURN_REQUESTED", { promptSha256: createHash("sha256").update(prompt).digest("hex") });
    const result = await (dependencies.run ?? runPreparedCourseSupportWorker)({
      receiptPath: launcherReceiptPath, promptPath, nodePath: validated.runtime.nodePath,
    });
    if (result?.outcome !== "completed" || result.nativeIdentityVerified !== true || result.approvalRequests !== 0) {
      fail("WORKER_TURN_PROOF_MISSING");
    }
    save("COMPLETED");
    return { outcome: "completed", receiptPath, launcherReceiptPath, childThreadId: prepared.threadId };
  } catch (error) {
    save("ATTENTION", { failedAt: receipt.status, failureCode: error.code ?? "SUPERVISOR_FAILED" });
    throw error;
  }
}

export function readSupervisorArguments(args) {
  const values = {};
  const names = new Set(["--context-file", "--assignment-file", "--worker-checkout", "--output-dir"]);
  for (let i = 0; i < args.length; i += 2) {
    if (!names.has(args[i]) || !args[i + 1] || args[i] in values) fail("INVALID_SUPERVISOR_ARGUMENTS");
    values[args[i]] = args[i + 1];
  }
  if (Object.keys(values).length !== names.size) fail("REQUIRED_SUPERVISOR_ARGUMENT_MISSING");
  return values;
}

if (process.argv[1] && same(scriptPath, process.argv[1])) {
  (async () => {
    const args = readSupervisorArguments(process.argv.slice(2));
    const outputDir = args["--output-dir"];
    if (!isAbsolute(outputDir)) fail("ABSOLUTE_OUTPUT_DIR_REQUIRED");
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const result = await superviseCourseSupportWorker({
      context: readJson(args["--context-file"]), assignment: readJson(args["--assignment-file"]),
      workerCheckout: args["--worker-checkout"], outputDir, parentThreadId: process.env.CODEX_THREAD_ID,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })().catch((error) => {
    process.stderr.write(`${error.code ?? "SUPERVISOR_FAILED"}; preserve the private receipt and assignment ownership.\n`);
    process.exitCode = 1;
  });
}
