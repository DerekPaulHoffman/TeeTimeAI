import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  assertSafeSearchEmailPayload,
  drainSearchEmailDeliveryGroup,
  finalizeSearchEmailDeliveryGroup,
  getSafeOfficialBookingUrl,
  hydrateMatchAlertPayload,
  hydrateSearchStatusEmailPayload,
  listRetryableSearchEmailDeliveryGroups,
  lockSearchForAlertMutation,
  prepareSearchEmailDeliveryGroup,
  SearchEmailDeliveryInProgressError,
  suppressSearchEmailDeliveriesForMatches
} from "./search-delivery-outbox";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    course: { findMany: vi.fn() },
    searchEmailDelivery: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn()
    },
    teeSearch: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    teeTimeMatch: {
      count: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn()
    }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });
const now = new Date("2026-07-15T15:00:00.000Z");
const currentSearch = {
  id: "search-1",
  status: "ACTIVE",
  alertGeneration: 3,
  checkLeaseToken: "check-lease",
  checkLeaseExpiresAt: new Date("2026-07-15T15:15:00.000Z")
};
const payload = {
  schemaVersion: 2 as const,
  checkedAt: now.toISOString(),
  matchIds: ["match-1"],
  displayMatchIds: ["match-1"],
  satisfiesStatusReport: true,
  statusSnapshot: [{ courseId: "course-1", courseName: "Course", state: "MATCH_FOUND:1" }],
    matchReport: {
      targetDate: "2026-07-16",
    startTime: "07:00",
    endTime: "10:00",
    players: 2,
    requestedLayoutHoles: null,
      userTimeZone: "America/New_York",
      matches: [
        {
          matchId: "match-1",
          courseId: "course-1",
          courseName: "Course",
          courseRank: 1,
          courseAddress: "1 Main Street",
          courseTimeZone: "America/New_York",
          startsAt: "2026-07-16T12:00:00.000Z",
          availableSpots: 4,
          bookingUrl: "https://example.com/tee-times?date=2026-07-16",
          priceCents: 6500,
          holes: 18,
          bookableHoleCounts: [9, 18],
          isNew: true
        }
      ]
  }
};

function delivery(
  id: string,
  recipient: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    teeSearchId: "search-1",
    alertGeneration: 3,
    kind: "MATCH",
    groupKey: "match-group",
    recipient,
    isOwnerRecipient: recipient === "owner@example.com",
    payload,
    status: "PENDING",
    claimToken: null,
    claimExpiresAt: null,
    attemptCount: 0,
    nextAttemptAt: null,
    sentAt: null,
    createdAt: new Date("2026-07-15T14:59:00.000Z"),
    ...overrides
  };
}

describe("search email delivery outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
    mockedPrisma.$queryRaw.mockResolvedValue([currentSearch] as never);
    mockedPrisma.$executeRaw.mockResolvedValue(1 as never);
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue(null);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.teeTimeMatch.count.mockResolvedValue(1);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.teeSearch.update.mockResolvedValue({ id: "search-1" } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it("prepares an immutable identical payload and marks exactly one owner recipient", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const friend = delivery("delivery-2", "friend@example.com");
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([owner, friend] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(owner as never);

    await expect(
      prepareSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        recipients: ["OWNER@example.com", "friend@example.com"],
        ownerRecipient: "owner@example.com",
        payload,
        now
      })
    ).resolves.toEqual(expect.objectContaining({ prepared: true }));
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "owner@example.com",
          isOwnerRecipient: true,
          payload
        })
      })
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "friend@example.com",
          isOwnerRecipient: false,
          payload
        })
      })
    );
  });

  it("keeps the first persisted snapshot immutable when a retry proposes newer memory", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const friend = delivery("delivery-2", "friend@example.com");
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([owner, friend] as never);

    await prepareSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      recipients: ["owner@example.com", "friend@example.com"],
      ownerRecipient: "owner@example.com",
      payload: { ...payload, checkedAt: new Date(now.getTime() + 60_000).toISOString() },
      now
    });

    expect(mockedPrisma.searchEmailDelivery.create).not.toHaveBeenCalled();
  });

  it("rejects a changed recipient set for an existing group", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);

    await expect(
      prepareSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        recipients: ["owner@example.com", "friend@example.com"],
        ownerRecipient: "owner@example.com",
        payload,
        now
      })
    ).rejects.toThrow("recipients are immutable");
  });

  it("does not prepare rows after the search generation changes", async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([
      { ...currentSearch, alertGeneration: 4 }
    ] as never);

    await expect(
      prepareSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        recipients: ["owner@example.com"],
        ownerRecipient: "owner@example.com",
        payload,
        now
      })
    ).resolves.toEqual({ prepared: false, reason: "stale_search", deliveries: [] });
  });

  it("claims every retryable recipient atomically under one token before sending", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const friend = delivery("delivery-2", "friend@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner, friend] as never);
    mockedPrisma.teeTimeMatch.count.mockResolvedValue(1);
    mockedPrisma.searchEmailDelivery.updateMany
      .mockResolvedValueOnce({ count: 2 } as never)
      .mockResolvedValue({ count: 1 } as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => now
      })
    ).resolves.toHaveLength(2);
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: { in: ["delivery-1", "delivery-2"] } },
        data: expect.objectContaining({
          status: "SENDING",
          claimToken: expect.any(String),
          attemptCount: { increment: 1 }
        })
      })
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload, idempotencyKey: expect.stringMatching(/^tee-search-delivery-/) })
    );
    const settlementTokens = mockedPrisma.searchEmailDelivery.updateMany.mock.calls
      .slice(1)
      .map(([call]) => call.where?.claimToken);
    expect(new Set(settlementTokens).size).toBe(1);
  });

  it("blocks mutations while any recipient in the group remains SENDING", async () => {
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue({
      claimExpiresAt: new Date(now.getTime() + 60_000)
    } as never);
    await expect(
      lockSearchForAlertMutation(prisma, { searchId: "search-1", userId: "user-1", now })
    ).rejects.toBeInstanceOf(SearchEmailDeliveryInProgressError);
    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("blocks mutations when a SENDING claim has expired instead of guessing whether it sent", async () => {
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue({
      claimExpiresAt: new Date(now.getTime() - 60_000)
    } as never);

    const error = await lockSearchForAlertMutation(prisma, {
      searchId: "search-1",
      userId: "user-1",
      now
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(SearchEmailDeliveryInProgressError);
    expect(error.retryAt).toEqual(new Date(now.getTime() + 60_000));
    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
  });

  it("does not suppress delivery or match state after the generation changes", async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([
      { ...currentSearch, alertGeneration: 4 }
    ] as never);

    await expect(
      suppressSearchEmailDeliveriesForMatches({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        matchIds: ["match-1"],
        now
      })
    ).resolves.toEqual({ count: 0, matchCount: 0, current: false });

    expect(mockedPrisma.$queryRaw).toHaveBeenCalledOnce();
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("does not suppress delivery or match state after the check lease changes", async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([
      { ...currentSearch, checkLeaseToken: "new-check-lease" }
    ] as never);

    await expect(
      suppressSearchEmailDeliveriesForMatches({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        matchIds: ["match-1"],
        now
      })
    ).resolves.toEqual({ count: 0, matchCount: 0, current: false });

    expect(mockedPrisma.$queryRaw).toHaveBeenCalledOnce();
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("never revives a group after one referenced pending match is gone", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      nextAttemptAt: new Date(now.getTime() - 1)
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null }
      ] as never);
    mockedPrisma.teeTimeMatch.count.mockResolvedValue(0);
    const send = vi.fn();

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => now
      })
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("persists a one-minute Workflow recheck after a group send failure", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({ count: 1 } as never);
    const sendError = new Error(
      "Provider failed for owner@example.com at https://provider.example/send?token=secret"
    );

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send: vi.fn().mockRejectedValue(sendError),
        now: () => now
      })
    ).rejects.toBe(sendError);
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 60_000),
          lastError: "Provider failed for [email] at [url]"
        })
      })
    );
    expect(mockedPrisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it("caps exponential delivery retries at ten minutes", async () => {
    const owner = delivery("delivery-1", "owner@example.com", { attemptCount: 12 });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({ count: 1 } as never);
    const sendError = new Error("provider unavailable");

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send: vi.fn().mockRejectedValue(sendError),
        now: () => now
      })
    ).rejects.toBe(sendError);

    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 10 * 60_000)
        })
      })
    );
    expect(mockedPrisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it("persists the owner outcome even when an additional recipient send fails", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const friend = delivery("delivery-2", "friend@example.com");
    const friendError = new Error("friend delivery failed");
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SENT", sentAt: now },
        { ...friend, status: "FAILED", nextAttemptAt: new Date(now.getTime() + 60_000) }
      ] as never);
    mockedPrisma.searchEmailDelivery.updateMany
      .mockResolvedValueOnce({ count: 2 } as never)
      .mockResolvedValue({ count: 1 } as never);

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send: vi.fn(async ({ recipient }) => {
          if (recipient === "friend@example.com") {
            throw friendError;
          }
          return { deliveryStatus: "sent" as const };
        }),
        now: () => now
      })
    ).rejects.toBe(friendError);
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { alertStatus: "SENT", sentAt: now } })
    );
    expect(mockedPrisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it("finalizes the owner outcome while an additional recipient remains retryable", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", { status: "SENT", sentAt: now }),
      delivery("delivery-2", "friend@example.com", { status: "FAILED" })
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "match-group"
      })
    ).resolves.toEqual({
      finalized: false,
      reason: "not_terminal",
      ownerFinalized: true
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { alertStatus: "SENT", sentAt: now } })
    );
  });

  it("requires the owner recipient SENT before marking matches or status globally sent", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", { status: "SUPPRESSED", sentAt: now }),
      delivery("delivery-2", "friend@example.com", { status: "SENT", sentAt: now })
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "match-group"
      })
    ).resolves.toEqual({ finalized: true, status: "SUPPRESSED", ownerSent: false });
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { alertStatus: "SUPPRESSED", sentAt: now } })
    );
    expect(mockedPrisma.teeSearch.update).not.toHaveBeenCalled();
  });

  it("atomically satisfies the status report from the MATCH payload after all recipients finish", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", { status: "SENT", sentAt: now }),
      delivery("delivery-2", "friend@example.com", { status: "SUPPRESSED", sentAt: now })
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "match-group"
      })
    ).resolves.toEqual({ finalized: true, status: "SENT", ownerSent: true });
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { alertStatus: "SENT", sentAt: now } })
    );
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          statusEmailSentAt: now,
          statusEmailSnapshot: payload.statusSnapshot
        }
      })
    );
  });

  it("rejects URLs and secret-bearing keys in durable payloads", () => {
    expect(() =>
      assertSafeSearchEmailPayload({
        schemaVersion: 2,
        checkedAt: now.toISOString(),
        statusReport: { bookingUrl: "https://example.com/signed?token=value" }
      })
    ).toThrow("booking URL contains session-specific data");
    expect(() =>
      assertSafeSearchEmailPayload({
        schemaVersion: 2,
        checkedAt: now.toISOString(),
        statusReport: { bookingUrl: "https://example.com/tee-times?date=2026-07-16" }
      })
    ).not.toThrow();
    expect(() =>
      assertSafeSearchEmailPayload({
        schemaVersion: 2,
        checkedAt: now.toISOString(),
        statusSnapshot: { token: "value" }
      })
    ).toThrow("payload cannot contain token");
  });

  it("hydrates a match retry only from the immutable persisted snapshot", async () => {
    const first = await hydrateMatchAlertPayload({
      searchId: "search-1",
      alertGeneration: 3,
      payload
    });
    mockedPrisma.course.findMany.mockResolvedValue([
      { id: "course-1", detectedBookingUrl: "https://changed.example", website: null }
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { id: "match-1", availableSpots: 1, bookingUrl: "https://changed.example" }
    ] as never);
    const retry = await hydrateMatchAlertPayload({
      searchId: "search-1",
      alertGeneration: 3,
      payload
    });

    expect(retry).toEqual(first);
    expect(retry.matches[0]).toEqual(
      expect.objectContaining({
        availableSpots: 4,
        bookingUrl: "https://example.com/tee-times?date=2026-07-16",
        priceCents: 6500
      })
    );
    expect(mockedPrisma.course.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.findMany).not.toHaveBeenCalled();
  });

  it("hydrates a status retry only from the immutable persisted snapshot", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      statusSnapshot: [{ courseId: "course-1", state: "NO_MATCH" }],
      statusReport: {
        kind: "daily",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: 18,
        userTimeZone: "America/New_York",
        previousSnapshot: [{ courseId: "course-1", state: "NEEDS_ADAPTER" }],
        courses: [
          {
            courseId: "course-1",
            courseName: "Course",
            timeZone: "America/New_York",
            outcome: "NO_MATCH",
            availableMatches: 0,
            message: "No matching public tee times were found.",
            bookingUrl: "https://example.com/tee-times?date=2026-07-16"
          }
        ]
      }
    };

    const first = await hydrateSearchStatusEmailPayload(statusPayload);
    mockedPrisma.course.findMany.mockResolvedValue([{
      id: "course-1",
      name: "Changed Course",
      website: "https://changed.example"
    }] as never);
    mockedPrisma.teeSearch.findFirst.mockResolvedValue({
      id: "search-1",
      players: 4
    } as never);
    const retry = await hydrateSearchStatusEmailPayload(statusPayload);

    expect(retry).toEqual(first);
    expect(retry).toEqual(
      expect.objectContaining({
        kind: "daily",
        players: 2,
        requestedLayoutHoles: 18,
        courses: [
          expect.objectContaining({
            courseName: "Course",
            bookingUrl: "https://example.com/tee-times?date=2026-07-16"
          })
        ]
      })
    );
    expect(mockedPrisma.course.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.findFirst).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.findMany).not.toHaveBeenCalled();
  });

  it("accepts only public official booking URLs and rejects restricted or signed flows", () => {
    expect(
      getSafeOfficialBookingUrl("https://course.example/tee-times?date=2026-07-16")
    ).toBe("https://course.example/tee-times?date=2026-07-16");
    expect(getSafeOfficialBookingUrl("https://course.example/checkout")).toBeUndefined();
    expect(getSafeOfficialBookingUrl("https://course.example/queue/wait")).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl("https://course.example/tee-times?session=private")
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl("https://course.example/tee-times?bookingToken=private")
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl("https://user:password@course.example/tee-times")
    ).toBeUndefined();
    expect(getSafeOfficialBookingUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("lists each retryable persisted group once in creation order", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      { kind: "MATCH", groupKey: "group-1", createdAt: new Date(now.getTime() - 2_000) },
      { kind: "MATCH", groupKey: "group-1", createdAt: new Date(now.getTime() - 2_000) },
      { kind: "DAILY", groupKey: "group-2", createdAt: new Date(now.getTime() - 1_000) }
    ] as never);

    await expect(
      listRetryableSearchEmailDeliveryGroups({ searchId: "search-1", alertGeneration: 3 })
    ).resolves.toEqual([
      { kind: "MATCH", groupKey: "group-1", createdAt: new Date(now.getTime() - 2_000) },
      { kind: "DAILY", groupKey: "group-2", createdAt: new Date(now.getTime() - 1_000) }
    ]);
  });
});
