import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
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
  courseSupportBatch: {
    updateMany: vi.fn(),
  },
  courseSupportBatchIncident: {
    updateMany: vi.fn(),
  },
  courseSupportIncident: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  courseSupportVerificationRequest: {
    updateMany: vi.fn(),
  },
  automationRun: {
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

function monitoringSnapshot(
  state = "AUTO_INVESTIGATING",
  overrides: Record<string, unknown> = {},
) {
  return {
    state,
    stateChangedAt: new Date("2026-07-27T15:20:00.000Z"),
    nextAutomaticAttemptAt: now,
    revalidationRequestedAt: null,
    revision: 7,
    ...overrides,
  };
}

function responderBatch(
  entries: Array<{
    incident: Record<string, unknown>;
    monitoringStatus: Record<string, unknown> | null;
    result?: string;
    course?: Record<string, unknown>;
  }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "batch-1",
    status: "VERIFYING",
    leaseExpiresAt: new Date("2026-07-27T15:59:00.000Z"),
    heartbeatAt: new Date("2026-07-27T15:50:00.000Z"),
    completedAt: null,
    revision: 4,
    ownerAutomationRunId: "run-1",
    ownerAutomationRun: null,
    summary: {},
    activeIncidents: entries.map((entry) => ({
      id: String(entry.incident.id),
    })),
    incidents: entries.map((entry, index) => ({
      id: `batch-entry-${index + 1}`,
      incidentId: String(entry.incident.id),
      courseId: String(entry.incident.courseId),
      cycle: Number(entry.incident.cycle),
      result: entry.result ?? "PENDING",
      updatedAt: new Date(`2026-07-27T15:5${index}:00.000Z`),
      incident: entry.incident,
      course: {
        bookingAccessMode: "UNKNOWN",
        automationReason: "OTHER",
        probes: [],
        monitoringStatus: entry.monitoringStatus,
        ...entry.course,
      },
    })),
    ...overrides,
  };
}

function completedBatchEvidence(
  completedAt: Date,
  overrides: Record<string, unknown> = {},
) {
  const closeout = {
    outcome: "success",
    derivedOutcome: "success",
    terminalCount: 1,
    retryCount: 0,
    needsHumanCount: 0,
    automationStalledCount: 0,
    failureDomain: "NONE",
    verificationWatchMode: "STANDARD",
    ...overrides,
  };
  const notes = JSON.stringify({
    schemaVersion: 1,
    lifecycle: "closeout",
    status: "SUCCEEDED",
    outcome: closeout.outcome,
    derivedOutcome: closeout.derivedOutcome,
    terminalCount: closeout.terminalCount,
    retryCount: closeout.retryCount,
    automationStalledCount: closeout.automationStalledCount,
    verificationWatchMode: closeout.verificationWatchMode,
    failureDomain: closeout.failureDomain,
  });
  return {
    status: "SUCCEEDED",
    completedAt,
    summary: { closeout },
    ownerAutomationRun: {
      id: "run-1",
      completedAt,
      outcome: closeout.outcome,
      notes,
    },
  };
}

describe("course monitoring watchdog", () => {
  beforeEach(() => {
    // Reset queued one-shot implementations as well as call history. Several
    // watchdog paths intentionally skip the human-review follow-up query, so a
    // leftover `mockResolvedValueOnce` must not leak into the next example.
    vi.resetAllMocks();
    prismaMocks.$transaction.mockImplementation(
      async (
        input:
          | Promise<unknown>[]
          | ((transaction: typeof prismaMocks) => Promise<unknown>),
      ) => (Array.isArray(input) ? Promise.all(input) : input(prismaMocks)),
    );
    prismaMocks.$queryRaw.mockResolvedValue([]);
    prismaMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseMonitoringStatus.update.mockResolvedValue({});
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseSupportIncident.update.mockResolvedValue({});
    prismaMocks.courseSupportBatch.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.courseSupportBatchIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseSupportVerificationRequest.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.automationRun.updateMany.mockResolvedValue({ count: 1 });
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

  function useDeadlineIncident(value: Record<string, unknown>) {
    prismaMocks.courseSupportIncident.findUnique.mockReset();
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce(value);
  }

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
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
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
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
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

  it("releases an expired multi-course owner and persists the due stalled endpoint atomically", async () => {
    const currentIncident = incident({
      courseId: "course-1",
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
      engineeringOnly: false,
    });
    const siblingIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      activeRealSearchCount: 0,
      revision: 2,
    });
    const currentMonitoring = monitoringSnapshot();
    const siblingMonitoring = monitoringSnapshot("AUTO_INVESTIGATING", {
      revision: 9,
    });
    const batch = responderBatch([
      { incident: currentIncident, monitoringStatus: currentMonitoring },
      { incident: siblingIncident, monitoringStatus: siblingMonitoring },
    ]);
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...currentIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 1,
    });

    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "batch-1",
        status: "VERIFYING",
        revision: 4,
        heartbeatAt: new Date("2026-07-27T15:50:00.000Z"),
        leaseExpiresAt: new Date("2026-07-27T15:59:00.000Z"),
        completedAt: null,
        AND: [{ leaseExpiresAt: { lt: now } }],
      },
      data: expect.objectContaining({
        status: "PARTIAL",
        completedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: now,
        summary: {
          closeout: {
            outcome: "needs_human",
            derivedOutcome: "needs_human",
            terminalCount: 0,
            restoredCount: 0,
            finalDispositionCount: 0,
            retryCount: 1,
            needsHumanCount: 1,
            endpointCount: 1,
            automationStalledCount: 1,
            exhaustedEndpointCount: 0,
            failureDomain: "SLA",
            verificationWatchMode: "ENDPOINT",
            reason: "stale_endpoint_ownership_released",
          },
        },
        revision: { increment: 1 },
      }),
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(
      2,
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          activeBatchId: "batch-1",
        }),
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          activeBatchId: null,
          humanReviewReason: "AUTOMATION_STALLED",
          escalatedAt: now,
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-2",
          activeBatchId: "batch-1",
        }),
        data: expect.objectContaining({
          activeBatchId: null,
          nextAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls.every(
        ([call]) => call.data.activeBatchId === null,
      ),
    ).toBe(true);
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "batch-entry-1" }),
        data: expect.objectContaining({ result: "NEEDS_HUMAN" }),
      }),
    );
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "batch-entry-2" }),
        data: expect.objectContaining({ result: "RETRY_SCHEDULED" }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          incidentId: "incident-1",
          eventType: "HUMAN_REVIEW_REQUESTED",
          audit: expect.objectContaining({
            cycle: 1,
            customerState: "NEEDS_HUMAN_REVIEW",
            playbookExhausted: false,
            automationStalled: true,
          }),
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          preferences: { some: { courseId: "course-1" } },
        }),
        data: { nextCheckAt: now, recheckRequestedAt: now },
      }),
    );
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          batchIncident: { batchId: "batch-1" },
        }),
        data: expect.objectContaining({ status: "STALE" }),
      }),
    );
    expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1", completedAt: null },
        data: expect.objectContaining({ outcome: "needs_human" }),
      }),
    );
  });

  it("closes a mixed expired batch with stalled, exhausted, and later retry outcomes in one pass", async () => {
    const stalledIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
    });
    const exhaustedIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: "batch-1",
      attemptLedger: exhaustedLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:31:00.000Z"),
      activeRealSearchCount: 1,
      revision: 2,
    });
    const laterIncident = incident({
      id: "incident-3",
      reference: "csi_323456789012345678901234",
      courseId: "course-3",
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      revision: 3,
    });
    const currentMonitoring = monitoringSnapshot();
    const batch = responderBatch([
      { incident: stalledIncident, monitoringStatus: currentMonitoring },
      {
        incident: exhaustedIncident,
        monitoringStatus: monitoringSnapshot("AUTO_INVESTIGATING", {
          revision: 8,
        }),
      },
      {
        incident: laterIncident,
        monitoringStatus: monitoringSnapshot("AUTO_INVESTIGATING", {
          revision: 9,
        }),
      },
    ]);
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...stalledIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 1,
      scheduled: 0,
    });
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(2);
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          incidentId: "incident-1",
          audit: expect.objectContaining({
            playbookExhausted: false,
            automationStalled: true,
          }),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          incidentId: "incident-2",
          audit: expect.objectContaining({
            playbookExhausted: true,
            automationStalled: false,
          }),
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "incident-2" }),
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          activeBatchId: null,
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "incident-3" }),
        data: expect.objectContaining({
          activeBatchId: null,
          nextAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PARTIAL",
          summary: {
            closeout: {
              outcome: "needs_human",
              derivedOutcome: "needs_human",
              terminalCount: 0,
              restoredCount: 0,
              finalDispositionCount: 0,
              retryCount: 1,
              needsHumanCount: 2,
              endpointCount: 2,
              automationStalledCount: 1,
              exhaustedEndpointCount: 1,
              failureDomain: "SLA",
              verificationWatchMode: "ENDPOINT",
              reason: "stale_endpoint_ownership_released",
            },
          },
        }),
      }),
    );
  });

  it("adopts a success inserted after the batch snapshot before expired closeout", async () => {
    const currentIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const siblingIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      lastSeenAt: new Date("2026-07-27T15:40:00.000Z"),
      revision: 2,
    });
    const currentMonitoring = monitoringSnapshot();
    const freshObservedAt = new Date("2026-07-27T15:59:00.000Z");
    const batch = responderBatch([
      { incident: currentIncident, monitoringStatus: currentMonitoring },
      {
        incident: siblingIncident,
        monitoringStatus: monitoringSnapshot("AUTO_INVESTIGATING", {
          revision: 8,
        }),
      },
    ]);
    let probeInsertCommitted = false;
    prismaMocks.$queryRaw.mockImplementationOnce(async () => {
      probeInsertCommitted = true;
      return [];
    });
    prismaMocks.courseProbe.findFirst.mockImplementation(
      async (query: { where?: { courseId?: string } }) =>
        probeInsertCommitted && query.where?.courseId === "course-2"
          ? {
              outcome: "NO_MATCH",
              observedAt: freshObservedAt,
              runtimeVersion: "fresh-runtime",
            }
          : null,
    );
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...currentIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await runCourseMonitoringWatchdog(now);

    expect(prismaMocks.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMocks.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMocks.courseProbe.findFirst.mock.invocationCallOrder[0]!,
    );

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "incident-2" }),
        data: expect.objectContaining({
          status: "RESOLVED",
          activeBatchId: null,
          resolution: "MONITORING_RESTORED",
          resolvedAt: freshObservedAt,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ courseId: "course-2", revision: 8 }),
        data: expect.objectContaining({
          state: "HEALTHY",
          lastSuccessfulAt: freshObservedAt,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          incidentId: "incident-2",
          eventType: "HUMAN_REVIEW_REQUESTED",
        }),
      }),
    );
  });

  it("normalizes detached resolved evidence while closing the remaining expired endpoint", async () => {
    const dueIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const detachedResolved = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: null,
      status: "RESOLVED",
      resolution: "MONITORING_RESTORED",
      resolvedAt: new Date("2026-07-27T15:55:00.000Z"),
      revision: 2,
    });
    const dueMonitoring = monitoringSnapshot();
    const batch = responderBatch([
      { incident: dueIncident, monitoringStatus: dueMonitoring },
      {
        incident: detachedResolved,
        monitoringStatus: monitoringSnapshot("HEALTHY", { revision: 8 }),
        result: "PENDING",
      },
    ]);
    batch.activeIncidents = [{ id: "incident-1" }];
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...dueIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      dueMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 1,
    });
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "batch-entry-2", result: "PENDING" }),
        data: expect.objectContaining({ result: "RESTORED" }),
      }),
    );
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PARTIAL",
          summary: expect.objectContaining({
            closeout: expect.objectContaining({
              outcome: "needs_human",
              needsHumanCount: 1,
              restoredCount: 1,
              retryCount: 0,
            }),
          }),
        }),
      }),
    );
  });

  it("fails closed when a detached batch entry points at a later incident cycle", async () => {
    const dueIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const laterCycleIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      cycle: 2,
      activeBatchId: null,
      status: "RESOLVED",
      resolution: "MONITORING_RESTORED",
      resolvedAt: new Date("2026-07-27T15:55:00.000Z"),
      revision: 2,
    });
    const dueMonitoring = monitoringSnapshot();
    const batch = responderBatch([
      { incident: dueIncident, monitoringStatus: dueMonitoring },
      {
        incident: laterCycleIncident,
        monitoringStatus: monitoringSnapshot("HEALTHY", { revision: 8 }),
        result: "PENDING",
      },
    ]);
    batch.activeIncidents = [{ id: "incident-1" }];
    batch.incidents[1]!.cycle = 1;
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    useDeadlineIncident({ ...dueIncident, activeBatch: batch });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      dueMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("repairs detached unproven AUTO human markers during expired closeout", async () => {
    const dueIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const detachedUnprovenHuman = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: null,
      status: "AUTO_INVESTIGATING",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: new Date("2026-07-27T15:45:00.000Z"),
      nextReminderAt: new Date("2026-07-27T15:50:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      activeRealSearchCount: 1,
      revision: 2,
    });
    const dueMonitoring = monitoringSnapshot();
    const batch = responderBatch([
      { incident: dueIncident, monitoringStatus: dueMonitoring },
      {
        incident: detachedUnprovenHuman,
        monitoringStatus: monitoringSnapshot(
          "ENGINEERING_VERIFICATION_NEEDED",
          {
          revision: 8,
          },
        ),
        result: "PENDING",
      },
    ]);
    batch.activeIncidents = [{ id: "incident-1" }];
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    useDeadlineIncident({ ...dueIncident, activeBatch: batch });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      dueMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 1,
    });
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "batch-entry-2" }),
        data: expect.objectContaining({ result: "RETRY_SCHEDULED" }),
      }),
    );
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            closeout: expect.objectContaining({
              needsHumanCount: 1,
              retryCount: 1,
            }),
          }),
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-2",
          status: "AUTO_INVESTIGATING",
          activeBatchId: null,
        }),
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextReminderAt: null,
          nextAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          courseId: "course-2",
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 8,
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
          revalidationRequestedAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          preferences: { some: { courseId: "course-2" } },
        }),
      }),
    );
  });

  it.each([
    ["authoritative course first", "course-1"],
    ["due endpoint first", "course-2"],
  ])(
    "adopts an authoritative sibling and a due endpoint when the %s triggers cleanup",
    async (_label, triggerCourseId) => {
      const authoritativeIncident = incident({
        id: "incident-authoritative",
        courseId: "course-1",
        activeBatchId: "batch-1",
        attemptLedger: renderedBrowserPendingLedger(),
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      });
      const dueIncident = incident({
        id: "incident-due",
        reference: "csi_223456789012345678901234",
        courseId: "course-2",
        activeBatchId: "batch-1",
        attemptLedger: renderedBrowserPendingLedger(),
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
        revision: 2,
      });
      const authoritativeMonitoring = monitoringSnapshot("HEALTHY", {
        revision: 7,
      });
      const dueMonitoring = monitoringSnapshot("AUTO_INVESTIGATING", {
        revision: 8,
      });
      const batch = responderBatch([
        {
          incident: authoritativeIncident,
          monitoringStatus: authoritativeMonitoring,
        },
        { incident: dueIncident, monitoringStatus: dueMonitoring },
      ]);
      const triggerIncident =
        triggerCourseId === "course-1"
          ? authoritativeIncident
          : dueIncident;
      const triggerMonitoring =
        triggerCourseId === "course-1"
          ? authoritativeMonitoring
          : dueMonitoring;
      prismaMocks.courseSupportIncident.findMany
        .mockResolvedValueOnce([{ courseId: triggerCourseId }])
        .mockResolvedValueOnce([]);
      useDeadlineIncident({
        ...triggerIncident,
        activeBatch: batch,
      });
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
        triggerMonitoring,
      );
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "UNKNOWN",
        automationReason: "OTHER",
      });
      prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await runCourseMonitoringWatchdog(now);

      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "incident-authoritative" }),
          data: expect.objectContaining({
            status: "RESOLVED",
            activeBatchId: null,
            resolution: "MONITORING_RESTORED",
          }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "incident-due" }),
          data: expect.objectContaining({
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
            humanReviewReason: "AUTOMATION_STALLED",
          }),
        }),
      );
      expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(1);
      expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            incidentId: "incident-due",
            eventType: "HUMAN_REVIEW_REQUESTED",
          }),
        }),
      );
    },
  );

  it("writes a selector-compatible retryable closeout when every stale entry retries", async () => {
    const firstIncident = incident({
      activeBatchId: "batch-1",
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: new Date("2026-07-27T15:45:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      activeRealSearchCount: 1,
    });
    const secondIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: "batch-1",
      humanReviewReason: "ACCOUNT_REQUIRED",
      escalatedAt: new Date("2026-07-27T15:46:00.000Z"),
      nextReminderAt: new Date("2026-07-27T15:51:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      activeRealSearchCount: 1,
      revision: 2,
    });
    const topLevelMonitoring = monitoringSnapshot(
      "ENGINEERING_VERIFICATION_NEEDED",
    );
    const batch = responderBatch([
      { incident: firstIncident, monitoringStatus: topLevelMonitoring },
      {
        incident: secondIncident,
        monitoringStatus: monitoringSnapshot(
          "ENGINEERING_VERIFICATION_NEEDED",
          {
          revision: 8,
          },
        ),
      },
    ]);
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    useDeadlineIncident({
      ...firstIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      topLevelMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RETRYABLE_FAILED",
          completedAt: now,
          summary: {
            closeout: expect.objectContaining({
              outcome: "retryable_failed",
              derivedOutcome: "retryable_failed",
              retryCount: 2,
              needsHumanCount: 0,
              terminalCount: 0,
            }),
          },
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany.mock.calls.every(
        ([call]) => call.data.result === "RETRY_SCHEDULED",
      ),
    ).toBe(true);
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(
      2,
    );
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls.every(
        ([call]) =>
          call.data.activeBatchId === null &&
          call.data.nextAttemptAt.getTime() ===
            new Date("2026-07-27T16:01:00.000Z").getTime(),
      ),
    ).toBe(true);
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          status: "NEEDS_HUMAN",
        }),
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextReminderAt: null,
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-2",
          status: "AUTO_INVESTIGATING",
        }),
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextReminderAt: null,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          courseId: "course-1",
          state: "ENGINEERING_VERIFICATION_NEEDED",
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
          revalidationRequestedAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          courseId: "course-2",
          state: "ENGINEERING_VERIFICATION_NEEDED",
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
          revalidationRequestedAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledTimes(2);
    for (const courseId of ["course-1", "course-2"]) {
      expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            preferences: { some: { courseId } },
          }),
        }),
      );
    }
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("clears a terminal batch orphan without rewriting its durable closeout", async () => {
    const ownedIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const currentMonitoring = monitoringSnapshot("HEALTHY");
    const completedAt = new Date("2026-07-27T15:55:00.000Z");
    const terminalEvidence = completedBatchEvidence(completedAt);
    const batch = responderBatch(
      [
        {
          incident: ownedIncident,
          monitoringStatus: currentMonitoring,
          result: "RESTORED",
        },
      ],
      terminalEvidence,
    );
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    useDeadlineIncident({
      ...ownedIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        completedAt,
        outcome: "success",
        notes: terminalEvidence.ownerAutomationRun.notes,
      },
      data: { outcome: "success" },
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ activeBatchId: "batch-1" }),
        data: expect.objectContaining({
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          activeBatchId: null,
        }),
      }),
    );
  });

  it.each([
    ["missing", { closeout: { outcome: "success" } }],
    [
      "contradictory",
      {
        closeout: {
          ...completedBatchEvidence(
            new Date("2026-07-27T15:55:00.000Z"),
          ).summary.closeout,
          terminalCount: 2,
        },
      },
    ],
  ])(
    "fails closed on a terminal orphan with %s canonical closeout evidence",
    async (_label, summary) => {
      const ownedIncident = incident({
        activeBatchId: "batch-1",
        attemptLedger: renderedBrowserPendingLedger(),
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      });
      const currentMonitoring = monitoringSnapshot("HEALTHY");
      const completedAt = new Date("2026-07-27T15:55:00.000Z");
      const terminalEvidence = completedBatchEvidence(completedAt);
      const batch = responderBatch(
        [
          {
            incident: ownedIncident,
            monitoringStatus: currentMonitoring,
            result: "RESTORED",
          },
        ],
        { ...terminalEvidence, summary },
      );
      prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
        { courseId: "course-1" },
      ]);
      useDeadlineIncident({ ...ownedIncident, activeBatch: batch });
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
        currentMonitoring,
      );
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "UNKNOWN",
        automationReason: "OTHER",
      });
      prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 0,
        escalated: 0,
      });
      expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
      expect(prismaMocks.automationRun.updateMany).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseSupportBatchIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    },
  );

  it("fails closed when terminal orphan AutomationRun evidence loses its CAS", async () => {
    const ownedIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const currentMonitoring = monitoringSnapshot("HEALTHY");
    const completedAt = new Date("2026-07-27T15:55:00.000Z");
    const terminalEvidence = completedBatchEvidence(completedAt);
    const batch = responderBatch(
      [
        {
          incident: ownedIncident,
          monitoringStatus: currentMonitoring,
          result: "RESTORED",
        },
      ],
      terminalEvidence,
    );
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    useDeadlineIncident({ ...ownedIncident, activeBatch: batch });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.automationRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("preserves an active batch whose endpoint lease is still live", async () => {
    const ownedIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const batch = responderBatch(
      [{ incident: ownedIncident, monitoringStatus: monitoringSnapshot() }],
      { leaseExpiresAt: now },
    );
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    useDeadlineIncident({
      ...ownedIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      monitoringSnapshot(),
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when stale batch ownership is renewed during the endpoint CAS", async () => {
    const ownedIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
    });
    const batch = responderBatch([
      { incident: ownedIncident, monitoringStatus: monitoringSnapshot() },
    ]);
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    useDeadlineIncident({
      ...ownedIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      monitoringSnapshot(),
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.courseSupportBatch.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("does not disturb prior human proof while an incomplete current cycle is within its deadline", async () => {
    const escalatedAt = new Date("2026-07-27T10:00:00.000Z");
    const revalidatingIncident = incident({
      cycle: 2,
      status: "AUTO_INVESTIGATING",
      attemptLedger: priorCycleExhaustedCurrentCyclePendingLedger(),
      escalatedAt,
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
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
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
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

  it("persists one truthful stalled endpoint for an unexhausted playbook deadline", async () => {
    const dueIncident = incident({
      confirmedAt: new Date("2026-07-27T15:00:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
      engineeringOnly: false,
      attemptLedger: renderedBrowserPendingLedger(),
    });
    const endpointAt = new Date("2026-07-27T16:00:00.123Z");
    const stalledIncident = {
      ...dueIncident,
      revision: 1,
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: endpointAt,
      nextReminderAt: endpointAt,
      nextAttemptAt: new Date("2026-07-27T22:00:00.123Z"),
    };
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(dueIncident)
      .mockResolvedValue(stalledIncident);
    prismaMocks.courseMonitoringStatus.findUnique
      .mockResolvedValueOnce({
        state: "AUTO_INVESTIGATING",
        stateChangedAt: new Date("2026-07-27T15:00:00.000Z"),
        revalidationRequestedAt: null,
        revision: 7,
      })
      .mockResolvedValue({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        stateChangedAt: endpointAt,
        nextAutomaticAttemptAt: new Date("2026-07-27T22:00:00.123Z"),
        revalidationRequestedAt: null,
        revision: 8,
      });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: "deadline-stalled",
        occurredAt: endpointAt,
      });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(
      runCourseMonitoringWatchdog(endpointAt),
    ).resolves.toMatchObject({
      checked: 0,
      scheduled: 0,
      escalated: 1,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: "AUTOMATION_STALLED",
          escalatedAt: endpointAt,
          nextReminderAt: endpointAt,
          nextAttemptAt: new Date("2026-07-27T22:00:00.123Z"),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revision: 7 }),
        data: expect.objectContaining({
          state: "ENGINEERING_VERIFICATION_NEEDED",
          nextAutomaticAttemptAt: new Date("2026-07-27T22:00:00.123Z"),
          revalidationRequestedAt: null,
          stateChangedAt: endpointAt,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "HUMAN_REVIEW_REQUESTED",
          fromState: "AUTO_INVESTIGATING",
          toState: "ENGINEERING_VERIFICATION_NEEDED",
          audit: expect.objectContaining({
            cycle: 1,
            customerState: "NEEDS_HUMAN_REVIEW",
            playbookExhausted: false,
            automationStalled: true,
            nextStage: "RENDERED_BROWSER_DISCOVERY",
            escalationDeadlineAt: "2026-07-27T15:30:00.000Z",
          }),
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
          nextCheckAt: endpointAt,
          recheckRequestedAt: endpointAt,
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
