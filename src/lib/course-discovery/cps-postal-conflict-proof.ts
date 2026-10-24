import { createHash } from "node:crypto";
import { z } from "zod";
import { completeUSAddress, fullCourseName, type OfficialIdentityPage } from "./teeitup-official-identity";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import { parsePublicCourseContactBlocks, hasInertPublicBookingLink, normalizePublicCourseContactPhone, type PublicCourseContactBlock } from "./public-course-contact-blocks";
import { getNativeOfficialIdentityPageDiagnostic, isFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";

export const normalizeCanonicalCoursePhone = normalizePublicCoursePhone;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const url = z.string().url().max(2048).refine(value=>{const parsed=new URL(value);return parsed.protocol==="https:"&&!parsed.username&&!parsed.password&&!parsed.port&&!parsed.hash;});
export const cpsPostalConflictProofSchema = z.object({
  kind:z.literal("CANONICAL_PHONE_POSTAL_CONFLICT"), officialUrl:url, officialPageUrl:url, bookingUrl:url,
  tenant:z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u), canonicalAddress:z.string().min(15).max(1024),officialAddress:z.string().min(15).max(1024),
  canonicalPostalCode:z.string().regex(/^\d{5}$/u),officialPostalCode:z.string().regex(/^\d{5}$/u),
  canonicalCoursePhone:z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/u),venueName:z.string().min(3).max(200),timeZone:z.string().min(1).max(100),
  providerVenueName:z.string().min(3).max(200),
  catalogHash:digest,courseIds:z.array(z.number().int().positive()).min(1).max(40),markupWitnessSha256:digest,phoneWitnessSha256:digest,
  warmTransport:z.literal("NATIVE_CHROME"),requiredCapability:z.literal("LOCAL_CHROME"),
}).strict().refine(value=>value.canonicalPostalCode!==value.officialPostalCode);
export type CpsPostalConflictProof=z.infer<typeof cpsPostalConflictProofSchema>;
type Source={officialUrl:string;bookingUrl:string;venueName:string;venueAddress?:string;timeZone:string};
const fail=():never=>{throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");};
const contactGateKeys = ["freshNativeOfficialPage", "canonicalAddressPresent", "canonicalAddressValid", "canonicalPhoneValid",
  "rawContactsPresent", "renderedContactsPresent", "contactCountBounded", "rawContactsNormalizable", "renderedContactsNormalizable",
  "uniqueNormalizedContact", "venueMatches", "phoneMatches", "postalDiscrepancy", "addressMatchesExceptPostal",
  "visibleBookingLink", "inertBookingLink"] as const;
type ContactGates = Record<typeof contactGateKeys[number], boolean | null>;
export type CpsPostalContactDiagnostic = { gates: ContactGates;
  native: ReturnType<typeof getNativeOfficialIdentityPageDiagnostic> };
const failureDiagnostics = new WeakMap<object, CpsPostalContactDiagnostic>();
/** A copied closed projection; neither error text nor captured source data is returned. */
export function getCpsPostalContactDiagnostic(error: unknown): CpsPostalContactDiagnostic | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = failureDiagnostics.get(error);
  return value ? { gates: { ...value.gates }, native: { ...value.native } } : undefined;
}
function normalized(block:PublicCourseContactBlock){
  if(!["US","USA","United States","United States of America"].includes(block.country))return fail();
  const address=completeUSAddress(`${block.street}, ${block.locality}, ${block.region} ${block.postalCode}, US`),phone=normalizePublicCourseContactPhone(block.phone);
  if(!address||!phone)return fail();
  return{venueName:fullCourseName(block.venueName),address,phone};
}
/** A normal durable phone corroborates only a ZIP-only discrepancy in this
 * exact venue's physical contact block. Native provenance is not identity. */
export function verifyCpsPostalContact(source:Source,page:OfficialIdentityPage,canonicalCoursePhone:unknown){
  const gates = Object.fromEntries(contactGateKeys.map(key => [key, null])) as ContactGates;
  const gate = (key: typeof contactGateKeys[number], value: boolean) => { gates[key] = value; if (!value) fail(); };
  try {
  gate("freshNativeOfficialPage",isFreshNativeOfficialIdentityPage(page,source.officialUrl));
  gate("canonicalAddressPresent",Boolean(source.venueAddress));
  if(!source.venueAddress)return fail();
  const canonical=completeUSAddress(source.venueAddress),phone=normalizeCanonicalCoursePhone(canonicalCoursePhone);
  gate("canonicalAddressValid",Boolean(canonical)); gate("canonicalPhoneValid",Boolean(phone));
  if(!canonical||!phone)return fail();
  const raw=parsePublicCourseContactBlocks(page.html,source.venueName),rendered=page.visibleEvidence?.publicContactBlocks;
  gate("rawContactsPresent",raw.length>0); gate("renderedContactsPresent",Boolean(rendered?.length));
  if(!rendered?.length)return fail();
  gate("contactCountBounded",raw.length<=40&&rendered.length<=40);
  gates.rawContactsNormalizable=false; const rawRows=raw.map(normalized); gates.rawContactsNormalizable=true;
  gates.renderedContactsNormalizable=false; const visibleRows=rendered.map(normalized); gates.renderedContactsNormalizable=true;
  const rows=[...rawRows,...visibleRows];
  const unique=new Set(rows.map(row=>JSON.stringify(row)));
  gate("uniqueNormalizedContact",unique.size===1);
  gate("venueMatches",rows.every(row=>row.venueName===fullCourseName(source.venueName)));
  gate("phoneMatches",rows.every(row=>row.phone===phone));
  const observed=rows[0].address;
  gate("postalDiscrepancy",observed.postalCode!==canonical.postalCode);
  gate("addressMatchesExceptPostal",JSON.stringify({...observed,postalCode:""})===JSON.stringify({...canonical,postalCode:""}));
  gate("visibleBookingLink",Boolean(page.visibleEvidence?.linkUrls.includes(source.bookingUrl)));
  // Exact source href must also occur in nonhidden inert markup. Contact
  // block binding never manufactures a bare provider ancestor.
  gate("inertBookingLink",hasInertPublicBookingLink(page.html,page.url,source.bookingUrl));
  const officialAddress=`${raw[0].street}, ${raw[0].locality}, ${raw[0].region} ${raw[0].postalCode}, USA`;
  return{canonical,observed,phone,officialAddress,canonicalRow:rows[0]};
  } catch (error) {
    if (error && typeof error === "object") failureDiagnostics.set(error, { gates: { ...gates },
      native: getNativeOfficialIdentityPageDiagnostic(page,source.officialUrl) });
    throw error;
  }
}
export function bindCpsPostalConflictProof(source:Source,page:OfficialIdentityPage,canonicalCoursePhone:unknown,
  catalog:{tenant:string;catalogHash:string;courseIds:number[]},providerVenueName:string):CpsPostalConflictProof{
  const {canonical,observed,phone,officialAddress,canonicalRow}=verifyCpsPostalContact(source,page,canonicalCoursePhone);
  return cpsPostalConflictProofSchema.parse({kind:"CANONICAL_PHONE_POSTAL_CONFLICT",officialUrl:source.officialUrl,officialPageUrl:page.url,bookingUrl:source.bookingUrl,
    tenant:catalog.tenant,catalogHash:catalog.catalogHash,courseIds:catalog.courseIds,canonicalAddress:source.venueAddress,officialAddress,
    canonicalPostalCode:canonical.postalCode,officialPostalCode:observed.postalCode,canonicalCoursePhone:phone,venueName:source.venueName,timeZone:source.timeZone,providerVenueName,
    markupWitnessSha256:hash(canonicalRow),phoneWitnessSha256:hash({venueName:fullCourseName(source.venueName),address:observed,phone}),
    warmTransport:"NATIVE_CHROME",requiredCapability:"LOCAL_CHROME"});
}
