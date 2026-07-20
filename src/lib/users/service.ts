import { prisma } from "@/lib/prisma";
import {
  fenceOwnedSearchesForEmailTransition,
  findActiveOwnedEmailDeliveryClaim,
  lockOwnedSearchesForPendingEmailTransition,
  lockUserForPendingEmailTransition,
  normalizeClerkEmail,
  SearchEmailDeliveryInProgressError,
  terminalizeExpiredOwnedEmailDeliveryClaims
} from "@/lib/users/pending-email";

export async function upsertClerkUser(input: {
  clerkUserId: string;
  email: string;
  clerkUpdatedAt: Date;
}) {
  const normalizedEmail = normalizeClerkEmail(input.email);
  const now = new Date();
  const clerkUpdatedAt = new Date(input.clerkUpdatedAt);
  if (!Number.isFinite(clerkUpdatedAt.getTime())) {
    throw new Error("The Clerk user update timestamp is invalid");
  }
  const result = await prisma.$transaction(async (transaction) => {
    let user = await lockUserForPendingEmailTransition(transaction, {
      clerkUserId: input.clerkUserId
    });
    if (!user) {
      await transaction.user.upsert({
        where: { clerkUserId: input.clerkUserId },
        update: {},
        create: {
          clerkUserId: input.clerkUserId,
          email: normalizedEmail,
          clerkUserUpdatedAt: clerkUpdatedAt
        }
      });
      user = await lockUserForPendingEmailTransition(transaction, {
        clerkUserId: input.clerkUserId
      });
      if (!user) {
        throw new Error("The Clerk user could not be persisted");
      }
    }

    const persistedClerkVersion = user.clerkUserUpdatedAt?.getTime() ?? null;
    const incomingClerkVersion = clerkUpdatedAt.getTime();
    const pendingEmailMatches =
      user.pendingEmail !== null &&
      normalizeClerkEmail(user.pendingEmail) === normalizedEmail;
    const appliedEmailMatches =
      user.pendingEmail === null && normalizeClerkEmail(user.email) === normalizedEmail;
    if (
      persistedClerkVersion !== null &&
      (incomingClerkVersion < persistedClerkVersion ||
        (incomingClerkVersion === persistedClerkVersion &&
          !pendingEmailMatches &&
          !appliedEmailMatches))
    ) {
      return { outcome: "ready" as const, user };
    }

    const emailChanged = normalizeClerkEmail(user.email) !== normalizedEmail;
    const sourceVersionAdvanced =
      persistedClerkVersion === null || incomingClerkVersion > persistedClerkVersion;
    if (!emailChanged && !user.pendingEmail && sourceVersionAdvanced) {
      if (persistedClerkVersion === null) {
        const searchRows = await lockOwnedSearchesForPendingEmailTransition(
          transaction,
          user.id
        );
        await fenceOwnedSearchesForEmailTransition(transaction, {
          searchIds: searchRows.map((search) => search.id),
          now,
          pendingDeliveryRetryAt: null
        });
      }
      user = await transaction.user.update({
        where: { id: user.id },
        data: { clerkUserUpdatedAt: clerkUpdatedAt }
      });
    }
    if (emailChanged || user.pendingEmail) {
      const searchRows = await lockOwnedSearchesForPendingEmailTransition(
        transaction,
        user.id
      );
      const searchIds = searchRows.map((search) => search.id);
      if (emailChanged) {
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
          const shouldReplacePending =
            sourceVersionAdvanced;
          if (shouldReplacePending) {
            await transaction.user.update({
              where: { id: user.id },
              data: {
                pendingEmail: normalizedEmail,
                pendingEmailObservedAt: clerkUpdatedAt,
                clerkUserUpdatedAt: clerkUpdatedAt
              }
            });
          }
          return {
            outcome: "deferred" as const,
            retryAt: activeClaim.claimExpiresAt
          };
        }
      } else {
        await fenceOwnedSearchesForEmailTransition(transaction, {
          searchIds,
          now,
          pendingDeliveryRetryAt: null
        });
      }

      user = await transaction.user.update({
        where: { id: user.id },
        data: {
          email: normalizedEmail,
          clerkUserUpdatedAt: clerkUpdatedAt,
          pendingEmail: null,
          pendingEmailObservedAt: null
        }
      });
    }

    const effectiveEmail = normalizeClerkEmail(user.email);
    const guestUser = await transaction.user.findUnique({
      where: { clerkUserId: guestUserKey(effectiveEmail) },
      select: { id: true }
    });

    if (guestUser && guestUser.id !== user.id) {
      await transaction.teeSearch.updateMany({
        where: { userId: guestUser.id },
        data: { userId: user.id }
      });
    }

    return { outcome: "ready" as const, user };
  });

  if (result.outcome === "deferred") {
    throw new SearchEmailDeliveryInProgressError(result.retryAt);
  }
  return result.user;
}

export function upsertGuestUser(email: string) {
  const normalizedEmail = normalizeClerkEmail(email);

  return prisma.user.upsert({
    where: { clerkUserId: guestUserKey(normalizedEmail) },
    update: { email: normalizedEmail },
    create: {
      clerkUserId: guestUserKey(normalizedEmail),
      email: normalizedEmail
    }
  });
}

function guestUserKey(email: string) {
  return `guest:${email}`;
}
