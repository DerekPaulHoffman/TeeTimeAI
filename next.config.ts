import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
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
