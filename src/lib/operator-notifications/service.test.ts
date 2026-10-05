// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ search: vi.fn(), probe: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  $transaction: async (callback: (tx: unknown) => unknown) => callback({
    teeSearch: { findUnique: mocks.search }, courseProbe: { findFirst: mocks.probe },
  }),
} }));
vi.mock("./push", () => ({ sendOperatorNotification: mocks.send, OperatorNotificationSendError: class extends Error {} }));

import { loadOperatorNotificationSearch } from "./service";

describe("operator notification search evidence", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("reads only the selected simulator offering on the same search", async () => {
    const offering = { id: "simulator-offering", kind: "SIMULATOR" };
    mocks.search.mockResolvedValue({ id: "search-1", mode: "SIMULATOR", alertGeneration: 2,
      preferences: [{ courseId: "hybrid", offeringId: offering.id, offering }], emailDeliveries: [],
    });
    const correctProbe = { teeSearchId: "search-1", courseId: "hybrid", offeringId: offering.id, outcome: "NO_MATCH" };
    mocks.probe.mockImplementation(async (query) => query.where.teeSearchId === "search-1" && query.where.offeringId === offering.id
      ? correctProbe : { ...correctProbe, offeringId: "outdoor-offering", outcome: "FETCH_FAILED" });
    const result = await loadOperatorNotificationSearch("search-1");
    expect(result?.probes).toEqual([correctProbe]);
    expect(mocks.search.mock.calls[0][0].include.preferences.include.offering).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("preserves outdoor probe reads after legacy offering backfill", async () => {
    mocks.search.mockResolvedValue({ id: "search-1", mode: "OUTDOOR", alertGeneration: 0,
      preferences: [{ courseId: "course-1", offeringId: "outdoor-offering" }], emailDeliveries: [],
    });
    mocks.probe.mockResolvedValue({ courseId: "course-1", offeringId: "outdoor-offering", outcome: "NO_MATCH" });
    expect((await loadOperatorNotificationSearch("search-1"))?.probes).toHaveLength(1);
    expect(mocks.probe.mock.calls[0][0].where).toEqual({ teeSearchId: "search-1", courseId: "course-1" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
