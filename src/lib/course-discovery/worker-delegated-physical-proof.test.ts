import { describe, expect, it } from "vitest";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor,
  inspectedAdapterSourceEvidence, shouldInvalidateDiscoveryAdapterObservation } from "../../../scripts/automation/course-discovery-worker.mjs";
import { nativeCanonicalRootDocumentProofSchema } from "./native-official-page-attestation";
import { physicalContactDigest, teeItUpPhysicalContactProofSchema } from "./teeitup-physical-contact-proof";
import { parseAccessRecipe } from "./recipe";

function fixture() {
  const official = "https://public-course.example/", document = "https://www.public-course.example/", booking = "https://public-course.book.teeitup.com/";
  const job = { id: "owned-job", sourceFingerprint: "a".repeat(64), attempts: 1, firstPickedUpAt: "2030-10-24T12:00:00.000Z", deadlineAt: "2030-10-24T12:15:00.000Z",
    request: { target: { courseId: "canonical", kind: "OUTDOOR" }, identity: { name: "Public Golf Club and Restaurant", officialUrl: official,
      address: "12 Public Road, Springfield, NC 27601, USA", timeZone: "America/New_York" },
    input: { date: "2030-10-25", players: 2, startTime: "08:00", endTime: "18:00", timeZone: "America/New_York" }, trustedContext: { canonicalCoursePhone: "+19195551234" } } };
  const redirects = [{ fromUrl: official, toUrl: document, status: 301 as const, completed: true as const }];
  const rootDocumentProof = nativeCanonicalRootDocumentProofSchema.parse({ kind: "NATIVE_CANONICAL_ROOT_REDIRECT", canonicalUrl: official, documentUrl: document, redirects,
    witnessSha256: physicalContactDigest({ canonicalUrl: official, documentUrl: document, redirects }) });
  const source = { officialUrl: official, officialDocumentUrl: document, bookingUrl: booking, canonicalName: job.request.identity.name,
    officialBrandName: "Public Golf Club (NC)", publicLocationName: "Public Golf Club", brandLocationLabel: "NC", canonicalNameRelation: "PUBLIC_LOCATION_AND_OBSERVED_SERVICE",
    serviceRemainder: "Restaurant", observedServiceLabel: "Restaurant menu", canonicalAddress: job.request.identity.address,
    officialAddress: job.request.identity.address, canonicalLocality: "springfield", officialLocality: "springfield",
    publicCoursePhone: job.request.trustedContext.canonicalCoursePhone, warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" };
  const semantic = { ...source, kind: "OFFICIAL_PHYSICAL_CONTACT_BINDING_V1", providerName: source.officialBrandName,
    providerAddress: "12 Public Road, Raleigh, NC 27601, US", providerLocality: "raleigh", providerLocalityRelation: "DIFFERENT_RECORDED", sourceWitnessSha256: physicalContactDigest(source) };
  const physicalContactProof = teeItUpPhysicalContactProofSchema.parse({ ...semantic, semanticDigest: physicalContactDigest(semantic) });
  const proof = { kind: "OFFICIAL_DELEGATED_BOOKING_SOURCE", officialUrl: official, bookingUrl: booking, venueName: job.request.identity.name,
    canonicalAddress: job.request.identity.address, timeZone: job.request.input.timeZone, rootWitnessSha256: "b".repeat(64), rootDocumentProof, physicalContactProof,
    hops: [{ pageUrl: document, nextUrl: booking, witnessSha256: "c".repeat(64) }], alias: "public-course", facilityId: 71, courseId: "provider-71",
    providerAddress: physicalContactProof.providerAddress, warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" };
  const adapter = { family: "TEEITUP", alias: "public-course", facilityIds: [71], officialDelegatedBookingProof: proof };
  const proposal = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: job.request.target, source: { officialUrl: official, bookingUrl: booking,
    venueName: job.request.identity.name, venueAddress: job.request.identity.address, providerFamily: "TEEITUP", timeZone: job.request.input.timeZone },
    adapter: { ...adapter, officialDelegatedBookingProof: { forged: true } } };
  const observation = createDiscoveryAdapterObservation(job, booking, adapter, document)!;
  return { official, document, booking, job, proof, adapter, proposal, observation };
}
const bind = (f: ReturnType<typeof fixture>, observation = f.observation, context: string | undefined = f.document) => bindDiscoveryRecipeIdentity(f.proposal, f.job, observation, context);

describe("current native delegated physical proof bridge", () => {
  it("strips model data and adopts the exact current schema-valid native observation", () => {
    const f = fixture();expect(bindDiscoveryRecipeIdentity(f.proposal, f.job).adapter).not.toHaveProperty("officialDelegatedBookingProof");
    const bound = bind(f);expect(bound.adapter.officialDelegatedBookingProof).toEqual(f.proof);expect(parseAccessRecipe(bound)).toEqual(bound);
    expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.document)).toEqual({ officialUrl: f.official, observedBookingUrl: f.booking });
    bound.adapter.officialDelegatedBookingProof.physicalContactProof.publicCoursePhone = "+19195559876";expect(bind(f).adapter.officialDelegatedBookingProof).toEqual(f.proof);
  });
  it.each(["jobId", "officialUrl", "bookingUrl", "contextUrl", "identityKey", "targetKey", "inputKey", "trustedContextKey", "sourceFingerprint", "jobAttempt", "firstPickedUpAt", "deadlineAt"])
  ("rejects foreign current observation binding %s", field => { const f = fixture();expect(bind(f, { ...f.observation, [field]: "foreign" }).adapter).not.toHaveProperty("officialDelegatedBookingProof"); });
  it.each(["attempt", "fingerprint", "pickup", "deadline", "phone", "input"])("cannot reuse a physical proof across changed %s", field => {
    const f = fixture(), recipe = bind(f);
    if (field === "attempt") f.job.attempts++;if (field === "fingerprint") f.job.sourceFingerprint = "d".repeat(64);
    if (field === "pickup") f.job.firstPickedUpAt = "2030-10-24T12:00:01.000Z";if (field === "deadline") f.job.deadlineAt = "2030-10-24T12:15:01.000Z";
    if (field === "phone") f.job.request.trustedContext.canonicalCoursePhone = "+19195559876";if (field === "input") f.job.request.input.players = 3;
    expect(bind(f).adapter).not.toHaveProperty("officialDelegatedBookingProof");expect(inspectedAdapterSourceEvidence(recipe, f.job, f.observation, true, f.document)).toBeUndefined();
  });
  it.each(["rootHash", "rootForeign", "rootIncomplete", "rootFork", "rootExtra", "physicalHash", "sourceHash", "physicalPhone", "physicalCanonical", "physicalDocument", "physicalProvider", "physicalExtra", "extraHop"])
  ("rejects malformed observed optional data %s", change => {
    const f = fixture(), o = structuredClone(f.observation), p = o.adapter.officialDelegatedBookingProof;
    if (change === "rootHash") p.rootDocumentProof.witnessSha256 = "d".repeat(64);
    if (change === "rootForeign") p.rootDocumentProof.redirects[0].toUrl = "https://foreign.example/";
    if (change === "rootIncomplete") p.rootDocumentProof.redirects[0].completed = false;
    if (change === "rootFork") p.rootDocumentProof.redirects.push({ ...p.rootDocumentProof.redirects[0] });
    if (change === "rootExtra") p.rootDocumentProof.secret = "PRIVATE";
    if (change === "physicalHash") p.physicalContactProof.semanticDigest = "d".repeat(64);
    if (change === "sourceHash") p.physicalContactProof.sourceWitnessSha256 = "d".repeat(64);
    if (change === "physicalPhone") p.physicalContactProof.publicCoursePhone = "+19195559876";
    if (change === "physicalCanonical") p.physicalContactProof.canonicalName = "Another course";
    if (change === "physicalDocument") p.physicalContactProof.officialDocumentUrl = "https://www.public-course.example/other/";
    if (change === "physicalProvider") p.physicalContactProof.providerAddress = f.job.request.identity.address;
    if (change === "physicalExtra") p.physicalContactProof.secret = "PRIVATE";
    if (change === "extraHop") p.hops.push({ pageUrl: f.booking, nextUrl: f.document, witnessSha256: "d".repeat(64) });
    expect(bind(f, o).adapter).not.toHaveProperty("officialDelegatedBookingProof");
  });
  it("requires exact context and phone; legacy root-only native observations stay independent from phone", () => {
    const f = fixture();expect(bind(f, f.observation, "https://www.public-course.example/other/").adapter).not.toHaveProperty("officialDelegatedBookingProof");
    delete (f.job.request as { trustedContext?: unknown }).trustedContext;expect(bind(f).adapter).not.toHaveProperty("officialDelegatedBookingProof");
    const root = fixture();delete root.adapter.officialDelegatedBookingProof.physicalContactProof;
    const observation = createDiscoveryAdapterObservation(root.job, root.booking, root.adapter, root.document);expect(bind(root, observation).adapter.officialDelegatedBookingProof.rootDocumentProof).toEqual(root.proof.rootDocumentProof);
    const noRoot = structuredClone(observation);delete noRoot.adapter.officialDelegatedBookingProof.rootDocumentProof;expect(bind(root, noRoot).adapter).not.toHaveProperty("officialDelegatedBookingProof");
  });
  it("redacts nested proof/private phone from model snapshots and invalidates it before every action", () => {
    const f = fixture(), value = createDiscoverySnapshotCompactor()({ adapter: f.adapter, trustedContext: f.job.request.trustedContext });
    expect(value.adapter).not.toHaveProperty("officialDelegatedBookingProof");expect(JSON.stringify(value)).not.toContain(f.job.request.trustedContext.canonicalCoursePhone);
    for (const action of ["open", "observe", "click", "select", "fill", "scroll", "inspect_adapter", "inspect", "finish"])expect(shouldInvalidateDiscoveryAdapterObservation(action, f.observation)).toBe(true);
  });
});
