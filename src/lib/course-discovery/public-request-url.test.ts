import { describe, expect, it } from "vitest";
import { canonicalPublicReadUrl } from "./public-request-url";
import { isSafeRecipeUrl } from "./recipe";

describe("canonical public reads", () => {
  it("drops only the optional exact ForeUP GET query before authorization and transport", () => {
    const raw = "https://foreupsoftware.com/index.php/api/booking/times?date=10-22-2026&api_key=private-shaped&players=2";
    expect(canonicalPublicReadUrl(raw, "GET")).toBe("https://foreupsoftware.com/index.php/api/booking/times?date=10-22-2026&players=2");
    expect(canonicalPublicReadUrl(raw, "POST")).toBe(raw);
    expect(canonicalPublicReadUrl(raw.replace("foreupsoftware.com", "other.example.org"), "GET")).toContain("api_key=");
    expect(canonicalPublicReadUrl(raw.replace("booking/times", "booking/account"), "GET")).toContain("api_key=");
    expect(isSafeRecipeUrl(canonicalPublicReadUrl(raw + "&token=private", "GET"))).toBe(false);
  });
});
