import { NextResponse } from "next/server";
import { clerkMiddleware } from "@clerk/nextjs/server";

import { hasClerkConfig } from "@/lib/env";

const clerkConfigured = hasClerkConfig();

export default clerkConfigured
  ? clerkMiddleware()
  : function proxy() {
      return NextResponse.next();
    };

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"]
};
