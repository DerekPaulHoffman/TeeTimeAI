export type VercelDeploymentSummary = {
  createdAt?: number;
  meta?: {
    branchAlias?: string;
    githubCommitRef?: string;
    githubCommitSha?: string;
    githubDeployment?: string;
  };
  state?: string;
  url?: string;
};

export type VercelDeploymentList = {
  deployments?: VercelDeploymentSummary[];
};

export type VercelDeploymentInspection = {
  aliases?: string[];
  id?: string;
  readyState?: string;
  url?: string;
};

const FAILED_DEPLOYMENT_STATES = new Set(["CANCELED", "ERROR"]);

export function selectGitProductionDeployment(
  input: VercelDeploymentList,
  options: { branch: string; commitSha: string }
) {
  return (input.deployments ?? [])
    .filter((deployment) => {
      const meta = deployment.meta;
      return (
        meta?.githubCommitSha === options.commitSha &&
        meta.githubCommitRef === options.branch &&
        meta.githubDeployment === "1" &&
        Boolean(meta.branchAlias) &&
        Boolean(deployment.url)
      );
    })
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))[0];
}

export function isFailedDeploymentState(state: string | undefined) {
  return FAILED_DEPLOYMENT_STATES.has(state ?? "");
}

export function getVercelDeploymentCreatedAtIso(
  deployment: VercelDeploymentSummary,
) {
  if (
    !Number.isFinite(deployment.createdAt) ||
    (deployment.createdAt ?? 0) <= 0
  ) {
    throw new Error(
      "The exact Git deployment did not include a valid creation timestamp.",
    );
  }
  const deployedAt = new Date(deployment.createdAt!);
  if (!Number.isFinite(deployedAt.getTime())) {
    throw new Error(
      "The exact Git deployment creation timestamp is invalid.",
    );
  }
  return deployedAt.toISOString();
}

export function evaluateProductionAliasTargets(
  inspections: Array<{ alias: string; inspection: VercelDeploymentInspection }>,
  options: { deploymentUrl: string; requiredAliases: string[] }
) {
  const inspectionsByAlias = new Map(
    inspections.map(({ alias, inspection }) => [alias, inspection])
  );
  const missingAliases = options.requiredAliases.filter(
    (alias) => !inspectionsByAlias.has(alias)
  );
  const notReadyAliases = options.requiredAliases.filter(
    (alias) => inspectionsByAlias.get(alias)?.readyState !== "READY"
  );
  const mismatchedAliases = options.requiredAliases.filter(
    (alias) => inspectionsByAlias.get(alias)?.url !== options.deploymentUrl
  );

  return {
    missingAliases,
    mismatchedAliases,
    notReadyAliases,
    verified:
      missingAliases.length === 0 &&
      notReadyAliases.length === 0 &&
      mismatchedAliases.length === 0
  };
}
