import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachSearchWorkflowRun: vi.fn(),
  failScheduledSearchCheck: vi.fn(),
  getSearchCheckRequestState: vi.fn(),
  queueSearchCheck: vi.fn(),
  recoverSearchScheduleStartFailure: vi.fn(),
  searchScheduleWorkflow: vi.fn(),
  start: vi.fn()
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/automation/db-service", () => ({
  attachSearchWorkflowRun: mocks.attachSearchWorkflowRun,
  failScheduledSearchCheck: mocks.failScheduledSearchCheck,
  getSearchCheckRequestState: mocks.getSearchCheckRequestState,
  queueSearchCheck: mocks.queueSearchCheck
}));
vi.mock("@/lib/automation/search-recheck-queue", () => ({
  buildSearchScheduleReference: vi.fn(),
  recoverSearchScheduleStartFailure: mocks.recoverSearchScheduleStartFailure
}));
vi.mock("@/workflows/search-schedule", () => ({
  searchScheduleWorkflow: mocks.searchScheduleWorkflow
}));

import { startSearchSchedule } from "./search-scheduler";

describe("guarded search schedule start", () => {
  const expectedState = {
    scheduleVersion: 8,
    updatedAt: new Date("2026-07-16T18:29:00.000Z"),
    observedAt: new Date("2026-07-16T18:30:00.000Z")
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not start Workflow when the expected state is no longer eligible", async () => {
    mocks.queueSearchCheck.mockResolvedValue({
      outcome: "not_eligible",
      reason: "state_changed"
    });

    await expect(
      startSearchSchedule("search-1", {
        expectedState
      })
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.attachSearchWorkflowRun).not.toHaveBeenCalled();
  });

  it("starts and attaches the exact guarded schedule version", async () => {
    mocks.queueSearchCheck.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      updatedAt: new Date("2026-07-16T18:30:01.000Z")
    });
    mocks.start.mockResolvedValue({ runId: "run-1" });
    mocks.attachSearchWorkflowRun.mockResolvedValue({ count: 1 });

    await expect(
      startSearchSchedule("search-1", { expectedState })
    ).resolves.toEqual({ runId: "run-1", scheduleVersion: 9, reused: false });

    expect(mocks.queueSearchCheck).toHaveBeenCalledWith(
      "search-1",
      undefined,
      expectedState
    );
    expect(mocks.start).toHaveBeenCalledWith(
      mocks.searchScheduleWorkflow,
      ["search-1", 9],
      { deploymentId: "latest" }
    );
    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledWith(
      "search-1",
      9,
      "run-1",
      null
    );
    expect(mocks.failScheduledSearchCheck).not.toHaveBeenCalled();
  });

  it("does not report a guarded start whose Workflow attachment lost a race", async () => {
    mocks.queueSearchCheck.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      updatedAt: new Date("2026-07-16T18:30:01.000Z")
    });
    mocks.start.mockResolvedValue({ runId: "stale-run" });
    mocks.attachSearchWorkflowRun.mockResolvedValue({ count: 0 });

    await expect(
      startSearchSchedule("search-1", { expectedState })
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledWith(
      "search-1",
      9,
      "stale-run",
      null
    );
    expect(mocks.failScheduledSearchCheck).not.toHaveBeenCalled();
    expect(mocks.recoverSearchScheduleStartFailure).not.toHaveBeenCalled();
  });

  it("recovers a guarded schedule when Workflow start fails", async () => {
    const startError = new Error("Workflow start failed");
    mocks.queueSearchCheck.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      updatedAt: new Date("2026-07-16T18:30:01.000Z")
    });
    mocks.start.mockRejectedValue(startError);
    mocks.failScheduledSearchCheck.mockResolvedValue({ count: 1 });
    mocks.recoverSearchScheduleStartFailure.mockResolvedValue({ outcome: "queued" });

    await expect(
      startSearchSchedule("search-1", { expectedState })
    ).rejects.toBe(startError);

    expect(mocks.attachSearchWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.failScheduledSearchCheck).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 9,
      message: "Workflow start failed",
      nextCheckAt: expect.any(Date),
      expectedWorkflowRunId: null
    });
    expect(mocks.recoverSearchScheduleStartFailure).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 9,
      trigger: "START_FAILED"
    });
  });

  it("recovers the queued version when attaching a started Workflow fails", async () => {
    const attachError = new Error("Workflow attach failed");
    mocks.queueSearchCheck.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      updatedAt: new Date("2026-07-16T18:30:01.000Z")
    });
    mocks.start.mockResolvedValue({ runId: "run-1" });
    mocks.attachSearchWorkflowRun.mockRejectedValue(attachError);
    mocks.failScheduledSearchCheck.mockResolvedValue({ count: 1 });
    mocks.recoverSearchScheduleStartFailure.mockResolvedValue({ outcome: "queued" });

    await expect(
      startSearchSchedule("search-1", { expectedState })
    ).rejects.toBe(attachError);

    expect(mocks.failScheduledSearchCheck).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 9,
      message: "Workflow attach failed",
      nextCheckAt: expect.any(Date),
      expectedWorkflowRunId: null
    });
    expect(mocks.recoverSearchScheduleStartFailure).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 9,
      trigger: "START_FAILED"
    });
  });
});
