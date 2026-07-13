import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  teeSearch: { count: vi.fn() },
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
    expect(result).toEqual(blocked);
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
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(existing);
    prismaMocks.courseSupportIncident.update
      .mockResolvedValueOnce(resolved)
      .mockResolvedValueOnce(incident({ ...resolved, resolutionNotifiedAt: now }));

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

});
