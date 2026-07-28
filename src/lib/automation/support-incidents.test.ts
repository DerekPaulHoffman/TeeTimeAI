import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  teeSearch: { aggregate: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  courseSupportIncident: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  }
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import {
  escalateCourseSupportIncident,
  reportCourseSupportIssue,
  resolveCourseSupportIncident
} from "./support-incidents";
import { buildProviderFailureFingerprint } from "./provider-capabilities";

const now = new Date("2026-07-12T14:00:00.000Z");

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: "incident-1",
    reference: "csi_1234567890abcdef12345678",
    courseId: "course-1",
    firstAffectedSearchId: "search-1",
    cycle: 1,
    status: "AUTO_INVESTIGATING",
    kind: "NEEDS_ADAPTER",
    courseNameSnapshot: "Pequabuck Golf Club",
    platformSnapshot: "CHRONOGOLF",
    bookingUrlSnapshot: "https://www.chronogolf.com/club/3563",
    initialMessage: "No supported adapter yet",
    latestMessage: "No supported adapter yet",
    nextAction: "Inspect the official booking surface",
    affectedSearchCount: 1,
    occurrenceCount: 1,
    engineeringOnly: false,
    firstSeenAt: now,
    lastSeenAt: now,
    ownerNotifiedAt: null,
    escalatedAt: null,
    escalationNotifiedAt: null,
    resolvedAt: null,
    resolution: null,
    resolutionMessage: null,
    resolutionNotifiedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

const foreupCourse = {
  id: "course-1",
  name: "Shared Coverage Course",
  timeZone: "America/New_York",
  detectedPlatform: "FOREUP" as const,
  detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/1/1",
  website: "https://example.com/"
};

const authFailureFingerprint = buildProviderFailureFingerprint({
  providerFamilyKey: "FOREUP",
  failureClass: "AUTH",
  operation: "AVAILABILITY",
  httpStatus: 401
});

const rateLimitFailureFingerprint = buildProviderFailureFingerprint({
  providerFamilyKey: "FOREUP",
  failureClass: "RATE_LIMIT",
  operation: "AVAILABILITY",
  httpStatus: 429
});
const missingSourceFingerprint = buildProviderFailureFingerprint({
  providerFamilyKey: "SOURCE_MISSING",
  failureClass: "MISSING_SOURCE",
  operation: "METADATA",
  httpStatus: null
});

function mockRealDemand(count: number) {
  prismaMocks.teeSearch.findUnique.mockResolvedValue({
    trafficClass: "PUBLIC",
    syntheticMultiCycle: false
  });
  prismaMocks.teeSearch.count.mockResolvedValue(count);
  prismaMocks.teeSearch.aggregate.mockResolvedValue({
    _count: { id: count },
    _min: { date: count > 0 ? now : null }
  });
}

describe("course support incidents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker({
        $queryRawUnsafe: vi.fn().mockResolvedValue([{ locked: true }])
      })
    );
    prismaMocks.teeSearch.count.mockResolvedValue(1);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 1 },
      _min: { date: now }
    });
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "UNCLASSIFIED",
      syntheticMultiCycle: false
    });
  });

  it("opens a durable incident without alerting the operator before a retry", async () => {
    const opened = incident();
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    prismaMocks.courseSupportIncident.create.mockResolvedValue(opened);

    const result = await reportCourseSupportIssue({
      course: {
        id: "course-1",
        name: "Pequabuck Golf Club",
        detectedPlatform: "CHRONOGOLF",
        detectedBookingUrl: "https://www.chronogolf.com/club/3563",
        website: "https://pequabuckgolf.com/"
      },
      searchId: "search-1",
      kind: "NEEDS_ADAPTER",
      message: "No supported adapter yet",
      nextAction: "Inspect the official booking surface",
      now
    });

    expect(result).toEqual({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING",
      ownerAlerted: false
    });
    expect(prismaMocks.courseSupportIncident.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          confirmedAt: null,
          escalationDeadlineAt: null,
          nextAttemptAt: new Date(now.getTime() + 2 * 60 * 1000)
        })
      })
    );
    expect(prismaMocks.teeSearch.count).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-12T00:00:00.000Z") },
        OR: [{ trafficClass: { notIn: ["AUTOMATION", "TEST"] } }, { syntheticMultiCycle: true }],
        preferences: { some: { courseId: "course-1" } }
      }
    });
  });

  it("does not open support incidents for synthetic searches", async () => {
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "TEST",
      syntheticMultiCycle: false
    });
    prismaMocks.teeSearch.count.mockResolvedValue(0);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 0 },
      _min: { date: null }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Synthetic Course",
          detectedPlatform: "UNKNOWN",
          detectedBookingUrl: null,
          website: "https://example.com/"
        },
        searchId: "search-test",
        kind: "NEEDS_ADAPTER",
        now
      })
    ).resolves.toEqual({
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    });

    expect(prismaMocks.courseSupportIncident.create).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
  });

  it("opens an engineering-only incident for explicit multi-cycle synthetic coverage", async () => {
    const opened = incident({ engineeringOnly: true });
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "TEST",
      syntheticMultiCycle: true
    });
    prismaMocks.teeSearch.count.mockResolvedValue(1);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 0 },
      _min: { date: null }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    prismaMocks.courseSupportIncident.create.mockResolvedValue(opened);

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Synthetic Coverage Course",
          detectedPlatform: "UNKNOWN",
          detectedBookingUrl: null,
          website: "https://example.com/"
        },
        searchId: "search-multi-cycle",
        kind: "NEEDS_ADAPTER",
        now
      })
    ).resolves.toEqual({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING",
      ownerAlerted: false
    });

    expect(prismaMocks.courseSupportIncident.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        firstAffectedSearchId: "search-multi-cycle",
        affectedSearchCount: 1,
        engineeringOnly: true
      })
    });
  });

  it("opens a synthetic-sourced incident as real demand when a real alert already exists", async () => {
    const opened = incident({
      engineeringOnly: false,
      activeRealSearchCount: 1,
      earliestTargetDate: now
    });
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "TEST",
      syntheticMultiCycle: true
    });
    prismaMocks.teeSearch.count.mockResolvedValue(2);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 1 },
      _min: { date: now }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    prismaMocks.courseSupportIncident.create.mockResolvedValue(opened);

    await reportCourseSupportIssue({
      course: {
        id: "course-1",
        name: "Shared Coverage Course",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://example.com/"
      },
      searchId: "search-multi-cycle",
      kind: "NEEDS_ADAPTER",
      now
    });

    expect(prismaMocks.courseSupportIncident.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        engineeringOnly: false,
        activeRealSearchCount: 1,
        earliestTargetDate: now
      })
    });
  });

  it.each([
    ["30", "2026-07-12T14:01:00.000Z"],
    [String(3 * 24 * 60 * 60), "2026-07-13T14:00:00.000Z"]
  ])(
    "bounds an initial provider Retry-After of %s seconds between one minute and 24 hours",
    async (retryAfter, expectedNextAttemptAt) => {
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
      prismaMocks.courseSupportIncident.create.mockResolvedValue(incident());

      await reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Rate Limited Course",
          detectedPlatform: "FOREUP",
          detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/1/1",
          website: "https://example.com/"
        },
        searchId: "search-1",
        kind: "FETCH_FAILED",
        error: { status: 429, retryAfter },
        now
      });

      expect(prismaMocks.courseSupportIncident.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          failureClass: "RATE_LIMIT",
          nextAttemptAt: new Date(expectedNextAttemptAt)
        })
      });
    }
  );

  it("reopens a synthetic-sourced incident as real demand when a real alert exists", async () => {
    const resolved = incident({ status: "RESOLVED", engineeringOnly: true });
    const reopened = incident({
      cycle: 2,
      engineeringOnly: false,
      activeRealSearchCount: 1,
      earliestTargetDate: now
    });
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "TEST",
      syntheticMultiCycle: true
    });
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 1 },
      _min: { date: now }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(resolved);
    prismaMocks.courseSupportIncident.update.mockResolvedValue(reopened);

    await reportCourseSupportIssue({
      course: {
        id: "course-1",
        name: "Shared Coverage Course",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://example.com/"
      },
      searchId: "search-multi-cycle",
      kind: "NEEDS_ADAPTER",
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: expect.objectContaining({
        engineeringOnly: false,
        activeRealSearchCount: 1,
        earliestTargetDate: now
      })
    });
  });

  it("closes an unnotified synthetic-only incident without hiding real demand", async () => {
    const existing = incident();
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "AUTOMATION",
      syntheticMultiCycle: false
    });
    prismaMocks.teeSearch.count.mockResolvedValue(0);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 0 },
      _min: { date: null }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(existing);
    prismaMocks.courseSupportIncident.update.mockResolvedValue({
      ...existing,
      status: "RESOLVED",
      resolvedAt: now
    });

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Synthetic Course",
          detectedPlatform: "UNKNOWN",
          detectedBookingUrl: null,
          website: "https://example.com/"
        },
        searchId: "search-automation",
        kind: "NEEDS_ADAPTER",
        now
      })
    ).resolves.toEqual({
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolution: null,
        resolutionMessage: "Closed because this course has only synthetic test demand.",
        nextAction: null,
        lastSeenAt: now
      }
    });
  });

  it("leaves a shared real-demand incident open during a synthetic check", async () => {
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "TEST",
      syntheticMultiCycle: false
    });
    prismaMocks.teeSearch.count.mockResolvedValue(1);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(incident());

    await reportCourseSupportIssue({
      course: {
        id: "course-1",
        name: "Shared Course",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://example.com/"
      },
      searchId: "search-test",
      kind: "NEEDS_ADAPTER",
      now
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
  });

  it("keeps an old unresolved incident in autonomous remediation", async () => {
    const firstSeenAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const existing = incident({ firstSeenAt });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(existing);
    prismaMocks.courseSupportIncident.update.mockResolvedValueOnce(incident({ firstSeenAt }));

    const result = await reportCourseSupportIssue({
      course: {
        id: "course-1",
        name: "Pequabuck Golf Club",
        detectedPlatform: "CHRONOGOLF",
        detectedBookingUrl: null,
        website: "https://pequabuckgolf.com/"
      },
      searchId: "search-1",
      kind: "NEEDS_ADAPTER",
      now
    });

    expect(result.status).toBe("AUTO_INVESTIGATING");
    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledOnce();
  });

  it("makes an unclaimed non-rate-limited incident due when real demand arrives", async () => {
    const nextAttemptAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const lastAttemptAt = new Date(now.getTime() - 60 * 60 * 1000);
    const engineeringOnly = incident({
      providerFamilyKey: "FOREUP",
      failureClass: "AUTH",
      failureFingerprint: authFailureFingerprint,
      engineeringOnly: true,
      activeRealSearchCount: 0,
      nextAttemptAt,
      attemptCount: 3,
      lastAttemptAt
    });
    const promoted = incident({
      providerFamilyKey: "FOREUP",
      failureClass: "AUTH",
      failureFingerprint: authFailureFingerprint,
      engineeringOnly: false,
      affectedSearchCount: 2,
      activeRealSearchCount: 2,
      nextAttemptAt: now,
      attemptCount: 3,
      lastAttemptAt
    });
    mockRealDemand(2);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(engineeringOnly);
    prismaMocks.courseSupportIncident.update.mockResolvedValue(promoted);

    const result = await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 401 },
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: expect.objectContaining({
        affectedSearchCount: 2,
        engineeringOnly: false,
        failureClass: "AUTH",
        failureFingerprint: authFailureFingerprint,
        nextAttemptAt: now
      })
    });
    const updateData = prismaMocks.courseSupportIncident.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("cycle");
    expect(updateData).not.toHaveProperty("attemptCount");
    expect(updateData).not.toHaveProperty("lastAttemptAt");
    expect(result.incidentId).toBe("incident-1");
  });

  it("does not immediately reopen unchanged synthetic source-unverified evidence", async () => {
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "TEST",
      syntheticMultiCycle: true
    });
    prismaMocks.teeSearch.count.mockResolvedValue(1);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 0 },
      _min: { date: null }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        status: "RESOLVED",
        resolution: "SOURCE_UNVERIFIED",
        providerFamilyKey: "SOURCE_MISSING",
        failureFingerprint: missingSourceFingerprint,
        engineeringOnly: true
      })
    );

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Synthetic Coverage Course",
          detectedPlatform: "UNKNOWN",
          detectedBookingUrl: null,
          website: null
        },
        searchId: "search-multi-cycle",
        kind: "NEEDS_ADAPTER",
        now
      })
    ).resolves.toEqual({
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
  });

  it("promotes same-local-day western demand after UTC midnight", async () => {
    const transitionNow = new Date("2026-07-21T01:00:00.000Z");
    const nextAttemptAt = new Date("2026-07-21T07:00:00.000Z");
    mockRealDemand(1);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 1 },
      _min: { date: new Date("2026-07-20T00:00:00.000Z") }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        providerFamilyKey: "FOREUP",
        failureClass: "AUTH",
        failureFingerprint: authFailureFingerprint,
        engineeringOnly: true,
        activeRealSearchCount: 0,
        nextAttemptAt
      })
    );
    prismaMocks.courseSupportIncident.update.mockResolvedValue(
      incident({
        engineeringOnly: false,
        activeRealSearchCount: 1,
        nextAttemptAt: transitionNow
      })
    );

    await reportCourseSupportIssue({
      course: {
        ...foreupCourse,
        timeZone: "America/Los_Angeles"
      },
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 401 },
      now: transitionNow
    });

    const expectedBoundary = new Date("2026-07-20T00:00:00.000Z");
    expect(prismaMocks.teeSearch.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ date: { gte: expectedBoundary } })
      })
    );
    expect(prismaMocks.teeSearch.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ date: { gte: expectedBoundary } })
      })
    );
    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: expect.objectContaining({
        engineeringOnly: false,
        activeRealSearchCount: 1,
        nextAttemptAt: transitionNow
      })
    });
  });

  it("preserves the retry ladder for an incident that already has real demand", async () => {
    const nextAttemptAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    mockRealDemand(2);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        providerFamilyKey: "FOREUP",
        failureClass: "AUTH",
        failureFingerprint: authFailureFingerprint,
        engineeringOnly: false,
        activeRealSearchCount: 1,
        nextAttemptAt
      })
    );
    prismaMocks.courseSupportIncident.update.mockResolvedValue(
      incident({ engineeringOnly: false, nextAttemptAt })
    );

    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 401 },
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: expect.objectContaining({ nextAttemptAt })
    });
  });

  it("refreshes ended real demand without rewriting its provenance or retry history", async () => {
    const nextAttemptAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const lastAttemptAt = new Date(now.getTime() - 60 * 60 * 1000);
    mockRealDemand(0);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        providerFamilyKey: "FOREUP",
        failureClass: "AUTH",
        failureFingerprint: authFailureFingerprint,
        engineeringOnly: false,
        affectedSearchCount: 2,
        activeRealSearchCount: 1,
        earliestTargetDate: now,
        nextAttemptAt,
        attemptCount: 3,
        lastAttemptAt,
        ownerNotifiedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000)
      })
    );
    prismaMocks.courseSupportIncident.update.mockResolvedValue(
      incident({
        engineeringOnly: false,
        activeRealSearchCount: 0,
        earliestTargetDate: null,
        nextAttemptAt,
        attemptCount: 3,
        lastAttemptAt
      })
    );

    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 401 },
      now
    });

    const data = prismaMocks.courseSupportIncident.update.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({
        engineeringOnly: false,
        activeRealSearchCount: 0,
        earliestTargetDate: null,
        affectedSearchCount: 2,
        nextAttemptAt
      })
    );
    expect(data).not.toHaveProperty("cycle");
    expect(data).not.toHaveProperty("attemptCount");
    expect(data).not.toHaveProperty("lastAttemptAt");
    expect(data).not.toHaveProperty("ownerNotifiedAt");
  });

  it("preserves an unchanged rate-limit cooldown when real demand arrives", async () => {
    const nextAttemptAt = new Date(now.getTime() + 4 * 60 * 60 * 1000);
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        providerFamilyKey: "FOREUP",
        failureClass: "RATE_LIMIT",
        failureFingerprint: rateLimitFailureFingerprint,
        engineeringOnly: true,
        activeRealSearchCount: 0,
        nextAttemptAt
      })
    );
    prismaMocks.courseSupportIncident.update.mockResolvedValue(
      incident({ engineeringOnly: false, nextAttemptAt })
    );

    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 429, retryAfter: "7200" },
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: expect.objectContaining({
        engineeringOnly: false,
        failureClass: "RATE_LIMIT",
        failureFingerprint: rateLimitFailureFingerprint,
        nextAttemptAt
      })
    });
  });

  it("refreshes an expired rate-limit cooldown when real demand arrives", async () => {
    const expiredNextAttemptAt = new Date(now.getTime() - 60 * 1000);
    const expectedNextAttemptAt = new Date(now.getTime() + 30 * 60 * 1000);
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        providerFamilyKey: "FOREUP",
        failureClass: "RATE_LIMIT",
        failureFingerprint: rateLimitFailureFingerprint,
        engineeringOnly: true,
        activeRealSearchCount: 0,
        nextAttemptAt: expiredNextAttemptAt
      })
    );
    prismaMocks.courseSupportIncident.update.mockResolvedValue(
      incident({
        engineeringOnly: false,
        nextAttemptAt: expectedNextAttemptAt
      })
    );

    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 429, retryAfter: "1800" },
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: expect.objectContaining({
        engineeringOnly: false,
        failureClass: "RATE_LIMIT",
        failureFingerprint: rateLimitFailureFingerprint,
        nextAttemptAt: expectedNextAttemptAt
      })
    });
  });

  it("honors Retry-After when a real-demand promotion changes to rate limiting", async () => {
    const expectedNextAttemptAt = new Date(now.getTime() + 30 * 60 * 1000);
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        providerFamilyKey: "FOREUP",
        failureClass: "AUTH",
        failureFingerprint: authFailureFingerprint,
        engineeringOnly: true,
        activeRealSearchCount: 0,
        nextAttemptAt: new Date(now.getTime() + 6 * 60 * 60 * 1000),
        attemptCount: 3,
        lastAttemptAt: new Date(now.getTime() - 60 * 60 * 1000)
      })
    );
    prismaMocks.courseSupportIncident.update.mockResolvedValue(
      incident({
        engineeringOnly: false,
        nextAttemptAt: expectedNextAttemptAt
      })
    );

    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 429, retryAfter: "1800" },
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: expect.objectContaining({
        cycle: { increment: 1 },
        attemptCount: 0,
        lastAttemptAt: null,
        engineeringOnly: false,
        failureClass: "RATE_LIMIT",
        failureFingerprint: rateLimitFailureFingerprint,
        nextAttemptAt: expectedNextAttemptAt
      })
    });
  });

  it("escalates a concrete blocker into the durable operator queue", async () => {
    const blocked = incident({
      status: "NEEDS_HUMAN",
      latestMessage: "The provider requires a signed contract before public API access.",
      nextAction: "Approve the provider agreement.",
      escalatedAt: now
    });
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(incident())
      .mockResolvedValueOnce(incident());
    prismaMocks.courseSupportIncident.update.mockResolvedValue(blocked);

    const result = await escalateCourseSupportIncident({
      incidentId: "incident-1",
      message: "The provider requires a signed contract before public API access.",
      nextAction: "Approve the provider agreement.",
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: expect.objectContaining({
        status: "NEEDS_HUMAN",
        escalatedAt: now,
        lastSeenAt: now
      })
    });
    expect(result).toEqual(blocked);
  });

  it("persists human review for an engineering-only incident", async () => {
    const engineeringIncident = incident({ engineeringOnly: true });
    const escalated = incident({
      engineeringOnly: true,
      status: "NEEDS_HUMAN",
      latestMessage: "Provider access is unavailable.",
      nextAction: "Persist the final direct-booking classification.",
      escalatedAt: now
    });
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(engineeringIncident)
      .mockResolvedValueOnce(engineeringIncident);
    prismaMocks.courseSupportIncident.update.mockResolvedValue(escalated);

    const result = await escalateCourseSupportIncident({
      incidentId: "incident-1",
      message: "Provider access is unavailable.",
      nextAction: "Persist the final direct-booking classification.",
      now
    });

    expect(result).toEqual(escalated);
    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledOnce();
  });

  it("records resolution for the operator history without sending email", async () => {
    const existing = incident({ ownerNotifiedAt: now });
    const resolved = incident({
      status: "RESOLVED",
      ownerNotifiedAt: now,
      resolvedAt: now,
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      resolutionMessage: "Chronogolf reports online booking disabled."
    });
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(resolved);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1
    });
    await expect(resolveCourseSupportIncident({
      courseId: "course-1",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      message: "Chronogolf reports online booking disabled.",
      now
    })).resolves.toEqual(resolved);
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          resolutionMessage: "Chronogolf reports online booking disabled."
        })
      })
    );
  });

  it("does not resolve or detach an incident owned by a responder batch", async () => {
    const owned = incident({ activeBatchId: "batch-1" });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(owned);

    await expect(
      resolveCourseSupportIncident({
        courseId: "course-1",
        resolution: "MONITORING_RESTORED",
        message: "A normal search observed a successful check.",
        now
      })
    ).resolves.toMatchObject({ id: "incident-1", activeBatchId: "batch-1" });

    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
  });

  it("fences a resolution when responder ownership wins after the first read", async () => {
    const unowned = incident({ activeBatchId: null });
    const owned = incident({ activeBatchId: "batch-1" });
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(unowned)
      .mockResolvedValueOnce(owned);

    await expect(
      resolveCourseSupportIncident({
        courseId: "course-1",
        resolution: "MONITORING_RESTORED",
        message: "A normal search observed a successful check.",
        now
      })
    ).resolves.toBeNull();

    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
  });

  it("preserves a claimed incident cycle while promoting newly arrived real demand", async () => {
    const owned = incident({
      activeBatchId: "batch-1",
      providerFamilyKey: "CHRONOGOLF",
      failureFingerprint: "claimed-fingerprint",
      engineeringOnly: true,
      activeRealSearchCount: 0,
      earliestTargetDate: null
    });
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 1 },
      _min: { date: now }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(owned);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1
    });

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Pequabuck Golf Club",
          detectedPlatform: "CHRONOGOLF",
          detectedBookingUrl: "https://www.chronogolf.com/club/3563",
          website: "https://pequabuckgolf.com/"
        },
        searchId: "search-1",
        kind: "FETCH_FAILED",
        error: new Error("A newly shaped provider failure"),
        now
      })
    ).resolves.toEqual({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING",
      ownerAlerted: false
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 1,
        status: "AUTO_INVESTIGATING",
        activeBatchId: "batch-1",
        updatedAt: now
      },
      data: expect.objectContaining({
        engineeringOnly: false,
        activeRealSearchCount: 1,
        earliestTargetDate: now,
        lastSeenAt: now
      })
    });
    const promotionData = prismaMocks.courseSupportIncident.updateMany.mock.calls[0][0].data;
    expect(promotionData).not.toHaveProperty("nextAttemptAt");
    expect(promotionData).not.toHaveProperty("cycle");
    expect(promotionData).not.toHaveProperty("failureFingerprint");
    expect(promotionData).not.toHaveProperty("activeBatchId");
  });

  it("does not let a disposable synthetic check resolve an incident owned by a batch", async () => {
    const owned = incident({ activeBatchId: "batch-1" });
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "TEST",
      syntheticMultiCycle: false
    });
    prismaMocks.teeSearch.count.mockResolvedValue(0);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 0 },
      _min: { date: null }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(owned);

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Synthetic Course",
          detectedPlatform: "UNKNOWN",
          detectedBookingUrl: null,
          website: "https://example.com/"
        },
        searchId: "search-test",
        kind: "NEEDS_ADAPTER",
        now
      })
    ).resolves.toEqual({
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
  });
});
