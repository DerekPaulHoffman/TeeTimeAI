import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runConfiguredCommand } from "../../../scripts/automation/course-support";

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
