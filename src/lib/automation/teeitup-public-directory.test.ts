// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildBrowserDiscovery, enrichBrowserDiscoveryWithProviderLease, type BrowserDiscovery } from "./browser-discovery";
import { enrichTeeItUpFromPublicDirectory, type TeeItUpPublicSourceContext } from "./teeitup-public-directory";

const now = new Date("2026-09-08T23:00:00Z");
function fixture() {
  const context: TeeItUpPublicSourceContext = {
    course: { id: "course-a", name: "Spring Lake 9 Hole Golf Course", address: "4020 Hoctor Blvd, Omaha, NE 68107, USA", city: "Omaha", stateCode: "NE", timeZone: "America/Chicago", website: "https://parks.example.org/golf" },
    observation: { courseId: "course-a", pageUrl: "https://parks.example.org/spring-lake", observedAt: now, visibleText: "Spring Lake GC 4020 Hoctor Blvd Omaha NE 68107", links: [{ label: "Book tee times", url: "https://municipal.book.teeitup.com/?course=8336" }] },
  };
  const discovery: BrowserDiscovery = { courseId: "course-a", status: "INSPECTED", detectedPlatform: "TEEITUP", sourceUrl: context.course.website, confidence: 0.2, evidence: { learnedFrom: "teeitup-target-scope-unconfirmed", observedUrls: [] } };
  const facility = { id: 13484, name: "Spring Lake GC", address: "4020 Hoctor Blvd, Omaha, NE 68107, US", timeZone: "America/Chicago" };
  return { context, discovery, facility };
}

describe("official source to public facility directory", () => {
  it("connects ordinary discovery with conflicting visible selectors to a unique directory identity", async () => {
    const { context, facility } = fixture();
    context.observation.links.push({ label: "Book tee times", url: "https://municipal.book.teeitup.com/?course=13485" });
    const observation = context.observation;
    const discovery = buildBrowserDiscovery({
      courseId: context.course.id,
      courseName: context.course.name,
      sourceUrl: context.course.website,
      officialCourseWebsite: context.course.website,
      finalUrl: observation.pageUrl,
      visibleText: observation.visibleText,
      observedUrls: observation.links.map((link) => link.url),
      linkCandidates: observation.links,
      officialPage: { url: observation.pageUrl, courseName: "Spring Lake Golf Course", visibleText: observation.visibleText, linkCandidates: observation.links },
    });
    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.evidence.learnedFrom).toBe("teeitup-target-scope-unconfirmed");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([facility]));
    const result = await enrichTeeItUpFromPublicDirectory(discovery, context, fetchImpl, now);
    expect(result.bookingUrl).toBe("https://municipal.book.teeitup.com/?course=13484");
    expect(result.apiMetadata).toMatchObject({ facilityIds: [13484] });
    expect(result.status).toBe("LEARNED");
  });

  it.each([true, false])("honors the TeeItUp provider lease (acquired=%s)", async (acquired) => {
    const { context, discovery, facility } = fixture();
    context.observation.observedAt = new Date();
    const families: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([facility]));
    const result = await enrichBrowserDiscoveryWithProviderLease(discovery, context.course.name,
      async (family, worker) => {
        families.push(family);
        return acquired ? { acquired: true, value: await worker() } : { acquired: false };
      }, fetchImpl, context);
    expect(families).toEqual(["TEEITUP"]);
    expect(result.acquired).toBe(acquired);
    expect(fetchImpl).toHaveBeenCalledTimes(acquired ? 1 : 0);
    if (result.acquired) expect(result.discovery.bookingUrl).toContain("course=13484");
  });

  it("reconciles a stale selector using fresh matching directory identity", async () => {
    const { context, discovery, facility } = fixture();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([facility]));
    const result = await enrichTeeItUpFromPublicDirectory(discovery, context, fetchImpl, now);
    expect(result.bookingUrl).toBe("https://municipal.book.teeitup.com/?course=13484");
    expect(result.status).toBe("LEARNED");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://phx-api-be-east-1b.kenna.io/alias/municipal/facilities");
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("error");
  });

  it.each([
    (c: TeeItUpPublicSourceContext) => { c.observation.courseId = "different"; },
    (c: TeeItUpPublicSourceContext) => { c.observation.pageUrl = "https://unrelated.example.org/golf"; },
    (c: TeeItUpPublicSourceContext) => { c.observation.observedAt = new Date(now.getTime() - 300_001); },
    (c: TeeItUpPublicSourceContext) => { c.observation.observedAt = new Date(now.getTime() + 1); },
    (c: TeeItUpPublicSourceContext) => { c.observation.visibleText = "Powered and protected by Privacy"; },
    (c: TeeItUpPublicSourceContext) => { c.observation.links[0].url = "http://municipal.book.teeitup.com/"; },
    (c: TeeItUpPublicSourceContext) => { c.observation.links.push({ label: "Book", url: "https://different.book.teeitup.com/" }); },
  ])("does not fetch without usable fresh official source evidence (%#)", async (mutate) => {
    const { context, discovery } = fixture();
    mutate(context);
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await enrichTeeItUpFromPublicDirectory(discovery, context, fetchImpl, now)).toBe(discovery);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves unresolved identity when the directory is ambiguous", async () => {
    const { context, discovery, facility } = fixture();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([facility, { ...facility, id: 13485 }]));
    expect(await enrichTeeItUpFromPublicDirectory(discovery, context, fetchImpl, now)).toBe(discovery);
  });
});
