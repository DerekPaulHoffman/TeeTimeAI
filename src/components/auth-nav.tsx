import Link from "next/link";
import { Bell, LogIn, Search } from "lucide-react";

import { DeferredSignInButton } from "@/components/deferred-sign-in-button";
import { DiscordMark } from "@/components/discord-mark";
import {
  SignedInAuthControls,
  SignedInUserButton
} from "@/components/signed-in-auth-controls";
import { discordInviteUrl } from "@/lib/community";

export function AuthNav({
  clerkEnabled,
  publishableKey,
  userId
}: {
  clerkEnabled: boolean;
  publishableKey?: string;
  userId: string | null;
}) {
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

  return (
    <nav aria-label="Primary navigation" className="nav-actions">
      <InfoNavLinks />
      <DiscordNavLink />
      {userId && publishableKey ? (
        <SignedInAuthControls userId={userId} />
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
      {!userId && publishableKey ? (
        <DeferredSignInButton
          className="button button-ghost nav-sign-in"
          publishableKey={publishableKey}
        >
          <LogIn size={17} />
          Sign in
        </DeferredSignInButton>
      ) : null}
      {userId && publishableKey ? (
        <SignedInUserButton publishableKey={publishableKey} />
      ) : null}
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
