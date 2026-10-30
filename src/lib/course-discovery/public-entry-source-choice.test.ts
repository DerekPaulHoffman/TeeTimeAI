import { describe, expect, it } from "vitest";
import { strictNativeSupportedSource, uniqueNativeSupportedSource, type NativeSourceChoiceCapture } from "./native-source-choice";

describe("observed public bootstrap sources", () => {
  it.each([
    "https://foreupsoftware.com/index.php/booking/19339",
    "https://foreupsoftware.com/index.php/booking/index/19339#/",
    "https://foreupsoftware.com/index.php/booking/index/19339#/teetimes",
  ])("hands the exact public facility bootstrap to independent fixed inspection: %s", url => {
    expect(strictNativeSupportedSource(url)).toBe("FOREUP");
    const value: NativeSourceChoiceCapture = { pageUrl: "https://official.example/", observedAt: 1000, documentHash: "a".repeat(64),
      settled: true, links: [url], frames: [], linksOverflow: false, framesOverflow: false };
    expect(uniqueNativeSupportedSource(value, value, { startedAt: 999, now: 1001, deadline: 2000 })).toMatchObject({ url, family: "FOREUP", via: "LINK" });
  });
  it.each(["https://public-course.cps.golf/", "https://public-course.cps.golf/onlineresweb/search-teetime"])("uses an actually observed current CPS document: %s", pageUrl => {
    const value: NativeSourceChoiceCapture = { pageUrl, observedAt: 1000, documentHash: "a".repeat(64), settled: true,
      links: [], frames: [], linksOverflow: false, framesOverflow: false };
    const choose = (a: NativeSourceChoiceCapture, b = a) => uniqueNativeSupportedSource(a, b, { startedAt: 999, now: 1001, deadline: 2000 });
    expect(choose(value)).toMatchObject({ url: pageUrl, family: "CPS", via: "DOCUMENT" });
    expect(choose(value, { ...value, documentHash: "b".repeat(64) })).toBeNull();
    expect(choose({ ...value, links: ["https://another-course.cps.golf/"] })).toBeNull();
    expect(choose({ ...value, settled: false })).toBeNull();
  });
  it.each([
    "https://foreupsoftware.com/index.php/booking/index/123/456", "https://foreupsoftware.com/index.php/booking/index/0",
    "https://foreupsoftware.com/index.php/booking/index/2147483648", "https://foreupsoftware.com/index.php/booking/index/123#/store",
    "https://foreupsoftware.com/index.php/booking/index/123?slot=1", "https://foreupsoftware.com.evil.example/index.php/booking/index/123",
    "https://public-course.cps.golf/?date=2026-11-02", "https://public-course.cps.golf/#selected",
    "https://admin.cps.golf/", "https://public-course.cps.golf/account", "https://public-course.cps.golf.evil.example/",
  ])("does not turn private, selected or ambiguous URLs into source authority: %s", url => expect(strictNativeSupportedSource(url)).toBeUndefined());
});
