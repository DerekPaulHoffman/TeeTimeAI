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

const emailMocks = vi.hoisted(() => ({
  sendCourseSupportOperatorEmail: vi.fn(),
  sendCourseSupportOperatorSummaryEmail: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/email/alerts", () => emailMocks);

import {
  escalateCourseSupportIncident,
  notifyCourseSupportIssueBatch,
  reportCourseSupportIssue,
  resolveCourseSupportIncident
} from "./support-incidents";

const now = new Date("2026-07-12T14:00:00.000Z");

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: "incident-1",
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

describe("course support incidents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker({ $queryRawUnsafe: vi.fn().mockResolvedValue([{ locked: true }]) })
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
    emailMocks.sendCourseSupportOperatorEmail.mockResolvedValue({
      id: "email-1",
      deliveryStatus: "sent"
    });
    emailMocks.sendCourseSupportOperatorSummaryEmail.mockResolvedValue({
      id: "email-summary-1",
      deliveryStatus: "sent"
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

    expect(emailMocks.sendCourseSupportOperatorEmail).not.toHaveBeenCalled();
    expect(emailMocks.sendCourseSupportOperatorSummaryEmail).not.toHaveBeenCalled();
    expect(result).toEqual({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING",
      ownerAlerted: false
    });
    expect(prismaMocks.teeSearch.count).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-12T00:00:00.000Z") },
        OR: [
          { trafficClass: { notIn: ["AUTOMATION", "TEST"] } },
          { syntheticMultiCycle: true }
        ],
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
    expect(emailMocks.sendCourseSupportOperatorEmail).not.toHaveBeenCalled();
    expect(emailMocks.sendCourseSupportOperatorSummaryEmail).not.toHaveBeenCalled();
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

    expect(emailMocks.sendCourseSupportOperatorEmail).not.toHaveBeenCalled();
    expect(emailMocks.sendCourseSupportOperatorSummaryEmail).not.toHaveBeenCalled();
    expect(result.status).toBe("AUTO_INVESTIGATING");
    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledOnce();
  });

  it("promotes an engineering-only incident when real demand arrives", async () => {
    const engineeringOnly = incident({ engineeringOnly: true });
    const promoted = incident({ engineeringOnly: false, affectedSearchCount: 2 });
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false
    });
    prismaMocks.teeSearch.count.mockResolvedValue(2);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 2 },
      _min: { date: now }
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(engineeringOnly);
    prismaMocks.courseSupportIncident.update.mockResolvedValue(promoted);

    const result = await reportCourseSupportIssue({
      course: {
        id: "course-1",
        name: "Shared Coverage Course",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://example.com/"
      },
      searchId: "search-public",
      kind: "NEEDS_ADAPTER",
      now
    });

    expect(prismaMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1" },
      data: expect.objectContaining({
        affectedSearchCount: 2,
        engineeringOnly: false
      })
    });
    expect(result.incidentId).toBe("incident-1");
  });

  it("escalates only after an automated remediation records a concrete blocker", async () => {
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
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([blocked]);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });

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
    expect(emailMocks.sendCourseSupportOperatorSummaryEmail).toHaveBeenCalledOnce();
    expect(prismaMocks.courseSupportIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ engineeringOnly: false })
      })
    );
    expect(result).toEqual(blocked);
  });

  it("does not escalate an engineering-only incident", async () => {
    const engineeringIncident = incident({ engineeringOnly: true });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(engineeringIncident);

    const result = await escalateCourseSupportIncident({
      incidentId: "incident-1",
      message: "Provider access is unavailable.",
      nextAction: "Persist the final direct-booking classification.",
      now
    });

    expect(result).toEqual(engineeringIncident);
    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(emailMocks.sendCourseSupportOperatorSummaryEmail).not.toHaveBeenCalled();
  });

  it("consolidates human-review incidents into one operator email", async () => {
    const first = incident({ status: "NEEDS_HUMAN", escalatedAt: now });
    const second = incident({
      id: "incident-2",
      courseId: "course-2",
      courseNameSnapshot: "Dennis Pines",
      status: "NEEDS_HUMAN",
      escalatedAt: now
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([first, second]);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 2 });

    const result = await notifyCourseSupportIssueBatch(
      ["incident-1", "incident-2"],
      now
    );

    expect(emailMocks.sendCourseSupportOperatorSummaryEmail).toHaveBeenCalledOnce();
    expect(emailMocks.sendCourseSupportOperatorSummaryEmail).toHaveBeenCalledWith({
      incidents: [
        expect.objectContaining({ incidentId: "incident-1" }),
        expect.objectContaining({ incidentId: "incident-2" })
      ]
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["incident-1", "incident-2"] } },
      data: { escalationNotifiedAt: now }
    });
    expect(result).toEqual({
      notifiedIncidentIds: ["incident-1", "incident-2"],
      pendingIncidentIds: []
    });
  });

  it("records resolution and sends a resolution email", async () => {
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
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.courseSupportIncident.update.mockResolvedValue(
      incident({ ...resolved, resolutionNotifiedAt: now })
    );

    await resolveCourseSupportIncident({
      courseId: "course-1",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      message: "Chronogolf reports online booking disabled.",
      now
    });

    expect(emailMocks.sendCourseSupportOperatorEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "resolved",
        resolution: "DIRECT_BOOKING_CLASSIFIED"
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
    expect(emailMocks.sendCourseSupportOperatorEmail).not.toHaveBeenCalled();
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
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });

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
