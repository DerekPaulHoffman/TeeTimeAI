import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  applyBrowserDiscoveryToCourse: vi.fn(),
  listRecentCourseAutomationDiscoveries: vi.fn(),
  recordBrowserDiscovery: vi.fn()
}));
const providerLeaseMocks = vi.hoisted(() => ({
  runWithProviderRequestLease: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => dbMocks);
vi.mock("@/lib/automation/provider-request-lease", () => providerLeaseMocks);

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
    providerLeaseMocks.runWithProviderRequestLease.mockImplementation(
      async (_providerFamilyKey: string, worker: () => Promise<unknown>) => ({
        acquired: true,
        value: await worker()
      })
    );
  });

  it("defers discovery without external I/O when the distributed provider lease is busy", async () => {
    providerLeaseMocks.runWithProviderRequestLease.mockResolvedValueOnce({
      acquired: false
    });
    const fetchImpl = vi.fn();
    const search = {
      preferences: [
        {
          rank: 1,
          course: {
            id: "busy-course",
            name: "Busy Course",
            website: "https://busy.example/golf",
            detectedBookingUrl: null,
            detectedPlatform: "UNKNOWN",
            automationEligibility: "UNKNOWN",
            bookingMetadata: null
          }
        }
      ]
    } as never;

    await expect(
      prepareSearchMonitoring(search, fetchImpl as typeof fetch, now)
    ).resolves.toEqual({
      attemptedCourseIds: [],
      appliedCourseIds: [],
      failedCourseIds: [],
      deferredCourseIds: ["busy-course"],
      retryCourseIds: ["busy-course"]
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
  });

  it("defers the whole discovery when a newly detected provider family is busy", async () => {
    providerLeaseMocks.runWithProviderRequestLease
      .mockImplementationOnce(
        async (_providerFamilyKey: string, worker: () => Promise<unknown>) => ({
          acquired: true,
          value: await worker()
        })
      )
      .mockResolvedValueOnce({ acquired: false });
    const fetchImpl = vi.fn(async () =>
      new Response(
        '<html><a href="https://busy-provider.book.teeitup.golf/">Book a tee time</a></html>',
        { status: 200, headers: { "content-type": "text/html" } }
      )
    );
    const search = {
      preferences: [
        {
          rank: 1,
          course: {
            id: "busy-followup",
            name: "Busy Followup Course",
            website: "https://course.example/golf",
            detectedBookingUrl: null,
            detectedPlatform: "UNKNOWN",
            automationEligibility: "UNKNOWN",
            bookingMetadata: null
          }
        }
      ]
    } as never;

    await expect(
      prepareSearchMonitoring(search, fetchImpl as typeof fetch, now)
    ).resolves.toEqual({
      attemptedCourseIds: [],
      appliedCourseIds: [],
      failedCourseIds: [],
      deferredCourseIds: ["busy-followup"],
      retryCourseIds: ["busy-followup"]
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
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
    expect(
      providerLeaseMocks.runWithProviderRequestLease.mock.calls.map(
        ([providerFamilyKey]) => providerFamilyKey
      )
    ).toEqual(["dennis.example", "TEEITUP"]);
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
      deferredCourseIds: [],
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

  it("learns Chronogolf metadata from an official inline widget club id", async () => {
    const officialUrl = "https://hydepark.example/";
    const profileUrl = "https://www.chronogolf.com/club/4006";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === officialUrl) {
        const longMarketingCopy = "Historic public golf course. ".repeat(600);
        return new Response(
          `<html><body><p>${longMarketingCopy}</p><script>
            window.chronogolfSettings = { "clubId": 4006, "locale": "en-US" };
          </script><script src="https://cdn2.chronogolf.com/widgets/v2"></script></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      expect(value).toBe(profileUrl);
      return new Response(
        `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
          props: {
            pageProps: {
              club: {
                id: 4006,
                features: { onlineBookingEnabled: true },
                courses: [{ uuid: "hyde-park-course-uuid" }]
              }
            }
          }
        })}</script></html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    });
    const search = {
      preferences: [
        {
          rank: 1,
          course: {
            id: "hyde-park",
            name: "Hyde Park Golf Club",
            website: officialUrl,
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
      officialUrl,
      profileUrl
    ]);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "LEARNED",
        detectedPlatform: "CHRONOGOLF",
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        bookingUrl: profileUrl,
        apiMetadata: {
          clubId: 4006,
          courseIds: ["hyde-park-course-uuid"],
          bookingBaseUrl: profileUrl
        },
        evidence: expect.objectContaining({
          learnedFrom: "chronogolf-public-club-profile"
        })
      })
    );
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
        evidence: expect.objectContaining({
          learnedFrom: "official-whoosh-booking"
        })
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
        status: "INSPECTED",
        detectedPlatform: "CUSTOM",
        bookingUrl: "https://fox.tenfore.golf/gainfieldfarms",
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "NONE"
      })
    );
  });

  it("upgrades a stale HTTP site and classifies its challenge-protected CPS booking", async () => {
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "grassy-hill",
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          accessBarriers: [
            { url: "https://grassyhill.cps.golf/", status: 403 }
          ]
        }
      }
    ]);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === "https://www.grassyhillcountryclub.com/") {
        return new Response("Conflict", { status: 409 });
      }
      if (value === "https://grassyhillcountryclub.com/") {
        return new Response(
          '<html><a href="https://secure.east.prophetservices.com/GrassyHillCCV3">Book Online Tee Times</a></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      if (value === "https://secure.east.prophetservices.com/GrassyHillCCV3") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://grassyhill.cps.golf" }
        });
      }
      if (value === "https://grassyhill.cps.golf/") {
        return new Response("<html><body>Enable JavaScript and cookies to continue</body></html>", {
          status: 403,
          headers: {
            "content-type": "text/html",
            "cf-mitigated": "challenge"
          }
        });
      }
      throw new Error(`Unexpected URL ${value}`);
    });
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "grassy-hill",
          name: "Grassy Hill Country Club",
          website: "http://www.grassyhillcountryclub.com/",
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://www.grassyhillcountryclub.com/",
      "https://grassyhillcountryclub.com/",
      "https://secure.east.prophetservices.com/GrassyHillCCV3",
      "https://grassyhill.cps.golf/"
    ]);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "VERIFIED",
        bookingUrl: "https://grassyhill.cps.golf/",
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE"
      })
    );
  });

  it("learns reusable GolfBack metadata from an official course link", async () => {
    const bookingUrl =
      "https://golfback.com/#/course/5a90fb0c-b928-43f0-9486-d5d43c03d25d";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === "https://windsorparke.example/") {
        return new Response(
          `<html><body>Public tee times<a href="${bookingUrl}">Book Online Now</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      if (value === bookingUrl) {
        return new Response(
          "<html><body>Windsor Parke public tee times</body></html>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      throw new Error(`Unexpected URL ${value}`);
    });
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "windsor-parke",
          name: "Windsor Parke Golf Club",
          website: "https://windsorparke.example/",
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://windsorparke.example/",
      bookingUrl
    ]);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "LEARNED",
        detectedPlatform: "CUSTOM",
        bookingUrl,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        apiMetadata: {
          provider: "GOLFBACK",
          courseId: "5a90fb0c-b928-43f0-9486-d5d43c03d25d",
          bookingBaseUrl: bookingUrl
        },
        evidence: expect.objectContaining({
          learnedFrom: "golfback-public-course-link"
        })
      })
    );
  });

  it("preserves official booking-link labels so shared Club Caddie inventories can be mapped safely", async () => {
    const amherstUrl =
      "https://apimanager-cc28.clubcaddie.com/webapi/view/amherst-public/slots";
    const ponemahUrl =
      "https://apimanager-cc28.clubcaddie.com/webapi/view/ponemah-public/slots";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (url.toString() === "https://playamherst.example/ponemah") {
        return new Response(
          `<html><a href="${amherstUrl}">Book @ ACC</a><a href="${ponemahUrl}">Book @ PG</a></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("<html><body>Public tee-time search</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });

    const evidence = await collectOfficialSiteEvidence(
      "https://playamherst.example/ponemah",
      fetchImpl as typeof fetch,
      "Ponemah Green Family Golf Center"
    );

    expect(evidence.linkCandidates).toEqual(expect.arrayContaining([
      { url: amherstUrl, label: "Book @ ACC" },
      { url: ponemahUrl, label: "Book @ PG" }
    ]));
  });

  it("follows the course-matching CPS tenant before a sibling facility", async () => {
    const sourceUrl = "https://candiaoaks.example/";
    const oaksUrl = "https://oaksgolflinks.cps.golf/onlineresweb/search-teetime";
    const candiaUrl = "https://candiawoods.cps.golf/";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (url.toString() === sourceUrl) {
        return new Response(
          `<html><a href="${oaksUrl}">The Oaks Book A Tee Time</a><a href="${candiaUrl}">Candia Woods Book A Tee Time</a></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("<html><body>Public tee times</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });

    await collectOfficialSiteEvidence(
      sourceUrl,
      fetchImpl as typeof fetch,
      "Candia Woods Golf Links"
    );

    expect(fetchImpl.mock.calls[1]?.[0].toString()).toBe(candiaUrl);
  });

  it("falls back to an HTTP official site when HTTPS is unavailable", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = url.toString();
      if (value === "https://legacy.example/") {
        throw new TypeError("TLS unavailable");
      }
      expect(value).toBe("http://legacy.example/");
      return new Response("<html><body>Public golf course</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });

    await collectOfficialSiteEvidence("http://legacy.example/", fetchImpl as typeof fetch);

    expect(fetchImpl.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://legacy.example/",
      "http://legacy.example/"
    ]);
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
