import { describe, expect, it, vi } from "vitest";

import { waitForGitDeployment } from "./wait-for-git-deployment";

const commitSha = "a".repeat(40);

describe("waitForGitDeployment", () => {
  it("returns exact Git deployment and alias proof", async () => {
    await expect(
      waitForGitDeployment(
        { commitSha, timeoutSeconds: 30, pollSeconds: 1 },
        {
          listDeployments: () => ({
            deployments: [gitDeployment("READY")],
          }),
          inspectAlias: (alias) => ({
            id: `inspection-${alias}`,
            readyState: "READY",
            url: "git.vercel.app",
          }),
        },
      ),
    ).resolves.toMatchObject({
      aliases: ["teetimespot.com", "www.teetimespot.com"],
      branch: "main",
      commitSha,
      deployedAt: "2026-08-27T12:00:00.000Z",
      deploymentUrl: "https://git.vercel.app",
      source: "git",
      state: "READY",
    });
  });

  it("waits through missing deployment and reports bounded state changes", async () => {
    let currentTime = 0;
    const statuses: string[] = [];
    const listDeployments = vi
      .fn()
      .mockResolvedValueOnce({ deployments: [] })
      .mockResolvedValueOnce({ deployments: [gitDeployment("READY")] });

    await waitForGitDeployment(
      { commitSha, timeoutSeconds: 30, pollSeconds: 1 },
      {
        listDeployments,
        inspectAlias: () => ({
          id: "verified-deployment",
          readyState: "READY",
          url: "git.vercel.app",
        }),
        now: () => currentTime,
        delay: async (milliseconds) => {
          currentTime += milliseconds;
        },
        onStatus: (status) => statuses.push(status),
      },
    );

    expect(listDeployments).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(["waiting_for_git_deployment"]);
  });

  it("fails immediately for a terminal Git deployment state", async () => {
    await expect(
      waitForGitDeployment(
        { commitSha },
        {
          listDeployments: () => ({
            deployments: [gitDeployment("ERROR")],
          }),
          inspectAlias: () => ({ readyState: "READY", url: "git.vercel.app" }),
        },
      ),
    ).rejects.toThrow("ended with ERROR");
  });

  it("does not return deployment proof without an exact inspection id", async () => {
    let currentTime = 0;

    await expect(
      waitForGitDeployment(
        { commitSha, timeoutSeconds: 1, pollSeconds: 1 },
        {
          listDeployments: () => ({
            deployments: [gitDeployment("READY")],
          }),
          inspectAlias: () => ({
            readyState: "READY",
            url: "git.vercel.app",
          }),
          now: () => currentTime,
          delay: async (milliseconds) => {
            currentTime += milliseconds;
          },
        },
      ),
    ).rejects.toThrow("did not include an inspection id");
  });

  it("honors cancellation without another Vercel read", async () => {
    const controller = new AbortController();
    controller.abort(new Error("owner operation stopped"));
    const listDeployments = vi.fn();

    await expect(
      waitForGitDeployment(
        { commitSha, signal: controller.signal },
        {
          listDeployments,
          inspectAlias: vi.fn(),
        },
      ),
    ).rejects.toThrow("owner operation stopped");
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it("passes cancellation through every external deployment read", async () => {
    const controller = new AbortController();
    const listSignals: Array<AbortSignal | undefined> = [];
    const aliasSignals: Array<AbortSignal | undefined> = [];

    await waitForGitDeployment(
      { commitSha, signal: controller.signal },
      {
        listDeployments: ({ signal }) => {
          listSignals.push(signal);
          return { deployments: [gitDeployment("READY")] };
        },
        inspectAlias: (alias, input) => {
          aliasSignals.push(input?.signal);
          return {
            id: `inspection-${alias}`,
            readyState: "READY",
            url: "git.vercel.app",
          };
        },
      },
    );

    expect(listSignals).toEqual([controller.signal]);
    expect(aliasSignals).toEqual([controller.signal, controller.signal]);
  });

  it("cancels an in-flight external deployment read", async () => {
    const controller = new AbortController();
    const inspectAlias = vi.fn();
    const listDeployments = vi.fn(
      ({ signal }: { commitSha: string; signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        }),
    );

    const waiting = waitForGitDeployment(
      { commitSha, signal: controller.signal },
      { listDeployments, inspectAlias },
    );
    await vi.waitFor(() => expect(listDeployments).toHaveBeenCalledOnce());
    controller.abort(new Error("owner heartbeat failed"));

    await expect(waiting).rejects.toThrow("owner heartbeat failed");
    expect(inspectAlias).not.toHaveBeenCalled();
  });

  it("does not inspect aliases when the deadline crosses during deployment listing", async () => {
    let currentTime = 0;
    const inspectAlias = vi.fn();

    await expect(
      waitForGitDeployment(
        { commitSha, timeoutSeconds: 1, pollSeconds: 1 },
        {
          listDeployments: () => {
            currentTime = 1_001;
            return { deployments: [gitDeployment("READY")] };
          },
          inspectAlias,
          now: () => currentTime,
          delay: vi.fn(),
        },
      ),
    ).rejects.toThrow("Timed out after 1s");
    expect(inspectAlias).not.toHaveBeenCalled();
  });

  it("does not return proof when the deadline crosses during alias inspection", async () => {
    let currentTime = 0;
    let aliasCount = 0;

    await expect(
      waitForGitDeployment(
        { commitSha, timeoutSeconds: 1, pollSeconds: 1 },
        {
          listDeployments: () => ({
            deployments: [gitDeployment("READY")],
          }),
          inspectAlias: (alias) => {
            aliasCount += 1;
            if (aliasCount === 2) {
              currentTime = 1_001;
            }
            return {
              id: `inspection-${alias}`,
              readyState: "READY",
              url: "git.vercel.app",
            };
          },
          now: () => currentTime,
          delay: vi.fn(),
        },
      ),
    ).rejects.toThrow("Timed out after 1s");
    expect(aliasCount).toBe(2);
  });
});

function gitDeployment(state: string) {
  return {
    createdAt: Date.parse("2026-08-27T12:00:00.000Z"),
    meta: {
      branchAlias: "teetimeai-git-main.vercel.app",
      githubCommitRef: "main",
      githubCommitSha: commitSha,
      githubDeployment: "1",
    },
    state,
    url: "git.vercel.app",
  };
}
