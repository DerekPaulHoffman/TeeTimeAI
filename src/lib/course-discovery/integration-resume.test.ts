import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), queue: vi.fn(), recheck: vi.fn(), attach: vi.fn(), consume: vi.fn(), recover: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { teeSearch: { findUnique: mocks.find } } }));
vi.mock("@/lib/automation/db-service", () => ({ queueSearchCheck: mocks.queue, requestSearchRecheck: mocks.recheck }));
vi.mock("@/lib/automation/search-schedule-consumer", () => ({ consumeSearchScheduleQueueMessage: mocks.consume }));
vi.mock("@/lib/automation/search-recheck-queue", () => ({ recoverSearchScheduleStartFailure: mocks.recover }));
vi.mock("./config", () => ({ isDiscoveryPilotSearch: async () => true }));
vi.mock("./runtime", () => ({ attachRecipeResumeVersion: mocks.attach }));
import { queueDiscoverySearchRecheck } from "./integration";

describe("completed recipe continuation", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it("repairs resume attachment after a crash following queue publication", async () => {
    const waiting = { id: "search", status: "ACTIVE", checkStatus: "WAITING", scheduleVersion: 1, updatedAt: new Date(), workflowRunId: null };
    mocks.find.mockResolvedValueOnce(waiting).mockResolvedValueOnce({ ...waiting, checkStatus: "QUEUED", scheduleVersion: 2 });
    mocks.queue.mockResolvedValue({ id: "search", scheduleVersion: 2 });
    mocks.attach.mockRejectedValueOnce(new Error("process lost before attachment")).mockResolvedValueOnce(true);
    await expect(queueDiscoverySearchRecheck("search", "execution")).rejects.toThrow("process lost");
    expect(await queueDiscoverySearchRecheck("search", "execution")).toBe(true);
    expect(mocks.attach).toHaveBeenLastCalledWith("execution", 2, "search");
    expect(mocks.recheck).toHaveBeenCalledWith("search", 2);
    expect(mocks.attach.mock.invocationCallOrder[1]).toBeLessThan(mocks.recheck.mock.invocationCallOrder[0]);
  });
});
