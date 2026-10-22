import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalPublicReadUrl } from "./public-request-url";
import { isSafeRecipeUrl } from "./recipe";

describe("canonical public reads", () => {
  it("trims the exact observed CPS public build padding before the unchanged URL guard and wire dispatch", () => {
    const raw = "https://thebobgcpa.cps.golf/onlineres/onlineapi/api/v1/onlinereservation/GetAllOptions/thebobgcpa?version=25.3.4.21239412485%0A&product=3";
    expect(createHash("sha256").update(raw).digest("hex")).toBe("c8ddf0e4cdb2b2fb62f130a67201e6d0820dac1c0605893309a98099d569b724");
    expect(isSafeRecipeUrl(raw)).toBe(false);
    const canonical = canonicalPublicReadUrl(raw, "GET");
    expect(canonical).toBe(raw.replace("%0A", ""));
    expect(isSafeRecipeUrl(canonical)).toBe(true);
  });

  it.each(["%0A", "%0D", "%20", "%20%0D%0A"])("trims only supported edge padding %s and preserves the remaining query bytes", padding => {
    const raw = `https://example-club.cps.golf/onlineres/onlineapi/api/v1/onlinereservation/GetAllOptions/example-club?parentName=Public%2DParent&product=3&version=${padding}25.3.4.21239412485${padding}`;
    expect(canonicalPublicReadUrl(raw, "GET")).toBe(raw.replace(`version=${padding}25.3.4.21239412485${padding}`, "version=25.3.4.21239412485"));
    expect(isSafeRecipeUrl(canonicalPublicReadUrl(raw, "GET"))).toBe(true);
  });

  const cps = "https://example-club.cps.golf/onlineres/onlineapi/api/v1/onlinereservation/GetAllOptions/example-club?version=25.3.4.21239412485%0A&product=3";
  it.each([
    ["wrong method", cps, "POST"],
    ["HEAD", cps, "HEAD"],
    ["wrong route", cps.replace("GetAllOptions", "TeeTimes"), "GET"],
    ["wrong host", cps.replace(".cps.golf", ".example.org"), "GET"],
    ["shared host", cps.replaceAll("example-club", "sc"), "GET"],
    ["foreign tenant", cps.replace("/example-club?", "/another-club?"), "GET"],
    ["nested tenant", cps.replace("example-club.cps.golf", "other.example-club.cps.golf"), "GET"],
    ["trailing hyphen", cps.replaceAll("example-club", "example-club-"), "GET"],
    ["encoded tenant", cps.replace("/example-club?", "/%65xample-club?"), "GET"],
    ["normalized path", cps.replace("/onlineres/", "/other/../onlineres/"), "GET"],
    ["credentials", cps.replace("https://", "https://user:password@"), "GET"],
    ["explicit port", cps.replace(".golf/", ".golf:443/"), "GET"],
    ["insecure scheme", cps.replace("https:", "http:"), "GET"],
    ["fragment", `${cps}#public`, "GET"],
    ["duplicate version", `${cps}&version=1.2.3`, "GET"],
    ["duplicate product", `${cps}&product=3`, "GET"],
    ["duplicate parent", `${cps}&parentName=public&parentName=other`, "GET"],
    ["wrong product", cps.replace("product=3", "product=4"), "GET"],
    ["unrelated query", `${cps}&other=public`, "GET"],
    ["credential query", `${cps}&token=private`, "GET"],
    ["encoded query name", cps.replace("version=", "%76ersion="), "GET"],
    ["missing equals", `${cps}&parentNameX`, "GET"],
    ["empty parent", `${cps}&parentName=`, "GET"],
    ["unsafe parent", `${cps}&parentName=public%0A`, "GET"],
    ["oversized parent", `${cps}&parentName=${"a".repeat(64)}`, "GET"],
    ["embedded LF", cps.replace("25.3.4", "25.3%0A.4"), "GET"],
    ["embedded CR", cps.replace("25.3.4", "25.3%0D.4"), "GET"],
    ["embedded space", cps.replace("25.3.4", "25.3%20.4"), "GET"],
    ["tab edge", cps.replace("%0A", "%09"), "GET"],
    ["NUL edge", cps.replace("%0A", "%00"), "GET"],
    ["DEL edge", cps.replace("%0A", "%7F"), "GET"],
    ["non-ASCII space edge", cps.replace("%0A", "%C2%A0"), "GET"],
    ["raw control", cps.replace("%0A", "\n"), "GET"],
    ["non-numeric build", cps.replace("25.3.4", "private.3.4"), "GET"],
    ["too many components", cps.replace("25.3.4.21239412485", "1.2.3.4.5.6.7.8.9"), "GET"],
    ["oversized numeric build", cps.replace("25.3.4.21239412485", `${"1".repeat(129)}.2.3`), "GET"],
    ["oversized padding", cps.replace("%0A", "%20".repeat(129)), "GET"],
  ])("leaves %s unchanged for ordinary rejection", (_name, raw, method) => {
    expect(canonicalPublicReadUrl(raw, method)).toBe(raw);
  });

  it("keeps ordinary URLs and the generic control/credential guard unchanged", () => {
    const clean = cps.replace("%0A", "");
    expect(canonicalPublicReadUrl(clean, "GET")).toBe(clean);
    expect(canonicalPublicReadUrl("not a URL", "GET")).toBe("not a URL");
    expect(isSafeRecipeUrl(cps)).toBe(false);
    expect(isSafeRecipeUrl(`${clean}&token=private`)).toBe(false);
    expect(isSafeRecipeUrl(cps.replace("GetAllOptions", "OtherPublicRead"))).toBe(false);
  });

  it("drops only the optional exact ForeUP GET query before authorization and transport", () => {
    const raw = "https://foreupsoftware.com/index.php/api/booking/times?date=10-22-2026&api_key=private-shaped&players=2";
    expect(canonicalPublicReadUrl(raw, "GET")).toBe("https://foreupsoftware.com/index.php/api/booking/times?date=10-22-2026&players=2");
    expect(canonicalPublicReadUrl(raw, "POST")).toBe(raw);
    expect(canonicalPublicReadUrl(raw.replace("foreupsoftware.com", "other.example.org"), "GET")).toContain("api_key=");
    expect(canonicalPublicReadUrl(raw.replace("booking/times", "booking/account"), "GET")).toContain("api_key=");
    expect(isSafeRecipeUrl(canonicalPublicReadUrl(raw + "&token=private", "GET"))).toBe(false);
  });
});
