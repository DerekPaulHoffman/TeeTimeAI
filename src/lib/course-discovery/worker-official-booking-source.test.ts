import { describe, expect, it } from "vitest";
import {
  bindDiscoveryRecipeIdentity,
  createDiscoveryAdapterObservation,
  readDiscoveryControllerCheckpoint,
} from "../../../scripts/automation/course-discovery-worker.mjs";
import { parseAccessRecipe } from "./recipe";
import { teeItUpOfficialBookingSourceProofSchema } from "./teeitup-official-booking-source";

function fixture() {
  const bookingUrl = "https://example-ridge.book.teeitup.com/";
  const job = { id: "current-job", request: {
    target: { courseId: "canonical-course", kind: "OUTDOOR" },
    identity: { name: "Example Ridge Golf Club", officialUrl: "https://example-ridge.org/",
      address: "12 Public Road, Springfield, NC 27601, USA", providerFamily: "TEEITUP", timeZone: "America/New_York" },
    input: { date: "2026-10-23", players: 2, timeZone: "America/New_York", startTime: "08:00", endTime: "18:00" },
  } };
  const proof = teeItUpOfficialBookingSourceProofSchema.parse({ kind: "OFFICIAL_BOOKING_SOURCE",
    officialUrl: job.request.identity.officialUrl, officialDocumentUrl: "https://www.example-ridge.org/",
    bookingPageUrl: "https://www.example-ridge.org/tee-times/", iframeEntryUrl: "https://example-ridge.play.teeitup.com/",
    bookingSourceUrl: bookingUrl, homeWitnessSha256: "a".repeat(64), pageWitnessSha256: "b".repeat(64), iframeRedirectStatus: 302,
    initialVisibility: "RENDERED_CONTROLLER_OBSERVATION", warmVisibility: "INERT_ANCESTRY_ONLY_EXTERNAL_CSS_NOT_REFRESHED",
    alias: "example-ridge", facilityId: 7, courseId: "public-course-7", venueName: job.request.identity.name,
    timeZone: job.request.input.timeZone, canonicalAddress: job.request.identity.address,
    providerAddress: "34 Public Road, Springfield, NC 27601, US", providerAddressVerified: false });
  const adapter = { family: "TEEITUP", alias: proof.alias, facilityIds: [proof.facilityId], officialBookingSourceProof: proof };
  const proposed = { schemaVersion: 1, engine: "EXISTING_ADAPTER",
    target: { courseId: "model-course", kind: "SIMULATOR" },
    source: { bookingUrl, officialUrl: "https://model.example.org/", venueName: "Model supplied name",
      venueAddress: "Model supplied address", providerFamily: "TEEITUP", timeZone: "UTC" },
    adapter: { family: "TEEITUP", alias: proof.alias, facilityIds: [proof.facilityId], officialBookingSourceProof: { forged: true } },
  };
  const observation = createDiscoveryAdapterObservation(job, bookingUrl, adapter, bookingUrl);
  if (!observation) throw new Error("FIXTURE_OBSERVATION_MISSING");
  return { job, bookingUrl, proof, adapter, proposed, observation };
}
type Fixture = ReturnType<typeof fixture>;
const bind = (value: Fixture, context = value.bookingUrl) => bindDiscoveryRecipeIdentity(value.proposed, value.job, value.observation, context);

describe("worker official booking source authority", () => {
  it("strips all model-supplied source proofs without a current private observation", () => {
    const f = fixture();
    const proposed = { ...f.proposed, adapter: { ...f.proposed.adapter, officialIdentityProof: { forged: "old proof" } } };
    const result = bindDiscoveryRecipeIdentity(proposed, f.job, undefined, f.bookingUrl);
    expect(result.adapter).not.toHaveProperty("officialBookingSourceProof");
    expect(result.adapter).not.toHaveProperty("officialIdentityProof");
    expect(proposed.adapter.officialBookingSourceProof).toEqual({ forged: true });
    expect(proposed.adapter.officialIdentityProof).toEqual({ forged: "old proof" });
  });

  it("restores the inspected proof and canonical job identity before actual recipe validation", () => {
    const f = fixture(), result = bind(f);
    expect(result.target).toEqual(f.job.request.target);
    expect(result.source).toEqual({ bookingUrl: f.bookingUrl, officialUrl: f.job.request.identity.officialUrl,
      venueName: f.job.request.identity.name, venueAddress: f.job.request.identity.address,
      providerFamily: "TEEITUP", timeZone: f.job.request.input.timeZone });
    expect(result.adapter.officialBookingSourceProof).toEqual(f.proof);
    expect(result.adapter.officialBookingSourceProof).not.toBe(f.observation.adapter.officialBookingSourceProof);
    expect(parseAccessRecipe(result)).toEqual(result);
    expect(f.proposed.adapter.officialBookingSourceProof).toEqual({ forged: true });
  });

  it("compares canonical data rather than object property insertion order", () => {
    const f = fixture();
    f.proposed.adapter = { facilityIds: [7], alias: f.proof.alias, family: "TEEITUP", officialBookingSourceProof: { forged: true } };
    expect(bind(f).adapter.officialBookingSourceProof).toEqual(f.proof);
  });

  it.each([
    ["job", (f: Fixture) => { f.job.id = "different-job"; }],
    ["course target", (f: Fixture) => { f.job.request.target.courseId = "different-course"; }],
    ["simulator target", (f: Fixture) => { f.job.request.target.kind = "SIMULATOR"; }],
    ["official URL", (f: Fixture) => { f.job.request.identity.officialUrl = "https://other-course.org/"; }],
    ["canonical name", (f: Fixture) => { f.job.request.identity.name = "Another Golf Club"; }],
    ["canonical address", (f: Fixture) => { f.job.request.identity.address = "99 Other Road, Springfield, NC 27601, USA"; }],
    ["identity zone", (f: Fixture) => { f.job.request.identity.timeZone = "America/Chicago"; }],
    ["provider family", (f: Fixture) => { f.job.request.identity.providerFamily = "FOREUP"; }],
    ["requested date", (f: Fixture) => { f.job.request.input.date = "2026-10-24"; }],
    ["requested players", (f: Fixture) => { f.job.request.input.players = 3; }],
    ["requested zone", (f: Fixture) => { f.job.request.input.timeZone = "America/Chicago"; }],
    ["requested start", (f: Fixture) => { f.job.request.input.startTime = "09:00"; }],
    ["requested end", (f: Fixture) => { f.job.request.input.endTime = "17:00"; }],
    ["booking URL", (f: Fixture) => { f.proposed.source.bookingUrl = "https://other.book.teeitup.com/"; }],
    ["adapter family", (f: Fixture) => { f.proposed.adapter.family = "FOREUP"; }],
    ["adapter alias", (f: Fixture) => { f.proposed.adapter.alias = "another-alias"; }],
    ["adapter facility", (f: Fixture) => { f.proposed.adapter.facilityIds = [8]; }],
    ["additional facility", (f: Fixture) => { f.proposed.adapter.facilityIds = [7, 8]; }],
  ] as const)("never transfers a current observation across changed %s", (_label, mutate) => {
    const f = fixture(); mutate(f);
    expect(bind(f).adapter).not.toHaveProperty("officialBookingSourceProof");
  });

  it.each([undefined, "https://example-ridge.org/", "https://example-ridge.book.teeitup.com/teetimes",
    "https://example-ridge.book.teeitup.com/?date=2026-10-23", "https://example-ridge.book.teeitup.com/#other",
    "https://example-ridge.play.teeitup.com/"])("requires the exact current inspected booking context: %s", context => {
    const f = fixture();
    expect(bindDiscoveryRecipeIdentity(f.proposed, f.job, f.observation, context).adapter).not.toHaveProperty("officialBookingSourceProof");
  });

  it.each(["jobId", "officialUrl", "bookingUrl", "contextUrl", "identityKey", "targetKey", "inputKey"])(
    "rejects an observation with changed %s", key => {
      const f = fixture();
      const observation = { ...f.observation, [key]: "changed" };
      expect(bindDiscoveryRecipeIdentity(f.proposed, f.job, observation, f.bookingUrl).adapter).not.toHaveProperty("officialBookingSourceProof");
    });

  it.each([
    ["kind", "OTHER_PROOF"], ["officialUrl", "https://other-course.org/"], ["bookingSourceUrl", "https://other.book.teeitup.com/"],
    ["alias", "other"], ["facilityId", 8], ["courseId", ""], ["courseId", 7], ["courseId", "a".repeat(129)],
    ["venueName", "Different Club"], ["canonicalAddress", "Different address"], ["timeZone", "America/Chicago"], ["providerAddressVerified", true],
  ])("does not copy a controller proof with mismatched %s", (key, value) => {
    const f = fixture();
    f.observation.adapter.officialBookingSourceProof[key] = value;
    expect(bind(f).adapter).not.toHaveProperty("officialBookingSourceProof");
  });

  it.each([{ label: "null", value: null }, { label: "array", value: [] }, { label: "string", value: "malformed" },
    { label: "partial", value: { kind: "OFFICIAL_BOOKING_SOURCE" } }])("does not promote malformed observed proof $label", ({ value }) => {
    const f = fixture(); f.observation.adapter.officialBookingSourceProof = value;
    expect(bind(f).adapter).not.toHaveProperty("officialBookingSourceProof");
  });

  it("bounds the copy and cannot borrow a second facility from another inspection", () => {
    const f = fixture();
    f.observation.adapter.officialBookingSourceProof.padding = "a".repeat(16_001);
    expect(bind(f).adapter).not.toHaveProperty("officialBookingSourceProof");
    const other = fixture();
    other.observation.adapter.facilityIds = [7, 8];
    expect(bind(other).adapter).not.toHaveProperty("officialBookingSourceProof");
  });

  it("deep copies both observation input and restored proof, isolating later mutations", () => {
    const f = fixture();
    f.adapter.facilityIds[0] = 99; f.proof.courseId = "changed-after-observation";
    expect(f.observation.adapter.facilityIds).toEqual([7]);
    expect(f.observation.adapter.officialBookingSourceProof.courseId).toBe("public-course-7");
    const result = bind(f); result.adapter.officialBookingSourceProof.courseId = "changed-after-binding";
    expect(bind(f).adapter.officialBookingSourceProof.courseId).toBe("public-course-7");
  });

  it("never revives the private proof observation from a persisted checkpoint", () => {
    const f = fixture();
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: f.job.request.identity.officialUrl,
      officialSourceObserved: true, observedNavigationUrls: [f.bookingUrl], adapterObservation: f.observation } }, f.job.request.identity.officialUrl);
    expect(restored).not.toHaveProperty("adapterObservation");
    expect(bindDiscoveryRecipeIdentity(f.proposed, f.job, undefined, f.bookingUrl).adapter).not.toHaveProperty("officialBookingSourceProof");
  });
});
