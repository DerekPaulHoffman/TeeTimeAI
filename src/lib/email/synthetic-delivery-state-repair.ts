export type SyntheticDeliveryRepairSearch = {
  id: string;
  user: { email: string };
  matches: Array<{
    id: string;
    alertStatus: string;
    sentAt: Date | null;
  }>;
  emailDeliveries: Array<{
    sentAt: Date | null;
    payload: unknown;
  }>;
};

export type SyntheticSearchDeliveryRepairPlan = {
  searchId: string;
  ordinal: string;
  restoreSent: Array<{ matchId: string; sentAt: Date }>;
  clearFalseSentAt: string[];
};

export function planSyntheticDeliveryStateRepair(
  searches: SyntheticDeliveryRepairSearch[],
  emailTag: string
) {
  return searches.map((search) => {
    const acceptedSentAtByMatchId = new Map<string, Date>();
    for (const delivery of search.emailDeliveries) {
      if (!delivery.sentAt) {
        continue;
      }
      for (const matchId of getCoveredMatchIds(delivery.payload)) {
        const previous = acceptedSentAtByMatchId.get(matchId);
        if (!previous || delivery.sentAt < previous) {
          acceptedSentAtByMatchId.set(matchId, delivery.sentAt);
        }
      }
    }

    const restoreSent: SyntheticSearchDeliveryRepairPlan["restoreSent"] = [];
    const clearFalseSentAt: string[] = [];
    for (const match of search.matches) {
      if (match.alertStatus !== "SUPPRESSED") {
        continue;
      }
      const acceptedSentAt = acceptedSentAtByMatchId.get(match.id);
      if (acceptedSentAt) {
        restoreSent.push({ matchId: match.id, sentAt: acceptedSentAt });
      } else if (match.sentAt) {
        clearFalseSentAt.push(match.id);
      }
    }

    return {
      searchId: search.id,
      ordinal: getOrdinal(search.user.email, emailTag),
      restoreSent,
      clearFalseSentAt
    } satisfies SyntheticSearchDeliveryRepairPlan;
  });
}

function getCoveredMatchIds(payload: unknown) {
  if (!isRecord(payload)) {
    return [];
  }
  // matchRefs is the current immutable ownership set. Legacy accepted payloads
  // can contain only matchIds, so use the union when reconciling old rows.
  return [
    ...new Set(
      [
        ...(Array.isArray(payload.matchRefs)
          ? payload.matchRefs.flatMap((value) =>
              isRecord(value) && typeof value.matchId === "string"
                ? [value.matchId]
                : []
            )
          : []),
        ...(Array.isArray(payload.matchIds)
          ? payload.matchIds.filter(
              (value): value is string => typeof value === "string"
            )
          : [])
      ]
    )
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOrdinal(email: string, emailTag: string) {
  const match = new RegExp(`${escapeRegExp(emailTag)}(\\d{2})(?:@|-)`, "i").exec(email);
  if (!match?.[1]) {
    throw new Error("A cohort search did not have a valid two-digit ordinal.");
  }
  return match[1];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
