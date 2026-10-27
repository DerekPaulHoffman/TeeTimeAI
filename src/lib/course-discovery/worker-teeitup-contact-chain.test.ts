import { describe, expect, it } from "vitest";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor,
  inspectedAdapterSourceEvidence, readDiscoveryControllerCheckpoint, shouldInvalidateDiscoveryAdapterObservation } from "../../../scripts/automation/course-discovery-worker.mjs";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { bindTeeItUpOfficialContactChain } from "./teeitup-official-contact-chain";
import { parseAccessRecipe } from "./recipe";

function fixture() {
  const source = { officialUrl: "https://harbor.example/", bookingUrl: "https://harbor.book.teeitup.com/", venueName: "Harbor Country Club",
    venueAddress: "781 Shore Lane, Harbor, MA 01030", timeZone: "America/New_York" };
  const contactUrl = "https://harbor.example/contact/";
  const native = (page: { url: string; html: string; visibleEvidence: object }) => registerFreshNativeOfficialIdentityPage({
    ...page, browserTransport: "NATIVE_CHROME" }, source.officialUrl, new Date(Date.now() + 25_000));
  const root = native({ url: source.officialUrl, html: '<h1>Harbor Country Club</h1><a href="/contact/">Contact Us</a>',
    visibleEvidence: { title: source.venueName, headings: [source.venueName], addressTexts: [], linkUrls: [contactUrl],
      officialContactLinkLabels: [{ href: contactUrl, text: "Contact Us" }] } });
  const contact = native({ url: contactUrl, html: `<h1>Contact Us</h1><p>${source.venueName}</p><p>${source.venueAddress}</p><a href="${source.bookingUrl}">Book Tee Times</a>`,
    visibleEvidence: { title: "Contact Us", headings: ["Contact Us"], officialContactBusinessNames: [source.venueName],
      addressTexts: [source.venueAddress], linkUrls: [source.bookingUrl], officialContactLinkLabels: [{ href: source.bookingUrl, text: "Book Tee Times" }] } });
  const rows = [{ id: 31, courseId: "harbor-31", name: source.venueName, address: "Shore Lane, Harbor, MA 1030, US",
    country: "US", timeZone: source.timeZone, isSimulator: false }];
  const proof = bindTeeItUpOfficialContactChain(source, root, contact, rows);
  const adapter = { family: "TEEITUP", alias: "harbor", facilityIds: [31], officialContactChainProof: proof };
  const job = { id: "owned-job", sourceFingerprint: "a".repeat(64), attempts: 1, firstPickedUpAt: "2030-10-24T12:00:00.000Z",
    deadlineAt: "2030-10-24T12:15:00.000Z", request: { identity: { name: source.venueName, officialUrl: source.officialUrl,
      address: source.venueAddress, timeZone: source.timeZone }, target: { courseId: "owned-course", kind: "OUTDOOR" },
      input: { date: "2030-10-29", players: 2, startTime: "09:00", endTime: "18:00", timeZone: source.timeZone } } };
  const proposal = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "model", kind: "SIMULATOR" },
    source: { ...source, providerFamily: "TEEITUP" }, adapter: { ...adapter, officialContactChainProof: { forged: true } } };
  const observation = createDiscoveryAdapterObservation(job, source.bookingUrl, adapter, source.bookingUrl)!;
  return { source, proof, adapter, job, proposal, observation };
}
describe("inspected-only TeeItUp contact-chain worker proof", () => {
  it("strips a model proof and binds only a current fixed inspection", () => {
    const f = fixture();
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job).adapter).not.toHaveProperty("officialContactChainProof");
    const bound = bindDiscoveryRecipeIdentity(f.proposal, f.job, f.observation, f.source.bookingUrl);
    expect(bound.adapter.officialContactChainProof).toEqual(f.proof);
    expect(parseAccessRecipe(bound)).toEqual(bound);
    expect(inspectedAdapterSourceEvidence(bound, f.job, f.observation, true, f.source.bookingUrl)).toEqual({
      officialUrl: f.source.officialUrl, observedBookingUrl: f.source.bookingUrl });
  });
  it.each(["jobId", "inputKey", "sourceFingerprint", "deadlineAt"])("rejects changed %s", field => {
    const f = fixture();
    const changed = { ...f.observation, [field]: "other" };
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job, changed, f.source.bookingUrl).adapter).not.toHaveProperty("officialContactChainProof");
  });
  it("rejects a forged inspection proof and redacts it from checkpoints/model snapshots", () => {
    const f = fixture(), changed = structuredClone(f.observation);
    changed.adapter.officialContactChainProof.providerAddressVerified = true;
    expect(bindDiscoveryRecipeIdentity(f.proposal, f.job, changed, f.source.bookingUrl).adapter).not.toHaveProperty("officialContactChainProof");
    const projected = createDiscoverySnapshotCompactor()({ adapter: f.adapter });
    expect(projected.adapter).not.toHaveProperty("officialContactChainProof");
    expect(readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: f.source.officialUrl,
      adapterObservation: f.observation } }, f.source.officialUrl)).not.toHaveProperty("adapterObservation");
    expect(shouldInvalidateDiscoveryAdapterObservation("observe", f.observation)).toBe(true);
  });
});
