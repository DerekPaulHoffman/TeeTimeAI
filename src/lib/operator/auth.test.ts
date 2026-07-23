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
  });

  it("returns the authorized Clerk account using its primary email", async () => {
    clerkMocks.auth.mockResolvedValue({ userId: "clerk-operator" });
    clerkMocks.currentUser.mockResolvedValue({
      primaryEmailAddress: {
        emailAddress: "DerekPaulHoffman@gmail.com"
      },
      emailAddresses: [
        { emailAddress: "other@example.com" },
        { emailAddress: "DerekPaulHoffman@gmail.com" }
      ]
    });

    await expect(getCurrentOperator()).resolves.toEqual({
      clerkUserId: "clerk-operator",
      email: "derekpaulhoffman@gmail.com"
    });
  });

  it("does not authorize a matching secondary email", async () => {
    clerkMocks.auth.mockResolvedValue({ userId: "clerk-other" });
    clerkMocks.currentUser.mockResolvedValue({
      primaryEmailAddress: {
        emailAddress: "other@example.com"
      },
      emailAddresses: [
        { emailAddress: "other@example.com" },
        { emailAddress: "derekpaulhoffman@gmail.com" }
      ]
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
