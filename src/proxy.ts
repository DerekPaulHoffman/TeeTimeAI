import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";

import { getClerkConfig } from "@/lib/env";

const clerkConfig = getClerkConfig();

if (clerkConfig) {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = clerkConfig.publishableKey;
  process.env.CLERK_SECRET_KEY = clerkConfig.secretKey;
}

const clerkProxyPromise = clerkConfig
  ? import("@clerk/nextjs/server").then(({ clerkMiddleware }) =>
      clerkMiddleware({ publishableKey: clerkConfig.publishableKey })
    )
  : undefined;

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!clerkProxyPromise) {
    return NextResponse.next();
  }

  const clerkProxy = await clerkProxyPromise;
  return clerkProxy(request, event);
}

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"]
};
