import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

import { hasClerkConfig } from "@/lib/env";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/api/searches(.*)"]);

const clerkConfigured = hasClerkConfig();

export default clerkConfigured
  ? clerkMiddleware(async (auth, request) => {
      if (isProtectedRoute(request)) {
        await auth.protect();
      }
    })
  : function proxy() {
      return NextResponse.next();
    };

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"]
};
