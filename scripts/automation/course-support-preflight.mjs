import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const responderArgs = [
  "vercel",
  "env",
  "run",
  "-e",
  "production",
  "--",
  "npm",
  "run",
  "automation:course-support",
  "--",
  "inspect"
];

export function responderInvocation(
  platform = process.platform,
  commandInterpreter = process.env.ComSpec
) {
  if (platform === "win32") {
    return {
      command: commandInterpreter?.trim() || "cmd.exe",
      // Windows cannot execute the npx.cmd shim directly with shell: false.
      // This command is entirely static; no checkout or user value is interpolated.
      args: ["/d", "/s", "/c", ["npx", ...responderArgs].join(" ")]
    };
  }

  return {
    command: "npx",
    args: [...responderArgs]
  };
}

export function launchFailureResult(command) {
  if (!command.error && command.status !== null) {
    return null;
  }

  const rawErrorCode = command.error?.code;
  const errorCode =
    typeof rawErrorCode === "string" && /^[A-Z0-9_]{1,32}$/u.test(rawErrorCode)
      ? rawErrorCode
      : undefined;

  return {
    outcome: "setup_required",
    reason: "The production course-support inspection process could not be started.",
    failureClass: command.error ? "PROCESS_LAUNCH_FAILED" : "MISSING_EXIT_STATUS",
    ...(errorCode ? { errorCode } : {}),
    nextAction:
      "Verify Node.js, npm/npx, and the Vercel CLI are available, then rerun the preflight."
  };
}

function main() {
  const requestedCheckout = process.env.TEE_TIME_SPOT_RESPONDER_CHECKOUT?.trim();
  const worktreeCandidates = git(["worktree", "list", "--porcelain"], process.cwd())
    ?.split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim()) ?? [];
  const candidates = [...new Set([
    requestedCheckout,
    "C:\\dev\\TeeTimeAI-responder-throughput",
    "C:\\dev\\TeeTimeAi-CourseSupportResponder",
    ...worktreeCandidates
  ].filter(Boolean))];

  const preparedCheckouts = candidates.filter(
    (candidate) =>
      existsSync(resolve(candidate, "package.json")) &&
      existsSync(resolve(candidate, "node_modules")) &&
      existsSync(resolve(candidate, ".vercel", "project.json")) &&
      git(["status", "--porcelain"], realpathSync(candidate)) === ""
  );
  const currentMain = git(["rev-parse", "origin/main"], process.cwd());
  const checkout = preparedCheckouts.find(
    (candidate) => git(["rev-parse", "HEAD"], realpathSync(candidate)) === currentMain
  );

  if (!checkout) {
    process.stdout.write(
      `${JSON.stringify({
        outcome: "setup_required",
        reason:
          "No exact-origin/main responder checkout has dependencies and Vercel project metadata.",
        nextAction:
          "Fast-forward the dedicated responder checkout and refresh dependencies only when the lockfile changed."
      })}\n`
    );
    process.exitCode = 2;
  } else {
    const resolvedCheckout = realpathSync(checkout);
    const checkoutHead = git(["rev-parse", "HEAD"], resolvedCheckout);

    if (!currentMain || checkoutHead !== currentMain) {
      process.stdout.write(
        `${JSON.stringify({
          outcome: "setup_required",
          reason: "The prepared responder checkout is not exactly current origin/main.",
          nextAction: "Refresh the dedicated responder checkout before running production inspection."
        })}\n`
      );
      process.exitCode = 2;
    } else if (!process.argv.includes("--run")) {
      process.stdout.write(
        `${JSON.stringify({
          outcome: "ready",
          checkout: resolvedCheckout,
          exactHead: true,
          command: "npm run automation:course-support:preflight -- --run"
        })}\n`
      );
    } else {
      const invocation = responderInvocation();
      const command = spawnSync(invocation.command, invocation.args, {
        cwd: resolvedCheckout,
        stdio: "inherit",
        shell: false
      });
      const launchFailure = launchFailureResult(command);

      if (launchFailure) {
        process.stdout.write(`${JSON.stringify(launchFailure)}\n`);
        process.exitCode = 1;
      } else {
        process.exitCode = command.status;
      }
    }
  }
}

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
