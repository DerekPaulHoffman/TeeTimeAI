import { describe, expect, it } from "vitest";

import { metadata } from "./page";

describe("search page metadata", () => {
  it("identifies the search route consistently in canonical and social metadata", () => {
    expect(metadata.alternates).toEqual({ canonical: "/search" });
    expect(metadata.openGraph).toMatchObject({
      title: "Search Tee Times | Tee Time Spot",
      url: "https://teetimespot.com/search",
      type: "website"
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "Search Tee Times | Tee Time Spot"
    });
  });
});
