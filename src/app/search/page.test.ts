import { describe, expect, it } from "vitest";

import { metadata, searchStructuredData } from "./page";

describe("search page metadata", () => {
  it("identifies the search route consistently in canonical and social metadata", () => {
    expect(metadata.alternates).toEqual({ canonical: "/search" });
    expect(metadata.openGraph).toMatchObject({
      title: "Find Public Golf Tee Times & Set Free Alerts | Tee Time Spot",
      url: "https://teetimespot.com/search",
      type: "website"
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "Find Public Golf Tee Times & Set Free Alerts | Tee Time Spot"
    });
  });

  it("describes the search route as an indexable page with breadcrumbs", () => {
    expect(searchStructuredData).toMatchObject({
      "@context": "https://schema.org",
      "@graph": expect.arrayContaining([
        expect.objectContaining({
          "@type": "WebPage",
          url: "https://teetimespot.com/search"
        }),
        expect.objectContaining({
          "@type": "BreadcrumbList"
        })
      ])
    });
  });
});
