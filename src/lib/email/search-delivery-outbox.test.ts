import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { applyPendingClerkEmailForSearch } from "@/lib/users/pending-email";
import { EmailDeliveryNotAcceptedError } from "./alerts";
import { DELIVERY_SYNTHETIC_MULTI_CYCLE_DRY_RUN } from "./delivery-policy";
import { renderSearchStatusHtml } from "./search-status";
import {
  assertSafeSearchEmailPayload,
  drainSearchEmailDeliveryGroup,
  finalizeSearchEmailDeliveryGroup,
  getPendingStatusEmailReplacement,
  getSafeOfficialBookingUrl,
  hydrateMatchAlertPayload,
  hydrateSearchStatusEmailPayload,
  isExpectedSearchEmailDeliveryControlFlow,
  listReachedMonitoringFinals,
  listReachedMonitoringOutages,
  listReachedMonitoringRecoveries,
  listRetryableSearchEmailDeliveryGroups,
  lockSearchForAlertMutation,
  lockSearchForEmailReconciliation,
  prepareRecipientMatchDeliveryGroups,
  prepareSearchEmailDeliveryGroup,
  reactivateTerminalUnresolvedMatchDeliveries,
  SearchEmailDeliveryDeferredError,
  SearchEmailDeliveryInProgressError,
  suppressSearchEmailDeliveriesForMatches,
} from "./search-delivery-outbox";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $executeRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    course: { findMany: vi.fn() },
    courseMonitoringStatus: { findMany: vi.fn() },
    courseProbe: { findMany: vi.fn() },
    localReaderJob: { findMany: vi.fn() },
    searchEmailDelivery: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    teeSearch: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    teeTimeMatch: {
      count: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/users/pending-email", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/users/pending-email")
  >("@/lib/users/pending-email");
  return {
    ...actual,
    applyPendingClerkEmailForSearch: vi.fn(),
  };
});

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedApplyPendingClerkEmailForSearch = vi.mocked(
  applyPendingClerkEmailForSearch,
);
const now = new Date("2026-07-15T15:00:00.000Z");
const currentSearch = {
  id: "search-1",
  userId: "user-1",
  status: "ACTIVE",
  syntheticMultiCycle: false,
  alertGeneration: 3,
  checkLeaseToken: "check-lease",
  checkLeaseExpiresAt: new Date("2026-07-15T15:15:00.000Z"),
  ownerEmail: "owner@example.com",
  ownerPendingEmail: null,
  additionalEmails: ["friend@example.com"],
};
const payload = {
  schemaVersion: 2 as const,
  checkedAt: now.toISOString(),
  matchIds: ["match-1"],
  matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
  displayMatchIds: ["match-1"],
  satisfiesStatusReport: true,
  statusSnapshot: [
    { courseId: "course-1", courseName: "Course", state: "MATCH_FOUND:1" },
  ],
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
        factLine: "Public · 4.1 rating · 1.3 mi · 18H · $65",
        courseGuideUrl: "/courses/course",
        isNew: true,
      },
    ],
  },
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
  intelligenceConfidence: null,
};

const currentMatch = {
  id: "match-1",
  courseId: "course-1",
  alertStatus: "PENDING",
  availabilityStatus: "AVAILABLE",
  availabilityCycle: 7,
  lastConfirmedAt: now,
  startsAt: new Date("2026-07-16T12:00:00.000Z"),
  availableSpots: 4,
  bookingUrl: "https://example.com/tee-times?date=2026-07-16",
  priceCents: 6500,
  holes: 18,
};

function delivery(
  id: string,
  recipient: string,
  overrides: Record<string, unknown> = {},
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
    ...overrides,
  };
}

function executeRawCallsContaining(fragment: string) {
  return mockedPrisma.$executeRaw.mock.calls.filter(([sql]) =>
    (sql as unknown as { strings: string[] }).strings
      .join(" ")
      .includes(fragment),
  );
}

function rawSqlText(sql: unknown) {
  return (sql as { strings?: string[] }).strings?.join(" ") ?? "";
}

function mockQueryRawForSearch(search: Record<string, unknown>) {
  mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
    const text = rawSqlText(sql);
    if (text.includes('FROM "ProviderRequestLease"')) {
      return [] as never;
    }
    if (text.includes('statement_timestamp() AS "currentTime"')) {
      return [{ currentTime: now }] as never;
    }
    return [search] as never;
  });
}

describe("search email delivery outbox", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma),
    );
    mockQueryRawForSearch(currentSearch);
    mockedPrisma.$queryRawUnsafe.mockResolvedValue([{ locked: true }] as never);
    mockedPrisma.$executeRaw.mockResolvedValue(1 as never);
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "owner@example.com",
      pendingEmail: null,
    } as never);
    mockedApplyPendingClerkEmailForSearch.mockResolvedValue({
      outcome: "none",
    });
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue(null);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.course.findMany.mockResolvedValue([currentCourse] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: now,
        lastFailureAt: null,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        outcome: "MATCH_FOUND",
        observedAt: now,
      },
    ] as never);
    mockedPrisma.localReaderJob.findMany.mockResolvedValue([] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      currentMatch,
    ] as never);
    mockedPrisma.teeTimeMatch.count.mockResolvedValue(1);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.teeSearch.findFirst.mockResolvedValue({
      additionalEmails: ["friend@example.com"],
      user: { email: "owner@example.com" },
    } as never);
    mockedPrisma.teeSearch.update.mockResolvedValue({
      id: "search-1",
    } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it("recognizes only typed durable delivery control flow", () => {
    expect(
      isExpectedSearchEmailDeliveryControlFlow(
        new SearchEmailDeliveryDeferredError(now),
      ),
    ).toBe(true);
    expect(
      isExpectedSearchEmailDeliveryControlFlow(
        new SearchEmailDeliveryInProgressError(now),
      ),
    ).toBe(true);
    expect(isExpectedSearchEmailDeliveryControlFlow(new Error("failed"))).toBe(
      false,
    );
    expect(isExpectedSearchEmailDeliveryControlFlow({ retryable: true })).toBe(
      false,
    );
  });

  it("reactivates only exact current-generation recipients suppressed by an unresolved provider source", async () => {
    const t2 = new Date("2026-07-15T15:02:00.000Z");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-owner",
        alertGeneration: 3,
        kind: "MATCH",
        payload,
        status: "SUPPRESSED",
        sentAt: t2,
        lastError: "DELIVERY_PROVIDER_SOURCE_UNRESOLVED",
      },
      {
        id: "delivery-friend",
        alertGeneration: 3,
        kind: "MATCH",
        payload,
        status: "SENT",
        sentAt: t2,
        lastError: null,
      },
    ] as never);

    await expect(
      reactivateTerminalUnresolvedMatchDeliveries(prisma, {
        searchId: "search-1",
        alertGeneration: 3,
        matchId: "match-1",
        availabilityCycle: 7,
        retryAt: now,
      }),
    ).resolves.toEqual({ count: 1 });

    expect(mockedPrisma.searchEmailDelivery.findMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        status: "SUPPRESSED",
        lastError: "DELIVERY_PROVIDER_SOURCE_UNRESOLVED",
      },
      select: {
        id: true,
        alertGeneration: true,
        kind: true,
        status: true,
        lastError: true,
        payload: true,
      },
    });
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-owner"] },
        teeSearchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        status: "SUPPRESSED",
        lastError: "DELIVERY_PROVIDER_SOURCE_UNRESOLVED",
      },
      data: {
        status: "PENDING",
        claimToken: null,
        claimExpiresAt: null,
        sentAt: null,
        nextAttemptAt: null,
        lastError: null,
      },
    });
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("does not reactivate a terminal unresolved delivery for a different availability cycle", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-owner",
        alertGeneration: 3,
        kind: "MATCH",
        status: "SUPPRESSED",
        lastError: "DELIVERY_PROVIDER_SOURCE_UNRESOLVED",
        payload,
      },
    ] as never);

    await expect(
      reactivateTerminalUnresolvedMatchDeliveries(prisma, {
        searchId: "search-1",
        alertGeneration: 3,
        matchId: "match-1",
        availabilityCycle: 8,
        retryAt: now,
      }),
    ).resolves.toEqual({ count: 0 });
    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(0);
  });

  it("rejects nonterminal, current-fence, and other-generation rows as reactivation authority", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-pending-source",
        alertGeneration: 3,
        kind: "MATCH",
        status: "FAILED",
        lastError: "DELIVERY_PROVIDER_SOURCE_PENDING",
        payload,
      },
      {
        id: "delivery-old-generation",
        alertGeneration: 2,
        kind: "MATCH",
        status: "SUPPRESSED",
        lastError: "DELIVERY_PROVIDER_SOURCE_UNRESOLVED",
        payload,
      },
    ] as never);

    await expect(
      reactivateTerminalUnresolvedMatchDeliveries(prisma, {
        searchId: "search-1",
        alertGeneration: 3,
        matchId: "match-1",
        availabilityCycle: 7,
        retryAt: now,
      }),
    ).resolves.toEqual({ count: 0 });
    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("reads outage recipients without counting safety suppression as delivery", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      {
        recipient: "owner@example.com",
        sentAt: new Date("2026-07-15T15:01:00.000Z"),
        status: "SENT",
        lastError: null,
        payload: {
          schemaVersion: 2,
          checkedAt: "2026-07-15T15:00:00.000Z",
          statusSnapshot: [
            {
              courseId: "course-1",
              courseName: "Course",
              state: "NEEDS_ADAPTER:ACTIONABLE:IN_OPERATOR_QUEUE:NONE",
              customerStatus: "RETRYING_AUTOMATICALLY",
            },
            {
              courseId: "course-2",
              courseName: "Healthy",
              state: "NO_MATCH:DATE_NOT_VISIBLE",
              customerStatus: "MONITORED",
            },
          ],
        },
      },
      {
        recipient: "friend@example.com",
        sentAt: new Date("2026-07-15T15:02:00.000Z"),
        status: "SENT",
        lastError: null,
        payload: {
          schemaVersion: 2,
          checkedAt: "2026-07-15T15:00:00.000Z",
          statusReport: {
            kind: "status-update",
            courses: [{ courseId: "course-1" }],
          },
          statusSnapshot: [
            {
              courseId: "course-1",
              courseName: "Course",
              state: "NEEDS_ADAPTER:ACTIONABLE:NEEDS_HUMAN_REVIEW:NONE",
              customerStatus: "NEEDS_HUMAN_REVIEW",
            },
            {
              courseId: "course-not-in-update",
              courseName: "Unreported retry",
              state: "FETCH_FAILED:ACTIONABLE:IN_OPERATOR_QUEUE:NONE",
              customerStatus: "RETRYING_AUTOMATICALLY",
            },
          ],
        },
      },
      {
        recipient: "owner@example.com",
        sentAt: new Date("2026-07-15T15:03:00.000Z"),
        status: "SUPPRESSED",
        lastError: "DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED",
        payload: {
          schemaVersion: 2,
          checkedAt: "2026-07-15T15:00:00.000Z",
          statusReport: {
            kind: "status-update",
            courses: [{ courseId: "course-suppressed" }],
          },
          statusSnapshot: [
            {
              courseId: "course-suppressed",
              courseName: "Suppressed",
              state: "NEEDS_ADAPTER:ACTIONABLE:NEEDS_HUMAN_REVIEW:NONE",
              customerStatus: "NEEDS_HUMAN_REVIEW",
            },
          ],
        },
      },
    ] as never);

    await expect(
      listReachedMonitoringOutages({
        searchId: "search-1",
        alertGeneration: 3,
      }),
    ).resolves.toEqual([
      {
        courseId: "course-1",
        recipient: "owner@example.com",
        sentAt: new Date("2026-07-15T15:01:00.000Z"),
        customerStatus: "RETRYING_AUTOMATICALLY",
      },
      {
        courseId: "course-1",
        recipient: "friend@example.com",
        sentAt: new Date("2026-07-15T15:02:00.000Z"),
        customerStatus: "NEEDS_HUMAN_REVIEW",
      },
    ]);
    expect(mockedPrisma.searchEmailDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: {
            in: [
              "SETUP",
              "DAILY",
              "MONITORING_STATUS_UPDATE",
              "MONITORING_OUTAGE",
            ],
          },
        }),
      }),
    );
  });

  it("deduplicates recovery from visible accepted courses, not unrelated snapshots or suppressed sends", async () => {
    const sentAt = new Date("2026-07-15T15:00:00Z");
    const payload = { schemaVersion: 2, checkedAt: sentAt.toISOString(),
      statusReport: { courses: [
        { courseId: "recovered", outcome: "NO_MATCH", availableMatches: 0 },
        { courseId: "pending", outcome: "CHECK_PENDING", availableMatches: 0 },
      ] },
      statusSnapshot: [{ courseId: "not-in-email", customerStatus: "MONITORED" }],
    };
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      { recipient: "owner@example.com", sentAt, status: "SENT", lastError: null, payload },
      { recipient: "suppressed@example.com", sentAt, status: "SUPPRESSED", lastError: "DELIVERY_PROVIDER_SOURCE_UNRESOLVED", payload },
      { recipient: "match@example.com", sentAt, status: "SENT", lastError: null,
        payload: { schemaVersion: 2, checkedAt: sentAt.toISOString(), matchReport: { matches: [{ courseId: "matched" }] } } },
    ] as never);
    await expect(listReachedMonitoringRecoveries({ searchId: "search-1", alertGeneration: 3 })).resolves.toEqual([
      { courseId: "recovered", recipient: "owner@example.com", sentAt },
      { courseId: "matched", recipient: "match@example.com", sentAt },
    ]);
    expect(mockedPrisma.searchEmailDelivery.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ teeSearchId: "search-1", alertGeneration: 3 }),
    }));
  });

  it("reads reached factual-final status deliveries for course-level dedupe", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      {
        recipient: "owner@example.com",
        sentAt: new Date("2026-07-15T15:01:00.000Z"),
        status: "SENT",
        lastError: null,
        payload: {
          schemaVersion: 2,
          checkedAt: "2026-07-15T15:00:00.000Z",
          statusReport: {
            kind: "status-update",
            courses: [{ courseId: "course-final" }],
          },
          statusSnapshot: [
            {
              courseId: "course-final",
              courseName: "Final Course",
              state:
                "MANUAL_DIRECT:MANUAL_FINAL:NO_SUPPORT_STATUS:NONE:PHONE_ONLY:PHONE_ONLY",
              customerStatus: "FINAL_DIRECT_ACTION",
            },
            {
              courseId: "course-not-in-report",
              courseName: "Other Final",
              state:
                "IDENTITY_FINAL:IDENTITY_FINAL:NO_SUPPORT_STATUS:NONE:UNKNOWN:UNKNOWN",
              customerStatus: "FINAL_DIRECT_ACTION",
            },
          ],
        },
      },
      {
        recipient: "friend@example.com",
        sentAt: new Date("2026-07-15T15:02:00.000Z"),
        status: "SENT",
        lastError: null,
        payload: {
          schemaVersion: 2,
          checkedAt: "2026-07-15T15:00:00.000Z",
          statusReport: {
            kind: "setup",
            courses: [{ courseId: "course-legacy-final" }],
          },
          statusSnapshot: [
            {
              courseId: "course-legacy-final",
              courseName: "Legacy Final",
              state:
                "BLOCKED_AUTH:TECHNICAL_FINAL:NO_SUPPORT_STATUS:ACCOUNT_REQUIRED:ACCOUNT_REQUIRED:PUBLIC_ONLINE",
            },
          ],
        },
      },
      {
        recipient: "suppressed@example.com",
        sentAt: new Date("2026-07-15T15:03:00.000Z"),
        status: "SUPPRESSED",
        lastError: "DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED",
        payload: {
          schemaVersion: 2,
          checkedAt: "2026-07-15T15:00:00.000Z",
          statusReport: {
            kind: "status-update",
            courses: [{ courseId: "course-suppressed" }],
          },
          statusSnapshot: [
            {
              courseId: "course-suppressed",
              courseName: "Suppressed Final",
              state:
                "MANUAL_DIRECT:MANUAL_FINAL:NO_SUPPORT_STATUS:NONE:PHONE_ONLY:PHONE_ONLY",
              customerStatus: "FINAL_DIRECT_ACTION",
            },
          ],
        },
      },
    ] as never);

    await expect(
      listReachedMonitoringFinals({
        searchId: "search-1",
        alertGeneration: 3,
      }),
    ).resolves.toEqual([
      {
        courseId: "course-final",
        recipient: "owner@example.com",
        sentAt: new Date("2026-07-15T15:01:00.000Z"),
      },
      {
        courseId: "course-legacy-final",
        recipient: "friend@example.com",
        sentAt: new Date("2026-07-15T15:02:00.000Z"),
      },
    ]);
    expect(mockedPrisma.searchEmailDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: {
            in: ["SETUP", "DAILY", "MONITORING_STATUS_UPDATE"],
          },
        }),
      }),
    );
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
        now,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ownerEmail: "new-owner@example.com",
        ownerPendingEmail: null,
      }),
    );

    expect(callOrder).toEqual(["lock-search", "read-owner"]);
    const lockSql = mockedPrisma.$queryRaw.mock.calls[0][0] as unknown as {
      strings: string[];
    };
    expect(lockSql.strings.join(" ")).not.toContain('JOIN "User"');
    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { email: true, pendingEmail: true },
    });
  });

  it("allows bounded delivery reconciliation to exceed Prisma's default transaction timeout", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([]);

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send: vi.fn(),
        now: () => now,
      }),
    ).resolves.toEqual([]);

    expect(mockedPrisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 15_000 },
    );
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
        now,
      }),
    ).resolves.toEqual(expect.objectContaining({ prepared: true }));
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "owner@example.com",
          isOwnerRecipient: true,
          payload,
        }),
      }),
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "friend@example.com",
          isOwnerRecipient: false,
          payload,
        }),
      }),
    );
  });

  it("seeds already-reached status recipients as permanently terminal in a current replacement", async () => {
    const sentAt = new Date(now.getTime() - 30_000);
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: [],
      displayMatchIds: [],
      statusReport: { kind: "daily" },
    };
    const oldOwner = delivery("old-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "old-status",
      payload: statusPayload,
      status: "SENT",
      sentAt,
    });
    const oldFriend = delivery("old-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "old-status",
      payload: statusPayload,
      status: "SUPPRESSED",
      attemptCount: 1,
      lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING",
    });
    const newOwner = delivery("new-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload,
      status: "SUPPRESSED",
      sentAt,
    });
    const newFriend = delivery("new-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload,
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
      now,
    });

    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "owner@example.com",
          status: "SUPPRESSED",
          sentAt,
          lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
        }),
      }),
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "friend@example.com",
        }),
      }),
    );
    expect(
      mockedPrisma.searchEmailDelivery.create.mock.calls[1]?.[0]?.data,
    ).not.toHaveProperty("status");
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING",
        }),
        data: { lastError: "STATUS_CONTENT_STALE_REPLACED" },
      }),
    );
  });

  it("does not resend current status to recipients who reached any coalesced status", async () => {
    const sentAt = new Date(now.getTime() - 30_000);
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: [],
      displayMatchIds: [],
      statusReport: { kind: "daily" },
    };
    const setupOwner = delivery("setup-owner", "owner@example.com", {
      kind: "SETUP",
      groupKey: "old-setup",
      payload: statusPayload,
      status: "SENT",
      sentAt,
    });
    const setupFriend = delivery("setup-friend", "friend@example.com", {
      kind: "SETUP",
      groupKey: "old-setup",
      payload: statusPayload,
      status: "FAILED",
      attemptCount: 1,
    });
    const dailyOwner = delivery("daily-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "old-daily",
      payload: statusPayload,
      status: "FAILED",
      attemptCount: 1,
    });
    const dailyFriend = delivery("daily-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "old-daily",
      payload: statusPayload,
      status: "SENT",
      sentAt,
    });
    const newOwner = delivery("new-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload,
    });
    const newFriend = delivery("new-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        setupOwner,
        setupFriend,
        dailyOwner,
        dailyFriend,
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
        { kind: "DAILY", groupKey: "old-daily" },
      ],
      now,
    });

    expect(mockedPrisma.$transaction.mock.calls.at(-1)?.[1]).toEqual({
      timeout: 15_000,
    });

    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledTimes(2);
    for (const call of mockedPrisma.searchEmailDelivery.create.mock.calls) {
      expect(call[0].data).toEqual(
        expect.objectContaining({
          status: "SUPPRESSED",
          sentAt,
          lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
        }),
      );
    }
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        alertGeneration: 3,
        lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING",
        OR: [
          { kind: "SETUP", groupKey: "old-setup" },
          { kind: "DAILY", groupKey: "old-daily" },
        ],
      },
      data: { lastError: "STATUS_CONTENT_STALE_REPLACED" },
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
      statusReport: { kind: "daily" },
    };
    const currentStatusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: ["match-2"],
      matchRefs: [{ matchId: "match-2", availabilityCycle: 5 }],
      displayMatchIds: ["match-2"],
      statusSnapshot: [
        {
          courseId: "course-2",
          courseName: "Second Course",
          state: "MATCH_FOUND:1",
        },
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
                holes: 18,
              },
            ],
          },
        ],
      },
    };
    const oldOwner = delivery("old-owner", "owner@example.com", {
      kind: "DAILY",
      groupKey: "old-status",
      payload: oldStatusPayload,
      status: "SENT",
      attemptCount: 1,
      sentAt,
    });
    const oldFriend = delivery("old-friend", "friend@example.com", {
      kind: "DAILY",
      groupKey: "old-status",
      payload: oldStatusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
    });
    const replacementOwner = delivery(
      "replacement-owner",
      "owner@example.com",
      {
        kind: "DAILY",
        groupKey: "replacement-status",
        payload: currentStatusPayload,
        status: "SUPPRESSED",
        sentAt,
        lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
      },
    );
    const replacementFriend = delivery(
      "replacement-friend",
      "friend@example.com",
      {
        kind: "DAILY",
        groupKey: "replacement-status",
        payload: currentStatusPayload,
        status: "SUPPRESSED",
        lastError: "STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT",
      },
    );
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
        now,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        prepared: true,
        continuationGroups: [
          { groupKey: expect.stringMatching(/^catchup-/) },
          { groupKey: expect.stringMatching(/^catchup-/) },
        ],
      }),
    );

    const createdRows = mockedPrisma.searchEmailDelivery.create.mock.calls.map(
      ([call]) => call.data,
    );
    expect(createdRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "DAILY",
          recipient: "owner@example.com",
          status: "SUPPRESSED",
          lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
        }),
        expect.objectContaining({
          kind: "DAILY",
          recipient: "friend@example.com",
          status: "SUPPRESSED",
          lastError: "STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT",
        }),
        expect.objectContaining({
          kind: "MATCH",
          recipient: "owner@example.com",
          isOwnerRecipient: true,
          payload: expect.objectContaining({
            matchIds: ["match-2"],
            matchRefs: [{ matchId: "match-2", availabilityCycle: 5 }],
          }),
        }),
        expect.objectContaining({
          kind: "MATCH",
          recipient: "friend@example.com",
          isOwnerRecipient: false,
          payload: expect.objectContaining({
            matchIds: ["match-2"],
            matchRefs: [{ matchId: "match-2", availabilityCycle: 5 }],
          }),
        }),
      ]),
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
      statusReport: { kind: "daily" },
    };
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("replacement-owner", "owner@example.com", {
        kind: "DAILY",
        groupKey: "replacement-status",
        payload: currentStatusPayload,
        status: "SUPPRESSED",
        sentAt: new Date(now.getTime() - 30_000),
        lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
      }),
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "DAILY",
        groupKey: "replacement-status",
      }),
    ).resolves.toEqual({
      finalized: true,
      status: "SUPPRESSED",
      ownerSent: false,
      ownerDeliveryOutcome: "PRIOR_REACHED",
      retainedMatchCount: 0,
      sentMatchCount: 0,
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 15_000 },
    );
  });

  it("rewrites one unattempted group atomically before its first send", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const friend = delivery("delivery-2", "friend@example.com");
    const refreshedPayload = {
      ...payload,
      checkedAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        { ...owner, payload: refreshedPayload },
        { ...friend, payload: refreshedPayload },
      ] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({
      count: 2,
    } as never);

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
        now,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        prepared: true,
        deliveries: expect.arrayContaining([
          expect.objectContaining({ payload: refreshedPayload }),
        ]),
      }),
    );

    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-1", "delivery-2"] },
        attemptCount: 0,
        status: { notIn: ["SENDING", "SENT"] },
      },
      data: { payload: refreshedPayload },
    });
    expect(mockedPrisma.searchEmailDelivery.create).not.toHaveBeenCalled();
  });

  it("reactivates only pre-send suppressed recipients for the same immutable group", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "SUPPRESSED",
      sentAt: null,
    });
    const friend = delivery("delivery-2", "friend@example.com", {
      status: "SENT",
      sentAt: now,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "PENDING" },
        friend,
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
          checkedAt: new Date(now.getTime() + 60_000).toISOString(),
        },
        now,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        prepared: true,
        deliveries: expect.arrayContaining([
          expect.objectContaining({
            id: "delivery-1",
            status: "PENDING",
            payload,
          }),
          expect.objectContaining({
            id: "delivery-2",
            status: "SENT",
            payload,
          }),
        ]),
      }),
    );

    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-1"] },
        status: "SUPPRESSED",
        sentAt: null,
        attemptCount: 0,
      },
      data: {
        status: "PENDING",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: null,
      },
    });
    expect(mockedPrisma.searchEmailDelivery.create).not.toHaveBeenCalled();
  });

  it("never reactivates a suppressed recipient after a send was attempted", async () => {
    const attempted = delivery("delivery-1", "owner@example.com", {
      status: "SUPPRESSED",
      attemptCount: 1,
      sentAt: null,
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
        now,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        prepared: true,
        deliveries: [
          expect.objectContaining({ status: "SUPPRESSED", attemptCount: 1 }),
        ],
      }),
    );

    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("deduplicates match obligations independently by recipient and exact cycle", async () => {
    const ownerCycleSeven = delivery("old-owner", "owner@example.com", {
      groupKey: "old-owner-group",
    });
    const friendCycleEight = delivery("old-friend", "friend@example.com", {
      groupKey: "old-friend-group",
      isOwnerRecipient: false,
      payload: {
        ...payload,
        matchRefs: [{ matchId: "match-1", availabilityCycle: 8 }],
      },
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      ownerCycleSeven,
      friendCycleEight,
    ] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("new-friend", "friend@example.com", {
        isOwnerRecipient: false,
        groupKey: "catchup-new",
      }) as never,
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
        now,
      }),
    ).resolves.toEqual({
      prepared: true,
      groups: [
        {
          groupKey: expect.stringMatching(/^catchup-/),
          recipient: "friend@example.com",
        },
      ],
      hasExistingObligation: true,
    });

    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledOnce();
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "friend@example.com",
          isOwnerRecipient: false,
          payload: expect.objectContaining({
            matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
          }),
        }),
      }),
    );
    expect(mockedPrisma.$transaction.mock.calls.at(-1)?.[1]).toEqual({
      timeout: 15_000,
    });
  });

  it("rejects a changed recipient set for an existing group", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
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
        payload,
        now,
      }),
    ).rejects.toThrow("recipients are immutable");
  });

  it("does not prepare rows after the search generation changes", async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([
      { ...currentSearch, alertGeneration: 4 },
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
        now,
      }),
    ).resolves.toEqual({
      prepared: false,
      reason: "stale_search",
      deliveries: [],
    });
  });

  it("claims every retryable recipient atomically under one token before sending", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const friend = delivery("delivery-2", "friend@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
      friend,
    ] as never);
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
        now: () => now,
      }),
    ).resolves.toHaveLength(2);
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: { in: ["delivery-1", "delivery-2"] } },
        data: expect.objectContaining({
          status: "SENDING",
          claimToken: expect.any(String),
          attemptCount: { increment: 1 },
        }),
      }),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        idempotencyKey: expect.stringMatching(/^tee-search-delivery-/),
      }),
    );
    const settlementTokens =
      mockedPrisma.searchEmailDelivery.updateMany.mock.calls
        .slice(1)
        .map(([call]) => call.where?.claimToken);
    expect(new Set(settlementTokens).size).toBe(1);
    expect(mockedApplyPendingClerkEmailForSearch).toHaveBeenCalledTimes(2);
  });

  it("durably dry-runs every synthetic multi-cycle recipient before the sender boundary", async () => {
    const owner = delivery("delivery-1", "golfer@real-domain.com", {
      isOwnerRecipient: true,
    });
    const friend = delivery("delivery-2", "friend@another-domain.com", {
      isOwnerRecipient: false,
    });
    mockQueryRawForSearch({
      ...currentSearch,
      alertEmail: "golfer@real-domain.com",
      additionalEmails: ["friend@another-domain.com"],
      syntheticMultiCycle: true,
    });
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "golfer@real-domain.com",
      pendingEmail: null,
    } as never);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
      friend,
    ] as never);
    mockedPrisma.searchEmailDelivery.updateMany
      .mockResolvedValueOnce({ count: 2 } as never)
      .mockResolvedValue({ count: 1 } as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" as const });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => now,
      }),
    ).resolves.toEqual([
      { id: "delivery-1", status: "SUPPRESSED" },
      { id: "delivery-2", status: "SUPPRESSED" },
    ]);

    expect(send).not.toHaveBeenCalled();
    const settlementWrites =
      mockedPrisma.searchEmailDelivery.updateMany.mock.calls.slice(1);
    expect(settlementWrites).toHaveLength(2);
    for (const [write] of settlementWrites) {
      expect(write).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "SUPPRESSED",
            sentAt: now,
            lastError: DELIVERY_SYNTHETIC_MULTI_CYCLE_DRY_RUN,
          }),
        }),
      );
      expect(write.data?.status).not.toBe("SENT");
    }
  });

  it("suppresses a claimed match group when a newer course failure supersedes its provider source", async () => {
    const providerObservedAt = new Date(now.getTime() - 60_000);
    const failureObservedAt = new Date(now.getTime() - 30_000);
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: providerObservedAt },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: providerObservedAt,
        lastFailureAt: failureObservedAt,
      },
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUPPRESSED",
          nextAttemptAt: null,
          lastError: "MATCH_PROVIDER_SOURCE_SUPERSEDED",
        }),
      }),
    );
    expect(mockedPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      "course-monitoring:course-1",
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(0);
  });

  it("sends a match only after exact current provider source proof under the course lock", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
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
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledOnce();
    expect(mockedPrisma.courseMonitoringStatus.findMany).toHaveBeenCalledWith({
      where: { courseId: { in: ["course-1"] } },
      select: {
        courseId: true,
        state: true,
        lastSuccessfulAt: true,
        lastFailureAt: true,
      },
    });
    expect(mockedPrisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it("suppresses a claimed match after a course-wide final classification", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "FINAL_IDENTITY",
        lastSuccessfulAt: now,
        lastFailureAt: null,
      },
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUPPRESSED",
          nextAttemptAt: null,
          lastError: "MATCH_PROVIDER_SOURCE_SUPERSEDED",
        }),
      }),
    );
  });

  const setupStatusPayload = {
    schemaVersion: 2 as const,
    checkedAt: now.toISOString(),
    displayMatchIds: [],
    statusSnapshot: [{ courseId: "course-1", state: "NO_MATCH" }],
    statusReport: {
      kind: "setup",
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
          availableMatches: 0,
        },
      ],
    },
  };

  function useCurrentSetupEvidence() {
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "NO_MATCH", observedAt: now },
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([]);
  }

  it("does not send a second setup to a recipient already reached by another group", async () => {
    useCurrentSetupEvidence();
    const sentAt = new Date(now.getTime() - 60_000);
    const older = delivery("older-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-older",
      payload: setupStatusPayload,
      status: "SENT",
      attemptCount: 1,
      sentAt,
      createdAt: new Date(now.getTime() - 120_000),
    });
    const newer = delivery("newer-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-newer",
      payload: setupStatusPayload,
      createdAt: new Date(now.getTime() - 60_000),
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([newer] as never)
      .mockResolvedValueOnce([older, newer] as never)
      .mockResolvedValueOnce([
        {
          ...newer,
          status: "SUPPRESSED",
          sentAt,
          lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
        },
      ] as never);
    const send = vi.fn();

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "SETUP",
        groupKey: "setup-newer",
        send,
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "newer-setup", status: "SUPPRESSED" }]);
    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "newer-setup" }),
        data: expect.objectContaining({
          status: "SUPPRESSED",
          sentAt,
          lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
        }),
      }),
    );
  });

  it("rekeys a setup after an ambiguous attempt is later confirmed not accepted", async () => {
    useCurrentSetupEvidence();
    mockQueryRawForSearch({ ...currentSearch, additionalEmails: [] });
    const older = delivery("older-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-older",
      payload: setupStatusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
      nextAttemptAt: new Date(now.getTime() - 1),
      createdAt: new Date(now.getTime() - 120_000),
    });
    const newer = delivery("newer-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-newer",
      payload: setupStatusPayload,
      createdAt: new Date(now.getTime() - 60_000),
    });
    const blockedNewer = {
      ...newer,
      status: "SUPPRESSED",
      lastError: "STATUS_SETUP_OTHER_ATTEMPT",
    };
    const rejectedOlder = {
      ...older,
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected",
    };
    const rekeyedOlder = {
      ...rejectedOlder,
      status: "SUPPRESSED",
      lastError: "STATUS_SETUP_REKEYED",
      nextAttemptAt: null,
    };
    const sentNewer = { ...newer, status: "SENT", sentAt: now };
    mockedPrisma.searchEmailDelivery.findMany
      // The newer key must wait while the older provider outcome is unknown.
      .mockResolvedValueOnce([newer] as never)
      .mockResolvedValueOnce([older, newer] as never)
      .mockResolvedValueOnce([blockedNewer] as never)
      // Retry visits the older key before preparing the newer one.
      .mockResolvedValueOnce([rejectedOlder] as never)
      .mockResolvedValueOnce([rejectedOlder, blockedNewer] as never)
      .mockResolvedValueOnce([rekeyedOlder] as never)
      // Preparing the same newer key reactivates it after confirmed rejection.
      .mockResolvedValueOnce([blockedNewer] as never)
      .mockResolvedValueOnce([newer] as never)
      // Only the newer key may reach transport.
      .mockResolvedValueOnce([newer] as never)
      .mockResolvedValueOnce([rekeyedOlder, newer] as never)
      .mockResolvedValueOnce([sentNewer] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "SETUP",
      groupKey: "setup-newer",
      send,
      now: () => now,
    });
    expect(send).not.toHaveBeenCalled();
    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "SETUP",
      groupKey: "setup-older",
      send,
      now: () => now,
    });
    expect(send).not.toHaveBeenCalled();
    await expect(
      prepareSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "SETUP",
        groupKey: "setup-newer",
        recipients: ["owner@example.com"],
        ownerRecipient: "owner@example.com",
        payload: setupStatusPayload,
        now,
      }),
    ).resolves.toEqual(expect.objectContaining({ prepared: true }));
    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "SETUP",
      groupKey: "setup-newer",
      send,
      now: () => now,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload: setupStatusPayload }),
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "older-setup" }),
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "STATUS_SETUP_REKEYED",
        }),
      }),
    );
  });

  it("retries only the original setup key while its provider outcome is ambiguous", async () => {
    useCurrentSetupEvidence();
    const older = delivery("older-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-older",
      payload: setupStatusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
      nextAttemptAt: new Date(now.getTime() - 1),
      createdAt: new Date(now.getTime() - 120_000),
    });
    const newer = delivery("newer-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-newer",
      payload: setupStatusPayload,
      createdAt: new Date(now.getTime() - 60_000),
    });
    const blockedNewer = {
      ...newer,
      status: "SUPPRESSED",
      lastError: "STATUS_SETUP_OTHER_ATTEMPT",
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([newer] as never)
      .mockResolvedValueOnce([older, newer] as never)
      .mockResolvedValueOnce([blockedNewer] as never)
      .mockResolvedValueOnce([older] as never)
      .mockResolvedValueOnce([older, blockedNewer] as never)
      .mockResolvedValueOnce([{ ...older, status: "SENT", sentAt: now }] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "SETUP",
      groupKey: "setup-newer",
      send,
      now: () => now,
    });
    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "SETUP",
      groupKey: "setup-older",
      send,
      now: () => now,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload: setupStatusPayload }),
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "newer-setup" }),
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "STATUS_SETUP_OTHER_ATTEMPT",
        }),
      }),
    );
  });

  it("fails closed when two setup keys have uncertain provider outcomes", async () => {
    useCurrentSetupEvidence();
    const older = delivery("older-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-older",
      payload: setupStatusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
      createdAt: new Date(now.getTime() - 120_000),
    });
    const newer = delivery("newer-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-newer",
      payload: setupStatusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
      createdAt: new Date(now.getTime() - 60_000),
    });
    const blockedOlder = {
      ...older,
      status: "SUPPRESSED",
      lastError: "STATUS_SETUP_MULTIPLE_ATTEMPTS",
    };
    const blockedNewer = {
      ...newer,
      status: "SUPPRESSED",
      lastError: "STATUS_SETUP_MULTIPLE_ATTEMPTS",
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([older] as never)
      .mockResolvedValueOnce([older, newer] as never)
      .mockResolvedValueOnce([blockedOlder] as never)
      .mockResolvedValueOnce([newer] as never)
      .mockResolvedValueOnce([blockedOlder, newer] as never)
      .mockResolvedValueOnce([blockedNewer] as never);
    const send = vi.fn();

    for (const groupKey of ["setup-older", "setup-newer"]) {
      await drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "SETUP",
        groupKey,
        send,
        now: () => now,
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: "STATUS_SETUP_MULTIPLE_ATTEMPTS",
        }),
      }),
    );
  });

  it("arbitrates setup recipients independently across groups", async () => {
    useCurrentSetupEvidence();
    const sentAt = new Date(now.getTime() - 90_000);
    const olderOwner = delivery("older-owner", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-older",
      payload: setupStatusPayload,
      status: "SENT",
      attemptCount: 1,
      sentAt,
      createdAt: new Date(now.getTime() - 120_000),
    });
    const olderFriend = delivery("older-friend", "friend@example.com", {
      kind: "SETUP",
      groupKey: "setup-older",
      payload: setupStatusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected",
      createdAt: new Date(now.getTime() - 120_000),
    });
    const newerOwner = delivery("newer-owner", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-newer",
      payload: setupStatusPayload,
      createdAt: new Date(now.getTime() - 60_000),
    });
    const newerFriend = delivery("newer-friend", "friend@example.com", {
      kind: "SETUP",
      groupKey: "setup-newer",
      payload: setupStatusPayload,
      createdAt: new Date(now.getTime() - 60_000),
    });
    const blockedOwner = {
      ...newerOwner,
      status: "SUPPRESSED",
      sentAt,
      lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([newerOwner, newerFriend] as never)
      .mockResolvedValueOnce([
        olderOwner, olderFriend, newerOwner, newerFriend,
      ] as never)
      .mockResolvedValueOnce([blockedOwner, newerFriend] as never)
      .mockResolvedValueOnce([
        blockedOwner, { ...newerFriend, status: "SENT", sentAt: now },
      ] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "SETUP",
      groupKey: "setup-newer",
      send,
      now: () => now,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "friend@example.com" }),
    );
  });

  it.each([
    { marker: "STATUS_SETUP_REKEYED", attemptCount: 1 },
    { marker: "STATUS_SETUP_OTHER_ATTEMPT", attemptCount: 0 },
  ])("does not mistake a $marker setup sentinel for an ambiguous provider attempt", async ({ marker, attemptCount }) => {
    mockQueryRawForSearch({ ...currentSearch, additionalEmails: [] });
    const retired = delivery("older-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-older",
      payload: setupStatusPayload,
      status: "SUPPRESSED",
      attemptCount,
      lastError: marker,
      createdAt: new Date(now.getTime() - 120_000),
    });
    const replacement = delivery("replacement-setup", "owner@example.com", {
      kind: "SETUP",
      groupKey: "setup-replacement",
      payload: setupStatusPayload,
      createdAt: new Date(now.getTime() - 60_000),
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([retired] as never)
      .mockResolvedValueOnce([replacement] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(replacement as never);

    await expect(
      prepareSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "SETUP",
        groupKey: "setup-replacement",
        recipients: ["owner@example.com"],
        ownerRecipient: "owner@example.com",
        payload: setupStatusPayload,
        supersededStatusGroups: [
          { kind: "SETUP", groupKey: "setup-older" },
        ],
        now,
      }),
    ).resolves.toEqual(expect.objectContaining({ prepared: true }));
    expect(
      mockedPrisma.searchEmailDelivery.create.mock.calls[0][0].data.status,
    ).toBeUndefined();
  });

  it.each([
    {
      finalState: "FINAL_MANUAL",
      markerState: "ACTIVE",
      leaseExpiresAt: new Date(now.getTime() + 2 * 60_000),
      retryUntil: new Date(now.getTime() + 12 * 60_000),
    },
    {
      finalState: "FINAL_TECHNICAL",
      markerState: "EXPIRED_TERMINAL",
      leaseExpiresAt: new Date(now.getTime() - 11 * 60_000),
      retryUntil: new Date(now.getTime() - 60_000),
    },
  ] as const)(
    "terminally suppresses an available match in $finalState despite a $markerState legacy provider marker",
    async ({ finalState, markerState, leaseExpiresAt, retryUntil }) => {
      const owner = delivery("delivery-1", "owner@example.com");
      mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
        owner,
      ] as never);
      mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
        {
          courseId: "course-1",
          state: finalState,
          lastSuccessfulAt: now,
          lastFailureAt: null,
        },
      ] as never);
      mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
        const text = rawSqlText(sql);
        if (text.includes('FROM "ProviderRequestLease"')) {
          return [
            {
              observationStartedAt: now,
              leaseExpiresAt,
              retryUntil,
              state: markerState,
            },
          ] as never;
        }
        if (text.includes('statement_timestamp() AS "currentTime"')) {
          return [{ currentTime: now }] as never;
        }
        return [currentSearch] as never;
      });
      const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

      await expect(
        drainSearchEmailDeliveryGroup({
          searchId: "search-1",
          alertGeneration: 3,
          checkLeaseToken: "check-lease",
          kind: "MATCH",
          groupKey: "match-group",
          send,
          now: () => now,
        }),
      ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

      expect(send).not.toHaveBeenCalled();
      expect(
        mockedPrisma.searchEmailDelivery.updateMany,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "SUPPRESSED",
            nextAttemptAt: null,
            lastError: "MATCH_PROVIDER_SOURCE_SUPERSEDED",
          }),
        }),
      );
      expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(0);
    },
  );

  it("sends only the reactivated owner obligation when the friend already received cycle 7", async () => {
    const owner = delivery("delivery-owner", "owner@example.com", {
      attemptCount: 1,
    });
    const friend = delivery("delivery-friend", "friend@example.com", {
      status: "SENT",
      attemptCount: 1,
      sentAt: new Date(now.getTime() - 60_000),
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SENT", sentAt: now },
        friend,
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
        now: () => now,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: "delivery-owner", status: "SENT" },
        { id: "delivery-friend", status: "SENT" },
      ]),
    );

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "owner@example.com" }),
    );
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "friend@example.com" }),
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["delivery-owner"] } },
        data: expect.objectContaining({ status: "SENDING" }),
      }),
    );
  });

  it("defers a claimed match while an equal-timestamp provider observation marker is active", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const markerExpiresAt = new Date(now.getTime() + 2 * 60_000);
    const retryUntil = new Date(markerExpiresAt.getTime() + 10 * 60_000);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const text = rawSqlText(sql);
      if (text.includes('FROM "ProviderRequestLease"')) {
        return [
          {
            observationStartedAt: now,
            leaseExpiresAt: markerExpiresAt,
            retryUntil,
            state: "ACTIVE",
          },
        ] as never;
      }
      if (text.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    const error = await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });
    expect(isExpectedSearchEmailDeliveryControlFlow(error)).toBe(true);

    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 60_000),
          lastError: "DELIVERY_PROVIDER_SOURCE_PENDING",
        }),
      }),
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("terminally suppresses an old claimed match when its provider observation marker expired unresolved", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const markerExpiresAt = new Date(now.getTime() - 11 * 60_000);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const text = rawSqlText(sql);
      if (text.includes('FROM "ProviderRequestLease"')) {
        return [
          {
            observationStartedAt: new Date(now.getTime() - 20 * 60_000),
            leaseExpiresAt: markerExpiresAt,
            retryUntil: new Date(markerExpiresAt.getTime() + 10 * 60_000),
            state: "EXPIRED_TERMINAL",
          },
        ] as never;
      }
      if (text.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SUPPRESSED" });

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUPPRESSED",
          nextAttemptAt: null,
          lastError: "DELIVERY_PROVIDER_SOURCE_UNRESOLVED",
        }),
      }),
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("reactivates settlement when a newer canonical provider success commits after the unresolved decision", async () => {
    const t1 = new Date(now.getTime() - 20 * 60_000);
    const t2 = new Date(now.getTime() - 10 * 60_000);
    const t3 = new Date(now.getTime() - 5 * 60_000);
    const owner = delivery("delivery-1", "owner@example.com", {
      attemptCount: 1,
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    let canonicalSourceAt = t1;
    mockedPrisma.teeTimeMatch.findMany.mockImplementation(async (args) => {
      const select = (args as { select?: Record<string, unknown> }).select;
      return [
        select?.lastConfirmedAt
          ? { ...currentMatch, lastConfirmedAt: canonicalSourceAt }
          : currentMatch,
      ] as never;
    });
    mockedPrisma.courseMonitoringStatus.findMany.mockImplementation(
      async () =>
        [
          {
            courseId: "course-1",
            lastSuccessfulAt: canonicalSourceAt,
            lastFailureAt: null,
          },
        ] as never,
    );
    let providerFenceReads = 0;
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const text = rawSqlText(sql);
      if (text.includes('FROM "ProviderRequestLease"')) {
        providerFenceReads += 1;
        return (
          providerFenceReads === 1
            ? [
                {
                  observationStartedAt: t2,
                  leaseExpiresAt: new Date(t2.getTime() + 60_000),
                  retryUntil: new Date(t2.getTime() + 11 * 60_000),
                  state: "EXPIRED_TERMINAL",
                },
              ]
            : []
        ) as never;
      }
      if (text.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    let releaseSettlementLock!: () => void;
    let settlementLockStarted!: () => void;
    const settlementLockBarrier = new Promise<void>((resolve) => {
      settlementLockStarted = resolve;
    });
    const settlementLockRelease = new Promise<void>((resolve) => {
      releaseSettlementLock = resolve;
    });
    let courseLockCalls = 0;
    mockedPrisma.$queryRawUnsafe.mockImplementation(async () => {
      courseLockCalls += 1;
      if (courseLockCalls === 2) {
        settlementLockStarted();
        await settlementLockRelease;
      }
      return [] as never;
    });
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    const drain = drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now,
    });
    await settlementLockBarrier;
    canonicalSourceAt = t3;
    releaseSettlementLock();

    await expect(drain).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "delivery-1",
          status: "SENDING",
        }),
        data: expect.objectContaining({
          status: "PENDING",
          sentAt: null,
          nextAttemptAt: null,
          lastError: null,
        }),
      }),
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("keeps settlement terminal when the unresolved marker disappears without a newer confirmation", async () => {
    const t1 = new Date(now.getTime() - 20 * 60_000);
    const t2 = new Date(now.getTime() - 10 * 60_000);
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: t1 },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: t1,
        lastFailureAt: null,
      },
    ] as never);
    let providerFenceReads = 0;
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const text = rawSqlText(sql);
      if (text.includes('FROM "ProviderRequestLease"')) {
        providerFenceReads += 1;
        return (
          providerFenceReads === 1
            ? [
                {
                  observationStartedAt: t2,
                  leaseExpiresAt: new Date(t2.getTime() + 60_000),
                  retryUntil: new Date(t2.getTime() + 11 * 60_000),
                  state: "EXPIRED_TERMINAL",
                },
              ]
            : []
        ) as never;
      }
      if (text.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SUPPRESSED" });

    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "DELIVERY_PROVIDER_SOURCE_UNRESOLVED",
        }),
      }),
    );
  });

  it("defers a claimed match while an equal-timestamp completed local-reader source awaits reconciliation", async () => {
    const priorSource = new Date(now.getTime() - 60_000);
    const readerSource = priorSource;
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: priorSource },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: priorSource,
        lastFailureAt: null,
      },
    ] as never);
    mockedPrisma.localReaderJob.findMany.mockResolvedValue([
      {
        claimedAt: readerSource,
        completedAt: new Date(readerSource.getTime() + 10_000),
        resultExpiresAt: new Date(now.getTime() + 5 * 60_000),
        result: {
          jobId: "reader-job",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          evidenceAnchor: "SERVER_CLAIM",
          observedAt: readerSource.toISOString(),
          pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
          pageTitle: "Tee Times",
          slots: [],
          readerVersion: "reader-v1",
        },
      },
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
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });

    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 60_000),
          lastError: "DELIVERY_PROVIDER_SOURCE_PENDING",
        }),
      }),
    );
  });

  it("sends after the exact completed local-reader source is durably marked consumed", async () => {
    const providerSource = new Date(now.getTime() - 60_000);
    const completedAt = new Date(providerSource.getTime() + 10_000);
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: providerSource },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: providerSource,
        lastFailureAt: null,
      },
    ] as never);
    mockedPrisma.localReaderJob.findMany.mockResolvedValue([
      {
        claimedAt: providerSource,
        completedAt,
        resultExpiresAt: completedAt,
        result: {
          jobId: "reader-job",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          evidenceAnchor: "SERVER_CLAIM",
          observedAt: providerSource.toISOString(),
          pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
          pageTitle: "Tee Times",
          slots: [],
          readerVersion: "reader-v1",
        },
      },
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
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledOnce();
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(0);
  });

  it("does not let one consumed equal-millisecond reader job mask an independent unconsumed source", async () => {
    const providerSource = new Date(now.getTime() - 60_000);
    const consumedAt = new Date(providerSource.getTime() + 20_000);
    const independentCompletedAt = new Date(providerSource.getTime() + 10_000);
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: providerSource },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: providerSource,
        lastFailureAt: null,
      },
    ] as never);
    const result = (jobId: string) => ({
      jobId,
      courseKey: "cps:grassyhill.cps.golf",
      status: "NO_AVAILABILITY",
      evidenceAnchor: "SERVER_CLAIM",
      observedAt: providerSource.toISOString(),
      pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
      pageTitle: "Tee Times",
      slots: [],
      readerVersion: "reader-v1",
    });
    mockedPrisma.localReaderJob.findMany.mockResolvedValue([
      {
        claimedAt: providerSource,
        completedAt: consumedAt,
        resultExpiresAt: consumedAt,
        result: result("reader-consumed"),
      },
      {
        claimedAt: providerSource,
        completedAt: independentCompletedAt,
        resultExpiresAt: new Date(now.getTime() + 5 * 60_000),
        result: result("reader-independent"),
      },
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
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });

    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError: "DELIVERY_PROVIDER_SOURCE_PENDING",
        }),
      }),
    );
  });

  it("sends when a strictly later canonical monitoring success supersedes an unconsumed local-reader source", async () => {
    const readerSource = new Date(now.getTime() - 2 * 60_000);
    const monitoringSource = new Date(now.getTime() - 60_000);
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: monitoringSource },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: monitoringSource,
        lastFailureAt: null,
      },
    ] as never);
    mockedPrisma.localReaderJob.findMany.mockResolvedValue([
      {
        claimedAt: readerSource,
        completedAt: new Date(readerSource.getTime() + 10_000),
        resultExpiresAt: new Date(now.getTime() + 5 * 60_000),
        result: {
          jobId: "reader-job",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          evidenceAnchor: "SERVER_CLAIM",
          observedAt: readerSource.toISOString(),
          pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
          pageTitle: "Tee Times",
          slots: [],
          readerVersion: "reader-v1",
        },
      },
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
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledOnce();
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(0);
  });

  it("terminally suppresses an old claimed match when a completed local-reader source expired unreconciled", async () => {
    const priorSource = new Date(now.getTime() - 20 * 60_000);
    const readerSource = new Date(now.getTime() - 10 * 60_000);
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: priorSource },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: priorSource,
        lastFailureAt: null,
      },
    ] as never);
    mockedPrisma.localReaderJob.findMany.mockResolvedValue([
      {
        claimedAt: readerSource,
        completedAt: new Date(readerSource.getTime() + 10_000),
        resultExpiresAt: new Date(now.getTime() - 60_000),
        result: {
          jobId: "reader-job",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          evidenceAnchor: "SERVER_CLAIM",
          observedAt: readerSource.toISOString(),
          pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
          pageTitle: "Tee Times",
          slots: [],
          readerVersion: "reader-v1",
        },
      },
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
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SUPPRESSED" });

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUPPRESSED",
          nextAttemptAt: null,
          lastError: "DELIVERY_PROVIDER_SOURCE_UNRESOLVED",
        }),
      }),
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("keeps retrying when an active provider observation coexists with a newer terminal local-reader source", async () => {
    const priorSource = new Date(now.getTime() - 30 * 60_000);
    const markerSource = new Date(now.getTime() - 20 * 60_000);
    const readerSource = new Date(now.getTime() - 10 * 60_000);
    const markerExpiresAt = new Date(now.getTime() + 2 * 60_000);
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: priorSource },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: priorSource,
        lastFailureAt: null,
      },
    ] as never);
    mockedPrisma.localReaderJob.findMany.mockResolvedValue([
      {
        claimedAt: readerSource,
        completedAt: new Date(readerSource.getTime() + 10_000),
        resultExpiresAt: new Date(now.getTime() - 60_000),
        result: {
          jobId: "reader-job",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          evidenceAnchor: "SERVER_CLAIM",
          observedAt: readerSource.toISOString(),
          pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
          pageTitle: "Tee Times",
          slots: [],
          readerVersion: "reader-v1",
        },
      },
    ] as never);
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const text = rawSqlText(sql);
      if (text.includes('FROM "ProviderRequestLease"')) {
        return [
          {
            observationStartedAt: markerSource,
            leaseExpiresAt: markerExpiresAt,
            retryUntil: new Date(markerExpiresAt.getTime() + 10 * 60_000),
            state: "ACTIVE",
          },
        ] as never;
      }
      if (text.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });

    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 60_000),
          lastError: "DELIVERY_PROVIDER_SOURCE_PENDING",
        }),
      }),
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("keeps retrying when a fresh local-reader source coexists with a newer terminal provider marker", async () => {
    const priorSource = new Date(now.getTime() - 40 * 60_000);
    const readerSource = new Date(now.getTime() - 30 * 60_000);
    const markerSource = new Date(now.getTime() - 20 * 60_000);
    const markerExpiresAt = new Date(now.getTime() - 11 * 60_000);
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: priorSource },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: priorSource,
        lastFailureAt: null,
      },
    ] as never);
    mockedPrisma.localReaderJob.findMany.mockResolvedValue([
      {
        claimedAt: readerSource,
        completedAt: new Date(readerSource.getTime() + 10_000),
        resultExpiresAt: new Date(now.getTime() + 5 * 60_000),
        result: {
          jobId: "reader-job",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          evidenceAnchor: "SERVER_CLAIM",
          observedAt: readerSource.toISOString(),
          pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
          pageTitle: "Tee Times",
          slots: [],
          readerVersion: "reader-v1",
        },
      },
    ] as never);
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const text = rawSqlText(sql);
      if (text.includes('FROM "ProviderRequestLease"')) {
        return [
          {
            observationStartedAt: markerSource,
            leaseExpiresAt: markerExpiresAt,
            retryUntil: new Date(markerExpiresAt.getTime() + 10 * 60_000),
            state: "EXPIRED_TERMINAL",
          },
        ] as never;
      }
      if (text.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });

    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 60_000),
          lastError: "DELIVERY_PROVIDER_SOURCE_PENDING",
        }),
      }),
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("does not start another old-recipient claim while a Clerk email transition is pending", async () => {
    const retryAt = new Date(now.getTime() + 60_000);
    mockedApplyPendingClerkEmailForSearch.mockResolvedValue({
      outcome: "deferred",
      retryAt,
    });
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "owner@example.com",
      pendingEmail: "new-owner@example.com",
    } as never);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com"),
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
        now: () => now,
      }),
    ).rejects.toMatchObject({
      code: "SEARCH_EMAIL_DELIVERY_DEFERRED",
      retryAt,
    });

    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks pending owner state inside the claim transaction after a clean preliminary check", async () => {
    mockedApplyPendingClerkEmailForSearch.mockResolvedValue({
      outcome: "none",
    });
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "owner@example.com",
      pendingEmail: "new-owner@example.com",
    } as never);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com"),
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
        now: () => now,
      }),
    ).rejects.toMatchObject({
      code: "SEARCH_EMAIL_DELIVERY_DEFERRED",
      retryAt: new Date(now.getTime() + 60_000),
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
      nextAttemptAt: new Date(now.getTime() + 60_000),
    };
    const retryAt = new Date(now.getTime() + 60_001);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([failedOwner] as never)
      .mockResolvedValueOnce([failedOwner] as never)
      .mockResolvedValueOnce([
        { ...failedOwner, status: "SENT", sentAt: retryAt },
      ] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    const firstError = new Error("temporary delivery failure");
    const attempts: Array<{ idempotencyKey: string; payload: unknown }> = [];
    const send = vi.fn(
      async (input: { idempotencyKey: string; payload: unknown }) => {
        attempts.push(input);
        if (attempts.length === 1) {
          throw firstError;
        }
        return { deliveryStatus: "sent" as const };
      },
    );

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => now,
      }),
    ).rejects.toBe(firstError);
    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => retryAt,
      }),
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
        "DELIVERY_NOT_ACCEPTED:Alert recipient authorization changed before delivery",
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([failedOwner] as never);
    mockedPrisma.user.findUnique
      .mockResolvedValueOnce({
        email: "owner@example.com",
        pendingEmail: null,
      } as never)
      .mockResolvedValue({
        email: "new-owner@example.com",
        pendingEmail: null,
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
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: "EMAIL_DELIVERY_NOT_ACCEPTED" });

    expect(send).not.toHaveBeenCalled();
    expect(
      mockedPrisma.user.findUnique.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError: expect.stringMatching(/^DELIVERY_NOT_ACCEPTED:/),
        }),
      }),
    );
  });

  it("does not resurrect a claim that expires while waiting for the final fence", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const failedOwner = {
      ...owner,
      status: "FAILED",
      attemptCount: 1,
      lastError:
        "DELIVERY_NOT_ACCEPTED:Alert email delivery claim expired before provider delivery",
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
      },
    );

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send,
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: "EMAIL_DELIVERY_NOT_ACCEPTED" });

    expect(send).toHaveBeenCalledOnce();
    expect(providerSend).not.toHaveBeenCalled();
    const renewalSql = mockedPrisma.$executeRaw.mock.calls[1][0] as unknown as {
      strings: string[];
    };
    const renewalText = renewalSql.strings.join(" ");
    expect(renewalText).toContain('"claimExpiresAt" > statement_timestamp()');
    expect(renewalText).toContain(
      'SET "claimExpiresAt" = statement_timestamp()',
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError: expect.stringMatching(/^DELIVERY_NOT_ACCEPTED:/),
        }),
      }),
    );
  });

  it("checks recipient-scoped overlap before sending a match group", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now,
    });

    expect(mockedPrisma.searchEmailDelivery.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "MATCH",
          groupKey: { not: "match-group" },
          recipient: { in: ["owner@example.com"] },
        }),
      }),
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
      createdAt: new Date(now.getTime() - 120_000),
    });
    const retiredOwner = {
      ...owner,
      status: "SUPPRESSED",
      lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP",
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([attemptedOwner] as never)
      .mockResolvedValueOnce([retiredOwner] as never);
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValueOnce({
      id: "attempted-delivery",
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["delivery-1"] } },
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP",
        }),
      }),
    );
  });

  it("lets a reached overlapping group outrank a current ambiguous retry", async () => {
    const ambiguousOwner = delivery("current-ambiguous", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
    });
    const reachedOwner = delivery("reached-owner", "owner@example.com", {
      groupKey: "reached-group",
      status: "SENT",
      sentAt: new Date(now.getTime() - 60_000),
      createdAt: new Date(now.getTime() - 120_000),
    });
    const retiredOwner = {
      ...ambiguousOwner,
      status: "SUPPRESSED",
      lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP",
    };
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValueOnce({
      id: "reached-owner",
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "current-ambiguous", status: "SUPPRESSED" }]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["current-ambiguous"] } },
        data: expect.objectContaining({
          lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP",
        }),
      }),
    );
  });

  it("rekeys an overlapping delivery only when the provider definitively did not accept it", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    const notAccepted = delivery("not-accepted", "owner@example.com", {
      groupKey: "older-group",
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected",
      createdAt: new Date(now.getTime() - 120_000),
    });
    const sentOwner = { ...owner, status: "SENT", sentAt: now };
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValueOnce({
      id: "not-accepted",
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
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledOnce();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["not-accepted"] } },
      data: {
        status: "SUPPRESSED",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: "MATCH_STALE_REKEYED",
      },
    });
  });

  it("retires an unattempted old owner address and prepares the exact-cycle successor for the current owner", async () => {
    const oldOwner = delivery("old-owner", "old-owner@example.com", {
      isOwnerRecipient: true,
    });
    const friend = delivery("friend", "friend@example.com", {
      isOwnerRecipient: false,
    });
    const retiredOwner = {
      ...oldOwner,
      status: "SUPPRESSED",
      lastError: "DELIVERY_RECIPIENT_REKEYED",
    };
    const sentFriend = { ...friend, status: "SENT", sentAt: now };
    mockQueryRawForSearch({
      ...currentSearch,
      ownerEmail: "new-owner@example.com",
      additionalEmails: ["friend@example.com"],
    });
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "new-owner@example.com",
      pendingEmail: null,
    } as never);
    mockedPrisma.teeSearch.findFirst.mockResolvedValue({
      additionalEmails: ["friend@example.com"],
      user: { email: "new-owner@example.com" },
    } as never);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([oldOwner, friend] as never)
      .mockResolvedValueOnce([retiredOwner, friend] as never)
      .mockResolvedValueOnce([retiredOwner, sentFriend] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("successor", "new-owner@example.com", {
        groupKey: "catchup-current-owner",
      }) as never,
    );
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "friend@example.com" }),
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "new-owner@example.com",
          isOwnerRecipient: true,
          payload: expect.objectContaining({
            matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
          }),
        }),
      }),
    );
  });

  it("fails an ambiguous old owner closed while preserving an authorized additional recipient", async () => {
    const oldOwner = delivery("old-owner", "old-owner@example.com", {
      isOwnerRecipient: true,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
    });
    const friend = delivery("friend", "friend@example.com", {
      isOwnerRecipient: false,
    });
    const blockedOwner = {
      ...oldOwner,
      status: "SUPPRESSED",
      lastError: "MATCH_STALE_REKEY_BLOCKED",
    };
    const sentFriend = { ...friend, status: "SENT", sentAt: now };
    mockQueryRawForSearch({
      ...currentSearch,
      ownerEmail: "new-owner@example.com",
      additionalEmails: ["friend@example.com"],
    });
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "new-owner@example.com",
      pendingEmail: null,
    } as never);
    mockedPrisma.teeSearch.findFirst.mockResolvedValue({
      additionalEmails: ["friend@example.com"],
      user: { email: "new-owner@example.com" },
    } as never);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([oldOwner, friend] as never)
      .mockResolvedValueOnce([blockedOwner, friend] as never)
      .mockResolvedValueOnce([blockedOwner, sentFriend] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("sentinel", "new-owner@example.com", {
        status: "SUPPRESSED",
        lastError: "MATCH_STALE_REKEY_BLOCKED",
      }) as never,
    );
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "friend@example.com" }),
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-1", availabilityCycle: 7 }],
          alertStatus: "PENDING",
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null },
      }),
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "new-owner@example.com",
          isOwnerRecipient: true,
          status: "SUPPRESSED",
          lastError: "MATCH_STALE_REKEY_BLOCKED",
        }),
      }),
    );
  });

  it("seeds exactly one current-owner terminal status when the old owner outcome is ambiguous", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      statusSnapshot: [],
      statusReport: { kind: "daily" },
    };
    const oldOwner = delivery("old-owner", "old-owner@example.com", {
      kind: "DAILY",
      groupKey: "daily-group",
      isOwnerRecipient: true,
      payload: statusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
    });
    const blockedOwner = {
      ...oldOwner,
      status: "SUPPRESSED",
      lastError: "DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED",
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
        lastError: "STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT",
      },
    );
    mockedPrisma.$queryRaw.mockResolvedValue([
      {
        ...currentSearch,
        ownerEmail: "new-owner@example.com",
        additionalEmails: [],
      },
    ] as never);
    mockedPrisma.user.findUnique.mockResolvedValue({
      email: "new-owner@example.com",
      pendingEmail: null,
    } as never);
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([oldOwner] as never)
      .mockResolvedValueOnce([blockedOwner, currentOwnerSentinel] as never)
      .mockResolvedValueOnce([blockedOwner, currentOwnerSentinel] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      currentOwnerSentinel as never,
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
        now: () => now,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "current-owner-sentinel",
          status: "SUPPRESSED",
        }),
      ]),
    );

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledOnce();
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipient: "new-owner@example.com",
        isOwnerRecipient: true,
        status: "SUPPRESSED",
        lastError: "STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT",
      }),
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
      lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      ambiguousLegacyOwner,
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
        now,
      }),
    ).resolves.toEqual({
      prepared: true,
      groups: [],
      hasExistingObligation: true,
    });

    expect(mockedPrisma.searchEmailDelivery.create).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-1", availabilityCycle: 7 }],
        }),
      }),
    );

    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma),
    );
    mockedPrisma.$queryRaw.mockResolvedValue([currentSearch] as never);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      {
        ...ambiguousLegacyOwner,
        status: "PENDING",
        attemptCount: 0,
        lastError: null,
      },
    ] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("current-owner", "owner@example.com") as never,
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
        now,
      }),
    ).resolves.toEqual({
      prepared: true,
      groups: [
        {
          groupKey: expect.stringMatching(/^catchup-/),
          recipient: "owner@example.com",
        },
      ],
      hasExistingObligation: false,
    });
  });

  it("does not let a row retired in favor of another group become an owner again", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("retired-owner", "owner@example.com", {
        status: "SUPPRESSED",
        lastError: "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP",
      }),
    ] as never);
    mockedPrisma.searchEmailDelivery.create.mockResolvedValue(
      delivery("current-owner", "owner@example.com") as never,
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
        now,
      }),
    ).resolves.toEqual({
      prepared: true,
      groups: [
        {
          groupKey: expect.stringMatching(/^catchup-/),
          recipient: "owner@example.com",
        },
      ],
      hasExistingObligation: false,
    });
  });

  it("retries a frozen current match group with its immutable payload", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SENT", sentAt: now },
      ] as never);
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
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ payload }));
  });

  it("blocks mutations while any recipient in the group remains SENDING", async () => {
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue({
      claimExpiresAt: new Date(now.getTime() + 60_000),
    } as never);
    await expect(
      lockSearchForAlertMutation(prisma, {
        searchId: "search-1",
        userId: "user-1",
        now,
      }),
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
          lastError: null,
        },
      ] as never);

    await lockSearchForAlertMutation(prisma, {
      searchId: "search-1",
      userId: "user-1",
      now,
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-1", availabilityCycle: 7 }],
          alertStatus: "PENDING",
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null },
      }),
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "SENDING" }),
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "DELIVERY_OUTCOME_UNKNOWN_AFTER_SEARCH_MUTATION",
        }),
      }),
    );
  });

  it("consumes pending matches from every attempted delivery kind before a generation mutation", async () => {
    const attemptedSetupPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      matchIds: ["match-1"],
      matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
      displayMatchIds: ["match-1"],
      statusReport: { kind: "setup" },
    };
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          payload: attemptedSetupPayload,
          status: "FAILED",
          attemptCount: 1,
          sentAt: null,
          lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
        },
      ] as never);

    await lockSearchForAlertMutation(prisma, {
      searchId: "search-1",
      userId: "user-1",
      now,
    });

    expect(mockedPrisma.searchEmailDelivery.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertGeneration: 3,
        }),
      }),
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-1", availabilityCycle: 7 }],
          alertStatus: "PENDING",
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null },
      }),
    );
  });

  it("leaves unattempted pending matches available for the next alert generation", async () => {
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await lockSearchForAlertMutation(prisma, {
      searchId: "search-1",
      userId: "user-1",
      now,
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
  });

  it("finalizes an owner-sent match before consuming only still-pending attempted evidence", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "SENT",
      sentAt: now,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([
        { kind: "MATCH", groupKey: "match-group" },
      ] as never)
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        {
          payload: {
            ...payload,
            matchIds: ["match-2"],
            matchRefs: [{ matchId: "match-2", availabilityCycle: 4 }],
            displayMatchIds: ["match-2"],
          },
          status: "FAILED",
          attemptCount: 1,
          sentAt: null,
          lastError: "DELIVERY_OUTCOME_UNKNOWN:timeout",
        },
      ] as never);

    await lockSearchForAlertMutation(prisma, {
      searchId: "search-1",
      userId: "user-1",
      now,
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: { alertStatus: "SENT", sentAt: now } }),
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-2", availabilityCycle: 4 }],
          alertStatus: "PENDING",
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null },
      }),
    );
  });

  it("does not suppress delivery or match state after the generation changes", async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([
      { ...currentSearch, alertGeneration: 4 },
    ] as never);

    await expect(
      suppressSearchEmailDeliveriesForMatches({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
        now,
      }),
    ).resolves.toEqual({ count: 0, matchCount: 0, current: false });

    expect(mockedPrisma.$queryRaw).toHaveBeenCalledOnce();
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("does not suppress delivery or match state after the check lease changes", async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([
      { ...currentSearch, checkLeaseToken: "new-check-lease" },
    ] as never);

    await expect(
      suppressSearchEmailDeliveriesForMatches({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
        now,
      }),
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
        now,
      }),
    ).resolves.toEqual({ count: 1, matchCount: 1, current: true });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        OR: [{ id: "match-1", availabilityCycle: 7 }],
        alertStatus: "PENDING",
      },
      data: { alertStatus: "SUPPRESSED", sentAt: null },
    });
  });

  it("never revives a group after one referenced pending match is gone", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null },
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses a queued match retry when the course is now an identity final", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null },
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
        intelligenceConfidence: 0.99,
      },
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["course-1"] } } }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a Grassy Hill local-reader match through a stored technical final", async () => {
    const bookingUrl =
      "https://grassyhill.cps.golf/onlineresweb/search-teetime";
    const grassyPayload = {
      ...payload,
      matchReport: {
        ...payload.matchReport,
        matches: payload.matchReport.matches.map((match) => ({
          ...match,
          courseName: "Grassy Hill Country Club",
          bookingUrl,
        })),
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      payload: grassyPayload,
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SENT", sentAt: now },
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, bookingUrl },
    ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        ...currentCourse,
        name: "Grassy Hill Country Club",
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        intelligenceVerifiedAt: new Date("2026-07-11T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-11T12:00:00.000Z"),
        intelligenceConfidence: 0.95,
      },
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
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload: grassyPayload }),
    );
  });

  it("reconciles an unattempted group to its confirmed subset before claiming it", async () => {
    const validRow = payload.matchReport.matches[0];
    const terminalRow = {
      ...validRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Private Course",
    };
    const multiCoursePayload = {
      ...payload,
      matchIds: ["match-1", "match-2"],
      matchRefs: [
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 4 },
      ],
      displayMatchIds: ["match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [validRow, terminalRow],
      },
    };
    const reconciledPayload = {
      ...multiCoursePayload,
      matchIds: ["match-1"],
      matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
      displayMatchIds: ["match-1"],
      satisfiesStatusReport: false,
      matchReport: {
        ...payload.matchReport,
        matches: [validRow],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      payload: multiCoursePayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, payload: reconciledPayload, status: "SENT", sentAt: now },
      ] as never);
    mockedPrisma.teeTimeMatch.findMany
      .mockResolvedValueOnce([
        {
          id: "match-1",
          courseId: "course-1",
          alertStatus: "PENDING",
          availabilityStatus: "AVAILABLE",
          availabilityCycle: 7,
        },
        {
          id: "match-2",
          courseId: "course-2",
          alertStatus: "PENDING",
          availabilityStatus: "AVAILABLE",
          availabilityCycle: 4,
        },
      ] as never)
      .mockResolvedValue([
        {
          ...currentMatch,
          lastConfirmedAt: now,
        },
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
        intelligenceConfidence: null,
      },
      {
        id: "course-2",
        isPublic: false,
        bookingMethod: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        intelligenceVerifiedAt: now,
        intelligenceReviewAt: new Date("2026-08-15T00:00:00.000Z"),
        intelligenceConfidence: 0.99,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now },
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
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload: reconciledPayload }),
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-1"] },
        attemptCount: 0,
        status: { notIn: ["SENDING", "SENT"] },
      },
      data: { payload: reconciledPayload },
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-2", availabilityCycle: 4 }],
        }),
        data: expect.objectContaining({
          alertStatus: "SUPPRESSED",
          availabilityStatus: "GONE",
        }),
      }),
    );
  });

  it("lets terminal evidence dominate transient evidence for a frozen group", async () => {
    const validRow = payload.matchReport.matches[0];
    const privateRow = {
      ...validRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Private Course",
    };
    const multiCoursePayload = {
      ...payload,
      matchIds: ["match-1", "match-2"],
      matchRefs: [
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 4 },
      ],
      displayMatchIds: ["match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [validRow, privateRow],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
      payload: multiCoursePayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null },
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-1",
        courseId: "course-1",
        alertStatus: "PENDING",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 7,
      },
      {
        id: "match-2",
        courseId: "course-2",
        alertStatus: "PENDING",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 4,
      },
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
        intelligenceConfidence: null,
      },
      {
        id: "course-2",
        isPublic: false,
        bookingMethod: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        intelligenceVerifiedAt: now,
        intelligenceReviewAt: new Date("2026-08-15T00:00:00.000Z"),
        intelligenceConfidence: 0.99,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "FETCH_FAILED", observedAt: now },
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-2", availabilityCycle: 4 }],
        }),
        data: expect.objectContaining({
          alertStatus: "SUPPRESSED",
          availabilityStatus: "GONE",
        }),
      }),
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        OR: [
          { id: "match-1", availabilityCycle: 7 },
          { id: "match-2", availabilityCycle: 4 },
        ],
        alertStatus: "PENDING",
      },
      data: { alertStatus: "SUPPRESSED", sentAt: null },
    });
  });

  it("splits a frozen mixed group into independent confirmed and transient continuations", async () => {
    const confirmedRow = payload.matchReport.matches[0];
    const terminalRow = {
      ...confirmedRow,
      matchId: "match-0",
      courseId: "course-0",
      courseName: "Removed Course",
    };
    const transientRow = {
      ...confirmedRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Second Course",
      startsAt: "2026-07-16T13:00:00.000Z",
    };
    const mixedPayload = {
      ...payload,
      matchIds: ["match-0", "match-1", "match-2"],
      matchRefs: [
        { matchId: "match-0", availabilityCycle: 3 },
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 4 },
      ],
      displayMatchIds: ["match-0", "match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [terminalRow, confirmedRow, transientRow],
      },
    };
    const frozenOwner = delivery("delivery-1", "owner@example.com", {
      payload: mixedPayload,
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected",
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([frozenOwner] as never)
      .mockResolvedValueOnce([
        {
          ...frozenOwner,
          status: "SUPPRESSED",
          nextAttemptAt: null,
          lastError: "MATCH_STALE_REKEYED",
        },
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      currentMatch,
      {
        ...currentMatch,
        id: "match-2",
        courseId: "course-2",
        availabilityCycle: 4,
        startsAt: new Date("2026-07-16T13:00:00.000Z"),
      },
    ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      currentCourse,
      {
        ...currentCourse,
        id: "course-2",
        name: "Second Course",
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now },
      { courseId: "course-2", outcome: "FETCH_FAILED", observedAt: now },
    ] as never);

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send: vi.fn(),
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    const continuationPayloads =
      mockedPrisma.searchEmailDelivery.create.mock.calls.map(
        ([call]) => call.data.payload,
      );
    expect(continuationPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientCatchup: true,
          matchIds: ["match-1"],
          matchRefs: [{ matchId: "match-1", availabilityCycle: 7 }],
        }),
        expect.objectContaining({
          recipientCatchup: true,
          matchIds: ["match-2"],
          matchRefs: [{ matchId: "match-2", availabilityCycle: 4 }],
        }),
      ]),
    );
    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "match-0", availabilityCycle: 3 }],
        }),
        data: expect.objectContaining({ availabilityStatus: "GONE" }),
      }),
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { id: "match-1", availabilityCycle: 7 },
            { id: "match-2", availabilityCycle: 4 },
          ]),
        }),
        data: { alertStatus: "SUPPRESSED", sentAt: null },
      }),
    );
  });

  it("suppresses instead of rewriting an immutable payload with a stale display match", async () => {
    const currentRow = payload.matchReport.matches[0];
    const staleRow = {
      ...currentRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Gone Course",
    };
    const retryPayload = {
      ...payload,
      displayMatchIds: ["match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [currentRow, staleRow],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
      payload: retryPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null },
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-1",
        courseId: "course-1",
        alertStatus: "PENDING",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 7,
      },
      {
        id: "match-2",
        courseId: "course-2",
        alertStatus: "SENT",
        availabilityStatus: "GONE",
        availabilityCycle: 2,
      },
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
        intelligenceConfidence: null,
      },
      {
        id: "course-2",
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
      },
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        OR: [{ id: "match-1", availabilityCycle: 7 }],
        alertStatus: "PENDING",
      },
      data: { alertStatus: "SUPPRESSED", sentAt: null },
    });
  });

  it("defers an attempted match email during a transient probe failure", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(now.getTime() - 1),
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "FETCH_FAILED", observedAt: now },
    ] as never);
    const send = vi.fn();

    const error = await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "match-group",
      send,
      now: () => now,
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
      monitoringDisposition: undefined,
    },
    {
      kind: "DAILY" as const,
      reportKind: "daily",
      reportOutcome: "MATCH_FOUND",
      currentOutcome: "MATCH_FOUND",
      monitoringDisposition: "TECHNICAL_FINAL",
    },
    {
      kind: "SETUP" as const,
      reportKind: "setup",
      reportOutcome: "BLOCKED_POLICY",
      currentOutcome: "BLOCKED_POLICY",
      monitoringDisposition: undefined,
    },
  ])(
    "suppresses stale $kind status evidence before send",
    async ({
      kind,
      reportKind,
      reportOutcome,
      currentOutcome,
      monitoringDisposition,
    }) => {
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
              ...(monitoringDisposition ? { monitoringDisposition } : {}),
            },
          ],
        },
      };
      const owner = delivery("delivery-1", "owner@example.com", {
        kind,
        groupKey: "status-group",
        payload: statusPayload,
      });
      mockedPrisma.searchEmailDelivery.findMany
        .mockResolvedValueOnce([owner] as never)
        .mockResolvedValueOnce(
          (kind === "SETUP" ? [owner] : [
            { ...owner, status: "SUPPRESSED", nextAttemptAt: null },
          ]) as never,
        )
        .mockResolvedValueOnce([
          { ...owner, status: "SUPPRESSED", nextAttemptAt: null },
        ] as never);
      mockedPrisma.courseProbe.findMany.mockResolvedValue([
        { courseId: "course-1", outcome: currentOutcome, observedAt: now },
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
          now: () => now,
        }),
      ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("sends a pending reader status when the latest durable probe predates it", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      displayMatchIds: [],
      statusSnapshot: [{ courseId: "course-1", state: "CHECK_PENDING" }],
      statusReport: {
        kind: "setup",
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
            outcome: "CHECK_PENDING",
            availableMatches: 0,
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "SETUP",
      groupKey: "status-group",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SENT", sentAt: now },
      ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        outcome: "NO_MATCH",
        observedAt: new Date(now.getTime() - 60_000),
      },
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "SETUP",
      groupKey: "status-group",
      send,
      now: () => now,
    });

    expect(send).toHaveBeenCalledOnce();
  });

  it.each([null, "DELIVERY_PROVIDER_SOURCE_PENDING"])(
    "distinguishes uncertain transport from a provider hold before stale status replacement (%s)", async (lastError) => {
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
            availableMatches: 0,
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError,
      nextAttemptAt: new Date(now.getTime() - 1),
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SUPPRESSED", nextAttemptAt: null },
      ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now },
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: lastError === "DELIVERY_PROVIDER_SOURCE_PENDING"
            ? "STATUS_CONTENT_STALE_REPLACEMENT_PENDING"
            : "STATUS_CONTENT_STALE_REPLACEMENT_PENDING_AMBIGUOUS",
        }),
      }),
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
            availableMatches: 0,
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload,
      status: "SUPPRESSED",
      sentAt,
      lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
    });
    const friend = delivery("delivery-2", "friend@example.com", {
      kind: "DAILY",
      groupKey: "replacement-status",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        owner,
        {
          ...friend,
          status: "SUPPRESSED",
          lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING",
        },
      ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now },
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
        now: () => now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "delivery-1", status: "SUPPRESSED" }),
      expect.objectContaining({ id: "delivery-2", status: "SUPPRESSED" }),
    ]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["delivery-2"] } }),
        data: expect.objectContaining({
          status: "SUPPRESSED",
          lastError: "STATUS_CONTENT_STALE_REPLACEMENT_PENDING",
        }),
      }),
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
            availableMatches: 0,
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SENT", sentAt: now },
      ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "NO_MATCH", observedAt: now },
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
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: "SENT" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload: statusPayload }),
    );
  });

  it("defers an unchanged no-match status while an equal-timestamp provider observation is active", async () => {
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
            availableMatches: 0,
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload,
    });
    const markerExpiresAt = new Date(now.getTime() + 2 * 60_000);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "NO_MATCH", observedAt: now },
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([]);
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const text = rawSqlText(sql);
      if (text.includes('FROM "ProviderRequestLease"')) {
        return [
          {
            observationStartedAt: now,
            leaseExpiresAt: markerExpiresAt,
            retryUntil: new Date(markerExpiresAt.getTime() + 10 * 60_000),
            state: "ACTIVE",
          },
        ] as never;
      }
      if (text.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "DAILY",
        groupKey: "status-group",
        send,
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError: "DELIVERY_PROVIDER_SOURCE_PENDING",
        }),
      }),
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  function pendingSetupPayload(courseOverrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      displayMatchIds: [],
      matchIds: [],
      matchRefs: [],
      statusSnapshot: [{ courseId: "course-1", state: "CHECK_PENDING" }],
      statusReport: {
        kind: "setup",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [{
          courseId: "course-1",
          courseName: "Course",
          timeZone: "America/New_York",
          outcome: "CHECK_PENDING",
          availableMatches: 0,
          ...courseOverrides,
        }],
      },
    };
  }

  function usePendingSetupSource(source: "ACTIVE" | "FRESH_UNCONSUMED" | "EXPIRED_RETRYABLE") {
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([]);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "NEEDS_ADAPTER", observedAt: now },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      { courseId: "course-1", state: "AUTO_INVESTIGATING", lastFailureAt: now, lastSuccessfulAt: null },
    ] as never);
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const query = rawSqlText(sql);
      if (query.includes('FROM "ProviderRequestLease"')) {
        return source !== "FRESH_UNCONSUMED"
          ? [{ observationStartedAt: now,
              leaseExpiresAt: new Date(now.getTime() + (source === "ACTIVE" ? 20 : -5) * 60_000),
              retryUntil: new Date(now.getTime() + (source === "ACTIVE" ? 30 : 5) * 60_000), state: source }] as never
          : [] as never;
      }
      if (query.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    if (source === "FRESH_UNCONSUMED") {
      mockedPrisma.localReaderJob.findMany.mockResolvedValue([{
        claimedAt: now,
        completedAt: now,
        resultExpiresAt: new Date(now.getTime() + 5 * 60_000),
        result: {
          jobId: "reader-job", courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY", evidenceAnchor: "SERVER_CLAIM",
          observedAt: now.toISOString(),
          pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
          pageTitle: "Tee Times", slots: [], readerVersion: "reader-v1",
        },
      }] as never);
    }
  }

  it.each(["ACTIVE", "FRESH_UNCONSUMED"] as const)(
    "sends a current pending setup within ten minutes while its source remains %s, once per recipient across changed groups",
    async (source) => {
      usePendingSetupSource(source);
      const statusPayload = pendingSetupPayload();
      const startedAt = new Date(now.getTime() - 9 * 60_000);
      const owner = delivery("pending-owner", "owner@example.com", {
        kind: "SETUP", groupKey: "pending-setup", payload: statusPayload, createdAt: startedAt,
      });
      const friend = { ...owner, id: "pending-friend", recipient: "friend@example.com", isOwnerRecipient: false };
      const accepted = [owner, friend].map((row) => ({ ...row, status: "SENT", attemptCount: 1, sentAt: now }));
      mockedPrisma.searchEmailDelivery.findMany
        .mockResolvedValueOnce([owner, friend] as never)
        .mockResolvedValueOnce([owner, friend] as never)
        .mockResolvedValueOnce(accepted as never);
      mockedPrisma.searchEmailDelivery.updateMany
        .mockResolvedValueOnce({ count: 2 } as never)
        .mockResolvedValue({ count: 1 } as never);
      const send = vi.fn().mockImplementation(async ({ recipient, payload, assertCurrentDelivery }) => {
        await assertCurrentDelivery();
        const report = await hydrateSearchStatusEmailPayload(payload);
        const html = renderSearchStatusHtml({ searchId: "search-1", to: recipient, ...report });
        expect(html).toContain("Current availability is not confirmed yet");
        expect(html).not.toContain("No matching tee times");
        expect(html).not.toContain("TEE TIME FOUND");
        expect(now.getTime() - startedAt.getTime()).toBeLessThan(10 * 60_000);
        return { deliveryStatus: "sent" };
      });
      await expect(drainSearchEmailDeliveryGroup({
        searchId: "search-1", alertGeneration: 3, checkLeaseToken: "check-lease",
        kind: "SETUP", groupKey: "pending-setup", send, now: () => now,
      })).resolves.toEqual([
        { id: "pending-owner", status: "SENT" },
        { id: "pending-friend", status: "SENT" },
      ]);

      const newer = [owner, friend].map((row) => ({
        ...row, id: `${row.id}-newer`, groupKey: "changed-pending-setup",
        payload: { ...statusPayload, checkedAt: new Date(now.getTime() + 1).toISOString() },
      }));
      mockedPrisma.searchEmailDelivery.findMany
        .mockResolvedValueOnce(newer as never)
        .mockResolvedValueOnce([...accepted, ...newer] as never)
        .mockResolvedValueOnce(newer.map((row) => ({
          ...row, status: "SUPPRESSED", sentAt: now, lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
        })) as never);
      await expect(drainSearchEmailDeliveryGroup({
        searchId: "search-1", alertGeneration: 3, checkLeaseToken: "check-lease",
        kind: "SETUP", groupKey: "changed-pending-setup", send, now: () => now,
      })).resolves.toEqual([
        { id: "pending-owner-newer", status: "SUPPRESSED" },
        { id: "pending-friend-newer", status: "SUPPRESSED" },
      ]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.map(([input]) => input.recipient).sort()).toEqual(["friend@example.com", "owner@example.com"]);
      expect(mockedPrisma.courseMonitoringStatus.findMany).toHaveBeenCalled();
      expect(mockedPrisma.localReaderJob.findMany).toHaveBeenCalled();
    },
  );

  it.each(["DAILY", "MONITORING_RECOVERY", "MONITORING_STATUS_UPDATE", "MONITORING_OUTAGE"] as const)(
    "keeps pending source confirmation mandatory for %s",
    async (kind) => {
      usePendingSetupSource("ACTIVE");
      const statusPayload = pendingSetupPayload();
      statusPayload.statusReport.kind = kind === "DAILY" ? "daily" : kind === "MONITORING_RECOVERY" ? "recovery" : kind === "MONITORING_OUTAGE" ? "outage" : "status-update";
      const owner = delivery("pending-owner", "owner@example.com", { kind, groupKey: "status-group", payload: statusPayload });
      mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
      const send = vi.fn();
      await expect(drainSearchEmailDeliveryGroup({
        searchId: "search-1", alertGeneration: 3, checkLeaseToken: "check-lease",
        kind, groupKey: "status-group", send, now: () => now,
      })).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(["ACTIVE", "FRESH_UNCONSUMED"] as const)(
    "does not let a pending setup mask a second course's unconfirmed no-match source (%s)",
    async (source) => {
      usePendingSetupSource(source);
      const statusPayload = pendingSetupPayload();
      statusPayload.statusReport.courses.push({
        courseId: "course-2", courseName: "Second Course", timeZone: "America/New_York",
        outcome: "NO_MATCH", availableMatches: 0,
      });
      mockedPrisma.course.findMany.mockResolvedValue([
        currentCourse, { ...currentCourse, id: "course-2", name: "Second Course" },
      ] as never);
      mockedPrisma.courseProbe.findMany.mockResolvedValue([
        { courseId: "course-1", outcome: "NEEDS_ADAPTER", observedAt: now },
        { courseId: "course-2", outcome: "NO_MATCH", observedAt: now },
      ] as never);
      const owner = delivery("pending-owner", "owner@example.com", {
        kind: "SETUP", groupKey: "status-group", payload: statusPayload,
      });
      mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
      const send = vi.fn();
      await expect(drainSearchEmailDeliveryGroup({
        searchId: "search-1", alertGeneration: 3, checkLeaseToken: "check-lease",
        kind: "SETUP", groupKey: "status-group", send, now: () => now,
      })).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("rechecks owner authority at the sender boundary for a source-pending setup", async () => {
    usePendingSetupSource("ACTIVE");
    const owner = delivery("pending-owner", "owner@example.com", {
      kind: "SETUP", groupKey: "status-group", payload: pendingSetupPayload(),
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
    mockedPrisma.user.findUnique
      .mockResolvedValueOnce({ email: "owner@example.com", pendingEmail: null } as never)
      .mockResolvedValue({ email: "new-owner@example.com", pendingEmail: null } as never);
    const send = vi.fn();
    await expect(drainSearchEmailDeliveryGroup({
      searchId: "search-1", alertGeneration: 3, checkLeaseToken: "check-lease",
      kind: "SETUP", groupKey: "status-group", send, now: () => now,
    })).rejects.toMatchObject({ code: "EMAIL_DELIVERY_NOT_ACCEPTED" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { monitoringDisposition: "TECHNICAL_FINAL" },
    { supportStatus: "NEEDS_HUMAN_REVIEW" },
    { automationPlaybookExhausted: true },
    { automationStalledAtEndpoint: true },
    { availability: { visibleSlotCount: 0, playerEligibleSlotCount: 0 } },
    { bookingWindow: { releaseDate: "2026-07-16" } },
  ])("does not bypass an active source for pending setup containing factual or final claims %j", async (claims) => {
    usePendingSetupSource("ACTIVE");
    const owner = delivery("pending-owner", "owner@example.com", {
      kind: "SETUP", groupKey: "status-group", payload: pendingSetupPayload(claims),
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
    const send = vi.fn();
    const result = drainSearchEmailDeliveryGroup({
      searchId: "search-1", alertGeneration: 3, checkLeaseToken: "check-lease",
      kind: "SETUP", groupKey: "status-group", send, now: () => now,
    });
    // A contradictory disposition is retired by the current-content guard;
    // the other claims remain current but wait for source reconciliation.
    if ("monitoringDisposition" in claims) await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not extend the expired-source exception to a pending setup with a human-review claim", async () => {
    usePendingSetupSource("EXPIRED_RETRYABLE");
    const owner = delivery("pending-owner", "owner@example.com", {
      kind: "SETUP", groupKey: "status-group",
      payload: pendingSetupPayload({ supportStatus: "NEEDS_HUMAN_REVIEW" }),
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
    const send = vi.fn();
    await expect(drainSearchEmailDeliveryGroup({
      searchId: "search-1", alertGeneration: 3, checkLeaseToken: "check-lease",
      kind: "SETUP", groupKey: "status-group", send, now: () => now,
    })).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_SOURCE_PENDING" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { status: "PAUSED" },
    { alertGeneration: 4 },
    { checkLeaseToken: "successor-check" },
    { checkLeaseExpiresAt: new Date(now.getTime() - 1) },
  ])("does not send a pending setup through a stale search fence %j", async (searchChanges) => {
    usePendingSetupSource("ACTIVE");
    mockQueryRawForSearch({ ...currentSearch, ...searchChanges });
    const owner = delivery("pending-owner", "owner@example.com", {
      kind: "SETUP", groupKey: "status-group", payload: pendingSetupPayload(),
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([owner] as never);
    const send = vi.fn();
    await drainSearchEmailDeliveryGroup({
      searchId: "search-1", alertGeneration: 3, checkLeaseToken: "check-lease",
      kind: "SETUP", groupKey: "status-group", send, now: () => now,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    {
      description: "sends a truthful unsupported-course setup after its source expires",
      outcome: "NEEDS_ADAPTER",
      monitoringState: "ENGINEERING_VERIFICATION_NEEDED",
      markerState: "EXPIRED_TERMINAL",
      expectedStatus: "SENT",
    },
    {
      description: "sends a truthful unsupported-course setup during source ambiguity retry",
      outcome: "NEEDS_ADAPTER",
      monitoringState: "ENGINEERING_VERIFICATION_NEEDED",
      markerState: "EXPIRED_RETRYABLE",
      expectedStatus: "SENT",
    },
    {
      description: "sends a factual pending setup while an unsupported course has an active source",
      outcome: "NEEDS_ADAPTER",
      monitoringState: "ENGINEERING_VERIFICATION_NEEDED",
      markerState: "ACTIVE",
      expectedStatus: "SENT",
    },
    {
      description: "does not send a no-match claim after its source expires unresolved",
      outcome: "NO_MATCH",
      monitoringState: "HEALTHY",
      markerState: "EXPIRED_TERMINAL",
      expectedStatus: "SUPPRESSED",
    },
    {
      description: "waits for a retryable source before sending a no-match claim",
      outcome: "NO_MATCH",
      monitoringState: "HEALTHY",
      markerState: "EXPIRED_RETRYABLE",
      expectedStatus: "FAILED",
    },
    {
      description: "waits for a retryable source before advertising an available match",
      outcome: "MATCH_FOUND",
      monitoringState: "HEALTHY",
      markerState: "EXPIRED_RETRYABLE",
      expectedStatus: "FAILED",
      advertisedMatch: true,
    },
  ])("$description", async ({ outcome, monitoringState, markerState, expectedStatus, advertisedMatch }) => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      displayMatchIds: advertisedMatch ? ["match-1"] : [],
      statusSnapshot: [{ courseId: "course-1", state: outcome }],
      statusReport: {
        kind: "setup",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [{
          courseId: "course-1",
          courseName: "Course",
          timeZone: "America/New_York",
          outcome,
          availableMatches: advertisedMatch ? 1 : 0,
          ...(advertisedMatch
            ? {
                matchingTimes: [
                  {
                    matchId: "match-1",
                    startsAt: "2026-07-16T08:00",
                    availableSpots: 4,
                  },
                ],
              }
            : {}),
        }],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "SETUP",
      groupKey: "status-group",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([{
        ...owner,
        status: expectedStatus,
        sentAt: expectedStatus === "SENT" ? now : null,
      }] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([{
      courseId: "course-1",
      outcome,
      observedAt: now,
    }] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([{
      courseId: "course-1",
      state: monitoringState,
      lastSuccessfulAt: monitoringState === "HEALTHY" ? now : null,
      lastFailureAt: monitoringState === "HEALTHY" ? null : now,
    }] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue(
      advertisedMatch ? [currentMatch] as never : [],
    );
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const text = rawSqlText(sql);
      if (text.includes('FROM "ProviderRequestLease"')) {
        const leaseExpiresAt = new Date(
          now.getTime() +
            (markerState === "ACTIVE"
              ? 2
              : markerState === "EXPIRED_RETRYABLE"
                ? -5
                : -11) *
              60_000,
        );
        return [{
          observationStartedAt: now,
          leaseExpiresAt,
          retryUntil: new Date(leaseExpiresAt.getTime() + 10 * 60_000),
          state: markerState,
        }] as never;
      }
      if (text.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });
    const drain = drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "SETUP",
      groupKey: "status-group",
      send,
      now: () => now,
    });

    if (expectedStatus === "FAILED") {
      await expect(drain).rejects.toMatchObject({
        code: "DELIVERY_PROVIDER_SOURCE_PENDING",
      });
    } else {
      await expect(drain).resolves.toContainEqual({
        id: "delivery-1",
        status: expectedStatus,
      });
    }
    expect(send).toHaveBeenCalledTimes(expectedStatus === "SENT" ? 1 : 0);
  });

  it.each([
    { secondOutcome: "MATCH_FOUND", secondAvailableMatches: 1, sends: false, description: "a second course claims a match" },
    { secondOutcome: "NEEDS_ADAPTER", secondAvailableMatches: 1, sends: false, description: "a second unsupported course reports availability" },
    { secondOutcome: "NO_MATCH", secondAvailableMatches: 0, sends: true, description: "a second course confirms no slots" },
  ])("handles a mixed setup when $description", async ({ secondOutcome, secondAvailableMatches, sends }) => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      displayMatchIds: [],
      statusSnapshot: [
        { courseId: "course-1", state: "NEEDS_ADAPTER" },
        { courseId: "course-2", state: secondOutcome === "MATCH_FOUND" ? "MATCH_FOUND:1" : secondOutcome },
      ],
      statusReport: {
        kind: "setup",
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
            outcome: "NEEDS_ADAPTER",
            availableMatches: 0,
          },
          {
            courseId: "course-2",
            courseName: "Second Course",
            timeZone: "America/New_York",
            outcome: secondOutcome,
            availableMatches: secondAvailableMatches,
            matchingTimes: [],
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "SETUP",
      groupKey: "status-group",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValue([{
        ...owner,
        status: "SENT",
        sentAt: now,
      }] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      currentCourse,
      { ...currentCourse, id: "course-2", name: "Second Course" },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "NEEDS_ADAPTER", observedAt: now },
      { courseId: "course-2", outcome: secondOutcome, observedAt: now },
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([]);
    let observationReads = 0;
    mockedPrisma.$queryRaw.mockImplementation(async (sql) => {
      const query = rawSqlText(sql);
      if (query.includes('FROM "ProviderRequestLease"')) {
        observationReads += 1;
        return observationReads === 1
          ? [{
              observationStartedAt: now,
              leaseExpiresAt: new Date(now.getTime() - 5 * 60_000),
              retryUntil: new Date(now.getTime() + 5 * 60_000),
              state: "EXPIRED_RETRYABLE",
            }] as never
          : [] as never;
      }
      if (query.includes('statement_timestamp() AS "currentTime"')) {
        return [{ currentTime: now }] as never;
      }
      return [currentSearch] as never;
    });
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    const drain = drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "SETUP",
      groupKey: "status-group",
      send,
      now: () => now,
    });
    if (sends) {
      await expect(drain).resolves.toContainEqual({
        id: "delivery-1",
        status: "SENT",
      });
    } else {
      await expect(drain).rejects.toMatchObject({
        code: "DELIVERY_PROVIDER_SOURCE_PENDING",
      });
    }
    expect(observationReads).toBe(2);
    expect(send).toHaveBeenCalledTimes(sends ? 1 : 0);
  });

  it.each([
    { staleAccess: false, knownReader: true, outcome: "NO_MATCH", sends: true },
    { staleAccess: true, knownReader: true, outcome: "NO_MATCH", sends: true },
    { staleAccess: true, knownReader: false, outcome: "NO_MATCH", sends: false },
    { staleAccess: true, knownReader: true, outcome: "NEEDS_ADAPTER", sends: false },
  ])("validates a public reader status against stored access ($staleAccess, $knownReader, $outcome)", async ({ staleAccess, knownReader, outcome, sends }) => {
    const bookingUrl =
      "https://grassyhill.cps.golf/onlineresweb/search-teetime";
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      displayMatchIds: [],
      statusSnapshot: [{ courseId: "course-1", state: "NO_MATCH" }],
      statusReport: {
        kind: "setup",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        requestedLayoutHoles: null,
        userTimeZone: "America/New_York",
        courses: [
          {
            courseId: "course-1",
            courseName: "Grassy Hill Country Club",
            timeZone: "America/New_York",
            bookingAccessMode: "PUBLIC_SIGNED_OUT",
            outcome: "NO_MATCH",
            availableMatches: 0,
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "SETUP",
      groupKey: "status-group",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: sends ? "SENT" : "SUPPRESSED", sentAt: sends ? now : null },
      ] as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        ...currentCourse,
        name: "Grassy Hill Country Club",
        detectedBookingUrl: knownReader ? bookingUrl : "https://booking.example/tee-times",
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        automationEligibility: staleAccess ? "NEEDS_REVIEW" : "BLOCKED",
        automationReason: staleAccess ? "OTHER" : "CAPTCHA_OR_QUEUE",
        intelligenceVerifiedAt: staleAccess ? null : new Date("2026-07-11T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-11T12:00:00.000Z"),
        intelligenceConfidence: 0.95,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome, observedAt: now },
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([]);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "SETUP",
        groupKey: "status-group",
        send,
        now: () => now,
      }),
    ).resolves.toContainEqual({ id: "delivery-1", status: sends ? "SENT" : "SUPPRESSED" });

    if (sends) {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ payload: statusPayload }));
    } else {
      expect(send).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      description:
        "sends a current status when optional provider details are omitted",
      optionalDetails: {},
      terminalStatus: "SENT" as const,
      shouldSend: true,
    },
    {
      description: "retires a status when a supplied provider price changed",
      optionalDetails: { priceCents: 4000 },
      terminalStatus: "SUPPRESSED" as const,
      shouldSend: false,
    },
  ])(
    "$description",
    async ({ optionalDetails, terminalStatus, shouldSend }) => {
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
                  ...optionalDetails,
                },
              ],
            },
          ],
        },
      };
      const owner = delivery("delivery-1", "owner@example.com", {
        kind: "DAILY",
        groupKey: "status-group",
        payload: statusPayload,
      });
      mockedPrisma.searchEmailDelivery.findMany
        .mockResolvedValueOnce([owner] as never)
        .mockResolvedValueOnce([
          {
            ...owner,
            status: terminalStatus,
            sentAt: shouldSend ? now : null,
          },
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
          intelligenceConfidence: null,
        },
      ] as never);
      mockedPrisma.courseProbe.findMany.mockResolvedValue([
        { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now },
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
          availabilityStatus: "AVAILABLE",
          availabilityCycle: 1,
          lastConfirmedAt: now,
        },
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
          now: () => now,
        }),
      ).resolves.toContainEqual({ id: "delivery-1", status: terminalStatus });

      if (shouldSend) {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ payload: statusPayload }),
        );
      } else {
        expect(send).not.toHaveBeenCalled();
      }
    },
  );

  it("suppresses a claimed daily report when a newer provider failure supersedes its displayed opening", async () => {
    const providerObservedAt = new Date(now.getTime() - 60_000);
    const failureObservedAt = new Date(now.getTime() - 30_000);
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: providerObservedAt.toISOString(),
      matchIds: [],
      matchRefs: [],
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
                startsAt: "2026-07-16T08:00",
                availableSpots: 4,
                priceCents: 6500,
                holes: 18,
              },
            ],
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        {
          ...owner,
          status: "SUPPRESSED",
          lastError: "MATCH_PROVIDER_SOURCE_SUPERSEDED",
        },
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { ...currentMatch, lastConfirmedAt: providerObservedAt },
    ] as never);
    mockedPrisma.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        lastSuccessfulAt: providerObservedAt,
        lastFailureAt: failureObservedAt,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        outcome: "MATCH_FOUND",
        observedAt: providerObservedAt,
      },
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
        now: () => now,
      }),
    ).resolves.toEqual([{ id: "delivery-1", status: "SUPPRESSED" }]);

    expect(send).not.toHaveBeenCalled();
    expect(mockedPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      "course-monitoring:course-1",
    );
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUPPRESSED",
          nextAttemptAt: null,
          lastError: "MATCH_PROVIDER_SOURCE_SUPERSEDED",
        }),
      }),
    );
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
            availableMatches: 1,
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload,
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
        intelligenceConfidence: null,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "MATCH_FOUND", observedAt: now },
    ] as never);
    mockedPrisma.teeTimeMatch.findMany
      .mockResolvedValueOnce([
        {
          id: "match-old",
          courseId: "course-1",
          alertStatus: "SENT",
          availabilityStatus: "AVAILABLE",
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          id: "match-new",
          courseId: "course-1",
          startsAt: new Date("2026-07-16T12:30:00.000Z"),
          availableSpots: 4,
          priceCents: 5000,
          holes: 18,
          alertStatus: "PENDING",
        },
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
        now: () => now,
      }),
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
            availableMatches: 0,
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SENT", sentAt: now },
      ] as never);
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
        intelligenceConfidence: null,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "NO_MATCH", observedAt: now },
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "old-date-match",
        courseId: "course-1",
        startsAt: new Date("2026-07-15T12:30:00.000Z"),
        availableSpots: 4,
        priceCents: 5000,
        holes: 18,
        alertStatus: "SENT",
      },
    ] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "DAILY",
      groupKey: "status-group",
      send,
      now: () => now,
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
            availableMatches: 0,
          },
        ],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      kind: "DAILY",
      groupKey: "status-group",
      payload: statusPayload,
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner] as never)
      .mockResolvedValueOnce([
        { ...owner, status: "SENT", sentAt: now },
      ] as never);
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
        intelligenceConfidence: null,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-1", outcome: "FETCH_FAILED", observedAt: now },
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "uncertain-match",
        courseId: "course-1",
        startsAt: new Date("2026-07-16T12:30:00.000Z"),
        availableSpots: 4,
        priceCents: 5000,
        holes: 18,
        alertStatus: "SUPPRESSED",
      },
    ] as never);
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" });

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "DAILY",
      groupKey: "status-group",
      send,
      now: () => now,
    });

    expect(send).toHaveBeenCalledOnce();
  });

  it("finalizes a pre-send stale-suppressed group without suppressing its pending match", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        status: "SUPPRESSED",
        sentAt: null,
      }),
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "match-group",
      }),
    ).resolves.toEqual({
      finalized: true,
      status: "SUPPRESSED",
      ownerSent: false,
      ownerDeliveryOutcome: "SAFETY_SUPPRESSED",
      retainedMatchCount: 0,
      sentMatchCount: 0,
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("persists a one-minute Workflow recheck after a group send failure", async () => {
    const owner = delivery("delivery-1", "owner@example.com");
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    const sendError = new Error(
      "Provider failed for owner@example.com at https://provider.example/send?token=secret",
    );

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send: vi.fn().mockRejectedValue(sendError),
        now: () => now,
      }),
    ).rejects.toBe(sendError);
    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 60_000),
          lastError:
            "DELIVERY_OUTCOME_UNKNOWN:Provider failed for [email] at [url]",
        }),
      }),
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("caps exponential delivery retries at ten minutes", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      attemptCount: 12,
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    const sendError = new Error("provider unavailable");

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send: vi.fn().mockRejectedValue(sendError),
        now: () => now,
      }),
    ).rejects.toBe(sendError);

    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 10 * 60_000),
        }),
      }),
    );
    expect(executeRawCallsContaining('"recheckRequestedAt"')).toHaveLength(1);
  });

  it("backs off a typed daily quota failure for 24 hours", async () => {
    const owner = delivery("delivery-1", "owner@example.com", {
      attemptCount: 12,
    });
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      owner,
    ] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    const sendError = new EmailDeliveryNotAcceptedError(
      "You have reached your daily email sending quota.",
      "daily_quota_exceeded",
    );

    await expect(
      drainSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        checkLeaseToken: "check-lease",
        kind: "MATCH",
        groupKey: "match-group",
        send: vi.fn().mockRejectedValue(sendError),
        now: () => now,
      }),
    ).rejects.toBe(sendError);

    expect(
      mockedPrisma.searchEmailDelivery.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 24 * 60 * 60_000),
          lastError:
            "DELIVERY_NOT_ACCEPTED:You have reached your daily email sending quota.",
        }),
      }),
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
        {
          ...friend,
          status: "FAILED",
          nextAttemptAt: new Date(now.getTime() + 60_000),
        },
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
        now: () => now,
      }),
    ).rejects.toBe(friendError);
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { alertStatus: "SENT", sentAt: now } }),
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
      startsAt: "2026-07-16T13:00:00.000Z",
    };
    const partialPayload = {
      ...payload,
      matchIds: ["match-1", "match-2"],
      matchRefs: [
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 7 },
      ],
      displayMatchIds: ["match-1", "match-2"],
      matchReport: {
        ...payload.matchReport,
        matches: [oldRow, survivingRow],
      },
    };
    const owner = delivery("delivery-1", "owner@example.com", {
      payload: partialPayload,
      status: "SENT",
      sentAt: now,
      attemptCount: 1,
    });
    const friend = delivery("delivery-2", "friend@example.com", {
      payload: partialPayload,
      status: "FAILED",
      attemptCount: 1,
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected",
      nextAttemptAt: new Date(now.getTime() - 1),
    });
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([owner, friend] as never)
      .mockResolvedValueOnce([
        owner,
        { ...friend, status: "SUPPRESSED", nextAttemptAt: null },
      ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-2",
        courseId: "course-2",
        alertStatus: "SENT",
        availabilityStatus: "AVAILABLE",
        availabilityCycle: 7,
      },
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
        intelligenceConfidence: null,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-2", outcome: "MATCH_FOUND", observedAt: now },
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
        now: () => now,
      }),
    ).resolves.toEqual([
      { id: "delivery-1", status: "SENT" },
      { id: "delivery-2", status: "SUPPRESSED" },
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
            displayMatchIds: ["match-2"],
          }),
        }),
      }),
    );
    expect(mockedPrisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it("rekeys a definitively not-accepted recipient catch-up to its current subset", async () => {
    const firstRow = payload.matchReport.matches[0];
    const secondRow = {
      ...firstRow,
      matchId: "match-2",
      courseId: "course-2",
      courseName: "Second Course",
    };
    const catchupPayload = {
      ...payload,
      recipientCatchup: true,
      matchIds: ["match-1", "match-2"],
      matchRefs: [
        { matchId: "match-1", availabilityCycle: 7 },
        { matchId: "match-2", availabilityCycle: 8 },
      ],
      displayMatchIds: ["match-1", "match-2"],
      matchReport: { ...payload.matchReport, matches: [firstRow, secondRow] },
    };
    const friend = delivery("delivery-2", "friend@example.com", {
      isOwnerRecipient: false,
      payload: catchupPayload,
      status: "FAILED",
      nextAttemptAt: new Date(now.getTime() - 1),
      attemptCount: 1,
      lastError: "DELIVERY_NOT_ACCEPTED:provider rejected",
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
        availabilityCycle: 8,
      },
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
        intelligenceConfidence: null,
      },
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      { courseId: "course-2", outcome: "MATCH_FOUND", observedAt: now },
    ] as never);

    await drainSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      checkLeaseToken: "check-lease",
      kind: "MATCH",
      groupKey: "catchup-old",
      send: vi.fn(),
      now: () => now,
    });

    expect(mockedPrisma.searchEmailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: "friend@example.com",
          payload: expect.objectContaining({
            recipientCatchup: true,
            matchIds: ["match-2"],
          }),
        }),
      }),
    );
    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["delivery-2"] } },
        data: expect.objectContaining({
          status: "SUPPRESSED",
          claimToken: null,
          claimExpiresAt: null,
        }),
      }),
    );
  });

  it("finalizes the owner outcome while an additional recipient remains retryable", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        status: "SENT",
        sentAt: now,
      }),
      delivery("delivery-2", "friend@example.com", { status: "FAILED" }),
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "match-group",
      }),
    ).resolves.toEqual({
      finalized: false,
      reason: "not_terminal",
      ownerFinalized: true,
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertStatus: { in: ["PENDING", "SUPPRESSED"] },
        }),
        data: { alertStatus: "SENT", sentAt: now },
      }),
    );
    expect(
      mockedPrisma.teeTimeMatch.updateMany.mock.calls[0]?.[0].where,
    ).not.toHaveProperty("availabilityStatus");
  });

  it("does not record a match send timestamp for a dry-run owner outcome", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        status: "SUPPRESSED",
        sentAt: now,
        lastError: "DELIVERY_DRY_RUN",
      }),
    ] as never);

    await finalizeSearchEmailDeliveryGroup({
      searchId: "search-1",
      alertGeneration: 3,
      kind: "MATCH",
      groupKey: "match-group",
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ alertStatus: "PENDING" }),
        data: { alertStatus: "SUPPRESSED", sentAt: null },
      }),
    );
  });

  it("keeps a seeded terminal owner nonblocking while an additional recipient retries", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        status: "SUPPRESSED",
        sentAt: now,
        lastError: "STATUS_RECIPIENT_PRIOR_REACHED",
      }),
      delivery("delivery-2", "friend@example.com", { status: "FAILED" }),
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "match-group",
      }),
    ).resolves.toEqual({
      finalized: false,
      reason: "not_terminal",
      ownerFinalized: true,
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
  });

  it("finalizes an ownerless recipient catch-up without blocking on or mutating owner state", async () => {
    const catchupPayload = {
      ...payload,
      recipientCatchup: true,
      satisfiesStatusReport: false,
    };
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("friend-catchup", "friend@example.com", {
        isOwnerRecipient: false,
        groupKey: "catchup-group",
        payload: catchupPayload,
        status: "SENT",
        sentAt: now,
      }),
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "catchup-group",
      }),
    ).resolves.toEqual({
      finalized: true,
      status: "SENT",
      ownerSent: false,
      ownerDeliveryOutcome: null,
      retainedMatchCount: 0,
      sentMatchCount: 0,
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("requires the owner recipient SENT before marking matches or status globally sent", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        status: "SUPPRESSED",
        sentAt: now,
      }),
      delivery("delivery-2", "friend@example.com", {
        status: "SENT",
        sentAt: now,
      }),
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "match-group",
      }),
    ).resolves.toEqual({
      finalized: true,
      status: "SUPPRESSED",
      ownerSent: false,
      ownerDeliveryOutcome: "SAFETY_SUPPRESSED",
      retainedMatchCount: 0,
      sentMatchCount: 0,
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.update).not.toHaveBeenCalled();
  });

  it("atomically satisfies the status report from the MATCH payload after all recipients finish", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        status: "SENT",
        sentAt: now,
      }),
      delivery("delivery-2", "friend@example.com", {
        status: "SUPPRESSED",
        sentAt: now,
      }),
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MATCH",
        groupKey: "match-group",
      }),
    ).resolves.toEqual({
      finalized: true,
      status: "SENT",
      ownerSent: true,
      ownerDeliveryOutcome: "SENT",
      retainedMatchCount: 1,
      sentMatchCount: 1,
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { alertStatus: "SENT", sentAt: now } }),
    );
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "search-1", alertGeneration: 3,
          OR: [{ statusEmailSentAt: null }, { statusEmailSentAt: { lt: now } }] },
        data: {
          statusEmailSentAt: now,
          statusEmailSnapshot: payload.statusSnapshot,
        },
      }),
    );
  });

  it("fences an old owner MATCH status while its additional recipient finishes later", async () => {
    const ownerSentAt = new Date(now.getTime() - 60_000);
    mockedPrisma.$queryRaw.mockResolvedValue([{ ...currentSearch, statusEmailSentAt: now }] as never);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("old-owner", "owner@example.com", { status: "SENT", sentAt: ownerSentAt }),
      delivery("retried-friend", "friend@example.com", { status: "SENT", sentAt: now }),
    ] as never);
    await finalizeSearchEmailDeliveryGroup({ searchId: "search-1", alertGeneration: 3,
      kind: "MATCH", groupKey: "match-group" });
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "search-1", alertGeneration: 3,
        OR: [{ statusEmailSentAt: null }, { statusEmailSentAt: { lt: ownerSentAt } }] },
      data: expect.objectContaining({ statusEmailSentAt: ownerSentAt }),
    }));
  });

  it("treats a monitoring status update as a durable status delivery", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      statusSnapshot: [
        {
          courseId: "course-1",
          courseName: "Course",
          state:
            "MANUAL_DIRECT:MANUAL_FINAL:NO_SUPPORT_STATUS:NONE:PHONE_ONLY:PHONE_ONLY",
          customerStatus: "FINAL_DIRECT_ACTION",
        },
      ],
      statusReport: {
        kind: "status-update",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        userTimeZone: "America/New_York",
        courses: [],
      },
    };
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        kind: "MONITORING_STATUS_UPDATE",
        groupKey: "status-update-group",
        payload: statusPayload,
        status: "SENT",
        sentAt: now,
      }),
      delivery("delivery-2", "friend@example.com", {
        kind: "MONITORING_STATUS_UPDATE",
        groupKey: "status-update-group",
        payload: statusPayload,
        status: "SUPPRESSED",
        sentAt: now,
      }),
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "MONITORING_STATUS_UPDATE",
        groupKey: "status-update-group",
      }),
    ).resolves.toEqual({
      finalized: true,
      status: "SENT",
      ownerSent: true,
      ownerDeliveryOutcome: "SENT",
      retainedMatchCount: 0,
      sentMatchCount: 0,
    });
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          statusEmailSentAt: now,
          statusEmailSnapshot: statusPayload.statusSnapshot,
        },
      }),
    );
  });

  it("retains the edited-generation clock while finalizing setup", async () => {
    const generationStartedAt = "2026-07-15T14:50:00.000Z";
    const statusSnapshot = [
      {
        courseId: "course-1",
        courseName: "Course",
        state: "NEEDS_ADAPTER:ACTIONABLE:IN_OPERATOR_QUEUE:NONE",
      },
    ];
    const setupPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      statusSnapshot,
      statusReport: {
        kind: "setup",
        targetDate: "2026-07-16",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        userTimeZone: "America/New_York",
        courses: [],
      },
    };
    mockedPrisma.$queryRaw.mockResolvedValue([
      {
        ...currentSearch,
        statusEmailSnapshot: {
          schemaVersion: 1,
          kind: "ALERT_GENERATION_START",
          alertGeneration: 3,
          generationStartedAt,
        },
      },
    ] as never);
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      delivery("delivery-1", "owner@example.com", {
        kind: "SETUP",
        groupKey: "setup-group",
        payload: setupPayload,
        status: "SENT",
        sentAt: now,
      }),
      delivery("delivery-2", "friend@example.com", {
        kind: "SETUP",
        groupKey: "setup-group",
        payload: setupPayload,
        status: "SUPPRESSED",
        sentAt: now,
      }),
    ] as never);

    await expect(
      finalizeSearchEmailDeliveryGroup({
        searchId: "search-1",
        alertGeneration: 3,
        kind: "SETUP",
        groupKey: "setup-group",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ finalized: true, ownerSent: true }),
    );
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          statusEmailSentAt: now,
          statusEmailSnapshot: {
            schemaVersion: 1,
            kind: "ALERT_GENERATION_STATUS",
            alertGeneration: 3,
            generationStartedAt,
            courseSnapshot: statusSnapshot,
          },
        },
      }),
    );
  });

  it("rejects URLs and secret-bearing keys in durable payloads", () => {
    expect(() =>
      assertSafeSearchEmailPayload({
        schemaVersion: 2,
        checkedAt: now.toISOString(),
        statusReport: { bookingUrl: "https://example.com/signed?token=value" },
      }),
    ).toThrow("booking URL contains session-specific data");
    expect(() =>
      assertSafeSearchEmailPayload({
        schemaVersion: 2,
        checkedAt: now.toISOString(),
        statusReport: {
          bookingUrl: "https://example.com/tee-times?date=2026-07-16",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeSearchEmailPayload({
        schemaVersion: 2,
        checkedAt: now.toISOString(),
        statusSnapshot: { token: "value" },
      }),
    ).toThrow("payload cannot contain token");
  });

  it("hydrates a match retry only from the immutable persisted snapshot", async () => {
    const first = await hydrateMatchAlertPayload({
      searchId: "search-1",
      alertGeneration: 3,
      payload,
    });
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        detectedBookingUrl: "https://changed.example",
        website: null,
      },
    ] as never);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      {
        id: "match-1",
        availableSpots: 1,
        bookingUrl: "https://changed.example",
      },
    ] as never);
    const retry = await hydrateMatchAlertPayload({
      searchId: "search-1",
      alertGeneration: 3,
      payload,
    });

    expect(retry).toEqual(first);
    expect(retry.matches[0]).toEqual(
      expect.objectContaining({
        availableSpots: 4,
        bookingUrl: "https://example.com/tee-times?date=2026-07-16",
        priceCents: 6500,
        factLine: "Public · 4.1 rating · 1.3 mi · 18H · $65",
        courseGuideUrl: "/courses/course",
      }),
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
            bookingUrl: "https://example.com/tee-times?date=2026-07-16",
          },
        ],
      },
    };

    const first = await hydrateSearchStatusEmailPayload(statusPayload);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-1",
        name: "Changed Course",
        website: "https://changed.example",
      },
    ] as never);
    mockedPrisma.teeSearch.findFirst.mockResolvedValue({
      id: "search-1",
      players: 4,
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
            bookingUrl: "https://example.com/tee-times?date=2026-07-16",
          }),
        ],
      }),
    );
    expect(mockedPrisma.course.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.findFirst).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.findMany).not.toHaveBeenCalled();
  });

  it("hydrates a factual-final monitoring status-update retry", async () => {
    const statusPayload = {
      schemaVersion: 2 as const,
      checkedAt: now.toISOString(),
      statusSnapshot: [
        {
          courseId: "course-1",
          courseName: "Course",
          state:
            "MANUAL_DIRECT:MANUAL_FINAL:NO_SUPPORT_STATUS:NONE:PHONE_ONLY:PHONE_ONLY",
          customerStatus: "FINAL_DIRECT_ACTION",
        },
      ],
      statusReport: {
        kind: "status-update",
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
            outcome: "MANUAL_DIRECT",
            availableMatches: 0,
            phone: "555-0100",
          },
        ],
      },
    };

    await expect(
      hydrateSearchStatusEmailPayload(statusPayload),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "status-update",
        players: 2,
        courses: [
          expect.objectContaining({
            courseId: "course-1",
            outcome: "MANUAL_DIRECT",
          }),
        ],
      }),
    );
  });

  it("accepts only public official booking URLs and rejects restricted or signed flows", () => {
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times?date=2026-07-16",
      ),
    ).toBe("https://course.example/tee-times?date=2026-07-16");
    expect(
      getSafeOfficialBookingUrl("https://course.example/checkout"),
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl("https://course.example/queue/wait"),
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times?session=private",
      ),
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times?bookingToken=private",
      ),
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times?next=/hop-one?next=/hop-two?next=http://127.0.0.1/private",
      ),
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times?redirect=https://provider.example/tee-times",
      ),
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times#https://evil.example/login",
      ),
    ).toBeUndefined();
    expect(
      getSafeOfficialBookingUrl(
        "https://course.example/tee-times?redirect=https:%5C%5Cevil.example%2Fpath",
      ),
    ).toBeUndefined();
    for (const sessionUrl of [
      "https://course.example/tee-times?JSESSIONID=private",
      "https://course.example/tee-times?PHPSESSID=private",
      "https://course.example/tee-times?ASPSESSIONIDABC123=private",
      "https://course.example/tee-times?sid=private",
      "https://course.example/tee-times?CFID=private&CFTOKEN=private",
      "https://course.example/tee-times?osCsid=private",
      "https://course.example/tee-times?connect.sid=private",
    ]) {
      expect(getSafeOfficialBookingUrl(sessionUrl)).toBeUndefined();
    }
    expect(
      getSafeOfficialBookingUrl(
        "https://user:password@course.example/tee-times",
      ),
    ).toBeUndefined();
    expect(getSafeOfficialBookingUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("lists retryable setup, match, and monitoring transition groups", async () => {
    mockedPrisma.searchEmailDelivery.findMany.mockResolvedValue([
      {
        kind: "MATCH",
        groupKey: "group-1",
        createdAt: new Date(now.getTime() - 2_000),
        isOwnerRecipient: true,
      },
      {
        kind: "MATCH",
        groupKey: "group-1",
        createdAt: new Date(now.getTime() - 2_000),
        isOwnerRecipient: false,
      },
      {
        kind: "SETUP",
        groupKey: "group-2",
        createdAt: new Date(now.getTime() - 1_000),
        isOwnerRecipient: true,
      },
    ] as never);

    await expect(
      listRetryableSearchEmailDeliveryGroups({
        searchId: "search-1",
        alertGeneration: 3,
      }),
    ).resolves.toEqual([
      {
        kind: "MATCH",
        groupKey: "group-1",
        createdAt: new Date(now.getTime() - 2_000),
        ownerRetryable: true,
      },
      {
        kind: "SETUP",
        groupKey: "group-2",
        createdAt: new Date(now.getTime() - 1_000),
        ownerRetryable: true,
      },
    ]);
    expect(mockedPrisma.searchEmailDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: {
            in: [
              "SETUP",
              "MATCH",
              "MONITORING_STATUS_UPDATE",
              "MONITORING_OUTAGE",
              "MONITORING_RECOVERY",
            ],
          },
        }),
      }),
    );
  });

  it("coalesces every durable stale-status request into one newest-kind replacement", async () => {
    mockedPrisma.searchEmailDelivery.findMany
      .mockResolvedValueOnce([
        {
          kind: "DAILY",
          groupKey: "status-group-2",
          createdAt: now,
        },
        {
          kind: "DAILY",
          groupKey: "status-group-1",
          createdAt: new Date(now.getTime() - 60_000),
        },
        {
          kind: "SETUP",
          groupKey: "setup-group",
          createdAt: new Date(now.getTime() - 120_000),
        },
      ] as never)
      .mockResolvedValueOnce([
        { isOwnerRecipient: true, status: "SENT", sentAt: now },
        { isOwnerRecipient: false, status: "SUPPRESSED", sentAt: null },
        { isOwnerRecipient: true, status: "SUPPRESSED", sentAt: now },
        { isOwnerRecipient: false, status: "SUPPRESSED", sentAt: null },
      ] as never);

    await expect(
      getPendingStatusEmailReplacement({
        searchId: "search-1",
        alertGeneration: 3,
      }),
    ).resolves.toEqual({
      kind: "DAILY",
      groups: [
        { kind: "DAILY", groupKey: "status-group-2" },
        { kind: "DAILY", groupKey: "status-group-1" },
        { kind: "SETUP", groupKey: "setup-group" },
      ],
      anyRecipientReached: true,
      ownerSent: true,
    });
  });
});
