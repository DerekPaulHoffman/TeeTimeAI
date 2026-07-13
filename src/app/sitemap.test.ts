import { describe, expect, it } from "vitest";

import sitemap from "./sitemap";

describe("sitemap", () => {
  it("lists every canonical public product route without guessed freshness metadata", () => {
    expect(sitemap()).toEqual([
      { url: "https://teetimespot.com/" },
      { url: "https://teetimespot.com/search" },
      { url: "https://teetimespot.com/how-it-works" },
      { url: "https://teetimespot.com/about" },
      { url: "https://teetimespot.com/methodology" },
      { url: "https://teetimespot.com/guides" },
      { url: "https://teetimespot.com/guides/tee-time-cancellation-alerts" },
      { url: "https://teetimespot.com/guides/public-golf-booking-windows" },
      { url: "https://teetimespot.com/guides/tee-time-alerts-vs-auto-booking" },
      { url: "https://teetimespot.com/contact" },
      { url: "https://teetimespot.com/privacy" },
      { url: "https://teetimespot.com/terms" }
    ]);
  });
});
