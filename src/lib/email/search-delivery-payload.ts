import { createHash } from "node:crypto";

import {
  Prisma,
  type SearchEmailDeliveryKind
} from "@prisma/client";

export type SearchEmailMatchRef = {
  matchId: string;
  availabilityCycle: number;
};

export type SearchEmailDeliveryPayload = {
  schemaVersion: 2;
  checkedAt: string;
  matchIds?: string[];
  matchRefs?: SearchEmailMatchRef[];
  displayMatchIds?: string[];
  recipientCatchup?: boolean;
  satisfiesStatusReport?: boolean;
  statusSnapshot?: Prisma.InputJsonValue;
  statusReport?: Prisma.InputJsonValue;
  matchReport?: Prisma.InputJsonValue;
};

export function parseSearchEmailPayload(
  value: unknown
): SearchEmailDeliveryPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.schemaVersion !== 2 ||
    typeof payload.checkedAt !== "string" ||
    Number.isNaN(new Date(payload.checkedAt).getTime())
  ) {
    return null;
  }
  return {
    schemaVersion: 2,
    checkedAt: payload.checkedAt,
    ...(Array.isArray(payload.matchIds)
      ? {
          matchIds: payload.matchIds.filter(
            (id): id is string => typeof id === "string"
          )
        }
      : {}),
    ...(Array.isArray(payload.matchRefs)
      ? {
          matchRefs: payload.matchRefs
            .map(optionalJsonRecord)
            .filter(
              (candidate): candidate is Record<string, unknown> =>
                Boolean(candidate)
            )
            .map((candidate) => ({
              matchId: optionalString(candidate.matchId),
              availabilityCycle: optionalNumber(candidate.availabilityCycle)
            }))
            .filter(
              (
                candidate
              ): candidate is SearchEmailMatchRef =>
                Boolean(
                  candidate.matchId &&
                    Number.isInteger(candidate.availabilityCycle) &&
                    (candidate.availabilityCycle ?? -1) >= 0
                )
            )
        }
      : {}),
    ...(Array.isArray(payload.displayMatchIds)
      ? {
          displayMatchIds: payload.displayMatchIds.filter(
            (id): id is string => typeof id === "string"
          )
        }
      : {}),
    ...(typeof payload.recipientCatchup === "boolean"
      ? { recipientCatchup: payload.recipientCatchup }
      : {}),
    ...(typeof payload.satisfiesStatusReport === "boolean"
      ? { satisfiesStatusReport: payload.satisfiesStatusReport }
      : {}),
    ...(payload.statusSnapshot !== undefined
      ? { statusSnapshot: payload.statusSnapshot as Prisma.InputJsonValue }
      : {}),
    ...(payload.statusReport !== undefined
      ? { statusReport: payload.statusReport as Prisma.InputJsonValue }
      : {}),
    ...(payload.matchReport !== undefined
      ? { matchReport: payload.matchReport as Prisma.InputJsonValue }
      : {})
  };
}

export function normalizeSearchEmailRecipients(recipients: string[]) {
  return [
    ...new Set(recipients.map(normalizeSearchEmailRecipient).filter(Boolean))
  ];
}

export function normalizeSearchEmailRecipient(recipient: string) {
  return recipient.trim().toLowerCase();
}

export function toSearchEmailMatchRefKey(match: SearchEmailMatchRef) {
  return `${match.matchId}:${match.availabilityCycle}`;
}

export function uniqueSearchEmailMatchRefs(matchRefs: SearchEmailMatchRef[]) {
  return [
    ...new Map(
      matchRefs.map(
        (match) => [toSearchEmailMatchRefKey(match), match] as const
      )
    ).values()
  ];
}

export function canonicalSearchEmailJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSearchEmailJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${canonicalSearchEmailJson(child)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function getStableSearchEmailDeliveryIdempotencyKey(input: {
  searchId: string;
  kind: SearchEmailDeliveryKind;
  groupKey: string;
  recipient: string;
  payload: SearchEmailDeliveryPayload;
}) {
  return `tee-search-delivery-${createHash("sha256")
    .update(
      canonicalSearchEmailJson({
        searchId: input.searchId,
        kind: input.kind,
        groupKey: input.groupKey,
        recipient: normalizeSearchEmailRecipient(input.recipient),
        payload: input.payload
      })
    )
    .digest("hex")
    .slice(0, 32)}`;
}

export function optionalJsonRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
