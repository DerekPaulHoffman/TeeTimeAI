import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";

const title = "Find Tee Times & Indoor Golf Simulators";
const description =
  "Find public golf courses or nearby indoor golf simulators. Set a free email alert for matching openings where supported, then book directly on the official site.";
const path = "/search";

export const searchPageMetadata = buildPageMetadata({
  title,
  description,
  path
});

export const searchStructuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  type: "WebPage"
});
