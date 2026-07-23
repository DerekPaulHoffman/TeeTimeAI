import { describe, expect, it } from "vitest";

import { getBookingWindowPresentation, getPublicFacilityFacts, getUnsupportedAlertCopy } from "@/lib/course-profiles/presentation";

describe("course profile presentation", () => {
  it("states an unknown booking schedule without describing the research process", () => {
    expect(getBookingWindowPresentation({
      bookingWindowDaysAhead: null,
      bookingReleaseTimeLocal: null,
      bookingWindowEvidenceUrl: null,
      detectedBookingUrl: "https://example.com/book",
      website: "https://example.com"
    })).toEqual({
      title: "Advance booking schedule",
      copy: "Confirm on the official booking page.",
      sourceUrl: "https://example.com/book",
      sourceLabel: "Open the official booking page"
    });
  });

  it("states a verified booking window directly", () => {
    expect(getBookingWindowPresentation({
      bookingWindowDaysAhead: 7,
      bookingReleaseTimeLocal: "07:00",
      bookingWindowEvidenceUrl: "https://example.com/policy",
      detectedBookingUrl: "https://example.com/book",
      website: "https://example.com"
    })).toEqual({
      title: "7-day booking window",
      copy: "Public tee times open up to 7 days ahead at 7:00 a.m. course-local time. Check the official booking page for current availability and any player-specific rules.",
      sourceUrl: "https://example.com/policy",
      sourceLabel: "View official booking details"
    });
  });

  it("presents stored highlights as direct facility facts and leaves booking rules to the booking section", () => {
    expect(getPublicFacilityFacts([
      "The official site describes the course as an eighteen-hole par-three facility.",
      "Fenwick identifies itself as Connecticut's oldest public golf course.",
      "The official course policy describes in-season play as riding only.",
      "The official page says tee times may generally be reserved six days ahead."
    ])).toEqual([
      "The course is an eighteen-hole par-three facility.",
      "Fenwick is Connecticut's oldest public golf course.",
      "In-season play is riding only."
    ]);
  });

  it("describes unavailable alert coverage as a customer-facing fact", () => {
    expect(
      getUnsupportedAlertCopy(
        "ACCOUNT_REQUIRED",
        "ACCOUNT_STAFF_PROVISIONED",
        "PUBLIC_ONLINE"
      )
    ).toContain(
      "requires staff to set up your online booking access"
    );
    expect(getUnsupportedAlertCopy("UNKNOWN")).toContain(
      "Please use the official website for current booking information"
    );
  });
});
