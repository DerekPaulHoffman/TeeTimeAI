import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthNav } from "./auth-nav";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  email: "derekpaulhoffman@gmail.com"
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    user: clerkState.isSignedIn
      ? {
          primaryEmailAddress: {
            emailAddress: clerkState.email
          }
        }
      : null
  }),
  SignInButton: ({ children }: { children: React.ReactNode }) => children,
  UserButton: () => <span data-testid="user-button" />
}));

describe("AuthNav operator access", () => {
  beforeEach(() => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.email = "derekpaulhoffman@gmail.com";
  });

  it("keeps the server-only operator allowlist out of client navigation", () => {
    render(<AuthNav clerkEnabled />);

    expect(screen.queryByRole("link", { name: "Site overview" })).toBeNull();
  });

  it("hides the private overview from other signed-in accounts", () => {
    clerkState.email = "someone@example.com";
    render(<AuthNav clerkEnabled />);

    expect(screen.queryByRole("link", { name: "Site overview" })).toBeNull();
  });

  it("hides the private overview while signed out or Clerk is unavailable", () => {
    clerkState.isSignedIn = false;
    const { rerender } = render(<AuthNav clerkEnabled />);
    expect(screen.queryByRole("link", { name: "Site overview" })).toBeNull();

    rerender(<AuthNav clerkEnabled={false} />);
    expect(screen.queryByRole("link", { name: "Site overview" })).toBeNull();
  });
});
