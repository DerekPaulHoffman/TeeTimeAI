// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveAcuityOfficialContact } from "./acuity-official-contact";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { parseAccessRecipe } from "./recipe";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, createDiscoveryBrowser, createDiscoverySnapshotCompactor,
  fillCurrentInspectedAdapter, inspectedAdapterSourceEvidence, shouldInvalidateDiscoveryAdapterObservation, verifyDiscoveryCandidate } from "../../../scripts/automation/course-discovery-worker.mjs";

const mocks = vi.hoisted(() => ({
  active: vi.fn(), pilot: vi.fn(),
  db: { localReaderJob: { findMany: vi.fn(), updateMany: vi.fn() }, teeSearch: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("./service", () => ({ getActiveAccessRecipe: mocks.active, assertActiveAccessRecipeInTransaction: vi.fn() }));
vi.mock("./config", () => ({ isDiscoveryPilotSearch: mocks.pilot }));
import { claimNextRecipeExecution } from "./runtime";

const phone = "+12065551234", now = new Date("2030-10-28T12:00:00.000Z");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture() {
  const source = { officialUrl: "https://example.org/cedar/", bookingUrl: "https://cedar.as.me/schedule/owner123",
    venueName: "Cedar Point Indoor Golf & Bar", venueAddress: "10 Cedar Street Unit 7, Example, MA 01844, USA", timeZone: "America/New_York", providerFamily: "ACUITY" };
  const page = registerFreshNativeOfficialIdentityPage({ url: source.officialUrl, browserTransport: "NATIVE_CHROME" as const,
    html: `<h1>Cedar Point</h1><ul><li>Market Place<br>10 Cedar Street<br>Example, Massachusetts 01844<br><a href="https://maps.example.org/">Map &amp; Directions</a></li><li>${phone}</li></ul><iframe src="https://cedar.as.me/"></iframe>`,
    visibleEvidence: { title: "Cedar Point", headings: ["Cedar Point"], addressTexts: ["Market Place, 10 Cedar Street, Example, Massachusetts 01844, Map & Directions"],
      linkUrls: ["https://maps.example.org/"], phoneTexts: [phone], phoneTextsOmitted: false,
      delegatedFrameSources: { rows: [{ src: "https://cedar.as.me/", visible: true, srcdoc: false, inForm: false }], omitted: false } } },
  source.officialUrl, new Date(Date.now() + 30_000));
  const proof = deriveAcuityOfficialContact(source, page, "Cedar Point", phone);
  const adapter = { family: "ACUITY", ownerKey: "owner123", businessId: "345", rentalProductIds: ["101"], officialContactProof: proof };
  const target = { courseId: "course1", offeringId: "offering1", kind: "SIMULATOR" as const };
  const input = { date: "2030-10-30", players: 2, startTime: "10:00", endTime: "20:00", durationMinutes: 60, timeZone: source.timeZone };
  const job = { id: "job1", leaseToken: "private-current-lease", attempts: 1, sourceFingerprint: "a".repeat(64),
    firstPickedUpAt: new Date(Date.now() - 1000).toISOString(), deadlineAt: new Date(Date.now() + 899_000).toISOString(),
    request: { identity: { name: source.venueName, officialUrl: source.officialUrl, address: source.venueAddress, timeZone: source.timeZone, bookingUrl: source.officialUrl, providerFamily: null },
      target, input, demand: { searchId: "search1", alertGeneration: 4 }, trustedContext: { canonicalCoursePhone: phone } } };
  const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target, source, adapter });
  if (recipe.engine !== "EXISTING_ADAPTER" || recipe.adapter.family !== "ACUITY") throw Error("Fixture must be an Acuity recipe");
  return { source, proof, adapter, target, input, job, recipe };
}
const browsers: Array<ReturnType<typeof createDiscoveryBrowser>> = [];
async function observed(f = fixture()) {
  const nativeProof = { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: hash(f.source.bookingUrl), currentUrlSha256: hash(f.source.bookingUrl),
    documentBindingSha256: "b".repeat(64), observedAt: Date.now(), status: 200 };
  const raw = { url: f.source.bookingUrl, text: "Public simulator rental", controls: [], adapter: f.adapter,
    browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false, nativeMainDocumentContinuity: nativeProof };
  const configuration: Array<{ args: string[] }> = [];
  const browser = createDiscoveryBrowser({ cwd: process.cwd(), initialUrls: [f.source.officialUrl], deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    trustedContext: f.job.request.trustedContext, helperEnvironment: { COURSE_DISCOVERY_JOB_ID: f.job.id, COURSE_DISCOVERY_LEASE_TOKEN: f.job.leaseToken },
    processFactory: options => { configuration.push(options); return { request: async () => structuredClone(raw), close: async () => {} }; } });
  browsers.push(browser);
  const snapshot = await browser.request({ action: "inspect_adapter", url: f.source.bookingUrl });
  const capability = browser.currentMainDocumentContinuity(snapshot, f.source.bookingUrl)!;
  const observation = createDiscoveryAdapterObservation(f.job, f.source.bookingUrl, snapshot.adapter, snapshot.url, capability, browser)!;
  return { ...f, browser, snapshot, capability, observation, configuration };
}
type Observed = Awaited<ReturnType<typeof observed>>;
const bound = (f: Observed, observation = f.observation, job = f.job, context = f.source.bookingUrl) => bindDiscoveryRecipeIdentity(f.recipe, job, observation, context);
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(async () => { for (const browser of browsers.splice(0)) await browser.close(); vi.useRealTimers(); });

describe("private Acuity contact proof binding", () => {
  it("restores only the real current owned native inspection and supplies exact source evidence", async () => {
    const f = await observed(), candidate = bound(f);
    expect(candidate.adapter.officialContactProof).toEqual(f.proof);
    expect(inspectedAdapterSourceEvidence(candidate, f.job, f.observation, true, f.source.bookingUrl)).toEqual({ officialUrl: f.source.officialUrl, observedBookingUrl: f.source.bookingUrl });
    expect(parseAccessRecipe(candidate)).toEqual(f.recipe);
    const { adapter: _adapter, ...withoutAdapter } = f.recipe;
    void _adapter;
    expect(fillCurrentInspectedAdapter(withoutAdapter, f.job, f.observation, true, f.source.bookingUrl, f.browser, true).adapter).toEqual(f.adapter);
  });
  it("keeps proof and phone out of model input without altering the private inspected metadata", async () => {
    const f = await observed(), before = JSON.stringify(f.snapshot);
    const preview = createDiscoverySnapshotCompactor()({ ...f.snapshot, trustedContext: f.job.request.trustedContext });
    expect(preview.adapter).not.toHaveProperty("officialContactProof");
    expect(preview).not.toHaveProperty("trustedContext");
    expect(JSON.stringify(preview)).not.toContain(f.proof.witnessSha256);
    expect(JSON.stringify(preview)).not.toContain(phone);
    expect(JSON.stringify(f.snapshot)).toBe(before);
    expect(f.snapshot.adapter.officialContactProof).toEqual(f.proof);
    expect(bound(f).adapter.officialContactProof).toEqual(f.proof);
  });
  it.each(["missing", "spread", "json", "uploaded", "copiedCapability"])("rejects %s inspection authority", async kind => {
    const f = await observed();
    const observation = kind === "missing" ? undefined : kind === "spread" ? { ...f.observation } : kind === "json" ? JSON.parse(JSON.stringify(f.observation)) :
      createDiscoveryAdapterObservation(f.job, f.source.bookingUrl, f.adapter, f.source.bookingUrl, kind === "copiedCapability" ? { ...f.capability } : undefined, f.browser);
    expect(bindDiscoveryRecipeIdentity(f.recipe, f.job, observation, f.source.bookingUrl).adapter).not.toHaveProperty("officialContactProof");
    expect(inspectedAdapterSourceEvidence(f.recipe, f.job, observation, true, f.source.bookingUrl)).toBeUndefined();
  });
  it.each(["lease", "job", "attempt", "fingerprint", "generation", "players", "phone", "canonicalName", "canonicalAddress", "officialUrl", "deadline"])("rejects changed %s binding", async kind => {
    const f = await observed();
    if (kind === "lease") f.job.leaseToken = "foreign-private-lease";
    if (kind === "job") f.job.id = "foreign-job";
    if (kind === "attempt") f.job.attempts++;
    if (kind === "fingerprint") f.job.sourceFingerprint = "c".repeat(64);
    if (kind === "generation") f.job.request.demand.alertGeneration++;
    if (kind === "players") f.job.request.input.players++;
    if (kind === "phone") f.job.request.trustedContext.canonicalCoursePhone = "+12065554321";
    if (kind === "canonicalName") f.job.request.identity.name = "Other Indoor Golf & Bar";
    if (kind === "canonicalAddress") f.job.request.identity.address = "11 Cedar Street Unit 7, Example, MA 01844, USA";
    if (kind === "officialUrl") f.job.request.identity.officialUrl = "https://foreign.example/";
    if (kind === "deadline") f.job.deadlineAt = new Date(Date.parse(f.job.deadlineAt) + 1).toISOString();
    expect(bound(f).adapter).not.toHaveProperty("officialContactProof");
    expect(inspectedAdapterSourceEvidence(f.recipe, f.job, f.observation, true, f.source.bookingUrl)).toBeUndefined();
  });
  it.each(["expired", "newSnapshot", "mutatedSnapshot", "closed"])("revokes an authentic inspection after %s", async kind => {
    const f = await observed();
    if (kind === "expired") vi.setSystemTime(new Date(now.getTime() + 5001));
    if (kind === "newSnapshot") await f.browser.request({ action: "observe" });
    if (kind === "mutatedSnapshot") f.snapshot.url = f.source.bookingUrl + "other";
    if (kind === "closed") await f.browser.close();
    expect(bound(f).adapter).not.toHaveProperty("officialContactProof");
    expect(inspectedAdapterSourceEvidence(f.recipe, f.job, f.observation, true, f.source.bookingUrl)).toBeUndefined();
  });
  it("rejects an exact native capability from another lease and a foreign current source", async () => {
    const f = await observed(), foreign = { ...f.job, leaseToken: "foreign-lease" };
    const observation = createDiscoveryAdapterObservation(foreign, f.source.bookingUrl, f.adapter, f.source.bookingUrl, f.capability, f.browser);
    expect(bindDiscoveryRecipeIdentity(f.recipe, foreign, observation, f.source.bookingUrl).adapter).not.toHaveProperty("officialContactProof");
    expect(bound(f, f.observation, f.job, f.source.officialUrl).adapter).not.toHaveProperty("officialContactProof");
    expect(inspectedAdapterSourceEvidence(f.recipe, f.job, f.observation, false, f.source.bookingUrl)).toBeUndefined();
    const proposal = { ...f.recipe, source: { ...f.recipe.source, bookingUrl: "https://other.as.me/schedule/owner123" } };
    expect(bindDiscoveryRecipeIdentity(proposal, f.job, f.observation, f.source.bookingUrl).adapter).not.toHaveProperty("officialContactProof");
  });
  it("rejects mutated metadata and modeled proof even when its witness is self-consistent", async () => {
    const f = await observed(), copied = structuredClone(f.recipe);
    if (copied.engine !== "EXISTING_ADAPTER" || copied.adapter.family !== "ACUITY" || !copied.adapter.officialContactProof) throw Error("Fixture mismatch");
    copied.adapter.officialContactProof.providerName = "Other Public Venue";
    const { witnessSha256: _witness, ...body } = copied.adapter.officialContactProof;
    void _witness;
    copied.adapter.officialContactProof.witnessSha256 = hash(body);
    expect(bindDiscoveryRecipeIdentity(copied, f.job, undefined, f.source.bookingUrl).adapter).not.toHaveProperty("officialContactProof");
    f.observation.adapter.businessId = "999";
    expect(bound(f).adapter).not.toHaveProperty("officialContactProof");
  });
  it("invalidates contact inspection on every browser action and rejects foreign wrapper owners", async () => {
    const f = await observed();
    for (const action of ["open", "observe", "click", "select", "fill", "scroll", "inspect", "inspect_adapter", "finish"])
      expect(shouldInvalidateDiscoveryAdapterObservation(action, f.observation)).toBe(true);
    const { adapter: _adapter, ...proposal } = f.recipe;
    void _adapter;
    expect(() => fillCurrentInspectedAdapter(proposal, f.job, f.observation, true, f.source.bookingUrl, {}, true)).toThrow("DISCOVERY_CURRENT_INSPECTION_REQUIRED");
  });
  it.each(["officialUrl", "bookingUrl", "venueName", "venueAddress", "timeZone"])("full recipe validation rejects changed %s beside a valid contact proof", key => {
    const f = fixture(), changed = { ...f.recipe, source: { ...f.recipe.source, [key]: key === "timeZone" ? "America/Chicago" :
      key.endsWith("Url") ? "https://foreign.example/" : "Different public identity" } };
    expect(() => parseAccessRecipe(changed)).toThrow();
  });
  it("forwards the phone only in private helper configuration and both independent replay calls", async () => {
    const f = await observed(), args = f.configuration[0].args;
    expect(JSON.parse(args[args.indexOf("--trusted-context") + 1])).toEqual(f.job.request.trustedContext);
    const contexts: unknown[] = [], recipeHash = "d".repeat(64), sourceEvidence = inspectedAdapterSourceEvidence(bound(f), f.job, f.observation, true, f.source.bookingUrl);
    const candidate = vi.fn(async (...args: unknown[]) => {
      expect(args[4]).toEqual(sourceEvidence);
      return { recipeHash, challenges: [1, 2].map(n => ({ id: `challenge${n}`, recipeHash, input: { ...f.input, players: n + 1 } })) };
    });
    await verifyDiscoveryCandidate({ job: f.job, recipe: bound(f), sourceEvidence,
      client: { candidate, verification: async () => ({}), activate: async () => ({ recipeId: "saved-recipe" }) },
      executeRecipe: async options => { contexts.push(options.trustedContext); return { status: "EMPTY", complete: true, slots: [], evidence: { recipeHash } }; } });
    expect(contexts).toEqual([f.job.request.trustedContext, f.job.request.trustedContext]);
    expect(candidate.mock.calls[0][4]).toEqual(sourceEvidence);
  });
});

describe("saved Acuity execution phone freshness", () => {
  it.each(["current", "missing", "changed"])("claims only the %s private phone context", async kind => {
    const f = fixture(), trustedContext = kind === "missing" ? undefined : { canonicalCoursePhone: kind === "changed" ? "+12065554321" : phone };
    mocks.pilot.mockResolvedValue(true);
    mocks.active.mockResolvedValue({ record: { id: "recipe1", hash: "d".repeat(64) }, recipe: f.recipe, trustedContext: f.job.request.trustedContext });
    mocks.db.localReaderJob.findMany.mockResolvedValue([{ id: "warm1", status: "PENDING", leaseToken: null, scheduleVersion: 2,
      jobExpiresAt: new Date(now.getTime() + 60_000), sourceContext: { searchId: "search1", target: f.target, recipeId: "recipe1", recipeHash: "d".repeat(64),
        input: f.input, alertGeneration: 4, ...(trustedContext ? { trustedContext } : {}) } }]);
    mocks.db.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    mocks.db.teeSearch.findUnique.mockResolvedValue({ status: "ACTIVE", alertGeneration: 4, scheduleVersion: 2, date: new Date("2030-10-30T00:00:00Z"),
      endTime: f.input.endTime, userTimeZone: f.input.timeZone, preferences: [{ courseId: f.target.courseId, offeringId: f.target.offeringId }] });
    const result = await claimNextRecipeExecution("hermetic-worker");
    if (kind === "current") expect(result).toMatchObject({ id: "warm1", trustedContext: { canonicalCoursePhone: phone }, recipe: f.recipe });
    else { expect(result).toBeNull(); expect(mocks.db.localReaderJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "EXPIRED" } })); }
  });
});
