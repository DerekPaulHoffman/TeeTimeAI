import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";

const title = "Find Public Golf Tee Times & Set Free Alerts";
const description =
  "Search nearby public golf courses and create free golf tee time alerts for your preferred date, time window, and group size.";
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
