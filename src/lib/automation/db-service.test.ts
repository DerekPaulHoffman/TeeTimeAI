import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachSearchWorkflowRun,
  classifyAutomationRunKind,
  claimScheduledSearchCheck,
  closeHourlyImprovementRun,
  completeExpiredSyntheticSearch,
  completeScheduledSearchCheck,
  failScheduledSearchCheck,
  getActiveSearchForAutomation,
  listBrowserProbeTargets,
  listAvailableMatchAlerts,
  listPendingMatchAlerts,
  markMatchAlertSent,
  markMatchAlertSuppressed,
  markMissingMatchesUnavailable,
  parseAutomationRunAudit,
  listSearchesNeedingScheduleRecovery,
  queueSearchCheck,
  recordCourseProbeIfChanged,
  recordTeeTimeMatch,
  updateHourlyImprovementRunState
} from "./db-service";
import {
  appendAutomationPlaybookEvent,
  type AutomationPlaybookEventInput
} from "./course-monitoring-playbook";
import {
  buildHourlyImprovementRunProvenance,
  buildImprovementCheckpoints,
  type HourlyImprovementRunRecord
} from "./improvement";

const deliveryOutboxMocks = vi.hoisted(() => ({
  lockSearchForAlertMutation: vi.fn(),
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
    course: {
      findMany: vi.fn()
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn()
  }
}));
vi.mock("@/lib/email/search-delivery-outbox", () => deliveryOutboxMocks);

import { prisma } from "@/lib/prisma";

const mockedPrisma = vi.mocked(prisma);

const browserRuntimeVersion = "a".repeat(40);

function browserPlaybookLedger(includeTerminalReader: boolean) {
  const events: AutomationPlaybookEventInput[] = [
    {
      cycle: 1,
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:OFFICIAL_IDENTITY:COMPLETED",
      runtimeVersion: browserRuntimeVersion
    },
    {
      cycle: 1,
      stage: "TYPED_ADAPTER",
      transition: "NOT_APPLICABLE",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "TOOLING",
      skipReason: "NO_RUNNABLE_ADAPTER",
      failureFingerprint: "PLAYBOOK:TYPED_ADAPTER:NO_RUNNABLE_ADAPTER",
      runtimeVersion: browserRuntimeVersion
    },
    {
      cycle: 1,
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:OFFICIAL_HTTP_DISCOVERY:COMPLETED",
      runtimeVersion: browserRuntimeVersion
    },
    {
      cycle: 1,
      stage: "HTTP_ADAPTER_RETRY",
      transition: "NOT_APPLICABLE",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "TOOLING",
      skipReason: "NO_RUNNABLE_ADAPTER",
      failureFingerprint: "PLAYBOOK:HTTP_ADAPTER_RETRY:NO_RUNNABLE_ADAPTER",
      runtimeVersion: browserRuntimeVersion
    },
    ...(includeTerminalReader
      ? ([
          {
            cycle: 1,
            stage: "RENDERED_BROWSER_DISCOVERY",
            transition: "COMPLETED",
            readPath: "RENDERED_BROWSER",
            evidenceKind: "RENDERED_PAGE",
            failureFingerprint:
              "PLAYBOOK:RENDERED_BROWSER_DISCOVERY:COMPLETED",
            runtimeVersion: browserRuntimeVersion
          },
          {
            cycle: 1,
            stage: "BROWSER_ADAPTER_RETRY",
            transition: "NOT_APPLICABLE",
            readPath: "TYPED_PROVIDER_ADAPTER",
            evidenceKind: "TOOLING",
            skipReason: "NO_RUNNABLE_ADAPTER",
            failureFingerprint:
              "PLAYBOOK:BROWSER_ADAPTER_RETRY:NO_RUNNABLE_ADAPTER",
            runtimeVersion: browserRuntimeVersion
          },
          {
            cycle: 1,
            stage: "LOCAL_READER",
            transition: "FAILED_TERMINAL",
            readPath: "LOCAL_READER",
            evidenceKind: "LOCAL_READER_RESULT",
            failureClass: "SCHEMA",
            failureFingerprint: "PLAYBOOK:LOCAL_READER:SCHEMA",
            runtimeVersion: "reader-v1"
          }
        ] satisfies AutomationPlaybookEventInput[])
      : [])
  ];
  return events.reduce<ReturnType<typeof appendAutomationPlaybookEvent> | null>(
    (ledger, event) => appendAutomationPlaybookEvent(ledger, event),
    null
  );
}

function localReaderOnlyBrowserProbeCourse(attemptLedger: unknown) {
  return {
    id: "course-reader-only",
    name: "Reader Only Course",
    website: "https://course.example/tee-times",
    detectedBookingUrl: "https://course.example/tee-times",
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "UNKNOWN",
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "UNSUPPORTED_PROVIDER",
    bookingMethod: "ONLINE",
    monitoringMode: "LOCAL_READER_ONLY",
    isPublic: true,
    intelligenceVerifiedAt: null,
    intelligenceReviewAt: null,
    intelligenceConfidence: null,
    bookingMetadata: null,
    supportIncident: {
      kind: "READER_CANDIDATE",
      failureClass: "READER_PARSER_MISSING",
      occurrenceCount: 1,
      lastSeenAt: new Date("2026-07-21T12:00:00.000Z"),
      cycle: 1,
      attemptLedger
    },
    probes: [],
    preferences: []
  };
}

describe("automation query payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects an exact reader-only course for independent browser confirmation", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      localReaderOnlyBrowserProbeCourse(browserPlaybookLedger(true))
    ] as never);

    await expect(
      listBrowserProbeTargets(1, undefined, "course-reader-only")
    ).resolves.toEqual([
      expect.objectContaining({
        searchId: undefined,
        course: expect.objectContaining({ id: "course-reader-only" })
      })
    ]);
    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "course-reader-only" })
      })
    );
  });

  it("still excludes an exact reader-only course from rendered browser discovery", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      localReaderOnlyBrowserProbeCourse(browserPlaybookLedger(false))
    ] as never);

    await expect(
      listBrowserProbeTargets(1, undefined, "course-reader-only")
    ).resolves.toEqual([]);
  });

  it("loads an active check without historical matches or unused user fields", async () => {
    mockedPrisma.teeSearch.findFirst.mockResolvedValue(null);

    await getActiveSearchForAutomation("search-1");

    expect(mockedPrisma.teeSearch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          user: {
            select: {
              email: true
            }
          },
          preferences: expect.any(Object)
        })
      })
    );
    const query = mockedPrisma.teeSearch.findFirst.mock.calls[0]?.[0];
    expect(query?.include).not.toHaveProperty("matches");
  });

  it("loads a still-active course-local target date after UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T02:00:00.000Z"));
    const search = {
      id: "search-local-day",
      status: "ACTIVE",
      date: new Date("2026-07-20T00:00:00.000Z"),
      endTime: "23:00",
      userTimeZone: "America/New_York",
      preferences: [{ course: { timeZone: "America/New_York" } }]
    };
    mockedPrisma.teeSearch.findFirst.mockResolvedValue(search as never);

    try {
      await expect(getActiveSearchForAutomation(search.id)).resolves.toBe(search);
      expect(mockedPrisma.teeSearch.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            date: { gte: new Date("2026-07-20T00:00:00.000Z") }
          })
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an active row after its exact course-local search window ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T03:00:00.000Z"));
    mockedPrisma.teeSearch.findFirst.mockResolvedValue({
      id: "search-ended",
      status: "ACTIVE",
      date: new Date("2026-07-20T00:00:00.000Z"),
      endTime: "23:00",
      userTimeZone: "America/New_York",
      preferences: [{ course: { timeZone: "America/New_York" } }]
    } as never);

    try {
      await expect(getActiveSearchForAutomation("search-ended")).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits pending alert hydration to the current rendered matches", async () => {
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([]);

    await listPendingMatchAlerts("search-1", ["match-1", "match-2"]);

    expect(mockedPrisma.teeTimeMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["match-1", "match-2"] },
          teeSearch: {
            status: "ACTIVE",
            id: "search-1"
          }
        }),
        select: expect.objectContaining({
          id: true,
          course: {
            select: {
              id: true,
              name: true,
              address: true,
              timeZone: true
            }
          }
        })
      })
    );
  });

  it("skips match queries when the current check rendered no matches", async () => {
    await expect(listPendingMatchAlerts("search-1", [])).resolves.toEqual([]);
    await expect(listAvailableMatchAlerts("search-1", [])).resolves.toEqual([]);

    expect(mockedPrisma.teeTimeMatch.findMany).not.toHaveBeenCalled();
  });
});

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

  it("terminalizes an expired synthetic search and its pending matches", async () => {
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      callback(mockedPrisma as never)
    );
    deliveryOutboxMocks.lockSearchForAlertMutation.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE",
      checkLeaseToken: "lease-token"
    });
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({ count: 2 } as never);

    await expect(
      completeExpiredSyntheticSearch({
        searchId: "search-1",
        scheduleVersion: 4,
        leaseToken: "lease-token",
        outcome: "synthetic multi-cycle test lifetime ended"
      })
    ).resolves.toEqual({ completedAt: expect.any(Date) });

    expect(deliveryOutboxMocks.lockSearchForAlertMutation).toHaveBeenCalledWith(
      mockedPrisma,
      { searchId: "search-1" }
    );
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "search-1",
        scheduleVersion: 4,
        checkLeaseToken: "lease-token",
        status: "ACTIVE"
      },
      data: expect.objectContaining({
        status: "COMPLETED",
        scheduleVersion: { increment: 1 },
        alertGeneration: { increment: 1 },
        checkStatus: "STOPPED",
        nextCheckAt: null,
        workflowRunId: null,
        lastCheckOutcome: "synthetic multi-cycle test lifetime ended"
      })
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        alertStatus: "PENDING"
      },
      data: {
        alertStatus: "SUPPRESSED",
        sentAt: null
      }
    });
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

  it("preserves an attached workflow whose wake already meets the endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:34:44.000Z"));
    const current = {
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 8,
      remediationDispatchKey: null,
      remediationDispatchVersion: null,
      workflowRunId: "healthy-run",
      checkStatus: "WAITING",
      nextCheckAt: new Date("2026-08-11T20:34:57.000Z"),
      preferences: [
        {
          course: {
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:35:26.000Z")
            }
          }
        }
      ],
      updatedAt: new Date("2026-08-11T20:34:30.000Z")
    };
    const tx = {
      teeSearch: {
        findUnique: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx)
    );

    try {
      await expect(
        queueSearchCheck("search-1", "dispatch-before-deadline")
      ).resolves.toMatchObject({
        scheduleVersion: 8,
        workflowRunId: "healthy-run",
        checkStatus: "WAITING"
      });
      expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            scheduleVersion: 8,
            workflowRunId: "healthy-run",
            checkStatus: "WAITING",
            nextCheckAt: new Date("2026-08-11T20:34:57.000Z")
          }),
          data: {
            remediationDispatchKey: "dispatch-before-deadline",
            remediationDispatchVersion: 8
          }
        })
      );
      const dispatchData = tx.teeSearch.updateMany.mock.calls[0]?.[0]?.data;
      expect(dispatchData).not.toHaveProperty("scheduleVersion");
      expect(dispatchData).not.toHaveProperty("workflowRunId");
      expect(dispatchData).not.toHaveProperty("checkStatus");
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces an attached workflow whose endpoint wake is already overdue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:34:44.000Z"));
    const current = {
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion: 8,
      remediationDispatchKey: null,
      remediationDispatchVersion: null,
      workflowRunId: "stuck-run",
      checkStatus: "WAITING",
      nextCheckAt: new Date("2026-08-11T20:34:40.000Z"),
      preferences: [
        {
          course: {
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:35:26.000Z")
            }
          }
        }
      ],
      updatedAt: new Date("2026-08-11T20:34:30.000Z")
    };
    const queued = {
      ...current,
      scheduleVersion: 9,
      remediationDispatchKey: "dispatch-overdue-wake",
      remediationDispatchVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      nextCheckAt: new Date("2026-08-11T20:34:44.000Z")
    };
    const tx = {
      teeSearch: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce(queued),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx)
    );

    try {
      await expect(
        queueSearchCheck("search-1", "dispatch-overdue-wake")
      ).resolves.toMatchObject({
        scheduleVersion: 9,
        workflowRunId: null,
        checkStatus: "QUEUED"
      });
      expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scheduleVersion: { increment: 1 },
            workflowRunId: null,
            checkStatus: "QUEUED"
          })
        })
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("atomically replaces the exact attached queued workflow", async () => {
    const tx = mockGuardedTransaction(1);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt,
        checkStatus: "QUEUED",
        workflowRunId: "workflow-sleeping",
        recoveryDispatchKey: "endpoint-deadline:incident-1:2"
      })
    ).resolves.toMatchObject({
      status: "ACTIVE",
      scheduleVersion: 9,
      checkStatus: "QUEUED"
    });

    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scheduleVersion: 8,
          updatedAt,
          checkStatus: "QUEUED",
          workflowRunId: "workflow-sleeping",
          OR: [
            { checkLeaseExpiresAt: null },
            { checkLeaseExpiresAt: { lte: observedAt } }
          ]
        }),
        data: expect.objectContaining({
          remediationDispatchKey: "endpoint-deadline:incident-1:2",
          remediationDispatchVersion: 9
        })
      })
    );
  });

  it("rejects an attached queued workflow that raced into checking", async () => {
    const tx = mockGuardedTransaction(0);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt,
        checkStatus: "QUEUED",
        workflowRunId: "workflow-sleeping"
      })
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkStatus: "QUEUED",
          workflowRunId: "workflow-sleeping"
        })
      })
    );
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

  it("keeps the prior UTC date in the recovery cohort until exact local expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T02:00:00.000Z"));
    mockedPrisma.teeSearch.findMany.mockResolvedValue([] as never);

    try {
      await listSearchesNeedingScheduleRecovery();

      expect(mockedPrisma.teeSearch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            date: { gte: new Date("2026-07-20T00:00:00.000Z") }
          })
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers QUEUED rows after two minutes while retaining ten-minute waiting thresholds", async () => {
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
                checkStatus: "QUEUED",
                workflowRunId: null,
                updatedAt: { lte: new Date("2026-07-16T11:58:00.000Z") }
              },
              {
                checkStatus: "QUEUED",
                workflowRunId: { not: null },
                updatedAt: { lte: new Date("2026-07-16T11:50:00.000Z") }
              },
              {
                checkStatus: "WAITING",
                nextCheckAt: { lte: new Date("2026-07-16T11:50:00.000Z") }
              }
            ])
          }),
          select: expect.objectContaining({
            id: true,
            scheduleVersion: true,
            checkStatus: true,
            workflowRunId: true
          })
        })
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("recovers a search in time for the ten-minute first-verdict target", async () => {
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
                    statusEmailSentAt: null,
                    createdAt: { lte: new Date("2026-07-16T11:55:00.000Z") }
                  },
                  {
                    checkStatus: { in: ["WAITING", "FAILED"] },
                    OR: [
                      { checkLeaseExpiresAt: null },
                      { checkLeaseExpiresAt: { lte: new Date("2026-07-16T12:00:00.000Z") } }
                    ]
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

      const query = mockedPrisma.teeSearch.findMany.mock.calls.find(
        ([candidate]) =>
          Array.isArray(candidate?.where?.OR) &&
          candidate.where.OR.some(
            (branch) => branch.checkStatus === "IDLE"
          )
      )?.[0];
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

  it("prioritizes an imminent endpoint whose queued workflow was never attached", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:23:00.000Z"));
    mockedPrisma.teeSearch.findMany.mockClear();
    mockedPrisma.teeSearch.findMany.mockResolvedValue([] as never);

    try {
      await listSearchesNeedingScheduleRecovery(
        new Date("2026-08-11T20:23:00.000Z")
      );

      expect(mockedPrisma.teeSearch.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              {
                checkStatus: "QUEUED",
                workflowRunId: null,
                preferences: {
                  some: {
                    course: {
                      supportIncident: {
                        is: expect.objectContaining({
                          status: "AUTO_INVESTIGATING",
                          humanReviewReason: null,
                          escalationDeadlineAt: {
                            lte: new Date("2026-08-11T20:28:00.000Z")
                          }
                        })
                      }
                    }
                  }
                }
              }
            ])
          }),
          take: 50
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers an undelivered attached setup with cron-jitter headroom", async () => {
    const observedAt = new Date("2026-08-11T20:25:00.000Z");
    mockedPrisma.teeSearch.findMany.mockClear();
    mockedPrisma.teeSearch.findMany.mockResolvedValue([] as never);

    await listSearchesNeedingScheduleRecovery(observedAt);

    expect(mockedPrisma.teeSearch.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              statusEmailSentAt: null,
              checkStatus: "QUEUED",
              workflowRunId: { not: null },
              updatedAt: { lte: new Date("2026-08-11T20:21:00.000Z") }
            }
          ])
        })
      })
    );
  });

  it("proactively replaces one sleeping endpoint workflow before a phase-offset deadline", async () => {
    const observedAt = new Date("2026-08-11T20:27:00.000Z");
    const deadlineAt = new Date("2026-08-11T20:28:00.000Z");
    const candidate = {
      id: "search-phase-offset",
      scheduleVersion: 7,
      checkStatus: "WAITING",
      workflowRunId: "workflow-sleeping",
      nextCheckAt: deadlineAt,
      updatedAt: new Date("2026-08-11T20:20:00.000Z"),
      statusEmailSentAt: new Date("2026-08-11T20:00:10.000Z"),
      remediationDispatchKey: null,
      preferences: [
        {
          course: {
            supportIncident: {
              id: "incident-1",
              cycle: 3,
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: deadlineAt,
              escalatedAt: null
            }
          }
        }
      ]
    };
    mockedPrisma.teeSearch.findMany.mockClear();
    mockedPrisma.teeSearch.findMany
      .mockResolvedValueOnce([candidate] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        {
          ...candidate,
          remediationDispatchKey: "endpoint-deadline:incident-1:3"
        }
      ] as never)
      .mockResolvedValueOnce([] as never);

    const first = await listSearchesNeedingScheduleRecovery(observedAt);
    const repeated = await listSearchesNeedingScheduleRecovery(observedAt);

    expect(first).toEqual([
      {
        ...candidate,
        endpointRecoveryDispatchKey: "endpoint-deadline:incident-1:3"
      }
    ]);
    expect(repeated).toEqual([]);
    expect(mockedPrisma.teeSearch.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              checkStatus: { in: ["QUEUED", "WAITING"] },
              workflowRunId: { not: null },
              preferences: expect.any(Object)
            })
          ])
        })
      })
    );
  });

  it("keeps a just-escalated endpoint in the critical queued recovery cohort", async () => {
    const observedAt = new Date("2026-08-11T20:28:01.000Z");
    const justEscalated = {
      id: "search-just-escalated",
      scheduleVersion: 4,
      checkStatus: "QUEUED",
      workflowRunId: null,
      nextCheckAt: observedAt,
      updatedAt: observedAt
    };
    mockedPrisma.teeSearch.findMany.mockClear();
    mockedPrisma.teeSearch.findMany
      .mockResolvedValueOnce([justEscalated] as never)
      .mockResolvedValueOnce([] as never);

    const recovered = await listSearchesNeedingScheduleRecovery(observedAt);

    expect(recovered).toEqual([justEscalated]);
    const criticalWhere = mockedPrisma.teeSearch.findMany.mock.calls[0]?.[0]
      ?.where;
    expect(criticalWhere).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          {
            AND: [
              {
                checkStatus: { in: ["QUEUED", "WAITING"] }
              },
              {
                recheckRequestedAt: {
                  gte: new Date("2026-08-11T20:23:01.000Z")
                }
              },
              {
                preferences: {
                  some: {
                    course: {
                      supportIncident: {
                        is: {
                          escalatedAt: {
                            gte: new Date("2026-08-11T20:23:01.000Z")
                          },
                          escalationDeadlineAt: { lte: observedAt },
                          OR: [
                            {
                              status: "AUTO_INVESTIGATING",
                              humanReviewReason: "AUTOMATION_STALLED"
                            },
                            {
                              status: "NEEDS_HUMAN",
                              humanReviewReason: { not: null }
                            }
                          ]
                        },
                      }
                    }
                  }
                }
              }
            ]
          }
        ])
      })
    );
  });

  it("prioritizes a just-escalated waiting search with an attached workflow", async () => {
    const observedAt = new Date("2026-08-11T20:28:01.000Z");
    const justEscalated = {
      id: "search-waiting-escalated",
      scheduleVersion: 6,
      checkStatus: "WAITING",
      workflowRunId: "workflow-sleeping",
      nextCheckAt: new Date("2026-08-11T20:33:00.000Z"),
      updatedAt: observedAt
    };
    mockedPrisma.teeSearch.findMany.mockClear();
    mockedPrisma.teeSearch.findMany
      .mockResolvedValueOnce([justEscalated] as never)
      .mockResolvedValueOnce([] as never);

    const recovered = await listSearchesNeedingScheduleRecovery(observedAt);

    expect(recovered).toEqual([justEscalated]);
    const criticalWhere = mockedPrisma.teeSearch.findMany.mock.calls[0]?.[0]
      ?.where;
    expect(criticalWhere?.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          AND: expect.arrayContaining([
            {
              checkStatus: { in: ["QUEUED", "WAITING"] }
            }
          ])
        })
      ])
    );
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

describe("match alert cycle finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not let a delayed old-cycle send consume a reopened cycle", async () => {
    mockedPrisma.teeTimeMatch.updateMany
      .mockResolvedValueOnce({ count: 0 } as never)
      .mockResolvedValueOnce({ count: 1 } as never);

    await expect(
      markMatchAlertSent({ matchId: "match-1", availabilityCycle: 0 })
    ).resolves.toBeNull();
    await expect(
      markMatchAlertSent({ matchId: "match-1", availabilityCycle: 1 })
    ).resolves.toEqual(
      expect.objectContaining({
        id: "match-1",
        availabilityCycle: 1,
        alertStatus: "SENT"
      })
    );

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: "match-1",
          availabilityCycle: 0,
          alertStatus: "PENDING"
        }
      })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: "match-1",
          availabilityCycle: 1,
          alertStatus: "PENDING"
        }
      })
    );
  });

  it("suppresses only the exact pending availability cycle", async () => {
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({ count: 1 } as never);

    await expect(
      markMatchAlertSuppressed({ matchId: "match-1", availabilityCycle: 4 })
    ).resolves.toEqual(
      expect.objectContaining({
        id: "match-1",
        availabilityCycle: 4,
        alertStatus: "SUPPRESSED"
      })
    );

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "match-1",
        availabilityCycle: 4,
        alertStatus: "PENDING"
      },
      data: {
        alertStatus: "SUPPRESSED",
        sentAt: expect.any(Date)
      }
    });
  });
});

describe("markMissingMatchesUnavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { id: "match-1", availabilityCycle: 3 }
    ] as never);
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
        matchRefs: [{ matchId: "match-1", availabilityCycle: 3 }],
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

  it("does not dedupe an unchanged success across an alert generation boundary", async () => {
    const generationStartedAt = new Date("2026-08-11T20:00:00.000Z");
    mockedPrisma.courseProbe.findFirst.mockResolvedValue(null);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "NO_MATCH",
      message: "Booking opens next week.",
      runtimeVersion: "same-release",
      observedAtOrAfter: generationStartedAt
    });

    expect(mockedPrisma.courseProbe.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          teeSearchId: "search-1",
          courseId: "fairview-farm",
          observedAt: { gte: generationStartedAt }
        }
      })
    );
    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
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

  it("classifies legacy automation runs without relying on free-form notes", () => {
    expect(classifyAutomationRunKind("hourly-improvement-v2")).toBe("IMPROVEMENT");
    expect(classifyAutomationRunKind("tee-time-spot-local-codex-loop-v1")).toBe(
      "IMPROVEMENT"
    );
    expect(classifyAutomationRunKind("course-support-v3")).toBe("COURSE_SUPPORT");
    expect(classifyAutomationRunKind("search-check-v2")).toBe("SEARCH_CHECK");
    expect(classifyAutomationRunKind("browser-probe-v1")).toBe("BROWSER_PROBE");
    expect(classifyAutomationRunKind("legacy")).toBe("OTHER");
  });

  it("copies parseable object notes into structured audit data", () => {
    expect(parseAutomationRunAudit('{"phase":"inspect","count":2}')).toEqual({
      phase: "inspect",
      count: 2
    });
    expect(parseAutomationRunAudit("not json")).toBeNull();
    expect(parseAutomationRunAudit("[1,2]")).toBeNull();
  });
});
