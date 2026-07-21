import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachCourseSupportVerificationWorkflow: vi.fn(),
  claimCourseSupportVerificationRequest: vi.fn(),
  courseSupportVerificationWorkflow: vi.fn(),
  failCourseSupportVerificationRequest: vi.fn(),
  getAutomationRuntimeVersion: vi.fn(),
  listDueCourseSupportVerificationRequests: vi.fn(),
  start: vi.fn()
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/automation/course-support-verification", () => ({
  attachCourseSupportVerificationWorkflow:
    mocks.attachCourseSupportVerificationWorkflow,
  claimCourseSupportVerificationRequest:
    mocks.claimCourseSupportVerificationRequest,
  failCourseSupportVerificationRequest: mocks.failCourseSupportVerificationRequest,
  listDueCourseSupportVerificationRequests:
    mocks.listDueCourseSupportVerificationRequests
}));
vi.mock("@/lib/automation/runtime-version", () => ({
  getAutomationRuntimeVersion: mocks.getAutomationRuntimeVersion
}));
vi.mock("@/workflows/course-support-verification", () => ({
  courseSupportVerificationWorkflow: mocks.courseSupportVerificationWorkflow
}));

import { recoverDueCourseSupportVerificationRequests } from "./course-support-verification-scheduler";

const now = new Date("2026-07-21T07:30:00.000Z");
const runtimeVersion = "a".repeat(40);
const intent = {
  targetDateLocal: "2026-07-21",
  startTimeLocal: "06:00" as const,
  endTimeLocal: "20:00" as const,
  timeZone: "America/New_York",
  players: 1 as const
};

function dueRequest(id: string, revision = 3) {
  return {
    id,
    releaseSha: runtimeVersion,
    status: "QUEUED",
    revision
  };
}

function claimedRequest(id: string, revision = 4) {
  return {
    claimed: true as const,
    requestId: id,
    courseId: `course-${id}`,
    releaseSha: runtimeVersion,
    runtimeVersion,
    revision,
    leaseToken: `lease-${id}`,
    leaseExpiresAt: new Date("2026-07-21T07:40:00.000Z"),
    providerSnapshotFingerprint: `fingerprint-${id}`,
    intent
  };
}

describe("recoverDueCourseSupportVerificationRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAutomationRuntimeVersion.mockReturnValue(runtimeVersion);
    mocks.attachCourseSupportVerificationWorkflow.mockResolvedValue({
      attached: true
    });
    mocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED"
    });
  });

  it("claims, starts, and attaches a due verification under exact ownership", async () => {
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      dueRequest("request-1")
    ]);
    mocks.claimCourseSupportVerificationRequest.mockResolvedValue(
      claimedRequest("request-1")
    );
    mocks.start.mockResolvedValue({ runId: "workflow-run-1" });

    await expect(
      recoverDueCourseSupportVerificationRequests({ now, limit: 7 })
    ).resolves.toEqual({ considered: 1, started: 1, skipped: 0, failed: 0 });

    expect(mocks.listDueCourseSupportVerificationRequests).toHaveBeenCalledWith({
      now,
      limit: 7
    });
    expect(mocks.claimCourseSupportVerificationRequest).toHaveBeenCalledWith({
      requestId: "request-1",
      expectedRevision: 3,
      runtimeVersion,
      now
    });
    expect(mocks.start).toHaveBeenCalledWith(
      mocks.courseSupportVerificationWorkflow,
      [
        {
          requestId: "request-1",
          expectedRevision: 4,
          leaseToken: "lease-request-1",
          runtimeVersion
        }
      ]
    );
    expect(mocks.start.mock.calls[0]).toHaveLength(2);
    expect(mocks.attachCourseSupportVerificationWorkflow).toHaveBeenCalledWith({
      requestId: "request-1",
      expectedRevision: 4,
      leaseToken: "lease-request-1",
      runtimeVersion,
      workflowRunId: "workflow-run-1",
      now
    });
    expect(mocks.failCourseSupportVerificationRequest).not.toHaveBeenCalled();
  });

  it("skips a request whose guarded claim is rejected", async () => {
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      dueRequest("request-1")
    ]);
    mocks.claimCourseSupportVerificationRequest.mockResolvedValue({
      claimed: false,
      reason: "runtime_mismatch"
    });

    await expect(
      recoverDueCourseSupportVerificationRequests({ now })
    ).resolves.toEqual({ considered: 1, started: 0, skipped: 1, failed: 0 });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.attachCourseSupportVerificationWorkflow).not.toHaveBeenCalled();
  });

  it("durably schedules a short retry when Workflow start fails", async () => {
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      dueRequest("request-1")
    ]);
    mocks.claimCourseSupportVerificationRequest.mockResolvedValue(
      claimedRequest("request-1")
    );
    mocks.start.mockRejectedValue(new Error("Workflow unavailable"));

    await expect(
      recoverDueCourseSupportVerificationRequests({ now })
    ).resolves.toEqual({ considered: 1, started: 0, skipped: 0, failed: 1 });
    expect(mocks.failCourseSupportVerificationRequest).toHaveBeenCalledWith({
      requestId: "request-1",
      expectedRevision: 4,
      leaseToken: "lease-request-1",
      runtimeVersion,
      failureClass: "UNKNOWN",
      message: "Workflow start failed before verification execution.",
      retryAt: new Date("2026-07-21T07:32:00.000Z"),
      now
    });
    expect(mocks.attachCourseSupportVerificationWorkflow).not.toHaveBeenCalled();
  });

  it("continues starting other due work after one Workflow start fails", async () => {
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      dueRequest("request-1"),
      dueRequest("request-2", 8)
    ]);
    mocks.claimCourseSupportVerificationRequest
      .mockResolvedValueOnce(claimedRequest("request-1"))
      .mockResolvedValueOnce(claimedRequest("request-2", 9));
    mocks.start
      .mockRejectedValueOnce(new Error("Workflow unavailable"))
      .mockResolvedValueOnce({ runId: "workflow-run-2" });

    await expect(
      recoverDueCourseSupportVerificationRequests({ now })
    ).resolves.toEqual({ considered: 2, started: 1, skipped: 0, failed: 1 });
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.failCourseSupportVerificationRequest).toHaveBeenCalledTimes(1);
    expect(mocks.attachCourseSupportVerificationWorkflow).toHaveBeenCalledWith({
      requestId: "request-2",
      expectedRevision: 9,
      leaseToken: "lease-request-2",
      runtimeVersion,
      workflowRunId: "workflow-run-2",
      now
    });
  });
});
