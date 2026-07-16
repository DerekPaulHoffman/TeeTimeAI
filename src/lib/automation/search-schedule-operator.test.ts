import { beforeEach, describe, expect, it, vi } from "vitest";

import { queueOperatorSearchScheduleRecovery } from "./search-schedule-operator";

const queued = {
  id: "search-1",
  status: "ACTIVE" as const,
  scheduleVersion: 9,
  workflowRunId: null,
  checkStatus: "QUEUED" as const,
  updatedAt: new Date("2026-07-16T20:00:00.000Z")
};
const expectedState = {
  scheduleVersion: 8,
  updatedAt: new Date("2026-07-16T19:59:00.000Z"),
  observedAt: new Date("2026-07-16T20:00:00.000Z")
};

function dependencies() {
  return {
    queueSearch: vi.fn().mockResolvedValue(queued)
  };
}

describe("operator search schedule start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists exactly one guarded version for deployed recovery pickup", async () => {
    const deps = dependencies();

    await expect(
      queueOperatorSearchScheduleRecovery("search-1", expectedState, deps)
    ).resolves.toEqual({ outcome: "queued_for_recovery", scheduleVersion: 9 });

    expect(deps.queueSearch).toHaveBeenCalledOnce();
    expect(deps.queueSearch).toHaveBeenCalledWith("search-1", expectedState);
  });

  it("does not publish after the search becomes ineligible", async () => {
    const deps = dependencies();
    deps.queueSearch.mockResolvedValue({
      outcome: "not_eligible",
      reason: "state_changed"
    });

    await expect(
      queueOperatorSearchScheduleRecovery("search-1", expectedState, deps)
    ).resolves.toEqual({ outcome: "not_eligible", scheduleVersion: null });
  });
});
