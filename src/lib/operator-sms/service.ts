import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOperatorSmsConfig } from "./config";
import {
  assessOperatorSmsHealth,
  buildOperatorSmsSummary,
  isEligibleOperatorSmsSearch,
} from "./content";
import { sendOperatorSms, SmsSendError } from "./twilio";

const FOLLOWUP_DELAY_MS = 5 * 60_000;
const CLAIM_MS = 60_000;
const MAX_ATTEMPTS = 5;
const TERMINAL_PROVIDER_STATUSES = new Set([
  "delivered",
  "failed",
  "undelivered",
]);

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

export async function recordOperatorSmsAcceptance(input: {
  id: string;
  token: string;
  sid: string;
  providerStatus: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.operatorSmsDelivery.updateMany({
      where: {
        id: input.id,
        claimToken: input.token,
        status: { in: ["SENDING", "UNCERTAIN"] },
      },
      data: {
        status: "ACCEPTED",
        acceptedAt: now,
        providerSid: input.sid,
        providerStatus: input.providerStatus,
        claimExpiresAt: null,
        lastError: ["failed", "undelivered"].includes(input.providerStatus)
          ? `provider_${input.providerStatus}`
          : null,
      },
    });
    if (!claimed.count) return false;
    const delivery = await tx.operatorSmsDelivery.findUniqueOrThrow({
      where: { id: input.id },
    });
    if (delivery.kind === "CREATED") {
      const dueAt = new Date(now.getTime() + FOLLOWUP_DELAY_MS);
      await tx.operatorSmsDelivery.createMany({
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

export async function recordOperatorSmsCallback(input: {
  id: string;
  token: string;
  sid: string;
  status: string;
}) {
  if (
    ![
      "accepted",
      "queued",
      "sending",
      "sent",
      "delivered",
      "failed",
      "undelivered",
    ].includes(input.status)
  )
    return;
  const newlyAccepted = await recordOperatorSmsAcceptance({
    ...input,
    providerStatus: input.status,
  });
  // Terminal receipts win over an earlier queued/sent receipt arriving late.
  await prisma.operatorSmsDelivery.updateMany({
    where: {
      id: input.id,
      claimToken: input.token,
      providerSid: input.sid,
      providerStatus: { notIn: [...TERMINAL_PROVIDER_STATUSES] },
    },
    data: {
      providerStatus: input.status,
      ...(["failed", "undelivered"].includes(input.status)
        ? { lastError: `provider_${input.status}` }
        : {}),
    },
  });
  if (!newlyAccepted) return null;
  const delivery = await prisma.operatorSmsDelivery.findUnique({
    where: { id: input.id },
    select: { sourceSearchId: true },
  });
  return delivery?.sourceSearchId ?? null;
}

export async function processOperatorSms(
  id: string,
): Promise<{ id: string; dueAt: string } | null> {
  const config = getOperatorSmsConfig();
  if (!config) return null;
  const now = new Date();
  const delivery = await prisma.operatorSmsDelivery.findUnique({
    where: { id },
  });
  if (!delivery) return null;
  if (delivery.status === "ACCEPTED")
    return nextFollowup(delivery.sourceSearchId);
  if (delivery.status !== "PENDING") return null;
  if (delivery.nextAttemptAt > now)
    return { id, dueAt: delivery.nextAttemptAt.toISOString() };
  const search = await loadSearch(delivery.teeSearchId);
  if (
    delivery.recipient !== config.to ||
    (search && !isEligibleOperatorSmsSearch(search, config.excludedEmails)) ||
    (!search && delivery.kind === "CREATED")
  ) {
    await prisma.operatorSmsDelivery.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "SUPPRESSED" },
    });
    return null;
  }
  const health =
    delivery.kind === "FOLLOWUP" ? assessOperatorSmsHealth(search, now) : null;
  const summary =
    delivery.kind === "FOLLOWUP" && search
      ? buildOperatorSmsSummary(search)
      : delivery.summary;
  const body =
    delivery.body ??
    `${delivery.kind === "CREATED" ? "Tee Time Spot: new customer alert" : "Tee Time Spot: 5-minute update"}\n${summary}\n${health ? `${health.text}\n` : ""}${config.origin}/operator`;
  const token = randomUUID();
  const claim = await prisma.operatorSmsDelivery.updateMany({
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
  let result: Awaited<ReturnType<typeof sendOperatorSms>>;
  try {
    result = await sendOperatorSms(config, {
      id,
      token,
      body,
      to: delivery.recipient,
    });
  } catch (error) {
    const failure =
      error instanceof SmsSendError
        ? error
        : new SmsSendError("uncertain", "transport");
    const retry =
      failure.outcome === "retry" && delivery.attemptCount + 1 < MAX_ATTEMPTS;
    const nextAttemptAt = new Date(
      Date.now() + Math.min(5, 2 ** delivery.attemptCount) * 60_000,
    );
    await prisma.operatorSmsDelivery.updateMany({
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
    console.error("[operator-sms:send-incomplete]", {
      outcome: failure.outcome,
      code: failure.code,
    });
    return retry ? { id, dueAt: nextAttemptAt.toISOString() } : null;
  }
  // If persistence fails after acceptance, retain the in-flight claim. A signed
  // callback can reconcile it; an automatic resend could text twice.
  await recordOperatorSmsAcceptance({
    id,
    token,
    sid: result.sid,
    providerStatus: result.status,
  });
  return delivery.kind === "CREATED"
    ? nextFollowup(delivery.sourceSearchId)
    : null;
}

async function nextFollowup(sourceSearchId: string) {
  const row = await prisma.operatorSmsDelivery.findUnique({
    where: { sourceSearchId_kind: { sourceSearchId, kind: "FOLLOWUP" } },
  });
  return row?.status === "PENDING"
    ? { id: row.id, dueAt: row.nextAttemptAt.toISOString() }
    : null;
}

export async function listOperatorSmsForRecovery() {
  if (!getOperatorSmsConfig()) return [];
  const now = new Date();
  await prisma.operatorSmsDelivery.updateMany({
    where: { status: "SENDING", claimExpiresAt: { lt: now } },
    data: {
      status: "UNCERTAIN",
      claimExpiresAt: null,
      lastError: "send_receipt_missing",
    },
  });
  return prisma.operatorSmsDelivery.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: 20,
    select: { id: true },
  });
}
