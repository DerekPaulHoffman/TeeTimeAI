import { describe, expect, it } from "vitest";

import { createAutomationService } from "./service";
import type { AutomationStore } from "./service";

describe("automation service", () => {
  it("records no-match probes without creating tee time alerts", async () => {
    const store = createInMemoryStore();
    const service = createAutomationService(store);

    await service.recordProbe({
      searchId: "search-1",
      courseId: "course-1",
      outcome: "NO_MATCH",
      observedAt: new Date("2026-08-01T12:00:00Z"),
      message: "No qualifying in-window tee times"
    });

    expect(store.probes).toHaveLength(1);
    expect(store.matches).toHaveLength(0);
  });

  it("records new matches idempotently", async () => {
    const store = createInMemoryStore();
    const service = createAutomationService(store);

    const match = {
      searchId: "search-1",
      courseId: "course-1",
      sourceId: "foreup-6654-1340",
      startsAt: "2026-08-10T13:40:00-04:00",
      availableSpots: 3,
      bookingUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
    };

    await service.recordMatch(match);
    await service.recordMatch(match);

    expect(store.matches).toHaveLength(1);
    expect(store.matches[0]?.alertStatus).toBe("PENDING");
  });

  it("marks pending matches as sent once", async () => {
    const store = createInMemoryStore();
    const service = createAutomationService(store);

    await service.recordMatch({
      searchId: "search-1",
      courseId: "course-1",
      sourceId: "foreup-6654-1340",
      startsAt: "2026-08-10T13:40:00-04:00",
      availableSpots: 3,
      bookingUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
    });

    await service.markAlertSent("search-1", "course-1", "foreup-6654-1340");
    await service.markAlertSent("search-1", "course-1", "foreup-6654-1340");

    expect(store.matches[0]?.alertStatus).toBe("SENT");
    expect(store.matches[0]?.sentCount).toBe(1);
  });
});

function createInMemoryStore(): AutomationStore {
  return {
    probes: [],
    matches: []
  };
}
