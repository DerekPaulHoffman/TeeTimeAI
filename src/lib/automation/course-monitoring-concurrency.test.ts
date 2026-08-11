import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionMocks = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(),
  courseMonitoringEvent: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  courseMonitoringStatus: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  courseSupportIncident: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  teeSearch: {
    updateMany: vi.fn(),
  },
}));

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  courseMonitoringEvent: {},
  courseMonitoringStatus: {},
  courseSupportIncident: {
    findMany: vi.fn(),
  },
  automationRun: {
    upsert: vi.fn(),
  },
  teeSearch: {},
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import {
  recordCourseMonitoringFinalClassification,
  recordCourseMonitoringPlaybookTransition,
  recordCourseMonitoringSuccess,
  revalidateCourseMonitoringForProviderEvidenceChange,
  revalidateHumanReviewCoursesForDeployment,
} from "./course-monitoring";

describe("course monitoring write serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.$transaction
      .mockRejectedValueOnce(
        Object.assign(new Error("Transaction failed due to a write conflict"), {
          code: "P2034",
        }),
      )
      .mockImplementation(async (worker) => worker(transactionMocks));
    transactionMocks.$queryRawUnsafe.mockResolvedValue([]);
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "HEALTHY",
      revision: 7,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue(null);
    transactionMocks.courseMonitoringStatus.create.mockResolvedValue({
      courseId: "course-1",
    });
    transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
      courseId: "course-1",
      state: "HEALTHY",
      revision: 8,
    });
    transactionMocks.courseMonitoringEvent.create.mockResolvedValue({
      id: "event-1",
    });
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    transactionMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1,
    });
    transactionMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 1 });
  });

  it("retries a write conflict and serializes writes by course", async () => {
    await expect(
      recordCourseMonitoringSuccess({
        courseId: "course-1",
        outcome: "NO_MATCH",
        now: new Date("2026-07-27T15:45:00.000Z"),
      }),
    ).resolves.toMatchObject({
      courseId: "course-1",
      state: "HEALTHY",
      revision: 8,
    });

    expect(prismaMocks.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMocks.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: "ReadCommitted",
        timeout: 15_000,
      }),
    );
    expect(transactionMocks.$queryRawUnsafe).toHaveBeenCalledWith(
      `WITH acquired AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))
     )
     SELECT true AS locked FROM acquired`,
      "course-monitoring:course-1",
    );
  });

  it.each([
    ["manual", "FINAL_MANUAL", "MANUAL_DIRECT"],
    ["identity", "FINAL_IDENTITY", "IDENTITY_FINAL"],
  ] as const)(
    "does not rewrite or append a transition for an unchanged clean %s final",
    async (_label, state, outcome) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 8,
      });

      await expect(
        recordCourseMonitoringFinalClassification({
          courseId: "course-1",
          state,
          outcome,
          message: "Official evidence confirms the final classification.",
          now: new Date("2026-07-27T15:50:00.000Z"),
        }),
      ).resolves.toMatchObject({
        state,
        revision: 8,
      });

      expect(
        transactionMocks.courseMonitoringStatus.update,
      ).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseMonitoringEvent.create,
      ).not.toHaveBeenCalled();
    },
  );

  it("repairs a dirty final snapshot without recording a same-state transition", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 2,
      failureFingerprint: "PHONE_ONLY:STALE",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8,
    });
    transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 0,
      revision: 9,
    });

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      message: "Official evidence confirms phone-only booking.",
      now: new Date("2026-07-27T15:50:00.000Z"),
    });

    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      {
        where: {
          courseId: "course-1",
          revision: 8,
        },
        data: {
          state: "FINAL_MANUAL",
          consecutiveFailures: 0,
          failureFingerprint: null,
          firstDegradedAt: null,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          revision: { increment: 1 },
        },
      },
    );
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("records one transition when a course enters a manual final state", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      consecutiveFailures: 3,
      failureFingerprint: "PHONE_ONLY:CONFIRMED",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8,
    });
    transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 0,
      revision: 9,
    });
    const now = new Date("2026-07-27T15:50:00.000Z");

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      message: "Official evidence confirms phone-only booking.",
      evidenceUrl: "https://course.example/booking",
      runtimeVersion: "release-sha",
      now,
    });

    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "FINAL_MANUAL",
          stateChangedAt: now,
        }),
      }),
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(
      1,
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "STATE_CHANGED",
        fromState: "AUTO_INVESTIGATING",
        toState: "FINAL_MANUAL",
        outcome: "MANUAL_DIRECT",
        occurredAt: now,
      }),
    });
  });

  it("queues active real searches for an external factual final transition", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      consecutiveFailures: 1,
      failureFingerprint: "SOURCE:UNKNOWN",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8,
    });
    const now = new Date("2026-07-27T15:50:00.000Z");

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      source: "COURSE_SUPPORT_RESPONDER",
      message: "Official evidence confirms direct action.",
      now,
    });

    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        trafficClass: { notIn: ["AUTOMATION", "TEST"] },
        preferences: { some: { courseId: "course-1" } },
      },
      data: { nextCheckAt: now, recheckRequestedAt: now },
    });
  });

  it("does not queue a duplicate self-recheck for a search-workflow final", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      consecutiveFailures: 1,
      failureFingerprint: "SOURCE:UNKNOWN",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8,
    });

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      source: "SEARCH_WORKFLOW",
      message: "Official evidence confirms direct action.",
    });

    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("appends playbook proof without consuming the legacy responder attempt ladder", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 1,
      revision: 7,
      status: "AUTO_INVESTIGATING",
      attemptLedger: null,
    });
    transactionMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    const now = new Date("2026-07-27T15:55:00.000Z");

    await recordCourseMonitoringPlaybookTransition({
      courseId: "course-1",
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:OFFICIAL_IDENTITY:COMPLETED",
      runtimeVersion: "release-sha",
      now,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptLedger: expect.any(Object),
          revision: { increment: 1 },
        }),
      }),
    );
    const updateData =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("attemptCount");
    expect(updateData).not.toHaveProperty("lastAttemptAt");
  });

  it("opens one deployment revalidation cycle per course and deployed SHA", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const now = new Date("2026-07-27T16:00:00.000Z");
    prismaMocks.automationRun.upsert.mockResolvedValue({ startedAt: now });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    transactionMocks.courseMonitoringEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "deployment-event" });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 3,
      revision: 9,
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      activeBatchId: null,
      failureFingerprint: "SOURCE:UNKNOWN",
      activeRealSearchCount: 1,
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      firstSeenAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 4,
    });
    const deploymentSha = "a".repeat(40);

    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 1,
      requeued: 1,
      retainedAuthoritativeFinals: 0,
    });
    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 1,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });
    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 1,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });

    expect(prismaMocks.courseSupportIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        where: expect.objectContaining({
          monitoringEvents: {
            none: {
              source: "DEPLOYMENT",
              deploymentSha,
              eventType: {
                in: ["REVALIDATION_REQUESTED", "DEPLOYMENT_VERIFIED"],
              },
            },
          },
        }),
      }),
    );
    expect(transactionMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(1);
    expect(transactionMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
        }),
      }),
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: "DEPLOYMENT",
        deploymentSha,
        idempotencyKey: expect.stringMatching(/^course-deploy-revalidate:[a-f0-9]{64}$/),
        audit: expect.objectContaining({ customerDataIncluded: false }),
      }),
    });
  });

  it("opens one deployment cycle for a customer-visible automation stall", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const now = new Date("2026-07-27T16:00:00.000Z");
    const deploymentSha = "c".repeat(40);
    prismaMocks.automationRun.upsert.mockResolvedValue({ startedAt: now });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-stalled" },
    ]);
    transactionMocks.courseMonitoringEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "deployment-stalled-event" });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-stalled",
      cycle: 5,
      revision: 11,
      status: "AUTO_INVESTIGATING",
      humanReviewReason: "AUTOMATION_STALLED",
      activeBatchId: null,
      failureFingerprint: "SOURCE:UNKNOWN",
      activeRealSearchCount: 1,
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      firstSeenAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-stalled",
      state: "AUTO_INVESTIGATING",
      revision: 8,
    });

    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 1,
      requeued: 1,
      retainedAuthoritativeFinals: 0,
    });
    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 1,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });

    expect(prismaMocks.courseSupportIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                { status: "NEEDS_HUMAN" },
                {
                  status: "AUTO_INVESTIGATING",
                  humanReviewReason: "AUTOMATION_STALLED",
                },
              ],
            },
          ]),
        }),
      }),
    );
    expect(transactionMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(1);
    expect(transactionMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-stalled",
          cycle: 5,
          revision: 11,
          status: "AUTO_INVESTIGATING",
          humanReviewReason: "AUTOMATION_STALLED",
          activeBatchId: null,
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          nextAttemptAt: now,
          escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
        }),
      }),
    );
    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { nextCheckAt: now, recheckRequestedAt: now },
      }),
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        source: "DEPLOYMENT",
        deploymentSha,
        audit: expect.objectContaining({ priorCycle: 5, cycle: 6 }),
      }),
    });
  });

  it("advances beyond twenty deployment candidates without replay starvation", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const now = new Date("2026-07-27T16:00:00.000Z");
    const deploymentSha = "b".repeat(40);
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      courseId: `course-${index + 1}`,
    }));
    prismaMocks.automationRun.upsert.mockResolvedValue({ startedAt: now });
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce(candidates.slice(0, 20))
      .mockResolvedValueOnce(candidates.slice(20));
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    transactionMocks.courseSupportIncident.findUnique.mockImplementation(
      async ({ where }: { where: { courseId: string } }) => ({
        id: `incident-${where.courseId}`,
        courseId: where.courseId,
        cycle: 2,
        revision: 7,
        status: "NEEDS_HUMAN",
        humanReviewReason: "CAPTCHA_OR_QUEUE",
        activeBatchId: null,
        failureFingerprint: "SOURCE:UNKNOWN",
        activeRealSearchCount: 1,
        escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
        firstSeenAt: new Date("2026-07-27T15:00:00.000Z"),
      }),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockImplementation(
      async ({ where }: { where: { courseId: string } }) => ({
        courseId: where.courseId,
        state:
          where.courseId === "course-25"
            ? "FINAL_MANUAL"
            : "ENGINEERING_VERIFICATION_NEEDED",
        revision: 4,
      }),
    );

    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 20,
      requeued: 20,
      retainedAuthoritativeFinals: 0,
    });
    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 5,
      requeued: 4,
      retainedAuthoritativeFinals: 1,
    });

    expect(prismaMocks.courseSupportIncident.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        take: 20,
        where: expect.objectContaining({
          monitoringEvents: {
            none: expect.objectContaining({ deploymentSha }),
          },
        }),
      }),
    );
    expect(transactionMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(24);
    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledTimes(24);
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(25);
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "DEPLOYMENT_VERIFIED",
        fromState: "FINAL_MANUAL",
        toState: "FINAL_MANUAL",
        deploymentSha,
      }),
    });
  });

  it("opens a fresh playbook cycle and queues real searches when provider metadata changes during human review", async () => {
    const now = new Date("2026-08-11T13:00:00.000Z");
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 4,
      revision: 9,
      status: "NEEDS_HUMAN",
      activeBatchId: null,
      activeRealSearchCount: 2,
      failureFingerprint: "CPS:CHALLENGE",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      resolution: null,
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 6,
    });
    transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: {
          providerFamilyKey: "CPS",
          bookingMetadata: { parserVersion: 1, tenantId: "tenant" },
        },
        after: {
          providerFamilyKey: "CPS",
          bookingMetadata: { parserVersion: 2, tenantId: "tenant" },
        },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toEqual({
      outcome: "REQUEUED",
      changedFields: ["bookingMetadata"],
      searchesQueued: 2,
    });

    expect(transactionMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          cycle: 4,
          revision: 9,
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          nextAttemptAt: now,
        }),
      }),
    );
    expect(transactionMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        revision: 6,
        state: "ENGINEERING_VERIFICATION_NEEDED",
      },
      data: {
        state: "AUTO_INVESTIGATING",
        nextAutomaticAttemptAt: now,
        revalidationRequestedAt: now,
        stateChangedAt: now,
        revision: { increment: 1 },
      },
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        idempotencyKey: expect.stringMatching(/^course-provider-evidence-revalidate:/u),
        audit: expect.objectContaining({
          priorCycle: 4,
          cycle: 5,
          changedFields: ["bookingMetadata"],
          customerDataIncluded: false,
        }),
      }),
    });
    const event = transactionMocks.courseMonitoringEvent.create.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(event)).not.toContain("tenant");
  });

  it("immediately restarts an automation-stalled cycle when access and monitoring evidence changes", async () => {
    const now = new Date("2026-08-11T14:00:00.000Z");
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-stalled",
      cycle: 7,
      revision: 12,
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      activeRealSearchCount: 1,
      failureFingerprint: "READER:PARSER",
      humanReviewReason: "AUTOMATION_STALLED",
      resolution: null,
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 3,
    });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: {
          bookingAccessMode: "CAPTCHA_OR_QUEUE",
          monitoringMode: "LOCAL_READER_ONLY",
        },
        after: {
          bookingAccessMode: "PUBLIC_SIGNED_OUT",
          monitoringMode: "AUTOMATIC",
        },
        source: "LOCAL_READER",
        now,
      }),
    ).resolves.toMatchObject({
      outcome: "REQUEUED",
      changedFields: ["bookingAccessMode", "monitoringMode"],
    });

    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        trafficClass: { notIn: ["AUTOMATION", "TEST"] },
        preferences: { some: { courseId: "course-1" } },
      },
      data: { nextCheckAt: now, recheckRequestedAt: now },
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        audit: expect.objectContaining({
          reason: "AUTOMATION_STALLED_PROVIDER_EVIDENCE_CHANGED",
        }),
      }),
    });
  });

  it("ignores immaterial evidence refreshes and metadata key-order changes", async () => {
    const now = new Date("2026-08-11T15:00:00.000Z");

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: {
          providerFamilyKey: "FOREUP",
          bookingMetadata: { bookingClassId: 8, scheduleId: 4 },
          policyNotes: "older note",
          intelligenceVerifiedAt: new Date("2026-08-10T00:00:00.000Z"),
        },
        after: {
          providerFamilyKey: "FOREUP",
          bookingMetadata: { scheduleId: 4, bookingClassId: 8 },
          policyNotes: "newer note",
          intelligenceVerifiedAt: now,
        },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toEqual({
      outcome: "IMMATERIAL",
      changedFields: [],
      searchesQueued: 0,
    });

    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
    expect(transactionMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["FINAL_MANUAL", "DIRECT_BOOKING_CLASSIFIED"],
    ["FINAL_IDENTITY", "IDENTITY_CLASSIFIED"],
  ])("preserves authoritative %s when provider evidence changes", async (state, resolution) => {
    const now = new Date("2026-08-11T16:00:00.000Z");
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-final",
      cycle: 2,
      revision: 5,
      status: "RESOLVED",
      activeBatchId: null,
      activeRealSearchCount: 1,
      failureFingerprint: "FACTUAL:FINAL",
      humanReviewReason: null,
      resolution,
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state,
      revision: 8,
    });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: { detectedBookingUrl: "https://old.example/booking" },
        after: { detectedBookingUrl: "https://new.example/booking" },
        source: "OPERATOR_CLI",
        now,
      }),
    ).resolves.toMatchObject({
      outcome: "AUTHORITATIVE_FINAL_PRESERVED",
      searchesQueued: 0,
    });

    expect(transactionMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(transactionMocks.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromState: state,
        toState: state,
        idempotencyKey: expect.stringMatching(/^course-provider-evidence-revalidate:/u),
        audit: expect.objectContaining({ authoritativeFinalRetained: true }),
      }),
    });
  });
});
