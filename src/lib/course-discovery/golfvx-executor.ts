import { createHash } from "node:crypto";
import { parseDateTime } from "@internationalized/date";
import { z } from "zod";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";
import { GOLFVX_GUEST_ROOT, GOLFVX_ORIGIN, golfVxEnvelopeRows, golfVxMetadataSchema, golfVxRoomScopes,
  parseGolfVxConfiguration, parseGolfVxSource, validateGolfVxIdentityContext, type GolfVxMetadata, type GolfVxSource } from "./golfvx-source";

type Target = { courseId: string; offeringId: string };
type Deps = { fetch?: typeof fetch; now?: () => Date; deadlineAt?: Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
function fail(code: string): never { throw new Error(code); }
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const slotSchema = z.object({ start: clock, available: z.boolean(), max_available_minutes: z.number().int().min(0).max(1440),
  bays: z.number().int().min(0).max(100), bays_for_full: z.number().int().min(0).max(100),
  // Retained public client 8575046b...6453 at offsets 722/1038 names EARLY
  // explicitly as Morning. The captured public response marks it non-peak.
  zone: z.enum(["PEAK", "OFFPEAK", "EARLY"]), is_peak: z.boolean() }).strict();
const availabilitySchema = z.object({ slot_minutes: z.literal(15), min_booking_minutes: z.number().int().min(1).max(480),
  max_booking_minutes: z.number().int().min(1).max(1440).nullable(), max_party_size: z.number().int().min(1).max(100),
  store_timezone: z.string().min(3).max(100), store_now: z.string().datetime({ offset: true }), business_date: dateOnly,
  booking_start_date: dateOnly, booking_end_date: dateOnly, reason: z.null(), slots: z.array(slotSchema).max(96) }).strict();
function localParts(value: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
function validateInput(input: AccessExecutionInput) {
  if (!dateOnly.safeParse(input.date).success || !clock.safeParse(input.startTime).success ||
      !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/u.test(input.endTime) || input.startTime >= input.endTime ||
      !Number.isInteger(input.players) || input.players < 1 || input.players > 100 ||
      !Number.isInteger(input.durationMinutes) || input.durationMinutes! < 15 || input.durationMinutes! > 480) fail("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
}

/** Reviewed guest GET contract: client chunks 138/633/675 (2026-10-21).
 * The public client initially asks with the base product duration; a separate
 * anonymous fixed-60-minute read established bays_for_full for that duration.
 * Date is bound by the exact admitted GET, not business_date (the store's
 * current local day). The full configured operating grid must be present even
 * when every row is unavailable. A truncated/empty array is never EMPTY. */
export function normalizeGolfVxAvailability(value: unknown, metadata: GolfVxMetadata, productId: number, roomType: string,
  target: Target, input: AccessExecutionInput): AccessExecutionResult["slots"] {
  validateInput(input);
  const product = metadata.products.find(value => value.id === productId);
  if (!product || !golfVxRoomScopes(metadata).includes(roomType) || input.timeZone !== metadata.timeZone ||
      product.status !== "ACTIVE" || product.availableOnline !== 1 || input.durationMinutes! % product.durationMinutes !== 0 ||
      input.players < product.minPartySize || input.players > product.maxPartySize) fail("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
  const rows = golfVxEnvelopeRows(value), parsed = rows.length === 1 ? availabilitySchema.safeParse(rows[0]) : undefined;
  if (!parsed?.success) fail("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
  const data = parsed.data, duration = input.durationMinutes!;
  if (data.store_timezone !== input.timeZone || data.booking_start_date > data.booking_end_date ||
      input.date < data.booking_start_date || input.date > data.booking_end_date ||
      localParts(new Date(data.store_now), input.timeZone).date !== data.business_date) fail("ADAPTER_DATE_MISMATCH");
  if (duration < data.min_booking_minutes || data.max_booking_minutes !== null && duration > data.max_booking_minutes ||
      input.players > data.max_party_size) fail("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
  const day = new Date(`${input.date}T00:00:00Z`).getUTCDay(), hours = metadata.store.operatingHours[String(day) as keyof GolfVxMetadata["store"]["operatingHours"]];
  const startMinute = minutes(hours.open), closeMinute = minutes(hours.close), expectedCount = (closeMinute - startMinute) / 15;
  const sorted = [...data.slots].sort((a, b) => a.start.localeCompare(b.start));
  if (sorted.length !== expectedCount || sorted.some((value, index) => minutes(value.start) !== startMinute + index * 15)) fail("ADAPTER_AVAILABILITY_INCOMPLETE");
  const results: AccessExecutionResult["slots"] = [];
  for (const row of sorted) {
    if (row.bays_for_full > row.bays || row.is_peak !== (row.zone === "PEAK") ||
        row.max_available_minutes > closeMinute - minutes(row.start) ||
        row.available !== (row.bays_for_full > 0 && row.max_available_minutes >= duration)) fail("ADAPTER_SLOT_MISMATCH");
    if (!row.available) continue;
    let startsAt: Date;
    try { startsAt = parseDateTime(`${input.date}T${row.start}`).toDate(input.timeZone, "reject"); }
    catch { fail("ADAPTER_DATE_MISMATCH"); }
    const endsAt = new Date(startsAt.getTime() + duration * 60_000), end = localParts(endsAt, input.timeZone);
    // Crossing a DST discontinuity cannot silently change the displayed rental.
    const endMinute = minutes(row.start) + duration;
    if (endMinute > closeMinute) fail("ADAPTER_SLOT_MISMATCH");
    const next = new Date(`${input.date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const expectedEndDate = endMinute === 1440 ? next.toISOString().slice(0, 10) : input.date;
    const expectedEndTime = `${String(Math.floor(endMinute / 60) % 24).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`;
    if (localParts(startsAt, input.timeZone).time !== row.start || end.date !== expectedEndDate || end.time !== expectedEndTime) fail("ADAPTER_DATE_MISMATCH");
    if (row.start < input.startTime || endMinute > minutes(input.endTime)) continue;
    const resourceId = `golfvx-room:${metadata.storeId}:${roomType}`, productKey = `golfvx-product:${productId}`;
    const sourceId = createHash("sha256").update([target.courseId, target.offeringId, resourceId, productKey,
      startsAt.toISOString(), endsAt.toISOString()].join("\n")).digest("hex");
    results.push({ sourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), availableSpots: 1,
      capacity: Math.min(product.maxPartySize, data.max_party_size), resourceId, productId: productKey, bookingUrl: metadata.bookingUrl });
  }
  return results;
}

function createReader(source: GolfVxSource, deps: Deps) {
  validateGolfVxIdentityContext(source);
  const context = parseGolfVxSource(source.bookingUrl);
  if (!context || !source.venueAddress) fail("ADAPTER_IDENTITY_MISSING");
  const remaining = Math.min(90_000, (deps.deadlineAt?.getTime() ?? Date.now() + 90_000) - Date.now());
  if (!(remaining > 0)) fail("DEADLINE_EXCEEDED");
  const cancellation = new AbortController(), signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(remaining)]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const allowed = new Set([`${GOLFVX_GUEST_ROOT}/stores`, `${GOLFVX_GUEST_ROOT}/stores/${context.storeId}/products`,
    `${GOLFVX_GUEST_ROOT}/room-types?store_id=${context.storeId}`]);
  let count = 0, bytes = 0;
  const read = async (url: string) => {
    if (!allowed.has(url) || ++count > 64) fail("ADAPTER_REQUEST_LIMIT");
    const parseUrl = (value: string) => {
      if (value !== url || !allowed.has(value) || new URL(value).origin !== GOLFVX_ORIGIN) fail("UNSCOPED_ADAPTER_REQUEST");
      return new URL(value);
    };
    const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl, maxResponseBytes: 2_000_000, timeoutMs: 15_000, redirectLimit: 0 });
    return queue.run("booking.golfvx.net", async () => {
      signal.throwIfAborted();
      const response = await transport(url, { method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", signal,
        headers: { accept: "application/json", "user-agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)" } });
      if (response.status === 429) fail("PROVIDER_THROTTLED");
      if (response.status !== 200 || response.redirected || response.url && response.url !== parseUrl(url).href) fail("ADAPTER_TRANSPORT_FAILED");
      if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) fail("ADAPTER_RESPONSE_INVALID");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (!Number.isFinite(declared) || declared < 0 || declared > 2_000_000) fail("ADAPTER_RESPONSE_LIMIT");
      const body = await response.arrayBuffer(); bytes += body.byteLength;
      if (body.byteLength > 2_000_000 || bytes > 12_000_000) fail("ADAPTER_RESPONSE_LIMIT");
      signal.throwIfAborted();
      try { return JSON.parse(Buffer.from(body).toString("utf8")) as unknown; } catch { fail("ADAPTER_RESPONSE_INVALID"); }
    });
  };
  const configuration = async () => {
    const stores = await read(`${GOLFVX_GUEST_ROOT}/stores`), products = await read(`${GOLFVX_GUEST_ROOT}/stores/${context.storeId}/products`),
      rooms = await read(`${GOLFVX_GUEST_ROOT}/room-types?store_id=${context.storeId}`);
    return parseGolfVxConfiguration(stores, products, rooms, source);
  };
  return { configuration, read, allowAvailability: (metadata: GolfVxMetadata, productId: number, roomType: string, input: AccessExecutionInput) => {
    if (metadata.storeId !== context.storeId || !metadata.products.some(value => value.id === productId) || !golfVxRoomScopes(metadata).includes(roomType)) fail("UNSCOPED_ADAPTER_REQUEST");
    const url = new URL(`${GOLFVX_GUEST_ROOT}/availability`);
    for (const [key, value] of Object.entries({ store_id: context.storeId, date: input.date, duration_minutes: String(input.durationMinutes),
      start_interval_minutes: "15", product_id: String(productId), room_type: roomType })) url.searchParams.set(key, value);
    allowed.add(url.href); return url.href;
  }, close: () => { cancellation.abort(); queue.dispose(); } };
}

export async function inspectGolfVx(source: GolfVxSource, deps: Deps): Promise<GolfVxMetadata> {
  const reader = createReader(source, deps);
  try { return await reader.configuration(); } finally { reader.close(); }
}

export async function executeGolfVx(source: GolfVxSource, metadata: GolfVxMetadata, target: Target, input: AccessExecutionInput,
  deps: Deps): Promise<AccessExecutionResult["slots"]> {
  validateInput(input);
  const reader = createReader(source, deps);
  try {
    const saved = golfVxMetadataSchema.parse(metadata), current = await reader.configuration();
    if (JSON.stringify(saved) !== JSON.stringify(current) || input.timeZone !== source.timeZone) fail("ADAPTER_CONFIGURATION_CHANGED");
    const products = saved.products.filter(value => value.status === "ACTIVE" && value.availableOnline === 1 &&
      input.players >= value.minPartySize && input.players <= value.maxPartySize && input.durationMinutes! % value.durationMinutes === 0);
    if (!products.length) fail("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
    const rooms = golfVxRoomScopes(saved);
    if (products.length * rooms.length + 3 > 64) fail("ADAPTER_REQUEST_LIMIT");
    const results: AccessExecutionResult["slots"] = [], keys = new Set<string>();
    for (const product of products) for (const room of rooms) {
      const body = await reader.read(reader.allowAvailability(saved, product.id, room, input));
      for (const slot of normalizeGolfVxAvailability(body, saved, product.id, room, target, input)) {
        if (keys.has(slot.sourceId)) fail("ADAPTER_DUPLICATE_SLOT"); keys.add(slot.sourceId); results.push(slot);
        if (results.length > 500) fail("ADAPTER_RESPONSE_LIMIT");
      }
    }
    return results.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.resourceId!.localeCompare(b.resourceId!) || a.productId!.localeCompare(b.productId!));
  } finally { reader.close(); }
}
