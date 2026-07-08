"use client";

import { ClerkProvider } from "@clerk/nextjs";

export function OptionalClerkProvider({
  children,
  enabled
}: {
  children: React.ReactNode;
  enabled: boolean;
}) {
  if (!enabled) {
    return <>{children}</>;
  }

  return <ClerkProvider>{children}</ClerkProvider>;
}
