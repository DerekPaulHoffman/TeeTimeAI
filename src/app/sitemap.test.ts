import { describe, expect, it } from "vitest";

import sitemap from "./sitemap";

describe("sitemap", () => {
  it("lists every canonical public product route without guessed freshness metadata", () => {
    expect(sitemap()).toEqual([
      { url: "https://teetimespot.com/" },
      { url: "https://teetimespot.com/search" }
    ]);
  });
});
