import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
          id: `user_${clerkState.email}`,
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ operator: false })
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the private overview after the server authorizes the current user", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ operator: true })
    } as Response);

    render(<AuthNav clerkEnabled />);

    expect(
      (await screen.findByRole("link", { name: "Site overview" })).getAttribute("href")
    ).toBe("/operator");
  });

  it("hides the private overview when the server denies access", async () => {
    clerkState.email = "someone@example.com";
    render(<AuthNav clerkEnabled />);

    expect(screen.queryByRole("link", { name: "Site overview" })).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "/api/operator/access",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("hides the private overview while signed out or Clerk is unavailable", () => {
    clerkState.isSignedIn = false;
    const { rerender } = render(<AuthNav clerkEnabled />);
    expect(screen.queryByRole("link", { name: "Site overview" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    rerender(<AuthNav clerkEnabled={false} />);
    expect(screen.queryByRole("link", { name: "Site overview" })).toBeNull();
  });
});
