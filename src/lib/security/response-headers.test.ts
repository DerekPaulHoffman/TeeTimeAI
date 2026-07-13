import { describe, expect, it } from "vitest";

import { browserSecurityHeaders } from "./response-headers";

describe("browser security response headers", () => {
  it("disables MIME sniffing and cross-origin framing without leaking full paths", () => {
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
      }
    ]);
  });
});
