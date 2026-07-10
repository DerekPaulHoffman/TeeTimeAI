"use client";

import { SignInButton } from "@clerk/nextjs";
import { ArrowLeft, LogIn } from "lucide-react";
import Link from "next/link";

export function DashboardSignInActions() {
  return (
    <div className="dashboard-auth-actions">
      <SignInButton mode="modal">
        <button className="button button-dark" type="button">
          <LogIn size={17} />
          Sign in
        </button>
      </SignInButton>
      <Link className="button button-ghost" href="/search">
        <ArrowLeft size={17} />
        Back to search
      </Link>
    </div>
  );
}
