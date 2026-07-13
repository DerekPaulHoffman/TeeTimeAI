import { execFileSync } from "node:child_process";

import {
  evaluateProductionAlias,
  isFailedDeploymentState,
  selectGitProductionDeployment,
  type VercelDeploymentInspection,
  type VercelDeploymentList
} from "@/lib/deployments/vercel-git";

const args = process.argv.slice(2);
const commitSha = readOption(args, "--sha") ?? readGitHead();
const branch = readOption(args, "--production-branch") ?? "main";
const domain = readOption(args, "--domain") ?? "teetimespot.com";
const timeoutSeconds = readPositiveNumber(args, "--timeout-seconds", 900);
const pollSeconds = readPositiveNumber(args, "--poll-seconds", 10);
const requiredAliases = ["teetimespot.com", "www.teetimespot.com"];
const deadline = Date.now() + timeoutSeconds * 1000;

validateInputs();

waitForGitDeployment().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function waitForGitDeployment() {
  let lastStatus = "";
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const list = runVercelJson<VercelDeploymentList>([
        "ls",
        "--environment",
        "production",
        "--meta",
        `githubCommitSha=${commitSha}`,
        "--format",
        "json",
        "--limit",
        "20"
      ]);
      const deployment = selectGitProductionDeployment(list, { branch, commitSha });

      if (!deployment) {
        lastStatus = reportStatus(lastStatus, "waiting_for_git_deployment");
      } else if (isFailedDeploymentState(deployment.state)) {
        throw new Error(
          `Git deployment for ${shortSha(commitSha)} ended with ${deployment.state}`
        );
      } else if (deployment.state !== "READY") {
        lastStatus = reportStatus(
          lastStatus,
          `git_deployment_${(deployment.state ?? "pending").toLowerCase()}`
        );
      } else {
        const inspection = runVercelJson<VercelDeploymentInspection>([
          "inspect",
          domain,
          "--format",
          "json"
        ]);
        const aliasState = evaluateProductionAlias(inspection, {
          deploymentUrl: deployment.url!,
          requiredAliases
        });

        if (aliasState.verified) {
          console.log(
            JSON.stringify(
              {
                aliases: inspection.aliases?.filter((alias) => requiredAliases.includes(alias)),
                branch,
                commitSha,
                deploymentId: inspection.id,
                deploymentUrl: `https://${deployment.url}`,
                source: "git",
                state: "READY"
              },
              null,
              2
            )
          );
          return;
        }

        lastStatus = reportStatus(lastStatus, "waiting_for_production_aliases");
      }
      lastError = "";
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Git deployment")) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : "unknown Vercel CLI error";
      lastStatus = reportStatus(lastStatus, "vercel_cli_retry");
    }

    await delay(pollSeconds * 1000);
  }

  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting for the Git deployment of ${shortSha(commitSha)}${
      lastError ? ` (${lastError})` : ""
    }`
  );
}

function runVercelJson<T>(commandArgs: string[]) {
  const isWindows = process.platform === "win32";
  const executable = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "npx";
  const executableArgs = isWindows
    ? ["/d", "/s", "/c", ["npx", "vercel", ...commandArgs].map(quoteCmdToken).join(" ")]
    : ["vercel", ...commandArgs];
  try {
    const stdout = execFileSync(executable, executableArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000
    });
    return JSON.parse(stdout) as T;
  } catch (error) {
    const code =
      typeof error === "object" && error
        ? "status" in error && error.status !== null
          ? String(error.status)
          : "code" in error
            ? String(error.code)
            : "unknown"
        : "unknown";
    throw new Error(`Vercel CLI command failed with exit code ${code}`);
  }
}

function validateInputs() {
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new Error("--sha must be a full 40-character Git commit SHA");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error("--production-branch contains unsupported characters");
  }
  if (!/^(?=.{1,253}$)[A-Za-z0-9.-]+$/.test(domain)) {
    throw new Error("--domain must be a hostname");
  }
}

function quoteCmdToken(value: string) {
  if (!/^[A-Za-z0-9_./:=,-]+$/.test(value)) {
    throw new Error("Vercel CLI argument contains unsupported characters");
  }
  return value;
}

function readGitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function readOption(input: string[], name: string) {
  const index = input.indexOf(name);
  return index >= 0 ? input[index + 1] : undefined;
}

function readPositiveNumber(input: string[], name: string, fallback: number) {
  const raw = readOption(input, name);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function reportStatus(previous: string, current: string) {
  if (previous !== current) {
    console.error(`[deployment:wait] ${current} (${shortSha(commitSha)})`);
  }
  return current;
}

function shortSha(value: string) {
  return value.slice(0, 8);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
