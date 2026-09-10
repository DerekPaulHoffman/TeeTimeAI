import { createHash } from "node:crypto";

import type { CourseSupportClaimActionPlan } from "./course-support-action-plan";

import {
  isKnownPublicSearchSurfaceUrl,
  isSafeManualEvidenceUrl,
} from "./browser-discovery";

const REDIRECTOR_HOSTS = new Set([
  "bit.ly",
  "goo.gl",
  "l.facebook.com",
  "lnkd.in",
  "t.co",
  "tinyurl.com",
]);

export type CourseSupportSourceSearchContext = {
  query: string;
  queryDigest: string;
  missingIdentityFields: Array<"ADDRESS" | "CITY" | "STATE">;
};

export type CourseSupportSourceSearchResult =
  | { result: "CANDIDATE"; candidateUrl: string }
  | { result: "NO_UNIQUE"; candidateUrl: null };

export type CourseSupportSourceSearchIdentity = {
  name: string;
  address: string | null;
  city: string | null;
  stateCode: string | null;
};

export function buildCourseSupportSourceSearchContext(
  input: CourseSupportSourceSearchIdentity,
): CourseSupportSourceSearchContext {
  const name = normalizeSearchPart(input.name);
  const address = normalizeSearchPart(input.address);
  const city = normalizeSearchPart(input.city);
  const stateCode = normalizeSearchPart(input.stateCode)?.toUpperCase() ?? null;
  if (!name) {
    throw new Error("Exact source search requires the current course name.");
  }
  const missingIdentityFields: CourseSupportSourceSearchContext["missingIdentityFields"] = [
    ...(address ? [] : (["ADDRESS"] as const)),
    ...(city ? [] : (["CITY"] as const)),
    ...(stateCode ? [] : (["STATE"] as const)),
  ];
  const locality = [city, stateCode].filter(Boolean).join(" ");
  // Retrieval needs to tolerate official name/address formatting differences.
  // Identity is established by the owned browser verifier, not exact phrases
  // (especially the generic words "official golf course") in a search index.
  const query = [name, address, locality || null, "official golf course"]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return {
    query,
    queryDigest: sha256(query.toLocaleLowerCase("en-US")),
    missingIdentityFields,
  };
}

/** Capability-change evidence only; this never authorizes or performs reopening. */
export function getCourseSupportSourceQueryChange(input: {
  identity: CourseSupportSourceSearchIdentity;
  priorResult: unknown;
  priorQueryDigest: unknown;
}) {
  if (input.priorResult !== "NO_UNIQUE" || typeof input.priorQueryDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.priorQueryDigest)) return null;
  const normalizeLegacyPart = (value: string | null) => value?.replace(/\s+/gu, " ").trim() || null;
  const name = normalizeLegacyPart(input.identity.name);
  if (!name) return null;
  const locality = [normalizeLegacyPart(input.identity.city),
    normalizeLegacyPart(input.identity.stateCode)?.toUpperCase()].filter(Boolean).join(", ");
  // Reconstruct only the released defective recipe. Arbitrary query changes or
  // changed course facts cannot turn another negative result into this proof.
  const legacyQuery = [name, normalizeLegacyPart(input.identity.address), locality || null, "official golf course"]
    .filter((part): part is string => Boolean(part))
    .map(part => `"${part.replace(/["“”]+/gu, " ").replace(/\s+/gu, " ").trim()}"`)
    .join(" ");
  if (sha256(legacyQuery.toLocaleLowerCase("en-US")) !== input.priorQueryDigest) return null;
  let current: CourseSupportSourceSearchContext;
  try { current = buildCourseSupportSourceSearchContext(input.identity); } catch { return null; }
  if (current.queryDigest === input.priorQueryDigest) return null;
  return {
    priorRecipe: "QUOTED_IDENTITIES_V1" as const,
    currentRecipe: "IDENTITY_TERMS_V2" as const,
    priorQueryDigest: input.priorQueryDigest,
    currentQueryDigest: current.queryDigest,
  };
}

export function normalizeCourseSupportSourceSearchResult(input: {
  candidateUrl?: string | null;
  noUnique?: boolean;
}): CourseSupportSourceSearchResult {
  const candidateUrl = input.candidateUrl?.trim() || null;
  if (Boolean(candidateUrl) === Boolean(input.noUnique)) {
    throw new Error(
      "Source search must record exactly one direct candidate or the NO_UNIQUE result.",
    );
  }
  if (!candidateUrl) {
    return { result: "NO_UNIQUE", candidateUrl: null };
  }
  if (candidateUrl.length > 2_048) {
    throw new Error("Source-search candidate URL is too long.");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    throw new Error("Source-search candidate must be a direct public URL.");
  }
  if (
    !isSafeManualEvidenceUrl(parsed) ||
    isKnownPublicSearchSurfaceUrl(parsed) ||
    REDIRECTOR_HOSTS.has(parsed.hostname.toLocaleLowerCase("en-US"))
  ) {
    throw new Error(
      "Source-search candidate must be a direct safe public URL.",
    );
  }
  parsed.hash = "";
  return { result: "CANDIDATE", candidateUrl: parsed.toString() };
}

export function buildCourseSupportSourceSearchScopeDigest(input: {
  batchId: string;
  incidentId: string;
  cycle: number;
  actionPlan?: CourseSupportClaimActionPlan | null;
}) {
  const baseScopeDigest = sha256(
    [
      "course-support-source-search-v1",
      input.batchId,
      input.incidentId,
      input.cycle,
    ].join("\0"),
  );
  // Modern candidates are bound to the canonical persisted assignment, not
  // just the batch and cycle. Keep the legacy digest only for legacy claims.
  return input.actionPlan
    ? sha256([baseScopeDigest, JSON.stringify(input.actionPlan)].join("\0"))
    : baseScopeDigest;
}

export function buildCourseSupportSourceSearchAttemptRef(input: {
  scopeDigest: string;
  queryDigest: string;
  courseUpdatedAt: Date;
}) {
  if (!Number.isFinite(input.courseUpdatedAt.getTime())) {
    throw new Error("Source-search course snapshot is invalid.");
  }
  return sha256(
    [
      "course-support-source-search-attempt-v1",
      input.scopeDigest,
      input.queryDigest,
      input.courseUpdatedAt.toISOString(),
    ].join("\0"),
  );
}

/** One immutable research result per rejected source, independent of batch ownership. */
export function buildCourseSupportRetainedSourceSearchKey(input: {
  incidentId: string;
  cycle: number;
  rejectionEvidenceDigest: string;
}) {
  if (
    !input.incidentId ||
    !Number.isInteger(input.cycle) || input.cycle < 1 ||
    !/^[a-f0-9]{64}$/u.test(input.rejectionEvidenceDigest)
  ) {
    throw new Error("Retained-source research scope is invalid.");
  }
  return `course-support-retained-source-search:${sha256([
    "course-support-retained-source-search-v1",
    input.incidentId,
    input.cycle,
    input.rejectionEvidenceDigest,
  ].join("\0"))}`;
}

function normalizeSearchPart(value: string | null | undefined) {
  const normalized = value
    ?.replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized || null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
