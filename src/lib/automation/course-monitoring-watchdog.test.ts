import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  courseMonitoringStatus: {
    findMany: vi.fn(),
    updateMany: vi.fn()
  },
  courseMonitoringEvent: {
    create: vi.fn()
  },
  courseSupportIncident: {
    create: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn()
  },
  teeSearch: {
    updateMany: vi.fn()
  }
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import { FAILURE_CONFIRMATION_WINDOW_MS, runCourseMonitoringWatchdog } from "./course-monitoring";

const now = new Date("2026-07-27T16:00:00.000Z");

function course(incident: Record<string, unknown> | null) {
  return {
    id: "course-1",
    name: "Example Public Golf Course",
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "SOURCE_MISSING",
    detectedBookingUrl: "https://course.example/book",
    website: "https://course.example",
    bookingAccessMode: "UNKNOWN",
    automationReason: "OTHER",
    timeZone: "America/New_York",
    supportIncident: incident,
    preferences: []
  };
}

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: "incident-1",
    reference: "csi_123456789012345678901234",
    courseId: "course-1",
    cycle: 1,
    revision: 0,
    status: "AUTO_INVESTIGATING",
    kind: "FETCH_FAILED",
    providerFamilyKey: "SOURCE_MISSING",
    failureClass: "UNKNOWN",
    failureFingerprint: "SOURCE_MISSING:UNKNOWN",
    courseNameSnapshot: "Example Public Golf Course",
    platformSnapshot: "UNKNOWN",
    bookingUrlSnapshot: "https://course.example/book",
    initialMessage: "Public check failed.",
    latestMessage: "Public check failed.",
    nextAction: "Retry safely.",
    affectedSearchCount: 1,
    occurrenceCount: 1,
    engineeringOnly: true,
    nextAttemptAt: now,
    confirmedAt: null,
    escalationDeadlineAt: null,
    humanReviewReason: null,
    nextReminderAt: null,
    decisionActorId: null,
    decisionAt: null,
    decisionNote: null,
    decisionEvidenceUrl: null,
    decisionIdempotencyKey: null,
    lastAttemptAt: null,
    attemptCount: 0,
    activeRealSearchCount: 0,
    earliestTargetDate: null,
    activeBatchId: null,
    firstSeenAt: new Date(now.getTime() - FAILURE_CONFIRMATION_WINDOW_MS),
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

describe("course monitoring watchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.$transaction.mockImplementation(
      async (
        input: Promise<unknown>[] | ((transaction: typeof prismaMocks) => Promise<unknown>)
      ) => (Array.isArray(input) ? Promise.all(input) : input(prismaMocks))
    );
    prismaMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1
    });
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1
    });
    prismaMocks.teeSearch.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.courseMonitoringEvent.create.mockResolvedValue({
      id: "event-1"
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([]);
  });

  it("turns an unconfirmed fifteen-minute gap into explicit tooling work", async () => {
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "DEGRADED_RETRYING",
        firstDegradedAt: new Date(now.getTime() - FAILURE_CONFIRMATION_WINDOW_MS),
        failureFingerprint: "SOURCE_MISSING:UNKNOWN",
        nextAutomaticAttemptAt: now,
        revision: 0,
        course: course(incident())
      }
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 1,
      escalated: 0
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "BLOCKED_TOOLING",
          confirmedAt: now,
          nextAttemptAt: now
        })
      })
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "TOOLING_INCIDENT",
          fromState: "DEGRADED_RETRYING",
          toState: "AUTO_INVESTIGATING"
        })
      })
    );
  });

  it("keeps a due human decision terminal instead of requeueing it", async () => {
    const humanIncident = incident({
      status: "NEEDS_HUMAN",
      confirmedAt: new Date("2026-07-27T10:00:00.000Z"),
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      nextReminderAt: new Date("2026-07-28T10:00:00.000Z")
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        firstDegradedAt: new Date("2026-07-27T10:00:00.000Z"),
        failureFingerprint: "CPS:CHALLENGE",
        nextAutomaticAttemptAt: now,
        revision: 3,
        course: course(humanIncident)
      }
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
      remindersSent: 0
    });
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "AUTO_INVESTIGATING" }) })
    );
  });

  it("escalates an expired incident when the course status already advanced to review", async () => {
    const mismatchedIncident = incident({
      confirmedAt: new Date("2026-07-27T15:00:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z")
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
        failureFingerprint: "SOURCE_MISSING:UNKNOWN",
        nextAutomaticAttemptAt: null,
        revision: 7,
        course: course(mismatchedIncident)
      }
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
      escalated: 1
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          nextAttemptAt: null
        })
      })
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "ENGINEERING_VERIFICATION_NEEDED"
        }),
        data: expect.objectContaining({
          state: "ENGINEERING_VERIFICATION_NEEDED",
          nextAutomaticAttemptAt: null
        })
      })
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "HUMAN_REVIEW_REQUESTED",
          fromState: "ENGINEERING_VERIFICATION_NEEDED",
          toState: "ENGINEERING_VERIFICATION_NEEDED"
        })
      })
    );
  });

  it("keeps a due review visible without sending an operator reminder", async () => {
    const humanIncident = incident({
      status: "NEEDS_HUMAN",
      confirmedAt: new Date("2026-07-27T10:00:00.000Z"),
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      nextReminderAt: now,
      nextAttemptAt: now
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        firstDegradedAt: new Date("2026-07-27T10:00:00.000Z"),
        failureFingerprint: "CPS:CHALLENGE",
        nextAutomaticAttemptAt: now,
        revision: 3,
        course: course(humanIncident)
      }
    ]);
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([humanIncident]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
      remindersSent: 0
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          nextReminderAt: new Date("2026-08-03T16:00:00.000Z"),
          revision: { increment: 1 }
        }
      })
    );
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "REMINDER_SENT" })
      })
    );
  });

  it("recovers a missed new-demand revalidation for a human-approved final", async () => {
    const activeDate = new Date("2026-08-02T00:00:00.000Z");
    const humanFinalIncident = incident({
      status: "RESOLVED",
      resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
      resolvedAt: new Date("2026-07-26T16:00:00.000Z"),
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      activeRealSearchCount: 0,
      earliestTargetDate: null
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "FINAL_TECHNICAL",
        stateChangedAt: new Date("2026-07-26T16:00:00.000Z"),
        firstDegradedAt: new Date("2026-07-26T10:00:00.000Z"),
        failureFingerprint: "CPS:CHALLENGE",
        revalidationRequestedAt: null,
        nextAutomaticAttemptAt: null,
        revision: 4,
        course: {
          ...course(humanFinalIncident),
          preferences: [
            {
              teeSearch: {
                date: activeDate,
                createdAt: new Date("2026-07-27T15:00:00.000Z")
              }
            }
          ]
        }
      }
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 1
    });
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "REVALIDATING_FINAL",
          revalidationRequestedAt: now,
          nextAutomaticAttemptAt: now
        })
      })
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          nextCheckAt: now,
          recheckRequestedAt: now
        }
      })
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          source: "RECOVERY_CRON"
        })
      })
    );
  });

  it("does not reopen a human-approved final for demand that already existed", async () => {
    const activeDate = new Date("2026-08-02T00:00:00.000Z");
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "FINAL_TECHNICAL",
        stateChangedAt: new Date("2026-07-27T15:30:00.000Z"),
        firstDegradedAt: null,
        failureFingerprint: null,
        revalidationRequestedAt: null,
        nextAutomaticAttemptAt: null,
        revision: 5,
        course: {
          ...course(
            incident({
              status: "RESOLVED",
              resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
              activeRealSearchCount: 1
            })
          ),
          preferences: [
            {
              teeSearch: {
                date: activeDate,
                createdAt: new Date("2026-07-27T14:00:00.000Z")
              }
            }
          ]
        }
      }
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0
    });
    expect(prismaMocks.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });
});
