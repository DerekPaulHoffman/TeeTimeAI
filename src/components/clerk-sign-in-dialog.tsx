"use client";

import { ClerkProvider, useClerk } from "@clerk/nextjs";
import { useEffect } from "react";

function OpenSignInDialog() {
  const clerk = useClerk();

  useEffect(() => {
    clerk.openSignIn();
  }, [clerk]);

  return null;
}

export default function ClerkSignInDialog({
  publishableKey
}: {
  publishableKey: string;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey} telemetry={false}>
      <OpenSignInDialog />
    </ClerkProvider>
  );
}
