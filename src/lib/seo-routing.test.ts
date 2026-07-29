import {
  getRedirectUrl,
  unstable_getResponseFromNextConfig
} from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import { canonicalHostRedirects } from "./seo-routing";

describe("canonical host redirects", () => {
  const nextConfig = {
    async redirects() {
      return canonicalHostRedirects;
    }
  };

  it("permanently redirects www pages to the matching apex URL", async () => {
    const response = await unstable_getResponseFromNextConfig({
      url: "https://www.teetimespot.com/locations/connecticut?source=google",
      nextConfig
    });

    expect(response.status).toBe(308);
    expect(getRedirectUrl(response)).toBe(
      "https://teetimespot.com/locations/connecticut?source=google"
    );
  });

  it("does not redirect the canonical apex host", async () => {
    const response = await unstable_getResponseFromNextConfig({
      url: "https://teetimespot.com/locations/connecticut",
      nextConfig
    });

    expect(response.status).toBe(200);
  });
});
