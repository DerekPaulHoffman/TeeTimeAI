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
    process.env.AUTOMATION_API_KEY = secret;
    const now = new Date("2026-07-11T00:00:00.000Z");

    expect(buildEmailStopUrls("search-1", { now })).toEqual(
      buildEmailStopUrls("search-1", { now: new Date(now) })
    );
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
        now: new Date("2027-03-01T00:00:00.000Z"),
        secret
      })
    ).toBeNull();
  });
});
