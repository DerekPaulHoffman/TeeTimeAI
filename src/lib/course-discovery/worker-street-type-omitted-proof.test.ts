import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor,
  inspectedAdapterSourceEvidence, readDiscoveryControllerCheckpoint, shouldInvalidateDiscoveryAdapterObservation } from "../../../scripts/automation/course-discovery-worker.mjs";
import { teeItUpStreetTypeOmittedProofSchema } from "./teeitup-street-type-omitted-proof";
import { parseAccessRecipe } from "./recipe";

function fixture() {
  const official = "https://canonical-course.example/", document = "https://www.canonical-course.example/", booking = "https://public-course.book.teeitup.com/";
  const job = { id: "owned-job", sourceFingerprint: "a".repeat(64), attempts: 1, firstPickedUpAt: "2030-10-24T12:00:00.000Z", deadlineAt: "2030-10-24T12:15:00.000Z",
    request: { target: { courseId: "canonical", kind: "OUTDOOR" }, identity: { name: "Canonical Public Golf Course", officialUrl: official,
      address: "12 Public Vista, Springfield, NC 27601, USA", timeZone: "America/New_York" },
    input: { date: "2030-10-25", players: 2, startTime: "08:00", endTime: "18:00", timeZone: "America/New_York" }, trustedContext: { canonicalCoursePhone: "+19195551234" } } };
  const configuration = { apiAlias: "public-api", facilityIds: [71] };
  const proofInput = { kind: "OFFICIAL_STREET_TYPE_OMITTED", officialUrl: official, officialDocumentUrl: document, bookingUrl: booking,
    venueName: job.request.identity.name, canonicalAddress: job.request.identity.address, providerAddress: "12 Public Vista Drive, Springfield, NC 27601, US",
    timeZone: job.request.input.timeZone, alias: "public-course", facilityId: 71, courseId: "provider-71",
    configurationSha256: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"), canonicalStreetType: null, providerStreetType: "dr",
    publicCoursePhone: job.request.trustedContext.canonicalCoursePhone, requiredCapability: "LOCAL_CHROME", warmTransport: "NATIVE_CHROME" };
  const semanticDigest = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(proofInput).sort().map(key => [key, proofInput[key as keyof typeof proofInput]])))).digest("hex");
  const proof = teeItUpStreetTypeOmittedProofSchema.parse({ ...proofInput, semanticDigest });
  const adapter = { family: "TEEITUP", alias: proof.alias, facilityIds: [71], publicBookingConfiguration: configuration, officialStreetTypeOmittedProof: proof };
  const proposal = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "model", kind: "SIMULATOR" }, source: {
    officialUrl: "https://model.example/", bookingUrl: booking, venueName: "Model", venueAddress: "Model address", providerFamily: "TEEITUP", timeZone: "UTC" },
    adapter: { ...adapter, officialStreetTypeOmittedProof: { forged: true } } };
  const observation = createDiscoveryAdapterObservation(job, booking, adapter, document)!;
  return { official, document, booking, job, proof, adapter, proposal, observation };
}
const bind = (f: ReturnType<typeof fixture>, observation = f.observation, context: string | undefined = f.document) => bindDiscoveryRecipeIdentity(f.proposal, f.job, observation, context);

describe("current native street-type omission worker proof", () => {
  it("strips any model proof and adopts only the matching private native observation", () => {
    const f = fixture();expect(bindDiscoveryRecipeIdentity(f.proposal, f.job).adapter).not.toHaveProperty("officialStreetTypeOmittedProof");
    const bound = bind(f);expect(bound.adapter.officialStreetTypeOmittedProof).toEqual(f.proof);expect(parseAccessRecipe(bound)).toEqual(bound);
    expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.document)).toEqual({ officialUrl: f.official, observedBookingUrl: f.booking });
    bound.adapter.officialStreetTypeOmittedProof.publicCoursePhone = "+19195559876";
    expect(bind(f).adapter.officialStreetTypeOmittedProof).toEqual(f.proof);expect(f.proposal.adapter.officialStreetTypeOmittedProof).toEqual({ forged: true });
  });
  it.each(["jobId", "officialUrl", "bookingUrl", "contextUrl", "identityKey", "targetKey", "inputKey", "trustedContextKey", "sourceFingerprint", "jobAttempt", "firstPickedUpAt", "deadlineAt"])
  ("rejects changed current observation binding %s", field => { const f = fixture();expect(bind(f, { ...f.observation, [field]: "foreign" }).adapter).not.toHaveProperty("officialStreetTypeOmittedProof"); });
  it.each(["attempt", "fingerprint", "pickup", "deadline", "input", "phone"])("does not transfer native proof across changed %s", change => {
    const f = fixture(), bound = bind(f);
    if (change === "attempt") f.job.attempts++;
    if (change === "fingerprint") f.job.sourceFingerprint = "c".repeat(64);
    if (change === "pickup") f.job.firstPickedUpAt = "2030-10-24T12:00:01.000Z";
    if (change === "deadline") f.job.deadlineAt = "2030-10-24T12:15:01.000Z";
    if (change === "input") f.job.request.input.players = 3;
    if (change === "phone") f.job.request.trustedContext.canonicalCoursePhone = "+19195559876";
    expect(bind(f).adapter).not.toHaveProperty("officialStreetTypeOmittedProof");expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.document)).toBeUndefined();
  });
  it.each(["https://www.canonical-course.example/other/", "https://foreign.example/", undefined])("requires exact attested document or booking context %s", context => {
    const f = fixture();expect(bindDiscoveryRecipeIdentity(f.proposal, f.job, f.observation, context).adapter).not.toHaveProperty("officialStreetTypeOmittedProof");
  });
  it.each(["kind", "official", "document", "booking", "name", "address", "zone", "phone", "alias", "facility", "configuration", "type", "canonicalType", "digest", "wrongDigest", "transport", "capability", "extra"])
  ("rejects mismatched or malformed observed proof %s", change => {
    const f = fixture(), o = structuredClone(f.observation), p = o.adapter.officialStreetTypeOmittedProof;
    if (change === "kind") p.kind = "OTHER";
    if (change === "official") p.officialUrl = "https://foreign.example/";
    if (change === "document") p.officialDocumentUrl = "https://foreign.example/";
    if (change === "booking") p.bookingUrl = f.document;
    if (change === "name") p.venueName = "Another Course";
    if (change === "address") p.canonicalAddress = p.providerAddress;
    if (change === "zone") p.timeZone = "UTC";
    if (change === "phone") p.publicCoursePhone = "+19195559876";
    if (change === "alias") p.alias = "other";
    if (change === "facility") p.facilityId = 72;
    if (change === "configuration") p.configurationSha256 = "c".repeat(64);
    if (change === "type") p.providerStreetType = "unknown";
    if (change === "canonicalType") p.canonicalStreetType = "dr";
    if (change === "digest") p.semanticDigest = "invalid";
    if (change === "wrongDigest") p.semanticDigest = "b".repeat(64);
    if (change === "transport") p.warmTransport = "PINNED_HTTP";
    if (change === "capability") p.requiredCapability = "SERVER";
    if (change === "extra") p.secret = "PRIVATE";
    expect(bind(f, o).adapter).not.toHaveProperty("officialStreetTypeOmittedProof");
    const multiple = fixture(), observed = structuredClone(multiple.observation);observed.adapter.publicBookingConfiguration.facilityIds = [71, 72];
    multiple.proposal.adapter.publicBookingConfiguration.facilityIds = [71, 72];
    observed.adapter.officialStreetTypeOmittedProof.configurationSha256 = createHash("sha256").update(JSON.stringify(observed.adapter.publicBookingConfiguration)).digest("hex");
    expect(bind(multiple, observed).adapter).not.toHaveProperty("officialStreetTypeOmittedProof");
  });
  it("binds the exact current literal configuration and cannot borrow missing phone or forged root context", () => {
    const f = fixture(), o = structuredClone(f.observation);o.adapter.publicBookingConfiguration.apiAlias = "changed";f.proposal.adapter.publicBookingConfiguration.apiAlias = "changed";
    expect(bind(f, o).adapter).not.toHaveProperty("officialStreetTypeOmittedProof");
    const g = fixture();delete (g.job.request as { trustedContext?: unknown }).trustedContext;expect(bind(g).adapter).not.toHaveProperty("officialStreetTypeOmittedProof");
    const h = fixture();h.observation.contextUrl = "https://foreign.example/";h.observation.adapter.officialStreetTypeOmittedProof.officialDocumentUrl = h.observation.contextUrl;
    expect(bind(h, h.observation, h.observation.contextUrl).adapter).not.toHaveProperty("officialStreetTypeOmittedProof");
  });
  it("redacts proof and phone from model snapshots, never restores observation from checkpoint, and invalidates before every action", () => {
    const f = fixture(), compact = createDiscoverySnapshotCompactor(), value = compact({ adapter: f.adapter, trustedContext: f.job.request.trustedContext });
    expect(value.adapter).not.toHaveProperty("officialStreetTypeOmittedProof");expect(JSON.stringify(value)).not.toContain(f.proof.publicCoursePhone);
    expect(f.adapter.officialStreetTypeOmittedProof).toEqual(f.proof);
    expect(readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: f.official, officialSourceObserved: true, observedNavigationUrls: [f.booking], adapterObservation: f.observation } }, f.official)).not.toHaveProperty("adapterObservation");
    for (const action of ["open", "observe", "click", "select", "fill", "scroll", "inspect_adapter", "inspect", "finish"])
      expect(shouldInvalidateDiscoveryAdapterObservation(action, f.observation)).toBe(true);
    expect(shouldInvalidateDiscoveryAdapterObservation("observe", { adapter: { family: "TEEITUP" } })).toBe(false);
  });
});
