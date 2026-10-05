import { describe, expect, it } from "vitest";

import { getSimulatorAlertSubject, renderSimulatorAlertHtml, renderSimulatorStatusHtml } from "./simulator-email";
import { parseSearchEmailPayload } from "./search-delivery-payload";
import { hydrateMatchAlertPayload, hydrateSimulatorStatusPayload } from "./search-delivery-outbox";
import { renderAlertHtml } from "./alerts";

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
    expect(renderAlertHtml({ ...hydrated, to: "person@example.com", searchId: "s1" })).toContain("Your time:");
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
    expect(html).toMatch(/Aug 10, 2026.*10:00 PM/);
    expect(html).toContain("11:30 PM");
    expect(html).toContain("90 minutes");
    expect(html).toContain("you book direct");
    expect(html).not.toMatch(/tee time|holes|spots/i);
  });

  it("shows six equivalent bays as one booking card while retaining their separate match records", () => {
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      offeringId: "sim-1", courseName: "West Bay Simulators", courseTimeZone: "America/Chicago",
      startsAt: new Date("2026-08-11T03:00:00.000Z"), endsAt: new Date("2026-08-11T04:30:00.000Z"),
      bookingUrl: "https://venue.example/book", capacity: 4, resourceId: `bay-${index}`,
    }));
    const html = renderSimulatorAlertHtml({ matches: sessions, durationMinutes: 90, players: 3 });
    expect((html.match(/Open the official booking page/g) ?? [])).toHaveLength(1);
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
});
