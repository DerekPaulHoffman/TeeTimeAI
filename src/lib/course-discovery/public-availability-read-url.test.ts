import { describe, expect, it, vi } from "vitest";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { isSafePublicAvailabilityReadUrl } from "./public-availability-read-url";

const base = "https://www.sevenrooms.com/api-yoa/availability/widget/range";
const query = "venue=public-golf-studio&time_slot=14:00&party_size=2&halo_size_interval=8&start_date=10-23-2026&num_days=3&channel=SEVENROOMS_WIDGET";
const semanticUrl = `${base}?${query}&selected_lang_code=en-US&picked_duration=60`;
const strict = (value: string) => getSafeCustomerBookingUrl(value) === value;
const accepts = (url: string, method = "GET", kind = "xhr") => isSafePublicAvailabilityReadUrl(url, kind, method, strict);
const change = (key: string, value: string) => semanticUrl.replace(new RegExp(`([?&]${key}=)[^&]*`, "u"), `$1${value}`);

describe("published public availability range URL", () => {
  it("permits the observed query semantics while the ordinary customer URL remains rejected", () => {
    expect(strict(semanticUrl)).toBe(false);
    expect(accepts(semanticUrl)).toBe(true);
    expect(accepts(semanticUrl, "GET", "fetch")).toBe(true);
    expect(strict(semanticUrl)).toBe(false);
  });

  it("changes only the language key in the validation copy and leaves the wire input intact", () => {
    const callback = vi.fn(strict), before = semanticUrl;
    expect(isSafePublicAvailabilityReadUrl(semanticUrl, "xhr", "GET", callback)).toBe(true);
    expect(callback).toHaveBeenCalledExactlyOnceWith(semanticUrl.replace("selected_lang_code=", "public_availability_language="));
    expect(semanticUrl).toBe(before);
    expect(accepts(`${base}?${query}`)).toBe(true);
  });

  it("preserves strict rejection and exceptions after the scalar checks", () => {
    expect(isSafePublicAvailabilityReadUrl(semanticUrl, "xhr", "GET", () => false)).toBe(false);
    expect(isSafePublicAvailabilityReadUrl(semanticUrl, "xhr", "GET", () => { throw new Error("DENIED"); })).toBe(false);
    expect(accepts(change("channel", "LongMixedCasePublicChannelValue"))).toBe(false);
    expect(accepts(change("venue", "PublicVenueIdentifier123456789"))).toBe(false);
  });

  it.each(["en", "en-US", "fr-CA", "es-419", "fil-PH"])("accepts a simple public language selection %s", language => {
    expect(accepts(change("selected_lang_code", language))).toBe(true);
  });

  it.each(["", "en_US", "en-US-private-extension", "secret-token", "https://example.org/en", "en%2DUS", "%65n"])(
    "rejects unsupported or encoded language state %s", language => {
      expect(accepts(change("selected_lang_code", language))).toBe(false);
    });

  it.each([
    semanticUrl.replace("https:", "http:"), semanticUrl.replace("www.sevenrooms.com", "sevenrooms.com"),
    semanticUrl.replace("www.sevenrooms.com", "www.sevenrooms.com.evil.example"),
    semanticUrl.replace("www.sevenrooms.com", "user:password@www.sevenrooms.com"),
    semanticUrl.replace("www.sevenrooms.com", "www.sevenrooms.com:443"),
    semanticUrl.replace("www.sevenrooms.com", "www.sevenrooms.com:8443"),
    semanticUrl.replace("/widget/range", "/widget/./range"), semanticUrl.replace("/widget/range", "/widget/%72ange"),
    semanticUrl.replace("/widget/range", "/widget/range/"), semanticUrl + "#state", " " + semanticUrl,
    semanticUrl.replace("selected_lang_code=", "%73elected_lang_code="), semanticUrl.replace("party_size=", "party%5fsize="),
    semanticUrl + "&selected_lang_code=en", semanticUrl + "&party_size=2", semanticUrl + "&", semanticUrl.replace("&channel=SEVENROOMS_WIDGET", ""),
  ])("rejects origin, raw-path, name and duplicate aliases: %s", url => { expect(accepts(url)).toBe(false); });

  it.each(["actual_id", "client_id", "experience_id", "bypass-go-live", "api_key", "token", "next", "unknown"])(
    "never admits modification, identity, debug or extra parameter %s", key => {
      expect(accepts(`${base}?${query}&${key}=true`)).toBe(false);
    });

  it.each([
    ["time_slot", "24:00"], ["time_slot", "14:60"], ["time_slot", "2:00"], ["time_slot", "14%3A00"],
    ["party_size", "0"], ["party_size", "5"], ["party_size", "02"], ["party_size", "2.5"],
    ["halo_size_interval", "-1"], ["halo_size_interval", "97"], ["halo_size_interval", "1.5"],
    ["num_days", "0"], ["num_days", "2"], ["num_days", "4"],
    ["picked_duration", "0"], ["picked_duration", "1441"], ["picked_duration", "NaN"],
    ["start_date", "2026-10-23"], ["start_date", "02-29-2026"], ["start_date", "04-31-2026"],
    ["start_date", "13-01-2026"], ["start_date", "00-01-2026"], ["start_date", "10-00-2026"],
    ["start_date", "10-23-0000"], ["venue", "https://example.org/venue"], ["channel", ""],
  ])("rejects invalid %s scalar %s", (key, value) => { expect(accepts(change(key, value))).toBe(false); });

  it("supports valid calendar and conservative scalar edges without claiming provider maxima", () => {
    expect(accepts(change("start_date", "02-29-2028"))).toBe(true);
    expect(accepts(change("num_days", "1"))).toBe(true);
    expect(accepts(change("halo_size_interval", "0"))).toBe(true);
    expect(accepts(change("halo_size_interval", "96"))).toBe(true);
    expect(accepts(change("picked_duration", "1440"))).toBe(true);
  });

  it.each([["POST", "xhr"], ["HEAD", "fetch"], ["OPTIONS", "other"], ["GET", "document"], ["GET", "script"]])(
    "does not grant %s %s requests", (method, kind) => { expect(accepts(semanticUrl, method, kind)).toBe(false); });
});
