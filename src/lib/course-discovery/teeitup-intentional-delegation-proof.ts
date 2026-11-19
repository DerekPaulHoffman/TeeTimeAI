import { z } from "zod";
import { nativePhysicalContactSourceSchema, physicalContactDigest, physicalProviderAddress, type NativePhysicalContactSource } from "./teeitup-physical-contact-proof";
import { teeItUpBookingConfigurationSchema, type TeeItUpBookingConfiguration } from "./teeitup-booking-configuration";
import { teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import type { OfficialIdentitySource } from "./teeitup-official-identity";

const id = z.number().int().min(1).max(2_147_483_647);
const literal = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
const fields = z.object({ kind: z.literal("OFFICIAL_INTENTIONAL_DELEGATION_V1"), contact: nativePhysicalContactSourceSchema,
  bookingConfiguration: teeItUpBookingConfigurationSchema, facilityId: id, courseId: z.string().min(1).max(128),
  providerName: z.string().min(3).max(200), providerAddress: z.string().min(15).max(1024), providerPhone: z.string().max(40),
  timeZone: z.string().min(1).max(100), country: z.literal("US"), isSimulator: z.literal(false), providerAddressVerified: z.literal(false) }).strict();
export const teeItUpIntentionalDelegationProofSchema = fields.extend({ semanticDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().refine(value => {
  const { semanticDigest, ...data } = value;
  const canonical = teeItUpCompleteStreetAddress(value.contact.canonicalAddress);
  const provider = canonical && physicalProviderAddress(canonical, value.providerAddress, value.country);
  return semanticDigest === physicalContactDigest(data) && value.bookingConfiguration.facilityIds.length === 1 &&
    value.bookingConfiguration.facilityIds[0] === value.facilityId && literal(value.providerName) === literal(value.contact.officialBrandName) &&
    normalizePublicCoursePhone(value.providerPhone) === value.contact.publicCoursePhone && Boolean(canonical && provider &&
    (["number", "region", "postalCode", "country", "unitType", "unit"] as const).every(key => canonical[key] === provider[key]) &&
    (["before", "street", "type", "after"] as const).some(key => canonical[key] !== provider[key]));
});
export type TeeItUpIntentionalDelegationProof = z.infer<typeof teeItUpIntentionalDelegationProofSchema>;

/** Sole-facility configuration must come from the exact current native final
 * document, and directoryAlias from the actual bounded directory GET. Neither
 * this JSON shape nor a matching telephone grants native or replay authority. */
export function bindTeeItUpIntentionalDelegation(source: OfficialIdentitySource, contact: NativePhysicalContactSource,
  directory: unknown, configuration: TeeItUpBookingConfiguration, directoryAlias: string): TeeItUpIntentionalDelegationProof {
  const reject = (): never => { throw new Error("OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED"); };
  const parsedContact = nativePhysicalContactSourceSchema.safeParse(contact), config = teeItUpBookingConfigurationSchema.safeParse(configuration);
  const rows = z.array(z.object({ id, courseId: z.string().min(1).max(128), name: z.string().min(3).max(200), address: z.string().min(15).max(1024),
    timeZone: z.string().min(1).max(100), country: z.literal("US"), isSimulator: z.literal(false), phone: z.string().max(40),
    locality: z.string().max(80).optional(), region: z.string().max(40).optional(), postalCode: z.string().max(10).optional() })).length(1).safeParse(directory);
  if (!parsedContact.success || !config.success || !rows.success || config.data.facilityIds.length !== 1 || config.data.apiAlias !== directoryAlias ||
      contact.officialUrl !== source.officialUrl || contact.bookingUrl !== source.bookingUrl || contact.canonicalName !== source.venueName ||
      contact.canonicalAddress !== source.venueAddress || rows.data[0].timeZone !== source.timeZone || config.data.facilityIds[0] !== rows.data[0].id) return reject();
  const row = rows.data[0], canonical = teeItUpCompleteStreetAddress(contact.canonicalAddress), provider = canonical && physicalProviderAddress(canonical, row.address, row.country);
  if (!provider || row.locality !== undefined && literal(row.locality) !== provider.locality || row.region !== undefined && row.region.toUpperCase() !== provider.region ||
      row.postalCode !== undefined && row.postalCode !== provider.postalCode && !( /^0[1-9]\d{3}$/u.test(provider.postalCode) && `0${row.postalCode}` === provider.postalCode)) return reject();
  const data = { kind: "OFFICIAL_INTENTIONAL_DELEGATION_V1" as const, contact: parsedContact.data, bookingConfiguration: config.data,
    facilityId: row.id, courseId: row.courseId, providerName: row.name, providerAddress: row.address, providerPhone: row.phone,
    timeZone: row.timeZone, country: row.country, isSimulator: row.isSimulator, providerAddressVerified: false as const };
  const proof = teeItUpIntentionalDelegationProofSchema.safeParse({ ...data, semanticDigest: physicalContactDigest(data) });
  return proof.success ? proof.data : reject();
}
