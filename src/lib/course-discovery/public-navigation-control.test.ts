import { describe, expect, it } from "vitest";
import { isPublicAvailabilityNavigation } from "./public-navigation-control";

describe("public availability link boundary", () => {
  it("permits public filter navigation carrying date, duration and resource identity", () => {
    expect(isPublicAvailabilityNavigation("https://example.org/date?facilityId=abc&duration=60", "Next")).toBe(true);
    expect(isPublicAvailabilityNavigation("https://example.org/time?date=2026-10-23&duration=60", "Continue")).toBe(true);
    expect(isPublicAvailabilityNavigation("https://example.org/calendar?Time=AnyTime", "Next")).toBe(true);
  });
  it.each(["https://example.org/checkout", "https://example.org/review", "https://example.org/account", "https://example.org/next?slotId=123",
    "https://example.org/next?time=12%3A00", "https://example.org/next?startTime=12%3A00", "https://example.org/next?teeTimeId=12",
    "https://example.org/next?time_id=12", "https://example.org/next?endTime=13%3A00", "https://example.org/next?step=confirm", "https://user:pass@example.org/date", "javascript:alert(1)", "http://127.0.0.1/date"])
    ("rejects transaction, selected time or unsafe destination %s", url => { expect(isPublicAvailabilityNavigation(url, "Next")).toBe(false); });
  it.each(["Confirm", "Pay", "Sign in", "12:00 PM", "9 AM", "Contact us"])("rejects unsafe navigation label %s", label => {
    expect(isPublicAvailabilityNavigation("https://example.org/date", label)).toBe(false);
  });
});
