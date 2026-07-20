import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const DEFAULT_PENDING_EMAIL_RECOVERY_LIMIT = 25;
const MAX_PENDING_EMAIL_RECOVERY_LIMIT = 100;
const EXPIRED_OWNER_EMAIL_CLAIM_ERROR =
  "DELIVERY_OUTCOME_UNKNOWN_AFTER_OWNER_EMAIL_CHANGE";

type PendingEmailTransaction = Prisma.TransactionClient;

export type LockedPendingEmailUser = {
  id: string;
  clerkUserId: string;
  email: string;
  clerkUserUpdatedAt: Date | null;
  pendingEmail: string | null;
  pendingEmailObservedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LockedPendingEmailSearch = { id: string };

export type PendingClerkEmailApplyResult =
  | { outcome: "none"; retryAt?: never }
  | { outcome: "applied"; retryAt?: never }
  | { outcome: "deferred"; retryAt: Date | null };

export class SearchEmailDeliveryInProgressError extends Error {
  readonly code = "SEARCH_EMAIL_DELIVERY_IN_PROGRESS";
  readonly retryable = true;
  readonly retryAt: Date | null;

  constructor(retryAt: Date | null = null) {
    super("An alert update is currently being finalized. Please retry in a moment.");
    this.name = "SearchEmailDeliveryInProgressError";
    this.retryAt = retryAt;
  }
}

export async function lockUserForPendingEmailTransition(
  transaction: PendingEmailTransaction,
  input: { userId: string } | { clerkUserId: string }
) {
  if ("userId" in input) {
    const [user] = await transaction.$queryRaw<LockedPendingEmailUser[]>(Prisma.sql`
      SELECT
        "id",
        "clerkUserId",
        "email",
        "clerkUserUpdatedAt",
        "pendingEmail",
        "pendingEmailObservedAt",
        "createdAt",
        "updatedAt"
      FROM "User"
      WHERE "id" = ${input.userId}
      FOR UPDATE
    `);
    return user ?? null;
  }

  const [user] = await transaction.$queryRaw<LockedPendingEmailUser[]>(Prisma.sql`
    SELECT
      "id",
      "clerkUserId",
      "email",
      "clerkUserUpdatedAt",
      "pendingEmail",
      "pendingEmailObservedAt",
      "createdAt",
      "updatedAt"
    FROM "User"
    WHERE "clerkUserId" = ${input.clerkUserId}
    FOR UPDATE
  `);
  return user ?? null;
}

export async function lockOwnedSearchesForPendingEmailTransition(
  transaction: PendingEmailTransaction,
  userId: string
) {
  return transaction.$queryRaw<LockedPendingEmailSearch[]>(Prisma.sql`
    SELECT "id"
    FROM "TeeSearch"
    WHERE "userId" = ${userId}
    ORDER BY "id"
    FOR UPDATE
  `);
}

export async function fenceOwnedSearchesForEmailTransition(
  transaction: PendingEmailTransaction,
  input: {
    searchIds: string[];
    now: Date;
    pendingDeliveryRetryAt: Date | null;
  }
) {
  if (input.searchIds.length === 0) {
    return { count: 0 };
  }
  const waitingForClaim = Boolean(input.pendingDeliveryRetryAt);
  return transaction.teeSearch.updateMany({
    where: {
      id: { in: input.searchIds },
      status: "ACTIVE"
    },
    data: {
      scheduleVersion: { increment: 1 },
      checkStatus: waitingForClaim ? "WAITING" : "QUEUED",
      nextCheckAt: input.pendingDeliveryRetryAt ?? input.now,
      workflowRunId: null,
      checkLeaseToken: null,
      checkLeaseExpiresAt: null,
      recheckRequestedAt: waitingForClaim ? input.now : null
    }
  });
}

export async function findActiveOwnedEmailDeliveryClaim(
  transaction: PendingEmailTransaction,
  searchIds: string[],
  now: Date
) {
  if (searchIds.length === 0) {
    return null;
  }

  return transaction.searchEmailDelivery.findFirst({
    where: {
      teeSearchId: { in: searchIds },
      status: "SENDING",
      claimExpiresAt: { gt: now }
    },
    orderBy: [{ claimExpiresAt: "desc" }, { id: "asc" }],
    select: { claimExpiresAt: true }
  });
}

export async function terminalizeExpiredOwnedEmailDeliveryClaims(
  transaction: PendingEmailTransaction,
  searchIds: string[],
  now: Date
) {
  if (searchIds.length === 0) {
    return { count: 0 };
  }

  return transaction.searchEmailDelivery.updateMany({
    where: {
      teeSearchId: { in: searchIds },
      status: "SENDING",
      OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lte: now } }]
    },
    data: {
      status: "FAILED",
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: now,
      lastError: EXPIRED_OWNER_EMAIL_CLAIM_ERROR
    }
  });
}

export async function applyPendingClerkEmailForUser(
  transaction: PendingEmailTransaction,
  input: { userId: string; now?: Date }
): Promise<PendingClerkEmailApplyResult> {
  const now = input.now ?? new Date();
  const user = await lockUserForPendingEmailTransition(transaction, {
    userId: input.userId
  });
  if (!user?.pendingEmail) {
    return { outcome: "none" };
  }

  const searchRows = await lockOwnedSearchesForPendingEmailTransition(
    transaction,
    user.id
  );
  const searchIds = searchRows.map((search) => search.id);
  await terminalizeExpiredOwnedEmailDeliveryClaims(
    transaction,
    searchIds,
    now
  );
  const activeClaim = await findActiveOwnedEmailDeliveryClaim(
    transaction,
    searchIds,
    now
  );
  await fenceOwnedSearchesForEmailTransition(transaction, {
    searchIds,
    now,
    pendingDeliveryRetryAt: activeClaim?.claimExpiresAt ?? null
  });
  if (activeClaim) {
    return {
      outcome: "deferred",
      retryAt: activeClaim.claimExpiresAt
    };
  }

  const pendingEmail = normalizeEmail(user.pendingEmail);
  await transaction.user.update({
    where: { id: user.id },
    data: {
      ...(pendingEmail ? { email: pendingEmail } : {}),
      pendingEmail: null,
      pendingEmailObservedAt: null
    }
  });
  return { outcome: pendingEmail ? "applied" : "none" };
}

export function applyPendingClerkEmailForSearch(input: {
  searchId: string;
  now?: Date;
}): Promise<PendingClerkEmailApplyResult> {
  return prisma.$transaction(async (transaction) => {
    const search = await transaction.teeSearch.findUnique({
      where: { id: input.searchId },
      select: { userId: true }
    });
    if (!search) {
      return { outcome: "none" as const };
    }
    return applyPendingClerkEmailForUser(transaction, {
      userId: search.userId,
      now: input.now
    });
  });
}

export async function recoverPendingClerkEmailUpdates(input: {
  now?: Date;
  limit?: number;
} = {}) {
  const now = input.now ?? new Date();
  const limit = normalizeRecoveryLimit(input.limit);
  const candidates = await prisma.user.findMany({
    where: { pendingEmail: { not: null } },
    orderBy: [{ pendingEmailObservedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true }
  });

  let applied = 0;
  let deferred = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await prisma.$transaction((transaction) =>
        applyPendingClerkEmailForUser(transaction, {
          userId: candidate.id,
          now
        })
      );
      if (result.outcome === "applied") {
        applied += 1;
      } else if (result.outcome === "deferred") {
        deferred += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return {
    considered: candidates.length,
    applied,
    deferred,
    failed
  };
}

function normalizeRecoveryLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PENDING_EMAIL_RECOVERY_LIMIT;
  }
  return Math.min(
    MAX_PENDING_EMAIL_RECOVERY_LIMIT,
    Math.max(1, Math.trunc(limit))
  );
}

export function normalizeClerkEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeEmail(email: string) {
  return normalizeClerkEmail(email);
}
