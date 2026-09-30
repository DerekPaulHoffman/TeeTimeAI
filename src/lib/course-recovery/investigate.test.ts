// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { investigateCourseRecovery } from "@/lib/course-recovery/investigate";
import type { RecoveryPlace } from "@/lib/course-recovery/places";
import { buildGooglePlaceReviewIndex, type GooglePlaceReviewRecord } from "@/lib/places/google-place-reviews";

const mocks = vi.hoisted(() => ({
  lease: vi.fn(async (_family: string, worker: () => Promise<unknown>): Promise<{ acquired: boolean; value?: unknown }> => ({ acquired: true, value: await worker() })),
  findMany: vi.fn(),
}));
vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: mocks.lease }));
vi.mock("@/lib/prisma", () => ({ prisma: { course: { findMany: mocks.findMany } } }));

const input = { name: "Aster Dunes Golf Course", town: "Hollowford, CT" };
const emptyReviews = buildGooglePlaceReviewIndex([]);

function place(overrides: Partial<RecoveryPlace> = {}, candidateOverrides: Partial<RecoveryPlace["candidate"]> = {}): RecoveryPlace {
  return {
    source: "GOOGLE", primaryType: "golf_course", types: ["golf_course"], businessStatus: "OPERATIONAL",
    ...overrides,
    candidate: {
      googlePlaceId: "unfamiliar-aster", name: input.name,
      address: "12 Dune Road, Hollowford, CT 06400, USA", city: "Hollowford", stateCode: "CT", stateName: "Connecticut",
      latitude: 41.3, longitude: -72.8, timeZone: "America/New_York",
      website: "https://asterdunes.example.com/", publicAccessStatus: "UNVERIFIED",
      ...candidateOverrides,
    },
  };
}

function review(overrides: Partial<GooglePlaceReviewRecord> = {}): GooglePlaceReviewRecord {
  return {
    googlePlaceId: "unfamiliar-aster", name: input.name, accessOverride: "VERIFIED_PUBLIC",
    classification: "Official public-course evidence", evidenceUrl: "https://asterdunes.example.com/",
    reviewedAt: new Date("2026-09-29"), active: true, canonicalPlaceId: null, canonicalName: null,
    canonicalAddress: null, canonicalWebsiteUrl: null, canonicalPhone: null,
    latitude: null, longitude: null, retainWhenCanonicalAbsent: false,
    ...overrides,
  };
}

function html(extra = "", name = input.name) {
  return `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1><p>An 18-hole public golf course in Hollowford, Connecticut.</p><a href="https://public-tees.example.com/aster-dunes">Book tee times</a>${extra}</body></html>`;
}

function pageResponse(body = html(), status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

function dependencies(places: RecoveryPlace[] = [place()], body = html()) {
  return {
    loadReviews: vi.fn(async () => emptyReviews),
    findCataloguePlaces: vi.fn(async () => [] as RecoveryPlace[]),
    searchPlaces: vi.fn(async () => places),
    officialFetch: vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => pageResponse(body)),
  };
}

describe("bounded missing-course identity investigation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recovers a real-but-missed persisted identity with current official booking evidence", async () => {
    const deps = dependencies();
    deps.findCataloguePlaces.mockResolvedValue([place({ source: "CATALOGUE", isPublic: null }, { courseId: "existing-course" })]);
    const result = await investigateCourseRecovery(input, deps);
    expect(result).toMatchObject({ status: "VERIFIED", bookingUrl: "https://public-tees.example.com/aster-dunes", course: { courseId: "existing-course", publicAccessStatus: "PUBLIC", monitoringReadiness: "VERIFYING", monitoringSupport: "UNCONFIRMED" } });
    expect(deps.searchPlaces).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(deps.officialFetch).toHaveBeenCalledTimes(1);
    expect(deps.officialFetch.mock.calls[0]?.[0]).toBeInstanceOf(URL);
  });

  it("recovers an unfamiliar sports-club shape only after positive public playable-course evidence", async () => {
    const deps = dependencies([place({ primaryType: "sports_club", types: ["sports_club", "golf_course"] })]);
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "VERIFIED", course: { googlePlaceId: "unfamiliar-aster", publicAccessStatus: "PUBLIC" } });
  });

  it("runs bounded alternate discovery when a catalogue source is stale and reuses the canonical course id", async () => {
    const deps = dependencies([place()]);
    deps.findCataloguePlaces.mockResolvedValue([place({ source: "CATALOGUE", isPublic: null }, { courseId: "existing-course", website: "https://oldaster.example.com/" })]);
    deps.officialFetch.mockImplementation(async url => String(url).includes("oldaster") ? pageResponse("missing", 404) : pageResponse());
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "VERIFIED", course: { courseId: "existing-course", website: "https://asterdunes.example.com/" } });
    expect(deps.searchPlaces).toHaveBeenCalledTimes(1);
    expect(deps.officialFetch).toHaveBeenCalledTimes(2);
  });

  it("does not equate a typed golf result and a booking link with public access", async () => {
    const deps = dependencies([place()], `<h1>${input.name}</h1><p>A golf course in Hollowford.</p><a href="/tee-times">Tee times</a>`);
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "UNRESOLVED" });
  });

  it("accepts reviewed public access only when the current official course and booking source agree", async () => {
    const deps = dependencies([place()], `<h1>${input.name}</h1><p>An 18-hole golf course in Hollowford, Connecticut.</p><a href="/tee-times">Tee times</a>`);
    deps.loadReviews.mockResolvedValue(buildGooglePlaceReviewIndex([review()]));
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "VERIFIED" });
  });

  it.each(["VERIFIED_PRIVATE", "VERIFIED_NON_COURSE"] as const)("preserves exact %s exclusions before reading a website", async accessOverride => {
    const deps = dependencies();
    deps.loadReviews.mockResolvedValue(buildGooglePlaceReviewIndex([review({ accessOverride })]));
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "NOT_PUBLIC" });
    expect(deps.officialFetch).not.toHaveBeenCalled();
  });

  it("preserves a canonical private exclusion even when an alias review says public", async () => {
    const deps = dependencies();
    deps.loadReviews.mockResolvedValue(buildGooglePlaceReviewIndex([
      review({ canonicalPlaceId: "canonical-aster" }), review({ googlePlaceId: "canonical-aster", accessOverride: "VERIFIED_PRIVATE" }),
    ]));
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "NOT_PUBLIC" });
    expect(deps.officialFetch).not.toHaveBeenCalled();
  });

  it("preserves a persisted private snapshot despite a public review", async () => {
    const deps = dependencies();
    deps.findCataloguePlaces.mockResolvedValue([place({ source: "CATALOGUE", isPublic: false })]);
    deps.loadReviews.mockResolvedValue(buildGooglePlaceReviewIndex([review()]));
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "NOT_PUBLIC" });
  });

  it.each([
    place({ primaryType: "sporting_goods_store" }),
    place({}, { name: "Aster Dunes Golf Course Pro Shop" }),
    place({ typeLabel: "Private golf course" }),
  ])("never promotes private or non-course provider shapes", async candidate => {
    const result = await investigateCourseRecovery(input, dependencies([candidate]));
    expect(result.status).not.toBe("VERIFIED");
  });

  it("rejects a currently private official page despite an older public review", async () => {
    const deps = dependencies([place()], html("<p>This is a private golf club, open only to members.</p>"));
    deps.loadReviews.mockResolvedValue(buildGooglePlaceReviewIndex([review()]));
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "NOT_PUBLIC" });
  });

  it("asks for the precise sibling course rather than promoting its parent facility", async () => {
    const result = await investigateCourseRecovery(input, dependencies([place({}, { name: "Aster Dunes North Golf Course" })]));
    expect(result).toMatchObject({ status: "NEEDS_DETAILS", reason: expect.stringContaining("Aster Dunes North") });
  });

  it("does not substitute a different color/layout course", async () => {
    const result = await investigateCourseRecovery({ ...input, name: "Aster Dunes Red Golf Course" }, dependencies([place({}, { name: "Aster Dunes Black Golf Course" })]));
    expect(result.status).not.toBe("VERIFIED");
  });

  it("keeps a mixed sibling official page ambiguous even when one heading matches", async () => {
    const body = html("<h1>Aster Dunes North Golf Course</h1>");
    expect(await investigateCourseRecovery(input, dependencies([place()], body))).toMatchObject({ status: "NEEDS_DETAILS", reason: expect.stringContaining("North") });
  });

  it("does not let nearby coordinates prove the requested town", async () => {
    const deps = dependencies([place({}, { city: "Otherford", address: "12 Dune Road, Otherford, CT 06401" })]);
    const result = await investigateCourseRecovery({ ...input, latitude: 41.3, longitude: -72.8 }, deps);
    expect(result).toMatchObject({ status: "NEEDS_DETAILS", reason: expect.stringContaining("Otherford") });
    expect(deps.officialFetch).not.toHaveBeenCalled();
  });

  it("keeps a same-name town in a different state separate", async () => {
    const result = await investigateCourseRecovery(input, dependencies([place({}, { stateCode: "NY", stateName: "New York", address: "12 Dune Road, Hollowford, NY 12000" })]));
    expect(result.status).not.toBe("VERIFIED");
  });

  it("detects a current official address that conflicts with the provider town", async () => {
    const structured = `<script type="application/ld+json">${JSON.stringify({ "@type": "GolfCourse", name: input.name, address: { addressLocality: "Otherford", addressRegion: "CT" } })}</script>`;
    expect(await investigateCourseRecovery(input, dependencies([place()], html(structured)))).toMatchObject({ status: "NEEDS_DETAILS", reason: expect.stringContaining("Otherford") });
  });

  it("can corroborate a missing provider town from a course-scoped official address", async () => {
    const structured = `<script type="application/ld+json">${JSON.stringify({ "@type": "GolfCourse", name: input.name, address: { addressLocality: "Hollowford", addressRegion: "CT" } })}</script>`;
    expect(await investigateCourseRecovery(input, dependencies([place({}, { city: undefined, address: undefined })], html(structured)))).toMatchObject({ status: "VERIFIED" });
  });

  it("returns a precise choice when distinct verified facilities share a name and town", async () => {
    const second = place({}, { googlePlaceId: "second-aster", address: "900 Cove Road, Hollowford, CT 06400", latitude: 41.32, website: "https://secondaster.example.com/" });
    const result = await investigateCourseRecovery(input, dependencies([place(), second]));
    expect(result).toMatchObject({ status: "NEEDS_DETAILS", reason: expect.stringContaining("12 Dune Road") });
    if (result.status === "NEEDS_DETAILS") expect(result.reason).toContain("900 Cove Road");
  });

  it("honors a reviewed canonical alias without creating duplicate course knowledge", async () => {
    const aliasName = "Old Aster Links Golf Course";
    const deps = dependencies([place({}, { name: aliasName, googlePlaceId: "old-aster" })]);
    deps.loadReviews.mockResolvedValue(buildGooglePlaceReviewIndex([review({
      googlePlaceId: "old-aster", name: aliasName, canonicalPlaceId: "canonical-aster", canonicalName: input.name,
      canonicalAddress: "12 Dune Road, Hollowford, CT 06400, USA", canonicalWebsiteUrl: "https://asterdunes.example.com/",
    })]));
    const result = await investigateCourseRecovery({ ...input, name: aliasName }, deps);
    expect(result).toMatchObject({ status: "VERIFIED", course: { googlePlaceId: "canonical-aster", name: input.name, city: "Hollowford" } });
  });

  it("matches a full requested state name against a canonical state code without relaxing source proof", async () => {
    const deps = dependencies([place({}, { stateName: undefined })]);
    expect(await investigateCourseRecovery({ ...input, town: "Hollowford, Connecticut" }, deps)).toMatchObject({ status: "VERIFIED" });
    deps.officialFetch.mockResolvedValue(pageResponse(html().replace("Connecticut", "New York")));
    expect(await investigateCourseRecovery({ ...input, town: "Hollowford, Connecticut" }, deps)).toMatchObject({ status: "UNRESOLVED" });
  });

  it("keeps fictional or empty bounded research unresolved without claiming nonexistence", async () => {
    const deps = dependencies([]);
    const result = await investigateCourseRecovery({ name: "Moonlit Dragon Golf Course", town: "Imaginaryford, CT" }, deps);
    expect(result).toMatchObject({ status: "UNRESOLVED", evidenceSummary: expect.stringContaining("does not mean it does not exist") });
    expect(deps.officialFetch).not.toHaveBeenCalled();
  });

  it("requires current booking/contact facts before returning a selectable public course", async () => {
    const deps = dependencies([place()], `<h1>${input.name}</h1><p>An 18-hole public golf course in Hollowford, Connecticut.</p>`);
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "UNRESOLVED", evidenceSummary: expect.stringContaining("booking or contact") });
  });

  it("keeps an official factual phone-only path selectable without claiming automatic monitoring", async () => {
    const deps = dependencies([place({}, { phone: "2035550100" })], `<h1>${input.name}</h1><p>An 18-hole public golf course in Hollowford, Connecticut. Reserve tee times by phone.</p>`);
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "VERIFIED", bookingUrl: null, course: { monitoringSupport: "MANUAL_ONLY", publicAccessStatus: "PUBLIC" } });
  });

  it("ignores booking-automation policy wording when public identity/source evidence is readable", async () => {
    expect(await investigateCourseRecovery(input, dependencies([place()], html("<p>Automated reservations and booking bots are prohibited.</p>")))).toMatchObject({ status: "VERIFIED" });
  });

  it("does not classify members-only league or booking-window terms as a private facility", async () => {
    expect(await investigateCourseRecovery(input, dependencies([place()], html("<p>Tuesday league times are members only. Members only may book more than seven days ahead. Public golfers can book within seven days.</p>")))).toMatchObject({ status: "VERIFIED" });
  });

  it("requires town evidence from the official course source rather than only the provider", async () => {
    const body = `<h1>${input.name}</h1><p>An 18-hole public golf course.</p><a href="/tee-times">Book tee times</a>`;
    expect(await investigateCourseRecovery(input, dependencies([place()], body))).toMatchObject({ status: "UNRESOLVED", evidenceSummary: expect.stringContaining("official source") });
  });

  it("does not use an incidental nearby-town mention as course location evidence", async () => {
    const body = `<h1>${input.name}</h1><p>An 18-hole public golf course near Hollowford, Connecticut.</p><a href="/tee-times">Book tee times</a>`;
    expect(await investigateCourseRecovery(input, dependencies([place()], body))).toMatchObject({ status: "UNRESOLVED" });
  });

  it("requires the requested state to appear in an official location assertion", async () => {
    const body = `<h1>${input.name}</h1><p>A public golf course in Hollowford.</p><a href="/tee-times">Book tee times</a>`;
    expect(await investigateCourseRecovery(input, dependencies([place()], body))).toMatchObject({ status: "UNRESOLVED" });
  });

  it("corroborates an official contact page without fetching its booking provider", async () => {
    const deps = dependencies();
    deps.officialFetch.mockImplementation(async url => String(url).endsWith("/contact")
      ? pageResponse(`<h1>Contact</h1><address>12 Dune Road, Hollowford, CT 06400</address>`)
      : pageResponse(`<h1>${input.name}</h1><p>A public golf course.</p><a href="/contact">Contact</a><a href="https://public-tees.example.com/aster-dunes">Book tee times</a>`));
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "VERIFIED" });
    expect(deps.officialFetch).toHaveBeenCalledTimes(2);
    expect(deps.officialFetch.mock.calls.every(([url]) => new URL(String(url)).hostname === "asterdunes.example.com")).toBe(true);
  });

  it("keeps conflicting official contact location evidence ambiguous", async () => {
    const deps = dependencies();
    deps.officialFetch.mockImplementation(async url => String(url).endsWith("/contact")
      ? pageResponse(`<h1>${input.name}</h1><address>12 Dune Road, Hollowford, NY 12000</address><a href="/tee-times">Book tee times</a>`)
      : pageResponse(`<h1>${input.name}</h1><p>An 18-hole public golf course in Hollowford, Connecticut.</p><a href="/contact">Contact</a>`));
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "NEEDS_DETAILS", evidenceUrl: "https://asterdunes.example.com/contact" });
  });

  it("does not borrow a provider state code to repair conflicting official address evidence", async () => {
    const body = html("<address>12 Dune Road, Hollowford, NY 12000</address>");
    expect(await investigateCourseRecovery(input, dependencies([place()], body))).toMatchObject({ status: "NEEDS_DETAILS" });
  });

  it("uses a supplied street-address hint only to narrow independently discovered facilities", async () => {
    const second = place({}, { googlePlaceId: "second-aster", address: "900 Cove Road, Hollowford, CT 06400", latitude: 41.32, website: "https://secondaster.example.com/" });
    const deps = dependencies([place(), second]);
    expect(await investigateCourseRecovery({ ...input, address: "900 Cove Road" }, deps)).toMatchObject({ status: "VERIFIED", course: { googlePlaceId: "second-aster" } });
    expect(deps.officialFetch).toHaveBeenCalledTimes(1);
  });

  it("uses an official-host hint to choose an independently discovered course and never fetches a supplied arbitrary URL", async () => {
    const second = place({}, { googlePlaceId: "second-aster", address: "900 Cove Road, Hollowford, CT 06400", latitude: 41.32, website: "https://secondaster.example.com/" });
    const deps = dependencies([place(), second]);
    expect(await investigateCourseRecovery({ ...input, officialWebsite: "https://secondaster.example.com/contact" }, deps)).toMatchObject({ status: "VERIFIED", course: { googlePlaceId: "second-aster" } });
    const unknown = dependencies();
    expect(await investigateCourseRecovery({ ...input, officialWebsite: "https://unknown.example.com/" }, unknown)).toMatchObject({ status: "UNRESOLVED" });
    expect(unknown.officialFetch).not.toHaveBeenCalled();
  });

  it("does not collect checkout or credential-bearing links as booking sources", async () => {
    const body = `<h1>${input.name}</h1><p>An 18-hole public golf course.</p><a href="https://provider.example.com/checkout">Book tee times</a><a href="https://provider.example.com/tee-times?token=secret">Book tee times</a>`;
    expect(await investigateCourseRecovery(input, dependencies([place()], body))).toMatchObject({ status: "UNRESOLVED" });
  });

  it.each([429, 500, 503])("throws a transient official HTTP %i error for automatic retry", async status => {
    const deps = dependencies(); deps.officialFetch.mockImplementation(async () => pageResponse("temporary", status));
    await expect(investigateCourseRecovery(input, deps)).rejects.toThrow("temporarily failed");
  });

  it("propagates failed provider evidence instead of translating it into a miss", async () => {
    const deps = dependencies(); deps.searchPlaces.mockRejectedValue(new Error("Places unavailable"));
    await expect(investigateCourseRecovery(input, deps)).rejects.toThrow("Places unavailable");
  });

  it("fails closed before provider work when active reviews cannot be read", async () => {
    const deps = dependencies(); deps.loadReviews.mockRejectedValue(new Error("reviews unavailable"));
    await expect(investigateCourseRecovery(input, deps)).rejects.toThrow("reviews unavailable");
    expect(deps.searchPlaces).not.toHaveBeenCalled();
    expect(deps.officialFetch).not.toHaveBeenCalled();
  });

  it.each([401, 403])("reports only a factual current HTTP %i access boundary", async status => {
    const deps = dependencies(); deps.officialFetch.mockImplementation(async () => pageResponse("denied", status));
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "ACCESS_LIMITED", reason: expect.stringContaining(`HTTP ${status}`) });
  });

  it("identifies an actual returned challenge document without attempting a bypass", async () => {
    const deps = dependencies([place()], "<title>Just a moment</title><div>Verify you are human</div><script src='/cdn-cgi/challenge-platform'></script>");
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "ACCESS_LIMITED" });
    expect(deps.officialFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an official 404 unresolved rather than claiming the course is gone", async () => {
    const deps = dependencies(); deps.officialFetch.mockImplementation(async () => pageResponse("missing", 404));
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "UNRESOLVED" });
  });

  it.each(["http://127.0.0.1/", "http://169.254.169.254/", "https://user:secret@asterdunes.example.com/", "file:///private", "https://google.com/search?q=golf"])("rejects unsafe or search URLs before reading %s", async website => {
    const deps = dependencies([place({}, { website })]);
    expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "UNRESOLVED" });
    expect(deps.officialFetch).not.toHaveBeenCalled();
  });

  it("pins public DNS and refuses a private resolved destination without an HTTP request", async () => {
    const requestPinned = vi.fn(async () => pageResponse());
    const deps = dependencies();
    const result = await investigateCourseRecovery(input, {
      ...deps, officialFetch: undefined,
      publicFetchDependencies: { resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }], requestPinned },
    });
    expect(result).toMatchObject({ status: "UNRESOLVED" });
    expect(requestPinned).not.toHaveBeenCalled();
    expect(mocks.lease).toHaveBeenCalledWith("asterdunes.example.com", expect.any(Function));
  });

  it("rejects redirects to a private address or a different host before following them", async () => {
    for (const location of ["http://127.0.0.1/", "https://different-course.example.com/"]) {
      const deps = dependencies();
      deps.officialFetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location } }));
      expect(await investigateCourseRecovery(input, deps)).toMatchObject({ status: "UNRESOLVED" });
      expect(deps.officialFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("leases the actual provider family on each default public source read", async () => {
    const candidate = place({}, { website: "https://foreupsoftware.com/index.php/booking/aster" });
    const deps = dependencies([candidate]);
    const requestPinned = vi.fn(async () => pageResponse());
    expect(await investigateCourseRecovery(input, {
      ...deps, officialFetch: undefined,
      publicFetchDependencies: { resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }], requestPinned },
    })).toMatchObject({ status: "VERIFIED" });
    expect(mocks.lease).toHaveBeenCalledWith("FOREUP", expect.any(Function));
    expect(requestPinned).toHaveBeenCalledTimes(1);
  });

  it("does not read a provider when the global/family lease is unavailable", async () => {
    mocks.lease.mockResolvedValueOnce({ acquired: false });
    const requestPinned = vi.fn(async () => pageResponse());
    await expect(investigateCourseRecovery(input, {
      ...dependencies(), officialFetch: undefined,
      publicFetchDependencies: { resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }], requestPinned },
    })).rejects.toThrow("provider capacity");
    expect(requestPinned).not.toHaveBeenCalled();
  });

  it("holds the default provider lease through the response body", async () => {
    const order: string[] = [];
    mocks.lease.mockImplementationOnce(async (_family, worker) => {
      order.push("claimed"); const value = await worker(); order.push("released"); return { acquired: true, value };
    });
    const requestPinned = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { order.push("body read"); controller.enqueue(new TextEncoder().encode(html())); controller.close(); },
    }), { headers: { "Content-Type": "text/html" } }));
    expect(await investigateCourseRecovery(input, {
      ...dependencies(), officialFetch: undefined,
      publicFetchDependencies: { resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }], requestPinned },
    })).toMatchObject({ status: "VERIFIED" });
    expect(order).toEqual(["claimed", "body read", "released"]);
  });
});
