import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  turbopack: {
    root: process.cwd()
  }
};

export default withWorkflow(nextConfig);
