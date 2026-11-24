import type { Prisma } from "@prisma/client";
import { getOperatorNotificationDeliveryConfig } from "./config";
import {
  buildOperatorNotificationSummary,
  isEligibleOperatorNotificationSearch,
} from "./content";
import { NTFY_NEW_ALERT_MESSAGE } from "./ntfy";

export async function enqueueOperatorNotification(
  transaction: Prisma.TransactionClient,
  search: {
    id: string;
    userId: string;
    trafficClass: string;
    syntheticMultiCycle: boolean;
    syntheticTestWindow?: unknown;
    alertEmail?: string | null;
    createdAt: Date;
    date: Date;
    startTime: string;
    endTime: string;
    players: number;
    mode?: "OUTDOOR" | "SIMULATOR";
    durationMinutes?: number | null;
    preferences: Array<{ rank: number; course: { name: string } }>;
  },
) {
  const config = getOperatorNotificationDeliveryConfig();
  if (!config) return;
  const user = await transaction.user.findUniqueOrThrow({
    where: { id: search.userId },
    select: { email: true },
  });
  if (
    !isEligibleOperatorNotificationSearch(
      { ...search, user },
      config.excludedEmails,
    )
  )
    return;
  let recipient: string;
  let summary = NTFY_NEW_ALERT_MESSAGE;
  if ("topic" in config) {
    recipient = config.recipient;
  } else {
    const subscription = await transaction.operatorPushSubscription.findUnique({
      where: { ownerEmail: config.ownerEmail },
    });
    if (!subscription || subscription.publicKey !== config.publicKey) return;
    recipient = subscription.id;
    summary = buildOperatorNotificationSummary({ ...search, user });
  }
  await transaction.operatorNotificationDelivery.createMany({
    data: [
      {
        sourceSearchId: search.id,
        teeSearchId: search.id,
        kind: "CREATED",
        recipient,
        summary,
        dueAt: search.createdAt,
        nextAttemptAt: search.createdAt,
      },
    ],
    skipDuplicates: true,
  });
}
