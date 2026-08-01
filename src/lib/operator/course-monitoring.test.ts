import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionMocks = vi.hoisted(() => ({
  course: {
    update: vi.fn()
  },
  courseMonitoringEvent: {
    create: vi.fn(),
    findUnique: vi.fn()
  },
  courseMonitoringStatus: {
    findUnique: vi.fn(),
    update: vi.fn()
  },
  courseSupportIncident: {
    findUnique: vi.fn(),
    update: vi.fn()
  }
}));

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  courseMonitoringEvent: {
    findUnique: vi.fn()
  },
  courseMonitoringStatus: {
    findFirst: vi.fn()
  },
  teeSearch: {
    findMany: vi.fn(),
    updateMany: vi.fn()
  }
}));

const localReaderMocks = vi.hoisted(() => ({
  queueLocalReaderCourseVerification: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/automation/search-scheduler", () => ({
  startSearchSchedule: vi.fn()
}));
vi.mock("@/lib/local-reader/service", () => localReaderMocks);

import {
  applyOperatorCourseDecision,
  correctOperatorCourseBookingLink,
  requestOperatorCourseRecheck,
  updateOperatorCourseOfficialLinks
} from "./course-monitoring";

const reference = "cm_123456789012345678901234";

function status() {
  return {
    courseId: "course-1",
    reference,
    state: "ENGINEERING_VERIFICATION_NEEDED",
    revision: 4,
    firstDegradedAt: new Date("2026-07-27T10:00:00.000Z"),
    course: {
      name: "Example Public Golf Course",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: "https://course.example/book",
      website: "https://course.example",
      providerFamilyKey: "SOURCE_MISSING",
      timeZone: "America/New_York",
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
      supportIncident: {
        id: "incident-1",
        cycle: 2,
        revision: 7,
        status: "NEEDS_HUMAN",
        activeRealSearchCount: 1,
        resolution: null,
        failureFingerprint: "SOURCE_MISSING:UNKNOWN"
      }
    }
  };
}

const context = {
  actorId: "user_clerk_operator",
  source: "OPERATOR_DASHBOARD" as const,
  apply: true,
  dispatchSearches: true
};

describe("operator course monitoring mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue(status());
    prismaMocks.teeSearch.findMany.mockResolvedValue([]);
    localReaderMocks.queueLocalReaderCourseVerification.mockResolvedValue(null);
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({ revision: 4 });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      cycle: 2,
      revision: 7
    });
    transactionMocks.courseSupportIncident.update.mockResolvedValue({
      id: "incident-1",
      failureFingerprint: "updated-fingerprint"
    });
    prismaMocks.$transaction.mockImplementation(
      async (callback: (transaction: typeof transactionMocks) => Promise<unknown>) =>
        callback(transactionMocks)
    );
  });

  it("rejects unsafe official links before reading course state", async () => {
    await expect(
      correctOperatorCourseBookingLink(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          bookingUrl: "https://user:secret@course.example/book",
          evidenceUrl: "https://course.example/evidence",
          note: "Verified from the official course website.",
          idempotencyKey: "operator-link-1234567890"
        },
        context
      )
    ).rejects.toThrow("without credentials");
    expect(prismaMocks.courseMonitoringStatus.findFirst).not.toHaveBeenCalled();
  });

  it("rejects stale status, incident cycle, or incident revision", async () => {
    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 6,
          note: "Retry the current public signed-out course surface.",
          idempotencyKey: "operator-recheck-123456"
        },
        context
      )
    ).rejects.toThrow("changed while this form was open");
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("treats an existing same-course idempotency key as a replay", async () => {
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue({
      courseId: "course-1"
    });

    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          note: "Retry the current public signed-out course surface.",
          idempotencyKey: "operator-recheck-123456"
        },
        context
      )
    ).resolves.toMatchObject({
      action: "request_recheck",
      applied: false,
      replayed: true
    });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an idempotency key already used by another course", async () => {
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue({
      courseId: "course-2"
    });

    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          note: "Retry the current public signed-out course surface.",
          idempotencyKey: "operator-recheck-123456"
        },
        context
      )
    ).rejects.toThrow("another course");
  });

  it("redacts sensitive note fragments and puts the guidance in the responder incident", async () => {
    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          note:
            "Verify https://course.example/book?id=customer-1 and reply to golfer@example.com.",
          idempotencyKey: "operator-recheck-123456"
        },
        context
      )
    ).resolves.toMatchObject({
      action: "request_recheck",
      applied: true,
      replayed: false
    });

    const safeNote = "Verify https://course.example and reply to [redacted-email].";
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7
      },
      data: {
        status: "AUTO_INVESTIGATING",
        humanReviewReason: null,
        nextReminderAt: null,
        nextAttemptAt: expect.any(Date),
        escalationDeadlineAt: expect.any(Date),
        lastSeenAt: expect.any(Date),
        nextAction: safeNote,
        revision: { increment: 1 }
      }
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        revision: 4
      },
      data: {
        state: "AUTO_INVESTIGATING",
        revalidationRequestedAt: expect.any(Date),
        nextAutomaticAttemptAt: expect.any(Date),
        stateChangedAt: expect.any(Date),
        revision: { increment: 1 }
      }
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        message: safeNote
      })
    });
  });

  it("releases a responder batch that was already closed before an operator recheck", async () => {
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      course: {
        ...status().course,
        supportIncident: {
          ...status().course.supportIncident,
          activeBatchId: "batch-closed",
          activeBatch: { status: "PARTIAL" }
        }
      }
    });

    await requestOperatorCourseRecheck(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        note: "Retry the current public signed-out course surface.",
        idempotencyKey: "operator-recheck-closed-batch"
      },
      context
    );

    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeBatchId: null })
      })
    );
  });

  it("does not release a responder batch that is still active", async () => {
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      course: {
        ...status().course,
        supportIncident: {
          ...status().course.supportIncident,
          activeBatchId: "batch-live",
          activeBatch: { status: "VERIFYING" }
        }
      }
    });

    await requestOperatorCourseRecheck(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        note: "Retry the current public signed-out course surface.",
        idempotencyKey: "operator-recheck-live-batch"
      },
      context
    );

    const update = transactionMocks.courseSupportIncident.update.mock.calls.at(-1)?.[0];
    expect(update.data).not.toHaveProperty("activeBatchId");
  });

  it("preserves a resolved final incident while requesting its bounded revalidation", async () => {
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      state: "FINAL_TECHNICAL",
      course: {
        ...status().course,
        supportIncident: {
          ...status().course.supportIncident,
          status: "RESOLVED"
        }
      }
    });

    await requestOperatorCourseRecheck(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        note: "Revalidate the prior technical decision against the public surface.",
        idempotencyKey: "operator-final-recheck-123456"
      },
      context
    );

    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7
      },
      data: {
        nextAttemptAt: expect.any(Date),
        lastSeenAt: expect.any(Date),
        nextAction: "Revalidate the prior technical decision against the public surface.",
        revision: { increment: 1 }
      }
    });
  });

  it("queues an immediate local-reader verification for a CPS course", async () => {
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      course: {
        ...status().course,
        detectedPlatform: "CUSTOM",
        detectedBookingUrl: "https://future-course.cps.golf/onlineresweb/search-teetime",
        providerFamilyKey: "CPS"
      }
    });
    prismaMocks.teeSearch.findMany.mockResolvedValue([
      {
        id: "search-1",
        date: new Date("2026-08-02T00:00:00.000Z"),
        players: 3
      }
    ]);
    localReaderMocks.queueLocalReaderCourseVerification.mockResolvedValue({
      id: "local-reader-job-1"
    });

    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          note: "Retry the rendered public CPS tee sheet.",
          idempotencyKey: "operator-recheck-cps-123456"
        },
        context
      )
    ).resolves.toMatchObject({
      action: "request_recheck",
      localReaderQueued: true,
      applied: true
    });

    expect(localReaderMocks.queueLocalReaderCourseVerification).toHaveBeenCalledWith({
      courseId: "course-1",
      targetDate: "2026-08-02",
      players: 3,
      bookingUrl: "https://future-course.cps.golf/onlineresweb/search-teetime",
      force: true
    });
  });

  it("saves both editable official links and immediately requests verification", async () => {
    await expect(
      updateOperatorCourseOfficialLinks(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          providerFamilyKey: "FOREUP",
          website: "https://new-course.example",
          bookingUrl: "https://new-course.example/tee-times",
          idempotencyKey: "operator-links-123456789"
        },
        context
      )
    ).resolves.toMatchObject({
      action: "update_official_links",
      applied: true,
      replayed: false
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        website: "https://new-course.example/",
        detectedBookingUrl: "https://new-course.example/tee-times",
        providerFamilyKey: "FOREUP",
        automationEligibility: "NEEDS_REVIEW"
      })
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        revision: 4
      },
      data: expect.objectContaining({
        state: "AUTO_INVESTIGATING",
        revalidationRequestedAt: expect.any(Date),
        nextAutomaticAttemptAt: expect.any(Date)
      })
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        evidenceUrl: "https://new-course.example/tee-times"
      })
    });
  });

  it("keeps a manually selected provider and queues verification when only it changes", async () => {
    await expect(
      updateOperatorCourseOfficialLinks(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          providerFamilyKey: "CPS",
          website: "https://course.example",
          bookingUrl: "https://course.example/book",
          idempotencyKey: "operator-provider-123456"
        },
        context
      )
    ).resolves.toMatchObject({
      action: "update_official_links",
      providerFamilyKey: "CPS",
      applied: true
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        providerFamilyKey: "CPS",
        detectedPlatform: "CUSTOM",
        automationEligibility: "NEEDS_REVIEW"
      })
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        revision: 4
      },
      data: expect.objectContaining({
        state: "AUTO_INVESTIGATING",
        revalidationRequestedAt: expect.any(Date)
      })
    });
  });

  it("records a private course as a final identity outcome", async () => {
    await expect(
      applyOperatorCourseDecision(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          decision: "PRIVATE_COURSE",
          idempotencyKey: "operator-private-123456"
        },
        context
      )
    ).resolves.toMatchObject({
      action: "set_course_outcome",
      decision: "PRIVATE_COURSE",
      applied: true
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        isPublic: false,
        automationEligibility: "BLOCKED",
        monitoringMode: "CONTACT_ONLY"
      })
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        revision: 4
      },
      data: expect.objectContaining({
        state: "FINAL_IDENTITY",
        nextAutomaticAttemptAt: null
      })
    });
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7
      },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolution: "IDENTITY_CLASSIFIED",
        humanReviewReason: null
      })
    });
  });

  it("marks a broken course website as temporary and schedules a retry", async () => {
    const retryStartedAt = Date.now();

    await expect(
      applyOperatorCourseDecision(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          decision: "WEBSITE_TEMPORARILY_UNAVAILABLE",
          idempotencyKey: "operator-temporary-123456"
        },
        context
      )
    ).resolves.toMatchObject({
      action: "set_course_outcome",
      decision: "WEBSITE_TEMPORARILY_UNAVAILABLE",
      retryAt: expect.any(Date),
      applied: true
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "TEMPORARILY_UNAVAILABLE",
        intelligenceReviewAt: expect.any(Date)
      })
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        revision: 4
      },
      data: expect.objectContaining({
        state: "DEGRADED_RETRYING",
        nextAutomaticAttemptAt: expect.any(Date),
        revalidationRequestedAt: null
      })
    });
    const retryAt = transactionMocks.courseMonitoringStatus.update.mock.calls.at(-1)?.[0]
      .data.nextAutomaticAttemptAt as Date;
    expect(retryAt.getTime()).toBeGreaterThanOrEqual(
      retryStartedAt + 6 * 60 * 60 * 1000
    );
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7
      },
      data: expect.objectContaining({
        status: "AUTO_INVESTIGATING",
        kind: "FETCH_FAILED",
        nextAttemptAt: retryAt,
        resolvedAt: null,
        resolution: null
      })
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "HUMAN_DECISION",
        toState: "DEGRADED_RETRYING",
        outcome: "FETCH_FAILED",
        audit: expect.objectContaining({
          decision: "WEBSITE_TEMPORARILY_UNAVAILABLE",
          timerBasedRevalidation: true
        })
      })
    });
  });

  it("routes the course to the local reader and queues a fresh reader check", async () => {
    localReaderMocks.queueLocalReaderCourseVerification.mockResolvedValue({
      id: "local-reader-job-2"
    });

    await expect(
      applyOperatorCourseDecision(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          decision: "LOCAL_READER",
          idempotencyKey: "operator-reader-1234567"
        },
        context
      )
    ).resolves.toMatchObject({
      action: "set_course_outcome",
      decision: "LOCAL_READER",
      localReaderQueued: true,
      applied: true
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        monitoringMode: "LOCAL_READER_ONLY",
        automationEligibility: "NEEDS_REVIEW"
      })
    });
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7
      },
      data: expect.objectContaining({
        status: "AUTO_INVESTIGATING",
        kind: "READER_CANDIDATE",
        failureClass: "READER_PARSER_MISSING"
      })
    });
    expect(localReaderMocks.queueLocalReaderCourseVerification).toHaveBeenCalledWith({
      courseId: "course-1",
      targetDate: expect.any(String),
      players: 2,
      bookingUrl: "https://course.example/book",
      force: true
    });
  });

  it("keeps engineering ownership when no compatible local reader job can be queued", async () => {
    localReaderMocks.queueLocalReaderCourseVerification.mockResolvedValue(null);

    await expect(
      applyOperatorCourseDecision(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          decision: "LOCAL_READER",
          idempotencyKey: "operator-reader-unsupported"
        },
        context
      )
    ).rejects.toThrow("not supported by the local tee-time reader yet");

    expect(localReaderMocks.queueLocalReaderCourseVerification).toHaveBeenCalledWith({
      courseId: "course-1",
      targetDate: expect.any(String),
      players: 2,
      bookingUrl: "https://course.example/book",
      force: true
    });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
    expect(transactionMocks.course.update).not.toHaveBeenCalled();
    expect(transactionMocks.courseMonitoringStatus.update).not.toHaveBeenCalled();
    expect(transactionMocks.courseSupportIncident.update).not.toHaveBeenCalled();
  });
});
