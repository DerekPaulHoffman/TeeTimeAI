import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transactionMocks = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  providerRequestLease: {
    deleteMany: vi.fn(),
  },
}));

const monitoringMocks = vi.hoisted(() => ({
  runSerializedCourseMonitoringWrite: vi.fn(),
}));

vi.mock("./course-monitoring", () => monitoringMocks);

import {
  COURSE_PROVIDER_OBSERVATION_MAX_TTL_MS,
  beginCourseProviderObservation,
  beginCourseProviderObservationInTransaction,
  getActiveCourseProviderObservationInTransaction,
  getCourseProviderObservationFenceInTransaction,
  markCourseProviderObservationUnreconciledInTransaction,
  releaseCourseProviderObservationInTransaction,
  startCourseProviderObservationHeartbeat,
} from "./provider-execution-marker";

describe("provider execution marker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monitoringMocks.runSerializedCourseMonitoringWrite.mockImplementation(
      async (_courseId, worker) => worker(transactionMocks),
    );
    transactionMocks.providerRequestLease.deleteMany.mockResolvedValue({
      count: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("establishes a hashed per-course marker in the serialized writer lane using database time", async () => {
    const observationStartedAt = new Date("2026-09-01T12:00:00.000Z");
    const leaseExpiresAt = new Date("2026-09-01T12:20:00.000Z");
    transactionMocks.$queryRaw.mockResolvedValue([
      {
        leaseToken: "opaque-token",
        observationStartedAt,
        leaseExpiresAt,
        supersededUnresolvedObservationStartedAt: null,
      },
    ]);

    await expect(
      beginCourseProviderObservation({
        courseId: "private-course-id",
        leaseToken: "opaque-token",
      }),
    ).resolves.toEqual({
      courseId: "private-course-id",
      leaseToken: "opaque-token",
      observationStartedAt,
      leaseExpiresAt,
      ttlMs: COURSE_PROVIDER_OBSERVATION_MAX_TTL_MS,
      supersededUnresolvedObservationStartedAt: null,
    });

    expect(
      monitoringMocks.runSerializedCourseMonitoringWrite,
    ).toHaveBeenCalledWith("private-course-id", expect.any(Function));
    const query = transactionMocks.$queryRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    expect(query.strings?.join(" ")).toContain("statement_timestamp()");
    expect(query.values).not.toContain("private-course-id");
    expect(String(query.values?.[0])).toMatch(
      /^__COURSE_PROVIDER_OBSERVATION__:[a-f0-9]{64}$/,
    );
  });

  it("returns busy without replacing a live marker", async () => {
    transactionMocks.$queryRaw.mockResolvedValue([]);

    await expect(
      beginCourseProviderObservationInTransaction(transactionMocks as never, {
        courseId: "course-1",
        leaseToken: "contender",
      }),
    ).resolves.toBeNull();
  });

  it("releases only the token that owns the marker", async () => {
    await releaseCourseProviderObservationInTransaction(
      transactionMocks as never,
      {
        courseId: "course-1",
        leaseToken: "owner-token",
        observationStartedAt: new Date("2026-09-01T12:00:00.000Z"),
        leaseExpiresAt: new Date("2026-09-01T12:20:00.000Z"),
        ttlMs: COURSE_PROVIDER_OBSERVATION_MAX_TTL_MS,
        supersededUnresolvedObservationStartedAt: null,
      },
    );

    expect(
      transactionMocks.providerRequestLease.deleteMany,
    ).toHaveBeenCalledWith({
      where: {
        providerFamilyKey: expect.stringMatching(
          /^__COURSE_PROVIDER_OBSERVATION__:[a-f0-9]{64}$/,
        ),
        slot: 0,
        leaseToken: "owner-token",
      },
    });
  });

  it("returns the active expiry using the database clock inside the caller transaction", async () => {
    const observationStartedAt = new Date("2026-09-01T12:00:00.000Z");
    const leaseExpiresAt = new Date("2026-09-01T12:20:00.000Z");
    transactionMocks.$queryRaw.mockResolvedValue([
      {
        observationStartedAt,
        leaseExpiresAt,
        retryUntil: new Date("2026-09-01T12:30:00.000Z"),
        state: "ACTIVE",
      },
    ]);

    await expect(
      getActiveCourseProviderObservationInTransaction(
        transactionMocks as never,
        "course-1",
      ),
    ).resolves.toEqual(leaseExpiresAt);

    const query = transactionMocks.$queryRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
    };
    expect(query.strings?.join(" ")).toContain("statement_timestamp()");
  });

  it.each(["EXPIRED_RETRYABLE", "EXPIRED_TERMINAL"] as const)(
    "retains an unreleased crashed marker as %s provider-source evidence",
    async (state) => {
      const fence = {
        observationStartedAt: new Date("2026-09-01T12:00:00.000Z"),
        leaseExpiresAt: new Date("2026-09-01T12:20:00.000Z"),
        retryUntil: new Date("2026-09-01T12:30:00.000Z"),
        state,
      };
      transactionMocks.$queryRaw.mockResolvedValue([fence]);

      await expect(
        getCourseProviderObservationFenceInTransaction(
          transactionMocks as never,
          "course-1",
        ),
      ).resolves.toEqual(fence);
    },
  );

  it("settles noncanonical provider proof without deleting its source watermark", async () => {
    const observationStartedAt = new Date("2026-09-01T12:00:00.000Z");
    const settledAt = new Date("2026-09-01T12:02:00.000Z");
    const lease = {
      courseId: "course-1",
      leaseToken: "owner-token",
      observationStartedAt,
      leaseExpiresAt: new Date("2026-09-01T12:20:00.000Z"),
      ttlMs: COURSE_PROVIDER_OBSERVATION_MAX_TTL_MS,
      supersededUnresolvedObservationStartedAt: null,
    };
    transactionMocks.$queryRaw.mockResolvedValue([
      { leaseExpiresAt: settledAt },
    ]);

    await expect(
      markCourseProviderObservationUnreconciledInTransaction(
        transactionMocks as never,
        lease,
      ),
    ).resolves.toBe(true);
    expect(lease.leaseExpiresAt).toEqual(settledAt);
    expect(
      transactionMocks.providerRequestLease.deleteMany,
    ).not.toHaveBeenCalled();
  });

  it("preserves a predecessor ambiguity when a successor never starts provider work", async () => {
    const predecessorStartedAt = new Date("2026-09-01T11:30:00.000Z");
    const lease = {
      courseId: "course-1",
      leaseToken: "successor-token",
      observationStartedAt: new Date("2026-09-01T12:00:00.000Z"),
      leaseExpiresAt: new Date("2026-09-01T12:20:00.000Z"),
      ttlMs: COURSE_PROVIDER_OBSERVATION_MAX_TTL_MS,
      supersededUnresolvedObservationStartedAt: predecessorStartedAt,
    };
    transactionMocks.$queryRaw.mockResolvedValue([
      { leaseExpiresAt: new Date("2026-09-01T12:01:00.000Z") },
    ]);

    await expect(
      markCourseProviderObservationUnreconciledInTransaction(
        transactionMocks as never,
        lease,
        { preserveSupersededSource: true },
      ),
    ).resolves.toBe(true);

    const query = transactionMocks.$queryRaw.mock.calls.at(-1)?.[0] as {
      values?: readonly unknown[];
    };
    expect(query.values).toContain(predecessorStartedAt);
    expect(query.values).not.toContain(lease.observationStartedAt);
  });

  it("surfaces lost heartbeat ownership before a caller can persist evidence", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(false);
    const heartbeat = startCourseProviderObservationHeartbeat(
      {
        courseId: "course-1",
        leaseToken: "owner-token",
        observationStartedAt: new Date("2026-09-01T12:00:00.000Z"),
        leaseExpiresAt: new Date("2026-09-01T12:20:00.000Z"),
        ttlMs: COURSE_PROVIDER_OBSERVATION_MAX_TTL_MS,
        supersededUnresolvedObservationStartedAt: null,
      },
      { renew },
    );

    await vi.advanceTimersByTimeAsync(60_000);

    expect(() => heartbeat.assertOwned()).toThrow(
      "Provider observation ownership expired",
    );
    await expect(heartbeat.stop()).rejects.toThrow(
      "Provider observation ownership expired",
    );
  });
});
