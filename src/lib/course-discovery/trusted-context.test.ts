import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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
  it("uses only the latest owned-channel native capability for CPS actual context while preserving the canonical booking source", async () => {
    const f = fixture(), job = { ...f.job, leaseToken: "owned-private-lease" }, current = f.source.bookingUrl + "onlineresweb/search-teetime?view=public";
    const hash = (v: string) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    const proof = { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: hash(f.source.bookingUrl), currentUrlSha256: hash(current),
      documentBindingSha256: "d".repeat(64), observedAt: Date.now(), status: 200 };
    const raw = { url: current, text: "Public document", controls: [], browserTransport: "NATIVE_CHROME", navigationStatus: 200, nativeMainDocumentContinuity: proof };
    const browser = createDiscoveryBrowser({ cwd: process.cwd(), deadlineAt: new Date(Date.now() + 60_000).toISOString(), initialUrls: [f.source.officialUrl],
      helperEnvironment: { COURSE_DISCOVERY_JOB_ID: job.id, COURSE_DISCOVERY_LEASE_TOKEN: job.leaseToken },
      processFactory: () => ({ request: async () => structuredClone(raw), close: async () => {} }) });
    try {
      const snapshot = await browser.request({ action: "observe" }); expect(snapshot).not.toHaveProperty("nativeMainDocumentContinuity");
      const capability = browser.currentMainDocumentContinuity(snapshot, f.source.bookingUrl)!;
      expect(capability).toEqual(proof);
      expect(browser.currentMainDocumentContinuity({ ...snapshot }, f.source.bookingUrl)).toBeUndefined();
      expect(browser.currentMainDocumentContinuity(snapshot, f.source.bookingUrl + "other")).toBeUndefined();
      const observation = createDiscoveryAdapterObservation(job, f.source.bookingUrl, f.proposal.adapter, current, capability);
      expect(observation.contextUrl).toBe(current);
      const bound = bindDiscoveryRecipeIdentity(f.proposal, job, observation, current);
      expect(bound.source.bookingUrl).toBe(f.source.bookingUrl); expect(bound.adapter.officialPostalConflictProof).toEqual(f.proposal.adapter.officialPostalConflictProof);
      for (const value of [{ ...capability }, JSON.parse(JSON.stringify(capability)), undefined]) {
        const copied = createDiscoveryAdapterObservation(job, f.source.bookingUrl, f.proposal.adapter, current, value);
        expect(bindDiscoveryRecipeIdentity(f.proposal, job, copied, current).adapter).not.toHaveProperty("officialPostalConflictProof");
      }
      expect(bindDiscoveryRecipeIdentity(f.proposal, job, { ...observation }, current).adapter).not.toHaveProperty("officialPostalConflictProof");
      const foreign = { ...job, leaseToken: "other-private-lease" };
      expect(bindDiscoveryRecipeIdentity(f.proposal, foreign, createDiscoveryAdapterObservation(foreign, f.source.bookingUrl, f.proposal.adapter, current, capability), current).adapter).not.toHaveProperty("officialPostalConflictProof");
      expect(createDiscoverySnapshotCompactor()(structuredClone(raw))).not.toHaveProperty("nativeMainDocumentContinuity");
      await browser.request({ action: "observe" });
      expect(browser.currentMainDocumentContinuity(snapshot, f.source.bookingUrl)).toBeUndefined();
      expect(bindDiscoveryRecipeIdentity(f.proposal, job, observation, current).adapter).not.toHaveProperty("officialPostalConflictProof");
    } finally { await browser.close(); }
  });
  it.each(["stale", "future", "wrongHash", "extra", "nonSuccess", "wrongTransport", "access", "nativeFatal", "mutatedSnapshot"])("rejects %s current native document metadata", async change => {
    const original = "https://publicgolf.cps.golf/", current = original + "search?view=public", hash = (v: string) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    const proof: Record<string, unknown> = { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: hash(original), currentUrlSha256: hash(current), documentBindingSha256: "a".repeat(64), observedAt: Date.now(), status: 200 };
    if (change === "stale") proof.observedAt = Date.now() - 5001; if (change === "future") proof.observedAt = Date.now() + 1000;
    if (change === "wrongHash") proof.currentUrlSha256 = "b".repeat(64); if (change === "extra") proof.rawUrl = "PRIVATE";
    const browser = createDiscoveryBrowser({ cwd: process.cwd(), deadlineAt: new Date(Date.now() + 60_000).toISOString(), initialUrls: [original],
      processFactory: () => ({ request: async () => ({ url: current, browserTransport: change === "wrongTransport" ? "PINNED_HTTP" : "NATIVE_CHROME", navigationStatus: change === "nonSuccess" ? 503 : 200,
        accessRequirementObserved: change === "access", ...(change === "nativeFatal" ? { nativeFirstFatal: { code: "NATIVE_REDIRECT_NETWORK_FAILED" } } : {}), nativeMainDocumentContinuity: proof }), close: async () => {} }) });
    try { const snapshot = await browser.request({ action: "observe" }); if (change === "mutatedSnapshot") snapshot.url = original + "other"; expect(browser.currentMainDocumentContinuity(snapshot, original)).toBeUndefined(); }
    finally { await browser.close(); }
  });
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
