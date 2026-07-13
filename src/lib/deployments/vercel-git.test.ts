import { describe, expect, it } from "vitest";

import {
  evaluateProductionAlias,
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
  it("recognizes terminal deployment failures", () => {
    expect(isFailedDeploymentState("ERROR")).toBe(true);
    expect(isFailedDeploymentState("CANCELED")).toBe(true);
    expect(isFailedDeploymentState("BUILDING")).toBe(false);
  });

  it("requires Ready, exact deployment ownership, and both production aliases", () => {
    expect(
      evaluateProductionAlias(
        {
          aliases: ["teetimespot.com", "www.teetimespot.com"],
          readyState: "READY",
          url: "git.vercel.app"
        },
        {
          deploymentUrl: "git.vercel.app",
          requiredAliases: ["teetimespot.com", "www.teetimespot.com"]
        }
      )
    ).toEqual({
      missingAliases: [],
      pointsToDeployment: true,
      ready: true,
      verified: true
    });

    expect(
      evaluateProductionAlias(
        {
          aliases: ["teetimespot.com"],
          readyState: "READY",
          url: "manual.vercel.app"
        },
        {
          deploymentUrl: "git.vercel.app",
          requiredAliases: ["teetimespot.com", "www.teetimespot.com"]
        }
      ).verified
    ).toBe(false);
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
