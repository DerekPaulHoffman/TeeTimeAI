import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  feedbackUpdateMany: vi.fn(),
  incidentFindUnique: vi.fn(),
  incidentUpdateMany: vi.fn(),
  lease: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    websiteFeedback: {
      updateMany: mocks.feedbackUpdateMany
    },
    courseSupportIncident: {
      findUnique: mocks.incidentFindUnique,
      updateMany: mocks.incidentUpdateMany
    }
  }
}));

vi.mock("@/lib/automation/lease", () => ({
  withPostgresAdvisoryTextLease: mocks.lease
}));

import {
  requestOperatorIncidentRetry,
  resolveOperatorFeedback
} from "./mutations";

describe("operator mutations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.lease.mockImplementation(
      async (_client: unknown, _lane: string, worker: () => Promise<unknown>) => ({
        acquired: true,
        value: await worker()
      })
    );
  });

  it("resolves feedback idempotently", async () => {
    mocks.feedbackUpdateMany.mockResolvedValueOnce({ count: 1 });
    await expect(
      resolveOperatorFeedback("feedback-1", new Date("2026-07-23T12:00:00Z"))
    ).resolves.toBe("resolved");
    expect(mocks.feedbackUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "feedback-1",
        resolvedAt: null,
        trafficClass: {
          notIn: ["AUTOMATION", "TEST"]
        }
      },
      data: {
        resolvedAt: new Date("2026-07-23T12:00:00Z")
      }
    });

    mocks.feedbackUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(resolveOperatorFeedback("feedback-1")).resolves.toBe(
      "already_resolved"
    );
  });

  it("moves only a future automatic incident retry to now", async () => {
    const now = new Date("2026-07-23T12:00:00Z");
    mocks.incidentFindUnique.mockResolvedValue({
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      nextAttemptAt: new Date("2026-07-23T14:00:00Z")
    });
    mocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(requestOperatorIncidentRetry("incident-1", now)).resolves.toBe(
      "queued"
    );
    expect(mocks.incidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        status: "AUTO_INVESTIGATING",
        activeBatchId: null,
        nextAttemptAt: { gt: now }
      },
      data: { nextAttemptAt: now }
    });
  });

  it.each([
    [
      "manual_review",
      {
        status: "NEEDS_HUMAN",
        activeBatchId: null,
        nextAttemptAt: null
      }
    ],
    [
      "in_progress",
      {
        status: "AUTO_INVESTIGATING",
        activeBatchId: "batch-1",
        nextAttemptAt: new Date("2026-07-23T14:00:00Z")
      }
    ],
    [
      "already_due",
      {
        status: "AUTO_INVESTIGATING",
        activeBatchId: null,
        nextAttemptAt: null
      }
    ],
    [
      "resolved",
      {
        status: "RESOLVED",
        activeBatchId: null,
        nextAttemptAt: null
      }
    ]
  ])("returns %s without changing guarded incident state", async (result, row) => {
    mocks.incidentFindUnique.mockResolvedValue(row);

    await expect(
      requestOperatorIncidentRetry(
        "incident-1",
        new Date("2026-07-23T12:00:00Z")
      )
    ).resolves.toBe(result);
    expect(mocks.incidentUpdateMany).not.toHaveBeenCalled();
  });

  it("returns busy when the course-support writer lease is owned", async () => {
    mocks.lease.mockResolvedValue({ acquired: false });

    await expect(requestOperatorIncidentRetry("incident-1")).resolves.toBe(
      "busy"
    );
  });
});
