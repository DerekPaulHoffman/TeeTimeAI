import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    "/",
    "/search",
    "/how-it-works",
    "/about",
    "/methodology",
    "/guides",
    "/guides/tee-time-cancellation-alerts",
    "/guides/public-golf-booking-windows",
    "/guides/tee-time-alerts-vs-auto-booking",
    "/contact",
    "/privacy",
    "/terms"
  ].map((path) => ({ url: absoluteUrl(path) }));
}
