import { describe, expect, it, vi } from "vitest";

import {
  hydrateMatchAlertPayload,
  hydrateSimulatorStatusPayload,
  type SearchEmailDeliveryPayload
} from "./search-delivery-outbox";
import { renderSimulatorStatusHtml } from "./simulator-email";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const checkedAt = "2026-10-06T16:30:00.000Z";

function statusPayload(): SearchEmailDeliveryPayload {
  return {
    schemaVersion: 3,
    mode: "SIMULATOR",
    checkedAt,
    statusReport: {
      mode: "SIMULATOR",
      kind: "setup",
      targetDate: "2026-10-10",
      startTime: "09:00",
      endTime: "14:00",
      durationMinutes: 60,
      players: 4,
      userTimeZone: "America/Los_Angeles",
      venues: [{
        courseId: "venue-1",
        courseName: "Example Simulator",
        courseRank: 2,
        courseAddress: "Fairfield, Connecticut",
        bookingUrl: "https://example.com/book",
        availability: "NO_MATCH"
      }]
    }
  };
}

describe("persisted simulator email rendering data", () => {
  it("hydrates unknown venue status without inventing an official booking URL", () => {
    const payload = statusPayload();
    const report = payload.statusReport as Record<string, unknown>;
    report.venues = [{ courseName: "New Simulator", availability: "SUPPORT_PENDING" }];
    const hydrated = hydrateSimulatorStatusPayload(payload);
    expect(hydrated.venues[0].bookingUrl).toBeUndefined();
    expect(renderSimulatorStatusHtml(hydrated)).toContain("ADDING ALERT SUPPORT");
  });
  it("retains the observation time, recipient timezone and ranked venue context", () => {
    const hydrated = hydrateSimulatorStatusPayload(statusPayload());
    expect(hydrated.checkedAt?.toISOString()).toBe(checkedAt);
    expect(hydrated.userTimeZone).toBe("America/Los_Angeles");
    expect(hydrated.venues[0]).toMatchObject({
      courseId: "venue-1", courseRank: 2, courseAddress: "Fairfield, Connecticut"
    });
    const html = renderSimulatorStatusHtml(hydrated);
    expect(html).toContain("Fairfield, Connecticut");
    expect(html).toContain("No matching session is available right now");
    expect(html).toContain("60 minutes");
  });

  it("renders queued legacy simulator status payloads without new optional fields", () => {
    const payload = statusPayload();
    const report = payload.statusReport as Record<string, unknown>;
    delete report.userTimeZone;
    report.venues = [{
      courseName: "Legacy Simulator", bookingUrl: "https://example.com/book",
      availability: "CHECK_PENDING"
    }];
    const hydrated = hydrateSimulatorStatusPayload(payload);
    expect(hydrated.userTimeZone).toBeUndefined();
    expect(hydrated.venues[0].courseRank).toBeUndefined();
    expect(renderSimulatorStatusHtml(hydrated)).toContain("Legacy Simulator");
  });

  it("retains a full session interval and venue address for saved match emails", async () => {
    const result = await hydrateMatchAlertPayload({
      searchId: "search-1", alertGeneration: 1,
      payload: {
        schemaVersion: 3, mode: "SIMULATOR", checkedAt,
        matchReport: {
          mode: "SIMULATOR", targetDate: "2026-10-10", startTime: "09:00",
          endTime: "14:00", durationMinutes: 60, players: 4,
          userTimeZone: "America/New_York",
          matches: [{
            offeringId: "offering-1", courseId: "venue-1", courseName: "Example Simulator",
            courseAddress: "Fairfield, Connecticut", courseRank: 1,
            courseTimeZone: "America/New_York", startsAt: "2026-10-10T13:00:00.000Z",
            endsAt: "2026-10-10T14:00:00.000Z", availableSpots: 1,
            bookingUrl: "https://example.com/book", isNew: true
          }]
        }
      }
    });
    expect(result.matches[0].courseAddress).toBe("Fairfield, Connecticut");
    expect(result.matches[0].startsAt.toISOString()).toBe("2026-10-10T13:00:00.000Z");
    expect(result.matches[0].endsAt?.toISOString()).toBe("2026-10-10T14:00:00.000Z");
    expect(result.durationMinutes).toBe(60);
  });
});
