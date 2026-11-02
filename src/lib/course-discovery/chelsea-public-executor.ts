import { request as httpsRequest } from "node:https";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { accessExecutionInputSchema, isSafeRecipeUrl, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import { chelseaPublicAvailability, chelseaPublicMetadata, chelseaPublicMetadataSchema, parseChelseaPublicSource,
  readChelseaPublicForm, type ChelseaPublicForm, type ChelseaPublicMetadata } from "./chelsea-public-source";

type Source = { officialUrl?: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
export type ChelseaPublicDependencies = { fetch?: typeof fetch; deadlineAt?: Date;
  venueMatches: (expected: string, actual: unknown) => boolean;
  toInstant: (value: unknown, input: AccessExecutionInput) => Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };

function createReader(source: Source, deps: Pick<ChelseaPublicDependencies, "fetch" | "deadlineAt" | "requestLease">) {
  const context = parseChelseaPublicSource(source.bookingUrl);
  if (!context || !source.officialUrl || !isSafeRecipeUrl(source.officialUrl) || !source.venueAddress) throw Error("INVALID_ADAPTER_SOURCE");
  const cancellation = new AbortController(), remaining = Math.min(90000, (deps.deadlineAt?.getTime() ?? Date.now() + 90000) - Date.now());
  if (remaining <= 0) throw Error("DEADLINE_EXCEEDED");
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(remaining)]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const bootstrap = context.origin + "/logingp.aspx";
  let cookie: string | undefined, expectedPost: string | undefined, count = 0, bytes = 0;
  const allowsPost = (url: URL, headers: Headers, body: string) => Boolean(cookie && expectedPost && body === expectedPost &&
    url.href === context.url && headers.get("content-type") === "application/x-www-form-urlencoded" &&
    headers.get("origin") === context.origin && headers.get("referer") === context.url);
  // The session value can only come from this execution's anonymous public
  // GETs. It stays in memory below the general credential-free/DNS/TLS guard.
  const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({
    parseUrl: value => { if (![context.url, bootstrap].includes(value)) throw Error("UNSCOPED_ADAPTER_REQUEST"); return new URL(value); },
    maxResponseBytes: 2000000, timeoutMs: 12000, redirectLimit: 0, authorizeReadPost: allowsPost,
  }, { requestNode: (url, options, callback) => httpsRequest(url, { ...options,
    headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } }, callback) });
  const read = async (url: string, body?: string) => {
    const method = body === undefined ? "GET" : "POST", headers = new Headers({ accept: "text/html" });
    if (![context.url, bootstrap].includes(url) || ++count > 12 || method === "POST" && url !== context.url)
      throw Error("UNSCOPED_ADAPTER_REQUEST");
    if (body !== undefined) {
      headers.set("content-type", "application/x-www-form-urlencoded"); headers.set("origin", context.origin); headers.set("referer", context.url);
      if (!allowsPost(new URL(url), headers, body)) throw Error("UNSAFE_ADAPTER_REQUEST");
    }
    return queue.run(requestFamilyForUrl(url), async () => {
      signal.throwIfAborted();
      const response = await transport(url, { method, headers, ...(body === undefined ? {} : { body }), signal,
        credentials: "omit", redirect: "manual", cache: "no-store" });
      try {
        if (response.status === 429) throw Error("PROVIDER_THROTTLED");
        if ([401, 403].includes(response.status)) throw Error("ACCESS_REQUIRED");
        if (response.redirected || response.url && response.url !== url || ![200, 302].includes(response.status)) throw Error("ADAPTER_TRANSPORT_FAILED");
        const cookies = response.headers.getSetCookie();
        if (cookies.length) {
          if (cookies.length !== 1 || method !== "GET" || !/^ASP\.NET_SessionId=[A-Za-z0-9]{8,100}(?:;|$)/u.test(cookies[0]))
            throw Error("ANONYMOUS_SESSION_CHANGED");
          const next = cookies[0].split(";", 1)[0];
          if (cookie && cookie !== next) throw Error("ANONYMOUS_SESSION_CHANGED");
          cookie = next;
        }
        if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) throw Error("ADAPTER_RESPONSE_INVALID");
        const buffer = await response.arrayBuffer(); bytes += buffer.byteLength;
        if (buffer.byteLength > 2000000 || bytes > 8000000) throw Error("ADAPTER_RESPONSE_LIMIT");
        return { status: response.status, location: response.headers.get("location"), html: Buffer.from(buffer).toString("utf8") };
      } finally { if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => undefined); }
    });
  };
  return {
    async open() {
      let url = context.url;
      for (let i = 0; i < 3; i++) {
        const result = await read(url);
        if (result.status === 200 && url === context.url && !result.location) return readChelseaPublicForm(result.html, context.url);
        const next = result.location && new URL(result.location, url).href;
        if (result.status !== 302 || !cookie || next !== (url === context.url ? bootstrap : context.url)) throw Error("CHELSEA_PUBLIC_BOOTSTRAP_UNVERIFIED");
        url = next;
      }
      throw Error("CHELSEA_PUBLIC_BOOTSTRAP_UNVERIFIED");
    },
    async filter(form: ChelseaPublicForm, metadata: ChelseaPublicMetadata, input: AccessExecutionInput, holes: 9 | 18, event: string) {
      // Only compiled public selectors and an actually offered DayN can create
      // a form body. Compare..., login, booking, contact and arbitrary events
      // have no entry into this private operation.
      const day = Number(input.date.slice(8, 10));
      if (!(event === `Day${day}` && form.availableDays.includes(day) || ["ddlMonth", "ddlYear"].includes(event)))
        throw Error("CHELSEA_PUBLIC_DATE_NOT_OPEN");
      const times = form.choices.ddlTime.map(o => o.value).filter(value => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)).sort();
      if (times.length !== form.choices.ddlTime.length || !times.length) throw Error("CHELSEA_PUBLIC_FORM_CHANGED");
      const values = { ddlCourse1: String(metadata.courseCode), ddlTime: times[0], ddlQuantity: String(input.players),
        ddlHoleSelection: String(holes), ddlMonth: input.date.slice(5, 7), ddlYear: input.date.slice(0, 4) };
      const body = new URLSearchParams(form.hiddenFields);
      for (const [name, value] of Object.entries(values)) {
        if (!form.choices[name]?.some(o => o.value === value)) throw Error("CHELSEA_PUBLIC_FILTER_UNVERIFIED");
        body.set(name, value);
      }
      body.set("__EVENTTARGET", event); body.set("__EVENTARGUMENT", ""); expectedPost = body.toString();
      try {
        const result = await read(context.url, expectedPost);
        if (result.status !== 200 || result.location) throw Error("CHELSEA_PUBLIC_FILTER_UNVERIFIED");
        return readChelseaPublicForm(result.html, context.url);
      } finally { expectedPost = undefined; }
    },
    close() { cookie = undefined; expectedPost = undefined; cancellation.abort(); queue.dispose(); },
  };
}

export async function inspectChelseaPublic(source: Source, deps: Pick<ChelseaPublicDependencies, "fetch" | "deadlineAt" | "requestLease" | "venueMatches">) {
  const reader = createReader(source, deps);
  try { return chelseaPublicMetadata(await reader.open(), source.venueName, deps.venueMatches); }
  finally { reader.close(); }
}
export async function executeChelseaPublic(source: Source, metadata: ChelseaPublicMetadata, rawInput: AccessExecutionInput,
  deps: ChelseaPublicDependencies): Promise<AccessExecutionResult["slots"]> {
  const input = accessExecutionInputSchema.parse(rawInput), saved = chelseaPublicMetadataSchema.parse(metadata);
  if (input.timeZone !== source.timeZone || input.durationMinutes !== undefined || input.players > 4) throw Error("ADAPTER_TARGET_MISMATCH");
  const reader = createReader(source, deps);
  try {
    let form = await reader.open();
    const verify = () => { if (JSON.stringify(chelseaPublicMetadata(form, source.venueName, deps.venueMatches)) !== JSON.stringify(saved)) throw Error("ADAPTER_CONFIGURATION_CHANGED"); };
    verify();
    const year = Number(input.date.slice(0, 4)), month = Number(input.date.slice(5, 7)), results: AccessExecutionResult["slots"] = [];
    if (form.calendarYear !== year || form.calendarMonth !== month) {
      form = await reader.filter(form, saved, input, saved.roundHoleCounts[0], form.calendarMonth !== month ? "ddlMonth" : "ddlYear"); verify();
      if (form.calendarYear !== year || form.calendarMonth !== month) throw Error("CHELSEA_PUBLIC_DATE_NOT_OPEN");
    }
    for (const holes of saved.roundHoleCounts) {
      form = await reader.filter(form, saved, input, holes, `Day${Number(input.date.slice(8, 10))}`); verify();
      const rows = chelseaPublicAvailability(form, saved, input, holes);
      results.push(...rows.map(row => ({ sourceId: row.sourceId, startsAt: deps.toInstant(row.time, input).toISOString(),
        availableSpots: row.availableSpots, holes: row.holes, bookingUrl: source.bookingUrl, resourceId: `chelsea-course:${saved.courseCode}` })));
    }
    return results.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.sourceId.localeCompare(b.sourceId));
  } finally { reader.close(); }
}
