import { describe, expect, it } from "vitest";
import { deriveCourseTrustedContext, discoveryTrustedContextSchema, isCurrentTrustedContext } from "./trusted-context";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor, inspectedAdapterSourceEvidence, createDiscoveryBrowser, verifyDiscoveryCandidate, DISCOVERY_BROWSER_INPUT_SCHEMA } from "../../../scripts/automation/course-discovery-worker.mjs";

const phone = "+13035551234";
function fixture() {
  const source = { officialUrl: "https://golf.example.com/", bookingUrl: "https://publicgolf.cps.golf/", venueName: "Example Golf Course", venueAddress: "100 Golf Road, Denver, CO 80001, USA", timeZone: "America/Denver" };
  const proof = { kind: "CANONICAL_PHONE_POSTAL_CONFLICT", officialUrl: source.officialUrl, officialPageUrl: source.officialUrl,
    bookingUrl: source.bookingUrl, tenant: "publicgolf", canonicalAddress: source.venueAddress, officialAddress: "100 Golf Road, Denver, CO 80002, USA",
    canonicalPostalCode: "80001", officialPostalCode: "80002", canonicalCoursePhone: phone, venueName: source.venueName, providerVenueName: source.venueName, timeZone: source.timeZone,
    catalogHash: "a".repeat(64), courseIds: [1], markupWitnessSha256: "b".repeat(64), phoneWitnessSha256: "c".repeat(64), warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" };
  const adapter = { family: "CPS", tenant: "publicgolf", courseIds: [1], catalogHash: proof.catalogHash, officialPostalConflictProof: proof };
  const job = { id: "job1", request: { identity: { name: source.venueName, officialUrl: source.officialUrl, address: source.venueAddress },
    target: { courseId: "course1", kind: "OUTDOOR" }, input: { date: "2030-01-02", timeZone: source.timeZone, players: 2, startTime: "09:00", endTime: "17:00" }, trustedContext: { canonicalCoursePhone: phone } } };
  const proposal = { engine: "EXISTING_ADAPTER", target: job.request.target, source, adapter };
  return { job, proposal, observation: createDiscoveryAdapterObservation(job, source.bookingUrl, adapter, source.bookingUrl), source };
}

describe("private durable course phone context", () => {
  it("forwards private context only through constructor and both independent replay calls", async () => {
    const f = fixture(), configurations: Array<{ args: string[] }> = [];
    const browser = createDiscoveryBrowser({ cwd: process.cwd(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialUrls: [f.source.officialUrl], trustedContext: f.job.request.trustedContext,
      processFactory: options => { configurations.push(options); return { request: async () => ({}), close: async () => {} }; } });
    const args = configurations[0].args;
    expect(JSON.parse(args[args.indexOf("--trusted-context") + 1])).toEqual(f.job.request.trustedContext);
    expect(JSON.stringify(DISCOVERY_BROWSER_INPUT_SCHEMA)).not.toMatch(/trustedContext|canonicalCoursePhone/);
    await browser.close();
    const contexts: unknown[] = [], hash = "a".repeat(64);
    await verifyDiscoveryCandidate({ job: { ...f.job, deadlineAt: new Date(Date.now() + 60_000).toISOString(), leaseToken: "synthetic" }, recipe: f.proposal,
      client: { candidate: async () => ({ recipeHash: hash, challenges: ["one", "two"].map(id => ({ id, recipeHash: hash, input: f.job.request.input })) }),
        verification: async () => ({}), activate: async () => ({ recipeId: "recipe1" }) },
      executeRecipe: async options => { contexts.push(options.trustedContext); return { status: "EMPTY", complete: true, slots: [], evidence: { recipeHash: hash } }; } });
    expect(contexts).toEqual([f.job.request.trustedContext, f.job.request.trustedContext]);
  });
  it("normalizes only durable valid public phone values and rejects extra controller keys", () => {
    expect(deriveCourseTrustedContext({ phone: "(303) 555-1234" })).toEqual({ canonicalCoursePhone: phone });
    for (const value of [null, "", "not a phone", "+442071234567"]) expect(deriveCourseTrustedContext({ phone: value })).toEqual({});
    expect(discoveryTrustedContextSchema.safeParse({ canonicalCoursePhone: phone, uploadedProof: true }).success).toBe(false);
    expect(isCurrentTrustedContext({ canonicalCoursePhone: phone }, { canonicalCoursePhone: "+13035554321" })).toBe(false);
  });
  it("strips modeled proof and adopts only exact fresh job/context inspection", () => {
    const f = fixture();
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job).adapter).not.toHaveProperty("officialPostalConflictProof");
    const bound = bindDiscoveryRecipeIdentity(f.proposal, f.job, f.observation, f.source.bookingUrl);
    expect(bound.adapter.officialPostalConflictProof.canonicalCoursePhone).toBe(phone);
    expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.source.bookingUrl)).toBeDefined();
    for (const change of [{ jobId: "other" }, { contextUrl: f.source.officialUrl }, { inputKey: "stale" }, { trustedContextKey: "forged" }]) {
      expect(bindDiscoveryRecipeIdentity(f.proposal, f.job, { ...f.observation, ...change }, f.source.bookingUrl).adapter).not.toHaveProperty("officialPostalConflictProof");
    }
    for (const key of ["canonicalCoursePhone", "canonicalAddress", "catalogHash", "bookingUrl", "venueName"]) {
      const observation = structuredClone(f.observation)!;
      observation.adapter.officialPostalConflictProof[key] = "forged";
      expect(bindDiscoveryRecipeIdentity(f.proposal, f.job, observation, f.source.bookingUrl).adapter).not.toHaveProperty("officialPostalConflictProof");
    }
    f.job.request.trustedContext.canonicalCoursePhone = "+13035554321";
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job, f.observation, f.source.bookingUrl).adapter).not.toHaveProperty("officialPostalConflictProof");
    expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.source.bookingUrl)).toBeUndefined();
  });
  it("keeps controller phone and phone proof out of model snapshots without mutating authority", () => {
    const f = fixture();
    const snapshot = { url: f.source.bookingUrl, adapter: f.proposal.adapter, trustedContext: f.job.request.trustedContext };
    const projected = createDiscoverySnapshotCompactor()(snapshot);
    expect(JSON.stringify(projected)).not.toContain(phone);
    expect(projected).not.toHaveProperty("trustedContext");
    expect(snapshot.adapter.officialPostalConflictProof.canonicalCoursePhone).toBe(phone);
  });
});
