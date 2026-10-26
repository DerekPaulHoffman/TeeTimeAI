import { createHash } from "node:crypto";
import { z } from "zod";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

type RootRedirect = { fromUrl: string; toUrl: string; status: number; completed: boolean };
const rootUrl = z.string().url().max(2048).refine(value => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port; } catch { return false; }
});
export const nativeCanonicalRootDocumentProofSchema = z.object({
  kind: z.literal("NATIVE_CANONICAL_ROOT_REDIRECT"), canonicalUrl: rootUrl, documentUrl: rootUrl,
  redirects: z.array(z.object({ fromUrl: rootUrl, toUrl: rootUrl, status: z.union([z.literal(301), z.literal(302), z.literal(303), z.literal(307), z.literal(308)]), completed: z.literal(true) }).strict()).min(1).max(5),
  witnessSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().refine(value => validRootRedirects(value.canonicalUrl, value.documentUrl, value.redirects) &&
  value.witnessSha256 === rootWitness(value.canonicalUrl, value.documentUrl, value.redirects));
export type NativeCanonicalRootDocumentProof = z.infer<typeof nativeCanonicalRootDocumentProofSchema>;
const pages = new WeakMap<OfficialIdentityPage, { officialUrl: string; expiresAt: number; hash: string; rootDocumentProof?: NativeCanonicalRootDocumentProof }>();
const delegatedPages = new WeakMap<OfficialIdentityPage, { officialUrl: string; expiresAt: number; hash: string }>();
type CleanupFacts = { cleanupStarted: boolean; cleanupSettled: boolean; cleanupSucceeded: boolean;
  freshBeforeCleanup: boolean | null; freshAfterCleanup: boolean | null };
const cleanupFacts = new WeakMap<OfficialIdentityPage, CleanupFacts>();
const hash = (page: OfficialIdentityPage) => createHash("sha256").update(JSON.stringify(page)).digest("hex");
function rootWitness(canonicalUrl: string, documentUrl: string, redirects: RootRedirect[]) {
  return createHash("sha256").update(JSON.stringify({ canonicalUrl, documentUrl,
    redirects: redirects.map(hop => ({ completed: hop.completed, fromUrl: hop.fromUrl, status: hop.status, toUrl: hop.toUrl })) })).digest("hex");
}
function validRootRedirects(canonical: string, current: string, redirects: RootRedirect[]) {
  try {
    const host = new URL(canonical).hostname.replace(/^www\./u, "");
    const valid = (value: string) => { const u = new URL(value); return rootUrl.safeParse(value).success && u.hostname.replace(/^www\./u, "") === host; };
    return canonical !== current && redirects.length > 0 && redirects.length <= 5 && redirects[0].fromUrl === canonical && redirects.at(-1)?.toUrl === current &&
      new Set([canonical, ...redirects.map(hop => hop.toUrl)]).size === redirects.length + 1 && redirects.every((hop, i) => hop.completed === true &&
        [301, 302, 303, 307, 308].includes(hop.status) && valid(hop.fromUrl) && valid(hop.toUrl) && (i === 0 || redirects[i - 1].toUrl === hop.fromUrl));
  } catch { return false; }
}
/** Called only after the fixed owned native reader's fresh raw/current/visible
 * capture. Neither a copied page nor serialized model metadata is authority. */
export function registerFreshNativeOfficialIdentityPage(page: OfficialIdentityPage, officialUrl: string, deadlineAt: Date,
  provenance?: { requestedUrl: string; redirects: RootRedirect[] }) {
  const redirects = provenance?.redirects.map(hop => ({ fromUrl: hop.fromUrl, toUrl: hop.toUrl, status: hop.status, completed: hop.completed }));
  const rootDocumentProof = provenance?.requestedUrl === officialUrl && redirects && validRootRedirects(officialUrl, page.url, redirects) ?
    nativeCanonicalRootDocumentProofSchema.parse({ kind: "NATIVE_CANONICAL_ROOT_REDIRECT", canonicalUrl: officialUrl, documentUrl: page.url, redirects,
      witnessSha256: rootWitness(officialUrl, page.url, redirects) }) : undefined;
  pages.set(page, { officialUrl, expiresAt: Math.min(deadlineAt.getTime(), Date.now() + 30_000), hash: hash(page), ...(rootDocumentProof ? { rootDocumentProof } : {}) });
  cleanupFacts.set(page, { cleanupStarted: false, cleanupSettled: false, cleanupSucceeded: false,
    freshBeforeCleanup: null, freshAfterCleanup: null });
  return page;
}
/** Closed controller diagnostics only. These facts never register or renew a page. */
export function getNativeOfficialIdentityPageDiagnostic(page: OfficialIdentityPage, officialUrl: string) {
  const proof = pages.get(page);
  let objectUnchanged = false;
  try { objectUnchanged = Boolean(proof && hash(page) === proof.hash); } catch { /* Diagnostics cannot replace the primary failure. */ }
  return { attestationPresent: Boolean(proof), officialRootMatches: proof?.officialUrl === officialUrl,
    expiresInFuture: Boolean(proof && proof.expiresAt > Date.now()), nativeTransport: page.browserTransport === "NATIVE_CHROME",
    objectUnchanged,
    ...(cleanupFacts.get(page) ?? { cleanupStarted: false, cleanupSettled: false, cleanupSucceeded: false,
      freshBeforeCleanup: null, freshAfterCleanup: null }) };
}
export function noteNativeOfficialIdentityPageCleanup(page: OfficialIdentityPage, officialUrl: string,
  phase: "BEFORE" | "AFTER", succeeded = false) {
  const facts = cleanupFacts.get(page);
  if (!facts) return;
  let fresh = false;
  try { fresh = isFreshNativeOfficialIdentityPage(page, officialUrl); } catch { /* Observation grants no authority. */ }
  if (phase === "BEFORE") {
    facts.cleanupStarted = true; facts.freshBeforeCleanup = fresh;
  } else {
    facts.cleanupSettled = true; facts.cleanupSucceeded = succeeded;
    facts.freshAfterCleanup = fresh;
  }
}
export function isFreshNativeOfficialIdentityPage(page: OfficialIdentityPage, officialUrl: string) {
  const proof = pages.get(page);
  return Boolean(proof && proof.officialUrl === officialUrl && proof.expiresAt > Date.now() &&
    page.browserTransport === "NATIVE_CHROME" && hash(page) === proof.hash);
}
/** Only the actual native reader can attach observed redirects to this original
 * page object. Same-host membership or serialized JSON alone is not proof. */
export function freshNativeCanonicalRootDocument(page: OfficialIdentityPage, officialUrl: string) {
  if (!isFreshNativeOfficialIdentityPage(page, officialUrl)) return;
  if (page.url === officialUrl) return { documentUrl: page.url, rootDocumentProof: undefined };
  const value = pages.get(page)?.rootDocumentProof;
  return value && value.canonicalUrl === officialUrl && value.documentUrl === page.url ? { documentUrl: page.url, rootDocumentProof: structuredClone(value) } : undefined;
}

/** A current owned delegated document is not a canonical official venue page. */
export function registerFreshNativeDelegatedDocument(page: OfficialIdentityPage, officialUrl: string, deadlineAt: Date) {
  delegatedPages.set(page, { officialUrl, expiresAt: Math.min(deadlineAt.getTime(), Date.now() + 30_000), hash: hash(page) });
  return page;
}
export function isFreshNativeDelegatedDocument(page: OfficialIdentityPage, officialUrl: string) {
  const value = delegatedPages.get(page);
  return Boolean(value && value.officialUrl === officialUrl && value.expiresAt > Date.now() && page.browserTransport === "NATIVE_CHROME" && hash(page) === value.hash);
}
