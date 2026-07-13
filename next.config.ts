import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

import { browserSecurityHeaders } from "./src/lib/security/response-headers";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...browserSecurityHeaders]
      }
    ];
  },
  images: {
    qualities: [75],
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
