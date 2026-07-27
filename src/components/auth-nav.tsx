"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SignInButton, UserButton, useUser } from "@clerk/nextjs";
import { Bell, Gauge, LogIn, Search } from "lucide-react";

import { DiscordMark } from "@/components/discord-mark";
import { discordInviteUrl } from "@/lib/community";

export function AuthNav({ clerkEnabled }: { clerkEnabled: boolean }) {
  if (!clerkEnabled) {
    return (
      <nav aria-label="Primary navigation" className="nav-actions">
        <InfoNavLinks />
        <DiscordNavLink />
        <Link
          aria-label="My alerts"
          className="button button-secondary"
          href="/dashboard"
          prefetch={false}
        >
          <Bell size={17} />
          <span className="nav-button-label">My alerts</span>
        </Link>
        <Link
          aria-label="Find a tee time"
          className="button button-primary"
          href="/search"
          prefetch={false}
        >
          <Search size={15} />
          <span className="nav-button-label">Find a tee time</span>
        </Link>
      </nav>
    );
  }

  return <ConfiguredAuthNav />;
}

function ConfiguredAuthNav() {
  const { isLoaded, isSignedIn, user } = useUser();
  const [operatorDecision, setOperatorDecision] = useState<{
    userId: string;
    allowed: boolean;
  } | null>(null);
  const userId = user?.id;

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;

    const controller = new AbortController();
    void fetch("/api/operator/access", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((result: { operator?: boolean } | null) => {
        if (!controller.signal.aborted) {
          setOperatorDecision({
            userId,
            allowed: result?.operator === true
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setOperatorDecision({ userId, allowed: false });
        }
      });

    return () => controller.abort();
  }, [isLoaded, isSignedIn, userId]);

  const operatorAccess =
    Boolean(isSignedIn) &&
    Boolean(userId) &&
    operatorDecision?.userId === userId &&
    operatorDecision?.allowed === true;

  if (!isLoaded) {
    return <nav aria-label="Primary navigation" className="nav-actions" />;
  }

  return (
    <nav aria-label="Primary navigation" className="nav-actions">
      <InfoNavLinks />
      <DiscordNavLink />
      {operatorAccess ? (
        <Link
          aria-label="Site overview"
          className="button button-secondary nav-operator"
          href="/operator"
          prefetch={false}
        >
          <Gauge size={17} />
          <span className="nav-button-label">Site overview</span>
        </Link>
      ) : null}
      <Link
        aria-label="My alerts"
        className="button button-secondary"
        href="/dashboard"
        prefetch={false}
      >
        <Bell size={17} />
        <span className="nav-button-label">My alerts</span>
      </Link>
      <Link
        aria-label="Find a tee time"
        className="button button-primary"
        href="/search"
        prefetch={false}
      >
        <Search size={15} />
        <span className="nav-button-label">Find a tee time</span>
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

function InfoNavLinks() {
  return (
    <span className="nav-info-links">
      <Link href="/how-it-works">How it works</Link>
      <Link href="/guides">Guides</Link>
    </span>
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
