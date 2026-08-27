import {
  evaluateProductionAliasTargets,
  getVercelDeploymentCreatedAtIso,
  isFailedDeploymentState,
  selectGitProductionDeployment,
  type VercelDeploymentInspection,
  type VercelDeploymentList,
} from "./vercel-git";

export type GitDeploymentProof = {
  aliases: string[];
  branch: string;
  commitSha: string;
  deployedAt: string;
  deploymentId: string;
  deploymentUrl: string;
  source: "git";
  state: "READY";
};

export type WaitForGitDeploymentOptions = {
  commitSha: string;
  branch?: string;
  domain?: string;
  timeoutSeconds?: number;
  pollSeconds?: number;
  signal?: AbortSignal;
};

export type WaitForGitDeploymentDependencies = {
  listDeployments: (input: {
    commitSha: string;
    signal?: AbortSignal;
  }) => VercelDeploymentList | Promise<VercelDeploymentList>;
  inspectAlias: (
    alias: string,
    input?: { signal?: AbortSignal },
  ) => VercelDeploymentInspection | Promise<VercelDeploymentInspection>;
  now?: () => number;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onStatus?: (status: string, commitSha: string) => void;
};

export async function waitForGitDeployment(
  options: WaitForGitDeploymentOptions,
  dependencies: WaitForGitDeploymentDependencies,
): Promise<GitDeploymentProof> {
  const commitSha = options.commitSha;
  const branch = options.branch ?? "main";
  const domain = options.domain ?? "teetimespot.com";
  const timeoutSeconds = options.timeoutSeconds ?? 900;
  const pollSeconds = options.pollSeconds ?? 10;
  validateInputs({ commitSha, branch, domain, timeoutSeconds, pollSeconds });

  const requiredAliases = Array.from(
    new Set([
      domain,
      domain.startsWith("www.") ? domain.slice(4) : `www.${domain}`,
    ]),
  );
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.delay ?? abortableDelay;
  const onStatus = dependencies.onStatus ?? (() => undefined);
  const deadline = now() + timeoutSeconds * 1_000;
  let lastStatus = "";
  let lastError = "";

  const report = (status: string) => {
    if (lastStatus !== status) {
      onStatus(status, commitSha);
      lastStatus = status;
    }
  };
  const deadlineReached = () => {
    options.signal?.throwIfAborted();
    return now() >= deadline;
  };

  while (now() < deadline) {
    options.signal?.throwIfAborted();
    try {
      const list = await dependencies.listDeployments({
        commitSha,
        signal: options.signal,
      });
      if (deadlineReached()) {
        break;
      }
      const deployment = selectGitProductionDeployment(list, {
        branch,
        commitSha,
      });

      if (!deployment) {
        report("waiting_for_git_deployment");
      } else if (isFailedDeploymentState(deployment.state)) {
        throw new GitDeploymentFailedError(deployment.state ?? "UNKNOWN");
      } else if (deployment.state !== "READY") {
        report(
          `git_deployment_${(deployment.state ?? "pending").toLowerCase()}`,
        );
      } else {
        const aliasInspections = await Promise.all(
          requiredAliases.map(async (alias) => ({
            alias,
            inspection: await dependencies.inspectAlias(alias, {
              signal: options.signal,
            }),
          })),
        );
        if (deadlineReached()) {
          break;
        }
        const aliasState = evaluateProductionAliasTargets(aliasInspections, {
          deploymentUrl: deployment.url!,
          requiredAliases,
        });

        if (aliasState.verified) {
          if (deadlineReached()) {
            break;
          }
          const deploymentId = aliasInspections[0]?.inspection.id;
          if (!deploymentId) {
            throw new Error(
              "The verified production deployment did not include an inspection id.",
            );
          }
          const deployedAt = getVercelDeploymentCreatedAtIso(deployment);
          if (deadlineReached()) {
            break;
          }
          return {
            aliases: requiredAliases,
            branch,
            commitSha,
            deployedAt,
            deploymentId,
            deploymentUrl: `https://${deployment.url}`,
            source: "git",
            state: "READY",
          };
        }
        report("waiting_for_production_aliases");
      }
      lastError = "";
    } catch (error) {
      if (error instanceof GitDeploymentFailedError) {
        throw new Error(
          `Git deployment for ${shortSha(commitSha)} ended with ${error.state}`,
        );
      }
      options.signal?.throwIfAborted();
      lastError =
        error instanceof Error ? error.message : "unknown Vercel CLI error";
      report("vercel_cli_retry");
    }

    const remainingMs = deadline - now();
    if (remainingMs > 0) {
      await wait(Math.min(pollSeconds * 1_000, remainingMs), options.signal);
    }
  }

  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting for the Git deployment of ${shortSha(commitSha)}${
      lastError ? ` (${lastError})` : ""
    }`,
  );
}

class GitDeploymentFailedError extends Error {
  constructor(readonly state: string) {
    super(state);
    this.name = "GitDeploymentFailedError";
  }
}

function validateInputs(input: {
  commitSha: string;
  branch: string;
  domain: string;
  timeoutSeconds: number;
  pollSeconds: number;
}) {
  if (!/^[a-f0-9]{40}$/iu.test(input.commitSha)) {
    throw new Error("--sha must be a full 40-character Git commit SHA");
  }
  if (!/^[A-Za-z0-9._/-]+$/u.test(input.branch)) {
    throw new Error("--production-branch contains unsupported characters");
  }
  if (!/^(?=.{1,253}$)[A-Za-z0-9.-]+$/u.test(input.domain)) {
    throw new Error("--domain must be a hostname");
  }
  if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0) {
    throw new Error("--timeout-seconds must be a positive number");
  }
  if (!Number.isFinite(input.pollSeconds) || input.pollSeconds <= 0) {
    throw new Error("--poll-seconds must be a positive number");
  }
}

function shortSha(value: string) {
  return value.slice(0, 8);
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Deployment wait was aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
