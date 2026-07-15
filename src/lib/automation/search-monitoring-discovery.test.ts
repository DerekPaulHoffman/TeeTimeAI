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

  it("learns ForeUp metadata from Apptegy embedded content links", async () => {
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/19333/145#teetimes";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === "https://www.stratfordct.gov/short-beach") {
        return new Response(
          String.raw`<html><script>window.page = JSON.parse("{\"content\":{\"buttons\":[{\"title\":\"Book Your Tee Time Online\",\"link\":\"https://foreupsoftware.com/index.php/booking/19333/145#teetimes\"}]}}")</script></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      expect(value).toBe(bookingUrl);
      return new Response("<html><body>Public ForeUp tee sheet</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const search = {
      preferences: [
        {
          rank: 1,
          course: {
            id: "short-beach",
            name: "Short Beach Golf Course",
            website: "https://www.stratfordct.gov/short-beach",
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
      "https://www.stratfordct.gov/short-beach",
      bookingUrl
    ]);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "LEARNED",
        detectedPlatform: "FOREUP",
        bookingUrl,
        apiMetadata: {
          scheduleId: 145,
          bookingBaseUrl: bookingUrl
        },
        evidence: expect.objectContaining({
          learnedFrom: "foreup-booking-url",
          observedUrls: expect.arrayContaining([bookingUrl])
        })
      })
    );
    const discovery = dbMocks.recordBrowserDiscovery.mock.calls[0]?.[0];
    expect(
      discovery.evidence.observedUrls.some(
        (url: string) => url.includes('\\"') || url.includes("%22")
      )
    ).toBe(false);
  });

  it("follows the exact course detail after a legacy URL redirects to a multi-course index", async () => {
    const legacyUrl = "https://city.example/departments/golf-course/";
    const indexUrl = "https://city.example/departments/golf-courses/";
    const detailUrl =
      "https://city.example/departments/golf-courses/winter-park-golf-course/";
    const siblingUrl =
      "https://city.example/departments/golf-courses/winter-park-pines-golf-club/";
    const bookingUrl = "https://winter-park-country-club.book.teeitup.com/";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === legacyUrl) {
        return new Response(null, {
          status: 301,
          headers: { location: indexUrl }
        });
      }
      if (value === indexUrl) {
        return new Response(
          `<html><a href="${detailUrl}">Winter Park Golf Course (WP9)</a><a href="${siblingUrl}">Winter Park Pines Golf Club (WP18)</a></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      if (value === detailUrl) {
        return new Response(
          `<html><p>Public tee times can be made three days ahead.</p><a href="${bookingUrl}">Book a Tee Time</a></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      if (value === bookingUrl) {
        return new Response("<html><body>Public tee sheet</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      throw new Error(`Unexpected URL ${value}`);
    });
    const search = {
      preferences: [
        {
          rank: 1,
          course: {
            id: "winter-park",
            name: "Winter Park Golf Course",
            website: legacyUrl,
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
      legacyUrl,
      indexUrl,
      detailUrl,
      bookingUrl
    ]);
    expect(fetchImpl).not.toHaveBeenCalledWith(siblingUrl, expect.anything());
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "LEARNED",
        detectedPlatform: "TEEITUP",
        bookingUrl,
        apiMetadata: expect.objectContaining({
          aliases: ["winter-park-country-club"],
          bookingBaseUrl: bookingUrl
        }),
        evidence: expect.objectContaining({
          observedUrls: expect.arrayContaining([detailUrl, bookingUrl])
        })
      })
    );
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

  it("does not let auxiliary FAQ wording override an ungated Whoosh booking surface", async () => {
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
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "UNSUPPORTED_PLATFORM",
        bookingUrl: "https://app.whoosh.io/patron/club/yale-golf-course",
        evidence: expect.objectContaining({ learnedFrom: "official-whoosh-booking" })
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

  it("preserves the official TenFore link even when a later simulator page is inspected", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === "https://gainfield.example/") {
        return new Response(
          '<html><a href="https://fox.tenfore.golf/gainfieldfarms">Book Tee Time</a><a href="/simulator-at-gainfield-farms/">Book indoor golf</a></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("<html><body>Public booking surface</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "gainfield",
          name: "Gainfield Farms Golf Course",
          website: "https://gainfield.example/",
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "VERIFIED",
        detectedPlatform: "CUSTOM",
        bookingUrl: "https://fox.tenfore.golf/gainfieldfarms",
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE"
      })
    );
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
