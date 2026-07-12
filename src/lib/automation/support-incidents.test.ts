import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  teeSearch: { count: vi.fn() },
  courseSupportIncident: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  }
}));

const emailMocks = vi.hoisted(() => ({
  sendCourseSupportOperatorEmail: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/email/alerts", () => emailMocks);

import {
  reportCourseSupportIssue,
  resolveCourseSupportIncident,
  shouldEscalateCourseSupportIncident
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
  });

  it("opens a durable incident and immediately alerts the operator once", async () => {
    const opened = incident();
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    prismaMocks.courseSupportIncident.create.mockResolvedValue(opened);
    prismaMocks.courseSupportIncident.update.mockResolvedValue(
      incident({ ownerNotifiedAt: now })
    );

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

    expect(emailMocks.sendCourseSupportOperatorEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "opened",
        incidentId: "incident-1",
        courseName: "Pequabuck Golf Club"
      })
    );
    expect(result).toEqual({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING",
      ownerAlerted: true
    });
  });

  it("escalates an unresolved incident after thirty minutes", async () => {
    const firstSeenAt = new Date(now.getTime() - 31 * 60 * 1000);
    const existing = incident({ firstSeenAt, ownerNotifiedAt: firstSeenAt });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(existing);
    prismaMocks.courseSupportIncident.update
      .mockResolvedValueOnce(incident({ firstSeenAt, ownerNotifiedAt: firstSeenAt }))
      .mockResolvedValueOnce(
        incident({
          firstSeenAt,
          ownerNotifiedAt: firstSeenAt,
          status: "NEEDS_HUMAN",
          escalatedAt: now
        })
      )
      .mockResolvedValueOnce(
        incident({
          firstSeenAt,
          ownerNotifiedAt: firstSeenAt,
          status: "NEEDS_HUMAN",
          escalatedAt: now,
          escalationNotifiedAt: now
        })
      );

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

    expect(emailMocks.sendCourseSupportOperatorEmail).toHaveBeenCalledWith(
      expect.objectContaining({ event: "escalated" })
    );
    expect(result.status).toBe("NEEDS_HUMAN");
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

  it("does not age an unresolved incident out before the escalation threshold", () => {
    expect(
      shouldEscalateCourseSupportIncident(
        new Date("2026-07-12T13:31:00.000Z"),
        now
      )
    ).toBe(false);
    expect(
      shouldEscalateCourseSupportIncident(
        new Date("2026-07-12T13:30:00.000Z"),
        now
      )
    ).toBe(true);
  });
});
