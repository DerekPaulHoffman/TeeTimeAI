import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const PINNED_WORKER_CLI_PACKAGE_VERSION = "0.160.1";
export const PINNED_WORKER_CLI_VERSION = `codex-cli ${PINNED_WORKER_CLI_PACKAGE_VERSION}`;

function within(parent, child) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

/** Resolve only the lockfile-installed native runtime, never desktop/PATH. */
export function inspectPinnedWorkerCli(checkout, {
  platform = process.platform, arch = process.arch,
  read = readFileSync, canonical = realpathSync, stat = statSync,
  execute = execFileSync,
} = {}) {
  if (platform !== "win32" || !["x64", "arm64"].includes(arch)) return { status: "unsupported_platform" };
  try {
    const root = canonical(checkout);
    const modules = canonical(resolve(root, "node_modules"));
    if (!within(root, modules)) return { status: "path_not_owned" };
    const packageFile = canonical(resolve(modules, "@openai/codex/package.json"));
    if (!within(modules, packageFile)) return { status: "path_not_owned" };
    const pkg = JSON.parse(read(packageFile, "utf8"));
    const alias = `@openai/codex-win32-${arch}`;
    const nativeVersion = `${PINNED_WORKER_CLI_PACKAGE_VERSION}-win32-${arch}`;
    if (pkg.name !== "@openai/codex" || pkg.version !== PINNED_WORKER_CLI_PACKAGE_VERSION ||
        pkg.optionalDependencies?.[alias] !== `npm:@openai/codex@${nativeVersion}`) return { status: "package_version_mismatch" };
    const nativeFile = canonical(createRequire(packageFile).resolve(`${alias}/package.json`));
    if (!within(modules, nativeFile)) return { status: "path_not_owned" };
    const native = JSON.parse(read(nativeFile, "utf8"));
    if (native.name !== "@openai/codex" || native.version !== nativeVersion) return { status: "package_version_mismatch" };
    const target = arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc";
    const nativeRoot = dirname(nativeFile);
    const cliPath = canonical(resolve(nativeRoot, "vendor", target, "bin", "codex.exe"));
    if (!within(nativeRoot, cliPath) || !stat(cliPath).isFile()) return { status: "path_not_owned" };
    const version = execute(cliPath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 40_000 }).trim();
    if (version !== PINNED_WORKER_CLI_VERSION) return { status: "runtime_version_mismatch" };
    return { status: "current", cliPath, cliVersion: version, source: "pinned_package" };
  } catch { return { status: "unavailable" }; }
}

export function pinnedWorkerCliSetupRequiredResult(inspection) {
  if (inspection.status === "current") return null;
  return {
    outcome: "setup_required", failureClass: "PINNED_WORKER_CLI_UNAVAILABLE",
    reason: "The responder's pinned native launcher could not be verified.",
    nextAction: "Restore the lockfile dependencies in the approved responder checkout; preserve owners and do not substitute desktop or PATH executables.",
    runtimeStatus: inspection.status,
  };
}
