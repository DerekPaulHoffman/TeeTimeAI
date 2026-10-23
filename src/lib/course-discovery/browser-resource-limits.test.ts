import { describe, expect, it } from "vitest";
import { assertPublicBrowserRequestBudget, PUBLIC_BROWSER_REQUEST_LIMIT, MINDBODY_APPOINTMENT_REQUEST_LIMIT,
  PUBLIC_BROWSER_TOTAL_BYTES, PUBLIC_BROWSER_TUNNEL_BYTES, publicBrowserResponseLimit } from "./browser-resource-limits";
describe("monotonic fixed public browser request budgets", () => {
  it.each([PUBLIC_BROWSER_REQUEST_LIMIT, MINDBODY_APPOINTMENT_REQUEST_LIMIT])("admits exactly %i requests without resetting on document transitions", limit => {
    let count = 0;
    for (let document = 0; document < 8; document++) for (let resource = 0; resource < limit / 8; resource++) {
      assertPublicBrowserRequestBudget(count, limit); count++;
    }
    expect(count).toBe(limit); expect(() => assertPublicBrowserRequestBudget(count, limit)).toThrow("PUBLIC_READ_REQUEST_LIMIT");
    expect(() => assertPublicBrowserRequestBudget(count + 1, limit)).toThrow("PUBLIC_READ_REQUEST_LIMIT");
  });
  it.each([0, -1, 193, 513, Infinity, NaN])("rejects arbitrary limit %s", limit => {
    expect(() => assertPublicBrowserRequestBudget(0, limit)).toThrow("PUBLIC_READ_REQUEST_LIMIT");
  });
  it("preserves byte and individual response limits", () => {
    expect(PUBLIC_BROWSER_TOTAL_BYTES).toBe(48_000_000); expect(PUBLIC_BROWSER_TUNNEL_BYTES).toBe(24_000_000);
    expect(publicBrowserResponseLimit("script")).toBe(16_000_000); expect(publicBrowserResponseLimit("stylesheet")).toBe(6_000_000);
    expect(publicBrowserResponseLimit("document")).toBe(2_000_000);
  });
});
