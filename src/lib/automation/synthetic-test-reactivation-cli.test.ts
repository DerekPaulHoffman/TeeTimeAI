import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSyntheticReactivationCli, runSyntheticReactivationCommand } from "../../../scripts/automation/reactivate-synthetic-search";
import type { SyntheticReactivationResult } from "./synthetic-test-reactivation";

type Dependencies = NonNullable<Parameters<typeof runSyntheticReactivationCommand>[2]>;

describe("synthetic reactivation command boundary", () => {
  const runtimeVersion = "a".repeat(40);
  const rawInput = Object.freeze({
    searchId: "synthetic-search", actorId: "synthetic-operator", idempotencyKey: "synthetic-request",
    expectedScheduleVersion: 3, expectedAlertGeneration: 7,
    expectedUpdatedAt: "2026-07-15T12:00:00.000Z", date: "2026-07-18", durationMinutes: 60,
  });
  const aggregate: SyntheticReactivationResult = {
    outcome: "ready", applied: false, replayed: false, selectedSearchCount: 1,
    scheduleVersion: 4, alertGeneration: 8, expiresAt: "2026-07-15T13:00:00.000Z",
    providerCalls: 0, emailSendCalls: 0, workflowStartCalls: 0,
  };
  const reactivate = vi.fn<Dependencies["reactivate"]>();
  const readGit = vi.fn<Dependencies["readGit"]>();
  const providerFetch = vi.fn(async () => { throw new Error("Unexpected provider I/O"); });
  let git: { head: string; main: string; status: string; branch: string };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "b".repeat(40));
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "synthetic-deployment");
    vi.stubGlobal("fetch", providerFetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    git = { head: runtimeVersion, main: runtimeVersion, status: "", branch: "automation/course-support-synthetic-window" };
    readGit.mockImplementation((args) => {
      switch (args.join(" ")) {
        case "rev-parse HEAD": return git.head;
        case "rev-parse origin/main": return git.main;
        case "status --porcelain": return git.status;
        case "branch --show-current": return git.branch;
        default: throw new Error("Unexpected Git command");
      }
    });
    reactivate.mockResolvedValue(aggregate);
  });

  afterEach(() => {
    expect(providerFetch).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function run(args: string[], environment: string | undefined = process.env.VERCEL_ENV) {
    return runSyntheticReactivationCommand(args, rawInput, { environment, readGit, reactivate });
  }

  it.each(["production", "preview"])("defaults to dry run against the matching %s environment", async (environment) => {
    vi.stubEnv("VERCEL_ENV", environment);

    const result = await run(["--environment", environment]);

    expect(reactivate).toHaveBeenCalledExactlyOnceWith(rawInput, { apply: false, runtimeVersion });
    expect(reactivate.mock.calls[0]?.[0]).toBe(rawInput);
    expect(result).toBe(aggregate);
    expect(readGit).toHaveBeenCalledWith(["rev-parse", "HEAD"]);
    expect(readGit).toHaveBeenCalledWith(["rev-parse", "origin/main"]);
    expect(readGit).toHaveBeenCalledWith(["status", "--porcelain"]);
    expect(readGit).toHaveBeenCalledWith(["branch", "--show-current"]);
    expect(process.env.VERCEL_ENV).toBe(environment);
    expect(process.env.VERCEL_GIT_COMMIT_SHA).toBe("b".repeat(40));
    expect(process.env.VERCEL_DEPLOYMENT_ID).toBe("synthetic-deployment");
    expect(JSON.stringify(result)).not.toContain(rawInput.searchId);
    expect(JSON.stringify(result)).not.toContain(rawInput.actorId);
    expect(JSON.stringify(result)).not.toContain(rawInput.idempotencyKey);
  });

  it.each([
    ["--environment", "production", "--apply"],
    ["--apply", "--environment", "production"],
    ["--environment", "preview", "--apply"],
  ])("passes one explicit apply through unchanged for %j", async (...args) => {
    vi.stubEnv("VERCEL_ENV", args.includes("preview") ? "preview" : "production");
    const applied: SyntheticReactivationResult = { ...aggregate, outcome: "queued_for_recovery", applied: true };
    reactivate.mockResolvedValueOnce(applied);

    expect(await run(args)).toBe(applied);

    expect(reactivate).toHaveBeenCalledExactlyOnceWith(rawInput, { apply: true, runtimeVersion });
    expect(reactivate.mock.calls[0]?.[0]).toBe(rawInput);
  });

  it.each([
    { name: "missing environment option", args: [], environment: "production" },
    { name: "missing environment value", args: ["--environment"], environment: "production" },
    { name: "missing wrapped environment", args: ["--environment", "production"], environment: undefined },
    { name: "mismatched wrapper", args: ["--environment", "production"], environment: "preview" },
    { name: "unsupported environment", args: ["--environment", "development"], environment: "development" },
    { name: "unknown argument", args: ["--environment", "production", "--force"], environment: "production" },
    { name: "duplicate apply", args: ["--environment", "production", "--apply", "--apply"], environment: "production" },
    { name: "duplicate environment", args: ["--environment", "production", "--environment", "production"], environment: "production" },
    { name: "extra payload argument", args: ["--environment", "production", "extra"], environment: "production" },
  ])("rejects $name before Git or service work", async ({ args, environment }) => {
    await expect(runSyntheticReactivationCommand(args, rawInput, { environment, readGit, reactivate })).rejects.toThrow("exact wrapped environment");
    expect(readGit).not.toHaveBeenCalled();
    expect(reactivate).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unstaged change", head: runtimeVersion, main: runtimeVersion, status: " M src/synthetic.ts" },
    { name: "staged change", head: runtimeVersion, main: runtimeVersion, status: "M  src/synthetic.ts" },
    { name: "untracked file", head: runtimeVersion, main: runtimeVersion, status: "?? src/synthetic.ts" },
    { name: "missing SHA", head: "", main: runtimeVersion, status: "" },
    { name: "short SHA", head: "aaaaaaa", main: "aaaaaaa", status: "" },
    { name: "non-Git runtime", head: "local", main: "local", status: "" },
    { name: "noncanonical SHA", head: "A".repeat(40), main: "A".repeat(40), status: "" },
    { name: "unpublished HEAD", head: runtimeVersion, main: "b".repeat(40), status: "" },
  ])("rejects $name without calling the service", async ({ head, main, status }) => {
    git = { ...git, head, main, status };
    await expect(run(["--environment", "production", "--apply"])).rejects.toThrow("clean exact-main checkout");
    expect(reactivate).not.toHaveBeenCalled();
  });

  it.each(["", "main", "master", "HEAD"].flatMap((branch) => [false, true].map((apply) => ({ branch, apply }))))(
    "rejects branch '$branch' with apply=$apply before the service call", async ({ branch, apply }) => {
      git.branch = branch;
      await expect(run(["--environment", "production", ...(apply ? ["--apply"] : [])])).rejects.toThrow();
      expect(readGit).toHaveBeenCalledWith(["branch", "--show-current"]);
      expect(reactivate).not.toHaveBeenCalled();
    },
  );

  it("preserves a native service rejection without retrying or producing output", async () => {
    const failure = new Error("Synthetic selection fence changed");
    reactivate.mockRejectedValueOnce(failure);
    await expect(run(["--environment", "production", "--apply"])).rejects.toBe(failure);
    expect(reactivate).toHaveBeenCalledOnce();
  });

  it("suppresses native work and cleanup diagnostics while emitting one aggregate and restoring streams", async () => {
    const stdoutWrite = vi.fn<NodeJS.WriteStream["write"]>().mockReturnValue(true);
    const stderrWrite = vi.fn<NodeJS.WriteStream["write"]>().mockReturnValue(true);
    const streams = { stdout: { write: stdoutWrite }, stderr: { write: stderrWrite } };
    const workCallback = vi.fn();
    const cleanupCallback = vi.fn();
    const work = vi.fn(async () => {
      expect(streams.stdout.write("synthetic-private-work", workCallback)).toBe(true);
      streams.stderr.write("synthetic-private-diagnostic");
      return aggregate;
    });
    const cleanup = vi.fn(async () => {
      streams.stdout.write("synthetic-private-cleanup");
      streams.stderr.write("synthetic-private-cleanup-error", "utf8", cleanupCallback);
    });

    expect(await runSyntheticReactivationCli(work, cleanup, streams)).toBe(0);

    expect(work).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(workCallback).toHaveBeenCalledExactlyOnceWith();
    expect(cleanupCallback).toHaveBeenCalledExactlyOnceWith();
    expect(stdoutWrite).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(aggregate)}\n`);
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(streams.stdout.write).toBe(stdoutWrite);
    expect(streams.stderr.write).toBe(stderrWrite);
  });

  it("redacts native database errors and cleanup noise without retrying the operation", async () => {
    const stdoutWrite = vi.fn<NodeJS.WriteStream["write"]>().mockReturnValue(true);
    const stderrWrite = vi.fn<NodeJS.WriteStream["write"]>().mockReturnValue(true);
    const streams = { stdout: { write: stdoutWrite }, stderr: { write: stderrWrite } };
    const work = vi.fn(async () => {
      streams.stderr.write("synthetic-private-database-query");
      throw new Error("synthetic-private-database-error");
    });
    const cleanup = vi.fn(async () => { streams.stdout.write("synthetic-private-disconnect"); });

    expect(await runSyntheticReactivationCli(work, cleanup, streams)).toBe(1);

    expect(work).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(stdoutWrite).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({
      outcome: "UNKNOWN", code: "SYNTHETIC_REACTIVATION_FAILED",
    })}\n`);
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(streams.stdout.write).toBe(stdoutWrite);
    expect(streams.stderr.write).toBe(stderrWrite);
  });

  it("reports an unknown cleanup outcome after successful work without leaking or retrying", async () => {
    const stdoutWrite = vi.fn<NodeJS.WriteStream["write"]>().mockReturnValue(true);
    const stderrWrite = vi.fn<NodeJS.WriteStream["write"]>().mockReturnValue(true);
    const streams = { stdout: { write: stdoutWrite }, stderr: { write: stderrWrite } };
    const work = vi.fn(async () => aggregate);
    const cleanup = vi.fn(async () => {
      streams.stderr.write("synthetic-private-cleanup");
      throw new Error("synthetic-private-cleanup-error");
    });

    expect(await runSyntheticReactivationCli(work, cleanup, streams)).toBe(1);

    expect(work).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(stdoutWrite).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({
      outcome: "UNKNOWN", code: "SYNTHETIC_REACTIVATION_FAILED",
    })}\n`);
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(streams.stdout.write).toBe(stdoutWrite);
    expect(streams.stderr.write).toBe(stderrWrite);
  });
});
