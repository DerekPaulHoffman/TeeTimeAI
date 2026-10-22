import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { getTimeZoneOffsetMinutes } from "@/lib/timezones";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";
import { isActiveBrowserAccessChallenge } from "./recipe";
import { teeItUpInertDocumentContent } from "./teeitup-official-booking-source";
import { requestFamilyForUrl } from "./request-family";
import { CPS_API_PATH, cpsFailure as fail, cpsMetadataSchema, inspectCpsOfficialDocument, parseCpsCatalog, parseCpsConfiguration,
  parseCpsOptions, parseCpsSource, sameCpsOfficialSite, validateCpsIdentity, type CpsConfiguration, type CpsMetadata, type CpsOptions, type CpsSource } from "./cps-source";

export type CpsDependencies = { fetch?: typeof fetch; now?: () => Date; deadlineAt?: Date; signal?: AbortSignal;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
const MAX_RESPONSE_BYTES = 2_000_000, MAX_TOTAL_BYTES = 13_000_000;
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const time = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
function validateInput(input: AccessExecutionInput, source: CpsSource) {
  if (!dateOnly.safeParse(input.date).success || input.timeZone !== source.timeZone || input.durationMinutes !== undefined ||
      !Number.isInteger(input.players) || input.players < 1 || input.players > 4 ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.startTime) || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/u.test(input.endTime) ||
      input.startTime >= input.endTime) fail("ADAPTER_TARGET_MISMATCH");
}
function localParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
/** Reject ambiguous and nonexistent local timestamps rather than choosing a DST side. */
export function cpsLocalInstant(value: string, timeZone: string): Date {
  const canonical = value.replace(" ", "T"), seconds = canonical.slice(0, 19).padEnd(19, ":00");
  const naive = Date.parse(`${seconds}Z`);
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 19) !== seconds) fail("CPS_SLOT_DATE_INVALID");
  const offsets = new Set([-36, 0, 36].map(hours => getTimeZoneOffsetMinutes(new Date(naive + hours * 3_600_000), timeZone)));
  const matches = [...offsets].map(offset => new Date(naive - offset * 60_000)).filter(instant => localParts(instant, timeZone) === seconds);
  if (matches.length !== 1) fail("CPS_SLOT_DATE_INVALID");
  const fraction = /\.(\d{1,7})$/u.exec(canonical)?.[1] ?? "";
  return new Date(matches[0].getTime() + Number(fraction.slice(0, 3).padEnd(3, "0")));
}
export function cpsAvailabilityQuery(date: string, courseIds: number[], transactionId: string) {
  if (!dateOnly.safeParse(date).success || !uuid(transactionId)) fail("CPS_REQUEST_INVALID");
  const day = new Date(`${date}T00:00:00Z`), weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return new URLSearchParams({ searchDate: `${weekdays[day.getUTCDay()]} ${months[day.getUTCMonth()]} ${String(day.getUTCDate()).padStart(2, "0")} ${day.getUTCFullYear()}`,
    holes: "0", numberOfPlayer: "0", courseIds: courseIds.join(","), searchTimeType: "0", transactionId,
    teeOffTimeMin: "0", teeOffTimeMax: "23", isChangeTeeOffTime: "true", teeSheetSearchView: "5", classCode: "R",
    defaultOnlineRate: "N", isUseCapacityPricing: "false", memberStoreId: "1", searchType: "1" });
}
function publicHeaders(source: CpsSource, configuration: CpsConfiguration, options: CpsOptions | undefined, date: string) {
  const noon = cpsLocalInstant(`${date}T12:00:00`, source.timeZone);
  return new Headers({ accept: "application/json, text/plain, */*", "x-apikey": configuration.apiKey, "client-id": configuration.clientId,
    "x-websiteid": options?.webSiteId ?? configuration.websiteId, "x-terminalid": String(options?.reservationOptions.terminalId ?? 1),
    "x-timezoneid": source.timeZone, "x-timezone-offset": String(Math.abs(getTimeZoneOffsetMinutes(noon, source.timeZone))),
    "x-siteid": "1", "x-moduleid": "7", "x-productid": "1", "x-componentid": "1", "x-ismobile": "false",
    referer: parseCpsSource(source.bookingUrl)!.origin + "/", "x-requestid": randomUUID() });
}
/** Exact current, freshly configured browsing context; no general POST grant.
 * The transport inserts only accept-encoding:identity before this callback. */
export function cpsBootstrapReadAllowed(url: URL, headers: Headers, body: string,
  expected: { url: string; headers: Headers; transactionId: string }): boolean {
  if (url.href !== expected.url || !uuid(expected.transactionId) || body !== JSON.stringify({ transactionId: expected.transactionId })) return false;
  const supplied = new Headers(headers);
  if (supplied.get("accept-encoding") !== "identity") return false;
  supplied.delete("accept-encoding");
  return JSON.stringify([...supplied].sort()) === JSON.stringify([...expected.headers].sort());
}
function createReader(source: CpsSource, deps: CpsDependencies, date: string) {
  validateCpsIdentity(source);
  const context = parseCpsSource(source.bookingUrl)!, deadline = Math.min(Date.now() + 120_000, deps.deadlineAt?.getTime() ?? Infinity);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) fail("DEADLINE_EXCEEDED");
  const cancellation = new AbortController(), signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(deadline - Date.now()), ...(deps.signal ? [deps.signal] : [])]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  let requests = 0, bytes = 0, officialReads = 0, apiReads = 0;
  const read = async (url: string, headers: Headers, kind: "html" | "json", post?: { transactionId: string }): Promise<{ status: number; headers: Headers; text: string }> => {
    if (++requests > 10 || kind === "html" && ++officialReads > 5 || kind === "json" && ++apiReads > 5) fail("ADAPTER_REQUEST_LIMIT");
    if (kind === "html" ? !sameCpsOfficialSite(url, source.officialUrl) : new URL(url).origin !== context.origin) fail("UNSCOPED_ADAPTER_REQUEST");
    const body = post ? JSON.stringify({ transactionId: post.transactionId }) : undefined, method = post ? "POST" : "GET";
    if (post) {
      if (url !== context.origin + CPS_API_PATH + "/RegisterTransactionId") fail("UNSCOPED_ADAPTER_REQUEST");
      headers.set("content-type", "application/json");
    }
    const limit = kind === "html" ? 600_000 : MAX_RESPONSE_BYTES;
    const policy = { parseUrl: (value: string) => { if (value !== url) fail("UNSCOPED_ADAPTER_REQUEST"); return new URL(value); },
      maxResponseBytes: limit, timeoutMs: 15_000, redirectLimit: 0,
      ...(post ? { authorizeReadPost: (value: URL, actualHeaders: Headers, actualBody: string) =>
        cpsBootstrapReadAllowed(value, actualHeaders, actualBody, { url, headers, transactionId: post.transactionId }) } : {}) };
    const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport(policy);
    return queue.run(requestFamilyForUrl(url), async () => {
      signal.throwIfAborted(); if (Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
      const response = await transport(url, { method, headers, ...(body ? { body } : {}), credentials: "omit", redirect: "manual", cache: "no-store", signal });
      try {
        if (response.redirected || response.url && response.url !== url) fail("ADAPTER_TRANSPORT_FAILED");
        if ([401, 403].includes(response.status)) fail("ACCESS_REQUIRED");
        if (response.status === 429) fail("PROVIDER_THROTTLED");
        if (kind === "html" && [301, 302, 303, 307, 308].includes(response.status)) return { status: response.status, headers: response.headers, text: "" };
        if (response.status !== 200) fail("ADAPTER_TRANSPORT_FAILED");
        if (!(kind === "html" ? /^text\/html(?:;|$)/iu : /^application\/json(?:;|$)/iu).test(response.headers.get("content-type") ?? "")) fail("ADAPTER_RESPONSE_INVALID");
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (!Number.isFinite(declared) || declared < 0 || declared > limit) fail("ADAPTER_RESPONSE_LIMIT");
        const buffer = await response.arrayBuffer(); bytes += buffer.byteLength;
        if (buffer.byteLength > limit || bytes > MAX_TOTAL_BYTES) fail("ADAPTER_RESPONSE_LIMIT");
        signal.throwIfAborted(); if (Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
        return { status: response.status, headers: response.headers, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
      } finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}); }
    });
  };
  const official = async () => {
    let links = 0, redirects = 0; const seen = new Set<string>(), pending = [source.officialUrl];
    for (let index = 0; index < 5 && pending.length; index++) {
      const url = pending.shift()!;
      if (seen.has(url)) { index--; continue; }
      seen.add(url);
      const page = await read(url, new Headers({ accept: "text/html", "user-agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)" }), "html");
      if (page.status !== 200) {
        const location = page.headers.get("location"); if (!location || ++redirects > 2) fail("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
        const next = new URL(location, url);
        if (!sameCpsOfficialSite(next.href, source.officialUrl) || next.origin !== new URL(url).origin &&
            (index !== 0 || next.pathname !== new URL(url).pathname)) fail("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
        if (seen.has(next.href)) fail("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
        pending.unshift(next.href); continue;
      }
      const content = teeItUpInertDocumentContent(page.text);
      if (isActiveBrowserAccessChallenge(content.text, content.title)) fail("ACCESS_REQUIRED");
      const proof = inspectCpsOfficialDocument(page.text, url, source);
      if (proof.bookingLinked) return;
      const next = proof.nextUrls?.filter(value => !seen.has(value) && !pending.includes(value));
      if (!next || (links += next.length) > 2) fail("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
      pending.push(...next);
    }
    fail("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
  };
  const json = async (url: string, headers: Headers, post?: { transactionId: string }): Promise<unknown> => {
    const response = await read(url, headers, "json", post);
    try { return JSON.parse(response.text) as unknown; } catch { fail("ADAPTER_RESPONSE_INVALID"); }
  };
  const configuration = async () => {
    await official();
    const config = parseCpsConfiguration(await json(context.origin + "/onlineresweb/Home/Configuration", new Headers({
      accept: "application/json", referer: context.origin + "/", "user-agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)" })), source);
    const options = parseCpsOptions(await json(context.origin + CPS_API_PATH + "/GetAllOptions/" + context.tenant + "?" +
      new URLSearchParams({ version: config.buildNumber, product: "3" }), publicHeaders(source, config, undefined, date)), config);
    const metadata = parseCpsCatalog(await json(context.origin + CPS_API_PATH + "/OnlineCourses", publicHeaders(source, config, options, date)), options, source);
    return { config, options, metadata };
  };
  return { configuration, availability: async (fresh: Awaited<ReturnType<typeof configuration>>, input: AccessExecutionInput) => {
    const transactionId = randomUUID(), headers = publicHeaders(source, fresh.config, fresh.options, input.date);
    const registration = await json(context.origin + CPS_API_PATH + "/RegisterTransactionId", headers, { transactionId });
    if (registration !== true) fail("CPS_BROWSE_CONTEXT_UNVERIFIED");
    const value = await json(context.origin + CPS_API_PATH + "/TeeTimes?" + cpsAvailabilityQuery(input.date, fresh.metadata.courseIds, transactionId),
      publicHeaders(source, fresh.config, fresh.options, input.date));
    return normalizeCpsAvailability(value, transactionId, fresh.metadata, source, input, (deps.now ?? (() => new Date()))());
  }, close: () => { cancellation.abort(); queue.dispose(); } };
}

const participant = z.number().int().min(1).max(4);
const slotSchema = z.object({ teeSheetId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), courseId: z.number().int().min(1),
  startTime: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,7})?)?$/u),
  availableParticipantNo: z.array(participant).max(4).refine(values => new Set(values).size === values.length),
  minPlayer: participant.nullish(), holes: z.union([z.literal(9), z.literal(18)]).nullish(),
  // The public client uses zero for "no default". A concrete 9/18-hole
  // selection is still required below; zero cannot supply a round length.
  defaultHoles: z.union([z.literal(0), z.literal(9), z.literal(18)]).nullish() }).passthrough();
export function normalizeCpsAvailability(value: unknown, transactionId: string, metadata: CpsMetadata, source: CpsSource,
  input: AccessExecutionInput, now: Date): AccessExecutionResult["slots"] {
  validateInput(input, source);
  const response = z.object({ isSuccess: z.literal(true), transactionId: z.literal(transactionId), content: z.array(slotSchema).max(500) }).strict().safeParse(value);
  if (!uuid(transactionId) || !response.success) fail("CPS_AVAILABILITY_INCOMPLETE");
  const ids = new Set<number>();
  // Validate every row, including excluded times/party options, before filtering.
  const rows = response.data.content.map(row => {
    if (ids.has(row.teeSheetId) || !metadata.courseIds.includes(row.courseId) || row.startTime.slice(0, 10) !== input.date)
      fail("CPS_AVAILABILITY_INCOMPLETE");
    const holes = row.holes ?? row.defaultHoles;
    if (holes !== 9 && holes !== 18) fail("CPS_AVAILABILITY_INCOMPLETE");
    ids.add(row.teeSheetId); return { row, holes, instant: cpsLocalInstant(row.startTime, input.timeZone) };
  });
  return rows.filter(({ row, instant }) => row.availableParticipantNo.includes(input.players) && (row.minPlayer ?? 1) <= input.players &&
    row.startTime.slice(11, 16) >= input.startTime && row.startTime.slice(11, 16) < input.endTime && instant > now)
    .map(({ row, holes, instant }) => ({ sourceId: `cps-${metadata.tenant}-${row.teeSheetId}`, startsAt: instant.toISOString(),
      availableSpots: Math.max(...row.availableParticipantNo), bookingUrl: source.bookingUrl, resourceId: `cps-course:${row.courseId}`,
      // This is a sold round choice, never physical Course.layoutHoleCounts.
      holes })).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.sourceId.localeCompare(b.sourceId));
}
export async function inspectCps(source: CpsSource, deps: CpsDependencies = {}): Promise<CpsMetadata> {
  const date = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10), reader = createReader(source, deps, date);
  try { return (await reader.configuration()).metadata; } finally { reader.close(); }
}
export async function executeCps(source: CpsSource, metadata: CpsMetadata, _target: { courseId: string }, input: AccessExecutionInput,
  deps: CpsDependencies = {}): Promise<AccessExecutionResult["slots"]> {
  validateInput(input, source); const saved = cpsMetadataSchema.parse(metadata);
  if (saved.tenant !== parseCpsSource(source.bookingUrl)?.tenant) fail("ADAPTER_SOURCE_MISMATCH");
  const reader = createReader(source, deps, input.date);
  try {
    const fresh = await reader.configuration();
    if (JSON.stringify(fresh.metadata) !== JSON.stringify(saved)) fail("ADAPTER_CONFIGURATION_CHANGED");
    return await reader.availability(fresh, input);
  } finally { reader.close(); }
}
