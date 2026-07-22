import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { applyPendingClerkEmailForSearch } from "@/lib/users/pending-email";
import {
  assertSafeSearchEmailPayload,
  drainSearchEmailDeliveryGroup,
  finalizeSearchEmailDeliveryGroup,
  getPendingStatusEmailReplacement,
  getSafeOfficialBookingUrl,
  hydrateMatchAlertPayload,
  hydrateSearchStatusEmailPayload,
  listRetryableSearchEmailDeliveryGroups,
  lockSearchForAlertMutation,
  lockSearchForEmailReconciliation,
  prepareRecipientMatchDeliveryGroups,
  prepareSearchEmailDeliveryGroup,
  SearchEmailDeliveryDeferredError,
  SearchEmailDeliveryInProgressError,
  suppressSearchEmailDeliveriesForMatches
} from "./search-delivery-outbox";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    course: { findMany: vi.fn() },
    courseProbe: { findMany: vi.fn() },
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

vi.mock("@/lib/users/pending-email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/users/pending-email")>(
    "@/lib/users/pending-email"
  );
  return {
    ...actual,
    applyPendingClerkEmailForSearch: vi.fn()
  };
});

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedApplyPendingClerkEmailForSearch = vi.mocked(
  applyPendingClerkEmailForSearch
);
const now = new Date("2026-07-15T15:00:00.000Z");
const currentSearch = {
  id: "search-1",
  userId: "user-1",
  status: "ACTIVE",
  alertGeneration: 3,
  checkLeaseToken: "check-lease",
  checkLeaseExpiresAt: new Date("2026-07-15T15:15:00.000Z"),
  ownerEmail: "owner@example.com",
  ownerPendingEmail: null,
  additionalEmails: ["friend@example.com"]
};
const payload = {
  schemaVersion: 2 as const,
  checkedAt: now.toISOString(),
  matchIds: ["match-1"],
  matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
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

const currentCourse = {
  id: "course-1",
  name: "Course",
  address: null,
  timeZone: "America/New_York",
  updatedAt: new Date("2026-07-15T14:00:00.000Z"),
  website: "https://example.com",
  detectedBookingUrl: "https://example.com/tee-times",
  isPublic: true,
  bookingMethod: "PUBLIC_ONLINE",
  automationEligibility: "ALLOWED",
  automationReason: "NONE",
  intelligenceVerifiedAt: null,
  intelligenceReviewAt: null,
  intelligenceConfidence: null
};

const currentMatch = {
  id: "match-1",
  courseId: "course-1",
  alertStatus: "PENDING",
  availabilityStatus: "AVAILABLE",
  availabilityCycle: 7,
  startsAt: new Date("2026-07-16T12:00:00.000Z"),
  availableSpots: 4,
  bookingUrl: "https://example.com/tee-times?date=2026-07-16",
  priceCents: 6500,
  holes: 18
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

function executeRawCallsContaining(fragment: string) {
  return mockedPrisma.$executeRaw.mock.calls.filter(([sql]) =>
    (sql as unknown as { strings: string[] }).strings.join(" ").includes(fragment)
  );
}

describe("search email delivery outbox", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
    mockedPrisma.$queryRaw.mockResolvedValue([currentSearch] as never);
    mockedPrisma.$executeRaw.mockResolvedValue(1 as never);
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "owner@example.com",
      pendingEmail: null
    } as never);
    mockedApplyPendingClerkEmailForSearch.mockResolvedValue({ outcome: "none" });
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue(null);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.course.findMany.mockResolvedValue([currentCourse] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        outcome: "MATCH_FOUND",
        observedAt: now
      }
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([currentMatch] as never);
    mockedPrisma.teeTimeMatch.count.mockResolvedValue(1);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.teeSearch.findFirst.mockResolvedValue({
      additionalEmails: ["friend@example.com"],
      user: { email: "owner@example.com" }
    } as never);
    mockedPrisma.teeSearch.update.mockResolvedValue({ id: "search-1" } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it("reads owner authority in a fresh statement after acquiring the search lock", async () => {
    const callOrder: string[] = [];
    mockedPrisma.$queryRaw.mockImplementation(async () => {
      callOrder.push("lock-search");
      return [currentSearch] as never;
    });
    mockedPrisma.user.findUnique.mockImplementation(async () => {
      callOrder.push("read-owner");
      return { email: "new-owner@example.com", pendingEmail: null } as never;
    });

    await expect(
      lockSearchForEmailReconciliation(prisma, {
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        now
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ownerEmail: "new-owner@example.com",
        ownerPendingEmail: null
      })
    );

    expect(callOrder).toEqual(["lock-search", "read-owner"]);
    const lockSql = mockedPrisma.$queryRaw.mock.calls[0][0] as unknown as {
      strings: string[];
    };
    expect(lockSql.strings.join(" ")).not.toContain('JOIN "User"');
    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { email: true, pendingEmail: true }
    });
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

  it("seeds already-reached status recipients as permanently terminal in a current replacement", async () => {
    const sentAt = new Date(now.getTime() - 30_000);
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: [],
      displayMatchIds: [],
      statusReport: { kind: "daily" }
    };
    const oldOwner = delivery("old-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "old-status",
      payload: statusPayload,
      status: "SENT",
      sentAt
    });
    const oldFriend = delivery("old-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "old-status",
      payload: statusPayload,
      status: "SUPPRESSED",
      attemptCount: 1,
      lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING"
    });
    const newOwner = delivery("new-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload,
      status: "SUPPRESSED",
      sentAt
    });
    const newFriend = delivery("new-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([oldOwner, oldFriend] as never)
      .mockResolvedValueOnce([newOwner, newFriend] as never);

    await prepareSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "DAILY",
      groupKey: "replacement-status",
      recipients: ["owner@example.com", "friend@example.com"],
      ownerRecipient: "owner@example.com",
      payload: statusPayload,
      supersededStatusGroups: [{ kind: "DAILY", groupKey: "old-status" }],
      now
    });

    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "owner@example.com",
          status: "SUPPRESSED",
          sentAt,
          lastError: "STATUS_RECIPIENT_PRIOR_REACHED"
        })
      })
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "friend@example.com"
        })
      })
    );
    expect(
      mockedPrisma.searchEmailDelivery.create.mock.calls[1]?.[0]?.data
    ).not.toHaveProperty("status");
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING"
        }),
        data: { lastError: "STATUS_CONTENT_STALE_REPLACED" }
      })
    );
  });

  it("does not resend current status to recipients who reached any coalesced status", async () => {
    const sentAt = new Date(now.getTime() - 30_000);
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: [],
      displayMatchIds: [],
      statusReport: { kind: "daily" }
    };
    const setupOwner = delivery("setup-owner", "owner@example.com", {
      kind: "SETUP",
      groupKey: "old-setup",
      payload: statusPayload,
      status: "SENT",
      sentAt
    });
    const setupFriend = delivery("setup-friend", "friend@example.com", {
      kind: "SETUP",
      groupKey: "old-setup",
      payload: statusPayload,
      status: "FAILED",
      attemptCount: 1
    });
    const dailyOwner = delivery("daily-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "old-daily",
      payload: statusPayload,
      status: "FAILED",
      attemptCount: 1
    });
    const dailyFriend = delivery("daily-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "old-daily",
      payload: statusPayload,
      status: "SENT",
      sentAt
    });
    const newOwner = delivery("new-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload
    });
    const newFriend = delivery("new-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        setupOwner,
        setupFriend,
        dailyOwner,
        dailyFriend
      ] as never)
      .mockResolvedValueOnce([newOwner, newFriend] as never);

    await prepareSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "DAILY",
      groupKey: "replacement-status",
      recipients: ["owner@example.com", "friend@example.com"],
      ownerRecipient: "owner@example.com",
      payload: statusPayload,
      supersededStatusGroups: [
        { kind: "SETUP", groupKey: "old-setup" },
        { kind: "DAILY", groupKey: "old-daily" }
      ],
      now
    });

    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledTimes(2);
    for (const call of mockedPrisma.searchEmailDelivery.create.mock.calls) {
      expect(call[0].data).toEqual(
        expect.objectContaining({
          status: "SUPPRESSED",
          sentAt,
          lastError: "STATUS_RECIPIENT_PRIOR_REACHED"
        })
      );
    }
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        alertGeneration: 3,
        lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING",
        OR: [
          { kind: "SETUP", groupKey: "old-setup" },
          { kind: "DAILY", groupKey: "old-daily" }
        ]
      },
      data: { lastError: "STATUS_CONTENT_STALE_REPLACED" }
    });
  });

  it("seeds prior and ambiguous status recipients while creating only uncovered match continuations", async () => {
    const sentAt = new Date(now.getTime() - 30_000);
    const oldStatusPayload = {
      schemaVersion: 2 as const,
      checkedAt: new Date(now.getTime() - 60_000).toISOString(),
      matchIds: [],
      matchRefs: [],
      displayMatchIds: [],
      statusReport: { kind: "daily" }
    };
    const currentStatusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: ["match-2"],
      matchRefs: [{ matchId: "match-2", availabilityCycle: 5 }],
      displayMatchIds: ["match-2"],
      statusSnapshot: [
        { courseId: "course-2", courseName: "Second Course", state: "MATCH_FOUND:1" }
      ],
      statusReport: {
        kind: "daily",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [
          {
            courseId: "course-2",
            courseName: "Second Course",
            timeZone: "America/New_York",
            outcome: "MATCH_FOUND",
            availableMatches: 1,
            bookingUrl: "https://example.com/tee-times?date=2026-07-16",
            matchingTimes: [
              {
                matchId: "match-2",
                startsAt: "2026-07-16T08:30:00",
                availableSpots: 4,
                priceCents: 5500,
                holes: 18
              }
            ]
          }
        ]
      }
    };
    const oldOwner = delivery("old-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "old-status",
      payload: oldStatusPayload,
      status: "SENT",
      attemptCount: 1,
      sentAt
    });
    const oldFriend = delivery("old-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "old-status",
      payload: oldStatusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout"
    });
    const replacementOwner = delivery("replacement-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: currentStatusPayload,
      status: "SUPPRESSED",
      sentAt,
      lastError: "STATUS_RECIPIENT_PRIOR_REACHED"
    });
    const replacementFriend = delivery("replacement-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: currentStatusPayload,
      status: "SUPPRESSED",
      lastError: "STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT"
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([oldOwner, oldFriend] as never)
      .mockResolvedValueOnce([oldOwner, oldFriend] as never)
      .mockResolvedValueOnce([replacementOwner, replacementFriend] as never);

    await expect(
      prepareSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "DAILY",
        groupKey: "replacement-status",
        recipients: ["owner@example.com", "friend@example.com"],
        ownerRecipient: "owner@example.com",
        payload: currentStatusPayload,
        supersededStatusGroups: [{ kind: "DAILY", groupKey: "old-status" }],
        now
      })
    ).resolves.toEqual(
      expect.objectContaining({
        prepared: true,
        continuationGroups: [
          { groupKey: expect.stringMatching(/^catchup-/) },
          { groupKey: expect.stringMatching(/^catchup-/) }
        ]
      })
    );

    const createdRows = mockedPrisma.searchEmailDelivery.create.mock.calls.map(
      ([call]) => call.data
    );
    expect(createdRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "DAILY",
          recipient: "owner@example.com",
          status: "SUPPRESSED",
          lastError: "STATUS_RECIPIENT_PRIOR_REACHED"
        }),
        expect.objectContaining({
          kind: "DAILY",
          recipient: "friend@example.com",
          status: "SUPPRESSED",
          lastError: "STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT"
        }),
        expect.objectContaining({
          kind: "MATCH",
          recipient: "owner@example.com",
          isOwnerRecipient: true,
          payload: expect.objectContaining({
            matchIds: ["match-2"],
            matchRefs: [{ matchId: "match-2", availabilityCycle: 5 }]
          })
        }),
        expect.objectContaining({
          kind: "MATCH",
          recipient: "friend@example.com",
          isOwnerRecipient: false,
          payload: expect.objectContaining({
            matchIds: ["match-2"],
            matchRefs: [{ matchId: "match-2", availabilityCycle: 5 }]
          })
        })
      ])
    );
  });

  it("does not let a seeded prior-reached owner consume an unseen current match cycle", async () => {
    const currentStatusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: ["match-2"],
      matchRefs: [{ matchId: "match-2", availabilityCycle: 5 }],
      displayMatchIds: ["match-2"],
      statusSnapshot: [{ courseId: "course-2", state: "MATCH_FOUND:1" }],
      statusReport: { kind: "daily" }
    };
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("replacement-owner", "owner@example.com", {
        kind: "DAILY",
        groupKey: "replacement-status",
        payload: currentStatusPayload,
        status: "SUPPRESSED",
        sentAt: new Date(now.getTime() - 30_000),
        lastError: "STATUS_RECIPIENT_PRIOR_REACHED"
      })
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "DAILY",
        groupKey: "replacement-status"
      })
    ).resolves.toEqual({
      finalized: true,
      status: "SUPPRESSED",
      ownerSent: false,
      ownerDeliveryOutcome: "PRIOR_REACHED",
      retainedMatchCount: 0,
      sentMatchCount: 0
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("rewrites one unattempted group atomically before its first send", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const friend = delivery("delivery-2", "friend@example.com");
    const refreshedPayload = {
      ...payload,
      checkedAt: new Date(now.getTime() + 60_000).toISOString()
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        { ...owner, payload: refreshedPayload },
        { ...friend, payload: refreshedPayload }
      ] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({ count: 2 } as never);

    await expect(
      prepareSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        recipients: ["owner@example.com", "friend@example.com"],
        ownerRecipient: "owner@example.com",
        payload: refreshedPayload,
        now
      })
    ).resolves.toEqual(
      expect.objectContaining({
        prepared: true,
        deliveries: expect.arrayContaining([
          expect.objectContaining({ payload: refreshedPayload })
        ])
      })
    );

    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-1", "delivery-2"] },
        attemptCount: 0,
        status: { notIn: ["SENDING", "SENT"] }
      },
      data: { payload: refreshedPayload }
    });
    expect(mockedPrisma.searchEmailDelivery.create).not.toHaveBeenCalled();
  });

  it("reactivates only pre-send suppressed recipients for the same immutable group", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "SUPPRESSED",
      sentAt: null
    });
    const friend = delivery("delivery-2", "friend@example.com", {
      status: "SENT",
      sentAt: now
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "PENDING" },
        friend
      ] as never);

    await expect(
      prepareSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        recipients: ["owner@example.com", "friend@example.com"],
        ownerRecipient: "owner@example.com",
        payload: {
          ...payload,
          checkedAt: new Date(now.getTime() + 60_000).toISOString()
        },
        now
      })
    ).resolves.toEqual(
      expect.objectContaining({
        prepared: true,
        deliveries: expect.arrayContaining([
          expect.objectContaining({ id: "delivery-1", status: "PENDING", payload }),
          expect.objectContaining({ id: "delivery-2", status: "SENT", payload })
        ])
      })
    );

    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-1"] },
        status: "SUPPRESSED",
        sentAt: null,
        attemptCount: 0
      },
      data: {
        status: "PENDING",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: null
      }
    });
    expect(mockedPrisma.searchEmailDelivery.create).not.toHaveBeenCalled();
  });

  it("never reactivates a suppressed recipient after a send was attempted", async () => {
    const attempted = delivery("delivery-1", "owner@example.com", {
      status: "SUPPRESSED",
      attemptCount: 1,
      sentAt: null
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([attempted] as never)
      .mockResolvedValueOnce([attempted] as never);

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
    ).resolves.toEqual(
      expect.objectContaining({
        prepared: true,
        deliveries: [expect.objectContaining({ status: "SUPPRESSED", attemptCount: 1 })]
      })
    );

    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("deduplicates match obligations independently by recipient and exact cycle", async () => {
    const ownerCycleSeven = delivery("old-owner", "owner@example.com", {
      groupKey: "old-owner-group"
    });
    const friendCycleEight = delivery("old-friend", "friend@example.com", {
      groupKey: "old-friend-group",
      isOwnerRecipient: false,
      payload: {
        ...payload,
        matchRefs: [{ matchId: "match-1", availabilityCycle: 8 }]
      }
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      ownerCycleSeven,
      friendCycleEight
    ] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("new-friend", "friend@example.com", {
        isOwnerRecipient: false,
        groupKey: "catchup-new"
      }) as never
    );

    await expect(
      prepareRecipientMatchDeliveryGroups({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        sourceGroupKey: "current-status",
        recipients: ["owner@example.com", "friend@example.com"],
        ownerRecipient: "owner@example.com",
        payload,
        now
      })
    ).resolves.toEqual({
      prepared: true,
      groups: [{ groupKey: expect.stringMatching(/^catchup-/), recipient: "friend@example.com" }],
      hasExistingObligation: true
    });

    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledOnce();
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "friend@example.com",
          isOwnerRecipient: false,
          payload: expect.objectContaining({
            matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }]
          })
        })
      })
    );
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
    expect(mockedApplyPendingClerkEmailForSearch).toHaveBeenCalledTimes(2);
  });

  it("does not start another old-recipient claim while a Clerk email transition is pending", async () => {
    const retryAt = new Date(now.getTime() + 60_000);
    mockedApplyPendingClerkEmailForSearch.mockResolvedValue({
      outcome: "deferred",
      retryAt
    });
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "owner@example.com",
      pendingEmail: "new-owner@example.com"
    } as never);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com")
    ] as never);
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
    ).rejects.toMatchObject({
      code: "SEARCH_EMAIL_DELIVERY_DEFERRED",
      retryAt
    });

    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks pending owner state inside the claim transaction after a clean preliminary check", async () => {
    mockedApplyPendingClerkEmailForSearch.mockResolvedValue({ outcome: "none" });
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "owner@example.com",
      pendingEmail: "new-owner@example.com"
    } as never);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com")
    ] as never);
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
    ).rejects.toMatchObject({
      code: "SEARCH_EMAIL_DELIVERY_DEFERRED",
      retryAt: new Date(now.getTime() + 60_000)
    });

    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("retries with the same idempotency key and exact immutable body", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const failedOwner = {
      ...owner,
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() + 60_000)
    };
    const retryAt = new Date(now.getTime() + 60_001);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([failedOwner] as never)
      .mockResolvedValueOnce([failedOwner] as never)
      .mockResolvedValueOnce([
        { ...failedOwner, status: "SENT", sentAt: retryAt }
      ] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({ count: 1 } as never);
    const firstError = new Error("temporary delivery failure");
    const attempts: Array<{ idempotencyKey: string; payload: unknown }> = [];
    const send = vi.fn(async (input: { idempotencyKey: string; payload: unknown }) => {
      attempts.push(input);
      if (attempts.length === 1) {
        throw firstError;
      }
      return { deliveryStatus: "sent" as const };
    });

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
    ).rejects.toBe(firstError);
    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => retryAt
      })
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(attempts).toHaveLength(2);
    expect(attempts[0].idempotencyKey).toBe(attempts[1].idempotencyKey);
    expect(attempts[0].payload).toEqual(payload);
    expect(attempts[1].payload).toEqual(payload);
  });

  it("rechecks recipient authority immediately before the provider call", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const failedOwner = {
      ...owner,
      status: "FAILED",
      attemptCount: 1,
      lastError:
        "DELIVERY_NOT_ACCEPTED:Alert recipient authorization changed before delivery"
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([failedOwner] as never);
    mockedPrisma.user.findUnique
      .mockResolvedValueOnce({
        email: "owner@example.com",
        pendingEmail: null
      } as never)
      .mockResolvedValue({
        email: "new-owner@example.com",
        pendingEmail: null
      } as never);
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
    ).rejects.toMatchObject({ code: "EMAIL_DELIVERY_NOT_ACCEPTED" });

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.user.findUnique.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError: expect.stringMatching(/^DELIVERY_NOT_ACCEPTED:/)
        })
      })
    );
  });

  it("does not resurrect a claim that expires while waiting for the final fence", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const failedOwner = {
      ...owner,
      status: "FAILED",
      attemptCount: 1,
      lastError:
        "DELIVERY_NOT_ACCEPTED:Alert email delivery claim expired before provider delivery"
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([failedOwner] as never);
    mockedPrisma.$executeRaw
      .mockResolvedValueOnce(1 as never)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValue(1 as never);
    const providerSend = vi.fn();
    const send = vi.fn(
      async (input: { assertCurrentDelivery: () => Promise<void> }) => {
        await input.assertCurrentDelivery();
        providerSend();
        return { deliveryStatus: "sent" as const };
      }
    );

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
    ).rejects.toMatchObject({ code: "EMAIL_DELIVERY_NOT_ACCEPTED" });

    expect(send).toHaveBeenCalledOnce();
    expect(providerSend).not.toHaveBeenCalled();
    const renewalSql = mockedPrisma.$executeRaw.mock.calls[1][0] as unknown as {
      strings: string[];
    };
    const renewalText = renewalSql.strings.join(" ");
    expect(renewalText).toContain(
      '"claimExpiresAt" > statement_timestamp()'
    );
    expect(renewalText).toContain(
      'SET "claimExpiresAt" = statement_timestamp()'
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError: expect.stringMatching(/^DELIVERY_NOT_ACCEPTED:/)
        })
      })
    );
  });

  it("checks recipient-scoped overlap before sending a match group", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now
    });

    expect(mockedPrisma.searchEmailDelivery.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "MATCH",
          groupKey: { not: "match-group" },
          recipient: { in: ["owner@example.com"] }
        })
      })
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("retires a new recipient row when an attempted group already owns its exact cycle", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const attemptedOwner = delivery("attempted-delivery", "owner@example.com", {
      groupKey: "attempted-group",
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
      createdAt: new Date(now.getTime() - 120_000)
    });
    const retiredOwner = {
      ...owner,
      status: "SUPPRESSED",
      lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP"
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([attemptedOwner] as never)
      .mockResolvedValueOnce([retiredOwner] as never);
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValueOnce({
      id: "attempted-delivery"
    } as never);
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
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["delivery-1"] } },
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP"
        })
      })
    );
  });

  it("lets a reached overlapping group outrank a current ambiguous retry", async () => {
    const ambiguousOwner = delivery("current-ambiguous", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout"
    });
    const reachedOwner = delivery("reached-owner", "owner@example.com", {
      groupKey: "reached-group",
      status: "SENT",
      sentAt: new Date(now.getTime() - 60_000),
      createdAt: new Date(now.getTime() - 120_000)
    });
    const retiredOwner = {
      ...ambiguousOwner,
      status: "SUPPRESSED",
      lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP"
    };
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValueOnce({
      id: "reached-owner"
    } as never);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([ambiguousOwner] as never)
      .mockResolvedValueOnce([reachedOwner] as never)
      .mockResolvedValueOnce([retiredOwner] as never);
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
    ).resolves.toEqual([
      { id: "current-ambiguous", status: "SUPPRESSED" }
    ]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["current-ambiguous"] } },
        data: expect.objectContaining({
          lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP"
        })
      })
    );
  });

  it("rekeys an overlapping delivery only when the provider definitively did not accept it", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const notAccepted = delivery("not-accepted", "owner@example.com", {
      groupKey: "older-group",
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected",
      createdAt: new Date(now.getTime() - 120_000)
    });
    const sentOwner = { ...owner, status: "SENT", sentAt: now };
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValueOnce({
      id: "not-accepted"
    } as never);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([notAccepted] as never)
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([sentOwner] as never);
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
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledOnce();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["not-accepted"] } },
      data: {
        status: "SUPPRESSED",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: "MATCH_STALE_REKEYED"
      }
    });
  });

  it("retires an unattempted old owner address and prepares the exact-cycle successor for the current owner", async () => {
    const oldOwner = delivery("old-owner", "old-owner@example.com", {
      isOwnerRecipient: true
    });
    const friend = delivery("friend", "friend@example.com", {
      isOwnerRecipient: false
    });
    const retiredOwner = {
      ...oldOwner,
      status: "SUPPRESSED",
      lastError: "DELIVERY_RECIPIENT_REKEYED"
    };
    const sentFriend = { ...friend, status: "SENT", sentAt: now };
    mockedPrisma.$queryRaw.mockResolvedValue([
      {
        ...currentSearch,
        ownerEmail: "new-owner@example.com",
        additionalEmails: ["friend@example.com"]
      }
    ] as never);
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "new-owner@example.com",
      pendingEmail: null
    } as never);
    mockedPrisma.teeSearch.findFirst.mockResolvedValue({
      additionalEmails: ["friend@example.com"],
      user: { email: "new-owner@example.com" }
    } as never);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([oldOwner, friend] as never)
      .mockResolvedValueOnce([retiredOwner, friend] as never)
      .mockResolvedValueOnce([retiredOwner, sentFriend] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("successor", "new-owner@example.com", {
        groupKey: "catchup-current-owner"
      }) as never
    );
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "friend@example.com" })
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "new-owner@example.com",
          isOwnerRecipient: true,
          payload: expect.objectContaining({
            matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }]
          })
        })
      })
    );
  });

  it("fails an ambiguous old owner closed while preserving an authorized additional recipient", async () => {
    const oldOwner = delivery("old-owner", "old-owner@example.com", {
      isOwnerRecipient: true,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout"
    });
    const friend = delivery("friend", "friend@example.com", {
      isOwnerRecipient: false
    });
    const blockedOwner = {
      ...oldOwner,
      status: "SUPPRESSED",
      lastError: "MATCH_STALE_REKEY_BLOCKED"
    };
    const sentFriend = { ...friend, status: "SENT", sentAt: now };
    mockedPrisma.$queryRaw.mockResolvedValue([
      {
        ...currentSearch,
        ownerEmail: "new-owner@example.com",
        additionalEmails: ["friend@example.com"]
      }
    ] as never);
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "new-owner@example.com",
      pendingEmail: null
    } as never);
    mockedPrisma.teeSearch.findFirst.mockResolvedValue({
      additionalEmails: ["friend@example.com"],
      user: { email: "new-owner@example.com" }
    } as never);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([oldOwner, friend] as never)
      .mockResolvedValueOnce([blockedOwner, friend] as never)
      .mockResolvedValueOnce([blockedOwner, sentFriend] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("sentinel", "new-owner@example.com", {
        status: "SUPPRESSED",
        lastError: "MATCH_STALE_REKEY_BLOCKED"
      }) as never
    );
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "friend@example.com" })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-1", availabilityCycle: 7 }],
          alertStatus: "PENDING"
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null }
      })
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "new-owner@example.com",
          isOwnerRecipient: true,
          status: "SUPPRESSED",
          lastError: "MATCH_STALE_REKEY_BLOCKED"
        })
      })
    );
  });

  it("seeds exactly one current-owner terminal status when the old owner outcome is ambiguous", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      statusSnapshot: [],
      statusReport: { kind: "daily" }
    };
    const oldOwner = delivery("old-owner", "old-owner@example.com", {
      kind: "DAILY",
      groupKey: "daily-group",
      isOwnerRecipient: true,
      payload: statusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout"
    });
    const blockedOwner = {
      ...oldOwner,
      status: "SUPPRESSED",
      lastError: "DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED"
    };
    const currentOwnerSentinel = delivery(
      "current-owner-sentinel",
      "new-owner@example.com",
      {
        kind: "DAILY",
        groupKey: "daily-group",
        isOwnerRecipient: true,
        payload: statusPayload,
        status: "SUPPRESSED",
        lastError: "STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT"
      }
    );
    mockedPrisma.$queryRaw.mockResolvedValue([
      {
        ...currentSearch,
        ownerEmail: "new-owner@example.com",
        additionalEmails: []
      }
    ] as never);
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "new-owner@example.com",
      pendingEmail: null
    } as never);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([oldOwner] as never)
      .mockResolvedValueOnce([blockedOwner, currentOwnerSentinel] as never)
      .mockResolvedValueOnce([blockedOwner, currentOwnerSentinel] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      currentOwnerSentinel as never
    );
    const send = vi.fn();

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "DAILY",
        groupKey: "daily-group",
        send,
        now: () => now
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "current-owner-sentinel", status: "SUPPRESSED" })
      ])
    );

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledOnce();
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipient: "new-owner@example.com",
        isOwnerRecipient: true,
        status: "SUPPRESSED",
        lastError: "STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT"
      })
    });
  });

  it("fails legacy ambiguous ownership closed by match id while allowing a safe legacy row to rekey", async () => {
    const legacyPayload = { ...payload } as Record<string, unknown>;
    delete legacyPayload.matchRefs;
    const ambiguousLegacyOwner = delivery("legacy-owner", "owner@example.com", {
      groupKey: "legacy-group",
      payload: legacyPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout"
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      ambiguousLegacyOwner
    ] as never);

    await expect(
      prepareRecipientMatchDeliveryGroups({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        sourceGroupKey: "current-status",
        recipients: ["owner@example.com"],
        ownerRecipient: "owner@example.com",
        payload,
        now
      })
    ).resolves.toEqual({
      prepared: true,
      groups: [],
      hasExistingObligation: true
    });

    expect(mockedPrisma.searchEmailDelivery.create).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-1", availabilityCycle: 7 }]
        })
      })
    );

    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
    mockedPrisma.$queryRaw.mockResolvedValue([currentSearch] as never);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      { ...ambiguousLegacyOwner, status: "PENDING", attemptCount: 0, lastError: null }
    ] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("current-owner", "owner@example.com") as never
    );

    await expect(
      prepareRecipientMatchDeliveryGroups({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        sourceGroupKey: "current-status",
        recipients: ["owner@example.com"],
        ownerRecipient: "owner@example.com",
        payload,
        now
      })
    ).resolves.toEqual({
      prepared: true,
      groups: [
        { groupKey: expect.stringMatching(/^catchup-/), recipient: "owner@example.com" }
      ],
      hasExistingObligation: false
    });
  });

  it("does not let a row retired in favor of another group become an owner again", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("retired-owner", "owner@example.com", {
        status: "SUPPRESSED",
        lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP"
      })
    ] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("current-owner", "owner@example.com") as never
    );

    await expect(
      prepareRecipientMatchDeliveryGroups({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        sourceGroupKey: "new-current-group",
        recipients: ["owner@example.com"],
        ownerRecipient: "owner@example.com",
        payload,
        now
      })
    ).resolves.toEqual({
      prepared: true,
      groups: [
        { groupKey: expect.stringMatching(/^catchup-/), recipient: "owner@example.com" }
      ],
      hasExistingObligation: false
    });
  });

  it("retries a frozen current match group with its immutable payload", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1)
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([{ ...owner, status: "SENT", sentAt: now }] as never);
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue(null);
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
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ payload }));
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

  it("retires an expired SENDING claim as ambiguous before allowing a mutation", async () => {
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue(null);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          payload,
          status: "SENDING",
          attemptCount: 1,
          sentAt: null,
          lastError: null
        }
      ] as never);

    await lockSearchForAlertMutation(prisma, {
      searchId: "search-1",
      userId: "user-1",
      now
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-1", availabilityCycle: 7 }],
          alertStatus: "PENDING"
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null }
      })
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "SENDING" }),
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "DELIVERY_OUTCOME_UNKNOWN_AFTER_SEARCH_MUTATION"
        })
      })
    );
  });

  it("consumes pending matches from every attempted delivery kind before a generation mutation", async () => {
    const attemptedSetupPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: ["match-1"],
      matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
      displayMatchIds: ["match-1"],
      statusReport: { kind: "setup" }
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          payload: attemptedSetupPayload,
          status: "FAILED",
          attemptCount: 1,
          sentAt: null,
          lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout"
        }
      ] as never);

    await lockSearchForAlertMutation(prisma, {
      searchId: "search-1",
      userId: "user-1",
      now
    });

    expect(mockedPrisma.searchEmailDelivery.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertGeneration: 3
        })
      })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-1", availabilityCycle: 7 }],
          alertStatus: "PENDING"
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null }
      })
    );
  });

  it("leaves unattempted pending matches available for the next alert generation", async () => {
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await lockSearchForAlertMutation(prisma, {
      searchId: "search-1",
      userId: "user-1",
      now
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
  });

  it("finalizes an owner-sent match before consuming only still-pending attempted evidence", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "SENT",
      sentAt: now
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([{ kind: "MATCH", groupKey: "match-group" }] as never)
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        {
          payload: {
            ...payload,
            matchIds: ["match-2"],
            matchRefs: [{ matchId: "match-2", availabilityCycle: 4 }],
            displayMatchIds: ["match-2"]
          },
          status: "FAILED",
          attemptCount: 1,
          sentAt: null,
          lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout"
        }
      ] as never);

    await lockSearchForAlertMutation(prisma, {
      searchId: "search-1",
      userId: "user-1",
      now
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: { alertStatus: "SENT", sentAt: now } })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-2", availabilityCycle: 4 }],
          alertStatus: "PENDING"
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null }
      })
    );
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
        matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
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
        matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
        now
      })
    ).resolves.toEqual({ count: 0, matchCount: 0, current: false });

    expect(mockedPrisma.$queryRaw).toHaveBeenCalledOnce();
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("suppresses only the referenced availability cycle after an opening is reopened", async () => {
    await expect(
      suppressSearchEmailDeliveriesForMatches({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
        now
      })
    ).resolves.toEqual({ count: 1, matchCount: 1, current: true });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        OR: [{ id: "match-1", availabilityCycle: 7 }],
        alertStatus: "PENDING"
      },
      data: { alertStatus: "SUPPRESSED", sentAt: null }
    });
  });

  it("never revives a group after one referenced pending match is gone", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1)
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null }
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([]);
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

  it("suppresses a queued match retry when the course is now an identity final", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1)
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null }
      ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        isPublic: false,
        bookingMethod: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        intelligenceVerifiedAt: now,
        intelligenceReviewAt: new Date("2026-08-15T00:00:00.000Z"),
        intelligenceConfidence: 0.99
      }
    ] as never);
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

    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["course-1"] } } })
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("reconciles an unattempted group to its confirmed subset before claiming it", async () => {
    const validRow = payload.matchReport.matches[0];
    const terminalRow = {
      ...validRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Private Course"
    };
    const multiCoursePayload = {
      ...payload,
      matchIds: ["match-1", "match-2"],
      matchRefs: [
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 4 }
      ],
      displayMatchIds: ["match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [validRow, terminalRow]
      }
    };
    const reconciledPayload = {
      ...multiCoursePayload,
      matchIds: ["match-1"],
      matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
      displayMatchIds: ["match-1"],
      satisfiesStatusReport: false,
      matchReport: {
        ...payload.matchReport,
        matches: [validRow]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      payload: multiCoursePayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, payload: reconciledPayload, status: "SENT", sentAt: now }
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-1",
        courseId: "course-1",
        alertStatus: "PENDING",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 7
      },
      {
        id: "match-2",
        courseId: "course-2",
        alertStatus: "PENDING",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 4
      }
    ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      },
      {
        id: "course-2",
        isPublic: false,
        bookingMethod: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        intelligenceVerifiedAt: now,
        intelligenceReviewAt: new Date("2026-08-15T00:00:00.000Z"),
        intelligenceConfidence: 0.99
      }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now }
    ] as never);
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
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload: reconciledPayload })
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-1"] },
        attemptCount: 0,
        status: { notIn: ["SENDING", "SENT"] }
      },
      data: { payload: reconciledPayload }
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-2", availabilityCycle: 4 }]
        }),
        data: expect.objectContaining({
          alertStatus: "SUPPRESSED",
          availabilityStatus: "GONE"
        })
      })
    );
  });

  it("lets terminal evidence dominate transient evidence for a frozen group", async () => {
    const validRow = payload.matchReport.matches[0];
    const privateRow = {
      ...validRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Private Course"
    };
    const multiCoursePayload = {
      ...payload,
      matchIds: ["match-1", "match-2"],
      matchRefs: [
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 4 }
      ],
      displayMatchIds: ["match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [validRow, privateRow]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
      payload: multiCoursePayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null }
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-1",
        courseId: "course-1",
        alertStatus: "PENDING",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 7
      },
      {
        id: "match-2",
        courseId: "course-2",
        alertStatus: "PENDING",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 4
      }
    ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      },
      {
        id: "course-2",
        isPublic: false,
        bookingMethod: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        intelligenceVerifiedAt: now,
        intelligenceReviewAt: new Date("2026-08-15T00:00:00.000Z"),
        intelligenceConfidence: 0.99
      }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "FETCH_FAILED", observedAt: now }
    ] as never);
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
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-2", availabilityCycle: 4 }]
        }),
        data: expect.objectContaining({
          alertStatus: "SUPPRESSED",
          availabilityStatus: "GONE"
        })
      })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        OR: [
          { id: "match-1", availabilityCycle: 7 },
          { id: "match-2", availabilityCycle: 4 }
        ],
        alertStatus: "PENDING"
      },
      data: { alertStatus: "SUPPRESSED", sentAt: null }
    });
  });

  it("splits a frozen mixed group into independent confirmed and transient continuations", async () => {
    const confirmedRow = payload.matchReport.matches[0];
    const terminalRow = {
      ...confirmedRow,
      matchId: "match-0",
      courseId: "course-0",
      courseName: "Removed Course"
    };
    const transientRow = {
      ...confirmedRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Second Course",
      startsAt: "2026-07-16T13:00:00.000Z"
    };
    const mixedPayload = {
      ...payload,
      matchIds: ["match-0", "match-1", "match-2"],
      matchRefs: [
        { matchId: "match-0", availabilityCycle: 3 },
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 4 }
      ],
      displayMatchIds: ["match-0", "match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [terminalRow, confirmedRow, transientRow]
      }
    };
    const frozenOwner = delivery("delivery-1", "owner@example.com", {
      payload: mixedPayload,
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected"
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([frozenOwner] as never)
      .mockResolvedValueOnce([
        {
          ...frozenOwner,
          status: "SUPPRESSED",
          nextAttemptAt: null,
          lastError: "MATCH_STALE_REKEYED"
        }
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      currentMatch,
      {
        ...currentMatch,
        id: "match-2",
        courseId: "course-2",
        availabilityCycle: 4,
        startsAt: new Date("2026-07-16T13:00:00.000Z")
      }
    ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      currentCourse,
      {
        ...currentCourse,
        id: "course-2",
        name: "Second Course"
      }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now },
      { courseId: "course-2", outcome: "FETCH_FAILED", observedAt: now }
    ] as never);

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send: vi.fn(),
        now: () => now
      })
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    const continuationPayloads = mockedPrisma.searchEmailDelivery.create.mock.calls.map(
      ([call]) => call.data.payload
    );
    expect(continuationPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientCatchup: true,
          matchIds: ["match-1"],
          matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }]
        }),
        expect.objectContaining({
          recipientCatchup: true,
          matchIds: ["match-2"],
          matchRefs: [{ matchId: "match-2", availabilityCycle: 4 }]
        })
      ])
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-0", availabilityCycle: 3 }]
        }),
        data: expect.objectContaining({ availabilityStatus: "GONE" })
      })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { id: "match-1", availabilityCycle: 7 },
            { id: "match-2", availabilityCycle: 4 }
          ])
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null }
      })
    );
  });

  it("suppresses instead of rewriting an immutable payload with a stale display match", async () => {
    const currentRow = payload.matchReport.matches[0];
    const staleRow = {
      ...currentRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Gone Course"
    };
    const retryPayload = {
      ...payload,
      displayMatchIds: ["match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [currentRow, staleRow]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
      payload: retryPayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null }
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-1",
        courseId: "course-1",
        alertStatus: "PENDING",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 7
      },
      {
        id: "match-2",
        courseId: "course-2",
        alertStatus: "SENT",
        availabilityStatus: "GONE",
        availabilityCycle: 2
      }
    ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      },
      {
        id: "course-2",
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      }
    ] as never);
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
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        OR: [{ id: "match-1", availabilityCycle: 7 }],
        alertStatus: "PENDING"
      },
      data: { alertStatus: "SUPPRESSED", sentAt: null }
    });
  });

  it("defers an attempted match email during a transient probe failure", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1)
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "FETCH_FAILED", observedAt: now }
    ] as never);
    const send = vi.fn();

    const error = await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(SearchEmailDeliveryDeferredError);
    expect(error.retryAt).toEqual(new Date(now.getTime() + 60_000));
    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it.each([
    {
      kind: "SETUP" as const,
      reportKind: "setup",
      reportOutcome: "NO_MATCH",
      currentOutcome: "MATCH_FOUND",
      monitoringDisposition: undefined
    },
    {
      kind: "DAILY" as const,
      reportKind: "daily",
      reportOutcome: "MATCH_FOUND",
      currentOutcome: "MATCH_FOUND",
      monitoringDisposition: "TECHNICAL_FINAL"
    },
    {
      kind: "SETUP" as const,
      reportKind: "setup",
      reportOutcome: "BLOCKED_POLICY",
      currentOutcome: "BLOCKED_POLICY",
      monitoringDisposition: undefined
    }
  ])(
    "suppresses stale $kind status evidence before send",
    async ({ kind, reportKind, reportOutcome, currentOutcome, monitoringDisposition }) => {
      const statusPayload = {
        schemaVersion: 2 as const,
        checkedAt: now.toISOString(),
        displayMatchIds: reportOutcome === "MATCH_FOUND" ? ["match-1"] : [],
        statusSnapshot: [{ courseId: "course-1", state: reportOutcome }],
        statusReport: {
          kind: reportKind,
          targetDate: "2026-07-16",
          startTime: "07:00",
          endTime: "10:00",
          players: 2,
          requestedLayoutHoles: null,
          userTimeZone: "America/New_York",
          courses: [
            {
              courseId: "course-1",
              courseName: "Course",
              timeZone: "America/New_York",
              outcome: reportOutcome,
              availableMatches: reportOutcome === "MATCH_FOUND" ? 1 : 0,
              ...(monitoringDisposition ? { monitoringDisposition } : {})
            }
          ]
        }
      };
      const owner = delivery("delivery-1", "owner@example.com", {
        kind,
        groupKey: "status-group",
        payload: statusPayload
      });
      mockedPrisma.searchEmailDelivery.findMany
        .mockResolvedValueOnce([owner] as never)
        .mockResolvedValueOnce([
          { ...owner, status: "SUPPRESSED", nextAttemptAt: null }
        ] as never);
      mockedPrisma.courseProbe.findMany.mockResolvedValue([
        { courseId: "course-1", outcome: currentOutcome, observedAt: now }
      ] as never);
      const send = vi.fn();

      await expect(
        drainSearchEmailDeliveryGroup({
          searchId: "search-1",
          alertGeneration: 3,
          checkLeaseToken: "check-lease",
          kind,
          groupKey: "status-group",
          send,
          now: () => now
        })
      ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);
      expect(send).not.toHaveBeenCalled();
    }
  );

  it("retires an ambiguously attempted stale status without issuing a new status key", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      displayMatchIds: [],
      statusSnapshot: [{ courseId: "course-1", state: "NO_MATCH" }],
      statusReport: {
        kind: "daily",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [
          {
            courseId: "course-1",
            courseName: "Course",
            timeZone: "America/New_York",
            outcome: "NO_MATCH",
            availableMatches: 0
          }
        ]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload,
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1)
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null }
      ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now }
    ] as never);
    const send = vi.fn();

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "DAILY",
        groupKey: "status-group",
        send,
        now: () => now
      })
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING_AMBIGUOUS"
        })
      })
    );
    expect(mockedPrisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it("keeps an already-reached recipient terminal across a crash before replacement claim", async () => {
    const sentAt = new Date(now.getTime() - 30_000);
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      displayMatchIds: [],
      statusSnapshot: [{ courseId: "course-1", state: "NO_MATCH" }],
      statusReport: {
        kind: "daily",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [
          {
            courseId: "course-1",
            courseName: "Course",
            timeZone: "America/New_York",
            outcome: "NO_MATCH",
            availableMatches: 0
          }
        ]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload,
      status: "SUPPRESSED",
      sentAt,
      lastError: "STATUS_RECIPIENT_PRIOR_REACHED"
    });
    const friend = delivery("delivery-2", "friend@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        owner,
        {
          ...friend,
          status: "SUPPRESSED",
          lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING"
        }
      ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now }
    ] as never);
    const send = vi.fn();

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "DAILY",
        groupKey: "replacement-status",
        send,
        now: () => now
      })
    ).resolves.toEqual([
      expect.objectContaining({ id: "delivery-1", status: "SUPPRESSED" }),
      expect.objectContaining({ id: "delivery-2", status: "SUPPRESSED" })
    ]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["delivery-2"] } }),
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING"
        })
      })
    );
    expect(mockedPrisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it("sends an unchanged status snapshot when its gate and newest probe still match", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      displayMatchIds: [],
      statusSnapshot: [{ courseId: "course-1", state: "NO_MATCH" }],
      statusReport: {
        kind: "daily",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [
          {
            courseId: "course-1",
            courseName: "Course",
            timeZone: "America/New_York",
            outcome: "NO_MATCH",
            availableMatches: 0
          }
        ]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([{ ...owner, status: "SENT", sentAt: now }] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "NO_MATCH", observedAt: now }
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([]);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "DAILY",
        groupKey: "status-group",
        send,
        now: () => now
      })
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload: statusPayload })
    );
  });

  it.each([
    {
      description: "sends a current status when optional provider details are omitted",
      optionalDetails: {},
      terminalStatus: "SENT" as const,
      shouldSend: true
    },
    {
      description: "retires a status when a supplied provider price changed",
      optionalDetails: { priceCents: 4000 },
      terminalStatus: "SUPPRESSED" as const,
      shouldSend: false
    }
  ])("$description", async ({ optionalDetails, terminalStatus, shouldSend }) => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: [],
      displayMatchIds: ["match-1"],
      statusSnapshot: [{ courseId: "course-1", state: "MATCH_FOUND" }],
      statusReport: {
        kind: "daily",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [
          {
            courseId: "course-1",
            courseName: "Course",
            timeZone: "America/New_York",
            outcome: "MATCH_FOUND",
            availableMatches: 1,
            matchingTimes: [
              {
                matchId: "match-1",
                startsAt: "2026-07-16T08:30",
                availableSpots: 4,
                ...optionalDetails
              }
            ]
          }
        ]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        {
          ...owner,
          status: terminalStatus,
          sentAt: shouldSend ? now : null
        }
      ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        name: "Course",
        address: null,
        timeZone: "America/New_York",
        updatedAt: new Date("2026-07-15T14:00:00.000Z"),
        website: "https://course.example/",
        detectedBookingUrl: "https://course.example/tee-times",
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now }
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-1",
        courseId: "course-1",
        startsAt: new Date("2026-07-16T12:30:00.000Z"),
        availableSpots: 4,
        priceCents: 5000,
        holes: 18,
        alertStatus: "SENT",
        availabilityCycle: 1
      }
    ] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "DAILY",
        groupKey: "status-group",
        send,
        now: () => now
      })
    ).resolves.toContainEqual({ id: "delivery-1", status: terminalStatus });

    if (shouldSend) {
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ payload: statusPayload })
      );
    } else {
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("retires an unattempted daily report when the exact rendered opening changed", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: [],
      displayMatchIds: ["match-old"],
      statusReport: {
        kind: "daily",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [
          {
            courseId: "course-1",
            courseName: "Course",
            timeZone: "America/New_York",
            outcome: "MATCH_FOUND",
            availableMatches: 1
          }
        ]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([{ ...owner, status: "SUPPRESSED" }] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        name: "Course",
        address: null,
        timeZone: "America/New_York",
        updatedAt: new Date("2026-07-15T14:00:00.000Z"),
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now }
    ] as never);
    mockedPrisma.teeTimeMatch.findMany
      .mockResolvedValueOnce([
        {
          id: "match-old",
          courseId: "course-1",
          alertStatus: "SENT",
          availabilityStatus: "AVAILABLE"
        }
      ] as never)
      .mockResolvedValueOnce([
        {
          id: "match-new",
          courseId: "course-1",
          startsAt: new Date("2026-07-16T12:30:00.000Z"),
          availableSpots: 4,
          priceCents: 5000,
          holes: 18,
          alertStatus: "PENDING"
        }
      ] as never);
    const send = vi.fn();

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "DAILY",
        groupKey: "status-group",
        send,
        now: () => now
      })
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores available matches outside the persisted daily intent window", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: [],
      displayMatchIds: [],
      statusReport: {
        kind: "daily",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [
          {
            courseId: "course-1",
            courseName: "Course",
            timeZone: "America/New_York",
            outcome: "NO_MATCH",
            availableMatches: 0
          }
        ]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([{ ...owner, status: "SENT", sentAt: now }] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        name: "Course",
        address: null,
        timeZone: "America/New_York",
        updatedAt: new Date("2026-07-15T14:00:00.000Z"),
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "NO_MATCH", observedAt: now }
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "old-date-match",
        courseId: "course-1",
        startsAt: new Date("2026-07-15T12:30:00.000Z"),
        availableSpots: 4,
        priceCents: 5000,
        holes: 18,
        alertStatus: "SENT"
      }
    ] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "DAILY",
      groupKey: "status-group",
      send,
      now: () => now
    });

    expect(send).toHaveBeenCalledOnce();
  });

  it("sends a current transient status while retaining the last available match as uncertain", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: [],
      displayMatchIds: [],
      statusReport: {
        kind: "daily",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [
          {
            courseId: "course-1",
            courseName: "Course",
            timeZone: "America/New_York",
            outcome: "FETCH_FAILED",
            availableMatches: 0
          }
        ]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([{ ...owner, status: "SENT", sentAt: now }] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        name: "Course",
        address: null,
        timeZone: "America/New_York",
        updatedAt: new Date("2026-07-15T14:00:00.000Z"),
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "FETCH_FAILED", observedAt: now }
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "uncertain-match",
        courseId: "course-1",
        startsAt: new Date("2026-07-16T12:30:00.000Z"),
        availableSpots: 4,
        priceCents: 5000,
        holes: 18,
        alertStatus: "SUPPRESSED"
      }
    ] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "DAILY",
      groupKey: "status-group",
      send,
      now: () => now
    });

    expect(send).toHaveBeenCalledOnce();
  });

  it("finalizes a pre-send stale-suppressed group without suppressing its pending match", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        status: "SUPPRESSED",
        sentAt: null
      })
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "match-group"
      })
    ).resolves.toEqual({
      finalized: true,
      status: "SUPPRESSED",
      ownerSent: false,
      ownerDeliveryOutcome: "SAFETY_SUPPRESSED",
      retainedMatchCount: 0,
      sentMatchCount: 0
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
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
          lastError: "DELIVERY_OUTCOME_UNKNOWN:Provider failed for [email] at [url]"
        })
      })
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
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
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
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
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("creates a recipient-only catch-up for surviving openings after the owner was sent", async () => {
    const oldRow = payload.matchReport.matches[0];
    const survivingRow = {
      ...oldRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Second Course",
      startsAt: "2026-07-16T13:00:00.000Z"
    };
    const partialPayload = {
      ...payload,
      matchIds: ["match-1", "match-2"],
      matchRefs: [
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 7 }
      ],
      displayMatchIds: ["match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [oldRow, survivingRow]
      }
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      payload: partialPayload,
      status: "SENT",
      sentAt: now,
      attemptCount: 1
    });
    const friend = delivery("delivery-2", "friend@example.com", {
      payload: partialPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected",
      nextAttemptAt: new Date(now.getTime() - 1)
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        owner,
        { ...friend, status: "SUPPRESSED", nextAttemptAt: null }
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-2",
        courseId: "course-2",
        alertStatus: "SENT",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 7
      }
    ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-2",
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-2", outcome: "MATCH_FOUND", observedAt: now }
    ] as never);
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
    ).resolves.toEqual([
      { id: "delivery-1", status: "SENT" },
      { id: "delivery-2", status: "SUPPRESSED" }
    ]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "MATCH",
          recipient: "friend@example.com",
          isOwnerRecipient: false,
          payload: expect.objectContaining({
            recipientCatchup: true,
            matchIds: ["match-2"],
            displayMatchIds: ["match-2"]
          })
        })
      })
    );
    expect(mockedPrisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it("rekeys a definitively not-accepted recipient catch-up to its current subset", async () => {
    const firstRow = payload.matchReport.matches[0];
    const secondRow = {
      ...firstRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Second Course"
    };
    const catchupPayload = {
      ...payload,
      recipientCatchup: true,
      matchIds: ["match-1", "match-2"],
      matchRefs: [
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 8 }
      ],
      displayMatchIds: ["match-1", "match-2"],
      matchReport: { ...payload.matchReport, matches: [firstRow, secondRow] }
    };
    const friend = delivery("delivery-2", "friend@example.com", {
      isOwnerRecipient: false,
      payload: catchupPayload,
      status: "FAILED",
      nextAttemptAt: new Date(now.getTime() - 1),
      attemptCount: 1,
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected"
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([friend] as never)
      .mockResolvedValueOnce([{ ...friend, status: "SUPPRESSED" }] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-2",
        courseId: "course-2",
        alertStatus: "SENT",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 8
      }
    ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-2",
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-2", outcome: "MATCH_FOUND", observedAt: now }
    ] as never);

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "catchup-old",
      send: vi.fn(),
      now: () => now
    });

    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "friend@example.com",
          payload: expect.objectContaining({
            recipientCatchup: true,
            matchIds: ["match-2"]
          })
        })
      })
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["delivery-2"] } },
        data: expect.objectContaining({
          status: "SUPPRESSED",
          claimToken: null,
          claimExpiresAt: null
        })
      })
    );
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
      expect.objectContaining({
        where: expect.objectContaining({
          alertStatus: { in: ["PENDING", "SUPPRESSED"] }
        }),
        data: { alertStatus: "SENT", sentAt: now }
      })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany.mock.calls[0]?.[0].where).not.toHaveProperty(
      "availabilityStatus"
    );
  });

  it("does not record a match send timestamp for a dry-run owner outcome", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        status: "SUPPRESSED",
        sentAt: now,
        lastError: "DELIVERY_DRY_RUN"
      })
    ] as never);

    await finalizeSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      kind: "MATCH",
      groupKey: "match-group"
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ alertStatus: "PENDING" }),
        data: { alertStatus: "SUPPRESSED", sentAt: null }
      })
    );
  });

  it("keeps a seeded terminal owner nonblocking while an additional recipient retries", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        status: "SUPPRESSED",
        sentAt: now,
        lastError: "STATUS_RECIPIENT_PRIOR_REACHED"
      }),
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
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
  });

  it("finalizes an ownerless recipient catch-up without blocking on or mutating owner state", async () => {
    const catchupPayload = {
      ...payload,
      recipientCatchup: true,
      satisfiesStatusReport: false
    };
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("friend-catchup", "friend@example.com", {
        isOwnerRecipient: false,
        groupKey: "catchup-group",
        payload: catchupPayload,
        status: "SENT",
        sentAt: now
      })
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "catchup-group"
      })
    ).resolves.toEqual({
      finalized: true,
      status: "SENT",
      ownerSent: false,
      ownerDeliveryOutcome: null,
      retainedMatchCount: 0,
      sentMatchCount: 0
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
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
    ).resolves.toEqual({
      finalized: true,
      status: "SUPPRESSED",
      ownerSent: false,
      ownerDeliveryOutcome: "SAFETY_SUPPRESSED",
      retainedMatchCount: 0,
      sentMatchCount: 0
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
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
    ).resolves.toEqual({
      finalized: true,
      status: "SENT",
      ownerSent: true,
      ownerDeliveryOutcome: "SENT",
      retainedMatchCount: 1,
      sentMatchCount: 1
    });
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
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times?next=/hop-one?next=/hop-two?next=http://127.0.0.1/private"
      )
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times?redirect=https://provider.example/tee-times"
      )
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times#https://evil.example/login"
      )
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times?redirect=https:%5C%5Cevil.example%2Fpath"
      )
    ).toBeUndefined();
    for (const sessionUrl of [
      "https://course.example/tee-times?JSESSIONID=private",
      "https://course.example/tee-times?PHPSESSID=private",
      "https://course.example/tee-times?ASPSESSIONIDABC123=private",
      "https://course.example/tee-times?sid=private",
      "https://course.example/tee-times?CFID=private&CFTOKEN=private",
      "https://course.example/tee-times?osCsid=private",
      "https://course.example/tee-times?connect.sid=private"
    ]) {
      expect(getSafeOfficialBookingUrl(sessionUrl)).toBeUndefined();
    }
    expect(
      getSafeOfficialBookingUrl("https://user:password@course.example/tee-times")
    ).toBeUndefined();
    expect(getSafeOfficialBookingUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("lists each retryable persisted group once in creation order", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      { kind: "MATCH", groupKey: "group-1", createdAt: new Date(now.getTime() - 2_000), isOwnerRecipient: true },
      { kind: "MATCH", groupKey: "group-1", createdAt: new Date(now.getTime() - 2_000), isOwnerRecipient: false },
      { kind: "DAILY", groupKey: "group-2", createdAt: new Date(now.getTime() - 1_000), isOwnerRecipient: false }
    ] as never);

    await expect(
      listRetryableSearchEmailDeliveryGroups({ searchId: "search-1", alertGeneration: 3 })
    ).resolves.toEqual([
      { kind: "MATCH", groupKey: "group-1", createdAt: new Date(now.getTime() - 2_000), ownerRetryable: true },
      { kind: "DAILY", groupKey: "group-2", createdAt: new Date(now.getTime() - 1_000), ownerRetryable: false }
    ]);
  });

  it("coalesces every durable stale-status request into one newest-kind replacement", async () => {
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([
        {
          kind: "DAILY",
          groupKey: "status-group-2",
          createdAt: now
        },
        {
          kind: "DAILY",
          groupKey: "status-group-1",
          createdAt: new Date(now.getTime() - 60_000)
        },
        {
          kind: "SETUP",
          groupKey: "setup-group",
          createdAt: new Date(now.getTime() - 120_000)
        }
      ] as never)
      .mockResolvedValueOnce([
        { isOwnerRecipient: true, status: "SENT", sentAt: now },
        { isOwnerRecipient: false, status: "SUPPRESSED", sentAt: null },
        { isOwnerRecipient: true, status: "SUPPRESSED", sentAt: now },
        { isOwnerRecipient: false, status: "SUPPRESSED", sentAt: null }
      ] as never);

    await expect(
      getPendingStatusEmailReplacement({ searchId: "search-1", alertGeneration: 3 })
    ).resolves.toEqual({
      kind: "DAILY",
      groups: [
        { kind: "DAILY", groupKey: "status-group-2" },
        { kind: "DAILY", groupKey: "status-group-1" },
        { kind: "SETUP", groupKey: "setup-group" }
      ],
      anyRecipientReached: true,
      ownerSent: true
    });
  });
});
