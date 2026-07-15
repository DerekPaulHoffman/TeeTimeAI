import { describe, expect, it } from "vitest";

import robots from "./robots";

describe("robots", () => {
  it("allows public crawlers, including OAI-SearchBot, while blocking APIs", () => {
    expect(robots()).toMatchObject({
      rules: { userAgent: "*", allow: "/", disallow: ["/api/"] },
      sitemap: "https://teetimespot.com/sitemap.xml"
    });
  });
});
