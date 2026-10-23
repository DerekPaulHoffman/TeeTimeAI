// @vitest-environment node
import { describe, expect, it } from "vitest";
import { describeBrowserJsonRequestMismatch } from "./browser-json-request-diagnostics";
import { isSafeRecipeUrl } from "./recipe";

const booking = "https://www.sevenrooms.com/reservations/examplegolf?duration-picker=true";
const url = "https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=examplegolf&time_slot=20:00&party_size=2&halo_size_interval=64&start_date=10-23-2030&num_days=1&channel=SEVENROOMS_WIDGET&selected_lang_code=en&picked_duration=60";
const request = (value = url, method = "GET") => ({ url: value, method });
const describeMismatch = (actual = request(), expected = request(), source = booking,
  strictUrl = isSafeRecipeUrl) => describeBrowserJsonRequestMismatch(actual, expected, source, strictUrl);

describe("closed public range request mismatch diagnostics, no matching authority", () => {
  it("leaves an identical expanded tuple without a diagnostic", () => {
    expect(describeMismatch()).toBeUndefined();
  });

  it.each([
    ["time_slot=20:00", "time_slot=18:00", "TIME_SLOT"],
    ["party_size=2", "party_size=3", "PARTY_SIZE"],
    ["halo_size_interval=64", "halo_size_interval=63", "HALO_SIZE_INTERVAL"],
    ["start_date=10-23-2030", "start_date=10-24-2030", "START_DATE"],
    ["num_days=1", "num_days=3", "NUM_DAYS"],
    ["channel=SEVENROOMS_WIDGET", "channel=web", "CHANNEL"],
    ["selected_lang_code=en", "selected_lang_code=fr", "SELECTED_LANG_CODE"],
    ["picked_duration=60", "picked_duration=120", "PICKED_DURATION"],
  ])("reports only the closed field code for %s", (from, to, field) => {
    expect(describeMismatch(request(url.replace(from, to)))).toBe(`BROWSER_JSON_REQUEST_${field}_MISMATCH`);
  });

  it.each([
    ["&selected_lang_code=en", "SELECTED_LANG_CODE"],
    ["&picked_duration=60", "PICKED_DURATION"],
  ])("treats an absent optional %s as a field mismatch in either direction", (part, field) => {
    const without = request(url.replace(part, ""));
    expect(describeMismatch(without)).toBe(`BROWSER_JSON_REQUEST_${field}_MISMATCH`);
    expect(describeMismatch(request(), without)).toBe(`BROWSER_JSON_REQUEST_${field}_MISMATCH`);
  });

  it("uses the separately expanded changed-input tuple rather than a baseline date or party", () => {
    const changed = request(url.replace("party_size=2", "party_size=3").replace("10-23-2030", "10-24-2030").replace("picked_duration=60", "picked_duration=120"));
    expect(describeMismatch(changed, changed)).toBeUndefined();
    expect(describeMismatch(changed)).toBe("BROWSER_JSON_REQUEST_MULTIPLE_FIELDS_MISMATCH");
    expect(describeMismatch(request(changed.url.replace("time_slot=20:00", "time_slot=19:00")), changed))
      .toBe("BROWSER_JSON_REQUEST_TIME_SLOT_MISMATCH");
  });

  it("distinguishes query order from scalar changes without returning the pairs", () => {
    const [path, query] = url.split("?");
    const reversed = request(`${path}?${query.split("&").reverse().join("&")}`);
    expect(describeMismatch(reversed)).toBe("BROWSER_JSON_REQUEST_QUERY_ORDER_MISMATCH");
    expect(describeMismatch(request(reversed.url.replace("time_slot=20:00", "time_slot=18:00"))))
      .toBe("BROWSER_JSON_REQUEST_TIME_SLOT_MISMATCH");
    expect(describeMismatch(request(reversed.url.replace("time_slot=20:00", "time_slot=18:00").replace("party_size=2", "party_size=3"))))
      .toBe("BROWSER_JSON_REQUEST_MULTIPLE_FIELDS_MISMATCH");
  });

  it.each([
    url + "&party_size=2", url + "&unknown=private-sentinel", url + "&token=private-sentinel",
    url.replace("time_slot=20:00", "time_slot=20%3A00"), url.replace("venue=examplegolf", "%76enue=examplegolf"),
    url.replace("10-23-2030", "02-30-2030"), url.replace("party_size=2", "party_size=9"),
    url.replace("/widget/range?", "/widget/other?"), url.replace("/widget/range?", "/widget/%72ange?"),
    url.replace("https://www.sevenrooms.com", "https://other.example"),
    url.replace("https://www.sevenrooms.com", "https://user@www.sevenrooms.com"),
    url.replace("https://www.sevenrooms.com", "https://www.sevenrooms.com:443"), url + "#private-sentinel",
  ])("does not describe an invalid or out-of-role URL", actual => {
    expect(describeMismatch(request(actual))).toBeUndefined();
    expect(describeMismatch(request(), request(actual))).toBeUndefined();
  });

  it("requires the exact booking tenant and ordinary public source URL", () => {
    expect(describeMismatch(request(url.replace("venue=examplegolf", "venue=foreigngolf")))).toBeUndefined();
    expect(describeMismatch(request(), request(url.replace("venue=examplegolf", "venue=foreigngolf")))).toBeUndefined();
    for (const source of [booking.replace("examplegolf", "foreigngolf"), booking.replace("www.sevenrooms.com", "other.example"),
      booking.replace("www.sevenrooms.com", "www.sevenrooms.com:443"), booking + "#private-sentinel", booking + "&token=private-sentinel"])
      expect(describeMismatch(request(), request(), source)).toBeUndefined();
  });

  it("requires GET on both sides and retains every existing strict callback denial", () => {
    expect(describeMismatch(request(url, "POST"))).toBeUndefined();
    expect(describeMismatch(request(), request(url, "HEAD"))).toBeUndefined();
    expect(describeMismatch(request(), request(), booking, () => false)).toBeUndefined();
    expect(describeMismatch(request(), request(), booking, () => { throw new Error("private-sentinel"); })).toBeUndefined();
  });

  it("only ever emits a bounded closed code, never the changed public value", () => {
    const actual = request(url.replace("channel=SEVENROOMS_WIDGET", "channel=private_sentinel"));
    const result = describeMismatch(actual);
    expect(result).toBe("BROWSER_JSON_REQUEST_CHANNEL_MISMATCH");
    expect(result).toMatch(/^[A-Z_0-9]{1,80}$/u);
    expect(result).not.toContain("private_sentinel");
  });
});
