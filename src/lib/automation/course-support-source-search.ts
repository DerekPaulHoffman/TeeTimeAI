import { createHash } from "node:crypto";

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

export function buildCourseSupportSourceSearchContext(input: {
  name: string;
  address: string | null;
  city: string | null;
  stateCode: string | null;
}): CourseSupportSourceSearchContext {
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
  const locality = [city, stateCode].filter(Boolean).join(", ");
  const query = [name, address, locality || null, "official golf course"]
    .filter((part): part is string => Boolean(part))
    .map((part) => `"${escapeQuotedSearchPart(part)}"`)
    .join(" ");
  return {
    query,
    queryDigest: sha256(query.toLocaleLowerCase("en-US")),
    missingIdentityFields,
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
}) {
  return sha256(
    [
      "course-support-source-search-v1",
      input.batchId,
      input.incidentId,
      input.cycle,
    ].join("\0"),
  );
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

function normalizeSearchPart(value: string | null | undefined) {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function escapeQuotedSearchPart(value: string) {
  return value
    .replace(/["“”]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
