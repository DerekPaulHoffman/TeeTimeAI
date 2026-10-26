import { describe, expect, it } from "vitest";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor, inspectedAdapterSourceEvidence, shouldInvalidateDiscoveryAdapterObservation } from "../../../scripts/automation/course-discovery-worker.mjs";
import { foreupOfficialRouteOwnershipProofSchema, foreupOwnershipDigest } from "./foreup-official-route-ownership";
import { parseAccessRecipe } from "./recipe";
function fixture() {
  const official = "https://official.example/", booking = "https://foreupsoftware.com/index.php/booking/12345/456#/teetimes";
  const job = { id: "owned", sourceFingerprint: "a".repeat(64), attempts: 1, firstPickedUpAt: "2030-01-01T12:00:00.000Z", deadlineAt: "2030-01-01T12:15:00.000Z",
    request: { identity: { name: "Example Golf Course", address: "10 Example Road, Example, NY 12345, USA", officialUrl: official, timeZone: "America/New_York" },
      target: { courseId: "owned-course", kind: "OUTDOOR" }, input: { date: "2030-01-02", players: 2, startTime: "08:00", endTime: "18:00", timeZone: "America/New_York" }, trustedContext: { canonicalCoursePhone: "+15555550123" } } };
  const source = { officialUrl: official, officialDocumentUrl: official, bookingUrl: booking, venueName: job.request.identity.name, officialTitle: "Example | County", publicLocationName: "Example",
    canonicalAddress: job.request.identity.address, timeZone: job.request.input.timeZone, publicCoursePhone: job.request.trustedContext.canonicalCoursePhone, requiredCapability: "LOCAL_CHROME", warmTransport: "NATIVE_CHROME" };
  const provider = { providerName: "Example Park Golf Course", sheetTitle: "Example East", providerAddress: "10 Example Rd, Example, NY 12345, US", facilityId: 12345, scheduleId: 456, bookingClassId: 12 };
  const body = { kind: "OFFICIAL_FOREUP_ROUTE_OWNERSHIP_V1", ...source, ...provider, sourceWitnessSha256: foreupOwnershipDigest(source), providerWitnessSha256: foreupOwnershipDigest({ ...provider, phone: source.publicCoursePhone, timeZone: source.timeZone }) };
  const proof = foreupOfficialRouteOwnershipProofSchema.parse({ ...body, semanticDigest: foreupOwnershipDigest(body) });
  const adapter = { family: "FOREUP", facilityId: 12345, scheduleId: 456, bookingClassId: 12, officialRouteOwnershipProof: proof };
  const proposal = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: job.request.target, source: { officialUrl: official, bookingUrl: booking, venueName: job.request.identity.name, venueAddress: job.request.identity.address, timeZone: job.request.input.timeZone, providerFamily: "FOREUP" }, adapter: { ...adapter, officialRouteOwnershipProof: { forged: true } } };
  const observation = createDiscoveryAdapterObservation(job, booking, adapter, official)!;
  return { job, adapter, proof, proposal, observation, official, booking };
}
const bind = (f: ReturnType<typeof fixture>, observation = f.observation) => bindDiscoveryRecipeIdentity(f.proposal, f.job, observation, f.official);
describe("current native ForeUP ownership bridge", () => {
  it("strips model proof and re-adopts only the exact current inspector observation", () => {
    const f = fixture();expect(bindDiscoveryRecipeIdentity(f.proposal, f.job).adapter).not.toHaveProperty("officialRouteOwnershipProof");
    const bound = bind(f);expect(bound.adapter.officialRouteOwnershipProof).toEqual(f.proof);expect(parseAccessRecipe(bound)).toEqual(bound);
    expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.official)).toEqual({ officialUrl: f.official, observedBookingUrl: f.booking });
  });
  it.each(["jobId","officialUrl","bookingUrl","contextUrl","identityKey","targetKey","inputKey","trustedContextKey","sourceFingerprint","jobAttempt","firstPickedUpAt","deadlineAt"])("rejects foreign %s current observation binding", field => {
    const f = fixture();expect(bind(f,{...f.observation,[field]:"foreign"}).adapter).not.toHaveProperty("officialRouteOwnershipProof");
  });
  it.each(["phone","input","attempt","fingerprint","pickup","deadline"])("cannot reuse native ownership after changed %s", field => {
    const f = fixture(), bound = bind(f);
    if (field === "phone") f.job.request.trustedContext.canonicalCoursePhone = "+15555559999";
    if (field === "input") f.job.request.input.players = 3;if (field === "attempt") f.job.attempts++;
    if (field === "fingerprint") f.job.sourceFingerprint = "b".repeat(64);
    if (field === "pickup") f.job.firstPickedUpAt = "2030-01-01T12:00:01.000Z";if (field === "deadline") f.job.deadlineAt = "2030-01-01T12:15:01.000Z";
    expect(bind(f).adapter).not.toHaveProperty("officialRouteOwnershipProof");expect(inspectedAdapterSourceEvidence(bound,f.job,f.observation,true,f.official)).toBeUndefined();
  });
  it.each(["semanticDigest","sourceWitnessSha256","providerWitnessSha256","publicCoursePhone","facilityId","scheduleId","bookingUrl","extra"])("rejects malformed current ownership %s", field => {
    const f = fixture(), observation = structuredClone(f.observation);
    observation.adapter.officialRouteOwnershipProof[field] = field === "extra" ? "PRIVATE" : field.endsWith("Id") ? 99 : "b".repeat(64);
    expect(bind(f,observation).adapter).not.toHaveProperty("officialRouteOwnershipProof");
  });
  it("redacts the entire physical witness/private phone and invalidates it before every action", () => {
    const f = fixture(), projected = createDiscoverySnapshotCompactor()({ adapter: f.adapter, trustedContext: f.job.request.trustedContext });
    expect(projected.adapter).not.toHaveProperty("officialRouteOwnershipProof");expect(JSON.stringify(projected)).not.toContain(f.proof.publicCoursePhone);
    for (const action of ["open","observe","click","select","fill","scroll","inspect","inspect_adapter","finish"]) expect(shouldInvalidateDiscoveryAdapterObservation(action,f.observation)).toBe(true);
  });
});
