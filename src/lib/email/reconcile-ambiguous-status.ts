import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { sendSearchStatusEmail } from "@/lib/email/alerts";
import { isSearchEmailDeliveryEnabled } from "@/lib/email/delivery-policy";
import {
  assertSafeSearchEmailPayload,
  finalizeSearchEmailDeliveryGroup,
  hydrateSearchStatusEmailPayload,
} from "@/lib/email/search-delivery-outbox";
import {
  getStableSearchEmailDeliveryIdempotencyKey,
  normalizeSearchEmailRecipient,
  parseSearchEmailPayload,
} from "@/lib/email/search-delivery-payload";

const AMBIGUOUS_SETUP_MARKER = "STATUS_CONTENT_STALE_REPLACED_AMBIGUOUS";
const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_CHECK_MS = 30 * 60 * 1000;

export type AmbiguousStatusReconciliation =
  | { outcome: "ineligible" }
  | { outcome: "accepted"; recorded: boolean };

/** Operator-only recovery of the exact immutable request behind an uncertain setup send. */
export async function reconcileAmbiguousSetupEmail(
  deliveryId: string,
  now = new Date(),
): Promise<AmbiguousStatusReconciliation> {
  if (!isSearchEmailDeliveryEnabled("SETUP")) {
    return { outcome: "ineligible" };
  }

  const delivery = await prisma.searchEmailDelivery.findUnique({
    where: { id: deliveryId },
  });
  if (
    !delivery ||
    delivery.kind !== "SETUP" ||
    delivery.status !== "SUPPRESSED" ||
    !delivery.isOwnerRecipient ||
    delivery.attemptCount < 1 ||
    delivery.sentAt ||
    delivery.lastError !== AMBIGUOUS_SETUP_MARKER ||
    now.getTime() - delivery.createdAt.getTime() >= RESEND_IDEMPOTENCY_WINDOW_MS
  ) {
    return { outcome: "ineligible" };
  }

  const payload = parseSearchEmailPayload(delivery.payload);
  if (!payload || (payload.matchIds?.length ?? 0) !== 0) {
    return { outcome: "ineligible" };
  }
  assertSafeSearchEmailPayload(payload);
  const report = await hydrateSearchStatusEmailPayload(payload);
  if (
    report.kind !== "setup" ||
    report.courses.length < 1 ||
    report.courses.some((course) => course.outcome !== "NO_MATCH")
  ) {
    return { outcome: "ineligible" };
  }

  // This short transaction is the recipient-authority decision immediately
  // before transport. Resend's original idempotency key handles concurrent
  // invocations of this exact request without a duplicate message.
  const authorized = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "TeeSearch"
      WHERE "id" = ${delivery.teeSearchId}
      FOR UPDATE
    `);
    const currentDelivery = await transaction.searchEmailDelivery.findUnique({
      where: { id: delivery.id },
      select: {
        status: true,
        lastError: true,
        attemptCount: true,
        sentAt: true,
        updatedAt: true,
      },
    });
    if (
      currentDelivery?.status !== "SUPPRESSED" ||
      currentDelivery.lastError !== AMBIGUOUS_SETUP_MARKER ||
      currentDelivery.attemptCount !== delivery.attemptCount ||
      currentDelivery.sentAt ||
      currentDelivery.updatedAt.getTime() !== delivery.updatedAt.getTime()
    ) {
      return false;
    }
    const search = await transaction.teeSearch.findUnique({
      where: { id: delivery.teeSearchId },
      include: {
        user: { select: { email: true, pendingEmail: true } },
        preferences: { select: { courseId: true } },
      },
    });
    if (
      !search ||
      search.status !== "ACTIVE" ||
      search.syntheticMultiCycle ||
      search.checkStatus !== "WAITING" ||
      search.alertGeneration !== delivery.alertGeneration ||
      search.user.pendingEmail ||
      normalizeSearchEmailRecipient(search.alertEmail ?? search.user.email) !==
        normalizeSearchEmailRecipient(delivery.recipient) ||
      !search.lastCheckedAt ||
      now.getTime() - search.lastCheckedAt.getTime() > RECENT_CHECK_MS
    ) {
      return false;
    }
    const outcome = JSON.parse(search.lastCheckOutcome ?? "null") as {
      availableMatches?: number;
      failedCourses?: unknown[];
    } | null;
    if (
      outcome?.availableMatches !== 0 ||
      !Array.isArray(outcome.failedCourses) ||
      outcome.failedCourses.length > 0
    ) {
      return false;
    }
    const selected = search.preferences.map((preference) => preference.courseId).sort();
    const reported = report.courses.map((course) => course.courseId).sort();
    if (
      selected.length !== reported.length ||
      selected.some((courseId, index) => courseId !== reported[index])
    ) {
      return false;
    }
    const [otherAccepted, otherInFlight, monitoring] = await Promise.all([
      transaction.searchEmailDelivery.count({
        where: {
          teeSearchId: search.id,
          alertGeneration: search.alertGeneration,
          isOwnerRecipient: true,
          status: "SENT",
        },
      }),
      transaction.searchEmailDelivery.count({
        where: {
          teeSearchId: search.id,
          alertGeneration: search.alertGeneration,
          isOwnerRecipient: true,
          status: "SENDING",
        },
      }),
      transaction.courseMonitoringStatus.findMany({
        where: { courseId: { in: selected } },
        select: { courseId: true, state: true, lastSuccessfulAt: true, lastFailureAt: true },
      }),
    ]);
    return (
      otherAccepted === 0 &&
      otherInFlight === 0 &&
      monitoring.length === selected.length &&
      monitoring.every(
        (course) =>
          course.state === "HEALTHY" &&
          course.lastSuccessfulAt &&
          (!course.lastFailureAt || course.lastFailureAt < course.lastSuccessfulAt),
      )
    );
  }, { timeout: 15_000 });
  if (!authorized) {
    return { outcome: "ineligible" };
  }

  const result = await sendSearchStatusEmail({
    searchId: delivery.teeSearchId,
    to: delivery.recipient,
    ...report,
    stableIdempotencyKey: getStableSearchEmailDeliveryIdempotencyKey({
      searchId: delivery.teeSearchId,
      kind: delivery.kind,
      groupKey: delivery.groupKey,
      recipient: delivery.recipient,
      payload,
    }),
  });
  if (result.deliveryStatus !== "sent") {
    return { outcome: "ineligible" };
  }

  const recorded = await prisma.searchEmailDelivery.updateMany({
    where: {
      id: delivery.id,
      teeSearchId: delivery.teeSearchId,
      alertGeneration: delivery.alertGeneration,
      status: "SUPPRESSED",
      lastError: AMBIGUOUS_SETUP_MARKER,
      attemptCount: delivery.attemptCount,
      sentAt: null,
    },
    data: {
      status: "SENT",
      sentAt: new Date(),
      lastError: null,
      nextAttemptAt: null,
    },
  });
  if (recorded.count !== 1) {
    return { outcome: "accepted", recorded: false };
  }
  const finalized = await finalizeSearchEmailDeliveryGroup({
    searchId: delivery.teeSearchId,
    alertGeneration: delivery.alertGeneration,
    kind: delivery.kind,
    groupKey: delivery.groupKey,
  });
  return { outcome: "accepted", recorded: finalized.finalized === true };
}
