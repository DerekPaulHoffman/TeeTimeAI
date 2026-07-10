"use client";

import Link from "next/link";
import { SignInButton, UserButton, useUser } from "@clerk/nextjs";
import { Bell, LogIn, Search } from "lucide-react";

import { DiscordMark } from "@/components/discord-mark";
import { discordInviteUrl } from "@/lib/community";

export function AuthNav({ clerkEnabled }: { clerkEnabled: boolean }) {
  if (!clerkEnabled) {
    return (
      <nav className="nav-actions">
        <DiscordNavLink />
        <Link className="button button-secondary" href="/dashboard" prefetch={false}>
          <Bell size={17} />
          My alerts
        </Link>
        <Link className="button button-primary" href="/search" prefetch={false}>
          <Search size={15} />
          Find a tee time
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
      <DiscordNavLink />
      <Link className="button button-secondary" href="/dashboard" prefetch={false}>
        <Bell size={17} />
        My alerts
      </Link>
      <Link className="button button-primary" href="/search" prefetch={false}>
        <Search size={15} />
        Find a tee time
      </Link>
      {isSignedIn ? (
        <UserButton />
      ) : (
        <SignInButton mode="modal">
          <button className="button button-ghost nav-sign-in" type="button">
            <LogIn size={17} />
            Sign in
          </button>
        </SignInButton>
      )}
    </nav>
  );
}

function DiscordNavLink() {
  return (
    <a
      aria-label="Join Tee Time Spot Discord for feedback and product suggestions"
      className="button button-community nav-community"
      href={discordInviteUrl}
      rel="noreferrer"
      target="_blank"
    >
      <DiscordMark size={15} />
      <span>Community</span>
    </a>
  );
}
