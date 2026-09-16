import type { Prisma } from "@prisma/client";
import { getOperatorSmsConfig } from "./config";
import {
  buildOperatorSmsSummary,
  isEligibleOperatorSmsSearch,
} from "./content";

export async function enqueueOperatorSms(
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
  const config = getOperatorSmsConfig();
  if (!config) return;
  const user = await transaction.user.findUniqueOrThrow({
    where: { id: search.userId },
    select: { email: true },
  });
  if (!isEligibleOperatorSmsSearch({ ...search, user }, config.excludedEmails))
    return;
  await transaction.operatorSmsDelivery.createMany({
    data: [
      {
        sourceSearchId: search.id,
        teeSearchId: search.id,
        kind: "CREATED",
        recipient: config.to,
        summary: buildOperatorSmsSummary({ ...search, user }),
        dueAt: search.createdAt,
        nextAttemptAt: search.createdAt,
      },
    ],
    skipDuplicates: true,
  });
}
