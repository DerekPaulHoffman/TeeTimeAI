import { afterEach, describe, expect, it } from "vitest";

import {
  buildPageMetadata,
  buildPageStructuredData,
  getSiteVerification,
  siteDescription
} from "./seo";

describe("SEO helpers", () => {
  const originalGoogleVerification = process.env.GOOGLE_SITE_VERIFICATION;
  const originalBingVerification = process.env.BING_SITE_VERIFICATION;

  afterEach(() => {
    setOptionalEnv("GOOGLE_SITE_VERIFICATION", originalGoogleVerification);
    setOptionalEnv("BING_SITE_VERIFICATION", originalBingVerification);
  });

  it("builds a self-canonical article metadata record", () => {
    const metadata = buildPageMetadata({
      title: "Cancellation alerts",
      description: "A useful guide.",
      path: "/guides/cancellation-alerts",
      type: "article"
    });

    expect(metadata.alternates).toEqual({ canonical: "/guides/cancellation-alerts" });
    expect(metadata.openGraph).toMatchObject({
      title: "Cancellation alerts | Tee Time Spot",
      url: "https://teetimespot.com/guides/cancellation-alerts",
      type: "article"
    });
  });

  it("builds page and breadcrumb structured data with a stable organization id", () => {
    const data = buildPageStructuredData({
      name: "Cancellation alerts",
      description: "A useful guide.",
      path: "/guides/cancellation-alerts",
      type: "Article",
      datePublished: "2026-07-13",
      breadcrumbs: [
        { name: "Home", path: "/" },
        { name: "Guides", path: "/guides" },
        { name: "Cancellation alerts", path: "/guides/cancellation-alerts" }
      ]
    });

    expect(data["@graph"][0]).toMatchObject({
      "@type": "Article",
      "@id": "https://teetimespot.com/guides/cancellation-alerts#webpage",
      headline: "Cancellation alerts",
      author: { "@id": "https://teetimespot.com/#organization" }
    });
    expect(data["@graph"][1]).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { position: 1, name: "Home", item: "https://teetimespot.com/" },
        { position: 2, name: "Guides", item: "https://teetimespot.com/guides" },
        {
          position: 3,
          name: "Cancellation alerts",
          item: "https://teetimespot.com/guides/cancellation-alerts"
        }
      ]
    });
  });

  it("emits verification metadata only when provider tokens are configured", () => {
    delete process.env.GOOGLE_SITE_VERIFICATION;
    delete process.env.BING_SITE_VERIFICATION;
    expect(getSiteVerification()).toBeUndefined();

    process.env.GOOGLE_SITE_VERIFICATION = " google-token ";
    process.env.BING_SITE_VERIFICATION = " bing-token ";
    expect(getSiteVerification()).toEqual({
      google: "google-token",
      other: { "msvalidate.01": "bing-token" }
    });
  });

  it("defines the product as free, public-golf focused, and alert-only", () => {
    expect(siteDescription).toMatch(/free/i);
    expect(siteDescription).toMatch(/alert-only/i);
    expect(siteDescription).toMatch(/public golf/i);
    expect(siteDescription).toMatch(/official booking link/i);
  });
});

function setOptionalEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
