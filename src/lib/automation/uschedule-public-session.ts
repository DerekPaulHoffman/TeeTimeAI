import { request as httpsRequest } from "node:https";
import { createAddressPinnedPublicFetchTransport } from "./address-pinned-public-fetch";
import { createSimulatorBrowserRequestQueue } from "./simulator-browser-request-queue";
import { runWithProviderRequestLease } from "./provider-request-lease";
import { createUSchedulePublicReadPolicy } from "./uschedule-public-read-policy";
import { requestFamilyForUrl } from "@/lib/course-discovery/request-family";
import { parseUScheduleLocationSource, type UScheduleOfficialLocationProof } from "@/lib/simulators/providers/uschedule-location-source";

/** A per-execution anonymous ASP.NET session. The cookie can only originate
 * from the exact public booking GET, remains in memory, and is injected below
 * the general credential-free transport after its DNS/IP/TLS checks. It is
 * never accepted from a recipe, caller, environment, or persisted output. */
export function createUSchedulePublicSession(sourceUrl: string, deps: {
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>; fetch?: typeof fetch; deadlineAt?: Date;
  officialLocation?: UScheduleOfficialLocationProof;
  /** Private engineering capture only, after the existing bounded body read.
   * No cookie/header/URL is exposed and no transport stream is read twice. */
  onPublicRead?: (read: Readonly<{ method: "GET" | "POST"; requestBody?: string; status: number; responseText: string }>) => unknown;
} = {}) {
  const source = new URL(sourceUrl);
  const locationEntry = deps.officialLocation && parseUScheduleLocationSource(deps.officialLocation.entryUrl);
  const parsed = parseUScheduleLocationSource(sourceUrl);
  const filteredLocation = parsed && locationEntry && parsed.canonicalUrl === locationEntry.canonicalUrl && parsed.locationId === locationEntry.locationId;
  if (source.protocol !== "https:" || source.hostname !== "clients.uschedule.com" || source.port || source.username || source.password || source.search && !filteredLocation || source.hash ||
      !/^\/[a-z][a-z0-9-]{2,62}\/booking$/u.test(source.pathname) || deps.officialLocation && !filteredLocation) throw new Error("INVALID_ADAPTER_SOURCE");
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(120_000, (deps.deadlineAt?.getTime() ?? Date.now() + 120_000) - Date.now())));
  const signal = AbortSignal.any([controller.signal, timeout]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const policy = createUSchedulePublicReadPolicy({ officialLocation: deps.officialLocation });
  let cookie: string | undefined, cursor: string | undefined, requests = 0, bytes = 0, closed = false, failure: string | undefined;
  let canonicalDocument: string | undefined;
  const currentDocument = () => canonicalDocument ?? source.href;
  const allowedUrls = () => [source.href, canonicalDocument, changeUrl, policy.publicClientUrl(currentDocument())];
  const changeUrl = new URL(`${source.pathname}/changefield`, source.origin).href;
  const continuation = (url: URL, headers: Headers, body: string) => (!deps.officialLocation || policy.locationReadReady(currentDocument())) && cursor !== undefined && url.href === changeUrl &&
    headers.get("referer") === currentDocument() && headers.get("origin") === source.origin && headers.get("content-type") === "application/json" &&
    body === JSON.stringify([{ Name: "more_next_avail", Value: cursor }]);
  const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({
    parseUrl: value => {
      const url = new URL(value);
      if (!allowedUrls().includes(url.href)) throw new Error("UNSCOPED_ADAPTER_REQUEST");
      return url;
    }, maxResponseBytes: 600_000, timeoutMs: 15_000, redirectLimit: 0,
    authorizeReadPost: (url, headers, body) => policy.allows(url, headers, body) || continuation(url, headers, body),
  }, { requestNode: (url, options, callback) => httpsRequest(url, { ...options,
    headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } }, callback) });
  const read: typeof fetch = async (value, init) => {
    if (closed || signal.aborted || ++requests > 40) throw new Error("ADAPTER_REQUEST_LIMIT");
    const url = new URL(value instanceof Request ? value.url : String(value));
    const headers = new Headers(init?.headers);
    const suppliedCookie = headers.get("cookie"); headers.delete("cookie");
    if (suppliedCookie && suppliedCookie !== cookie || ["authorization", "proxy-authorization", "x-api-key"].some(key => headers.has(key))) throw new Error("UNSAFE_ADAPTER_REQUEST");
    const method = init?.method ?? "GET", body = typeof init?.body === "string" ? init.body : undefined;
    if (!allowedUrls().includes(url.href) || !["GET", "POST"].includes(method) ||
        method === "GET" && (![source.href, canonicalDocument, policy.publicClientUrl(currentDocument())].includes(url.href) || body) ||
        method === "POST" && (!cookie || !body || url.href !== changeUrl)) throw new Error("UNSCOPED_ADAPTER_REQUEST");
    if (method === "POST" && !policy.allows(url, headers, body!) && !continuation(url, headers, body!)) throw new Error("UNSAFE_ADAPTER_REQUEST");
    return queue.run(requestFamilyForUrl(url.href), async () => {
      const response = await transport(url, { ...init, method, headers, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal, credentials: "omit", redirect: "manual", cache: "no-store" });
      try {
      if (response.status === 429) { failure = "PROVIDER_THROTTLED"; throw new Error(failure); }
      if ([401, 403].includes(response.status)) { failure = "ACCESS_REQUIRED"; throw new Error(failure); }
      const bootstrap = Boolean(deps.officialLocation && !canonicalDocument && url.href === source.href && method === "GET" && response.status === 302 &&
        response.headers.get("location") && new URL(response.headers.get("location")!, url).href === parsed!.canonicalUrl);
      if ((!response.ok && !bootstrap) || response.redirected || response.url && response.url !== url.href || response.headers.has("location") && !bootstrap)
        throw new Error("ADAPTER_TRANSPORT_FAILED");
      const cookies = response.headers.getSetCookie();
      if (cookies.length) {
        if (cookies.length !== 1 || !/^ASP\.NET_SessionId=[A-Za-z0-9]{8,100}(?:;|$)/u.test(cookies[0])) throw new Error("ANONYMOUS_SESSION_CHANGED");
        const next = cookies[0].split(";", 1)[0];
        if (cookie ? next !== cookie : ![source.href, canonicalDocument].includes(url.href) || method !== "GET") throw new Error("ANONYMOUS_SESSION_CHANGED");
        cookie = next;
      }
      const buffer = await response.arrayBuffer(); bytes += buffer.byteLength;
      if (buffer.byteLength > 600_000 || bytes > 8_000_000) throw new Error("ADAPTER_RESPONSE_LIMIT");
      if (bootstrap) canonicalDocument = parsed!.canonicalUrl;
      const text = Buffer.from(buffer).toString("utf8");
      if (policy.observeResponse(url.href, method, response.status, response.headers.get("content-type") ?? "", text)) {
        const cursors = [...text.matchAll(/(?:^|\n)\s*var\s+lastAvailTime\s*=\s*'(\d{12})';/gu)];
        cursor = cursors.length === 1 ? cursors[0][1] : undefined;
      }
      try {
        const observation = deps.onPublicRead?.({ method: method === "GET" ? "GET" : "POST", ...(body === undefined ? {} : { requestBody: body }), status: response.status, responseText: text });
        if (observation instanceof Promise) void observation.catch(() => undefined);
      } catch { /* Diagnostic capture cannot alter read admission or mask its result. */ }
      return new Response(buffer, { status: response.status, headers: response.headers });
      } finally { if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {}); }
    });
  };
  return { read, failureReason: () => failure, dispose() { closed = true; cookie = undefined; controller.abort(); queue.dispose(); } };
}
