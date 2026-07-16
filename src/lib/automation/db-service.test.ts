import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachSearchWorkflowRun,
  claimScheduledSearchCheck,
  closeHourlyImprovementRun,
  completeScheduledSearchCheck,
  failScheduledSearchCheck,
  markMissingMatchesUnavailable,
  listSearchesNeedingScheduleRecovery,
  queueSearchCheck,
  recordCourseProbeIfChanged,
  recordTeeTimeMatch,
  updateHourlyImprovementRunState
} from "./db-service";
import {
  buildHourlyImprovementRunProvenance,
  buildImprovementCheckpoints,
  type HourlyImprovementRunRecord
} from "./improvement";

const deliveryOutboxMocks = vi.hoisted(() => ({
  lockSearchForEmailReconciliation: vi.fn(),
  suppressSearchEmailDeliveriesForMatches: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teeTimeMatch: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn()
    },
    courseProbe: {
      create: vi.fn(),
      findFirst: vi.fn()
    },
    automationRun: {
      updateMany: vi.fn()
    },
    teeSearch: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn()
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn()
  }
}));
vi.mock("@/lib/email/search-delivery-outbox", () => deliveryOutboxMocks);

import { prisma } from "@/lib/prisma";

const mockedPrisma = vi.mocked(prisma);

describe("search check row lease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a follow-up request when the exact schedule is already busy", async () => {
    mockedPrisma.teeSearch.updateMany
      .mockResolvedValueOnce({ count: 0 } as never)
      .mockResolvedValueOnce({ count: 1 } as never);

    await expect(claimScheduledSearchCheck("search-1", 4)).resolves.toBeNull();

    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "search-1",
          scheduleVersion: 4,
          status: "ACTIVE"
        }),
        data: { recheckRequestedAt: expect.any(Date) }
      })
    );
  });

  it("claims an expired lease with a fresh opaque token", async () => {
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);

    const lease = await claimScheduledSearchCheck("search-1", 4);

    expect(lease).toMatchObject({
      searchId: "search-1",
      scheduleVersion: 4,
      token: expect.any(String),
      expiresAt: expect.any(Date)
    });
    expect(lease?.token).not.toContain("search-1");
  });

  it("lets Workflow completion honor a future durable delivery retry", async () => {
    const retryAt = new Date("2026-07-15T15:01:00.000Z");
    mockedPrisma.$queryRaw.mockResolvedValue([
      { recheckRequested: true, nextCheckAt: retryAt }
    ] as never);

    await expect(
      completeScheduledSearchCheck({
        searchId: "search-1",
        scheduleVersion: 4,
        leaseToken: "lease-token",
        outcome: "email retry queued",
        nextCheckAt: new Date("2026-07-15T17:00:00.000Z")
      })
    ).resolves.toEqual({ recheckRequested: true, nextCheckAt: retryAt });
    const query = mockedPrisma.$queryRaw.mock.calls[0]?.[0] as {
      strings?: string[];
    };
    expect(query.strings?.join(" ")).toContain("GREATEST");
    expect(query.strings?.join(" ")).toContain('current."recheckRequestedAt"');
  });

  it("keeps the earliest durable delivery retry when a scheduled check fails", async () => {
    const retryAt = new Date("2026-07-15T15:01:00.000Z");
    mockedPrisma.$queryRaw.mockResolvedValue([{ nextCheckAt: retryAt }] as never);

    await expect(
      failScheduledSearchCheck({
        searchId: "search-1",
        scheduleVersion: 4,
        leaseToken: "lease-token",
        message: "email delivery failed",
        nextCheckAt: new Date("2026-07-15T15:05:00.000Z")
      })
    ).resolves.toEqual({ count: 1, nextCheckAt: retryAt });
    const query = mockedPrisma.$queryRaw.mock.calls[0]?.[0] as {
      strings?: string[];
    };
    expect(query.strings?.join(" ")).toContain("LEAST");
    expect(query.strings?.join(" ")).toContain("GREATEST");
    expect(query.strings?.join(" ")).toContain('"recheckRequestedAt"');
    expect(query.strings?.join(" ")).toContain('"checkLeaseToken" =');
  });

  it("attaches only when no current workflow won the version or the prior start failed", async () => {
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);

    await attachSearchWorkflowRun("search-1", 4, "run-1", "prior-run");

    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "search-1",
        scheduleVersion: 4,
        status: "ACTIVE",
        workflowRunId: "prior-run"
      },
      data: {
        workflowRunId: "run-1"
      }
    });
  });
});

describe("remediation schedule dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the originally dispatched version without incrementing twice", async () => {
    const tx = {
      teeSearch: {
        findUnique: vi.fn().mockResolvedValue({
          id: "search-1",
          status: "ACTIVE",
          scheduleVersion: 12,
          remediationDispatchKey: "dispatch-1",
          remediationDispatchVersion: 9,
          workflowRunId: "newer-run",
          checkStatus: "WAITING",
          updatedAt: new Date()
        }),
        updateMany: vi.fn()
      }
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx)
    );

    await expect(queueSearchCheck("search-1", "dispatch-1")).resolves.toMatchObject({
      scheduleVersion: 9
    });
    expect(tx.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("persists a dispatch key and its exact incremented schedule version", async () => {
    const current = {
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 8,
      remediationDispatchKey: null,
      remediationDispatchVersion: null,
      workflowRunId: null,
      checkStatus: "WAITING",
      updatedAt: new Date()
    };
    const tx = {
      teeSearch: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce({ ...current, scheduleVersion: 9 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx)
    );

    await expect(queueSearchCheck("search-1", "dispatch-1")).resolves.toMatchObject({
      scheduleVersion: 9
    });
    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          remediationDispatchKey: "dispatch-1",
          remediationDispatchVersion: 9,
          scheduleVersion: { increment: 1 }
        })
      })
    );
  });
});

describe("guarded schedule dispatch", () => {
  const observedAt = new Date("2026-07-16T18:30:00.000Z");
  const updatedAt = new Date("2026-07-16T18:29:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockGuardedTransaction(
    updateCount: number,
    findResult: Record<string, unknown> | null = {
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      updatedAt: observedAt
    }
  ) {
    const tx = {
      teeSearch: {
        updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
        findUnique: vi.fn().mockResolvedValue(findResult)
      }
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx)
    );
    return tx;
  }

  it("atomically queues the exact waiting version with no live lease", async () => {
    const tx = mockGuardedTransaction(1);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt
      })
    ).resolves.toMatchObject({
      status: "ACTIVE",
      scheduleVersion: 9,
      checkStatus: "QUEUED"
    });

    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "search-1",
          status: "ACTIVE",
          scheduleVersion: 8,
          updatedAt,
          checkStatus: "WAITING",
          OR: [
            { checkLeaseExpiresAt: null },
            { checkLeaseExpiresAt: { lte: observedAt } }
          ]
        },
        data: expect.objectContaining({
          scheduleVersion: { increment: 1 },
          checkStatus: "QUEUED"
        })
      })
    );
    expect(tx.teeSearch.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "search-1",
          status: "ACTIVE",
          scheduleVersion: 9,
          checkStatus: "QUEUED",
          workflowRunId: null
        }
      })
    );
  });

  it("rejects a row with a future lease without reading a newer state", async () => {
    const tx = mockGuardedTransaction(0);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt
      })
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(tx.teeSearch.findUnique).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "CHECKING"])(
    "rejects a search that has moved to %s without reading a newer state",
    async () => {
      const tx = mockGuardedTransaction(0);

      await expect(
        queueSearchCheck("search-1", undefined, {
          scheduleVersion: 8,
          updatedAt,
          observedAt
        })
      ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

      expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ checkStatus: "WAITING" })
        })
      );
      expect(tx.teeSearch.findUnique).not.toHaveBeenCalled();
    }
  );

  it("rejects a schedule-version race without reading a newer state", async () => {
    const tx = mockGuardedTransaction(0);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt
      })
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scheduleVersion: 8 })
      })
    );
    expect(tx.teeSearch.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a WAITING state restored after an ABA transition", async () => {
    const tx = mockGuardedTransaction(0);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt
      })
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAt })
      })
    );
    expect(tx.teeSearch.findUnique).not.toHaveBeenCalled();
  });

  it("throws to roll back when the exact queued row cannot be read", async () => {
    const tx = mockGuardedTransaction(1, null);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt
      })
    ).rejects.toThrow("Guarded search schedule changed after it was queued.");

    expect(tx.teeSearch.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scheduleVersion: 9,
          checkStatus: "QUEUED",
          workflowRunId: null
        })
      })
    );
  });
});

describe("schedule recovery fairness", () => {
  it("bounds a full cohort recovery pass and orders the stalest rows first", async () => {
    mockedPrisma.teeSearch.findMany.mockResolvedValue([] as never);

    await listSearchesNeedingScheduleRecovery();

    expect(mockedPrisma.teeSearch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: 50
      })
    );
  });

  it("recovers a waiting search when an available pending match has no timely delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    mockedPrisma.teeSearch.findMany.mockResolvedValue([] as never);

    try {
      await listSearchesNeedingScheduleRecovery();

      expect(mockedPrisma.teeSearch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              {
                AND: [
                  {
                    checkStatus: { in: ["WAITING", "FAILED"] },
                    OR: [
                      { checkLeaseExpiresAt: null },
                      { checkLeaseExpiresAt: { lte: new Date("2026-07-16T12:00:00.000Z") } }
                    ]
                  },
                  {
                    OR: expect.arrayContaining([
                      {
                        matches: {
                          some: {
                            availabilityStatus: "AVAILABLE",
                            alertStatus: "PENDING",
                            firstSeenAt: { lte: new Date("2026-07-16T11:50:00.000Z") }
                          }
                        }
                      }
                    ])
                  }
                ]
              }
            ])
          })
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("never preempts a healthy checking lease to retry delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    mockedPrisma.teeSearch.findMany.mockResolvedValue([] as never);

    try {
      await listSearchesNeedingScheduleRecovery();

      const query = mockedPrisma.teeSearch.findMany.mock.calls[0]?.[0];
      const recoveryBranches = query?.where?.OR ?? [];
      const deliveryBranch = recoveryBranches.find(
        (branch) => "AND" in branch && Array.isArray(branch.AND)
      );

      expect(deliveryBranch).toEqual(
        expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              checkStatus: { in: ["WAITING", "FAILED"] }
            })
          ])
        })
      );
      expect(deliveryBranch?.AND).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkStatus: "CHECKING" })
        ])
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function buildHourlyRecord(): HourlyImprovementRunRecord {
  return {
    schemaVersion: 1,
    automationId: "teetimeai-hourly-product-improvement-loop",
    promptVersion: "tee-time-spot-improvement-loop-v8",
    lifecycle: "candidate_selected",
    owner: {
      runId: "run-hourly-1",
      threadId: "thread-hourly-1"
    },
    provenance: buildHourlyImprovementRunProvenance({
      ownerRunId: "run-hourly-1",
      ownerThreadId: "thread-hourly-1",
      branch: "automation/hourly-20260713-120000",
      startingSha: "0123456789abcdef0123456789abcdef01234567",
      plannedPaths: ["src/lib/automation/improvement.ts"]
    }),
    checkpoints: buildImprovementCheckpoints({
      queueConfirmed: true,
      candidateSelected: true,
      provenanceRecorded: true
    })
  };
}

describe("hourly improvement durable state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.automationRun.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it("refuses to persist outcome_recorded before closeout", async () => {
    const record = buildHourlyRecord();
    record.checkpoints.outcome_recorded = true;

    await expect(updateHourlyImprovementRunState("run-hourly-1", record)).rejects.toThrow(
      "outcome_recorded may only become true"
    );
    expect(mockedPrisma.automationRun.updateMany).not.toHaveBeenCalled();
  });

  it("sets completedAt, terminal outcome, and outcome_recorded atomically", async () => {
    await closeHourlyImprovementRun("run-hourly-1", {
      outcome: "success",
      record: buildHourlyRecord(),
      changedFiles: ["src/lib/automation/improvement.ts"]
    });

    expect(mockedPrisma.automationRun.updateMany).toHaveBeenCalledTimes(1);
    const update = mockedPrisma.automationRun.updateMany.mock.calls[0]?.[0];
    expect(update?.data).toMatchObject({
      completedAt: expect.any(Date),
      outcome: "success",
      changedFiles: ["src/lib/automation/improvement.ts"]
    });
    expect(JSON.parse(String(update?.data.notes))).toMatchObject({
      lifecycle: "closeout",
      checkpoints: { outcome_recorded: true }
    });
  });
});

describe("recordTeeTimeMatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    mockedPrisma.teeTimeMatch.upsert.mockResolvedValue({ id: "match-1" } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-alert a tee time that briefly disappears and returns", async () => {
    mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue({
      availabilityStatus: "GONE",
      unavailableAt: new Date("2026-07-10T11:45:00.000Z"),
      availabilityCycle: 0
    } as never);

    await recordTeeTimeMatch({
      searchId: "search-1",
      courseId: "course-1",
      sourceId: "slot-1",
      startsAt: new Date("2026-07-11T12:00:00.000Z"),
      availableSpots: 4,
      bookingUrl: "https://example.com/book"
    });

    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({ alertStatus: "PENDING" })
      })
    );
  });

  it("re-alerts a tee time that returns after being absent for 30 minutes", async () => {
    mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue({
      availabilityStatus: "GONE",
      unavailableAt: new Date("2026-07-10T11:30:00.000Z"),
      availabilityCycle: 3
    } as never);

    await recordTeeTimeMatch({
      searchId: "search-1",
      courseId: "course-1",
      sourceId: "slot-1",
      startsAt: new Date("2026-07-11T12:00:00.000Z"),
      availableSpots: 4,
      bookingUrl: "https://example.com/book"
    });

    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          alertStatus: "PENDING",
          sentAt: null,
          availabilityCycle: { increment: 1 }
        })
      })
    );
  });
});

describe("markMissingMatchesUnavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([{ id: "match-1" }] as never);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({ count: 1 } as never);
    deliveryOutboxMocks.lockSearchForEmailReconciliation.mockResolvedValue({
      id: "search-1"
    });
    deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches.mockResolvedValue({
      count: 1
    });
  });

  it("suppresses pending alerts when their tee times disappear", async () => {
    await markMissingMatchesUnavailable({
      searchId: "search-1",
      alertGeneration: 2,
      checkLeaseToken: "check-lease",
      courseId: "course-1",
      date: "2026-07-11",
      timeZone: "America/New_York",
      confirmedMatches: [
        {
          sourceId: "foreup-6654-2026-07-11 08:00",
          startsAt: new Date("2026-07-11T12:00:00.000Z")
        }
      ]
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertStatus: "PENDING",
          startsAt: {
            gte: new Date("2026-07-11T04:00:00.000Z"),
            lt: new Date("2026-07-12T04:00:00.000Z")
          },
          NOT: [
            {
              sourceId: "foreup-6654-2026-07-11 08:00",
              startsAt: new Date("2026-07-11T12:00:00.000Z")
            }
          ]
        }),
        data: expect.objectContaining({
          alertStatus: "SUPPRESSED",
          availabilityStatus: "GONE"
        })
      })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertStatus: { not: "PENDING" }
        }),
        data: expect.not.objectContaining({
          alertStatus: expect.anything()
        })
      })
    );
    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
    expect(deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        searchId: "search-1",
        matchIds: ["match-1"],
        transaction: prisma
      })
    );
  });

  it("does not reconcile availability after the generation or check lease becomes stale", async () => {
    deliveryOutboxMocks.lockSearchForEmailReconciliation.mockResolvedValue(null);

    await expect(
      markMissingMatchesUnavailable({
        searchId: "search-1",
        alertGeneration: 2,
        checkLeaseToken: "stale-check-lease",
        courseId: "course-1",
        date: "2026-07-11",
        timeZone: "America/New_York",
        confirmedMatches: []
      })
    ).rejects.toThrow(
      "Search check is no longer current during availability reconciliation"
    );

    expect(mockedPrisma.teeTimeMatch.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(
      deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches
    ).not.toHaveBeenCalled();
  });
});

describe("recordCourseProbeIfChanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.courseProbe.create.mockResolvedValue({ id: "new-probe" } as never);
  });

  it("does not write the same Fairview policy block every five minutes", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation.",
      runtimeVersion: "local"
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation."
    });

    expect(mockedPrisma.courseProbe.create).not.toHaveBeenCalled();
  });

  it("records a transition from adapter work to a policy block", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "NEEDS_ADAPTER",
      message: "No supported adapter yet for UNKNOWN"
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation."
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
  });

  it("records unchanged evidence once for a newly deployed runtime", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "old-runtime-probe",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "old-release"
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "new-release"
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ runtimeVersion: "new-release" })
      })
    );
  });

  it("records a changed policy reason", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "BLOCKED_POLICY",
      message: "Older policy reason"
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation."
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
  });
});
