import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { runSerializedCourseMonitoringWrite } from "./course-monitoring";

export const PROVIDER_EXECUTION_MARKERS = [
  "RUNNABLE_PROVIDER_CHECK",
  "LOCAL_BROWSER_READER",
] as const;

export type ProviderExecutionMarker =
  (typeof PROVIDER_EXECUTION_MARKERS)[number];

export const PROVIDER_EXECUTION_EVIDENCE_MAX_LAG_MS = 20 * 60_000;

// ProviderRequestLease already supplies a durable token-fenced lease primitive.
// A distinct, hashed key keeps this observation fence separate from provider-
// family throttling without persisting a course identifier in the shared key.
const COURSE_PROVIDER_OBSERVATION_KEY_PREFIX =
  "__COURSE_PROVIDER_OBSERVATION__:";
const COURSE_PROVIDER_OBSERVATION_SLOT = 0;
export const COURSE_PROVIDER_OBSERVATION_MAX_TTL_MS = 20 * 60_000;
export const COURSE_PROVIDER_OBSERVATION_AMBIGUITY_RETRY_MS = 10 * 60_000;
const COURSE_PROVIDER_OBSERVATION_HEARTBEAT_MS = 60_000;

export type CourseProviderObservationLease = {
  courseId: string;
  leaseToken: string;
  observationStartedAt: Date;
  leaseExpiresAt: Date;
  ttlMs: number;
  supersededUnresolvedObservationStartedAt: Date | null;
};

export type CourseProviderObservationFence = {
  observationStartedAt: Date;
  leaseExpiresAt: Date;
  retryUntil: Date;
  state: "ACTIVE" | "EXPIRED_RETRYABLE" | "EXPIRED_TERMINAL";
};

const providerExecutionMarkers = new Set<string>(PROVIDER_EXECUTION_MARKERS);

export function isProviderExecutionMarker(
  value: unknown,
): value is ProviderExecutionMarker {
  return typeof value === "string" && providerExecutionMarkers.has(value);
}

export function getProviderExecutionEvidenceObservedAt(input: {
  rawSummary: unknown;
  probeObservedAt: Date;
}) {
  if (
    !(input.probeObservedAt instanceof Date) ||
    !Number.isFinite(input.probeObservedAt.getTime())
  ) {
    return null;
  }
  const summary = asRecord(input.rawSummary);
  if (
    summary.providerExecution !== "RUNNABLE_PROVIDER_CHECK" &&
    summary.providerExecution !== "LOCAL_BROWSER_READER"
  ) {
    return null;
  }
  const providerObservedAt = parseCanonicalTimestamp(
    summary.providerObservedAt,
  );
  if (!providerObservedAt) return null;
  const persistenceLagMs =
    input.probeObservedAt.getTime() - providerObservedAt.getTime();
  return persistenceLagMs >= 0 &&
    persistenceLagMs <= PROVIDER_EXECUTION_EVIDENCE_MAX_LAG_MS
    ? providerObservedAt
    : null;
}

/**
 * Establishes the operational fence before a provider observation can begin.
 *
 * This transition is serialized through the same course advisory-lock lane as
 * monitoring and delivery. `leaseExpiresAt` is operational crash recovery
 * only; it must never be reused as provider evidence time.
 */
export async function beginCourseProviderObservation(input: {
  courseId: string;
  leaseToken?: string;
  ttlMs?: number;
}): Promise<CourseProviderObservationLease | null> {
  const courseId = requireNonEmptyCourseId(input.courseId);
  const leaseToken = input.leaseToken ?? randomUUID();
  if (!leaseToken.trim()) {
    throw new Error("A provider observation lease token is required");
  }
  const ttlMs = requireBoundedObservationTtl(input.ttlMs);

  return runSerializedCourseMonitoringWrite(courseId, (transaction) =>
    beginCourseProviderObservationInTransaction(transaction, {
      courseId,
      leaseToken,
      ttlMs,
    }),
  );
}

/**
 * The caller must already own the course monitoring advisory lock in this
 * transaction. Local-reader claim uses this form so the marker and LEASED job
 * transition become visible atomically.
 */
export async function beginCourseProviderObservationInTransaction(
  transaction: Prisma.TransactionClient,
  input: {
    courseId: string;
    leaseToken?: string;
    ttlMs?: number;
  },
): Promise<CourseProviderObservationLease | null> {
  const courseId = requireNonEmptyCourseId(input.courseId);
  const leaseToken = input.leaseToken ?? randomUUID();
  if (!leaseToken.trim()) {
    throw new Error("A provider observation lease token is required");
  }
  const ttlMs = requireBoundedObservationTtl(input.ttlMs);
  const rows = await transaction.$queryRaw<
    Array<{
      leaseToken: string;
      observationStartedAt: Date;
      leaseExpiresAt: Date;
      supersededUnresolvedObservationStartedAt: Date | null;
    }>
  >(Prisma.sql`
      WITH prior AS MATERIALIZED (
        SELECT "updatedAt" AS "observationStartedAt"
        FROM "ProviderRequestLease"
        WHERE
          "providerFamilyKey" = ${getCourseProviderObservationKey(courseId)}
          AND "slot" = ${COURSE_PROVIDER_OBSERVATION_SLOT}
        LIMIT 1
      ), upserted AS (
        INSERT INTO "ProviderRequestLease" (
          "providerFamilyKey", "slot", "leaseToken", "leaseExpiresAt", "updatedAt"
        )
        VALUES (
          ${getCourseProviderObservationKey(courseId)},
          ${COURSE_PROVIDER_OBSERVATION_SLOT},
          ${leaseToken},
          statement_timestamp() + (${ttlMs} * INTERVAL '1 millisecond'),
          statement_timestamp()
        )
        ON CONFLICT ("providerFamilyKey", "slot") DO UPDATE
        SET
          "leaseToken" = EXCLUDED."leaseToken",
          "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
          "updatedAt" = EXCLUDED."updatedAt"
        WHERE
          "ProviderRequestLease"."leaseExpiresAt" <= statement_timestamp()
          OR "ProviderRequestLease"."leaseToken" = ${leaseToken}
        RETURNING
          "leaseToken",
          "updatedAt" AS "observationStartedAt",
          "leaseExpiresAt"
      )
      SELECT
        upserted."leaseToken",
        upserted."observationStartedAt",
        upserted."leaseExpiresAt",
        prior."observationStartedAt" AS "supersededUnresolvedObservationStartedAt"
      FROM upserted
      LEFT JOIN prior ON TRUE
    `);
  if (!rows[0]) return null;
  return {
    courseId,
    leaseToken,
    observationStartedAt: rows[0].observationStartedAt,
    leaseExpiresAt: rows[0].leaseExpiresAt,
    ttlMs,
    supersededUnresolvedObservationStartedAt:
      rows[0].supersededUnresolvedObservationStartedAt,
  };
}

/**
 * Releases only the caller's marker and does so in the course writer lane.
 * A lost/crashed caller therefore cannot delete a successor's observation.
 */
export async function releaseCourseProviderObservation(
  lease: CourseProviderObservationLease,
) {
  const courseId = requireNonEmptyCourseId(lease.courseId);
  await runSerializedCourseMonitoringWrite(courseId, (transaction) =>
    releaseCourseProviderObservationInTransaction(transaction, lease),
  );
}

/** The caller must already own the course monitoring advisory lock. */
export async function releaseCourseProviderObservationInTransaction(
  transaction: Prisma.TransactionClient,
  lease: CourseProviderObservationLease,
) {
  const courseId = requireNonEmptyCourseId(lease.courseId);
  await transaction.providerRequestLease.deleteMany({
    where: {
      providerFamilyKey: getCourseProviderObservationKey(courseId),
      slot: COURSE_PROVIDER_OBSERVATION_SLOT,
      leaseToken: lease.leaseToken,
    },
  });
}

/**
 * Ends execution without declaring the provider source reconciled into the
 * canonical monitoring state. The durable row remains as an ambiguity fence;
 * a later ordered provider check may replace it, but delivery must never treat
 * TTL expiry as permission to send older evidence.
 */
export async function markCourseProviderObservationUnreconciled(
  lease: CourseProviderObservationLease,
  options: { preserveSupersededSource?: boolean } = {},
) {
  const courseId = requireNonEmptyCourseId(lease.courseId);
  return runSerializedCourseMonitoringWrite(courseId, (transaction) =>
    markCourseProviderObservationUnreconciledInTransaction(
      transaction,
      lease,
      options,
    ),
  );
}

/** The caller must already own the course monitoring advisory lock. */
export async function markCourseProviderObservationUnreconciledInTransaction(
  transaction: Prisma.TransactionClient,
  lease: CourseProviderObservationLease,
  options: { preserveSupersededSource?: boolean } = {},
) {
  const courseId = requireNonEmptyCourseId(lease.courseId);
  const unresolvedSourceStartedAt =
    options.preserveSupersededSource &&
    lease.supersededUnresolvedObservationStartedAt
      ? lease.supersededUnresolvedObservationStartedAt
      : lease.observationStartedAt;
  const rows = await transaction.$queryRaw<Array<{ leaseExpiresAt: Date }>>(
    Prisma.sql`
      UPDATE "ProviderRequestLease"
      SET
        "leaseExpiresAt" = statement_timestamp(),
        "updatedAt" = ${unresolvedSourceStartedAt}
      WHERE
        "providerFamilyKey" = ${getCourseProviderObservationKey(courseId)}
        AND "slot" = ${COURSE_PROVIDER_OBSERVATION_SLOT}
        AND "leaseToken" = ${lease.leaseToken}
      RETURNING "leaseExpiresAt"
    `,
  );
  if (!rows[0]) return false;
  lease.leaseExpiresAt = rows[0].leaseExpiresAt;
  return true;
}

export async function renewCourseProviderObservation(
  lease: CourseProviderObservationLease,
) {
  const courseId = requireNonEmptyCourseId(lease.courseId);
  return runSerializedCourseMonitoringWrite(courseId, (transaction) =>
    renewCourseProviderObservationInTransaction(transaction, lease),
  );
}

/** The caller must already own the course monitoring advisory lock. */
export async function renewCourseProviderObservationInTransaction(
  transaction: Prisma.TransactionClient,
  lease: CourseProviderObservationLease,
) {
  const courseId = requireNonEmptyCourseId(lease.courseId);
  const rows = await transaction.$queryRaw<Array<{ leaseExpiresAt: Date }>>(
    Prisma.sql`
        UPDATE "ProviderRequestLease"
        SET
          "leaseExpiresAt" = statement_timestamp() + (${lease.ttlMs} * INTERVAL '1 millisecond')
        WHERE
          "providerFamilyKey" = ${getCourseProviderObservationKey(courseId)}
          AND "slot" = ${COURSE_PROVIDER_OBSERVATION_SLOT}
          AND "leaseToken" = ${lease.leaseToken}
          AND "leaseExpiresAt" > statement_timestamp()
        RETURNING "leaseExpiresAt"
      `,
  );
  if (!rows[0]) return false;
  lease.leaseExpiresAt = rows[0].leaseExpiresAt;
  return true;
}

/**
 * Reads an observation marker from a transaction that already owns every
 * relevant course advisory lock. Delivery uses this exact helper while
 * holding those locks; calling it as an unlocked health query is insufficient
 * to fence a provider read that has not begun yet.
 */
export async function getActiveCourseProviderObservationInTransaction(
  transaction: Prisma.TransactionClient,
  courseIdValue: string,
) {
  const fence = await getCourseProviderObservationFenceInTransaction(
    transaction,
    courseIdValue,
  );
  return fence?.state === "ACTIVE" ? fence.leaseExpiresAt : null;
}

/**
 * Returns every unreleased marker, including a crashed marker whose operational
 * lease expired. The caller must already own the course advisory lock. State is
 * classified entirely by the database clock so a skewed delivery host cannot
 * reopen stale customer evidence.
 */
export async function getCourseProviderObservationFenceInTransaction(
  transaction: Prisma.TransactionClient,
  courseIdValue: string,
): Promise<CourseProviderObservationFence | null> {
  const courseId = requireNonEmptyCourseId(courseIdValue);
  const rows = await transaction.$queryRaw<
    Array<{
      observationStartedAt: Date;
      leaseExpiresAt: Date;
      retryUntil: Date;
      state: CourseProviderObservationFence["state"];
    }>
  >(Prisma.sql`
      SELECT
        "updatedAt" AS "observationStartedAt",
        "leaseExpiresAt",
        "leaseExpiresAt" + (${COURSE_PROVIDER_OBSERVATION_AMBIGUITY_RETRY_MS} * INTERVAL '1 millisecond') AS "retryUntil",
        CASE
          WHEN "leaseExpiresAt" > statement_timestamp() THEN 'ACTIVE'
          WHEN "leaseExpiresAt" + (${COURSE_PROVIDER_OBSERVATION_AMBIGUITY_RETRY_MS} * INTERVAL '1 millisecond') > statement_timestamp()
            THEN 'EXPIRED_RETRYABLE'
          ELSE 'EXPIRED_TERMINAL'
        END AS "state"
      FROM "ProviderRequestLease"
      WHERE
        "providerFamilyKey" = ${getCourseProviderObservationKey(courseId)}
        AND "slot" = ${COURSE_PROVIDER_OBSERVATION_SLOT}
      LIMIT 1
    `);
  const row = rows[0];
  if (!row) return null;
  if (
    !(row.observationStartedAt instanceof Date) ||
    !Number.isFinite(row.observationStartedAt.getTime()) ||
    !(row.leaseExpiresAt instanceof Date) ||
    !Number.isFinite(row.leaseExpiresAt.getTime()) ||
    !(row.retryUntil instanceof Date) ||
    !Number.isFinite(row.retryUntil.getTime()) ||
    !["ACTIVE", "EXPIRED_RETRYABLE", "EXPIRED_TERMINAL"].includes(row.state)
  ) {
    throw new Error("The provider observation fence is invalid");
  }
  return row;
}

/**
 * Batch read for a customer projection that already owns its database
 * snapshot. Classification and source visibility use only that transaction.
 */
export async function getCourseProviderObservationFencesInTransaction(
  transaction: Prisma.TransactionClient,
  courseIdValues: readonly string[],
) {
  const courseIds = [
    ...new Set(
      courseIdValues.map((courseId) => courseId.trim()).filter(Boolean),
    ),
  ];
  if (courseIds.length === 0) {
    return new Map<string, CourseProviderObservationFence>();
  }
  const courseIdByKey = new Map(
    courseIds.map((courseId) => [
      getCourseProviderObservationKey(courseId),
      courseId,
    ]),
  );
  const keys = [...courseIdByKey.keys()];
  const result = await transaction.$queryRaw<
    Array<{
      providerFamilyKey: string;
      observationStartedAt: Date;
      leaseExpiresAt: Date;
      retryUntil: Date;
      state: CourseProviderObservationFence["state"];
    }>
  >(Prisma.sql`
      SELECT
        "providerFamilyKey",
        "updatedAt" AS "observationStartedAt",
        "leaseExpiresAt",
        "leaseExpiresAt" + (${COURSE_PROVIDER_OBSERVATION_AMBIGUITY_RETRY_MS} * INTERVAL '1 millisecond') AS "retryUntil",
        CASE
          WHEN "leaseExpiresAt" > statement_timestamp() THEN 'ACTIVE'
          WHEN "leaseExpiresAt" + (${COURSE_PROVIDER_OBSERVATION_AMBIGUITY_RETRY_MS} * INTERVAL '1 millisecond') > statement_timestamp()
            THEN 'EXPIRED_RETRYABLE'
          ELSE 'EXPIRED_TERMINAL'
        END AS "state"
      FROM "ProviderRequestLease"
      WHERE
        "providerFamilyKey" IN (${Prisma.join(keys)})
        AND "slot" = ${COURSE_PROVIDER_OBSERVATION_SLOT}
    `);
  const fences = new Map<string, CourseProviderObservationFence>();
  for (const row of result) {
    const courseId = courseIdByKey.get(row.providerFamilyKey);
    if (!courseId) continue;
    if (
      !(row.observationStartedAt instanceof Date) ||
      !Number.isFinite(row.observationStartedAt.getTime()) ||
      !(row.leaseExpiresAt instanceof Date) ||
      !Number.isFinite(row.leaseExpiresAt.getTime()) ||
      !(row.retryUntil instanceof Date) ||
      !Number.isFinite(row.retryUntil.getTime()) ||
      !["ACTIVE", "EXPIRED_RETRYABLE", "EXPIRED_TERMINAL"].includes(row.state)
    ) {
      throw new Error("The provider observation fence is invalid");
    }
    fences.set(courseId, row);
  }
  return fences;
}

/** Batch read for callers that do not already own a projection snapshot. */
export async function getCourseProviderObservationFences(
  courseIdValues: readonly string[],
) {
  return prisma.$transaction((transaction) =>
    getCourseProviderObservationFencesInTransaction(
      transaction,
      courseIdValues,
    ),
  );
}

export function startCourseProviderObservationHeartbeat(
  lease: CourseProviderObservationLease,
  dependencies: {
    renew: (current: CourseProviderObservationLease) => Promise<boolean>;
  } = { renew: renewCourseProviderObservation },
) {
  const controller = new AbortController();
  let ownershipError: unknown = null;
  const heartbeat = maintainCourseProviderObservation(
    lease,
    dependencies.renew,
    controller.signal,
  ).catch((error) => {
    ownershipError = error;
  });
  return {
    assertOwned() {
      if (ownershipError) throw ownershipError;
    },
    async stop() {
      controller.abort();
      await heartbeat;
      if (ownershipError) throw ownershipError;
    },
  };
}

async function maintainCourseProviderObservation(
  lease: CourseProviderObservationLease,
  renew: (current: CourseProviderObservationLease) => Promise<boolean>,
  signal: AbortSignal,
) {
  while (await waitForCourseProviderObservationHeartbeat(signal)) {
    if (!(await renew(lease))) {
      throw new Error(
        "Provider observation ownership expired before persistence completed",
      );
    }
  }
}

function waitForCourseProviderObservationHeartbeat(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, COURSE_PROVIDER_OBSERVATION_HEARTBEAT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseCanonicalTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getCourseProviderObservationKey(courseId: string) {
  return `${COURSE_PROVIDER_OBSERVATION_KEY_PREFIX}${createHash("sha256")
    .update(courseId)
    .digest("hex")}`;
}

function requireNonEmptyCourseId(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("A course is required for a provider observation");
  }
  return normalized;
}

function requireBoundedObservationTtl(value: number | undefined) {
  const ttlMs = value ?? COURSE_PROVIDER_OBSERVATION_MAX_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > COURSE_PROVIDER_OBSERVATION_MAX_TTL_MS
  ) {
    throw new Error("The provider observation lease TTL is invalid");
  }
  return ttlMs;
}
