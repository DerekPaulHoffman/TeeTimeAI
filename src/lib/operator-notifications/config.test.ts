// @vitest-environment node
import webpush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOperatorNotificationConfig } from "./config";

const keys = webpush.generateVAPIDKeys();
describe("operator push configuration", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries({
      VERCEL_ENV: "production",
      OPERATOR_NOTIFICATIONS_ENABLED: "true",
      OPERATOR_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
      OPERATOR_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
      OPERATOR_NOTIFICATIONS_OWNER_EMAIL: " OWNER@realmail.com ",
      OPERATOR_NOTIFICATIONS_EXCLUDED_EMAILS: "other@realmail.com",
      NEXT_PUBLIC_SITE_URL: "https://teetimespot.com",
    }))
      vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("always excludes the configured owner even without additional exclusions", () => {
    vi.stubEnv("OPERATOR_NOTIFICATIONS_EXCLUDED_EMAILS", "");
    expect(getOperatorNotificationConfig()?.excludedEmails).toEqual([
      "owner@realmail.com",
    ]);
  });
  it.each(["preview", "development", ""])(
    "fails closed outside production: %s",
    (environment) => {
      vi.stubEnv("VERCEL_ENV", environment);
      expect(getOperatorNotificationConfig()).toBeNull();
    },
  );
  it.each([
    "OPERATOR_NOTIFICATIONS_ENABLED",
    "OPERATOR_PUSH_VAPID_PUBLIC_KEY",
    "OPERATOR_PUSH_VAPID_PRIVATE_KEY",
    "OPERATOR_NOTIFICATIONS_OWNER_EMAIL",
  ])("requires %s", (key) => {
    vi.stubEnv(key, "");
    expect(getOperatorNotificationConfig()).toBeNull();
  });
  it("rejects mismatched keys", () => {
    vi.stubEnv(
      "OPERATOR_PUSH_VAPID_PRIVATE_KEY",
      webpush.generateVAPIDKeys().privateKey,
    );
    expect(getOperatorNotificationConfig()).toBeNull();
  });
  it.each([
    "http://teetimespot.com",
    "https://token@teetimespot.com",
    "https://teetimespot.com/path",
    "https://teetimespot.com/?token=secret",
  ])("rejects unsafe origin %s", (origin) => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
    expect(getOperatorNotificationConfig()).toBeNull();
  });
});
