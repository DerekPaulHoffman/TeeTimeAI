import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectGeneratedPrismaClient,
  inspectPlaywrightChromiumRuntime
} from "./course-support-preflight.mjs";

// Windows npm.cmd can redirect to the roaming global prefix. Invoke the actual
// CLI with a known Node executable, including when this module runs on bundled Node.
export function resolveCourseSupportWorkerRuntime({
  platform = process.platform,
  execPath = process.execPath,
  environment = process.env,
  exists = existsSync
} = {}) {
  if (platform !== "win32") return { status: "unsupported_platform" };
  const installed = win32.join(environment.ProgramFiles || "C:\\Program Files", "nodejs");
  const npmCliPath = win32.join(installed, "node_modules", "npm", "bin", "npm-cli.js");
  if (!exists(npmCliPath)) return { status: "npm_cli_unavailable" };
  const installedNode = win32.join(installed, "node.exe");
  const nodePath = [installedNode, execPath].find((candidate) => candidate && exists(candidate));
  return nodePath
    ? { status: "available", nodePath, npmCliPath, source: nodePath === installedNode ? "installed_node" : "current_node" }
    : { status: "node_unavailable" };
}

function setupEnvironment(environment) {
  const allowed = ["SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "PATHEXT", "PATH", "CODEX_THREAD_ID"];
  const names = new Map(allowed.map((key) => [key.toLowerCase(), key]));
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    const name = names.get(key.toLowerCase());
    if (name && typeof value === "string") result[name] = value;
  }
  return result;
}

export function courseSupportWorkerRuntimeEnvironment(runtime, checkout, environment = process.env) {
  if (runtime.status !== "available") throw new Error("WORKER_RUNTIME_UNAVAILABLE");
  const result = setupEnvironment(environment);
  result.PATH = `${win32.dirname(runtime.nodePath)};${result.PATH || ""}`;
  result.npm_config_cache = resolve(checkout, ".codex-artifacts", "npm-cache");
  result.npm_config_prefix = resolve(checkout, ".codex-artifacts", "npm-prefix");
  return result;
}

export function courseSupportWorkerNpmCommand(runtime, args) {
  if (runtime.status !== "available") throw new Error("WORKER_RUNTIME_UNAVAILABLE");
  return { command: runtime.nodePath, args: [runtime.npmCliPath, ...args] };
}

export const courseSupportWorkerVercelPackage = "vercel@62.2.0";
const productionScripts = new Set(["automation:course-support", "automation:course-dispatch", "automation:simulator-support", "deployment:wait"]);

export function courseSupportWorkerProductionCommand(runtime, script, args = []) {
  if (!productionScripts.has(script) || !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("INVALID_WORKER_PRODUCTION_COMMAND");
  return courseSupportWorkerNpmCommand(runtime, [
    "exec", "--yes", `--package=${courseSupportWorkerVercelPackage}`, "--", "vercel", "env", "run", "-e", "production", "--",
    runtime.nodePath, runtime.npmCliPath, "run", script, "--", ...args
  ]);
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", windowsHide: true, shell: false,
    stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, ...options
  });
  return { status: result.status, stdout: result.stdout || "" };
}

function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function samePath(left, right) {
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isPrivateWorkerPath(checkout, candidate) {
  const root = canonical(checkout);
  const tail = relative(root, canonical(candidate));
  if (tail === ".." || tail.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(tail)) return false;
  try { return !lstatSync(candidate).isSymbolicLink(); } catch { return !existsSync(candidate); }
}

function readBinding(checkout) {
  try {
    const value = JSON.parse(readFileSync(resolve(checkout, ".vercel", "project.json"), "utf8"));
    return typeof value.projectId === "string" && value.projectId && typeof value.orgId === "string" && value.orgId
      ? { projectId: value.projectId, orgId: value.orgId } : null;
  } catch { return null; }
}

function inspectBrowserFiles(checkout) {
  try {
    const require = createRequire(resolve(checkout, "package.json"));
    const playwright = require("@playwright/test");
    return { moduleAvailable: true, executableAvailable: existsSync(playwright.chromium.executablePath()), smoke: "not_run" };
  } catch {
    return { moduleAvailable: false, executableAvailable: false, smoke: "not_run" };
  }
}

export function inspectCourseSupportWorkerRuntime(options = {}, dependencies = {}) {
  const checkout = canonical(options.checkout || process.cwd());
  const selectedCheckout = options.selectedCheckout ? canonical(options.selectedCheckout) : null;
  const environment = options.environment || process.env;
  const run = dependencies.runCommand || runCommand;
  const runtime = dependencies.runtime || resolveCourseSupportWorkerRuntime({ environment });
  const inspectionEnv = runtime.status === "available"
    ? courseSupportWorkerRuntimeEnvironment(runtime, checkout, environment)
    : setupEnvironment(environment);
  const readGit = (args, cwd = checkout) => {
    const result = run("git", args, { cwd, env: { ...inspectionEnv, GIT_OPTIONAL_LOCKS: "0" } });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const linkedWorktree = (() => {
    try { return lstatSync(resolve(checkout, ".git")).isFile(); } catch { return false; }
  })();
  const branch = readGit(["branch", "--show-current"]);
  const head = readGit(["rev-parse", "HEAD"]);
  const originMain = readGit(["rev-parse", "origin/main"]);
  const clean = readGit(["status", "--porcelain"]) === "";
  const common = readGit(["rev-parse", "--git-common-dir"]);
  const selectedCommon = selectedCheckout ? readGit(["rev-parse", "--git-common-dir"], selectedCheckout) : null;
  const binding = readBinding(checkout);
  const selectedBinding = selectedCheckout ? readBinding(selectedCheckout) : null;
  const bindingMatches = Boolean(binding && selectedBinding && binding.projectId === selectedBinding.projectId && binding.orgId === selectedBinding.orgId);
  const privatePaths = ["node_modules", "node_modules/.prisma", "node_modules/.prisma/client", "node_modules/@prisma", "node_modules/@prisma/client", ".codex-artifacts", ".codex-artifacts/npm-cache", ".codex-artifacts/npm-prefix", ".codex-artifacts/browser-tmp"];
  const dependenciesPrivate = privatePaths.every((path) => isPrivateWorkerPath(checkout, resolve(checkout, path)));
  const guards = {
    ownCurrentCheckout: samePath(checkout, options.cwd || process.cwd()),
    nativeIdentityPresent: Boolean(environment.CODEX_THREAD_ID?.trim()),
    linkedWorktree,
    namedWorkerBranch: Boolean(branch && /^automation\/course-support-[a-z0-9][a-z0-9-]*$/.test(branch)),
    atLocalOriginMain: Boolean(head && /^[a-f0-9]{40}$/.test(head) && head === originMain),
    clean,
    selectedCheckoutDistinct: Boolean(selectedCheckout && !samePath(checkout, selectedCheckout)),
    sameRepository: Boolean(common && selectedCommon && samePath(resolve(checkout, common), resolve(selectedCheckout, selectedCommon))),
    bindingMatches,
    dependenciesPrivate
  };
  const version = (command, args, pattern) => {
    const result = run(command, args, { cwd: checkout, env: inspectionEnv });
    const value = result.stdout.trim();
    return result.status === 0 && pattern.test(value) ? value : null;
  };
  const runtimeReceipt = runtime.status === "available" ? {
    status: runtime.status, source: runtime.source,
    nodeVersion: version(runtime.nodePath, ["--version"], /^v\d+\.\d+\.\d+$/),
    npmVersion: version(runtime.nodePath, [runtime.npmCliPath, "--version"], /^\d+\.\d+\.\d+$/)
  } : { status: runtime.status };
  const client = dependenciesPrivate ? (dependencies.inspectClient || inspectGeneratedPrismaClient)(checkout) : { status: "shared_output_rejected" };
  const browser = dependenciesPrivate ? (dependencies.inspectBrowser || inspectBrowserFiles)(checkout) : { moduleAvailable: false, executableAvailable: false, smoke: "not_run" };
  return {
    mode: "inspect", observedAt: new Date().toISOString(), runtime: runtimeReceipt, guards, client, browser,
    prepareEligible: Object.values(guards).every(Boolean) && Boolean(runtimeReceipt.nodeVersion && runtimeReceipt.npmVersion),
    setupRequired: runtime.status !== "available" || !runtimeReceipt.nodeVersion || !runtimeReceipt.npmVersion || !bindingMatches || !dependenciesPrivate || client.status !== "current" || !browser.executableAvailable
  };
}

export function prepareCourseSupportWorkerRuntime(options = {}, dependencies = {}) {
  const checkout = canonical(options.checkout || process.cwd());
  const environment = options.environment || process.env;
  const runtime = dependencies.runtime || resolveCourseSupportWorkerRuntime({ environment });
  const initial = inspectCourseSupportWorkerRuntime(options, { ...dependencies, runtime });
  if (!initial.prepareEligible) return { ...initial, mode: "prepare", outcome: "guard_rejected", stages: [] };
  // Generation only. Never borrow live database configuration for installation.
  const localEnv = {
    ...courseSupportWorkerRuntimeEnvironment(runtime, checkout, environment),
    DATABASE_URL: "postgresql://generate:generate@prisma-generate.invalid:5432/generate",
    DATABASE_URL_UNPOOLED: "postgresql://generate:generate@prisma-generate.invalid:5432/generate"
  };
  const run = dependencies.runCommand || runCommand;
  const stages = [];
  let fresh = initial;
  for (const [stage, args] of [["dependencies", ["ci", "--prefix", checkout]], ["generated_client", ["run", "prisma:generate", "--prefix", checkout]]]) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const command = courseSupportWorkerNpmCommand(runtime, args);
    const result = run(command.command, command.args, { cwd: checkout, env: localEnv, timeout: 600_000 });
    stages.push({ stage, startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), exitCode: result.status });
    if (result.status !== 0) return { ...initial, mode: "prepare", outcome: "setup_failed", stages };
    fresh = inspectCourseSupportWorkerRuntime(options, { ...dependencies, runtime });
    if (!fresh.prepareEligible) return { ...fresh, mode: "prepare", outcome: "guard_changed", stages };
  }
  const browserFiles = fresh.browser;
  const browserSmoke = dependencies.browserSmoke || ((directory) => {
    const privateTemp = resolve(directory, ".codex-artifacts", "browser-tmp");
    mkdirSync(privateTemp, { recursive: true });
    return inspectPlaywrightChromiumRuntime(directory, undefined, undefined, () => run(runtime.nodePath,
      [resolve(directory, "scripts", "automation", "course-support-preflight.mjs"), "--internal-playwright-chromium-runtime-smoke", directory],
      { cwd: directory, env: { ...localEnv, TMP: privateTemp, TEMP: privateTemp }, timeout: 12_000 }
    ).status === 0);
  });
  const browser = browserFiles.executableAvailable
    ? { ...browserFiles, smoke: browserSmoke(checkout).status === "current" ? "passed" : "failed" }
    : browserFiles;
  const final = inspectCourseSupportWorkerRuntime(options, { ...dependencies, runtime });
  if (!final.prepareEligible) return { ...final, mode: "prepare", outcome: "guard_changed", stages };
  const finalBrowser = { ...final.browser, smoke: browser.smoke };
  const ready = final.client.status === "current" && finalBrowser.executableAvailable && finalBrowser.smoke === "passed";
  return { ...final, mode: "prepare", browser: finalBrowser, setupRequired: !ready, outcome: ready ? "prepared" : "readiness_failed", stages };
}

export function runCourseSupportWorkerProduction(options = {}, dependencies = {}) {
  const checkout = canonical(options.checkout || process.cwd());
  const environment = options.environment || process.env;
  const runtime = dependencies.runtime || resolveCourseSupportWorkerRuntime({ environment });
  const command = courseSupportWorkerProductionCommand(runtime, options.script, options.args || []);
  const inspection = inspectCourseSupportWorkerRuntime(options, { ...dependencies, runtime });
  // Code changes and a descendant commit are legitimate after an owned claim.
  // Product commands retain their own owner, lease, cycle, source, and release fences.
  const guards = Object.entries(inspection.guards).filter(([name]) => !["clean", "atLocalOriginMain"].includes(name));
  if (!guards.every(([, passed]) => passed) || inspection.setupRequired) return { ...inspection, mode: "production", outcome: "guard_rejected" };
  const run = dependencies.runCommand || runCommand;
  const result = run(command.command, command.args, {
    cwd: checkout, env: courseSupportWorkerRuntimeEnvironment(runtime, checkout, environment),
    shell: false, stdio: "inherit", timeout: undefined
  });
  return { mode: "production", outcome: result.status === 0 ? "completed" : "command_failed", exitCode: result.status ?? 1 };
}

export function readWorkerProductionArguments(args) {
  const options = { args: [] };
  const fields = { "--script": "script", "--checkout": "checkout", "--selected-checkout": "selectedCheckout" };
  let separator = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") { options.args = args.slice(index + 1); separator = true; break; }
    const field = fields[arg];
    const value = args[++index];
    if (!field || !value || value.startsWith("--") || field in options) throw new Error("INVALID_PRODUCTION_ARGUMENT");
    options[field] = value;
  }
  if (!separator || !options.selectedCheckout || !productionScripts.has(options.script)) throw new Error("INVALID_PRODUCTION_ARGUMENT");
  return options;
}

function main(args) {
  if (args[0] === "production") {
    const receipt = runCourseSupportWorkerProduction(readWorkerProductionArguments(args.slice(1)));
    if (receipt.outcome === "guard_rejected") console.log(JSON.stringify(receipt, null, 2));
    process.exitCode = receipt.exitCode ?? 2;
    return;
  }
  const options = {};
  let prepare = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--prepare") prepare = true;
    else if ((arg === "--checkout" || arg === "--selected-checkout") && args[index + 1]) options[arg === "--checkout" ? "checkout" : "selectedCheckout"] = args[++index];
    else throw new Error("INVALID_ARGUMENT");
  }
  const receipt = prepare ? prepareCourseSupportWorkerRuntime(options) : inspectCourseSupportWorkerRuntime(options);
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = prepare ? (receipt.outcome === "prepared" ? 0 : 2) : (receipt.setupRequired ? 2 : 0);
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch { console.log(JSON.stringify({ outcome: "runtime_inspection_failed" })); process.exitCode = 2; }
}
