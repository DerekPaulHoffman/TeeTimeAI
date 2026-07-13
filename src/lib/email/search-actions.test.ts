import { describe, expect, it } from "vitest";

import {
  buildEmailStopUrls,
  createEmailStopToken,
  verifyEmailStopToken
} from "./search-actions";

const secret = "test-email-action-secret";

describe("email alert stop tokens", () => {
  it("builds stable stop links when retries use the same date anchor", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://teetimespot.com";
    process.env.EMAIL_ACTION_SECRET = secret;
    const now = new Date("2026-07-11T00:00:00.000Z");

    expect(buildEmailStopUrls("search-1", { now })).toEqual(
      buildEmailStopUrls("search-1", { now: new Date(now) })
    );
  });

  it("prefers the dedicated email action secret over the automation credential", () => {
    process.env.EMAIL_ACTION_SECRET = secret;
    process.env.AUTOMATION_API_KEY = "different-automation-secret";
    const now = new Date("2026-07-10T12:00:00.000Z");
    const token = createEmailStopToken("search-1", "booked", { now });

    expect(verifyEmailStopToken(token, { now, secret })).not.toBeNull();
    expect(
      verifyEmailStopToken(token, { now, secret: process.env.AUTOMATION_API_KEY })
    ).toBeNull();
  });

  it("supports a search-bound expiration with a seven-day grace period", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const expiresAt = new Date("2026-07-18T00:00:00.000Z");
    const token = createEmailStopToken("search-1", "cancelled", {
      now,
      expiresAt,
      secret
    });

    expect(
      verifyEmailStopToken(token, {
        now: new Date("2026-07-17T23:59:59.999Z"),
        secret
      })
    ).not.toBeNull();
    expect(verifyEmailStopToken(token, { now: expiresAt, secret })).toBeNull();
  });

  it("round-trips a signed booked action without exposing personal data", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const token = createEmailStopToken("search-1", "booked", { now, secret });

    expect(verifyEmailStopToken(token, { now, secret })).toMatchObject({
      version: 1,
      searchId: "search-1",
      reason: "booked"
    });
    expect(token).not.toContain("@example.com");
  });

  it("rejects modified and expired tokens", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const token = createEmailStopToken("search-1", "cancelled", {
      now: createdAt,
      secret
    });

    expect(
      verifyEmailStopToken(`${token.slice(0, -1)}x`, { now: createdAt, secret })
    ).toBeNull();
    expect(
      verifyEmailStopToken(token, {
        now: new Date("2026-02-01T00:00:00.001Z"),
        secret
      })
    ).toBeNull();
  });
});
