import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clerkHandler: vi.fn(() => "clerk-response"),
  clerkMiddleware: vi.fn(),
  getClerkConfig: vi.fn(),
  next: vi.fn(() => "passthrough")
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: mocks.clerkMiddleware
}));

vi.mock("@/lib/env", () => ({
  getClerkConfig: mocks.getClerkConfig
}));

vi.mock("next/server", () => ({
  NextResponse: { next: mocks.next }
}));

const originalEnv = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY
};

describe("proxy Clerk configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.clerkMiddleware.mockClear();
    mocks.clerkMiddleware.mockReturnValue(mocks.clerkHandler);
    mocks.clerkHandler.mockClear();
    mocks.getClerkConfig.mockReset();
    mocks.next.mockClear();
  });

  afterEach(() => {
    restoreEnv(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      originalEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    );
    restoreEnv("CLERK_SECRET_KEY", originalEnv.CLERK_SECRET_KEY);
  });

  it("normalizes the Clerk environment before middleware initializes", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "\uFEFF pk_test_copied ";
    process.env.CLERK_SECRET_KEY = "\uFEFFsk_test_copied\n";
    mocks.getClerkConfig.mockReturnValue({
      publishableKey: "pk_test_normalized",
      secretKey: "sk_test_normalized"
    });

    const proxy = await import("./proxy");
    const response = await proxy.default({} as never, {} as never);

    expect(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY).toBe("pk_test_normalized");
    expect(process.env.CLERK_SECRET_KEY).toBe("sk_test_normalized");
    expect(mocks.clerkMiddleware).toHaveBeenCalledWith({
      publishableKey: "pk_test_normalized"
    });
    expect(mocks.clerkHandler).toHaveBeenCalledOnce();
    expect(response).toBe("clerk-response");
  });

  it("keeps the pass-through proxy when Clerk configuration is invalid", async () => {
    mocks.getClerkConfig.mockReturnValue(undefined);

    const proxy = await import("./proxy");

    expect(mocks.clerkMiddleware).not.toHaveBeenCalled();
    expect(await proxy.default({} as never, {} as never)).toBe("passthrough");
    expect(mocks.next).toHaveBeenCalledOnce();
  });
});

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
