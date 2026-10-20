import { createHash } from "node:crypto";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { isSafeRecipeUrl } from "./recipe";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import { ameliaMetadataSchema, parseAmeliaBookingPage, parseAmeliaPublicClient, verifyAmeliaOfficialPage,
  verifyAmeliaClients, parseAmeliaEntities, type AmeliaIdentitySource, type AmeliaMetadata } from "./amelia-source";

type Target = { courseId: string; offeringId: string };
type Rental = { id: number; durationSeconds: number; timeBeforeSeconds: number; timeAfterSeconds: number;
  minCapacity: number; maxCapacity: number; providerIds: number[]; bringingAnyone?: boolean };
type Source = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
type Deps = { fetch?: typeof fetch; now?: () => Date; deadlineAt?: Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
export type AmeliaCalendarRange = { startDateTime: string; endDateTime: string; queryTimeZone: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function dateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("ADAPTER_RANGE_UNVERIFIED");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("ADAPTER_RANGE_UNVERIFIED");
  return parsed;
}

/** Mirrors the observed Sunday-start, six-week FullCalendar month view. The
 * requested local date must be interior; range-edge inclusivity is not assumed. */
export function ameliaCalendarRange(date: string, timeZone: string): AmeliaCalendarRange {
  const requested = dateOnly(date);
  try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { throw new Error("ADAPTER_RANGE_UNVERIFIED"); }
  const grid = (month: Date) => {
    const start = new Date(month); start.setUTCDate(1); start.setUTCDate(1 - start.getUTCDay());
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 42);
    return { startDateTime: start.toISOString().slice(0, 10), endDateTime: end.toISOString().slice(0, 10), queryTimeZone: timeZone };
  };
  let range = grid(requested);
  if (date === range.startDateTime) { const previous = new Date(requested); previous.setUTCDate(1); previous.setUTCMonth(previous.getUTCMonth() - 1); range = grid(previous); }
  if (!(range.startDateTime < date && date < range.endDateTime)) throw new Error("ADAPTER_RANGE_UNVERIFIED");
  return range;
}
function localParts(value: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

/** The pinned public client reads these keys as UTC before local conversion.
 * Only affirmative resource entries are used; occupied/schedule data is ignored.
 * Range is the exact explicit query contract, never response min/max/last key. */
export function normalizeAmeliaAvailability(value: unknown, service: Rental, target: Target, input: AccessExecutionInput,
  range: AmeliaCalendarRange, bookingUrl: string): AccessExecutionResult["slots"] {
  const expected = ameliaCalendarRange(input.date, input.timeZone);
  if (!range || ["startDateTime", "endDateTime", "queryTimeZone"].some(key => range[key as keyof AmeliaCalendarRange] !== expected[key as keyof AmeliaCalendarRange]))
    throw new Error("ADAPTER_RANGE_UNVERIFIED");
  if (!Number.isSafeInteger(input.durationMinutes) || !input.durationMinutes || input.durationMinutes < 15 || input.durationMinutes > 480 ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.startTime) || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/u.test(input.endTime) || input.startTime >= input.endTime ||
      input.durationMinutes * 60 !== service.durationSeconds ||
      !Number.isSafeInteger(input.players) || input.players < service.minCapacity || input.players > service.maxCapacity)
    throw new Error("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
  if (!object(value) || value.message !== "Successfully retrieved free slots" || !object(value.data) || !object(value.data.slots)) throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
  const map = value.data.slots, days = Object.entries(map), results: AccessExecutionResult["slots"] = [], seen = new Set<string>();
  if (days.length > 62) throw new Error("ADAPTER_RESPONSE_LIMIT");
  const providers = new Set(service.providerIds);
  if (!providers.size || providers.size !== service.providerIds.length) throw new Error("ADAPTER_CONFIGURATION_UNVERIFIED");
  const nextDate = requestedNextDate(input.date).slice(0, 10);
  let clocks = 0, entries = 0;
  for (const [date, times] of days) {
    dateOnly(date);
    if (!object(times)) throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
    for (const [time, resources] of Object.entries(times)) {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time) || !Array.isArray(resources) || !resources.length || resources.length > 40)
        throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
      if (++clocks > 5000 || (entries += resources.length) > 20_000) throw new Error("ADAPTER_RESPONSE_LIMIT");
      const startsAt = new Date(`${date}T${time}:00Z`), endsAt = new Date(startsAt.getTime() + service.durationSeconds * 1000);
      const localStart = localParts(startsAt, input.timeZone), localEnd = localParts(endsAt, input.timeZone);
      if (localStart.date < range.startDateTime || localStart.date >= range.endDateTime) throw new Error("ADAPTER_RANGE_UNVERIFIED");
      for (const resource of resources) {
        if (!object(resource) || Object.keys(resource).some(key => !["e", "l", "p"].includes(key)) ||
            !Number.isSafeInteger(resource.e) || !providers.has(resource.e as number) || resource.l !== null || resource.p !== null)
          throw new Error("ADAPTER_RESOURCE_MISMATCH");
        const resourceId = `amelia-provider:${resource.e}`, productId = `amelia-service:${service.id}`;
        const sourceId = createHash("sha256").update([target.courseId, target.offeringId, resourceId, productId, startsAt.toISOString(), endsAt.toISOString()].join("\n")).digest("hex");
        if (seen.has(sourceId)) throw new Error("ADAPTER_DUPLICATE_SLOT"); seen.add(sourceId);
        if (localStart.date !== input.date || localStart.time < `${input.startTime}:00`) continue;
        const withinEnd = localEnd.date === input.date && localEnd.time <= `${input.endTime}:00` ||
          input.endTime === "24:00" && localEnd.date === nextDate && localEnd.time === "00:00:00";
        if (!withinEnd) continue;
        results.push({ sourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), availableSpots: 1,
          capacity: service.maxCapacity, resourceId, productId, bookingUrl });
        if (results.length > 500) throw new Error("ADAPTER_RESPONSE_LIMIT");
      }
    }
  }
  return results.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.resourceId!.localeCompare(b.resourceId!));
}
function requestedNextDate(date: string) { const next = dateOnly(date); next.setUTCDate(next.getUTCDate() + 1); return next.toISOString(); }

function createReader(source: Source, deps: Deps) {
  if (!source.venueAddress || !isSafeRecipeUrl(source.officialUrl) || !isSafeRecipeUrl(source.bookingUrl) ||
      new URL(source.officialUrl).origin !== new URL(source.bookingUrl).origin) throw new Error("ADAPTER_IDENTITY_MISSING");
  const identitySource: AmeliaIdentitySource = { ...source, venueAddress: source.venueAddress };
  const remaining = Math.min(90_000, (deps.deadlineAt?.getTime() ?? Date.now() + 90_000) - Date.now());
  if (!(remaining > 0)) throw new Error("DEADLINE_EXCEEDED");
  const cancellation = new AbortController(), signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(remaining)]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const allowed = new Set([source.officialUrl, source.bookingUrl]);
  let requests = 0, bytes = 0;
  const allow = (url: string) => { if (!isSafeRecipeUrl(url) || new URL(url).origin !== new URL(source.officialUrl).origin) throw new Error("UNSCOPED_ADAPTER_REQUEST"); allowed.add(url); };
  const read = async (url: string, kind: "html" | "script" | "json") => {
    if (!allowed.has(url) || ++requests > 64) throw new Error("ADAPTER_REQUEST_LIMIT");
    const parseUrl = (value: string) => {
      if (value !== url || !allowed.has(value) || !isSafeRecipeUrl(value)) throw new Error("UNSCOPED_ADAPTER_REQUEST");
      return new URL(value);
    };
    const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl, maxResponseBytes: 2_000_000, timeoutMs: 15_000, redirectLimit: 0 });
    return queue.run(requestFamilyForUrl(url), async () => {
      signal.throwIfAborted();
      const response = await transport(url, { method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", signal,
        headers: { accept: kind === "json" ? "application/json" : kind === "script" ? "application/javascript, text/javascript" : "text/html",
          "user-agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)" } });
      if (response.status === 429) throw new Error("PROVIDER_THROTTLED");
      if (response.status !== 200 || response.redirected || response.url && response.url !== parseUrl(url).href) throw new Error("ADAPTER_TRANSPORT_FAILED");
      const contentType = response.headers.get("content-type") ?? "";
      if (!(kind === "json" ? /^application\/json(?:;|$)/iu : kind === "script" ? /^(?:application|text)\/(?:x-)?javascript(?:;|$)/iu : /^text\/html(?:;|$)/iu).test(contentType))
        throw new Error("ADAPTER_RESPONSE_INVALID");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (!Number.isFinite(declared) || declared < 0 || declared > 2_000_000) throw new Error("ADAPTER_RESPONSE_LIMIT");
      const buffer = await response.arrayBuffer(); bytes += buffer.byteLength;
      if (buffer.byteLength > 2_000_000 || bytes > 16_000_000) throw new Error("ADAPTER_RESPONSE_LIMIT");
      return Buffer.from(buffer).toString("utf8");
    });
  };
  const json = async (url: string) => { try { return JSON.parse(await read(url, "json")) as unknown; } catch (error) {
    if (error instanceof SyntaxError) throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED"); throw error;
  } };
  const configuration = async () => {
    const official = await read(source.officialUrl, "html"); verifyAmeliaOfficialPage(identitySource, official);
    const booking = source.bookingUrl === source.officialUrl ? official : await read(source.bookingUrl, "html");
    const page = parseAmeliaBookingPage(booking, source.bookingUrl, identitySource);
    allow(page.publicClientUrl);
    const witness = parseAmeliaPublicClient(await read(page.publicClientUrl, "script"), page.publicClientUrl);
    allow(witness.stepClientUrl); allow(witness.eventClientUrl);
    const verified = verifyAmeliaClients(page, witness, { step: await read(witness.stepClientUrl, "script"), event: await read(witness.eventClientUrl, "script") });
    const url = new URL(page.apiUrl);
    for (const [key, value] of Object.entries({ action: "wpamelia_api", call: "/entities",
      types: "employees,categories,locations,packages,entitiesRelations,customFields,taxes", page: "booking", lite: "true" })) url.searchParams.set(key, value);
    allow(url.href);
    return parseAmeliaEntities(await json(url.href), { ...page, ...verified });
  };
  return { configuration, json, allow, close: () => { cancellation.abort(); queue.dispose(); } };
}

export async function inspectAmelia(source: Source, deps: Deps): Promise<AmeliaMetadata> {
  const reader = createReader(source, deps);
  try { return await reader.configuration(); } finally { reader.close(); }
}

export async function executeAmelia(source: Source, metadata: AmeliaMetadata, target: Target, input: AccessExecutionInput, deps: Deps): Promise<AccessExecutionResult["slots"]> {
  const reader = createReader(source, deps);
  try {
    const saved = ameliaMetadataSchema.parse(metadata), current = await reader.configuration();
    if (JSON.stringify(current) !== JSON.stringify(saved) || input.timeZone !== current.timeZone || input.timeZone !== source.timeZone)
      throw new Error("ADAPTER_CONFIGURATION_CHANGED");
    const range = ameliaCalendarRange(input.date, input.timeZone);
    const partyEligible = saved.services.filter(service => input.players >= service.minCapacity && input.players <= service.maxCapacity &&
      (input.players === 1 || service.bringingAnyone));
    // Optional duration extras can make a shorter base rental another eligible
    // product. Base-only execution must not silently omit it while reporting
    // complete inventory from a different matching base-duration product.
    if (partyEligible.some(service => service.durationSeconds < input.durationMinutes! * 60 && service.hasDurationExtras))
      throw new Error("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
    const services = partyEligible.filter(service => service.durationSeconds === input.durationMinutes! * 60);
    if (!services.length) throw new Error("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
    if (services.reduce((count, service) => count + service.providerIds.length, 0) + 6 > 64) throw new Error("ADAPTER_REQUEST_LIMIT");
    const results: AccessExecutionResult["slots"] = [], seen = new Set<string>();
    // Each public provider is read explicitly. This uses the observed single-ID
    // query template and proves all eligible resources without an assumed CSV
    // serialization or silent fallback to the first provider.
    for (const service of services) for (const providerId of service.providerIds) {
      const url = new URL(saved.apiUrl);
      for (const [key, value] of Object.entries({ action: "wpamelia_api", call: "/slots", startDateTime: range.startDateTime, endDateTime: range.endDateTime,
        queryTimeZone: input.timeZone, monthsLoad: "1", serviceId: String(service.id), serviceDuration: String(service.durationSeconds),
        providerIds: String(providerId), group: "1", page: "booking", structured: "true", persons: String(input.players) })) url.searchParams.set(key, value);
      reader.allow(url.href);
      const slots = normalizeAmeliaAvailability(await reader.json(url.href), { ...service, providerIds: [providerId] }, target, input, range, source.bookingUrl);
      for (const slot of slots) {
        if (seen.has(slot.sourceId)) throw new Error("ADAPTER_DUPLICATE_SLOT"); seen.add(slot.sourceId); results.push(slot);
        if (results.length > 500) throw new Error("ADAPTER_RESPONSE_LIMIT");
      }
    }
    return results.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.resourceId!.localeCompare(b.resourceId!) || a.productId!.localeCompare(b.productId!));
  } finally { reader.close(); }
}
