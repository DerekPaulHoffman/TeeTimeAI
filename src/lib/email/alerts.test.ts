import { describe, expect, it } from "vitest";

import { renderAlertHtml } from "./alerts";

describe("renderAlertHtml", () => {
  it("escapes dynamic email fields", () => {
    const html = renderAlertHtml({
      to: "player@example.com",
      courseName: "<script>alert('x')</script>",
      startsAt: new Date("2026-07-09T14:30:00.000Z"),
      availableSpots: 4,
      bookingUrl: "https://example.com/book?x=<bad>"
    });

    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).toContain("https://example.com/book?x=&lt;bad&gt;");
    expect(html).not.toContain("<script>");
  });
});
