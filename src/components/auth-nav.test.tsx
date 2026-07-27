import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDeferredClerkSignIn } from "@/lib/auth/deferred-clerk";

import { AuthNav } from "./auth-nav";
import {
  SignedInAuthControls,
  SignedInUserButton
} from "./signed-in-auth-controls";

vi.mock("@/lib/auth/deferred-clerk", () => ({
  mountDeferredClerkUserButton: vi.fn().mockResolvedValue(() => undefined),
  openDeferredClerkSignIn: vi.fn().mockResolvedValue(undefined)
}));

describe("AuthNav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("keeps signed-out navigation available without initializing Clerk", () => {
    render(
      <AuthNav
        clerkEnabled
        publishableKey="pk_test_example"
        userId={null}
      />
    );

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "My alerts" })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads Clerk only after the signed-out user requests sign-in", async () => {
    render(
      <AuthNav
        clerkEnabled
        publishableKey="pk_test_example"
        userId={null}
      />
    );

    expect(openDeferredClerkSignIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(openDeferredClerkSignIn).toHaveBeenCalledWith("pk_test_example");
    });
  });

  it("omits sign-in when Clerk is unavailable", () => {
    render(<AuthNav clerkEnabled={false} userId={null} />);

    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getByRole("link", { name: "My alerts" })).toBeTruthy();
  });

  it("shows the private overview after the server authorizes the signed-in user", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ operator: true })
    } as Response);

    render(
      <>
        <SignedInAuthControls userId="user_123" />
        <SignedInUserButton publishableKey="pk_test_example" />
      </>
    );

    expect(
      (await screen.findByRole("link", { name: "Site overview" })).getAttribute(
        "href"
      )
    ).toBe("/operator");
    expect(screen.getByTestId("user-button")).toBeTruthy();
  });

  it("hides the private overview when access is denied", async () => {
    render(
      <SignedInAuthControls userId="user_123" />
    );

    expect(screen.queryByRole("link", { name: "Site overview" })).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "/api/operator/access",
      expect.objectContaining({ cache: "no-store" })
    );
  });
});
