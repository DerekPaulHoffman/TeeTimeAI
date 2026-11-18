import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { retainOwnedReleaseDiagnosis, runConfiguredCommand } from "../../../scripts/automation/course-support";
import { GitDeploymentReadOnlyFailure, waitForGitDeployment } from "../deployments/wait-for-git-deployment";

describe("course-support verification command failure signaling", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  const watchFailure = {
    outcome: "verification_watch_closed",
    stoppedReason: "error",
    failureCode: "SETTLED_CLOSEOUT_FAILED",
    durableCloseoutRecorded: true,
    closeout: {
      outcome: "command_failed",
      durableCloseoutRecorded: true,
      threadDisposition: "KEEP_VISIBLE"
    }
  };

  it("retains a confirmed read-only release failure for the same full repair without claiming deployment or customer success", async () => {
    const releaseSha = "a".repeat(40), controller = new AbortController();
    const reconfirmAuthority = vi.fn(async () => true), checkpoint = vi.fn(async () => true);
    const error = await waitForGitDeployment({ commitSha: releaseSha }, {
      listDeployments: () => ({ deployments: [{ url: "fixture.vercel.app", state: "READY", createdAt: 1800000000000,
        meta: { githubCommitSha: releaseSha, githubCommitRef: "main", githubDeployment: "1", branchAlias: "fixture-git-main.vercel.app" } }] }),
      inspectDeployment: () => ({ url: "fixture.vercel.app", readyState: "READY",
        meta: { githubCommitSha: releaseSha, githubCommitRef: "main" }, checks: { "deployment-alias": { state: "failed" } } }),
      inspectAlias: vi.fn(),
    }).catch(failure => failure);
    expect(error).toBeInstanceOf(GitDeploymentReadOnlyFailure);
    const result = await retainOwnedReleaseDiagnosis({ releaseSha, signal: controller.signal, error }, { reconfirmAuthority, checkpoint });
    expect(reconfirmAuthority).toHaveBeenCalledOnce(); expect(checkpoint).toHaveBeenCalledOnce();
    expect(reconfirmAuthority.mock.invocationCallOrder[0]).toBeLessThan(checkpoint.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ outcome: "repair_required", repairPhase: "RELEASE_DIAGNOSIS", releaseCheckOutcome: "failed",
      failureCode: "PRODUCTION_ALIAS_CHECK_FAILED", ownershipRetained: true, durableCloseoutRecorded: false,
      deploymentVerified: false, monitoringVerified: false, deliveryVerified: false, threadDisposition: "KEEP_VISIBLE" });
    expect(result).not.toHaveProperty("deployment"); expect(result?.nextAction).toContain("Do not replay the unchanged failed operation");
    const write = vi.fn();
    await runConfiguredCommand({ argv: ["verify-release"], isWorkerExecutionAllowed: async () => true,
      verifyRelease: async () => result, write });
    expect(write).toHaveBeenCalledExactlyOnceWith(result); expect(process.exitCode).not.toBe(1);
  });

  it.each([new Error("unknown crash"), new Error("Git deployment timed out"),
    new GitDeploymentReadOnlyFailure("b".repeat(40), "PRODUCTION_ALIAS_CHECK_FAILED")])(
    "does not convert unknown or foreign failures into repair authority: %s", async error => {
      const reconfirmAuthority = vi.fn(async () => true), checkpoint = vi.fn(async () => true);
      expect(await retainOwnedReleaseDiagnosis({ error, releaseSha: "a".repeat(40), signal: new AbortController().signal },
        { reconfirmAuthority, checkpoint })).toBeNull();
      expect(reconfirmAuthority).not.toHaveBeenCalled(); expect(checkpoint).not.toHaveBeenCalled();
    });

  it("preserves the stop for legacy/stage-only missions or rejected fresh owner/source/lease authority", async () => {
    const releaseSha = "a".repeat(40), checkpoint = vi.fn(async () => true);
    expect(await retainOwnedReleaseDiagnosis({ releaseSha, signal: new AbortController().signal,
      error: new GitDeploymentReadOnlyFailure(releaseSha, "PRODUCTION_ALIAS_CHECK_FAILED") },
    { reconfirmAuthority: async () => false, checkpoint })).toBeNull();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it.each(["before", "during"])("preserves cancellation %s authority revalidation", async when => {
    const releaseSha = "a".repeat(40), controller = new AbortController(), checkpoint = vi.fn(async () => true);
    if (when === "before") controller.abort(Error("CANCELLED"));
    await expect(retainOwnedReleaseDiagnosis({ releaseSha, signal: controller.signal,
      error: new GitDeploymentReadOnlyFailure(releaseSha, "PRODUCTION_ALIAS_CHECK_FAILED") },
    { reconfirmAuthority: async () => { controller.abort(Error("CANCELLED")); return true; }, checkpoint })).rejects.toThrow("CANCELLED");
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("does not retain the mission when the durable ownership checkpoint fails", async () => {
    const releaseSha = "a".repeat(40);
    await expect(retainOwnedReleaseDiagnosis({ releaseSha, signal: new AbortController().signal,
      error: new GitDeploymentReadOnlyFailure(releaseSha, "PRODUCTION_ALIAS_ASSIGNMENT_FAILED") },
    { reconfirmAuthority: async () => true, checkpoint: async () => false })).rejects.toThrow("lost durable batch ownership");
  });

  it.each(["verify", "verify-release"])("%s returns owned repair work without pretending it closed or passed", async command => {
    const repair = { outcome: "repair_required", stoppedReason: "error", failureCode: "BROWSER_STAGE_NETWORK_FAILED",
      durableCloseoutRecorded: false, closeout: { outcome: "repair_required", ownershipRetained: true, durableCloseoutRecorded: false } };
    const result = command === "verify" ? repair : { outcome: "release_verification_completed", verification: repair };
    const write = vi.fn();
    await runConfiguredCommand({ argv: [command], isWorkerExecutionAllowed: vi.fn(async () => true),
      verify: async () => result, verifyRelease: async () => result, write });
    expect(process.exitCode).not.toBe(1);
    expect(write).toHaveBeenCalledExactlyOnceWith(result);
  });

  it.each(["verify", "verify-release"])(
    "%s fails after successful cleanup and preserves the durable result",
    async (command) => {
      const result = command === "verify"
        ? watchFailure
        : {
            outcome: "release_verification_completed",
            deployment: { source: "git", state: "READY" },
            verification: watchFailure
          };
      const operation = vi.fn(async () => result);
      const write = vi.fn();

      await runConfiguredCommand({
        argv: [command, "--watch", "--closeout"],
        isWorkerExecutionAllowed: vi.fn(async () => true),
        verify: operation,
        verifyRelease: operation,
        write
      });

      expect(operation).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledExactlyOnceWith(
        command === "verify"
          ? result
          : { ...result, outcome: "release_verification_failed" }
      );
      expect(process.exitCode).toBe(1);
    }
  );

  it("does not let a successful fallback course outcome erase the watch error", async () => {
    const result = {
      ...watchFailure,
      closeout: { outcome: "retryable_failed", durableCloseoutRecorded: true }
    };
    const write = vi.fn();
    await runConfiguredCommand({
      argv: ["verify"],
      isWorkerExecutionAllowed: vi.fn(async () => true),
      verify: async () => result,
      write
    });
    expect(process.exitCode).toBe(1);
    expect(write).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("retains zero-execution retry evidence while signaling its infrastructure failure", async () => {
    const result = {
      outcome: "verification_watch_closed",
      stoppedReason: "max",
      closeout: {
        outcome: "command_failed",
        durableCloseoutRecorded: true,
        providerExecutionObservedIncidentCount: 0,
        orchestrationOnlyIncidentCount: 1,
        nextAttemptAt: "2026-09-05T06:15:00.000Z"
      }
    };
    const write = vi.fn();
    await runConfiguredCommand({
      argv: ["verify"],
      isWorkerExecutionAllowed: vi.fn(async () => true),
      verify: async () => result,
      write
    });
    expect(process.exitCode).toBe(1);
    expect(write).toHaveBeenCalledExactlyOnceWith(result);
  });

  it.each(["verify", "verify-release"])(
    "%s preserves an ordinary endpoint retry without manufacturing command failure",
    async (command) => {
      const watch = {
        outcome: "verification_watch_closed",
        stoppedReason: "endpoint",
        failureCode: null,
        closeout: { outcome: "retryable_failed", durableCloseoutRecorded: true }
      };
      const result = command === "verify"
        ? watch
        : { outcome: "release_verification_completed", verification: watch };
      const write = vi.fn();
      await runConfiguredCommand({
        argv: [command],
        isWorkerExecutionAllowed: vi.fn(async () => true),
        verify: async () => result,
        verifyRelease: async () => result,
        write
      });
      expect(process.exitCode).toBeUndefined();
      expect(write).toHaveBeenCalledExactlyOnceWith(result);
    }
  );

  it("keeps successful settled verification successful without clearing an earlier failure", async () => {
    const result = {
      outcome: "verification_watch_settled",
      closeout: { outcome: "success", durableCloseoutRecorded: true }
    };
    const write = vi.fn();
    const input = {
      argv: ["verify"],
      isWorkerExecutionAllowed: vi.fn(async () => true),
      verify: async () => result,
      write
    };
    await runConfiguredCommand(input);
    expect(process.exitCode).toBeUndefined();
    process.exitCode = 1;
    await runConfiguredCommand(input);
    expect(process.exitCode).toBe(1);
  });

  it("propagates a rejected verifier to the existing top-level failure handler", async () => {
    const write = vi.fn();
    const failure = new Error("Verification ownership lost.");
    await expect(runConfiguredCommand({
      argv: ["verify"],
      isWorkerExecutionAllowed: vi.fn(async () => true),
      verify: async () => { throw failure; },
      write
    })).rejects.toBe(failure);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["verify", "verify-release"])(
    "%s preserves durable failure output with a real nonzero process exit",
    (command) => {
      const result = command === "verify"
        ? watchFailure
        : { outcome: "release_verification_completed", verification: watchFailure };
      const child = spawnSync(process.execPath, [
        resolve("node_modules/tsx/dist/cli.mjs"),
        "--eval",
        `import { runConfiguredCommand } from ${JSON.stringify(resolve("scripts/automation/course-support.ts"))};
void runConfiguredCommand({
  argv: [${JSON.stringify(command)}],
  isWorkerExecutionAllowed: async () => true,
  verify: async () => (${JSON.stringify(result)}),
  verifyRelease: async () => (${JSON.stringify(result)})
}).catch(() => { process.exitCode = 2; });`
      ], {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test"
        }
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      const output = JSON.parse(child.stdout.trim());
      expect(output).toEqual(command === "verify"
        ? result
        : { ...result, outcome: "release_verification_failed" });
    },
    20_000
  );
});
