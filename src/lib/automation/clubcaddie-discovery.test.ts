import { describe, expect, it, vi } from "vitest";
import { buildBrowserDiscovery, enrichClubCaddieDiscovery } from "./browser-discovery";

const officialUrl = "https://executivegolf.rcgov.org/";
const bookingUrl = "https://apimanager-cc20.clubcaddie.com/webapi/view/fdfdabab";

function source(courseName = "Rapid City Executive Golf") {
  // Shape observed on the actual official page: generic labels, opaque resource
  // slug, and no initial officialPage identity accepted by the strict matcher.
  return {
    courseId: "source-check", courseName, sourceUrl: officialUrl,
    finalUrl: officialUrl, officialCourseWebsite: officialUrl,
    observedUrls: [officialUrl, bookingUrl, "https://clubcaddie.com/"],
    linkCandidates: [
      { url: bookingUrl, label: "Book A Tee Time" },
      { url: bookingUrl, label: "BOOK A TEE TIME" },
      { url: "https://clubcaddie.com/", label: "CLUB CADDIE" }
    ]
  };
}

function publicIdentityFetch(heading: string) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("Public tee sheet", { headers: { "session-id": "transient-public-session" } }))
    .mockResolvedValueOnce(new Response(`${heading}<form id="SearchForm">
      <input name="CourseId" value="12345"><input name="apikey" value="fixture-public-form">
      <input name="HoleGroup" value="front"></form>`));
}

describe("official Club Caddie destination identity", () => {
  it.each([
    ["Rapid City Executive Golf", "Rapid City Executive Course"],
    ["Lake Meadow Golf", "Lake Meadow Course"],
    ["River Oaks Golf Club", "River Oaks Golf Course"],
    ["Meadowbrook Golf Club", "Meadowbrook Golf Club"],
    ["Meadowbrook Golf Course", "Meadowbrook Golf Club"]
  ])("learns %s from its public destination without a course-specific rule", async (courseName, heading) => {
    const initial = buildBrowserDiscovery(source(courseName));
    expect(initial.apiMetadata).toBeUndefined();
    const fetchMock = publicIdentityFetch(`<h1>${heading}</h1>`);
    const result = await enrichClubCaddieDiscovery(initial, courseName, fetchMock);
    expect(result).toMatchObject({ status: "LEARNED", bookingUrl,
      apiMetadata: { provider: "CLUB_CADDIE", bookingBaseUrl: bookingUrl },
      evidence: { publicProviderCourseName: heading,
        courseIdentityCorroboration: { courseName, officialWebsiteUrl: officialUrl, providerUrl: bookingUrl } } });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET" && init.credentials === "omit")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("transient-public-session");
    expect(JSON.stringify(result)).not.toContain("fixture-public-form");
  });

  it.each([
    "<h1>Rapid City Championship Course</h1>",
    "<h1>Rapid City Executive North Course</h1>",
    "<h1>Rapid City Executive Course</h1><h1>Another Course</h1>",
    "<h2>Rapid City Executive Course</h2>"
  ])("does not learn missing, ambiguous or sibling identity: %s", async (heading) => {
    const initial = buildBrowserDiscovery(source());
    const result = await enrichClubCaddieDiscovery(initial, "Rapid City Executive Golf", publicIdentityFetch(heading));
    expect(result).toEqual(initial);
    expect(result.apiMetadata).toBeUndefined();
  });

  it("requires exact official provenance and a single booking destination before provider I/O", async () => {
    const input = source();
    const fetchMock = vi.fn<typeof fetch>();
    for (const invalid of [
      { ...input, officialCourseWebsite: "https://another-course.example/" },
      { ...input, finalUrl: "https://another-course.example/" },
      { ...input, linkCandidates: [...input.linkCandidates, { url: "https://apimanager-cc20.clubcaddie.com/webapi/view/second-course", label: "Book Tee Times" }] }
    ]) {
      const result = await enrichClubCaddieDiscovery(buildBrowserDiscovery(invalid), input.courseName, fetchMock);
      expect(result.apiMetadata).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept a generic identity with no distinctive course name", async () => {
    const initial = buildBrowserDiscovery(source("Golf Course"));
    const result = await enrichClubCaddieDiscovery(initial, "Golf Course", publicIdentityFetch("<h1>Golf Course</h1>"));
    expect(result.apiMetadata).toBeUndefined();
  });

  it("records the inspected official page after an HTTPS upgrade and booking-page followup", async () => {
    const input = { ...source("Meadowbrook Golf Course"),
      sourceUrl: "http://www.golfatmeadowbrook.com/",
      officialCourseWebsite: "http://www.golfatmeadowbrook.com/",
      finalUrl: "https://www.golfatmeadowbrook.com/tee-times" };
    const result = await enrichClubCaddieDiscovery(buildBrowserDiscovery(input), input.courseName,
      publicIdentityFetch("<h1>Meadowbrook Golf Club</h1>"));
    expect(result).toMatchObject({ status: "LEARNED", sourceUrl: input.finalUrl,
      evidence: { courseIdentityCorroboration: { officialWebsiteUrl: input.officialCourseWebsite, officialPageUrl: input.finalUrl } } });
    const downgrade = buildBrowserDiscovery({ ...input, sourceUrl: input.finalUrl,
      officialCourseWebsite: input.finalUrl, finalUrl: input.sourceUrl });
    expect(downgrade.evidence.clubCaddieIdentityCandidate).toBeUndefined();
  });

  it("rejects target changes and leaves access challenges unaccepted", async () => {
    const initial = buildBrowserDiscovery(source());
    const unused = vi.fn<typeof fetch>();
    expect(await enrichClubCaddieDiscovery(initial, "Another Course", unused)).toEqual(initial);
    expect(unused).not.toHaveBeenCalled();
    const challenged = vi.fn<typeof fetch>().mockResolvedValue(new Response("Verify you are human", { status: 403 }));
    await expect(enrichClubCaddieDiscovery(initial, "Rapid City Executive Golf", challenged)).rejects.toThrow();
  });
});
