// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryHandlers } from "../../../scripts/automation/course-discovery-handlers.mjs";

function setup(mode?: string) {
  const client = { next: vi.fn(async () => ({ job: "cold" })), nextExecution: vi.fn(async () => ({ job: "warm" })),
    executionResult: vi.fn(), helperEnvironment: vi.fn() };
  const prepareStagehand = vi.fn(), runStagehand = vi.fn(async options => ({ mode: "stagehand", options }));
  const prepareNative = vi.fn(() => "catalog"), runNative = vi.fn(async options => ({ mode: "native", options }));
  const executeRecipe = vi.fn(async options => ({ complete: true, options }));
  const handlers = createCourseDiscoveryHandlers({ client, cwd: "/owned/worktree", ...(mode ? { mode } : {}),
    prepareStagehand, runStagehand, prepareNative, runNative, executeRecipe });
  return { client, prepareStagehand, runStagehand, prepareNative, runNative, executeRecipe, handlers };
}

describe("normal learning worker and restart-only selection", () => {
  it("uses the verified Stagehand/Sol path by default", async () => {
    const f = setup();
    await f.handlers.prepareWorker();
    await f.handlers.startWorker({ job: { id: "job" }, workDeadlineAt: "original" });
    expect(f.prepareStagehand).toHaveBeenCalledExactlyOnceWith({ cwd: "/owned/worktree" });
    expect(f.runStagehand).toHaveBeenCalledWith(expect.objectContaining({ client: f.client, cwd: "/owned/worktree", model: "gpt-6.1-sol", workDeadlineAt: "original" }));
    expect(f.prepareNative).not.toHaveBeenCalled();
    expect(f.runNative).not.toHaveBeenCalled();
  });
  it("keeps an explicit Sol-only rollback without silently falling back on failure", async () => {
    const f = setup("NATIVE_SOL");
    await f.handlers.prepareWorker();
    await f.handlers.startWorker({ job: { id: "job" } });
    expect(f.runNative).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-6.1-sol", modelCatalogJson: "catalog" }));
    expect(f.runStagehand).not.toHaveBeenCalled();
    const selected = setup();
    selected.runStagehand.mockRejectedValueOnce(new Error("source failed"));
    await expect(selected.handlers.startWorker({})).rejects.toThrow("source failed");
    expect(selected.runNative).not.toHaveBeenCalled();
  });
  it("restarts saved execution with no cold claims, account preparation or model calls", async () => {
    const f = setup("REUSE_ONLY");
    await f.handlers.prepareWorker();
    expect(await f.handlers.client.next("worker")).toEqual({ job: null });
    expect(await f.handlers.client.nextExecution("worker")).toEqual({ job: "warm" });
    const options = { recipe: { hash: "saved" }, input: { players: 3 }, helperEnvironment: { lease: "owned" } };
    await f.handlers.executeRecipe(options);
    expect(f.executeRecipe).toHaveBeenCalledExactlyOnceWith({ ...options, cwd: "/owned/worktree" });
    expect(() => f.handlers.startWorker({})).toThrow("DISCOVERY_MODELS_DISABLED");
    for (const action of [f.client.next, f.prepareStagehand, f.runStagehand, f.prepareNative, f.runNative]) expect(action).not.toHaveBeenCalled();
  });
  it("does not accept arbitrary or misspelled worker strategies", () => {
    for (const mode of ["ASTRA", "stagehand", "*", "AUTO_FALLBACK"]) expect(() => setup(mode)).toThrow("DISCOVERY_WORKER_MODE_INVALID");
  });
});
