import { createHash } from "node:crypto";

import { Prisma, type ProbeOutcome } from "@prisma/client";

import { MAX_COURSE_PREFERENCES } from "@/lib/validation/search-constraints";

import { getProviderExecutionEvidenceObservedAt } from "./provider-execution-marker";

const SEARCH_EXECUTION_FENCE_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COURSE_REF_PATTERN = /^[a-f0-9]{24}$/u;
const COURSE_SUPPORT_PROBE_READ_LIMIT_PER_COURSE = 256;
export const COURSE_SUPPORT_SEARCH_EXECUTION_PROBE_READ_LIMIT =
  MAX_COURSE_PREFERENCES * COURSE_SUPPORT_PROBE_READ_LIMIT_PER_COURSE;

export type CourseSupportSearchExecutionFenceReason =
  | "DISPATCH_NOT_COMPLETE"
  | "DISPATCH_SET_CHANGED"
  | "SEARCH_REMOVAL_UNVERIFIED"
  | "SEARCH_GENERATION_CHANGED"
  | "SEARCH_STATUS_CHANGED"
  | "SEARCH_WORKFLOW_MISSING"
  | "SEARCH_CHECK_UNSETTLED"
  | "SEARCH_LEASE_ACTIVE"
  | "SEARCH_RECHECK_PENDING"
  | "SEARCH_CHECK_STALE"
  | "SEARCH_REMEDIATION_CHANGED"
  | "PREFERENCE_MEMBERSHIP_EMPTY";

export type CourseSupportSearchExecutionFenceProbe = {
  id: string;
  teeSearchId: string;
  courseId: string;
  automationRunId: string | null;
  outcome: ProbeOutcome;
  observedAt: Date;
  message: string | null;
  evidenceUrl: string | null;
  rawSummary: unknown;
  runtimeVersion: string | null;
};

export type CourseSupportSearchExecutionFencePreference = {
  id: string;
  teeSearchId: string;
  courseId: string;
  rank: number;
};

export type CourseSupportSearchExecutionFenceSearch = {
  id: string;
  status: string;
  trafficClass: string;
  scheduleVersion: number;
  alertGeneration: number;
  workflowRunId: string | null;
  checkStatus: string;
  checkLeaseToken: string | null;
  checkLeaseExpiresAt: Date | null;
  recheckRequestedAt: Date | null;
  remediationDispatchKey: string | null;
  remediationDispatchVersion: number | null;
  nextCheckAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckOutcome: string | null;
  updatedAt: Date;
  preferences: CourseSupportSearchExecutionFencePreference[];
  probes: CourseSupportSearchExecutionFenceProbe[];
};

export type CourseSupportSearchExecutionFenceDispatch = {
  id: string;
  teeSearchId: string | null;
  searchRef: string;
  scheduleVersion: number;
  removedAt: Date | null;
  removalReason: string | null;
  teeSearch: CourseSupportSearchExecutionFenceSearch | null;
};

export type CourseSupportSearchExecutionFenceSnapshot = {
  schemaVersion: 1;
  digest: string;
  searchStateDigest: string;
  probeEvidenceRefs: string[];
  settled: boolean;
  reasons: CourseSupportSearchExecutionFenceReason[];
  batchSearchCount: number;
  teeSearchCount: number;
  preferenceCount: number;
  probeCount: number;
  deletedSearchRefs: string[];
  probeEvidenceBySearch: Array<{
    searchRef: string;
    probes: Array<{ probeRef: string; courseRef: string }>;
  }>;
  memberships: Array<{
    searchRef: string;
    scheduleVersion: number;
    alertGeneration: number | null;
    courseRefs: string[];
  }>;
  providerExecutionAttemptCourseIds: string[];
  providerExecutionAttemptCourseRefs: string[];
  searchExecutionMayHaveStartedCourseRefs: string[];
};

export type PersistedCourseSupportSearchExecutionFence = Omit<
  CourseSupportSearchExecutionFenceSnapshot,
  "providerExecutionAttemptCourseIds"
> & {
  capturedAt: string;
};

export type CourseSupportSearchExecutionFenceInput = {
  batchId: string;
  courseIds: string[];
  expectedSearches: Array<{ searchRef: string; scheduleVersion: number }>;
  recheckDispatchKey: string | null;
  recheckDispatchStartedAt: Date | null;
  recheckDispatchedAt: Date | null;
  now: Date;
};

function getCourseSupportPostDispatchFloor(input: {
  recheckDispatchStartedAt: Date | null;
  recheckDispatchedAt: Date | null;
}) {
  return input.recheckDispatchedAt ?? input.recheckDispatchStartedAt;
}

export function createCourseSupportSearchExecutionFenceInput(input: {
  batchId: string;
  courseIds: string[];
  summary: unknown;
  recheckDispatchKey: string | null;
  recheckDispatchStartedAt: Date | null;
  recheckDispatchedAt: Date | null;
  now: Date;
}): CourseSupportSearchExecutionFenceInput {
  const summary = asRecord(input.summary);
  const dispatch = asRecord(summary.recheckDispatch);
  const expectedByRef = new Map<string, number>();
  if (Array.isArray(dispatch.affectedSearchRefs)) {
    for (const value of dispatch.affectedSearchRefs) {
      const entry = asRecord(value);
      if (
        typeof entry.searchRef === "string" &&
        SHA256_PATTERN.test(entry.searchRef) &&
        typeof entry.scheduleVersion === "number" &&
        Number.isInteger(entry.scheduleVersion) &&
        entry.scheduleVersion >= 0
      ) {
        expectedByRef.set(entry.searchRef, entry.scheduleVersion);
      }
    }
  }
  return {
    batchId: input.batchId,
    courseIds: input.courseIds,
    expectedSearches: [...expectedByRef].map(
      ([searchRef, scheduleVersion]) => ({
        searchRef,
        scheduleVersion,
      }),
    ),
    recheckDispatchKey: input.recheckDispatchKey,
    recheckDispatchStartedAt: input.recheckDispatchStartedAt,
    recheckDispatchedAt: input.recheckDispatchedAt,
    now: input.now,
  };
}

type CourseSupportSearchExecutionFenceClient = Pick<
  Prisma.TransactionClient,
  "courseSupportBatchSearch"
>;

export class CourseSupportSearchExecutionFenceRetryError extends Error {
  constructor(
    message = "Course-support search execution changed; run another verification pass.",
  ) {
    super(message);
    this.name = "CourseSupportSearchExecutionFenceRetryError";
  }
}

export function isCourseSupportSearchExecutionFenceRetryError(
  error: unknown,
): error is CourseSupportSearchExecutionFenceRetryError {
  return error instanceof CourseSupportSearchExecutionFenceRetryError;
}

export async function readCourseSupportSearchExecutionFence(
  client: CourseSupportSearchExecutionFenceClient,
  input: CourseSupportSearchExecutionFenceInput,
) {
  return (await loadCourseSupportSearchExecutionFence(client, input)).snapshot;
}

export async function loadCourseSupportSearchExecutionFence(
  client: CourseSupportSearchExecutionFenceClient,
  input: CourseSupportSearchExecutionFenceInput,
) {
  const courseIds = [...new Set(input.courseIds)].sort();
  const postDispatchFloor =
    getCourseSupportPostDispatchFloor(input) ?? new Date(0);
  const dispatches = (await client.courseSupportBatchSearch.findMany({
    where: { batchId: input.batchId },
    orderBy: [{ id: "asc" }],
    select: {
      id: true,
      teeSearchId: true,
      searchRef: true,
      scheduleVersion: true,
      removedAt: true,
      removalReason: true,
      teeSearch: {
        select: {
          id: true,
          status: true,
          trafficClass: true,
          scheduleVersion: true,
          alertGeneration: true,
          workflowRunId: true,
          checkStatus: true,
          checkLeaseToken: true,
          checkLeaseExpiresAt: true,
          recheckRequestedAt: true,
          remediationDispatchKey: true,
          remediationDispatchVersion: true,
          nextCheckAt: true,
          lastCheckedAt: true,
          lastCheckOutcome: true,
          updatedAt: true,
          preferences: {
            orderBy: [{ courseId: "asc" }, { id: "asc" }],
            select: {
              id: true,
              teeSearchId: true,
              courseId: true,
              rank: true,
            },
          },
          probes: {
            where: {
              observedAt: { gte: postDispatchFloor },
            },
            orderBy: [{ observedAt: "asc" }, { id: "asc" }],
            take: COURSE_SUPPORT_SEARCH_EXECUTION_PROBE_READ_LIMIT + 1,
            select: {
              id: true,
              teeSearchId: true,
              courseId: true,
              automationRunId: true,
              outcome: true,
              observedAt: true,
              message: true,
              evidenceUrl: true,
              rawSummary: true,
              runtimeVersion: true,
            },
          },
        },
      },
    },
  })) as CourseSupportSearchExecutionFenceDispatch[];
  if (
    dispatches.some(
      (dispatch) =>
        (dispatch.teeSearch?.probes.length ?? 0) >
        COURSE_SUPPORT_SEARCH_EXECUTION_PROBE_READ_LIMIT,
    )
  ) {
    throw new CourseSupportSearchExecutionFenceRetryError(
      "Course-support post-dispatch probe evidence exceeds the bounded read limit.",
    );
  }

  return {
    dispatches,
    snapshot: buildCourseSupportSearchExecutionFenceSnapshot({
      ...input,
      courseIds,
      dispatches,
    }),
  };
}

export async function lockCourseSupportSearchExecutionFenceRows(
  transaction: Prisma.TransactionClient,
  input: Pick<
    CourseSupportSearchExecutionFenceInput,
    | "batchId"
    | "courseIds"
    | "recheckDispatchStartedAt"
    | "recheckDispatchedAt"
  >,
) {
  const postDispatchFloor =
    getCourseSupportPostDispatchFloor(input) ?? new Date(0);

  // Workflow/search writers already establish TeeSearch as the first locked
  // parent. Discover the exact ids without a lock, acquire them in stable
  // order, then lock and re-read the BatchSearch membership before children.
  const discoveredSearches = await transaction.$queryRaw<
    Array<{ teeSearchId: string | null }>
  >(Prisma.sql`
    SELECT dispatch."teeSearchId"
    FROM "CourseSupportBatchSearch" AS dispatch
    WHERE dispatch."batchId" = ${input.batchId}
    ORDER BY dispatch."teeSearchId", dispatch."id"
  `);
  const teeSearchIds = discoveredSearches.flatMap((row) =>
    typeof row.teeSearchId === "string" ? [row.teeSearchId] : [],
  );
  await transaction.$queryRaw(Prisma.sql`
    SELECT search."id"
    FROM "TeeSearch" AS search
    WHERE ${teeSearchIds.length > 0 ? Prisma.sql`search."id" IN (${Prisma.join(teeSearchIds)})` : Prisma.sql`FALSE`}
    ORDER BY search."id"
    FOR UPDATE
  `);
  await transaction.$queryRaw(Prisma.sql`
    SELECT dispatch."id"
    FROM "CourseSupportBatchSearch" AS dispatch
    WHERE dispatch."batchId" = ${input.batchId}
    ORDER BY dispatch."id"
    FOR UPDATE
  `);
  const lockedSearches = await transaction.$queryRaw<
    Array<{ teeSearchId: string | null }>
  >(Prisma.sql`
    SELECT dispatch."teeSearchId"
    FROM "CourseSupportBatchSearch" AS dispatch
    WHERE dispatch."batchId" = ${input.batchId}
    ORDER BY dispatch."teeSearchId", dispatch."id"
  `);
  if (
    stableStringify(discoveredSearches.map((row) => row.teeSearchId)) !==
    stableStringify(lockedSearches.map((row) => row.teeSearchId))
  ) {
    throw new CourseSupportSearchExecutionFenceRetryError(
      "Course-support batch-search membership changed while acquiring the search fence.",
    );
  }
  await transaction.$queryRaw(Prisma.sql`
    SELECT preference."id"
    FROM "CoursePreference" AS preference
    WHERE preference."teeSearchId" IN (
      SELECT dispatch."teeSearchId"
      FROM "CourseSupportBatchSearch" AS dispatch
      WHERE dispatch."batchId" = ${input.batchId}
        AND dispatch."teeSearchId" IS NOT NULL
    )
    ORDER BY preference."teeSearchId", preference."courseId", preference."id"
    FOR UPDATE
  `);
  await transaction.$queryRaw(Prisma.sql`
    SELECT probe."id"
    FROM "CourseProbe" AS probe
    WHERE probe."teeSearchId" IN (
      SELECT dispatch."teeSearchId"
      FROM "CourseSupportBatchSearch" AS dispatch
      WHERE dispatch."batchId" = ${input.batchId}
        AND dispatch."teeSearchId" IS NOT NULL
    )
      AND probe."observedAt" >= ${postDispatchFloor}
    ORDER BY probe."teeSearchId", probe."observedAt", probe."id"
    FOR UPDATE
  `);
}

export function buildCourseSupportSearchExecutionFenceSnapshot(input: {
  courseIds: string[];
  expectedSearches: Array<{ searchRef: string; scheduleVersion: number }>;
  recheckDispatchKey: string | null;
  recheckDispatchStartedAt: Date | null;
  recheckDispatchedAt: Date | null;
  now: Date;
  dispatches: CourseSupportSearchExecutionFenceDispatch[];
}): CourseSupportSearchExecutionFenceSnapshot {
  const courseIds = [...new Set(input.courseIds)].sort();
  const postDispatchFloor = getCourseSupportPostDispatchFloor(input);
  const relevantCourseIds = new Set(courseIds);
  const expectedSearches = [...input.expectedSearches]
    .map((search) => ({
      searchRef: search.searchRef,
      scheduleVersion: search.scheduleVersion,
    }))
    .sort(compareExpectedSearch);
  const dispatches = [...input.dispatches]
    .map((dispatch) =>
      normalizeDispatch(dispatch, postDispatchFloor),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const reasons = new Set<CourseSupportSearchExecutionFenceReason>();
  const batchCourseRefs = courseIds.map(createCourseRef);
  const searchExecutionMayHaveStartedCourseRefs = new Set<string>();
  const deletedSearchRefs = new Set<string>();
  const markOperationalUnknown = () => {
    for (const courseRef of batchCourseRefs) {
      searchExecutionMayHaveStartedCourseRefs.add(courseRef);
    }
  };
  const expectedByRef = new Map(
    expectedSearches.map((search) => [search.searchRef, search]),
  );
  const actualByRef = new Map(
    dispatches.map((dispatch) => [dispatch.searchRef, dispatch]),
  );

  if (
    (input.recheckDispatchKey ||
      input.recheckDispatchStartedAt ||
      expectedSearches.length > 0) &&
    (!input.recheckDispatchStartedAt || !input.recheckDispatchedAt)
  ) {
    reasons.add("DISPATCH_NOT_COMPLETE");
  }
  if (
    actualByRef.size !== expectedByRef.size ||
    expectedSearches.some((expected) => {
      const actual = actualByRef.get(expected.searchRef);
      return !actual || actual.scheduleVersion !== expected.scheduleVersion;
    })
  ) {
    reasons.add("DISPATCH_SET_CHANGED");
  }

  for (const dispatch of dispatches) {
    const expected = expectedByRef.get(dispatch.searchRef);
    if (!expected || expected.scheduleVersion !== dispatch.scheduleVersion) {
      continue;
    }
    const search = dispatch.teeSearch;
    if (!search) {
      if (
        !postDispatchFloor ||
        !dispatch.removedAt ||
        dispatch.removedAt.getTime() <
          postDispatchFloor.getTime() ||
        dispatch.removalReason !== "SEARCH_DELETED_BY_OWNER"
      ) {
        reasons.add("SEARCH_REMOVAL_UNVERIFIED");
      } else {
        deletedSearchRefs.add(dispatch.searchRef);
        markOperationalUnknown();
      }
      continue;
    }
    if (
      dispatch.teeSearchId !== search.id ||
      search.scheduleVersion < dispatch.scheduleVersion
    ) {
      reasons.add("SEARCH_GENERATION_CHANGED");
      continue;
    }
    const generationSuperseded =
      search.scheduleVersion > dispatch.scheduleVersion;
    const hasLease = Boolean(
      search.checkLeaseToken || search.checkLeaseExpiresAt,
    );
    if (hasLease) {
      reasons.add("SEARCH_LEASE_ACTIVE");
    }
    if (search.recheckRequestedAt) {
      reasons.add("SEARCH_RECHECK_PENDING");
    }
    const dispatchStartedAt = postDispatchFloor;
    const freshLastCheckedAt = Boolean(
      dispatchStartedAt &&
      search.lastCheckedAt &&
      search.lastCheckedAt.getTime() >= dispatchStartedAt.getTime(),
    );
    if (search.status === "ACTIVE") {
      const settledCheckStatus = generationSuperseded
        ? search.checkStatus === "WAITING" || search.checkStatus === "STOPPED"
        : search.checkStatus === "WAITING";
      const workflowStateSettled =
        search.checkStatus !== "WAITING" || Boolean(search.workflowRunId);
      const activeExecutionStateSettled =
        settledCheckStatus &&
        workflowStateSettled &&
        freshLastCheckedAt &&
        !hasLease &&
        !search.recheckRequestedAt;
      if (!settledCheckStatus) {
        reasons.add("SEARCH_CHECK_UNSETTLED");
      }
      if (search.checkStatus === "WAITING" && !search.workflowRunId) {
        reasons.add("SEARCH_WORKFLOW_MISSING");
      }
      if (!freshLastCheckedAt) {
        reasons.add("SEARCH_CHECK_STALE");
      }
      if (
        !generationSuperseded &&
        (!input.recheckDispatchKey ||
          search.remediationDispatchKey !== input.recheckDispatchKey ||
          search.remediationDispatchVersion !== dispatch.scheduleVersion)
      ) {
        if (activeExecutionStateSettled) {
          markOperationalUnknown();
        } else {
          reasons.add("SEARCH_REMEDIATION_CHANGED");
        }
      }
      if (generationSuperseded) {
        markOperationalUnknown();
      }
    } else if (["PAUSED", "CANCELLED", "COMPLETED"].includes(search.status)) {
      if (
        !dispatchStartedAt ||
        search.updatedAt.getTime() < dispatchStartedAt.getTime()
      ) {
        reasons.add("SEARCH_STATUS_CHANGED");
      } else {
        markOperationalUnknown();
      }
    } else {
      reasons.add("SEARCH_STATUS_CHANGED");
    }
    if (search.preferences.length === 0) {
      markOperationalUnknown();
    }
  }

  const providerExecutionAttemptCourseIds = [
    ...new Set(
      dispatches.flatMap((dispatch) =>
        (dispatch.teeSearch?.probes ?? []).flatMap((probe) =>
          relevantCourseIds.has(probe.courseId) &&
          isProviderExecutionAttempt({
            rawSummary: probe.rawSummary,
            probeObservedAt: probe.observedAt,
            notBefore: postDispatchFloor,
          })
            ? [probe.courseId]
            : [],
        ),
      ),
    ),
  ].sort();
  const providerExecutionAttemptCourseRefs =
    providerExecutionAttemptCourseIds.map(createCourseRef);
  const memberships = dispatches.map((dispatch) => ({
    searchRef: dispatch.searchRef,
    scheduleVersion: dispatch.scheduleVersion,
    alertGeneration: dispatch.teeSearch?.alertGeneration ?? null,
    courseRefs: (dispatch.teeSearch?.preferences ?? [])
      .map((preference) => createCourseRef(preference.courseId))
      .sort(),
  }));
  const serializedDispatches = dispatches.map(serializeDispatch);
  const canonical = {
    courseIds: courseIds.map(createCourseRef),
    expectedSearches,
    dispatches: serializedDispatches,
  };
  const searchStateCanonical = {
    courseIds: canonical.courseIds,
    expectedSearches,
    dispatches: serializedDispatches.map((dispatch) =>
      dispatch.teeSearch
        ? {
            ...dispatch,
            teeSearch: { ...dispatch.teeSearch, probes: [] },
          }
        : dispatch,
    ),
  };
  const probeEvidenceBySearch = serializedDispatches.map((dispatch) => ({
    searchRef: dispatch.searchRef,
    probes: (dispatch.teeSearch?.probes ?? [])
      .map((probe) => ({
        probeRef: createHash("sha256")
          .update(stableStringify(probe))
          .digest("hex"),
        courseRef: probe.courseRef,
      }))
      .sort((left, right) => left.probeRef.localeCompare(right.probeRef)),
  }));
  const probeEvidenceRefs = probeEvidenceBySearch
    .flatMap((entry) => entry.probes.map((probe) => probe.probeRef))
    .sort();
  const preferenceCount = dispatches.reduce(
    (total, dispatch) => total + (dispatch.teeSearch?.preferences.length ?? 0),
    0,
  );
  const probeCount = dispatches.reduce(
    (total, dispatch) => total + (dispatch.teeSearch?.probes.length ?? 0),
    0,
  );

  return {
    schemaVersion: SEARCH_EXECUTION_FENCE_SCHEMA_VERSION,
    digest: createHash("sha256")
      .update(stableStringify(canonical))
      .digest("hex"),
    searchStateDigest: createHash("sha256")
      .update(stableStringify(searchStateCanonical))
      .digest("hex"),
    probeEvidenceRefs,
    settled: reasons.size === 0,
    reasons: [...reasons].sort(),
    batchSearchCount: dispatches.length,
    teeSearchCount: dispatches.filter((dispatch) => dispatch.teeSearch !== null)
      .length,
    preferenceCount,
    probeCount,
    deletedSearchRefs: [...deletedSearchRefs].sort(),
    probeEvidenceBySearch,
    memberships,
    providerExecutionAttemptCourseIds,
    providerExecutionAttemptCourseRefs,
    searchExecutionMayHaveStartedCourseRefs: [
      ...searchExecutionMayHaveStartedCourseRefs,
    ].sort(),
  };
}

export function persistCourseSupportSearchExecutionFence(
  snapshot: CourseSupportSearchExecutionFenceSnapshot,
  capturedAt: Date,
): PersistedCourseSupportSearchExecutionFence {
  const persisted = Object.fromEntries(
    Object.entries(snapshot).filter(
      ([key]) => key !== "providerExecutionAttemptCourseIds",
    ),
  ) as Omit<
    CourseSupportSearchExecutionFenceSnapshot,
    "providerExecutionAttemptCourseIds"
  >;
  return {
    ...persisted,
    capturedAt: capturedAt.toISOString(),
  };
}

export function readPersistedCourseSupportSearchExecutionFence(
  value: unknown,
): PersistedCourseSupportSearchExecutionFence | null {
  const candidate = asRecord(value);
  if (
    candidate.schemaVersion !== SEARCH_EXECUTION_FENCE_SCHEMA_VERSION ||
    typeof candidate.digest !== "string" ||
    !SHA256_PATTERN.test(candidate.digest) ||
    typeof candidate.searchStateDigest !== "string" ||
    !SHA256_PATTERN.test(candidate.searchStateDigest) ||
    typeof candidate.settled !== "boolean" ||
    typeof candidate.capturedAt !== "string" ||
    !Number.isFinite(new Date(candidate.capturedAt).getTime()) ||
    !Array.isArray(candidate.reasons) ||
    !Array.isArray(candidate.memberships) ||
    candidate.memberships.some((value) => {
      const membership = asRecord(value);
      return (
        typeof membership.searchRef !== "string" ||
        !SHA256_PATTERN.test(membership.searchRef) ||
        !Array.isArray(membership.courseRefs) ||
        membership.courseRefs.some(
          (courseRef) =>
            typeof courseRef !== "string" ||
            !COURSE_REF_PATTERN.test(courseRef),
        )
      );
    }) ||
    !Array.isArray(candidate.deletedSearchRefs) ||
    candidate.deletedSearchRefs.some(
      (searchRef) =>
        typeof searchRef !== "string" || !SHA256_PATTERN.test(searchRef),
    ) ||
    !Array.isArray(candidate.probeEvidenceBySearch) ||
    candidate.probeEvidenceBySearch.some((value) => {
      const evidence = asRecord(value);
      return (
        typeof evidence.searchRef !== "string" ||
        !SHA256_PATTERN.test(evidence.searchRef) ||
        !Array.isArray(evidence.probes) ||
        evidence.probes.some((probeValue) => {
          const probe = asRecord(probeValue);
          return (
            typeof probe.probeRef !== "string" ||
            !SHA256_PATTERN.test(probe.probeRef) ||
            typeof probe.courseRef !== "string" ||
            !COURSE_REF_PATTERN.test(probe.courseRef)
          );
        })
      );
    }) ||
    !Array.isArray(candidate.probeEvidenceRefs) ||
    candidate.probeEvidenceRefs.some(
      (value) => typeof value !== "string" || !SHA256_PATTERN.test(value),
    ) ||
    !Array.isArray(candidate.providerExecutionAttemptCourseRefs) ||
    candidate.providerExecutionAttemptCourseRefs.some(
      (courseRef) =>
        typeof courseRef !== "string" || !COURSE_REF_PATTERN.test(courseRef),
    ) ||
    !Array.isArray(candidate.searchExecutionMayHaveStartedCourseRefs) ||
    candidate.searchExecutionMayHaveStartedCourseRefs.some(
      (courseRef) =>
        typeof courseRef !== "string" || !COURSE_REF_PATTERN.test(courseRef),
    )
  ) {
    return null;
  }
  return candidate as PersistedCourseSupportSearchExecutionFence;
}

export function courseSupportSearchExecutionFenceMatches(
  expected: PersistedCourseSupportSearchExecutionFence,
  current: CourseSupportSearchExecutionFenceSnapshot,
) {
  return (
    expected.settled && current.settled && expected.digest === current.digest
  );
}

export function canAdvanceCourseSupportSearchExecutionFence(
  expected: PersistedCourseSupportSearchExecutionFence,
  current: CourseSupportSearchExecutionFenceSnapshot,
) {
  if (!current.settled) return false;
  const currentSearchRefs = new Set(
    current.memberships.map((entry) => entry.searchRef),
  );
  if (
    expected.memberships.some(
      (entry) => !currentSearchRefs.has(entry.searchRef),
    ) ||
    current.memberships.some(
      (entry) =>
        !expected.memberships.some(
          (prior) => prior.searchRef === entry.searchRef,
        ),
    )
  ) {
    return false;
  }
  const deletedSearchRefs = new Set(current.deletedSearchRefs);
  const currentProbesBySearch = new Map(
    current.probeEvidenceBySearch.map((entry) => [
      entry.searchRef,
      new Set(entry.probes.map((probe) => probe.probeRef)),
    ]),
  );
  return expected.probeEvidenceBySearch.every((entry) => {
    if (deletedSearchRefs.has(entry.searchRef)) return true;
    const currentProbeRefs = currentProbesBySearch.get(entry.searchRef);
    return Boolean(
      currentProbeRefs &&
      entry.probes.every((probe) => currentProbeRefs.has(probe.probeRef)),
    );
  });
}

export function getCourseSupportSearchExecutionMayHaveStartedCourseRefs(
  expected: PersistedCourseSupportSearchExecutionFence | null,
  current: CourseSupportSearchExecutionFenceSnapshot,
) {
  const refs = new Set(current.searchExecutionMayHaveStartedCourseRefs);
  const firstPostDispatchFence = Boolean(
    expected &&
    expected.batchSearchCount === 0 &&
    expected.memberships.length === 0,
  );
  for (const courseRef of expected?.searchExecutionMayHaveStartedCourseRefs ??
    []) {
    refs.add(courseRef);
  }
  for (const courseRef of current.providerExecutionAttemptCourseRefs) {
    refs.add(courseRef);
  }
  const expectedProbeRefs = new Set(
    firstPostDispatchFence ? [] : (expected?.probeEvidenceRefs ?? []),
  );
  for (const entry of current.probeEvidenceBySearch) {
    for (const probe of entry.probes) {
      if (!expectedProbeRefs.has(probe.probeRef)) {
        refs.add(probe.courseRef);
      }
    }
  }
  if (
    expected &&
    !firstPostDispatchFence &&
    expected.searchStateDigest !== current.searchStateDigest
  ) {
    for (const membership of [
      ...expected.memberships,
      ...current.memberships,
    ]) {
      for (const courseRef of membership.courseRefs) {
        refs.add(courseRef);
      }
    }
  }
  return [...refs].sort();
}

function normalizeDispatch(
  dispatch: CourseSupportSearchExecutionFenceDispatch,
  postDispatchFloor: Date | null,
): CourseSupportSearchExecutionFenceDispatch {
  if (!dispatch.teeSearch) {
    return { ...dispatch, teeSearch: null };
  }
  return {
    ...dispatch,
    teeSearch: {
      ...dispatch.teeSearch,
      preferences: [...dispatch.teeSearch.preferences].sort(
        (left, right) =>
          left.courseId.localeCompare(right.courseId) ||
          left.id.localeCompare(right.id),
      ),
      probes: [...dispatch.teeSearch.probes]
        .filter(
          (probe) =>
            !postDispatchFloor ||
            probe.observedAt.getTime() >= postDispatchFloor.getTime(),
        )
        .sort(
          (left, right) =>
            left.observedAt.getTime() - right.observedAt.getTime() ||
            left.id.localeCompare(right.id),
        ),
    },
  };
}

function serializeDispatch(
  dispatch: CourseSupportSearchExecutionFenceDispatch,
) {
  return {
    id: createStableRef(dispatch.id),
    teeSearchId: dispatch.teeSearchId
      ? createStableRef(dispatch.teeSearchId)
      : null,
    searchRef: dispatch.searchRef,
    scheduleVersion: dispatch.scheduleVersion,
    removedAt: toIso(dispatch.removedAt),
    removalReason: dispatch.removalReason,
    teeSearch: dispatch.teeSearch
      ? {
          id: createStableRef(dispatch.teeSearch.id),
          status: dispatch.teeSearch.status,
          trafficClass: dispatch.teeSearch.trafficClass,
          scheduleVersion: dispatch.teeSearch.scheduleVersion,
          alertGeneration: dispatch.teeSearch.alertGeneration,
          workflowRunId: dispatch.teeSearch.workflowRunId
            ? createStableRef(dispatch.teeSearch.workflowRunId)
            : null,
          checkStatus: dispatch.teeSearch.checkStatus,
          checkLeaseToken: dispatch.teeSearch.checkLeaseToken
            ? createStableRef(dispatch.teeSearch.checkLeaseToken)
            : null,
          checkLeaseExpiresAt: toIso(dispatch.teeSearch.checkLeaseExpiresAt),
          recheckRequestedAt: toIso(dispatch.teeSearch.recheckRequestedAt),
          remediationDispatchKey: dispatch.teeSearch.remediationDispatchKey
            ? createStableRef(dispatch.teeSearch.remediationDispatchKey)
            : null,
          remediationDispatchVersion:
            dispatch.teeSearch.remediationDispatchVersion,
          nextCheckAt: toIso(dispatch.teeSearch.nextCheckAt),
          lastCheckedAt: toIso(dispatch.teeSearch.lastCheckedAt),
          lastCheckOutcome: dispatch.teeSearch.lastCheckOutcome,
          updatedAt: dispatch.teeSearch.updatedAt.toISOString(),
          preferences: dispatch.teeSearch.preferences.map((preference) => ({
            id: createStableRef(preference.id),
            teeSearchId: createStableRef(preference.teeSearchId),
            courseRef: createCourseRef(preference.courseId),
            rank: preference.rank,
          })),
          probes: dispatch.teeSearch.probes.map((probe) => ({
            id: createStableRef(probe.id),
            teeSearchId: createStableRef(probe.teeSearchId),
            courseRef: createCourseRef(probe.courseId),
            automationRunId: probe.automationRunId
              ? createStableRef(probe.automationRunId)
              : null,
            outcome: probe.outcome,
            observedAt: probe.observedAt.toISOString(),
            message: probe.message,
            evidenceUrl: probe.evidenceUrl,
            rawSummary: probe.rawSummary,
            runtimeVersion: probe.runtimeVersion,
          })),
        }
      : null,
  };
}

function compareExpectedSearch(
  left: { searchRef: string; scheduleVersion: number },
  right: { searchRef: string; scheduleVersion: number },
) {
  return (
    left.searchRef.localeCompare(right.searchRef) ||
    left.scheduleVersion - right.scheduleVersion
  );
}

function isProviderExecutionAttempt(input: {
  rawSummary: unknown;
  probeObservedAt: Date;
  notBefore: Date | null;
}) {
  const providerObservedAt = getProviderExecutionEvidenceObservedAt(input);
  return Boolean(
    providerObservedAt &&
      input.notBefore &&
      providerObservedAt.getTime() >= input.notBefore.getTime(),
  );
}

function createCourseRef(courseId: string) {
  return createHash("sha256").update(courseId).digest("hex").slice(0, 24);
}

function createStableRef(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function toIso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
