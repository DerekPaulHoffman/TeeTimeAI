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

  it("follows an official intermediate tee-time page to reusable Teesnap metadata", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === "https://southersmarsh.com/") {
        return new Response(
          '<html><a href="/teetimes/">Tee Times and Barn Reservations</a></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      if (value === "https://southersmarsh.com/teetimes/") {
        return new Response(
          '<html><a href="https://southersmarsh.teesnap.net/">Continue to tee times</a></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response(
        '<html><script>window.courses = [{"id":1196,"name":"Top Tracer Range","core_id":1301},{"id":655,"name":"Southers Marsh Golf Club","core_id":761,"holes_default":18,"addons_default":"on"}]; window.property = {"id":599};</script></html>',
        { status: 200, headers: { "content-type": "text/html" } }
      );
    });
    const search = {
      preferences: [
        {
          rank: 1,
          course: {
            id: "southers-marsh",
            name: "Southers Marsh Golf Club",
            website: "https://southersmarsh.com/",
            detectedBookingUrl: null,
            detectedPlatform: "UNKNOWN",
            automationEligibility: "UNKNOWN",
            bookingMetadata: null
          }
        }
      ]
    } as never;

    await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "LEARNED",
        detectedPlatform: "CUSTOM",
        apiMetadata: {
          provider: "TEESNAP",
          courseId: 655,
          bookingBaseUrl: "https://southersmarsh.teesnap.net/",
          defaultHoles: 18,
          defaultAddons: "on"
        }
      })
    );
  });

  it("inspects an official FAQ before the Whoosh shell and classifies account-required availability", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === "https://yalebulldogs.com/golf") {
        return new Response(
          '<html><script>window.navigation = {"items":[{"title":"Frequently Asked Questions (FAQ)","url":"/faqs"},{"title":"Register & Book a Tee Time","url":"https://app.whoosh.io/patron/club/yale-golf-course"}]};</script></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      if (value === "https://yalebulldogs.com/faqs") {
        return new Response(
          "<html>Players must register in Whoosh before booking. Once a player’s registration is confirmed, availability of tee times through Whoosh can be viewed once booking windows open.</html>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("<html><body>Whoosh</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const search = {
      preferences: [
        {
          rank: 1,
          course: {
            id: "yale",
            name: "Yale University Golf Course",
            website: "https://yalebulldogs.com/golf",
            detectedBookingUrl: null,
            detectedPlatform: "UNKNOWN",
            automationEligibility: "UNKNOWN",
            bookingMetadata: null
          }
        }
      ]
    } as never;

    await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://yalebulldogs.com/golf",
      "https://yalebulldogs.com/faqs",
      "https://app.whoosh.io/patron/club/yale-golf-course"
    ]);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "VERIFIED",
        detectedPlatform: "CUSTOM",
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        evidence: expect.objectContaining({ learnedFrom: "official-account-required-booking" })
      })
    );
  });

  it("follows the official club overview when a private-club shell hides access details", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === "https://www.osgolfclub.com/") {
        return new Response(
          '<html><body><a href="/public">The Club</a><footer>Private Golf Club sites by MembersFirst</footer></body></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response(
        '<html><body>Old Sandwich Golf Club is a private club available to Local and National members.</body></html>',
        { status: 200, headers: { "content-type": "text/html" } }
      );
    });
    const search = {
      preferences: [
        {
          rank: 1,
          course: {
            id: "old-sandwich",
            name: "Old Sandwich Golf Club",
            website: "https://www.osgolfclub.com/",
            detectedBookingUrl: null,
            detectedPlatform: "UNKNOWN",
            automationEligibility: "UNKNOWN",
            bookingMetadata: null
          }
        }
      ]
    } as never;

    await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "VERIFIED",
        bookingMethod: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        evidence: expect.objectContaining({ learnedFrom: "official-private-club-access" })
      })
    );
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
