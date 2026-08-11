import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
  "C:\\dev\\TeeTimeAI-course-support-dispatch";

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
  const approvedCheckout = normalize(input.approvedCheckout);
  if (
    input.requestedCheckout &&
    normalize(input.requestedCheckout) !== approvedCheckout
  ) {
    return { outcome: "rejected_requested_checkout" };
  }

  const checkout = input.preparedCheckouts.find(
    (candidate) => normalize(candidate) === approvedCheckout
  );
  if (
    !checkout ||
    !input.currentMain ||
    input.readHead(checkout) !== input.currentMain
  ) {
    return { outcome: "unavailable" };
  }
  return { outcome: "selected", checkout };
}

function main() {
  const requestedCheckoutValue =
    process.env.TEE_TIME_SPOT_RESPONDER_CHECKOUT?.trim();
  const approvedCheckout = resolveCheckoutPath(
    approvedCourseSupportResponderCheckout
  );
  const requestedCheckout = requestedCheckoutValue
    ? resolveCheckoutPath(requestedCheckoutValue)
    : undefined;
  const candidates = [approvedCheckout];

  const preparedCheckouts = candidates.filter(
    (candidate) =>
      existsSync(resolve(candidate, "package.json")) &&
      existsSync(resolve(candidate, "node_modules")) &&
      existsSync(resolve(candidate, ".vercel", "project.json")) &&
      git(["status", "--porcelain"], realpathSync(candidate)) === ""
  );
  const currentMain = git(["rev-parse", "origin/main"], approvedCheckout);
  const selection = selectApprovedCourseSupportResponderCheckout({
    approvedCheckout,
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
            ? "The configured responder checkout is not the approved dispatch checkout."
            : "The approved dispatch checkout is not clean, prepared, and exactly at origin/main.",
        failureClass:
          selection.outcome === "rejected_requested_checkout"
            ? "UNAPPROVED_RESPONDER_CHECKOUT"
            : "APPROVED_RESPONDER_CHECKOUT_UNAVAILABLE",
        nextAction:
          "Prepare C:\\dev\\TeeTimeAI-course-support-dispatch at exact origin/main and refresh dependencies only when the lockfile changed."
      })}\n`
    );
    process.exitCode = 2;
  } else {
    const resolvedCheckout = realpathSync(checkout);
    const checkoutHead = git(["rev-parse", "HEAD"], resolvedCheckout);
    const generatedPrismaInspection = inspectGeneratedPrismaClient(resolvedCheckout);
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
