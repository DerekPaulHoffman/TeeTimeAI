import { describe, expect, it, vi } from "vitest";
import { bindTeeItUpPostalConflictProof, normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { parseAccessRecipe, type CourseAccessRecipeData } from "./recipe";
import { recipeTimeToInstant, venueProofMatches } from "./executor";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, inspectedAdapterSourceEvidence } from "../../../scripts/automation/course-discovery-worker.mjs";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

const source = { officialUrl: "https://example.org/", bookingUrl: "https://harbor-ridge.book.teeitup.com/",
  venueName: "Harbor Ridge Golf Club", venueAddress: "10 Harbor Drive, Example, NY 12345, USA", timeZone: "America/New_York", providerFamily: "TEEITUP" };
const directory = [{ id: 31, courseId: "provider-course-31", name: source.venueName, address: "10 Harbor Dr., Example, NY 32801, US",
  timeZone: source.timeZone, country: "US", isSimulator: false, phone: "+1 (916) 555-4653" }];
const body = `<h1>${source.venueName}</h1><address>10 Harbor Dr., Example, NY 12345</address><a href="${source.bookingUrl}">Tee Times</a><a class="course-contact" href="tel:+1-916-555-4653">916-555-4653</a>`;
const html = (content = body) => `<html><head><title>Home - ${source.venueName}</title></head><body>${content}</body></html>`;
const page: OfficialIdentityPage = { url: source.officialUrl, html: html(), visibleEvidence: { title: `Home - ${source.venueName}`,
  headings: [source.venueName], addressTexts: ["10 Harbor Dr., Example, NY 12345"], linkUrls: [source.bookingUrl], phoneTexts: ["916-555-4653"] } };
const input = { date: "2030-01-02", players: 2, timeZone: source.timeZone, startTime: "08:00", endTime: "18:00" };
const deps = { now: () => new Date("2030-01-01T12:00:00Z"), recipeHash: "a".repeat(64), venueMatches: venueProofMatches,
  toInstant: recipeTimeToInstant, requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
const bind = (rows: unknown = directory, officialPage: OfficialIdentityPage = page) =>
  bindTeeItUpPostalConflictProof(source, officialPage, rows, { requireVisibleEvidence: true });

describe("independent official postal-conflict corroboration", () => {
  it("retains canonical identity and the discrepancy while binding a unique public facility and independent phone", () => {
    const proof = bind();
    expect(proof).toMatchObject({ kind: "OFFICIAL_POSTAL_CONFLICT", alias: "harbor-ridge", facilityId: 31, courseId: "provider-course-31",
      canonicalAddress: source.venueAddress, providerAddress: directory[0].address, providerAddressVerified: false,
      postalConflict: { canonical: "12345", provider: "32801" }, publicCoursePhone: "+19165554653",
      initialVisibility: "RENDERED_CONTROLLER_OBSERVATION", warmVisibility: "INERT_ANCESTRY_ONLY_EXTERNAL_CSS_NOT_REFRESHED" });
    expect(proof.phoneWitnessSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(source.venueAddress).toContain("12345");
  });

  it.each([
    { name: "Another Harbor Golf Club" }, { address: "11 Harbor Dr., Example, NY 32801, US" },
    { address: "10 Other Dr., Example, NY 32801, US" }, { address: "10 W Harbor Dr., Example, NY 32801, US" },
    { address: "10 Harbor Dr. Unit 2, Example, NY 32801, US" }, { address: "10 Harbor Dr., Other City, NY 32801, US" },
    { address: "10 Harbor Dr., Example, CA 32801, US" }, { address: "10 Harbor Dr., Example, NY 32801, Canada" },
    { address: "10 Harbor Dr., Example, NY 12345, US" }, { country: "CA" }, { country: undefined },
    { timeZone: "America/Chicago" }, { isSimulator: true }, { phone: "916-555-4654" }, { phone: undefined },
    { phone: "916-555-4653 ext 2" },
  ])("rejects any additional conflict or absent independent discriminator (%j)", change => {
    expect(() => bind([{ ...directory[0], ...change }])).toThrow("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
  });

  it.each([
    [...directory, { ...directory[0], id: 32, courseId: "second-course" }],
    [...directory, { ...directory[0], name: "Another course", courseId: "second-course" }],
    [...directory, { ...directory[0], id: 32, name: "Another course" }],
  ])("rejects ambiguous names and duplicate provider identifiers", rows => {
    expect(() => bind(rows)).toThrow("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
  });

  it.each([
    html(body.replace("<address>", '<address hidden>')),
    html(body.replace('<a class="course-contact"', '<a hidden class="course-contact"')),
    html(body.replace('<a class="course-contact"', '<a style="display:none" class="course-contact"')),
    html(body.replace('class="course-contact"', 'class="account-contact"')),
    html(body.replace('<a class="course-contact"', '<form><a class="course-contact"').replace("</a></body>", "</a></form></body>")),
    html(body.replace(source.bookingUrl, "https://another-course.book.teeitup.com/")),
    html(body.replace("10 Harbor Dr.", "11 Harbor Dr.")),
    html(body + '<a href="tel:916-555-9999">916-555-9999</a>'),
    html(body.replace("916-555-4653</a>", "916-555-4654</a>")),
  ])("rejects hidden, private, conflicting or ambiguous official evidence", value => {
    expect(() => bind(directory, { ...page, html: value })).toThrow();
  });

  it.each([
    { ...page, visibleEvidence: undefined },
    { ...page, visibleEvidence: { ...page.visibleEvidence!, phoneTexts: [] } },
    { ...page, visibleEvidence: { ...page.visibleEvidence!, phoneTexts: ["916-555-4654"] } },
    { ...page, visibleEvidence: { ...page.visibleEvidence!, addressTexts: ["10 Harbor Dr., Example, NY 32801"] } },
    { ...page, visibleEvidence: { ...page.visibleEvidence!, linkUrls: [] } },
  ])("requires initial controller-rendered source proof including the phone", value => {
    expect(() => bind(directory, value)).toThrow();
  });

  it.each(["customer:916-555-4653", "9165554653@private.example", "011-1-916-555-4653", "916-555-4653 x1", "000-000-0000"])(
    "does not parse private prose or an arbitrary telephone token: %s", value => expect(normalizePublicCoursePhone(value)).toBeUndefined());

  it("does not substitute another booking-provider page for the independent official site", () => {
    expect(() => bindTeeItUpPostalConflictProof({ ...source, officialUrl: source.bookingUrl }, { ...page, url: source.bookingUrl }, directory,
      { requireVisibleEvidence: true })).toThrow("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
  });

  it("requires a fresh official document and directory on every fixed replay, including an edited party input", async () => {
    const calls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async value => {
      const url = new URL(String(value)); calls.push(url.href);
      if (url.href === source.officialUrl) return new Response(html(), { headers: { "content-type": "text/html" } });
      if (url.pathname.endsWith("/facilities")) return Response.json(directory);
      return Response.json([{ courseId: directory[0].courseId, teetimes: [{ courseId: directory[0].courseId, teetime: "2030-01-02T15:00:00Z",
        rates: [{ _id: 1, allowedPlayers: [2, 3, 4], holes: 18, greenFeeCart: 2500 }] }] }]);
    });
    const observed = await inspectExistingAdapter(source, { ...deps, fetch, officialIdentityPage: page });
    expect(observed.adapter).toHaveProperty("officialPostalConflictProof");
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "owned-course", kind: "OUTDOOR" }, source, adapter: observed.adapter });
    if (recipe.engine !== "EXISTING_ADAPTER") throw new Error("WRONG_ENGINE");
    for (const players of [2, 3]) expect(await executeExistingAdapterRecipe(recipe, { ...input, players }, { ...deps, fetch }))
      .toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ availableSpots: 4 }], evidence: { venueVerified: true, completeVerified: true } });
    expect(calls.filter(url => url === source.officialUrl)).toHaveLength(2);
    expect(calls.filter(url => url.endsWith("/facilities"))).toHaveLength(3);
    expect(calls.filter(url => url.includes("/v2/tee-times"))).toHaveLength(2);
  });

  it.each(["phone", "official-address", "provider-phone", "facility-id", "course-id", "official-link"])(
    "fails closed before availability when saved corroboration changes: %s", async change => {
      const proof = bind();
      const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "owned-course", kind: "OUTDOOR" },
        source, adapter: { family: "TEEITUP", alias: proof.alias, facilityIds: [31], officialPostalConflictProof: proof } });
      if (recipe.engine !== "EXISTING_ADAPTER") throw new Error("WRONG_ENGINE");
      const changed = change === "provider-phone" ? [{ ...directory[0], phone: "916-555-4654" }]
        : change === "facility-id" ? [{ ...directory[0], id: 32 }] : change === "course-id" ? [{ ...directory[0], courseId: "another-id" }] : directory;
      const currentHtml = change === "phone" ? html().replaceAll("916-555-4653", "916-555-4654")
        : change === "official-address" ? html().replace("10 Harbor Dr.", "11 Harbor Dr.")
          : change === "official-link" ? html().replace(source.bookingUrl, "https://other.book.teeitup.com/") : html();
      const fetch = vi.fn<typeof globalThis.fetch>(async value => String(value) === source.officialUrl
        ? new Response(currentHtml, { headers: { "content-type": "text/html" } }) : Response.json(changed));
      expect(await executeExistingAdapterRecipe(recipe, input, { ...deps, fetch })).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
      expect(fetch.mock.calls.some(([url]) => String(url).includes("/v2/tee-times"))).toBe(false);
    });

  it("strips a model-proposed proof and copies only a current exact controller inspection", () => {
    const proof = bind(), adapter = { family: "TEEITUP", alias: proof.alias, facilityIds: [31], officialPostalConflictProof: proof };
    const job = { id: "owned-job", request: { identity: { name: source.venueName, officialUrl: source.officialUrl, address: source.venueAddress },
      target: { courseId: "owned-course", kind: "OUTDOOR" }, input } };
    const proposal = { engine: "EXISTING_ADAPTER", source, target: job.request.target, adapter: { ...adapter, officialPostalConflictProof: { forged: true } } };
    const observation = createDiscoveryAdapterObservation(job, source.bookingUrl, adapter, source.officialUrl);
    expect(bindDiscoveryRecipeIdentity(proposal, job).adapter).not.toHaveProperty("officialPostalConflictProof");
    const bound = bindDiscoveryRecipeIdentity(proposal, job, observation, source.officialUrl);
    expect(bound.adapter.officialPostalConflictProof).toEqual(proof);
    expect(inspectedAdapterSourceEvidence(bound, job, observation, true, source.officialUrl)).toEqual({ officialUrl: source.officialUrl, observedBookingUrl: source.bookingUrl });
    for (const stale of [{ ...observation, jobId: "another-job" }, { ...observation, contextUrl: "https://another.example/" },
      { ...observation, identityKey: "stale" }, { ...observation, inputKey: "stale" }])
      expect(bindDiscoveryRecipeIdentity(proposal, job, stale, source.officialUrl).adapter).not.toHaveProperty("officialPostalConflictProof");
    expect(bindDiscoveryRecipeIdentity({ ...proposal, adapter: { ...proposal.adapter, facilityIds: [32] } }, job, observation, source.officialUrl).adapter)
      .not.toHaveProperty("officialPostalConflictProof");
    expect(() => parseAccessRecipe({ schemaVersion: 1, ...bound, target: { courseId: "owned-course", offeringId: "offering", kind: "SIMULATOR" } } as CourseAccessRecipeData)).toThrow();
  });
});
