import { createHash } from "node:crypto";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

const pages = new WeakMap<OfficialIdentityPage, { officialUrl: string; expiresAt: number; hash: string }>();
type CleanupFacts = { cleanupStarted: boolean; cleanupSettled: boolean; cleanupSucceeded: boolean;
  freshBeforeCleanup: boolean | null; freshAfterCleanup: boolean | null };
const cleanupFacts = new WeakMap<OfficialIdentityPage, CleanupFacts>();
const hash = (page: OfficialIdentityPage) => createHash("sha256").update(JSON.stringify(page)).digest("hex");
/** Called only after the fixed owned native reader's fresh raw/current/visible
 * capture. Neither a copied page nor serialized model metadata is authority. */
export function registerFreshNativeOfficialIdentityPage(page: OfficialIdentityPage, officialUrl: string, deadlineAt: Date) {
  pages.set(page, { officialUrl, expiresAt: Math.min(deadlineAt.getTime(), Date.now() + 30_000), hash: hash(page) });
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
