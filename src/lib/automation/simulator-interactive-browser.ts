import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { createAddressPinnedPublicFetchTransport } from "./address-pinned-public-fetch";
import { runWithProviderRequestLease } from "./provider-request-lease";
import { sanitizeResponderText } from "./course-support-responder-policy";
import { detectSimulatorResearchAccessControls, summarizeSimulatorPublicJsonShape,
  resultFromSimulatorResearchBody, type SimulatorResearchResult } from "./simulator-support-research";

export const INTERACTIVE_BROWSER_DURATION_MS = 5 * 60_000;
export const browserActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("observe") }).strict(),
  z.object({ action: z.literal("click"), target: z.string().uuid() }).strict(),
  z.object({ action: z.literal("select"), target: z.string().uuid(), option: z.string().min(1).max(120) }).strict(),
  z.object({ action: z.literal("fill"), target: z.string().uuid(), text: z.string().max(120) }).strict(),
  z.object({ action: z.literal("scroll"), direction: z.enum(["up", "down"]) }).strict(),
  z.object({ action: z.literal("finish") }).strict(),
]);
type BrowserAction = z.infer<typeof browserActionSchema>;
const forbidden = /\b(?:login|log in|sign in|sign up|register|checkout|check out|pay|payment|purchase|buy|cart|reserve|confirm|submit|cancel|delete|send|subscribe|membership|password|email|phone)\b/iu;
const filterName = /\b(?:date|day|month|calendar|duration|length|party|players?|people|guests?|bay|resource|simulator|location|activity|previous month|next month|availability|available|search|view times)\b/iu;
const timeSlot = /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/iu;

/** UI intent is checked separately from the server request contract. Slots are never clicked. */
export function interactiveControlKind(input: { tag: string; role: string; name: string; label: string; href?: string; calendar?: boolean; sensitiveForm?: boolean; inputType?: string }) {
  const name = `${input.name} ${input.label}`.trim();
  if (input.sensitiveForm || forbidden.test(name) || timeSlot.test(input.name)) return null;
  if (input.tag === "a" && input.href && getSafeCustomerBookingUrl(input.href)) return "link" as const;
  if ((input.tag === "select" || input.role === "combobox") && filterName.test(name)) return "filter" as const;
  if (input.tag === "input" && ["search", "date", "text", "number"].includes(input.inputType ?? "") &&
      /\b(?:search|date|duration|players?|party|location|course)\b/iu.test(name)) return "field" as const;
  if (input.role === "option") return "option" as const;
  if ((input.role === "gridcell" || input.tag === "button") &&
      (filterName.test(name) || (input.role === "gridcell" || input.calendar) && /\d/u.test(input.name))) return "calendar" as const;
  return null;
}

/** Only explicitly read-shaped anonymous JSON requests, never arbitrary page POSTs. */
export function isAnonymousBrowserReadPost(_url: URL, headers: Headers, body: string) {
  if (Buffer.byteLength(body) > 32_768 || !/application\/json/iu.test(headers.get("content-type") ?? "")) return false;
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const serialized = JSON.stringify(value);
    if (/"[^"\\]*(?:password|secret|token|email|phone|card|payment|customer|account|session|authorization|cookie)[^"\\]*"\s*:/iu.test(serialized)) return false;
    if (/\b(?:mutation|subscription|checkout|reserve|purchase|payment|createBooking|bookSlot|delete|update|insert)\b/iu.test(serialized)) return false;
    if (typeof value.query === "string") return /^\s*(?:query\b|\{)/u.test(value.query) && !/\b(?:mutation|subscription)\b/u.test(value.query);
    // A get/list-shaped operation name alone does not establish read semantics.
    return false;
  } catch { return false; }
}

function containsGraphqlQuery(body: string) {
  if (body.length > 32_768) return false;
  try { return typeof JSON.parse(body)?.query === "string"; } catch { return false; }
}

export async function validateBrowserChannel(directory: string, cwd = process.cwd()) {
  const root = await realpath(resolve(cwd, ".codex-artifacts", "browser"));
  const path = resolve(directory);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !(path + sep).startsWith(root + sep) || await realpath(path) !== path) throw new Error("BROWSER_CHANNEL_REJECTED");
  return path;
}

async function readChannelFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4_000_000) throw new Error("BROWSER_CHANNEL_REJECTED");
  return JSON.parse(await readFile(path, "utf8"));
}
async function publish(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

/** One owned source read; the native worker chooses each next action from fresh visual evidence. */
export async function collectInteractiveSimulatorResearch(input: { url: string; channel: string; assertOwned: () => Promise<void> },
  dependencies: { launch?: typeof chromium.launch; lease?: typeof runWithProviderRequestLease; fetch?: typeof fetch } = {}): Promise<SimulatorResearchResult> {
  const channel = await validateBrowserChannel(input.channel);
  const requestedUrl = getSafeCustomerBookingUrl(input.url);
  if (!requestedUrl) throw new Error("SIMULATOR_RESEARCH_UNSAFE_URL");
  const deadline = AbortSignal.timeout(INTERACTIVE_BROWSER_DURATION_MS);
  const browser = await (dependencies.launch ?? (options => chromium.launch(options)))({ headless: true, timeout: 15_000 });
  let context;
  try { context = await browser.newContext({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block",
    acceptDownloads: false, viewport: { width: 1280, height: 900 } }); }
  catch (error) { await browser.close(); throw error; }
  let page: Page | undefined;
  let failure: unknown;
  let requests = 0, blocked = 0, bytes = 0, navigations = 0, sequence = 0;
  let status = 0;
  let choosingFilter = false;
  const origins = new Set([new URL(requestedUrl).origin]);
  const contracts: NonNullable<SimulatorResearchResult["responseContracts"]> = [];
  const active = new Set<Promise<void>>();
  let controls = new Map<string, { locator: Locator; kind: string; signature: string; href?: string }>();
  const transport = dependencies.fetch ?? createAddressPinnedPublicFetchTransport({
    parseUrl: value => { const safe = getSafeCustomerBookingUrl(value); if (!safe) throw new Error("BROWSER_UNSAFE_REQUEST"); return new URL(safe); },
    maxResponseBytes: 4_000_000, timeoutMs: 15_000, redirectLimit: 0, authorizeReadPost: isAnonymousBrowserReadPost,
  });
  const lease = dependencies.lease ?? runWithProviderRequestLease;
  const assertLive = async () => {
    if (deadline.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
    if (failure) throw failure;
    await input.assertOwned();
  };
  try {
    await context.routeWebSocket("**/*", route => route.close());
    await context.route("**/*", async route => {
      const operation = (async () => {
        const request = route.request();
        try {
          if (deadline.aborted || failure) return await route.abort();
          const safe = getSafeCustomerBookingUrl(request.url());
          const headers = await request.allHeaders();
          const method = request.method();
          const kind = request.resourceType();
          const body = request.postData() ?? "";
          const publicHeaders = new Headers();
          for (const key of ["accept", "accept-language", "user-agent", "content-type", "origin"]) if (headers[key]) publicHeaders.set(key, headers[key]);
          if (!safe || !["GET", "HEAD", "POST"].includes(method) ||
              Object.keys(headers).some(key => /^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token)$/iu.test(key)) ||
              !["document", "script", "stylesheet", "image", "font", "xhr", "fetch"].includes(kind) ||
              method === "POST" && ((!origins.has(new URL(safe).origin) && !containsGraphqlQuery(body)) || !isAnonymousBrowserReadPost(new URL(safe), publicHeaders, body))) {
            blocked += 1; return await route.abort("blockedbyclient");
          }
          if (kind === "document" && request.frame() === page?.mainFrame() && !origins.has(new URL(safe).origin)) {
            blocked += 1; return await route.abort("blockedbyclient");
          }
          if (++requests > 192 || bytes > 24_000_000) throw new Error("SIMULATOR_RESEARCH_REQUEST_LIMIT");
          const leased = await lease(new URL(safe).hostname, async () => {
            const response = await transport(safe, { method, headers: publicHeaders, credentials: "omit", redirect: "manual", signal: deadline,
              ...(method === "POST" ? { body } : {}) });
            const buffer = Buffer.from(await response.arrayBuffer());
            bytes += buffer.length;
            if (bytes > 24_000_000) throw new Error("SIMULATOR_RESEARCH_BODY_LIMIT");
            const type = response.headers.get("content-type") ?? "";
            const responseHeaders: Record<string, string> = { "content-type": type };
            const location = response.headers.get("location");
            if (location) {
              const next = getSafeCustomerBookingUrl(new URL(location, safe).href);
              if (!next || method === "POST" || ++navigations > 6 || new URL(next).hostname.replace(/^www\./u, "") !== new URL(safe).hostname.replace(/^www\./u, "")) throw new Error("BROWSER_UNSAFE_REDIRECT");
              origins.add(new URL(next).origin); responseHeaders.location = next;
            }
            if (request.isNavigationRequest() && request.frame() === page?.mainFrame()) status = response.status;
            if (type.includes("json") && contracts.length < 8) {
              try { contracts.push({ pathShape: new URL(safe).pathname.split("/").map(p => p ? ":value" : "").join("/"), queryKeys: [],
                httpStatus: response.status, shape: summarizeSimulatorPublicJsonShape(JSON.parse(buffer.toString("utf8"))) }); } catch { /* Not JSON. */ }
            }
            const cors = response.headers.get("access-control-allow-origin");
            if (cors === "*" || cors && origins.has(cors)) responseHeaders["access-control-allow-origin"] = cors;
            await route.fulfill({ status: response.status, headers: responseHeaders, body: buffer });
          });
          if (!leased.acquired) throw new Error("SIMULATOR_RESEARCH_PROVIDER_BUSY");
        } catch (error) { failure = error; await route.abort().catch(() => {}); }
      })();
      active.add(operation);
      try { await operation; } finally { active.delete(operation); }
    });
    page = await context.newPage();
    page.on("popup", popup => { void popup.close(); });
    const observedControl = async (locator: Locator) => locator.evaluate(element => {
      const e = element as HTMLElement;
      const input = element as HTMLInputElement;
      const label = [e.getAttribute("aria-label"), ...(Array.from(input.labels ?? []).map(l => l.textContent)),
        e.getAttribute("aria-labelledby")?.split(/\s+/u).map(id => document.getElementById(id)?.textContent).join(" ")].filter(Boolean).join(" ");
      return { tag: e.tagName.toLowerCase(), role: e.getAttribute("role") ?? "", name: (e.innerText || e.getAttribute("aria-label") || "").trim().slice(0, 160), label: label.slice(0, 200),
        href: e instanceof HTMLAnchorElement ? e.href : undefined,
        calendar: Boolean(e.closest('[role="grid"]')),
        inputType: input.type,
        sensitiveForm: Boolean(e.closest("form")?.querySelector('input[type="password"],input[type="email"],input[type="tel"],[autocomplete^="cc-"]')) };
    });
    const snapshot = async (message?: string) => {
      await assertLive();
      await page!.waitForTimeout(350);
      const html = await page!.content();
      const access = detectSimulatorResearchAccessControls(html);
      controls = new Map();
      const visible = [];
      const locators = await page!.locator("a[href],button,select,input,[role=combobox],[role=option],[role=gridcell]").all();
      for (const locator of locators.slice(0, 300)) {
        if (!await locator.isVisible() || !await locator.isEnabled()) continue;
        const item = await observedControl(locator);
        const kind = interactiveControlKind(item);
        if (!kind || access.length || status >= 400 || kind === "option" && !choosingFilter) continue;
        const target = randomUUID();
        controls.set(target, { locator, kind, signature: JSON.stringify(item), href: item.href });
        visible.push({ target, kind, name: sanitizeResponderText(item.name), label: sanitizeResponderText(item.label),
          ...(item.tag === "select" ? { options: await locator.locator("option").allTextContents() } : {}) });
      }
      const image = (await page!.screenshot({ type: "png", timeout: 5_000 })).toString("base64");
      if (image.length > 3_000_000) throw new Error("BROWSER_SCREENSHOT_LIMIT");
      return { phase: "open", sequence, message, url: page!.url(), text: sanitizeResponderText(await page!.locator("body").innerText()).slice(0, 12_000),
        controls: visible, accessControls: access, blockedRequests: blocked, admittedRequests: requests, screenshot: image };
    };
    await assertLive();
    await page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await publish(join(channel, "response-0.json"), await snapshot());
    for (sequence = 1; sequence <= 24; sequence++) {
      let action: BrowserAction | undefined;
      const path = join(channel, `request-${sequence}.json`);
      while (!action) {
        if (deadline.aborted || failure) throw failure ?? new Error("SIMULATOR_RESEARCH_DEADLINE");
        try { action = browserActionSchema.parse(await readChannelFile(path)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await delay(100); }
      }
      await assertLive();
      if (action.action === "finish") break;
      if (action.action === "scroll") await page.mouse.wheel(0, action.direction === "down" ? 650 : -650);
      if (action.action === "click" || action.action === "select" || action.action === "fill") {
        const control = controls.get(action.target);
        if (!control || !await control.locator.isVisible() || !await control.locator.isEnabled() ||
            JSON.stringify(await observedControl(control.locator)) !== control.signature) {
          await publish(join(channel, `response-${sequence}.json`), await snapshot("Target changed; choose from fresh controls.")); continue;
        }
        if (action.action === "fill") {
          if (control.kind !== "field") throw new Error("BROWSER_ACTION_REJECTED");
          await control.locator.fill(action.text, { timeout: 5_000 });
        } else if (action.action === "select") {
          if (control.kind !== "filter") throw new Error("BROWSER_ACTION_REJECTED");
          await control.locator.selectOption({ label: action.option }, { timeout: 5_000 });
        } else {
          choosingFilter = control.kind === "filter";
          if (control.kind === "link" && control.href) {
            if (++navigations > 3) throw new Error("SIMULATOR_RESEARCH_REDIRECT_LIMIT");
            origins.add(new URL(control.href).origin);
          }
          await control.locator.click({ timeout: 5_000, noWaitAfter: true });
        }
      }
      await publish(join(channel, `response-${sequence}.json`), await snapshot());
    }
    await assertLive();
    const html = await page.content();
    const result = resultFromSimulatorResearchBody(requestedUrl, page.url(), status, "text/html", Buffer.from(html), new Date());
    return { ...result, method: "BROWSER", accessControlsObserved: true, accessControls: detectSimulatorResearchAccessControls(html),
      renderComplete: blocked === 0, ...(blocked ? { renderWarning: "SECONDARY_REQUESTS_BLOCKED" as const } : {}),
      contentProvenance: "RENDERED_DOM", admittedRequests: requests, blockedRequests: blocked, responseContracts: contracts };
  } finally {
    await context.close().catch(() => {});
    await Promise.allSettled([...active]);
    await browser.close();
  }
}
