import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachSearchWorkflowRun: vi.fn(),
  getSearchCheckRequestState: vi.fn(),
  queueSearchCheck: vi.fn(),
  searchScheduleWorkflow: vi.fn(),
  start: vi.fn()
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/automation/db-service", () => ({
  attachSearchWorkflowRun: mocks.attachSearchWorkflowRun,
  getSearchCheckRequestState: mocks.getSearchCheckRequestState,
  queueSearchCheck: mocks.queueSearchCheck
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
    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledTimes(2);
    expect(mocks.attachSearchWorkflowRun).toHaveBeenNthCalledWith(
      1,
      "search-1",
      9,
      expect.stringMatching(/^tee-search-schedule-starting:/),
      null
    );
    expect(mocks.attachSearchWorkflowRun).toHaveBeenLastCalledWith(
      "search-1",
      9,
      "run-1",
      expect.stringMatching(/^tee-search-schedule-starting:/)
    );
  });

  it("does not start Workflow when the durable reservation loses a race", async () => {
    mocks.queueSearchCheck.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      updatedAt: new Date("2026-07-16T18:30:01.000Z")
    });
    mocks.attachSearchWorkflowRun.mockResolvedValue({ count: 0 });

    await expect(
      startSearchSchedule("search-1", { expectedState })
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledWith(
      "search-1",
      9,
      expect.stringMatching(/^tee-search-schedule-starting:/),
      null
    );
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("allows only one guarded caller to start the same queued generation", async () => {
    let workflowRunId: string | null = null;
    mocks.queueSearchCheck.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      updatedAt: new Date("2026-07-16T18:30:01.000Z")
    });
    mocks.start.mockResolvedValue({ runId: "only-run" });
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
      startSearchSchedule("search-1", { expectedState }),
      startSearchSchedule("search-1", { expectedState })
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        { runId: "only-run", scheduleVersion: 9, reused: false },
        { outcome: "not_eligible", reason: "state_changed" }
      ])
    );
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(workflowRunId).toBe("only-run");
  });

  it("retains the durable reservation when Workflow start throws ambiguously", async () => {
    const startError = new Error("Workflow start failed");
    let workflowRunId: string | null = null;
    mocks.queueSearchCheck.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      updatedAt: new Date("2026-07-16T18:30:01.000Z")
    });
    mocks.start.mockRejectedValue(startError);
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

    await expect(
      startSearchSchedule("search-1", { expectedState })
    ).rejects.toBe(startError);

    expect(workflowRunId).toMatch(/^tee-search-schedule-starting:/);
    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("retains the reservation when attaching an accepted Workflow throws", async () => {
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
    mocks.attachSearchWorkflowRun
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(attachError);

    await expect(
      startSearchSchedule("search-1", { expectedState })
    ).rejects.toBe(attachError);

    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledTimes(2);
    expect(mocks.attachSearchWorkflowRun).toHaveBeenNthCalledWith(
      1,
      "search-1",
      9,
      expect.stringMatching(/^tee-search-schedule-starting:/),
      null
    );
  });
});
