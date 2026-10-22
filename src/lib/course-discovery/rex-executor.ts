import { createHash } from "node:crypto";
import { parseDateTime } from "@internationalized/date";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { isRexPublicReadPost } from "@/lib/automation/rex-public-read-policy";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { parseRexAvailability, parseRexConfiguration, rexFailure, rexLocalDate, rexMetadataSchema, selectRexVenue,
  validateRexIdentity, type RexConfiguration, type RexMetadata, type RexSource } from "./rex-source";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";

export type RexDependencies = { fetch?: typeof fetch; now?: () => Date; deadlineAt?: Date; signal?: AbortSignal;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
type Target = { courseId: string; offeringId: string };
const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
function localParts(instant: Date, timeZone: string) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant).map(part => [part.type, part.value]));
  return { date: `${fields.year}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}` };
}
function validateInput(source: RexSource, input: AccessExecutionInput) {
  validateRexIdentity(source);
  if (!rexLocalDate(input.date) || input.timeZone !== source.timeZone || !Number.isInteger(input.players) || input.players < 1 || input.players > 20 ||
      !Number.isInteger(input.durationMinutes) || input.durationMinutes! < 30 || input.durationMinutes! > 480 || input.durationMinutes! % 30 !== 0 ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.startTime) || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/u.test(input.endTime) || input.startTime >= input.endTime)
    rexFailure("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
}
function validatePartyAndDuration(configuration: RexConfiguration, input: AccessExecutionInput) {
  if (input.players < configuration.selected.minGuests || input.players > configuration.selected.maxGuests ||
      !configuration.durationUnits.includes(input.durationMinutes! / 30)) rexFailure("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
}

/** Reviewed app-UmUWLyNF.js (SHA6a9da5...9504c6), As708551 and gA1070331:
 * numeric starts count 30-minute units since local midnight (zero shifting only).
 * Request duration is provider units; the completed package read returns starts
 * for that whole rental. Never infer capacity from lanes, price or slot count. */
export function normalizeRexAvailability(value: unknown, configuration: RexConfiguration, source: RexSource, target: Target,
  input: AccessExecutionInput, now: Date): AccessExecutionResult["slots"] {
  validateInput(source, input); validatePartyAndDuration(configuration, input);
  if (!target.courseId || !target.offeringId) rexFailure("ADAPTER_TARGET_MISMATCH");
  const rows = parseRexAvailability(value, configuration, source), results: AccessExecutionResult["slots"] = [];
  const resourceId = `rex-bay:${createHash("sha256").update([configuration.metadata.tenant, configuration.metadata.venueId,
    configuration.metadata.packageId].join("\n")).digest("hex")}`;
  for (const row of rows) {
    // The public client uses !!isDisabled; omission means false. Validate all
    // rows first, including sold-out and age-restricted rows, before exclusion.
    if (row.isDisabled === true || row.is21plus === true) continue;
    const startMinute = row.time * 30, endMinute = startMinute + input.durationMinutes!;
    if (endMinute > 1440) rexFailure("REX_SLOT_INVALID");
    const startClock = `${String(Math.floor(startMinute / 60)).padStart(2, "0")}:${String(startMinute % 60).padStart(2, "0")}`;
    let start: Date;
    try { start = parseDateTime(`${input.date}T${startClock}`).toDate(input.timeZone, "reject"); }
    catch { rexFailure("AMBIGUOUS_OR_INVALID_LOCAL_TIME"); }
    const end = new Date(start.getTime() + input.durationMinutes! * 60_000), endLocal = localParts(end, input.timeZone);
    const tomorrow = new Date(`${input.date}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const endClock = `${String(Math.floor(endMinute / 60) % 24).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`;
    if (localParts(start, input.timeZone).date !== input.date || localParts(start, input.timeZone).time !== startClock ||
        endLocal.date !== (endMinute === 1440 ? tomorrow.toISOString().slice(0, 10) : input.date) || endLocal.time !== endClock)
      rexFailure("AMBIGUOUS_OR_INVALID_LOCAL_TIME");
    if (start <= now || startMinute < minute(input.startTime) || endMinute > minute(input.endTime)) continue;
    const sourceId = createHash("sha256").update([resourceId, input.date, row.time].join("\n")).digest("hex");
    results.push({ sourceId, startsAt: start.toISOString(), endsAt: end.toISOString(), availableSpots: 1,
      capacity: configuration.selected.maxGuests, resourceId, productId: `rex-package:${configuration.metadata.packageId}`, bookingUrl: source.bookingUrl });
  }
  return results.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function createReader(source: RexSource, deps: RexDependencies) {
  const context = validateRexIdentity(source), realNow = Date.now(), remaining = Math.min(60_000, (deps.deadlineAt?.getTime() ?? realNow + 60_000) - realNow);
  if (!(remaining > 0)) rexFailure("DEADLINE_EXCEEDED");
  const cancellation = new AbortController(), signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(remaining), ...(deps.signal ? [deps.signal] : [])]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const paths = ["/api/venue", "/api/venue/get", "/api/venue/get-venue-with-package"];
  const parseUrl = (value: string) => {
    const parsed = new URL(value);
    if (parsed.origin !== context.origin || parsed.username || parsed.password || parsed.port || parsed.hash || parsed.search ||
        !paths.includes(parsed.pathname) || parsed.href !== value) rexFailure("UNSCOPED_ADAPTER_REQUEST");
    return parsed;
  };
  const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl, maxResponseBytes: 2_000_000, timeoutMs: 15_000,
    redirectLimit: 0, authorizeReadPost: isRexPublicReadPost });
  let count = 0, bytes = 0;
  const read = async (path: typeof paths[number], body?: Record<string, unknown>) => {
    if (++count > 3 || !paths.includes(path) || (path === "/api/venue") !== (body === undefined)) rexFailure("ADAPTER_REQUEST_LIMIT");
    const url = `${context.origin}${path}`, method = body ? "POST" : "GET", headers = new Headers({ accept: "application/json" });
    const payload = body ? JSON.stringify(body) : undefined;
    if (body) { headers.set("origin", context.origin); headers.set("content-type", "application/json"); }
    if (payload && !isRexPublicReadPost(parseUrl(url), headers, payload)) rexFailure("UNSCOPED_ADAPTER_REQUEST");
    return queue.run(new URL(context.origin).hostname, async () => {
      signal.throwIfAborted();
      const response = await transport(url, { method, headers, ...(payload ? { body: payload } : {}), signal, credentials: "omit", redirect: "manual", cache: "no-store" });
      try {
        if (response.status === 429) rexFailure("PROVIDER_THROTTLED");
        if (response.status === 401 || response.status === 403) rexFailure("ACCESS_REQUIRED");
        if (response.status !== 200 || response.redirected || response.url && response.url !== url) rexFailure("ADAPTER_TRANSPORT_FAILED");
        if (response.headers.has("content-range")) rexFailure("REX_RESPONSE_INCOMPLETE");
        if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) rexFailure("ADAPTER_RESPONSE_INVALID");
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (!Number.isFinite(declared) || declared < 0 || declared > 2_000_000) rexFailure("ADAPTER_RESPONSE_LIMIT");
        const reader = response.body?.getReader(); if (!reader) rexFailure("ADAPTER_RESPONSE_INVALID");
        const chunks: Uint8Array[] = []; let length = 0;
        try {
          for (;;) {
            signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
            length += part.value.byteLength; bytes += part.value.byteLength;
            if (length > 2_000_000 || bytes > 6_000_000) rexFailure("ADAPTER_RESPONSE_LIMIT"); chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        signal.throwIfAborted();
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { rexFailure("ADAPTER_RESPONSE_INVALID"); }
      } finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined); }
    });
  };
  const configuration = async (date: string, players: number, units: number) => {
    const directory = await read("/api/venue"), venue = selectRexVenue(directory, source);
    const catalog = await read("/api/venue/get", { venueId: venue.id, date, guests: players, duration: units, lanes: 1, packagesTag: "" });
    return { configuration: parseRexConfiguration(directory, catalog, source), directory };
  };
  return { configuration, availability: (configuration: RexConfiguration, input: AccessExecutionInput) => read("/api/venue/get-venue-with-package", {
    venueId: configuration.metadata.venueId, packageId: configuration.metadata.packageId, date: input.date, guests: input.players,
    duration: input.durationMinutes! / 30, lanes: 1, packagesTag: "", resourceIds: [], guestsWithAgeGroups: [], singlePackage: false,
  }), close: () => { cancellation.abort(); queue.dispose(); } };
}

export async function inspectRex(source: RexSource, deps: RexDependencies): Promise<RexMetadata> {
  const reader = createReader(source, deps);
  try { return (await reader.configuration(localParts((deps.now ?? (() => new Date()))(), source.timeZone).date, 1, 2)).configuration.metadata; }
  finally { reader.close(); }
}
export async function executeRex(source: RexSource, saved: RexMetadata, target: Target, input: AccessExecutionInput,
  deps: RexDependencies): Promise<AccessExecutionResult["slots"]> {
  validateInput(source, input);
  if (!target.courseId || !target.offeringId) rexFailure("ADAPTER_TARGET_MISMATCH");
  const metadata = rexMetadataSchema.parse(saved), reader = createReader(source, deps);
  try {
    // Configuration requests one baseline bay. Actual party/duration are sent
    // only after the independently fresh public rental bounds are validated.
    const { configuration } = await reader.configuration(input.date, 1, 2);
    if (JSON.stringify(metadata) !== JSON.stringify(configuration.metadata)) rexFailure("ADAPTER_CONFIGURATION_CHANGED");
    validatePartyAndDuration(configuration, input);
    return normalizeRexAvailability(await reader.availability(configuration, input), configuration, source, target, input, (deps.now ?? (() => new Date()))());
  } finally { reader.close(); }
}
