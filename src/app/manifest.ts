import type { MetadataRoute } from "next";

import { absoluteUrl, siteDescription, siteName } from "@/lib/seo";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteName,
    short_name: "Tee Time Spot",
    description: siteDescription,
    start_url: absoluteUrl("/"),
    display: "standalone",
    background_color: "#f4efe5",
    theme_color: "#111d18",
    icons: [
      {
        src: absoluteUrl("/icon.svg"),
        sizes: "any",
        type: "image/svg+xml"
      }
    ]
  };
}
