import { parse, type DefaultTreeAdapterMap } from "parse5";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { sameUScheduleOfficialSite } from "@/lib/simulators/providers/uschedule-location-source";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import { isSafeRecipeUrl } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import type { OfficialIdentityPage, OfficialIdentitySource } from "./teeitup-official-identity";
import type { NativeOfficialPageReader } from "./native-official-page-reader";
import { isFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";

const maxBytes = 600_000;
type Source = Pick<OfficialIdentitySource, "officialUrl" | "bookingUrl" | "venueName">;
type Node = DefaultTreeAdapterMap["node"];
type Dependencies = {
  fetch?: typeof fetch;
  deadlineAt?: Date;
  trustedContext?: { canonicalCoursePhone?: string };
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  officialIdentityPage?: OfficialIdentityPage & {
    officialDocumentProof?: { kind: string; officialUrl: string; documentUrl: string };
  };
  localCapabilities?: readonly "LOCAL_CHROME"[];
  readNativeOfficialPage?: NativeOfficialPageReader;
};

function shopBrand(value: unknown) {
  return typeof value === "string" ? value.normalize("NFKC").toLowerCase()
    .replace(/\s+(?:virtual golf|golf shop)\s*$/u, "").replace(/[^a-z0-9]/gu, "") : "";
}

function bootstrapScripts(root: Node): string[] {
  const documents: string[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if ("tagName" in node && node.tagName === "script") {
      const text = node.childNodes.map(child => "value" in child ? child.value : "").join("").trim();
      if (text.startsWith("window.__BOOTSTRAP_STATE__ = ")) documents.push(text);
      continue;
    }
    if ("childNodes" in node) for (const child of node.childNodes) stack.push(child);
  }
  return documents;
}

/** The merchant's public site must independently name the business, publish
 * its canonical phone and link its booking action to this exact tenant. */
export function matchesUScheduleOfficialShop(html: string, source: Source, canonicalPhone: string) {
  if (Buffer.byteLength(html) > maxBytes) return false;
  const scripts = bootstrapScripts(parse(html));
  if (scripts.length !== 1) return false;
  const json = /^window\.__BOOTSTRAP_STATE__ = (\{[\s\S]*\});$/u.exec(scripts[0])?.[1];
  if (!json) return false;
  try {
    const data = JSON.parse(json)?.siteData;
    const snapshot = data?.snapshot?.properties;
    const link = snapshot?.contentAreas?.header?.content?.properties?.actionButton?.link?.link?.external;
    const cells = data?.page?.properties?.contentAreas?.userContent?.content?.cells;
    const brand = shopBrand(source.venueName);
    if (brand.length < 5 || shopBrand(snapshot?.title) !== brand || link !== source.bookingUrl || !Array.isArray(cells) || cells.length > 40) return false;
    const locations = cells.map(cell => cell?.content?.properties?.syncedLocation)
      .filter(location => location?.business_name || location?.phone);
    return locations.length === 1 && shopBrand(locations[0]?.business_name) === brand &&
      normalizePublicCoursePhone(locations[0]?.phone) === canonicalPhone;
  } catch { return false; }
}

export async function verifyUScheduleOfficialShop(source: OfficialIdentitySource, deps: Dependencies) {
  const fail = (): never => { throw new Error("ADAPTER_IDENTITY_MISMATCH"); };
  const phone = normalizePublicCoursePhone(deps.trustedContext?.canonicalCoursePhone);
  if (!phone || !source.officialUrl || !isSafeRecipeUrl(source.officialUrl)) return fail();
  const official = new URL(source.officialUrl);
  if (official.pathname !== "/" || official.search || official.hash) return fail();
  const matchesNative = (page: OfficialIdentityPage) => page.browserTransport === "NATIVE_CHROME" &&
    sameUScheduleOfficialSite(official.href, page.url) && page.visibleEvidence?.linkUrls.includes(source.bookingUrl) &&
    matchesUScheduleOfficialShop(page.html, source, phone);
  const captured = deps.officialIdentityPage;
  if (captured?.officialDocumentProof?.kind === "VERIFIED_OFFICIAL_DOCUMENT" &&
      captured.officialDocumentProof.officialUrl === official.href && captured.officialDocumentProof.documentUrl === captured.url &&
      matchesNative(captured)) return;
  let target = official.href;
  const signal = AbortSignal.timeout(Math.max(1, Math.min(25_000, (deps.deadlineAt?.getTime() ?? Infinity) - Date.now())));
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const read = deps.fetch ?? createAddressPinnedPublicFetchTransport({
    parseUrl: value => value === target && isSafeRecipeUrl(value) ? new URL(value) : fail(),
    maxResponseBytes: maxBytes, timeoutMs: 10_000, redirectLimit: 0,
  });
  let nativeReadRequired = false;
  try {
    for (let count = 0; count <= 1; count++) {
      const response = await queue.run(requestFamilyForUrl(target), () => read(target, {
        method: "GET", credentials: "omit", redirect: "manual", signal, headers: { accept: "*/*" },
      }));
      try {
        if (response.redirected || response.url && response.url !== target) return fail();
        const location = response.headers.get("location");
        // Some merchant sites publish the booking data only on their www
        // alias. A content-negotiation failure does not supply any identity.
        const alias = response.status === 406 && !location && !official.hostname.startsWith("www.")
          ? `https://www.${official.hostname}/` : null;
        if (count === 0 && (alias || [301, 302, 303, 307, 308].includes(response.status) && location)) {
          const next = new URL(alias ?? location!, target);
          if (next.href === target || next.pathname !== "/" || next.search || next.hash ||
              !isSafeRecipeUrl(next.href) || !sameUScheduleOfficialSite(official.href, next.href)) return fail();
          target = next.href;
          continue;
        }
        if (response.status === 406 && !location && deps.localCapabilities?.includes("LOCAL_CHROME")) {
          nativeReadRequired = true;
          break;
        }
        if (response.status !== 200 || location || !/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "") ||
            !matchesUScheduleOfficialShop(await response.text(), source, phone)) return fail();
        return;
      } finally {
        if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      }
    }
  } finally { queue.dispose(); }
  if (!nativeReadRequired) return fail();
  const deadline = new Date(Math.min(deps.deadlineAt?.getTime() ?? Infinity, Date.now() + 30_000));
  let native = deps.readNativeOfficialPage;
  if (!native) {
    const loaded = await import("./native-official-page-reader");
    const readerModule = typeof loaded.readNativeOfficialIdentityPage === "function" ? loaded :
      (loaded as unknown as { default: typeof loaded }).default;
    const requestLease: typeof runWithProviderRequestLease = async (family, work) => {
      const result = await (deps.requestLease ?? runWithProviderRequestLease)(family, work);
      return result.acquired ? { acquired: true, value: await result.value } : { acquired: false };
    };
    native = (identity, url, until) => readerModule.readNativeOfficialIdentityPage(identity, url, until, {
      requestLease, trustedContext: deps.trustedContext, allowOfficialShopBookingLink: true,
    });
  }
  const page = await native(source, official.href, deadline, "USCHEDULE_SHOP");
  if (!isFreshNativeOfficialIdentityPage(page, official.href) || !matchesNative(page)) return fail();
}
