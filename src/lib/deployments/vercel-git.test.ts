import { describe, expect, it } from "vitest";

import {
  evaluateProductionAliasTargets,
  getVercelDeploymentCreatedAtIso,
  isFailedDeploymentState,
  selectGitProductionDeployment
} from "./vercel-git";

describe("selectGitProductionDeployment", () => {
  it("ignores a duplicate CLI deployment and selects the Git integration deployment", () => {
    const selected = selectGitProductionDeployment(
      {
        deployments: [
          {
            createdAt: 200,
            meta: {
              githubCommitRef: "release-task",
              githubCommitSha: "abc123"
            },
            state: "READY",
            url: "manual.vercel.app"
          },
          {
            createdAt: 100,
            meta: {
              branchAlias: "teetimeai-git-main.vercel.app",
              githubCommitRef: "main",
              githubCommitSha: "abc123",
              githubDeployment: "1"
            },
            state: "READY",
            url: "git.vercel.app"
          }
        ]
      },
      { branch: "main", commitSha: "abc123" }
    );

    expect(selected?.url).toBe("git.vercel.app");
  });

  it("selects the newest matching Git deployment", () => {
    const selected = selectGitProductionDeployment(
      {
        deployments: [
          gitDeployment({ createdAt: 100, url: "old.vercel.app" }),
          gitDeployment({ createdAt: 300, url: "new.vercel.app" })
        ]
      },
      { branch: "main", commitSha: "abc123" }
    );

    expect(selected?.url).toBe("new.vercel.app");
  });
});

describe("deployment verification", () => {
  it("returns the exact Git deployment creation time as canonical ISO proof", () => {
    expect(
      getVercelDeploymentCreatedAtIso({
        createdAt: Date.parse("2026-07-21T00:00:00.000Z"),
      }),
    ).toBe("2026-07-21T00:00:00.000Z");
    expect(() => getVercelDeploymentCreatedAtIso({})).toThrow(
      "did not include a valid creation timestamp",
    );
  });

  it("recognizes terminal deployment failures", () => {
    expect(isFailedDeploymentState("ERROR")).toBe(true);
    expect(isFailedDeploymentState("CANCELED")).toBe(true);
    expect(isFailedDeploymentState("BUILDING")).toBe(false);
  });

  it("requires each production alias to resolve Ready to the exact Git deployment", () => {
    expect(
      evaluateProductionAliasTargets(
        [
          {
            alias: "teetimespot.com",
            inspection: { readyState: "READY", url: "git.vercel.app" }
          },
          {
            alias: "www.teetimespot.com",
            inspection: { readyState: "READY", url: "git.vercel.app" }
          }
        ],
        {
          deploymentUrl: "git.vercel.app",
          requiredAliases: ["teetimespot.com", "www.teetimespot.com"]
        }
      )
    ).toEqual({
      missingAliases: [],
      mismatchedAliases: [],
      notReadyAliases: [],
      verified: true
    });

    expect(
      evaluateProductionAliasTargets(
        [
          {
            alias: "teetimespot.com",
            inspection: { readyState: "READY", url: "manual.vercel.app" }
          }
        ],
        {
          deploymentUrl: "git.vercel.app",
          requiredAliases: ["teetimespot.com", "www.teetimespot.com"]
        }
      ).verified
    ).toBe(false);
  });

  it("rejects an alias that resolves to the deployment before it is Ready", () => {
    expect(
      evaluateProductionAliasTargets(
        [
          {
            alias: "teetimespot.com",
            inspection: { readyState: "BUILDING", url: "git.vercel.app" }
          }
        ],
        {
          deploymentUrl: "git.vercel.app",
          requiredAliases: ["teetimespot.com"]
        }
      )
    ).toEqual({
      missingAliases: [],
      mismatchedAliases: [],
      notReadyAliases: ["teetimespot.com"],
      verified: false
    });
  });
});

function gitDeployment(input: { createdAt: number; url: string }) {
  return {
    ...input,
    meta: {
      branchAlias: "teetimeai-git-main.vercel.app",
      githubCommitRef: "main",
      githubCommitSha: "abc123",
      githubDeployment: "1"
    },
    state: "READY"
  };
}
