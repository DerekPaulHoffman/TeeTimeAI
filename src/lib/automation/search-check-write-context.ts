import { AsyncLocalStorage } from "node:async_hooks";

import { Prisma } from "@prisma/client";

type SearchCheckWriteContext = {
  searchId: string;
  scheduleVersion: number;
  leaseToken: string;
};

const currentSearchCheck = new AsyncLocalStorage<SearchCheckWriteContext>();

export function withSearchCheckWriteContext<T>(
  context: SearchCheckWriteContext,
  work: () => Promise<T>,
) {
  return currentSearchCheck.run(context, work);
}

export function getSearchCheckWriteContext() {
  return currentSearchCheck.getStore() ?? null;
}

// Lock the search row inside the same transaction as each check-result write.
// A stale worker can no longer publish a probe, monitoring change, or match
// after a new schedule generation or lease holder takes over.
export async function assertCurrentSearchCheckWrite(
  transaction: Prisma.TransactionClient,
) {
  const context = getSearchCheckWriteContext();
  if (!context) return;
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT "id" FROM "TeeSearch"
      WHERE "id" = ${context.searchId}
        AND "scheduleVersion" = ${context.scheduleVersion}
        AND "checkLeaseToken" = ${context.leaseToken}
        AND "status" = 'ACTIVE'::"SearchStatus"
        AND "checkStatus" = 'CHECKING'::"SearchCheckStatus"
        AND "checkLeaseExpiresAt" > statement_timestamp()
      FOR UPDATE
    `,
  );
  if (rows[0]?.id !== context.searchId) {
    throw new Error("Search check lease changed before its result could be saved");
  }
}
