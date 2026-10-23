// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isSafeRecipeUrl } from "./recipe";
import { normalizeDiscoverySourceUrl } from "./source-url";

describe("HTTPS discovery identity projection", () => {
  it.each([
    ["http://golf.example.com/", "https://golf.example.com/"],
    ["HTTP://Golf.Example.com/Public-Times?course=12&date=2026-10-23", "https://Golf.Example.com/Public-Times?course=12&date=2026-10-23"],
    ["http://golf.example.com/A%20Public/Path?utm_source=official", "https://golf.example.com/A%20Public/Path?utm_source=official"],
    ["http://www.cityofwestminster.us/ParksRecreation/GolfWestminster/WalnutCreekGolfPreserve", "https://www.cityofwestminster.us/ParksRecreation/GolfWestminster/WalnutCreekGolfPreserve"],
  ])("changes only the scheme of the safe public source %s", (raw, expected) => {
    expect(normalizeDiscoverySourceUrl(raw)).toBe(expected);
    expect(isSafeRecipeUrl(expected)).toBe(true);
  });

  it.each([null, "https://Golf.Example.com/Path?course=1", "https://golf.example.com:443/", "https://golf.example.com/login"])(
    "preserves an existing HTTPS or absent source byte for byte: %s", raw => {
      expect(normalizeDiscoverySourceUrl(raw)).toBe(raw);
    });

  it.each([
    "http://localhost/", "http://course.internal/", "http://course.local/", "http://course.invalid/", "http://course.test/",
    "http://127.0.0.1/", "http://10.0.0.1/", "http://[::1]/", "http://2130706433/", "http://0x7f000001/",
    "http://user:secret@golf.example.com/", "http://golf.example.com:80/", "http://golf.example.com:443/", "http://golf.example.com:8080/",
    "http://golf.example.com/login", "http://golf.example.com/account", "http://golf.example.com/checkout",
    "http://golf.example.com/reservations/hold", "http://golf.example.com/session/private-id", "http://golf.example.com/%6cogin",
    "http://golf.example.com/times?token=secret", "http://golf.example.com/times?api_key=secret", "http://golf.example.com/times?email=a%40example.com",
    "http://golf.example.com/AbCdEfGhIjKlMnOpQrStUvWx", "http://golf.example.com/PublicPrivateCalendar",
    "http://golf.example.com/App/GlobalTenantSettings", "http://golf.example.com/PublicGlobalSettings", "http://golf.example.com/PublicMetadataCatalog",
    "http://golf.example.com/PublicBootstrapCalendar", "http://golf.example.com/PublicConfigurationMenu", "http://golf.example.com/PublicConfigCalendar",
    "http://golf.example.com/PublicRemoteProcedure", "http://golf.example.com/PublicProcedureCalls",
    "http://golf.example.com/path?label=WalnutCreekGolfPreserve", "http://golf.example.com/path#/WalnutCreekGolfPreserve",
    "http://golf.example.com/redirect/WalnutCreekGolfPreserve",
    "http://golf.example.com./", "http://golf..example.com/", "http://golf.example.com/{date}", "http://golf.example.com/%ZZ",
    "http:///golf.example.com/", "http://golf.example.com\\other", "http://golf.example.com/has space", "http://golf.example.com/\n",
    " http://golf.example.com/", "http://golf.example.com/times?x=" + "a".repeat(2048),
    "file:///private", "javascript:alert(1)", "//golf.example.com/",
  ])("retains an unsafe input unchanged so downstream validation still rejects it: %s", raw => {
    expect(normalizeDiscoverySourceUrl(raw)).toBe(raw);
    expect(isSafeRecipeUrl(normalizeDiscoverySourceUrl(raw))).toBe(false);
  });
});
