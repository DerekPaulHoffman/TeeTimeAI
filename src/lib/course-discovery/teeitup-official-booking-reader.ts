import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { isActiveBrowserAccessChallenge, isSafeRecipeUrl } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import { readTeeItUpOfficialEmbed, readTeeItUpOfficialHome, sameTeeItUpOfficialHost, teeItUpBookAlias, teeItUpInertDocumentContent,
  type TeeItUpObservedSourceChain, type TeeItUpSourceIdentity } from "./teeitup-official-booking-source";

function fail(code = "OFFICIAL_BOOKING_SOURCE_UNVERIFIED"): never { throw new Error(code); }
/** At most five independently leased public documents, then the existing
 * directory/data reader performs its separate two reads. No held data lease
 * calls this helper and no response or cookie can authorize an arbitrary hop. */
export async function readTeeItUpOfficialBookingChain(source: TeeItUpSourceIdentity & { bookingUrl: string }, expected: TeeItUpObservedSourceChain,
  deps: { fetch?: typeof fetch; signal: AbortSignal;
    requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> }) {
  if (!source.officialUrl || expected.officialUrl !== source.officialUrl || expected.bookingSourceUrl !== source.bookingUrl || !teeItUpBookAlias(source.bookingUrl)) return fail();
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, deps.signal);
  const authorized = new Set([source.officialUrl]); let requests = 0, totalBytes = 0;
  const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl: value => {
    if (!authorized.has(value) || !isSafeRecipeUrl(value)) return fail("UNSCOPED_ADAPTER_REQUEST"); return new URL(value);
  }, maxResponseBytes: 600_000, timeoutMs: 15_000, redirectLimit: 0 });
  const read = async (value: string) => {
    deps.signal.throwIfAborted();
    if (++requests > 5 || !authorized.has(value) || !isSafeRecipeUrl(value)) return fail("ADAPTER_REQUEST_LIMIT");
    return queue.run(requestFamilyForUrl(value), async () => {
      const response = await transport(value, { method: "GET", headers: { accept: "text/html" }, signal: deps.signal,
        credentials: "omit", redirect: "manual", cache: "no-store" });
      try {
        if ([401, 403].includes(response.status)) return fail("ACCESS_REQUIRED");
        if (response.status === 429) return fail("PROVIDER_THROTTLED");
        if (response.redirected || response.url && response.url !== value) return fail();
        const bytes = await response.arrayBuffer(); totalBytes += bytes.byteLength;
        if (bytes.byteLength > 600_000 || totalBytes > 3_000_000) return fail("ADAPTER_RESPONSE_LIMIT");
        return { status: response.status, location: response.headers.get("location"),
          type: response.headers.get("content-type") ?? "", html: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } finally { if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {}); }
    });
  };
  const html = (reply: Awaited<ReturnType<typeof read>>) => {
    if (reply.status !== 200 || reply.location || !/^text\/html(?:;|$)/iu.test(reply.type)) return fail();
    const content = teeItUpInertDocumentContent(reply.html);
    if (isActiveBrowserAccessChallenge(content.text, content.title)) return fail("ACCESS_REQUIRED");
    return reply.html;
  };
  try {
    let documentUrl = source.officialUrl, root = await read(documentUrl);
    if ([301, 302, 303, 307, 308].includes(root.status)) {
      if (!root.location) return fail();
      const target = new URL(root.location, documentUrl), before = new URL(documentUrl);
      if (target.href !== expected.officialDocumentUrl || !sameTeeItUpOfficialHost(target.href, before.href) ||
          target.pathname !== before.pathname || target.search !== before.search || target.href === before.href) return fail();
      authorized.add(target.href); documentUrl = target.href; root = await read(documentUrl);
    }
    if (documentUrl !== expected.officialDocumentUrl) return fail();
    const home = readTeeItUpOfficialHome(source, { url: documentUrl, html: html(root) }, false);
    if (home.witness !== expected.homeWitnessSha256 || home.bookingPageUrl !== expected.bookingPageUrl) return fail("OFFICIAL_BOOKING_SOURCE_CHANGED");
    authorized.add(home.bookingPageUrl);
    const page = readTeeItUpOfficialEmbed({ url: home.bookingPageUrl, html: html(await read(home.bookingPageUrl)) });
    if (page.witness !== expected.pageWitnessSha256 || page.iframeEntryUrl !== expected.iframeEntryUrl) return fail("OFFICIAL_BOOKING_SOURCE_CHANGED");
    authorized.add(page.iframeEntryUrl);
    const entry = await read(page.iframeEntryUrl);
    if (entry.status !== expected.iframeRedirectStatus || !entry.location || new URL(entry.location, page.iframeEntryUrl).href !== source.bookingUrl) return fail("OFFICIAL_BOOKING_SOURCE_CHANGED");
    authorized.add(source.bookingUrl); html(await read(source.bookingUrl));
    return { ...expected };
  } finally { queue.dispose(); }
}
