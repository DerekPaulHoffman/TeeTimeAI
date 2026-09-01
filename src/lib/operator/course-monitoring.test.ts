import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionMocks = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(),
  course: {
    update: vi.fn(),
  },
  courseAutomationDiscovery: {
    create: vi.fn(),
  },
  courseMonitoringEvent: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  courseMonitoringStatus: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  courseSupportIncident: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  teeTimeMatch: {
    updateMany: vi.fn(),
  },
}));

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  courseMonitoringEvent: {
    findUnique: vi.fn(),
  },
  courseMonitoringStatus: {
    findFirst: vi.fn(),
  },
  teeSearch: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const localReaderMocks = vi.hoisted(() => ({
  queueLocalReaderCourseVerification: vi.fn(),
}));

const schedulerMocks = vi.hoisted(() => ({
  startSearchSchedule: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/automation/search-scheduler", () => schedulerMocks);
vi.mock("@/lib/local-reader/service", () => localReaderMocks);

import {
  appendAutomationPlaybookEvent,
  type AutomationPlaybookLedger,
  type AutomationPlaybookReadPath,
  type AutomationPlaybookStage,
} from "@/lib/automation/course-monitoring-playbook";
import {
  applyOperatorCourseDecision,
  approveOperatorCourseTechnicalFinal,
  correctOperatorCourseBookingLink,
  requestOperatorCourseRecheck,
  updateOperatorCourseOfficialLinks,
} from "./course-monitoring";

const reference = "cm_123456789012345678901234";
const cabqFaqUrl =
  "https://www.cabq.gov/parksandrecreation/recreation/golf/faq#autotoc-item-autotoc-1";

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
      bookingPhone: "555-0100",
      bookingMethod: "PUBLIC_ONLINE",
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
      supportIncident: {
        id: "incident-1",
        cycle: 2,
        revision: 7,
        status: "NEEDS_HUMAN",
        confirmedAt: new Date("2026-08-20T12:00:00.000Z"),
        activeRealSearchCount: 1,
        attemptLedger: null,
        resolution: null,
        failureFingerprint: "SOURCE_MISSING:UNKNOWN",
      },
    },
  };
}

function technicalFinalLedger(cycle = 2) {
  const priorStages: Array<
    [AutomationPlaybookStage, AutomationPlaybookReadPath]
  > = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
  ];
  let ledger: AutomationPlaybookLedger | null = null;
  for (const [stage, readPath] of priorStages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle,
      stage,
      transition: "NOT_APPLICABLE",
      readPath,
      evidenceKind: "TOOLING",
      skipReason: "MONITORING_MODE_EXCLUDED",
      failureFingerprint: "PLAYBOOK:NOT_APPLICABLE",
      runtimeVersion: "operator-test",
    });
  }
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "LOCAL_READER",
    transition: "TECHNICAL_LIMITATION",
    readPath: "LOCAL_READER",
    evidenceKind: "LOCAL_READER_RESULT",
    technicalReason: "CAPTCHA_OR_QUEUE",
    failureFingerprint: "LOCAL_READER:CHALLENGE",
    runtimeVersion: "operator-test",
  });
  return appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "INDEPENDENT_CONFIRMATION",
    transition: "TECHNICAL_LIMITATION",
    readPath: "INDEPENDENT_CONFIRMATION",
    evidenceKind: "RENDERED_PAGE",
    technicalReason: "CAPTCHA_OR_QUEUE",
    failureFingerprint: "CONFIRMATION:CHALLENGE",
    runtimeVersion: "operator-test",
  });
}

const context = {
  actorId: "user_clerk_operator",
  source: "OPERATOR_DASHBOARD" as const,
  apply: true,
  dispatchSearches: true,
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("operator course monitoring mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue(status());
    prismaMocks.teeSearch.findMany.mockResolvedValue([]);
    schedulerMocks.startSearchSchedule.mockResolvedValue(undefined);
    localReaderMocks.queueLocalReaderCourseVerification.mockResolvedValue(null);
    transactionMocks.$queryRawUnsafe.mockResolvedValue([{ locked: true }]);
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      revision: 4,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      cycle: 2,
      revision: 7,
    });
    transactionMocks.courseSupportIncident.update.mockResolvedValue({
      id: "incident-1",
      failureFingerprint: "updated-fingerprint",
    });
    prismaMocks.$transaction.mockImplementation(
      async (
        callback: (transaction: typeof transactionMocks) => Promise<unknown>,
      ) => callback(transactionMocks),
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
          idempotencyKey: "operator-link-1234567890",
        },
        context,
      ),
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
          idempotencyKey: "operator-recheck-123456",
        },
        context,
      ),
    ).rejects.toThrow("changed while this form was open");
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("treats an existing same-course idempotency key as a replay", async () => {
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue({
      courseId: "course-1",
    });

    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          note: "Retry the current public signed-out course surface.",
          idempotencyKey: "operator-recheck-123456",
        },
        context,
      ),
    ).resolves.toMatchObject({
      action: "request_recheck",
      applied: false,
      replayed: true,
    });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an idempotency key already used by another course", async () => {
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue({
      courseId: "course-2",
    });

    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          note: "Retry the current public signed-out course surface.",
          idempotencyKey: "operator-recheck-123456",
        },
        context,
      ),
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
          note: "Verify https://course.example/book?id=customer-1 and reply to golfer@example.com.",
          idempotencyKey: "operator-recheck-123456",
        },
        context,
      ),
    ).resolves.toMatchObject({
      action: "request_recheck",
      applied: true,
      replayed: false,
    });

    const safeNote =
      "Verify https://course.example and reply to [redacted-email].";
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7,
      },
      data: {
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        humanReviewReason: null,
        nextReminderAt: null,
        confirmedAt: expect.any(Date),
        nextAttemptAt: expect.any(Date),
        escalationDeadlineAt: expect.any(Date),
        lastSeenAt: expect.any(Date),
        nextAction: safeNote,
        revision: { increment: 1 },
      },
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      {
        where: {
          courseId: "course-1",
          revision: 4,
        },
        data: {
          state: "AUTO_INVESTIGATING",
          revalidationRequestedAt: expect.any(Date),
          nextAutomaticAttemptAt: expect.any(Date),
          stateChangedAt: expect.any(Date),
          revision: { increment: 1 },
        },
      },
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        message: safeNote,
      }),
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
          activeBatch: { status: "PARTIAL" },
        },
      },
    });

    await requestOperatorCourseRecheck(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        note: "Retry the current public signed-out course surface.",
        idempotencyKey: "operator-recheck-closed-batch",
      },
      context,
    );

    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeBatchId: null }),
      }),
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
          activeBatch: { status: "VERIFYING" },
        },
      },
    });

    await requestOperatorCourseRecheck(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        note: "Retry the current public signed-out course surface.",
        idempotencyKey: "operator-recheck-live-batch",
      },
      context,
    );

    const update =
      transactionMocks.courseSupportIncident.update.mock.calls.at(-1)?.[0];
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
          status: "RESOLVED",
        },
      },
    });

    await requestOperatorCourseRecheck(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        note: "Revalidate the prior technical decision against the public surface.",
        idempotencyKey: "operator-final-recheck-123456",
      },
      context,
    );

    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7,
      },
      data: {
        nextAttemptAt: expect.any(Date),
        lastSeenAt: expect.any(Date),
        nextAction:
          "Revalidate the prior technical decision against the public surface.",
        revision: { increment: 1 },
      },
    });
  });

  it("starts a CPS recheck without queueing the reader before the browser adapter retry", async () => {
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      course: {
        ...status().course,
        detectedPlatform: "CUSTOM",
        detectedBookingUrl:
          "https://future-course.cps.golf/onlineresweb/search-teetime",
        providerFamilyKey: "CPS",
      },
    });
    prismaMocks.teeSearch.findMany.mockResolvedValue([
      {
        id: "search-1",
        date: new Date("2026-08-02T00:00:00.000Z"),
        players: 3,
      },
    ]);
    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          note: "Retry the rendered public CPS tee sheet.",
          idempotencyKey: "operator-recheck-cps-123456",
        },
        context,
      ),
    ).resolves.toMatchObject({
      action: "request_recheck",
      localReaderQueued: false,
      applied: true,
    });

    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
  });

  it("opens a fresh ordered cycle when an automatic investigation stalled", async () => {
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      state: "AUTO_INVESTIGATING",
      course: {
        ...status().course,
        supportIncident: {
          ...status().course.supportIncident,
          status: "AUTO_INVESTIGATING",
          humanReviewReason: "AUTOMATION_STALLED",
          nextReminderAt: new Date("2026-08-11T18:00:00.000Z"),
        },
      },
    });
    prismaMocks.teeSearch.findMany.mockResolvedValue([
      {
        id: "search-stalled",
        date: new Date("2026-08-12T00:00:00.000Z"),
        players: 2,
      },
    ]);

    await requestOperatorCourseRecheck(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        note: "Restart the ordered public signed-out verification.",
        idempotencyKey: "operator-recheck-stalled",
      },
      context,
    );

    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: { id: "incident-1", cycle: 2, revision: 7 },
      data: expect.objectContaining({
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        humanReviewReason: null,
        nextReminderAt: null,
        nextAttemptAt: expect.any(Date),
      }),
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      {
        where: { courseId: "course-1", revision: 4 },
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          revalidationRequestedAt: expect.any(Date),
          nextAutomaticAttemptAt: expect.any(Date),
        }),
      },
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromState: "AUTO_INVESTIGATING",
        toState: "AUTO_INVESTIGATING",
        audit: expect.objectContaining({
          priorCycle: 2,
          cycle: 3,
          authoritativeFinalRetained: false,
        }),
      }),
    });
    expect(schedulerMocks.startSearchSchedule).toHaveBeenCalledWith(
      "search-stalled",
    );
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
  });

  it.each(["FINAL_MANUAL", "FINAL_IDENTITY"] as const)(
    "rejects a generic recheck for authoritative %s",
    async (state) => {
      prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
        ...status(),
        state,
        course: {
          ...status().course,
          supportIncident: {
            ...status().course.supportIncident,
            status: "RESOLVED",
          },
        },
      });

      await expect(
        requestOperatorCourseRecheck(
          {
            reference,
            statusRevision: 4,
            incidentCycle: 2,
            incidentRevision: 7,
            note: "Retain the authoritative factual classification.",
            idempotencyKey: `operator-recheck-${state.toLowerCase()}`,
          },
          context,
        ),
      ).rejects.toThrow("factual final");

      expect(prismaMocks.$transaction).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseMonitoringStatus.update,
      ).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseSupportIncident.update,
      ).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseMonitoringEvent.create,
      ).not.toHaveBeenCalled();
      expect(
        localReaderMocks.queueLocalReaderCourseVerification,
      ).not.toHaveBeenCalled();
    },
  );

  it("saves changed official links and starts ordered verification without a reader shortcut", async () => {
    const courseLock = createDeferred<Array<{ locked: boolean }>>();
    transactionMocks.$queryRawUnsafe.mockReturnValueOnce(courseLock.promise);
    const mutation = updateOperatorCourseOfficialLinks(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        providerFamilyKey: "FOREUP",
        website: "https://new-course.example",
        bookingUrl: "https://new-course.example/tee-times",
        idempotencyKey: "operator-links-123456789",
      },
      context,
    );

    await vi.waitFor(() =>
      expect(transactionMocks.$queryRawUnsafe).toHaveBeenCalledOnce(),
    );
    expect(transactionMocks.course.update).not.toHaveBeenCalled();
    expect(transactionMocks.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    courseLock.resolve([{ locked: true }]);

    await expect(mutation).resolves.toMatchObject({
      action: "update_official_links",
      applied: true,
      replayed: false,
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        website: "https://new-course.example/",
        detectedBookingUrl: "https://new-course.example/tee-times",
        providerFamilyKey: "FOREUP",
        automationEligibility: "NEEDS_REVIEW",
      }),
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      {
        where: {
          courseId: "course-1",
          revision: 4,
        },
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          revalidationRequestedAt: expect.any(Date),
          nextAutomaticAttemptAt: expect.any(Date),
        }),
      },
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        evidenceUrl: "https://new-course.example/tee-times",
        audit: expect.objectContaining({ priorCycle: 2, cycle: 3 }),
      }),
    });
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cycle: { increment: 1 } }),
      }),
    );
    expect(transactionMocks.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      "course-monitoring:course-1",
    );
    expect(transactionMocks.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        where: {
          courseId: "course-1",
          availabilityStatus: "AVAILABLE",
          alertStatus: "PENDING",
        },
        data: {
          availabilityStatus: "GONE",
          alertStatus: "SUPPRESSED",
          unavailableAt: expect.any(Date),
        },
      },
    );
    expect(transactionMocks.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        where: {
          courseId: "course-1",
          availabilityStatus: "AVAILABLE",
        },
        data: {
          availabilityStatus: "GONE",
          unavailableAt: expect.any(Date),
        },
      },
    );
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
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
          idempotencyKey: "operator-provider-123456",
        },
        context,
      ),
    ).resolves.toMatchObject({
      action: "update_official_links",
      providerFamilyKey: "CPS",
      applied: true,
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        providerFamilyKey: "CPS",
        detectedPlatform: "CUSTOM",
        automationEligibility: "NEEDS_REVIEW",
      }),
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      {
        where: {
          courseId: "course-1",
          revision: 4,
        },
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          revalidationRequestedAt: expect.any(Date),
        }),
      },
    );
  });

  it("records a private course as a final identity outcome", async () => {
    const courseLock = createDeferred<Array<{ locked: boolean }>>();
    transactionMocks.$queryRawUnsafe.mockReturnValueOnce(courseLock.promise);
    const mutation = applyOperatorCourseDecision(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        decision: "PRIVATE_COURSE",
        evidenceUrl: "https://course.example/private-membership",
        note: "The official course page confirms that public play is not available.",
        idempotencyKey: "operator-private-123456",
      },
      context,
    );

    await vi.waitFor(() =>
      expect(transactionMocks.$queryRawUnsafe).toHaveBeenCalledOnce(),
    );
    expect(transactionMocks.course.update).not.toHaveBeenCalled();
    expect(transactionMocks.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    courseLock.resolve([{ locked: true }]);

    await expect(mutation).resolves.toMatchObject({
      action: "set_course_outcome",
      decision: "PRIVATE_COURSE",
      applied: true,
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        isPublic: false,
        automationEligibility: "BLOCKED",
        monitoringMode: "CONTACT_ONLY",
      }),
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      {
        where: {
          courseId: "course-1",
          revision: 4,
        },
        data: expect.objectContaining({
          state: "FINAL_IDENTITY",
          nextAutomaticAttemptAt: null,
        }),
      },
    );
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7,
      },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolution: "IDENTITY_CLASSIFIED",
        humanReviewReason: null,
      }),
    });
    expect(transactionMocks.teeTimeMatch.updateMany).toHaveBeenCalledTimes(2);
    expect(
      transactionMocks.courseMonitoringStatus.update.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      transactionMocks.teeTimeMatch.updateMany.mock.invocationCallOrder[0],
    );
    expect(
      transactionMocks.courseAutomationDiscovery.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "VERIFIED",
        sourceUrl: "https://course.example/private-membership",
        bookingUrl: null,
        bookingMethod: "UNKNOWN",
        bookingPhone: null,
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        evidence: expect.objectContaining({
          action: "set_course_outcome",
          classification: "PRIVATE_COURSE",
          note: "The official course page confirms that public play is not available.",
        }),
      }),
    });
  });

  it("rejects a final outcome without a safe official evidence URL", async () => {
    await expect(
      applyOperatorCourseDecision(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          decision: "PHONE_OR_MANUAL",
          evidenceUrl: "https://user:secret@course.example/tee-time-faq",
          note: "The official FAQ confirms the manual reservation process.",
          idempotencyKey: "operator-manual-unsafe",
        },
        context,
      ),
    ).rejects.toThrow("without credentials");
    expect(prismaMocks.courseMonitoringStatus.findFirst).not.toHaveBeenCalled();
  });

  it("rejects sensitive fragment data in an otherwise public final evidence URL", async () => {
    await expect(
      applyOperatorCourseDecision(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          decision: "PHONE_OR_MANUAL",
          evidenceUrl:
            "https://course.example/tee-time-faq#access_token=secret",
          note: "The official FAQ confirms the manual reservation process.",
          idempotencyKey: "operator-manual-fragment",
        },
        context,
      ),
    ).rejects.toThrow("sensitive fragment data");
    expect(prismaMocks.courseMonitoringStatus.findFirst).not.toHaveBeenCalled();
  });

  it("records a manual course with exact evidence without discarding known provider data", async () => {
    const publicBookingMetadata = {
      bookingBaseUrl: "https://booking.course.example/",
      facilityId: "public-facility-17",
    };
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      course: {
        ...status().course,
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "DRIVERPOS",
        bookingMetadata: publicBookingMetadata,
        policyNotes: "Prior public provider evidence.",
      },
    });

    await expect(
      applyOperatorCourseDecision(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          decision: "PHONE_OR_MANUAL",
          evidenceUrl: cabqFaqUrl,
          note: "The official FAQ says reservations alternate between in-person and phone requests.",
          idempotencyKey: "operator-manual-1234567",
        },
        context,
      ),
    ).resolves.toMatchObject({
      action: "set_course_outcome",
      decision: "PHONE_OR_MANUAL",
      applied: true,
    });

    const courseUpdate = transactionMocks.course.update.mock.calls.at(-1)?.[0];
    expect(courseUpdate).toEqual({
      where: { id: "course-1" },
      data: expect.objectContaining({
        bookingMethod: "CONTACT_COURSE",
        bookingAccessMode: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        monitoringMode: "CONTACT_ONLY",
      }),
    });
    expect(courseUpdate.data).toMatchObject({
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
    });
    expect(courseUpdate.data.bookingMetadata).toBe(Prisma.DbNull);
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7,
      },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolution: "DIRECT_BOOKING_CLASSIFIED",
        decisionEvidenceUrl: cabqFaqUrl,
        decisionNote:
          "The official FAQ says reservations alternate between in-person and phone requests.",
      }),
    });
    expect(
      transactionMocks.courseAutomationDiscovery.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "VERIFIED",
        sourceUrl: cabqFaqUrl,
        bookingUrl: null,
        bookingPhone: "555-0100",
        detectedPlatform: "UNKNOWN",
        bookingMethod: "CONTACT_COURSE",
        bookingAccessMode: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        evidence: expect.objectContaining({
          learnedFrom: "operator-final-decision",
          classification: "PHONE_OR_MANUAL",
          priorCourseSnapshot: expect.objectContaining({
            bookingMethod: "PUBLIC_ONLINE",
            detectedBookingUrl: "https://course.example/book",
            providerFamilyKey: "DRIVERPOS",
            bookingMetadata: publicBookingMetadata,
            bookingMetadataDisposition: "PRESERVED_PUBLIC",
          }),
          currentProjection: expect.objectContaining({
            detectedPlatform: "UNKNOWN",
            providerFamilyKey: "SOURCE_MISSING",
            bookingUrl: null,
            bookingMetadata: "CLEARED",
          }),
        }),
      }),
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toState: "FINAL_MANUAL",
        outcome: "MANUAL_DIRECT",
        evidenceUrl: cabqFaqUrl,
        message:
          "The official FAQ says reservations alternate between in-person and phone requests.",
        audit: expect.objectContaining({
          action: "set_course_outcome",
          cycle: 2,
          confirmedAt: "2026-08-20T12:00:00.000Z",
          automatedFinal: false,
        }),
      }),
    });
  });

  it("retains an exact manual action page while clearing active provider metadata", async () => {
    const manualActionUrl = "https://course.example/manual-request#tee-times";
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      course: {
        ...status().course,
        detectedPlatform: "CUSTOM",
        detectedBookingUrl: manualActionUrl,
        providerFamilyKey: "COURSE_EXAMPLE",
        bookingMetadata: {
          bookingBaseUrl: "https://course.example/manual-request",
          facilityId: "public-facility-17",
        },
      },
    });

    await applyOperatorCourseDecision(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        decision: "PHONE_OR_MANUAL",
        evidenceUrl: manualActionUrl,
        note: "The official request page confirms that the course handles reservations directly.",
        idempotencyKey: "operator-manual-action-page",
      },
      context,
    );

    const courseUpdate = transactionMocks.course.update.mock.calls.at(-1)?.[0];
    expect(courseUpdate.data).toMatchObject({
      detectedBookingUrl: manualActionUrl,
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "COURSE_EXAMPLE",
      bookingMethod: "CONTACT_COURSE",
      bookingAccessMode: "CONTACT_COURSE",
    });
    expect(courseUpdate.data.bookingMetadata).toBe(Prisma.DbNull);
    expect(
      transactionMocks.courseAutomationDiscovery.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        detectedPlatform: "CUSTOM",
        bookingUrl: manualActionUrl,
        bookingPhone: "555-0100",
        bookingMethod: "CONTACT_COURSE",
        bookingAccessMode: "CONTACT_COURSE",
      }),
    });
  });

  it("omits non-public provider metadata from the historical snapshot", async () => {
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      course: {
        ...status().course,
        bookingMetadata: {
          bookingBaseUrl: "https://course.example/manual-request",
          accessToken: "must-not-be-retained",
        },
      },
    });

    await applyOperatorCourseDecision(
      {
        reference,
        statusRevision: 4,
        incidentCycle: 2,
        incidentRevision: 7,
        decision: "PHONE_OR_MANUAL",
        evidenceUrl: cabqFaqUrl,
        note: "The official FAQ confirms the manual reservation process.",
        idempotencyKey: "operator-manual-private-metadata",
      },
      context,
    );

    expect(
      transactionMocks.courseAutomationDiscovery.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        evidence: expect.objectContaining({
          priorCourseSnapshot: expect.objectContaining({
            bookingMetadata: null,
            bookingMetadataDisposition: "OMITTED_NON_PUBLIC",
          }),
        }),
      }),
    });
  });

  it("does not append duplicate final evidence for an idempotent replay", async () => {
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue({
      courseId: "course-1",
    });

    await expect(
      applyOperatorCourseDecision(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          decision: "PHONE_OR_MANUAL",
          evidenceUrl: cabqFaqUrl,
          note: "The official FAQ confirms the manual reservation process.",
          idempotencyKey: "operator-manual-idempotent",
        },
        context,
      ),
    ).resolves.toMatchObject({ applied: false, replayed: true });

    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseAutomationDiscovery.create,
    ).not.toHaveBeenCalled();
  });

  it("rejects a technical final when the current incident cycle lacks playbook proof", async () => {
    await expect(
      approveOperatorCourseTechnicalFinal(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          reason: "CAPTCHA_OR_QUEUE",
          evidenceUrl: "https://course.example/evidence",
          note: "Confirmed the current signed-out technical limitation.",
          idempotencyKey: "operator-technical-final-reject",
        },
        context,
      ),
    ).rejects.toThrow(/terminal local-reader proof/i);
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("accepts a matching technical final only after reader and independent confirmation", async () => {
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue({
      ...status(),
      course: {
        ...status().course,
        supportIncident: {
          ...status().course.supportIncident,
          attemptLedger: technicalFinalLedger(),
        },
      },
    });

    await expect(
      approveOperatorCourseTechnicalFinal(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          reason: "CAPTCHA_OR_QUEUE",
          evidenceUrl: "https://course.example/evidence",
          note: "Confirmed the current signed-out technical limitation.",
          idempotencyKey: "operator-technical-final-accept",
        },
        context,
      ),
    ).resolves.toMatchObject({
      action: "approve_technical_final",
      applied: true,
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "FINAL_TECHNICAL" }),
      }),
    );
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RESOLVED",
          resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
        }),
      }),
    );
    expect(
      transactionMocks.courseAutomationDiscovery.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "VERIFIED",
        sourceUrl: "https://course.example/evidence",
        bookingMethod: "PUBLIC_ONLINE",
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        evidence: expect.objectContaining({
          action: "approve_technical_final",
          classification: "CAPTCHA_OR_QUEUE",
          note: "Confirmed the current signed-out technical limitation.",
        }),
      }),
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "HUMAN_DECISION",
        toState: "FINAL_TECHNICAL",
        audit: expect.objectContaining({
          action: "approve_technical_final",
          cycle: 2,
          confirmedAt: "2026-08-20T12:00:00.000Z",
          automatedFinal: false,
        }),
      }),
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
          idempotencyKey: "operator-temporary-123456",
        },
        context,
      ),
    ).resolves.toMatchObject({
      action: "set_course_outcome",
      decision: "WEBSITE_TEMPORARILY_UNAVAILABLE",
      retryAt: expect.any(Date),
      applied: true,
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "TEMPORARILY_UNAVAILABLE",
        intelligenceReviewAt: expect.any(Date),
      }),
    });
    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      {
        where: {
          courseId: "course-1",
          revision: 4,
        },
        data: expect.objectContaining({
          state: "DEGRADED_RETRYING",
          nextAutomaticAttemptAt: expect.any(Date),
          revalidationRequestedAt: null,
        }),
      },
    );
    const retryAt =
      transactionMocks.courseMonitoringStatus.update.mock.calls.at(-1)?.[0].data
        .nextAutomaticAttemptAt as Date;
    expect(retryAt.getTime()).toBeGreaterThanOrEqual(
      retryStartedAt + 6 * 60 * 60 * 1000,
    );
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7,
      },
      data: expect.objectContaining({
        status: "AUTO_INVESTIGATING",
        kind: "FETCH_FAILED",
        nextAttemptAt: retryAt,
        resolvedAt: null,
        resolution: null,
      }),
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "HUMAN_DECISION",
        toState: "DEGRADED_RETRYING",
        outcome: "FETCH_FAILED",
        audit: expect.objectContaining({
          decision: "WEBSITE_TEMPORARILY_UNAVAILABLE",
          timerBasedRevalidation: true,
        }),
      }),
    });
  });

  it("routes the course to the local reader and queues a fresh reader check", async () => {
    localReaderMocks.queueLocalReaderCourseVerification.mockResolvedValue({
      id: "local-reader-job-2",
    });

    await expect(
      applyOperatorCourseDecision(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          decision: "LOCAL_READER",
          idempotencyKey: "operator-reader-1234567",
        },
        context,
      ),
    ).resolves.toMatchObject({
      action: "set_course_outcome",
      decision: "LOCAL_READER",
      localReaderQueued: true,
      applied: true,
    });

    expect(transactionMocks.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: expect.objectContaining({
        monitoringMode: "LOCAL_READER_ONLY",
        automationEligibility: "NEEDS_REVIEW",
      }),
    });
    expect(transactionMocks.courseSupportIncident.update).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        revision: 7,
      },
      data: expect.objectContaining({
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        kind: "READER_CANDIDATE",
        failureClass: "READER_PARSER_MISSING",
      }),
    });
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).toHaveBeenCalledWith({
      courseId: "course-1",
      targetDate: expect.any(String),
      players: 2,
      bookingUrl: "https://course.example/book",
      force: true,
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
          idempotencyKey: "operator-reader-unsupported",
        },
        context,
      ),
    ).rejects.toThrow("not supported by the local tee-time reader yet");

    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).toHaveBeenCalledWith({
      courseId: "course-1",
      targetDate: expect.any(String),
      players: 2,
      bookingUrl: "https://course.example/book",
      force: true,
    });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
    expect(transactionMocks.course.update).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringStatus.update,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportIncident.update,
    ).not.toHaveBeenCalled();
  });
});
