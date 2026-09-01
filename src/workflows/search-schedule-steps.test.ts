import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachSearchWorkflowRun: vi.fn(),
  buildSearchScheduleReference: vi.fn(),
  executeScheduledSearchCheck: vi.fn(),
  getWorkflowMetadata: vi.fn(),
  getSearchScheduleState: vi.fn(),
  launchSearchScheduleWorkflow: vi.fn(),
}));

vi.mock("workflow", () => ({
  getWorkflowMetadata: mocks.getWorkflowMetadata,
}));
vi.mock("@/lib/automation/db-service", () => ({
  attachSearchWorkflowRun: mocks.attachSearchWorkflowRun,
  getSearchScheduleState: mocks.getSearchScheduleState
}));
vi.mock("@/lib/automation/search-recheck-queue", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/automation/search-recheck-queue")
  >()),
  buildSearchScheduleReference: mocks.buildSearchScheduleReference,
}));
vi.mock("@/lib/automation/search-schedule-execution", () => ({
  executeScheduledSearchCheck: mocks.executeScheduledSearchCheck
}));
vi.mock("@/lib/automation/search-schedule-launcher", () => ({
  launchSearchScheduleWorkflow: mocks.launchSearchScheduleWorkflow
}));
import {
  executeSearchCheckStep,
  startNextSearchCheckStep
} from "./search-schedule-steps";

describe("search schedule workflow steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildSearchScheduleReference.mockReturnValue("search-ref");
    mocks.getWorkflowMetadata.mockReturnValue({
      workflowRunId: "current-run",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates a scheduled check with the exact search schedule version", async () => {
    const result = {
      outcome: "checked",
      nextCheckAt: new Date("2026-07-16T14:00:00.000Z")
    };
    mocks.executeScheduledSearchCheck.mockResolvedValue(result);

    await expect(executeSearchCheckStep("search-1", 7)).resolves.toBe(result);

    expect(mocks.executeScheduledSearchCheck).toHaveBeenCalledOnce();
    expect(mocks.executeScheduledSearchCheck).toHaveBeenCalledWith("search-1", 7);
  });

  it("stops without starting a successor when the schedule is no longer current", async () => {
    mocks.getSearchScheduleState.mockResolvedValue(null);

    await expect(startNextSearchCheckStep("search-1", 7)).resolves.toBeNull();

    expect(mocks.getSearchScheduleState).toHaveBeenCalledWith("search-1", 7);
    expect(mocks.launchSearchScheduleWorkflow).not.toHaveBeenCalled();
    expect(mocks.attachSearchWorkflowRun).not.toHaveBeenCalled();
  });

  it("starts the successor on the latest deployment and attaches it with CAS ownership", async () => {
    mocks.getSearchScheduleState.mockResolvedValue({
      workflowRunId: "current-run"
    });
    mocks.launchSearchScheduleWorkflow.mockResolvedValue({ runId: "successor-run" });
    mocks.attachSearchWorkflowRun.mockResolvedValue({ count: 1 });

    await expect(startNextSearchCheckStep("search-1", 7)).resolves.toBe(
      "successor-run"
    );

    expect(mocks.launchSearchScheduleWorkflow).toHaveBeenCalledWith("search-1", 7);
    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledTimes(2);
    expect(mocks.attachSearchWorkflowRun).toHaveBeenNthCalledWith(
      1,
      "search-1",
      7,
      expect.stringMatching(/^tee-search-schedule-starting:/),
      "current-run"
    );
    expect(mocks.attachSearchWorkflowRun).toHaveBeenLastCalledWith(
      "search-1",
      7,
      "successor-run",
      expect.stringMatching(/^tee-search-schedule-starting:/)
    );
  });

  it("allows only one replayed successor step to start the same generation", async () => {
    let workflowRunId: string | null = "current-run";
    mocks.getSearchScheduleState.mockResolvedValue({
      workflowRunId: "current-run"
    });
    mocks.launchSearchScheduleWorkflow.mockResolvedValue({
      runId: "only-successor"
    });
    mocks.attachSearchWorkflowRun.mockImplementation(
      async (
        _searchId: string,
        _scheduleVersion: number,
        nextWorkflowRunId: string,
        expectedWorkflowRunId: string | null
      ) => {
        if (workflowRunId !== expectedWorkflowRunId) return { count: 0 };
        workflowRunId = nextWorkflowRunId;
        return { count: 1 };
      }
    );

    const results = await Promise.all([
      startNextSearchCheckStep("search-1", 7),
      startNextSearchCheckStep("search-1", 7)
    ]);

    expect(results.sort()).toEqual(["only-successor", null].sort());
    expect(mocks.launchSearchScheduleWorkflow).toHaveBeenCalledTimes(1);
    expect(workflowRunId).toBe("only-successor");
  });

  it("does not start a second successor when the completed step replays", async () => {
    let workflowRunId = "current-run";
    mocks.getSearchScheduleState.mockImplementation(async () => ({
      workflowRunId,
    }));
    mocks.launchSearchScheduleWorkflow.mockResolvedValue({
      runId: "successor-run",
    });
    mocks.attachSearchWorkflowRun.mockImplementation(
      async (
        _searchId: string,
        _scheduleVersion: number,
        nextWorkflowRunId: string,
        expectedWorkflowRunId: string | null,
      ) => {
        if (workflowRunId !== expectedWorkflowRunId) return { count: 0 };
        workflowRunId = nextWorkflowRunId;
        return { count: 1 };
      },
    );

    await expect(startNextSearchCheckStep("search-1", 7)).resolves.toBe(
      "successor-run",
    );
    await expect(startNextSearchCheckStep("search-1", 7)).resolves.toBeNull();

    expect(mocks.launchSearchScheduleWorkflow).toHaveBeenCalledTimes(1);
    expect(workflowRunId).toBe("successor-run");
  });

  it("retains the durable reservation when successor start throws ambiguously", async () => {
    let workflowRunId: string | null = "current-run";
    mocks.getSearchScheduleState.mockResolvedValue({
      workflowRunId: "current-run"
    });
    mocks.launchSearchScheduleWorkflow.mockRejectedValue(
      new Error("workflow start unavailable")
    );
    mocks.attachSearchWorkflowRun.mockImplementation(
      async (
        _searchId: string,
        _scheduleVersion: number,
        nextWorkflowRunId: string,
        expectedWorkflowRunId: string | null
      ) => {
        if (workflowRunId !== expectedWorkflowRunId) return { count: 0 };
        workflowRunId = nextWorkflowRunId;
        return { count: 1 };
      }
    );

    await expect(startNextSearchCheckStep("search-1", 7)).resolves.toBeNull();

    expect(workflowRunId).toMatch(/^tee-search-schedule-starting:/);
    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("stops before Workflow when another starter already holds a reservation", async () => {
    mocks.getSearchScheduleState.mockResolvedValue({
      workflowRunId: "tee-search-schedule-starting:existing"
    });

    await expect(startNextSearchCheckStep("search-1", 7)).resolves.toBeNull();

    expect(mocks.attachSearchWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.launchSearchScheduleWorkflow).not.toHaveBeenCalled();
  });
});
