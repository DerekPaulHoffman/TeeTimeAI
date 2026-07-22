import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  batchFindUnique: vi.fn(),
  requestFindUnique: vi.fn(),
  requestFindMany: vi.fn(),
  requestCreateMany: vi.fn(),
  requestUpdateMany: vi.fn(),
  incidentUpdateMany: vi.fn(),
  batchIncidentUpdateMany: vi.fn(),
  activeSearchCount: vi.fn(),
  rootRequestFindMany: vi.fn(),
  rootRequestUpdateMany: vi.fn()
}));

const transactionClient = {
  courseSupportBatch: { findUnique: prismaMocks.batchFindUnique },
  courseSupportVerificationRequest: {
    findUnique: prismaMocks.requestFindUnique,
    findMany: prismaMocks.requestFindMany,
    createMany: prismaMocks.requestCreateMany,
    updateMany: prismaMocks.requestUpdateMany
  },
  courseSupportIncident: { updateMany: prismaMocks.incidentUpdateMany },
  courseSupportBatchIncident: {
    updateMany: prismaMocks.batchIncidentUpdateMany
  },
  teeSearch: { count: prismaMocks.activeSearchCount }
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: prismaMocks.transaction,
    courseSupportVerificationRequest: {
      findMany: prismaMocks.rootRequestFindMany,
      updateMany: prismaMocks.rootRequestUpdateMany
    }
  }
}));

import {
  attachCourseSupportVerificationProviderSnapshot,
  attachCourseSupportVerificationWorkflow,
  buildCourseSupportProviderSnapshotFingerprint,
  buildCourseSupportVerificationIntent,
  claimCourseSupportVerificationRequest,
  completeCourseSupportVerificationRequest,
  failCourseSupportVerificationRequest,
  getCurrentCourseSupportVerificationFailure,
  getEligibleCourseSupportVerificationProof,
  heartbeatCourseSupportVerificationRequest,
  listDueCourseSupportVerificationRequests,
  markCourseSupportVerificationDiscoveryAttempted,
  markCourseSupportVerificationDiscoveryVerified,
  resolveCourseSupportProviderRetryNotBeforeAt,
  resolveCourseSupportVerificationRetryAt,
  scheduleCourseSupportVerificationRequests
} from "./course-support-verification";

const releaseSha = "a".repeat(40);
const newerReleaseSha = "b".repeat(40);
const now = new Date("2026-07-21T12:00:00.000Z");

function currentIntelligence() {
  return {
    intelligenceVerifiedAt: new Date("2026-07-20T12:00:00.000Z"),
    intelligenceReviewAt: new Date("2026-08-20T12:00:00.000Z"),
    intelligenceConfidence: 0.95
  };
}

function course(overrides: Record<string, unknown> = {}) {
  return {
    id: "course-1",
    timeZone: "America/New_York",
    website: "https://course.example/",
    detectedBookingUrl: "https://book.example/tee-times?token=never-persist-this",
    detectedPlatform: "CUSTOM",
    providerFamilyKey: "CPS",
    bookingMethod: "PUBLIC_ONLINE",
    bookingWindowDaysAhead: 7,
    bookingReleaseTimeLocal: "07:00",
    bookingWindowSource: "PROVIDER_CONFIG",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    isPublic: true,
    intelligenceVerifiedAt: null,
    intelligenceReviewAt: null,
    intelligenceConfidence: null,
    bookingMetadata: {
      provider: "CPS",
      facilityId: "opaque-provider-value",
      nested: { second: 2, first: 1 }
    },
    ...overrides
  };
}

function fingerprint(courseValue = course()) {
  return buildCourseSupportProviderSnapshotFingerprint(
    courseValue as Parameters<
      typeof buildCourseSupportProviderSnapshotFingerprint
    >[0]
  );
}

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: "incident-1",
    cycle: 1,
    activeBatchId: "batch-1",
    engineeringOnly: true,
    activeRealSearchCount: 0,
    earliestTargetDate: null,
    updatedAt: new Date("2026-07-21T11:55:00.000Z"),
    status: "AUTO_INVESTIGATING",
    ...overrides
  };
}

function request(overrides: Record<string, unknown> = {}) {
  const providerCourse = course();
  return {
    id: "request-1",
    batchIncidentId: "batch-incident-1",
    courseId: "course-1",
    releaseSha,
    runtimeVersion: releaseSha,
    status: "CHECKING",
    revision: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date("2026-07-21T12:10:00.000Z"),
    nextAttemptAt: null,
    targetDateLocal: "2026-07-21",
    startTimeLocal: "06:00",
    endTimeLocal: "20:00",
    timeZone: "America/New_York",
    players: 1,
    providerSnapshotFingerprint: fingerprint(providerCourse),
    discoveryAttemptedAt: new Date("2026-07-21T11:57:00.000Z"),
    discoveryVerifiedAt: new Date("2026-07-21T11:58:00.000Z"),
    startedAt: new Date("2026-07-21T11:59:00.000Z"),
    createdAt: new Date("2026-07-21T11:00:00.000Z"),
    batchIncident: {
      id: "batch-incident-1",
      batchId: "batch-1",
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 1,
      verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
      batch: {
        id: "batch-1",
        status: "VERIFYING",
        releaseSha,
        completedAt: null
      },
      incident: incident()
    },
    course: providerCourse,
    ...overrides
  };
}

function verificationEvidence(
  outcome = "NO_MATCH",
  providerExecution = true
) {
  return {
    schemaVersion: 1,
    kind: "PROVIDER_VERIFICATION",
    providerExecution,
    releaseSha,
    runtimeVersion: releaseSha,
    observedAt: now.toISOString(),
    outcome,
    providerSnapshotFingerprint: fingerprint()
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.transaction.mockImplementation(
    async (worker: (client: typeof transactionClient) => Promise<unknown>) =>
      worker(transactionClient)
  );
  prismaMocks.activeSearchCount.mockResolvedValue(0);
  prismaMocks.requestUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.batchIncidentUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.rootRequestUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.requestCreateMany.mockResolvedValue({ count: 1 });
  prismaMocks.requestFindMany.mockResolvedValue([]);
});

describe("course-support verification intent and fingerprint", () => {
  it("generates a bounded one-player intent on the course-local current day", () => {
    expect(
      buildCourseSupportVerificationIntent(
        "America/Los_Angeles",
        new Date("2026-07-21T02:00:00.000Z")
      )
    ).toEqual({
      targetDateLocal: "2026-07-20",
      startTimeLocal: "06:00",
      endTimeLocal: "20:00",
      timeZone: "America/Los_Angeles",
      players: 1
    });
  });

  it("uses a stable full digest and changes it when provider execution inputs change", () => {
    const left = fingerprint();
    const reordered = fingerprint(
      course({
        bookingMetadata: {
          nested: { first: 1, second: 2 },
          facilityId: "opaque-provider-value",
          provider: "CPS"
        }
      })
    );
    const changed = fingerprint(
      course({ bookingMetadata: { provider: "CPS", facilityId: "changed" } })
    );
    const accessChanged = fingerprint(course({ isPublic: false }));
    const intelligenceChanged = fingerprint(
      course({
        intelligenceVerifiedAt: new Date("2026-07-20T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-20T12:00:00.000Z"),
        intelligenceConfidence: 0.95
      })
    );

    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(left);
    expect(changed).not.toBe(left);
    expect(accessChanged).not.toBe(left);
    expect(intelligenceChanged).not.toBe(left);
  });
});

describe("course-support verification scheduling", () => {
  it("creates requests for inactive courses regardless of incident provenance", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident(),
          course: course()
        },
        {
          id: "batch-incident-real",
          incidentId: "incident-real",
          courseId: "course-real",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            id: "incident-real",
            engineeringOnly: false
          }),
          course: course({ id: "course-real" })
        }
      ]
    });
    prismaMocks.requestFindMany.mockResolvedValue([
      {
        id: "request-1",
        batchIncidentId: "batch-incident-1",
        releaseSha,
        status: "QUEUED",
        revision: 0,
        nextAttemptAt: now
      },
      {
        id: "request-real",
        batchIncidentId: "batch-incident-real",
        releaseSha,
        status: "QUEUED",
        revision: 0,
        nextAttemptAt: now
      }
    ]);
    prismaMocks.requestCreateMany.mockResolvedValueOnce({ count: 2 });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now
      })
    ).resolves.toMatchObject({
      createdCount: 2,
      eligibleCount: 2,
      ineligibleCount: 0
    });

    const create = prismaMocks.requestCreateMany.mock.calls[0][0];
    expect(create.data).toHaveLength(2);
    expect(create.data[0]).toMatchObject({
      batchIncidentId: "batch-incident-1",
      courseId: "course-1",
      releaseSha,
      targetDateLocal: "2026-07-21",
      startTimeLocal: "06:00",
      endTimeLocal: "20:00",
      players: 1,
      providerFamilyKeySnapshot: "CPS"
    });
    expect(create.data[0]).not.toHaveProperty("website");
    expect(create.data[0]).not.toHaveProperty("detectedBookingUrl");
    expect(create.data[0]).not.toHaveProperty("bookingMetadata");
    expect(create.data[0]).not.toHaveProperty("teeSearchId");
    expect(create.data[0]).not.toHaveProperty("recipient");
    expect(prismaMocks.activeSearchCount).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-21T00:00:00.000Z") },
        preferences: { some: { courseId: "course-1" } }
      }
    });
  });

  it("reconciles stale real-demand cache before detached verification", async () => {
    const incidentUpdatedAt = new Date("2026-07-21T11:55:00.000Z");
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-real",
          incidentId: "incident-real",
          courseId: "course-real",
          cycle: 1,
          verifiedIncidentUpdatedAt: incidentUpdatedAt,
          incident: incident({
            id: "incident-real",
            engineeringOnly: false,
            activeRealSearchCount: 1,
            earliestTargetDate: new Date("2026-07-22T00:00:00.000Z"),
            updatedAt: incidentUpdatedAt
          }),
          course: course({ id: "course-real" })
        }
      ]
    });
    prismaMocks.requestFindMany.mockResolvedValue([
      {
        id: "request-real",
        batchIncidentId: "batch-incident-real",
        releaseSha,
        status: "QUEUED",
        revision: 0,
        nextAttemptAt: now
      }
    ]);

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now
      })
    ).resolves.toMatchObject({
      createdCount: 1,
      eligibleCount: 1,
      ineligibleCount: 0
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-real",
        cycle: 1,
        activeBatchId: "batch-1",
        status: "AUTO_INVESTIGATING",
        updatedAt: incidentUpdatedAt,
        activeRealSearchCount: 1,
        earliestTargetDate: new Date("2026-07-22T00:00:00.000Z")
      },
      data: {
        activeRealSearchCount: 0,
        earliestTargetDate: null,
        updatedAt: now
      }
    });
    expect(prismaMocks.batchIncidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "batch-incident-real",
        batchId: "batch-1",
        incidentId: "incident-real",
        cycle: 1,
        verifiedIncidentUpdatedAt: incidentUpdatedAt
      },
      data: { verifiedIncidentUpdatedAt: now }
    });
    const requestData = prismaMocks.requestCreateMany.mock.calls[0][0].data[0];
    expect(requestData).not.toHaveProperty("teeSearchId");
    expect(requestData).not.toHaveProperty("recipient");
    expect(requestData).not.toHaveProperty("match");
    expect(requestData).not.toHaveProperty("delivery");
    expect(prismaMocks.incidentUpdateMany.mock.calls[0][0].data).not.toHaveProperty(
      "engineeringOnly"
    );
  });

  it("fails closed when stale demand reconciliation loses its incident fence", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-real",
          incidentId: "incident-real",
          courseId: "course-real",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            id: "incident-real",
            engineeringOnly: false,
            activeRealSearchCount: 1,
            earliestTargetDate: new Date("2026-07-22T00:00:00.000Z")
          }),
          course: course({ id: "course-real" })
        }
      ]
    });
    prismaMocks.incidentUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now
      })
    ).resolves.toEqual({
      createdCount: 0,
      eligibleCount: 0,
      ineligibleCount: 1,
      requests: []
    });
    expect(prismaMocks.batchIncidentUpdateMany).not.toHaveBeenCalled();
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
  });

  it("rolls back scheduling when the batch proof-version fence is lost", async () => {
    const incidentUpdatedAt = new Date("2026-07-21T11:55:00.000Z");
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-real",
          incidentId: "incident-real",
          courseId: "course-real",
          cycle: 1,
          verifiedIncidentUpdatedAt: incidentUpdatedAt,
          incident: incident({
            id: "incident-real",
            engineeringOnly: false,
            activeRealSearchCount: 1,
            earliestTargetDate: new Date("2026-07-22T00:00:00.000Z"),
            updatedAt: incidentUpdatedAt
          }),
          course: course({ id: "course-real" })
        }
      ]
    });
    prismaMocks.batchIncidentUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now
      })
    ).rejects.toThrow("demand changed while detached verification was scheduled");

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" }
    );
  });

  it("does not schedule an engineering request while any active future pair exists", async () => {
    const localTransition = new Date("2026-07-21T02:00:00.000Z");
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          courseId: "course-1",
          cycle: 1,
          incident: incident(),
          course: course({ timeZone: "America/Los_Angeles" })
        }
      ]
    });
    prismaMocks.activeSearchCount.mockResolvedValue(1);

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now: localTransition
      })
    ).resolves.toEqual({
      createdCount: 0,
      eligibleCount: 0,
      ineligibleCount: 1,
      requests: []
    });
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.activeSearchCount).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-20T00:00:00.000Z") },
        preferences: { some: { courseId: "course-1" } }
      }
    });
  });

  it("does not schedule detached work for a currently non-actionable course", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          courseId: "course-1",
          cycle: 1,
          incident: incident(),
          course: course({
            automationEligibility: "BLOCKED",
            automationReason: "CAPTCHA_OR_QUEUE",
            ...currentIntelligence()
          })
        }
      ]
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now
      })
    ).resolves.toEqual({
      createdCount: 0,
      eligibleCount: 0,
      ineligibleCount: 1,
      requests: []
    });
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("rejects scheduling against a release other than the batch release", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha: newerReleaseSha,
      completedAt: null,
      incidents: []
    });
    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now
      })
    ).rejects.toThrow("must equal the batch release SHA");
  });

  it("rejects scheduling once the owning batch is no longer verifying", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "RETRYABLE_FAILED",
      releaseSha,
      completedAt: now,
      incidents: []
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now
      })
    ).rejects.toThrow("actively verifying batch");
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
  });

  it("rejects scheduling when a stale VERIFYING batch is already completed", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: now,
      incidents: []
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now
      })
    ).rejects.toThrow("actively verifying batch");
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("lists only due and expired-lease states with a bounded limit", async () => {
    prismaMocks.rootRequestFindMany.mockResolvedValue([]);
    await listDueCourseSupportVerificationRequests({
      now,
      limit: Number.NaN
    });

    expect(prismaMocks.rootRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: { gt: new Date("2026-07-20T12:00:00.000Z") },
          OR: [
            { status: "QUEUED", nextAttemptAt: { lte: now } },
            { status: "RETRYABLE_FAILED", nextAttemptAt: { lte: now } },
            { status: "CHECKING", leaseExpiresAt: { lte: now } }
          ]
        },
        take: 20
      })
    );
    expect(prismaMocks.rootRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
        createdAt: { lte: new Date("2026-07-20T12:00:00.000Z") }
      },
      data: {
        status: "STALE",
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "request_horizon_exceeded",
        updatedAt: now
      }
    });
  });
});

describe("course-support verification execution fencing", () => {
  it("stales a request at its absolute 24-hour execution horizon", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        createdAt: new Date("2026-07-20T12:00:00.000Z")
      })
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: releaseSha,
        now
      })
    ).resolves.toEqual({
      claimed: false,
      reason: "request_horizon_exceeded"
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          completedAt: now,
          lastError: "request_horizon_exceeded"
        })
      })
    );
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("stales work from a runtime other than the exact release SHA", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now
      })
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: newerReleaseSha,
        now
      })
    ).resolves.toEqual({ claimed: false, reason: "runtime_mismatch" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "runtime_mismatch"
        })
      })
    );
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("stales an old request once its batch advances to a newer release", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        batchIncident: {
          id: "batch-incident-1",
          batchId: "batch-1",
          courseId: "course-1",
          cycle: 1,
          batch: {
            id: "batch-1",
            status: "VERIFYING",
            releaseSha: newerReleaseSha,
            completedAt: null
          },
          incident: incident()
        }
      })
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: newerReleaseSha,
        now
      })
    ).resolves.toEqual({
      claimed: false,
      reason: "batch_release_changed"
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "STALE" })
      })
    );
  });

  it.each([
    {
      label: "closed batch",
      batchStatus: "RETRYABLE_FAILED",
      batchCompletedAt: now,
      incidentCycle: 1,
      activeBatchId: "batch-1",
      reason: "batch_not_verifying"
    },
    {
      label: "reopened incident cycle",
      batchStatus: "VERIFYING",
      batchCompletedAt: null,
      incidentCycle: 2,
      activeBatchId: "batch-1",
      reason: "batch_ownership_changed"
    },
    {
      label: "released incident ownership",
      batchStatus: "VERIFYING",
      batchCompletedAt: null,
      incidentCycle: 1,
      activeBatchId: null,
      reason: "batch_ownership_changed"
    }
  ])(
    "stales due work after a $label",
    async ({
      batchStatus,
      batchCompletedAt,
      incidentCycle,
      activeBatchId,
      reason
    }) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        request({
          runtimeVersion: null,
          status: "QUEUED",
          revision: 0,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: now,
          batchIncident: {
            ...request().batchIncident,
            batch: {
              ...request().batchIncident.batch,
              status: batchStatus,
              completedAt: batchCompletedAt
            },
            incident: incident({ cycle: incidentCycle, activeBatchId })
          }
        })
      );

      await expect(
        claimCourseSupportVerificationRequest({
          requestId: "request-1",
          expectedRevision: 0,
          runtimeVersion: releaseSha,
          now
        })
      ).resolves.toEqual({ claimed: false, reason });
      expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "STALE", lastError: reason })
        })
      );
      expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
    }
  );

  it("stales due work when the batch is completed despite a stale VERIFYING status", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        batchIncident: {
          ...request().batchIncident,
          batch: {
            ...request().batchIncident.batch,
            status: "VERIFYING",
            completedAt: now
          }
        }
      })
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: releaseSha,
        now
      })
    ).resolves.toEqual({ claimed: false, reason: "batch_not_verifying" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "batch_not_verifying"
        })
      })
    );
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("claims by revision and expired-state CAS only after eligibility is rechecked", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now
      })
    );

    const result = await claimCourseSupportVerificationRequest({
      requestId: "request-1",
      expectedRevision: 0,
      runtimeVersion: releaseSha,
      now
    });

    expect(result).toMatchObject({
      claimed: true,
      revision: 1,
      releaseSha,
      runtimeVersion: releaseSha,
      intent: {
        targetDateLocal: "2026-07-21",
        startTimeLocal: "06:00",
        endTimeLocal: "20:00",
        players: 1
      }
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "request-1",
          revision: 0,
          releaseSha,
          OR: expect.any(Array)
        }),
        data: expect.objectContaining({
          status: "CHECKING",
          runtimeVersion: releaseSha,
          revision: { increment: 1 },
          attemptCount: { increment: 1 }
        })
      })
    );
  });

  it("invalidates a queued request when active demand appears before claim", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now
      })
    );
    prismaMocks.activeSearchCount.mockResolvedValue(1);

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: releaseSha,
        now
      })
    ).resolves.toEqual({ claimed: false, reason: "active_demand" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          leaseToken: null,
          nextAttemptAt: null
        })
      })
    );
  });

  it("attaches and heartbeats a Workflow through its lease and monotonic revision fence", async () => {
    await expect(
      attachCourseSupportVerificationWorkflow({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        workflowRunId: "wf/run-safe_1",
        now
      })
    ).resolves.toEqual({ attached: true });
    expect(prismaMocks.rootRequestUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          revision: { gte: 1 },
          releaseSha,
          runtimeVersion: releaseSha,
          leaseToken: "lease-1",
          leaseExpiresAt: { gt: now }
        }),
        data: { workflowRunId: "wf/run-safe_1", updatedAt: now }
      })
    );

    await expect(
      heartbeatCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now
      })
    ).resolves.toMatchObject({ renewed: true });
    expect(prismaMocks.rootRequestUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          leaseExpiresAt: new Date("2026-07-21T12:10:00.000Z")
        })
      })
    );
  });

  it("persists a fresh post-discovery provider snapshot before adapter I/O", async () => {
    const changedCourse = course({
      bookingMetadata: { provider: "CPS", facilityId: "fresh-discovery" }
    });
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ course: changedCourse })
    );

    const result = await attachCourseSupportVerificationProviderSnapshot({
      requestId: "request-1",
      expectedRevision: 1,
      leaseToken: "lease-1",
      runtimeVersion: releaseSha,
      now
    });

    expect(result).toMatchObject({ attached: true, revision: 2 });
    expect(result).toHaveProperty(
      "providerSnapshotFingerprint",
      fingerprint(changedCourse)
    );
    expect(result).toMatchObject({
      discoveryAttemptedAt: new Date("2026-07-21T11:57:00.000Z"),
      discoveryVerifiedAt: null
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerSnapshotFingerprint: fingerprint(changedCourse),
          providerSnapshotAt: now,
          discoveryVerifiedAt: null,
          revision: { increment: 1 }
        })
      })
    );
  });

  it("stops provider attachment when the current course becomes private", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ course: course({ isPublic: false }) })
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now
      })
    ).resolves.toEqual({
      attached: false,
      reason: "monitoring_not_actionable"
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "monitoring_not_actionable"
        })
      })
    );
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("persists a one-shot discovery attempt under the exact execution lease", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ discoveryAttemptedAt: null, discoveryVerifiedAt: null })
    );

    await expect(
      markCourseSupportVerificationDiscoveryAttempted({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now
      })
    ).resolves.toEqual({
      marked: true,
      revision: 2,
      discoveryAttemptedAt: now,
      discoveryVerifiedAt: null
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "request-1",
          revision: 1,
          leaseToken: "lease-1",
          runtimeVersion: releaseSha
        }),
        data: {
          discoveryAttemptedAt: now,
          revision: { increment: 1 },
          updatedAt: now
        }
      })
    );
  });

  it("marks discovery verified only after an owned attempted discovery", async () => {
    const attemptedAt = new Date("2026-07-21T11:59:00.000Z");
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        revision: 2,
        discoveryAttemptedAt: attemptedAt,
        discoveryVerifiedAt: null
      })
    );

    await expect(
      markCourseSupportVerificationDiscoveryVerified({
        requestId: "request-1",
        expectedRevision: 2,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now
      })
    ).resolves.toEqual({
      marked: true,
      revision: 3,
      discoveryAttemptedAt: attemptedAt,
      discoveryVerifiedAt: now
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          discoveryVerifiedAt: now,
          revision: { increment: 1 },
          updatedAt: now
        }
      })
    );
  });

  it("rejects discovery verification when no discovery attempt was persisted", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ discoveryAttemptedAt: null, discoveryVerifiedAt: null })
    );

    await expect(
      markCourseSupportVerificationDiscoveryVerified({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now
      })
    ).resolves.toEqual({
      marked: false,
      reason: "discovery_not_attempted"
    });
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalled();
  });
});

describe("course-support verification terminal evidence", () => {
  it("preserves valid long provider cooldowns and drops invalid values", () => {
    expect(
      resolveCourseSupportProviderRetryNotBeforeAt({
        retryAfterSeconds: 6 * 60 * 60,
        now
      })
    ).toEqual(new Date("2026-07-21T18:00:00.000Z"));
    for (const retryAfterSeconds of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      Number.MAX_VALUE
    ]) {
      expect(
        resolveCourseSupportProviderRetryNotBeforeAt({
          retryAfterSeconds,
          now
        })
      ).toBeNull();
    }
  });

  it("honors Retry-After without exceeding the bounded request retry horizon", () => {
    expect(
      resolveCourseSupportVerificationRetryAt({
        requestedRetryAt: new Date("2026-07-21T12:15:00.000Z"),
        retryAfterSeconds: 60 * 60,
        now
      })
    ).toEqual(new Date("2026-07-21T13:00:00.000Z"));
    expect(
      resolveCourseSupportVerificationRetryAt({
        requestedRetryAt: new Date("2026-07-21T12:15:00.000Z"),
        retryAfterSeconds: 25 * 60 * 60,
        now
      })
    ).toBeNull();
  });

  it("stores only allowlisted aggregate evidence and removes signed URLs and email", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());
    const observation = {
      outcome: "NO_MATCH" as const,
      observedAt: now,
      providerExecution: true,
      adapterKey: "cps.public-read",
      availabilityCount: 0,
      httpStatus: 200,
      message:
        "Fetched https://book.example/tee-times?session=secret for owner@example.com",
      bookingUrl: "https://evil.example/?token=secret",
      slots: [{ startsAt: "2026-07-21T09:00:00" }],
      recipient: "owner@example.com"
    };

    const result = await completeCourseSupportVerificationRequest({
      requestId: "request-1",
      expectedRevision: 1,
      leaseToken: "lease-1",
      runtimeVersion: releaseSha,
      observation,
      now
    });

    expect(result).toMatchObject({
      completed: true,
      status: "SUCCEEDED",
      revision: 2,
      outcome: "NO_MATCH"
    });
    const evidence = prismaMocks.requestUpdateMany.mock.calls[0][0].data.evidence;
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      kind: "PROVIDER_VERIFICATION",
      providerExecution: true,
      releaseSha,
      runtimeVersion: releaseSha,
      outcome: "NO_MATCH",
      providerFamilyKey: "CPS",
      availabilityCount: 0,
      httpStatus: 200,
      message: "Fetched https://book.example for [redacted-email]"
    });
    expect(evidence).not.toHaveProperty("bookingUrl");
    expect(evidence).not.toHaveProperty("slots");
    expect(evidence).not.toHaveProperty("recipient");
    expect(JSON.stringify(evidence)).not.toContain("session=secret");
  });

  it("rejects completion when the batch completed after provider execution began", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        batchIncident: {
          ...request().batchIncident,
          batch: {
            ...request().batchIncident.batch,
            status: "VERIFYING",
            completedAt: now
          }
        }
      })
    );

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: true
        },
        now
      })
    ).resolves.toEqual({
      completed: false,
      reason: "batch_not_verifying"
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "batch_not_verifying"
        })
      })
    );
  });

  it("rejects completion when current evidence becomes account-required", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        course: course({
          automationEligibility: "BLOCKED",
          automationReason: "ACCOUNT_REQUIRED",
          ...currentIntelligence()
        })
      })
    );

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: true
        },
        now
      })
    ).resolves.toEqual({
      completed: false,
      reason: "monitoring_not_actionable"
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "monitoring_not_actionable"
        })
      })
    );
  });

  it("rejects runnable completion without a coherent verified discovery", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ discoveryAttemptedAt: now, discoveryVerifiedAt: null })
    );

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: true
        },
        now
      })
    ).resolves.toEqual({
      completed: false,
      reason: "discovery_not_verified"
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "discovery_not_verified"
        })
      })
    );
  });

  it("rejects completion as stale when the checked provider snapshot changed", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        course: course({
          bookingMetadata: { provider: "CPS", facilityId: "changed-after-check" }
        })
      })
    );

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: true
        },
        now
      })
    ).resolves.toEqual({
      completed: false,
      reason: "provider_snapshot_changed"
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "STALE" })
      })
    );
  });

  it("rejects a runnable outcome unless provider I/O actually executed", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: false
        },
        now
      })
    ).rejects.toThrow("require provider execution");
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalled();
  });

  it("persists a bounded retry without calling it successful", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());
    const retryAt = new Date("2026-07-21T12:30:00.000Z");

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "TIMEOUT",
        message:
          "request timed out at https://book.example/?token=secret session=bare-secret",
        retryAt,
        now
      })
    ).resolves.toEqual({
      failed: true,
      status: "RETRYABLE_FAILED",
      revision: 2,
      nextAttemptAt: retryAt
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RETRYABLE_FAILED",
          nextAttemptAt: retryAt,
          failureClass: "TIMEOUT",
          lastError:
            "request timed out at https://book.example [redacted-credential]"
        })
      })
    );
    const evidence = prismaMocks.requestUpdateMany.mock.calls[0][0].data.evidence;
    expect(evidence).toMatchObject({
      kind: "PROVIDER_VERIFICATION",
      providerExecution: false,
      outcome: "FETCH_FAILED"
    });
  });

  it("never retries before the provider Retry-After cooldown", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "RATE_LIMIT",
        message: "provider rate limit",
        retryAt: new Date("2026-07-21T12:15:00.000Z"),
        retryAfterSeconds: 60 * 60,
        now
      })
    ).resolves.toMatchObject({
      failed: true,
      status: "RETRYABLE_FAILED",
      nextAttemptAt: new Date("2026-07-21T13:00:00.000Z")
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: new Date("2026-07-21T13:00:00.000Z")
        })
      })
    );
    expect(
      prismaMocks.requestUpdateMany.mock.calls[0][0].data.evidence
    ).toMatchObject({
      providerRetryNotBeforeAt: "2026-07-21T13:00:00.000Z"
    });
  });

  it("preserves a provider cooldown beyond the request retry horizon", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "RATE_LIMIT",
        message: "provider rate limit",
        retryAt: new Date("2026-07-21T12:15:00.000Z"),
        retryAfterSeconds: 48 * 60 * 60,
        now
      })
    ).resolves.toEqual({
      failed: true,
      status: "STALE",
      revision: 2,
      nextAttemptAt: null
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          completedAt: now,
          evidence: expect.objectContaining({
            providerRetryNotBeforeAt: "2026-07-23T12:00:00.000Z"
          })
        })
      })
    );
  });

  it("ignores a non-finite provider cooldown without losing a valid retry", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());
    const retryAt = new Date("2026-07-21T12:15:00.000Z");

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "RATE_LIMIT",
        message: "provider rate limit",
        retryAt,
        retryAfterSeconds: Number.POSITIVE_INFINITY,
        now
      })
    ).resolves.toMatchObject({
      failed: true,
      status: "RETRYABLE_FAILED",
      nextAttemptAt: retryAt
    });
    const evidence = prismaMocks.requestUpdateMany.mock.calls[0][0].data.evidence;
    expect(evidence).not.toHaveProperty("providerRetryNotBeforeAt");
  });

  it("stores current failure evidence without retrying beyond the request lifetime", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ createdAt: new Date("2026-07-20T12:30:00.000Z") })
    );

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "NETWORK",
        message: "network failure",
        retryAt: new Date("2026-07-21T12:30:00.000Z"),
        observation: {
          outcome: "FETCH_FAILED",
          observedAt: now,
          providerExecution: true
        },
        now
      })
    ).resolves.toEqual({
      failed: true,
      status: "STALE",
      revision: 2,
      nextAttemptAt: null
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          outcome: "FETCH_FAILED",
          failureClass: "NETWORK",
          completedAt: now
        })
      })
    );
  });

  it("turns a failure stale instead of retrying after real demand appears", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());
    prismaMocks.activeSearchCount.mockResolvedValue(1);

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "NETWORK",
        message: "network failure",
        retryAt: new Date("2026-07-21T12:30:00.000Z"),
        now
      })
    ).resolves.toMatchObject({
      failed: true,
      status: "STALE",
      nextAttemptAt: null
    });
  });

  it("invalidates an earlier success when any active future pair now exists", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        outcome: "NO_MATCH",
        evidence: verificationEvidence(),
        completedAt: now
      })
    );
    prismaMocks.activeSearchCount.mockResolvedValue(1);

    await expect(
      getEligibleCourseSupportVerificationProof({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now
      })
    ).resolves.toEqual({ eligible: false, reason: "active_demand" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revision: 2, status: "SUCCEEDED" }),
        data: expect.objectContaining({ status: "STALE" })
      })
    );
  });

  it("returns exact-release eligible proof without exposing workflow or lease state", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        outcome: "NO_MATCH",
        evidence: verificationEvidence(),
        completedAt: now
      })
    );

    const proof = await getEligibleCourseSupportVerificationProof({
      batchIncidentId: "batch-incident-1",
      releaseSha,
      now
    });

    expect(proof).toMatchObject({
      eligible: true,
      releaseSha,
      runtimeVersion: releaseSha,
      outcome: "NO_MATCH",
      completedAt: now
    });
    expect(proof).not.toHaveProperty("workflowRunId");
    expect(proof).not.toHaveProperty("leaseToken");
    expect(proof).not.toHaveProperty("courseId");
  });

  it.each([
    {
      label: "private identity",
      courseOverrides: { isPublic: false }
    },
    {
      label: "current account requirement",
      courseOverrides: {
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        ...currentIntelligence()
      }
    },
    {
      label: "current CAPTCHA or queue",
      courseOverrides: {
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        ...currentIntelligence()
      }
    },
    {
      label: "current manual booking disposition",
      courseOverrides: {
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        ...currentIntelligence()
      }
    }
  ])(
    "invalidates prior runnable proof after a $label change",
    async ({ courseOverrides }) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        request({
          status: "SUCCEEDED",
          revision: 2,
          leaseToken: null,
          leaseExpiresAt: null,
          outcome: "NO_MATCH",
          evidence: verificationEvidence(),
          course: course(courseOverrides),
          completedAt: now
        })
      );

      await expect(
        getEligibleCourseSupportVerificationProof({
          batchIncidentId: "batch-incident-1",
          releaseSha,
          now
        })
      ).resolves.toEqual({
        eligible: false,
        reason: "monitoring_not_actionable"
      });
      expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "STALE",
            lastError: "monitoring_not_actionable"
          })
        })
      );
      expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
    }
  );

  it("invalidates runnable proof that bypassed verified discovery", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        outcome: "NO_MATCH",
        evidence: verificationEvidence(),
        discoveryAttemptedAt: now,
        discoveryVerifiedAt: null,
        completedAt: now
      })
    );

    await expect(
      getEligibleCourseSupportVerificationProof({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now
      })
    ).resolves.toEqual({
      eligible: false,
      reason: "discovery_not_verified"
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "discovery_not_verified"
        })
      })
    );
  });

  it.each([
    { status: "RETRYABLE_FAILED" as const, completedAt: null },
    { status: "STALE" as const, completedAt: now }
  ])(
    "returns bounded current failure evidence from $status without treating it as proof",
    async ({ status, completedAt }) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        request({
          status,
          revision: 2,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt:
            status === "RETRYABLE_FAILED"
              ? new Date("2026-07-21T12:30:00.000Z")
              : null,
          outcome: "FETCH_FAILED",
          failureClass: "AUTH",
          evidence: {
            ...verificationEvidence("FETCH_FAILED", true),
            failureClass: "AUTH",
            httpStatus: 403,
            providerRetryNotBeforeAt: "2026-07-23T12:00:00.000Z",
            message: "Public provider availability verification failed."
          },
          completedAt
        })
      );

      const failure = await getCurrentCourseSupportVerificationFailure({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now
      });

      expect(failure).toMatchObject({
        current: true,
        releaseSha,
        runtimeVersion: releaseSha,
        status,
        outcome: "FETCH_FAILED",
        failureClass: "AUTH",
        providerExecution: true,
        observedAt: now,
        providerRetryNotBeforeAt: new Date("2026-07-23T12:00:00.000Z")
      });
      expect(failure).not.toHaveProperty("courseId");
      expect(failure).not.toHaveProperty("workflowRunId");
      expect(failure).not.toHaveProperty("leaseToken");
    }
  );

  it("invalidates current failure evidence after a verified manual disposition", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "RETRYABLE_FAILED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date("2026-07-21T12:30:00.000Z"),
        outcome: "FETCH_FAILED",
        failureClass: "NETWORK",
        evidence: {
          ...verificationEvidence("FETCH_FAILED", true),
          failureClass: "NETWORK"
        },
        course: course({
          bookingMethod: "PHONE_ONLY",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          ...currentIntelligence()
        })
      })
    );

    await expect(
      getCurrentCourseSupportVerificationFailure({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now
      })
    ).resolves.toEqual({
      current: false,
      reason: "monitoring_not_actionable"
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "monitoring_not_actionable"
        })
      })
    );
  });

  it("invalidates current failure evidence after batch ownership ends", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "RETRYABLE_FAILED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date("2026-07-21T12:30:00.000Z"),
        outcome: "FETCH_FAILED",
        failureClass: "NETWORK",
        evidence: {
          ...verificationEvidence("FETCH_FAILED", true),
          failureClass: "NETWORK"
        },
        batchIncident: {
          ...request().batchIncident,
          batch: {
            ...request().batchIncident.batch,
            status: "RETRYABLE_FAILED"
          }
        }
      })
    );

    await expect(
      getCurrentCourseSupportVerificationFailure({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now
      })
    ).resolves.toEqual({ current: false, reason: "batch_not_verifying" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "batch_not_verifying"
        })
      })
    );
  });

  it("invalidates a success whose stored proof contract is incoherent", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        outcome: "NO_MATCH",
        evidence: {
          ...verificationEvidence(),
          providerExecution: false
        },
        completedAt: now
      })
    );

    await expect(
      getEligibleCourseSupportVerificationProof({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now
      })
    ).resolves.toEqual({ eligible: false, reason: "invalid_evidence" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "STALE" })
      })
    );
  });
});
