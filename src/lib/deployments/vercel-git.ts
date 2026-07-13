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

export function evaluateProductionAlias(
  inspection: VercelDeploymentInspection,
  options: { deploymentUrl: string; requiredAliases: string[] }
) {
  const aliases = new Set(inspection.aliases ?? []);
  const missingAliases = options.requiredAliases.filter((alias) => !aliases.has(alias));
  const pointsToDeployment = inspection.url === options.deploymentUrl;
  const ready = inspection.readyState === "READY";

  return {
    missingAliases,
    pointsToDeployment,
    ready,
    verified: ready && pointsToDeployment && missingAliases.length === 0
  };
}
