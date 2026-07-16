import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachSearchWorkflowRun: vi.fn(),
  buildSearchScheduleReference: vi.fn(),
  executeScheduledSearchCheck: vi.fn(),
  failScheduledSearchCheck: vi.fn(),
  getSearchScheduleState: vi.fn(),
  recoverSearchScheduleStartFailure: vi.fn(),
  searchScheduleWorkflow: vi.fn(),
  start: vi.fn()
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/automation/db-service", () => ({
  attachSearchWorkflowRun: mocks.attachSearchWorkflowRun,
  failScheduledSearchCheck: mocks.failScheduledSearchCheck,
  getSearchScheduleState: mocks.getSearchScheduleState
}));
vi.mock("@/lib/automation/search-recheck-queue", () => ({
  buildSearchScheduleReference: mocks.buildSearchScheduleReference,
  recoverSearchScheduleStartFailure: mocks.recoverSearchScheduleStartFailure
}));
vi.mock("@/lib/automation/search-schedule-execution", () => ({
  executeScheduledSearchCheck: mocks.executeScheduledSearchCheck
}));
vi.mock("./search-schedule", () => ({
  searchScheduleWorkflow: mocks.searchScheduleWorkflow
}));

import {
  executeSearchCheckStep,
  startNextSearchCheckStep
} from "./search-schedule-steps";

describe("search schedule workflow steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildSearchScheduleReference.mockReturnValue("search-ref");
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
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.attachSearchWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.failScheduledSearchCheck).not.toHaveBeenCalled();
    expect(mocks.recoverSearchScheduleStartFailure).not.toHaveBeenCalled();
  });

  it("starts the successor on the latest deployment and attaches it with CAS ownership", async () => {
    mocks.getSearchScheduleState.mockResolvedValue({
      workflowRunId: "current-run"
    });
    mocks.start.mockResolvedValue({ runId: "successor-run" });
    mocks.attachSearchWorkflowRun.mockResolvedValue({ count: 1 });

    await expect(startNextSearchCheckStep("search-1", 7)).resolves.toBe(
      "successor-run"
    );

    expect(mocks.start).toHaveBeenCalledWith(
      mocks.searchScheduleWorkflow,
      ["search-1", 7],
      { deploymentId: "latest" }
    );
    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledWith(
      "search-1",
      7,
      "successor-run",
      "current-run"
    );
    expect(mocks.failScheduledSearchCheck).not.toHaveBeenCalled();
    expect(mocks.recoverSearchScheduleStartFailure).not.toHaveBeenCalled();
  });

  it("persists a start failure and invokes queue or direct recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T13:00:00.000Z"));
    mocks.getSearchScheduleState.mockResolvedValue({
      workflowRunId: "current-run"
    });
    mocks.start.mockRejectedValue(new Error("workflow start unavailable"));
    mocks.failScheduledSearchCheck.mockResolvedValue({
      count: 1,
      nextCheckAt: new Date("2026-07-16T13:05:00.000Z")
    });
    mocks.recoverSearchScheduleStartFailure.mockResolvedValue({ outcome: "queued" });

    await expect(startNextSearchCheckStep("search-1", 7)).resolves.toBeNull();

    expect(mocks.failScheduledSearchCheck).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 7,
      message: "workflow start unavailable",
      nextCheckAt: new Date("2026-07-16T13:05:00.000Z"),
      expectedWorkflowRunId: "current-run"
    });
    expect(mocks.recoverSearchScheduleStartFailure).toHaveBeenCalledOnce();
    expect(mocks.recoverSearchScheduleStartFailure).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 7,
      trigger: "START_FAILED"
    });
    expect(mocks.attachSearchWorkflowRun).not.toHaveBeenCalled();
  });

  it("does not enqueue recovery after a stale failure update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T13:00:00.000Z"));
    mocks.getSearchScheduleState.mockResolvedValue({
      workflowRunId: "current-run"
    });
    mocks.start.mockRejectedValue(new Error("workflow start unavailable"));
    mocks.failScheduledSearchCheck.mockResolvedValue({
      count: 0,
      nextCheckAt: null
    });

    await expect(startNextSearchCheckStep("search-1", 7)).resolves.toBeNull();

    expect(mocks.failScheduledSearchCheck).toHaveBeenCalledOnce();
    expect(mocks.recoverSearchScheduleStartFailure).not.toHaveBeenCalled();
    expect(mocks.attachSearchWorkflowRun).not.toHaveBeenCalled();
  });
});
