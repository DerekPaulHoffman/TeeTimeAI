import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOperatorSmsConfig } from "./config";

describe("operator SMS production gate", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries({
      OPERATOR_SMS_ENABLED: "true",
      VERCEL_ENV: "production",
      TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "test-secret",
      TWILIO_SMS_FROM: "+12025550100",
      OPERATOR_SMS_TO: "+12025550101",
      OPERATOR_SMS_EXCLUDED_EMAILS: " OWNER@realmail.com ",
      NEXT_PUBLIC_SITE_URL: "https://teetimespot.com",
    }))
      vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("normalizes configuration without exposing it", () =>
    expect(getOperatorSmsConfig()?.excludedEmails).toEqual([
      "owner@realmail.com",
    ]));
  it.each(["preview", "development", ""])(
    "never enables sends in %s",
    (environment) => {
      vi.stubEnv("VERCEL_ENV", environment);
      expect(getOperatorSmsConfig()).toBeNull();
    },
  );
  it.each([
    "OPERATOR_SMS_ENABLED",
    "TWILIO_AUTH_TOKEN",
    "OPERATOR_SMS_EXCLUDED_EMAILS",
    "TWILIO_SMS_FROM",
    "OPERATOR_SMS_TO",
  ])("requires %s", (key) => {
    vi.stubEnv(key, "");
    expect(getOperatorSmsConfig()).toBeNull();
  });
  it.each([
    "http://teetimespot.com",
    "https://token@teetimespot.com",
    "https://teetimespot.com/path",
  ])("rejects unsafe callback origin %s", (origin) => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
    expect(getOperatorSmsConfig()).toBeNull();
  });
});
