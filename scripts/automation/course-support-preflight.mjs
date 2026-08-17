import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

export const approvedCourseSupportResponderCheckout =
  "C:\\dev\\TeeTimeAI-course-support-clean";
export const approvedCourseSupportResponderCheckouts = Object.freeze([
  approvedCourseSupportResponderCheckout,
  "C:\\dev\\TeeTimeAI-responder-self-healing"
]);

export const requiredCourseSupportIncidentScalarFields = Object.freeze([
  "attemptLedger",
  "cycle",
  "status"
]);

export function inspectGeneratedPrismaClient(
  checkout,
  loadClient = loadPrismaClientFromCheckout
) {
  try {
    const client = loadClient(checkout);
    const scalarFields = client?.Prisma?.CourseSupportIncidentScalarFieldEnum;
    const missingScalarFieldCount = requiredCourseSupportIncidentScalarFields.filter(
      (field) => scalarFields?.[field] !== field
    ).length;

    return {
      status: missingScalarFieldCount === 0 ? "current" : "stale",
      requiredScalarFieldCount: requiredCourseSupportIncidentScalarFields.length,
      missingScalarFieldCount
    };
  } catch {
    return {
      status: "unavailable",
      requiredScalarFieldCount: requiredCourseSupportIncidentScalarFields.length
    };
  }
}

export function generatedPrismaSetupRequiredResult(inspection) {
  if (inspection.status === "current") {
    return null;
  }

  return {
    outcome: "setup_required",
    reason:
      inspection.status === "stale"
        ? "The responder checkout's generated Prisma client is stale for required course-support fields."
        : "The responder checkout's generated Prisma client could not be inspected.",
    failureClass:
      inspection.status === "stale"
        ? "STALE_GENERATED_PRISMA_CLIENT"
        : "GENERATED_PRISMA_CLIENT_UNAVAILABLE",
    requiredScalarFieldCount: inspection.requiredScalarFieldCount,
    ...(inspection.status === "stale"
      ? { missingScalarFieldCount: inspection.missingScalarFieldCount }
      : {}),
    nextAction:
      "Run npm run prisma:generate in the dedicated responder checkout, confirm it remains clean, then rerun the preflight."
  };
}

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

export function selectApprovedCourseSupportResponderCheckout(input) {
  const normalize = (value) =>
    input.platform === "win32" ? value.toLowerCase() : value;
  const approvedCheckouts = (
    input.approvedCheckouts ?? [input.approvedCheckout]
  ).filter(Boolean);
  const normalizedApprovedCheckouts = approvedCheckouts.map(normalize);
  if (
    input.requestedCheckout &&
    !normalizedApprovedCheckouts.includes(normalize(input.requestedCheckout))
  ) {
    return { outcome: "rejected_requested_checkout" };
  }

  const eligibleCheckouts = input.requestedCheckout
    ? [input.requestedCheckout]
    : approvedCheckouts;
  const checkout = eligibleCheckouts.find((approvedCheckout) =>
    input.preparedCheckouts.some(
      (candidate) => normalize(candidate) === normalize(approvedCheckout)
    )
  );
  if (!checkout || !input.currentMain || input.readHead(checkout) !== input.currentMain) {
    return { outcome: "unavailable" };
  }
  return {
    outcome: "selected",
    checkout,
    failover: normalize(checkout) !== normalizedApprovedCheckouts[0]
  };
}

export function getResponderCheckoutRefreshPlan(input) {
  if (!input.prepared || !input.clean || !input.currentMain || !input.head) {
    return { outcome: "unavailable" };
  }
  if (input.head === input.currentMain) {
    return { outcome: "ready", refreshDependencies: false };
  }
  if (input.aheadCount === 0 && input.behindCount > 0) {
    return {
      outcome: "fast_forward",
      refreshDependencies: input.lockfileChanged === true
    };
  }
  return { outcome: "unavailable" };
}

function main() {
  const requestedCheckoutValue =
    process.env.TEE_TIME_SPOT_RESPONDER_CHECKOUT?.trim();
  const approvedCheckouts = approvedCourseSupportResponderCheckouts.map(
    resolveCheckoutPath
  );
  const requestedCheckout = requestedCheckoutValue
    ? resolveCheckoutPath(requestedCheckoutValue)
    : undefined;
  const repositoryCheckout = approvedCheckouts.find((candidate) =>
    existsSync(resolve(candidate, ".git"))
  );
  const fetchedMain = repositoryCheckout
    ? git(["fetch", "origin", "main"], repositoryCheckout)
    : null;
  const currentMain =
    repositoryCheckout && fetchedMain !== null
      ? git(["rev-parse", "origin/main"], repositoryCheckout)
      : null;
  const preparedCheckouts = approvedCheckouts.filter((candidate) =>
    prepareApprovedResponderCheckout(candidate, currentMain)
  );
  const selection = selectApprovedCourseSupportResponderCheckout({
    approvedCheckouts,
    requestedCheckout,
    preparedCheckouts,
    currentMain,
    readHead: (checkout) => git(["rev-parse", "HEAD"], checkout),
    platform: process.platform
  });
  const checkout = selection.outcome === "selected" ? selection.checkout : null;

  if (!checkout) {
    process.stdout.write(
      `${JSON.stringify({
        outcome: "setup_required",
        reason:
          selection.outcome === "rejected_requested_checkout"
            ? "The configured responder checkout is not in the approved responder pool."
            : "No approved responder checkout is clean, prepared, and safely synchronized with origin/main.",
        failureClass:
          selection.outcome === "rejected_requested_checkout"
            ? "UNAPPROVED_RESPONDER_CHECKOUT"
            : "APPROVED_RESPONDER_CHECKOUT_UNAVAILABLE",
        nextAction:
          "Keep at least one approved responder checkout clean and prepared; preserve dirty checkouts for their owner."
      })}\n`
    );
    process.exitCode = 2;
  } else {
    const resolvedCheckout = realpathSync(checkout);
    const checkoutHead = git(["rev-parse", "HEAD"], resolvedCheckout);
    let generatedPrismaInspection = inspectGeneratedPrismaClient(resolvedCheckout);
    if (
      generatedPrismaInspection.status === "stale" &&
      runNpm(["run", "prisma:generate"], resolvedCheckout)
    ) {
      generatedPrismaInspection = inspectGeneratedPrismaClient(resolvedCheckout);
    }
    const generatedPrismaSetupRequired = generatedPrismaSetupRequiredResult(
      generatedPrismaInspection
    );

    if (!currentMain || checkoutHead !== currentMain) {
      process.stdout.write(
        `${JSON.stringify({
          outcome: "setup_required",
          reason: "The prepared responder checkout is not exactly current origin/main.",
          nextAction: "Refresh the dedicated responder checkout before running production inspection."
        })}\n`
      );
      process.exitCode = 2;
    } else if (generatedPrismaSetupRequired) {
      process.stdout.write(`${JSON.stringify(generatedPrismaSetupRequired)}\n`);
      process.exitCode = 2;
    } else if (!process.argv.includes("--run")) {
      process.stdout.write(
        `${JSON.stringify({
          outcome: "ready",
          checkout: resolvedCheckout,
          exactHead: true,
          failover: selection.failover,
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

function prepareApprovedResponderCheckout(candidate, currentMain) {
  if (
    !existsSync(resolve(candidate, "package.json")) ||
    !existsSync(resolve(candidate, "node_modules")) ||
    !existsSync(resolve(candidate, ".vercel", "project.json"))
  ) {
    return false;
  }
  const checkout = realpathSync(candidate);
  const clean = git(["status", "--porcelain"], checkout) === "";
  const head = git(["rev-parse", "HEAD"], checkout);
  const counts = git(["rev-list", "--left-right", "--count", "HEAD...origin/main"], checkout)
    ?.split(/\s+/u)
    .map(Number);
  const lockfileChanged = Boolean(
    git(["diff", "--name-only", "HEAD..origin/main", "--", "package-lock.json"], checkout)
  );
  const plan = getResponderCheckoutRefreshPlan({
    prepared: true,
    clean,
    currentMain,
    head,
    aheadCount: counts?.[0],
    behindCount: counts?.[1],
    lockfileChanged
  });
  if (plan.outcome === "unavailable") {
    return false;
  }
  if (plan.outcome === "fast_forward") {
    if (git(["merge", "--ff-only", "origin/main"], checkout) === null) {
      return false;
    }
  }
  if (dependenciesNeedRefresh(checkout, plan.refreshDependencies)) {
    markDependencyRefreshRequired(checkout);
    if (!runNpm(["ci"], checkout)) return false;
    markDependenciesCurrent(checkout);
  }
  return (
    git(["status", "--porcelain"], checkout) === "" &&
    git(["rev-parse", "HEAD"], checkout) === currentMain
  );
}

function dependenciesNeedRefresh(checkout, forced) {
  if (forced) return true;
  const marker = dependencyMarkerPath(checkout);
  if (!existsSync(marker)) return false;
  return readFileSync(marker, "utf8").trim() !== packageLockHash(checkout);
}

function markDependencyRefreshRequired(checkout) {
  writeFileSync(dependencyMarkerPath(checkout), "refresh-required\n", "utf8");
}

function markDependenciesCurrent(checkout) {
  writeFileSync(dependencyMarkerPath(checkout), `${packageLockHash(checkout)}\n`, "utf8");
}

function dependencyMarkerPath(checkout) {
  return resolve(checkout, "node_modules", ".tee-time-spot-package-lock.sha256");
}

function packageLockHash(checkout) {
  return createHash("sha256")
    .update(readFileSync(resolve(checkout, "package-lock.json")))
    .digest("hex");
}

function runNpm(args, cwd) {
  const invocation = npmInvocation(args);
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"]
  }).status === 0;
}

function npmInvocation(args, platform = process.platform, commandInterpreter = process.env.ComSpec) {
  if (platform === "win32") {
    return {
      command: commandInterpreter?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", ["npm", ...args].join(" ")]
    };
  }
  return { command: "npm", args };
}

function loadPrismaClientFromCheckout(checkout) {
  const requireFromCheckout = createRequire(resolve(checkout, "package.json"));
  return requireFromCheckout("@prisma/client");
}

function resolveCheckoutPath(checkout) {
  try {
    return realpathSync(checkout);
  } catch {
    return resolve(checkout);
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
