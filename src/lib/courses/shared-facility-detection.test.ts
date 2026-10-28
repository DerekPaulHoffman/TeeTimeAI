import { describe, expect, it } from "vitest";
import { detectOfficialSharedFacility } from "./shared-facility-detection";

const course = (name: string, path: string, latitude = 41.24, longitude = -73.2) => ({
  "@type": "GolfCourse", name, url: `https://official.example/${path}`, geo: { latitude, longitude },
});
const north = course("Cedar Ridge North Course", "north"), south = course("Cedar Ridge South Course", "south", 41.241);
const page = (children: unknown[] = [north, south]) => `<script type="application/ld+json">${JSON.stringify({ "@type": "SportsActivityLocation", containsPlace: children })}</script>`;
const detect = (html = page()) => detectOfficialSharedFacility({ html, sourceUrl: "https://official.example/", courseName: north.name });

describe("provider-independent official facility detection", () => {
  it("detects explicit co-located physical courses, leaving access and layouts unverified", () => {
    const result = detect()!;
    expect(result.method).toBe("OFFICIAL_CONTAINS_PLACE");
    expect(result.primaryKey).toBe(north.url);
    expect(result.courses.map(row => [row.name, row.publicAccess])).toEqual([[north.name, "PENDING"], [south.name, "PENDING"]]);
    expect(JSON.stringify(result)).not.toContain("layoutHoleCounts");
  });
  it("resolves explicit graph references at a different facility and location", () => {
    const children = [course("Desert West Golf Course", "west", 33.42, -111.92), course("Desert East Golf Course", "east", 33.421, -111.921)]
      .map(row => ({ ...row, "@id": row.url }));
    const html = `<script type='application/ld+json'>${JSON.stringify({ "@graph": [
      { "@type": "Place", containsPlace: children.map(row => ({ "@id": row.url })) }, ...children,
    ] })}</script>`;
    expect(detectOfficialSharedFacility({ html, sourceUrl: "https://official.example/courses", courseName: children[0].name })?.courses).toHaveLength(2);
  });
  it.each(["foreign-host", "far-away", "duplicate-name", "duplicate-url", "not-course", "no-geo", "no-url", "member", "rate", "front-nine", "checkout", "malformed"])("rejects %s evidence", mode => {
    const children = structuredClone([north, south]) as Array<Record<string, unknown>>;
    if (mode === "foreign-host") children[1].url = "https://chain.example/south";
    if (mode === "far-away") children[1].geo = { latitude: 40, longitude: -72 };
    if (mode === "duplicate-name") children[1].name = north.name;
    if (mode === "duplicate-url") children[1].url = north.url;
    if (mode === "not-course") children[1]["@type"] = "Product";
    if (mode === "no-geo") delete children[1].geo;
    if (mode === "no-url") delete children[1].url;
    if (mode === "member") children[1].name = "Members Golf Course";
    if (mode === "rate") children[1].name = "Senior Rate";
    if (mode === "front-nine") children[1].name = "Front Nine Course";
    if (mode === "checkout") children[1].url = "https://official.example/checkout";
    expect(detect(mode === "malformed" ? "<script type='application/ld+json'>broken</script>" : page(children))).toBeNull();
  });
  it("does not group nearby listings, a chain's graph, or an ambiguous root", () => {
    expect(detect(`<script type="application/ld+json">${JSON.stringify([north, south])}</script>`)).toBeNull();
    expect(detectOfficialSharedFacility({ html: page(), sourceUrl: "https://official.example", courseName: "Cedar Ridge Resort" })).toBeNull();
    expect(detect(page() + page())).toBeNull();
  });
});
