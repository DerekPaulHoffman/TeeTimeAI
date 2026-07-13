import { describe, expect, it } from "vitest";

import { browserSecurityHeaders } from "./response-headers";

describe("browser security response headers", () => {
  it("limits browser capabilities without blocking same-origin geolocation", () => {
    expect(browserSecurityHeaders).toEqual([
      {
        key: "X-Content-Type-Options",
        value: "nosniff"
      },
      {
        key: "X-Frame-Options",
        value: "DENY"
      },
      {
        key: "Referrer-Policy",
        value: "strict-origin-when-cross-origin"
      },
      {
        key: "Permissions-Policy",
        value: "browsing-topics=(), camera=(), geolocation=(self), microphone=(), payment=(), usb=()"
      }
    ]);
  });
});
