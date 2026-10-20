import { randomUUID } from "node:crypto";
import type { Browser, Locator } from "@playwright/test";
import { z } from "zod";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createPassfactoryPublicReadPolicy, isIncidentalBrowserRequest, isNonEvidenceBrowserResource } from "@/lib/automation/passfactory-public-read-policy";
import { interactiveControlKind, isAnonymousBrowserReadPost } from "@/lib/automation/simulator-interactive-browser";
import { addVerifiedMindbodyReadHeaders } from "@/lib/automation/mindbody-public-read-policy";
import { createUSchedulePublicReadPolicy } from "@/lib/automation/uschedule-public-read-policy";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { isActiveBrowserAccessChallenge, isSafeBrowserAssetUrl, isSafeRecipeUrl, recipeSelectorSchema } from "./recipe";
import { continueNativeBrowserRead, createNativePublicBrowserProxy, isObservedNativeRedirect, nativeReadPreflightMethod } from "./native-public-browser";
import { requestFamilyForUrl } from "./request-family";
import { canonicalPublicReadUrl } from "./public-request-url";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { isPublicCalendarApply } from "./public-calendar-apply";
import { isObservedPublicCalendarDay, observedPublicCalendarDays } from "./public-calendar-day";
import { PUBLIC_BROWSER_TOTAL_BYTES, publicBrowserResponseLimit } from "./browser-resource-limits";
import { observedPublicDropdowns, selectPublicDropdown, type PublicDropdownProof } from "./public-dropdown-control";
import { venueProofMatches } from "./executor";
import type { ExistingAdapterMetadata } from "./existing-adapter-schema";
import { publicResponseSchema, type PublicResponseSchema } from "./public-response-schema";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

const identifier = z.union([z.string().max(128), z.number().int()]);
export const discoveryBrowserActionSchema = z.discriminatedUnion("action", [
  z.object({ id: identifier, action: z.literal("open"), url: z.string().max(2048) }).strict(),
  z.object({ id: identifier, action: z.literal("inspect_adapter"), url: z.string().max(2048) }).strict(),
  z.object({ id: identifier, action: z.literal("inspect"), selector: recipeSelectorSchema }).strict(),
  z.object({ id: identifier, action: z.literal("observe") }).strict(),
  z.object({ id: identifier, action: z.literal("click"), target: z.string().uuid() }).strict(),
  z.object({ id: identifier, action: z.literal("select"), target: z.string().uuid(), option: z.string().max(200) }).strict(),
  z.object({ id: identifier, action: z.literal("fill"), target: z.string().uuid(), text: z.string().max(120) }).strict(),
  z.object({ id: identifier, action: z.literal("scroll"), direction: z.enum(["up", "down"]) }).strict(),
  z.object({ id: identifier, action: z.literal("finish") }).strict(),
]);
export type DiscoveryBrowserAction = z.infer<typeof discoveryBrowserActionSchema>;
type ObservedControl = { tag: string; role: string; name: string; label: string; href?: string; calendar: boolean;
  sensitiveForm: boolean; inputType: string; hasPopup: string; selector: string; options?: Array<{ value: string; label: string }>;
  currentValue?: string; product?: { selector: string; durationMinutes: number }; choiceValue?: string; choiceContext?: string; disabledChoice?: boolean };

export function discoveryPublicChoiceKind(control: Pick<ObservedControl, "tag" | "name" | "href" | "calendar" | "sensitiveForm" | "choiceValue" | "choiceContext" | "disabledChoice">) {
  if (control.sensitiveForm || control.disabledChoice || control.href || /\b(?:checkout|reserve|book|pay|confirm|cancel)\b|\d{1,2}:\d{2}/iu.test(control.name)) return null;
  if (["td", "th"].includes(control.tag) && control.calendar && /^(?:\d{1,2}|[<>‹›«»])$/u.test(control.name.trim())) return "calendar" as const;
  if (["a", "button", "div", "span"].includes(control.tag) && control.choiceValue && control.choiceValue.length <= 40 &&
      /players?|holes?|duration|time.?of.?day|morning|midday|evening/iu.test(control.choiceContext ?? "") &&
      /^(?:\d{1,3}(?:\s+(?:holes?|players?|guests?|minutes?|hours?))?|any|all|both|morning|midday|evening|anytime)$/iu.test(control.name.trim())) return "option" as const;
  return null;
}

/** Public navigation labels are distinct from selecting or reserving a time. */
export function discoveryPublicAnchorKind(control: Pick<ObservedControl, "tag" | "name" | "label" | "href" | "sensitiveForm">) {
  if (control.tag !== "a" || !control.href || !isSafeRecipeUrl(control.href) || control.sensitiveForm) return null;
  const text = `${control.name} ${control.label}`;
  if (!/\b(?:book|reserve|reservations?|tee\s*times?|availability)\b/iu.test(text) ||
      /\b(?:login|log in|sign in|sign up|register|checkout|pay|payment|purchase|confirm|cancel|delete|send|subscribe|password|email|phone)\b/iu.test(text) ||
      /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/iu.test(text)) return null;
  const url = new URL(control.href);
  if ([...url.searchParams.keys()].some(key => /^(?:time|start|slot|booking_?id|reservation_?id)$/iu.test(key))) return null;
  return "link" as const;
}

/** ForeUP's official login bookmark shares a documented public tee-sheet
 * bootstrap. Inspect that public base without entering the login route. */
export function normalizeDiscoveryNavigationUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "foreupsoftware.com" &&
        /^\/index\.php\/booking\/\d+(?:\/\d+)?\/?$/u.test(url.pathname) && /^#\/login\/?$/iu.test(url.hash)) {
      url.hash = "";
      if (isSafeRecipeUrl(url.href)) return url.href;
    }
  } catch { /* Normal URL validation below rejects invalid source links. */ }
  return value;
}

/** Fragments select a client-side view of the same HTTP document. Keep every
 * other URL byte exact so a later route/query cannot borrow an earlier status. */
export function sameDiscoveryMainDocument(observedUrl: string, currentUrl: string) {
  return Boolean(observedUrl && currentUrl) && observedUrl.split("#", 1)[0] === currentUrl.split("#", 1)[0];
}
export type DiscoveryBrowserSnapshot = {
  url: string; text: string; controls: Array<{ target: string; selector: string; kind: string; name: string; label: string; options?: Array<{ value: string; label: string }>; currentValue?: string; product?: { selector: string; durationMinutes: number } }>;
  responses: Array<{ url: string; status: number; method: string; body?: unknown; bodyOmitted?: true; schemaEvidence?: PublicResponseSchema; schemaEvidenceOmitted?: true }>;
  requests: Array<{ url: string; method: string; resourceType: string; status?: number; blockedReason?: string; body?: unknown }>;
  frames: Array<{ url: string }>;
  elements: Array<{ selector: string; tag: string; text: string; attributes: Record<string, string> }>;
  loading: boolean; blockedRequests: number; requestCount: number; interceptCount: number; responseBytes: number; startupMs: number;
  navigationStatus?: number; navigationElapsedMs?: number; initialContentWaitMs?: number; pendingRequestCount?: number;
  browserTransport: "PINNED_HTTP" | "NATIVE_CHROME";
  accessRequirementObserved?: boolean;
  adapter?: ExistingAdapterMetadata;
  structure?: { selected: string; ancestors: Array<{ selector: string; matches: number; tag: string; text: string;
    attributes: Record<string, string>; children: Array<{ selector: string; tag: string; text: string }> }> };
};
export type DiscoveryBrowserSessionDependencies = {
  fetch?: typeof fetch;
  launchBrowser?: () => Promise<Browser>;
  requestLease?: typeof runWithProviderRequestLease;
  browserTransport?: "PINNED_HTTP" | "NATIVE_CHROME";
  onRequestFailure?: (failure: { url: string; resourceType: string; reason: string }) => void;
  inspectAdapter?: typeof inspectExistingAdapter;
};
const sensitive = /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|contact|card|customer|user|person|attendee/iu;
/** URL metadata may contain a site's public API key; it is not model input. */
export function redactDiscoveryRequestUrl(value: string) {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) if (/^(?:key|api[-_]?key|access[-_]?token|token|secret|password|credential|authorization|email|phone)$/iu.test(key)) url.searchParams.set(key, "REDACTED");
    return url.href;
  } catch { return ""; }
}
/** Project public calendar data only; never return response headers or raw bodies. */
export function redactDiscoveryJson(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[depth limit]";
  if (typeof value === "string") return sanitizeResponderText(value).slice(0, 600);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactDiscoveryJson(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 80)
    .map(([key, item]) => [key.slice(0, 80), sensitive.test(key) ? "[redacted]" : redactDiscoveryJson(item, depth + 1)]));
  return null;
}

/** Scoped, disposable discovery browser. The model receives data and opaque
 * control IDs; it never receives browser/CDP access or a JavaScript evaluator. */
export async function createCourseDiscoveryBrowserSession(input: {
  deadlineAt: Date; initialUrls: string[]; timeZone?: string; venueName?: string; venueAddress?: string; venueOfficialUrl?: string;
}, deps: DiscoveryBrowserSessionDependencies = {}) {
  const startupStartedAt = Date.now();
  if (!input.initialUrls.length || input.initialUrls.length > 16 || !input.initialUrls.every(isSafeRecipeUrl)) throw new Error("INVALID_INITIAL_URLS");
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone ?? "UTC" }); } catch { throw new Error("INVALID_TIME_ZONE"); }
  const remaining = input.deadlineAt.getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 20 * 60_000) throw new Error("INVALID_DEADLINE");
  const cancellation = new AbortController();
  const deadline = AbortSignal.any([AbortSignal.timeout(remaining), cancellation.signal]);
  const allowedNavigation = new Set(input.initialUrls.map(value => new URL(value).href));
  let officialIdentityPage: (OfficialIdentityPage & { observedAt: number }) | undefined;
  let officialIdentityDocument: { url: string; html: string } | undefined;
  const navigationOrigins = new Set(input.initialUrls.map(value => new URL(value).origin));
  const passfactory = createPassfactoryPublicReadPolicy();
  const uschedule = createUSchedulePublicReadPolicy();
  input.initialUrls.forEach(value => passfactory.observeWidgetUrl(value));
  const readPost = (url: URL, headers: Headers, body: string) =>
    isAnonymousBrowserReadPost(url, headers, body) || passfactory.allows(url, headers, body) || uschedule.allows(url, headers, body);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, deadline);
  const nativeProxy = deps.browserTransport === "NATIVE_CHROME" ? await createNativePublicBrowserProxy({ signal: deadline }) : undefined;
  let browser: Browser;
  try {
    browser = deps.launchBrowser ? await deps.launchBrowser() : await (await import("@playwright/test")).chromium.launch({
      headless: true, ...(process.platform === "win32" ? { channel: "chrome" } : {}), timeout: Math.min(15_000, remaining),
      ...(nativeProxy ? { args: ["--disable-quic", "--proxy-bypass-list=<-loopback>"] } : {}),
    });
  } catch (error) { await nativeProxy?.close(); queue.dispose(); throw error; }
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, timezoneId: input.timeZone ?? "UTC", locale: "en-US",
    ...(nativeProxy ? { proxy: { server: nativeProxy.server, bypass: "<-loopback>" } } : {}) });
  await context.routeWebSocket("**/*", route => { route.close(); });
  const page = await context.newPage();
  const startupMs = Date.now() - startupStartedAt;
  page.setDefaultTimeout(Math.min(10_000, remaining));
  const responses: DiscoveryBrowserSnapshot["responses"] = [];
  const observedRequests: DiscoveryBrowserSnapshot["requests"] = [];
  const pendingRequestMetadata = new Set<DiscoveryBrowserSnapshot["requests"][number]>();
  let requestMetadataBytes = 0;
  const recordRequest = (metadata: DiscoveryBrowserSnapshot["requests"][number], priority = false) => {
    if ((!isSafeRecipeUrl(metadata.url) && !isSafeBrowserAssetUrl(metadata.url, metadata.resourceType, metadata.method)) || observedRequests.includes(metadata)) return;
    const size = JSON.stringify(metadata).length + 120;
    if (priority) {
      while (observedRequests.length && (observedRequests.length >= 80 || requestMetadataBytes + size > 10_000)) {
        const index = observedRequests.findIndex(row => !["xhr", "fetch", "document"].includes(row.resourceType) && !row.blockedReason);
        if (index < 0) break;
        observedRequests.splice(index, 1);
        requestMetadataBytes = observedRequests.reduce((total, row) => total + JSON.stringify(row).length + 120, 0);
      }
    }
    if (observedRequests.length < 80 && requestMetadataBytes + size <= 10_000) {
      observedRequests.push(metadata); requestMetadataBytes += size;
    }
  };
  const controls = new Map<string, { locator: Locator; signature: string; kind: string; href?: string; calendarDay?: string; dropdown?: PublicDropdownProof }>();
  const observedElements = new Map<string, { locator: Locator; signature: string }>();
  let closed = false, requestCount = 0, interceptCount = 0, responseBytes = 0, blockedRequests = 0, pendingRequests = 0, actions = 0, observations = 0;
  let navigation: { url: string; status: number } | undefined;
  let navigationStartedAt: number | undefined;
  const close = async () => { if (closed) return; closed = true; cancellation.abort("BROWSER_CLOSED"); queue.dispose(); await context.close().catch(() => {}); await browser.close().catch(() => {}); await nativeProxy?.close(); };
  const abort = () => { void close(); };
  deadline.addEventListener("abort", abort, { once: true });
  page.on("popup", popup => { void popup.close(); });
  context.on("page", opened => { if (opened !== page) void opened.close(); });
  await context.route("**/*", async route => {
    const request = route.request();
    const requestUrl = canonicalPublicReadUrl(request.url(), request.method());
    // Denied media/telemetry never spends the public-read budget. A separate
    // hard interception cap still bounds hostile pages that emit rejected work.
    if (++interceptCount > 1024) { await route.abort().catch(() => {}); void close(); return; }
    if (isIncidentalBrowserRequest(request.url()) || isNonEvidenceBrowserResource(request.url(), request.resourceType())) { await route.abort(); return; }
    pendingRequests++;
    const metadata: DiscoveryBrowserSnapshot["requests"][number] = {
      url: redactDiscoveryRequestUrl(requestUrl), method: request.method(), resourceType: request.resourceType(),
    };
    recordRequest(metadata, ["xhr", "fetch", "document"].includes(metadata.resourceType));
    pendingRequestMetadata.add(metadata);
    try {
      deadline.throwIfAborted();
      if (!isSafeRecipeUrl(requestUrl) && !isSafeBrowserAssetUrl(requestUrl, request.resourceType(), request.method())) throw new Error("UNSAFE_URL");
      const url = new URL(requestUrl);
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        if (input.venueOfficialUrl && url.origin === new URL(input.venueOfficialUrl).origin) {
          officialIdentityDocument = undefined; officialIdentityPage = undefined;
        }
        if (nativeProxy && request.redirectedFrom()) {
          if (!isObservedNativeRedirect(request, navigationOrigins)) throw new Error("UNSAFE_REDIRECT");
          allowedNavigation.add(url.href); navigationOrigins.add(url.origin);
        }
        if (!allowedNavigation.has(url.href) && !navigationOrigins.has(url.origin)) throw new Error("UNOBSERVED_NAVIGATION");
      }
      const method = request.method();
      // Public widgets may select a resource with history.replaceState before
      // issuing its read. Bind only the URL actually observed in this frame.
      const frameUrl = request.frame().url();
      if (isSafeRecipeUrl(frameUrl)) passfactory.observeWidgetUrl(frameUrl);
      const headers = new Headers();
      const requestHeaders = request.headers();
      if (nativeProxy && Object.keys(requestHeaders).some(key => /^(?:authorization|proxy-authorization|x-api-key)$/iu.test(key))) throw new Error("CREDENTIAL_HEADERS");
      for (const key of ["accept", "content-type", "origin"]) if (requestHeaders[key]) headers.set(key, requestHeaders[key]);
      const body = request.postData() ?? undefined;
      if (!addVerifiedMindbodyReadHeaders(url, method, requestHeaders, headers, body ?? "")) throw new Error("UNSAFE_METHOD");
      if (!uschedule.addReadHeaders(url, method, requestHeaders, headers, body ?? "")) throw new Error("UNSAFE_METHOD");
      const preflight = nativeProxy && method === "OPTIONS" && nativeReadPreflightMethod(requestHeaders);
      if (!["GET", "HEAD"].includes(method) && !preflight && !(method === "POST" && body && readPost(url, headers, body))) throw new Error("UNSAFE_METHOD");
      if (method === "POST" && body) {
        try {
          const projected = redactDiscoveryJson(JSON.parse(body));
          const bodySize = JSON.stringify(projected).length + 16;
          if (bodySize <= 8192 && observedRequests.includes(metadata) && requestMetadataBytes + bodySize <= 10_000) {
            metadata.body = projected; requestMetadataBytes += bodySize;
          }
        } catch { /* Non-JSON public reads remain opaque; never return raw text. */ }
      }
      if (requestCount >= 192) throw new Error("PUBLIC_READ_REQUEST_LIMIT");
      if (responseBytes >= PUBLIC_BROWSER_TOTAL_BYTES) throw new Error("PUBLIC_READ_BYTE_LIMIT");
      requestCount++;
      const responseLimit = publicBrowserResponseLimit(request.resourceType());
      const reply = await queue.run(requestFamilyForUrl(url.href), async () => {
        if (nativeProxy) {
          nativeProxy.allowHostConnections(url.hostname);
          const response = await continueNativeBrowserRead(route, deadline, responseLimit, async () => {
            await nativeProxy.cancelHostConnections(url.hostname);
          }, requestUrl);
          return { status: response.status, headers: response.headers, buffer: response.body };
        }
        const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({
          parseUrl: value => {
            if (!isSafeRecipeUrl(value) && !isSafeBrowserAssetUrl(value, request.resourceType(), method)) throw new Error("UNSAFE_URL");
            return new URL(value);
          },
          maxResponseBytes: responseLimit, timeoutMs: 15_000, redirectLimit: 0, authorizeReadPost: readPost,
        });
        const response = await transport(url, { method, headers, body, credentials: "omit", redirect: "manual", signal: deadline });
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > responseLimit) throw new Error("BODY_LIMIT");
        return { status: response.status, headers: Object.fromEntries(response.headers), buffer };
      });
      metadata.status = reply.status;
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigation = { url: request.url(), status: reply.status };
      // Retain only the bounded, successfully read official document. Its raw
      // semantic markup is reproducible on warm reads; page.content() contains
      // transient browser mutations and must not define the saved witness.
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && input.venueOfficialUrl &&
          url.origin === new URL(input.venueOfficialUrl).origin && reply.status >= 200 && reply.status < 300 &&
          reply.buffer.length <= 600_000 && /^text\/html(?:;|$)/iu.test(reply.headers["content-type"] ?? ""))
        officialIdentityDocument = { url: url.href, html: reply.buffer.toString("utf8") };
      if (["GET", "HEAD"].includes(method) && ["document", "xhr", "fetch"].includes(request.resourceType()) &&
          reply.status >= 200 && reply.status < 400 && isSafeRecipeUrl(url.href)) allowedNavigation.add(url.href);
      responseBytes += reply.buffer.length;
      if (url.hostname === "clients.uschedule.com" && method === "GET" && /^text\/html(?:;|$)/iu.test(reply.headers["content-type"] ?? ""))
        uschedule.observeResponse(url.href, method, reply.status, reply.headers["content-type"] ?? "", reply.buffer.toString("utf8"));
      if (responseBytes > PUBLIC_BROWSER_TOTAL_BYTES) { cancellation.abort("PUBLIC_READ_BYTE_LIMIT"); throw new Error("PUBLIC_READ_BYTE_LIMIT"); }
      const responseHeaders: Record<string, string> = {};
      for (const key of ["content-type", "access-control-allow-origin"]) { const value = reply.headers[key]; if (value) responseHeaders[key] = value; }
      const redirect = reply.headers.location;
      if (redirect) {
        const next = new URL(redirect, url);
        if (method === "POST" || !isSafeRecipeUrl(next.href) || next.hostname.replace(/^www\./u, "") !== url.hostname.replace(/^www\./u, "")) throw new Error("UNSAFE_REDIRECT");
        responseHeaders.location = next.href;
        allowedNavigation.add(next.href); navigationOrigins.add(next.origin);
      }
      if (responses.length < 12 && /application\/(?:[a-z0-9.+-]*\+)?json/iu.test(responseHeaders["content-type"] ?? "") && ["xhr", "fetch"].includes(request.resourceType())) {
        try {
          const original: unknown = JSON.parse(reply.buffer.toString("utf8"));
          const projected = redactDiscoveryJson(original);
          const schemaEvidence = publicResponseSchema(original);
          const schemaBytes = responses.reduce((total, response) => total + (response.schemaEvidence ? JSON.stringify(response.schemaEvidence).length : 0), 0);
          responses.push({ url: redactDiscoveryRequestUrl(url.href), status: reply.status, method,
            ...(JSON.stringify(projected).length < 28_000 ? { body: projected } : { bodyOmitted: true as const }),
            ...(schemaBytes + JSON.stringify(schemaEvidence).length <= 24_000 ? { schemaEvidence } : { schemaEvidenceOmitted: true as const }) });
        } catch { /* Invalid JSON is not evidence. */ }
      }
      if (!nativeProxy) await route.fulfill({ status: reply.status, headers: responseHeaders, body: reply.buffer });
    } catch (error) {
      blockedRequests++;
      metadata.blockedReason = error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : "REQUEST_FAILED";
      deps.onRequestFailure?.({ url: metadata.url, resourceType: metadata.resourceType, reason: metadata.blockedReason });
      recordRequest(metadata, true);
      await route.abort().catch(() => {});
    }
    finally { pendingRequests--; pendingRequestMetadata.delete(metadata); }
  });

  const observeControl = (locator: Locator): Promise<ObservedControl> => locator.evaluate(element => {
    const node = element as HTMLElement;
    const field = element as HTMLInputElement;
    // Object methods remain self-contained when tsx preserves function names.
    // Assigned nested arrow functions would capture its module-only __name helper.
    const selectors = {
      quote(value: string) { return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"'); },
      for(target: Element): string {
        if (target.id && document.querySelectorAll(`[id="${this.quote(target.id)}"]`).length === 1) return `[id="${this.quote(target.id)}"]`;
        const path: string[] = [];
        let current: Element | null = target;
        while (current && current.tagName !== "BODY" && path.length < 12) {
          const tag = current.tagName.toLowerCase();
          const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(child => child.tagName === current!.tagName) : [current];
          path.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
          const candidate = path.join(" > ");
          if (document.querySelectorAll(candidate).length === 1 && document.querySelector(candidate) === target) return candidate;
          current = current.parentElement;
        }
        return `body > ${path.join(" > ")}`;
      },
    };
    let label = [node.getAttribute("aria-label"), ...Array.from(field.labels ?? []).map(item => item.textContent),
      node.getAttribute("aria-labelledby")?.split(/\s/u).map(id => document.getElementById(id)?.textContent).join(" ")].filter(Boolean).join(" ");
    if (!label) {
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 3 && !["BODY", "FORM"].includes(parent.tagName); depth++, parent = parent.parentElement) {
        const fields = parent.querySelectorAll('input:not([type=hidden]):not([aria-hidden=true]),select,[role=combobox],[aria-haspopup=listbox]');
        if (fields.length !== 1 || fields[0] !== node) continue;
        const labels = parent.querySelectorAll(':scope > label,:scope > .label,:scope > .field-label,:scope > [data-field-label],:scope > fieldset > legend');
        const directText = Array.from(parent.childNodes).filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join(" ").trim();
        if (labels.length === 1) label = labels[0].textContent ?? "";
        else if (directText.length > 0 && directText.length < 200) label = directText;
        if (label) break;
      }
    }
    let product: ObservedControl["product"];
    let choiceContext: string | undefined;
    if (node.hasAttribute("data-value")) {
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 3 && !["BODY", "FORM"].includes(parent.tagName); depth++, parent = parent.parentElement) {
        const context = `${parent.id} ${parent.className} ${parent.innerText}`.replace(/\s+/gu, " ").trim();
        if (context.length <= 300 && /players?|holes?|duration|time.?of.?day|morning|midday|evening/iu.test(context)) { choiceContext = context; break; }
      }
      if (!label && choiceContext) label = choiceContext;
    }
    if (/^(?:book|select)$/iu.test(node.innerText.trim()) && ["BUTTON", "A"].includes(node.tagName)) {
      let card = node.parentElement;
      for (let depth = 0; card && depth < 6 && !["BODY", "FORM"].includes(card.tagName); depth++, card = card.parentElement) {
        const text = card.innerText.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/([A-Za-z])(\d)/gu, "$1 $2").trim();
        const minutes = [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|minutes?|mins?|min)\b/giu)]
          .map(match => Number(match[1]) * (/^h/iu.test(match[2]) ? 60 : 1));
        const unique = [...new Set(minutes)];
        if (text.length <= 2000 && unique.length === 1 && Number.isInteger(unique[0]) && unique[0] >= 15 && unique[0] <= 480 &&
          !/\b\d{1,2}:\d{2}/u.test(text) && !/\b(?:checkout|payment|purchase|confirm|password|sign in|login)\b/iu.test(text) &&
          !card.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]')) {
          product = { selector: selectors.for(card), durationMinutes: unique[0] }; break;
        }
      }
    }
    return { tag: node.tagName.toLowerCase(), role: node.getAttribute("role") ?? "", name: (node.innerText || node.getAttribute("aria-label") || node.querySelector("img")?.getAttribute("alt") || node.getAttribute("title") || "").trim().slice(0, 160),
      label: label.trim().slice(0, 200), href: node instanceof HTMLAnchorElement ? node.href : undefined,
      calendar: Boolean(node.closest('[role="grid"],[role="dialog"],[class*="calendar"],[class*="datepicker"]')),
      sensitiveForm: Boolean(node.closest("form")?.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]')),
      inputType: field.type ?? "", hasPopup: node.getAttribute("aria-haspopup") ?? "", selector: selectors.for(node),
      choiceValue: node.getAttribute("data-value") ?? undefined, choiceContext,
      disabledChoice: node.getAttribute("aria-disabled") === "true" || node.classList.contains("disabled"),
      ...((node.tagName === "SELECT" || node.tagName === "INPUT" && ["date", "number"].includes(field.type)) ? { currentValue: field.value.slice(0, 200) } : {}),
      ...(product ? { product } : {}),
      ...(node.tagName === "SELECT" ? { options: Array.from((node as HTMLSelectElement).options).slice(0, 100).map(item => ({ value: item.value.slice(0, 200), label: (item.textContent ?? "").trim().slice(0, 200) })) } : {}) };
  }).then(control => ({ ...control, ...(control.href ? { href: normalizeDiscoveryNavigationUrl(control.href) } : {}) }));
  const publicControlKind = (control: ObservedControl, blockedAccess: boolean) => {
    if (!recipeSelectorSchema.safeParse(control.selector).success || blockedAccess) return null;
    const kind = control.product ? "product" : discoveryPublicAnchorKind(control) ?? discoveryPublicChoiceKind(control) ?? interactiveControlKind(control) ?? (control.tag === "select" && !control.sensitiveForm ? "filter" : null);
    if (!kind || /\b(?:book|reserve|checkout|confirm|purchase|pay)\b/iu.test(control.name) && !["link", "product"].includes(kind) ||
      control.href && !isSafeRecipeUrl(control.href)) return null;
    return kind;
  };
  const waitForInitialContent = async () => {
    const startedAt = Date.now();
    // A blank shell is not a settled page. Keep the original navigation clock
    // across observe calls; a slow request cannot create a fresh waiting budget.
    while (navigationStartedAt !== undefined && pendingRequests > 0 && Date.now() < Math.min(navigationStartedAt + 30_000, input.deadlineAt.getTime())) {
      deadline.throwIfAborted();
      const text = sanitizeResponderText(await page.locator("body").innerText()).slice(0, 16_000);
      if (text.replace(/[^\p{L}\p{N}]/gu, "").length >= 40 || isActiveBrowserAccessChallenge(text, await page.title())) break;
      let usableControl = false;
      for (const node of (await page.locator('a[href],a[data-value],button,select,input,td,th,[role="combobox"],[role="option"],[role="gridcell"],[role="button"]').all()).slice(0, 180)) {
        if (!await node.isVisible() || !await node.isEnabled()) continue;
        const control = await observeControl(node);
        if (/[\p{L}\p{N}]{2}/u.test(`${control.name} ${control.label}`) && publicControlKind(control, false)) {
          usableControl = true; break;
        }
      }
      if (usableControl) break;
      await page.waitForTimeout(Math.min(250, Math.max(1, navigationStartedAt + 30_000 - Date.now()), Math.max(1, input.deadlineAt.getTime() - Date.now())));
    }
    return Date.now() - startedAt;
  };
  const snapshot = async (settleInitialContent = false): Promise<DiscoveryBrowserSnapshot> => {
    deadline.throwIfAborted();
    if (closed) throw new Error("BROWSER_CLOSED");
    controls.clear();
    observedElements.clear();
    await page.waitForTimeout(Math.min(300, Math.max(1, input.deadlineAt.getTime() - Date.now())));
    const initialContentWaitMs = settleInitialContent ? await waitForInitialContent() : 0;
    // A public app may change its route without making a document request.
    // Only its actually observed URL on an already admitted origin is reusable.
    const currentUrl = page.url();
    if (isSafeRecipeUrl(currentUrl) && navigationOrigins.has(new URL(currentUrl).origin)) {
      allowedNavigation.add(currentUrl);
      passfactory.observeWidgetUrl(currentUrl);
    }
    const text = sanitizeResponderText(await page.locator("body").innerText()).slice(0, 16_000);
    const blockedAccess = isActiveBrowserAccessChallenge(text, await page.title());
    if (!blockedAccess && officialIdentityDocument && sameDiscoveryMainDocument(officialIdentityDocument.url, currentUrl)) {
        const visibleEvidence = await page.evaluate(() => {
          const headings: string[] = [], linkUrls: string[] = [], addressTexts: string[] = [];
          for (const node of Array.from(document.querySelectorAll('h1,h2,a[href],address,p,div,li,td')).slice(0, 3000)) {
            if (!(node instanceof HTMLElement) || node.closest('form,script,template,noscript,iframe,[hidden],[inert],[aria-hidden="true"]')) continue;
            const rect = node.getBoundingClientRect();
            let ancestor: HTMLElement | null = node, visible = Boolean(rect.width && rect.height), depth = 0;
            while (ancestor && visible && depth++ < 32) {
              const style = getComputedStyle(ancestor);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') visible = false;
              ancestor = ancestor.parentElement;
            }
            if (!visible || ancestor) continue;
            const value = node.innerText.replace(/\n+/gu, ', ').replace(/\s+/gu, ' ').trim();
            if (/^H[12]$/u.test(node.tagName) && value.length <= 300 && headings.length < 80) headings.push(value);
            if (node instanceof HTMLAnchorElement && linkUrls.length < 120) linkUrls.push(node.href);
            if (value.length >= 15 && value.length <= 500 && addressTexts.length < 160 && /\b\d{5}(?:-\d{4})?\b/u.test(value)) addressTexts.push(value);
          }
          return { title: document.title.slice(0, 500), headings, linkUrls, addressTexts };
        });
        officialIdentityPage = { ...officialIdentityDocument, visibleEvidence, observedAt: Date.now() };
    }
    const visible: DiscoveryBrowserSnapshot["controls"] = [];
    const candidates: Array<{ locator: Locator; date?: string; dropdown?: PublicDropdownProof }> = (await page.locator('a[href],a[data-value],button,select,input,td,th,[role="combobox"],[role="option"],[role="gridcell"],[role="button"]').all()).slice(0, 180).map(locator => ({ locator }));
    const dayCandidates = blockedAccess ? [] : await observedPublicCalendarDays(page);
    const dropdowns = blockedAccess ? [] : (await observedPublicDropdowns(page)).map(value => ({ locator: value.locator, dropdown: value.proof }));
    const seenControls = new Set<string>();
    for (const { locator, date, dropdown } of [...dayCandidates, ...dropdowns, ...candidates] as typeof candidates) {
      if (!await locator.isVisible() || !await locator.isEnabled()) continue;
      const control = await observeControl(locator);
      if (seenControls.has(control.selector)) continue;
      seenControls.add(control.selector);
      // Native public selects remain discoverable when the widget omitted an
      // accessible name, without admitting sensitive forms or arbitrary fields.
      const kind = ((date || dropdown) && !blockedAccess && recipeSelectorSchema.safeParse(control.selector).success
        ? dropdown ? "filter" : interactiveControlKind({ ...control, verifiedCalendarDay: true }) : publicControlKind(control, blockedAccess)) ??
        (!blockedAccess && /^(?:Apply|Apply dates)$/iu.test(control.name) && await isPublicCalendarApply(locator) ? "calendar" : null);
      if (!kind) continue;
      if (control.href && isSafeRecipeUrl(control.href)) { allowedNavigation.add(control.href); passfactory.observeWidgetUrl(control.href); }
      if (control.href && !isSafeRecipeUrl(control.href)) continue;
      const target = randomUUID();
      controls.set(target, { locator, signature: JSON.stringify(control), kind, href: control.href, ...(date ? { calendarDay: date } : {}), ...(dropdown ? { dropdown } : {}) });
      observedElements.set(control.selector, { locator, signature: JSON.stringify(control) });
      visible.push({ target, selector: control.selector, kind, name: sanitizeResponderText(control.name), label: sanitizeResponderText(dropdown?.label ?? control.label),
        ...(control.currentValue === undefined ? {} : { currentValue: sanitizeResponderText(control.currentValue) }),
        ...(control.product ? { product: control.product } : {}),
        ...(control.options ? { options: control.options.map(option => ({ value: sanitizeResponderText(option.value), label: sanitizeResponderText(option.label) })) } : {}) });
    }
    const elements: DiscoveryBrowserSnapshot["elements"] = [];
    const allElements = page.locator("body *");
    const displayIndexes = await allElements.evaluateAll(nodes => {
      const dates: number[] = [], times: number[] = [], resources: number[] = [], durations: number[] = [];
      for (let index = 0; index < Math.min(nodes.length, 3000); index++) {
        const node = nodes[index];
        if (node.closest("script,style,noscript,input,textarea,select,option") ||
          node.closest("form")?.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]')) continue;
        const ownText = Array.from(node.childNodes).filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent ?? "").join(" ").trim();
        const label = node.getAttribute("aria-label") ?? "";
        const text = `${ownText} ${label}`;
        if (text.length < 250 && dates.length < 24 && /\b(?:\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/iu.test(text)) dates.push(index);
        // Read public display leaves independently of generated CSS classes.
        // These entries grant inspection only, never click authority.
        if (!ownText || ownText.length > 160 || node.children.length ||
          /\b(?:login|sign in|sign up|password|email|phone|checkout|payment|purchase|reserve|confirm|submit|contact)\b/iu.test(ownText)) continue;
        if (times.length < 48 && /^(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]\.?m\.?)?|(?:[1-9]|1[0-2])\s*[ap]\.?m\.?)$/iu.test(ownText)) times.push(index);
        else if (resources.length < 24 && /\b(?:golf|sims?|simulators?|bays?|rentals?|rooms?|courses?)\b/iu.test(ownText) &&
          !/\b(?:lessons?|coaching|classes?|leagues?|members?)\b/iu.test(ownText)) resources.push(index);
        else if (durations.length < 16 && /^(?:\d+(?:\.\d+)?\s*(?:minutes?|mins?|min|hours?|hrs?|hr|h)\s*(?:[-–]\s*)?)+$/iu.test(ownText)) durations.push(index);
      }
      return [...dates, ...times, ...resources, ...durations];
    });
    const nodes = [...displayIndexes.map(index => allElements.nth(index)), ...await page.locator('h1,h2,h3,label,time,[datetime],[data-date],[data-time],[data-capacity],[aria-live],select,input[type=date],input[type=number],td,li,[class*="slot"],[class*="time"],[class*="card"]').all()];
    const seenElements = new Set<string>();
    for (const node of nodes.slice(0, 180)) {
      if (!await node.isVisible()) continue;
      const control = await observeControl(node);
      if (!recipeSelectorSchema.safeParse(control.selector).success || control.sensitiveForm || seenElements.has(control.selector)) continue;
      seenElements.add(control.selector);
      observedElements.set(control.selector, { locator: node, signature: JSON.stringify(control) });
      const attributes = await node.evaluate(element => Object.fromEntries(Array.from(element.attributes)
        .filter(attribute => ["id", "class", "role", "datetime", "aria-label", "aria-selected", "aria-current", "value"].includes(attribute.name) || /^data-(?:date|time|timestamp|capacity|value|duration|resource|product|loaded|complete)$/u.test(attribute.name))
        .map(attribute => [attribute.name, attribute.value.slice(0, 200)])));
      elements.push({ selector: control.selector, tag: control.tag, text: sanitizeResponderText(control.name).slice(0, 250), attributes });
    }
    const frames = page.frames().filter(frame => frame !== page.mainFrame() && isSafeRecipeUrl(frame.url())).map(frame => ({ url: frame.url() })).slice(0, 10);
    for (const frame of frames) { allowedNavigation.add(frame.url); passfactory.observeWidgetUrl(frame.url); }
    const requests = observedRequests.map(request => ({ ...request }));
    const pendingMetadata = observedRequests.filter(request => pendingRequestMetadata.has(request));
    observedRequests.splice(0, observedRequests.length, ...pendingMetadata);
    requestMetadataBytes = pendingMetadata.reduce((total, request) => total + JSON.stringify(request).length + 120, 0);
    return { url: page.url(), text, controls: visible, elements, frames, responses: responses.splice(0), requests, loading: pendingRequests > 0,
      blockedRequests, requestCount, interceptCount, responseBytes, startupMs, initialContentWaitMs, pendingRequestCount: pendingRequests,
      ...(navigationStartedAt === undefined ? {} : { navigationElapsedMs: Date.now() - navigationStartedAt }),
      ...(navigation && sameDiscoveryMainDocument(navigation.url, page.url()) ? { navigationStatus: navigation.status } : {}),
      browserTransport: deps.browserTransport ?? "PINNED_HTTP", accessRequirementObserved: blockedAccess };
  };
  return {
    async execute(value: unknown): Promise<DiscoveryBrowserSnapshot> {
      const action = discoveryBrowserActionSchema.parse(value);
      deadline.throwIfAborted();
      if (closed || action.action !== "observe" && ++actions > 40) throw new Error("BROWSER_ACTION_LIMIT");
      if (action.action === "observe") {
        if (++observations > 120) throw new Error("BROWSER_OBSERVATION_LIMIT");
        await page.waitForTimeout(Math.min(700, Math.max(1, input.deadlineAt.getTime() - Date.now())));
      }
      if (action.action === "finish") { const result = await snapshot(); await close(); return result; }
      if (action.action === "inspect") {
        const known = observedElements.get(action.selector);
        if (!known || !await known.locator.isVisible() || JSON.stringify(await observeControl(known.locator)) !== known.signature)
          throw new Error("STALE_OR_UNKNOWN_ELEMENT");
        const structure: NonNullable<DiscoveryBrowserSnapshot["structure"]> = { selected: action.selector, ancestors: [] };
        const returnedNodes: Array<{ locator: Locator; selector: string; signature: string }> = [];
        let node = known.locator;
        for (let depth = 0; depth < 4; depth++) {
          const control = await observeControl(node);
          if (control.sensitiveForm || !recipeSelectorSchema.safeParse(control.selector).success) break;
          const attributes = await node.evaluate(element => Object.fromEntries(Array.from(element.attributes)
            .filter(attribute => ["id", "class", "role"].includes(attribute.name)).map(attribute => [attribute.name, attribute.value.slice(0, 100)])));
          const children: Array<{ selector: string; tag: string; text: string }> = [];
          const returnedChildren: typeof returnedNodes = [];
          for (const child of (await node.locator(":scope > *").all()).slice(0, 12)) {
            if (children.length >= 6 || !await child.isVisible()) continue;
            const observed = await observeControl(child);
            if (observed.sensitiveForm || !recipeSelectorSchema.safeParse(observed.selector).success) continue;
            children.push({ selector: observed.selector, tag: observed.tag, text: sanitizeResponderText(observed.name).slice(0, 80) });
            returnedChildren.push({ locator: child, selector: observed.selector, signature: JSON.stringify(observed) });
          }
          const selector = control.tag === "body" ? "body" : control.selector;
          const entry = { selector, matches: await page.locator(selector).count(), tag: control.tag,
            text: sanitizeResponderText(control.name).slice(0, 160), attributes, children };
          if (JSON.stringify({ ...structure, ancestors: [...structure.ancestors, entry] }).length > 6000) break;
          structure.ancestors.push(entry);
          returnedNodes.push(...returnedChildren);
          returnedNodes.push({ locator: node, selector, signature: JSON.stringify(control) });
          if (control.tag === "body") break;
          node = node.locator("..");
        }
        const result = await snapshot();
        for (const returned of returnedNodes) {
          if (await returned.locator.isVisible() && JSON.stringify(await observeControl(returned.locator)) === returned.signature)
            observedElements.set(returned.selector, { locator: returned.locator, signature: returned.signature });
        }
        return { ...result, structure };
      }
      if (action.action === "inspect_adapter") {
        if (!isSafeRecipeUrl(action.url) || !allowedNavigation.has(new URL(action.url).href)) throw new Error("UNOBSERVED_NAVIGATION");
        if (!input.venueName || input.venueName.length > 200) throw new Error("MISSING_VENUE_IDENTITY");
        const result = await (deps.inspectAdapter ?? inspectExistingAdapter)({ officialUrl: input.venueOfficialUrl, bookingUrl: action.url, venueName: input.venueName, venueAddress: input.venueAddress, timeZone: input.timeZone ?? "UTC" },
          { venueMatches: venueProofMatches, requestLease: deps.requestLease ?? runWithProviderRequestLease, deadlineAt: input.deadlineAt,
            ...(officialIdentityPage && Date.now() - officialIdentityPage.observedAt <= 5 * 60_000 ? { officialIdentityPage } : {}) });
        return { ...await snapshot(), adapter: result.adapter };
      }
      if (action.action === "open") {
        if (!isSafeRecipeUrl(action.url) || !allowedNavigation.has(new URL(action.url).href)) throw new Error("UNOBSERVED_NAVIGATION");
        navigationOrigins.add(new URL(action.url).origin); passfactory.observeWidgetUrl(action.url);
        navigationStartedAt = Date.now();
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, Math.max(1, input.deadlineAt.getTime() - Date.now())) });
      } else if (page.url() === "about:blank") throw new Error("OPEN_A_SOURCE_FIRST");
      else if (action.action === "scroll") await page.mouse.wheel(0, action.direction === "down" ? 600 : -600);
      else if (["click", "select", "fill"].includes(action.action) && "target" in action) {
        const known = controls.get(action.target);
        if (!known || !await known.locator.isVisible() || !await known.locator.isEnabled() || JSON.stringify(await observeControl(known.locator)) !== known.signature) throw new Error("STALE_OR_UNKNOWN_CONTROL");
        if (known.calendarDay && !await isObservedPublicCalendarDay(known.locator, known.calendarDay)) throw new Error("STALE_OR_UNKNOWN_CONTROL");
        if (action.action === "select") {
          if (known.kind !== "filter") throw new Error("UNSAFE_CONTROL");
          if (known.dropdown) await selectPublicDropdown(known.locator, { value: action.option, purpose: known.dropdown.purpose, simulator: true });
          else {
            const observed = await observeControl(known.locator);
            const option = observed.options?.find(item => item.value === action.option || item.label === action.option);
            if (!option) throw new Error("UNOBSERVED_OPTION");
            await known.locator.selectOption(option.value);
          }
        } else if (action.action === "fill") {
          if (known.kind !== "field" || !/^[\d\s/:.T-]{1,120}$/u.test(action.text)) throw new Error("UNSAFE_CONTROL");
          await known.locator.fill(action.text); await known.locator.dispatchEvent("change");
        } else {
          if (known.kind === "field" || known.kind === "filter" && (await observeControl(known.locator)).tag === "select") throw new Error("USE_TYPED_CONTROL_ACTION");
          if (known.href) {
            if (!isSafeRecipeUrl(known.href)) throw new Error("UNSAFE_NAVIGATION");
            allowedNavigation.add(known.href); navigationOrigins.add(new URL(known.href).origin); navigationStartedAt = Date.now();
            await page.goto(known.href, { waitUntil: "domcontentloaded" });
          } else await known.locator.click();
        }
      }
      return snapshot(action.action === "open" || action.action === "observe");
    },
    async close() { deadline.removeEventListener("abort", abort); await close(); },
  };
}
