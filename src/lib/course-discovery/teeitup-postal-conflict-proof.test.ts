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
const brandBody = `<p class="site-title"><a href="${source.officialUrl}">${source.venueName}</a></p>` +
  `<p><strong>Address:</strong><br>10 Harbor Dr.<br>Example, NY 12345</p><a href="${source.bookingUrl}">Tee Times</a>` +
  '<a class="course-contact" href="tel:916-555-4653">916-555-4653</a>';
const nativePage: OfficialIdentityPage = { ...page, html: html(brandBody), browserTransport: "NATIVE_CHROME",
  visibleEvidence: { ...page.visibleEvidence!, headings: [], brandLinks: [{ href: source.officialUrl, text: source.venueName }],
    addressTexts: ["Address:, 10 Harbor Dr., Example, NY 12345"] } };

describe("independent official postal-conflict corroboration", () => {
  it("binds exact root brand and title with a labelled BR address, requiring rendered refresh on every native warm read", () => {
    expect(bind(directory, nativePage)).toMatchObject({ warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME",
      warmVisibility: "RENDERED_CONTROLLER_OBSERVATION", officialSourceProof: { kind: "OFFICIAL_WHOLE_BRAND_ADDRESS",
        alternateAddress: { postalCode: "12345" } } });
    expect(() => bind(directory, { ...nativePage, browserTransport: "PINNED_HTTP" })).toThrow();
    expect(() => bindTeeItUpPostalConflictProof({ ...source, venueAddress: source.venueAddress.replace("12345", "12346") }, nativePage, directory,
      { requireVisibleEvidence: true })).toThrow();
  });
  it.each([
    brandBody.replace(source.officialUrl, "https://unrelated.example/"),
    brandBody.replace('class="site-title"', 'class="site-title" hidden'),
    brandBody.replace(source.venueName, "Unrelated Golf Club"),
    brandBody.replace("10 Harbor Dr.", "11 Harbor Dr."),
    brandBody.replace("NY 12345", "CA 12345"),
    brandBody.replace("<p><strong>Address:", '<p class="billing"><strong>Address:'),
    brandBody.replace('class="course-contact"', 'class="fax"'),
    brandBody + '<p>11 Harbor Dr., Example, NY 12345</p>',
    brandBody + '<p class="site-title"><a href="https://unrelated.example/">Unrelated Golf Club</a></p>',
  ])("rejects conflicting, hidden or unrelated brand/address/contact markup", content => {
    expect(() => bind(directory, { ...nativePage, html: html(content) })).toThrow();
  });
  it.each([
    { ...nativePage, html: html(brandBody).replace(`Home - ${source.venueName}`, `Other Golf Club - ${source.venueName}`) },
    { ...nativePage, visibleEvidence: { ...nativePage.visibleEvidence!, brandLinks: [] } },
    { ...nativePage, visibleEvidence: { ...nativePage.visibleEvidence!, addressTexts: [] } },
    { ...nativePage, visibleEvidence: undefined },
  ])("requires fresh visible whole identity for the separate native attestation", current => expect(() => bind(directory, current)).toThrow());

  it.each(["Mailing Address", "Corporate Address", "Billing Address", "Headquarters"])(
    "rejects a canonical-looking address inside a nonphysical %s heading context", label => {
      const content = brandBody.replace('<p><strong>Address:</strong><br>10 Harbor Dr.<br>Example, NY 12345</p>',
        `<section><h2>${label}</h2><div><p>10 Harbor Dr., Example, NY 12345</p></div></section>`);
      expect(() => bind(directory, { ...nativePage, html: html(content), visibleEvidence: { ...nativePage.visibleEvidence!,
        headings: [label], addressTexts: ["10 Harbor Dr., Example, NY 12345"] } })).toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    });
  it("retains the observed public footer/Get In Touch address grammar", () => {
    const content = brandBody.replace('<p><strong>Address:</strong><br>10 Harbor Dr.<br>Example, NY 12345</p>',
      '<footer><h2>Footer</h2><section><h3>Get In Touch</h3><div><p><strong>Address:</strong><br>10 Harbor Dr.<br>Example, NY 12345</p></div></section></footer>');
    expect(bind(directory, { ...nativePage, html: html(content), visibleEvidence: { ...nativePage.visibleEvidence!,
      headings: ["Footer", "Get In Touch"] } }).officialSourceProof.kind).toBe("OFFICIAL_WHOLE_BRAND_ADDRESS");
  });
  it.each(["aria-label", "title"])("rejects a nonphysical address context expressed by %s", attribute => {
    const content = brandBody.replace('<p><strong>Address:', `<section ${attribute}="Corporate headquarters"><p><strong>Address:`)
      .replace('Example, NY 12345</p>', 'Example, NY 12345</p></section>');
    expect(() => bind(directory, { ...nativePage, html: html(content) })).toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
  });

  it("requires local capability before network access and refreshes the native official source before fixed provider reads", async () => {
    const proof = bind(directory, nativePage);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "owned-course", kind: "OUTDOOR" },
      source, adapter: { family: "TEEITUP", alias: proof.alias, facilityIds: [31], officialPostalConflictProof: proof } });
    if (recipe.engine !== "EXISTING_ADAPTER") throw new Error("WRONG_ENGINE");
    const calls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async url => {
      calls.push(String(url));
      if (String(url).endsWith("/facilities")) return Response.json(directory);
      return Response.json([{ courseId: directory[0].courseId, teetimes: [] }]);
    });
    expect(await executeExistingAdapterRecipe(recipe, input, { ...deps, fetch })).toMatchObject({ complete: false, evidence: { reason: "LOCAL_CHROME_REQUIRED" } });
    expect(fetch).not.toHaveBeenCalled();
    let leaseHeld = false;
    const requestLease = async <T>(_family: string, work: () => Promise<T>) => {
      if (leaseHeld) throw new Error("NESTED_SAME_FAMILY_LEASE");
      leaseHeld = true;
      try { return { acquired: true as const, value: await work() }; } finally { leaseHeld = false; }
    };
    const readNativeOfficialPage = vi.fn(async () => (await requestLease("TEEITUP", async () => { calls.push("native-source"); return nativePage; })).value);
    const nativeDeps = { ...deps, fetch, requestLease, localCapabilities: ["LOCAL_CHROME"] as const, readNativeOfficialPage };
    for (const players of [2, 3]) expect(await executeExistingAdapterRecipe(recipe, { ...input, players }, nativeDeps)).toMatchObject({ complete: true });
    expect(readNativeOfficialPage).toHaveBeenCalledTimes(2);
    expect(calls[0]).toBe("native-source");
    expect(calls).not.toContain(source.officialUrl);
    expect(leaseHeld).toBe(false);
    calls.length = 0;
    readNativeOfficialPage.mockResolvedValueOnce({ ...nativePage, visibleEvidence: { ...nativePage.visibleEvidence!, phoneTexts: [] } });
    expect(await executeExistingAdapterRecipe(recipe, input, nativeDeps)).toMatchObject({ complete: false });
    expect(calls.some(url => url.includes("/v2/tee-times"))).toBe(false);
  });
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
