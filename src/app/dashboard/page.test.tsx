import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackWidget } from "@/components/feedback-widget";
import { listTeeSearchesForUser } from "@/lib/searches/service";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import DashboardPage from "./page";

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "fixture-owner" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/auth/current-user", () => ({ getRequiredAppUser: async () => ({ id: "fixture-owner" }) }));
vi.mock("@/lib/env", () => ({ hasClerkConfig: () => true, hasDatabaseConfig: () => true }));
vi.mock("@/lib/searches/service", () => ({ listTeeSearchesForUser: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  searchEmailDelivery: { groupBy: async () => [] },
  teeSearch: { findMany: async () => [] }
} }));
vi.mock("@/lib/places/google", () => ({ getGooglePlacePhoto: async () => ({
  photoReference: "fixture-photo",
  authorAttributions: [{ displayName: "Venue photography" }]
}) }));

const now = new Date("2026-10-09T18:56:00Z");
const observedAt = new Date("2026-10-09T18:55:00Z");

function fixture(mode: "SIMULATOR" | "GOLF", name: string) {
  const course = {
    id: name, name, address: "100 Fairway Drive, Trumbull, CT, USA",
    timeZone: "America/New_York", googlePlaceId: name, isManual: false,
    isPublic: true, createdAt: observedAt, website: "https://official.example/",
    detectedBookingUrl: "https://official.example/booking", detectedPlatform: "UNKNOWN",
    automationEligibility: "ALLOWED", automationReason: "NONE", bookingMethod: "ONLINE",
    bookingFacts: null, providerMetadata: null, layoutHoleCounts: [18],
    rating: 4.5, monitoringStatus: null, supportIncident: null, profile: null
  };
  const offering = {
    id: `${name}-simulator`, kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC",
    bookingUrl: "https://official.example/booking", evidenceUrl: "https://official.example/rentals",
    verifiedAt: observedAt, providerFamilyKey: "TEST", providerMetadata: {}, maxPartySize: 4,
    supportedDurationsMinutes: [60], bookingWindowDaysAhead: null, bookingReleaseTimeLocal: null,
    monitoringMode: "AUTOMATIC", automationEligibility: "ALLOWED", monitoringState: "HEALTHY",
    monitoringVerifiedAt: observedAt, lastFailureAt: null, observationToken: null
  };
  const fingerprint = getSimulatorOfferingSourceFingerprint(offering);
  const matches = Array.from({ length: 7 }, (_, index) => ({
    id: `${name}-match-${index}`, courseId: name, course, offering, offeringId: offering.id,
    offeringSourceFingerprint: fingerprint, startsAt: new Date(`2026-10-10T${15 + index}:00:00Z`),
    endsAt: new Date(`2026-10-10T${16 + index}:00:00Z`), lastConfirmedAt: observedAt,
    availabilityStatus: "AVAILABLE", alertStatus: "SENT", availableSpots: 4, holes: 18,
    bookingUrl: offering.bookingUrl
  }));
  return {
    id: name, mode, status: "ACTIVE", date: new Date("2026-10-10T12:00:00Z"),
    startTime: "09:00", endTime: "18:00", userTimeZone: "America/New_York", players: 4,
    user: { email: "golfer@example.com" }, additionalEmails: ["friend@example.com"],
    alertEmail: null, alertGeneration: 1, requestedLayoutHoles: null, cadenceMinutes: 5,
    checkStatus: "WAITING", scheduleVersion: 1, lastCheckedAt: observedAt,
    nextCheckAt: new Date("2026-10-09T19:00:00Z"), createdAt: observedAt,
    preferences: [{ id: `${name}-preference`, rank: 1, course, offering: mode === "SIMULATOR" ? offering : null }],
    probes: [{ courseId: name, offeringId: offering.id, outcome: mode === "SIMULATOR" ? "MATCH_FOUND" : "NO_MATCH",
      observedAt, rawSummary: { mode, sourceFingerprint: fingerprint, providerObservedAt: observedAt.toISOString() } }],
    matches: mode === "SIMULATOR" ? matches : []
  };
}

describe("dashboard course and simulator presentation", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("renders real session links in a spaced list, with shared settings and venue actions", async () => {
    const pending = fixture("SIMULATOR", "Two Roads Golf Club");
    pending.matches = [];
    pending.probes[0].outcome = "NEEDS_ADAPTER";
    pending.preferences[0].offering!.monitoringState = "VERIFYING";
    const searches = [fixture("SIMULATOR", "One Golf Haven"), pending, fixture("GOLF", "Fairway Golf Club")];
    vi.mocked(listTeeSearchesForUser).mockResolvedValue(searches as unknown as Awaited<ReturnType<typeof listTeeSearchesForUser>>);
    const html = renderToStaticMarkup(await DashboardPage());
    const dom = document.createElement("div");
    dom.innerHTML = html;
    expect(dom.querySelectorAll(".dashboard-settings")).toHaveLength(3);
    expect(dom.querySelectorAll(".dashboard-settings span")).toHaveLength(9);
    expect(dom.querySelectorAll(".dashboard-alert-accordion[open]")).toHaveLength(0);
    expect(dom.querySelectorAll(".known-tee-time-list .known-tee-time")).toHaveLength(7);
    expect(dom.querySelector(".known-tee-time")?.textContent).toBe("11:00 AM");
    expect(dom.querySelectorAll(".dashboard-row > .dashboard-matching-times .known-tee-time")).toHaveLength(7);
    expect(dom.querySelectorAll(".dashboard-alert-body .known-tee-time")).toHaveLength(0);
    expect(dom.querySelector(".known-tee-time")?.getAttribute("aria-label")).toContain("official booking page");
    expect(dom.querySelector(".known-tee-time")?.getAttribute("href")).toBe("https://official.example/booking");
    expect(dom.querySelectorAll(".watch-course-row .watch-course-links")).toHaveLength(3);
    expect(html).toContain("Adding alert support");
    expect(dom.querySelector(".dashboard-booking-note")?.textContent).toBe("Availability can change. You book direct.");
    expect(html).toContain("+1 more");

    if (process.env.DASHBOARD_VISUAL_FIXTURE) {
      const output = path.resolve(process.env.DASHBOARD_VISUAL_FIXTURE);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, html + renderToStaticMarkup(<FeedbackWidget />));
    }
  });

  it("keeps an empty simulator check honest and uses the photo fallback", async () => {
    const search = fixture("SIMULATOR", "Pending Venue");
    search.matches = [];
    search.probes = [];
    search.preferences[0].course.isManual = true;
    vi.mocked(listTeeSearchesForUser).mockResolvedValue([search] as unknown as Awaited<ReturnType<typeof listTeeSearchesForUser>>);
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("Simulator check pending");
    expect(html).toContain("dashboard-course-image-empty");
    expect(html).not.toContain('aria-label="Matching simulator sessions"');
  });

  it("shows golf matches outside the management accordion with search-style labels", async () => {
    const search = { ...fixture("GOLF", "Golf Matches"), matches: fixture("SIMULATOR", "Golf Matches").matches.map(match => ({ ...match, offeringId: null, offering: null })) };
    vi.mocked(listTeeSearchesForUser).mockResolvedValue([search] as unknown as Awaited<ReturnType<typeof listTeeSearchesForUser>>);
    const dom = document.createElement("div");
    dom.innerHTML = renderToStaticMarkup(await DashboardPage());
    expect(dom.querySelectorAll('.dashboard-row > [aria-label="Matching tee times"] .known-tee-time')).toHaveLength(7);
    expect(dom.querySelector(".known-tee-time")?.textContent).toBe("11:00 AM");
    expect(dom.querySelector(".known-tee-time")?.getAttribute("aria-label")).toContain("4 spots, 18 holes");
    expect(dom.querySelector(".dashboard-alert-accordion")?.hasAttribute("open")).toBe(false);
  });
});
