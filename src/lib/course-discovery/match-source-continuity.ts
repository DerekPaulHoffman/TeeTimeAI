import type { Prisma } from "@prisma/client";

type MatchIdentity = {
  sourceId: string;
  startsAt: Date;
  endsAt?: Date | null;
  resourceId?: string | null;
  productId?: string | null;
  holes?: number | null;
};

function key(match: MatchIdentity) {
  return JSON.stringify([match.startsAt.toISOString(), match.endsAt?.toISOString() ?? null,
    match.resourceId ?? null, match.productId ?? null, match.holes ?? null]);
}

/** An interpreter change cannot make an already-known physical opening new.
 * Preserve identity only for exact, unambiguous one-to-one observations. */
export function preserveUnambiguousMatchSources<T extends MatchIdentity>(incoming: T[], previous: MatchIdentity[]): T[] {
  const counts = new Map<string, number>();
  const previousByKey = new Map<string, MatchIdentity[]>();
  for (const match of incoming) counts.set(key(match), (counts.get(key(match)) ?? 0) + 1);
  for (const match of previous) previousByKey.set(key(match), [...(previousByKey.get(key(match)) ?? []), match]);
  return incoming.map(match => {
    const identity = key(match), prior = previousByKey.get(identity);
    return counts.get(identity) === 1 && prior?.length === 1 ? { ...match, sourceId: prior[0].sourceId } : match;
  });
}

export async function continueGenericRecipeMatchSources<T extends MatchIdentity>(transaction: Prisma.TransactionClient,
  scope: { searchId: string; courseId: string; offeringId?: string }, matches: T[]): Promise<T[]> {
  if (!matches.length || matches.length > 1000) return matches;
  const previous = await transaction.teeTimeMatch.findMany({ where: {
    teeSearchId: scope.searchId, courseId: scope.courseId, offeringId: scope.offeringId ?? null,
    startsAt: { in: matches.map(match => match.startsAt) },
  }, take: 1001, select: { sourceId: true, startsAt: true, endsAt: true, resourceId: true, productId: true, holes: true } });
  // A large or ambiguous history is not authority to pick a prior identity.
  return previous.length > 1000 ? matches : preserveUnambiguousMatchSources(matches, previous);
}
