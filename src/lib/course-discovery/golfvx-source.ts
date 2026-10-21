import { createHash } from "node:crypto";
import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";

export const GOLFVX_ORIGIN = "https://booking.golfvx.net";
export const GOLFVX_GUEST_ROOT = `${GOLFVX_ORIGIN}/api/v1/billing/guest/booking`;
const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const id = z.number().int().min(1).max(2_147_483_647);
const timeZone = z.string().min(3).max(100).refine(value => {
  try { return value.includes("/") && new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone === value; } catch { return false; }
});
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const closingClock = z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/u);
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const hours = z.object({ open: clock, close: closingClock }).strict().refine(value =>
  minutes(value.open) < minutes(value.close) && minutes(value.open) % 15 === 0 && minutes(value.close) % 15 === 0);
const week = z.object({ "0": hours, "1": hours, "2": hours, "3": hours, "4": hours, "5": hours, "6": hours }).strict();
const roomCode = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/u);
const rentalName = z.string().trim().min(2).max(160).regex(/^(?:bay|simulator) rentals?$/iu);
const product = z.object({ id, name: rentalName, durationMinutes: z.number().int().min(1).max(480),
  minPartySize: id.max(100), maxPartySize: id.max(100), productType: z.literal("TIMED"), bookingType: z.literal("PURCHASE"),
  resourceType: z.literal("SCREEN_GOLF"), availableOnline: z.union([z.literal(0), z.literal(1)]), status: z.enum(["ACTIVE", "INACTIVE"]) }).strict()
  .refine(value => value.minPartySize <= value.maxPartySize);
const productIdentity = z.object({ id, store_id: uuid, name: z.string().trim().min(2).max(160), product_type: z.string().min(1).max(40),
  booking_type: z.literal("PURCHASE"), available_online: z.union([z.literal(0), z.literal(1)]), status: z.enum(["ACTIVE", "INACTIVE"]) });
const saleDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u).refine(value => {
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.replace(" ", "T");
});
// Public PASS plans have no rental resource/duration/party binding. Only this
// explicit non-inventory shape may be excluded; a PASS with any resource hint
// or a malformed/foreign/duplicate catalog identity remains unsupported.
const nonRentalPass = productIdentity.extend({ product_type: z.literal("PASS"), duration_minutes: z.null(), resource_type: z.null(),
  secondary_resource_type: z.null(), min_party_size: z.null(), max_party_size: z.null(), plan_id: id, billing_interval: z.literal("monthly"),
  sale_start_date: saleDateTime.nullable(), sale_end_date: saleDateTime.nullable(), plan_name: z.string().trim().min(2).max(160),
  plan_subtitle: z.string().max(400).nullable(), base_price: z.number().finite().min(0).max(1_000_000),
  external_ref_id: z.null(), tier_code: z.null(), grant_type: z.null(), total_count: z.null(), total_minutes: z.null(), period_minutes: z.null(),
  period_unit: z.null(), validity_period_value: z.null(), validity_period_unit: z.null(),
  metadata: z.object({ membership: z.record(z.string(), z.unknown()) }).strict() })
  .refine(value => value.sale_start_date === null || value.sale_end_date === null || value.sale_start_date <= value.sale_end_date);
const rooms = z.object({ hasUnassigned: z.boolean(), types: z.array(z.object({ code: roomCode, name: z.string().trim().min(1).max(100),
  surcharge: z.number().finite().min(0).max(100_000), confirmPolicy: z.literal("INSTANT") }).strict()).max(20)
  .refine(values => new Set(values.map(value => value.code)).size === values.length) }).strict()
  .refine(value => value.hasUnassigned || value.types.length > 0);
const identity = z.object({ officialUrl: z.string().min(8).max(2048).refine(value => {
  try { return new URL(value).protocol === "https:" && Boolean(getSafeCustomerBookingUrl(value)); } catch { return false; }
}), venueName: z.string().trim().min(5).max(200),
  // This is trusted controller context. The public API does not publish an address.
  venueAddress: z.string().trim().min(10).max(400) }).strict();
const store = z.object({ name: z.string().trim().min(5).max(200), industry: z.literal("GOLF"), currency: z.literal("USD"),
  bookingPeriodDays: id.max(366), operatingHours: week, slotDurationMinutes: id.max(480) }).strict();
export const golfVxMetadataSchema = z.object({ family: z.literal("GOLFVX"), bookingUrl: z.string().max(2048), storeId: uuid, timeZone,
  identity, store, products: z.array(product).min(1).max(20).refine(values => new Set(values.map(value => value.id)).size === values.length),
  rooms, catalogHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
  .refine(value => parseGolfVxSource(value.bookingUrl)?.storeId === value.storeId);
export type GolfVxMetadata = z.infer<typeof golfVxMetadataSchema>;
export type GolfVxSource = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
function fail(code = "ADAPTER_CONFIGURATION_UNVERIFIED"): never { throw new Error(code); }
const nameKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");

export function validateGolfVxIdentityContext(source: GolfVxSource): void {
  if (!parseGolfVxSource(source.bookingUrl) || !getSafeCustomerBookingUrl(source.officialUrl) || !source.venueAddress ||
      !identity.safeParse({ officialUrl: source.officialUrl, venueName: source.venueName, venueAddress: source.venueAddress }).success ||
      !timeZone.safeParse(source.timeZone).success) fail("ADAPTER_IDENTITY_MISSING");
}

/** Only the public page is a recipe source. API paths never become customer URLs. */
export function parseGolfVxSource(value: string): { bookingUrl: string; storeId: string } | undefined {
  try {
    const url = new URL(value), match = /^\/book\/([^/]+)$/u.exec(url.pathname);
    if (url.origin !== GOLFVX_ORIGIN || url.username || url.password || url.port || url.search || url.hash ||
        url.href !== value || !match || !uuid.safeParse(match[1]).success) return undefined;
    return { bookingUrl: url.href, storeId: match[1] };
  } catch { return undefined; }
}

/** Reviewed guest client get/getList unwrap dataset[0][0] / dataset[0]. Raw
 * array and paginated/extra datasets are deliberately outside this contract. */
export function golfVxEnvelopeRows(value: unknown): unknown[] {
  const parsed = z.object({ code: z.literal(0), msg: z.string().max(500), output: z.object({}).strict(), affected: z.literal(-1),
    dataset: z.tuple([z.array(z.unknown()).max(200)]), timestamp: z.string().datetime({ offset: true }) }).strict().safeParse(value);
  if (!parsed.success) fail("ADAPTER_RESPONSE_INVALID");
  return parsed.data.dataset[0];
}

export function golfVxRoomScopes(metadata: GolfVxMetadata): string[] {
  return [...(metadata.rooms.hasUnassigned ? ["BASE"] : []), ...metadata.rooms.types.map(value => value.code)];
}

/** The controller establishes official->observed-book-URL provenance. Fresh
 * public data independently binds that exact UUID, whole venue and timezone.
 * Address is retained for continuity, never claimed as provider address proof. */
export function parseGolfVxConfiguration(storesBody: unknown, productsBody: unknown, roomsBody: unknown, source: GolfVxSource): GolfVxMetadata {
  const context = parseGolfVxSource(source.bookingUrl);
  validateGolfVxIdentityContext(source);
  if (!context) fail("ADAPTER_IDENTITY_MISSING");
  const rawStores = golfVxEnvelopeRows(storesBody);
  const stores = rawStores.map(value => {
    const result = z.object({ store_id: uuid, store_name: z.string().trim().min(5).max(200), industry_code: z.string().min(1).max(40),
      currency: z.string().min(1).max(10), timezone: timeZone, booking_period_days: id.max(366), operating_hours: z.string().max(8000),
      slot_duration_minutes: id.max(480), default_break_times: z.null() }).safeParse(value);
    if (!result.success) fail("GOLFVX_STORE_SCHEMA_UNSUPPORTED"); return result.data;
  });
  if (!stores.length || new Set(stores.map(value => value.store_id)).size !== stores.length) fail("ADAPTER_IDENTITY_MISMATCH");
  const selected = stores.find(value => value.store_id === context.storeId);
  if (!selected || nameKey(selected.store_name) !== nameKey(source.venueName) || nameKey(source.venueName).length < 8 ||
      selected.timezone !== source.timeZone || selected.industry_code !== "GOLF" || selected.currency !== "USD") fail("ADAPTER_IDENTITY_MISMATCH");
  let operatingHours: z.infer<typeof week>;
  try { operatingHours = week.parse(JSON.parse(selected.operating_hours)); } catch { fail("GOLFVX_OPERATING_HOURS_UNSUPPORTED"); }
  const rawProducts = golfVxEnvelopeRows(productsBody);
  // Validate every row before excluding anything, including non-rental PASS
  // identities. Excluded commerce changes cannot invalidate rental knowledge.
  const catalog = rawProducts.map(value => {
    const parsed = productIdentity.safeParse(value);
    if (!parsed.success || parsed.data.store_id !== context.storeId) fail("GOLFVX_PRODUCT_IDENTITY_INVALID");
    return { value, identity: parsed.data };
  });
  if (new Set(catalog.map(row => row.identity.id)).size !== catalog.length) fail("GOLFVX_PRODUCT_IDENTITY_INVALID");
  const products = catalog.flatMap(({ value, identity }) => {
    if (identity.product_type === "PASS") {
      if (!nonRentalPass.safeParse(value).success) fail("GOLFVX_NONRENTAL_SCHEMA_UNSUPPORTED");
      return [];
    }
    if (identity.product_type !== "TIMED") fail("GOLFVX_PRODUCT_TYPE_UNSUPPORTED");
    const parsed = z.object({ id, store_id: uuid, name: rentalName, product_type: z.literal("TIMED"), booking_type: z.literal("PURCHASE"),
      duration_minutes: id.max(480), resource_type: z.literal("SCREEN_GOLF"), secondary_resource_type: z.null(),
      min_party_size: id.max(100), max_party_size: id.max(100), available_online: z.union([z.literal(0), z.literal(1)]),
      status: z.enum(["ACTIVE", "INACTIVE"]), sale_start_date: z.null(), sale_end_date: z.null(), metadata: z.null(),
      plan_id: z.null(), grant_type: z.null(), tier_code: z.null(), external_ref_id: z.null(), total_count: z.null(), total_minutes: z.null(),
      period_minutes: z.null(), period_unit: z.null(), validity_period_value: z.null(), validity_period_unit: z.null(),
      billing_interval: z.null(), plan_name: z.null(), plan_subtitle: z.null() }).safeParse(value);
    if (!parsed.success) fail("GOLFVX_RENTAL_SCHEMA_UNSUPPORTED");
    const row = parsed.data;
    const rental = product.safeParse({ id: row.id, name: row.name, durationMinutes: row.duration_minutes, minPartySize: row.min_party_size, maxPartySize: row.max_party_size,
      productType: row.product_type, bookingType: row.booking_type, resourceType: row.resource_type, availableOnline: row.available_online, status: row.status });
    if (!rental.success) fail("GOLFVX_RENTAL_SCHEMA_UNSUPPORTED");
    return [rental.data];
  }).sort((a, b) => a.id - b.id);
  if (!products.length || products.length > 20) fail("GOLFVX_RENTAL_SCHEMA_UNSUPPORTED");
  const rawRooms = golfVxEnvelopeRows(roomsBody);
  if (rawRooms.length !== 1) fail("GOLFVX_ROOM_TYPES_COUNT_UNSUPPORTED");
  const parsedRooms = z.object({ has_unassigned: z.union([z.literal(0), z.literal(1)]), room_types: z.array(z.object({ code: roomCode,
    name: z.string().trim().min(1).max(100), surcharge: z.number().finite().min(0).max(100_000), confirm_policy: z.literal("INSTANT") }).strict()).max(20) }).strict().safeParse(rawRooms[0]);
  if (!parsedRooms.success) fail("GOLFVX_ROOM_TYPES_SCHEMA_UNSUPPORTED");
  const config = { family: "GOLFVX" as const, ...context, timeZone: source.timeZone,
    identity: identity.parse({ officialUrl: source.officialUrl, venueName: source.venueName, venueAddress: source.venueAddress }),
    store: store.parse({ name: selected.store_name, industry: selected.industry_code, currency: selected.currency,
      bookingPeriodDays: selected.booking_period_days, operatingHours, slotDurationMinutes: selected.slot_duration_minutes }), products,
    rooms: rooms.parse({ hasUnassigned: parsedRooms.data.has_unassigned === 1, types: parsedRooms.data.room_types.map(value => ({
      code: value.code, name: value.name, surcharge: value.surcharge, confirmPolicy: value.confirm_policy })).sort((a, b) => a.code.localeCompare(b.code)) }) };
  return golfVxMetadataSchema.parse({ ...config, catalogHash: createHash("sha256").update(JSON.stringify(config)).digest("hex") });
}
