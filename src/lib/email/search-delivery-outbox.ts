import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  Prisma,
  type SearchEmailDeliveryKind,
  type SearchEmailDeliveryStatus
} from "@prisma/client";

import { evaluateMonitoringGate } from "@/lib/automation/policy";
import { prisma } from "@/lib/prisma";
import {
  EmailDeliveryNotAcceptedError,
  type TeeTimeAlertInput
} from "@/lib/email/alerts";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import type {
  SearchStatusCourseReport,
  SearchStatusEmailInput
} from "@/lib/email/search-status";
import { getRenderedAvailabilityTimes } from "@/lib/email/customer-email";
import { zonedDateTimeToDate } from "@/lib/timezones";
import {
  applyPendingClerkEmailForSearch,
  SearchEmailDeliveryInProgressError
} from "@/lib/users/pending-email";

const DELIVERY_CLAIM_MS = 5 * 60 * 1000;
const DELIVERY_HEARTBEAT_MS = 60 * 1000;
const DELIVERY_RETRY_BASE_MS = 60 * 1000;
const DELIVERY_RETRY_MAX_MS = 10 * 60 * 1000;
const STALE_STATUS_REPLACEMENT_PENDING = "STATUS_CONTENT_STALE_REPLACEMENT_PENDING";
const STALE_STATUS_REPLACEMENT_PENDING_AMBIGUOUS =
  "STATUS_CONTENT_STALE_REPLACEMENT_PENDING_AMBIGUOUS";
const STALE_STATUS_REPLACED = "STATUS_CONTENT_STALE_REPLACED";
const STALE_STATUS_REPLACED_AMBIGUOUS = "STATUS_CONTENT_STALE_REPLACED_AMBIGUOUS";
const DELIVERY_DRY_RUN = "DELIVERY_DRY_RUN";
const DELIVERY_NOT_ACCEPTED_PREFIX = "DELIVERY_NOT_ACCEPTED:";
const DELIVERY_OUTCOME_UNKNOWN_PREFIX = "DELIVERY_OUTCOME_UNKNOWN:";
const STATUS_RECIPIENT_PRIOR_REACHED = "STATUS_RECIPIENT_PRIOR_REACHED";
const STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT =
  "STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT";
const MATCH_STALE_REKEY_BLOCKED = "MATCH_STALE_REKEY_BLOCKED";
const MATCH_STALE_REKEYED = "MATCH_STALE_REKEYED";
const MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP =
  "MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP";
const DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED =
  "DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED";
const DELIVERY_RECIPIENT_REKEYED = "DELIVERY_RECIPIENT_REKEYED";
const TRANSIENT_MATCH_PROBE_OUTCOMES = new Set([
  "FETCH_FAILED",
  "NEEDS_ADAPTER",
  "BLOCKED_TOOLING",
  "BLOCKED_AUTH",
  "BLOCKED_POLICY"
]);

type MatchPayloadReconciliation = {
  valid: boolean;
  contentChanged: boolean;
  confirmedMatchIds: string[];
  terminalMatchIds: string[];
  terminalMatchRefs: MatchRef[];
  staleMatchIds: string[];
  transientMatchIds: string[];
  transientMatchRefs: MatchRef[];
  confirmedMatchCycles: Array<{ matchId: string; availabilityCycle: number }>;
  payload: SearchEmailDeliveryPayload | null;
};

type StatusPayloadState = "current" | "stale" | "transient";

type MatchRef = { matchId: string; availabilityCycle: number };

type DeliveryTransaction = Prisma.TransactionClient;

type LockedSearch = {
  id: string;
  userId: string;
  status: string;
  alertGeneration: number;
  checkLeaseToken: string | null;
  checkLeaseExpiresAt: Date | null;
  ownerEmail: string;
  ownerPendingEmail: string | null;
  additionalEmails: string[];
};

type LockedSearchRow = Omit<LockedSearch, "ownerEmail" | "ownerPendingEmail">;

type DeliveryState = {
  status: SearchEmailDeliveryStatus;
  attemptCount: number;
  sentAt: Date | null;
  lastError: string | null;
};

function isDeliveryDryRun(delivery: DeliveryState) {
  return (
    delivery.status === "SUPPRESSED" &&
    Boolean(delivery.sentAt) &&
    delivery.lastError === DELIVERY_DRY_RUN
  );
}

function wasDeliveryNotAccepted(delivery: DeliveryState) {
  return (
    delivery.status === "FAILED" &&
    delivery.lastError?.startsWith(DELIVERY_NOT_ACCEPTED_PREFIX) === true
  );
}

function canSafelyRekeyDelivery(delivery: DeliveryState) {
  return (
    (delivery.status === "PENDING" && delivery.attemptCount === 0) ||
    wasDeliveryNotAccepted(delivery) ||
    isDeliveryDryRun(delivery) ||
    delivery.lastError === STALE_STATUS_REPLACEMENT_PENDING ||
    delivery.lastError === MATCH_STALE_REKEYED
  );
}

function isAmbiguousDelivery(delivery: DeliveryState) {
  return (
    delivery.status === "SENDING" ||
    (delivery.status === "PENDING" && delivery.attemptCount > 0) ||
    (delivery.status === "FAILED" && !wasDeliveryNotAccepted(delivery)) ||
    delivery.lastError === STALE_STATUS_REPLACEMENT_PENDING_AMBIGUOUS ||
    delivery.lastError === STALE_STATUS_REPLACED_AMBIGUOUS ||
    delivery.lastError === STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT ||
    delivery.lastError === MATCH_STALE_REKEY_BLOCKED ||
    delivery.lastError === DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED
  );
}

function isReachedDelivery(delivery: DeliveryState) {
  return delivery.status === "SENT";
}

function isRecipientAuthorityRetired(delivery: DeliveryState) {
  return delivery.lastError === DELIVERY_RECIPIENT_REKEYED;
}

export type SearchEmailDeliveryPayload = {
  schemaVersion: 2;
  checkedAt: string;
  matchIds?: string[];
  matchRefs?: MatchRef[];
  displayMatchIds?: string[];
  recipientCatchup?: boolean;
  satisfiesStatusReport?: boolean;
  statusSnapshot?: Prisma.InputJsonValue;
  statusReport?: Prisma.InputJsonValue;
  matchReport?: Prisma.InputJsonValue;
};

export { SearchEmailDeliveryInProgressError };

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
  await rejectActiveDeliveryClaim(transaction, input.searchId, now, true);
  await finalizeOwnerOutcomesForSearch(transaction, search);
  const currentGenerationDeliveries = await transaction.searchEmailDelivery.findMany({
    where: {
      teeSearchId: input.searchId,
      alertGeneration: search.alertGeneration
    },
    select: {
      payload: true,
      status: true,
      attemptCount: true,
      sentAt: true,
      lastError: true
    }
  });
  const ambiguousDeliveries = currentGenerationDeliveries.filter(isAmbiguousDelivery);
  const ambiguouslyAttemptedMatchRefs = ambiguousDeliveries.flatMap(
    (row) => parseSearchEmailPayload(row.payload)?.matchRefs ?? []
  );
  const ambiguouslyAttemptedLegacyMatchIds = ambiguousDeliveries.flatMap((row) =>
    getLegacyMatchIds(parseSearchEmailPayload(row.payload))
  );
  await suppressPendingMatchRefs(
    transaction,
    input.searchId,
    ambiguouslyAttemptedMatchRefs,
    now
  );
  await suppressPendingMatchIds(
    transaction,
    input.searchId,
    ambiguouslyAttemptedLegacyMatchIds,
    now
  );
  await transaction.searchEmailDelivery.updateMany({
    where: {
      teeSearchId: input.searchId,
      status: "SENDING"
    },
    data: {
      status: "SUPPRESSED",
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: null,
      lastError: "DELIVERY_OUTCOME_UNKNOWN_AFTER_SEARCH_MUTATION"
    }
  });
  await transaction.searchEmailDelivery.updateMany({
    where: {
      teeSearchId: input.searchId,
      status: { in: ["PENDING", "FAILED"] }
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
  await rejectActiveDeliveryClaim(transaction, input.searchId, now, true);
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
  supersededStatusGroups?: Array<{
    kind: Extract<SearchEmailDeliveryKind, "SETUP" | "DAILY">;
    groupKey: string;
  }>;
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
    if (!matchesLockedRecipientAuthority(search, recipients, ownerRecipient)) {
      return {
        prepared: false as const,
        reason: "recipient_drift" as const,
        deliveries: []
      };
    }
    await rejectActiveDeliveryClaim(transaction, input.searchId, now);

    const inputMatchIds = [...new Set(input.payload.matchIds ?? [])];
    const inputMatchRefs = uniqueMatchRefs(input.payload.matchRefs ?? []);
    if (
      inputMatchIds.length !== inputMatchRefs.length ||
      inputMatchRefs.some((match) => !inputMatchIds.includes(match.matchId))
    ) {
      throw new Error("Delivery payload match references are incomplete");
    }

    const existing = await transaction.searchEmailDelivery.findMany({
      where: groupWhere(input)
    });
    const supersededStatusGroups =
      input.kind === "SETUP" || input.kind === "DAILY"
        ? (input.supersededStatusGroups ?? [])
        : [];
    const supersededRows =
      existing.length === 0 && supersededStatusGroups.length > 0
        ? await transaction.searchEmailDelivery.findMany({
            where: {
              teeSearchId: input.searchId,
              alertGeneration: input.alertGeneration,
              OR: supersededStatusGroups.map((group) => ({
                kind: group.kind,
                groupKey: group.groupKey
              }))
            }
          })
        : [];
    const existingMatchObligations =
      existing.length === 0 &&
      supersededStatusGroups.length > 0 &&
      inputMatchRefs.length > 0
        ? await transaction.searchEmailDelivery.findMany({
            where: {
              teeSearchId: input.searchId,
              alertGeneration: input.alertGeneration,
              recipient: { in: recipients }
            }
          })
        : [];
    const ownedMatchRefsByRecipient = new Map<string, Set<string>>();
    const ambiguousMatchRefsByRecipient = new Map<string, Set<string>>();
    const legacyOwnedMatchIdsByRecipient = new Map<string, Set<string>>();
    for (const delivery of existingMatchObligations) {
      const deliveryPayload = parseSearchEmailPayload(delivery.payload);
      const deliveryMatchRefs = deliveryPayload?.matchRefs ?? [];
      const legacyOwnedMatchIds = getOwnedLegacyMatchIds(delivery, deliveryPayload);
      if (legacyOwnedMatchIds.length > 0) {
        const ownedMatchIds =
          legacyOwnedMatchIdsByRecipient.get(delivery.recipient) ?? new Set();
        for (const matchId of legacyOwnedMatchIds) {
          ownedMatchIds.add(matchId);
        }
        legacyOwnedMatchIdsByRecipient.set(delivery.recipient, ownedMatchIds);
      }
      if (
        isAmbiguousDelivery(delivery) &&
        delivery.lastError !== STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT
      ) {
        const ambiguousMatchRefs =
          ambiguousMatchRefsByRecipient.get(delivery.recipient) ?? new Set();
        for (const matchRef of deliveryMatchRefs) {
          ambiguousMatchRefs.add(toMatchRefKey(matchRef));
        }
        ambiguousMatchRefsByRecipient.set(
          delivery.recipient,
          ambiguousMatchRefs
        );
      }
      if (!deliveryOwnsExistingMatchObligation(delivery)) {
        continue;
      }
      const ownedMatchRefs =
        ownedMatchRefsByRecipient.get(delivery.recipient) ?? new Set();
      for (const matchRef of deliveryMatchRefs) {
        ownedMatchRefs.add(toMatchRefKey(matchRef));
      }
      ownedMatchRefsByRecipient.set(delivery.recipient, ownedMatchRefs);
    }
    const supersededRowsByRecipient = new Map<
      string,
      Array<(typeof supersededRows)[number]>
    >();
    for (const delivery of supersededRows) {
      const recipient = delivery.isOwnerRecipient
        ? ownerRecipient
        : normalizeRecipient(delivery.recipient);
      if (!recipients.includes(recipient)) {
        continue;
      }
      const recipientRows = supersededRowsByRecipient.get(recipient) ?? [];
      recipientRows.push(delivery);
      supersededRowsByRecipient.set(recipient, recipientRows);
    }
    const replacementStateByRecipient = new Map<
      string,
      { state: "PRIOR_REACHED" | "AMBIGUOUS_ATTEMPT"; sentAt: Date | null }
    >();
    for (const [recipient, recipientRows] of supersededRowsByRecipient) {
      const latestSentAt = recipientRows.reduce<Date | null>((latest, delivery) => {
        if (!delivery.sentAt) {
          return latest;
        }
        return !latest || delivery.sentAt > latest ? delivery.sentAt : latest;
      }, null);
      if (
        recipientRows.some(
          (delivery) =>
            isReachedDelivery(delivery) ||
            delivery.lastError === STATUS_RECIPIENT_PRIOR_REACHED
        )
      ) {
        replacementStateByRecipient.set(recipient, {
          state: "PRIOR_REACHED",
          sentAt: latestSentAt
        });
      } else if (
        recipientRows.some(
          (delivery) =>
            isAmbiguousDelivery(delivery) ||
            (!canSafelyRekeyDelivery(delivery) && delivery.status === "SUPPRESSED")
        )
      ) {
        replacementStateByRecipient.set(recipient, {
          state: "AMBIGUOUS_ATTEMPT",
          sentAt: null
        });
      }
    }
    let persistedPayload =
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

    const groupFrozen = existing.some(
      (delivery) =>
        delivery.attemptCount > 0 ||
        delivery.status === "SENDING" ||
        delivery.status === "SENT" ||
        (delivery.status === "SUPPRESSED" && Boolean(delivery.sentAt))
    );
    if (
      existing.length > 0 &&
      !groupFrozen &&
      canonicalJson(persistedPayload) !== canonicalJson(input.payload)
    ) {
      const rewritten = await transaction.searchEmailDelivery.updateMany({
        where: {
          id: { in: existing.map((delivery) => delivery.id) },
          attemptCount: 0,
          status: { notIn: ["SENDING", "SENT"] }
        },
        data: { payload: input.payload }
      });
      if (rewritten.count !== existing.length) {
        throw new SearchEmailDeliveryInProgressError(
          new Date(now.getTime() + DELIVERY_RETRY_BASE_MS)
        );
      }
      persistedPayload = input.payload;
    }

    const reactivatableIds = existing
      .filter(
        (delivery) =>
          delivery.status === "SUPPRESSED" &&
          !delivery.sentAt &&
          delivery.attemptCount === 0
      )
      .map((delivery) => delivery.id);
    if (reactivatableIds.length > 0) {
      await transaction.searchEmailDelivery.updateMany({
        where: {
          id: { in: reactivatableIds },
          status: "SUPPRESSED",
          sentAt: null,
          attemptCount: 0
        },
        data: {
          status: "PENDING",
          claimToken: null,
          claimExpiresAt: null,
          nextAttemptAt: null,
          lastError: null
        }
      });
    }

    const continuationGroups: Array<{ groupKey: string }> = [];
    const existingRecipients = new Set(existing.map((delivery) => delivery.recipient));
    for (const recipient of recipients) {
      if (existingRecipients.has(recipient)) {
        continue;
      }
      const replacementState = replacementStateByRecipient.get(recipient);
      await transaction.searchEmailDelivery.create({
        data: {
          teeSearchId: input.searchId,
          alertGeneration: input.alertGeneration,
          kind: input.kind,
          groupKey: input.groupKey,
          recipient,
          isOwnerRecipient: recipient === ownerRecipient,
          payload: persistedPayload,
          ...(replacementState?.state === "PRIOR_REACHED"
            ? {
                status: "SUPPRESSED" as const,
                sentAt: replacementState.sentAt,
                lastError: STATUS_RECIPIENT_PRIOR_REACHED
              }
            : replacementState?.state === "AMBIGUOUS_ATTEMPT"
              ? {
                  status: "SUPPRESSED" as const,
                  sentAt: null,
                  lastError: STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT
                }
            : {})
        }
      });

      if (replacementState && inputMatchRefs.length > 0) {
        const ownedMatchRefs = ownedMatchRefsByRecipient.get(recipient) ?? new Set();
        const legacyOwnedMatchIds =
          legacyOwnedMatchIdsByRecipient.get(recipient) ?? new Set();
        const uncoveredMatchRefs = inputMatchRefs.filter(
          (match) =>
            !ownedMatchRefs.has(toMatchRefKey(match)) &&
            !legacyOwnedMatchIds.has(match.matchId)
        );
        const continuationPayload = createMatchContinuationFromStatusPayload(
          input.payload,
          uncoveredMatchRefs
        );
        if (continuationPayload) {
          const continuation = await createRecipientMatchDeliveryRow(transaction, {
            searchId: input.searchId,
            alertGeneration: input.alertGeneration,
            sourceGroupKey: input.groupKey,
            recipient,
            isOwnerRecipient: recipient === ownerRecipient,
            payload: continuationPayload
          });
          continuationGroups.push({ groupKey: continuation.groupKey });
        }
        if (recipient === ownerRecipient) {
          const ambiguousMatchRefs =
            ambiguousMatchRefsByRecipient.get(recipient) ?? new Set();
          await suppressPendingMatchRefs(
            transaction,
            input.searchId,
            inputMatchRefs.filter((match) =>
              ambiguousMatchRefs.has(toMatchRefKey(match))
            ),
            now
          );
          await suppressPendingMatchRefs(
            transaction,
            input.searchId,
            inputMatchRefs.filter((match) =>
              legacyOwnedMatchIds.has(match.matchId)
            ),
            now
          );
        }
      }
    }

    const deliveries = await transaction.searchEmailDelivery.findMany({
      where: groupWhere(input),
      orderBy: [{ isOwnerRecipient: "desc" }, { recipient: "asc" }]
    });
    if (deliveries.length !== recipients.length) {
      throw new Error("Delivery group recipient set is incomplete");
    }
    assertIdenticalGroupPayloads(deliveries);
    if (supersededStatusGroups.length > 0) {
      await transaction.searchEmailDelivery.updateMany({
        where: {
          teeSearchId: input.searchId,
          alertGeneration: input.alertGeneration,
          lastError: STALE_STATUS_REPLACEMENT_PENDING,
          OR: supersededStatusGroups.map((group) => ({
            kind: group.kind,
            groupKey: group.groupKey
          }))
        },
        data: { lastError: STALE_STATUS_REPLACED }
      });
      await transaction.searchEmailDelivery.updateMany({
        where: {
          teeSearchId: input.searchId,
          alertGeneration: input.alertGeneration,
          lastError: STALE_STATUS_REPLACEMENT_PENDING_AMBIGUOUS,
          OR: supersededStatusGroups.map((group) => ({
            kind: group.kind,
            groupKey: group.groupKey
          }))
        },
        data: { lastError: STALE_STATUS_REPLACED_AMBIGUOUS }
      });
    }
    return { prepared: true as const, deliveries, continuationGroups };
  });
}

export async function prepareRecipientMatchDeliveryGroups(input: {
  searchId: string;
  alertGeneration: number;
  checkLeaseToken: string;
  sourceGroupKey: string;
  recipients: string[];
  ownerRecipient: string;
  payload: SearchEmailDeliveryPayload;
  now?: Date;
}) {
  assertSafeSearchEmailPayload(input.payload);
  const now = input.now ?? new Date();
  const recipients = normalizeRecipients(input.recipients);
  const ownerRecipient = normalizeRecipient(input.ownerRecipient);
  const matchRefs = uniqueMatchRefs(input.payload.matchRefs ?? []);
  const matchIds = [...new Set(input.payload.matchIds ?? [])];
  if (
    !ownerRecipient ||
    !recipients.includes(ownerRecipient) ||
    matchRefs.length === 0 ||
    matchRefs.length !== matchIds.length ||
    matchRefs.some((match) => !matchIds.includes(match.matchId))
  ) {
    throw new Error("Recipient match delivery input is incomplete");
  }

  return prisma.$transaction(async (transaction) => {
    const [search] = await lockSearchRow(transaction, input.searchId);
    if (!isCurrentDeliverySearch(search, input, now)) {
      return { prepared: false as const, reason: "stale_search" as const, groups: [] };
    }
    if (!matchesLockedRecipientAuthority(search, recipients, ownerRecipient)) {
      return {
        prepared: false as const,
        reason: "recipient_drift" as const,
        groups: []
      };
    }
    const existing = await transaction.searchEmailDelivery.findMany({
      where: {
        teeSearchId: input.searchId,
        alertGeneration: input.alertGeneration,
        recipient: { in: recipients }
      }
    });
    const groups: Array<{ groupKey: string; recipient: string }> = [];
    let hasExistingObligation = false;
    for (const recipient of recipients) {
      const ownedRefs = new Set<string>();
      const ambiguousOwnedRefs = new Set<string>();
      const legacyOwnedMatchIds = new Set<string>();
      for (const delivery of existing) {
        if (
          delivery.recipient !== recipient ||
          !deliveryOwnsExistingMatchObligation(delivery)
        ) {
          continue;
        }
        const deliveryPayload = parseSearchEmailPayload(delivery.payload);
        for (const matchRef of deliveryPayload?.matchRefs ?? []) {
          ownedRefs.add(toMatchRefKey(matchRef));
          if (isAmbiguousDelivery(delivery)) {
            ambiguousOwnedRefs.add(toMatchRefKey(matchRef));
          }
        }
        for (const matchId of getOwnedLegacyMatchIds(delivery, deliveryPayload)) {
          legacyOwnedMatchIds.add(matchId);
        }
      }
      const uncoveredRefs = matchRefs.filter(
        (match) =>
          !ownedRefs.has(toMatchRefKey(match)) &&
          !legacyOwnedMatchIds.has(match.matchId)
      );
      if (uncoveredRefs.length < matchRefs.length) {
        hasExistingObligation = true;
      }
      if (recipient === ownerRecipient && legacyOwnedMatchIds.size > 0) {
        await suppressPendingMatchRefs(
          transaction,
          input.searchId,
          matchRefs.filter((match) => legacyOwnedMatchIds.has(match.matchId)),
          now
        );
      }
      if (recipient === ownerRecipient && ambiguousOwnedRefs.size > 0) {
        await suppressPendingMatchRefs(
          transaction,
          input.searchId,
          matchRefs.filter((match) =>
            ambiguousOwnedRefs.has(toMatchRefKey(match))
          ),
          now
        );
      }
      const payload = filterMatchDeliveryPayload(input.payload, uncoveredRefs);
      if (!payload) {
        continue;
      }
      const created = await createRecipientMatchDeliveryRow(transaction, {
        searchId: input.searchId,
        alertGeneration: input.alertGeneration,
        sourceGroupKey: input.sourceGroupKey,
        recipient,
        isOwnerRecipient: recipient === ownerRecipient,
        payload
      });
      groups.push({ groupKey: created.groupKey, recipient });
    }
    return { prepared: true as const, groups, hasExistingObligation };
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
      createdAt: true,
      isOwnerRecipient: true
    },
    orderBy: { createdAt: "asc" }
  });
  const groups = new Map<
    string,
    {
      kind: SearchEmailDeliveryKind;
      groupKey: string;
      createdAt: Date;
      ownerRetryable: boolean;
    }
  >();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.groupKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.ownerRetryable ||= row.isOwnerRecipient;
      continue;
    }
    groups.set(key, {
      kind: row.kind,
      groupKey: row.groupKey,
      createdAt: row.createdAt,
      ownerRetryable: row.isOwnerRecipient
    });
  }
  return [...groups.values()];
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
    // Call after hydration and immediately before starting the provider request.
    // A successful call is the recipient-authorization linearization point.
    assertCurrentDelivery: () => Promise<void>;
  }) => Promise<TDelivery>;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const claimNow = now();
  const pendingEmailTransition = await applyPendingClerkEmailForSearch({
    searchId: input.searchId,
    now: claimNow
  });
  const claim = await claimSearchEmailDeliveryGroup({
    ...input,
    now: claimNow,
    pendingTransitionRetryAt:
      pendingEmailTransition.outcome === "deferred"
        ? pendingEmailTransition.retryAt
        : null
  });
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
  let heartbeatError: unknown = null;
  const heartbeat = maintainSearchEmailDeliveryClaim({
    searchId: input.searchId,
    alertGeneration: input.alertGeneration,
    claimToken: claim.claimToken,
    expectedCount: claim.deliveries.length,
    signal: heartbeatController.signal
  }).catch((error) => {
    heartbeatError = error;
  });
  let results: PromiseSettledResult<{
    delivery: (typeof claim.deliveries)[number];
    result: TDelivery;
  }>[];
  try {
    results = await Promise.allSettled(
      claim.deliveries.map(async (delivery) => {
        try {
          const assertCurrentDelivery = async () => {
            if (heartbeatError) {
              throw new EmailDeliveryNotAcceptedError(
                "Alert email delivery claim heartbeat was lost"
              );
            }
            await renewClaimedDeliveryRecipientAuthorization({
              searchId: input.searchId,
              alertGeneration: input.alertGeneration,
              claimToken: claim.claimToken,
              delivery
            });
          };
          await assertCurrentDelivery();
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
              payload: claim.payload,
              assertCurrentDelivery
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
  await applyPendingClerkEmailForSearch({ searchId: input.searchId, now: now() });
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
      status:
        outcome.ownerSent ||
        ("recipientCatchup" in outcome && outcome.recipientCatchup && outcome.groupSent)
          ? ("SENT" as const)
          : ("SUPPRESSED" as const),
      ownerSent: outcome.ownerSent,
      ownerDeliveryOutcome:
        "ownerDeliveryOutcome" in outcome ? outcome.ownerDeliveryOutcome : null,
      retainedMatchCount: outcome.retainedMatchCount,
      sentMatchCount: outcome.ownerSent ? outcome.retainedMatchCount : 0
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
      ownerSent: false,
      retainedMatchCount: 0
    };
  }
  const payload = assertIdenticalGroupPayloads(deliveries);
  const ownerRecipient = search
    ? getLockedRecipientAuthority(search)?.ownerRecipient
    : undefined;
  const ownerDeliveries = ownerRecipient
    ? deliveries.filter(
        (delivery) => normalizeRecipient(delivery.recipient) === ownerRecipient
      )
    : [];
  const groupComplete = deliveries.every(
    (delivery) => delivery.status === "SENT" || delivery.status === "SUPPRESSED"
  );
  if (payload.recipientCatchup === true && ownerDeliveries.length === 0) {
    return {
      reason: null,
      groupComplete,
      ownerFinalized: true,
      ownerSent: false,
      retainedMatchCount: 0,
      recipientCatchup: true as const,
      groupSent: deliveries.some((delivery) => delivery.status === "SENT")
    };
  }
  if (ownerDeliveries.length !== 1) {
    return {
      reason: "invalid_owner" as const,
      groupComplete: false,
      ownerFinalized: false,
      ownerSent: false,
      retainedMatchCount: 0
    };
  }
  const ownerDelivery = ownerDeliveries[0];
  const ownerSent = ownerDelivery.status === "SENT";
  const ownerDeliveryOutcome = ownerSent
    ? ("SENT" as const)
    : isDeliveryDryRun(ownerDelivery)
      ? ("DRY_RUN" as const)
      : ownerDelivery.lastError === STATUS_RECIPIENT_PRIOR_REACHED
        ? ("PRIOR_REACHED" as const)
        : isAmbiguousDelivery(ownerDelivery)
          ? ("AMBIGUOUS" as const)
          : ("SAFETY_SUPPRESSED" as const);
  const ownerFinalized =
    ownerSent || ownerDelivery.status === "SUPPRESSED";
  if (!ownerFinalized) {
    return {
      reason: null,
      groupComplete,
      ownerFinalized,
      ownerSent,
      ownerDeliveryOutcome,
      retainedMatchCount: 0
    };
  }

  const terminalStatus = ownerSent ? "SENT" : "SUPPRESSED";
  const sentAt = ownerDelivery.sentAt ?? new Date(payload.checkedAt);
  const ownerCoveredCurrentPayload =
    ownerDeliveryOutcome === "SENT" ||
    ownerDeliveryOutcome === "DRY_RUN";
  const coveredMatchIdSet = new Set(payload.matchIds ?? []);
  const terminalMatchRefs = ownerCoveredCurrentPayload
    ? uniqueMatchRefs(
        (payload.matchRefs ?? []).filter((match) =>
          coveredMatchIdSet.has(match.matchId)
        )
      )
    : [];
  if (terminalMatchRefs.length > 0) {
    await transaction.teeTimeMatch.updateMany({
      where: {
        teeSearchId: input.searchId,
        OR: terminalMatchRefs.map((match) => ({
          id: match.matchId,
          availabilityCycle: match.availabilityCycle
        })),
        alertStatus: "PENDING",
        ...(input.kind === "MATCH" ? { availabilityStatus: "AVAILABLE" } : {})
      },
      data: { alertStatus: terminalStatus, sentAt }
    });
  }

  const satisfiesStatusReport =
    input.kind === "SETUP" ||
    input.kind === "DAILY" ||
    (input.kind === "MATCH" &&
      payload.satisfiesStatusReport === true &&
      terminalMatchRefs.length > 0);
  if (
    (ownerSent || ownerDeliveryOutcome === "DRY_RUN") &&
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
  } else if (
    ownerDeliveryOutcome === "AMBIGUOUS" &&
    (input.kind === "SETUP" || input.kind === "DAILY") &&
    search?.alertGeneration === input.alertGeneration
  ) {
    await transaction.teeSearch.updateMany({
      where: { id: input.searchId, alertGeneration: input.alertGeneration },
      data: { statusEmailSentAt: sentAt }
    });
  }
  return {
    reason: null,
    groupComplete,
    ownerFinalized,
    ownerSent,
    ownerDeliveryOutcome,
    retainedMatchCount: terminalMatchRefs.length
  };
}

export async function suppressSearchEmailDeliveriesForMatches(input: {
  searchId: string;
  alertGeneration: number;
  checkLeaseToken: string;
  matchRefs: MatchRef[];
  now?: Date;
  transaction?: DeliveryTransaction;
}) {
  const matchRefs = uniqueMatchRefs(input.matchRefs ?? []);
  if (matchRefs.length === 0) {
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
    const serializedMatchRefs = JSON.stringify(matchRefs);
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH target_refs AS (
        SELECT *
        FROM jsonb_to_recordset(${serializedMatchRefs}::jsonb)
          AS target_ref("matchId" text, "availabilityCycle" integer)
      ), affected_groups AS (
        SELECT DISTINCT "alertGeneration", "groupKey", "kind"
        FROM "SearchEmailDelivery"
        WHERE "teeSearchId" = ${input.searchId}
          AND "alertGeneration" = ${input.alertGeneration}
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              COALESCE("payload"->'matchRefs', '[]'::jsonb)
            ) AS match_ref
            JOIN target_refs
              ON match_ref->>'matchId' = target_refs."matchId"
             AND match_ref->>'availabilityCycle' = target_refs."availabilityCycle"::text
          )
      )
      UPDATE "SearchEmailDelivery" AS delivery
      SET
        "status" = 'SUPPRESSED'::"SearchEmailDeliveryStatus",
        "claimToken" = NULL,
        "claimExpiresAt" = NULL,
        "nextAttemptAt" = NULL,
        "lastError" = ${MATCH_STALE_REKEYED},
        "updatedAt" = ${input.now ?? new Date()}
      FROM affected_groups
      WHERE delivery."teeSearchId" = ${input.searchId}
        AND delivery."kind" = affected_groups."kind"
        AND delivery."alertGeneration" = affected_groups."alertGeneration"
        AND delivery."groupKey" = affected_groups."groupKey"
        AND delivery."status" IN (
          'PENDING'::"SearchEmailDeliveryStatus",
          'FAILED'::"SearchEmailDeliveryStatus",
          'SENDING'::"SearchEmailDeliveryStatus"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "SearchEmailDelivery" AS frozen_delivery
          WHERE frozen_delivery."teeSearchId" = delivery."teeSearchId"
            AND frozen_delivery."alertGeneration" = delivery."alertGeneration"
            AND frozen_delivery."kind" = delivery."kind"
            AND frozen_delivery."groupKey" = delivery."groupKey"
            AND (
              frozen_delivery."attemptCount" > 0
              OR frozen_delivery."status" IN (
                'SENDING'::"SearchEmailDeliveryStatus",
                'SENT'::"SearchEmailDeliveryStatus"
              )
              OR (
                frozen_delivery."status" = 'SUPPRESSED'::"SearchEmailDeliveryStatus"
                AND frozen_delivery."sentAt" IS NOT NULL
              )
              OR frozen_delivery."payload" @> '{"recipientCatchup":true}'::jsonb
            )
        )
      RETURNING delivery."id"
    `);
    const matches = await transaction.teeTimeMatch.updateMany({
      where: {
        teeSearchId: input.searchId,
        OR: matchRefs.map((match) => ({
          id: match.matchId,
          availabilityCycle: match.availabilityCycle
        })),
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
  if (!getSafeCustomerBookingUrl(value)) {
    throw new Error("Search email delivery booking URL is not a safe public URL");
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
  pendingTransitionRetryAt: Date | null;
}) {
  return prisma.$transaction(async (transaction) => {
    const [search] = await lockSearchRow(transaction, input.searchId);
    let deliveries = await transaction.searchEmailDelivery.findMany({
      where: groupWhere(input),
      orderBy: [{ isOwnerRecipient: "desc" }, { recipient: "asc" }]
    });
    if (deliveries.length === 0) {
      return { outcome: "suppressed" as const, deliveries: [] };
    }
    if (search?.ownerPendingEmail) {
      const retryAt =
        input.pendingTransitionRetryAt && input.pendingTransitionRetryAt > input.now
          ? input.pendingTransitionRetryAt
          : new Date(input.now.getTime() + DELIVERY_RETRY_BASE_MS);
      await requestDeliveryRetry(
        transaction,
        input.searchId,
        input.alertGeneration,
        retryAt
      );
      return { outcome: "deferred" as const, retryAt };
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

    const authority = search ? getLockedRecipientAuthority(search) : null;
    if (!authority) {
      await suppressRetryableGroupRows(
        transaction,
        deliveries,
        DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED
      );
      const suppressed = await transaction.searchEmailDelivery.findMany({
        where: groupWhere(input)
      });
      return { outcome: "suppressed" as const, deliveries: suppressed };
    }

    const promoteToOwnerIds = deliveries
      .filter(
        (delivery) =>
          normalizeRecipient(delivery.recipient) === authority.ownerRecipient &&
          !delivery.isOwnerRecipient
      )
      .map((delivery) => delivery.id);
    const demotedOwnerRows = deliveries.filter(
      (delivery) =>
        delivery.isOwnerRecipient &&
        authority.additionalRecipients.has(normalizeRecipient(delivery.recipient))
    );
    const demoteToAdditionalIds = demotedOwnerRows.map((delivery) => delivery.id);
    if (promoteToOwnerIds.length > 0) {
      await transaction.searchEmailDelivery.updateMany({
        where: { id: { in: promoteToOwnerIds } },
        data: { isOwnerRecipient: true }
      });
    }
    if (demoteToAdditionalIds.length > 0) {
      await transaction.searchEmailDelivery.updateMany({
        where: { id: { in: demoteToAdditionalIds } },
        data: { isOwnerRecipient: false }
      });
    }
    if (promoteToOwnerIds.length > 0 || demoteToAdditionalIds.length > 0) {
      deliveries = await transaction.searchEmailDelivery.findMany({
        where: groupWhere(input),
        orderBy: [{ isOwnerRecipient: "desc" }, { recipient: "asc" }]
      });
    }

    const staleRecipientDeliveries = deliveries.filter(
      (delivery) =>
        !isRecipientAuthorityRetired(delivery) &&
        !isDeliveryAuthorizedForLockedSearch(search!, delivery)
    );
    if (staleRecipientDeliveries.length > 0 || demotedOwnerRows.length > 0) {
      const staleOwnerIsUncertain =
        staleRecipientDeliveries.some(
          (delivery) =>
            delivery.isOwnerRecipient &&
            !canSafelyRekeyDelivery(delivery) &&
            !isDeliveryDryRun(delivery)
        ) ||
        demotedOwnerRows.some(
          (delivery) =>
            !canSafelyRekeyDelivery(delivery) && !isDeliveryDryRun(delivery)
        );
      if (staleOwnerIsUncertain) {
        if (input.kind === "MATCH") {
          await suppressPendingMatchRefs(
            transaction,
            input.searchId,
            payload.matchRefs ?? [],
            input.now
          );
          await suppressPendingMatchIds(
            transaction,
            input.searchId,
            getLegacyMatchIds(payload),
            input.now
          );
        }
        const currentOwnerRows = deliveries.filter(
          (delivery) =>
            normalizeRecipient(delivery.recipient) === authority.ownerRecipient
        );
        const currentOwnerRetryableIds = currentOwnerRows
          .filter(
            (delivery) =>
              delivery.status !== "SENT" && delivery.status !== "SUPPRESSED"
          )
          .map((delivery) => delivery.id);
        if (currentOwnerRetryableIds.length > 0) {
          await transaction.searchEmailDelivery.updateMany({
            where: { id: { in: currentOwnerRetryableIds } },
            data: {
              status: "SUPPRESSED",
              claimToken: null,
              claimExpiresAt: null,
              nextAttemptAt: null,
              lastError:
                input.kind === "MATCH"
                  ? MATCH_STALE_REKEY_BLOCKED
                  : STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT
            }
          });
        }
        if (currentOwnerRows.length === 0) {
          if (input.kind === "MATCH" && (payload.matchRefs?.length ?? 0) > 0) {
            await createRecipientMatchDeliveryRow(transaction, {
              searchId: input.searchId,
              alertGeneration: input.alertGeneration,
              sourceGroupKey: input.groupKey,
              recipient: authority.ownerRecipient,
              isOwnerRecipient: true,
              payload: { ...payload, satisfiesStatusReport: false },
              terminalLastError: MATCH_STALE_REKEY_BLOCKED
            });
          } else if (input.kind !== "MATCH") {
            await transaction.searchEmailDelivery.create({
              data: {
                teeSearchId: input.searchId,
                alertGeneration: input.alertGeneration,
                kind: input.kind,
                groupKey: input.groupKey,
                recipient: authority.ownerRecipient,
                isOwnerRecipient: true,
                payload,
                status: "SUPPRESSED",
                lastError: STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT
              }
            });
          }
        }
        await transaction.searchEmailDelivery.updateMany({
          where: {
            id: {
              in: staleRecipientDeliveries
                .filter(
                  (delivery) =>
                    delivery.status !== "SENT" &&
                    delivery.status !== "SUPPRESSED"
                )
                .map((delivery) => delivery.id)
            }
          },
          data: {
            status: "SUPPRESSED",
            claimToken: null,
            claimExpiresAt: null,
            nextAttemptAt: null,
            lastError:
              input.kind === "MATCH"
                ? MATCH_STALE_REKEY_BLOCKED
                : DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED
          }
        });
      } else {
        const safelyRetiredIds = staleRecipientDeliveries
          .filter(
            (delivery) =>
              canSafelyRekeyDelivery(delivery) || isDeliveryDryRun(delivery)
          )
          .map((delivery) => delivery.id);
        const blockedIds = staleRecipientDeliveries
          .filter(
            (delivery) =>
              !canSafelyRekeyDelivery(delivery) &&
              !isDeliveryDryRun(delivery) &&
              delivery.status !== "SENT"
          )
          .map((delivery) => delivery.id);
        if (safelyRetiredIds.length > 0) {
          await transaction.searchEmailDelivery.updateMany({
            where: { id: { in: safelyRetiredIds } },
            data: {
              status: "SUPPRESSED",
              claimToken: null,
              claimExpiresAt: null,
              nextAttemptAt: null,
              lastError:
                input.kind === "MATCH"
                  ? DELIVERY_RECIPIENT_REKEYED
                  : STALE_STATUS_REPLACEMENT_PENDING
            }
          });
        }
        const safeOwnerNeedsRemap =
          staleRecipientDeliveries.some(
            (delivery) =>
              delivery.isOwnerRecipient &&
              (canSafelyRekeyDelivery(delivery) || isDeliveryDryRun(delivery))
          ) ||
          demotedOwnerRows.some(
            (delivery) =>
              canSafelyRekeyDelivery(delivery) || isDeliveryDryRun(delivery)
          );
        if (
          input.kind === "MATCH" &&
          (payload.matchRefs?.length ?? 0) > 0 &&
          safeOwnerNeedsRemap &&
          !deliveries.some(
            (delivery) =>
              normalizeRecipient(delivery.recipient) === authority.ownerRecipient &&
              delivery.isOwnerRecipient
          )
        ) {
          await createRecipientMatchDeliveryRow(transaction, {
            searchId: input.searchId,
            alertGeneration: input.alertGeneration,
            sourceGroupKey: input.groupKey,
            recipient: authority.ownerRecipient,
            isOwnerRecipient: true,
            payload: { ...payload, satisfiesStatusReport: false }
          });
        }
        if (blockedIds.length > 0) {
          await transaction.searchEmailDelivery.updateMany({
            where: { id: { in: blockedIds } },
            data: {
              status: "SUPPRESSED",
              claimToken: null,
              claimExpiresAt: null,
              nextAttemptAt: null,
              lastError: DELIVERY_RECIPIENT_NO_LONGER_AUTHORIZED
            }
          });
        }
      }
      deliveries = await transaction.searchEmailDelivery.findMany({
        where: groupWhere(input),
        orderBy: [{ isOwnerRecipient: "desc" }, { recipient: "asc" }]
      });
    }

    const groupFrozen = deliveries.some(
      (delivery) =>
        delivery.attemptCount > 0 ||
        delivery.status === "SENDING" ||
        delivery.status === "SENT" ||
        (delivery.status === "SUPPRESSED" && Boolean(delivery.sentAt))
    );

    const newerGroup =
      input.kind === "MATCH"
        ? null
        : await transaction.searchEmailDelivery.findFirst({
            where: {
              teeSearchId: input.searchId,
              alertGeneration: input.alertGeneration,
              kind: input.kind,
              groupKey: { not: input.groupKey },
              createdAt: { gt: deliveries[0].createdAt },
              NOT: {
                status: "SUPPRESSED",
                sentAt: null
              }
            },
            select: { id: true }
          });
    const deliveryContextCurrent = Boolean(
      isCurrentDeliverySearch(search, input, input.now) &&
        (!newerGroup || groupFrozen)
    );
    if (!deliveryContextCurrent) {
      await suppressRetryableGroupRows(transaction, deliveries);
      const suppressed = await transaction.searchEmailDelivery.findMany({
        where: groupWhere(input)
      });
      return { outcome: "suppressed" as const, deliveries: suppressed };
    }

    const ownerSent = deliveries.some(
      (delivery) => delivery.isOwnerRecipient && delivery.status === "SENT"
    );
    let claimPayload = payload;

    if (input.kind === "MATCH") {
      const overlapsRetired = await retireOverlappingMatchRecipientRows(
        transaction,
        {
          searchId: input.searchId,
          alertGeneration: input.alertGeneration,
          groupKey: input.groupKey,
          payload,
          deliveries,
          now: input.now
        }
      );
      if (overlapsRetired) {
        deliveries = await transaction.searchEmailDelivery.findMany({
          where: groupWhere(input),
          orderBy: [{ isOwnerRecipient: "desc" }, { recipient: "asc" }]
        });
      }

      const reconciliation = await reconcileCurrentMatchDeliveryPayload(
        transaction,
        input.searchId,
        payload,
        input.now,
        groupFrozen
      );
      if (!reconciliation.valid) {
        await suppressRetryableGroupRows(
          transaction,
          deliveries,
          groupFrozen ? MATCH_STALE_REKEY_BLOCKED : MATCH_STALE_REKEYED
        );
        if (groupFrozen && !ownerSent) {
          await suppressPendingMatchRefs(
            transaction,
            input.searchId,
            payload.matchRefs ?? [],
            input.now
          );
        }
        const suppressed = await transaction.searchEmailDelivery.findMany({
          where: groupWhere(input)
        });
        return { outcome: "suppressed" as const, deliveries: suppressed };
      }

      if (reconciliation.terminalMatchIds.length > 0) {
        await terminalizeMatchEvidence(
          transaction,
          input.searchId,
          reconciliation.terminalMatchRefs,
          input.now
        );
      }

      if (
        groupFrozen &&
        (reconciliation.terminalMatchIds.length > 0 ||
          reconciliation.staleMatchIds.length > 0 ||
          reconciliation.contentChanged)
      ) {
        let ownerContinuationCreated = false;
        if (
          reconciliation.confirmedMatchIds.length > 0 &&
          reconciliation.payload
        ) {
          const continuation = await createRecipientMatchCatchups(transaction, {
            searchId: input.searchId,
            alertGeneration: input.alertGeneration,
            sourceGroupKey: input.groupKey,
            deliveries,
            payload: reconciliation.payload,
            matchCycles: reconciliation.confirmedMatchCycles,
            now: input.now
          });
          ownerContinuationCreated = continuation.ownerContinuationCreated;
        }
        if (reconciliation.transientMatchRefs.length > 0) {
          const transientPayload = filterMatchDeliveryPayload(
            payload,
            reconciliation.transientMatchRefs,
            { satisfiesStatusReport: false }
          );
          if (transientPayload) {
            const continuation = await createRecipientMatchCatchups(transaction, {
              searchId: input.searchId,
              alertGeneration: input.alertGeneration,
              sourceGroupKey: input.groupKey,
              deliveries,
              payload: transientPayload,
              matchCycles: reconciliation.transientMatchRefs,
              now: input.now
            });
            ownerContinuationCreated =
              ownerContinuationCreated || continuation.ownerContinuationCreated;
          }
        }
        await retireStaleMatchGroupRows(transaction, deliveries);
        const sourceHasOwner = deliveries.some(
          (delivery) => delivery.isOwnerRecipient
        );
        if (sourceHasOwner && !ownerSent && !ownerContinuationCreated) {
          await suppressPendingMatchRefs(
            transaction,
            input.searchId,
            payload.matchRefs ?? [],
            input.now
          );
        }
        const suppressed = await transaction.searchEmailDelivery.findMany({
          where: groupWhere(input)
        });
        return { outcome: "suppressed" as const, deliveries: suppressed };
      }

      if (groupFrozen && reconciliation.transientMatchIds.length > 0) {
        const retryAt = getEvidenceRetryAt(deliveries, input.now);
        await requestDeliveryRetry(
          transaction,
          input.searchId,
          input.alertGeneration,
          retryAt
        );
        return { outcome: "deferred" as const, retryAt };
      }

      if (reconciliation.confirmedMatchIds.length === 0) {
        if (reconciliation.transientMatchIds.length > 0) {
          const retryAt = getEvidenceRetryAt(deliveries, input.now);
          await requestDeliveryRetry(
            transaction,
            input.searchId,
            input.alertGeneration,
            retryAt
          );
          return { outcome: "deferred" as const, retryAt };
        }
        await suppressRetryableGroupRows(transaction, deliveries);
        const suppressed = await transaction.searchEmailDelivery.findMany({
          where: groupWhere(input)
        });
        return { outcome: "suppressed" as const, deliveries: suppressed };
      }

      if (!groupFrozen && reconciliation.payload) {
        claimPayload = reconciliation.payload;
        if (canonicalJson(claimPayload) !== canonicalJson(payload)) {
          const rewritten = await transaction.searchEmailDelivery.updateMany({
            where: {
              id: { in: deliveries.map((delivery) => delivery.id) },
              attemptCount: 0,
              status: { notIn: ["SENDING", "SENT"] }
            },
            data: { payload: claimPayload }
          });
          if (rewritten.count !== deliveries.length) {
            throw new SearchEmailDeliveryInProgressError(
              new Date(input.now.getTime() + DELIVERY_RETRY_BASE_MS)
            );
          }
        }
      }
    } else {
      const statusState = await validateCurrentStatusDeliveryPayload(
        transaction,
        input.searchId,
        payload,
        input.now
      );
      if (statusState !== "current") {
        await retireStaleStatusGroupRows(transaction, deliveries, {
          searchId: input.searchId,
          alertGeneration: input.alertGeneration,
          now: input.now
        });
        const suppressed = await transaction.searchEmailDelivery.findMany({
          where: groupWhere(input)
        });
        return { outcome: "suppressed" as const, deliveries: suppressed };
      }
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
      payload: claimPayload,
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
      const failureMarker =
        status === "FAILED" ? getDeliveryFailureMarker(rejectedError) : null;
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
            status === "FAILED"
              ? failureMarker
              : status === "SUPPRESSED"
                ? DELIVERY_DRY_RUN
                : null
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
    const extended = await prisma.$executeRaw(Prisma.sql`
      UPDATE "SearchEmailDelivery"
      SET "claimExpiresAt" = statement_timestamp()
        + (${DELIVERY_CLAIM_MS} * INTERVAL '1 millisecond')
      WHERE "teeSearchId" = ${input.searchId}
        AND "alertGeneration" = ${input.alertGeneration}
        AND "status" = 'SENDING'
        AND "claimToken" = ${input.claimToken}
        AND "claimExpiresAt" > statement_timestamp()
    `);
    if (extended !== input.expectedCount) {
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
  now: Date,
  allowExpired = false
) {
  const inFlight = await transaction.searchEmailDelivery.findFirst({
    where: {
      teeSearchId: searchId,
      status: "SENDING",
      ...(allowExpired ? { claimExpiresAt: { gt: now } } : {})
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

async function reconcileCurrentMatchDeliveryPayload(
  transaction: DeliveryTransaction,
  searchId: string,
  payload: SearchEmailDeliveryPayload,
  now: Date,
  groupFrozen: boolean
): Promise<MatchPayloadReconciliation> {
  const invalid = (): MatchPayloadReconciliation => ({
    valid: false,
    contentChanged: false,
    confirmedMatchIds: [],
    terminalMatchIds: [],
    terminalMatchRefs: [],
    staleMatchIds: [],
    transientMatchIds: [],
    transientMatchRefs: [],
    confirmedMatchCycles: [],
    payload: null
  });
  const report = optionalJsonRecord(payload.matchReport);
  if (!report) {
    return invalid();
  }
  const rawPersistedMatches = Array.isArray(report.matches) ? report.matches : [];
  const persistedMatches = rawPersistedMatches
    .map((value) => ({
      value,
      row: optionalJsonRecord(value)
    }))
    .filter(
      (match): match is { value: unknown; row: Record<string, unknown> } =>
        Boolean(match.row)
    )
    .map(({ value, row }) => ({
      value,
      row,
      matchId: optionalString(row.matchId),
      courseId: optionalString(row.courseId)
    }))
    .filter(
      (
        match
      ): match is {
        value: unknown;
        row: Record<string, unknown>;
        matchId: string;
        courseId: string;
      } =>
        Boolean(match.matchId && match.courseId)
    );
  const rawMatchIds = payload.matchIds ?? [];
  const rawMatchRefs = payload.matchRefs ?? [];
  const rawDisplayMatchIds = payload.displayMatchIds ?? [];
  const requestedMatchIds = [...new Set(rawMatchIds)];
  const requestedDisplayMatchIds = [...new Set(rawDisplayMatchIds)];
  const persistedMatchIds = persistedMatches.map((match) => match.matchId);
  if (
    requestedMatchIds.length === 0 ||
    requestedDisplayMatchIds.length === 0 ||
    requestedMatchIds.length !== rawMatchIds.length ||
    new Set(rawMatchRefs.map(toMatchRefKey)).size !== rawMatchRefs.length ||
    rawMatchRefs.some((match) => !requestedMatchIds.includes(match.matchId)) ||
    requestedDisplayMatchIds.length !== rawDisplayMatchIds.length ||
    persistedMatches.length !== rawPersistedMatches.length ||
    new Set(persistedMatchIds).size !== persistedMatchIds.length ||
    persistedMatchIds.length !== requestedDisplayMatchIds.length ||
    requestedMatchIds.some((matchId) => !requestedDisplayMatchIds.includes(matchId)) ||
    requestedDisplayMatchIds.some((matchId) => !persistedMatchIds.includes(matchId))
  ) {
    return invalid();
  }
  const matches = await transaction.teeTimeMatch.findMany({
    where: {
      id: { in: requestedDisplayMatchIds },
      teeSearchId: searchId
    },
    select: {
      id: true,
      courseId: true,
      alertStatus: true,
      availabilityStatus: true,
      availabilityCycle: true,
      startsAt: true,
      availableSpots: true,
      bookingUrl: true,
      priceCents: true,
      holes: true
    }
  });
  const persistedCourseIds = [
    ...new Set(persistedMatches.map((match) => match.courseId))
  ];
  const courses = await transaction.course.findMany({
    where: { id: { in: persistedCourseIds } },
    select: {
      id: true,
      name: true,
      address: true,
      timeZone: true,
      isPublic: true,
      bookingMethod: true,
      automationEligibility: true,
      automationReason: true,
      intelligenceVerifiedAt: true,
      intelligenceReviewAt: true,
      intelligenceConfidence: true
    }
  });
  const latestProbeByCourse = await getLatestCourseProbeByCourse(
    transaction,
    searchId,
    persistedCourseIds
  );
  const courseById = new Map(courses.map((course) => [course.id, course]));
  const currentMatchById = new Map(matches.map((match) => [match.id, match]));
  const requestedMatchIdSet = new Set(requestedMatchIds);
  const requestedMatchRefById = new Map(
    (payload.matchRefs ?? []).map((match) => [match.matchId, match] as const)
  );
  const confirmedDisplayMatchIds: string[] = [];
  const terminalMatchIds: string[] = [];
  const staleMatchIds: string[] = [];
  const transientMatchIds: string[] = [];
  const currentValueByMatchId = new Map<string, Prisma.InputJsonValue>();
  for (const persisted of persistedMatches) {
    const course = courseById.get(persisted.courseId);
    const current = currentMatchById.get(persisted.matchId);
    if (!course || !current) {
      terminalMatchIds.push(persisted.matchId);
      continue;
    }
    if (current.courseId !== persisted.courseId) {
      staleMatchIds.push(persisted.matchId);
      continue;
    }
    const requestedRef = requestedMatchRefById.get(persisted.matchId);
    if (
      requestedMatchIdSet.has(persisted.matchId) &&
      requestedRef &&
      requestedRef.availabilityCycle !== current.availabilityCycle
    ) {
      staleMatchIds.push(persisted.matchId);
      continue;
    }
    if (evaluateMonitoringGate({ ...course, now }).disposition !== "ACTIONABLE") {
      terminalMatchIds.push(persisted.matchId);
      continue;
    }
    if (current.availabilityStatus !== "AVAILABLE") {
      terminalMatchIds.push(persisted.matchId);
      continue;
    }
    if (
      payload.recipientCatchup !== true &&
      (current.alertStatus === "SUPPRESSED" ||
        (current.alertStatus === "SENT" &&
          !groupFrozen &&
          requestedMatchIdSet.has(persisted.matchId)))
    ) {
      staleMatchIds.push(persisted.matchId);
      continue;
    }
    if (
      current.alertStatus !== "PENDING" &&
      current.alertStatus !== "SENT" &&
      !(payload.recipientCatchup === true && current.alertStatus === "SUPPRESSED")
    ) {
      staleMatchIds.push(persisted.matchId);
      continue;
    }

    const probe = latestProbeByCourse.get(persisted.courseId);
    const outcome = probe?.outcome;
    if (!outcome || TRANSIENT_MATCH_PROBE_OUTCOMES.has(outcome)) {
      transientMatchIds.push(persisted.matchId);
      continue;
    }
    if (outcome !== "MATCH_FOUND") {
      terminalMatchIds.push(persisted.matchId);
      continue;
    }
    const startsAt =
      current.startsAt instanceof Date
        ? current.startsAt
        : new Date(requireString(persisted.row.startsAt, "match start"));
    const bookingUrl = getSafeOfficialBookingUrl(
      current.bookingUrl ?? persisted.row.bookingUrl
    );
    if (!bookingUrl || Number.isNaN(startsAt.getTime())) {
      terminalMatchIds.push(persisted.matchId);
      continue;
    }
    const currentValue = toSearchEmailJson({
      matchId: persisted.matchId,
      courseId: persisted.courseId,
      courseName:
        course.name ?? requireString(persisted.row.courseName, "course name"),
      ...(optionalNumber(persisted.row.courseRank) !== undefined
        ? { courseRank: optionalNumber(persisted.row.courseRank) }
        : {}),
      ...(course.address ?? optionalString(persisted.row.courseAddress)
        ? {
            courseAddress:
              course.address ?? optionalString(persisted.row.courseAddress)
          }
        : {}),
      courseTimeZone:
        course.timeZone ??
        requireString(persisted.row.courseTimeZone, "course time zone"),
      startsAt: startsAt.toISOString(),
      availableSpots:
        current.availableSpots ??
        requireNumber(persisted.row.availableSpots, "available spots"),
      bookingUrl,
      priceCents:
        current.priceCents === undefined
          ? optionalNullableNumber(persisted.row.priceCents)
          : current.priceCents,
      holes:
        current.holes === undefined
          ? optionalNullableNumber(persisted.row.holes)
          : current.holes,
      ...(Array.isArray(persisted.row.bookableHoleCounts)
        ? { bookableHoleCounts: persisted.row.bookableHoleCounts }
        : {}),
      isNew: requestedMatchIdSet.has(persisted.matchId)
    });
    currentValueByMatchId.set(persisted.matchId, currentValue);
    confirmedDisplayMatchIds.push(persisted.matchId);
  }

  const confirmedDisplaySet = new Set(confirmedDisplayMatchIds);
  const confirmedMatchIds = requestedMatchIds.filter((matchId) =>
    confirmedDisplaySet.has(matchId)
  );
  const removedEvidence =
    terminalMatchIds.length > 0 ||
    staleMatchIds.length > 0 ||
    transientMatchIds.length > 0;
  const currentPersistedMatches = persistedMatches
    .filter((match) => confirmedDisplaySet.has(match.matchId))
    .map((match) => currentValueByMatchId.get(match.matchId) ?? match.value);
  const contentChanged =
    canonicalJson(currentPersistedMatches) !==
    canonicalJson(
      persistedMatches
        .filter((match) => confirmedDisplaySet.has(match.matchId))
        .map((match) => match.value)
    ) ||
    requestedMatchIds.some((matchId) => !requestedMatchRefById.has(matchId));
  return {
    valid: true,
    contentChanged,
    confirmedMatchIds,
    terminalMatchIds: [...new Set(terminalMatchIds)],
    terminalMatchRefs: (payload.matchRefs ?? []).filter((match) =>
      terminalMatchIds.includes(match.matchId)
    ),
    staleMatchIds: [...new Set(staleMatchIds)],
    transientMatchIds: [...new Set(transientMatchIds)],
    transientMatchRefs: (payload.matchRefs ?? []).filter((match) =>
      transientMatchIds.includes(match.matchId)
    ),
    confirmedMatchCycles: matches
      .filter((match) => confirmedMatchIds.includes(match.id))
      .map((match) => ({
        matchId: match.id,
        availabilityCycle: match.availabilityCycle
      })),
    payload:
      confirmedMatchIds.length > 0
        ? {
            ...payload,
            matchIds: confirmedMatchIds,
            matchRefs: matches
              .filter((match) => confirmedMatchIds.includes(match.id))
              .map((match) => ({
                matchId: match.id,
                availabilityCycle: match.availabilityCycle
              })),
            displayMatchIds: confirmedDisplayMatchIds,
            ...(removedEvidence || contentChanged
              ? { satisfiesStatusReport: false }
              : {}),
            matchReport: {
              ...report,
              matches: currentPersistedMatches
            } as Prisma.InputJsonObject
          }
        : null
  };
}

export async function getPendingStatusEmailReplacement(input: {
  searchId: string;
  alertGeneration: number;
}) {
  const markers = await prisma.searchEmailDelivery.findMany({
    where: {
      teeSearchId: input.searchId,
      alertGeneration: input.alertGeneration,
      kind: { in: ["SETUP", "DAILY"] },
      lastError: {
        in: [
          STALE_STATUS_REPLACEMENT_PENDING,
          STALE_STATUS_REPLACEMENT_PENDING_AMBIGUOUS
        ]
      }
    },
    select: { kind: true, groupKey: true, createdAt: true },
    orderBy: { createdAt: "desc" }
  });
  const latest = markers[0];
  if (!latest || (latest.kind !== "SETUP" && latest.kind !== "DAILY")) {
    return null;
  }
  const kind: "SETUP" | "DAILY" = latest.kind;
  const groups: Array<{ kind: "SETUP" | "DAILY"; groupKey: string }> = [];
  const seenGroups = new Set<string>();
  for (const marker of markers) {
    if (marker.kind !== "SETUP" && marker.kind !== "DAILY") {
      continue;
    }
    const markerKey = `${marker.kind}:${marker.groupKey}`;
    if (seenGroups.has(markerKey)) {
      continue;
    }
    seenGroups.add(markerKey);
    groups.push({ kind: marker.kind, groupKey: marker.groupKey });
  }
  const deliveries = await prisma.searchEmailDelivery.findMany({
    where: {
      teeSearchId: input.searchId,
      alertGeneration: input.alertGeneration,
      OR: groups.map((group) => ({
        kind: group.kind,
        groupKey: group.groupKey
      }))
    },
    select: {
      isOwnerRecipient: true,
      status: true,
      sentAt: true,
      lastError: true
    }
  });
  return {
    kind,
    groups,
    anyRecipientReached: deliveries.some(
      (delivery) =>
        delivery.status === "SENT" ||
        delivery.lastError === STATUS_RECIPIENT_PRIOR_REACHED
    ),
    ownerSent: deliveries.some(
      (delivery) => delivery.isOwnerRecipient && delivery.status === "SENT"
    )
  };
}

export async function satisfyPendingDailyStatusReplacementWithMatch(input: {
  searchId: string;
  alertGeneration: number;
  checkLeaseToken: string;
  groups: Array<{ kind: "SETUP" | "DAILY"; groupKey: string }>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (transaction) => {
    const [search] = await lockSearchRow(transaction, input.searchId);
    if (!isCurrentDeliverySearch(search, input, now)) {
      return { current: false as const, count: 0 };
    }
    const updated = await transaction.searchEmailDelivery.updateMany({
      where: {
        teeSearchId: input.searchId,
        alertGeneration: input.alertGeneration,
        lastError: {
          in: [
            STALE_STATUS_REPLACEMENT_PENDING,
            STALE_STATUS_REPLACEMENT_PENDING_AMBIGUOUS
          ]
        },
        OR: input.groups.map((group) => ({
          kind: group.kind,
          groupKey: group.groupKey
        }))
      },
      data: { lastError: STALE_STATUS_REPLACED }
    });
    return { current: true as const, count: updated.count };
  });
}

async function createRecipientMatchCatchups(
  transaction: DeliveryTransaction,
  input: {
    searchId: string;
    alertGeneration: number;
    sourceGroupKey: string;
    deliveries: Array<{
      recipient: string;
      isOwnerRecipient: boolean;
      status: SearchEmailDeliveryStatus;
      attemptCount: number;
      sentAt: Date | null;
      lastError: string | null;
    }>;
    payload: SearchEmailDeliveryPayload;
    matchCycles: Array<{ matchId: string; availabilityCycle: number }>;
    now: Date;
  }
) {
  const recipients = input.deliveries.filter(canSafelyRekeyDelivery);
  if (recipients.length === 0 || input.matchCycles.length === 0) {
    return { createdCount: 0, ownerContinuationCreated: false };
  }
  const catchupPayload: SearchEmailDeliveryPayload = {
    ...input.payload,
    recipientCatchup: true,
    satisfiesStatusReport: false
  };
  assertSafeSearchEmailPayload(catchupPayload);
  const groupKeys: string[] = [];
  for (const delivery of recipients) {
    const created = await createRecipientMatchDeliveryRow(transaction, {
      searchId: input.searchId,
      alertGeneration: input.alertGeneration,
      sourceGroupKey: input.sourceGroupKey,
      recipient: delivery.recipient,
      isOwnerRecipient: delivery.isOwnerRecipient,
      payload: catchupPayload
    });
    groupKeys.push(created.groupKey);
  }
  await requestDeliveryRetry(
    transaction,
    input.searchId,
    input.alertGeneration,
    new Date(input.now.getTime() + DELIVERY_RETRY_BASE_MS)
  );
  return {
    createdCount: recipients.length,
    ownerContinuationCreated: recipients.some(
      (delivery) => delivery.isOwnerRecipient
    ),
    groupKeys
  };
}

async function createRecipientMatchDeliveryRow(
  transaction: DeliveryTransaction,
  input: {
    searchId: string;
    alertGeneration: number;
    sourceGroupKey: string;
    recipient: string;
    isOwnerRecipient: boolean;
    payload: SearchEmailDeliveryPayload;
    terminalLastError?: string;
  }
) {
  const matchRefs = uniqueMatchRefs(input.payload.matchRefs ?? []);
  if (matchRefs.length === 0) {
    throw new Error("Recipient match delivery requires an exact match cycle");
  }
  const payload: SearchEmailDeliveryPayload = {
    ...input.payload,
    matchIds: matchRefs.map((match) => match.matchId),
    matchRefs,
    recipientCatchup: true
  };
  assertSafeSearchEmailPayload(payload);
  const groupKey = `catchup-${createHash("sha256")
    .update(
      canonicalJson({
        sourceGroupKey: input.sourceGroupKey,
        recipient: normalizeRecipient(input.recipient),
        matchRefs,
        payload,
        terminalLastError: input.terminalLastError ?? null
      })
    )
    .digest("hex")
    .slice(0, 24)}`;
  await transaction.searchEmailDelivery.create({
    data: {
      teeSearchId: input.searchId,
      alertGeneration: input.alertGeneration,
      kind: "MATCH",
      groupKey,
      recipient: normalizeRecipient(input.recipient),
      isOwnerRecipient: input.isOwnerRecipient,
      payload,
      ...(input.terminalLastError
        ? {
            status: "SUPPRESSED" as const,
            lastError: input.terminalLastError
          }
        : {})
    }
  });
  return { groupKey, payload };
}

function createMatchContinuationFromStatusPayload(
  payload: SearchEmailDeliveryPayload,
  matchRefs: MatchRef[]
) {
  const refs = uniqueMatchRefs(matchRefs);
  if (refs.length === 0) {
    return null;
  }
  const report = optionalJsonRecord(payload.statusReport);
  const courses = report && Array.isArray(report.courses) ? report.courses : [];
  const refById = new Map(refs.map((match) => [match.matchId, match] as const));
  const matches: Prisma.InputJsonValue[] = [];
  for (const rawCourse of courses) {
    const course = optionalJsonRecord(rawCourse);
    if (!course) {
      continue;
    }
    const courseId = optionalString(course.courseId);
    const courseName = optionalString(course.courseName);
    const courseTimeZone = optionalString(course.timeZone);
    const bookingUrl = getSafeOfficialBookingUrl(course.bookingUrl);
    if (!courseId || !courseName || !courseTimeZone || !bookingUrl) {
      continue;
    }
    const matchingTimes = Array.isArray(course.matchingTimes)
      ? course.matchingTimes
      : [];
    for (const rawTime of matchingTimes) {
      const time = optionalJsonRecord(rawTime);
      const matchId = time ? optionalString(time.matchId) : undefined;
      if (!time || !matchId || !refById.has(matchId)) {
        continue;
      }
      const startsAt = zonedDateTimeToDate(
        requireString(time.startsAt, "match start"),
        courseTimeZone
      );
      if (Number.isNaN(startsAt.getTime())) {
        throw new Error("Status replacement match start is invalid");
      }
      matches.push(
        toSearchEmailJson({
          matchId,
          courseId,
          courseName,
          ...(optionalNumber(course.rank) !== undefined
            ? { courseRank: optionalNumber(course.rank) }
            : {}),
          ...(optionalString(course.courseAddress)
            ? { courseAddress: optionalString(course.courseAddress) }
            : {}),
          courseTimeZone,
          startsAt: startsAt.toISOString(),
          availableSpots: requireNumber(time.availableSpots, "available spots"),
          bookingUrl,
          priceCents: optionalNullableNumber(time.priceCents),
          holes: optionalNullableNumber(time.holes),
          ...(Array.isArray(time.bookableHoleCounts)
            ? { bookableHoleCounts: time.bookableHoleCounts }
            : {}),
          isNew: true
        })
      );
    }
  }
  const matchedIds = new Set(
    matches.flatMap((value) => {
      const row = optionalJsonRecord(value);
      const matchId = row ? optionalString(row.matchId) : undefined;
      return matchId ? [matchId] : [];
    })
  );
  if (matchedIds.size !== refs.length) {
    throw new Error("Status replacement could not build every match continuation");
  }
  const continuationRefs = refs.filter((match) => matchedIds.has(match.matchId));
  return {
    schemaVersion: 2 as const,
    checkedAt: payload.checkedAt,
    matchIds: continuationRefs.map((match) => match.matchId),
    matchRefs: continuationRefs,
    displayMatchIds: continuationRefs.map((match) => match.matchId),
    recipientCatchup: true,
    satisfiesStatusReport: false,
    statusSnapshot: payload.statusSnapshot,
    matchReport: toSearchEmailJson({
      targetDate: requireString(report?.targetDate, "target date"),
      startTime: requireString(report?.startTime, "start time"),
      endTime: requireString(report?.endTime, "end time"),
      players: requireNumber(report?.players, "players"),
      requestedLayoutHoles:
        report?.requestedLayoutHoles === 9 || report?.requestedLayoutHoles === 18
          ? report.requestedLayoutHoles
          : null,
      userTimeZone: requireString(report?.userTimeZone, "user time zone"),
      matches
    })
  } satisfies SearchEmailDeliveryPayload;
}

function filterMatchDeliveryPayload(
  payload: SearchEmailDeliveryPayload,
  matchRefs: MatchRef[],
  options?: { satisfiesStatusReport?: boolean }
) {
  const refs = uniqueMatchRefs(matchRefs);
  if (refs.length === 0) {
    return null;
  }
  const report = optionalJsonRecord(payload.matchReport);
  if (!report || !Array.isArray(report.matches)) {
    throw new Error("Match delivery report is missing");
  }
  const refById = new Map(refs.map((match) => [match.matchId, match] as const));
  const matches = report.matches.filter((value) => {
    const row = optionalJsonRecord(value);
    const matchId = row ? optionalString(row.matchId) : undefined;
    return Boolean(matchId && refById.has(matchId));
  });
  const matchedIds = new Set(
    matches.flatMap((value) => {
      const row = optionalJsonRecord(value);
      const matchId = row ? optionalString(row.matchId) : undefined;
      return matchId ? [matchId] : [];
    })
  );
  if (matchedIds.size !== refs.length) {
    throw new Error("Match delivery subset is incomplete");
  }
  const subsetRefs = refs.filter((match) => matchedIds.has(match.matchId));
  return {
    ...payload,
    matchIds: subsetRefs.map((match) => match.matchId),
    matchRefs: subsetRefs,
    displayMatchIds: subsetRefs.map((match) => match.matchId),
    recipientCatchup: true,
    ...(options?.satisfiesStatusReport !== undefined
      ? { satisfiesStatusReport: options.satisfiesStatusReport }
      : {}),
    matchReport: {
      ...report,
      matches
    } as Prisma.InputJsonObject
  } satisfies SearchEmailDeliveryPayload;
}

function deliveryOwnsExistingMatchObligation(
  delivery: DeliveryState & { kind: SearchEmailDeliveryKind; lastError: string | null }
) {
  if (
    delivery.lastError === STALE_STATUS_REPLACEMENT_PENDING ||
    delivery.lastError === STALE_STATUS_REPLACED ||
    delivery.lastError === MATCH_STALE_REKEYED ||
    delivery.lastError === MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP ||
    delivery.lastError === DELIVERY_RECIPIENT_REKEYED ||
    delivery.lastError === STATUS_RECIPIENT_PRIOR_REACHED ||
    delivery.lastError === STATUS_RECIPIENT_AMBIGUOUS_ATTEMPT
  ) {
    return false;
  }
  return (
    delivery.kind === "MATCH" ||
    isReachedDelivery(delivery) ||
    isDeliveryDryRun(delivery) ||
    isAmbiguousDelivery(delivery) ||
    delivery.status === "PENDING" ||
    delivery.status === "FAILED" ||
    delivery.status === "SENDING"
  );
}

function getOwnedLegacyMatchIds(
  delivery: DeliveryState & { kind: SearchEmailDeliveryKind; lastError: string | null },
  payload: SearchEmailDeliveryPayload | null
) {
  if (!isReachedDelivery(delivery) && !isAmbiguousDelivery(delivery)) {
    return [];
  }
  if (!deliveryOwnsExistingMatchObligation(delivery)) {
    return [];
  }
  return getLegacyMatchIds(payload);
}

async function retireOverlappingMatchRecipientRows(
  transaction: DeliveryTransaction,
  input: {
    searchId: string;
    alertGeneration: number;
    groupKey: string;
    payload: SearchEmailDeliveryPayload;
    deliveries: Array<{
      id: string;
      recipient: string;
      isOwnerRecipient: boolean;
      status: SearchEmailDeliveryStatus;
      attemptCount: number;
      sentAt: Date | null;
      lastError: string | null;
      createdAt: Date;
    }>;
    now: Date;
  }
) {
  const matchRefs = uniqueMatchRefs(input.payload.matchRefs ?? []);
  if (matchRefs.length === 0) {
    return false;
  }
  const candidateExists = await transaction.searchEmailDelivery.findFirst({
    where: {
      teeSearchId: input.searchId,
      alertGeneration: input.alertGeneration,
      kind: "MATCH",
      groupKey: { not: input.groupKey },
      recipient: { in: input.deliveries.map((delivery) => delivery.recipient) }
    },
    select: { id: true }
  });
  if (!candidateExists) {
    return false;
  }
  const candidates = await transaction.searchEmailDelivery.findMany({
    where: {
      teeSearchId: input.searchId,
      alertGeneration: input.alertGeneration,
      kind: "MATCH",
      groupKey: { not: input.groupKey },
      recipient: { in: input.deliveries.map((delivery) => delivery.recipient) }
    }
  });
  const safelySupersededCandidateIds = new Set<string>();
  const retiredCurrentIds: string[] = [];
  const legacyBlockedOwnerRefs: MatchRef[] = [];
  let createdContinuation = false;
  for (const delivery of input.deliveries) {
    const currentCanRekey = canSafelyRekeyDelivery(delivery);
    const currentPriority = isReachedDelivery(delivery)
      ? 3
      : isAmbiguousDelivery(delivery)
        ? 2
        : 1;
    const conflictRefs = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.recipient !== delivery.recipient) {
        continue;
      }
      const candidatePayload = parseSearchEmailPayload(candidate.payload);
      const candidateRefs = uniqueMatchRefs(candidatePayload?.matchRefs ?? []);
      const candidateLegacyMatchIds = getLegacyMatchIds(candidatePayload);
      const exactOverlappingRefs = candidateRefs.filter((candidateRef) =>
        matchRefs.some(
          (currentRef) => toMatchRefKey(currentRef) === toMatchRefKey(candidateRef)
        )
      );
      const legacyOverlappingRefs = matchRefs.filter((currentRef) =>
        candidateLegacyMatchIds.includes(currentRef.matchId)
      );
      if (
        exactOverlappingRefs.length === 0 &&
        legacyOverlappingRefs.length === 0
      ) {
        continue;
      }

      if (
        legacyOverlappingRefs.length > 0 &&
        canSafelyRekeyDelivery(candidate)
      ) {
        safelySupersededCandidateIds.add(candidate.id);
        continue;
      }
      if (wasDeliveryNotAccepted(candidate) && currentCanRekey) {
        safelySupersededCandidateIds.add(candidate.id);
        continue;
      }
      const candidateLegacyOwns =
        legacyOverlappingRefs.length > 0 &&
        getOwnedLegacyMatchIds(candidate, candidatePayload).length > 0;
      const candidateEligible =
        candidateLegacyOwns ||
        (exactOverlappingRefs.length > 0 &&
          deliveryOwnsExistingMatchObligation(candidate));
      if (!candidateEligible) {
        continue;
      }
      const candidatePriority = isReachedDelivery(candidate)
        ? 3
        : isAmbiguousDelivery(candidate)
          ? 2
          : 1;
      const candidateWinsTie =
        candidate.createdAt < delivery.createdAt ||
        (candidate.createdAt.getTime() === delivery.createdAt.getTime() &&
          candidate.id < delivery.id);
      const candidateOwns =
        candidatePriority > currentPriority ||
        (candidatePriority === currentPriority &&
          currentPriority < 3 &&
          candidateWinsTie);
      if (!candidateOwns) {
        continue;
      }
      for (const matchRef of exactOverlappingRefs) {
        conflictRefs.add(toMatchRefKey(matchRef));
      }
      for (const matchRef of legacyOverlappingRefs) {
        conflictRefs.add(toMatchRefKey(matchRef));
        if (delivery.isOwnerRecipient) {
          legacyBlockedOwnerRefs.push(matchRef);
        }
      }
    }
    if (conflictRefs.size === 0) {
      continue;
    }
    const uncoveredRefs = matchRefs.filter(
      (match) => !conflictRefs.has(toMatchRefKey(match))
    );
    if (currentCanRekey && uncoveredRefs.length > 0) {
      const payload = filterMatchDeliveryPayload(input.payload, uncoveredRefs, {
        satisfiesStatusReport: false
      });
      if (payload) {
        await createRecipientMatchDeliveryRow(transaction, {
          searchId: input.searchId,
          alertGeneration: input.alertGeneration,
          sourceGroupKey: input.groupKey,
          recipient: delivery.recipient,
          isOwnerRecipient: delivery.isOwnerRecipient,
          payload
        });
        createdContinuation = true;
      }
    }
    retiredCurrentIds.push(delivery.id);
  }
  if (safelySupersededCandidateIds.size > 0) {
    await transaction.searchEmailDelivery.updateMany({
      where: { id: { in: [...safelySupersededCandidateIds] } },
      data: {
        status: "SUPPRESSED",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: MATCH_STALE_REKEYED
      }
    });
  }
  await suppressPendingMatchRefs(
    transaction,
    input.searchId,
    legacyBlockedOwnerRefs,
    input.now
  );
  if (retiredCurrentIds.length > 0) {
    await transaction.searchEmailDelivery.updateMany({
      where: { id: { in: retiredCurrentIds } },
      data: {
        status: "SUPPRESSED",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: MATCH_RECIPIENT_OWNED_BY_OTHER_GROUP
      }
    });
  }
  if (createdContinuation) {
    await requestDeliveryRetry(
      transaction,
      input.searchId,
      input.alertGeneration,
      new Date(input.now.getTime() + DELIVERY_RETRY_BASE_MS)
    );
  }
  return retiredCurrentIds.length > 0 || safelySupersededCandidateIds.size > 0;
}

async function validateCurrentStatusDeliveryPayload(
  transaction: DeliveryTransaction,
  searchId: string,
  payload: SearchEmailDeliveryPayload,
  now: Date
): Promise<StatusPayloadState> {
  const report = optionalJsonRecord(payload.statusReport);
  const payloadCheckedAt = new Date(payload.checkedAt);
  const targetDate = report ? optionalString(report.targetDate) : undefined;
  const startTime = report ? optionalString(report.startTime) : undefined;
  const endTime = report ? optionalString(report.endTime) : undefined;
  const players = report ? optionalNumber(report.players) : undefined;
  const rawCourses = report && Array.isArray(report.courses) ? report.courses : [];
  const persistedCourses = rawCourses
    .map((value) => optionalJsonRecord(value))
    .filter((course): course is Record<string, unknown> => Boolean(course))
    .map((course) => {
      const outcome = optionalString(course.outcome);
      return {
        courseId: optionalString(course.courseId),
        courseName: optionalString(course.courseName),
        courseAddress: optionalString(course.courseAddress),
        timeZone: optionalString(course.timeZone),
        bookingMethod: optionalString(course.bookingMethod),
        bookingUrl: optionalString(course.bookingUrl),
        matchingTimes: Array.isArray(course.matchingTimes)
          ? course.matchingTimes
              .map((value) => optionalJsonRecord(value))
              .filter((value): value is Record<string, unknown> => Boolean(value))
          : [],
        outcome,
        monitoringDisposition:
          course.monitoringDisposition === undefined
            ? outcome === "BLOCKED_POLICY" || outcome === "BLOCKED_AUTH"
              ? null
              : "ACTIONABLE"
            : isMonitoringDisposition(course.monitoringDisposition)
              ? course.monitoringDisposition
              : null
      };
    });
  if (
    !report ||
    Number.isNaN(payloadCheckedAt.getTime()) ||
    !targetDate ||
    !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
    !startTime ||
    !/^\d{2}:\d{2}$/.test(startTime) ||
    !endTime ||
    !/^\d{2}:\d{2}$/.test(endTime) ||
    !players ||
    players < 1 ||
    persistedCourses.length === 0 ||
    persistedCourses.length !== rawCourses.length ||
    persistedCourses.some(
      (course) =>
        !course.courseId ||
        !course.courseName ||
        !course.timeZone ||
        !course.outcome ||
        !course.monitoringDisposition
    )
  ) {
    return "stale";
  }
  const courseIds = persistedCourses.map((course) => course.courseId as string);
  if (new Set(courseIds).size !== courseIds.length) {
    return "stale";
  }

  const rawMatchIds = payload.matchIds ?? [];
  const matchIds = [...new Set(rawMatchIds)];
  const matchRefs = uniqueMatchRefs(payload.matchRefs ?? []);
  const rawDisplayMatchIds = payload.displayMatchIds;
  const displayMatchIds = [...new Set(rawDisplayMatchIds ?? [])];
  if (
    !Array.isArray(rawDisplayMatchIds) ||
    matchIds.length !== rawMatchIds.length ||
    matchRefs.length !== matchIds.length ||
    matchRefs.some((match) => !matchIds.includes(match.matchId)) ||
    displayMatchIds.length !== rawDisplayMatchIds.length ||
    matchIds.some((matchId) => !displayMatchIds.includes(matchId))
  ) {
    return "stale";
  }
  if (matchIds.length > 0) {
    const coveredMatches = await transaction.teeTimeMatch.findMany({
      where: {
        teeSearchId: searchId,
        OR: matchRefs.map((match) => ({
          id: match.matchId,
          availabilityCycle: match.availabilityCycle
        })),
        alertStatus: { in: ["PENDING", "SENT"] },
        availabilityStatus: "AVAILABLE"
      },
      select: { id: true, courseId: true, availabilityCycle: true }
    });
    const reportByCourse = new Map(
      persistedCourses.map((course) => [course.courseId, course])
    );
    if (
      coveredMatches.length !== matchIds.length ||
      coveredMatches.some(
        (match) => reportByCourse.get(match.courseId)?.outcome !== "MATCH_FOUND"
      )
    ) {
      return "stale";
    }
  }

  const courses = await transaction.course.findMany({
    where: { id: { in: courseIds } },
    select: {
      id: true,
      name: true,
      address: true,
      timeZone: true,
      updatedAt: true,
      website: true,
      detectedBookingUrl: true,
      isPublic: true,
      bookingMethod: true,
      automationEligibility: true,
      automationReason: true,
      intelligenceVerifiedAt: true,
      intelligenceReviewAt: true,
      intelligenceConfidence: true
    }
  });
  if (courses.length !== courseIds.length) {
    return "stale";
  }
  const currentDispositionByCourse = new Map(
    courses.map((course) => [
      course.id,
      evaluateMonitoringGate({ ...course, now }).disposition
    ])
  );
  const currentCourseById = new Map(courses.map((course) => [course.id, course]));
  const latestProbeByCourse = await getLatestCourseProbeByCourse(
    transaction,
    searchId,
    courseIds
  );
  for (const course of persistedCourses) {
    const courseId = course.courseId as string;
    const currentCourse = currentCourseById.get(courseId);
    if (
      !currentCourse ||
      currentCourse.updatedAt > payloadCheckedAt ||
      currentCourse.name !== course.courseName ||
      (currentCourse.address ?? undefined) !== course.courseAddress ||
      currentCourse.timeZone !== course.timeZone ||
      (course.bookingMethod !== undefined &&
        currentCourse.bookingMethod !== course.bookingMethod) ||
      currentDispositionByCourse.get(courseId) !== course.monitoringDisposition
    ) {
      return "stale";
    }
    const latestProbe = latestProbeByCourse.get(courseId);
    const latestOutcome = latestProbe?.outcome;
    if (!latestOutcome) {
      return "transient";
    }
    if (latestProbe.observedAt > payloadCheckedAt) {
      return "stale";
    }
    if (latestOutcome !== course.outcome) {
      return TRANSIENT_MATCH_PROBE_OUTCOMES.has(latestOutcome)
        ? "transient"
        : "stale";
    }
  }
  const currentMatches = await transaction.teeTimeMatch.findMany({
    where: {
      teeSearchId: searchId,
      courseId: { in: courseIds },
      availabilityStatus: "AVAILABLE"
    },
    select: {
      id: true,
      courseId: true,
      startsAt: true,
      availableSpots: true,
      bookingUrl: true,
      priceCents: true,
      holes: true,
      alertStatus: true,
      availabilityCycle: true
    }
  });
  const currentMatchById = new Map(currentMatches.map((match) => [match.id, match]));
  for (const course of persistedCourses) {
    for (const matchingTime of course.matchingTimes) {
      const matchId = optionalString(matchingTime.matchId);
      const startsAt = optionalString(matchingTime.startsAt);
      const currentMatch = matchId ? currentMatchById.get(matchId) : undefined;
      if (!matchId || !startsAt || !currentMatch) {
        return "stale";
      }
      const persistedStart = zonedDateTimeToDate(startsAt, course.timeZone as string);
      if (
        Number.isNaN(persistedStart.getTime()) ||
        persistedStart.getTime() !== currentMatch.startsAt.getTime() ||
        optionalNumber(matchingTime.availableSpots) !== currentMatch.availableSpots ||
        (optionalNullableNumber(matchingTime.priceCents) ?? null) !==
          currentMatch.priceCents ||
        (optionalNullableNumber(matchingTime.holes) ?? null) !== currentMatch.holes
      ) {
        return "stale";
      }
    }
  }
  const currentRenderedMatchIds = courses.flatMap((course) => {
    if (
      persistedCourses.find((persisted) => persisted.courseId === course.id)?.outcome !==
      "MATCH_FOUND"
    ) {
      return [];
    }
    return getRenderedAvailabilityTimes(
      currentMatches
        .filter((match) => {
          if (match.courseId !== course.id || match.availableSpots < players) {
            return false;
          }
          const windowStart = zonedDateTimeToDate(
            `${targetDate}T${startTime}:00`,
            course.timeZone
          );
          const windowEnd = zonedDateTimeToDate(
            `${targetDate}T${endTime}:00`,
            course.timeZone
          );
          return match.startsAt >= windowStart && match.startsAt < windowEnd;
        })
        .map((match) => ({
          id: match.id,
          startsAt: match.startsAt,
          availableSpots: match.availableSpots,
          priceCents: match.priceCents,
          holes: match.holes,
          isNew: match.alertStatus === "PENDING"
        })),
      course.timeZone
    ).map((match) => match.id);
  });
  if (
    [...currentRenderedMatchIds].sort().join("\u0000") !==
    [...displayMatchIds].sort().join("\u0000")
  ) {
    return "stale";
  }
  return "current";
}

async function getLatestCourseProbeByCourse(
  transaction: DeliveryTransaction,
  searchId: string,
  courseIds: string[]
) {
  const probes = await transaction.courseProbe.findMany({
    where: {
      teeSearchId: searchId,
      courseId: { in: courseIds }
    },
    orderBy: { observedAt: "desc" },
    select: { courseId: true, outcome: true, observedAt: true }
  });
  const latestProbeByCourse = new Map<
    string,
    { outcome: string; observedAt: Date }
  >();
  for (const probe of probes) {
    if (!latestProbeByCourse.has(probe.courseId)) {
      latestProbeByCourse.set(probe.courseId, {
        outcome: probe.outcome,
        observedAt: probe.observedAt
      });
    }
  }
  return latestProbeByCourse;
}

function isMonitoringDisposition(
  value: unknown
): value is "ACTIONABLE" | "MANUAL_FINAL" | "TECHNICAL_FINAL" | "IDENTITY_FINAL" {
  return (
    value === "ACTIONABLE" ||
    value === "MANUAL_FINAL" ||
    value === "TECHNICAL_FINAL" ||
    value === "IDENTITY_FINAL"
  );
}

function getEvidenceRetryAt(
  deliveries: Array<{ status: SearchEmailDeliveryStatus; nextAttemptAt: Date | null }>,
  now: Date
) {
  const evidenceRetryAt = new Date(now.getTime() + DELIVERY_RETRY_BASE_MS);
  const providerRetryAt = deliveries
    .filter(
      (delivery) =>
        delivery.status === "FAILED" &&
        delivery.nextAttemptAt &&
        delivery.nextAttemptAt > now
    )
    .map((delivery) => delivery.nextAttemptAt as Date)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return providerRetryAt && providerRetryAt > evidenceRetryAt
    ? providerRetryAt
    : evidenceRetryAt;
}

async function terminalizeMatchEvidence(
  transaction: DeliveryTransaction,
  searchId: string,
  matchRefs: MatchRef[],
  now: Date
) {
  const refs = uniqueMatchRefs(matchRefs);
  if (refs.length === 0) {
    return;
  }
  await transaction.teeTimeMatch.updateMany({
    where: {
      teeSearchId: searchId,
      OR: refs.map((match) => ({
        id: match.matchId,
        availabilityCycle: match.availabilityCycle
      })),
      alertStatus: "PENDING"
    },
    data: {
      alertStatus: "SUPPRESSED",
      availabilityStatus: "GONE",
      sentAt: now,
      unavailableAt: now
    }
  });
  await transaction.teeTimeMatch.updateMany({
    where: {
      teeSearchId: searchId,
      OR: refs.map((match) => ({
        id: match.matchId,
        availabilityCycle: match.availabilityCycle
      })),
      alertStatus: { not: "PENDING" }
    },
    data: {
      availabilityStatus: "GONE",
      unavailableAt: now
    }
  });
}

async function suppressPendingMatchRefs(
  transaction: DeliveryTransaction,
  searchId: string,
  matchRefs: MatchRef[],
  now: Date
) {
  const refs = uniqueMatchRefs(matchRefs);
  if (refs.length === 0) {
    return;
  }
  await transaction.teeTimeMatch.updateMany({
    where: {
      teeSearchId: searchId,
      OR: refs.map((match) => ({
        id: match.matchId,
        availabilityCycle: match.availabilityCycle
      })),
      alertStatus: "PENDING"
    },
    data: {
      alertStatus: "SUPPRESSED",
      sentAt: now
    }
  });
}

async function suppressPendingMatchIds(
  transaction: DeliveryTransaction,
  searchId: string,
  matchIds: string[],
  now: Date
) {
  const ids = [...new Set(matchIds)];
  if (ids.length === 0) {
    return;
  }
  await transaction.teeTimeMatch.updateMany({
    where: {
      teeSearchId: searchId,
      id: { in: ids },
      alertStatus: "PENDING"
    },
    data: {
      alertStatus: "SUPPRESSED",
      sentAt: now
    }
  });
}

async function suppressRetryableGroupRows(
  transaction: DeliveryTransaction,
  deliveries: Array<{ id: string; status: SearchEmailDeliveryStatus }>,
  lastError?: string | null
) {
  const ids = deliveries
    .filter(
      (delivery) =>
        delivery.status === "PENDING" ||
        delivery.status === "FAILED" ||
        delivery.status === "SENDING"
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
      nextAttemptAt: null,
      ...(lastError !== undefined ? { lastError } : {})
    }
  });
}

async function retireStaleStatusGroupRows(
  transaction: DeliveryTransaction,
  deliveries: Array<{
    id: string;
    status: SearchEmailDeliveryStatus;
    attemptCount: number;
    sentAt: Date | null;
    lastError: string | null;
  }>,
  input: { searchId: string; alertGeneration: number; now: Date }
) {
  const rekeyableIds = deliveries
    .filter(canSafelyRekeyDelivery)
    .map((delivery) => delivery.id);
  const ambiguousIds = deliveries
    .filter(isAmbiguousDelivery)
    .map((delivery) => delivery.id);
  if (rekeyableIds.length > 0) {
    await transaction.searchEmailDelivery.updateMany({
      where: { id: { in: rekeyableIds } },
      data: {
        status: "SUPPRESSED",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: STALE_STATUS_REPLACEMENT_PENDING
      }
    });
  }
  if (ambiguousIds.length > 0) {
    await transaction.searchEmailDelivery.updateMany({
      where: { id: { in: ambiguousIds } },
      data: {
        status: "SUPPRESSED",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: STALE_STATUS_REPLACEMENT_PENDING_AMBIGUOUS
      }
    });
  }
  if (rekeyableIds.length > 0 || ambiguousIds.length > 0) {
    await requestDeliveryRetry(
      transaction,
      input.searchId,
      input.alertGeneration,
      new Date(input.now.getTime() + DELIVERY_RETRY_BASE_MS)
    );
  }
}

async function retireStaleMatchGroupRows(
  transaction: DeliveryTransaction,
  deliveries: Array<{
    id: string;
    status: SearchEmailDeliveryStatus;
    attemptCount: number;
    sentAt: Date | null;
    lastError: string | null;
  }>
) {
  const rekeyedIds = deliveries
    .filter(canSafelyRekeyDelivery)
    .map((delivery) => delivery.id);
  const blockedIds = deliveries
    .filter(isAmbiguousDelivery)
    .map((delivery) => delivery.id);
  if (rekeyedIds.length > 0) {
    await transaction.searchEmailDelivery.updateMany({
      where: { id: { in: rekeyedIds } },
      data: {
        status: "SUPPRESSED",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: "MATCH_STALE_REKEYED"
      }
    });
  }
  if (blockedIds.length > 0) {
    await transaction.searchEmailDelivery.updateMany({
      where: { id: { in: blockedIds } },
      data: {
        status: "SUPPRESSED",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError: MATCH_STALE_REKEY_BLOCKED
      }
    });
  }
}

async function lockSearchRow(
  transaction: DeliveryTransaction,
  searchId: string,
  userId?: string
) {
  const userFilter = userId
    ? Prisma.sql`AND search."userId" = ${userId}`
    : Prisma.empty;
  const rows = await transaction.$queryRaw<LockedSearchRow[]>(Prisma.sql`
    SELECT
      search."id",
      search."userId",
      search."status"::text AS "status",
      search."alertGeneration",
      search."checkLeaseToken",
      search."checkLeaseExpiresAt",
      search."additionalEmails"
    FROM "TeeSearch" AS search
    WHERE search."id" = ${searchId}
    ${userFilter}
    FOR UPDATE OF search
  `);
  const search = rows[0];
  if (!search) {
    return [];
  }
  const owner = await transaction.user.findUnique({
    where: { id: search.userId },
    select: { email: true, pendingEmail: true }
  });
  if (!owner) {
    return [];
  }
  return [
    {
      ...search,
      ownerEmail: owner.email,
      ownerPendingEmail: owner.pendingEmail
    }
  ];
}

function getLockedRecipientAuthority(search: LockedSearch) {
  if (
    typeof search.ownerEmail !== "string" ||
    !Array.isArray(search.additionalEmails)
  ) {
    return null;
  }
  const ownerRecipient = normalizeRecipient(search.ownerEmail);
  if (!ownerRecipient) {
    return null;
  }
  const additionalRecipients = new Set(
    normalizeRecipients(search.additionalEmails ?? []).filter(
      (recipient) => recipient !== ownerRecipient
    )
  );
  return {
    ownerRecipient,
    additionalRecipients,
    recipients: [ownerRecipient, ...additionalRecipients]
  };
}

function matchesLockedRecipientAuthority(
  search: LockedSearch | undefined,
  recipients: string[],
  ownerRecipient: string
) {
  if (!search) {
    return false;
  }
  const authority = getLockedRecipientAuthority(search);
  if (!authority) {
    return false;
  }
  if (ownerRecipient !== authority.ownerRecipient) {
    return false;
  }
  const actual = normalizeRecipients(recipients).sort();
  const allowed = new Set(authority.recipients);
  return actual.every((recipient) => allowed.has(recipient));
}

function isDeliveryAuthorizedForLockedSearch(
  search: LockedSearch,
  delivery: { recipient: string; isOwnerRecipient: boolean }
) {
  const authority = getLockedRecipientAuthority(search);
  if (!authority) {
    return false;
  }
  const recipient = normalizeRecipient(delivery.recipient);
  return delivery.isOwnerRecipient
    ? recipient === authority.ownerRecipient
    : authority.additionalRecipients.has(recipient);
}

async function renewClaimedDeliveryRecipientAuthorization(input: {
  searchId: string;
  alertGeneration: number;
  claimToken: string;
  delivery: { id: string; recipient: string; isOwnerRecipient: boolean };
}) {
  await prisma.$transaction(async (transaction) => {
    const [search] = await lockSearchRow(transaction, input.searchId);
    const authorized = Boolean(
      search &&
        search.status === "ACTIVE" &&
        search.alertGeneration === input.alertGeneration &&
        !search.ownerPendingEmail &&
        isDeliveryAuthorizedForLockedSearch(search, input.delivery)
    );
    if (!authorized) {
      throw new EmailDeliveryNotAcceptedError(
        "Alert recipient authorization changed before delivery"
      );
    }
    const renewed = await transaction.$executeRaw(Prisma.sql`
      UPDATE "SearchEmailDelivery"
      SET "claimExpiresAt" = statement_timestamp()
        + (${DELIVERY_CLAIM_MS} * INTERVAL '1 millisecond')
      WHERE "id" = ${input.delivery.id}
        AND "teeSearchId" = ${input.searchId}
        AND "alertGeneration" = ${input.alertGeneration}
        AND "status" = 'SENDING'
        AND "claimToken" = ${input.claimToken}
        AND "claimExpiresAt" > statement_timestamp()
    `);
    if (renewed !== 1) {
      throw new EmailDeliveryNotAcceptedError(
        "Alert email delivery claim expired before provider delivery"
      );
    }
  });
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
    ...(Array.isArray(payload.matchRefs)
      ? {
          matchRefs: payload.matchRefs
            .map((value) => optionalJsonRecord(value))
            .filter((value): value is Record<string, unknown> => Boolean(value))
            .map((value) => ({
              matchId: optionalString(value.matchId),
              availabilityCycle: optionalNumber(value.availabilityCycle)
            }))
            .filter(
              (
                value
              ): value is { matchId: string; availabilityCycle: number } =>
                Boolean(
                  value.matchId &&
                    Number.isInteger(value.availabilityCycle) &&
                    (value.availabilityCycle ?? -1) >= 0
                )
            )
        }
      : {}),
    ...(Array.isArray(payload.displayMatchIds)
      ? {
          displayMatchIds: payload.displayMatchIds.filter(
            (id): id is string => typeof id === "string"
          )
        }
      : {}),
    ...(typeof payload.recipientCatchup === "boolean"
      ? { recipientCatchup: payload.recipientCatchup }
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

function toMatchRefKey(match: { matchId: string; availabilityCycle: number }) {
  return `${match.matchId}:${match.availabilityCycle}`;
}

function getLegacyMatchIds(payload: SearchEmailDeliveryPayload | null) {
  if (!payload) {
    return [];
  }
  const exactMatchIds = new Set(
    uniqueMatchRefs(payload.matchRefs ?? []).map((match) => match.matchId)
  );
  return [
    ...new Set(
      (payload.matchIds ?? []).filter((matchId) => !exactMatchIds.has(matchId))
    )
  ];
}

function uniqueMatchRefs(matchRefs: MatchRef[]) {
  return [
    ...new Map(
      matchRefs.map((match) => [toMatchRefKey(match), match] as const)
    ).values()
  ];
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

function optionalJsonRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function getDeliveryFailureMarker(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const prefix =
    code === "EMAIL_DELIVERY_NOT_ACCEPTED" ||
    code === "EMAIL_DELIVERY_NOT_CONFIGURED"
      ? DELIVERY_NOT_ACCEPTED_PREFIX
      : DELIVERY_OUTCOME_UNKNOWN_PREFIX;
  return `${prefix}${sanitizeDeliveryError(error)}`;
}
