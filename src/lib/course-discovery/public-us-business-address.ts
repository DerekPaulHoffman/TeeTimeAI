import { completeUSAddress } from "./teeitup-official-identity";

export type PublicUSBusinessUnit = Readonly<{ kind: "SUITE"; identifier: string }>;
type CanonicalAddress = NonNullable<ReturnType<typeof completeUSAddress>>;
export type PublicUSBusinessAddress = Readonly<{ canonicalAddress: Readonly<CanonicalAddress>; unit: PublicUSBusinessUnit | null }>;
export const publicUSStates = Object.freeze({ Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY" });
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max && !/\p{Cc}/u.test(value)
  ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : undefined;
export function normalizePublicUSState(value: unknown): string | null {
  const clean = text(value, 40);
  return clean ? Object.entries(publicUSStates).find(([name, code]) => clean.toLowerCase() === name.toLowerCase() || clean.toUpperCase() === code)?.[1] ?? null : null;
}
function countryUS(value: unknown) { const clean = text(value, 40); return clean !== undefined && /^(?:US|USA|United States(?: of America)?)$/iu.test(clean); }
function streetAndUnit(value: unknown) {
  const clean = text(value, 500);
  if (!clean) return null;
  const pieces = clean.split(",").map(part => part.trim());
  if (pieces.length === 1) return { street: pieces[0], unit: null };
  if (pieces.length !== 2 || !pieces[0]) return null;
  const match = /^(?:Ste|Suite)\.? ([A-Za-z0-9]{1,8})$/iu.exec(pieces[1]);
  // A bounded identifier can contain letters and numbers, or one letter. A
  // whole prose word is not an inferred suite identifier.
  if (!match || !(/\d/u.test(match[1]) || /^[A-Za-z]$/u.test(match[1]))) return null;
  return { street: pieces[0], unit: Object.freeze({ kind: "SUITE" as const, identifier: match[1].toUpperCase() }) };
}
function frozen(address: CanonicalAddress, unit: PublicUSBusinessUnit | null): PublicUSBusinessAddress {
  return Object.freeze({ canonicalAddress: Object.freeze(address), unit });
}
/** Split metadata requires every actual postal part. No expected/source field
 * is accepted by this parser and none can fill a missing component. */
export function parsePublicUSBusinessAddressParts(parts: { address: unknown; city: unknown; state: unknown; postalCode: unknown; country: unknown }): PublicUSBusinessAddress | null {
  if (!parts || typeof parts !== "object" || Array.isArray(parts) || ["address", "city", "state", "postalCode", "country"].some(key => !Object.hasOwn(parts, key))) return null;
  const street = streetAndUnit(parts.address), city = text(parts.city, 80), state = normalizePublicUSState(parts.state), postal = text(parts.postalCode, 10);
  if (!street || !city || !/^[\p{L} .'-]{2,80}$/u.test(city) || !state || !postal || !/^\d{5}(?:-\d{4})?$/u.test(postal) || !countryUS(parts.country)) return null;
  const address = completeUSAddress(`${street.street}, ${city}, ${state} ${postal}, US`);
  return address ? frozen(address, street.unit) : null;
}
/** The existing complete address grammar remains available. The additional
 * representation is exactly one comma-separated Ste/Suite segment, retained
 * as metadata rather than silently removed from the identity witness. */
export function parsePublicUSBusinessAddress(value: unknown): PublicUSBusinessAddress | null {
  const clean = text(value, 1024);
  if (!clean) return null;
  const legacy = completeUSAddress(clean);
  if (legacy) return normalizePublicUSState(legacy.region) ? frozen(legacy, null) : null;
  const pieces = clean.replace(/^Address\s*:\s*/iu, "").split(",").map(part => part.trim());
  if (pieces.some(part => !part) || pieces.length < 3 || pieces.length > 5) return null;
  const withUnit = /^(?:Ste|Suite)\.? /iu.test(pieces[1]);
  const localityIndex = withUnit ? 2 : 1, remainder = pieces.length - localityIndex;
  if (remainder !== 2 && remainder !== 3) return null;
  const statePostal = /^(.{2,40}) (\d{5}(?:-\d{4})?)$/u.exec(pieces[localityIndex + 1]);
  if (!statePostal) return null;
  return parsePublicUSBusinessAddressParts({ address: withUnit ? `${pieces[0]}, ${pieces[1]}` : pieces[0], city: pieces[localityIndex],
    state: statePostal[1], postalCode: statePostal[2], country: remainder === 3 ? pieces[localityIndex + 2] : "US" });
}
