import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachCourseSupportVerificationWorkflow: vi.fn(),
  claimCourseSupportVerificationRequest: vi.fn(),
  courseSupportVerificationWorkflow: vi.fn(),
  failCourseSupportVerificationRequest: vi.fn(),
  getAutomationRuntimeVersion: vi.fn(),
  listDueCourseSupportVerificationRequests: vi.fn(),
  start: vi.fn(),
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/automation/course-support-verification", () => ({
  COURSE_SUPPORT_VERIFICATION_MAX_DUE: 25,
  attachCourseSupportVerificationWorkflow:
    mocks.attachCourseSupportVerificationWorkflow,
  claimCourseSupportVerificationRequest:
    mocks.claimCourseSupportVerificationRequest,
  failCourseSupportVerificationRequest:
    mocks.failCourseSupportVerificationRequest,
  listDueCourseSupportVerificationRequests:
    mocks.listDueCourseSupportVerificationRequests,
}));
vi.mock("@/lib/automation/runtime-version", () => ({
  getAutomationRuntimeVersion: mocks.getAutomationRuntimeVersion,
}));
vi.mock("@/workflows/course-support-verification", () => ({
  courseSupportVerificationWorkflow: mocks.courseSupportVerificationWorkflow,
}));

import { recoverDueCourseSupportVerificationRequests } from "./course-support-verification-scheduler";

const now = new Date("2026-07-21T07:30:00.000Z");
const runtimeVersion = "a".repeat(40);
const intent = {
  targetDateLocal: "2026-07-21",
  startTimeLocal: "06:00" as const,
  endTimeLocal: "20:00" as const,
  timeZone: "America/New_York",
  players: 1 as const,
};

function dueRequest(id: string, revision = 3) {
  return {
    id,
    releaseSha: runtimeVersion,
    status: "QUEUED",
    revision,
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
    intent,
  };
}

describe("recoverDueCourseSupportVerificationRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAutomationRuntimeVersion.mockReturnValue(runtimeVersion);
    mocks.attachCourseSupportVerificationWorkflow.mockResolvedValue({
      attached: true,
    });
    mocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims, starts, and attaches a due verification under exact ownership", async () => {
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      dueRequest("request-1"),
    ]);
    mocks.claimCourseSupportVerificationRequest.mockResolvedValue(
      claimedRequest("request-1"),
    );
    mocks.start.mockResolvedValue({ runId: "workflow-run-1" });

    await expect(
      recoverDueCourseSupportVerificationRequests({ now, limit: 7 }),
    ).resolves.toEqual({ considered: 1, started: 1, skipped: 0, failed: 0 });

    expect(mocks.listDueCourseSupportVerificationRequests).toHaveBeenCalledWith(
      {
        now,
        limit: 7,
        runtimeVersion,
      },
    );
    expect(mocks.claimCourseSupportVerificationRequest).toHaveBeenCalledWith({
      requestId: "request-1",
      expectedRevision: 3,
      runtimeVersion,
      now,
    });
    expect(mocks.start).toHaveBeenCalledWith(
      mocks.courseSupportVerificationWorkflow,
      [
        {
          requestId: "request-1",
          expectedRevision: 4,
          leaseToken: "lease-request-1",
          runtimeVersion,
        },
      ],
    );
    expect(mocks.start.mock.calls[0]).toHaveLength(2);
    expect(mocks.attachCourseSupportVerificationWorkflow).toHaveBeenCalledWith({
      requestId: "request-1",
      expectedRevision: 4,
      leaseToken: "lease-request-1",
      runtimeVersion,
      workflowRunId: "workflow-run-1",
      now,
    });
    expect(mocks.failCourseSupportVerificationRequest).not.toHaveBeenCalled();
  });

  it("skips a request whose guarded claim is rejected", async () => {
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      dueRequest("request-1"),
    ]);
    mocks.claimCourseSupportVerificationRequest.mockResolvedValue({
      claimed: false,
      reason: "runtime_mismatch",
    });

    await expect(
      recoverDueCourseSupportVerificationRequests({ now }),
    ).resolves.toEqual({ considered: 1, started: 0, skipped: 1, failed: 0 });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(
      mocks.attachCourseSupportVerificationWorkflow,
    ).not.toHaveBeenCalled();
  });

  it("starts an exact-release request selected during mismatch grace", async () => {
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      {
        ...dueRequest("request-1", 5),
        lastError: "runtime_release_mismatch:2026-07-21T07:30:00.000Z",
        nextAttemptAt: new Date("2026-07-21T07:31:00.000Z"),
      },
    ]);
    mocks.claimCourseSupportVerificationRequest.mockResolvedValue(
      claimedRequest("request-1", 6),
    );
    mocks.start.mockResolvedValue({ runId: "workflow-run-1" });

    await expect(
      recoverDueCourseSupportVerificationRequests({ now }),
    ).resolves.toEqual({ considered: 1, started: 1, skipped: 0, failed: 0 });
    expect(mocks.listDueCourseSupportVerificationRequests).toHaveBeenCalledWith(
      {
        now,
        limit: 25,
        runtimeVersion,
      },
    );
    expect(mocks.claimCourseSupportVerificationRequest).toHaveBeenCalledWith({
      requestId: "request-1",
      expectedRevision: 5,
      runtimeVersion,
      now,
    });
  });

  it("durably schedules a short retry when Workflow start fails", async () => {
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      dueRequest("request-1"),
    ]);
    mocks.claimCourseSupportVerificationRequest.mockResolvedValue(
      claimedRequest("request-1"),
    );
    mocks.start.mockRejectedValue(new Error("Workflow unavailable"));

    await expect(
      recoverDueCourseSupportVerificationRequests({ now }),
    ).resolves.toEqual({ considered: 1, started: 0, skipped: 0, failed: 1 });
    expect(mocks.failCourseSupportVerificationRequest).toHaveBeenCalledWith({
      requestId: "request-1",
      expectedRevision: 4,
      leaseToken: "lease-request-1",
      runtimeVersion,
      failureClass: "UNKNOWN",
      message: "Workflow start failed before verification execution.",
      retryAt: new Date("2026-07-21T07:32:00.000Z"),
      now,
    });
    expect(
      mocks.attachCourseSupportVerificationWorkflow,
    ).not.toHaveBeenCalled();
  });

  it("continues starting other due work after one Workflow start fails", async () => {
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      dueRequest("request-1"),
      dueRequest("request-2", 8),
    ]);
    mocks.claimCourseSupportVerificationRequest
      .mockResolvedValueOnce(claimedRequest("request-1"))
      .mockResolvedValueOnce(claimedRequest("request-2", 9));
    mocks.start
      .mockRejectedValueOnce(new Error("Workflow unavailable"))
      .mockResolvedValueOnce({ runId: "workflow-run-2" });

    await expect(
      recoverDueCourseSupportVerificationRequests({ now }),
    ).resolves.toEqual({ considered: 2, started: 1, skipped: 0, failed: 1 });
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.failCourseSupportVerificationRequest).toHaveBeenCalledTimes(1);
    expect(mocks.attachCourseSupportVerificationWorkflow).toHaveBeenCalledWith({
      requestId: "request-2",
      expectedRevision: 9,
      leaseToken: "lease-request-2",
      runtimeVersion,
      workflowRunId: "workflow-run-2",
      now,
    });
  });

  it("refreshes live time before claiming later work in a sequential sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const deadlineAt = new Date(now.getTime() + 1_000);
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      { ...dueRequest("request-1"), deadlineAt },
      { ...dueRequest("request-2", 8), deadlineAt },
    ]);
    mocks.claimCourseSupportVerificationRequest.mockImplementation(
      async (input: {
        requestId: string;
        expectedRevision: number;
        now: Date;
      }) =>
        input.now.getTime() < deadlineAt.getTime()
          ? claimedRequest(input.requestId, input.expectedRevision + 1)
          : { claimed: false as const, reason: "request_horizon_exceeded" },
    );
    mocks.start.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(deadlineAt.getTime() + 1_000));
      return { runId: "workflow-run-1" };
    });
    mocks.attachCourseSupportVerificationWorkflow.mockImplementationOnce(
      async (input: { now: Date }) =>
        input.now.getTime() < deadlineAt.getTime()
          ? { attached: true as const }
          : {
              attached: false as const,
              reason: "request_horizon_exceeded",
            },
    );

    await expect(
      recoverDueCourseSupportVerificationRequests(),
    ).resolves.toEqual({ considered: 2, started: 0, skipped: 1, failed: 1 });

    expect(mocks.listDueCourseSupportVerificationRequests).toHaveBeenCalledWith(
      {
        now,
        limit: 25,
        runtimeVersion,
      },
    );
    expect(mocks.claimCourseSupportVerificationRequest.mock.calls).toEqual([
      [
        {
          requestId: "request-1",
          expectedRevision: 3,
          runtimeVersion,
          now,
        },
      ],
      [
        {
          requestId: "request-2",
          expectedRevision: 8,
          runtimeVersion,
          now: new Date("2026-07-21T07:30:02.000Z"),
        },
      ],
    ]);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.attachCourseSupportVerificationWorkflow).toHaveBeenCalledWith({
      requestId: "request-1",
      expectedRevision: 4,
      leaseToken: "lease-request-1",
      runtimeVersion,
      workflowRunId: "workflow-run-1",
      now: new Date("2026-07-21T07:30:02.000Z"),
    });
  });

  it("refreshes live time before persisting a Workflow start failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue([
      dueRequest("request-1"),
    ]);
    mocks.claimCourseSupportVerificationRequest.mockResolvedValue(
      claimedRequest("request-1"),
    );
    mocks.start.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(now.getTime() + 30_000));
      throw new Error("Workflow unavailable");
    });

    await expect(
      recoverDueCourseSupportVerificationRequests(),
    ).resolves.toEqual({ considered: 1, started: 0, skipped: 0, failed: 1 });

    expect(mocks.failCourseSupportVerificationRequest).toHaveBeenCalledWith({
      requestId: "request-1",
      expectedRevision: 4,
      leaseToken: "lease-request-1",
      runtimeVersion,
      failureClass: "UNKNOWN",
      message: "Workflow start failed before verification execution.",
      retryAt: new Date("2026-07-21T07:32:30.000Z"),
      now: new Date("2026-07-21T07:30:30.000Z"),
    });
  });

  it("attempts all 25 synchronized requests before their final minute expires", async () => {
    const finalMinuteDeadline = new Date(now.getTime() + 60 * 1000);
    const synchronizedDue = Array.from({ length: 25 }, (_, index) => ({
      ...dueRequest(`request-${index + 1}`, index + 1),
      nextAttemptAt: new Date(now.getTime() - 60 * 1000),
      deadlineAt: finalMinuteDeadline,
    }));
    mocks.listDueCourseSupportVerificationRequests.mockResolvedValue(
      synchronizedDue,
    );
    mocks.claimCourseSupportVerificationRequest.mockImplementation(
      async (input: { requestId: string; expectedRevision: number }) =>
        claimedRequest(input.requestId, input.expectedRevision + 1),
    );
    mocks.start.mockImplementation(async (_workflow, [input]) => ({
      runId: `workflow-${input.requestId}`,
    }));

    await expect(
      recoverDueCourseSupportVerificationRequests({ now }),
    ).resolves.toEqual({ considered: 25, started: 25, skipped: 0, failed: 0 });

    expect(mocks.listDueCourseSupportVerificationRequests).toHaveBeenCalledWith(
      {
        now,
        limit: 25,
        runtimeVersion,
      },
    );
    expect(mocks.claimCourseSupportVerificationRequest).toHaveBeenCalledTimes(
      25,
    );
    expect(mocks.start).toHaveBeenCalledTimes(25);
    expect(
      mocks.claimCourseSupportVerificationRequest.mock.calls
        .slice(20)
        .map(([input]) => input.requestId),
    ).toEqual([
      "request-21",
      "request-22",
      "request-23",
      "request-24",
      "request-25",
    ]);
  });
});
