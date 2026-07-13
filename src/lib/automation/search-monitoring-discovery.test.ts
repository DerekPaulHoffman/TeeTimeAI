import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  applyBrowserDiscoveryToCourse: vi.fn(),
  listRecentCourseAutomationDiscoveries: vi.fn(),
  recordBrowserDiscovery: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => dbMocks);

import {
  collectOfficialSiteEvidence,
  prepareSearchMonitoring,
  shouldAttemptMonitoringDiscovery
} from "./search-monitoring-discovery";

const now = new Date("2026-07-13T20:00:00.000Z");

describe("search monitoring discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([]);
    dbMocks.recordBrowserDiscovery.mockResolvedValue({ id: "discovery-1" });
    dbMocks.applyBrowserDiscoveryToCourse.mockResolvedValue({ id: "course-1" });
  });

  it("tries the official site before classification and reuses exact shared-site evidence", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === "https://dennis.example/golf") {
        return new Response(
          '<html><a href="https://dennis-golf.book.teeitup.golf/">Book a tee time</a></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("<html><body>Public tee times</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const course = {
      name: "Dennis Highlands",
      website: "https://dennis.example/golf",
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN",
      automationEligibility: "UNKNOWN",
      bookingMetadata: null
    };
    const search = {
      preferences: [
        { rank: 1, course: { ...course, id: "dennis-highlands" } },
        { rank: 2, course: { ...course, id: "dennis-pines", name: "Dennis Pines" } }
      ]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledTimes(2);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "LEARNED",
        detectedPlatform: "TEEITUP",
        apiMetadata: expect.objectContaining({ aliases: ["dennis-golf"] })
      })
    );
    expect(result).toEqual({
      attemptedCourseIds: ["dennis-highlands", "dennis-pines"],
      appliedCourseIds: ["dennis-highlands", "dennis-pines"],
      failedCourseIds: [],
      retryCourseIds: ["dennis-highlands", "dennis-pines"]
    });
  });

  it("stops fast search retries after the second persisted discovery attempt", async () => {
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      { courseId: "course-1", createdAt: new Date("2026-07-13T19:00:00.000Z") }
    ]);
    dbMocks.applyBrowserDiscoveryToCourse.mockResolvedValue(null);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html><body>Public golf course</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    );
    const search = {
      preferences: [
        {
          rank: 1,
          course: {
            id: "course-1",
            name: "Example Golf Course",
            website: "https://course.example/",
            detectedBookingUrl: null,
            detectedPlatform: "UNKNOWN",
            automationEligibility: "UNKNOWN",
            bookingMetadata: null
          }
        }
      ]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(result.attemptedCourseIds).toEqual(["course-1"]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("allows one retry after thirty minutes but caps discovery at two attempts per day", () => {
    expect(
      shouldAttemptMonitoringDiscovery(
        [new Date("2026-07-13T19:31:00.000Z")],
        now
      )
    ).toBe(false);
    expect(
      shouldAttemptMonitoringDiscovery(
        [new Date("2026-07-13T19:30:00.000Z")],
        now
      )
    ).toBe(true);
    expect(
      shouldAttemptMonitoringDiscovery(
        [
          new Date("2026-07-13T18:00:00.000Z"),
          new Date("2026-07-13T19:00:00.000Z")
        ],
        now
      )
    ).toBe(false);
  });

  it("refuses private-network URLs without making a request", async () => {
    const fetchImpl = vi.fn();

    await expect(
      collectOfficialSiteEvidence("http://127.0.0.1/admin", fetchImpl as typeof fetch)
    ).rejects.toThrow("safe public HTTP address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
