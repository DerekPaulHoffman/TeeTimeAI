import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyRecoveredOfficialWebsiteToCourse,
  attachSearchWorkflowRun,
  classifyAutomationRunKind,
  claimScheduledSearchCheck,
  closeHourlyImprovementRun,
  commitCurrentCourseTeeTimeMatches,
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
  markCourseBookingWindowChecked,
  parseAutomationRunAudit,
  listSearchesNeedingScheduleRecovery,
  queueSearchCheck,
  recordAndApplyBrowserDiscoveryToCourse,
  recordBrowserDiscovery,
  recordCourseBookingWindowEvidence,
  recordCoursePhysicalLayoutEvidence,
  recordCourseProbeIfChanged,
  recordTeeTimeMatch,
  updateHourlyImprovementRunState,
} from "./db-service";
import {
  appendAutomationPlaybookEvent,
  type AutomationPlaybookEventInput,
} from "./course-monitoring-playbook";
import {
  ACTIVE_OWNED_COURSE_SUPPORT_BROWSER_RESULTS,
  persistOwnedCourseSupportBrowserPlaybookStages,
  type CourseSupportBrowserPersistenceFence,
  type CourseSupportBrowserStageBatch,
} from "./course-support-browser-stages";
import {
  buildHourlyImprovementRunProvenance,
  buildImprovementCheckpoints,
  type HourlyImprovementRunRecord,
} from "./improvement";

const deliveryOutboxMocks = vi.hoisted(() => ({
  lockSearchForAlertMutation: vi.fn(),
  lockSearchForEmailReconciliation: vi.fn(),
  reactivateTerminalUnresolvedMatchDeliveries: vi.fn(),
  suppressSearchEmailDeliveriesForMatches: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teeTimeMatch: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    courseProbe: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    automationRun: {
      updateMany: vi.fn(),
    },
    teeSearch: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    course: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    courseBookingFact: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    courseAutomationDiscovery: {
      create: vi.fn(),
    },
    courseSupportIncident: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    courseSupportBatch: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    courseSupportBatchIncident: {
      findUnique: vi.fn(),
    },
    courseMonitoringStatus: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    courseMonitoringEvent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    localReaderJob: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    providerRequestLease: {
      deleteMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/email/search-delivery-outbox", () => deliveryOutboxMocks);

import { prisma } from "@/lib/prisma";

const mockedPrisma = vi.mocked(prisma, { deep: true });

beforeEach(() => {
  mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 0 } as never);
  mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({ count: 0 } as never);
});

const browserRuntimeVersion = "a".repeat(40);
const browserDeployedAt = new Date("2026-07-21T12:00:00.000Z");

function ownedBrowserPersistenceFence(
  overrides: Partial<CourseSupportBrowserPersistenceFence> = {},
): CourseSupportBrowserPersistenceFence {
  return {
    batchId: "batch-browser",
    leaseToken: "lease-browser",
    ownerThreadId: "owner-browser",
    releaseSha: browserRuntimeVersion,
    deployedAt: browserDeployedAt,
    runtimeVersion: browserRuntimeVersion,
    incidentId: "incident-blocked-tooling",
    courseId: "course-blocked-tooling",
    cycle: 1,
    stage: "RENDERED_BROWSER_DISCOVERY",
    ...overrides,
  };
}

function browserPlaybookLedger(includeTerminalReader: boolean) {
  const events: AutomationPlaybookEventInput[] = [
    {
      cycle: 1,
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:OFFICIAL_IDENTITY:COMPLETED",
      runtimeVersion: browserRuntimeVersion,
    },
    {
      cycle: 1,
      stage: "TYPED_ADAPTER",
      transition: "NOT_APPLICABLE",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "TOOLING",
      skipReason: "NO_RUNNABLE_ADAPTER",
      failureFingerprint: "PLAYBOOK:TYPED_ADAPTER:NO_RUNNABLE_ADAPTER",
      runtimeVersion: browserRuntimeVersion,
    },
    {
      cycle: 1,
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:OFFICIAL_HTTP_DISCOVERY:COMPLETED",
      runtimeVersion: browserRuntimeVersion,
    },
    {
      cycle: 1,
      stage: "HTTP_ADAPTER_RETRY",
      transition: "NOT_APPLICABLE",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "TOOLING",
      skipReason: "NO_RUNNABLE_ADAPTER",
      failureFingerprint: "PLAYBOOK:HTTP_ADAPTER_RETRY:NO_RUNNABLE_ADAPTER",
      runtimeVersion: browserRuntimeVersion,
    },
    ...(includeTerminalReader
      ? ([
          {
            cycle: 1,
            stage: "RENDERED_BROWSER_DISCOVERY",
            transition: "COMPLETED",
            readPath: "RENDERED_BROWSER",
            evidenceKind: "RENDERED_PAGE",
            failureFingerprint: "PLAYBOOK:RENDERED_BROWSER_DISCOVERY:COMPLETED",
            runtimeVersion: browserRuntimeVersion,
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
            runtimeVersion: browserRuntimeVersion,
          },
          {
            cycle: 1,
            stage: "LOCAL_READER",
            transition: "FAILED_TERMINAL",
            readPath: "LOCAL_READER",
            evidenceKind: "LOCAL_READER_RESULT",
            failureClass: "SCHEMA",
            failureFingerprint: "PLAYBOOK:LOCAL_READER:SCHEMA",
            runtimeVersion: "reader-v1",
          },
        ] satisfies AutomationPlaybookEventInput[])
      : []),
  ];
  return events.reduce<ReturnType<typeof appendAutomationPlaybookEvent> | null>(
    (ledger, event) => appendAutomationPlaybookEvent(ledger, event),
    null,
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
      attemptLedger,
    },
    probes: [],
    preferences: [],
  };
}

function blockedToolingBrowserProbeCourse(
  failureClass: "AUTH" | "CHALLENGE",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "course-blocked-tooling",
    name: "Blocked Tooling Course",
    googlePlaceId: "place-blocked-tooling",
    address: "1 Public Course Way",
    city: "Testville",
    stateCode: "MA",
    website: "https://course.example/tee-times",
    detectedBookingUrl: "https://course.example/tee-times",
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "UNKNOWN",
    automationEligibility: "BLOCKED",
    automationReason:
      failureClass === "AUTH" ? "ACCOUNT_REQUIRED" : "CAPTCHA_OR_QUEUE",
    bookingMethod: "PUBLIC_ONLINE",
    monitoringMode: "BROWSER_ONLY",
    isPublic: true,
    intelligenceVerifiedAt: null,
    intelligenceReviewAt: null,
    intelligenceConfidence: null,
    bookingMetadata: null,
    layoutHoleCounts: [],
    layoutHolesVerifiedAt: null,
    supportIncident: {
      id: "incident-blocked-tooling",
      kind: "BLOCKED_TOOLING",
      failureClass,
      status: "AUTO_INVESTIGATING",
      activeBatchId: "batch-browser",
      occurrenceCount: 1,
      lastSeenAt: new Date("2026-07-21T12:00:00.000Z"),
      cycle: 1,
      confirmedAt: new Date("2026-07-21T11:00:00.000Z"),
      attemptLedger: browserPlaybookLedger(false),
    },
    probes: [],
    preferences: [],
    ...overrides,
  };
}

function fetchFailedMissingMetadataBrowserProbeCourse(
  overrides: Record<string, unknown> = {},
) {
  const base = blockedToolingBrowserProbeCourse("AUTH");
  return {
    ...base,
    supportIncident: {
      ...base.supportIncident,
      kind: "FETCH_FAILED",
      failureClass: "MISSING_METADATA",
    },
    ...overrides,
  };
}

describe("automation query payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.courseSupportBatch.findFirst.mockResolvedValue({
      id: "current-owned-batch",
    } as never);
  });

  it("selects an exact reader-only course for independent browser confirmation", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      localReaderOnlyBrowserProbeCourse(browserPlaybookLedger(true)),
    ] as never);

    await expect(
      listBrowserProbeTargets(1, undefined, "course-reader-only"),
    ).resolves.toEqual([
      expect.objectContaining({
        searchId: undefined,
        course: expect.objectContaining({ id: "course-reader-only" }),
      }),
    ]);
    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "course-reader-only" }),
      }),
    );
  });

  it("still excludes an exact reader-only course from rendered browser discovery", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      localReaderOnlyBrowserProbeCourse(browserPlaybookLedger(false)),
    ] as never);

    await expect(
      listBrowserProbeTargets(1, undefined, "course-reader-only"),
    ).resolves.toEqual([]);
  });

  it.each(["AUTH", "CHALLENGE"] as const)(
    "selects an owned BLOCKED_TOOLING/%s course for its exact rendered stage",
    async (failureClass) => {
      mockedPrisma.course.findMany.mockResolvedValue([
        blockedToolingBrowserProbeCourse(failureClass),
      ] as never);

      await expect(
        listBrowserProbeTargets(
          1,
          undefined,
          "course-blocked-tooling",
          ownedBrowserPersistenceFence(),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          course: expect.objectContaining({ id: "course-blocked-tooling" }),
          probeUrl: "https://course.example/tee-times",
        }),
      ]);
      expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            supportIncident: {
              select: expect.objectContaining({
                id: true,
                status: true,
                activeBatchId: true,
              }),
            },
          }),
        }),
      );
      expect(mockedPrisma.courseSupportBatch.findFirst).toHaveBeenCalledWith({
        where: {
          id: "batch-browser",
          leaseToken: "lease-browser",
          ownerThreadId: "owner-browser",
          status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
          leaseExpiresAt: { gt: expect.any(Date) },
          releaseSha: browserRuntimeVersion,
          deployedAt: browserDeployedAt,
          incidents: {
            some: {
              incidentId: "incident-blocked-tooling",
              courseId: "course-blocked-tooling",
              cycle: 1,
              result: {
                in: [...ACTIVE_OWNED_COURSE_SUPPORT_BROWSER_RESULTS],
              },
            },
          },
        },
        select: { id: true },
      });
    },
  );

  it.each(["AUTH", "CHALLENGE"] as const)(
    "keeps unowned BLOCKED_TOOLING/%s excluded from exact browser selection",
    async (failureClass) => {
      mockedPrisma.course.findMany.mockResolvedValue([
        blockedToolingBrowserProbeCourse(failureClass),
      ] as never);

      await expect(
        listBrowserProbeTargets(1, undefined, "course-blocked-tooling"),
      ).resolves.toEqual([]);
    },
  );

  it("selects an owned FETCH_FAILED/MISSING_METADATA course at its exact rendered stage", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      fetchFailedMissingMetadataBrowserProbeCourse(),
    ] as never);

    await expect(
      listBrowserProbeTargets(
        1,
        undefined,
        "course-blocked-tooling",
        ownedBrowserPersistenceFence(),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        course: expect.objectContaining({ id: "course-blocked-tooling" }),
        probeUrl: "https://course.example/tee-times",
      }),
    ]);
  });

  it("keeps an unowned FETCH_FAILED/MISSING_METADATA course out of exact browser selection", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      fetchFailedMissingMetadataBrowserProbeCourse(),
    ] as never);

    await expect(
      listBrowserProbeTargets(1, undefined, "course-blocked-tooling"),
    ).resolves.toEqual([]);
    expect(mockedPrisma.courseSupportBatch.findFirst).not.toHaveBeenCalled();
  });

  it("keeps FETCH_FAILED/MISSING_METADATA excluded when its owner fence is stale", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      fetchFailedMissingMetadataBrowserProbeCourse(),
    ] as never);
    mockedPrisma.courseSupportBatch.findFirst.mockResolvedValue(null);

    await expect(
      listBrowserProbeTargets(
        1,
        undefined,
        "course-blocked-tooling",
        ownedBrowserPersistenceFence(),
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    ["a private identity", { isPublic: false }],
    [
      "an unsafe source",
      {
        website: "http://127.0.0.1/private",
        detectedBookingUrl: "http://127.0.0.1/private",
      },
    ],
  ])(
    "does not let an exact owner fence admit FETCH_FAILED/MISSING_METADATA with %s",
    async (_label, overrides) => {
      mockedPrisma.course.findMany.mockResolvedValue([
        fetchFailedMissingMetadataBrowserProbeCourse(overrides),
      ] as never);
      mockedPrisma.courseMonitoringEvent.findFirst.mockResolvedValue(null);

      await expect(
        listBrowserProbeTargets(
          1,
          undefined,
          "course-blocked-tooling",
          ownedBrowserPersistenceFence(),
        ),
      ).resolves.toEqual([]);
    },
  );

  it.each([
    ["course", { courseId: "course-other" }, {}],
    ["incident", { incidentId: "incident-other" }, {}],
    ["cycle", { cycle: 2 }, {}],
    ["active batch", {}, { activeBatchId: "batch-other" }],
    ["incident status", {}, { status: "NEEDS_HUMAN" }],
    ["stage", { stage: "INDEPENDENT_CONFIRMATION" }, {}],
  ] as const)(
    "excludes an owned blocked-tooling target when the %s fence is stale",
    async (_field, fenceOverrides, incidentOverrides) => {
      const course = blockedToolingBrowserProbeCourse("AUTH");
      course.supportIncident = {
        ...course.supportIncident,
        ...incidentOverrides,
      };
      mockedPrisma.course.findMany.mockResolvedValue([course] as never);
      const fence = ownedBrowserPersistenceFence(
        fenceOverrides as Partial<CourseSupportBrowserPersistenceFence>,
      );

      await expect(
        listBrowserProbeTargets(1, undefined, fence.courseId, fence),
      ).resolves.toEqual([]);
    },
  );

  it.each([
    ["lease", { leaseToken: "lease-stale" }],
    ["owner", { ownerThreadId: "owner-stale" }],
    ["release", { releaseSha: "b".repeat(40), runtimeVersion: "b".repeat(40) }],
    ["deployment", { deployedAt: new Date("2026-07-21T12:01:00.000Z") }],
    ["inactive status", {}],
    ["expired lease", {}],
    ["missing membership", {}],
    ["completed member", {}],
  ] as const)(
    "excludes an owned target when current batch %s proof is absent",
    async (_field, fenceOverrides) => {
      mockedPrisma.course.findMany.mockResolvedValue([
        blockedToolingBrowserProbeCourse("AUTH"),
      ] as never);
      mockedPrisma.courseSupportBatch.findFirst.mockResolvedValue(null);
      const fence = ownedBrowserPersistenceFence(
        fenceOverrides as Partial<CourseSupportBrowserPersistenceFence>,
      );

      await expect(
        listBrowserProbeTargets(1, undefined, fence.courseId, fence),
      ).resolves.toEqual([]);
      expect(mockedPrisma.courseSupportBatch.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: fence.batchId,
            leaseToken: fence.leaseToken,
            ownerThreadId: fence.ownerThreadId,
            leaseExpiresAt: { gt: expect.any(Date) },
            releaseSha: fence.releaseSha,
            deployedAt: fence.deployedAt,
            incidents: {
              some: expect.objectContaining({
                incidentId: fence.incidentId,
                courseId: fence.courseId,
                cycle: fence.cycle,
                result: {
                  in: [...ACTIVE_OWNED_COURSE_SUPPORT_BROWSER_RESULTS],
                },
              }),
            },
          }),
        }),
      );
    },
  );

  it("rejects a persistence fence whose runtime differs from its release", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      blockedToolingBrowserProbeCourse("AUTH"),
    ] as never);
    const fence = ownedBrowserPersistenceFence({
      runtimeVersion: "b".repeat(40),
    });

    await expect(
      listBrowserProbeTargets(1, undefined, fence.courseId, fence),
    ).resolves.toEqual([]);
    expect(mockedPrisma.courseSupportBatch.findFirst).not.toHaveBeenCalled();
  });

  it("keeps LOCAL_READER_ONLY rendered discovery excluded under a current fence", async () => {
    const course = localReaderOnlyBrowserProbeCourse(
      browserPlaybookLedger(false),
    );
    course.supportIncident = {
      ...course.supportIncident,
      id: "incident-reader-only",
      status: "AUTO_INVESTIGATING",
      activeBatchId: "batch-browser",
    } as typeof course.supportIncident;
    mockedPrisma.course.findMany.mockResolvedValue([course] as never);
    const fence = ownedBrowserPersistenceFence({
      courseId: course.id,
      incidentId: "incident-reader-only",
    });

    await expect(
      listBrowserProbeTargets(1, undefined, course.id, fence),
    ).resolves.toEqual([]);
  });

  it.each([
    [null, null],
    ["http://127.0.0.1/private", "http://127.0.0.1/private"],
  ])(
    "rejects an owned blocked-tooling target without a safe public probe URL",
    async (website, detectedBookingUrl) => {
      mockedPrisma.course.findMany.mockResolvedValue([
        blockedToolingBrowserProbeCourse("AUTH", {
          website,
          detectedBookingUrl,
        }),
      ] as never);
      mockedPrisma.courseMonitoringEvent.findFirst.mockResolvedValue(null);

      await expect(
        listBrowserProbeTargets(
          1,
          undefined,
          "course-blocked-tooling",
          ownedBrowserPersistenceFence(),
        ),
      ).resolves.toEqual([]);
    },
  );

  it("runs every exact target when blocked-tooling AUTH entries precede fetch-failed AUTH", async () => {
    const courseRows = Array.from({ length: 3 }, (_, index) => {
      const blocked = blockedToolingBrowserProbeCourse("AUTH");
      return {
        ...blocked,
        id: `mixed-course-${index + 1}`,
        supportIncident: {
          ...blocked.supportIncident,
          id: `mixed-incident-${index + 1}`,
          activeBatchId: "batch-1",
          ...(index === 2 ? { kind: "FETCH_FAILED" } : {}),
        },
      };
    });
    mockedPrisma.course.findMany.mockImplementation(async (query) => {
      const requestedId = query.where?.id;
      return courseRows.filter((course) => course.id === requestedId) as never;
    });
    const batch: CourseSupportBrowserStageBatch = {
      releaseSha: browserRuntimeVersion,
      deployedAt: browserDeployedAt,
      incidents: courseRows.map((course) => ({
        courseId: course.id,
        cycle: 1,
        result: "PENDING",
        incident: {
          id: course.supportIncident.id,
          cycle: 1,
          status: "AUTO_INVESTIGATING",
          activeBatchId: "batch-1",
          attemptLedger: course.supportIncident.attemptLedger,
        },
      })),
    };
    const runBrowserProbe = vi.fn(
      async (input: {
        courseId: string;
        persistenceFence: CourseSupportBrowserPersistenceFence;
      }) => {
        const targets = await listBrowserProbeTargets(
          1,
          undefined,
          input.courseId,
          input.persistenceFence,
        );
        expect(targets).toHaveLength(1);
        return { persistedCount: 1 };
      },
    );

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(
        {
          batchId: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "thread-1",
          requestedReleaseSha: browserRuntimeVersion,
          requestedDeployedAt: browserDeployedAt,
          now: new Date("2026-07-21T12:05:00.000Z"),
        },
        {
          loadBatch: vi.fn().mockResolvedValue(batch),
          runBrowserProbe,
        },
      ),
    ).resolves.toMatchObject({
      eligibleCount: 3,
      persistedCount: 3,
      renderedDiscoveryCount: 3,
    });
    expect(runBrowserProbe).toHaveBeenCalledTimes(3);
    expect(runBrowserProbe.mock.calls.map(([input]) => input.courseId)).toEqual(
      ["mixed-course-1", "mixed-course-2", "mixed-course-3"],
    );
  });

  it("loads an active check without historical matches or unused user fields", async () => {
    mockedPrisma.teeSearch.findFirst.mockResolvedValue(null);

    await getActiveSearchForAutomation("search-1");

    expect(mockedPrisma.teeSearch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          user: {
            select: {
              email: true,
            },
          },
          preferences: expect.any(Object),
        }),
      }),
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
      preferences: [{ course: { timeZone: "America/New_York" } }],
    };
    mockedPrisma.teeSearch.findFirst.mockResolvedValue(search as never);

    try {
      await expect(getActiveSearchForAutomation(search.id)).resolves.toBe(
        search,
      );
      expect(mockedPrisma.teeSearch.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            date: { gte: new Date("2026-07-20T00:00:00.000Z") },
          }),
        }),
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
      preferences: [{ course: { timeZone: "America/New_York" } }],
    } as never);

    try {
      await expect(
        getActiveSearchForAutomation("search-ended"),
      ).resolves.toBeNull();
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
            id: "search-1",
          },
        }),
        select: expect.objectContaining({
          id: true,
          course: {
            select: {
              id: true,
              name: true,
              address: true,
              timeZone: true,
            },
          },
        }),
      }),
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
          status: "ACTIVE",
        }),
        data: { recheckRequestedAt: expect.any(Date) },
      }),
    );
  });

  it("claims an expired lease with a fresh opaque token", async () => {
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);

    const lease = await claimScheduledSearchCheck("search-1", 4);

    expect(lease).toMatchObject({
      searchId: "search-1",
      scheduleVersion: 4,
      token: expect.any(String),
      expiresAt: expect.any(Date),
    });
    expect(lease?.token).not.toContain("search-1");
  });

  it("lets Workflow completion honor a future durable delivery retry", async () => {
    const retryAt = new Date("2026-07-15T15:01:00.000Z");
    mockedPrisma.$queryRaw.mockResolvedValue([
      { recheckRequested: true, nextCheckAt: retryAt },
    ] as never);

    await expect(
      completeScheduledSearchCheck({
        searchId: "search-1",
        scheduleVersion: 4,
        leaseToken: "lease-token",
        outcome: "email retry queued",
        nextCheckAt: new Date("2026-07-15T17:00:00.000Z"),
      }),
    ).resolves.toEqual({ recheckRequested: true, nextCheckAt: retryAt });
    const query = mockedPrisma.$queryRaw.mock.calls[0]?.[0] as {
      strings?: string[];
    };
    expect(query.strings?.join(" ")).toContain("GREATEST");
    expect(query.strings?.join(" ")).toContain('current."recheckRequestedAt"');
  });

  it("terminalizes an expired synthetic search and its pending matches", async () => {
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      callback(mockedPrisma as never),
    );
    deliveryOutboxMocks.lockSearchForAlertMutation.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE",
      checkLeaseToken: "lease-token",
    });
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({
      count: 2,
    } as never);

    await expect(
      completeExpiredSyntheticSearch({
        searchId: "search-1",
        scheduleVersion: 4,
        leaseToken: "lease-token",
        outcome: "synthetic multi-cycle test lifetime ended",
      }),
    ).resolves.toEqual({ completedAt: expect.any(Date) });

    expect(deliveryOutboxMocks.lockSearchForAlertMutation).toHaveBeenCalledWith(
      mockedPrisma,
      { searchId: "search-1" },
    );
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "search-1",
        scheduleVersion: 4,
        checkLeaseToken: "lease-token",
        status: "ACTIVE",
      },
      data: expect.objectContaining({
        status: "COMPLETED",
        scheduleVersion: { increment: 1 },
        alertGeneration: { increment: 1 },
        checkStatus: "STOPPED",
        nextCheckAt: null,
        workflowRunId: null,
        lastCheckOutcome: "synthetic multi-cycle test lifetime ended",
      }),
    });
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: "search-1",
        alertStatus: "PENDING",
      },
      data: {
        alertStatus: "SUPPRESSED",
        sentAt: null,
      },
    });
  });

  it("keeps the earliest durable delivery retry when a scheduled check fails", async () => {
    const retryAt = new Date("2026-07-15T15:01:00.000Z");
    mockedPrisma.$queryRaw.mockResolvedValue([
      { nextCheckAt: retryAt },
    ] as never);

    await expect(
      failScheduledSearchCheck({
        searchId: "search-1",
        scheduleVersion: 4,
        leaseToken: "lease-token",
        message: "email delivery failed",
        nextCheckAt: new Date("2026-07-15T15:05:00.000Z"),
      }),
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
        workflowRunId: "prior-run",
      },
      data: {
        workflowRunId: "run-1",
      },
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
          updatedAt: new Date(),
        }),
        updateMany: vi.fn(),
      },
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx),
    );

    await expect(
      queueSearchCheck("search-1", "dispatch-1"),
    ).resolves.toMatchObject({
      scheduleVersion: 9,
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
      updatedAt: new Date(),
    };
    const tx = {
      teeSearch: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce({ ...current, scheduleVersion: 9 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx),
    );

    await expect(
      queueSearchCheck("search-1", "dispatch-1"),
    ).resolves.toMatchObject({
      scheduleVersion: 9,
    });
    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          remediationDispatchKey: "dispatch-1",
          remediationDispatchVersion: 9,
          scheduleVersion: { increment: 1 },
        }),
      }),
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
              escalationDeadlineAt: new Date("2026-08-11T20:35:26.000Z"),
            },
          },
        },
      ],
      updatedAt: new Date("2026-08-11T20:34:30.000Z"),
    };
    const tx = {
      teeSearch: {
        findUnique: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx),
    );

    try {
      await expect(
        queueSearchCheck("search-1", "dispatch-before-deadline"),
      ).resolves.toMatchObject({
        scheduleVersion: 8,
        workflowRunId: "healthy-run",
        checkStatus: "WAITING",
      });
      expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            scheduleVersion: 8,
            workflowRunId: "healthy-run",
            checkStatus: "WAITING",
            nextCheckAt: new Date("2026-08-11T20:34:57.000Z"),
          }),
          data: {
            remediationDispatchKey: "dispatch-before-deadline",
            remediationDispatchVersion: 8,
          },
        }),
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
              escalationDeadlineAt: new Date("2026-08-11T20:35:26.000Z"),
            },
          },
        },
      ],
      updatedAt: new Date("2026-08-11T20:34:30.000Z"),
    };
    const queued = {
      ...current,
      scheduleVersion: 9,
      remediationDispatchKey: "dispatch-overdue-wake",
      remediationDispatchVersion: 9,
      workflowRunId: null,
      checkStatus: "QUEUED",
      nextCheckAt: new Date("2026-08-11T20:34:44.000Z"),
    };
    const tx = {
      teeSearch: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce(queued),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx),
    );

    try {
      await expect(
        queueSearchCheck("search-1", "dispatch-overdue-wake"),
      ).resolves.toMatchObject({
        scheduleVersion: 9,
        workflowRunId: null,
        checkStatus: "QUEUED",
      });
      expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scheduleVersion: { increment: 1 },
            workflowRunId: null,
            checkStatus: "QUEUED",
          }),
        }),
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
      updatedAt: observedAt,
    },
  ) {
    const tx = {
      teeSearch: {
        updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
        findUnique: vi.fn().mockResolvedValue(findResult),
      },
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (worker) =>
      (worker as (client: typeof tx) => Promise<unknown>)(tx),
    );
    return tx;
  }

  it("atomically queues the exact waiting version with no live lease", async () => {
    const tx = mockGuardedTransaction(1);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt,
      }),
    ).resolves.toMatchObject({
      status: "ACTIVE",
      scheduleVersion: 9,
      checkStatus: "QUEUED",
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
            { checkLeaseExpiresAt: { lte: observedAt } },
          ],
        },
        data: expect.objectContaining({
          scheduleVersion: { increment: 1 },
          checkStatus: "QUEUED",
        }),
      }),
    );
    expect(tx.teeSearch.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "search-1",
          status: "ACTIVE",
          scheduleVersion: 9,
          checkStatus: "QUEUED",
          workflowRunId: null,
        },
      }),
    );
  });

  it("rejects a row with a future lease without reading a newer state", async () => {
    const tx = mockGuardedTransaction(0);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt,
      }),
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
        recoveryDispatchKey: "endpoint-deadline:incident-1:2",
      }),
    ).resolves.toMatchObject({
      status: "ACTIVE",
      scheduleVersion: 9,
      checkStatus: "QUEUED",
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
            { checkLeaseExpiresAt: { lte: observedAt } },
          ],
        }),
        data: expect.objectContaining({
          remediationDispatchKey: "endpoint-deadline:incident-1:2",
          remediationDispatchVersion: 9,
        }),
      }),
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
        workflowRunId: "workflow-sleeping",
      }),
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkStatus: "QUEUED",
          workflowRunId: "workflow-sleeping",
        }),
      }),
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
          observedAt,
        }),
      ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

      expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ checkStatus: "WAITING" }),
        }),
      );
      expect(tx.teeSearch.findUnique).not.toHaveBeenCalled();
    },
  );

  it("rejects a schedule-version race without reading a newer state", async () => {
    const tx = mockGuardedTransaction(0);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt,
      }),
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scheduleVersion: 8 }),
      }),
    );
    expect(tx.teeSearch.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a WAITING state restored after an ABA transition", async () => {
    const tx = mockGuardedTransaction(0);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt,
      }),
    ).resolves.toEqual({ outcome: "not_eligible", reason: "state_changed" });

    expect(tx.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAt }),
      }),
    );
    expect(tx.teeSearch.findUnique).not.toHaveBeenCalled();
  });

  it("throws to roll back when the exact queued row cannot be read", async () => {
    const tx = mockGuardedTransaction(1, null);

    await expect(
      queueSearchCheck("search-1", undefined, {
        scheduleVersion: 8,
        updatedAt,
        observedAt,
      }),
    ).rejects.toThrow("Guarded search schedule changed after it was queued.");

    expect(tx.teeSearch.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scheduleVersion: 9,
          checkStatus: "QUEUED",
          workflowRunId: null,
        }),
      }),
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
        take: 50,
      }),
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
            date: { gte: new Date("2026-07-20T00:00:00.000Z") },
          }),
        }),
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
                updatedAt: { lte: new Date("2026-07-16T11:58:00.000Z") },
              },
              {
                checkStatus: "QUEUED",
                workflowRunId: { not: null },
                updatedAt: { lte: new Date("2026-07-16T11:50:00.000Z") },
              },
              {
                checkStatus: "WAITING",
                nextCheckAt: { lte: new Date("2026-07-16T11:50:00.000Z") },
              },
            ]),
          }),
          select: expect.objectContaining({
            id: true,
            scheduleVersion: true,
            checkStatus: true,
            workflowRunId: true,
          }),
        }),
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
                      {
                        checkLeaseExpiresAt: {
                          lte: new Date("2026-07-16T12:00:00.000Z"),
                        },
                      },
                    ],
                  },
                  {
                    OR: expect.arrayContaining([
                      {
                        matches: {
                          some: {
                            availabilityStatus: "AVAILABLE",
                            alertStatus: "PENDING",
                            firstSeenAt: {
                              lte: new Date("2026-07-16T11:50:00.000Z"),
                            },
                          },
                        },
                      },
                    ]),
                  },
                ],
              },
            ]),
          }),
        }),
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
                    createdAt: { lte: new Date("2026-07-16T11:55:00.000Z") },
                  },
                  {
                    checkStatus: { in: ["WAITING", "FAILED"] },
                    OR: [
                      { checkLeaseExpiresAt: null },
                      {
                        checkLeaseExpiresAt: {
                          lte: new Date("2026-07-16T12:00:00.000Z"),
                        },
                      },
                    ],
                  },
                ],
              },
            ]),
          }),
        }),
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
          candidate.where.OR.some((branch) => branch.checkStatus === "IDLE"),
      )?.[0];
      const recoveryBranches = query?.where?.OR ?? [];
      const deliveryBranch = recoveryBranches.find(
        (branch) => "AND" in branch && Array.isArray(branch.AND),
      );

      expect(deliveryBranch).toEqual(
        expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              checkStatus: { in: ["WAITING", "FAILED"] },
            }),
          ]),
        }),
      );
      expect(deliveryBranch?.AND).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkStatus: "CHECKING" }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks two cron intervals ahead for an imminent endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:23:01.000Z"));
    mockedPrisma.teeSearch.findMany.mockClear();
    mockedPrisma.teeSearch.findMany.mockResolvedValue([] as never);

    try {
      await listSearchesNeedingScheduleRecovery(
        new Date("2026-08-11T20:23:01.000Z"),
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
                            lte: new Date("2026-08-11T20:33:01.000Z"),
                          },
                        }),
                      },
                    },
                  },
                },
              },
            ]),
          }),
          take: 50,
        }),
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
              updatedAt: { lte: new Date("2026-08-11T20:21:00.000Z") },
            },
          ]),
        }),
      }),
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
              escalatedAt: null,
            },
          },
        },
      ],
    };
    mockedPrisma.teeSearch.findMany.mockClear();
    mockedPrisma.teeSearch.findMany
      .mockResolvedValueOnce([candidate] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        {
          ...candidate,
          remediationDispatchKey: "endpoint-deadline:incident-1:3",
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const first = await listSearchesNeedingScheduleRecovery(observedAt);
    const repeated = await listSearchesNeedingScheduleRecovery(observedAt);

    expect(first).toEqual([
      {
        ...candidate,
        endpointRecoveryDispatchKey: "endpoint-deadline:incident-1:3",
      },
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
              preferences: expect.any(Object),
            }),
          ]),
        }),
      }),
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
      updatedAt: observedAt,
    };
    mockedPrisma.teeSearch.findMany.mockClear();
    mockedPrisma.teeSearch.findMany
      .mockResolvedValueOnce([justEscalated] as never)
      .mockResolvedValueOnce([] as never);

    const recovered = await listSearchesNeedingScheduleRecovery(observedAt);

    expect(recovered).toEqual([justEscalated]);
    const criticalWhere =
      mockedPrisma.teeSearch.findMany.mock.calls[0]?.[0]?.where;
    expect(criticalWhere).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          {
            AND: [
              {
                checkStatus: { in: ["QUEUED", "WAITING"] },
              },
              {
                recheckRequestedAt: {
                  gte: new Date("2026-08-11T20:23:01.000Z"),
                },
              },
              {
                preferences: {
                  some: {
                    course: {
                      supportIncident: {
                        is: {
                          escalatedAt: {
                            gte: new Date("2026-08-11T20:23:01.000Z"),
                          },
                          escalationDeadlineAt: { lte: observedAt },
                          OR: [
                            {
                              status: "AUTO_INVESTIGATING",
                              humanReviewReason: "AUTOMATION_STALLED",
                            },
                            {
                              status: "NEEDS_HUMAN",
                              humanReviewReason: { not: null },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        ]),
      }),
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
      updatedAt: observedAt,
    };
    mockedPrisma.teeSearch.findMany.mockClear();
    mockedPrisma.teeSearch.findMany
      .mockResolvedValueOnce([justEscalated] as never)
      .mockResolvedValueOnce([] as never);

    const recovered = await listSearchesNeedingScheduleRecovery(observedAt);

    expect(recovered).toEqual([justEscalated]);
    const criticalWhere =
      mockedPrisma.teeSearch.findMany.mock.calls[0]?.[0]?.where;
    expect(criticalWhere?.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          AND: expect.arrayContaining([
            {
              checkStatus: { in: ["QUEUED", "WAITING"] },
            },
          ]),
        }),
      ]),
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
      threadId: "thread-hourly-1",
    },
    provenance: buildHourlyImprovementRunProvenance({
      ownerRunId: "run-hourly-1",
      ownerThreadId: "thread-hourly-1",
      branch: "automation/hourly-20260713-120000",
      startingSha: "0123456789abcdef0123456789abcdef01234567",
      plannedPaths: ["src/lib/automation/improvement.ts"],
    }),
    checkpoints: buildImprovementCheckpoints({
      queueConfirmed: true,
      candidateSelected: true,
      provenanceRecorded: true,
    }),
  };
}

describe("hourly improvement durable state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.automationRun.updateMany.mockResolvedValue({
      count: 1,
    } as never);
  });

  it("refuses to persist outcome_recorded before closeout", async () => {
    const record = buildHourlyRecord();
    record.checkpoints.outcome_recorded = true;

    await expect(
      updateHourlyImprovementRunState("run-hourly-1", record),
    ).rejects.toThrow("outcome_recorded may only become true");
    expect(mockedPrisma.automationRun.updateMany).not.toHaveBeenCalled();
  });

  it("sets completedAt, terminal outcome, and outcome_recorded atomically", async () => {
    await closeHourlyImprovementRun("run-hourly-1", {
      outcome: "success",
      record: buildHourlyRecord(),
      changedFiles: ["src/lib/automation/improvement.ts"],
    });

    expect(mockedPrisma.automationRun.updateMany).toHaveBeenCalledTimes(1);
    const update = mockedPrisma.automationRun.updateMany.mock.calls[0]?.[0];
    expect(update?.data).toMatchObject({
      completedAt: expect.any(Date),
      outcome: "success",
      changedFiles: ["src/lib/automation/improvement.ts"],
    });
    expect(JSON.parse(String(update?.data.notes))).toMatchObject({
      lifecycle: "closeout",
      checkpoints: { outcome_recorded: true },
    });
  });
});

describe("recordTeeTimeMatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    mockedPrisma.teeTimeMatch.upsert.mockResolvedValue({
      id: "match-1",
    } as never);
    deliveryOutboxMocks.reactivateTerminalUnresolvedMatchDeliveries.mockResolvedValue(
      { count: 0 },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-alert a tee time that briefly disappears and returns", async () => {
    mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue({
      availabilityStatus: "GONE",
      unavailableAt: new Date("2026-07-10T11:45:00.000Z"),
      availabilityCycle: 0,
    } as never);

    await recordTeeTimeMatch({
      searchId: "search-1",
      alertGeneration: 3,
      courseId: "course-1",
      sourceId: "slot-1",
      startsAt: new Date("2026-07-11T12:00:00.000Z"),
      availableSpots: 4,
      bookingUrl: "https://example.com/book",
    });

    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({ alertStatus: "PENDING" }),
      }),
    );
    expect(
      deliveryOutboxMocks.reactivateTerminalUnresolvedMatchDeliveries,
    ).not.toHaveBeenCalled();
  });

  it("re-alerts a tee time that returns after being absent for 30 minutes", async () => {
    mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue({
      availabilityStatus: "GONE",
      unavailableAt: new Date("2026-07-10T11:30:00.000Z"),
      availabilityCycle: 3,
    } as never);

    await recordTeeTimeMatch({
      searchId: "search-1",
      alertGeneration: 3,
      courseId: "course-1",
      sourceId: "slot-1",
      startsAt: new Date("2026-07-11T12:00:00.000Z"),
      availableSpots: 4,
      bookingUrl: "https://example.com/book",
    });

    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          alertStatus: "PENDING",
          sentAt: null,
          availabilityCycle: { increment: 1 },
        }),
      }),
    );
    expect(
      deliveryOutboxMocks.reactivateTerminalUnresolvedMatchDeliveries,
    ).not.toHaveBeenCalled();
  });
});

describe("commitCurrentCourseTeeTimeMatches", () => {
  const providerObservedAt = new Date("2026-07-10T12:00:00.000Z");
  const providerObservation = {
    courseId: "course-1",
    leaseToken: "provider-observation-token",
    observationStartedAt: providerObservedAt,
    leaseExpiresAt: new Date("2026-07-10T12:05:00.000Z"),
    ttlMs: 5 * 60_000,
    supersededUnresolvedObservationStartedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma),
    );
    mockedPrisma.$queryRawUnsafe.mockResolvedValue([] as never);
    mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue(null);
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([]);
    mockedPrisma.teeTimeMatch.upsert.mockResolvedValue({
      id: "match-1",
      alertStatus: "PENDING",
    } as never);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({
      count: 0,
    } as never);
    mockedPrisma.courseBookingFact.findUnique.mockResolvedValue(null);
    deliveryOutboxMocks.lockSearchForEmailReconciliation.mockResolvedValue({
      id: "search-1",
    });
    deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches.mockResolvedValue(
      {
        count: 0,
      },
    );
    deliveryOutboxMocks.reactivateTerminalUnresolvedMatchDeliveries.mockResolvedValue(
      { count: 0 },
    );
  });

  const commit = (
    overrides: Partial<
      Parameters<typeof commitCurrentCourseTeeTimeMatches>[0]
    > = {},
  ) =>
    commitCurrentCourseTeeTimeMatches({
      searchId: "search-1",
      alertGeneration: 0,
      checkLeaseToken: "check-lease",
      courseId: "course-1",
      date: "2026-07-11",
      timeZone: "America/New_York",
      providerObservedAt,
      sourceKind: "SUCCESS",
      matches: [
        {
          sourceId: "slot-1",
          startsAt: new Date("2026-07-11T12:00:00.000Z"),
          availableSpots: 4,
          bookingUrl: "https://example.com/book",
        },
      ],
      ...overrides,
    });

  it("commits matches while the accepted provider source still owns monitoring", async () => {
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "HEALTHY",
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: new Date("2026-07-10T11:59:00.000Z"),
    } as never);

    await expect(commit()).resolves.toMatchObject({
      sourceEvidenceAccepted: true,
      persistedMatchStates: [{ matchId: "match-1", isPending: true }],
    });
    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastSeenAt: providerObservedAt,
          lastConfirmedAt: providerObservedAt,
        }),
      }),
    );
  });

  it.each(["FINAL_MANUAL", "FINAL_TECHNICAL", "FINAL_IDENTITY"] as const)(
    "rejects a late canonical match commit after the course reaches %s",
    async (state) => {
      mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
        state,
        lastSuccessfulAt: providerObservedAt,
        lastFailureAt: null,
      } as never);

      await expect(commit()).resolves.toEqual({
        sourceEvidenceAccepted: false,
        persistedMatchStates: [],
      });
      expect(mockedPrisma.teeTimeMatch.upsert).not.toHaveBeenCalled();
      expect(
        deliveryOutboxMocks.lockSearchForEmailReconciliation,
      ).not.toHaveBeenCalled();
    },
  );

  it("atomically consumes the exact local-reader source with its canonical match commit", async () => {
    const completedAt = new Date("2026-07-10T12:01:00.000Z");
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: null,
    } as never);
    mockedPrisma.$queryRaw.mockResolvedValue([{ id: "search-1" }] as never);
    mockedPrisma.localReaderJob.findUnique.mockResolvedValue({
      id: "reader-job-1",
      teeSearchId: "search-1",
      courseId: "course-1",
      scheduleVersion: 1,
      status: "COMPLETED",
      claimedAt: providerObservedAt,
      completedAt,
      resultExpiresAt: new Date("2026-07-10T12:11:00.000Z"),
      result: {
        jobId: "reader-job-1",
        courseKey: "cps:grassyhill.cps.golf",
        status: "AVAILABLE",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: providerObservedAt.toISOString(),
        pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
        pageTitle: "Grassy Hill Country Club",
        slots: [
          {
            startsAtLocal: "2026-07-11T08:00:00",
            timeLabel: "8:00 AM",
            holes: [18],
            minimumPlayers: 1,
            availableSpots: 4,
            priceCents: 7000,
            cartIncluded: true,
          },
        ],
        readerVersion: "reader-v1",
      },
    } as never);
    mockedPrisma.localReaderJob.updateMany.mockResolvedValue({
      count: 1,
    } as never);

    await expect(
      commit({
        localReaderObservation: {
          jobId: "reader-job-1",
          scheduleVersion: 1,
          resultStatus: "AVAILABLE",
          monitoringOutcome: "MATCH_FOUND",
        },
      }),
    ).resolves.toMatchObject({ sourceEvidenceAccepted: true });

    expect(mockedPrisma.localReaderJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "reader-job-1",
        teeSearchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 1,
        claimedAt: providerObservedAt,
        completedAt,
      }),
      data: { resultExpiresAt: completedAt },
    });
    expect(
      mockedPrisma.teeTimeMatch.upsert.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedPrisma.localReaderJob.updateMany.mock.invocationCallOrder[0],
    );
  });

  it("resumes an equal local-reader source only from its exact accepted monitoring event", async () => {
    const completedAt = new Date("2026-07-10T12:01:00.000Z");
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: null,
    } as never);
    mockedPrisma.courseMonitoringEvent.findMany.mockResolvedValue([
      {
        audit: {
          localReaderCanonicalSource: {
            jobId: "reader-job-resume",
            searchId: "search-1",
            scheduleVersion: 1,
            resultStatus: "NO_AVAILABILITY",
            providerObservedAt: providerObservedAt.toISOString(),
          },
        },
      },
    ] as never);
    mockedPrisma.$queryRaw.mockResolvedValue([{ id: "search-1" }] as never);
    mockedPrisma.localReaderJob.findUnique.mockResolvedValue({
      id: "reader-job-resume",
      teeSearchId: "search-1",
      courseId: "course-1",
      scheduleVersion: 1,
      status: "COMPLETED",
      claimedAt: providerObservedAt,
      completedAt,
      // Expiry is operational; an unconsumed exact accepted source remains
      // resumable after its delivery window closes.
      resultExpiresAt: new Date("2026-07-10T12:02:00.000Z"),
      result: {
        jobId: "reader-job-resume",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: providerObservedAt.toISOString(),
        pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
        pageTitle: "Grassy Hill Country Club",
        slots: [],
        readerVersion: "reader-v1",
      },
    } as never);
    mockedPrisma.localReaderJob.updateMany.mockResolvedValue({
      count: 1,
    } as never);

    await expect(
      commit({
        reconcileMatches: false,
        matches: [],
        localReaderObservation: {
          jobId: "reader-job-resume",
          scheduleVersion: 1,
          resultStatus: "NO_AVAILABILITY",
          monitoringOutcome: "NO_MATCH",
          resumePreviouslyAcceptedSource: true,
        },
      }),
    ).resolves.toEqual({
      sourceEvidenceAccepted: true,
      persistedMatchStates: [],
    });
    expect(mockedPrisma.localReaderJob.updateMany).toHaveBeenCalledOnce();
  });

  it("rejects equal-source resume when the accepted event belongs to another reader job", async () => {
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: null,
    } as never);
    mockedPrisma.courseMonitoringEvent.findMany.mockResolvedValue([
      {
        audit: {
          localReaderCanonicalSource: {
            jobId: "reader-job-other",
            searchId: "search-1",
            scheduleVersion: 1,
            resultStatus: "NO_AVAILABILITY",
            providerObservedAt: providerObservedAt.toISOString(),
          },
        },
      },
    ] as never);

    await expect(
      commit({
        reconcileMatches: false,
        matches: [],
        localReaderObservation: {
          jobId: "reader-job-resume",
          scheduleVersion: 1,
          resultStatus: "NO_AVAILABILITY",
          monitoringOutcome: "NO_MATCH",
          resumePreviouslyAcceptedSource: true,
        },
      }),
    ).resolves.toEqual({
      sourceEvidenceAccepted: false,
      persistedMatchStates: [],
    });
    expect(mockedPrisma.teeTimeMatch.upsert).not.toHaveBeenCalled();
    expect(mockedPrisma.localReaderJob.updateMany).not.toHaveBeenCalled();
  });

  it("rejects all customer writes when provider observation ownership is lost", async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([] as never);
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: null,
    } as never);

    await expect(commit({ providerObservation })).rejects.toThrow(
      "Provider observation ownership expired",
    );

    expect(
      mockedPrisma.courseMonitoringStatus.findUnique,
    ).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.upsert).not.toHaveBeenCalled();
    expect(
      deliveryOutboxMocks.reactivateTerminalUnresolvedMatchDeliveries,
    ).not.toHaveBeenCalled();
    expect(mockedPrisma.providerRequestLease.deleteMany).not.toHaveBeenCalled();
  });

  it("releases provider observation ownership atomically after accepted match writes", async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([
      { leaseExpiresAt: new Date("2026-07-10T12:10:00.000Z") },
    ] as never);
    mockedPrisma.providerRequestLease.deleteMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: null,
    } as never);

    await expect(commit({ providerObservation })).resolves.toMatchObject({
      sourceEvidenceAccepted: true,
    });

    expect(mockedPrisma.providerRequestLease.deleteMany).toHaveBeenCalledWith({
      where: {
        providerFamilyKey: expect.any(String),
        slot: 0,
        leaseToken: "provider-observation-token",
      },
    });
    expect(
      mockedPrisma.teeTimeMatch.upsert.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedPrisma.providerRequestLease.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it("reactivates cycle 7 obligations when a strictly newer canonical reconfirmation follows terminal unresolved suppression", async () => {
    const t1 = new Date("2026-07-10T11:40:00.000Z");
    const t2 = new Date("2026-07-10T11:50:00.000Z");
    expect(t1 < t2 && t2 < providerObservedAt).toBe(true);
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: null,
    } as never);
    mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue({
      id: "match-1",
      alertStatus: "PENDING",
      availabilityStatus: "AVAILABLE",
      unavailableAt: null,
      availabilityCycle: 7,
      lastConfirmedAt: t1,
    } as never);
    deliveryOutboxMocks.reactivateTerminalUnresolvedMatchDeliveries.mockResolvedValue(
      { count: 1 },
    );

    await expect(commit()).resolves.toMatchObject({
      sourceEvidenceAccepted: true,
    });

    expect(
      deliveryOutboxMocks.reactivateTerminalUnresolvedMatchDeliveries,
    ).toHaveBeenCalledWith(prisma, {
      searchId: "search-1",
      alertGeneration: 0,
      matchId: "match-1",
      availabilityCycle: 7,
      retryAt: providerObservedAt,
    });
    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastConfirmedAt: providerObservedAt,
        }),
      }),
    );
    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({
          availabilityCycle: { increment: 1 },
        }),
      }),
    );
  });

  it.each([
    ["equal", providerObservedAt],
    ["older", new Date("2026-07-10T12:01:00.000Z")],
  ])(
    "does not reactivate cycle 7 for an %s canonical reconfirmation",
    async (_label, lastConfirmedAt) => {
      mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
        lastSuccessfulAt: providerObservedAt,
        lastFailureAt: null,
      } as never);
      mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue({
        id: "match-1",
        alertStatus: "PENDING",
        availabilityStatus: "AVAILABLE",
        unavailableAt: null,
        availabilityCycle: 7,
        lastConfirmedAt,
      } as never);
      await expect(commit()).resolves.toMatchObject({
        sourceEvidenceAccepted: true,
      });

      expect(
        deliveryOutboxMocks.reactivateTerminalUnresolvedMatchDeliveries,
      ).not.toHaveBeenCalled();
      expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.not.objectContaining({
            availabilityCycle: { increment: 1 },
          }),
        }),
      );
    },
  );

  it("keeps the cycle stable when a newer confirmation finds no exact terminal unresolved obligation", async () => {
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: null,
    } as never);
    mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue({
      id: "match-1",
      alertStatus: "PENDING",
      availabilityStatus: "AVAILABLE",
      unavailableAt: null,
      availabilityCycle: 7,
      lastConfirmedAt: new Date("2026-07-10T11:40:00.000Z"),
    } as never);
    await expect(commit()).resolves.toMatchObject({
      sourceEvidenceAccepted: true,
    });

    expect(
      deliveryOutboxMocks.reactivateTerminalUnresolvedMatchDeliveries,
    ).toHaveBeenCalledOnce();
    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({
          availabilityCycle: { increment: 1 },
        }),
      }),
    );
  });

  it("rejects customer mutations when a newer provider source wins the lock", async () => {
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: new Date("2026-07-10T12:01:00.000Z"),
    } as never);

    await expect(commit()).resolves.toEqual({
      sourceEvidenceAccepted: false,
      persistedMatchStates: [],
    });
    expect(mockedPrisma.teeTimeMatch.upsert).not.toHaveBeenCalled();
    expect(
      deliveryOutboxMocks.lockSearchForEmailReconciliation,
    ).not.toHaveBeenCalled();
  });

  it("commits booking-window and pricing facts with matches under the exact source fence", async () => {
    const currentCourse = {
      id: "course-1",
      timeZone: "America/New_York",
      bookingWindowDaysAhead: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      bookingWindowEvidenceUrl: null,
      bookingWindowCheckedAt: null,
      bookingWindowObservedAt: null,
      updatedAt: new Date("2026-07-10T11:00:00.000Z"),
    };
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: null,
    } as never);
    mockedPrisma.course.findUnique.mockResolvedValue(currentCourse as never);
    mockedPrisma.course.update.mockResolvedValue({
      ...currentCourse,
      bookingWindowDaysAhead: 14,
      bookingWindowCheckedAt: providerObservedAt,
      bookingWindowObservedAt: providerObservedAt,
      updatedAt: providerObservedAt,
    } as never);
    mockedPrisma.courseBookingFact.upsert.mockResolvedValue({
      courseId: "course-1",
      holes: 18,
    } as never);

    await expect(
      commitCurrentCourseTeeTimeMatches({
        searchId: "search-1",
        alertGeneration: 0,
        checkLeaseToken: "check-lease",
        courseId: "course-1",
        date: "2026-07-11",
        timeZone: "America/New_York",
        providerObservedAt,
        sourceKind: "SUCCESS",
        bookingWindowEvidence: {
          daysAhead: 14,
          releaseTimeLocal: null,
          source: "PROVIDER_CONFIG",
          confidence: 1,
          evidenceUrl: "https://example.com/book",
        },
        pricing: {
          currency: "USD",
          observedAt: providerObservedAt.toISOString(),
          eighteenHoles: {
            minPriceCents: 6000,
            maxPriceCents: 7000,
            sampleSize: 2,
          },
        },
        bookableHoleCounts: [18],
        reconcileMatches: false,
        matches: [],
      }),
    ).resolves.toEqual({
      sourceEvidenceAccepted: true,
      persistedMatchStates: [],
    });

    expect(mockedPrisma.course.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingWindowDaysAhead: 14,
          bookingWindowObservedAt: providerObservedAt,
        }),
      }),
    );
    expect(mockedPrisma.courseBookingFact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          minPriceCents: 6000,
          bookableObservedAt: providerObservedAt,
        }),
      }),
    );
  });

  it("rejects booking metadata before any write when a newer source wins", async () => {
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      lastSuccessfulAt: providerObservedAt,
      lastFailureAt: new Date("2026-07-10T12:01:00.000Z"),
    } as never);

    await expect(
      commitCurrentCourseTeeTimeMatches({
        searchId: "search-1",
        alertGeneration: 0,
        checkLeaseToken: "check-lease",
        courseId: "course-1",
        date: "2026-07-11",
        timeZone: "America/New_York",
        providerObservedAt,
        sourceKind: "SUCCESS",
        bookingWindowEvidence: {
          daysAhead: 14,
          releaseTimeLocal: null,
          source: "PROVIDER_CONFIG",
          confidence: 1,
          evidenceUrl: "https://example.com/book",
        },
        pricing: {
          currency: "USD",
          observedAt: providerObservedAt.toISOString(),
          eighteenHoles: {
            minPriceCents: 6000,
            maxPriceCents: 7000,
            sampleSize: 2,
          },
        },
        bookableHoleCounts: [18],
        reconcileMatches: false,
        matches: [],
      }),
    ).resolves.toEqual({
      sourceEvidenceAccepted: false,
      persistedMatchStates: [],
    });

    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(mockedPrisma.courseBookingFact.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.courseBookingFact.upsert).not.toHaveBeenCalled();
  });

  it("rejects matches attached to a failed provider observation", async () => {
    await expect(
      commitCurrentCourseTeeTimeMatches({
        searchId: "search-1",
        alertGeneration: 0,
        checkLeaseToken: "check-lease",
        courseId: "course-1",
        date: "2026-07-11",
        timeZone: "America/New_York",
        providerObservedAt,
        sourceKind: "FAILURE",
        matches: [
          {
            sourceId: "slot-unsafe-response",
            startsAt: new Date("2026-07-11T12:00:00.000Z"),
            availableSpots: 4,
            bookingUrl: "https://example.com/book",
          },
        ],
      }),
    ).rejects.toThrow("Failed provider observations cannot");

    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.upsert).not.toHaveBeenCalled();
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
      markMatchAlertSent({ matchId: "match-1", availabilityCycle: 0 }),
    ).resolves.toBeNull();
    await expect(
      markMatchAlertSent({ matchId: "match-1", availabilityCycle: 1 }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "match-1",
        availabilityCycle: 1,
        alertStatus: "SENT",
      }),
    );

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: "match-1",
          availabilityCycle: 0,
          alertStatus: "PENDING",
        },
      }),
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: "match-1",
          availabilityCycle: 1,
          alertStatus: "PENDING",
        },
      }),
    );
  });

  it("suppresses only the exact pending availability cycle", async () => {
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({
      count: 1,
    } as never);

    await expect(
      markMatchAlertSuppressed({ matchId: "match-1", availabilityCycle: 4 }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "match-1",
        availabilityCycle: 4,
        alertStatus: "SUPPRESSED",
      }),
    );

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "match-1",
        availabilityCycle: 4,
        alertStatus: "PENDING",
      },
      data: {
        alertStatus: "SUPPRESSED",
        sentAt: expect.any(Date),
      },
    });
  });
});

describe("markMissingMatchesUnavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma),
    );
    mockedPrisma.teeTimeMatch.findMany.mockResolvedValue([
      { id: "match-1", availabilityCycle: 3 },
    ] as never);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    deliveryOutboxMocks.lockSearchForEmailReconciliation.mockResolvedValue({
      id: "search-1",
    });
    deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches.mockResolvedValue(
      {
        count: 1,
      },
    );
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
          startsAt: new Date("2026-07-11T12:00:00.000Z"),
        },
      ],
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertStatus: "PENDING",
          startsAt: {
            gte: new Date("2026-07-11T04:00:00.000Z"),
            lt: new Date("2026-07-12T04:00:00.000Z"),
          },
          NOT: [
            {
              sourceId: "foreup-6654-2026-07-11 08:00",
              startsAt: new Date("2026-07-11T12:00:00.000Z"),
            },
          ],
        }),
        data: expect.objectContaining({
          alertStatus: "SUPPRESSED",
          availabilityStatus: "GONE",
        }),
      }),
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertStatus: { not: "PENDING" },
        }),
        data: expect.not.objectContaining({
          alertStatus: expect.anything(),
        }),
      }),
    );
    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
    expect(
      deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        searchId: "search-1",
        matchRefs: [{ matchId: "match-1", availabilityCycle: 3 }],
        transaction: prisma,
      }),
    );
  });

  it("does not reconcile availability after the generation or check lease becomes stale", async () => {
    deliveryOutboxMocks.lockSearchForEmailReconciliation.mockResolvedValue(
      null,
    );

    await expect(
      markMissingMatchesUnavailable({
        searchId: "search-1",
        alertGeneration: 2,
        checkLeaseToken: "stale-check-lease",
        courseId: "course-1",
        date: "2026-07-11",
        timeZone: "America/New_York",
        confirmedMatches: [],
      }),
    ).rejects.toThrow(
      "Search check is no longer current during availability reconciliation",
    );

    expect(mockedPrisma.teeTimeMatch.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect(
      deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches,
    ).not.toHaveBeenCalled();
  });
});

describe("recordCourseProbeIfChanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.courseProbe.create.mockResolvedValue({
      id: "new-probe",
    } as never);
  });

  it("does not write the same Fairview policy block every five minutes", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation.",
      runtimeVersion: "local",
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation.",
    });

    expect(mockedPrisma.courseProbe.create).not.toHaveBeenCalled();
  });

  it("records a transition from adapter work to a policy block", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "NEEDS_ADAPTER",
      message: "No supported adapter yet for UNKNOWN",
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation.",
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
  });

  it("records unchanged evidence once for a newly deployed runtime", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "old-runtime-probe",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "old-release",
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "new-release",
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ runtimeVersion: "new-release" }),
      }),
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
      observedAtOrAfter: generationStartedAt,
    });

    expect(mockedPrisma.courseProbe.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          teeSearchId: "search-1",
          courseId: "fairview-farm",
          observedAt: { gte: generationStartedAt },
        },
      }),
    );
    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
  });

  it("records a changed policy reason", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "BLOCKED_POLICY",
      message: "Older policy reason",
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation.",
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
  });

  it("reuses evidence for the same local-reader observation", async () => {
    const providerObservedAt = "2026-08-11T20:00:00.000Z";
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "same-release",
      rawSummary: {
        providerExecution: "LOCAL_BROWSER_READER",
        providerObservedAt,
      },
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "same-release",
      rawSummary: {
        providerExecution: "LOCAL_BROWSER_READER",
        providerObservedAt,
      },
    });

    expect(mockedPrisma.courseProbe.create).not.toHaveBeenCalled();
  });

  it("records a new local-reader observation with an unchanged outcome", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "same-release",
      rawSummary: {
        providerExecution: "LOCAL_BROWSER_READER",
        providerObservedAt: "2026-08-11T20:00:00.000Z",
      },
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "same-release",
      rawSummary: {
        providerExecution: "LOCAL_BROWSER_READER",
        providerObservedAt: "2026-08-11T20:05:00.000Z",
      },
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
  });

  it("records every runnable provider check even when its outcome is unchanged", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "same-release",
      rawSummary: { providerExecution: "RUNNABLE_PROVIDER_CHECK" },
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "NO_MATCH",
      message: "No qualifying tee times in the requested window",
      runtimeVersion: "same-release",
      rawSummary: { providerExecution: "RUNNABLE_PROVIDER_CHECK" },
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
  });

  it("classifies legacy automation runs without relying on free-form notes", () => {
    expect(classifyAutomationRunKind("hourly-improvement-v2")).toBe(
      "IMPROVEMENT",
    );
    expect(classifyAutomationRunKind("tee-time-spot-local-codex-loop-v1")).toBe(
      "IMPROVEMENT",
    );
    expect(classifyAutomationRunKind("course-support-v3")).toBe(
      "COURSE_SUPPORT",
    );
    expect(classifyAutomationRunKind("search-check-v2")).toBe("SEARCH_CHECK");
    expect(classifyAutomationRunKind("browser-probe-v1")).toBe("BROWSER_PROBE");
    expect(classifyAutomationRunKind("legacy")).toBe("OTHER");
  });

  it("copies parseable object notes into structured audit data", () => {
    expect(parseAutomationRunAudit('{"phase":"inspect","count":2}')).toEqual({
      phase: "inspect",
      count: 2,
    });
    expect(parseAutomationRunAudit("not json")).toBeNull();
    expect(parseAutomationRunAudit("[1,2]")).toBeNull();
  });
});

describe("booking-window evidence monitoring revalidation", () => {
  const observedAt = new Date("2026-08-18T14:00:00.000Z");
  const currentCourse = {
    id: "course-window",
    name: "Window Golf Course",
    timeZone: "America/New_York",
    website: "https://example.com",
    detectedBookingUrl: "https://example.com/book",
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "SOURCE_MISSING",
    bookingMethod: "PUBLIC_ONLINE",
    bookingWindowDaysAhead: 7,
    bookingWindowEvidenceUrl: "https://example.com/old-window",
    bookingReleaseTimeLocal: "07:00",
    bookingWindowSource: "OFFICIAL_BOOKING_PAGE",
    bookingWindowConfidence: 0.8,
    bookingWindowCheckedAt: new Date("2026-08-01T12:00:00.000Z"),
    bookingWindowObservedAt: new Date("2026-08-01T12:00:00.000Z"),
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "OTHER",
    monitoringMode: "AUTOMATIC",
    bookingAccessMode: "UNKNOWN",
    isPublic: true,
    intelligenceConfidence: null,
    bookingMetadata: null,
    updatedAt: new Date("2026-08-01T12:00:00.000Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma),
    );
  });

  it("wakes parked monitoring when booking-window semantics change", async () => {
    const appliedCourse = {
      ...currentCourse,
      bookingWindowDaysAhead: 14,
      bookingWindowEvidenceUrl: "https://example.com/new-window",
      bookingReleaseTimeLocal: "06:30",
      bookingWindowConfidence: 1,
      bookingWindowCheckedAt: observedAt,
      bookingWindowObservedAt: observedAt,
      updatedAt: observedAt,
    };
    mockedPrisma.course.findUnique.mockResolvedValue(currentCourse as never);
    mockedPrisma.course.update.mockResolvedValue(appliedCourse as never);
    mockedPrisma.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-parked",
      cycle: 3,
      revision: 8,
      status: "NEEDS_HUMAN",
      activeBatchId: null,
      activeRealSearchCount: 2,
      kind: "FETCH_FAILED",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "HTTP",
      failureFingerprint: "parked-fingerprint",
      humanReviewReason: "AUTOMATION_STALLED",
      resolution: null,
      activeBatch: null,
    } as never);
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "NEEDS_HUMAN",
      revision: 5,
    } as never);
    mockedPrisma.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 2 } as never);

    await recordCourseBookingWindowEvidence({
      courseId: currentCourse.id,
      evidence: {
        daysAhead: 14,
        releaseTimeLocal: "06:30",
        source: "OFFICIAL_BOOKING_PAGE",
        confidence: 1,
        evidenceUrl: "https://example.com/new-window",
      },
      observedAt,
    });

    expect(mockedPrisma.course.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: currentCourse.id, updatedAt: currentCourse.updatedAt },
      }),
    );
    expect(mockedPrisma.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-parked",
          cycle: 3,
          revision: 8,
          status: "NEEDS_HUMAN",
          activeBatchId: null,
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          nextAttemptAt: observedAt,
        }),
      }),
    );
    expect(mockedPrisma.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: observedAt,
          revalidationRequestedAt: observedAt,
        }),
      }),
    );
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          nextCheckAt: observedAt,
          recheckRequestedAt: observedAt,
        },
      }),
    );
  });

  it("does not wake parked monitoring for an observation timestamp refresh", async () => {
    const appliedCourse = {
      ...currentCourse,
      bookingWindowCheckedAt: observedAt,
      bookingWindowObservedAt: observedAt,
      updatedAt: observedAt,
    };
    mockedPrisma.course.findUnique.mockResolvedValue(currentCourse as never);
    mockedPrisma.course.update.mockResolvedValue(appliedCourse as never);

    await recordCourseBookingWindowEvidence({
      courseId: currentCourse.id,
      evidence: {
        daysAhead: currentCourse.bookingWindowDaysAhead,
        releaseTimeLocal: currentCourse.bookingReleaseTimeLocal,
        source: currentCourse.bookingWindowSource as "OFFICIAL_BOOKING_PAGE",
        confidence: currentCourse.bookingWindowConfidence,
        evidenceUrl: currentCourse.bookingWindowEvidenceUrl,
      },
      observedAt,
    });

    expect(
      mockedPrisma.courseSupportIncident.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      mockedPrisma.courseMonitoringStatus.findUnique,
    ).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("serializes a checked-at-only write in the monitoring writer lane", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue(currentCourse as never);
    mockedPrisma.course.update.mockResolvedValue({
      ...currentCourse,
      bookingWindowCheckedAt: observedAt,
    } as never);

    await markCourseBookingWindowChecked(currentCourse.id, observedAt);

    expect(mockedPrisma.course.update).toHaveBeenCalledWith({
      where: { id: currentCourse.id, updatedAt: currentCourse.updatedAt },
      data: { bookingWindowCheckedAt: observedAt },
    });
    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
    expect(
      mockedPrisma.courseSupportIncident.findUnique,
    ).not.toHaveBeenCalled();
  });
});

describe("physical-layout evidence persistence", () => {
  const operationTime = new Date("2026-08-18T15:00:00.000Z");
  const verifiedAt = new Date("2026-08-17T00:00:00.000Z");
  const currentCourse = {
    id: "aguila",
    name: "Aguila Golf Course",
    timeZone: "America/Phoenix",
    website: "https://parks.example/aguila-golf-course.html",
    detectedBookingUrl: null,
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "SOURCE_MISSING",
    bookingMethod: "UNKNOWN",
    bookingWindowDaysAhead: null,
    bookingWindowEvidenceUrl: null,
    bookingReleaseTimeLocal: null,
    bookingWindowSource: null,
    bookingWindowConfidence: null,
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "OTHER",
    monitoringMode: "AUTOMATIC",
    bookingAccessMode: "UNKNOWN",
    isPublic: true,
    intelligenceConfidence: null,
    bookingMetadata: null,
    layoutHoleCounts: [],
    layoutHolesEvidenceUrl: null,
    layoutHolesVerifiedAt: null,
    updatedAt: new Date("2026-08-18T14:00:00.000Z"),
  };
  const providerObservation = {
    courseId: currentCourse.id,
    leaseToken: "physical-layout-observation",
    observationStartedAt: operationTime,
    leaseExpiresAt: new Date("2026-08-18T15:20:00.000Z"),
    ttlMs: 20 * 60_000,
    supersededUnresolvedObservationStartedAt: null,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(operationTime);
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma),
    );
    mockedPrisma.$queryRaw.mockResolvedValue([
      { leaseExpiresAt: new Date("2026-08-18T15:20:00.000Z") },
    ] as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes the CAS update and revalidates at operation time", async () => {
    const appliedCourse = {
      ...currentCourse,
      layoutHoleCounts: [18],
      layoutHolesEvidenceUrl: "https://parks.example/aguila-golf-course.html",
      layoutHolesVerifiedAt: verifiedAt,
      updatedAt: operationTime,
    };
    mockedPrisma.course.findUnique.mockResolvedValue(currentCourse as never);
    mockedPrisma.course.update.mockResolvedValue(appliedCourse as never);
    mockedPrisma.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-aguila",
      cycle: 2,
      revision: 4,
      status: "NEEDS_HUMAN",
      activeBatchId: null,
      activeRealSearchCount: 1,
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "missing-source",
      humanReviewReason: "AUTOMATION_STALLED",
      resolution: null,
      activeBatch: null,
    } as never);
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "NEEDS_HUMAN",
      revision: 3,
    } as never);
    mockedPrisma.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await recordCoursePhysicalLayoutEvidence({
      courseId: currentCourse.id,
      holeCounts: [18],
      evidenceUrl: "https://parks.example/aguila-golf-course.html",
      verifiedAt,
      expectedUpdatedAt: currentCourse.updatedAt,
      expectedName: currentCourse.name,
      providerObservation,
      source: "OPERATOR_CLI",
    });

    expect(result).toBe(appliedCourse);
    expect(mockedPrisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "ReadCommitted" }),
    );
    expect(mockedPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      `course-monitoring:${currentCourse.id}`,
    );
    expect(mockedPrisma.course.update).toHaveBeenCalledWith({
      where: {
        id: currentCourse.id,
        updatedAt: currentCourse.updatedAt,
        name: currentCourse.name,
      },
      data: {
        layoutHoleCounts: [18],
        layoutHolesEvidenceUrl: "https://parks.example/aguila-golf-course.html",
        layoutHolesVerifiedAt: verifiedAt,
      },
    });
    expect(mockedPrisma.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextAttemptAt: operationTime }),
      }),
    );
    expect(mockedPrisma.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          occurredAt: operationTime,
          audit: expect.objectContaining({
            changedFields: expect.arrayContaining([
              "layoutHoleCounts",
              "layoutHolesVerifiedAt",
            ]),
          }),
        }),
      }),
    );
  });

  it("does not continue after an updatedAt CAS write failure", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue(currentCourse as never);
    mockedPrisma.course.update.mockRejectedValue(
      new Error("Record to update not found"),
    );

    await expect(
      recordCoursePhysicalLayoutEvidence({
        courseId: currentCourse.id,
        holeCounts: [18],
        evidenceUrl: "https://parks.example/aguila-golf-course.html",
        verifiedAt,
        expectedUpdatedAt: currentCourse.updatedAt,
        expectedName: currentCourse.name,
        providerObservation,
        source: "OPERATOR_CLI",
      }),
    ).rejects.toThrow("Record to update not found");
    expect(
      mockedPrisma.courseSupportIncident.findUnique,
    ).not.toHaveBeenCalled();
    expect(mockedPrisma.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("does not write when the provider observation cannot be renewed under the course lock", async () => {
    mockedPrisma.$queryRaw.mockResolvedValueOnce([] as never);

    await expect(
      recordCoursePhysicalLayoutEvidence({
        courseId: currentCourse.id,
        holeCounts: [18],
        evidenceUrl: "https://parks.example/aguila-golf-course.html",
        verifiedAt,
        expectedUpdatedAt: currentCourse.updatedAt,
        expectedName: currentCourse.name,
        providerObservation,
        source: "OPERATOR_CLI",
      }),
    ).rejects.toThrow(
      "Provider observation ownership expired before physical-layout evidence could be persisted",
    );

    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(
      mockedPrisma.courseSupportIncident.findUnique,
    ).not.toHaveBeenCalled();
    expect(mockedPrisma.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a stale pre-fetch course identity or updatedAt snapshot", async () => {
    const write = () =>
      recordCoursePhysicalLayoutEvidence({
        courseId: currentCourse.id,
        holeCounts: [18],
        evidenceUrl: "https://parks.example/aguila-golf-course.html",
        verifiedAt,
        expectedUpdatedAt: currentCourse.updatedAt,
        expectedName: currentCourse.name,
        providerObservation,
        source: "OPERATOR_CLI",
      });
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      ...currentCourse,
      updatedAt: new Date("2026-08-18T14:30:00.000Z"),
    } as never);

    await expect(write()).rejects.toThrow(
      "Course identity or layout changed while physical-layout evidence was being verified",
    );

    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      ...currentCourse,
      name: "Aguila 9 Golf Course",
    } as never);
    await expect(write()).rejects.toThrow(
      "Course identity or layout changed while physical-layout evidence was being verified",
    );
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(
      mockedPrisma.courseSupportIncident.findUnique,
    ).not.toHaveBeenCalled();
    expect(mockedPrisma.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a future verification date at the persistence boundary", async () => {
    await expect(
      recordCoursePhysicalLayoutEvidence({
        courseId: currentCourse.id,
        holeCounts: [18],
        evidenceUrl: "https://parks.example/aguila-golf-course.html",
        verifiedAt: new Date("2026-08-19T00:00:00.000Z"),
        expectedUpdatedAt: currentCourse.updatedAt,
        expectedName: currentCourse.name,
        providerObservation,
        source: "OPERATOR_CLI",
      }),
    ).rejects.toThrow("valid non-future verification date");
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
  });

  it("rejects account and transaction evidence URLs at the persistence boundary", async () => {
    await expect(
      recordCoursePhysicalLayoutEvidence({
        courseId: currentCourse.id,
        holeCounts: [18],
        evidenceUrl: "https://booking.example/sign-in?returnTo=checkout",
        verifiedAt,
        expectedUpdatedAt: currentCourse.updatedAt,
        expectedName: currentCourse.name,
        providerObservation,
        source: "OPERATOR_CLI",
      }),
    ).rejects.toThrow(
      "Physical layout evidence URL must be a credential-free public HTTP(S) URL",
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
  });
});

describe("course automation discovery parent fencing", () => {
  const fencedCourseUpdatedAt = new Date("2026-08-31T00:00:00.001Z");
  const discovery = {
    courseId: "course-discovery-fence",
    status: "INSPECTED" as const,
    detectedPlatform: "UNKNOWN",
    sourceUrl: "https://course.example/tee-times",
    bookingUrl: null,
    confidence: 0.75,
    evidence: {
      learnedFrom: "rendered-browser",
      observedUrls: ["https://course.example/tee-times"],
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.$transaction
      .mockReset()
      .mockImplementation(async (worker) => worker(mockedPrisma as never));
    mockedPrisma.$queryRaw
      .mockReset()
      .mockResolvedValue([{ updatedAt: fencedCourseUpdatedAt }] as never);
    mockedPrisma.$queryRawUnsafe.mockReset().mockResolvedValue([] as never);
    mockedPrisma.courseAutomationDiscovery.create
      .mockReset()
      .mockResolvedValue({
        id: "discovery-fenced",
      } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 0 } as never);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({
      count: 0,
    } as never);
  });

  it("serializes the ordinary writer and touches its parent before appending", async () => {
    await expect(recordBrowserDiscovery(discovery)).resolves.toEqual({
      id: "discovery-fenced",
    });

    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
    expect(mockedPrisma.$queryRaw).toHaveBeenCalledOnce();
    const [parentFence] = mockedPrisma.$queryRaw.mock.calls[0] as [
      { strings: readonly string[]; values: unknown[] },
    ];
    const parentFenceSql = parentFence.strings.join("");
    expect(parentFenceSql).toContain('UPDATE "Course"');
    expect(parentFenceSql).toContain("GREATEST(");
    expect(parentFenceSql).toContain("INTERVAL '1 millisecond'");
    expect(parentFenceSql).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
    expect(parentFenceSql).toContain('RETURNING "updatedAt"');
    expect(parentFence.values).toEqual([discovery.courseId]);
    expect(mockedPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPrisma.courseAutomationDiscovery.create.mock.invocationCallOrder[0],
    );
  });

  it("persists a caller-provided provider source time instead of receipt time", async () => {
    const providerObservedAt = new Date("2026-08-30T23:57:00.000Z");

    await expect(
      recordBrowserDiscovery(
        discovery,
        undefined,
        undefined,
        undefined,
        providerObservedAt,
      ),
    ).resolves.toEqual({ id: "discovery-fenced" });

    expect(mockedPrisma.courseAutomationDiscovery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        courseId: discovery.courseId,
        createdAt: providerObservedAt,
      }),
    });
  });

  it("touches the parent after an expected-unowned reservation and before appending", async () => {
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.courseMonitoringEvent.findFirst.mockResolvedValue(null);

    await expect(
      recordBrowserDiscovery(discovery, undefined, undefined, {
        id: "incident-discovery-fence",
        cycle: 2,
        revision: 4,
        status: "AUTO_INVESTIGATING",
      }),
    ).resolves.toEqual({ id: "discovery-fenced" });

    expect(
      mockedPrisma.courseSupportIncident.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedPrisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(mockedPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPrisma.courseAutomationDiscovery.create.mock.invocationCallOrder[0],
    );
  });

  it("touches the parent after validating an owned persistence fence", async () => {
    const fence = ownedBrowserPersistenceFence({
      incidentId: "incident-discovery-fence",
      courseId: discovery.courseId,
    });
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.courseSupportBatch.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.courseSupportBatchIncident.findUnique.mockResolvedValue({
      courseId: discovery.courseId,
      cycle: fence.cycle,
      result: "PENDING",
    } as never);
    mockedPrisma.courseSupportIncident.findUnique.mockResolvedValue({
      cycle: fence.cycle,
      attemptLedger: browserPlaybookLedger(false),
    } as never);
    mockedPrisma.courseMonitoringEvent.findFirst.mockResolvedValue(null);

    await expect(
      recordBrowserDiscovery(discovery, fence, browserRuntimeVersion),
    ).resolves.toEqual({ id: "discovery-fenced" });

    expect(mockedPrisma.courseSupportBatch.updateMany).toHaveBeenCalledOnce();
    expect(mockedPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPrisma.courseAutomationDiscovery.create.mock.invocationCallOrder[0],
    );
  });

  it("touches the parent after persisting a recovered official site and before appending", async () => {
    const expectedUpdatedAt = new Date("2026-08-19T11:00:00.000Z");
    const observedAt = new Date("2026-08-19T11:01:00.000Z");
    const current = {
      id: discovery.courseId,
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN",
      automationEligibility: "UNKNOWN",
      automationReason: "NONE",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceConfidence: null,
      bookingMetadata: null,
      monitoringStatus: null,
      supportIncident: null,
      updatedAt: expectedUpdatedAt,
    };
    const applied = {
      ...current,
      website: "https://course.example/golf",
      updatedAt: new Date("2026-08-19T11:01:01.000Z"),
    };
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce(current as never)
      .mockResolvedValueOnce(applied as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await expect(
      applyRecoveredOfficialWebsiteToCourse({
        courseId: current.id,
        website: applied.website,
        expectedUpdatedAt,
        observedAt,
      }),
    ).resolves.toEqual({ ...applied, updatedAt: fencedCourseUpdatedAt });

    expect(
      mockedPrisma.course.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedPrisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(mockedPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPrisma.courseAutomationDiscovery.create.mock.invocationCallOrder[0],
    );
  });

  it("applies and appends ordinary discovery atomically before returning the parent fence timestamp", async () => {
    const expectedUpdatedAt = new Date("2026-08-19T11:30:00.000Z");
    const observedAt = new Date("2026-08-19T11:31:00.000Z");
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes";
    const bookingMetadata = {
      scheduleId: 6123,
      bookingBaseUrl: bookingUrl,
    };
    const current = {
      id: discovery.courseId,
      name: "Discovery Fence Golf Course",
      timeZone: "America/New_York",
      website: "https://course.example/golf",
      detectedBookingUrl: bookingUrl,
      detectedPlatform: "FOREUP",
      providerFamilyKey: "FOREUP",
      bookingMethod: "UNKNOWN",
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
      monitoringStatus: null,
      supportIncident: null,
      updatedAt: expectedUpdatedAt,
    };
    const applied = {
      ...current,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      bookingMetadata,
      intelligenceVerifiedAt: observedAt,
      intelligenceConfidence: 0.95,
      updatedAt: observedAt,
    };
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce(current as never)
      .mockResolvedValueOnce(applied as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await expect(
      recordAndApplyBrowserDiscoveryToCourse(
        {
          ...discovery,
          status: "LEARNED",
          detectedPlatform: "FOREUP",
          sourceUrl: current.website,
          bookingUrl,
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
          apiMetadata: bookingMetadata,
          confidence: 0.95,
        },
        {
          updatedAt: expectedUpdatedAt,
          detectedBookingUrl: bookingUrl,
          bookingMethod: "UNKNOWN",
          automationEligibility: "NEEDS_REVIEW",
        },
        undefined,
        { observedAt },
      ),
    ).resolves.toEqual({
      applied: { ...applied, updatedAt: fencedCourseUpdatedAt },
      discovery: { id: "discovery-fenced" },
    });

    expect(
      mockedPrisma.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      mockedPrisma.course.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedPrisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(mockedPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPrisma.courseAutomationDiscovery.create.mock.invocationCallOrder[0],
    );
    const [parentFence] = mockedPrisma.$queryRaw.mock.calls[0] as [
      { values: unknown[] },
    ];
    expect(parentFence.values).toEqual([current.id]);
  });

  it("touches the parent when appending evidence without changing an operator-final projection", async () => {
    const observedAt = new Date("2026-08-19T12:00:00.000Z");
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    } as never);
    mockedPrisma.courseMonitoringEvent.findFirst.mockResolvedValue(null);
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "SOURCE_MISSING",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: null,
      website: "https://course.example/golf",
      bookingMetadata: null,
      isPublic: true,
      bookingMethod: "PHONE_ONLY",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      bookingAccessMode: "PHONE_ONLY",
      intelligenceVerifiedAt: observedAt,
      intelligenceReviewAt: null,
      intelligenceConfidence: 1,
      monitoringStatus: { state: "FINAL_MANUAL" },
      supportIncident: { resolution: "DIRECT_BOOKING_CLASSIFIED" },
      updatedAt: observedAt,
    } as never);

    await expect(
      recordAndApplyBrowserDiscoveryToCourse(
        {
          ...discovery,
          status: "LEARNED",
          detectedPlatform: "FOREUP",
          bookingUrl:
            "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
          apiMetadata: {
            scheduleId: 6123,
            bookingBaseUrl:
              "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
          },
          confidence: 0.95,
        },
        {
          updatedAt: observedAt,
          detectedBookingUrl: null,
          bookingMethod: "PHONE_ONLY",
          automationEligibility: "BLOCKED",
        },
        {
          id: "incident-discovery-fence",
          cycle: 2,
          revision: 6,
          status: "RESOLVED",
        },
        { observedAt },
      ),
    ).resolves.toEqual({
      applied: null,
      discovery: { id: "discovery-fenced" },
    });

    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPrisma.courseAutomationDiscovery.create.mock.invocationCallOrder[0],
    );
  });

  it("fails clearly without retrying or appending when the parent course is missing", async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([] as never);

    await expect(recordBrowserDiscovery(discovery)).rejects.toThrow(
      "Course automation discovery parent course no longer exists.",
    );

    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
    expect(mockedPrisma.$queryRaw).toHaveBeenCalledOnce();
    expect(
      mockedPrisma.courseAutomationDiscovery.create,
    ).not.toHaveBeenCalled();
  });
});
