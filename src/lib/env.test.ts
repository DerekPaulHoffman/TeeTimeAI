import { afterEach, describe, expect, it } from "vitest";

import {
  getClerkPublishableKey,
  hasClerkConfig,
  hasDatabaseConfig,
  hasGooglePlacesConfig,
  isVercelProduction
} from "./env";

const originalEnv = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_AUTH_READY: process.env.CLERK_AUTH_READY,
  DATABASE_URL: process.env.DATABASE_URL,
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY
};

afterEach(() => {
  restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
  restoreEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", originalEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  restoreEnv("CLERK_SECRET_KEY", originalEnv.CLERK_SECRET_KEY);
  restoreEnv("CLERK_AUTH_READY", originalEnv.CLERK_AUTH_READY);
  restoreEnv("DATABASE_URL", originalEnv.DATABASE_URL);
  restoreEnv("GOOGLE_PLACES_API_KEY", originalEnv.GOOGLE_PLACES_API_KEY);
});

describe("hasClerkConfig", () => {
  it("rejects Clerk test keys in Vercel production", () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = clerkPublishableKey("test");
    process.env.CLERK_SECRET_KEY = "sk_test_demo";

    expect(hasClerkConfig()).toBe(false);
  });

  it("allows Clerk test keys outside Vercel production", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = clerkPublishableKey("test");
    process.env.CLERK_SECRET_KEY = "sk_test_demo";

    expect(hasClerkConfig()).toBe(true);
    expect(getClerkPublishableKey()).toBe(clerkPublishableKey("test"));
  });

  it("rejects prefix-only placeholder keys before Clerk can render", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_demo";
    process.env.CLERK_SECRET_KEY = "sk_test_demo";

    expect(hasClerkConfig()).toBe(false);
    expect(getClerkPublishableKey()).toBeUndefined();
  });

  it("rejects Clerk keys from different instances", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = clerkPublishableKey("test");
    process.env.CLERK_SECRET_KEY = "sk_live_demo";

    expect(hasClerkConfig()).toBe(false);
  });

  it("rejects Clerk live keys in Vercel production until auth is marked ready", () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = clerkPublishableKey("live");
    process.env.CLERK_SECRET_KEY = "sk_live_demo";

    expect(hasClerkConfig()).toBe(false);
  });

  it("allows Clerk live keys in Vercel production when auth is marked ready", () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = clerkPublishableKey("live");
    process.env.CLERK_SECRET_KEY = "sk_live_demo";
    process.env.CLERK_AUTH_READY = "true";

    expect(hasClerkConfig()).toBe(true);
  });

  it("normalizes copied Clerk values before validating production auth", () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `\uFEFF ${clerkPublishableKey("live")} `;
    process.env.CLERK_SECRET_KEY = "\uFEFFsk_live_demo\n";
    process.env.CLERK_AUTH_READY = " true ";

    expect(hasClerkConfig()).toBe(true);
    expect(getClerkPublishableKey()).toBe(clerkPublishableKey("live"));
  });
});

describe("server configuration", () => {
  it("normalizes database and Google Places configuration values", () => {
    process.env.DATABASE_URL = "\uFEFF postgresql://example.test/teetimespot ";
    process.env.GOOGLE_PLACES_API_KEY = "\uFEFF copied-key \n";

    expect(hasDatabaseConfig()).toBe(true);
    expect(hasGooglePlacesConfig()).toBe(true);
  });

  it("treats blank configuration values as missing", () => {
    process.env.DATABASE_URL = " \n";
    process.env.GOOGLE_PLACES_API_KEY = "\uFEFF  ";

    expect(hasDatabaseConfig()).toBe(false);
    expect(hasGooglePlacesConfig()).toBe(false);
  });

  it("distinguishes Vercel production from preview", () => {
    process.env.VERCEL_ENV = "preview";
    expect(isVercelProduction()).toBe(false);

    process.env.VERCEL_ENV = "production";
    expect(isVercelProduction()).toBe(true);
  });
});

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function clerkPublishableKey(environment: "test" | "live") {
  const encodedFrontendApi = Buffer.from("clerk.example.test$").toString("base64url");
  return `pk_${environment}_${encodedFrontendApi}`;
}
