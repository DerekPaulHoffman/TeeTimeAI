import { describe, expect, it } from "vitest";

import { deriveSameOriginPagePath, sanitizePagePath } from "./page-path";

describe("engagement page path privacy", () => {
  it("keeps only the pathname from relative and absolute URLs", () => {
    expect(sanitizePagePath("/search?email=golfer@example.com#results")).toBe("/search");
    expect(
      sanitizePagePath("https://teetimespot.com/alerts/stop?token=signed-secret")
    ).toBe("/alerts/stop");
  });

  it("derives a path only from a same-origin referrer", () => {
    expect(
      deriveSameOriginPagePath(
        new Request("https://teetimespot.com/api/analytics/events", {
          headers: { referer: "https://teetimespot.com/search?latitude=41.2#courses" }
        })
      )
    ).toBe("/search");

    expect(
      deriveSameOriginPagePath(
        new Request("https://teetimespot.com/api/analytics/events", {
          headers: { referer: "https://example.com/search?email=golfer@example.com" }
        })
      )
    ).toBeUndefined();
  });
});
