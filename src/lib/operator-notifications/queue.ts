import type { Prisma } from "@prisma/client";
import { getOperatorNotificationConfig } from "./config";
import {
  buildOperatorNotificationSummary,
  isEligibleOperatorNotificationSearch,
} from "./content";

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
    preferences: Array<{ rank: number; course: { name: string } }>;
  },
) {
  const config = getOperatorNotificationConfig();
  if (!config) return;
  const subscription = await transaction.operatorPushSubscription.findUnique({
    where: { ownerEmail: config.ownerEmail },
  });
  if (!subscription || subscription.publicKey !== config.publicKey) return;
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
  await transaction.operatorNotificationDelivery.createMany({
    data: [
      {
        sourceSearchId: search.id,
        teeSearchId: search.id,
        kind: "CREATED",
        recipient: subscription.id,
        summary: buildOperatorNotificationSummary({ ...search, user }),
        dueAt: search.createdAt,
        nextAttemptAt: search.createdAt,
      },
    ],
    skipDuplicates: true,
  });
}
