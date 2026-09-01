import { describe, expect, it, vi } from "vitest";

import {
  buildCourseSupportSearchExecutionFenceSnapshot,
  canAdvanceCourseSupportSearchExecutionFence,
  COURSE_SUPPORT_SEARCH_EXECUTION_PROBE_READ_LIMIT,
  CourseSupportSearchExecutionFenceRetryError,
  courseSupportSearchExecutionFenceMatches,
  getCourseSupportSearchExecutionMayHaveStartedCourseRefs,
  loadCourseSupportSearchExecutionFence,
  lockCourseSupportSearchExecutionFenceRows,
  persistCourseSupportSearchExecutionFence,
  readPersistedCourseSupportSearchExecutionFence,
  type CourseSupportSearchExecutionFenceDispatch,
} from "./course-support-search-execution-fence";

const dispatchedAt = new Date("2026-08-20T14:00:00.000Z");
const completedAt = new Date("2026-08-20T14:01:00.000Z");
const now = new Date("2026-08-20T14:02:00.000Z");

function dispatch(
  overrides: Partial<CourseSupportSearchExecutionFenceDispatch> = {},
): CourseSupportSearchExecutionFenceDispatch {
  return {
    id: "batch-search-1",
    teeSearchId: "search-1",
    searchRef: "a".repeat(64),
    scheduleVersion: 7,
    removedAt: null,
    removalReason: null,
    teeSearch: {
      id: "search-1",
      status: "ACTIVE",
      trafficClass: "PUBLIC",
      scheduleVersion: 7,
      alertGeneration: 3,
      workflowRunId: "workflow-1",
      checkStatus: "WAITING",
      checkLeaseToken: null,
      checkLeaseExpiresAt: null,
      recheckRequestedAt: null,
      remediationDispatchKey: "dispatch-1",
      remediationDispatchVersion: 7,
      nextCheckAt: new Date("2026-08-20T14:15:00.000Z"),
      lastCheckedAt: completedAt,
      lastCheckOutcome: "no new matches",
      updatedAt: completedAt,
      preferences: [
        {
          id: "preference-2",
          teeSearchId: "search-1",
          courseId: "course-2",
          rank: 2,
        },
        {
          id: "preference-1",
          teeSearchId: "search-1",
          courseId: "course-1",
          rank: 1,
        },
      ],
      probes: [
        {
          id: "probe-2",
          teeSearchId: "search-1",
          courseId: "course-2",
          automationRunId: "run-1",
          outcome: "NO_MATCH",
          observedAt: completedAt,
          message: null,
          evidenceUrl: null,
          rawSummary: {
            providerExecution: "RUNNABLE_PROVIDER_CHECK",
            providerObservedAt: completedAt.toISOString(),
          },
          runtimeVersion: "wrong-runtime",
        },
        {
          id: "probe-1",
          teeSearchId: "search-1",
          courseId: "course-1",
          automationRunId: "run-1",
          outcome: "FETCH_FAILED",
          observedAt: new Date("2026-08-20T14:00:30.000Z"),
          message: "Provider request failed.",
          evidenceUrl: null,
          rawSummary: {
            providerExecution: "RUNNABLE_PROVIDER_CHECK",
            providerObservedAt: "2026-08-20T14:00:30.000Z",
          },
          runtimeVersion: null,
        },
      ],
    },
    ...overrides,
  };
}

function snapshot(
  dispatches: CourseSupportSearchExecutionFenceDispatch[] = [dispatch()],
) {
  return buildCourseSupportSearchExecutionFenceSnapshot({
    courseIds: ["course-2", "course-1"],
    expectedSearches: [{ searchRef: "a".repeat(64), scheduleVersion: 7 }],
    recheckDispatchKey: "dispatch-1",
    recheckDispatchStartedAt: dispatchedAt,
    recheckDispatchedAt: dispatchedAt,
    now,
    dispatches,
  });
}

describe("course-support search execution fence", () => {
  it("bounds post-dispatch probe reads and fails closed on overflow", async () => {
    const row = dispatch();
    row.teeSearch!.probes = Array.from(
      { length: COURSE_SUPPORT_SEARCH_EXECUTION_PROBE_READ_LIMIT + 1 },
      (_, index) => ({
        ...row.teeSearch!.probes[0],
        id: `overflow-probe-${index + 1}`,
      }),
    );
    const findMany = vi.fn().mockResolvedValue([row]);

    await expect(
      loadCourseSupportSearchExecutionFence(
        { courseSupportBatchSearch: { findMany } } as never,
        {
          batchId: "batch-1",
          courseIds: ["course-1", "course-2"],
          expectedSearches: [
            { searchRef: "a".repeat(64), scheduleVersion: 7 },
          ],
          recheckDispatchKey: "dispatch-1",
          recheckDispatchStartedAt: dispatchedAt,
          recheckDispatchedAt: dispatchedAt,
          now,
        },
      ),
    ).rejects.toBeInstanceOf(CourseSupportSearchExecutionFenceRetryError);

    expect(
      findMany.mock.calls[0]?.[0]?.select?.teeSearch?.select?.probes?.take,
    ).toBe(COURSE_SUPPORT_SEARCH_EXECUTION_PROBE_READ_LIMIT + 1);
  });

  it("is canonical across row, preference, and probe ordering", () => {
    const first = dispatch();
    const second = dispatch({
      id: "batch-search-2",
      teeSearchId: null,
      searchRef: "b".repeat(64),
      scheduleVersion: 8,
      removedAt: completedAt,
      removalReason: "SEARCH_DELETED_BY_OWNER",
      teeSearch: null,
    });
    const ordered = buildCourseSupportSearchExecutionFenceSnapshot({
      courseIds: ["course-1", "course-2"],
      expectedSearches: [
        { searchRef: "a".repeat(64), scheduleVersion: 7 },
        { searchRef: "b".repeat(64), scheduleVersion: 8 },
      ],
      recheckDispatchKey: "dispatch-1",
      recheckDispatchStartedAt: dispatchedAt,
      recheckDispatchedAt: dispatchedAt,
      now,
      dispatches: [first, second],
    });
    const reversedFirst = dispatch({
      teeSearch: {
        ...first.teeSearch!,
        preferences: [...first.teeSearch!.preferences].reverse(),
        probes: [...first.teeSearch!.probes].reverse(),
      },
    });
    const reversed = buildCourseSupportSearchExecutionFenceSnapshot({
      courseIds: ["course-2", "course-1"],
      expectedSearches: [
        { searchRef: "b".repeat(64), scheduleVersion: 8 },
        { searchRef: "a".repeat(64), scheduleVersion: 7 },
      ],
      recheckDispatchKey: "dispatch-1",
      recheckDispatchStartedAt: dispatchedAt,
      recheckDispatchedAt: dispatchedAt,
      now,
      dispatches: [second, reversedFirst],
    });

    expect(reversed.digest).toBe(ordered.digest);
    expect(reversed.memberships).toEqual(ordered.memberships);
  });

  it("counts every post-dispatch provider execution attempt without runtime or outcome promotion", () => {
    const result = snapshot();

    expect(result.settled).toBe(true);
    expect(result.providerExecutionAttemptCourseIds).toEqual([
      "course-1",
      "course-2",
    ]);
    expect(result.providerExecutionAttemptCourseRefs).toHaveLength(2);
  });

  it("does not count execution observed after a failed attempt but before successful dispatch", () => {
    const successfulDispatchAt = new Date("2026-08-20T14:00:45.000Z");
    const row = dispatch();
    row.teeSearch!.probes = [
      {
        ...row.teeSearch!.probes[0],
        id: "probe-between-dispatch-attempts",
        courseId: "course-1",
        observedAt: new Date("2026-08-20T14:00:30.000Z"),
        rawSummary: {
          providerExecution: "LOCAL_BROWSER_READER",
          providerObservedAt: "2026-08-20T14:00:30.000Z",
        },
      },
    ];

    const result = buildCourseSupportSearchExecutionFenceSnapshot({
      courseIds: ["course-1"],
      expectedSearches: [{ searchRef: "a".repeat(64), scheduleVersion: 7 }],
      recheckDispatchKey: "dispatch-1",
      recheckDispatchStartedAt: dispatchedAt,
      recheckDispatchedAt: successfulDispatchAt,
      now,
      dispatches: [row],
    });

    expect(result.settled).toBe(true);
    expect(result.providerExecutionAttemptCourseIds).toEqual([]);
    expect(result.providerExecutionAttemptCourseRefs).toEqual([]);
    expect(result.probeEvidenceRefs).toEqual([]);
  });

  it("counts the exact local-reader marker and rejects lookalike markers", () => {
    const candidate = dispatch();
    candidate.teeSearch!.probes = [
      {
        ...candidate.teeSearch!.probes[0],
        id: "probe-local-reader",
        courseId: "course-1",
        rawSummary: {
          providerExecution: "LOCAL_BROWSER_READER",
          providerObservedAt: "2026-08-20T14:00:30.000Z",
        },
      },
      {
        ...candidate.teeSearch!.probes[1],
        id: "probe-lookalike",
        courseId: "course-2",
        rawSummary: { providerExecution: "LOCAL_BROWSER_READER_V2" },
      },
    ];

    const result = snapshot([candidate]);

    expect(result.providerExecutionAttemptCourseIds).toEqual(["course-1"]);
    expect(result.providerExecutionAttemptCourseRefs).toHaveLength(1);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "2026-08-20T14:00:30Z"],
    ["pre-dispatch", "2026-08-20T13:59:59.999Z"],
    ["later than its probe", "2026-08-20T14:01:00.001Z"],
  ])(
    "rejects a local-reader marker whose source timestamp is %s",
    (_label, providerObservedAt) => {
      const candidate = dispatch();
      candidate.teeSearch!.probes = [
        {
          ...candidate.teeSearch!.probes[0],
          id: "probe-local-reader",
          courseId: "course-1",
          observedAt: new Date("2026-08-20T14:01:00.000Z"),
          rawSummary: {
            providerExecution: "LOCAL_BROWSER_READER",
            ...(providerObservedAt ? { providerObservedAt } : {}),
          },
        },
      ];

      expect(snapshot([candidate]).providerExecutionAttemptCourseIds).toEqual(
        [],
      );
    },
  );

  it("fences the complete related-search membership beyond the incident courses", () => {
    const initial = snapshot();
    const changed = dispatch();
    changed.teeSearch!.preferences.push({
      id: "preference-3",
      teeSearchId: "search-1",
      courseId: "course-outside-batch",
      rank: 3,
    });

    const changedSnapshot = snapshot([changed]);
    expect(changedSnapshot.digest).not.toBe(initial.digest);
    expect(changedSnapshot.searchStateDigest).not.toBe(
      initial.searchStateDigest,
    );
    const persisted = persistCourseSupportSearchExecutionFence(initial, now);
    expect(
      getCourseSupportSearchExecutionMayHaveStartedCourseRefs(
        persisted,
        changedSnapshot,
      ),
    ).toEqual(changedSnapshot.memberships[0]?.courseRefs);
  });

  it.each([
    {
      label: "queued",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.checkStatus = "QUEUED";
      },
      reason: "SEARCH_CHECK_UNSETTLED",
    },
    {
      label: "checking",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.checkStatus = "CHECKING";
      },
      reason: "SEARCH_CHECK_UNSETTLED",
    },
    {
      label: "failed",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.checkStatus = "FAILED";
      },
      reason: "SEARCH_CHECK_UNSETTLED",
    },
    {
      label: "active lease",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.checkLeaseExpiresAt = new Date(
          "2026-08-20T14:03:00.000Z",
        );
      },
      reason: "SEARCH_LEASE_ACTIVE",
    },
    {
      label: "stale check",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.lastCheckedAt = new Date("2026-08-20T13:59:59.000Z");
      },
      reason: "SEARCH_CHECK_STALE",
    },
  ])("fails closed for $label", ({ mutate, reason }) => {
    const row = dispatch();
    mutate(row);

    expect(snapshot([row])).toMatchObject({
      settled: false,
      reasons: expect.arrayContaining([reason]),
    });
  });

  it("treats dispatch intent without durable completion as unsettled even with no rows", () => {
    const result = buildCourseSupportSearchExecutionFenceSnapshot({
      courseIds: ["course-1"],
      expectedSearches: [],
      recheckDispatchKey: "dispatch-before-batch-search-upsert",
      recheckDispatchStartedAt: dispatchedAt,
      recheckDispatchedAt: null,
      now,
      dispatches: [],
    });

    expect(result).toMatchObject({
      settled: false,
      reasons: expect.arrayContaining(["DISPATCH_NOT_COMPLETE"]),
    });

    const partialResult = buildCourseSupportSearchExecutionFenceSnapshot({
      courseIds: ["course-1", "course-2"],
      expectedSearches: [{ searchRef: "a".repeat(64), scheduleVersion: 7 }],
      recheckDispatchKey: "dispatch-before-batch-search-upsert",
      recheckDispatchStartedAt: dispatchedAt,
      recheckDispatchedAt: null,
      now,
      dispatches: [dispatch()],
    });
    expect(partialResult).toMatchObject({
      settled: false,
      reasons: expect.arrayContaining(["DISPATCH_NOT_COMPLETE"]),
    });
  });

  it("keeps exact-generation settled zero evidence eligible", () => {
    const row = dispatch();
    row.teeSearch!.probes = [];

    const result = snapshot([row]);

    expect(result.settled).toBe(true);
    expect(result.searchExecutionMayHaveStartedCourseRefs).toEqual([]);
    expect(result.providerExecutionAttemptCourseRefs).toEqual([]);
  });

  it.each([
    {
      label: "key",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.remediationDispatchKey = "second-active-batch-dispatch";
      },
    },
    {
      label: "version",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.remediationDispatchVersion = 8;
      },
    },
  ])(
    "settles exact-generation remediation $label replacement as operationally unknown",
    ({ mutate }) => {
      const row = dispatch();
      mutate(row);
      row.teeSearch!.probes = [];

      const result = snapshot([row]);

      expect(result.settled).toBe(true);
      expect(result.reasons).not.toContain("SEARCH_REMEDIATION_CHANGED");
      expect(result.searchExecutionMayHaveStartedCourseRefs).toHaveLength(2);
      expect(result.providerExecutionAttemptCourseRefs).toEqual([]);
    },
  );

  it.each([
    {
      label: "an active check",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.checkStatus = "CHECKING";
      },
    },
    {
      label: "a missing workflow",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.workflowRunId = null;
      },
    },
    {
      label: "a search lease",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.checkLeaseToken = "lease";
      },
    },
    {
      label: "a pending recheck",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.recheckRequestedAt = completedAt;
      },
    },
    {
      label: "a stale completion",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.lastCheckedAt = new Date(dispatchedAt.getTime() - 1);
      },
    },
  ])(
    "keeps remediation ownership replacement unsettled with $label",
    ({ mutate }) => {
      const row = dispatch();
      row.teeSearch!.remediationDispatchKey = "second-active-batch-dispatch";
      row.teeSearch!.probes = [];
      mutate(row);

      expect(snapshot([row])).toMatchObject({
        settled: false,
        reasons: expect.arrayContaining(["SEARCH_REMEDIATION_CHANGED"]),
      });
    },
  );

  it("keeps the first exact post-dispatch zero-probe snapshot zero eligible", () => {
    const preDispatch = buildCourseSupportSearchExecutionFenceSnapshot({
      courseIds: ["course-1", "course-2"],
      expectedSearches: [],
      recheckDispatchKey: null,
      recheckDispatchStartedAt: null,
      recheckDispatchedAt: null,
      now,
      dispatches: [],
    });
    const row = dispatch();
    row.teeSearch!.probes = [];
    const postDispatch = snapshot([row]);

    expect(
      getCourseSupportSearchExecutionMayHaveStartedCourseRefs(
        persistCourseSupportSearchExecutionFence(preDispatch, dispatchedAt),
        postDispatch,
      ),
    ).toEqual([]);
  });

  it.each(["WAITING", "STOPPED"])(
    "settles a post-run superseding ACTIVE generation in %s as operationally unknown",
    (checkStatus) => {
      const row = dispatch();
      row.teeSearch!.scheduleVersion = 8;
      row.teeSearch!.checkStatus = checkStatus;
      if (checkStatus === "STOPPED") row.teeSearch!.workflowRunId = null;
      row.teeSearch!.probes = [];

      const result = snapshot([row]);

      expect(result.settled).toBe(true);
      expect(result.searchExecutionMayHaveStartedCourseRefs).toHaveLength(2);
    },
  );

  it.each([
    {
      label: "queued",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.checkStatus = "QUEUED";
      },
      reason: "SEARCH_CHECK_UNSETTLED",
    },
    {
      label: "waiting without workflow",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.workflowRunId = null;
      },
      reason: "SEARCH_WORKFLOW_MISSING",
    },
    {
      label: "lease",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.checkLeaseToken = "lease";
      },
      reason: "SEARCH_LEASE_ACTIVE",
    },
    {
      label: "recheck",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.recheckRequestedAt = completedAt;
      },
      reason: "SEARCH_RECHECK_PENDING",
    },
    {
      label: "stale completion",
      mutate: (row: CourseSupportSearchExecutionFenceDispatch) => {
        row.teeSearch!.lastCheckedAt = new Date(dispatchedAt.getTime() - 1);
      },
      reason: "SEARCH_CHECK_STALE",
    },
  ])(
    "keeps a superseding ACTIVE generation unsettled for $label",
    ({ mutate, reason }) => {
      const row = dispatch();
      row.teeSearch!.scheduleVersion = 8;
      row.teeSearch!.probes = [];
      mutate(row);

      expect(snapshot([row])).toMatchObject({
        settled: false,
        reasons: expect.arrayContaining([reason]),
      });
    },
  );

  it.each(["PAUSED", "CANCELLED", "COMPLETED"])(
    "settles a fresh inactive %s generation as operationally unknown",
    (status) => {
      const row = dispatch();
      row.teeSearch!.status = status;
      row.teeSearch!.scheduleVersion = 8;
      row.teeSearch!.checkStatus = "STOPPED";
      row.teeSearch!.workflowRunId = null;
      row.teeSearch!.probes = [];

      const result = snapshot([row]);

      expect(result.settled).toBe(true);
      expect(result.searchExecutionMayHaveStartedCourseRefs).toHaveLength(2);
    },
  );

  it("keeps an inactive search unsettled until the status change is post-dispatch", () => {
    const row = dispatch();
    row.teeSearch!.status = "PAUSED";
    row.teeSearch!.scheduleVersion = 8;
    row.teeSearch!.updatedAt = new Date(dispatchedAt.getTime() - 1);

    expect(snapshot([row])).toMatchObject({
      settled: false,
      reasons: expect.arrayContaining(["SEARCH_STATUS_CHANGED"]),
    });
  });

  it("settles a verified deletion and an empty preference membership as operationally unknown", () => {
    const deleted = dispatch({
      teeSearchId: null,
      removedAt: completedAt,
      removalReason: "SEARCH_DELETED_BY_OWNER",
      teeSearch: null,
    });
    const deletedResult = snapshot([deleted]);
    expect(deletedResult.settled).toBe(true);
    expect(deletedResult.deletedSearchRefs).toEqual(["a".repeat(64)]);
    expect(deletedResult.searchExecutionMayHaveStartedCourseRefs).toHaveLength(
      2,
    );

    const empty = dispatch();
    empty.teeSearch!.preferences = [];
    empty.teeSearch!.probes = [];
    const emptyResult = snapshot([empty]);
    expect(emptyResult.settled).toBe(true);
    expect(emptyResult.searchExecutionMayHaveStartedCourseRefs).toHaveLength(2);
  });

  it("adopts monotonic provider and non-provider probes without allowing disappearance", () => {
    const initialRow = dispatch();
    initialRow.teeSearch!.probes = [];
    const initial = snapshot([initialRow]);
    const persisted = persistCourseSupportSearchExecutionFence(initial, now);
    expect(readPersistedCourseSupportSearchExecutionFence(persisted)).toEqual(
      persisted,
    );
    expect(
      readPersistedCourseSupportSearchExecutionFence({
        ...persisted,
        searchExecutionMayHaveStartedCourseRefs: ["course-1"],
      }),
    ).toBeNull();
    expect(courseSupportSearchExecutionFenceMatches(persisted, initial)).toBe(
      true,
    );

    const changed = dispatch();
    changed.teeSearch!.probes = [
      {
        ...dispatch().teeSearch!.probes[0],
        id: "late-non-provider-probe",
        courseId: "course-1",
        observedAt: new Date("2026-08-20T14:01:30.000Z"),
        rawSummary: { providerExecution: false },
      },
    ];
    const changedSnapshot = snapshot([changed]);
    expect(
      courseSupportSearchExecutionFenceMatches(persisted, changedSnapshot),
    ).toBe(false);
    expect(
      canAdvanceCourseSupportSearchExecutionFence(persisted, changedSnapshot),
    ).toBe(true);
    expect(
      getCourseSupportSearchExecutionMayHaveStartedCourseRefs(
        persisted,
        changedSnapshot,
      ),
    ).toContain(changedSnapshot.probeEvidenceBySearch[0]?.probes[0]?.courseRef);

    const disappeared = persistCourseSupportSearchExecutionFence(
      changedSnapshot,
      now,
    );
    expect(
      canAdvanceCourseSupportSearchExecutionFence(disappeared, initial),
    ).toBe(false);

    const deleted = snapshot([
      dispatch({
        teeSearchId: null,
        removedAt: completedAt,
        removalReason: "SEARCH_DELETED_BY_OWNER",
        teeSearch: null,
      }),
    ]);
    expect(
      canAdvanceCourseSupportSearchExecutionFence(disappeared, deleted),
    ).toBe(true);
  });

  it("locks search execution rows in a stable parent-to-child order", async () => {
    const queries: string[] = [];
    const transaction = {
      $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) => {
        const sql = query.strings?.join(" ") ?? "";
        queries.push(sql);
        return sql.includes('SELECT dispatch."teeSearchId"')
          ? [{ teeSearchId: "search-1" }]
          : [];
      }),
    };

    await lockCourseSupportSearchExecutionFenceRows(transaction as never, {
      batchId: "batch-1",
      courseIds: ["course-2", "course-1"],
      recheckDispatchStartedAt: dispatchedAt,
      recheckDispatchedAt: dispatchedAt,
    });

    expect(queries).toHaveLength(6);
    expect(queries[0]).toContain('FROM "CourseSupportBatchSearch"');
    expect(queries[0]).not.toContain("FOR UPDATE");
    expect(queries[1]).toContain('FROM "TeeSearch"');
    expect(queries[2]).toContain('FROM "CourseSupportBatchSearch"');
    expect(queries[3]).toContain('FROM "CourseSupportBatchSearch"');
    expect(queries[3]).not.toContain("FOR UPDATE");
    expect(queries[4]).toContain('FROM "CoursePreference"');
    expect(queries[5]).toContain('FROM "CourseProbe"');
    for (const query of [queries[1], queries[2], queries[4], queries[5]]) {
      expect(query).toContain("ORDER BY");
      expect(query).toContain("FOR UPDATE");
    }
  });
});
