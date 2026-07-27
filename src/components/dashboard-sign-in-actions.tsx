"use client";

import { ArrowLeft, LogIn } from "lucide-react";
import Link from "next/link";

import { DeferredSignInButton } from "@/components/deferred-sign-in-button";

export function DashboardSignInActions({
  publishableKey
}: {
  publishableKey: string;
}) {
  return (
    <div className="dashboard-auth-actions">
      <DeferredSignInButton
        className="button button-dark"
        publishableKey={publishableKey}
      >
        <LogIn size={17} />
        Sign in
      </DeferredSignInButton>
      <Link className="button button-ghost" href="/search">
        <ArrowLeft size={17} />
        Back to search
      </Link>
    </div>
  );
}
