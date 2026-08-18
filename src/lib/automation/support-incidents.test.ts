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
    revision: 1,
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
    activeBatchId: null,
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
const unsupportedExampleMetadataFingerprint = buildProviderFailureFingerprint({
  providerFamilyKey: "example.com",
  failureClass: "UNSUPPORTED_FAMILY",
  operation: "METADATA",
  httpStatus: null
});
const chronogolfAuthFailureFingerprint = buildProviderFailureFingerprint({
  providerFamilyKey: "CHRONOGOLF",
  failureClass: "AUTH",
  operation: "AVAILABILITY",
  httpStatus: 401
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
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });
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
          escalationDeadlineAt: new Date(now.getTime() + 28 * 60 * 1000),
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
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(resolved)
      .mockResolvedValueOnce(reopened);

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

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "incident-1",
        cycle: 1,
        revision: 1,
        status: "RESOLVED",
        activeBatchId: null
      }),
      data: expect.objectContaining({
        engineeringOnly: false,
        activeRealSearchCount: 1,
        earliestTargetDate: now
      })
    });
  });

  it("does not let a disposable synthetic check close a historical real-demand incident", async () => {
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

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
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
    const existing = incident({
      firstSeenAt,
      kind: "FETCH_FAILED",
      providerFamilyKey: "CHRONOGOLF",
      failureClass: "AUTH",
      failureFingerprint: chronogolfAuthFailureFingerprint
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(existing);
    prismaMocks.courseSupportIncident.update.mockResolvedValueOnce(incident({ firstSeenAt }));

    const result = await reportCourseSupportIssue({
      course: {
        id: "course-1",
        name: "Pequabuck Golf Club",
        detectedPlatform: "CHRONOGOLF",
        detectedBookingUrl: "https://www.chronogolf.com/club/3563",
        website: "https://pequabuckgolf.com/"
      },
      searchId: "search-1",
      kind: "FETCH_FAILED",
      error: { status: 401 },
      now
    });

    expect(result.status).toBe("AUTO_INVESTIGATING");
    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledOnce();
  });

  it("keeps first-seen truthful while anchoring retry and escalation to the generation", async () => {
    const episodeStartedAt = new Date(now.getTime() - 4_000);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    prismaMocks.courseSupportIncident.create.mockResolvedValue(
      incident({ firstSeenAt: now })
    );

    await reportCourseSupportIssue({
      course: {
        ...foreupCourse,
        timeZone: "America/New_York"
      },
      searchId: "search-1",
      kind: "FETCH_FAILED",
      message: "The first provider attempt failed.",
      episodeStartedAt,
      now
    });

    expect(prismaMocks.courseSupportIncident.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstSeenAt: now,
          nextAttemptAt: new Date(episodeStartedAt.getTime() + 2 * 60 * 1000),
          escalationDeadlineAt: new Date(
            episodeStartedAt.getTime() + 28 * 60 * 1000
          )
        })
      })
    );
  });

  it("anchors a repaired missing deadline to the first degradation episode", async () => {
    const firstSeenAt = new Date(now.getTime() - 10 * 60 * 1000);
    const existing = incident({
      providerFamilyKey: "FOREUP",
      failureClass: "AUTH",
      failureFingerprint: authFailureFingerprint,
      platformSnapshot: "FOREUP",
      bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
      firstSeenAt,
      escalationDeadlineAt: null
    });
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(existing);
    prismaMocks.courseSupportIncident.update.mockResolvedValue(existing);

    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 401 },
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          escalationDeadlineAt: new Date(firstSeenAt.getTime() + 28 * 60 * 1000)
        })
      })
    );
  });

  it("does not reset a persisted endpoint deadline after setup delivery", async () => {
    const persistedDeadline = new Date(now.getTime() + 18 * 60 * 1000);
    const existing = incident({
      providerFamilyKey: "FOREUP",
      failureClass: "AUTH",
      failureFingerprint: authFailureFingerprint,
      platformSnapshot: "FOREUP",
      bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
      escalationDeadlineAt: persistedDeadline
    });
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(existing);
    prismaMocks.courseSupportIncident.update.mockResolvedValue(existing);

    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 401 },
      episodeStartedAt: now,
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          escalationDeadlineAt: persistedDeadline
        })
      })
    );
  });

  it("makes an unclaimed non-rate-limited incident due when real demand arrives", async () => {
    const nextAttemptAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const lastAttemptAt = new Date(now.getTime() - 60 * 60 * 1000);
    const engineeringOnly = incident({
      providerFamilyKey: "FOREUP",
      failureClass: "AUTH",
      failureFingerprint: authFailureFingerprint,
      platformSnapshot: "FOREUP",
      bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
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

  it("reopens source-unverified evidence when real customer demand arrives", async () => {
    const sourceUnverified = incident({
      status: "RESOLVED",
      resolution: "SOURCE_UNVERIFIED",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: missingSourceFingerprint,
      engineeringOnly: true,
      activeRealSearchCount: 0,
      resolvedAt: new Date("2026-07-20T12:00:00.000Z")
    });
    const reopened = incident({
      cycle: 2,
      status: "AUTO_INVESTIGATING",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: missingSourceFingerprint,
      engineeringOnly: false,
      activeRealSearchCount: 1
    });
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(sourceUnverified)
      .mockResolvedValueOnce(reopened);

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Customer Demand Course",
          detectedPlatform: "UNKNOWN",
          detectedBookingUrl: null,
          website: null
        },
        searchId: "search-public",
        kind: "NEEDS_ADAPTER",
        now
      })
    ).resolves.toMatchObject({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING"
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "incident-1",
        cycle: 1,
        revision: 1,
        status: "RESOLVED",
        resolution: "SOURCE_UNVERIFIED",
        activeBatchId: null
      }),
      data: expect.objectContaining({
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        engineeringOnly: false,
        activeRealSearchCount: 1,
        attemptCount: 0,
        resolution: null
      })
    });
  });

  it.each([
    "DIRECT_BOOKING_CLASSIFIED",
    "IDENTITY_CLASSIFIED"
  ] as const)(
    "does not overwrite a concurrently committed %s final while reopening source evidence",
    async (resolution) => {
      const staleSourceSnapshot = incident({
        status: "RESOLVED",
        resolution: "SOURCE_UNVERIFIED",
        providerFamilyKey: "SOURCE_MISSING",
        failureClass: "MISSING_SOURCE",
        failureFingerprint: missingSourceFingerprint,
        engineeringOnly: true,
        activeRealSearchCount: 0
      });
      const concurrentFinal = incident({
        cycle: 2,
        revision: 2,
        status: "RESOLVED",
        resolution,
        providerFamilyKey: "SOURCE_MISSING",
        failureClass: "MISSING_SOURCE",
        failureFingerprint: missingSourceFingerprint,
        engineeringOnly: false,
        activeRealSearchCount: 1,
        resolvedAt: now
      });
      mockRealDemand(1);
      prismaMocks.courseSupportIncident.findUnique
        .mockResolvedValueOnce(staleSourceSnapshot)
        .mockResolvedValueOnce(concurrentFinal);
      prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        reportCourseSupportIssue({
          course: {
            id: "course-1",
            name: "Concurrently Classified Course",
            detectedPlatform: "UNKNOWN",
            detectedBookingUrl: null,
            website: null
          },
          searchId: "search-public",
          kind: "NEEDS_ADAPTER",
          now
        })
      ).resolves.toEqual({
        incidentId: "incident-1",
        status: "UNRECORDED",
        ownerAlerted: false
      });

      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            cycle: 1,
            revision: 1,
            status: "RESOLVED",
            resolution: "SOURCE_UNVERIFIED",
            activeBatchId: null
          })
        })
      );
      expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    }
  );

  it("keeps an unchanged contact-only decision resolved", async () => {
    const finalIncident = incident({
      status: "RESOLVED",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      providerFamilyKey: "example.com",
      failureClass: "UNSUPPORTED_FAMILY",
      failureFingerprint: unsupportedExampleMetadataFingerprint,
      platformSnapshot: "UNKNOWN",
      bookingUrlSnapshot: "https://example.com/",
      resolvedAt: new Date("2026-07-20T12:00:00.000Z")
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(finalIncident);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Contact Course",
          timeZone: "America/New_York",
          detectedPlatform: "UNKNOWN",
          detectedBookingUrl: null,
          website: "https://example.com/",
          providerFamilyKey: "example.com"
        },
        searchId: "search-1",
        kind: "NEEDS_ADAPTER",
        now
      })
    ).resolves.toMatchObject({
      incidentId: "incident-1",
      status: "UNRECORDED"
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "RESOLVED" }),
        data: expect.not.objectContaining({ status: "AUTO_INVESTIGATING" })
      })
    );
  });

  it.each([
    "DIRECT_BOOKING_CLASSIFIED",
    "IDENTITY_CLASSIFIED"
  ] as const)(
    "keeps an authoritative %s decision resolved when a later failure shape changes",
    async (resolution) => {
      const finalIncident = incident({
        status: "RESOLVED",
        resolution,
        providerFamilyKey: "example.com",
        failureClass: "UNSUPPORTED_FAMILY",
        failureFingerprint: unsupportedExampleMetadataFingerprint,
        platformSnapshot: "UNKNOWN",
        bookingUrlSnapshot: "https://example.com/",
        resolvedAt: new Date("2026-07-20T12:00:00.000Z")
      });
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(finalIncident);
      prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        reportCourseSupportIssue({
          course: {
            id: "course-1",
            name: "Authoritatively Classified Course",
            timeZone: "America/New_York",
            detectedPlatform: "UNKNOWN",
            detectedBookingUrl: null,
            website: "https://example.com/",
            providerFamilyKey: "example.com"
          },
          searchId: "search-1",
          kind: "FETCH_FAILED",
          error: { status: 503 },
          now
        })
      ).resolves.toMatchObject({
        incidentId: "incident-1",
        status: "UNRECORDED"
      });

      expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "RESOLVED" }),
          data: expect.not.objectContaining({ status: "AUTO_INVESTIGATING" })
        })
      );
    }
  );

  it("keeps unchanged human review terminal after its retry time elapses", async () => {
    const laterNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const firstSeenAt = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const humanIncident = incident({
      cycle: 4,
      status: "NEEDS_HUMAN",
      providerFamilyKey: "example.com",
      failureClass: "UNSUPPORTED_FAMILY",
      failureFingerprint: unsupportedExampleMetadataFingerprint,
      platformSnapshot: "UNKNOWN",
      bookingUrlSnapshot: "https://example.com/",
      humanReviewReason: "SOURCE_UNVERIFIED",
      nextAttemptAt: now,
      attemptCount: 3,
      firstSeenAt
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(humanIncident);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Human Review Course",
          timeZone: "America/New_York",
          detectedPlatform: "UNKNOWN",
          detectedBookingUrl: null,
          website: "https://example.com/",
          providerFamilyKey: "example.com"
        },
        searchId: "search-1",
        kind: "NEEDS_ADAPTER",
        now: laterNow
      })
    ).resolves.toMatchObject({
      incidentId: "incident-1",
      status: "NEEDS_HUMAN"
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          cycle: expect.anything(),
          status: "AUTO_INVESTIGATING",
          attemptCount: 0,
          firstSeenAt: laterNow
        })
      })
    );
    const updateData = prismaMocks.courseSupportIncident.updateMany.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("cycle");
    expect(updateData).not.toHaveProperty("status");
    expect(updateData).not.toHaveProperty("attemptCount");
    expect(updateData).not.toHaveProperty("firstSeenAt");
  });

  it("promotes new real demand without reopening unchanged human review", async () => {
    const nextAttemptAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    mockRealDemand(2);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        cycle: 4,
        status: "NEEDS_HUMAN",
        providerFamilyKey: "FOREUP",
        failureClass: "AUTH",
        failureFingerprint: authFailureFingerprint,
        platformSnapshot: "FOREUP",
        bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
        engineeringOnly: true,
        activeRealSearchCount: 0,
        humanReviewReason: "ACCOUNT_REQUIRED",
        nextAttemptAt,
        attemptCount: 3
      })
    );
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      reportCourseSupportIssue({
        course: foreupCourse,
        searchId: "search-public",
        kind: "FETCH_FAILED",
        error: { status: 401 },
        now
      })
    ).resolves.toMatchObject({
      incidentId: "incident-1",
      status: "NEEDS_HUMAN"
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 4,
        status: "NEEDS_HUMAN",
        activeBatchId: null
      },
      data: expect.objectContaining({
        engineeringOnly: false,
        activeRealSearchCount: 2,
        occurrenceCount: { increment: 1 }
      })
    });
    const updateData = prismaMocks.courseSupportIncident.updateMany.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("cycle");
    expect(updateData).not.toHaveProperty("status");
    expect(updateData).not.toHaveProperty("attemptCount");
  });

  it.each([
    {
      change: "platform snapshot",
      previousPlatform: "CHRONOGOLF",
      previousBookingUrl: "https://www.chronogolf.com/club/3563",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: "https://www.chronogolf.com/club/3563"
    },
    {
      change: "booking-source snapshot",
      previousPlatform: "CHRONOGOLF",
      previousBookingUrl: "https://www.chronogolf.com/club/old-source",
      detectedPlatform: "CHRONOGOLF",
      detectedBookingUrl: "https://www.chronogolf.com/club/3563"
    }
  ] as const)("reopens parked human review for a changed $change", async (scenario) => {
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        cycle: 4,
        status: "NEEDS_HUMAN",
        providerFamilyKey: "CHRONOGOLF",
        failureClass: "AUTH",
        failureFingerprint: chronogolfAuthFailureFingerprint,
        platformSnapshot: scenario.previousPlatform,
        bookingUrlSnapshot: scenario.previousBookingUrl,
        humanReviewReason: "ACCOUNT_REQUIRED",
        nextReminderAt: now,
        decisionActorId: "operator-1",
        decisionAt: now,
        decisionNote: "Reviewed the prior source.",
        decisionEvidenceUrl: "https://example.com/evidence",
        decisionIdempotencyKey: "decision-1",
        ownerNotifiedAt: now,
        escalatedAt: now,
        escalationNotifiedAt: now,
        attemptCount: 3,
        lastAttemptAt: now
      })
    );
    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Changed Source Course",
          timeZone: "America/New_York",
          detectedPlatform: scenario.detectedPlatform,
          detectedBookingUrl: scenario.detectedBookingUrl,
          website: "https://course.example/"
        },
        searchId: "search-public",
        kind: "FETCH_FAILED",
        error: { status: 401 },
        now
      })
    ).resolves.toMatchObject({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING"
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 4,
        revision: 1,
        status: "NEEDS_HUMAN",
        activeBatchId: null
      },
      data: expect.objectContaining({
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        providerFamilyKey: "CHRONOGOLF",
        failureFingerprint: chronogolfAuthFailureFingerprint,
        courseNameSnapshot: "Changed Source Course",
        platformSnapshot: scenario.detectedPlatform,
        bookingUrlSnapshot: scenario.detectedBookingUrl,
        firstSeenAt: now,
        attemptCount: 0,
        lastAttemptAt: null,
        ownerNotifiedAt: null,
        escalatedAt: null,
        escalationNotifiedAt: null,
        humanReviewReason: null,
        nextReminderAt: null,
        decisionActorId: null,
        decisionAt: null,
        decisionNote: null,
        decisionEvidenceUrl: null,
        decisionIdempotencyKey: null
      })
    });
  });

  it("reopens parked human review when the provider family changes", async () => {
    const previousFailureFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "old-provider.example",
      failureClass: "UNSUPPORTED_FAMILY",
      operation: "METADATA",
      httpStatus: null
    });
    const nextFailureFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "new-provider.example",
      failureClass: "UNSUPPORTED_FAMILY",
      operation: "METADATA",
      httpStatus: null
    });
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        cycle: 4,
        status: "NEEDS_HUMAN",
        providerFamilyKey: "old-provider.example",
        failureClass: "UNSUPPORTED_FAMILY",
        failureFingerprint: previousFailureFingerprint,
        platformSnapshot: "UNKNOWN",
        bookingUrlSnapshot: null,
        humanReviewReason: "SOURCE_UNVERIFIED",
        nextReminderAt: now,
        attemptCount: 3
      })
    );
    await reportCourseSupportIssue({
      course: {
        id: "course-1",
        name: "Changed Provider Course",
        timeZone: "America/New_York",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: null,
        providerFamilyKey: "new-provider.example"
      },
      searchId: "search-public",
      kind: "NEEDS_ADAPTER",
      now
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 4,
        revision: 1,
        status: "NEEDS_HUMAN",
        activeBatchId: null
      },
      data: expect.objectContaining({
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        providerFamilyKey: "new-provider.example",
        failureFingerprint: nextFailureFingerprint,
        humanReviewReason: null,
        nextReminderAt: null,
        attemptCount: 0
      })
    });
  });

  it("does not detach a batch claimed after material-change evidence was read", async () => {
    const stale = incident({
      cycle: 4,
      revision: 7,
      status: "NEEDS_HUMAN",
      providerFamilyKey: "CHRONOGOLF",
      failureClass: "AUTH",
      failureFingerprint: chronogolfAuthFailureFingerprint,
      platformSnapshot: "CHRONOGOLF",
      bookingUrlSnapshot: "https://www.chronogolf.com/club/old-source",
      humanReviewReason: "ACCOUNT_REQUIRED"
    });
    const claimed = incident({
      cycle: 4,
      revision: 8,
      status: "AUTO_INVESTIGATING",
      activeBatchId: "batch-claimed-concurrently",
      providerFamilyKey: "CHRONOGOLF",
      failureClass: "AUTH",
      failureFingerprint: chronogolfAuthFailureFingerprint
    });
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(claimed);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      reportCourseSupportIssue({
        course: {
          id: "course-1",
          name: "Concurrently Claimed Course",
          timeZone: "America/New_York",
          detectedPlatform: "CHRONOGOLF",
          detectedBookingUrl: "https://www.chronogolf.com/club/new-source",
          website: "https://course.example/"
        },
        searchId: "search-public",
        kind: "FETCH_FAILED",
        error: { status: 401 },
        now
      })
    ).resolves.toEqual({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING",
      ownerAlerted: false
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "incident-1",
          cycle: 4,
          revision: 7,
          status: "NEEDS_HUMAN",
          activeBatchId: null
        },
        data: expect.objectContaining({ activeBatchId: null })
      })
    );
    expect(prismaMocks.courseSupportIncident.findUnique).toHaveBeenLastCalledWith({
      where: { id: "incident-1" }
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
        platformSnapshot: "FOREUP",
        bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
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
        platformSnapshot: "FOREUP",
        bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
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
        platformSnapshot: "FOREUP",
        bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
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
        platformSnapshot: "FOREUP",
        bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
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
        platformSnapshot: "FOREUP",
        bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
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
        platformSnapshot: "FOREUP",
        bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
        engineeringOnly: true,
        activeRealSearchCount: 0,
        nextAttemptAt: new Date(now.getTime() + 6 * 60 * 60 * 1000),
        attemptCount: 3,
        lastAttemptAt: new Date(now.getTime() - 60 * 60 * 1000)
      })
    );
    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 429, retryAfter: "1800" },
      now
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 1,
        revision: 1,
        status: "AUTO_INVESTIGATING",
        activeBatchId: null
      },
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

  it("starts a fresh retry and escalation ladder when the failure fingerprint changes", async () => {
    const oldEpisodeStartedAt = new Date(now.getTime() - 20 * 60 * 1000);
    mockRealDemand(1);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        status: "NEEDS_HUMAN",
        providerFamilyKey: "FOREUP",
        failureClass: "RATE_LIMIT",
        failureFingerprint: rateLimitFailureFingerprint,
        platformSnapshot: "FOREUP",
        bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
        humanReviewReason: "ACCOUNT_REQUIRED",
        nextReminderAt: now,
        attemptCount: 3,
        firstSeenAt: oldEpisodeStartedAt,
        escalationDeadlineAt: new Date(
          oldEpisodeStartedAt.getTime() + 28 * 60 * 1000
        )
      })
    );
    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 401 },
      episodeStartedAt: oldEpisodeStartedAt,
      now
    });

    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 1,
        revision: 1,
        status: "NEEDS_HUMAN",
        activeBatchId: null
      },
      data: expect.objectContaining({
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        firstSeenAt: now,
        attemptCount: 0,
        humanReviewReason: null,
        nextReminderAt: null,
        nextAttemptAt: new Date(now.getTime() + 2 * 60 * 1000),
        escalationDeadlineAt: new Date(now.getTime() + 28 * 60 * 1000),
        failureFingerprint: authFailureFingerprint
      })
    });
  });

  it("starts a fresh ladder when the same failure returns after monitoring recovery", async () => {
    const oldEpisodeStartedAt = new Date(now.getTime() - 20 * 60 * 1000);
    mockRealDemand(1);
    const restored = incident({
        status: "RESOLVED",
        resolution: "MONITORING_RESTORED",
        resolvedAt: new Date(now.getTime() - 60 * 1000),
        providerFamilyKey: "FOREUP",
        failureClass: "AUTH",
        failureFingerprint: authFailureFingerprint,
        platformSnapshot: "FOREUP",
        bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
        firstSeenAt: oldEpisodeStartedAt,
        escalationDeadlineAt: new Date(
          oldEpisodeStartedAt.getTime() + 28 * 60 * 1000
        )
      });
    const reopened = incident({
        cycle: 2,
        providerFamilyKey: "FOREUP",
        failureClass: "AUTH",
        failureFingerprint: authFailureFingerprint,
        firstSeenAt: now
      });
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(restored)
      .mockResolvedValueOnce(reopened);

    await reportCourseSupportIssue({
      course: foreupCourse,
      searchId: "search-public",
      kind: "FETCH_FAILED",
      error: { status: 401 },
      episodeStartedAt: oldEpisodeStartedAt,
      now
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "incident-1",
        cycle: 1,
        revision: 1,
        status: "RESOLVED",
        resolution: "MONITORING_RESTORED",
        activeBatchId: null
      }),
      data: expect.objectContaining({
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        firstSeenAt: now,
        nextAttemptAt: new Date(now.getTime() + 2 * 60 * 1000),
        escalationDeadlineAt: new Date(now.getTime() + 28 * 60 * 1000),
        failureFingerprint: authFailureFingerprint
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

  it("upgrades a resolved technical incident when fresh factual evidence is recorded", async () => {
    const technical = incident({
      status: "RESOLVED",
      resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
      resolvedAt: new Date(now.getTime() - 60_000),
      revision: 4
    });
    const factual = incident({
      status: "RESOLVED",
      resolution: "IDENTITY_CLASSIFIED",
      resolutionMessage: "Fresh official evidence confirms the identity.",
      resolvedAt: now,
      revision: 5
    });
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(technical)
      .mockResolvedValueOnce(technical)
      .mockResolvedValueOnce(factual);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      resolveCourseSupportIncident({
        courseId: "course-1",
        resolution: "IDENTITY_CLASSIFIED",
        message: "Fresh official evidence confirms the identity.",
        now
      })
    ).resolves.toEqual(factual);

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        status: "RESOLVED",
        activeBatchId: null,
        revision: 4,
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED"
      },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolution: "IDENTITY_CLASSIFIED",
        resolvedAt: now
      })
    });
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
    const generationStartedAt = new Date(now.getTime() - 5 * 60 * 1000);
    const owned = incident({
      activeBatchId: "batch-1",
      providerFamilyKey: "CHRONOGOLF",
      failureFingerprint: "claimed-fingerprint",
      engineeringOnly: true,
      activeRealSearchCount: 0,
      earliestTargetDate: null,
      firstSeenAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      escalationDeadlineAt: new Date(now.getTime() - 47.5 * 60 * 60 * 1000)
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
        episodeStartedAt: generationStartedAt,
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
        lastSeenAt: now,
        escalationDeadlineAt: new Date(
          generationStartedAt.getTime() + 28 * 60 * 1000
        )
      })
    });
    const promotionData = prismaMocks.courseSupportIncident.updateMany.mock.calls[0][0].data;
    expect(promotionData).not.toHaveProperty("nextAttemptAt");
    expect(promotionData).not.toHaveProperty("cycle");
    expect(promotionData).not.toHaveProperty("failureFingerprint");
    expect(promotionData).not.toHaveProperty("activeBatchId");
  });

  it("invalidates owned proof when the failure fingerprint changes without demand", async () => {
    const ownedUpdatedAt = new Date(now.getTime() - 60_000);
    const ownedLastSeenAt = new Date(now.getTime() - 2 * 60_000);
    const owned = incident({
      activeBatchId: "batch-1",
      providerFamilyKey: "FOREUP",
      failureClass: "AUTH",
      failureFingerprint: authFailureFingerprint,
      platformSnapshot: "FOREUP",
      bookingUrlSnapshot: foreupCourse.detectedBookingUrl,
      activeRealSearchCount: 0,
      occurrenceCount: 3,
      lastSeenAt: ownedLastSeenAt,
      updatedAt: ownedUpdatedAt
    });
    mockRealDemand(0);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(owned);

    await expect(
      reportCourseSupportIssue({
        course: foreupCourse,
        searchId: "search-public",
        kind: "FETCH_FAILED",
        error: { status: 429 },
        now
      })
    ).resolves.toEqual({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING",
      ownerAlerted: false
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 1,
        status: "AUTO_INVESTIGATING",
        activeBatchId: "batch-1",
        updatedAt: ownedUpdatedAt
      },
      data: {
        occurrenceCount: { increment: 1 },
        lastSeenAt: now,
        revision: { increment: 1 }
      }
    });
    const freshnessData = prismaMocks.courseSupportIncident.updateMany.mock.calls[0][0].data;
    expect(freshnessData).not.toHaveProperty("cycle");
    expect(freshnessData).not.toHaveProperty("status");
    expect(freshnessData).not.toHaveProperty("activeBatchId");
    expect(freshnessData).not.toHaveProperty("providerFamilyKey");
    expect(freshnessData).not.toHaveProperty("failureClass");
    expect(freshnessData).not.toHaveProperty("failureFingerprint");
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
