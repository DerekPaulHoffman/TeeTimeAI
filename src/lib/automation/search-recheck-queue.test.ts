import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachSearchWorkflowRun: vi.fn(),
  getSearchScheduleState: vi.fn(),
  searchScheduleWorkflow: vi.fn(),
  send: vi.fn(),
  start: vi.fn()
}));

vi.mock("@vercel/queue", () => ({ send: mocks.send }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/automation/db-service", () => ({
  attachSearchWorkflowRun: mocks.attachSearchWorkflowRun,
  getSearchScheduleState: mocks.getSearchScheduleState
}));
vi.mock("@/workflows/search-schedule", () => ({
  searchScheduleWorkflow: mocks.searchScheduleWorkflow
}));

import {
  InvalidSearchScheduleQueueMessageError,
  SEARCH_SCHEDULE_QUEUE_RETENTION_SECONDS,
  SEARCH_SCHEDULE_QUEUE_TOPIC,
  buildSearchScheduleQueueIdempotencyKey,
  buildSearchScheduleReference,
  consumeSearchScheduleMessage,
  enqueueRemediatedCourseRechecks,
  enqueueSearchScheduleMessage,
  getSearchScheduleQueueRetryDirective,
  recoverSearchScheduleStartFailure
} from "./search-recheck-queue";

const message = {
  searchId: "search-1",
  scheduleVersion: 7,
  trigger: "START_FAILED" as const
};

describe("search schedule recovery queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes the minimal message for 24 hours with a redacted idempotency key", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await enqueueSearchScheduleMessage(message, { sendMessage });

    expect(sendMessage).toHaveBeenCalledWith(
      SEARCH_SCHEDULE_QUEUE_TOPIC,
      {
        searchId: "search-1",
        scheduleVersion: 7,
        trigger: "START_FAILED"
      },
      {
        idempotencyKey: expect.stringMatching(/^tee-search-schedule-[a-f0-9]{32}$/),
        retentionSeconds: SEARCH_SCHEDULE_QUEUE_RETENTION_SECONDS
      }
    );
    expect(sendMessage.mock.calls[0][2].idempotencyKey).not.toContain("search-1");
  });

  it("deduplicates both trigger types for the same search schedule version", () => {
    expect(buildSearchScheduleQueueIdempotencyKey(message, "event-1")).toBe(
      buildSearchScheduleQueueIdempotencyKey({
        searchId: message.searchId,
        scheduleVersion: message.scheduleVersion
      }, "event-1")
    );
    expect(buildSearchScheduleQueueIdempotencyKey(message, "event-1")).not.toBe(
      buildSearchScheduleQueueIdempotencyKey({
        searchId: message.searchId,
        scheduleVersion: message.scheduleVersion + 1
      }, "event-1")
    );
    expect(buildSearchScheduleQueueIdempotencyKey(message, "event-1")).not.toBe(
      buildSearchScheduleQueueIdempotencyKey(message, "event-2")
    );
  });

  it("reuses a persisted remediation seed for crash-safe queue publication", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await enqueueSearchScheduleMessage(message, { sendMessage }, "dispatch-1");
    await enqueueSearchScheduleMessage(message, { sendMessage }, "dispatch-1");

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][2].idempotencyKey).toBe(
      sendMessage.mock.calls[1][2].idempotencyKey
    );
  });

  it("rejects payloads with extra fields without echoing their contents", async () => {
    const sendMessage = vi.fn();

    await expect(
      enqueueSearchScheduleMessage(
        { ...message, recipient: "private@example.com" } as never,
        { sendMessage }
      )
    ).rejects.toEqual(new InvalidSearchScheduleQueueMessageError());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("acknowledges a stale schedule without starting a workflow", async () => {
    const dependencies = {
      getScheduleState: vi.fn().mockResolvedValue(null),
      startWorkflow: vi.fn(),
      attachWorkflowRun: vi.fn()
    };

    await expect(consumeSearchScheduleMessage(message, dependencies)).resolves.toEqual({
      outcome: "stale"
    });
    expect(dependencies.startWorkflow).not.toHaveBeenCalled();
    expect(dependencies.attachWorkflowRun).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate after the current version has a workflow run", async () => {
    const dependencies = {
      getScheduleState: vi
        .fn()
        .mockResolvedValue({ workflowRunId: "existing-run", checkStatus: "QUEUED" }),
      startWorkflow: vi.fn(),
      attachWorkflowRun: vi.fn()
    };

    await expect(consumeSearchScheduleMessage(message, dependencies)).resolves.toEqual({
      outcome: "already_started"
    });
    expect(dependencies.startWorkflow).not.toHaveBeenCalled();
  });

  it("replaces the prior run when starting the next workflow failed", async () => {
    const dependencies = {
      getScheduleState: vi
        .fn()
        .mockResolvedValue({ workflowRunId: "completed-prior-run", checkStatus: "FAILED" }),
      startWorkflow: vi.fn().mockResolvedValue({ runId: "replacement-run" }),
      attachWorkflowRun: vi.fn().mockResolvedValue({ count: 1 })
    };

    await expect(consumeSearchScheduleMessage(message, dependencies)).resolves.toEqual({
      outcome: "started"
    });
    expect(dependencies.startWorkflow).toHaveBeenCalledWith("search-1", 7);
    expect(dependencies.attachWorkflowRun).toHaveBeenCalledWith(
      "search-1",
      7,
      "replacement-run",
      "completed-prior-run"
    );
  });

  it("starts the exact active version on the latest deployment and persists its run", async () => {
    mocks.getSearchScheduleState.mockResolvedValue({ workflowRunId: null });
    mocks.start.mockResolvedValue({ runId: "new-run" });
    mocks.attachSearchWorkflowRun.mockResolvedValue({ count: 1 });

    await expect(consumeSearchScheduleMessage(message)).resolves.toEqual({ outcome: "started" });

    expect(mocks.getSearchScheduleState).toHaveBeenCalledWith("search-1", 7);
    expect(mocks.start).toHaveBeenCalledWith(
      mocks.searchScheduleWorkflow,
      ["search-1", 7],
      { deploymentId: "latest" }
    );
    expect(mocks.attachSearchWorkflowRun).toHaveBeenCalledWith(
      "search-1",
      7,
      "new-run",
      null
    );
  });

  it("does not report success when the schedule changes after workflow start", async () => {
    const dependencies = {
      getScheduleState: vi.fn().mockResolvedValue({ workflowRunId: null }),
      startWorkflow: vi.fn().mockResolvedValue({ runId: "new-run" }),
      attachWorkflowRun: vi.fn().mockResolvedValue({ count: 0 })
    };

    await expect(consumeSearchScheduleMessage(message, dependencies)).resolves.toEqual({
      outcome: "stale_after_start"
    });
  });

  it("acknowledges malformed messages and retries transient failures with bounded backoff", () => {
    expect(
      getSearchScheduleQueueRetryDirective(new InvalidSearchScheduleQueueMessageError(), 1)
    ).toEqual({ acknowledge: true });
    expect(getSearchScheduleQueueRetryDirective(new Error("temporary"), 1)).toEqual({
      afterSeconds: 15
    });
    expect(getSearchScheduleQueueRetryDirective(new Error("temporary"), 20)).toEqual({
      afterSeconds: 300
    });
  });

  it("increments and enqueues each affected search exactly once", async () => {
    const dependencies = {
      listSearchIds: vi.fn().mockResolvedValue(["search-1", "search-1", "search-2"]),
      queueSearch: vi
        .fn()
        .mockResolvedValueOnce({ scheduleVersion: 8 })
        .mockResolvedValueOnce({ scheduleVersion: 3 }),
      enqueue: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      enqueueRemediatedCourseRechecks(["course-1", "course-1"], dependencies)
    ).resolves.toEqual({
      affectedSearchCount: 2,
      queuedCount: 2,
      queueFailureCount: 0,
      directStartCount: 0,
      scheduledSearches: [
        {
          searchId: "search-1",
          searchRef: buildSearchScheduleReference("search-1"),
          scheduleVersion: 8
        },
        {
          searchId: "search-2",
          searchRef: buildSearchScheduleReference("search-2"),
          scheduleVersion: 3
        }
      ],
      affectedSearchRefs: [
        { searchRef: buildSearchScheduleReference("search-1"), scheduleVersion: 8 },
        { searchRef: buildSearchScheduleReference("search-2"), scheduleVersion: 3 }
      ]
    });
    expect(dependencies.queueSearch).toHaveBeenCalledTimes(2);
    expect(dependencies.enqueue).toHaveBeenNthCalledWith(1, {
      searchId: "search-1",
      scheduleVersion: 8,
      trigger: "COURSE_REMEDIATED"
    });
  });

  it("forwards one durable remediation key to schedule and queue idempotency", async () => {
    const dependencies = {
      listSearchIds: vi.fn().mockResolvedValue(["search-1"]),
      queueSearch: vi.fn().mockResolvedValue({ scheduleVersion: 8 }),
      enqueue: vi.fn().mockResolvedValue(undefined)
    };

    await enqueueRemediatedCourseRechecks(
      ["course-1"],
      dependencies,
      "dispatch-1"
    );

    expect(dependencies.queueSearch).toHaveBeenCalledWith(
      "search-1",
      "dispatch-1"
    );
    expect(dependencies.enqueue).toHaveBeenCalledWith(
      {
        searchId: "search-1",
        scheduleVersion: 8,
        trigger: "COURSE_REMEDIATED"
      },
      "dispatch-1"
    );
  });

  it("leaves persisted schedule recovery when queue publishing fails", async () => {
    const dependencies = {
      listSearchIds: vi.fn().mockResolvedValue(["search-1"]),
      queueSearch: vi.fn().mockResolvedValue({ scheduleVersion: 9 }),
      enqueue: vi.fn().mockRejectedValue(new Error("queue unavailable"))
    };

    await expect(
      enqueueRemediatedCourseRechecks(["course-1"], dependencies)
    ).resolves.toEqual({
      affectedSearchCount: 1,
      queuedCount: 0,
      queueFailureCount: 1,
      directStartCount: 0,
      scheduledSearches: [
        {
          searchId: "search-1",
          searchRef: buildSearchScheduleReference("search-1"),
          scheduleVersion: 9
        }
      ],
      affectedSearchRefs: [
        { searchRef: buildSearchScheduleReference("search-1"), scheduleVersion: 9 }
      ]
    });
    expect(dependencies.queueSearch).toHaveBeenCalledOnce();
  });

  it("accounts for a localized schedule-save failure without aborting the batch", async () => {
    const dependencies = {
      listSearchIds: vi.fn().mockResolvedValue(["search-1", "search-2"]),
      queueSearch: vi
        .fn()
        .mockRejectedValueOnce(new Error("save failed"))
        .mockResolvedValueOnce({ scheduleVersion: 4 }),
      enqueue: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      enqueueRemediatedCourseRechecks(["course-1"], dependencies)
    ).resolves.toMatchObject({
      affectedSearchCount: 2,
      queuedCount: 1,
      queueFailureCount: 1,
      directStartCount: 0,
      affectedSearchRefs: [
        { searchRef: buildSearchScheduleReference("search-1"), scheduleVersion: null },
        { searchRef: buildSearchScheduleReference("search-2"), scheduleVersion: 4 }
      ]
    });
  });

  it("leaves failed starts recoverable without attempting a local Workflow start", async () => {
    const dependencies = {
      enqueue: vi.fn().mockRejectedValue(new Error("queue unavailable"))
    };

    await expect(
      recoverSearchScheduleStartFailure(message, dependencies)
    ).resolves.toEqual({ outcome: "failed" });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
