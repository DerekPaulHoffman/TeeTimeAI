import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

import { browserSecurityHeaders } from "./src/lib/security/response-headers";
import { canonicalHostRedirects } from "./src/lib/seo-routing";

const nextConfig: NextConfig = {
  async redirects() {
    return canonicalHostRedirects;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...browserSecurityHeaders]
      }
    ];
  },
  images: {
    qualities: [50, 60, 75],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        pathname: "/photo-1535131749006-b7f58c99034b"
      }
    ]
  },
  typedRoutes: true,
  turbopack: {
    root: process.cwd()
  }
};

export default withWorkflow(nextConfig);
