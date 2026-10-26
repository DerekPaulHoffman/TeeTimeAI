import { describe, expect, it } from "vitest";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor,
  inspectedAdapterSourceEvidence, readDiscoveryControllerCheckpoint } from "../../../scripts/automation/course-discovery-worker.mjs";
import { parseAccessRecipe } from "./recipe";
import { teeItUpDelegatedBookingProofSchema } from "./teeitup-delegated-booking-source";

function fixture() {
  const root = "https://canonical-course.example/", operator = "https://public-operator.example/public-times/", booking = "https://public-course.book.teeitup.com/";
  const job = { id: "owned-job", request: { target: { courseId: "canonical", kind: "OUTDOOR" },
    identity: { name: "Canonical Public Golf Club", officialUrl: root, address: "12 Public Road, Springfield, NC 27601, USA", timeZone: "America/New_York" },
    input: { date: "2030-10-24", players: 2, startTime: "08:00", endTime: "18:00", timeZone: "America/New_York" }, trustedContext: { canonicalCoursePhone: "+19195551234" } } };
  const proof = teeItUpDelegatedBookingProofSchema.parse({ kind: "OFFICIAL_DELEGATED_BOOKING_SOURCE", officialUrl: root, bookingUrl: booking,
    venueName: job.request.identity.name, canonicalAddress: job.request.identity.address, timeZone: job.request.input.timeZone,
    rootWitnessSha256: "a".repeat(64), hops: [{ pageUrl: root, nextUrl: operator, witnessSha256: "b".repeat(64) }, { pageUrl: operator, nextUrl: booking, witnessSha256: "c".repeat(64) }],
    alias: "public-course", facilityId: 71, courseId: "provider-71", providerAddress: "12 Public Road, Springfield, NC 27601, US", warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" });
  const adapter = { family: "TEEITUP", alias: proof.alias, facilityIds: [71], officialDelegatedBookingProof: proof };
  const proposal = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "model-target", kind: "SIMULATOR" },
    source: { bookingUrl: booking, officialUrl: "https://model.example/", venueName: "Model name", venueAddress: "Model address", providerFamily: "TEEITUP", timeZone: "UTC" },
    adapter: { family: "TEEITUP", alias: proof.alias, facilityIds: [71], officialDelegatedBookingProof: { forged: true } } };
  const observation = createDiscoveryAdapterObservation(job, booking, adapter, operator)!;
  return { root, operator, booking, job, adapter, proof, proposal, observation };
}
const bind = (f: ReturnType<typeof fixture>, observation = f.observation, context: string | undefined = f.operator) => bindDiscoveryRecipeIdentity(f.proposal, f.job, observation, context);

describe("worker native delegated booking proof", () => {
  it("strips model evidence and adopts only the matching private observation before typed recipe validation", () => {
    const f = fixture();
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job).adapter).not.toHaveProperty("officialDelegatedBookingProof");
    const bound = bind(f); expect(bound.adapter.officialDelegatedBookingProof).toEqual(f.proof); expect(parseAccessRecipe(bound)).toEqual(bound);
    expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.operator)).toEqual({ officialUrl: f.root, observedBookingUrl: f.booking });
    expect(f.proposal.adapter.officialDelegatedBookingProof).toEqual({ forged: true });
    bound.adapter.officialDelegatedBookingProof.hops[0].nextUrl = "https://changed.example/";
    expect(bind(f).adapter.officialDelegatedBookingProof).toEqual(f.proof);
  });
  it.each(["jobId", "officialUrl", "bookingUrl", "contextUrl", "identityKey", "targetKey", "inputKey", "trustedContextKey"])("rejects a changed current observation binding: %s", field => {
    const f = fixture(); expect(bind(f, { ...f.observation, [field]: "foreign" }).adapter).not.toHaveProperty("officialDelegatedBookingProof");
  });
  it("does not transfer a proof to changed demand or private context, and exact source evidence rechecks context", () => {
    const f = fixture(); f.job.request.input.players = 3; expect(bind(f).adapter).not.toHaveProperty("officialDelegatedBookingProof");
    const g = fixture(), bound = bind(g); g.job.request.trustedContext.canonicalCoursePhone = "+19195559876";
    expect(bind(g).adapter).not.toHaveProperty("officialDelegatedBookingProof");
    expect(inspectedAdapterSourceEvidence(bound, g.job, g.observation, true, g.operator)).toBeUndefined();
  });
  it.each(["https://public-operator.example/other/", "https://public-course.book.teeitup.com/?other=1", undefined])("requires an exact validated hop or booking context: %s", context => {
    const f = fixture(); expect(bindDiscoveryRecipeIdentity(f.proposal, f.job, f.observation, context).adapter).not.toHaveProperty("officialDelegatedBookingProof");
  });
  it.each(["kind", "root", "booking", "name", "address", "zone", "alias", "facility", "capability", "transport", "rootHash", "hopHash", "hopGap", "cycle", "thirdHop", "extra"])("rejects malformed or mismatched private proof: %s", change => {
    const f = fixture(), observation = structuredClone(f.observation), proof = observation.adapter.officialDelegatedBookingProof;
    if (change === "kind") proof.kind = "OTHER";
    if (change === "root") proof.officialUrl = f.operator;
    if (change === "booking") proof.bookingUrl = f.operator;
    if (change === "name") proof.venueName = "Other course";
    if (change === "address") proof.canonicalAddress = "Other address";
    if (change === "zone") proof.timeZone = "UTC";
    if (change === "alias") proof.alias = "other";
    if (change === "facility") proof.facilityId = 72;
    if (change === "capability") proof.requiredCapability = "SERVER_HTTP";
    if (change === "transport") proof.warmTransport = "PINNED_HTTP";
    if (change === "rootHash") proof.rootWitnessSha256 = "invalid";
    if (change === "hopHash") proof.hops[0].witnessSha256 = "invalid";
    if (change === "hopGap") proof.hops[1].pageUrl = f.root;
    if (change === "cycle") proof.hops[0].nextUrl = f.root;
    if (change === "thirdHop") proof.hops.push({ ...proof.hops[1] });
    if (change === "extra") proof.private = "DO_NOT_ADOPT";
    expect(bind(f, observation).adapter).not.toHaveProperty("officialDelegatedBookingProof");
  });
  it("redacts private native proof from every model snapshot without mutating controller evidence or restoring it from a checkpoint", () => {
    const f = fixture(), compact = createDiscoverySnapshotCompactor();
    expect(compact({ adapter: f.adapter }).adapter).not.toHaveProperty("officialDelegatedBookingProof");
    expect(f.adapter.officialDelegatedBookingProof).toEqual(f.proof);
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: f.root, officialSourceObserved: true, observedNavigationUrls: [f.booking], adapterObservation: f.observation } }, f.root);
    expect(restored).not.toHaveProperty("adapterObservation");
  });
});
