import "./load-local-env";

import { pathToFileURL } from "node:url";

import {
  planSyntheticDeliveryStateRepair,
  type SyntheticSearchDeliveryRepairPlan
} from "@/lib/email/synthetic-delivery-state-repair";
import { prisma } from "@/lib/prisma";

type DeliveryRepairOptions = {
  emailTag: string;
  expectedSearches: number;
  apply: boolean;
};

export async function repairSyntheticDeliveryState(options: DeliveryRepairOptions) {
  validateOptions(options);
  const searches = await prisma.teeSearch.findMany({
    where: {
      syntheticMultiCycle: true,
      user: { email: { contains: options.emailTag, mode: "insensitive" } }
    },
    select: {
      id: true,
      user: { select: { email: true } },
      matches: {
        select: { id: true, alertStatus: true, sentAt: true }
      },
      emailDeliveries: {
        where: {
          kind: "MATCH",
          isOwnerRecipient: true,
          status: "SENT"
        },
        select: { sentAt: true, payload: true }
      }
    }
  });
  if (searches.length !== options.expectedSearches) {
    throw new Error(
      `Expected ${options.expectedSearches} cohort searches but found ${searches.length}; no repair was applied.`
    );
  }

  const plan = planSyntheticDeliveryStateRepair(searches, options.emailTag);
  assertUniqueOrdinals(plan);
  const changedOrdinals = plan
    .filter(
      (entry) => entry.restoreSent.length > 0 || entry.clearFalseSentAt.length > 0
    )
    .map((entry) => ({
      ordinal: entry.ordinal,
      restoredSent: entry.restoreSent.length,
      clearedFalseSentAt: entry.clearFalseSentAt.length
    }));
  const totals = changedOrdinals.reduce(
    (result, entry) => ({
      restoredSent: result.restoredSent + entry.restoredSent,
      clearedFalseSentAt:
        result.clearedFalseSentAt + entry.clearedFalseSentAt
    }),
    { restoredSent: 0, clearedFalseSentAt: 0 }
  );

  if (options.apply && (totals.restoredSent > 0 || totals.clearedFalseSentAt > 0)) {
    await prisma.$transaction(async (transaction) => {
      for (const entry of plan) {
        const restoreGroups = groupRestoresBySentAt(entry.restoreSent);
        for (const [sentAt, matches] of restoreGroups) {
          const updated = await transaction.teeTimeMatch.updateMany({
            where: {
              teeSearchId: entry.searchId,
              id: { in: matches.map((match) => match.matchId) },
              alertStatus: "SUPPRESSED"
            },
            data: { alertStatus: "SENT", sentAt: new Date(sentAt) }
          });
          if (updated.count !== matches.length) {
            throw new Error(
              "Match delivery state changed during repair; transaction rolled back."
            );
          }
        }
        if (entry.clearFalseSentAt.length > 0) {
          const updated = await transaction.teeTimeMatch.updateMany({
            where: {
              teeSearchId: entry.searchId,
              id: { in: entry.clearFalseSentAt },
              alertStatus: "SUPPRESSED",
              sentAt: { not: null }
            },
            data: { sentAt: null }
          });
          if (updated.count !== entry.clearFalseSentAt.length) {
            throw new Error(
              "Match delivery state changed during repair; transaction rolled back."
            );
          }
        }
      }
    });
  }

  return {
    mode: options.apply ? "apply" : "dry-run",
    expectedSearches: options.expectedSearches,
    observedSearches: searches.length,
    totals,
    changedOrdinals
  };
}

function groupRestoresBySentAt(
  restores: SyntheticSearchDeliveryRepairPlan["restoreSent"]
) {
  const groups = new Map<
    string,
    SyntheticSearchDeliveryRepairPlan["restoreSent"]
  >();
  for (const restore of restores) {
    const key = restore.sentAt.toISOString();
    groups.set(key, [...(groups.get(key) ?? []), restore]);
  }
  return groups;
}

function assertUniqueOrdinals(plan: SyntheticSearchDeliveryRepairPlan[]) {
  const ordinals = plan.map((entry) => entry.ordinal);
  if (new Set(ordinals).size !== ordinals.length) {
    throw new Error("Cohort ordinals were not unique; no repair was applied.");
  }
}

function validateOptions(options: DeliveryRepairOptions) {
  if (!/^\+[a-z0-9][a-z0-9-]{2,80}-$/i.test(options.emailTag)) {
    throw new Error("--email-tag must be a bounded plus-address local-part tag.");
  }
  if (!Number.isInteger(options.expectedSearches) || options.expectedSearches < 1) {
    throw new Error("--expected-searches must be a positive integer.");
  }
}

function parseArgs(argv: string[]): DeliveryRepairOptions {
  const emailTagIndex = argv.indexOf("--email-tag");
  const emailTag = emailTagIndex >= 0 ? argv[emailTagIndex + 1] : undefined;
  const expectedIndex = argv.indexOf("--expected-searches");
  const expectedSearches = Number(
    expectedIndex >= 0 ? argv[expectedIndex + 1] : "30"
  );
  if (!emailTag) {
    throw new Error("--email-tag is required.");
  }
  return { emailTag, expectedSearches, apply: argv.includes("--apply") };
}

async function main() {
  console.log(
    JSON.stringify(
      await repairSyntheticDeliveryState(parseArgs(process.argv.slice(2))),
      null,
      2
    )
  );
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
