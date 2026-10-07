// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPinnedWorkerCli, pinnedWorkerCliSetupRequiredResult } from "../../../scripts/automation/course-support-worker-cli.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    if (!path.startsWith("..") && path.startsWith("course-worker-cli-")) rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "course-worker-cli-"));
  roots.push(root);
  const packageFile = join(root, "node_modules/@openai/codex/package.json");
  const nativeFile = join(root, "node_modules/@openai/codex-win32-x64/package.json");
  const cliPath = join(dirname(nativeFile), "vendor/x86_64-pc-windows-msvc/bin/codex.exe");
  for (const file of [packageFile, nativeFile, cliPath]) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(packageFile, JSON.stringify({ name: "@openai/codex", version: "0.160.1",
    optionalDependencies: { "@openai/codex-win32-x64": "npm:@openai/codex@0.160.1-win32-x64" } }));
  writeFileSync(nativeFile, JSON.stringify({ name: "@openai/codex", version: "0.160.1-win32-x64" }));
  writeFileSync(cliPath, "test binary, never executed");
  const execute = vi.fn(() => "codex-cli 0.160.1\n");
  const options = { platform: "win32", arch: "x64", execute };
  return { root, packageFile, nativeFile, cliPath: realpathSync(cliPath), options };
}

describe("pinned responder native CLI", () => {
  it("uses only the exact installed native executable and verifies its real version", () => {
    const f = fixture();
    const inspection = inspectPinnedWorkerCli(f.root, f.options);
    expect(inspection).toEqual({ status: "current", cliPath: f.cliPath, cliVersion: "codex-cli 0.160.1", source: "pinned_package" });
    expect(f.options.execute).toHaveBeenCalledExactlyOnceWith(f.cliPath, ["--version"], expect.objectContaining({ windowsHide: true, timeout: 40_000 }));
    expect(pinnedWorkerCliSetupRequiredResult(inspection)).toBeNull();
  });

  it.each(["package", "native", "alias"])("refuses a changed %s manifest before executing anything", (changed) => {
    const f = fixture();
    const file = changed === "native" ? f.nativeFile : f.packageFile;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (changed === "alias") pkg.optionalDependencies["@openai/codex-win32-x64"] = "npm:@openai/codex@latest";
    else pkg.version = "0.162.0-alpha.2";
    writeFileSync(file, JSON.stringify(pkg));
    const inspection = inspectPinnedWorkerCli(f.root, f.options);
    expect(inspection.status).toBe("package_version_mismatch");
    expect(pinnedWorkerCliSetupRequiredResult(inspection)).toMatchObject({ outcome: "setup_required", failureClass: "PINNED_WORKER_CLI_UNAVAILABLE" });
    expect(f.options.execute).not.toHaveBeenCalled();
  });

  it("refuses a substituted executable even when its package still claims the pinned version", () => {
    const f = fixture();
    f.options.execute.mockReturnValue("codex-cli 0.162.0-alpha.2");
    expect(inspectPinnedWorkerCli(f.root, f.options)).toEqual({ status: "runtime_version_mismatch" });
  });

  it.each(["package", "native", "binary"])("does not fall back to desktop or PATH when the %s is missing", (missing) => {
    const f = fixture();
    rmSync(missing === "package" ? f.packageFile : missing === "native" ? f.nativeFile : f.cliPath);
    expect(inspectPinnedWorkerCli(f.root, f.options)).toEqual({ status: "unavailable" });
    expect(f.options.execute).not.toHaveBeenCalled();
  });

  it.each(["modules", "native", "binary"])("rejects a canonical %s path outside its owned installation", (escape) => {
    const f = fixture();
    const escaped = escape === "modules" ? join(f.root, "node_modules") : escape === "native" ? f.nativeFile : f.cliPath;
    const canonical = (path: string) => resolve(path) === resolve(escaped) ? resolve(f.root, "../other-installation", "outside.exe") : realpathSync(path);
    expect(inspectPinnedWorkerCli(f.root, { ...f.options, canonical }).status).toBe("path_not_owned");
    expect(f.options.execute).not.toHaveBeenCalled();
  });

  it("stops rather than exposing an executable failure or provider environment", () => {
    const f = fixture();
    f.options.execute.mockImplementation(() => { throw new Error("private failure with secret data"); });
    const inspection = inspectPinnedWorkerCli(f.root, f.options);
    expect(inspection).toEqual({ status: "unavailable" });
    expect(JSON.stringify(pinnedWorkerCliSetupRequiredResult(inspection))).not.toContain("secret data");
  });

  it("refuses unsupported host platforms before reading or executing an installation", () => {
    const f = fixture();
    expect(inspectPinnedWorkerCli(f.root, { ...f.options, platform: "linux" })).toEqual({ status: "unsupported_platform" });
    expect(inspectPinnedWorkerCli(f.root, { ...f.options, arch: "ia32" })).toEqual({ status: "unsupported_platform" });
    expect(f.options.execute).not.toHaveBeenCalled();
  });
});
