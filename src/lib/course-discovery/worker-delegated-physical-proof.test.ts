import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor,
  inspectedAdapterSourceEvidence, shouldInvalidateDiscoveryAdapterObservation } from "../../../scripts/automation/course-discovery-worker.mjs";
import { nativeCanonicalRootDocumentProofSchema } from "./native-official-page-attestation";
import { physicalContactDigest, teeItUpPhysicalContactProofSchema } from "./teeitup-physical-contact-proof";
import { parseAccessRecipe } from "./recipe";

function fixture(withEntry = false) {
  const official = "https://public-course.example/", document = "https://www.public-course.example/", booking = "https://public-course.book.teeitup.com/";
  const job = { id: "owned-job", sourceFingerprint: "a".repeat(64), attempts: 1, firstPickedUpAt: "2030-10-24T12:00:00.000Z", deadlineAt: "2030-10-24T12:15:00.000Z",
    request: { target: { courseId: "canonical", kind: "OUTDOOR" }, identity: { name: "Public Golf Club and Restaurant", officialUrl: official,
      address: "12 Public Road, Springfield, NC 27601, USA", timeZone: "America/New_York" },
    input: { date: "2030-10-25", players: 2, startTime: "08:00", endTime: "18:00", timeZone: "America/New_York" }, trustedContext: { canonicalCoursePhone: "+19195551234" } } };
  const redirects = [{ fromUrl: official, toUrl: document, status: 301 as const, completed: true as const }];
  const rootDocumentProof = nativeCanonicalRootDocumentProofSchema.parse({ kind: "NATIVE_CANONICAL_ROOT_REDIRECT", canonicalUrl: official, documentUrl: document, redirects,
    witnessSha256: physicalContactDigest({ canonicalUrl: official, documentUrl: document, redirects }) });
  const entry = "https://www.public-course.example/book-public-golf/";
  const source = { officialUrl: official, officialDocumentUrl: document, bookingUrl: booking, ...(withEntry ? { bookingEntryUrl: entry } : {}), canonicalName: job.request.identity.name,
    officialBrandName: "Public Golf Club (NC)", publicLocationName: "Public Golf Club", brandLocationLabel: "NC", canonicalNameRelation: "PUBLIC_LOCATION_AND_OBSERVED_SERVICE",
    serviceRemainder: "Restaurant", observedServiceLabel: "Restaurant menu", canonicalAddress: job.request.identity.address,
    officialAddress: job.request.identity.address, canonicalLocality: "springfield", officialLocality: "springfield",
    publicCoursePhone: job.request.trustedContext.canonicalCoursePhone, warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" };
  const semantic = { ...source, kind: "OFFICIAL_PHYSICAL_CONTACT_BINDING_V1", providerName: source.officialBrandName,
    providerAddress: "12 Public Road, Raleigh, NC 27601, US", providerLocality: "raleigh", providerLocalityRelation: "DIFFERENT_RECORDED", sourceWitnessSha256: physicalContactDigest(source) };
  const physicalContactProof = teeItUpPhysicalContactProofSchema.parse({ ...semantic, semanticDigest: physicalContactDigest(semantic) });
  const proof = { kind: "OFFICIAL_DELEGATED_BOOKING_SOURCE", officialUrl: official, bookingUrl: booking, venueName: job.request.identity.name,
    canonicalAddress: job.request.identity.address, timeZone: job.request.input.timeZone, rootWitnessSha256: "b".repeat(64), rootDocumentProof, physicalContactProof,
    hops: withEntry ? [{ pageUrl: document, nextUrl: entry, witnessSha256: "c".repeat(64) }, { pageUrl: entry, nextUrl: booking, witnessSha256: "d".repeat(64) }] :
      [{ pageUrl: document, nextUrl: booking, witnessSha256: "c".repeat(64) }], alias: "public-course", facilityId: 71, courseId: "provider-71",
    providerAddress: physicalContactProof.providerAddress, warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" };
  const adapter = { family: "TEEITUP", alias: "public-course", facilityIds: [71], officialDelegatedBookingProof: proof };
  const proposal = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: job.request.target, source: { officialUrl: official, bookingUrl: booking,
    venueName: job.request.identity.name, venueAddress: job.request.identity.address, providerFamily: "TEEITUP", timeZone: job.request.input.timeZone },
    adapter: { ...adapter, officialDelegatedBookingProof: { forged: true } } };
  const observation = createDiscoveryAdapterObservation(job, booking, adapter, document)!;
  return { official, document, booking, entry, job, proof, adapter, proposal, observation };
}
const bind = (f: ReturnType<typeof fixture>, observation = f.observation, context: string | undefined = f.document) => bindDiscoveryRecipeIdentity(f.proposal, f.job, observation, context);

function locationFixture() {
  const official = "https://example.org/Locations/Example", booking = "https://clients.uschedule.com/examplegolf/booking?filter=loc[82]";
  const job = { id: "location-job", sourceFingerprint: "a".repeat(64), attempts: 1, firstPickedUpAt: "2030-10-24T12:00:00.000Z", deadlineAt: "2030-10-24T12:15:00.000Z",
    request: { target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, identity: { officialUrl: official, name: "Example Golf Club", address: "10 Main Drive, Suite C, Example, WA 98000, USA" },
      input: { date: "2030-10-25", players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00", timeZone: "America/Los_Angeles" },
      trustedContext: { canonicalCoursePhone: "+14255550123" } } };
  const proof = { kind: "PUBLIC_LOCATION_SERVICE_POOL_V1", official: { kind: "OFFICIAL_PUBLIC_LOCATION_CONTACT_V1", officialPageUrl: official, entryUrl: booking, locationId: "82",
    venueName: job.request.identity.name, addressKey: "complete physical address with suite", locality: "example", region: "WA",
    phoneSha256: createHash("sha256").update(JSON.stringify(job.request.trustedContext.canonicalCoursePhone)).digest("hex"), markupWitnessSha256: "b".repeat(64) },
    locationId: "82", locationName: "Example - Example Golf Club", serviceId: "72", serviceName: "Simulator Rental - Example", catalogHash: "c".repeat(64), maxPartySize: null,
    client: { path: "/bundles/js/bookingBS5", sha256: "569c4665e02740090f39df0a016d0f6087edafce318836e62f876db5f9865a0e" } };
  const adapter = { family: "USCHEDULE", tenant: "examplegolf", serviceId: "72", serviceName: proof.serviceName, publicLocationProof: proof };
  const proposal = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: job.request.target, source: { officialUrl: official, bookingUrl: booking,
    venueName: job.request.identity.name, venueAddress: job.request.identity.address, providerFamily: "USCHEDULE", timeZone: job.request.input.timeZone }, adapter };
  return { job, official, booking, adapter, proposal, observation: createDiscoveryAdapterObservation(job, booking, adapter, official)! };
}

describe("current native USchedule contact observation bridge", () => {
  it("strips generated contact proof and adopts only the matching private current inspection", () => {
    const f = locationFixture();
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job).adapter).not.toHaveProperty("publicLocationProof");
    const generated = structuredClone(f.proposal); generated.adapter.publicLocationProof.official.phoneSha256 = "f".repeat(64);
    const bound = bindDiscoveryRecipeIdentity(generated, f.job, f.observation, f.official);
    expect(bound.adapter.publicLocationProof).toEqual(f.adapter.publicLocationProof); expect(parseAccessRecipe(bound)).toEqual(bound);
    expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.official)).toEqual({ officialUrl: f.official, observedBookingUrl: f.booking });
  });
  it.each(["jobId", "officialUrl", "bookingUrl", "contextUrl", "identityKey", "targetKey", "inputKey", "trustedContextKey", "sourceFingerprint", "jobAttempt", "firstPickedUpAt", "deadlineAt"])
  ("rejects foreign/stale %s from contact inspection", field => {
    const f = locationFixture(), observation = { ...f.observation, [field]: "foreign" };
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job, observation, f.official).adapter).not.toHaveProperty("publicLocationProof");
    expect(inspectedAdapterSourceEvidence(f.proposal, f.job, observation, true, f.official)).toBeUndefined();
  });
  it.each(["phone", "absent phone", "raw phone hash", "entry", "name"])("rejects %s without adopting serialized contact authority", change => {
    const f = locationFixture(), observation = structuredClone(f.observation);
    if (change === "phone") f.job.request.trustedContext.canonicalCoursePhone = "+14255550124";
    if (change === "absent phone") delete (f.job.request as { trustedContext?: unknown }).trustedContext;
    if (change === "raw phone hash") observation.adapter.publicLocationProof.official.phoneSha256 = createHash("sha256").update("+14255550123").digest("hex");
    if (change === "entry") observation.adapter.publicLocationProof.official.entryUrl = "https://clients.uschedule.com/othergolf/booking?filter=loc[82]";
    if (change === "name") observation.adapter.publicLocationProof.official.venueName = "Other Golf Club";
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job, observation, f.official).adapter).not.toHaveProperty("publicLocationProof");
  });
  it("keeps contact witnesses out of model snapshots and invalidates them before another action", () => {
    const f = locationFixture(), output = createDiscoverySnapshotCompactor()({ adapter: f.adapter, trustedContext: f.job.request.trustedContext });
    expect(output.adapter).not.toHaveProperty("publicLocationProof"); expect(output).not.toHaveProperty("trustedContext");
    expect(JSON.stringify(output)).not.toContain(f.adapter.publicLocationProof.official.phoneSha256);
    expect(shouldInvalidateDiscoveryAdapterObservation("observe", f.observation)).toBe(true);
  });
  it("preserves the old public-location profile and its observation rules", () => {
    const f = locationFixture(), legacy = { ...f.adapter, publicLocationProof: { kind: "PUBLIC_LOCATION_RENTAL_V1" } };
    const proposal = { ...f.proposal, adapter: legacy };
    expect(bindDiscoveryRecipeIdentity(proposal, f.job).adapter).toEqual(legacy);
    const observation = createDiscoveryAdapterObservation(f.job, f.booking, legacy, f.official)!;
    expect(observation).not.toHaveProperty("jobAttempt"); expect(shouldInvalidateDiscoveryAdapterObservation("observe", observation)).toBe(false);
    expect(createDiscoverySnapshotCompactor()({ adapter: legacy }).adapter).toEqual(legacy);
  });
});

describe("current native delegated physical proof bridge", () => {
  it("adopts the typed final native iframe edge only from the exact current observation", () => {
    const f = fixture(true), hop = { ...f.proof.hops[1], kind: "NATIVE_VISIBLE_IFRAME_SRC" };
    hop.witnessSha256 = createHash("sha256").update(JSON.stringify({ pageUrl: hop.pageUrl, nextUrl: hop.nextUrl, kind: hop.kind })).digest("hex");
    Object.assign(f.proof.hops[1], hop);
    const observation = createDiscoveryAdapterObservation(f.job, f.booking, f.adapter, f.entry)!;
    const bound = bind(f, observation, f.entry);
    expect(bound.adapter.officialDelegatedBookingProof).toEqual(f.proof);
    expect(parseAccessRecipe(bound)).toEqual(bound);
    expect(inspectedAdapterSourceEvidence(bound, f.job, observation, true, f.entry)).toEqual({ officialUrl: f.official, observedBookingUrl: f.booking });
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job).adapter).not.toHaveProperty("officialDelegatedBookingProof");
  });
  it("requires current attempt and original clocks for iframe edges even without optional physical or redirect data", () => {
    const f = fixture(true), p = f.adapter.officialDelegatedBookingProof;
    delete p.physicalContactProof; delete p.rootDocumentProof; p.hops[0].pageUrl = f.official;
    const hop = { ...p.hops[1], kind: "NATIVE_VISIBLE_IFRAME_SRC" };
    hop.witnessSha256 = createHash("sha256").update(JSON.stringify({ pageUrl: hop.pageUrl, nextUrl: hop.nextUrl, kind: hop.kind })).digest("hex");
    Object.assign(p.hops[1], hop);
    const observation = createDiscoveryAdapterObservation(f.job, f.booking, f.adapter, f.entry)!;
    expect(observation.jobAttempt).toBe(f.job.attempts); expect(observation.sourceFingerprint).toBe(f.job.sourceFingerprint);
    expect(bind(f, observation, f.entry).adapter.officialDelegatedBookingProof).toEqual(p);
    for (const key of ["jobAttempt", "sourceFingerprint", "firstPickedUpAt", "deadlineAt"]) {
      expect(bind(f, { ...observation, [key]: "changed" }, f.entry).adapter).not.toHaveProperty("officialDelegatedBookingProof");
    }
  });
  it.each(["firstHop", "directHop", "unknownKind", "hash", "anchorHash", "extra", "foreignAlias", "query", "fragment", "path", "port", "insecure", "nonfinal"])
  ("rejects typed iframe edge %s rather than treating it as an anchor", change => {
    const f = fixture(true), o = structuredClone(f.observation), p = o.adapter.officialDelegatedBookingProof;
    const hop = p.hops[change === "firstHop" ? 0 : 1];
    hop.kind = "NATIVE_VISIBLE_IFRAME_SRC";
    if (change === "directHop") { p.hops = [{ ...hop, pageUrl: f.document }]; }
    if (change === "unknownKind") hop.kind = "MODEL_FRAME";
    if (change === "extra") hop.secret = "PRIVATE";
    if (change === "nonfinal") p.bookingUrl = "https://public-course.book.teeitup.golf/";
    if (["foreignAlias", "query", "fragment", "path", "port", "insecure"].includes(change)) {
      const url = { foreignAlias: "https://other-course.book.teeitup.com/", query: f.booking + "?date=2030-10-25", fragment: f.booking + "#booking",
        path: f.booking + "availability", port: "https://public-course.book.teeitup.com:444/", insecure: f.booking.replace("https:", "http:") }[change]!;
      hop.nextUrl = url;
      p.bookingUrl = url; o.bookingUrl = url; f.proposal.source.bookingUrl = url;
      p.physicalContactProof.bookingUrl = url;
      const nonSource = new Set(["kind", "providerName", "providerAddress", "providerLocality", "providerLocalityRelation", "sourceWitnessSha256", "semanticDigest"]);
      p.physicalContactProof.sourceWitnessSha256 = physicalContactDigest(Object.fromEntries(Object.entries(p.physicalContactProof).filter(([key]) => !nonSource.has(key))));
      p.physicalContactProof.semanticDigest = physicalContactDigest(Object.fromEntries(Object.entries(p.physicalContactProof).filter(([key]) => key !== "semanticDigest")));
    }
    hop.witnessSha256 = change === "hash" ? "e".repeat(64) : change === "anchorHash" ?
      createHash("sha256").update(JSON.stringify({ pageUrl: hop.pageUrl, nextUrl: hop.nextUrl })).digest("hex") :
      createHash("sha256").update(JSON.stringify({ pageUrl: hop.pageUrl, nextUrl: hop.nextUrl, kind: hop.kind })).digest("hex");
    expect(bind(f, o).adapter).not.toHaveProperty("officialDelegatedBookingProof");
  });
  it("adopts only the exact native two-hop entry and retains its source and semantic digests", () => {
    const f = fixture(true), bound = bind(f);
    expect(bound.adapter.officialDelegatedBookingProof).toEqual(f.proof);
    expect(parseAccessRecipe(bound)).toEqual(bound);
    expect(bind(f, createDiscoveryAdapterObservation(f.job, f.booking, f.adapter, f.entry), f.entry).adapter.officialDelegatedBookingProof).toEqual(f.proof);
    expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.document)).toEqual({ officialUrl: f.official, observedBookingUrl: f.booking });
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job).adapter).not.toHaveProperty("officialDelegatedBookingProof");
  });
  it.each(["entry", "final", "document", "private", "querySecret", "oneHop", "fork", "thirdHop", "missingEntry", "sourceHash", "semanticHash"])
  ("rejects nonbinding two-hop physical entry %s even with freshly recomputed data hashes", change => {
    const f = fixture(true), o = structuredClone(f.observation), p = o.adapter.officialDelegatedBookingProof, physical = p.physicalContactProof;
    if (change === "entry") physical.bookingEntryUrl = "https://www.public-course.example/another-entry/";
    if (change === "final") physical.bookingEntryUrl = f.booking;
    if (change === "document") physical.bookingEntryUrl = f.document;
    if (change === "private") physical.bookingEntryUrl = "https://127.0.0.1/book/";
    if (change === "querySecret") physical.bookingEntryUrl = `${f.entry}?token=secret`;
    if (change === "oneHop") p.hops = [{ pageUrl: f.document, nextUrl: f.booking, witnessSha256: "c".repeat(64) }];
    if (change === "fork") p.hops[1].pageUrl = "https://www.public-course.example/another-entry/";
    if (change === "thirdHop") p.hops.splice(1, 0, { pageUrl: f.entry, nextUrl: f.entry, witnessSha256: "c".repeat(64) });
    if (change === "missingEntry") delete physical.bookingEntryUrl;
    const nonSource = new Set(["kind", "providerName", "providerAddress", "providerLocality", "providerLocalityRelation", "sourceWitnessSha256", "semanticDigest"]);
    const source = Object.fromEntries(Object.entries(physical).filter(([key]) => !nonSource.has(key)));
    physical.sourceWitnessSha256 = change === "sourceHash" ? "e".repeat(64) : physicalContactDigest(source);
    const semantic = Object.fromEntries(Object.entries(physical).filter(([key]) => key !== "semanticDigest"));
    physical.semanticDigest = change === "semanticHash" ? "f".repeat(64) : physicalContactDigest(semantic);
    expect(bind(f, o).adapter).not.toHaveProperty("officialDelegatedBookingProof");
  });
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
