import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { Browser, Response as BrowserResponse } from "@playwright/test";
import { createAddressPinnedPublicFetchTransport, resolvePinnedPublicAddress } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { createNativePublicBrowserProxy } from "./native-public-browser";
import { isSafeBrowserAssetUrl, isSafeRecipeUrl, type AccessExecutionInput } from "./recipe";
import { teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";
import { PLAYBYPOINT_CLIENT_HASH, PLAYBYPOINT_CLIENT_URL, parsePlaybyPointWidget, playbyPointMetadataSchema,
  playbyPointOptionsSchema, playbyPointPublicHeader, playbyPointReadInput, playbyPointResourceSelection, isPlaybyPointPublicFacilityRead,
  type PlaybyPointMetadata, type PlaybyPointOptions, type PlaybyPointSource } from "./playbypoint-public";

type Dependencies = { deadlineAt?: Date; localCapabilities?: readonly "LOCAL_CHROME"[];
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  launchBrowser?: (proxy: string) => Promise<Browser>;
  toInstant?: (value: unknown, input: AccessExecutionInput) => Date };
function fail(code: string): never { throw Error(code); }
const nameKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function officialBookingLinks(html: string, officialUrl: string) {
  const roots = new Set<string>(), official = new URL(officialUrl);
  const walk = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node && node.tagName === "a") {
      const value = node.attrs.find(attr => attr.name === "href")?.value;
      try {
        const url = value && new URL(value, official);
        if (url && url.protocol === "https:" && !url.username && !url.password && !url.port &&
          url.hostname === "book." + official.hostname.replace(/^www\./u, "")) roots.add(url.origin + "/");
      } catch { /* Invalid links cannot prove an official booking source. */ }
    }
    if ("childNodes" in node) node.childNodes.forEach(walk);
  };
  parse(html).childNodes.forEach(walk);
  return [...roots];
}
export function isPlaybyPointCandidate(source: PlaybyPointSource) {
  try {
    return Boolean(source.officialUrl && source.venueAddress && isSafeRecipeUrl(source.bookingUrl) &&
      (source.bookingUrl === source.officialUrl || new URL(source.bookingUrl).hostname ===
        "book." + new URL(source.officialUrl).hostname.replace(/^www\./u, "")));
  } catch { return false; }
}
export function playbyPointRouteAllowed(request: {
  url: string; method: string; type: string; body: string | null; headers: Record<string, string>;
}, scope: { root: string; widget: string | null; date: string }) {
  try {
    const url = new URL(request.url), root = new URL(scope.root), widget = scope.widget && parsePlaybyPointWidget(scope.widget);
    const api = widget && "https://app.playbypoint.com/v1/" + widget.facilityUuid + "/graphql";
    if (request.url === api && request.method === "POST") {
      const input = playbyPointReadInput(request.body);
      const bootstrap = input && Object.keys(input).length === 0 || isPlaybyPointPublicFacilityRead(request.body);
      const dated = input?.date && input.dateFrom && input.dateTo && input.date >= input.dateFrom && input.date <= input.dateTo &&
        (input.sport === undefined || input.date === scope.date);
      return Boolean((bootstrap || dated) && playbyPointPublicHeader(request.headers));
    }
    if (request.url === api && request.method === "OPTIONS") {
      return request.headers.origin === "https://greenfield.playbypoint.com" &&
        request.headers["access-control-request-method"] === "POST" && !request.body &&
        (request.headers["access-control-request-headers"] ?? "").split(",").every(key =>
          ["authorization", "content-type", "fooly"].includes(key.trim().toLowerCase()));
    }
    if (request.method !== "GET" || request.body || Object.keys(request.headers).some(key =>
      /^(?:authorization|proxy-authorization|token|x-api-key)$/iu.test(key))) return false;
    if (url.origin === root.origin && /^\/page_builder\/api\/facilities\/[A-Za-z0-9_-]{1,100}\/pages\/home$/u.test(url.pathname) &&
      !url.search && ["fetch", "xhr"].includes(request.type)) return true;
    if (request.type === "document") return request.url === scope.root || request.url === root.origin + "/book" ||
      /^\/book\/[A-Za-z0-9_-]{1,100}$/u.test(url.pathname) && url.origin === root.origin && !url.search ||
      request.url === scope.widget;
    if (url.origin === "https://greenfield.playbypoint.com" && url.pathname === "/bootstrap-platform-auth.js" && !url.search) return true;
    return ["script", "stylesheet", "font", "image"].includes(request.type) &&
      [root.hostname, "greenfield.playbypoint.com", "assets.playbypoint.com", "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname) &&
      (["font", "image"].includes(request.type) ? isSafeRecipeUrl(request.url) : isSafeBrowserAssetUrl(request.url, request.type, "GET"));
  } catch { return false; }
}
export async function readPlaybyPoint(source: PlaybyPointSource, input: AccessExecutionInput, deps: Dependencies,
  saved?: PlaybyPointMetadata) {
  if (!deps.localCapabilities?.includes("LOCAL_CHROME")) fail("LOCAL_CHROME_REQUIRED");
  if (!isPlaybyPointCandidate(source) || input.timeZone !== source.timeZone || input.durationMinutes !== 60) fail("ADAPTER_TARGET_MISMATCH");
  const remaining = Math.min(100_000, (deps.deadlineAt?.getTime() ?? Infinity) - Date.now());
  if (remaining <= 0) fail("DEADLINE_EXCEEDED");
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const officialUrl = source.officialUrl!;
  const transport = createAddressPinnedPublicFetchTransport({ parseUrl: value => {
    if (value !== officialUrl) fail("UNSCOPED_ADAPTER_REQUEST"); return new URL(value);
  }, maxResponseBytes: 2_000_000, timeoutMs: 12_000, redirectLimit: 0 });
  const roots = await queue.run(new URL(officialUrl).hostname, async () => {
    const response = await transport(officialUrl, { method: "GET", credentials: "omit", redirect: "manual", signal });
    try {
      if (response.status !== 200 || !/text\/html/iu.test(response.headers.get("content-type") ?? "")) fail("PLAYBYPOINT_OFFICIAL_SOURCE_UNVERIFIED");
      return officialBookingLinks(await response.text(), officialUrl);
    } finally { await response.body?.cancel().catch(() => {}); }
  }).catch(error => { controller.abort(); queue.dispose(); throw error; });
  if (roots.length !== 1 || source.bookingUrl !== officialUrl && new URL(source.bookingUrl).origin !== new URL(roots[0]).origin)
    { controller.abort(); queue.dispose(); fail("PLAYBYPOINT_OFFICIAL_SOURCE_UNVERIFIED"); }
  const root = roots[0], scope = { root, widget: null as string | null, date: input.date };
  const proxy = await createNativePublicBrowserProxy({ signal, maxBytes: 24_000_000, maxConnections: 200 })
    .catch(error => { controller.abort(); queue.dispose(); throw error; });
  let browser: Browser | undefined;
  let phase = "LAUNCH", requestCount = 0, verifiedClient = false;
  const denied: string[] = [];
  try {
    browser = deps.launchBrowser ? await deps.launchBrowser(proxy.server) : await launchPublicReadBrowser({
      headless: process.platform !== "win32", ...(process.platform === "win32" ? { channel: "chrome" } : {}),
      proxy: { server: proxy.server, bypass: "<-loopback>" }, args: ["--disable-quic"], timeout: 30000,
    });
    const owned = browser;
    const abort = () => { void owned.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const context = await browser.newContext({ timezoneId: input.timeZone, locale: "en-US", serviceWorkers: "block", acceptDownloads: false });
      await context.routeWebSocket("**/*", socket => socket.close());
      const page = await context.newPage();
      await context.route("**/*", async route => {
        const request = route.request();
        let continued = false;
        try {
          signal.throwIfAborted();
          const headers = await request.allHeaders();
          const body = request.postData();
          if (++requestCount > 180 || !playbyPointRouteAllowed({ url: request.url(), method: request.method(),
            type: request.resourceType(), body, headers }, scope)) throw Error("PLAYBYPOINT_READ_REJECTED");
          const hostname = new URL(request.url()).hostname;
          await resolvePinnedPublicAddress(hostname); proxy.allowHostConnections(hostname);
          await queue.run(hostname.endsWith("playbypoint.com") ? "PLAYBYPOINT" : hostname, async () => {
            continued = true; await route.continue();
            const response = await request.response();
            if (request.url() === PLAYBYPOINT_CLIENT_URL && response?.status() === 200) {
              const bytes = await response.body();
              verifiedClient = bytes.length <= 2_000_000 && createHash("sha256").update(bytes).digest("hex") === PLAYBYPOINT_CLIENT_HASH;
            }
            if (response) await response.finished();
          });
        } catch {
          denied.push(request.method() + " " + request.resourceType() + " " + new URL(request.url()).pathname.slice(0,100));
          if (denied.length > 15) denied.shift();
          if (!continued) await route.abort().catch(() => {});
        }
      });
      phase = "IDENTITY";
      const landing = await page.goto(root, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (landing?.status() !== 200 || page.url() !== root) fail("PLAYBYPOINT_IDENTITY_UNVERIFIED");
      const heading = page.getByRole("heading", { level: 1, name: source.venueName, exact: true });
      await heading.waitFor({ timeout: 15000 });
      const canonicalAddress = teeItUpCompleteStreetAddress(source.venueAddress!);
      const paragraphs = await page.locator("p").allTextContents();
      const addresses = paragraphs.map(value => teeItUpCompleteStreetAddress(value)).filter(Boolean);
      if (!canonicalAddress || !addresses.some(address => JSON.stringify(address) === JSON.stringify(canonicalAddress)) ||
        nameKey(await heading.innerText()) !== nameKey(source.venueName)) fail("PLAYBYPOINT_IDENTITY_UNVERIFIED");
      const entry = page.getByRole("link", { name: "Book Now", exact: true });
      const href = await entry.getAttribute("href");
      if (!href || !/^\/book\/[A-Za-z0-9_-]{1,100}$/u.test(href)) fail("PLAYBYPOINT_ENTRY_UNVERIFIED");
      await entry.click();
      const frameElement = page.locator('iframe[src^="https://greenfield.playbypoint.com/booking/select?"]');
      await frameElement.waitFor({ timeout: 15000 });
      scope.widget = await frameElement.getAttribute("src");
      const widget = scope.widget && parsePlaybyPointWidget(scope.widget);
      if (!widget) fail("PLAYBYPOINT_WIDGET_UNVERIFIED");
      // The frame navigation is withheld until its DOM URL is independently bound.
      const frameUrl = scope.widget!;
      await page.goto(frameUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      const ui = page;
      const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
        .formatToParts(new Date(input.date + "T12:00:00Z"));
      const fields = Object.fromEntries(dateLabel.map(part => [part.type, part.value]));
      const dateButton = ui.getByRole("button", { name: `${fields.weekday} ${fields.day} ${fields.month}`.toUpperCase(), exact: true });
      const api = "https://app.playbypoint.com/v1/" + widget.facilityUuid + "/graphql";
      const responseFor = (predicate: (value: NonNullable<ReturnType<typeof playbyPointReadInput>>) => boolean) =>
        page.waitForResponse(response => response.url() === api && response.request().method() === "POST" &&
          response.request().frame() === page.mainFrame() && (() => { const value = playbyPointReadInput(response.request().postData()); return value !== null && predicate(value); })(),
        { timeout: 18000 });
      const readResponse = async (response: BrowserResponse): Promise<PlaybyPointOptions> => {
        if (!verifiedClient || response.status() !== 200 || !/application\/json/iu.test(response.headers()["content-type"] ?? "")) fail("PLAYBYPOINT_PUBLIC_READ_FAILED");
        const bytes = await response.body();
        if (bytes.length > 1_000_000) fail("PLAYBYPOINT_RESPONSE_LIMIT");
        return playbyPointOptionsSchema.parse(JSON.parse(bytes.toString("utf8"))).data.whiteLabelFacility;
      };
      phase = "DATE_CONTROL";
      await dateButton.waitFor({ timeout: 20000 });
      phase = "DATE_CLICK";
      await dateButton.click();
      const publicOptions = responseFor(value => value.date === input.date && value.sport === "SIMULATOR" && value.hourStart === undefined);
      phase = "SIMULATOR_CONTROL";
      await ui.getByRole("button", { name: "Simulator", exact: true }).click();
      phase = "SIMULATOR_RESPONSE";
      const options = await readResponse(await publicOptions);
      const resources = playbyPointResourceSelection(options, { date: input.date, timeZone: source.timeZone });
      if (!resources.length) fail("PLAYBYPOINT_RESOURCES_UNVERIFIED");
      const metadata = playbyPointMetadataSchema.parse({ family: "PLAYBYPOINT", entryUrl: source.bookingUrl,
        warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME",
        bookingRoot: root, widgetUrl: frameUrl, facilityUuid: widget.facilityUuid, facilityId: options.id, timeZone: options.bookingOptions.timeZone, resources });
      if (saved && JSON.stringify(metadata) !== JSON.stringify(saved)) fail("ADAPTER_CONFIGURATION_CHANGED");
      if (!deps.toInstant) return { metadata, slots: [] };
      const startSeconds = (clock: string) => { const [hours, minutes] = clock.split(":").map(Number); return hours * 3600 + minutes * 60; };
      const starts = options.bookingOptions.schedule.startOptions.filter(value => value.hourStart >= startSeconds(input.startTime) &&
        value.hourStart + 3600 <= startSeconds(input.endTime) && value.hourEnds.includes(value.hourStart + 3600));
      if (starts.length > 24) fail("PLAYBYPOINT_REQUEST_LIMIT");
      const slots = [];
      phase = "AVAILABILITY";
      for (const start of starts) {
        signal.throwIfAborted();
        const end = start.hourStart + 3600;
        const reply = responseFor(value => value.date === input.date && value.sport === "SIMULATOR" &&
          value.hourStart === start.hourStart && value.hourEnd === end);
        const dateFormat = (seconds: number) => { const hours = Math.floor(seconds / 3600), minutes = seconds % 3600 / 60;
          return `${hours % 12 || 12}${minutes ? ":" + String(minutes).padStart(2,"0") : ""}`; };
        const firstEnd = start.hourStart + 1800;
        const button = `${dateFormat(start.hourStart)}-${dateFormat(firstEnd)} ${firstEnd < 43200 ? "AM" : "PM"}`;
        await ui.getByRole("button", { name: button, exact: true }).click();
        const current = await readResponse(await reply);
        const available = playbyPointResourceSelection(current, { facilityId: metadata.facilityId, date: input.date,
          timeZone: input.timeZone, start: start.hourStart, end });
        for (const resource of available) {
          if (!metadata.resources.some(value => value.id === resource.id && value.name === resource.name)) fail("PLAYBYPOINT_RESOURCES_CHANGED");
          const clock = (seconds: number) => String(Math.floor(seconds / 3600)).padStart(2,"0") + ":" + String(seconds % 3600 / 60).padStart(2,"0");
          const startsAt = deps.toInstant(`${input.date}T${clock(start.hourStart)}:00`, input).toISOString();
          const endsAt = deps.toInstant(`${input.date}T${clock(end)}:00`, input).toISOString();
          if (Date.parse(endsAt) - Date.parse(startsAt) !== 3600000) fail("PLAYBYPOINT_DURATION_UNVERIFIED");
          slots.push({ sourceId: `playbypoint-${metadata.facilityId}-${resource.id}-${startsAt}`, startsAt, endsAt,
            availableSpots: 1, capacity: null, bookingUrl: source.bookingUrl, resourceId: resource.id });
        }
        const cleared = responseFor(value => value.date === input.date && value.sport === "SIMULATOR" && value.hourStart === undefined);
        await ui.getByRole("button", { name: button, exact: true }).click();
        const reset = await readResponse(await cleared);
        playbyPointResourceSelection(reset, { facilityId: metadata.facilityId, date: input.date, timeZone: input.timeZone });
      }
      return { metadata, slots };
    } finally { signal.removeEventListener("abort", abort); }
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "PLAYBYPOINT_PUBLIC_READ_FAILED";
    throw Object.assign(Error(code), { details: { phase, requestCount, denied,
      errorKind: error instanceof Error ? error.name : "unknown" } });
  } finally { controller.abort(); queue.dispose(); await browser?.close().catch(() => {}); await proxy.close(); }
}
