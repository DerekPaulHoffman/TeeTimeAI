import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  Prisma,
  type SearchEmailDeliveryKind,
  type SearchEmailDeliveryStatus
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { TeeTimeAlertInput } from "@/lib/email/alerts";
import type {
  SearchStatusCourseReport,
  SearchStatusEmailInput
} from "@/lib/email/search-status";

const DELIVERY_CLAIM_MS = 5 * 60 * 1000;
const DELIVERY_HEARTBEAT_MS = 60 * 1000;
const DELIVERY_RETRY_BASE_MS = 60 * 1000;
const DELIVERY_RETRY_MAX_MS = 10 * 60 * 1000;

type DeliveryTransaction = Prisma.TransactionClient;

type LockedSearch = {
  id: string;
  status: string;
  alertGeneration: number;
  checkLeaseToken: string | null;
  checkLeaseExpiresAt: Date | null;
};

export type SearchEmailDeliveryPayload = {
  schemaVersion: 2;
  checkedAt: string;
  matchIds?: string[];
  displayMatchIds?: string[];
  satisfiesStatusReport?: boolean;
  statusSnapshot?: Prisma.InputJsonValue;
  statusReport?: Prisma.InputJsonValue;
  matchReport?: Prisma.InputJsonValue;
};

export class SearchEmailDeliveryInProgressError extends Error {
  readonly code = "SEARCH_EMAIL_DELIVERY_IN_PROGRESS";
  readonly retryable = true;
  readonly retryAt: Date | null;

  constructor(retryAt: Date | null = null) {
    super("An alert email is currently being finalized. Please retry in a moment.");
    this.name = "SearchEmailDeliveryInProgressError";
    this.retryAt = retryAt;
  }
}

export class SearchEmailDeliveryDeferredError extends Error {
  readonly code = "SEARCH_EMAIL_DELIVERY_DEFERRED";
  readonly retryable = true;
  readonly retryAt: Date | null;

  constructor(retryAt: Date | null = null) {
    super("Alert email delivery is scheduled to retry.");
    this.name = "SearchEmailDeliveryDeferredError";
    this.retryAt = retryAt;
  }
}

export async function lockSearchForAlertMutation(
  transaction: DeliveryTransaction,
  input: { searchId: string; userId?: string; now?: Date }
) {
  const now = input.now ?? new Date();
  const [search] = await lockSearchRow(transaction, input.searchId, input.userId);
  if (!search) {
    throw new Error("Search not found");
  }
  await rejectActiveDeliveryClaim(transaction, input.searchId, now);
  await finalizeOwnerOutcomesForSearch(transaction, search);
  await transaction.searchEmailDelivery.updateMany({
    where: {
      teeSearchId: input.searchId,
      OR: [
        { status: { in: ["PENDING", "FAILED"] } }
      ]
    },
    data: {
      status: "SUPPRESSED",
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: null
    }
  });
  return search;
}

export async function lockSearchForEmailReconciliation(
  transaction: DeliveryTransaction,
  input: {
    searchId: string;
    alertGeneration: number;
    checkLeaseToken: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const [search] = await lockSearchRow(transaction, input.searchId);
  if (!search) {
    throw new Error("Search not found");
  }
  await rejectActiveDeliveryClaim(transaction, input.searchId, now);
  return isCurrentDeliverySearch(search, input, now) ? search : null;
}

export async function prepareSearchEmailDeliveryGroup(input: {
  searchId: string;
  alertGeneration: number;
  checkLeaseToken: string;
  kind: SearchEmailDeliveryKind;
  groupKey: string;
  recipients: string[];
  ownerRecipient: string;
  payload: SearchEmailDeliveryPayload;
  now?: Date;
}) {
  assertSafeSearchEmailPayload(input.payload);
  const now = input.now ?? new Date();
  const recipients = normalizeRecipients(input.recipients);
  const ownerRecipient = normalizeRecipient(input.ownerRecipient);
  if (!ownerRecipient || !recipients.includes(ownerRecipient)) {
    throw new Error("The alert owner must be included in the delivery group");
  }

  return prisma.$transaction(async (transaction) => {
    const [search] = await lockSearchRow(transaction, input.searchId);
    if (!isCurrentDeliverySearch(search, input, now)) {
      return { prepared: false as const, reason: "stale_search" as const, deliveries: [] };
    }
    await rejectActiveDeliveryClaim(transaction, input.searchId, now);

    const existing = await transaction.searchEmailDelivery.findMany({
      where: groupWhere(input)
    });
    const persistedPayload =
      existing.length > 0 ? assertIdenticalGroupPayloads(existing) : input.payload;
    const recipientSet = new Set(recipients);
    if (existing.length > 0 && existing.length !== recipients.length) {
      throw new Error("Delivery group recipients are immutable");
    }
    for (const delivery of existing) {
      if (!recipientSet.has(delivery.recipient)) {
        throw new Error("Delivery group recipients are immutable");
      }
      if (delivery.isOwnerRecipient !== (delivery.recipient === ownerRecipient)) {
        throw new Error("Delivery group owner is immutable");
      }
    }

    const existingRecipients = new Set(existing.map((delivery) => delivery.recipient));
    for (const recipient of recipients) {
      if (existingRecipients.has(recipient)) {
        continue;
      }
      await transaction.searchEmailDelivery.create({
        data: {
          teeSearchId: input.searchId,
          alertGeneration: input.alertGeneration,
          kind: input.kind,
          groupKey: input.groupKey,
          recipient,
          isOwnerRecipient: recipient === ownerRecipient,
          payload: persistedPayload
        }
      });
    }

    const deliveries = await transaction.searchEmailDelivery.findMany({
      where: groupWhere(input),
      orderBy: [{ isOwnerRecipient: "desc" }, { recipient: "asc" }]
    });
    if (deliveries.length !== recipients.length) {
      throw new Error("Delivery group recipient set is incomplete");
    }
    assertIdenticalGroupPayloads(deliveries);
    return { prepared: true as const, deliveries };
  });
}

export async function listRetryableSearchEmailDeliveryGroups(input: {
  searchId: string;
  alertGeneration: number;
}) {
  const rows = await prisma.searchEmailDelivery.findMany({
    where: {
      teeSearchId: input.searchId,
      alertGeneration: input.alertGeneration,
      status: { in: ["PENDING", "FAILED", "SENDING"] }
    },
    select: {
      kind: true,
      groupKey: true,
      createdAt: true
    },
    orderBy: { createdAt: "asc" }
  });
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const key = `${row.kind}\u0000${row.groupKey}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ kind: row.kind, groupKey: row.groupKey, createdAt: row.createdAt }];
  });
}

export async function drainSearchEmailDeliveryGroup<TDelivery extends {
  deliveryStatus: "sent" | "dry_run";
}>(input: {
  searchId: string;
  alertGeneration: number;
  checkLeaseToken: string;
  kind: SearchEmailDeliveryKind;
  groupKey: string;
  send: (input: {
    recipient: string;
    idempotencyKey: string;
    payload: SearchEmailDeliveryPayload;
  }) => Promise<TDelivery>;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const claim = await claimSearchEmailDeliveryGroup({ ...input, now: now() });
  if (claim.outcome === "busy") {
    throw new SearchEmailDeliveryInProgressError(claim.retryAt);
  }
  if (claim.outcome === "deferred") {
    throw new SearchEmailDeliveryDeferredError(claim.retryAt);
  }
  if (claim.outcome === "terminal" || claim.outcome === "suppressed") {
    return claim.deliveries.map((delivery) => ({
      id: delivery.id,
      status: delivery.status as Extract<
        SearchEmailDeliveryStatus,
        "SENT" | "SUPPRESSED"
      >
    }));
  }

  const heartbeatController = new AbortController();
  const heartbeat = maintainSearchEmailDeliveryClaim({
    searchId: input.searchId,
    alertGeneration: input.alertGeneration,
    claimToken: claim.claimToken,
    expectedCount: claim.deliveries.length,
    signal: heartbeatController.signal
  }).catch(() => undefined);
  let results: PromiseSettledResult<{
    delivery: (typeof claim.deliveries)[number];
    result: TDelivery;
  }>[];
  try {
    results = await Promise.allSettled(
      claim.deliveries.map(async (delivery) => {
        try {
          return {
            delivery,
            result: await input.send({
              recipient: delivery.recipient,
              idempotencyKey: getStableDeliveryIdempotencyKey({
                searchId: input.searchId,
                kind: input.kind,
                groupKey: input.groupKey,
                recipient: delivery.recipient,
                payload: claim.payload
              }),
              payload: claim.payload
            })
          };
        } catch (error) {
          throw { delivery, error };
        }
      })
    );
  } finally {
    heartbeatController.abort();
    await heartbeat;
  }
  const settled = await settleClaimedSearchEmailGroup({
    searchId: input.searchId,
    alertGeneration: input.alertGeneration,
    kind: input.kind,
    groupKey: input.groupKey,
    claimToken: claim.claimToken,
    results,
    now: now()
  });
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failed) {
    throw getRejectedError(failed.reason);
  }
  return [...claim.terminalDeliveries, ...settled].map((delivery) => ({
    id: delivery.id,
    status: delivery.status
  }));
}

export async function finalizeSearchEmailDeliveryGroup(input: {
  searchId: string;
  alertGeneration: number;
  kind: SearchEmailDeliveryKind;
  groupKey: string;
}) {
  return prisma.$transaction(async (transaction) => {
    const [search] = await lockSearchRow(transaction, input.searchId);
    if (!search) {
      return { finalized: false as const, reason: "missing_search" as const };
    }
    const outcome = await applyOwnerDeliveryOutcome(transaction, input, search);
    if (outcome.reason === "missing_group") {
      return { finalized: false as const, reason: "not_terminal" as const };
    }
    if (outcome.reason === "invalid_owner") {
      return { finalized: false as const, reason: "invalid_owner" as const };
    }
    if (!outcome.groupComplete) {
      return {
        finalized: false as const,
        reason: "not_terminal" as const,
        ownerFinalized: outcome.ownerFinalized
      };
    }
    return {
      finalized: true as const,
      status: outcome.ownerSent ? ("SENT" as const) : ("SUPPRESSED" as const),
      ownerSent: outcome.ownerSent
    };
  });
}

async function finalizeOwnerOutcomesForSearch(
  transaction: DeliveryTransaction,
  search: LockedSearch
) {
  const ownerRows = await transaction.searchEmailDelivery.findMany({
    where: {
      teeSearchId: search.id,
      alertGeneration: search.alertGeneration,
      isOwnerRecipient: true,
      status: { in: ["SENT", "SUPPRESSED"] }
    },
    select: { kind: true, groupKey: true }
  });
  for (const row of ownerRows) {
    await applyOwnerDeliveryOutcome(
      transaction,
      {
        searchId: search.id,
        alertGeneration: search.alertGeneration,
        kind: row.kind,
        groupKey: row.groupKey
      },
      search
    );
  }
}

async function applyOwnerDeliveryOutcome(
  transaction: DeliveryTransaction,
  input: {
    searchId: string;
    alertGeneration: number;
    kind: SearchEmailDeliveryKind;
    groupKey: string;
  },
  lockedSearch?: LockedSearch
) {
  const search = lockedSearch ?? (await lockSearchRow(transaction, input.searchId))[0];
  const deliveries = await transaction.searchEmailDelivery.findMany({
    where: groupWhere(input)
  });
  if (deliveries.length === 0) {
    return {
      reason: "missing_group" as const,
      groupComplete: false,
      ownerFinalized: false,
      ownerSent: false
    };
  }
  const payload = assertIdenticalGroupPayloads(deliveries);
  const ownerDeliveries = deliveries.filter((delivery) => delivery.isOwnerRecipient);
  if (ownerDeliveries.length !== 1) {
    return {
      reason: "invalid_owner" as const,
      groupComplete: false,
      ownerFinalized: false,
      ownerSent: false
    };
  }
  const groupComplete = deliveries.every(
    (delivery) => delivery.status === "SENT" || delivery.status === "SUPPRESSED"
  );
  const ownerDelivery = ownerDeliveries[0];
  const ownerSent = ownerDelivery.status === "SENT";
  const ownerFinalized = ownerSent || (ownerDelivery.status === "SUPPRESSED" && groupComplete);
  if (!ownerFinalized) {
    return { reason: null, groupComplete, ownerFinalized, ownerSent };
  }

  const terminalStatus = ownerSent ? "SENT" : "SUPPRESSED";
  const sentAt = ownerDelivery.sentAt ?? new Date(payload.checkedAt);
  if (payload.matchIds && payload.matchIds.length > 0) {
    await transaction.teeTimeMatch.updateMany({
      where: {
        id: { in: payload.matchIds },
        teeSearchId: input.searchId,
        alertStatus: "PENDING"
      },
      data: { alertStatus: terminalStatus, sentAt }
    });
  }

  const satisfiesStatusReport =
    input.kind === "SETUP" ||
    input.kind === "DAILY" ||
    (input.kind === "MATCH" && payload.satisfiesStatusReport === true);
  if (
    ownerSent &&
    satisfiesStatusReport &&
    search?.alertGeneration === input.alertGeneration &&
    payload.statusSnapshot !== undefined
  ) {
    await transaction.teeSearch.updateMany({
      where: { id: input.searchId, alertGeneration: input.alertGeneration },
      data: {
        statusEmailSentAt: sentAt,
        statusEmailSnapshot: payload.statusSnapshot
      }
    });
  }
  return { reason: null, groupComplete, ownerFinalized, ownerSent };
}

export async function suppressSearchEmailDeliveriesForMatches(input: {
  searchId: string;
  alertGeneration: number;
  checkLeaseToken: string;
  matchIds: string[];
  now?: Date;
  transaction?: DeliveryTransaction;
}) {
  const matchIds = [...new Set(input.matchIds.filter(Boolean))];
  if (matchIds.length === 0) {
    return { count: 0, matchCount: 0, current: true as const };
  }
  const worker = async (transaction: DeliveryTransaction) => {
    const search = await lockSearchForEmailReconciliation(transaction, {
      searchId: input.searchId,
      alertGeneration: input.alertGeneration,
      checkLeaseToken: input.checkLeaseToken,
      now: input.now
    });
    if (!search) {
      return { count: 0, matchCount: 0, current: false as const };
    }
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH affected_groups AS (
        SELECT DISTINCT "alertGeneration", "groupKey", "kind"
        FROM "SearchEmailDelivery"
        WHERE "teeSearchId" = ${input.searchId}
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              COALESCE("payload"->'matchIds', '[]'::jsonb)
            ) AS match_id
            WHERE match_id = ANY(${matchIds}::text[])
          )
      )
      UPDATE "SearchEmailDelivery" AS delivery
      SET
        "status" = 'SUPPRESSED'::"SearchEmailDeliveryStatus",
        "claimToken" = NULL,
        "claimExpiresAt" = NULL,
        "nextAttemptAt" = NULL,
        "updatedAt" = ${input.now ?? new Date()}
      FROM affected_groups
      WHERE delivery."teeSearchId" = ${input.searchId}
        AND delivery."kind" = affected_groups."kind"
        AND delivery."alertGeneration" = affected_groups."alertGeneration"
        AND delivery."groupKey" = affected_groups."groupKey"
        AND delivery."status" IN (
          'PENDING'::"SearchEmailDeliveryStatus",
          'FAILED'::"SearchEmailDeliveryStatus"
        )
      RETURNING delivery."id"
    `);
    const matches = await transaction.teeTimeMatch.updateMany({
      where: {
        id: { in: matchIds },
        teeSearchId: input.searchId,
        alertStatus: "PENDING"
      },
      data: {
        alertStatus: "SUPPRESSED",
        sentAt: input.now ?? new Date()
      }
    });
    return { count: rows.length, matchCount: matches.count, current: true as const };
  };
  return input.transaction
    ? worker(input.transaction)
    : prisma.$transaction((transaction) => worker(transaction));
}

export async function hydrateSearchStatusEmailPayload(
  payload: SearchEmailDeliveryPayload
): Promise<Omit<SearchStatusEmailInput, "to" | "searchId" | "stableIdempotencyKey">> {
  const report = requireJsonRecord(payload.statusReport, "status report");
  const courses = Array.isArray(report.courses)
    ? (report.courses as SearchStatusCourseReport[])
    : [];
  return {
    kind: report.kind === "daily" ? "daily" : "setup",
    targetDate: requireString(report.targetDate, "target date"),
    startTime: requireString(report.startTime, "start time"),
    endTime: requireString(report.endTime, "end time"),
    players: requireNumber(report.players, "players"),
    requestedLayoutHoles:
      report.requestedLayoutHoles === 9 || report.requestedLayoutHoles === 18
        ? report.requestedLayoutHoles
        : null,
    userTimeZone: requireString(report.userTimeZone, "user time zone"),
    checkedAt: new Date(payload.checkedAt),
    courses,
    previousSnapshot: report.previousSnapshot
  };
}

export async function hydrateMatchAlertPayload(input: {
  searchId: string;
  alertGeneration: number;
  payload: SearchEmailDeliveryPayload;
}): Promise<Omit<TeeTimeAlertInput, "to" | "searchId" | "stableIdempotencyKey">> {
  const report = requireJsonRecord(input.payload.matchReport, "match report");
  const persistedMatches = Array.isArray(report.matches) ? report.matches : [];
  return {
    matches: persistedMatches.map((value) => {
      const match = requireJsonRecord(value, "match alert row");
      const startsAt = new Date(requireString(match.startsAt, "match start"));
      if (Number.isNaN(startsAt.getTime())) {
        throw new Error("Persisted match start is invalid");
      }
      return {
        courseId: optionalString(match.courseId),
        courseName: requireString(match.courseName, "course name"),
        courseRank: optionalNumber(match.courseRank),
        courseAddress: optionalString(match.courseAddress),
        courseTimeZone: optionalString(match.courseTimeZone),
        startsAt,
        availableSpots: requireNumber(match.availableSpots, "available spots"),
        bookingUrl: requireString(match.bookingUrl, "booking URL"),
        priceCents: optionalNullableNumber(match.priceCents),
        holes: optionalNullableNumber(match.holes),
        bookableHoleCounts: Array.isArray(match.bookableHoleCounts)
          ? match.bookableHoleCounts.filter(
              (holes: unknown): holes is 9 | 18 => holes === 9 || holes === 18
            )
          : undefined,
        isNew: match.isNew === true
      };
    }),
    userTimeZone: requireString(report.userTimeZone, "user time zone"),
    targetDate: requireString(report.targetDate, "target date"),
    startTime: requireString(report.startTime, "start time"),
    endTime: requireString(report.endTime, "end time"),
    players: requireNumber(report.players, "players"),
    requestedLayoutHoles:
      report.requestedLayoutHoles === 9 || report.requestedLayoutHoles === 18
        ? report.requestedLayoutHoles
        : null,
    checkedAt: new Date(input.payload.checkedAt)
  };
}

export function toSearchEmailJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function assertSafeSearchEmailPayload(payload: SearchEmailDeliveryPayload) {
  const visit = (value: unknown, key = "") => {
    if (key === "bookingUrl") {
      assertSafeOfficialBookingUrl(value);
      return;
    }
    if (/^(?:url|link|token|secret|code|email|recipient)$/i.test(key)) {
      throw new Error(`Search email delivery payload cannot contain ${key}`);
    }
    if (typeof value === "string" && /https?:\/\//i.test(value)) {
      throw new Error("Search email delivery payload cannot contain URLs");
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
    }
  };
  visit(payload);
}

function assertSafeOfficialBookingUrl(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("Search email delivery booking URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Search email delivery booking URL is invalid");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Search email delivery booking URL is not a safe public URL");
  }
  if (
    /\/(?:account|login|sign-in|signin|checkout|cart|captcha|queue|waiting-room)(?:\/|$)/i.test(
      parsed.pathname
    )
  ) {
    throw new Error("Search email delivery booking URL targets a restricted flow");
  }
  for (const key of parsed.searchParams.keys()) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (
      /(?:^|_)(?:access_?token|auth|authorization|code|credential|key|secret|session|sig|signature|token|expires?)(?:_|$)/i.test(
        normalizedKey
      )
    ) {
      throw new Error("Search email delivery booking URL contains session-specific data");
    }
  }
}

export function getSafeOfficialBookingUrl(value: unknown) {
  try {
    assertSafeOfficialBookingUrl(value);
    return value as string;
  } catch {
    return undefined;
  }
}

async function claimSearchEmailDeliveryGroup(input: {
  searchId: string;
  alertGeneration: number;
  checkLeaseToken: string;
  kind: SearchEmailDeliveryKind;
  groupKey: string;
  now: Date;
}) {
  return prisma.$transaction(async (transaction) => {
    const [search] = await lockSearchRow(transaction, input.searchId);
    const deliveries = await transaction.searchEmailDelivery.findMany({
      where: groupWhere(input),
      orderBy: [{ isOwnerRecipient: "desc" }, { recipient: "asc" }]
    });
    if (deliveries.length === 0) {
      return { outcome: "suppressed" as const, deliveries: [] };
    }
    const payload = assertIdenticalGroupPayloads(deliveries);
    const activeClaim = deliveries.find(
      (delivery) =>
        delivery.status === "SENDING" &&
        delivery.claimExpiresAt &&
        delivery.claimExpiresAt > input.now
    );
    if (activeClaim) {
      return { outcome: "busy" as const, retryAt: activeClaim.claimExpiresAt };
    }

    const newerGroup = await transaction.searchEmailDelivery.findFirst({
      where: {
        teeSearchId: input.searchId,
        alertGeneration: input.alertGeneration,
        kind: input.kind,
        groupKey: { not: input.groupKey },
        createdAt: { gt: deliveries[0].createdAt }
      },
      select: { id: true }
    });
    const matchRefsCurrent = await areMatchReferencesCurrent(
      transaction,
      input.searchId,
      payload.matchIds
    );
    if (!isCurrentDeliverySearch(search, input, input.now) || newerGroup || !matchRefsCurrent) {
      await suppressRetryableGroupRows(transaction, deliveries);
      const suppressed = await transaction.searchEmailDelivery.findMany({
        where: groupWhere(input)
      });
      return { outcome: "suppressed" as const, deliveries: suppressed };
    }

    const deferred = deliveries
      .filter(
        (delivery) =>
          delivery.status === "FAILED" &&
          delivery.nextAttemptAt &&
          delivery.nextAttemptAt > input.now
      )
      .sort((left, right) => left.nextAttemptAt!.getTime() - right.nextAttemptAt!.getTime())[0];
    if (deferred) {
      await requestDeliveryRetry(
        transaction,
        input.searchId,
        input.alertGeneration,
        deferred.nextAttemptAt!
      );
      return { outcome: "deferred" as const, retryAt: deferred.nextAttemptAt };
    }

    const terminalDeliveries = deliveries.filter(
      (delivery) => delivery.status === "SENT" || delivery.status === "SUPPRESSED"
    );
    const claimable = deliveries.filter(
      (delivery) => delivery.status !== "SENT" && delivery.status !== "SUPPRESSED"
    );
    if (claimable.length === 0) {
      return { outcome: "terminal" as const, deliveries: terminalDeliveries };
    }

    const claimToken = randomUUID();
    const claimExpiresAt = new Date(input.now.getTime() + DELIVERY_CLAIM_MS);
    const claimed = await transaction.searchEmailDelivery.updateMany({
      where: { id: { in: claimable.map((delivery) => delivery.id) } },
      data: {
        status: "SENDING",
        claimToken,
        claimExpiresAt,
        attemptCount: { increment: 1 },
        nextAttemptAt: null,
        lastError: null
      }
    });
    if (claimed.count !== claimable.length) {
      throw new SearchEmailDeliveryInProgressError(claimExpiresAt);
    }
    return {
      outcome: "claimed" as const,
      claimToken,
      payload,
      deliveries: claimable.map((delivery) => ({
        ...delivery,
        attemptCount: delivery.attemptCount + 1
      })),
      terminalDeliveries
    };
  });
}

async function settleClaimedSearchEmailGroup(input: {
  searchId: string;
  alertGeneration: number;
  kind: SearchEmailDeliveryKind;
  groupKey: string;
  claimToken: string;
  results: PromiseSettledResult<{
    delivery: { id: string; attemptCount: number };
    result: { deliveryStatus: "sent" | "dry_run" };
  }>[];
  now: Date;
}) {
  return prisma.$transaction(async (transaction) => {
    await lockSearchRow(transaction, input.searchId);
    const settled: Array<{
      id: string;
      status: Extract<SearchEmailDeliveryStatus, "SENT" | "SUPPRESSED">;
    }> = [];
    for (const result of input.results) {
      const delivery =
        result.status === "fulfilled"
          ? result.value.delivery
          : getRejectedDelivery(result.reason);
      if (!delivery) {
        throw new Error("Delivery result lost its group claim context");
      }
      const status =
        result.status === "fulfilled"
          ? result.value.result.deliveryStatus === "dry_run"
            ? "SUPPRESSED"
            : "SENT"
          : "FAILED";
      const rejectedError =
        result.status === "rejected" ? getRejectedError(result.reason) : null;
      const retryDelay = Math.min(
        DELIVERY_RETRY_MAX_MS,
        DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, delivery.attemptCount - 1)
      );
      const updated = await transaction.searchEmailDelivery.updateMany({
        where: {
          id: delivery.id,
          status: "SENDING",
          claimToken: input.claimToken
        },
        data: {
          status,
          claimToken: null,
          claimExpiresAt: null,
          sentAt: status === "FAILED" ? undefined : input.now,
          nextAttemptAt:
            status === "FAILED" ? new Date(input.now.getTime() + retryDelay) : null,
          lastError:
            status === "FAILED" ? sanitizeDeliveryError(rejectedError) : null
        }
      });
      if (updated.count !== 1) {
        throw new Error("Alert email group claim expired before it could be settled");
      }
      if (status !== "FAILED") {
        settled.push({ id: delivery.id, status });
      }
    }
    const nextAttemptAt = input.results.reduce<Date | null>((earliest, result) => {
      if (result.status !== "rejected") {
        return earliest;
      }
      const delivery = getRejectedDelivery(result.reason);
      if (!delivery) {
        return earliest;
      }
      const retryDelay = Math.min(
        DELIVERY_RETRY_MAX_MS,
        DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, delivery.attemptCount - 1)
      );
      const retryAt = new Date(input.now.getTime() + retryDelay);
      return !earliest || retryAt < earliest ? retryAt : earliest;
    }, null);
    if (nextAttemptAt) {
      await requestDeliveryRetry(
        transaction,
        input.searchId,
        input.alertGeneration,
        nextAttemptAt
      );
    }
    await applyOwnerDeliveryOutcome(transaction, {
      searchId: input.searchId,
      alertGeneration: input.alertGeneration,
      kind: input.kind,
      groupKey: input.groupKey
    });
    return settled;
  });
}

async function maintainSearchEmailDeliveryClaim(input: {
  searchId: string;
  alertGeneration: number;
  claimToken: string;
  expectedCount: number;
  signal: AbortSignal;
}) {
  while (!input.signal.aborted) {
    try {
      await delay(DELIVERY_HEARTBEAT_MS, undefined, { signal: input.signal });
    } catch (error) {
      if (input.signal.aborted) {
        return;
      }
      throw error;
    }
    const heartbeatAt = new Date();
    const extended = await prisma.searchEmailDelivery.updateMany({
      where: {
        teeSearchId: input.searchId,
        alertGeneration: input.alertGeneration,
        status: "SENDING",
        claimToken: input.claimToken
      },
      data: {
        claimExpiresAt: new Date(heartbeatAt.getTime() + DELIVERY_CLAIM_MS)
      }
    });
    if (extended.count !== input.expectedCount) {
      throw new Error("Alert email group claim changed while delivery was active");
    }
  }
}

async function requestDeliveryRetry(
  transaction: DeliveryTransaction,
  searchId: string,
  alertGeneration: number,
  retryAt: Date
) {
  await transaction.$executeRaw(Prisma.sql`
    UPDATE "TeeSearch"
    SET "recheckRequestedAt" = CASE
      WHEN "recheckRequestedAt" IS NULL OR "recheckRequestedAt" > ${retryAt}
        THEN ${retryAt}
      ELSE "recheckRequestedAt"
    END
    WHERE "id" = ${searchId}
      AND "alertGeneration" = ${alertGeneration}
      AND "status" = 'ACTIVE'::"SearchStatus"
  `);
}

async function rejectActiveDeliveryClaim(
  transaction: DeliveryTransaction,
  searchId: string,
  now: Date
) {
  const inFlight = await transaction.searchEmailDelivery.findFirst({
    where: {
      teeSearchId: searchId,
      status: "SENDING"
    },
    orderBy: { claimExpiresAt: "desc" },
    select: { claimExpiresAt: true }
  });
  if (inFlight) {
    throw new SearchEmailDeliveryInProgressError(
      inFlight.claimExpiresAt && inFlight.claimExpiresAt > now
        ? inFlight.claimExpiresAt
        : new Date(now.getTime() + DELIVERY_RETRY_BASE_MS)
    );
  }
}

async function areMatchReferencesCurrent(
  transaction: DeliveryTransaction,
  searchId: string,
  matchIds?: string[]
) {
  if (!matchIds || matchIds.length === 0) {
    return true;
  }
  const currentCount = await transaction.teeTimeMatch.count({
    where: {
      id: { in: matchIds },
      teeSearchId: searchId,
      alertStatus: { in: ["PENDING", "SENT"] },
      availabilityStatus: "AVAILABLE"
    }
  });
  return currentCount === new Set(matchIds).size;
}

async function suppressRetryableGroupRows(
  transaction: DeliveryTransaction,
  deliveries: Array<{ id: string; status: SearchEmailDeliveryStatus }>
) {
  const ids = deliveries
    .filter(
      (delivery) =>
        delivery.status === "PENDING" || delivery.status === "FAILED"
    )
    .map((delivery) => delivery.id);
  if (ids.length === 0) {
    return;
  }
  await transaction.searchEmailDelivery.updateMany({
    where: { id: { in: ids } },
    data: {
      status: "SUPPRESSED",
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: null
    }
  });
}

async function lockSearchRow(
  transaction: DeliveryTransaction,
  searchId: string,
  userId?: string
) {
  const userFilter = userId ? Prisma.sql`AND "userId" = ${userId}` : Prisma.empty;
  return transaction.$queryRaw<LockedSearch[]>(Prisma.sql`
    SELECT
      "id",
      "status"::text AS "status",
      "alertGeneration",
      "checkLeaseToken",
      "checkLeaseExpiresAt"
    FROM "TeeSearch"
    WHERE "id" = ${searchId}
    ${userFilter}
    FOR UPDATE
  `);
}

function isCurrentDeliverySearch(
  search: LockedSearch | undefined,
  input: { alertGeneration: number; checkLeaseToken: string },
  now: Date
) {
  return Boolean(
    search &&
      search.status === "ACTIVE" &&
      search.alertGeneration === input.alertGeneration &&
      search.checkLeaseToken === input.checkLeaseToken &&
      search.checkLeaseExpiresAt &&
      search.checkLeaseExpiresAt > now
  );
}

function groupWhere(input: {
  searchId: string;
  alertGeneration: number;
  kind: SearchEmailDeliveryKind;
  groupKey: string;
}) {
  return {
    teeSearchId: input.searchId,
    alertGeneration: input.alertGeneration,
    kind: input.kind,
    groupKey: input.groupKey
  } as const;
}

function assertIdenticalGroupPayloads(
  deliveries: Array<{ payload: unknown }>
): SearchEmailDeliveryPayload {
  const payload = parseSearchEmailPayload(deliveries[0]?.payload);
  if (!payload) {
    throw new Error("Delivery group payload is invalid");
  }
  const canonical = canonicalJson(payload);
  if (
    deliveries.some((delivery) => canonicalJson(delivery.payload) !== canonical)
  ) {
    throw new Error("Delivery group payloads do not match");
  }
  return payload;
}

function parseSearchEmailPayload(value: unknown): SearchEmailDeliveryPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.schemaVersion !== 2 ||
    typeof payload.checkedAt !== "string" ||
    Number.isNaN(new Date(payload.checkedAt).getTime())
  ) {
    return null;
  }
  return {
    schemaVersion: 2,
    checkedAt: payload.checkedAt,
    ...(Array.isArray(payload.matchIds)
      ? { matchIds: payload.matchIds.filter((id): id is string => typeof id === "string") }
      : {}),
    ...(Array.isArray(payload.displayMatchIds)
      ? {
          displayMatchIds: payload.displayMatchIds.filter(
            (id): id is string => typeof id === "string"
          )
        }
      : {}),
    ...(typeof payload.satisfiesStatusReport === "boolean"
      ? { satisfiesStatusReport: payload.satisfiesStatusReport }
      : {}),
    ...(payload.statusSnapshot !== undefined
      ? { statusSnapshot: payload.statusSnapshot as Prisma.InputJsonValue }
      : {}),
    ...(payload.statusReport !== undefined
      ? { statusReport: payload.statusReport as Prisma.InputJsonValue }
      : {}),
    ...(payload.matchReport !== undefined
      ? { matchReport: payload.matchReport as Prisma.InputJsonValue }
      : {})
  };
}

function normalizeRecipients(recipients: string[]) {
  return [...new Set(recipients.map(normalizeRecipient).filter(Boolean))];
}

function normalizeRecipient(recipient: string) {
  return recipient.trim().toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function getStableDeliveryIdempotencyKey(input: {
  searchId: string;
  kind: SearchEmailDeliveryKind;
  groupKey: string;
  recipient: string;
  payload: SearchEmailDeliveryPayload;
}) {
  return `tee-search-delivery-${createHash("sha256")
    .update(
      canonicalJson({
        searchId: input.searchId,
        kind: input.kind,
        groupKey: input.groupKey,
        recipient: normalizeRecipient(input.recipient),
        payload: input.payload
      })
    )
    .digest("hex")
    .slice(0, 32)}`;
}

function getRejectedDelivery(error: unknown) {
  if (!error || typeof error !== "object" || !("delivery" in error)) {
    return null;
  }
  return (error as { delivery: { id: string; attemptCount: number } }).delivery;
}

function getRejectedError(error: unknown) {
  if (!error || typeof error !== "object" || !("error" in error)) {
    return error;
  }
  return (error as { error: unknown }).error;
}

function requireJsonRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Persisted ${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`Persisted ${label} is invalid`);
  }
  return value;
}

function requireNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Persisted ${label} is invalid`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalNullableNumber(value: unknown) {
  return value === null ? null : optionalNumber(value);
}

function sanitizeDeliveryError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown delivery failure";
  return message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .slice(0, 500);
}
