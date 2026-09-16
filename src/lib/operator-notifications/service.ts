import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOperatorNotificationConfig } from "./config";
import {
  assessOperatorNotificationHealth,
  buildOperatorNotificationSummary,
  isEligibleOperatorNotificationSearch,
} from "./content";
import {
  sendOperatorNotification,
  OperatorNotificationSendError,
} from "./push";

const FOLLOWUP_DELAY_MS = 5 * 60_000;
const CLAIM_MS = 60_000;
const MAX_ATTEMPTS = 5;

async function loadSearch(searchId: string | null) {
  if (!searchId) return null;
  return prisma.$transaction(
    async (tx) => {
      const search = await tx.teeSearch.findUnique({
        where: { id: searchId },
        include: {
          user: { select: { email: true } },
          preferences: {
            orderBy: { rank: "asc" },
            include: {
              course: {
                select: {
                  name: true,
                  layoutHoleCounts: true,
                  monitoringStatus: { select: { lastFailureAt: true } },
                },
              },
            },
          },
          emailDeliveries: {
            where: { status: { in: ["PENDING", "SENDING", "FAILED"] } },
            select: {
              alertGeneration: true,
              status: true,
              attemptCount: true,
              nextAttemptAt: true,
            },
          },
        },
      });
      if (!search) return null;
      const newest = await Promise.all(
        search.preferences.map((preference) =>
          tx.courseProbe.findFirst({
            where: { teeSearchId: search.id, courseId: preference.courseId },
            orderBy: [{ observedAt: "desc" }, { id: "desc" }],
            select: {
              courseId: true,
              outcome: true,
              observedAt: true,
              rawSummary: true,
            },
          }),
        ),
      );
      return {
        ...search,
        probes: newest.filter((probe) => probe !== null),
        emailDeliveries: search.emailDeliveries.filter(
          (delivery) => delivery.alertGeneration === search.alertGeneration,
        ),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function recordOperatorNotificationAcceptance(input: {
  id: string;
  token: string;
  messageId: string;
  providerStatus: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.operatorNotificationDelivery.updateMany({
      where: {
        id: input.id,
        claimToken: input.token,
        status: "SENDING",
      },
      data: {
        status: "ACCEPTED",
        acceptedAt: now,
        providerMessageId: input.messageId,
        providerStatus: input.providerStatus,
        claimExpiresAt: null,
        lastError: null,
      },
    });
    if (!claimed.count) return false;
    const delivery = await tx.operatorNotificationDelivery.findUniqueOrThrow({
      where: { id: input.id },
    });
    if (delivery.kind === "CREATED") {
      const dueAt = new Date(now.getTime() + FOLLOWUP_DELAY_MS);
      await tx.operatorNotificationDelivery.createMany({
        data: [
          {
            sourceSearchId: delivery.sourceSearchId,
            teeSearchId: delivery.teeSearchId,
            kind: "FOLLOWUP",
            recipient: delivery.recipient,
            summary: delivery.summary,
            dueAt,
            nextAttemptAt: dueAt,
          },
        ],
        skipDuplicates: true,
      });
    }
    return true;
  });
}

export async function processOperatorNotification(
  id: string,
): Promise<{ id: string; dueAt: string } | null> {
  const config = getOperatorNotificationConfig();
  if (!config) return null;
  const now = new Date();
  const delivery = await prisma.operatorNotificationDelivery.findUnique({
    where: { id },
  });
  if (!delivery) return null;
  if (delivery.status === "ACCEPTED")
    return nextFollowup(delivery.sourceSearchId);
  if (delivery.status !== "PENDING") return null;
  if (delivery.nextAttemptAt > now)
    return { id, dueAt: delivery.nextAttemptAt.toISOString() };
  const search = await loadSearch(delivery.teeSearchId);
  const subscription = await prisma.operatorPushSubscription.findUnique({
    where: { id: delivery.recipient },
  });
  if (
    !subscription ||
    subscription.ownerEmail !== config.ownerEmail ||
    subscription.publicKey !== config.publicKey ||
    (search &&
      !isEligibleOperatorNotificationSearch(search, config.excludedEmails)) ||
    (!search && delivery.kind === "CREATED")
  ) {
    await prisma.operatorNotificationDelivery.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "SUPPRESSED" },
    });
    return null;
  }
  const health =
    delivery.kind === "FOLLOWUP"
      ? assessOperatorNotificationHealth(search, now)
      : null;
  const summary =
    delivery.kind === "FOLLOWUP" && search
      ? buildOperatorNotificationSummary(search)
      : delivery.summary;
  const body =
    delivery.body ??
    `${delivery.kind === "CREATED" ? "Tee Time Spot: new customer alert" : "Tee Time Spot: 5-minute update"}\n${summary}\n${health ? `${health.text}\n` : ""}${config.origin}/operator`;
  const token = randomUUID();
  const claim = await prisma.operatorNotificationDelivery.updateMany({
    where: { id, status: "PENDING", nextAttemptAt: { lte: now } },
    data: {
      status: "SENDING",
      claimToken: token,
      claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
      attemptCount: { increment: 1 },
      body,
    },
  });
  if (!claim.count) return null;
  let result: Awaited<ReturnType<typeof sendOperatorNotification>>;
  try {
    result = await sendOperatorNotification(config, {
      id,
      body,
      subscription,
    });
  } catch (error) {
    const failure =
      error instanceof OperatorNotificationSendError
        ? error
        : new OperatorNotificationSendError("uncertain", "transport");
    const retry =
      failure.outcome === "retry" && delivery.attemptCount + 1 < MAX_ATTEMPTS;
    if (failure.code === "404" || failure.code === "410") {
      await prisma.operatorPushSubscription.deleteMany({
        where: { id: subscription.id },
      });
    }
    const nextAttemptAt = new Date(
      Date.now() +
        Math.max(
          Math.min(5, 2 ** delivery.attemptCount) * 60,
          failure.retryAfterSeconds ?? 0,
        ) *
          1000,
    );
    await prisma.operatorNotificationDelivery.updateMany({
      where: { id, status: "SENDING", claimToken: token },
      data: {
        status: retry
          ? "PENDING"
          : failure.outcome === "uncertain"
            ? "UNCERTAIN"
            : "FAILED",
        nextAttemptAt,
        claimExpiresAt: null,
        lastError: failure.code,
      },
    });
    console.error("[operator-notifications:send-incomplete]", {
      outcome: failure.outcome,
      code: failure.code,
    });
    return retry ? { id, dueAt: nextAttemptAt.toISOString() } : null;
  }
  // If persistence fails after acceptance, retain the in-flight claim for
  // operator review; an automatic resend could notify twice.
  await recordOperatorNotificationAcceptance({
    id,
    token,
    messageId: result.messageId,
    providerStatus: result.status,
  });
  return delivery.kind === "CREATED"
    ? nextFollowup(delivery.sourceSearchId)
    : null;
}

async function nextFollowup(sourceSearchId: string) {
  const row = await prisma.operatorNotificationDelivery.findUnique({
    where: { sourceSearchId_kind: { sourceSearchId, kind: "FOLLOWUP" } },
  });
  return row?.status === "PENDING"
    ? { id: row.id, dueAt: row.nextAttemptAt.toISOString() }
    : null;
}

export async function listOperatorNotificationForRecovery() {
  if (!getOperatorNotificationConfig()) return [];
  const now = new Date();
  await prisma.operatorNotificationDelivery.updateMany({
    where: { status: "SENDING", claimExpiresAt: { lt: now } },
    data: {
      status: "UNCERTAIN",
      claimExpiresAt: null,
      lastError: "send_receipt_missing",
    },
  });
  return prisma.operatorNotificationDelivery.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: 20,
    select: { id: true },
  });
}
