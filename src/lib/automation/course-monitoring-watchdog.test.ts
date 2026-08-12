import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  course: {
    findUnique: vi.fn(),
  },
  courseMonitoringStatus: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  courseMonitoringEvent: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  courseProbe: {
    findFirst: vi.fn(),
  },
  courseSupportIncident: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  teeSearch: {
    updateMany: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import {
  FAILURE_CONFIRMATION_WINDOW_MS,
  runCourseMonitoringWatchdog,
} from "./course-monitoring";
import {
  appendAutomationPlaybookEvent,
  type AutomationPlaybookLedger,
  type AutomationPlaybookReadPath,
  type AutomationPlaybookStage,
} from "./course-monitoring-playbook";

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
    preferences: [],
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
    attemptLedger: null,
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
    ...overrides,
  };
}

function exhaustedLedger() {
  const stages: Array<[AutomationPlaybookStage, AutomationPlaybookReadPath]> = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["LOCAL_READER", "LOCAL_READER"],
    ["INDEPENDENT_CONFIRMATION", "INDEPENDENT_CONFIRMATION"],
  ];
  let ledger: AutomationPlaybookLedger | null = null;
  for (const [stage, readPath] of stages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage,
      transition: "NOT_APPLICABLE",
      readPath,
      evidenceKind: "TOOLING",
      skipReason: "MONITORING_MODE_EXCLUDED",
      failureFingerprint: "PLAYBOOK:NOT_APPLICABLE",
      runtimeVersion: "watchdog-test",
      observedAt: new Date("2026-07-27T15:20:00.000Z"),
    });
  }
  return ledger;
}

function renderedBrowserPendingLedger() {
  const stages: Array<[AutomationPlaybookStage, AutomationPlaybookReadPath]> = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
  ];
  let ledger: AutomationPlaybookLedger | null = null;
  for (const [stage, readPath] of stages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage,
      transition:
        stage === "OFFICIAL_IDENTITY" || stage === "OFFICIAL_HTTP_DISCOVERY"
          ? "COMPLETED"
          : "FAILED_TERMINAL",
      readPath,
      evidenceKind:
        stage === "OFFICIAL_IDENTITY" || stage === "OFFICIAL_HTTP_DISCOVERY"
          ? "OFFICIAL_SOURCE"
          : "PROVIDER_RESPONSE",
      failureFingerprint: `PLAYBOOK:${stage}`,
      failureClass:
        stage === "TYPED_ADAPTER" || stage === "HTTP_ADAPTER_RETRY"
          ? "UNKNOWN"
          : undefined,
      runtimeVersion: "watchdog-test",
      observedAt: new Date("2026-07-27T15:20:00.000Z"),
    });
  }
  return ledger;
}

function priorCycleExhaustedCurrentCyclePendingLedger() {
  return appendAutomationPlaybookEvent(exhaustedLedger(), {
    cycle: 2,
    stage: "OFFICIAL_IDENTITY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_IDENTITY",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "PLAYBOOK:OFFICIAL_IDENTITY",
    runtimeVersion: "watchdog-test",
    observedAt: new Date("2026-07-27T15:50:00.000Z"),
  });
}

describe("course monitoring watchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.$transaction.mockImplementation(
      async (
        input:
          | Promise<unknown>[]
          | ((transaction: typeof prismaMocks) => Promise<unknown>),
      ) => (Array.isArray(input) ? Promise.all(input) : input(prismaMocks)),
    );
    prismaMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseMonitoringStatus.update.mockResolvedValue({});
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseSupportIncident.update.mockResolvedValue({});
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(null);
    prismaMocks.course.findUnique.mockResolvedValue(null);
    prismaMocks.teeSearch.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.courseMonitoringEvent.create.mockResolvedValue({
      id: "event-1",
    });
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([]);
  });

  it("turns an unconfirmed fifteen-minute gap into explicit tooling work", async () => {
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "DEGRADED_RETRYING",
        firstDegradedAt: new Date(
          now.getTime() - FAILURE_CONFIRMATION_WINDOW_MS,
        ),
        failureFingerprint: "SOURCE_MISSING:UNKNOWN",
        nextAutomaticAttemptAt: now,
        revision: 0,
        course: course(incident()),
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "BLOCKED_TOOLING",
          confirmedAt: now,
          escalationDeadlineAt: new Date(now.getTime() + 15 * 60 * 1000),
          nextAttemptAt: now,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "TOOLING_INCIDENT",
          fromState: "DEGRADED_RETRYING",
          toState: "AUTO_INVESTIGATING",
        }),
      }),
    );
  });

  it("retains a proof-backed human decision without repeated escalation or writes", async () => {
    const humanIncident = incident({
      status: "NEEDS_HUMAN",
      attemptLedger: exhaustedLedger(),
      confirmedAt: new Date("2026-07-27T10:00:00.000Z"),
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: new Date("2026-07-27T10:30:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T10:30:00.000Z"),
      nextAttemptAt: new Date("2026-07-27T22:00:00.000Z"),
      nextReminderAt: new Date("2026-07-28T10:00:00.000Z"),
    });
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([humanIncident])
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([humanIncident]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      humanIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      automationReason: "CAPTCHA_OR_QUEUE",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        firstDegradedAt: new Date("2026-07-27T10:00:00.000Z"),
        failureFingerprint: "CPS:CHALLENGE",
        nextAutomaticAttemptAt: now,
        revision: 3,
        course: course(humanIncident),
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
      escalated: 0,
      remindersSent: 0,
    });
    expect(
      prismaMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AUTO_INVESTIGATING" }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["incident-1"] },
          status: "NEEDS_HUMAN",
        }),
      }),
    );

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
      scheduled: 0,
    });
    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("immediately repairs a stale needs-human row without current or prior proof", async () => {
    const staleHuman = incident({
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: now,
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      attemptLedger: null,
      activeRealSearchCount: 1,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(staleHuman);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      automationReason: "CAPTCHA_OR_QUEUE",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextAttemptAt: now,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "HUMAN_REVIEW_REQUESTED",
        }),
      }),
    );
  });

  it("repairs a stale non-stalled human reason with an invalid ledger", async () => {
    const stale = incident({
      status: "AUTO_INVESTIGATING",
      humanReviewReason: "ACCOUNT_REQUIRED",
      escalatedAt: now,
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      attemptLedger: { version: 999, events: [] },
      activeRealSearchCount: 1,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(stale);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "ACCOUNT_REQUIRED",
      automationReason: "ACCOUNT_REQUIRED",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextAttemptAt: now,
        }),
      }),
    );
  });

  it.each([
    ["unexhausted", renderedBrowserPendingLedger()],
    ["current-cycle exhausted", exhaustedLedger()],
  ])(
    "does not mutate a stale-human incident with %s proof while a responder batch owns it",
    async (_proof, attemptLedger) => {
      const ownedIncident = incident({
        status: "NEEDS_HUMAN",
        humanReviewReason: "CAPTCHA_OR_QUEUE",
        escalatedAt: now,
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
        attemptLedger,
        activeBatchId: "batch-1",
        activeRealSearchCount: 0,
      });
      prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
        { courseId: "course-1" },
      ]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
        ownedIncident,
      );
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        revision: 3,
      });
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        automationReason: "CAPTCHA_OR_QUEUE",
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
        {
          courseId: "course-1",
          state: "ENGINEERING_VERIFICATION_NEEDED",
          stateChangedAt: now,
          firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
          failureFingerprint: "SOURCE_MISSING:CHALLENGE",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          revision: 3,
          course: course(ownedIncident),
        },
      ]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 0,
        escalated: 0,
      });
      expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringStatus.update).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).not.toHaveBeenCalled();
      expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    },
  );

  it("preserves prior human proof while continuing an incomplete current cycle", async () => {
    const escalatedAt = new Date("2026-07-27T10:00:00.000Z");
    const revalidatingIncident = incident({
      cycle: 2,
      status: "AUTO_INVESTIGATING",
      attemptLedger: priorCycleExhaustedCurrentCyclePendingLedger(),
      escalatedAt,
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      revalidatingIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      automationReason: "CAPTCHA_OR_QUEUE",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          escalatedAt,
          humanReviewReason: null,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          audit: expect.objectContaining({
            playbookExhausted: false,
            priorCycleHumanReviewProof: true,
            nextStage: "TYPED_ADAPTER",
          }),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "HUMAN_REVIEW_REQUESTED" }),
      }),
    );
  });

  it("repairs proofless engineering state with no incident owner", async () => {
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        stateChangedAt: now,
        firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
        failureFingerprint: "SOURCE_MISSING:UNKNOWN",
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 3,
        course: course(null),
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "ENGINEERING_VERIFICATION_NEEDED",
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: now,
          revalidationRequestedAt: now,
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          audit: expect.objectContaining({ missingIncidentProof: true }),
        }),
      }),
    );
  });

  it("repairs proofless engineering state with an automatic incident before its deadline", async () => {
    const futureDeadline = new Date("2026-07-27T18:00:00.000Z");
    const orphanedIncident = incident({
      status: "AUTO_INVESTIGATING",
      attemptLedger: null,
      escalationDeadlineAt: futureDeadline,
      humanReviewReason: null,
      nextAttemptAt: null,
      activeRealSearchCount: 1,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      orphanedIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          nextAttemptAt: now,
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0]?.data
        ?.escalationDeadlineAt,
    ).toBeUndefined();
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: now,
          revalidationRequestedAt: now,
        }),
      }),
    );
  });

  it.each([
    ["HEALTHY", "MONITORING_RESTORED"],
    ["FINAL_MANUAL", "DIRECT_BOOKING_CLASSIFIED"],
    ["FINAL_TECHNICAL", "TECHNICAL_LIMITATION_CLASSIFIED"],
  ] as const)(
    "lets a newer %s monitoring state win over a stale due incident",
    async (state, resolution) => {
      const staleIncident = incident({
        activeRealSearchCount: 1,
        engineeringOnly: false,
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      });
      prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
        { courseId: "course-1" },
      ]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
        staleIncident,
      );
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state,
        revision: 9,
      });
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "PUBLIC_READ_ONLY",
        automationReason: null,
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        checked: 0,
        escalated: 0,
      });

      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            revision: 0,
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
          }),
          data: expect.objectContaining({
            status: "RESOLVED",
            resolution,
            resolvedAt: now,
            nextAttemptAt: null,
            nextReminderAt: null,
          }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringStatus.update).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    },
  );

  it.each(["NO_MATCH", "MATCH_FOUND"] as const)(
    "adopts a fresh %s probe when success closeout crashed before the deadline",
    async (outcome) => {
      const lastFailureAt = new Date("2026-07-27T15:30:00.000Z");
      const successObservedAt = new Date("2026-07-27T15:59:00.000Z");
      const staleIncident = incident({
        activeRealSearchCount: 1,
        engineeringOnly: false,
        lastSeenAt: lastFailureAt,
        escalationDeadlineAt: new Date("2026-07-27T15:58:00.000Z"),
      });
      prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
        { courseId: "course-1" },
      ]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
        staleIncident,
      );
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state: "AUTO_INVESTIGATING",
        revision: 7,
      });
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "PUBLIC_READ_ONLY",
        automationReason: null,
      });
      prismaMocks.courseProbe.findFirst.mockResolvedValue({
        outcome,
        observedAt: successObservedAt,
        runtimeVersion: "success-runtime",
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        checked: 0,
        escalated: 0,
      });

      expect(prismaMocks.courseProbe.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          courseId: "course-1",
          outcome: { in: ["MATCH_FOUND", "NO_MATCH"] },
          observedAt: { gt: lastFailureAt, lte: now },
          teeSearch: {
            status: "ACTIVE",
            trafficClass: { notIn: ["AUTOMATION", "TEST"] },
          },
        }),
        orderBy: [{ observedAt: "desc" }, { id: "desc" }],
        select: {
          outcome: true,
          observedAt: true,
          runtimeVersion: true,
        },
      });
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { courseId: "course-1", revision: 7 },
          data: expect.objectContaining({
            state: "HEALTHY",
            lastSuccessfulAt: successObservedAt,
            failureFingerprint: null,
            firstDegradedAt: null,
          }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
          }),
          data: expect.objectContaining({
            status: "RESOLVED",
            resolution: "MONITORING_RESTORED",
            resolvedAt: successObservedAt,
          }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: "RECOVERED",
            outcome,
          }),
        }),
      );
    },
  );

  it.each([
    ["HEALTHY", "MONITORING_RESTORED"],
    ["FINAL_TECHNICAL", "TECHNICAL_LIMITATION_CLASSIFIED"],
  ] as const)(
    "lets an authoritative %s state heal a stale needs-human row",
    async (state, resolution) => {
      const staleHuman = incident({
        status: "NEEDS_HUMAN",
        humanReviewReason: "CAPTCHA_OR_QUEUE",
        escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      });
      prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
        { courseId: "course-1" },
      ]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
        staleHuman,
      );
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state,
        revision: 4,
      });
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "PUBLIC_READ_ONLY",
        automationReason: null,
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        escalated: 0,
      });

      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "NEEDS_HUMAN" }),
          data: expect.objectContaining({
            status: "RESOLVED",
            resolution,
          }),
        }),
      );
    },
  );

  it("lets a fresh probe heal a stale needs-human row", async () => {
    const successObservedAt = new Date("2026-07-27T15:59:00.000Z");
    const staleHuman = incident({
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      lastSeenAt: new Date("2026-07-27T15:40:00.000Z"),
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(staleHuman);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 4,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "PUBLIC_READ_ONLY",
      automationReason: null,
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue({
      outcome: "NO_MATCH",
      observedAt: successObservedAt,
      runtimeVersion: "success-runtime",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "NEEDS_HUMAN" }),
        data: expect.objectContaining({
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
        }),
      }),
    );
  });

  it("adopts fresh success without detaching an active responder batch", async () => {
    const successObservedAt = new Date("2026-07-27T15:59:00.000Z");
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        activeBatchId: "batch-1",
        activeRealSearchCount: 1,
        lastSeenAt: new Date("2026-07-27T15:30:00.000Z"),
        escalationDeadlineAt: new Date("2026-07-27T15:58:00.000Z"),
      }),
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 7,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "PUBLIC_READ_ONLY",
      automationReason: null,
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue({
      outcome: "NO_MATCH",
      observedAt: successObservedAt,
      runtimeVersion: "success-runtime",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
    });

    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "HEALTHY" }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
  });

  it("keeps an expired rendered-browser stage automatic and clears stale human markers", async () => {
    const staleIncident = incident({
      confirmedAt: new Date("2026-07-27T15:00:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
      engineeringOnly: false,
      attemptLedger: renderedBrowserPendingLedger(),
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: now,
      nextReminderAt: now,
      nextAttemptAt: new Date("2026-07-27T22:00:00.000Z"),
    });
    const continuationAt = new Date("2026-07-27T16:00:00.123Z");
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(staleIncident)
      .mockResolvedValue({
        ...staleIncident,
        revision: 1,
        humanReviewReason: null,
        escalatedAt: null,
        nextReminderAt: null,
        nextAttemptAt: continuationAt,
      });
    prismaMocks.courseMonitoringStatus.findUnique
      .mockResolvedValueOnce({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        revalidationRequestedAt: null,
        revision: 7,
      })
      .mockResolvedValue({
        state: "AUTO_INVESTIGATING",
        nextAutomaticAttemptAt: continuationAt,
        revalidationRequestedAt: continuationAt,
        revision: 8,
      });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: "deadline-continuation",
        occurredAt: continuationAt,
      });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(
      runCourseMonitoringWatchdog(continuationAt),
    ).resolves.toMatchObject({
      checked: 0,
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextReminderAt: null,
          nextAttemptAt: continuationAt,
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0]?.data
        ?.escalationDeadlineAt,
    ).toBeUndefined();
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revision: 7,
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: continuationAt,
          revalidationRequestedAt: continuationAt,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          fromState: "ENGINEERING_VERIFICATION_NEEDED",
          toState: "AUTO_INVESTIGATING",
          audit: expect.objectContaining({
            customerState: "RETRYING_AUTOMATICALLY",
            playbookExhausted: false,
            nextStage: "RENDERED_BROWSER_DISCOVERY",
          }),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "HUMAN_REVIEW_REQUESTED",
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ACTIVE",
          trafficClass: { notIn: ["AUTOMATION", "TEST"] },
          preferences: { some: { courseId: "course-1" } },
        }),
        data: {
          nextCheckAt: continuationAt,
          recheckRequestedAt: continuationAt,
        },
      }),
    );

    await expect(
      runCourseMonitoringWatchdog(new Date("2026-07-27T16:10:00.000Z")),
    ).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(
      1,
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledTimes(
      1,
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(1);
  });

  it("uses the course limitation reason only when current-cycle playbook exhaustion is proven", async () => {
    const provenIncident = incident({
      confirmedAt: new Date("2026-07-27T15:00:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      failureClass: "CHALLENGE",
      attemptLedger: exhaustedLedger(),
    });
    const humanIncident = {
      ...provenIncident,
      revision: 1,
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: now,
      nextReminderAt: now,
      nextAttemptAt: new Date("2026-07-27T22:00:00.000Z"),
    };
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([humanIncident]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      provenIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 7,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      automationReason: "CAPTCHA_OR_QUEUE",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
        failureFingerprint: "SOURCE_MISSING:CHALLENGE",
        nextAutomaticAttemptAt: new Date("2026-07-27T22:00:00.000Z"),
        revision: 8,
        course: course(humanIncident),
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 1,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          humanReviewReason: "CAPTCHA_OR_QUEUE",
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audit: expect.objectContaining({
            playbookConclusion: "UNRESOLVED_EXHAUSTED",
            playbookExhausted: true,
          }),
        }),
      }),
    );
  });

  it("opens a fresh cycle and queues affected searches for a due six-hour recheck", async () => {
    const humanIncident = incident({
      status: "NEEDS_HUMAN",
      attemptLedger: exhaustedLedger(),
      confirmedAt: new Date("2026-07-27T10:00:00.000Z"),
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      nextReminderAt: now,
      nextAttemptAt: now,
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        firstDegradedAt: new Date("2026-07-27T10:00:00.000Z"),
        failureFingerprint: "CPS:CHALLENGE",
        nextAutomaticAttemptAt: now,
        revision: 3,
        course: course(humanIncident),
      },
    ]);
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([humanIncident]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 1,
      remindersSent: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          nextAttemptAt: now,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          revalidationRequestedAt: now,
          nextAutomaticAttemptAt: now,
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { nextCheckAt: now, recheckRequestedAt: now },
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          audit: expect.objectContaining({ priorCycle: 1, cycle: 2 }),
        }),
      }),
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
      earliestTargetDate: null,
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
                createdAt: new Date("2026-07-27T15:00:00.000Z"),
              },
            },
          ],
        },
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 1,
    });
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "REVALIDATING_FINAL",
          revalidationRequestedAt: now,
          nextAutomaticAttemptAt: now,
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          nextCheckAt: now,
          recheckRequestedAt: now,
        },
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          source: "RECOVERY_CRON",
        }),
      }),
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
              activeRealSearchCount: 1,
            }),
          ),
          preferences: [
            {
              teeSearch: {
                date: activeDate,
                createdAt: new Date("2026-07-27T14:00:00.000Z"),
              },
            },
          ],
        },
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
    });
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });
});
