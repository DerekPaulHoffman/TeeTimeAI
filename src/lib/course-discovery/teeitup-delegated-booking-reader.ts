import type { OfficialIdentitySource, OfficialIdentityPage } from "./teeitup-official-identity";
import type { NativeOfficialPageReader } from "./native-official-page-reader";
import type { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { isFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { delegatedCanonicalVenueWitness, delegatedBookingHop } from "./teeitup-delegated-booking-source";
import { authorizeDelegatedGet, freshDelegatedPage, registerNativeDelegatedChain, createDelegatedReadBudget, type DelegatedGetGrant } from "./teeitup-delegated-booking-context";
import { teeItUpBookAlias } from "./teeitup-official-booking-source";
import { createDelegationDiagnostic, rememberTeeItUpDelegationFailure, type DelegatedDiagnosticGate } from "./teeitup-delegated-booking-diagnostic";
import { deriveNativePhysicalContactSource, getTeeItUpPhysicalContactDiagnostic, type NativePhysicalContactSource } from "./teeitup-physical-contact-proof";

export type DelegatedReaderDependencies = {
  deadlineAt?: Date; localCapabilities?: readonly "LOCAL_CHROME"[];
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  readDelegatedRoot?: NativeOfficialPageReader;
  trustedContext?: { canonicalCoursePhone?: string };
  /** Fixed controller test seam, never model or serialized recipe authority. */
  readDelegatedDocument?: (source: OfficialIdentitySource, grant: DelegatedGetGrant) => Promise<OfficialIdentityPage>;
};
/** Fresh deterministic rediscovery. No report path or caller-provided chain is
 * consumed: each next GET is earned from the preceding owned native document. */
export async function readTeeItUpDelegatedBookingChain(source: OfficialIdentitySource, deps: DelegatedReaderDependencies) {
  const diagnostic = createDelegationDiagnostic(), note = (key: DelegatedDiagnosticGate, value: boolean) => { diagnostic.gates[key] = value; };
  try {
  note("capabilityAvailable", Boolean(deps.localCapabilities?.includes("LOCAL_CHROME")));
  if (!deps.localCapabilities?.includes("LOCAL_CHROME")) throw new Error("LOCAL_CHROME_REQUIRED");
  diagnostic.stage = "SOURCE"; note("sourceValid", Boolean(source.officialUrl && source.venueAddress && teeItUpBookAlias(source.bookingUrl)));
  if (!source.officialUrl || !source.venueAddress || !teeItUpBookAlias(source.bookingUrl)) throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  const deadline = new Date(Math.min(deps.deadlineAt?.getTime() ?? Infinity, Date.now() + 120000));
  note("deadlineCurrent", Number.isFinite(deadline.getTime()) && deadline.getTime() > Date.now());
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) throw new Error("DEADLINE_EXCEEDED");
  const loaded = await import("./native-official-page-reader");
  const native = typeof loaded.readNativeOfficialIdentityPage === "function" ? loaded :
    (loaded as unknown as { default: typeof loaded }).default;
  if (typeof native?.readNativeOfficialIdentityPage !== "function" || typeof native.readNativeDelegatedDocument !== "function")
    throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  const requestLease: typeof runWithProviderRequestLease | undefined = deps.requestLease ? async (family, work) => {
    const reply = await deps.requestLease!(family, work);
    return reply.acquired ? { acquired: true, value: await reply.value } : { acquired: false };
  } : undefined;
  const delegatedReadBudget = createDelegatedReadBudget(deadline);
  const rootRead = deps.readDelegatedRoot ?? ((s, url, end) => native.readNativeOfficialIdentityPage(s, url, end, { requestLease, delegatedReadBudget }));
  const nextRead = deps.readDelegatedDocument ?? ((s, grant) => native.readNativeDelegatedDocument(s, grant, { requestLease, delegatedReadBudget }));
  diagnostic.stage = "ROOT_READ";
  let root = await rootRead(source, source.officialUrl, deadline); note("rootReadReturned", true);
  diagnostic.stage = "ROOT_FRESH"; note("rootFresh", isFreshNativeOfficialIdentityPage(root, source.officialUrl));
  if (!isFreshNativeOfficialIdentityPage(root, source.officialUrl)) throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  diagnostic.stage = "ROOT_IDENTITY";
  let physicalContactSource: NativePhysicalContactSource | undefined;
  let physicalContactRequired = false;
  const firstBookingHop = (page: OfficialIdentityPage) => {
    try { return delegatedBookingHop(page, source.bookingUrl, note); } catch { return delegatedBookingHop(page, undefined, note); }
  };
  const physicalWitness = (page: OfficialIdentityPage) => {
    const first = firstBookingHop(page);
    return deriveNativePhysicalContactSource(source, page, deps.trustedContext?.canonicalCoursePhone,
      first.nextUrl === source.bookingUrl ? undefined : first.nextUrl);
  };
  const rootWitness = (page: OfficialIdentityPage) => {
    try {
      const legacy = delegatedCanonicalVenueWitness(source, page, note);
      physicalContactRequired = false;
      physicalContactSource = undefined;
      try { physicalContactSource = physicalWitness(page); } catch { /* Legacy source evidence remains unchanged. */ }
      return legacy;
    } catch (error) {
      if (!deps.trustedContext?.canonicalCoursePhone) throw error;
      physicalContactSource = physicalWitness(page);
      physicalContactRequired = true;
      return physicalContactSource.sourceWitnessSha256;
    }
  };
  const rootWitnessSha256 = rootWitness(root);
  // Prefer an exact direct link if present, otherwise require one unambiguous
  // public booking delegation from the canonical venue document.
  diagnostic.stage = "ROOT_LINK";
  const first = firstBookingHop(root);
  note("rootLinkVerified", true);
  const admitted = authorizeDelegatedGet(root, source.officialUrl, deadline, first.nextUrl);
  diagnostic.stage = "HOP_ONE_READ";
  let final = await nextRead(source, admitted.token); note("firstReadReturned", true);
  const hops = [admitted.hop];
  if (first.nextUrl !== source.bookingUrl) {
    diagnostic.stage = "HOP_ONE_FRESH"; note("firstFresh", freshDelegatedPage(final, source.officialUrl));
    if (!freshDelegatedPage(final, source.officialUrl)) throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    diagnostic.stage = "HOP_TWO_LINK";
    const second = authorizeDelegatedGet(final, source.officialUrl, deadline, source.bookingUrl, note);
    note("secondLinkVerified", true);
    if (second.hop.nextUrl === root.url) throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    diagnostic.stage = "HOP_TWO_READ";
    hops.push(second.hop); final = await nextRead(source, second.token); note("secondReadReturned", true);
  }
  // The root's attestation is not renewed by moving to a different document.
  // If it expired during the bounded chain, actually recapture it once.
  note("rootRefreshRequired", !isFreshNativeOfficialIdentityPage(root, source.officialUrl));
  if (!isFreshNativeOfficialIdentityPage(root, source.officialUrl)) {
    diagnostic.stage = "ROOT_REFRESH";
    root = await rootRead(source, source.officialUrl, deadline);
    note("rootRefreshReturned", true);
    if (!isFreshNativeOfficialIdentityPage(root, source.officialUrl) ||
        !(diagnostic.gates.rootRefreshIdentityMatches = rootWitness(root) === rootWitnessSha256) ||
        !(diagnostic.gates.rootRefreshLinkMatches = JSON.stringify(delegatedBookingHop(root, hops[0].nextUrl, note)) === JSON.stringify(hops[0]))) throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  }
  diagnostic.stage = "FINAL_FRESH";
  note("finalFresh", freshDelegatedPage(final, source.officialUrl)); note("finalUrlMatches", final.url === source.bookingUrl);
  note("deadlineCurrent", Date.now() < deadline.getTime());
  if (Date.now() >= deadline.getTime() || !freshDelegatedPage(final, source.officialUrl) || final.url !== source.bookingUrl)
    throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  diagnostic.stage = "CHAIN_REGISTER";
  return registerNativeDelegatedChain({ root, final, officialUrl: source.officialUrl, bookingUrl: source.bookingUrl,
    rootWitnessSha256, hops, deadline: deadline.getTime(), ...(physicalContactSource ? { physicalContactSource } : {}), ...(physicalContactRequired ? { physicalContactRequired: true } : {}) });
  } catch (error) {
    const physical = getTeeItUpPhysicalContactDiagnostic(error);
    if (physical) {
      const group = (...keys: Array<keyof typeof physical.gates>) => keys.some(key => physical.gates[key] === false) ? false : keys.every(key => physical.gates[key] === true) ? true : null;
      diagnostic.gates.physicalRaw = group("rawTitleUnique", "rawBrandUnique", "titleBrandBinding", "physicalBlockUnique", "canonicalAddressExact", "rawBookingLinkPresent");
      diagnostic.gates.physicalRendered = group("titleRawVisibleEqual", "brandRawVisibleMatch", "visiblePhysicalBlockMatches", "visibleBookingLinkPresent");
      diagnostic.gates.physicalNameRelation = physical.gates.observedServiceBinding;
      diagnostic.gates.physicalPhone = group("canonicalPhoneValid", "rawPhonesPresent", "rawPhoneHrefsMatch", "rawPhoneTextsMatch", "visiblePhonesPresent", "visiblePhonesMatch");
    }
    rememberTeeItUpDelegationFailure(error, diagnostic); throw error;
  }
}
