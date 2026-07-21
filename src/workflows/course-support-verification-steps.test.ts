import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerReadMocks = vi.hoisted(() => ({
  fetchCourseTeeSheet: vi.fn()
}));

const verificationMocks = vi.hoisted(() => ({
  attachCourseSupportVerificationProviderSnapshot: vi.fn(),
  completeCourseSupportVerificationRequest: vi.fn(),
  failCourseSupportVerificationRequest: vi.fn(),
  heartbeatCourseSupportVerificationRequest: vi.fn(),
  markCourseSupportVerificationDiscoveryAttempted: vi.fn(),
  markCourseSupportVerificationDiscoveryVerified: vi.fn()
}));

const discoveryMocks = vi.hoisted(() => ({
  prepareCourseSupportVerificationMonitoring: vi.fn()
}));

const capabilityMocks = vi.hoisted(() => ({
  classifyProviderFailure: vi.fn(),
  getProviderReadinessFailure: vi.fn(),
  resolveProviderCapability: vi.fn()
}));

const providerLeaseMocks = vi.hoisted(() => ({
  runWithProviderRequestLease: vi.fn()
}));

const runtimeMocks = vi.hoisted(() => ({
  getAutomationRuntimeVersion: vi.fn()
}));

const deliveryMocks = vi.hoisted(() => ({
  getSafeOfficialBookingUrl: vi.fn()
}));

const prismaMocks = vi.hoisted(() => ({
  courseFindUnique: vi.fn()
}));

vi.mock("@/lib/automation/course-provider-read", () => providerReadMocks);
vi.mock("@/lib/automation/course-support-verification", () =>
  verificationMocks
);
vi.mock("@/lib/automation/search-monitoring-discovery", () => discoveryMocks);
vi.mock("@/lib/automation/provider-capabilities", () => capabilityMocks);
vi.mock("@/lib/automation/provider-request-lease", () => providerLeaseMocks);
vi.mock("@/lib/automation/runtime-version", () => runtimeMocks);
vi.mock("@/lib/email/search-delivery-outbox", () => deliveryMocks);
vi.mock("@/lib/prisma", () => ({
  prisma: { course: { findUnique: prismaMocks.courseFindUnique } }
}));

import { executeCourseSupportVerificationStep } from "./course-support-verification-steps";

const runtimeVersion = "a".repeat(40);
const input = {
  requestId: "verification-request-1",
  expectedRevision: 3,
  leaseToken: "lease-1",
  runtimeVersion
};

const intent = {
  targetDateLocal: "2026-07-24",
  startTimeLocal: "06:00",
  endTimeLocal: "20:00",
  timeZone: "America/New_York",
  players: 1
};

const course = {
  id: "course-1",
  timeZone: "America/New_York",
  website: "https://course.example",
  detectedBookingUrl: "https://booking.example/tee-times",
  providerFamilyKey: "CPS",
  detectedPlatform: "CUSTOM",
  bookingMetadata: { provider: "CPS", tenantId: "tenant-1" },
  bookingWindowEvidenceUrl: null,
  bookingMethod: "PUBLIC_ONLINE",
  automationEligibility: "ALLOWED",
  automationReason: "PUBLIC_READ_ONLY",
  isPublic: true,
  intelligenceVerifiedAt: null,
  intelligenceReviewAt: null,
  intelligenceConfidence: null
};

const discoveryAttemptedAt = new Date("2026-07-21T12:00:00.000Z");
const discoveryVerifiedAt = new Date("2026-07-21T12:00:01.000Z");

function slot(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "slot-1",
    courseId: "course-1",
    startsAt: "2026-07-24T08:00:00",
    availableSpots: 4,
    bookingUrl: "https://booking.example/tee-times",
    ...overrides
  };
}

function allowOwnedExecution() {
  verificationMocks.attachCourseSupportVerificationProviderSnapshot
    .mockResolvedValueOnce({
      attached: true,
      revision: 4,
      providerSnapshotFingerprint: "before-discovery",
      discoveryAttemptedAt: null,
      discoveryVerifiedAt: null,
      courseId: "course-1",
      intent
    })
    .mockResolvedValueOnce({
      attached: true,
      revision: 6,
      providerSnapshotFingerprint: "after-discovery",
      discoveryAttemptedAt,
      discoveryVerifiedAt: null,
      courseId: "course-1",
      intent
    });
}

function allowOwnedDiscovery() {
  verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce(
    {
      attached: true,
      revision: 4,
      providerSnapshotFingerprint: "before-discovery",
      discoveryAttemptedAt: null,
      discoveryVerifiedAt: null,
      courseId: "course-1",
      intent
    }
  );
}

describe("executeCourseSupportVerificationStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));

    runtimeMocks.getAutomationRuntimeVersion.mockReturnValue(runtimeVersion);
    verificationMocks.heartbeatCourseSupportVerificationRequest.mockResolvedValue({
      renewed: true
    });
    verificationMocks.completeCourseSupportVerificationRequest.mockResolvedValue({
      completed: true
    });
    verificationMocks.markCourseSupportVerificationDiscoveryAttempted.mockResolvedValue({
      marked: true,
      revision: 5,
      discoveryAttemptedAt,
      discoveryVerifiedAt: null
    });
    verificationMocks.markCourseSupportVerificationDiscoveryVerified.mockResolvedValue({
      marked: true,
      revision: 7,
      discoveryAttemptedAt,
      discoveryVerifiedAt
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "FAILED"
    });
    discoveryMocks.prepareCourseSupportVerificationMonitoring.mockResolvedValue({
      attemptedCourseIds: ["course-1"],
      appliedCourseIds: ["course-1"],
      failedCourseIds: [],
      deferredCourseIds: [],
      retryCourseIds: []
    });
    prismaMocks.courseFindUnique.mockResolvedValue(course);
    capabilityMocks.resolveProviderCapability.mockReturnValue({
      providerFamilyKey: "CPS",
      isRunnable: true,
      metadataReady: true,
      evidenceConflict: false
    });
    capabilityMocks.getProviderReadinessFailure.mockReturnValue(null);
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "NETWORK",
      httpStatus: null,
      retryAfterSeconds: null
    });
    providerLeaseMocks.runWithProviderRequestLease.mockImplementation(
      async (_providerFamily: string, worker: () => Promise<unknown>) => ({
        acquired: true,
        value: await worker()
      })
    );
    deliveryMocks.getSafeOfficialBookingUrl.mockImplementation(
      (value: unknown) =>
        typeof value === "string" && !value.includes("/checkout")
          ? value
          : undefined
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops an exact-runtime mismatch before any database or network I/O", async () => {
    runtimeMocks.getAutomationRuntimeVersion.mockReturnValue("b".repeat(40));

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "runtime_mismatch"
    });

    expect(
      verificationMocks.attachCourseSupportVerificationProviderSnapshot
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.heartbeatCourseSupportVerificationRequest
    ).not.toHaveBeenCalled();
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseFindUnique).not.toHaveBeenCalled();
    expect(providerLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "private identity",
      overrides: { isPublic: false },
      failureClass: "UNSUPPORTED_FAMILY"
    },
    {
      label: "account requirement",
      overrides: {
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED"
      },
      failureClass: "AUTH"
    },
    {
      label: "captcha or queue",
      overrides: {
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE"
      },
      failureClass: "CHALLENGE"
    },
    {
      label: "manual booking",
      overrides: {
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING"
      },
      failureClass: "UNSUPPORTED_FAMILY"
    }
  ])(
    "performs no discovery or provider I/O for a current $label disposition",
    async ({ overrides, failureClass }) => {
      allowOwnedDiscovery();
      prismaMocks.courseFindUnique.mockResolvedValue({
        ...course,
        ...overrides,
        intelligenceVerifiedAt: new Date("2026-07-20T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-20T12:00:00.000Z"),
        intelligenceConfidence: 0.95
      });

      await executeCourseSupportVerificationStep(input);

      expect(
        verificationMocks.failCourseSupportVerificationRequest
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedRevision: 4,
          failureClass,
          observation: expect.objectContaining({ providerExecution: false })
        })
      );
      expect(
        verificationMocks.markCourseSupportVerificationDiscoveryAttempted
      ).not.toHaveBeenCalled();
      expect(
        discoveryMocks.prepareCourseSupportVerificationMonitoring
      ).not.toHaveBeenCalled();
      expect(providerLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
      expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    }
  );

  it("uses the normal capped discovery path after the one-shot attempt is persisted", async () => {
    verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce({
      attached: true,
      revision: 4,
      providerSnapshotFingerprint: "before-discovery",
      discoveryAttemptedAt,
      discoveryVerifiedAt: null,
      courseId: "course-1",
      intent
    });
    discoveryMocks.prepareCourseSupportVerificationMonitoring.mockResolvedValue({
      attemptedCourseIds: [],
      appliedCourseIds: [],
      failedCourseIds: [],
      deferredCourseIds: [],
      retryCourseIds: ["course-1"]
    });

    await executeCourseSupportVerificationStep(input);

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted
    ).not.toHaveBeenCalled();
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring
    ).toHaveBeenCalledWith(
      "course-1",
      undefined,
      new Date("2026-07-21T12:00:00.000Z"),
      { forceFresh: false }
    );
    expect(
      verificationMocks.failCourseSupportVerificationRequest
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 4,
        failureClass: "RATE_LIMIT",
        retryAt: new Date("2026-07-21T12:15:00.000Z")
      })
    );
    expect(providerLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
  });

  it("reuses verified discovery on a provider-only retry", async () => {
    verificationMocks.attachCourseSupportVerificationProviderSnapshot
      .mockResolvedValueOnce({
        attached: true,
        revision: 4,
        providerSnapshotFingerprint: "verified-provider",
        discoveryAttemptedAt,
        discoveryVerifiedAt,
        courseId: "course-1",
        intent
      })
      .mockResolvedValueOnce({
        attached: true,
        revision: 5,
        providerSnapshotFingerprint: "verified-provider",
        discoveryAttemptedAt,
        discoveryVerifiedAt,
        courseId: "course-1",
        intent
      });
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH"
    });

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified
    ).not.toHaveBeenCalled();
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest
    ).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 5 })
    );
  });

  it.each([
    {
      label: "not attempted",
      result: {
        attemptedCourseIds: [],
        appliedCourseIds: [],
        failedCourseIds: [],
        deferredCourseIds: [],
        retryCourseIds: []
      },
      failureClass: "MISSING_SOURCE",
      retryAt: undefined
    },
    {
      label: "failed",
      result: {
        attemptedCourseIds: ["course-1"],
        appliedCourseIds: [],
        failedCourseIds: ["course-1"],
        deferredCourseIds: [],
        retryCourseIds: ["course-1"]
      },
      failureClass: "NETWORK",
      retryAt: new Date("2026-07-21T12:15:00.000Z")
    },
    {
      label: "deferred",
      result: {
        attemptedCourseIds: [],
        appliedCourseIds: [],
        failedCourseIds: [],
        deferredCourseIds: ["course-1"],
        retryCourseIds: ["course-1"]
      },
      failureClass: "RATE_LIMIT",
      retryAt: new Date("2026-07-21T12:02:00.000Z")
    }
  ])(
    "fails closed when forced discovery is $label",
    async ({ result, failureClass, retryAt }) => {
      allowOwnedDiscovery();
      discoveryMocks.prepareCourseSupportVerificationMonitoring.mockResolvedValue(
        result
      );

      await executeCourseSupportVerificationStep(input);

      expect(
        verificationMocks.failCourseSupportVerificationRequest
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "verification-request-1",
          expectedRevision: 5,
          leaseToken: "lease-1",
          runtimeVersion,
          failureClass,
          retryAt,
          observation: expect.objectContaining({ providerExecution: false })
        })
      );
      expect(
        verificationMocks.attachCourseSupportVerificationProviderSnapshot
      ).toHaveBeenCalledTimes(1);
      expect(prismaMocks.courseFindUnique).toHaveBeenCalledTimes(1);
      expect(providerLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
      expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
      expect(
        verificationMocks.completeCourseSupportVerificationRequest
      ).not.toHaveBeenCalled();
    }
  );

  it("stops when the authoritative request course changes during discovery", async () => {
    verificationMocks.attachCourseSupportVerificationProviderSnapshot
      .mockResolvedValueOnce({
        attached: true,
        revision: 4,
        providerSnapshotFingerprint: "before-discovery",
        discoveryAttemptedAt: null,
        discoveryVerifiedAt: null,
        courseId: "course-1",
        intent
      })
      .mockResolvedValueOnce({
        attached: true,
        revision: 6,
        providerSnapshotFingerprint: "after-discovery",
        discoveryAttemptedAt,
        discoveryVerifiedAt: null,
        courseId: "course-2",
        intent
      });

    await executeCourseSupportVerificationStep(input);

    expect(
      verificationMocks.failCourseSupportVerificationRequest
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 6,
        failureClass: "SCHEMA",
        observation: expect.objectContaining({ providerExecution: false })
      })
    );
    expect(prismaMocks.courseFindUnique).toHaveBeenCalledTimes(1);
    expect(providerLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
  });

  it.each([
    { providerOutcome: "NO_MATCH" as const, slots: [], availabilityCount: 0 },
    {
      providerOutcome: "MATCH_FOUND" as const,
      slots: [slot()],
      availabilityCount: 1
    }
  ])(
    "completes a safe $providerOutcome through the provider lease",
    async ({ providerOutcome, slots, availabilityCount }) => {
      allowOwnedExecution();
      providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
        slots,
        targetDateStatus: "OPEN",
        bookingWindowEvidence: null
      });

      await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
        outcome: "completed",
        providerOutcome
      });

      expect(
        verificationMocks.markCourseSupportVerificationDiscoveryAttempted
      ).toHaveBeenCalledWith({
        requestId: "verification-request-1",
        expectedRevision: 4,
        leaseToken: "lease-1",
        runtimeVersion
      });
      expect(
        discoveryMocks.prepareCourseSupportVerificationMonitoring
      ).toHaveBeenCalledWith(
        "course-1",
        undefined,
        new Date("2026-07-21T12:00:00.000Z"),
        { forceFresh: true }
      );
      expect(
        verificationMocks.markCourseSupportVerificationDiscoveryVerified
      ).toHaveBeenCalledWith({
        requestId: "verification-request-1",
        expectedRevision: 6,
        leaseToken: "lease-1",
        runtimeVersion
      });
      expect(providerLeaseMocks.runWithProviderRequestLease).toHaveBeenCalledWith(
        "CPS",
        expect.any(Function)
      );
      expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledWith(
        course,
        new Date("2026-07-24T00:00:00.000Z"),
        1,
        true
      );
      expect(
        verificationMocks.completeCourseSupportVerificationRequest
      ).toHaveBeenCalledWith({
        requestId: "verification-request-1",
        expectedRevision: 7,
        leaseToken: "lease-1",
        runtimeVersion,
        observation: {
          outcome: providerOutcome,
          observedAt: new Date("2026-07-21T12:00:00.000Z"),
          adapterKey: "CPS",
          availabilityCount,
          providerExecution: true
        }
      });
      expect(
        verificationMocks.failCourseSupportVerificationRequest
      ).not.toHaveBeenCalled();
    }
  );

  it("rechecks the monitoring gate after discovery before provider I/O", async () => {
    allowOwnedExecution();
    prismaMocks.courseFindUnique
      .mockResolvedValueOnce(course)
      .mockResolvedValueOnce({
        ...course,
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        intelligenceVerifiedAt: new Date("2026-07-21T11:59:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-21T12:00:00.000Z"),
        intelligenceConfidence: 0.98
      });

    await executeCourseSupportVerificationStep(input);

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified
    ).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 6 })
    );
    expect(
      verificationMocks.failCourseSupportVerificationRequest
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 7,
        failureClass: "CHALLENGE",
        observation: expect.objectContaining({ providerExecution: false })
      })
    );
    expect(providerLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
  });

  it("fails closed on an unsafe provider booking URL without recording success", async () => {
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [slot({ bookingUrl: "https://booking.example/checkout" })],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "verification-request-1",
        expectedRevision: 7,
        leaseToken: "lease-1",
        runtimeVersion,
        failureClass: "SCHEMA",
        retryAt: undefined,
        observation: expect.objectContaining({
          outcome: "FETCH_FAILED",
          providerExecution: true
        })
      })
    );
    expect(
      verificationMocks.completeCourseSupportVerificationRequest
    ).not.toHaveBeenCalled();
  });

  it.each(["lease_lost", "active_demand"] as const)(
    "honors a post-discovery %s rejection before the adapter request",
    async (reason) => {
      verificationMocks.attachCourseSupportVerificationProviderSnapshot
        .mockResolvedValueOnce({
          attached: true,
          revision: 4,
          providerSnapshotFingerprint: "before-discovery",
          discoveryAttemptedAt: null,
          discoveryVerifiedAt: null,
          courseId: "course-1",
          intent
        })
        .mockResolvedValueOnce({ attached: false, reason });

      await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
        outcome: "stopped",
        reason
      });

      expect(
        discoveryMocks.prepareCourseSupportVerificationMonitoring
      ).toHaveBeenCalledWith(
        "course-1",
        undefined,
        new Date("2026-07-21T12:00:00.000Z"),
        { forceFresh: true }
      );
      expect(prismaMocks.courseFindUnique).toHaveBeenCalledTimes(1);
      expect(providerLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
      expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
      expect(
        verificationMocks.completeCourseSupportVerificationRequest
      ).not.toHaveBeenCalled();
      expect(
        verificationMocks.failCourseSupportVerificationRequest
      ).not.toHaveBeenCalled();
    }
  );

  it("persists a transient adapter retry with truthful provider execution", async () => {
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })
    );
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED"
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true
    });

    expect(capabilityMocks.classifyProviderFailure).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: "ECONNRESET" })
    });
    expect(
      verificationMocks.failCourseSupportVerificationRequest
    ).toHaveBeenCalledWith({
      requestId: "verification-request-1",
      expectedRevision: 7,
      leaseToken: "lease-1",
      runtimeVersion,
      failureClass: "NETWORK",
      message: "Public provider availability verification failed.",
      retryAfterSeconds: null,
      retryAt: new Date("2026-07-21T12:15:00.000Z"),
      observation: {
        outcome: "FETCH_FAILED",
        observedAt: new Date("2026-07-21T12:00:00.000Z"),
        httpStatus: null,
        providerExecution: true
      }
    });
    expect(
      verificationMocks.completeCourseSupportVerificationRequest
    ).not.toHaveBeenCalled();
  });

  it("never retries before a longer provider Retry-After", async () => {
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("provider throttled")
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "RATE_LIMIT",
      httpStatus: 429,
      retryAfterSeconds: 30 * 60
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED"
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "RATE_LIMIT",
        retryAfterSeconds: 30 * 60,
        retryAt: new Date("2026-07-21T12:30:00.000Z"),
        observation: expect.objectContaining({
          httpStatus: 429,
          providerExecution: true
        })
      })
    );
  });

  it("does not schedule a request retry beyond the bounded horizon", async () => {
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("provider unavailable")
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "HTTP_5XX",
      httpStatus: 503,
      retryAfterSeconds: 25 * 60 * 60
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "STALE"
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "HTTP_5XX",
        retryAfterSeconds: 25 * 60 * 60,
        retryAt: null,
        observation: expect.objectContaining({
          httpStatus: 503,
          providerExecution: true
        })
      })
    );
  });
});
