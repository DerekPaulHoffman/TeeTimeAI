// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  courseSupportWorkerNpmCommand,
  courseSupportWorkerProductionCommand,
  courseSupportWorkerRuntimeEnvironment,
  establishCourseSupportWorkerBinding,
  inspectCourseSupportWorkerRuntime,
  inspectCourseSupportWorkerVercel,
  isPrivateWorkerPath,
  prepareCourseSupportWorkerRuntime,
  readWorkerProductionArguments,
  runCourseSupportWorkerProduction,
  resolveCourseSupportWorkerRuntime
} from "../../../scripts/automation/course-support-worker-runtime.mjs";

const fixtures: string[] = [];
const productionKeys = ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "RESEND_API_KEY", "AUTOMATION_API_KEY", "VERCEL_TOKEN", "GOOGLE_PLACES_API_KEY", "CLERK_SECRET_KEY", "EMAIL_ACTION_SECRET"];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private worker binding bootstrap", () => {
  it("compares only case-sensitive parsed project and organization IDs and preserves matching bytes", () => {
    const { checkout, selectedCheckout, options, dependencies } = fixture();
    const childPath = join(checkout, ".vercel/project.json"), parentPath = join(selectedCheckout, ".vercel/project.json");
    const parentBytes = Buffer.from('{"projectId":"private-project","orgId":"private-team","projectName":"parent-name"}\n');
    const childBytes = Buffer.from('{\r\n  "orgId": "private-team",\r\n  "projectName": "different-optional-name",\r\n  "projectId": "private-project"\r\n}');
    writeFileSync(parentPath, parentBytes); writeFileSync(childPath, childBytes);
    const receipt = establishCourseSupportWorkerBinding(options, dependencies);
    expect(receipt).toMatchObject({ mode: "establish_binding", outcome: "binding_ready", bindingAction: "preserved", exitCode: 0 });
    expect(readFileSync(childPath)).toEqual(childBytes); expect(readFileSync(parentPath)).toEqual(parentBytes);
    expect(dependencies.browserSmoke).not.toHaveBeenCalled();
    const serialized = JSON.stringify(receipt);
    for (const secret of ["private-project", "private-team", "parent-name", "different-optional-name", options.environment.CODEX_THREAD_ID, checkout, selectedCheckout]) expect(serialized).not.toContain(secret);
    const calls = dependencies.runCommand.mock.calls as unknown as [string, string[], { env: Record<string, string> }][];
    expect(calls.every(([command, args]) => command === "git" || args.includes("--version"))).toBe(true);
    for (const [, , settings] of calls) for (const key of productionKeys) expect(settings.env[key]).toBeUndefined();
  });

  it("exclusively establishes a missing binding in the child's ignored directory and never changes the parent", () => {
    const { checkout, selectedCheckout, options, dependencies } = fixture();
    const childPath = join(checkout, ".vercel/project.json"), parentPath = join(selectedCheckout, ".vercel/project.json");
    const parentBytes = readFileSync(parentPath);
    unlinkSync(childPath); rmdirSync(join(checkout, ".vercel"));
    const receipt = establishCourseSupportWorkerBinding(options, dependencies);
    expect(receipt).toMatchObject({ outcome: "binding_ready", bindingAction: "created", exitCode: 0, guards: { bindingMatches: false, childBindingIgnored: true } });
    expect(readFileSync(childPath)).toEqual(parentBytes); expect(readFileSync(parentPath)).toEqual(parentBytes);
    expect(inspectCourseSupportWorkerRuntime(options, dependencies).prepareEligible).toBe(true);
    expect(establishCourseSupportWorkerBinding(options, dependencies).bindingAction).toBe("preserved");
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("ci") || args.includes("exec"))).toBe(false);
  });

  it.each([
    ["project", '{"projectId":"PRIVATE-project","orgId":"private-team"}', "binding_mismatch"],
    ["organization", '{"projectId":"private-project","orgId":"PRIVATE-team"}', "binding_mismatch"],
    ["malformed JSON", "{invalid-json", "binding_invalid"],
    ["missing ID", '{"projectId":"private-project"}', "binding_invalid"],
  ])("preserves an existing %s mismatch or invalid file rather than repairing it", (_label, body, outcome) => {
    const { checkout, selectedCheckout, options, dependencies } = fixture();
    const childPath = join(checkout, ".vercel/project.json"), parentPath = join(selectedCheckout, ".vercel/project.json");
    const parentBytes = readFileSync(parentPath), childBytes = Buffer.from(body);
    writeFileSync(childPath, childBytes);
    expect(establishCourseSupportWorkerBinding(options, dependencies)).toMatchObject({ outcome, exitCode: 2 });
    expect(readFileSync(childPath)).toEqual(childBytes); expect(readFileSync(parentPath)).toEqual(parentBytes);
  });

  it.each(["identity", "cwd", "branch", "base", "clean", "linked", "distinct", "repository", "ignored"])("preserves both bindings when the %s bootstrap guard fails", failure => {
    const { root, checkout, selectedCheckout, options, dependencies } = fixture();
    const childPath = join(checkout, ".vercel/project.json"), parentPath = join(selectedCheckout, ".vercel/project.json");
    const parentBytes = readFileSync(parentPath), childBytes = readFileSync(childPath);
    if (failure === "identity") delete options.environment.CODEX_THREAD_ID;
    if (failure === "cwd") options.cwd = selectedCheckout;
    if (failure === "linked") { unlinkSync(join(checkout, ".git")); mkdirSync(join(checkout, ".git")); }
    if (failure === "distinct") options.selectedCheckout = checkout;
    let commonReads = 0;
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => {
      const key = args.join(" ");
      if (command === "git" && failure === "branch" && key === "branch --show-current") return { status: 0, stdout: "main" };
      if (command === "git" && failure === "base" && key === "rev-parse origin/main") return { status: 0, stdout: "b".repeat(40) };
      if (command === "git" && failure === "clean" && key === "status --porcelain") return { status: 0, stdout: " M src/unowned-change.ts" };
      if (command === "git" && failure === "repository" && key === "rev-parse --git-common-dir" && ++commonReads === 2) return { status: 0, stdout: join(root, "other-repository") };
      if (command === "git" && failure === "ignored" && args.includes("check-ignore")) return { status: 1, stdout: "" };
      return original(command, args);
    });
    expect(establishCourseSupportWorkerBinding(options, dependencies)).toMatchObject({ outcome: "guard_rejected", exitCode: 2 });
    expect(readFileSync(childPath)).toEqual(childBytes); expect(readFileSync(parentPath)).toEqual(parentBytes);
  });

  it.each(["child", "parent"])("rejects a shared %s binding directory junction without changing its target", target => {
    const { root, checkout, selectedCheckout, options, dependencies } = fixture();
    const directory = join(target === "child" ? checkout : selectedCheckout, ".vercel");
    const shared = join(root, "shared-binding"); mkdirSync(shared);
    const bytes = readFileSync(join(directory, "project.json"));
    writeFileSync(join(shared, "project.json"), bytes);
    unlinkSync(join(directory, "project.json")); rmdirSync(directory);
    symlinkSync(shared, directory, process.platform === "win32" ? "junction" : "dir");
    expect(establishCourseSupportWorkerBinding(options, dependencies)).toMatchObject({ outcome: "guard_rejected", exitCode: 2 });
    expect(readFileSync(join(shared, "project.json"))).toEqual(bytes);
  });

  it("rejects a shared hard-linked binding file even when its IDs match", () => {
    const { checkout, selectedCheckout, options, dependencies } = fixture();
    const parentPath = join(selectedCheckout, ".vercel/project.json"), childPath = join(checkout, ".vercel/project.json");
    const bytes = readFileSync(parentPath);
    unlinkSync(childPath); linkSync(parentPath, childPath);
    expect(establishCourseSupportWorkerBinding(options, dependencies)).toMatchObject({ outcome: "guard_rejected", exitCode: 2 });
    expect(readFileSync(parentPath)).toEqual(bytes); expect(readFileSync(childPath)).toEqual(bytes);
  });

  it("never creates a child binding from an invalid parent binding", () => {
    const { checkout, selectedCheckout, options, dependencies } = fixture();
    const childPath = join(checkout, ".vercel/project.json"), parentPath = join(selectedCheckout, ".vercel/project.json");
    unlinkSync(childPath); writeFileSync(parentPath, "not-json");
    expect(establishCourseSupportWorkerBinding(options, dependencies)).toMatchObject({ outcome: "guard_rejected", exitCode: 2, guards: { parentBindingValid: false } });
    expect(existsSync(childPath)).toBe(false); expect(readFileSync(parentPath, "utf8")).toBe("not-json");
  });

  it("does not create an unignored missing child binding", () => {
    const { checkout, options, dependencies } = fixture();
    const childPath = join(checkout, ".vercel/project.json");
    unlinkSync(childPath); rmdirSync(join(checkout, ".vercel"));
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => command === "git" && args.includes("check-ignore") ? { status: 1, stdout: "" } : original(command, args));
    expect(establishCourseSupportWorkerBinding(options, dependencies)).toMatchObject({ outcome: "guard_rejected", exitCode: 2 });
    expect(existsSync(join(checkout, ".vercel"))).toBe(false);
  });

  it("recognizes the standalone CLI stage with a structured nonzero guard receipt and rejects combining preparation", () => {
    const { checkout, selectedCheckout, options } = fixture();
    const childPath = join(checkout, ".vercel/project.json"), parentPath = join(selectedCheckout, ".vercel/project.json");
    const childBytes = readFileSync(childPath), parentBytes = readFileSync(parentPath);
    const helper = resolve("scripts/automation/course-support-worker-runtime.mjs");
    const settings = { cwd: checkout, env: { ...options.environment, CODEX_THREAD_ID: "" }, encoding: "utf8" as const, windowsHide: true, timeout: 15_000 };
    const result = spawnSync(process.execPath, [helper, "--establish-binding", "--selected-checkout", selectedCheckout], settings);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "establish_binding", outcome: "guard_rejected", exitCode: 2, guards: { nativeIdentityPresent: false } });
    expect(result.stdout).not.toContain("private-project"); expect(result.stdout).not.toContain("private-team");
    const combined = spawnSync(process.execPath, [helper, "--establish-binding", "--prepare", "--selected-checkout", selectedCheckout], settings);
    expect(combined.status).toBe(2); expect(JSON.parse(combined.stdout)).toEqual({ outcome: "runtime_inspection_failed" });
    expect(readFileSync(childPath)).toEqual(childBytes); expect(readFileSync(parentPath)).toEqual(parentBytes);
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "course-worker-runtime-"));
  fixtures.push(root);
  const checkout = join(root, "worker");
  const selectedCheckout = join(root, "selected");
  for (const directory of [checkout, selectedCheckout]) {
    mkdirSync(join(directory, ".vercel"), { recursive: true });
    writeFileSync(join(directory, ".git"), "gitdir: ../repository/worktrees/worker");
    writeFileSync(join(directory, ".vercel", "project.json"), JSON.stringify({ projectId: "private-project", orgId: "private-team" }));
    writeVercelFixture(directory);
  }
  const runtime = { status: "available", source: "installed_node", nodePath: "C:\\Program Files\\nodejs\\node.exe", npmCliPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" };
  const environment: Record<string, string> = { CODEX_THREAD_ID: "private-native-identity", PATH: "roaming-shims", SystemRoot: "C:\\Windows", APPDATA: "private-appdata" };
  for (const key of productionKeys) environment[key] = `private-${key}`;
  const runCommand = vi.fn((command: string, args: string[]) => {
    if (command !== "git") {
      if (args[0]?.endsWith("vercel" + (process.platform === "win32" ? "\\" : "/") + "dist" + (process.platform === "win32" ? "\\" : "/") + "vc.js") && args.at(-1) === "--version") return { status: 0, stdout: "", stderr: "Vercel CLI 62.2.0\n" };
      if (args.at(-1) === "--version") return { status: 0, stdout: args.length === 1 ? "v22.22.2\n" : "10.9.7\n" };
      return { status: 0, stdout: "private-install-output" };
    }
    const key = args.join(" ");
    const outputs: Record<string, string> = {
      "branch --show-current": "automation/course-support-worker",
      "rev-parse HEAD": "a".repeat(40),
      "rev-parse origin/main": "a".repeat(40),
      "status --porcelain": "",
      "rev-parse --git-common-dir": join(root, "repository")
    };
    return { status: 0, stdout: outputs[key] ?? "" };
  });
  const dependencies = {
    runtime, runCommand,
    inspectClient: vi.fn(() => ({ status: "current" })),
    inspectBrowser: vi.fn(() => ({ moduleAvailable: true, executableAvailable: true, smoke: "not_run" })),
    browserSmoke: vi.fn(() => ({ status: "current" }))
  };
  return { root, checkout, selectedCheckout, options: { checkout, selectedCheckout, cwd: checkout, environment }, dependencies };
}

function writeVercelFixture(checkout: string, version = "62.2.0") {
  const directory = join(checkout, "node_modules", "vercel");
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "vercel", version, bin: { vercel: "./dist/vc.js" } }));
  writeFileSync(join(directory, "dist", "vc.js"), "process.stdout.write('62.2.0\\n');");
}

describe("private Windows worker runtime", () => {
  it("recognizes the real locked installed CLI and its declared entry without executing it", () => {
    const checkout = process.cwd();
    const manifest = JSON.parse(readFileSync(join(checkout, "node_modules", "vercel", "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "vercel", version: "62.2.0", bin: { vercel: "./dist/vc.js" } });
    expect(inspectCourseSupportWorkerVercel(checkout)).toEqual({ status: "current", version: "62.2.0" });
    const { dependencies } = fixture();
    expect(courseSupportWorkerProductionCommand(dependencies.runtime, "automation:course-dispatch", ["assignment"], checkout).args[0]).toBe(resolve(checkout, "node_modules", "vercel", manifest.bin.vercel));
  });

  it("bypasses roaming npm and removes conflicting Windows Path keys", () => {
    const installedNode = "C:\\Program Files\\nodejs\\node.exe";
    const installedNpm = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const runtime = resolveCourseSupportWorkerRuntime({ platform: "win32", execPath: "C:\\bundled\\node.exe", environment: {}, exists: (path: string) => [installedNode, installedNpm].includes(path) });
    expect(runtime).toMatchObject({ status: "available", nodePath: installedNode, npmCliPath: installedNpm });
    const environment = courseSupportWorkerRuntimeEnvironment(runtime, resolve("private-worker"), { Path: "roaming-shims", NPM_CONFIG_CACHE: "shared-cache", NPM_CONFIG_PREFIX: "roaming-prefix", API_KEY: "secret" });
    expect(environment.Path).toBeUndefined();
    expect(environment.NPM_CONFIG_CACHE).toBeUndefined();
    expect(environment.NPM_CONFIG_PREFIX).toBeUndefined();
    expect(environment.API_KEY).toBeUndefined();
    expect(environment.PATH).toBe("C:\\Program Files\\nodejs;roaming-shims");
    expect(environment.npm_config_cache).toBe(resolve("private-worker", ".codex-artifacts/npm-cache"));
    expect(environment.npm_config_prefix).toBe(resolve("private-worker", ".codex-artifacts/npm-prefix"));
    expect(courseSupportWorkerNpmCommand(runtime, ["ci"])).toEqual({ command: installedNode, args: [installedNpm, "ci"] });
  });

  it("never substitutes an arbitrary roaming npm CLI when the installed CLI is absent", () => {
    expect(resolveCourseSupportWorkerRuntime({ platform: "win32", exists: () => false })).toEqual({ status: "npm_cli_unavailable" });
  });

  it("default inspection does not prepare dependencies, launch a browser, or emit private metadata", () => {
    const { options, dependencies } = fixture();
    const receipt = inspectCourseSupportWorkerRuntime(options, dependencies);
    expect(receipt.prepareEligible).toBe(true);
    expect(receipt.browser.smoke).toBe("not_run");
    expect(dependencies.browserSmoke).not.toHaveBeenCalled();
    expect(dependencies.runCommand.mock.calls.filter(([command, args]) => command !== "git" && !args.includes("--version"))).toEqual([]);
    const calls = dependencies.runCommand.mock.calls as unknown as [string, string[], { env: Record<string, string> }][];
    for (const [command, , settings] of calls) {
      if (command === "git") expect(settings.env.GIT_OPTIONAL_LOCKS).toBe("0");
      for (const key of productionKeys) expect(settings.env[key]).toBeUndefined();
    }
    const serialized = JSON.stringify(receipt);
    for (const value of ["private-project", "private-team", "private-native-identity", "private-live-database", "private-key", options.checkout]) expect(serialized).not.toContain(value);
  });

  it.each(["main", "", "fix/another-task"])("rejects preparation on branch %s before any install", (branch) => {
    const { options, dependencies } = fixture();
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => command === "git" && args.join(" ") === "branch --show-current" ? { status: 0, stdout: branch } : original(command, args));
    expect(prepareCourseSupportWorkerRuntime(options, dependencies).outcome).toBe("guard_rejected");
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("ci"))).toBe(false);
  });

  it("rejects wrong cwd, stale source, and mismatching selected project before installing", () => {
    const first = fixture();
    expect(prepareCourseSupportWorkerRuntime({ ...first.options, cwd: first.selectedCheckout }, first.dependencies).outcome).toBe("guard_rejected");
    const second = fixture();
    const original = second.dependencies.runCommand.getMockImplementation()!;
    second.dependencies.runCommand.mockImplementation((command, args) => command === "git" && args.join(" ") === "rev-parse origin/main" ? { status: 0, stdout: "b".repeat(40) } : original(command, args));
    expect(prepareCourseSupportWorkerRuntime(second.options, second.dependencies).outcome).toBe("guard_rejected");
    const third = fixture();
    writeFileSync(join(third.selectedCheckout, ".vercel/project.json"), JSON.stringify({ projectId: "other-project", orgId: "private-team" }));
    expect(prepareCourseSupportWorkerRuntime(third.options, third.dependencies).outcome).toBe("guard_rejected");
  });

  it("rejects shared dependency junctions without importing their client or installing", () => {
    const { root, checkout, options, dependencies } = fixture();
    const shared = join(root, "shared-dependencies");
    mkdirSync(shared);
    unlinkSync(join(checkout, "node_modules", "vercel", "dist", "vc.js"));
    rmdirSync(join(checkout, "node_modules", "vercel", "dist"));
    unlinkSync(join(checkout, "node_modules", "vercel", "package.json"));
    rmdirSync(join(checkout, "node_modules", "vercel"));
    rmdirSync(join(checkout, "node_modules"));
    symlinkSync(shared, join(checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    expect(isPrivateWorkerPath(checkout, join(checkout, "node_modules"))).toBe(false);
    expect(prepareCourseSupportWorkerRuntime(options, dependencies).outcome).toBe("guard_rejected");
    expect(dependencies.inspectClient).not.toHaveBeenCalled();
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("ci"))).toBe(false);
  });

  it("prepares only with direct npm CLI, private cache, generation-only URLs, and redacted stage timings", () => {
    const { checkout, options, dependencies } = fixture();
    const receipt = prepareCourseSupportWorkerRuntime(options, dependencies);
    expect(receipt.outcome).toBe("prepared");
    const setup = dependencies.runCommand.mock.calls.filter(([, args]) => args.includes("ci") || args.includes("prisma:generate"));
    expect(setup).toHaveLength(2);
    expect(setup.map(([, args]) => args.slice(1))).toEqual([["ci", "--prefix", checkout], ["run", "prisma:generate", "--prefix", checkout]]);
    for (const [command, args, settings] of setup as unknown as [string, string[], { cwd: string; env: Record<string, string> }][]) {
      expect(command).toBe(dependencies.runtime.nodePath);
      expect(args[0]).toBe(dependencies.runtime.npmCliPath);
      expect(settings.cwd).toBe(checkout);
      expect(settings.env.npm_config_cache).toBe(resolve(checkout, ".codex-artifacts/npm-cache"));
      expect(settings.env.DATABASE_URL).toContain("prisma-generate.invalid");
      expect(settings.env.DATABASE_URL_UNPOOLED).toContain("prisma-generate.invalid");
      for (const key of productionKeys.filter((key) => !key.startsWith("DATABASE_URL"))) expect(settings.env[key]).toBeUndefined();
      expect(settings.env.SystemRoot).toBe("C:\\Windows");
    }
    expect(receipt.stages.map(stage => stage.stage)).toEqual(["dependencies", "vercel_cli", "generated_client"]);
    expect(receipt.stages[1]).toMatchObject({ exitCode: 0, versionVerified: true });
    expect(dependencies.browserSmoke).toHaveBeenCalledOnce();
    expect(JSON.stringify(receipt)).not.toContain("private-install-output");
  });

  it("stops on installation failure without generation or browser execution", () => {
    const { options, dependencies } = fixture();
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => args.includes("ci") ? { status: 1, stdout: "private-token" } : original(command, args));
    const receipt = prepareCourseSupportWorkerRuntime(options, dependencies);
    expect(receipt.outcome).toBe("setup_failed");
    expect(receipt.stages).toHaveLength(1);
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("prisma:generate"))).toBe(false);
    expect(dependencies.browserSmoke).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain("private-token");
  });

  it.each(["branch", "binding", "native_identity", "version"])("stops on %s drift after npm ci, before generation or browser execution", (drift) => {
    const { checkout, options, dependencies } = fixture();
    let installed = false;
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => {
      if (args.includes("ci")) {
        installed = true;
        if (drift === "binding") writeFileSync(join(checkout, ".vercel/project.json"), JSON.stringify({ projectId: "changed-project", orgId: "private-team" }));
        if (drift === "native_identity") delete options.environment.CODEX_THREAD_ID;
      }
      if (installed && drift === "branch" && command === "git" && args.join(" ") === "branch --show-current") return { status: 0, stdout: "main" };
      if (installed && drift === "version" && args.includes("--version")) return { status: 1, stdout: "private-runtime-error" };
      return original(command, args);
    });
    const receipt = prepareCourseSupportWorkerRuntime(options, dependencies);
    expect(receipt.outcome).toBe("guard_changed");
    expect(receipt.prepareEligible).toBe(false);
    expect(receipt.stages).toHaveLength(1);
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("prisma:generate"))).toBe(false);
    expect(dependencies.browserSmoke).not.toHaveBeenCalled();
  });

  it("does not return prepared when checkout authority changes during the browser smoke", () => {
    const { checkout, options, dependencies } = fixture();
    dependencies.browserSmoke.mockImplementation(() => {
      writeFileSync(join(checkout, ".vercel/project.json"), JSON.stringify({ projectId: "changed-project", orgId: "private-team" }));
      return { status: "current" };
    });
    const receipt = prepareCourseSupportWorkerRuntime(options, dependencies);
    expect(receipt.outcome).toBe("guard_changed");
    expect(receipt.prepareEligible).toBe(false);
  });

  it("uses the exact private installed CLI without npm exec or a PATH lookup", () => {
    const { checkout, dependencies } = fixture();
    const runtime = dependencies.runtime;
    const exactArgs = ["assignment", "--assignment-ref", "private value&unchanged"];
    expect(courseSupportWorkerProductionCommand(runtime, "automation:course-dispatch", exactArgs, checkout)).toEqual({
      command: runtime.nodePath,
      args: [join(checkout, "node_modules", "vercel", "dist", "vc.js"), "env", "run", "-e", "production", "--", runtime.nodePath, runtime.npmCliPath, "run", "automation:course-dispatch", "--", ...exactArgs]
    });
    expect(() => courseSupportWorkerProductionCommand(runtime, "seed:foreup", [])).toThrow("INVALID_WORKER_PRODUCTION_COMMAND");
    expect(() => courseSupportWorkerProductionCommand(runtime, "automation:course-support", ["bad\0argument"])).toThrow("INVALID_WORKER_PRODUCTION_COMMAND");
  });

  it("requires the exact selected checkout and strict script/separator on the production CLI", () => {
    const parsed = readWorkerProductionArguments(["--selected-checkout", "private selected path", "--script", "automation:course-support", "--", "claim", "--max-courses", "1"]);
    expect(parsed).toEqual({ selectedCheckout: "private selected path", script: "automation:course-support", args: ["claim", "--max-courses", "1"] });
    expect(readWorkerProductionArguments(["--selected-checkout", "private selected path", "--script", "automation:simulator-support", "--", "claim", "--assignment-ref", "private-assignment"]))
      .toEqual({ selectedCheckout: "private selected path", script: "automation:simulator-support", args: ["claim", "--assignment-ref", "private-assignment"] });
    for (const invalid of [
      ["--script", "automation:course-support", "--", "claim"],
      ["--selected-checkout", "path", "--script", "automation:course-support"],
      ["--selected-checkout", "path", "--script", "seed:foreup", "--"],
      ["--selected-checkout", "path", "--selected-checkout", "other", "--script", "automation:course-support", "--"]
    ]) expect(() => readWorkerProductionArguments(invalid)).toThrow();
  });

  it("permits later dirty descendant worker commands while preserving exact native identity and stripping product keys", () => {
    const { checkout, options, dependencies } = fixture();
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return { status: 0, stdout: "b".repeat(40) };
      if (command === "git" && args.join(" ") === "status --porcelain") return { status: 0, stdout: " M src/owned-change.ts" };
      return original(command, args);
    });
    const receipt = runCourseSupportWorkerProduction({ ...options, script: "automation:course-support", args: ["inspect-owned"] }, dependencies);
    expect(receipt).toEqual({ mode: "production", outcome: "completed", exitCode: 0 });
    const calls = dependencies.runCommand.mock.calls as unknown as [string, string[], { cwd: string; shell: boolean; stdio: string; env: Record<string, string> }][];
    const production = calls.find(([, args]) => args.includes("env") && args.includes("production"))!;
    expect(production[0]).toBe(dependencies.runtime.nodePath);
    expect(production[2]).toMatchObject({ cwd: checkout, shell: false, stdio: "inherit" });
    expect(production[2].env.CODEX_THREAD_ID).toBe(options.environment.CODEX_THREAD_ID);
    expect(production[2].env.PATH.startsWith("C:\\Program Files\\nodejs;")).toBe(true);
    for (const key of productionKeys) expect(production[2].env[key]).toBeUndefined();
    expect(dependencies.browserSmoke).not.toHaveBeenCalled();
  });

  it.each(["binding", "identity", "checkout"])("blocks a production wrapper with wrong %s without any live execution", (failure) => {
    const { checkout, selectedCheckout, options, dependencies } = fixture();
    if (failure === "binding") writeFileSync(join(checkout, ".vercel/project.json"), JSON.stringify({ projectId: "wrong-project", orgId: "private-team" }));
    if (failure === "identity") delete options.environment.CODEX_THREAD_ID;
    if (failure === "checkout") options.cwd = selectedCheckout;
    const receipt = runCourseSupportWorkerProduction({ ...options, script: "automation:course-support", args: ["claim"] }, dependencies);
    expect(receipt.outcome).toBe("guard_rejected");
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("env"))).toBe(false);
  });

  it.each(["missing", "wrong_version", "invalid_manifest", "missing_entry", "shared_entry", "shared_manifest"])("blocks %s CLI readiness before any production execution", failure => {
    const { root, checkout, options, dependencies } = fixture();
    const directory = join(checkout, "node_modules", "vercel"), manifest = join(directory, "package.json"), entry = join(directory, "dist", "vc.js");
    if (failure === "missing") unlinkSync(manifest);
    if (failure === "wrong_version") writeVercelFixture(checkout, "62.2.1");
    if (failure === "invalid_manifest") writeFileSync(manifest, JSON.stringify({ name: "vercel", version: "62.2.0", bin: { vercel: "../../unowned.js" } }));
    if (failure === "missing_entry") unlinkSync(entry);
    if (failure.startsWith("shared_")) {
      const file = failure === "shared_entry" ? entry : manifest;
      linkSync(file, join(root, "shared-cli-file"));
    }
    const inspection = inspectCourseSupportWorkerRuntime(options, dependencies);
    expect(inspection.prepareEligible).toBe(true);
    expect(inspection.setupRequired).toBe(true);
    expect(inspection.vercel.status).not.toBe("current");
    expect(runCourseSupportWorkerProduction({ ...options, script: "automation:course-dispatch", args: ["assignment"] }, dependencies).outcome).toBe("guard_rejected");
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("env") || args.includes("exec"))).toBe(false);
    expect(() => courseSupportWorkerProductionCommand(dependencies.runtime, "automation:course-dispatch", [], checkout)).toThrow("WORKER_VERCEL_NOT_READY");
  });

  it("rejects a CLI directory junction even when its version is correct", () => {
    const { root, checkout } = fixture();
    const directory = join(checkout, "node_modules", "vercel");
    unlinkSync(join(directory, "dist", "vc.js")); rmdirSync(join(directory, "dist"));
    unlinkSync(join(directory, "package.json")); rmdirSync(directory);
    const shared = join(root, "shared-cli"); writeVercelFixture(shared);
    symlinkSync(join(shared, "node_modules", "vercel"), directory, process.platform === "win32" ? "junction" : "dir");
    expect(inspectCourseSupportWorkerVercel(checkout)).toEqual({ status: "shared_output_rejected" });
  });

  it("rejects a dist junction even when its target stays inside this checkout", () => {
    const { checkout } = fixture();
    const dist = join(checkout, "node_modules", "vercel", "dist"), target = join(checkout, "other-dist");
    mkdirSync(target); writeFileSync(join(target, "vc.js"), "fixture");
    unlinkSync(join(dist, "vc.js")); rmdirSync(dist);
    symlinkSync(target, dist, process.platform === "win32" ? "junction" : "dir");
    expect(inspectCourseSupportWorkerVercel(checkout)).toEqual({ status: "shared_output_rejected" });
  });

  it("stops immediately if CLI metadata changes during its successful version smoke", () => {
    const { checkout, options, dependencies } = fixture();
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => {
      const result = original(command, args);
      if (args[0] === join(checkout, "node_modules", "vercel", "dist", "vc.js")) writeVercelFixture(checkout, "62.2.1");
      return result;
    });
    const receipt = prepareCourseSupportWorkerRuntime(options, dependencies);
    expect(receipt.outcome).toBe("guard_changed");
    expect(receipt.stages).toHaveLength(2);
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("prisma:generate"))).toBe(false);
    expect(dependencies.browserSmoke).not.toHaveBeenCalled();
  });

  it("keeps first-turn preparation strict while an older owned candidate gains only private CLI readiness", () => {
    const { checkout, options, dependencies } = fixture();
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => command === "git" && args.join(" ") === "rev-parse HEAD"
      ? { status: 0, stdout: "b".repeat(40) } : original(command, args));
    unlinkSync(join(checkout, "node_modules", "vercel", "package.json"));
    expect(prepareCourseSupportWorkerRuntime(options, dependencies).outcome).toBe("guard_rejected");
    expect(runCourseSupportWorkerProduction({ ...options, script: "automation:simulator-support", args: ["inspect"] }, dependencies).outcome).toBe("guard_rejected");
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("ci") || args.includes("env"))).toBe(false);
    writeVercelFixture(checkout);
    expect(runCourseSupportWorkerProduction({ ...options, script: "automation:simulator-support", args: ["inspect"] }, dependencies).outcome).toBe("completed");
    expect(options.environment.CODEX_THREAD_ID).toBe("private-native-identity");
  });

  it("installs a missing CLI during credential-free setup and verifies it before generation", () => {
    const { checkout, options, dependencies } = fixture();
    unlinkSync(join(checkout, "node_modules", "vercel", "package.json"));
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => {
      if (args.includes("ci")) writeVercelFixture(checkout);
      return original(command, args);
    });
    const receipt = prepareCourseSupportWorkerRuntime(options, dependencies);
    expect(receipt.outcome).toBe("prepared");
    const call = dependencies.runCommand.mock.calls.find(([, args]) => args[0] === join(checkout, "node_modules", "vercel", "dist", "vc.js"))!;
    expect(call[1]).toEqual([join(checkout, "node_modules", "vercel", "dist", "vc.js"), "--version"]);
    expect(call[2]).toMatchObject({ timeout: 10_000 });
    for (const key of productionKeys.filter(key => !key.startsWith("DATABASE_URL"))) expect(call[2].env[key]).toBeUndefined();
    expect(receipt.stages.map(stage => stage.stage)).toEqual(["dependencies", "vercel_cli", "generated_client"]);
  });

  it.each(["nonzero", "wrong_version", "malformed"])("stops on a %s CLI smoke before generation or browser launch", failure => {
    const { checkout, options, dependencies } = fixture();
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => args[0] === join(checkout, "node_modules", "vercel", "dist", "vc.js")
      ? { status: failure === "nonzero" ? 1 : 0, stdout: failure === "wrong_version" ? "62.2.1" : "private-invalid-output" } : original(command, args));
    const receipt = prepareCourseSupportWorkerRuntime(options, dependencies);
    expect(receipt.outcome).toBe("setup_failed");
    expect(receipt.stages).toHaveLength(2);
    expect(dependencies.runCommand.mock.calls.some(([, args]) => args.includes("prisma:generate"))).toBe(false);
    expect(dependencies.browserSmoke).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain("private-invalid-output");
  });

  it.each([1, null])("returns a closed failure receipt for exit %s without replay or private output", status => {
    const { options, dependencies } = fixture();
    const original = dependencies.runCommand.getMockImplementation()!;
    dependencies.runCommand.mockImplementation((command, args) => args.includes("env")
      ? { status, stdout: "private-live-database", stderr: "private-token", errorCode: "private-error", signal: "private-signal" } : original(command, args));
    const receipt = runCourseSupportWorkerProduction({ ...options, script: "automation:course-dispatch", args: ["assignment", "private-assignment"] }, dependencies);
    expect(receipt).toMatchObject({ mode: "production", outcome: "command_failed", exitCode: 1, phase: "production_wrapper", spawnError: "UNCLASSIFIED", signal: "UNCLASSIFIED" });
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(dependencies.runCommand.mock.calls.filter(([, args]) => args.includes("env"))).toHaveLength(1);
    for (const secret of ["private-live-database", "private-token", "private-error", "private-signal", "private-assignment"]) expect(JSON.stringify(receipt)).not.toContain(secret);
  });
});
