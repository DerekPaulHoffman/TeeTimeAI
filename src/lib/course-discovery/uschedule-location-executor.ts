import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import { fetchUScheduleRecipeAvailability, prepareUScheduleLocationCatalog } from "@/lib/simulators/providers/uschedule";
import { deriveUScheduleOfficialLocation, parseUScheduleLocationSource, sameUScheduleOfficialSite, type USchedulePublicLocationProof } from "@/lib/simulators/providers/uschedule-location-source";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import type { AccessExecutionInput } from "./recipe";
import { isSafeRecipeUrl } from "./recipe";
import { requestFamilyForUrl } from "./request-family";

type Source = { officialUrl?: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
type Dependencies = { fetch?: typeof fetch; deadlineAt?: Date; officialIdentityPage?: OfficialIdentityPage;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
export type UScheduleLocationMetadata = { family: "USCHEDULE"; tenant: string; serviceId: string; serviceName: string;
  publicLocationProof: USchedulePublicLocationProof };
function fail(code: string): never { throw new Error(code); }
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function signalFor(deps: Dependencies) {
  const remaining = Math.min(120_000, (deps.deadlineAt?.getTime() ?? Date.now() + 120_000) - Date.now());
  if (remaining <= 0) return fail("DEADLINE_EXCEEDED");
  return AbortSignal.timeout(remaining);
}
function bound(source: Source, metadata: UScheduleLocationMetadata) {
  const parsed = parseUScheduleLocationSource(source.bookingUrl), entry = parseUScheduleLocationSource(metadata.publicLocationProof.official.entryUrl);
  if (!source.officialUrl || !source.venueAddress || !parsed || !entry || metadata.tenant !== parsed.tenant ||
      parsed.canonicalUrl !== entry.canonicalUrl || metadata.publicLocationProof.locationId !== entry.locationId ||
      parsed.locationId && parsed.locationId !== entry.locationId || metadata.publicLocationProof.official.venueName !== source.venueName ||
      !sameUScheduleOfficialSite(metadata.publicLocationProof.official.officialPageUrl, source.officialUrl))
    return fail("ADAPTER_IDENTITY_MISMATCH");
}
async function readOfficial(source: Source, metadata: UScheduleLocationMetadata, deps: Dependencies, signal: AbortSignal) {
  bound(source, metadata);
  const expected = metadata.publicLocationProof.official.officialPageUrl;
  if (!isSafeRecipeUrl(expected)) return fail("OFFICIAL_IDENTITY_UNVERIFIED");
  const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl: value => {
    if (value !== expected || !isSafeRecipeUrl(value)) return fail("UNSCOPED_ADAPTER_REQUEST"); return new URL(value);
  }, maxResponseBytes: 600_000, timeoutMs: 15_000, redirectLimit: 0 });
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  try {
    return await queue.run(requestFamilyForUrl(expected), async () => {
      const response = await transport(expected, { method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", signal,
        headers: { accept: "text/html" } });
      try {
        if ([401, 403].includes(response.status)) return fail("ACCESS_REQUIRED");
        if (response.status === 429) return fail("PROVIDER_THROTTLED");
        if (response.status !== 200 || response.headers.has("location") || response.redirected || response.url && response.url !== expected ||
            !/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) return fail("OFFICIAL_IDENTITY_UNVERIFIED");
        const bytes = await response.arrayBuffer(); if (bytes.byteLength > 600_000) return fail("ADAPTER_RESPONSE_LIMIT");
        const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const proof = deriveUScheduleOfficialLocation(source, { url: expected, html }, false);
        if (!equal(proof, metadata.publicLocationProof.official)) return fail("OFFICIAL_IDENTITY_CHANGED");
        return proof;
      } finally { if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {}); }
    });
  } finally { queue.dispose(); }
}

export async function inspectUSchedulePublicLocation(source: Source, deps: Dependencies): Promise<UScheduleLocationMetadata> {
  if (!deps.officialIdentityPage) return fail("OFFICIAL_IDENTITY_UNVERIFIED");
  const official = deriveUScheduleOfficialLocation(source, deps.officialIdentityPage);
  const parsed = parseUScheduleLocationSource(official.entryUrl)!;
  const session = createUSchedulePublicSession(official.entryUrl, { ...deps, officialLocation: official });
  try {
    const prepared = await prepareUScheduleLocationCatalog(official, session.read, signalFor(deps));
    return { family: "USCHEDULE", tenant: parsed.tenant, ...prepared.config.service, publicLocationProof: prepared.config.proof };
  } catch (error) { if (session.failureReason()) return fail(session.failureReason()!); throw error; }
  finally { session.dispose(); }
}

export async function executeUSchedulePublicLocation(source: Source, metadata: UScheduleLocationMetadata,
  target: { courseId: string; offeringId: string }, input: AccessExecutionInput, deps: Dependencies) {
  bound(source, metadata);
  if (input.players > metadata.publicLocationProof.includedPartySize || input.players < 1 || !input.durationMinutes || input.timeZone !== source.timeZone)
    return fail("USCHEDULE_INCLUDED_PARTY_UNSUPPORTED");
  const official = await readOfficial(source, metadata, deps, signalFor(deps));
  const session = createUSchedulePublicSession(official.entryUrl, { ...deps, officialLocation: official });
  try {
    return await fetchUScheduleRecipeAvailability({ date: input.date, durationMinutes: input.durationMinutes, partySize: 1, timeZone: input.timeZone,
      offering: { id: target.offeringId, courseId: target.courseId, bookingUrl: source.bookingUrl, providerFamilyKey: "USCHEDULE", active: true,
        publicAccessStatus: "PUBLIC", providerMetadata: { tenant: metadata.tenant, serviceId: metadata.serviceId },
        maxPartySize: metadata.publicLocationProof.maxPartySize, supportedDurationsMinutes: [input.durationMinutes] } },
    { serviceId: metadata.serviceId, serviceName: metadata.serviceName, publicLocationProof: { ...metadata.publicLocationProof, official } }, session.read);
  } catch (error) { if (session.failureReason()) return fail(session.failureReason()!); throw error; }
  finally { session.dispose(); }
}
