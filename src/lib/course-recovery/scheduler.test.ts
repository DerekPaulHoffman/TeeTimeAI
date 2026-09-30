import { beforeEach, describe, expect, it, vi } from "vitest";
import { startRecoveryRequest, recoverDueCourseRecovery } from "./scheduler";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), fail: vi.fn(), due: vi.fn(), start: vi.fn(), attach: vi.fn(), pending: vi.fn(), activate: vi.fn(), expire: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/course-recovery", () => ({ courseRecoveryWorkflow: vi.fn() }));
vi.mock("./service", () => ({ claimRecoveryRequest: mocks.claim, failRecoveryAttempt: mocks.fail, listDueRecoveryRequests: mocks.due }));
vi.mock("./demand", () => ({ activateVerifiedRecoveryDemands: mocks.activate, expireRecoveryDemands: mocks.expire }));
vi.mock("@/lib/prisma", () => ({ prisma: { courseRecoveryRequest: { updateMany: mocks.attach, findMany: mocks.pending } } }));
const claim = { requestId: "request-1", revision: 2, leaseToken: "owned-token" };
describe("course recovery Workflow start recovery", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.claim.mockResolvedValue(claim); mocks.start.mockResolvedValue({ runId: "workflow-1" }); mocks.attach.mockResolvedValue({ count: 1 }); mocks.fail.mockResolvedValue(true); mocks.due.mockResolvedValue([{ id: "request-1" }]); mocks.pending.mockResolvedValue([]); mocks.expire.mockResolvedValue({ expired: 0, actionRequired: 0 }); });
  it("starts only owned work and attaches to its exact revision", async () => {
    expect(await startRecoveryRequest("request-1")).toBe("started");
    expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), [claim]);
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "request-1", revision: 2, status: "INVESTIGATING", leaseToken: "owned-token" } }));
  });
  it("retains automatic retry after a launch failure", async () => {
    mocks.start.mockRejectedValue(new Error("runtime unavailable"));
    expect(await startRecoveryRequest("request-1")).toBe("failed");
    expect(mocks.fail).toHaveBeenCalledWith(claim);
    expect(mocks.attach).not.toHaveBeenCalled();
  });
  it("does not start already active or terminal work", async () => {
    mocks.claim.mockResolvedValue(null);
    expect(await startRecoveryRequest("request-1")).toBe("skipped");
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("keeps verified-demand recovery independent of a failed investigation start", async () => {
    mocks.start.mockRejectedValue(new Error("runtime unavailable"));
    mocks.pending.mockResolvedValue([{ id: "verified-1" }]);
    expect(await recoverDueCourseRecovery()).toMatchObject({ considered: 1, started: 0, failed: 1, demandRequestsConsidered: 1 });
    expect(mocks.activate).toHaveBeenCalledWith("verified-1");
    expect(mocks.expire.mock.invocationCallOrder[0]).toBeLessThan(mocks.pending.mock.invocationCallOrder[0]);
  });
});
