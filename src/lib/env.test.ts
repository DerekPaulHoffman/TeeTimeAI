import { afterEach, describe, expect, it } from "vitest";

import { hasClerkConfig } from "./env";

const originalEnv = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_AUTH_READY: process.env.CLERK_AUTH_READY
};

describe("hasClerkConfig", () => {
  afterEach(() => {
    restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
    restoreEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", originalEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    restoreEnv("CLERK_SECRET_KEY", originalEnv.CLERK_SECRET_KEY);
    restoreEnv("CLERK_AUTH_READY", originalEnv.CLERK_AUTH_READY);
  });

  it("rejects Clerk test keys in Vercel production", () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_demo";
    process.env.CLERK_SECRET_KEY = "sk_test_demo";

    expect(hasClerkConfig()).toBe(false);
  });

  it("allows Clerk test keys outside Vercel production", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_demo";
    process.env.CLERK_SECRET_KEY = "sk_test_demo";

    expect(hasClerkConfig()).toBe(true);
  });

  it("rejects Clerk live keys in Vercel production until auth is marked ready", () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_demo";
    process.env.CLERK_SECRET_KEY = "sk_live_demo";

    expect(hasClerkConfig()).toBe(false);
  });

  it("allows Clerk live keys in Vercel production when auth is marked ready", () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_demo";
    process.env.CLERK_SECRET_KEY = "sk_live_demo";
    process.env.CLERK_AUTH_READY = "true";

    expect(hasClerkConfig()).toBe(true);
  });
});

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
