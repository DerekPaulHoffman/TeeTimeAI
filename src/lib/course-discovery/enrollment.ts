import type { Prisma } from "@prisma/client";
import { automaticDiscoveryPilot, matchingDiscoveryPilotTargetKey, type DiscoveryPilotTargetSearch } from "./config";

type NewSearch = DiscoveryPilotTargetSearch & { id: string; userId: string; trafficClass: string; syntheticMultiCycle: boolean };

/** Called inside ordinary search creation, before that transaction commits.
 * The existing User row serializes parallel saves for this exact pilot owner. */
export async function enrollDiscoveryPilotInTransaction(tx: Prisma.TransactionClient, search: NewSearch,
  env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const pilot = automaticDiscoveryPilot(env);
  if (!pilot || search.userId !== pilot.ownerUserId || ["TEST", "AUTOMATION"].includes(search.trafficClass) ||
    search.syntheticMultiCycle || !["OUTDOOR", "SIMULATOR"].includes(search.mode) || search.preferences.length !== 1) return false;
  const targetKey = matchingDiscoveryPilotTargetKey(search, pilot.targetKeys);
  if (!targetKey) return false;
  // Search insertion already holds a foreign-key KEY SHARE lock on this row.
  // NO KEY UPDATE serializes quota writers without a lock-upgrade deadlock.
  const owner = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${pilot.ownerUserId} FOR NO KEY UPDATE`;
  if (owner.length !== 1) return false;
  const existing = await tx.courseDiscoveryPilotEnrollment.findUnique({ where: { searchId: search.id } });
  if (existing) return existing.cohortId === pilot.cohortId && existing.ownerUserId === pilot.ownerUserId && existing.targetKey === targetKey;
  if (await tx.courseDiscoveryPilotEnrollment.findUnique({ where: { cohortId_targetKey: { cohortId: pilot.cohortId, targetKey } } })) return false;
  const consumed = await tx.courseDiscoveryPilotEnrollment.count({ where: { cohortId: pilot.cohortId } });
  if (consumed >= 3) return false;
  await tx.courseDiscoveryPilotEnrollment.create({ data: { searchId: search.id, ownerUserId: pilot.ownerUserId,
    cohortId: pilot.cohortId, targetKey, slot: consumed + 1 } });
  return true;
}
