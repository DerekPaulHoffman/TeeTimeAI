"use client";

import { ClerkProvider } from "@clerk/nextjs";

export function OptionalClerkProvider({
  children,
  publishableKey
}: {
  children: React.ReactNode;
  publishableKey?: string;
}) {
  if (!publishableKey) {
    return <>{children}</>;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} telemetry={false}>
      {children}
    </ClerkProvider>
  );
}
