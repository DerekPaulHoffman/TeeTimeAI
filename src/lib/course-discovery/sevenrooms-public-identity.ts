import { createHash } from "node:crypto";
import { completeUSAddress } from "./teeitup-official-identity";

type Source = { bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
type Request = { url: string; method: string; status: number };
type Address = NonNullable<ReturnType<typeof completeUSAddress>>;
export type SevenRoomsPublicIdentity = Readonly<{
  venueName: string; timeZone: string; tenant: string;
  canonicalAddress: Readonly<Address>; witnessSha256: string;
}>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const own = (value: unknown, key: string): value is Record<string, unknown> => object(value) && Object.hasOwn(value, key);
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max && !/\p{Cc}/u.test(value) ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : undefined;
const fail = (reason: string): never => { throw new Error(`SEVENROOMS_IDENTITY_${reason}`); };
const country = (value: unknown) => { const clean = text(value, 40); return clean !== undefined && /^(?:US|USA|United States(?: of America)?)$/iu.test(clean); };
const sameAddress = (left: Address, right: Address) => JSON.stringify(left) === JSON.stringify(right);

/** Only current own fields from this one public metadata container may supply
 * identity. Expected source fields compare; they never fill missing parts. */
export function verifySevenRoomsPublicIdentity(body: unknown, source: Source, request: Request,
  venueMatches: (expected: string, observed: unknown) => boolean): SevenRoomsPublicIdentity {
  let tenant: string | undefined;
  try {
    const booking = new URL(source.bookingUrl);
    tenant = /^\/reservations\/([a-z0-9]+(?:[-_][a-z0-9]+)*)$/u.exec(booking.pathname)?.[1];
    if (!tenant || tenant.length > 128 || source.bookingUrl.length > 2048 || booking.href !== source.bookingUrl || booking.origin !== "https://www.sevenrooms.com" || booking.username || booking.password || booking.port || booking.hash ||
        !["", "?duration-picker=true"].includes(booking.search)) return fail("SOURCE_INVALID");
  } catch { return fail("SOURCE_INVALID"); }
  const expectedAddress = typeof source.venueAddress === "string" && source.venueAddress.length <= 1024 ? completeUSAddress(source.venueAddress) : null;
  if (!expectedAddress || !text(source.venueName, 200) || !text(source.timeZone, 100)) return fail("SOURCE_INVALID");
  try { new Intl.DateTimeFormat("en-US", { timeZone: source.timeZone }).format(); } catch { return fail("SOURCE_INVALID"); }
  const metadataUrl = `https://www.sevenrooms.com/api-yoa/dining/venue_info?venue_url_key=${tenant}&widget_type=RESERVATIONS&modify_upgrades=false`;
  if (request.url !== metadataUrl || request.method !== "GET" || request.status !== 200) return fail("REQUEST_UNVERIFIED");
  if (!own(body, "status") || body.status !== 200) return fail("APPLICATION_FAILURE");
  if (!own(body, "data") || !own(body.data, "venue_info") || !object(body.data.venue_info)) return fail("CONTAINER_INVALID");
  const venue = body.data.venue_info;
  const name = own(venue, "name") ? text(venue.name, 200) : undefined;
  if (!name || !venueMatches(source.venueName, name)) return fail("NAME_MISMATCH");
  if (!own(venue, "url_key") || venue.url_key !== tenant || own(venue, "venue_url_key") && venue.venue_url_key !== tenant) return fail("TENANT_MISMATCH");
  const zone = own(venue, "timezone") ? text(venue.timezone, 100) : undefined;
  if (!zone || zone !== source.timeZone) return fail("TIME_ZONE_MISMATCH");
  const address = own(venue, "address") ? text(venue.address, 500) : undefined;
  if (!address || own(venue, "address2") && text(venue.address2, 200) !== "" ||
      own(venue, "address1") && text(venue.address1, 500) !== "" && text(venue.address1, 500) !== address) return fail("ADDRESS_UNVERIFIED");
  for (const key of ["country", "country_code"]) if (own(venue, key) && !country(venue[key])) return fail("ADDRESS_UNVERIFIED");
  let actual = completeUSAddress(address);
  if (!actual) {
    const city = own(venue, "city") ? text(venue.city, 80) : undefined;
    const state = own(venue, "state") ? text(venue.state, 2) : undefined;
    const postal = own(venue, "postal_code") ? text(venue.postal_code, 10) : undefined;
    if (!city || !/^[\p{L} .'-]{2,80}$/u.test(city) || !state || !/^[A-Za-z]{2}$/u.test(state) || !postal || !/^\d{5}(?:-\d{4})?$/u.test(postal) ||
        !["country", "country_code"].some(key => own(venue, key) && country(venue[key]))) return fail("ADDRESS_UNVERIFIED");
    actual = completeUSAddress(`${address}, ${city}, ${state} ${postal}, US`);
  } else {
    // Redundant actual fields must not contradict the independently complete
    // address. Missing redundant fields do not borrow from the expected source.
    if (own(venue, "city") && text(venue.city, 80)?.toLowerCase() !== actual.locality ||
        own(venue, "state") && text(venue.state, 2)?.toUpperCase() !== actual.region ||
        own(venue, "postal_code") && (!/^\d{5}(?:-\d{4})?$/u.test(text(venue.postal_code, 10) ?? "") || text(venue.postal_code, 10)?.slice(0, 5) !== actual.postalCode)) return fail("ADDRESS_UNVERIFIED");
  }
  if (!actual || own(venue, "zip_code") && (!/^\d{5}(?:-\d{4})?$/u.test(text(venue.zip_code, 10) ?? "") || text(venue.zip_code, 10)?.slice(0, 5) !== actual.postalCode) || !sameAddress(actual, expectedAddress)) return fail("ADDRESS_UNVERIFIED");
  const canonicalAddress = Object.freeze(actual), identity = { venueName: name, timeZone: zone, tenant, canonicalAddress };
  return Object.freeze({ ...identity, witnessSha256: createHash("sha256").update(JSON.stringify(identity)).digest("hex") });
}
