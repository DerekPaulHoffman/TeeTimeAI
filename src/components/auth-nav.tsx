"use client";

import Link from "next/link";
import { SignInButton, UserButton, useUser } from "@clerk/nextjs";
import { LayoutDashboard, LogIn } from "lucide-react";

export function AuthNav() {
  const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  if (!clerkConfigured) {
    return (
      <nav className="nav-actions">
        <Link className="text-link" href="/dashboard">
          Dashboard
        </Link>
        <span className="button button-secondary">Configure Clerk</span>
      </nav>
    );
  }

  return <ConfiguredAuthNav />;
}

function ConfiguredAuthNav() {
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) {
    return <nav className="nav-actions" />;
  }

  return (
    <nav className="nav-actions">
      {isSignedIn ? (
        <>
          <Link className="button button-secondary" href="/dashboard">
            <LayoutDashboard size={17} />
            Dashboard
          </Link>
          <UserButton />
        </>
      ) : (
        <SignInButton mode="modal">
          <button className="button button-secondary" type="button">
            <LogIn size={17} />
            Sign in
          </button>
        </SignInButton>
      )}
    </nav>
  );
}
