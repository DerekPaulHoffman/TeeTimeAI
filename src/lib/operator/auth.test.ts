import { beforeEach, describe, expect, it, vi } from "vitest";

const clerkMocks = vi.hoisted(() => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  configEnabled: true
}));

vi.mock("@clerk/nextjs/server", () => clerkMocks);
vi.mock("@/lib/env", () => ({
  hasClerkConfig: () => clerkMocks.configEnabled
}));

import { getCurrentOperator } from "./auth";

describe("getCurrentOperator", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clerkMocks.configEnabled = true;
    process.env.OPERATOR_DASHBOARD_EMAILS = "operator@example.com";
  });

  it("returns the authorized Clerk account using its primary email", async () => {
    clerkMocks.auth.mockResolvedValue({ userId: "clerk-operator" });
    clerkMocks.currentUser.mockResolvedValue({
      primaryEmailAddress: {
        emailAddress: "operator@example.com",
        verification: { status: "verified" }
      },
      emailAddresses: [
        { emailAddress: "other@example.com" },
        { emailAddress: "operator@example.com" }
      ]
    });

    await expect(getCurrentOperator()).resolves.toEqual({
      clerkUserId: "clerk-operator",
      email: "operator@example.com"
    });
  });

  it("does not authorize a matching secondary email", async () => {
    clerkMocks.auth.mockResolvedValue({ userId: "clerk-other" });
    clerkMocks.currentUser.mockResolvedValue({
      primaryEmailAddress: {
        emailAddress: "other@example.com",
        verification: { status: "verified" }
      },
      emailAddresses: [
        { emailAddress: "other@example.com" },
        { emailAddress: "operator@example.com" }
      ]
    });

    await expect(getCurrentOperator()).resolves.toBeNull();
  });

  it("fails closed when the configured primary email is unverified", async () => {
    clerkMocks.auth.mockResolvedValue({ userId: "clerk-operator" });
    clerkMocks.currentUser.mockResolvedValue({
      primaryEmailAddress: {
        emailAddress: "operator@example.com",
        verification: { status: "unverified" }
      }
    });

    await expect(getCurrentOperator()).resolves.toBeNull();
  });

  it("returns null without a signed-in Clerk user", async () => {
    clerkMocks.auth.mockResolvedValue({ userId: null });

    await expect(getCurrentOperator()).resolves.toBeNull();
    expect(clerkMocks.currentUser).not.toHaveBeenCalled();
  });

  it("returns null without invoking Clerk when account mode is unavailable", async () => {
    clerkMocks.configEnabled = false;

    await expect(getCurrentOperator()).resolves.toBeNull();
    expect(clerkMocks.auth).not.toHaveBeenCalled();
    expect(clerkMocks.currentUser).not.toHaveBeenCalled();
  });
});
