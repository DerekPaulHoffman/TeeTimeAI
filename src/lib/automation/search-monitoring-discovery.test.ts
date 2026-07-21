import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  applyBrowserDiscoveryToCourse: vi.fn(),
  listRecentCourseAutomationDiscoveries: vi.fn(),
  recordBrowserDiscovery: vi.fn(),
  retireLegacyPolicyOnlyCourseBlock: vi.fn()
}));
const providerLeaseMocks = vi.hoisted(() => ({
  runWithProviderRequestLease: vi.fn()
}));
const prismaMocks = vi.hoisted(() => ({
  courseSupportBatchSearch: { findMany: vi.fn() }
}));

vi.mock("@/lib/automation/db-service", () => dbMocks);
vi.mock("@/lib/automation/provider-request-lease", () => providerLeaseMocks);
vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import { buildBrowserDiscovery } from "./browser-discovery";
import {
  collectOfficialSiteEvidence,
  createAddressPinnedPublicFetch,
  prepareSearchMonitoring,
  shouldAttemptMonitoringDiscovery
} from "./search-monitoring-discovery";

const now = new Date("2026-07-13T20:00:00.000Z");
const remediationDispatchedAt = new Date("2026-07-13T19:30:00.000Z");
const remediationLeaseExpiresAt = new Date("2026-07-13T20:15:00.000Z");

function remediationPreference(courseId: string, rank: number) {
  return {
    rank,
    course: {
      id: courseId,
      name: `${courseId} Golf Course`,
      website: `https://${courseId}.example/`,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN",
      automationEligibility: "UNKNOWN",
      bookingMetadata: null
    }
  };
}

function remediationSearch(
  courseIds = ["remediated-course"],
  overrides: Record<string, unknown> = {}
) {
  return {
    id: "search-1",
    scheduleVersion: 7,
    remediationDispatchKey: "dispatch-key",
    remediationDispatchVersion: 7,
    checkLeaseToken: "check-lease",
    checkLeaseExpiresAt: remediationLeaseExpiresAt,
    preferences: courseIds.map((courseId, index) =>
      remediationPreference(courseId, index + 1)
    ),
    ...overrides
  } as never;
}

function remediationDispatchRow(
  courseIds = ["remediated-course"],
  scheduleVersion = 7
) {
  return {
    scheduleVersion: 7,
    removedAt: null,
    teeSearch: {
      id: "search-1",
      status: "ACTIVE",
      scheduleVersion,
      remediationDispatchKey: "dispatch-key",
      remediationDispatchVersion: 7,
      checkLeaseToken: "check-lease",
      checkLeaseExpiresAt: remediationLeaseExpiresAt,
      preferences: courseIds.map((courseId) => ({ courseId }))
    },
    batch: {
      status: "VERIFYING",
      releaseSha: "release-sha",
      deployedAt: new Date("2026-07-13T19:20:00.000Z"),
      recheckDispatchKey: "dispatch-key",
      recheckDispatchStartedAt: remediationDispatchedAt,
      recheckDispatchedAt: new Date("2026-07-13T19:31:00.000Z"),
      incidents: courseIds.map((courseId, index) => ({
        id: `batch-incident-${index + 1}`,
        courseId
      }))
    }
  };
}

describe("search monitoring discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([]);
    dbMocks.recordBrowserDiscovery.mockResolvedValue({ id: "discovery-1" });
    dbMocks.applyBrowserDiscoveryToCourse.mockResolvedValue({ id: "course-1" });
    dbMocks.retireLegacyPolicyOnlyCourseBlock.mockResolvedValue({ id: "course-1" });
    prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([]);
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

  it("does not apply one generic shared-site TeeItUp alias to Dennis Highlands and Dennis Pines", async () => {
    dbMocks.applyBrowserDiscoveryToCourse.mockResolvedValue(null);
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
    const discoveries = dbMocks.recordBrowserDiscovery.mock.calls.map(
      ([discovery]) => discovery
    );
    expect(discoveries).toEqual([
      expect.objectContaining({
        courseId: "dennis-highlands",
        status: "INSPECTED",
        detectedPlatform: "TEEITUP",
        bookingUrl: "https://dennis.example/golf",
        evidence: expect.objectContaining({
          learnedFrom: "teeitup-target-scope-unconfirmed"
        })
      }),
      expect.objectContaining({
        courseId: "dennis-pines",
        status: "INSPECTED",
        detectedPlatform: "TEEITUP",
        bookingUrl: "https://dennis.example/golf",
        evidence: expect.objectContaining({
          learnedFrom: "teeitup-target-scope-unconfirmed"
        })
      })
    ]);
    expect(discoveries.every((discovery) => discovery.apiMetadata === undefined))
      .toBe(true);
    expect(result).toEqual({
      attemptedCourseIds: ["dennis-highlands", "dennis-pines"],
      appliedCourseIds: [],
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

  it("learns minimal CPS metadata from the exact tenant public configuration", async () => {
    const officialUrl = "https://town.example/golf";
    const bookingUrl =
      "https://colonie.cps.golf/onlineresweb/search-teetime";
    const configurationUrl =
      "https://colonie.cps.golf/onlineresweb/Home/Configuration";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const value = input.toString();
      if (value === officialUrl) {
        return new Response(
          `<html><a href="${bookingUrl}">Colonie Golf Course Book a Tee Time</a></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      if (value === bookingUrl) {
        return new Response("<html><body>Public tee time search</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (value === configurationUrl) {
        return new Response(
          JSON.stringify({
            courseId: 0,
            siteName: "colonie",
            websiteId: "public-website",
            onlineApi:
              "https://colonie.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
            authorityBaseUrl: "https://colonie.cps.golf/identityapi",
            apiKey: "must-not-be-persisted"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Unexpected URL ${value}`);
    });
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "colonie",
          name: "Colonie Golf Course",
          website: officialUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(
      search,
      fetchImpl as typeof fetch,
      now
    );

    expect(fetchImpl.mock.calls.map(([input]) => input.toString())).toEqual([
      officialUrl,
      bookingUrl,
      configurationUrl
    ]);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "LEARNED",
        bookingUrl: "https://colonie.cps.golf/",
        apiEndpoint:
          "https://colonie.cps.golf/onlineres/onlineapi/api/v1/onlinereservation/TeeTimes",
        apiMetadata: {
          provider: "CPS",
          siteName: "colonie",
          bookingBaseUrl: "https://colonie.cps.golf/",
          courseIds: [0],
          holes: [18, 9],
          resolvePlaceholderCourseIds: true
        },
        evidence: expect.objectContaining({
          learnedFrom: "cps-public-configuration"
        })
      })
    );
    expect(JSON.stringify(dbMocks.recordBrowserDiscovery.mock.calls)).not.toContain(
      "must-not-be-persisted"
    );
    expect(result).toEqual({
      attemptedCourseIds: ["colonie"],
      appliedCourseIds: ["colonie"],
      failedCourseIds: [],
      deferredCourseIds: [],
      retryCourseIds: ["colonie"]
    });
  });

  it("defers CPS enrichment without recording partial metadata when its lease is busy", async () => {
    providerLeaseMocks.runWithProviderRequestLease
      .mockImplementationOnce(
        async (_providerFamilyKey: string, worker: () => Promise<unknown>) => ({
          acquired: true,
          value: await worker()
        })
      )
      .mockImplementationOnce(
        async (_providerFamilyKey: string, worker: () => Promise<unknown>) => ({
          acquired: true,
          value: await worker()
        })
      )
      .mockResolvedValueOnce({ acquired: false });
    const officialUrl = "https://town.example/golf";
    const bookingUrl =
      "https://colonie.cps.golf/onlineresweb/search-teetime";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (input.toString() === officialUrl) {
        return new Response(
          `<html><a href="${bookingUrl}">Colonie Golf Course Book a Tee Time</a></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("<html><body>Public tee time search</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "colonie",
          name: "Colonie Golf Course",
          website: officialUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    await expect(
      prepareSearchMonitoring(search, fetchImpl as typeof fetch, now)
    ).resolves.toEqual({
      attemptedCourseIds: [],
      appliedCourseIds: [],
      failedCourseIds: [],
      deferredCourseIds: ["colonie"],
      retryCourseIds: ["colonie"]
    });
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
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

  it("does not treat persisted runnable adapter metadata as current working evidence", async () => {
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes";
    const updatedAt = new Date("2026-07-13T18:00:00.000Z");
    const fetchImpl = vi.fn(async () => {
      throw new Error("Current public evidence is unavailable");
    });
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "runnable-policy-course",
          name: "Runnable Policy Golf Course",
          website: "https://runnable.example/",
          detectedBookingUrl: bookingUrl,
          detectedPlatform: "FOREUP",
          providerFamilyKey: "FOREUP",
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: {
            scheduleId: 6123,
            bookingBaseUrl: bookingUrl
          },
          updatedAt
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "runnable-policy-course",
        status: "FAILED"
      })
    );
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(dbMocks.retireLegacyPolicyOnlyCourseBlock).toHaveBeenCalledWith(
      "runnable-policy-course",
      {
        updatedAt,
        detectedBookingUrl: bookingUrl,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED"
      },
      {
        preserveWebsite: true,
        preserveDetectedBookingUrl: true,
        preserveBookingMetadata: true
      }
    );
    expect(result.appliedCourseIds).toEqual(["runnable-policy-course"]);
    expect(result.failedCourseIds).toEqual(["runnable-policy-course"]);
    expect(result.attemptedCourseIds).toEqual(["runnable-policy-course"]);
  });

  it("does not persist a sensitive booking URL when discovery fails", async () => {
    const unsafeBookingUrl =
      "https://booking.example/checkout?session_token=synthetic-secret-value";
    const safeWebsite = "https://course.example/";
    const fetchImpl = vi.fn(async () => {
      throw new Error("Current public evidence is unavailable");
    });
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "sensitive-booking-url",
          name: "Safe Evidence Golf Course",
          website: safeWebsite,
          detectedBookingUrl: unsafeBookingUrl,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMethod: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).toHaveBeenCalledWith(
      safeWebsite,
      expect.any(Object)
    );
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "sensitive-booking-url",
        status: "FAILED",
        sourceUrl: safeWebsite,
        evidence: expect.objectContaining({ observedUrls: [safeWebsite] })
      })
    );
    expect(
      JSON.stringify(dbMocks.recordBrowserDiscovery.mock.calls)
    ).not.toContain(unsafeBookingUrl);
  });

  it("does not preserve cross-origin CPS endpoint overrides", async () => {
    const bookingUrl = "https://tenant.cps.golf/";
    const updatedAt = new Date("2026-07-13T18:00:00.000Z");
    const fetchImpl = vi.fn(async () => {
      throw new Error("Current public evidence is unavailable");
    });
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "cross-origin-cps-policy",
          name: "CPS Policy Golf Course",
          website: bookingUrl,
          detectedBookingUrl: bookingUrl,
          detectedPlatform: "CUSTOM",
          providerFamilyKey: "CPS",
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: {
            provider: "CPS",
            siteName: "tenant",
            bookingBaseUrl: bookingUrl,
            courseIds: [1],
            websiteId: "1",
            authorityBaseUrl: "https://tenant.cps.golf/identityapi",
            onlineApi: "https://unrelated.example/public-api"
          },
          updatedAt
        }
      }]
    } as never;

    await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(dbMocks.retireLegacyPolicyOnlyCourseBlock).toHaveBeenCalledWith(
      "cross-origin-cps-policy",
      expect.any(Object),
      {
        preserveWebsite: true,
        preserveDetectedBookingUrl: true,
        preserveBookingMetadata: false
      }
    );
  });

  it("retires a legacy policy-only block that has no safe public source", async () => {
    const updatedAt = new Date("2026-07-13T18:00:00.000Z");
    const unsafeBookingUrl =
      "https://booking.example/checkout?session_token=synthetic-secret-value";
    const unsafeWebsite =
      "https://course.example/account/session/synthetic-secret-value";
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "unsafe-policy-source",
          name: "Unsafe Policy Source Golf Course",
          website: unsafeWebsite,
          detectedBookingUrl: unsafeBookingUrl,
          detectedPlatform: "CUSTOM",
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: { bookingBaseUrl: unsafeBookingUrl },
          updatedAt
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(dbMocks.retireLegacyPolicyOnlyCourseBlock).toHaveBeenCalledWith(
      "unsafe-policy-source",
      {
        updatedAt,
        detectedBookingUrl: unsafeBookingUrl,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED"
      },
      {
        preserveWebsite: false,
        preserveDetectedBookingUrl: false,
        preserveBookingMetadata: false
      }
    );
    expect(result.appliedCourseIds).toEqual(["unsafe-policy-source"]);
  });

  it("retains credential-free customer account links without probing them", async () => {
    const updatedAt = new Date("2026-07-13T18:00:00.000Z");
    const website = "https://course.example/members/tee-times";
    const bookingUrl = "https://booking.example/account/tee-times";
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "account-link-policy-source",
          name: "Account Link Golf Course",
          website,
          detectedBookingUrl: bookingUrl,
          detectedPlatform: "CUSTOM",
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: null,
          updatedAt
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.retireLegacyPolicyOnlyCourseBlock).toHaveBeenCalledWith(
      "account-link-policy-source",
      expect.any(Object),
      {
        preserveWebsite: true,
        preserveDetectedBookingUrl: true,
        preserveBookingMetadata: false
      }
    );
    expect(result.appliedCourseIds).toEqual(["account-link-policy-source"]);
  });

  it.each([
    "/checkout-session/start",
    "/payment-flow/start",
    "/cart-checkout/start",
    "/order-confirmation/start",
    "/session-id/opaque-state",
    "/signed-link/opaque-state",
    "/magic-link/opaque-state",
    "/oauth/callback/opaque-code",
    "/login/callback/opaque-ticket"
  ])("clears compound transaction or credential state at %s", async (path) => {
    const updatedAt = new Date("2026-07-13T18:00:00.000Z");
    const bookingUrl = `https://booking.example${path}`;
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "unsafe-customer-state",
          name: "Unsafe Customer State Golf Course",
          website: null,
          detectedBookingUrl: bookingUrl,
          detectedPlatform: "CUSTOM",
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: null,
          updatedAt
        }
      }]
    } as never;

    await prepareSearchMonitoring(search, vi.fn() as typeof fetch, now);

    expect(dbMocks.retireLegacyPolicyOnlyCourseBlock).toHaveBeenCalledWith(
      "unsafe-customer-state",
      expect.any(Object),
      {
        preserveWebsite: false,
        preserveDetectedBookingUrl: false,
        preserveBookingMetadata: false
      }
    );
  });

  it("reconciles a legacy policy-only Whoosh block from current public evidence", async () => {
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "yale",
        status: "FAILED",
        sourceUrl: "https://yalebulldogs.com/golf",
        createdAt: new Date("2026-07-13T19:30:00.000Z"),
        evidence: null
      },
      {
        courseId: "yale",
        status: "FAILED",
        sourceUrl: "https://yalebulldogs.com/golf",
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: null
      }
    ]);
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
            automationEligibility: "BLOCKED",
            automationReason: "AUTOMATION_PROHIBITED",
            bookingMethod: "PUBLIC_ONLINE",
            bookingMetadata: null,
            updatedAt: new Date("2026-07-14T00:00:00.000Z")
          }
        }
      ]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

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
          learnedFrom: "official-whoosh-booking:legacy-policy-reconciliation"
        })
      })
    );
    expect(dbMocks.applyBrowserDiscoveryToCourse).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "VERIFIED",
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "UNSUPPORTED_PLATFORM"
      }),
      {
        updatedAt: new Date("2026-07-14T00:00:00.000Z"),
        detectedBookingUrl: null,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED"
      }
    );
    expect(result.attemptedCourseIds).toEqual(["yale"]);
    expect(result.appliedCourseIds).toEqual(["yale"]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("does not bypass the daily cap again after a marked policy reconciliation", async () => {
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "legacy-policy-course",
        status: "FAILED",
        sourceUrl: "https://course.example/golf",
        createdAt: new Date("2026-07-13T19:30:00.000Z"),
        evidence: {
          learnedFrom:
            "browser-discovery-failed:legacy-policy-reconciliation"
        }
      },
      {
        courseId: "legacy-policy-course",
        status: "FAILED",
        sourceUrl: "https://course.example/golf",
        createdAt: new Date("2026-07-13T18:30:00.000Z"),
        evidence: null
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "legacy-policy-course",
          name: "Legacy Policy Golf Course",
          website: "https://course.example/golf",
          detectedBookingUrl: null,
          detectedPlatform: "CUSTOM",
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.attemptedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("waits for the retry interval before the one-time policy reconciliation", async () => {
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "recent-policy-course",
        status: "FAILED",
        sourceUrl: "https://recent.example/golf",
        createdAt: new Date("2026-07-13T19:50:00.000Z"),
        evidence: null
      },
      {
        courseId: "recent-policy-course",
        status: "FAILED",
        sourceUrl: "https://recent.example/golf",
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: null
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "recent-policy-course",
          name: "Recent Policy Golf Course",
          website: "https://recent.example/golf",
          detectedBookingUrl: null,
          detectedPlatform: "CUSTOM",
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.attemptedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual(["recent-policy-course"]);
  });

  it("schedules the bounded reconciliation after the second ordinary attempt", async () => {
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "second-attempt-policy-course",
        status: "FAILED",
        sourceUrl: "https://second-attempt.example/golf",
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: null
      }
    ]);
    dbMocks.applyBrowserDiscoveryToCourse.mockResolvedValueOnce(null);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html><body>Public golf course information.</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    );
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "second-attempt-policy-course",
          name: "Second Attempt Golf Course",
          website: "https://second-attempt.example/golf",
          detectedBookingUrl: null,
          detectedPlatform: "CUSTOM",
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(result.attemptedCourseIds).toEqual(["second-attempt-policy-course"]);
    expect(result.appliedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual(["second-attempt-policy-course"]);
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

  it("gives one capped remediated course a fresh attempt without uncapping its sibling", async () => {
    const dispatch = remediationDispatchRow([
      "remediated-course",
      "capped-sibling"
    ]);
    dispatch.batch.incidents = [
      { id: "batch-incident-1", courseId: "remediated-course" }
    ];
    prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([dispatch]);
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:20:00.000Z")
      },
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:00:00.000Z")
      },
      {
        courseId: "capped-sibling",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:15:00.000Z")
      },
      {
        courseId: "capped-sibling",
        status: "FAILED",
        createdAt: new Date("2026-07-13T18:45:00.000Z")
      }
    ]);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html><body>Public golf course</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    );

    const result = await prepareSearchMonitoring(
      remediationSearch(["remediated-course", "capped-sibling"]),
      fetchImpl as typeof fetch,
      now
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe(
      "https://remediated-course.example/"
    );
    expect(result.attemptedCourseIds).toEqual(["remediated-course"]);
    expect(dbMocks.listRecentCourseAutomationDiscoveries).toHaveBeenCalledWith(
      ["remediated-course", "capped-sibling"],
      new Date("2026-07-12T19:59:59.999Z")
    );
    expect(prismaMocks.courseSupportBatchSearch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teeSearchId: "search-1",
          scheduleVersion: 7,
          removedAt: null,
          teeSearch: {
            is: expect.objectContaining({
              scheduleVersion: 7,
              remediationDispatchKey: "dispatch-key",
              remediationDispatchVersion: 7,
              checkLeaseToken: "check-lease",
              checkLeaseExpiresAt: {
                equals: remediationLeaseExpiresAt,
                gt: now
              }
            })
          },
          batch: {
            is: expect.objectContaining({
              status: "VERIFYING",
              recheckDispatchKey: "dispatch-key",
              releaseSha: { not: null },
              deployedAt: { not: null },
              recheckDispatchStartedAt: { not: null },
              recheckDispatchedAt: { not: null }
            })
          }
        }),
        select: expect.objectContaining({
          batch: {
            select: expect.objectContaining({
              incidents: {
                where: {
                  result: { not: "FINAL_DISPOSITION" },
                  courseId: {
                    in: ["remediated-course", "capped-sibling"]
                  }
                },
                select: { courseId: true }
              }
            })
          }
        }),
        take: 2
      })
    );
  });

  it.each([7, 8])(
    "bypasses the retry delay for remediation schedule version %i",
    async (scheduleVersion) => {
      const dispatch = remediationDispatchRow(
        ["remediated-course"],
        scheduleVersion
      );
      dispatch.batch.recheckDispatchStartedAt = new Date(
        "2026-07-13T19:50:00.000Z"
      );
      dispatch.batch.recheckDispatchedAt = new Date(
        "2026-07-13T19:51:00.000Z"
      );
      prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([dispatch]);
      dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
        {
          courseId: "remediated-course",
          status: "FAILED",
          createdAt: new Date("2026-07-13T19:45:00.000Z")
        }
      ]);
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response("<html><body>Public golf course</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      );

      const result = await prepareSearchMonitoring(
        remediationSearch(["remediated-course"], { scheduleVersion }),
        fetchImpl as typeof fetch,
        now
      );

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(result.attemptedCourseIds).toEqual(["remediated-course"]);
    }
  );

  it.each(["LEARNED", "FAILED"])(
    "treats a post-dispatch %s row as consuming the one-shot override",
    async (status) => {
      prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([
        remediationDispatchRow()
      ]);
      dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
        {
          courseId: "remediated-course",
          status,
          createdAt: new Date("2026-07-13T19:40:00.000Z")
        },
        {
          courseId: "remediated-course",
          status: "FAILED",
          createdAt: new Date("2026-07-13T19:00:00.000Z")
        }
      ]);
      const fetchImpl = vi.fn();

      const result = await prepareSearchMonitoring(
        remediationSearch(),
        fetchImpl as typeof fetch,
        now
      );

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.attemptedCourseIds).toEqual([]);
    }
  );

  it("keeps a lease-deferred remediation attempt eligible for the same generation", async () => {
    prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([
      remediationDispatchRow()
    ]);
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:20:00.000Z")
      },
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:00:00.000Z")
      }
    ]);
    providerLeaseMocks.runWithProviderRequestLease.mockResolvedValue({
      acquired: false
    });
    const fetchImpl = vi.fn();
    const search = remediationSearch();

    const first = await prepareSearchMonitoring(
      search,
      fetchImpl as typeof fetch,
      now
    );
    const second = await prepareSearchMonitoring(
      search,
      fetchImpl as typeof fetch,
      now
    );

    expect(first.deferredCourseIds).toEqual(["remediated-course"]);
    expect(second.deferredCourseIds).toEqual(["remediated-course"]);
    expect(providerLeaseMocks.runWithProviderRequestLease).toHaveBeenCalledTimes(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
  });

  it("does not query remediation state for an ordinary search without a dispatch key", async () => {
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "ordinary-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:20:00.000Z")
      },
      {
        courseId: "ordinary-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:00:00.000Z")
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      ...remediationSearch(["ordinary-course"]),
      remediationDispatchKey: null,
      remediationDispatchVersion: null
    } as never;

    const result = await prepareSearchMonitoring(
      search,
      fetchImpl as typeof fetch,
      now
    );

    expect(prismaMocks.courseSupportBatchSearch.findMany).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.attemptedCourseIds).toEqual([]);
  });

  it.each([
    {
      label: "dispatch key",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.batch.recheckDispatchKey = "other-key";
      }
    },
    {
      label: "dispatch version",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.scheduleVersion = 6;
      }
    },
    {
      label: "current remediation version",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.teeSearch.remediationDispatchVersion = 6;
      }
    },
    {
      label: "current schedule version",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.teeSearch.scheduleVersion = 8;
      }
    },
    {
      label: "removed row",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.removedAt = remediationDispatchedAt as never;
      }
    },
    {
      label: "final disposition",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.batch.incidents = [];
      }
    },
    {
      label: "current preference",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.teeSearch.preferences = [{ courseId: "different-course" }];
      }
    },
    {
      label: "check lease token",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.teeSearch.checkLeaseToken = "other-lease";
      }
    },
    {
      label: "check lease expiry",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.teeSearch.checkLeaseExpiresAt = new Date(
          "2026-07-13T19:59:00.000Z"
        );
      }
    },
    {
      label: "release deployment",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.batch.releaseSha = null as never;
      }
    },
    {
      label: "batch status",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.batch.status = "SUCCEEDED";
      }
    },
    {
      label: "recheck completion",
      mutate: (dispatch: ReturnType<typeof remediationDispatchRow>) => {
        dispatch.batch.recheckDispatchedAt = null as never;
      }
    }
  ])("rejects a mismatched remediation $label", async ({ mutate }) => {
    const dispatch = remediationDispatchRow();
    mutate(dispatch);
    prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([dispatch]);
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:20:00.000Z")
      },
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:00:00.000Z")
      }
    ]);
    const fetchImpl = vi.fn();

    const result = await prepareSearchMonitoring(
      remediationSearch(),
      fetchImpl as typeof fetch,
      now
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.attemptedCourseIds).toEqual([]);
  });

  it("fails closed when two remediation dispatch rows match", async () => {
    prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([
      remediationDispatchRow(),
      remediationDispatchRow()
    ]);
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:20:00.000Z")
      },
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:00:00.000Z")
      }
    ]);
    const fetchImpl = vi.fn();

    await prepareSearchMonitoring(
      remediationSearch(),
      fetchImpl as typeof fetch,
      now
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportBatchSearch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 })
    );
  });

  it("rejects schedule version vN+2 before querying remediation state", async () => {
    const fetchImpl = vi.fn();
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:20:00.000Z")
      },
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:00:00.000Z")
      }
    ]);

    await prepareSearchMonitoring(
      remediationSearch(["remediated-course"], { scheduleVersion: 9 }),
      fetchImpl as typeof fetch,
      now
    );

    expect(prismaMocks.courseSupportBatchSearch.findMany).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an expired loaded check lease before querying remediation state", async () => {
    const fetchImpl = vi.fn();
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:20:00.000Z")
      },
      {
        courseId: "remediated-course",
        status: "FAILED",
        createdAt: new Date("2026-07-13T19:00:00.000Z")
      }
    ]);

    await prepareSearchMonitoring(
      remediationSearch(["remediated-course"], {
        checkLeaseExpiresAt: new Date("2026-07-13T19:59:00.000Z")
      }),
      fetchImpl as typeof fetch,
      now
    );

    expect(prismaMocks.courseSupportBatchSearch.findMany).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("applies capped replay evidence without spending the remediation override", async () => {
    const sourceUrl = "http://www.knightsplay.com";
    const finalUrl = "https://www.knightsplay.com/";
    const ratesUrl = "https://www.knightsplay.com/rates";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "knights-play",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl,
          observedUrls: [sourceUrl, finalUrl, "https://static.wixstatic.com/media/logo.png"],
          visibleText:
            "Knights Play Golf Center does not offer online booking. General course information."
        }
      },
      {
        courseId: "knights-play",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: ratesUrl,
          observedUrls: [sourceUrl, finalUrl, ratesUrl],
          visibleText:
            "Knights Play Golf Center is a 27-hole public golf course. Please call 919-303-4653 to reserve your tee time. Tee times are taken one week in advance."
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      ...remediationSearch(["knights-play"]),
      preferences: [{
        rank: 1,
        course: {
          id: "knights-play",
          name: "Knights Play Golf Center",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMethod: "UNKNOWN",
          bookingMetadata: null,
          updatedAt: new Date("2026-07-13T19:50:00.000Z")
        }
      }]
    } as never;

    const dispatch = remediationDispatchRow(["knights-play"]);
    dispatch.batch.recheckDispatchStartedAt = new Date(
      "2026-07-13T19:50:00.000Z"
    );
    dispatch.batch.recheckDispatchedAt = new Date(
      "2026-07-13T19:51:00.000Z"
    );
    prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([dispatch]);

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(providerLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledOnce();
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "knights-play",
        status: "VERIFIED",
        sourceUrl: ratesUrl,
        bookingMethod: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        evidence: expect.objectContaining({
          learnedFrom: "official-phone-reservation-contact"
        })
      })
    );
    expect(dbMocks.applyBrowserDiscoveryToCourse).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "knights-play",
        status: "VERIFIED",
        bookingMethod: "CONTACT_COURSE"
      }),
      {
        updatedAt: new Date("2026-07-13T19:50:00.000Z"),
        detectedBookingUrl: null,
        bookingMethod: "UNKNOWN",
        automationEligibility: "UNKNOWN"
      }
    );
    expect(result).toEqual({
      attemptedCourseIds: [],
      appliedCourseIds: ["knights-play"],
      failedCourseIds: [],
      deferredCourseIds: [],
      retryCourseIds: []
    });
  });

  it("does not replay a manual classification rejected for unsafe URL evidence", async () => {
    const sourceUrl = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "rejected-manual-replay",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Example Valley Golf Course. Please call 919-303-4653 to reserve your tee time.",
          learnedFrom: "official-phone-reservation-rejected:unsafe-url-evidence"
        }
      },
      {
        courseId: "rejected-manual-replay",
        status: "FAILED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: { observedUrls: [sourceUrl] }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "rejected-manual-replay",
          name: "Example Valley Golf Course",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMethod: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(result.appliedCourseIds).toEqual([]);
  });

  it("does not record a replayed classification when the guarded apply loses", async () => {
    const sourceUrl = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "apply-race",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText: "Example Valley Golf Course"
        }
      },
      {
        courseId: "apply-race",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Example Valley Golf Course. Please call 919-303-4653 to reserve your tee time."
        }
      }
    ]);
    dbMocks.applyBrowserDiscoveryToCourse.mockResolvedValue(null);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "apply-race",
          name: "Example Valley Golf Course",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).toHaveBeenCalledOnce();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(result.appliedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("does not replay a sibling course's walk-in policy onto the selected course", async () => {
    const sourceUrl = "https://parks.example/golf/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "target-walk-in-replay",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText: "Target Municipal Golf Course offers public play."
        }
      },
      {
        courseId: "target-walk-in-replay",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Target Municipal Golf Course offers public play. Tee times are not required at Sibling Hills Golf Course, where golf is first come, first served."
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "target-walk-in-replay",
          name: "Target Municipal Golf Course",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMethod: "UNKNOWN",
          bookingMetadata: null,
          updatedAt: new Date("2026-07-13T19:50:00.000Z")
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(result.appliedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("does not replay older manual evidence over a current custom online booking URL", async () => {
    const website = "https://course.example/";
    const bookingUrl = "https://course.example/tee-times";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "current-online-course",
        status: "INSPECTED",
        sourceUrl: website,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: website,
          observedUrls: [website],
          visibleText:
            "Current Online Golf Course is an 18-hole public golf course. Please call 919-303-4653 to reserve your tee time."
        }
      },
      {
        courseId: "current-online-course",
        status: "INSPECTED",
        sourceUrl: website,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: website,
          observedUrls: [website],
          visibleText: "Current Online Golf Course"
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "current-online-course",
          name: "Current Online Golf Course",
          website,
          detectedBookingUrl: bookingUrl,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: null,
          updatedAt: new Date("2026-07-13T19:50:00.000Z")
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(result.appliedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("requires a current custom booking URL to be represented by replay evidence", async () => {
    const website = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "changed-booking-url",
        status: "INSPECTED",
        sourceUrl: website,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: website,
          observedUrls: [website],
          visibleText:
            "Changed Booking Golf Course is an 18-hole public golf course. Please call 919-303-4653 to reserve your tee time."
        }
      },
      {
        courseId: "changed-booking-url",
        status: "INSPECTED",
        sourceUrl: website,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: website,
          observedUrls: [website],
          visibleText: "Changed Booking Golf Course"
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "changed-booking-url",
          name: "Changed Booking Golf Course",
          website,
          detectedBookingUrl: "https://course.example/reserve",
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMethod: "UNKNOWN",
          bookingMetadata: null,
          updatedAt: new Date("2026-07-13T19:50:00.000Z")
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(result.appliedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("uses deterministic input order for equal-time online and manual evidence", async () => {
    const sourceUrl = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "provider-contradiction",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl, "https://course.example/go/42"],
          visibleText: "Example Golf Course. Book tee times online."
        }
      },
      {
        courseId: "provider-contradiction",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Example Golf Course is an 18-hole public golf course. Please call 919-303-4653 to reserve your tee time."
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "provider-contradiction",
          name: "Example Golf Course",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(result.appliedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("does not trust a legacy bare booking-call boolean as tee-time proof", async () => {
    const sourceUrl = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "bare-booking-boolean",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl, "https://course.example/go/42"],
          visibleText: "Example Night Golf Center",
          bookingCallToAction: true
        }
      },
      {
        courseId: "bare-booking-boolean",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Example Night Golf Center. Please call 919-303-4653 to reserve your tee time."
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "bare-booking-boolean",
          name: "Example Night Golf Center",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).toHaveBeenCalledOnce();
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledOnce();
    expect(result.appliedCourseIds).toEqual(["bare-booking-boolean"]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("does not treat unrelated reservation URLs as replay contradictions", async () => {
    const sourceUrl = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "unrelated-replay-url",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl, "https://course.example/restaurant/reservations"],
          visibleText: "Example Valley Golf Course. Restaurant reservations."
        }
      },
      {
        courseId: "unrelated-replay-url",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Example Valley Golf Course is an 18-hole public golf course. Please call 919-303-4653 to reserve your tee time."
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "unrelated-replay-url",
          name: "Example Valley Golf Course",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).toHaveBeenCalledOnce();
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledOnce();
    expect(result.appliedCourseIds).toEqual(["unrelated-replay-url"]);
  });

  it.each([
    "Book your tee time now",
    "Book your tee-time now",
    "Book your tee‑time now",
    "Book your tee–time now",
    "Reserve Your Tee Time",
    "Schedule Tee Times",
    "View Tee Times",
    "Find Tee Times",
    "See Tee Times",
    "Search Tee Times",
    "Make a Tee Time",
    "Online Tee Times",
    "Book tee times online or call the pro shop",
    "Tee times are available online and by phone"
  ])(
    "keeps legacy visible %s evidence from exposing an older manual classification",
    async (bookingAction) => {
    const sourceUrl = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "visible-cta-contradiction",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl, "https://course.example/go/42"],
          visibleText: `Example Night Golf Center. ${bookingAction}.`
        }
      },
      {
        courseId: "visible-cta-contradiction",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Example Night Golf Center. Please call 919-303-4653 to reserve your tee time."
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "visible-cta-contradiction",
          name: "Example Night Golf Center",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(result.appliedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual([]);
    }
  );

  it.each([
    "Book Now",
    "Reservations",
    "Check Availability",
    "Find a Time",
    "Manage Reservations",
    "Schedule Your Reservation",
    "Golf Reservations",
    "Upcoming Reservations",
    "My Reservations",
    "Manage All Reservations",
    "Your Reservations",
    "Existing Reservations",
    "Manage Existing Reservations",
    "Change Reservations",
    "Tee Time Reservations",
    "Current Tee Times",
    "Available Tee Times",
    "Public Tee Times",
    "Tee Time Booking",
    "Today's Tee Times",
    "Tomorrow's Tee Times",
    "Weekend Tee Times",
    "Evening Tee Times",
    "Daily Tee Times",
    "Member Tee Times",
    "Customer Tee Times",
    "User Tee Times",
    "Book a tee time by calling the pro shop at 919-555-0142",
    "Reserve tee times by calling 919-555-0142"
  ])(
    "does not let ambiguous legacy %s copy hide trusted manual evidence",
    async (bookingAction) => {
      const sourceUrl = "https://course.example/";
      dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
        {
          courseId: "ambiguous-visible-copy",
          status: "INSPECTED",
          sourceUrl,
          createdAt: new Date("2026-07-13T19:45:00.000Z"),
          evidence: {
            finalUrl: sourceUrl,
            observedUrls: [sourceUrl, "https://course.example/go/42"],
            visibleText: `Example Night Golf Center. ${bookingAction}.`
          }
        },
        {
          courseId: "ambiguous-visible-copy",
          status: "INSPECTED",
          sourceUrl,
          createdAt: new Date("2026-07-13T19:00:00.000Z"),
          evidence: {
            finalUrl: sourceUrl,
            observedUrls: [sourceUrl],
            visibleText:
              "Example Night Golf Center. Please call 919-303-4653 to reserve your tee time."
          }
        }
      ]);
      const fetchImpl = vi.fn();
      const search = {
        preferences: [{
          rank: 1,
          course: {
            id: "ambiguous-visible-copy",
            name: "Example Night Golf Center",
            website: sourceUrl,
            detectedBookingUrl: null,
            detectedPlatform: "UNKNOWN",
            automationEligibility: "UNKNOWN",
            bookingMetadata: null
          }
        }]
      } as never;

      const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(dbMocks.applyBrowserDiscoveryToCourse).toHaveBeenCalledOnce();
      expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledOnce();
      expect(result.appliedCourseIds).toEqual(["ambiguous-visible-copy"]);
      expect(result.retryCourseIds).toEqual([]);
    }
  );

  it("does not let malformed newer evidence expose an older manual classification", async () => {
    const sourceUrl = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "inspected-only",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: sourceUrl,
          visibleText: "Malformed persisted evidence"
        }
      },
      {
        courseId: "inspected-only",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Example Golf Course. Please call 919-303-4653 to reserve your tee time."
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "inspected-only",
          name: "Example Golf Course",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(result.appliedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("does not let newer session-bearing evidence expose an older manual classification", async () => {
    const sourceUrl = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "session-evidence",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:45:00.000Z"),
        evidence: {
          finalUrl: "https://course.example/session/private",
          observedUrls: ["https://course.example/session/private"],
          visibleText:
            "Example Valley Golf Course. Please call 919-303-4653 to reserve your tee time."
        }
      },
      {
        courseId: "session-evidence",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Example Valley Golf Course. Please call 919-303-4653 to reserve your tee time."
        }
      }
    ]);
    const fetchImpl = vi.fn();
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "session-evidence",
          name: "Example Valley Golf Course",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    const result = await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(result.appliedCourseIds).toEqual([]);
    expect(result.retryCourseIds).toEqual([]);
  });

  it("does not treat evidence at the twenty-four-hour boundary as current", async () => {
    const sourceUrl = "https://course.example/";
    dbMocks.listRecentCourseAutomationDiscoveries.mockResolvedValue([
      {
        courseId: "stale-evidence",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-13T19:00:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText: "Example Golf Course"
        }
      },
      {
        courseId: "stale-evidence",
        status: "INSPECTED",
        sourceUrl,
        createdAt: new Date("2026-07-12T20:00:00.000Z"),
        evidence: {
          finalUrl: sourceUrl,
          observedUrls: [sourceUrl],
          visibleText:
            "Example Golf Course is an 18-hole public golf course. Please call 919-303-4653 to reserve your tee time."
        }
      }
    ]);
    dbMocks.applyBrowserDiscoveryToCourse.mockResolvedValue(null);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html><body>Example Golf Course</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    );
    const search = {
      preferences: [{
        rank: 1,
        course: {
          id: "stale-evidence",
          name: "Example Golf Course",
          website: sourceUrl,
          detectedBookingUrl: null,
          detectedPlatform: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          bookingMetadata: null
        }
      }]
    } as never;

    await prepareSearchMonitoring(search, fetchImpl as typeof fetch, now);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledOnce();
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "INSPECTED" })
    );
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

  it("deduplicates a UTM-tagged self link and follows the matching course tee-time page", async () => {
    const sourceUrl =
      "https://www.playdcgolf.example/rock-creek-park-golf-course/?utm_source=extnet&utm_medium=yext";
    const canonicalUrl =
      "https://www.playdcgolf.example/rock-creek-park-golf-course/";
    const bookingIndexUrl = "https://www.playdcgolf.example/book-online/";
    const targetTeeTimesUrl =
      "https://www.playdcgolf.example/rock-creek-tee-times/";
    const publicBookingUrl =
      "https://play-dc-golf-public.book.teeitup.com/?course=24680";
    const siblingPublicBookingUrl =
      "https://sibling-public.book.teeitup.com/?course=13579";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      switch (url.toString()) {
        case sourceUrl:
          return new Response(
            `<html><a href="${canonicalUrl}">Rock Creek Park Golf</a><a href="${bookingIndexUrl}">Book Tee Times</a></html>`,
            { status: 200, headers: { "content-type": "text/html" } }
          );
        case bookingIndexUrl:
          return new Response(
            `<html><a href="/east-potomac-tee-times/">East Potomac Golf Links Tee Times</a><a href="${siblingPublicBookingUrl}">General Public</a><a href="/rock-creek-tee-times/">Rock Creek Park Golf Tee Times</a><a href="/langston-tee-times/">Langston Golf Course Tee Times</a></html>`,
            { status: 200, headers: { "content-type": "text/html" } }
          );
        case targetTeeTimesUrl:
          return new Response(
            `<html><a href="${publicBookingUrl}">General Public</a></html>`,
            { status: 200, headers: { "content-type": "text/html" } }
          );
        default:
          throw new Error(`Unexpected URL ${url.toString()}`);
      }
    });

    const evidence = await collectOfficialSiteEvidence(
      sourceUrl,
      fetchImpl as typeof fetch,
      "Rock Creek Park Golf"
    );

    expect(fetchImpl.mock.calls.map(([url]) => url.toString())).toEqual([
      sourceUrl,
      bookingIndexUrl,
      targetTeeTimesUrl
    ]);
    expect(evidence.linkCandidates).toContainEqual({
      url: publicBookingUrl,
      label: "General Public"
    });
    expect(evidence.linkCandidates).toContainEqual({
      url: siblingPublicBookingUrl,
      label: "General Public"
    });
    expect(evidence.officialPage).toEqual({
      url: targetTeeTimesUrl,
      linkCandidates: [{ url: publicBookingUrl, label: "General Public" }],
      courseName: "Rock Creek Park Golf"
    });

    const discovery = buildBrowserDiscovery({
      ...evidence,
      courseId: "rock-creek",
      courseName: "Rock Creek Park Golf"
    });
    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingUrl: publicBookingUrl,
      apiMetadata: {
        aliases: ["play-dc-golf-public"],
        bookingBaseUrl: publicBookingUrl,
        facilityIds: [24680]
      }
    });
  });

  it("does not bless sibling inventory when a target detail URL redirects to a generic index", async () => {
    const sourceUrl =
      "https://redirect.playdcgolf.example/rock-creek-park-golf-course/";
    const bookingIndexUrl =
      "https://redirect.playdcgolf.example/book-online/";
    const targetTeeTimesUrl =
      "https://redirect.playdcgolf.example/rock-creek-tee-times/";
    const redirectedIndexUrl =
      "https://redirect.playdcgolf.example/book-online/?view=shared";
    const siblingPublicBookingUrl =
      "https://sibling-public.book.teeitup.com/?course=13579";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      switch (url.toString()) {
        case sourceUrl:
          return new Response(
            `<html><a href="${bookingIndexUrl}">Book Tee Times</a></html>`,
            { status: 200, headers: { "content-type": "text/html" } }
          );
        case bookingIndexUrl:
          return new Response(
            `<html><a href="${targetTeeTimesUrl}">Rock Creek Park Golf Tee Times</a></html>`,
            { status: 200, headers: { "content-type": "text/html" } }
          );
        case targetTeeTimesUrl:
          return new Response(null, {
            status: 302,
            headers: { location: redirectedIndexUrl }
          });
        case redirectedIndexUrl:
          return new Response(
            `<html><a href="${siblingPublicBookingUrl}">General Public</a></html>`,
            { status: 200, headers: { "content-type": "text/html" } }
          );
        default:
          throw new Error(`Unexpected URL ${url.toString()}`);
      }
    });

    const evidence = await collectOfficialSiteEvidence(
      sourceUrl,
      fetchImpl as typeof fetch,
      "Rock Creek Park Golf"
    );

    expect(fetchImpl.mock.calls.map(([url]) => url.toString())).toEqual([
      sourceUrl,
      bookingIndexUrl,
      targetTeeTimesUrl,
      redirectedIndexUrl
    ]);
    expect(evidence.officialPage).toEqual({
      url: sourceUrl,
      linkCandidates: [{ url: bookingIndexUrl, label: "Book Tee Times" }],
      courseName: "Rock Creek Park Golf"
    });

    const discovery = buildBrowserDiscovery({
      ...evidence,
      courseId: "rock-creek",
      courseName: "Rock Creek Park Golf"
    });
    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.bookingUrl).not.toBe(siblingPublicBookingUrl);
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

  it.each([
    { address: "127.0.0.1", family: 4 as const },
    { address: "10.20.30.40", family: 4 as const },
    { address: "169.254.169.254", family: 4 as const },
    { address: "::1", family: 6 as const },
    { address: "::ffff:127.0.0.1", family: 6 as const },
    { address: "64:ff9b::a9fe:a9fe", family: 6 as const },
    { address: "fd00::1", family: 6 as const },
    { address: "fe80::1", family: 6 as const },
    { address: "ff02::1", family: 6 as const }
  ])("rejects a DNS alias resolving to non-public $address", async (target) => {
    const requestPinned = vi.fn();
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses: vi.fn().mockResolvedValue([target]),
      requestPinned
    });

    await expect(pinnedFetch("https://public-name.example/")).rejects.toThrow(
      "non-public network address"
    );
    expect(requestPinned).not.toHaveBeenCalled();
  });

  it("stops waiting for DNS resolution when the request signal aborts", async () => {
    const controller = new AbortController();
    const resolveAddresses = vi.fn(
      () => new Promise<Array<{ address: string; family: 4 | 6 }>>(() => undefined)
    );
    const requestPinned = vi.fn();
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses,
      requestPinned
    });
    const pending = pinnedFetch("https://slow-dns.example/", {
      signal: controller.signal
    });

    controller.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(resolveAddresses).toHaveBeenCalledOnce();
    expect(requestPinned).not.toHaveBeenCalled();
  });

  it("applies a default deadline to a stalled pinned request without a caller signal", async () => {
    const requestPinned = vi.fn(
      () => new Promise<Response>(() => undefined)
    );
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses: vi.fn().mockResolvedValue([
        { address: "8.8.8.8", family: 4 }
      ]),
      requestPinned,
      timeoutMs: 20
    });

    await expect(
      pinnedFetch("https://stalled-public-course.example/")
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requestPinned).toHaveBeenCalledOnce();
  });

  it("rejects mixed public and private DNS answers", async () => {
    const requestPinned = vi.fn();
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses: vi.fn().mockResolvedValue([
        { address: "8.8.8.8", family: 4 },
        { address: "192.168.1.5", family: 4 }
      ]),
      requestPinned
    });

    await expect(pinnedFetch("https://mixed-answer.example/")).rejects.toThrow(
      "non-public network address"
    );
    expect(requestPinned).not.toHaveBeenCalled();
  });

  it("requests the original host with a validated pinned public address", async () => {
    const requestPinned = vi.fn().mockResolvedValue(
      new Response("<html>Public course</html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    );
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses: vi.fn().mockResolvedValue([
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "8.8.8.8", family: 4 }
      ]),
      requestPinned
    });

    const response = await pinnedFetch("https://public-course.example/rates");

    expect(response.status).toBe(200);
    expect(requestPinned).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.objectContaining({
          hostname: "public-course.example",
          pathname: "/rates"
        }),
        address: "8.8.8.8",
        family: 4,
        method: "GET"
      })
    );
  });

  it("drops caller-supplied Host before the pinned Node request", async () => {
    let requestHeaders: Record<string, string> | undefined;
    const requestNode = vi.fn((_url, options, callback) => {
      requestHeaders = options.headers as Record<string, string>;
      const incoming = Object.assign(new EventEmitter(), {
        headers: {},
        statusCode: 204,
        statusMessage: "No Content",
        destroy: vi.fn()
      });
      const client = Object.assign(new EventEmitter(), {
        end: () => queueMicrotask(() => {
          callback(incoming as never);
          queueMicrotask(() => incoming.emit("end"));
        })
      });
      return client as never;
    });
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses: vi.fn().mockResolvedValue([
        { address: "8.8.8.8", family: 4 }
      ]),
      requestNode
    });

    await expect(
      pinnedFetch("https://public-course.example/rates", {
        headers: { Host: "internal.example" }
      })
    ).resolves.toMatchObject({ status: 204 });
    expect(requestHeaders).not.toHaveProperty("host");
    expect(requestHeaders).not.toHaveProperty("Host");
  });

  it("rejects and closes an attempted protocol upgrade", async () => {
    const destroy = vi.fn();
    const requestNode = vi.fn(() => {
      const client = Object.assign(new EventEmitter(), {
        end: () => queueMicrotask(() => {
          client.emit("upgrade", {}, { destroy }, Buffer.alloc(0));
        })
      });
      return client as never;
    });
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses: vi.fn().mockResolvedValue([
        { address: "8.8.8.8", family: 4 }
      ]),
      requestNode
    });

    await expect(
      pinnedFetch("https://public-course.example/upgrade")
    ).rejects.toThrow("unsupported protocol upgrade");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects an invalid remote status without throwing outside the request promise", async () => {
    const requestNode = vi.fn((_url, _options, callback) => {
      const incoming = Object.assign(new EventEmitter(), {
        headers: {},
        statusCode: 700,
        statusMessage: "Invalid",
        destroy: vi.fn()
      });
      const client = Object.assign(new EventEmitter(), {
        end: () => queueMicrotask(() => {
          callback(incoming as never);
          queueMicrotask(() => incoming.emit("end"));
        })
      });
      return client as never;
    });
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses: vi.fn().mockResolvedValue([
        { address: "8.8.8.8", family: 4 }
      ]),
      requestNode
    });

    await expect(
      pinnedFetch("https://public-course.example/status")
    ).rejects.toThrow("invalid HTTP status");
  });

  it("re-resolves a manual redirect and blocks a private destination before request", async () => {
    const resolveAddresses = vi.fn().mockImplementation(async (hostname: string) =>
      hostname === "public-course.example"
        ? [{ address: "8.8.8.8", family: 4 as const }]
        : [{ address: "127.0.0.1", family: 4 as const }]
    );
    const requestPinned = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://private-alias.example/admin" }
      })
    );
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses,
      requestPinned
    });

    await expect(
      collectOfficialSiteEvidence("https://public-course.example/", pinnedFetch)
    ).rejects.toThrow("non-public network address");
    expect(resolveAddresses).toHaveBeenCalledTimes(2);
    expect(requestPinned).toHaveBeenCalledTimes(1);
  });

  it("re-resolves followed redirects and blocks a private destination", async () => {
    const resolveAddresses = vi.fn().mockImplementation(async (hostname: string) =>
      hostname === "public-course.example"
        ? [{ address: "8.8.8.8", family: 4 as const }]
        : [{ address: "fd00::1", family: 6 as const }]
    );
    const requestPinned = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://private-alias.example/admin" }
      })
    );
    const pinnedFetch = createAddressPinnedPublicFetch({
      resolveAddresses,
      requestPinned
    });

    await expect(
      pinnedFetch("https://public-course.example/", { redirect: "follow" })
    ).rejects.toThrow("non-public network address");
    expect(resolveAddresses).toHaveBeenCalledTimes(2);
    expect(requestPinned).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://localhost./rates/",
    "https://[::ffff:127.0.0.1]/rates/",
    "https://course.internal./rates/",
    "https://course.local./rates/",
    "https://accounts.safe-course.example/rates/",
    "https://tenant.accounts.safe-course.example/rates/",
    "https://tenant.login.safe-course.example/rates/",
    "https://tenant.auth.safe-course.example/rates/",
    "https://secure-login.safe-course.example/rates/",
    "https://portal.auth.safe-course.example/rates/",
    "https://course.queue-it.net/rates/",
    "https://challenges.cloudflare.com/turnstile/v0/",
    "https://www.google.com/recaptcha/api2/anchor",
    "https://sso.safe-course.example/",
    "https://oauth.safe-course.example/",
    "https://oauth2.safe-course.example/",
    "https://auth0.safe-course.example/",
    "https://oidc.safe-course.example/",
    "https://idp.safe-course.example/",
    "https://identity.safe-course.example/",
    "https://identity-provider.safe-course.example/",
    "https://member-login.safe-course.example/",
    "https://customer-login.safe-course.example/",
    "https://prod-login.safe-course.example/",
    "https://login-us.safe-course.example/",
    "https://auth-prod.safe-course.example/",
    "https://sso2.safe-course.example/",
    "https://myaccount.safe-course.example/",
    "https://adminlogin.safe-course.example/",
    "https://stafflogin.safe-course.example/",
    "https://login2.safe-course.example/",
    "https://waitingroom.safe-course.example/",
    "https://turnstile.safe-course.example/",
    "https://recaptcha.safe-course.example/",
    "https://mfa.safe-course.example/",
    "https://identityserver.safe-course.example/",
    "https://saml.safe-course.example/",
    "https://openid.safe-course.example/",
    "https://adfs.safe-course.example/",
    "https://authorization.safe-course.example/",
    "https://openidconnect.safe-course.example/",
    "https://samlauthnrequest.safe-course.example/",
    "https://samlacs.safe-course.example/",
    "https://queueprogress.safe-course.example/",
    "https://captchachallenge.safe-course.example/",
    "https://challengeplatform.safe-course.example/",
    "https://memberdashboard.safe-course.example/",
    "https://accountsettings.safe-course.example/",
    "https://clientlogin.safe-course.example/",
    "https://partnerlogin.safe-course.example/",
    "https://employeelogin.safe-course.example/",
    "https://regionallogin.safe-course.example/",
    "https://authservice.safe-course.example/",
    "https://accountrecovery.safe-course.example/",
    "https://forgotpassword.safe-course.example/",
    "https://passwordreset.safe-course.example/",
    "https://resetpassword.safe-course.example/",
    "https://passwordless.safe-course.example/",
    "https://emailverification.safe-course.example/",
    "https://verifyemail.safe-course.example/",
    "https://magiclink.safe-course.example/",
    "https://invite.safe-course.example/",
    "https://session.safe-course.example/",
    "https://token.safe-course.example/",
    "https://arkose.safe-course.example/",
    "https://arkoselabs.safe-course.example/",
    "https://okta.safe-course.example/",
    "https://onelogin.safe-course.example/",
    "https://cloudflareaccess.safe-course.example/",
    "https://credential.safe-course.example/",
    "https://credentials.safe-course.example/",
    "https://secret.safe-course.example/",
    "https://signature.safe-course.example/",
    "https://signed.safe-course.example/",
    "https://ticket.safe-course.example/",
    "https://assertion.safe-course.example/",
    "https://relaystate.safe-course.example/",
    "https://consent.safe-course.example/",
    "https://jsessionid.safe-course.example/",
    "https://authcode.safe-course.example/",
    "https://nonce.safe-course.example/",
    "https://jwt.safe-course.example/",
    "https://signedurl.safe-course.example/",
    "https://serviceticket.safe-course.example/",
    "https://accesstoken.safe-course.example/",
    "https://clientsecret.safe-course.example/",
    "https://apikey.safe-course.example/",
    "https://safe-course.example:80/rates/"
  ])("refuses unsafe public-looking hosts before fetch: %s", async (unsafeUrl) => {
    const fetchImpl = vi.fn();

    await expect(
      collectOfficialSiteEvidence(unsafeUrl, fetchImpl as typeof fetch)
    ).rejects.toThrow("safe public HTTP address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "https://safe-course.example/members/tee-times",
    "https://safe-course.example/member/book/tee-times",
    "https://safe-course.example/member/reserve/tee-times",
    "https://safe-course.example/members/golf/tee-times",
    "https://safe-course.example/secure/tee-times",
    "https://safe-course.example/customer/book/tee-times",
    "https://safe-course.example/user/reserve/tee-times",
    "https://safe-course.example/members/tee-times.aspx",
    "https://safe-course.example/member/book.php",
    "https://safe-course.example/secure/teetimes.html",
    "https://safe-course.example/customer/reserve.aspx",
    "https://safe-course.example/user/schedule.php",
    "https://safe-course.example/member/book.do",
    "https://safe-course.example/customer/reserve.action",
    "https://safe-course.example/user/schedule.do",
    "https://safe-course.example/members/tee-time-booking",
    "https://safe-course.example/customer/tee-time-search",
    "https://safe-course.example/user/online-tee-times",
    "https://safe-course.example/members2/tee/time",
    "https://safe-course.example/secure-v2/online/tee/times",
    "https://safe-course.example/rates?nextUrl=%2Faccount%2Flogin",
    "https://safe-course.example/rates?nextPath=%2Fcheckout%2Fstart",
    "https://safe-course.example/rates?continueUrl=%2Fqueue%2Fwait",
    "https://safe-course.example/rates?continueTo=%2Fcaptcha%2Fverify",
    "https://safe-course.example/rates?returnPath=%2Faccount%2Flogin",
    "https://safe-course.example/rates?redirectPath=%2Fcheckout%2Fstart",
    "https://safe-course.example/rates?successUrl=%2Faccount%2Fportal",
    "https://safe-course.example/rates?cancelUrl=%2Fcheckout%2Fcancel",
    "https://safe-course.example/rates?callbackTo=login",
    "https://safe-course.example/rates?destinationUrl=checkout",
    "https://safe-course.example/rates?next=ftp%3A%2F%2Fpublic.vendor.example%2Frates",
    "https://safe-course.example/callback2?code=PUBLIC",
    "https://safe-course.example/callbackv2?state=NC",
    "https://safe-course.example/ssocallback2?code=PUBLIC",
    "https://safe-course.example/rates?key=sk_test_abc123def456ghi789",
    "https://safe-course.example/rates?key=pk_live_abc123def456ghi789"
  ])("refuses sensitive public paths before fetch: %s", async (unsafeUrl) => {
    const fetchImpl = vi.fn();

    await expect(
      collectOfficialSiteEvidence(unsafeUrl, fetchImpl as typeof fetch)
    ).rejects.toThrow("safe public HTTP address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "https://safe-course.example/golf-cart-rates/",
    "https://safe-course.example/the-challenge-at-manele/",
    "https://safe-course.example/missouri-golf-courses/",
    "https://safe-course.example/cartwright-golf-course/",
    "https://safe-course.example/billings-golf-course/",
    "https://billings.example/golf/",
    "https://safe-course.example/key-west-golf-club/",
    "https://safe-course.example/keystone-golf-course/",
    "https://safe-course.example/key-largo-golf/",
    "https://keywestgolf.example/",
    "https://keystonegolf.example/",
    "https://key-largo-golf.example/",
    "https://safe-course.example/rates?state=NC",
    "https://safe-course.example/rates?code=PUBLIC",
    "https://safe-course.example/rates?key=course",
    "https://safe-course.example/rates?destination=Raleigh",
    "https://safe-course.example/rates?target=public",
    "https://safe-course.example/public/tee-times.html",
    "https://safe-course.example/public/tee-times.do",
    "https://safe-course.example/programs/493b6c83-491b-4243-b9a1-f0090f288fb2",
    "https://golfback.com/#/course/5a90fb0c-b928-43f0-9486-d5d43c03d25d",
    "https://safe-course.example/#/the-challenge-at-manele",
    "https://safe-course.example/#/author-information"
  ])("fetches legitimate public course paths at %s", async (publicUrl) => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url.toString()).toBe(publicUrl);
      return new Response("<html><body>Public golf course</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });

    await collectOfficialSiteEvidence(publicUrl, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not follow unsafe or sensitive booking links from a safe official page", async () => {
    const sourceUrl = "https://safe-course.example/";
    const blockedLinks = [
      "https://localhost./tee-times",
      "https://course.internal./tee-times",
      "https://safe-course.example/account/login",
      "https://safe-course.example/checkout/start",
      "https://safe-course.example/queue/wait",
      "https://safe-course.example/oauth/callback?ticket=private",
      "https://safe-course.example/secure-checkout/start",
      "https://safe-course.example/user-login/start",
      "https://safe-course.example/auth0/callback?auth_code=private",
      "https://safe-course.example/queueit/wait",
      "https://safe-course.example/captchaChallenge/start",
      "https://safe-course.example/magic-link/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
      "https://safe-course.example/reset-password/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
      "https://safe-course.example/invite/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
      "https://safe-course.example/go/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
      "https://safe-course.example/callback?client_id=course&response_type=code",
      "https://safe-course.example/callback?%2563ode=private",
      "https://safe-course.example/callback?%2563lient_id=course&%2572esponse_type=code",
      "https://safe-course.example/callback?oauth_verifier=private",
      "https://safe-course.example/callback?session_state=private",
      "https://safe-course.example/callback?SAMLart=private",
      "https://safe-course.example/callback?login_ticket=private",
      "https://safe-course.example/%2561ccount%252Flogin",
      "https://safe-course.example/forgot-password/start",
      "https://safe-course.example/account-recovery/start",
      "https://safe-course.example/login-callback",
      "https://safe-course.example/signin-oidc",
      "https://safe-course.example/oauth2-callback",
      "https://safe-course.example/checkout-flow/start",
      "https://safe-course.example/captcha-v2/start",
      "https://safe-course.example/queue-status",
      "https://safe-course.example/checkout-session/start",
      "https://safe-course.example/payment-confirm",
      "https://safe-course.example/account-settings",
      "https://safe-course.example/forgot-my-password",
      "https://safe-course.example/password-reset-confirm",
      "https://safe-course.example/captcha-verify",
      "https://safe-course.example/queue-redirect",
      "https://safe-course.example/challenge-response",
      "https://safe-course.example/authentication-callback",
      "https://safe-course.example/authorize-callback",
      "https://safe-course.example/saml-acs",
      "https://safe-course.example/openid-connect",
      "https://safe-course.example/login-flow",
      "https://safe-course.example/checkout-step",
      "https://safe-course.example/payment-flow",
      "https://safe-course.example/cart-checkout",
      "https://safe-course.example/queue-progress",
      "https://safe-course.example/authorizecallback",
      "https://safe-course.example/checkoutstep",
      "https://safe-course.example/checkoutstart",
      "https://safe-course.example/loginflow",
      "https://safe-course.example/queueprogress",
      "https://safe-course.example/paymentstep",
      "https://safe-course.example/samlauthnrequest",
      "https://safe-course.example/openidconnect",
      "https://safe-course.example/mfachallenge",
      "https://safe-course.example/hcaptcha/start",
      "https://safe-course.example/funcaptcha/start",
      "https://safe-course.example/member-dashboard",
      "https://safe-course.example/forgot-username",
      "https://safe-course.example/confirm-email",
      "https://safe-course.example/booking-payment",
      "https://safe-course.example/clientlogin",
      "https://safe-course.example/partnerlogin",
      "https://safe-course.example/regionallogin",
      "https://safe-course.example/authservice",
      "https://safe-course.example/authproxy",
      "https://safe-course.example/billing",
      "https://safe-course.example/billingportal",
      "https://safe-course.example/payment-method",
      "https://safe-course.example/paymentmethod",
      "https://safe-course.example/order-review",
      "https://safe-course.example/cartreview",
      "https://safe-course.example/members/booking",
      "https://safe-course.example/member/center",
      "https://safe-course.example/secure/portal",
      "https://safe-course.example/shopping/bag",
      "https://safe-course.example/place/order",
      "https://safe-course.example/complete/purchase",
      "https://safe-course.example/order/history",
      "https://safe-course.example/transaction/history",
      "https://safe-course.example/members/tee-times",
      "https://safe-course.example/member/book/tee-times",
      "https://safe-course.example/member/reserve/tee-times",
      "https://safe-course.example/members/golf/tee-times",
      "https://safe-course.example/secure/tee-times",
      "https://safe-course.example/customer/book/tee-times",
      "https://safe-course.example/user/reserve/tee-times",
      "https://safe-course.example/callback?SAMLRequest=private",
      "https://safe-course.example/callback?oauth_nonce=private",
      "https://safe-course.example/callback?oauth_callback=private",
      "https://safe-course.example/callback?openid.mode=private",
      "https://safe-course.example/callback?SigAlg=private",
      "https://safe-course.example/rates?next=https%3A%2F%2Fmember-login.vendor.example%2Fstart",
      "https://safe-course.example/rates#access_token=private",
      "https://safe-course.example/rates#oauth_nonce=private",
      "https://safe-course.example/rates?prompt=login",
      "https://safe-course.example/rates?code_challenge_method=S256",
      "https://safe-course.example/rates?response_mode=query",
      "https://safe-course.example/rates?returnUrl=%2Faccount%2Flogin",
      "https://safe-course.example/rates?next=%2Fcheckout%2Fstart",
      "https://safe-course.example/rates?redirect=%2Fcaptcha%2Fverify",
      "https://safe-course.example/rates?continue=%2Fqueue%2Fwait",
      "https://safe-course.example/rates?returnUrl=%2F%2Faccounts.vendor.example%2Flogin",
      "https://safe-course.example/rates?nextUrl=%2Faccount%2Flogin",
      "https://safe-course.example/rates?nextPath=%2Fcheckout%2Fstart",
      "https://safe-course.example/rates?continueUrl=%2Fqueue%2Fwait",
      "https://safe-course.example/rates?continueTo=%2Fcaptcha%2Fverify",
      "https://safe-course.example/rates?returnPath=%2Faccount%2Flogin",
      "https://safe-course.example/rates?redirectPath=%2Fcheckout%2Fstart",
      "https://safe-course.example/rates?successUrl=%2Faccount%2Fportal",
      "https://safe-course.example/rates?cancelUrl=%2Fcheckout%2Fcancel",
      "https://safe-course.example/rates#wresult",
      "https://safe-course.example/rates?view=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf",
      "https://safe-course.example/rates?view=AbCdEfGhIjKlMnOpQrS",
      "https://safe-course.example/rates?csrf=private",
      "https://safe-course.example/rates?xsrf=private",
      "https://safe-course.example/rates?form_key=private",
      "https://safe-course.example/rates?__RequestVerificationToken=private",
      "https://safe-course.example/rates?csrfmiddlewaretoken=private",
      "https://safe-course.example/rates?x-csrf-token=private",
      "https://safe-course.example/rates?anti_csrf_token=private",
      "https://safe-course.example/rates?verification_token=private",
      "https://safe-course.example/rates?checkout_session_id=private",
      "https://safe-course.example/rates?payment_intent=private",
      "https://safe-course.example/rates?order_id=private",
      "https://safe-course.example/rates?transaction_id=private",
      "https://safe-course.example/rates?invoice_id=private",
      "https://safe-course.example/rates?cart_id=private",
      "https://safe-course.example/rates?s=AbCdEfGhIjKlMnOpQrSt%3D%3D",
      "https://safe-course.example/rates?view=AbCdEfGhIjKlMnOp-_%3D%3D",
      "https://member-login.vendor.example/rates",
      "https://login-us.vendor.example/rates",
      "https://knights-play.book.teeitup.golf/go/01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "https://knights-play.book.teeitup.golf/go/a1b2c3d4e5f6g7h8i9j0",
      "https://knights-play.book.teeitup.golf/go/a1b2c3d4e5f6g7h8i9j",
      "https://knights-play.book.teeitup.golf/go/AbCdEfGhIjKlMnOpQrSt",
      "https://knights-play.book.teeitup.golf/go/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
      "https://example.queue-it.net/",
      "https://challenges.cloudflare.com/turnstile/v0/",
      "https://www.google.com/recaptcha/api2/anchor"
    ];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url.toString()).toBe(sourceUrl);
      return new Response(
        `<html>${blockedLinks
          .map((href) => `<a href="${href}">Book Tee Times</a>`)
          .join("")}</html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    });

    const evidence = await collectOfficialSiteEvidence(
      sourceUrl,
      fetchImpl as typeof fetch
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(evidence.linkCandidates).toEqual([]);
    for (const blockedLink of blockedLinks) {
      expect(JSON.stringify(evidence)).not.toContain(blockedLink);
    }
  });

  it.each([
    "https://localhost./tee-times",
    "https://example.queue-it.net/",
    "https://challenges.cloudflare.com/turnstile/v0/",
    "https://www.google.com/recaptcha/api2/anchor",
    "https://safe-course.example/secure-checkout/start",
    "https://safe-course.example/user-login/start",
    "https://safe-course.example/auth0/callback?auth_code=private",
    "https://safe-course.example/queueit/wait",
    "https://safe-course.example/captchaChallenge/start",
    "https://safe-course.example/magic-link/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "https://safe-course.example/reset-password/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "https://safe-course.example/callback?client_id=course&response_type=code",
    "https://safe-course.example/callback?%2563ode=private",
    "https://safe-course.example/callback?%2563lient_id=course&%2572esponse_type=code",
    "https://safe-course.example/callback?oauth_verifier=private",
    "https://safe-course.example/callback?session_state=private",
    "https://safe-course.example/callback?SAMLart=private",
    "https://safe-course.example/callback?login_ticket=private",
    "https://safe-course.example/forgot-password/start",
    "https://safe-course.example/account-recovery/start",
    "https://safe-course.example/login-callback",
    "https://safe-course.example/signin-oidc",
    "https://safe-course.example/oauth2-callback",
    "https://safe-course.example/checkout-flow/start",
    "https://safe-course.example/captcha-v2/start",
    "https://safe-course.example/queue-status",
    "https://safe-course.example/checkout-session/start",
    "https://safe-course.example/payment-confirm",
    "https://safe-course.example/account-settings",
    "https://safe-course.example/forgot-my-password",
    "https://safe-course.example/password-reset-confirm",
    "https://safe-course.example/captcha-verify",
    "https://safe-course.example/queue-redirect",
    "https://safe-course.example/challenge-response",
    "https://safe-course.example/authentication-callback",
    "https://safe-course.example/authorize-callback",
    "https://safe-course.example/saml-acs",
    "https://safe-course.example/openid-connect",
    "https://safe-course.example/login-flow",
    "https://safe-course.example/checkout-step",
    "https://safe-course.example/payment-flow",
    "https://safe-course.example/cart-checkout",
    "https://safe-course.example/queue-progress",
    "https://safe-course.example/authorizecallback",
    "https://safe-course.example/checkoutstep",
    "https://safe-course.example/checkoutstart",
    "https://safe-course.example/loginflow",
    "https://safe-course.example/queueprogress",
    "https://safe-course.example/paymentstep",
    "https://safe-course.example/samlauthnrequest",
    "https://safe-course.example/openidconnect",
    "https://safe-course.example/mfachallenge",
    "https://safe-course.example/hcaptcha/start",
    "https://safe-course.example/funcaptcha/start",
    "https://safe-course.example/member-dashboard",
    "https://safe-course.example/forgot-username",
    "https://safe-course.example/confirm-email",
    "https://safe-course.example/booking-payment",
    "https://safe-course.example/clientlogin",
    "https://safe-course.example/partnerlogin",
    "https://safe-course.example/regionallogin",
    "https://safe-course.example/authservice",
    "https://safe-course.example/authproxy",
    "https://safe-course.example/billing",
    "https://safe-course.example/billingportal",
    "https://safe-course.example/payment-method",
    "https://safe-course.example/paymentmethod",
    "https://safe-course.example/order-review",
    "https://safe-course.example/cartreview",
    "https://safe-course.example/members/booking",
    "https://safe-course.example/member/center",
    "https://safe-course.example/secure/portal",
    "https://safe-course.example/shopping/bag",
    "https://safe-course.example/place/order",
    "https://safe-course.example/complete/purchase",
    "https://safe-course.example/order/history",
    "https://safe-course.example/transaction/history",
    "https://safe-course.example/members/tee-times",
    "https://safe-course.example/member/book/tee-times",
    "https://safe-course.example/member/reserve/tee-times",
    "https://safe-course.example/members/golf/tee-times",
    "https://safe-course.example/secure/tee-times",
    "https://safe-course.example/customer/book/tee-times",
    "https://safe-course.example/user/reserve/tee-times",
    "https://safe-course.example/callback?SAMLRequest=private",
    "https://safe-course.example/callback?oauth_nonce=private",
    "https://safe-course.example/callback?oauth_callback=private",
    "https://safe-course.example/callback?openid.mode=private",
    "https://safe-course.example/callback?SigAlg=private",
    "https://safe-course.example/rates?next=https%3A%2F%2Fmember-login.vendor.example%2Fstart",
    "https://safe-course.example/rates#access_token=private",
    "https://safe-course.example/rates#oauth_nonce=private",
    "https://safe-course.example/rates?prompt=login",
    "https://safe-course.example/rates?code_challenge_method=S256",
    "https://safe-course.example/rates?response_mode=query",
    "https://safe-course.example/rates?returnUrl=%2Faccount%2Flogin",
    "https://safe-course.example/rates?next=%2Fcheckout%2Fstart",
    "https://safe-course.example/rates?redirect=%2Fcaptcha%2Fverify",
    "https://safe-course.example/rates?continue=%2Fqueue%2Fwait",
    "https://safe-course.example/rates?returnUrl=%2F%2Faccounts.vendor.example%2Flogin",
    "https://safe-course.example/rates?nextUrl=%2Faccount%2Flogin",
    "https://safe-course.example/rates?nextPath=%2Fcheckout%2Fstart",
    "https://safe-course.example/rates?continueUrl=%2Fqueue%2Fwait",
    "https://safe-course.example/rates?continueTo=%2Fcaptcha%2Fverify",
    "https://safe-course.example/rates?returnPath=%2Faccount%2Flogin",
    "https://safe-course.example/rates?redirectPath=%2Fcheckout%2Fstart",
    "https://safe-course.example/rates?successUrl=%2Faccount%2Fportal",
    "https://safe-course.example/rates?cancelUrl=%2Fcheckout%2Fcancel",
    "https://safe-course.example/rates#wresult",
    "https://safe-course.example/rates?view=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf",
    "https://safe-course.example/rates?view=AbCdEfGhIjKlMnOpQrS",
    "https://safe-course.example/rates?csrf=private",
    "https://safe-course.example/rates?xsrf=private",
    "https://safe-course.example/rates?form_key=private",
    "https://safe-course.example/rates?__RequestVerificationToken=private",
    "https://safe-course.example/rates?csrfmiddlewaretoken=private",
    "https://safe-course.example/rates?x-csrf-token=private",
    "https://safe-course.example/rates?anti_csrf_token=private",
    "https://safe-course.example/rates?verification_token=private",
    "https://safe-course.example/rates?checkout_session_id=private",
    "https://safe-course.example/rates?payment_intent=private",
    "https://safe-course.example/rates?order_id=private",
    "https://safe-course.example/rates?transaction_id=private",
    "https://safe-course.example/rates?invoice_id=private",
    "https://safe-course.example/rates?cart_id=private",
    "https://safe-course.example/rates?s=AbCdEfGhIjKlMnOpQrSt%3D%3D",
    "https://safe-course.example/rates?view=AbCdEfGhIjKlMnOp-_%3D%3D",
    "https://member-login.vendor.example/rates",
    "https://login-us.vendor.example/rates",
    "https://knights-play.book.teeitup.golf/go/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "https://knights-play.book.teeitup.golf/go/a1b2c3d4e5f6g7h8i9j0",
    "https://knights-play.book.teeitup.golf/go/a1b2c3d4e5f6g7h8i9j",
    "https://knights-play.book.teeitup.golf/go/AbCdEfGhIjKlMnOpQrSt",
    "https://knights-play.book.teeitup.golf/go/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
  ])("rejects unsafe redirect %s before making the redirected request", async (unsafeRedirect) => {
    const sourceUrl = "https://safe-course.example/";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url.toString()).toBe(sourceUrl);
      return new Response(null, {
        status: 302,
        headers: { location: unsafeRedirect }
      });
    });

    await expect(
      collectOfficialSiteEvidence(sourceUrl, fetchImpl as typeof fetch)
    ).rejects.toThrow("safe public HTTP address");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
