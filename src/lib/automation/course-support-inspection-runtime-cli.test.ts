import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inspectionMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  inspectQueue: vi.fn(),
  attachAcceptance: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, execFileSync: inspectionMocks.execFileSync },
    execFileSync: inspectionMocks.execFileSync,
  };
});

vi.mock("@/lib/automation/course-support-batches", async (importOriginal) => ({
  ...await importOriginal<typeof import("./course-support-batches")>(),
  inspectCourseSupportQueue: inspectionMocks.inspectQueue,
}));

vi.mock("@/lib/operator/course-support-acceptance-process", () => ({
  attachCourseSupportAcceptanceProjectionFromWorker: inspectionMocks.attachAcceptance,
}));

import { runConfiguredCommand } from "../../../scripts/automation/course-support";
import { getAutomationRuntimeVersion } from "./runtime-version";

describe("course-support inspection selection runtime", () => {
  const headSha = "a".repeat(40);
  const staleSha = "b".repeat(40);
  const ownerThreadId = "synthetic-inspection-owner";
  const queueResult = { outcome: "ready", parkedCampaign: { readyCount: 1 } };
  const providerFetch = vi.fn(async () => {
    throw new Error("Inspection runtime selection must not perform provider I/O");
  });
  let git: { branch: string; headSha: string; originMainSha: string; status: string };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODEX_THREAD_ID", ownerThreadId);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", undefined);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", undefined);
    vi.stubGlobal("fetch", providerFetch);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    git = { branch: "automation/course-support-inspection", headSha, originMainSha: headSha, status: "" };
    inspectionMocks.inspectQueue.mockResolvedValue(queueResult);
    inspectionMocks.attachAcceptance.mockImplementation(async (result) => result);
    inspectionMocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      expect(file).toBe("git");
      switch (args.join(" ")) {
        case "branch --show-current": return `${git.branch}\n`;
        case "rev-parse HEAD": return `${git.headSha}\n`;
        case "rev-parse origin/main": return `${git.originMainSha}\n`;
        case "status --porcelain=v1 -z": return git.status;
        default: throw new Error("Unexpected Git command in inspection");
      }
    });
  });

  afterEach(() => {
    expect(providerFetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function run() {
    return runConfiguredCommand({
      argv: ["inspect", "--owner-thread", ownerThreadId],
      isWorkerExecutionAllowed: vi.fn(async () => true),
    });
  }

  it.each([
    { name: "missing Vercel runtime", commit: undefined, deployment: undefined, runtime: "local" },
    { name: "stale Vercel commit", commit: staleSha, deployment: "synthetic-deployment", runtime: staleSha },
    { name: "deployment-only runtime", commit: undefined, deployment: "synthetic-deployment", runtime: "synthetic-deployment" },
    { name: "matching Vercel commit", commit: headSha, deployment: undefined, runtime: headSha },
  ])("passes the exact clean checkout only for admission with $name", async ({ commit, deployment, runtime }) => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", commit);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", deployment);
    expect(getAutomationRuntimeVersion()).toBe(runtime);

    await run();

    expect(inspectionMocks.inspectQueue).toHaveBeenCalledExactlyOnceWith({
      requestingThreadId: ownerThreadId,
      completeParkedCampaignIfDone: false,
      admissionRuntimeVersion: headSha,
    });
    expect(inspectionMocks.attachAcceptance).toHaveBeenCalledExactlyOnceWith(queueResult);
    expect(inspectionMocks.execFileSync).toHaveBeenCalledWith("git", ["rev-parse", "origin/main"], expect.anything());
    expect(getAutomationRuntimeVersion()).toBe(runtime);
    expect(process.env.VERCEL_GIT_COMMIT_SHA).toBe(commit);
    expect(process.env.VERCEL_DEPLOYMENT_ID).toBe(deployment);
  });

  it.each([
    { name: "dirty tracked checkout", change: { status: " M src/synthetic.ts\0" } },
    { name: "untracked work", change: { status: "?? synthetic.ts\0" } },
    { name: "main checkout", change: { branch: "main" } },
    { name: "unrelated task branch", change: { branch: "fix/synthetic-inspection" } },
    { name: "empty task suffix", change: { branch: "automation/course-support-" } },
    { name: "detached checkout", change: { branch: "" } },
    { name: "diverged checkout", change: { originMainSha: staleSha } },
    { name: "abbreviated checkout SHA", change: { headSha: "a".repeat(39), originMainSha: "a".repeat(39) } },
    { name: "invalid checkout SHA", change: { headSha: "g".repeat(40), originMainSha: "g".repeat(40) } },
    { name: "invalid origin SHA", change: { originMainSha: "UNKNOWN" } },
  ])("keeps ordinary inspection available without an override for $name", async ({ change }) => {
    git = { ...git, ...change };
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", staleSha);

    await expect(run()).resolves.toBeUndefined();

    expect(inspectionMocks.inspectQueue).toHaveBeenCalledOnce();
    expect(inspectionMocks.inspectQueue.mock.calls[0]?.[0].admissionRuntimeVersion).toBeUndefined();
    expect(inspectionMocks.attachAcceptance).toHaveBeenCalledExactlyOnceWith(queueResult);
    expect(getAutomationRuntimeVersion()).toBe(staleSha);
    expect(process.env.VERCEL_GIT_COMMIT_SHA).toBe(staleSha);
    expect(process.env.VERCEL_DEPLOYMENT_ID).toBeUndefined();
  });

  it("keeps ordinary inspection available when Git cannot be read", async () => {
    inspectionMocks.execFileSync.mockImplementation(() => { throw new Error("Synthetic Git unavailable"); });

    await expect(run()).resolves.toBeUndefined();

    expect(inspectionMocks.inspectQueue).toHaveBeenCalledOnce();
    expect(inspectionMocks.inspectQueue.mock.calls[0]?.[0].admissionRuntimeVersion).toBeUndefined();
    expect(getAutomationRuntimeVersion()).toBe("local");
  });

  it("does not inspect Git or campaign state when the worker is paused", async () => {
    await runConfiguredCommand({ argv: ["inspect"], isWorkerExecutionAllowed: vi.fn(async () => false) });

    expect(inspectionMocks.execFileSync).not.toHaveBeenCalled();
    expect(inspectionMocks.inspectQueue).not.toHaveBeenCalled();
  });
});
