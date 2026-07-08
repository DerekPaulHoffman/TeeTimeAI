"use client";

import Link from "next/link";
import { SignInButton, UserButton, useUser } from "@clerk/nextjs";
import { LayoutDashboard, LogIn } from "lucide-react";

export function AuthNav({ clerkEnabled }: { clerkEnabled: boolean }) {
  if (!clerkEnabled) {
    return (
      <nav className="nav-actions">
        <Link className="text-link" href="/dashboard">
          Dashboard
        </Link>
        <Link className="button button-secondary" href="/#start">
          Email alerts
        </Link>
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
