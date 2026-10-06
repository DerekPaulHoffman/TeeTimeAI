import { afterEach, describe, expect, it, vi } from "vitest";

import { getSimulatorAlertSubject, renderSimulatorAlertHtml, renderSimulatorStatusHtml } from "./simulator-email";
import { parseSearchEmailPayload } from "./search-delivery-payload";
import { hydrateMatchAlertPayload, hydrateSimulatorStatusPayload } from "./search-delivery-outbox";
import { renderAlertHtml, sendSimulatorStatusEmail } from "./alerts";
import { verifyEmailStopToken } from "./search-actions";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({ Resend: class {
  emails = { send };
} }));

afterEach(() => {
  vi.unstubAllEnvs();
  send.mockReset();
});

describe("simulator customer email", () => {
  it("preserves the immutable simulator payload version and mode", () => {
    expect(parseSearchEmailPayload({ schemaVersion: 3, mode: "SIMULATOR", checkedAt: "2026-08-10T12:00:00.000Z", matchIds: ["m1"] }))
      .toMatchObject({ schemaVersion: 3, mode: "SIMULATOR", matchIds: ["m1"] });
    expect(parseSearchEmailPayload({ schemaVersion: 3, checkedAt: "2026-08-10T12:00:00.000Z" })).toBeNull();
  });

  it("hydrates the persisted v3 session report with end time and capacity", async () => {
    const payload = {
      schemaVersion: 3 as const, mode: "SIMULATOR" as const,
      checkedAt: "2026-08-10T12:00:00.000Z", matchIds: ["m1"],
      matchRefs: [{ matchId: "m1", availabilityCycle: 0 }], displayMatchIds: ["m1"],
      matchReport: { mode: "SIMULATOR", durationMinutes: 90, targetDate: "2026-08-10",
        startTime: "20:00", endTime: "23:59", players: 3, userTimeZone: "America/New_York",
        matches: [{ matchId: "m1", offeringId: "sim-1", courseId: "venue-1",
          courseName: "West Bay Simulators", courseRank: 1, courseTimeZone: "America/Chicago",
          startsAt: "2026-08-11T03:00:00.000Z", endsAt: "2026-08-11T04:30:00.000Z",
          availableSpots: 4, bookingUrl: "https://venue.example/book" }] },
    };
    const hydrated = await hydrateMatchAlertPayload({ searchId: "s1", alertGeneration: 0, payload });
    expect(hydrated.mode).toBe("SIMULATOR");
    expect(hydrated.matches[0]?.endsAt?.toISOString()).toBe("2026-08-11T04:30:00.000Z");
    expect(renderAlertHtml({ ...hydrated, to: "person@example.com", searchId: "s1" })).toContain("for you");
  });

  it("hydrates a pending setup without inventing a match", () => {
    const status = hydrateSimulatorStatusPayload({ schemaVersion: 3, mode: "SIMULATOR",
      checkedAt: "2026-08-10T12:00:00.000Z",
      statusReport: { mode: "SIMULATOR", kind: "setup", targetDate: "2026-08-10",
        startTime: "13:00", endTime: "17:00", durationMinutes: 120, players: 2,
        venues: [{ courseName: "West Bay", bookingUrl: "https://venue.example/book", availability: "CHECK_PENDING" }] } });
    expect(status.venues[0]?.availability).toBe("CHECK_PENDING");
  });
  it("shows a whole venue-local session and official booking handoff without outdoor claims", () => {
    const match = {
      courseName: "West Bay Simulators",
      courseTimeZone: "America/Chicago",
      startsAt: new Date("2026-08-11T03:00:00.000Z"),
      endsAt: new Date("2026-08-11T04:30:00.000Z"),
      bookingUrl: "https://venue.example/official-booking",
      capacity: 4,
    };
    const html = renderSimulatorAlertHtml({
      matches: [match], durationMinutes: 90, players: 3,
      targetDate: "2026-08-10", startTime: "20:00", endTime: "23:59",
    });
    expect(getSimulatorAlertSubject([match])).toContain("simulator session");
    expect(html).toContain("Aug 10");
    expect(html).toContain("10:00 PM");
    expect(html).toContain("11:30 PM");
    expect(html).toContain("90 minutes");
    expect(html).toContain("You book direct");
    expect(html).not.toMatch(/tee times? just opened|holes|spots|GOLFERS|COURSE LAYOUT/i);
    expect(html).toContain("Tee Time Spot");
    expect(html).toContain('class="email-card"');
  });

  it("shows six equivalent bays as one booking card while retaining their separate match records", () => {
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      offeringId: "sim-1", courseName: "West Bay Simulators", courseTimeZone: "America/Chicago",
      startsAt: new Date("2026-08-11T03:00:00.000Z"), endsAt: new Date("2026-08-11T04:30:00.000Z"),
      bookingUrl: "https://venue.example/book", capacity: 4, resourceId: `bay-${index}`,
    }));
    const html = renderSimulatorAlertHtml({ matches: sessions, durationMinutes: 90, players: 3 });
    expect((html.match(/href="https:\/\/venue.example\/book"/g) ?? [])).toHaveLength(1);
    expect(getSimulatorAlertSubject(sessions)).toContain("A simulator session opened");
    expect(sessions).toHaveLength(6);
  });

  it("does not claim a pending setup has verified availability", () => {
    const html = renderSimulatorStatusHtml({
      kind: "setup", targetDate: "2026-08-10", startTime: "13:00", endTime: "17:00",
      durationMinutes: 120, players: 2,
      venues: [{ courseName: "Venue <One>", bookingUrl: "https://venue.example/book", availability: "CHECK_PENDING" }],
    });
    expect(html).toContain("Your simulator alert is saved");
    expect(html).toContain("We are checking current sessions");
    expect(html).toContain("Venue &lt;One&gt;");
    expect(html).not.toContain("Venue <One>");
  });

  it("uses the existing brand, ranked cards, summary and both bounded stop controls", () => {
    const html = renderAlertHtml({
      mode: "SIMULATOR", durationMinutes: 60, to: "person@example.com", searchId: "s1",
      targetDate: "2026-08-10", startTime: "13:00", endTime: "18:00", players: 4,
      stopUrls: { booked: "https://teetimespot.com/alerts/stop?token=booked", cancelled: "https://teetimespot.com/alerts/stop?token=cancelled" },
      assetBaseUrl: "https://preview.teetimespot.com", checkedAt: new Date("2026-08-10T12:00:00Z"),
      matches: [
        { offeringId: "second", courseId: "venue-2", courseName: "Second Venue", courseRank: 2, courseAddress: "20 Main St, Canton, CT 06019, USA",
          startsAt: new Date("2026-08-10T18:00:00Z"), endsAt: new Date("2026-08-10T19:00:00Z"), availableSpots: 1, bookingUrl: "https://venue.example/second" },
        { offeringId: "first", courseId: "venue-1", courseName: "First Venue", courseRank: 1, courseAddress: "10 Main St, Fairfield, CT 06824, USA",
          startsAt: new Date("2026-08-10T19:00:00Z"), endsAt: new Date("2026-08-10T20:00:00Z"), availableSpots: 1, bookingUrl: "https://venue.example/first" }
      ]
    });
    expect(html).toContain('class="email-card"');
    expect(html).toContain("DATE");
    expect(html).toContain("SESSION");
    expect(html).toContain("60 minutes");
    expect(html).toContain("Fairfield, CT");
    expect(html.indexOf("First Venue")).toBeLessThan(html.indexOf("Second Venue"));
    expect((html.match(/I booked &mdash; stop these results/g) ?? [])).toHaveLength(1);
    expect((html.match(/Cancel this alert/g) ?? [])).toHaveLength(1);
    expect((html.match(/Unsubscribe/g) ?? [])).toHaveLength(1);
    expect(html).toContain('href="https://teetimespot.com/alerts/stop?token=booked"');
    expect(html).toContain('href="https://teetimespot.com/alerts/stop?token=cancelled"');
    expect(html).not.toMatch(/GOLFERS|COURSE LAYOUT|4 spots|course-card-/);
  });

  it("deduplicates hundreds of bay records into bounded venue session pills", () => {
    const matches = Array.from({ length: 379 }, (_, index) => {
      const startsAt = new Date(Date.UTC(2026, 7, 10, 12, (index % 37) * 15));
      return { offeringId: "sim-1", courseId: "venue-1", courseName: "West Bay", courseRank: 1,
        startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000), bookingUrl: "https://venue.example/book", resourceId: `bay-${index}` };
    });
    const html = renderSimulatorAlertHtml({ matches, durationMinutes: 60, targetDate: "2026-08-10", startTime: "08:00", endTime: "18:00", players: 4 });
    expect((html.match(/href="https:\/\/venue.example\/book"/g) ?? [])).toHaveLength(1);
    expect(html).toMatch(/21 more session/);
    expect(html).not.toContain("363 more");
    expect(matches).toHaveLength(379);
  });

  it("uses full local and recipient session ranges across midnight", () => {
    const html = renderSimulatorAlertHtml({
      matches: [{ courseName: "West Bay", courseTimeZone: "America/Chicago", startsAt: new Date("2026-08-11T04:30:00Z"),
        endsAt: new Date("2026-08-11T05:30:00Z"), bookingUrl: "https://venue.example/book" }],
      durationMinutes: 60, targetDate: "2026-08-10", startTime: "20:00", endTime: "23:59", userTimeZone: "America/Los_Angeles"
    });
    expect(html).toContain("11:30 PM");
    expect(html).toContain("12:30 AM");
    expect(html).toContain("9:30 PM");
    expect(html).toContain("10:30 PM");
    expect(html).toContain("for you");
    expect(html).not.toMatch(/spots|holes|GOLFERS/);
  });

  it("escapes session fields and preserves a legacy cancellation URL without inventing a booked control", () => {
    const html = renderSimulatorAlertHtml({
      matches: [{ courseName: "Venue <script>", startsAt: new Date("2026-08-10T14:00:00Z"), bookingUrl: "https://venue.example/book?x=<bad>&y=1" }],
      durationMinutes: 60, stopUrl: "https://teetimespot.com/alerts/stop?token=cancel-only&x=<bad>"
    });
    expect(html).toContain("Venue &lt;script&gt;");
    expect(html).toContain("https://venue.example/book?x=&lt;bad&gt;&amp;y=1");
    expect(html).toContain("https://teetimespot.com/alerts/stop?token=cancel-only&amp;x=&lt;bad&gt;");
    expect(html).toContain("Cancel this alert");
    expect(html).not.toContain("I booked &mdash;");
    expect(html).not.toContain("Venue <script>");
  });

  it.each(["setup", "daily"] as const)("renders shared %s status cards with honest venue outcomes", (kind) => {
    const html = renderSimulatorStatusHtml({
      kind, targetDate: "2026-08-10", startTime: "13:00", endTime: "17:00", durationMinutes: 60, players: 4,
      checkedAt: new Date("2026-08-10T12:00:00Z"), userTimeZone: "America/New_York",
      stopUrls: { booked: "https://teetimespot.com/alerts/stop?token=booked", cancelled: "https://teetimespot.com/alerts/stop?token=cancelled" },
      venues: [
        { courseName: "Verified Venue", bookingUrl: "https://venue.example/verified", availability: "MATCH_FOUND" },
        { courseName: "No Match Venue", bookingUrl: "https://venue.example/no-match", availability: "NO_MATCH" },
        { courseName: "Future Venue", bookingUrl: "https://venue.example/future", availability: "BOOKING_NOT_OPEN" },
        { courseName: "Unavailable Venue", bookingUrl: "https://venue.example/unavailable", availability: "UNAVAILABLE" },
        { courseName: "Pending Venue", bookingUrl: "https://venue.example/pending", availability: "CHECK_PENDING" }
      ]
    });
    expect(html).toContain('class="email-card"');
    expect(html).toContain("Current sessions were verified");
    expect(html).toContain("No matching session is available right now");
    expect(html).toContain("Booking has not opened yet");
    expect(html).toContain("We could not verify current sessions yet");
    expect(html).toContain("We have not verified availability for your requested window yet");
    expect(html).toContain("Last checked on");
    expect((html.match(/I booked &mdash; stop these results/g) ?? [])).toHaveLength(1);
    expect((html.match(/Cancel this alert/g) ?? [])).toHaveLength(1);
    expect(html).not.toMatch(/player count|GOLFERS|COURSE LAYOUT|tee time alert|course-card-/i);
  });

  it("rejects invalid requested duration and keeps complete session ends mandatory in alert delivery", () => {
    expect(() => renderSimulatorAlertHtml({ matches: [], durationMinutes: 0 })).toThrow("valid session duration");
    expect(() => renderAlertHtml({ mode: "SIMULATOR", durationMinutes: 60, to: "person@example.com", searchId: "s1", matches: [
      { courseName: "West Bay", startsAt: new Date("2026-08-10T14:00:00Z"), availableSpots: 1, bookingUrl: "https://venue.example/book" }
    ] })).toThrow("complete session end times");
  });

  it("constructs both distinct bounded status controls before the mocked transport boundary", async () => {
    vi.stubEnv("RESEND_API_KEY", "simulator-email-template-test-key");
    vi.stubEnv("ALERT_EMAIL_FROM", "Tee Time Spot <alerts@teetimespot.com>");
    vi.stubEnv("EMAIL_ACTION_SECRET", "simulator-email-test-secret");
    send.mockResolvedValueOnce({ data: { id: "mock-accepted" }, error: null });
    const result = await sendSimulatorStatusEmail({
      kind: "setup", targetDate: "2030-01-02", startTime: "13:00", endTime: "17:00", durationMinutes: 60, players: 4,
      to: "person@customer.example", searchId: "simulator-controls-test", stableIdempotencyKey: "simulator-status-test",
      venues: [{ courseName: "Test Venue", bookingUrl: "https://venue.example/book", availability: "CHECK_PENDING" }]
    });
    expect(result.deliveryStatus).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
    const email = send.mock.calls[0][0] as { html: string };
    const tokens = [...email.html.matchAll(/href="[^"]*\/alerts\/stop\?token=([^"&]+)"/g)]
      .map((match) => verifyEmailStopToken(decodeURIComponent(match[1]), { secret: "simulator-email-test-secret" }));
    expect(tokens).toHaveLength(3);
    expect(tokens.map((token) => token?.reason)).toEqual(["booked", "cancelled", "cancelled"]);
    expect(tokens.every((token) => token?.searchId === "simulator-controls-test")).toBe(true);
    expect(email.html).toContain('class="email-card"');
    expect(send.mock.calls[0][1]).toEqual({ headers: { "Idempotency-Key": "simulator-status-test" } });
  });
});
