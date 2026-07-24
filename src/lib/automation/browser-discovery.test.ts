import { describe, expect, it, vi } from "vitest";

import {
  buildBrowserDiscovery,
  enrichBrowserDiscoveryWithProviderLease,
  enrichCpsDiscovery,
  enrichChronogolfDiscovery,
  enrichTeeItUpDiscovery,
  enrichTeesnapDiscovery,
  evaluateBrowserDiscoveryMonitoringGate,
  findCorroboratingAccessBarrier,
  haveSamePublicWebsiteOrigin,
  getBestProbeUrl,
  isLegacyTeeItUpPlayUrl,
  keepPolicyOnlyDiscoveryActionable,
  pickLikelyBookingHref,
  prioritizeBrowserDiscoveryLinks,
  sanitizeBrowserDiscoveryAccessEvidence,
  shouldQueueBrowserProbe,
  type BrowserDiscoveryEvidence
} from "./browser-discovery";

describe("booking-link selection", () => {
  it("retains late official booking links inside the bounded evidence set", () => {
    const genericLinks = Array.from({ length: 120 }, (_, index) => ({
      url: `https://course.example/page-${index}`,
      label: `Page ${index}`
    }));
    const bookingLink = {
      url: "https://provider.example/public-course/tee-times",
      label: "Book Tee Times"
    };
    expect(
      prioritizeBrowserDiscoveryLinks([...genericLinks, bookingLink], 80)
    ).toContainEqual(bookingLink);
  });

  it("keeps apex and www redirects inside the same official website", () => {
    expect(
      haveSamePublicWebsiteOrigin(
        "https://course.example/",
        "https://www.course.example/book-tee-time/"
      )
    ).toBe(true);
    expect(
      haveSamePublicWebsiteOrigin(
        "http://course.example/",
        "https://www.course.example/book-tee-time/"
      )
    ).toBe(true);
    expect(
      haveSamePublicWebsiteOrigin(
        "https://course.example/",
        "https://booking.example.net/tee-times"
      )
    ).toBe(false);
  });

  it("prefers a public external tee sheet over a same-page booking label", () => {
    expect(
      pickLikelyBookingHref(
        [
          {
            href: "https://course.example/book-tee-time/",
            text: "Book Tee Times"
          },
          {
            href: "https://troon.example/course/public/reserve-tee-time",
            text: "Please click here"
          },
          {
            href:
              "https://golfwithaccess.com/course/public-course/reserve-tee-time?filterFacilities=north-course&utm_source=official-course",
            text: "BOOK TEE TIMES"
          }
        ],
        "https://course.example/book-tee-time/"
      )
    ).toBe(
      "https://golfwithaccess.com/course/public-course/reserve-tee-time?filterFacilities=north-course&utm_source=official-course"
    );
  });

  it("does not select account, checkout, or unrelated booking links", () => {
    expect(
      pickLikelyBookingHref(
        [
          {
            href: "https://course.example/account/login",
            text: "Book Tee Times"
          },
          {
            href: "https://course.example/checkout/start",
            text: "Reserve Tee Time"
          },
          {
            href: "https://course.example/lessons/book",
            text: "Book Lessons Online"
          }
        ],
        "https://course.example/"
      )
    ).toBeNull();
  });
});

describe("browser discovery monitoring gate", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");

  it("accepts a newly verified coherent manual classification", () => {
    expect(
      evaluateBrowserDiscoveryMonitoringGate(
        {
          status: "VERIFIED",
          bookingMethod: "PHONE_ONLY",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
          confidence: 0.95
        },
        now
      )
    ).toMatchObject({ disposition: "MANUAL_FINAL", adapterAllowed: false });
  });

  it("does not promote an inspected or incoherent discovery to a final", () => {
    expect(
      evaluateBrowserDiscoveryMonitoringGate(
        {
          status: "INSPECTED",
          bookingMethod: "PHONE_ONLY",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
          confidence: 0.95
        },
        now
      )
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
    expect(
      evaluateBrowserDiscoveryMonitoringGate(
        {
          status: "VERIFIED",
          bookingMethod: "CONTACT_COURSE",
          automationEligibility: "BLOCKED",
          automationReason: "OTHER",
          intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
          confidence: 0.95
        },
        now
      )
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
    expect(
      evaluateBrowserDiscoveryMonitoringGate(
        {
          status: "VERIFIED",
          bookingMethod: "WALK_IN",
          automationEligibility: "ALLOWED",
          automationReason: "NO_ONLINE_BOOKING",
          intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
          confidence: 0.95
        },
        now
      )
    ).toMatchObject({ disposition: "ACTIONABLE", adapterAllowed: true });
  });

  it("expires a verified private identity into a fresh-evidence recheck", () => {
    expect(
      evaluateBrowserDiscoveryMonitoringGate(
        {
          status: "VERIFIED",
          isPublic: false,
          bookingMethod: "UNKNOWN",
          automationEligibility: "BLOCKED",
          automationReason: "OTHER",
          intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
          confidence: 0.98
        },
        now
      )
    ).toMatchObject({
      disposition: "IDENTITY_FINAL",
      adapterAllowed: false,
      requiresRevalidation: false,
      currentEvidence: true
    });
    expect(
      evaluateBrowserDiscoveryMonitoringGate(
        {
          status: "VERIFIED",
          isPublic: false,
          bookingMethod: "UNKNOWN",
          automationEligibility: "BLOCKED",
          automationReason: "OTHER",
          intelligenceReviewAt: new Date("2026-07-15T00:00:00.000Z"),
          confidence: 0.98
        },
        now
      )
    ).toMatchObject({
      disposition: "IDENTITY_RECHECK",
      adapterAllowed: false,
      requiresRevalidation: true,
      currentEvidence: false
    });
  });
});

describe("buildBrowserDiscovery", () => {
  it("learns reusable Golf with Access metadata from an official provider link and public API request", () => {
    const bookingUrl =
      "https://golfwithaccess.com/course/example-public-course/reserve-tee-time";
    const officialBookingLink = `${bookingUrl}?filterFacilities=north-course&filterFacilities=south-course&utm_source=official-course`;
    const apiUrl = new URL("https://golfwithaccess.com/api/v1/tee-times");
    apiUrl.searchParams.append(
      "courseIds",
      "11111111-1111-4111-8111-111111111111"
    );
    apiUrl.searchParams.append(
      "courseIds",
      "22222222-2222-4222-8222-222222222222"
    );
    apiUrl.searchParams.set("players", "2");
    apiUrl.searchParams.set("startAt", "00:00:00");
    apiUrl.searchParams.set("endAt", "23:59:59");
    apiUrl.searchParams.set("day", "2026-07-24");
    apiUrl.searchParams.set("utmCampaign", "official-booking-link");
    apiUrl.searchParams.set("utmSource", "official-course");

    const discovery = buildBrowserDiscovery({
      courseId: "golf-with-access-course",
      courseName: "Example Public Golf Club",
      sourceUrl: "https://course.example/book-tee-time/",
      finalUrl: bookingUrl,
      officialCourseWebsite: "https://course.example/",
      observedUrls: [officialBookingLink, apiUrl.toString()],
      linkCandidates: [{ url: officialBookingLink, label: "Book Tee Times" }],
      officialPage: {
        url: "https://course.example/book-tee-time/",
        courseName: "Example Public Golf Club",
        linkCandidates: [
          { url: officialBookingLink, label: "Book Tee Times" }
        ],
        visibleText: "Example Public Golf Club. Book tee times online."
      },
      visibleText:
        "Example Public Golf Club. Public signed-out tee times are available."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "CUSTOM",
      bookingUrl: officialBookingLink,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiEndpoint: "https://golfwithaccess.com/api/v1/tee-times",
      apiMetadata: {
        provider: "GOLF_WITH_ACCESS",
        courseIds: [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222"
        ],
        bookingBaseUrl: bookingUrl
      },
      evidence: {
        learnedFrom: "golf-with-access-public-availability",
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_PROVIDER_LINK"
        }
      }
    });
  });

  it.each([
    {
      label: "missing official provider link",
      mutate: (evidence: BrowserDiscoveryEvidence) => ({
        ...evidence,
        officialPage: { ...evidence.officialPage!, linkCandidates: [] }
      })
    },
    {
      label: "mismatched official course identity",
      mutate: (evidence: BrowserDiscoveryEvidence) => ({
        ...evidence,
        officialPage: {
          ...evidence.officialPage!,
          courseName: "Different Golf Club"
        }
      })
    },
    {
      label: "unsafe API query state",
      mutate: (evidence: BrowserDiscoveryEvidence) => ({
        ...evidence,
        observedUrls: evidence.observedUrls.map((url) =>
          url.includes("/api/v1/tee-times") ? `${url}&token=private` : url
        )
      })
    }
  ])("fails closed for $label", ({ mutate }) => {
    const bookingUrl =
      "https://golfwithaccess.com/course/example-public-course/reserve-tee-time";
    const apiUrl =
      "https://golfwithaccess.com/api/v1/tee-times?courseIds=11111111-1111-4111-8111-111111111111&players=2&startAt=00%3A00%3A00&endAt=23%3A59%3A59&day=2026-07-24";
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "golf-with-access-negative",
      courseName: "Example Public Golf Club",
      sourceUrl: "https://course.example/book-tee-time/",
      finalUrl: bookingUrl,
      officialCourseWebsite: "https://course.example/",
      observedUrls: [bookingUrl, apiUrl],
      linkCandidates: [{ url: bookingUrl, label: "Book Tee Times" }],
      officialPage: {
        url: "https://course.example/book-tee-time/",
        courseName: "Example Public Golf Club",
        linkCandidates: [{ url: bookingUrl, label: "Book Tee Times" }],
        visibleText: "Example Public Golf Club. Book tee times online."
      },
      visibleText: "Example Public Golf Club."
    };

    const discovery = buildBrowserDiscovery(mutate(evidence));
    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("classifies a confirmed initial-page soft 404 without retaining polluted links", () => {
    const before = Date.now();
    const discovery = buildBrowserDiscovery({
      courseId: "eastwood",
      courseName: "Eastwood Country Club",
      sourceUrl: "https://eastwood.example/?campaign=stale#top",
      finalUrl: "https://www.eastwood.example/",
      sourcePageAvailability: "SOFT_NOT_FOUND",
      observedUrls: [
        "https://www.eastwood.example/",
        "https://unrelated.example/book-tee-times"
      ],
      linkCandidates: [
        {
          url: "https://unrelated.example/book-tee-times",
          label: "Book tee times"
        }
      ],
      visibleText: "Page Not Found unrelated promotional copy"
    });
    const after = Date.now();

    expect(discovery).toMatchObject({
      courseId: "eastwood",
      status: "INSPECTED",
      detectedPlatform: "UNKNOWN",
      sourceUrl: "https://eastwood.example/",
      bookingMethod: "UNKNOWN",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "TEMPORARILY_UNAVAILABLE",
      confidence: 0.98,
      evidence: {
        finalUrl: "https://www.eastwood.example/",
        observedUrls: [
          "https://eastwood.example/",
          "https://www.eastwood.example/"
        ],
        learnedFrom: "official-site-soft-not-found"
      }
    });
    expect(discovery).not.toHaveProperty("bookingUrl");
    expect(JSON.stringify(discovery)).not.toContain("unrelated.example");
    const reviewAt = new Date(discovery.intelligenceReviewAt!).getTime();
    expect(reviewAt).toBeGreaterThanOrEqual(
      before + 7 * 24 * 60 * 60 * 1000
    );
    expect(reviewAt).toBeLessThanOrEqual(
      after + 7 * 24 * 60 * 60 * 1000
    );
    expect(evaluateBrowserDiscoveryMonitoringGate(discovery)).toMatchObject({
      disposition: "ACTIONABLE",
      adapterAllowed: true
    });
    expect(shouldQueueBrowserProbe({
      isPublic: true,
      detectedPlatform: discovery.detectedPlatform,
      providerFamilyKey: "eastwood.example",
      automationEligibility: discovery.automationEligibility!,
      automationReason: discovery.automationReason,
      bookingMethod: discovery.bookingMethod,
      intelligenceVerifiedAt: new Date(),
      intelligenceReviewAt: discovery.intelligenceReviewAt,
      intelligenceConfidence: discovery.confidence,
      website: discovery.sourceUrl,
      detectedBookingUrl: null,
      bookingMetadata: null
    })).toBe(true);
  });

  it("learns reusable ForeUP metadata from browser-observed API requests", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "Oak Hills Park Golf Course",
      sourceUrl: "https://www.oakhillsgc.com/tee-times",
      officialCourseWebsite: "https://www.oakhillsgc.com/",
      officialPage: {
        url: "https://www.oakhillsgc.com/tee-times",
        courseName: "Oak Hills Park Golf Course",
        linkCandidates: [
          {
            url: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
            label: "Book tee times"
          }
        ],
        observedUrls: [
          "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
          "https://foreupsoftware.com/index.php/api/booking/times?time=all&date=07-10-2026&holes=all&players=3&schedule_id=11739&booking_class=22739"
        ]
      },
      finalUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      observedUrls: [
        "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
        "https://foreupsoftware.com/index.php/api/booking/times?time=all&date=07-10-2026&holes=all&players=3&schedule_id=11739&booking_class=22739"
      ],
      visibleText: "Oak Hills Park Golf Course 3:30 PM 3 spots"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("LEARNED");
    expect(discovery.detectedPlatform).toBe("FOREUP");
    expect(discovery.bookingUrl).toBe(
      "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
    );
    expect(discovery.apiEndpoint).toBe(
      "https://foreupsoftware.com/index.php/api/booking/times"
    );
    expect(discovery.apiMetadata).toEqual({
      scheduleId: 11739,
      bookingClassId: 22739,
      bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
    });
    expect(discovery.evidence.courseIdentityCorroboration).toEqual({
      kind: "OFFICIAL_COURSE_PROVIDER_LINK",
      courseName: "Oak Hills Park Golf Course",
      officialWebsiteUrl: "https://www.oakhillsgc.com/",
      officialPageUrl: "https://www.oakhillsgc.com/tee-times",
      providerUrl:
        "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
    });
  });

  it("does not infer a ForeUP booking class from route segments without an observed API request", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "Longshore Golf Course",
      sourceUrl: "https://www.longshoregolfcourse.com/tee-times",
      finalUrl: "https://foreupsoftware.com/index.php/booking/23148/12897#/teetimes",
      observedUrls: ["https://foreupsoftware.com/index.php/booking/23148/12897#/teetimes"],
      visibleText: "Booking as Guests (Public)"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("LEARNED");
    expect(discovery.apiMetadata).toEqual({
      scheduleId: 12897,
      bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/23148/12897#/teetimes"
    });
    expect(discovery.evidence.courseIdentityCorroboration).toBeUndefined();
  });

  it("does not let a provider page self-attest cross-provider course identity", () => {
    const providerUrl =
      "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes";
    const discovery = buildBrowserDiscovery({
      courseId: "course-1",
      courseName: "Oak Hills Park Golf Course",
      sourceUrl: providerUrl,
      officialCourseWebsite: "https://www.oakhillsgc.com/",
      officialPage: {
        url: providerUrl,
        linkCandidates: [{ url: providerUrl, label: "Oak Hills Park Golf Course" }]
      },
      finalUrl: providerUrl,
      observedUrls: [providerUrl],
      visibleText: "Oak Hills Park Golf Course"
    });

    expect(discovery.evidence.courseIdentityCorroboration).toBeUndefined();
  });

  it("records useful website evidence even when no reusable adapter is learned", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "Longshore Golf Course",
      sourceUrl: "https://longshoregolfcourse.com",
      finalUrl: "https://longshoregolfcourse.com/tee-times",
      observedUrls: ["https://longshoregolfcourse.com/tee-times"],
      visibleText: "Call the pro shop for tee times"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("UNKNOWN");
    expect(discovery.bookingUrl).toBe("https://longshoregolfcourse.com/tee-times");
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("fails closed for multiple newly discovered unscoped TeeItUp booking links", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "Fairchild Wheeler Golf Course",
      sourceUrl: "https://www.fairchildwheelergolf.com/teetimes/",
      finalUrl: "https://www.fairchildwheelergolf.com/teetimes/",
      observedUrls: [
        "https://fairchild-wheeler-red-course.book.teeitup.golf/",
        "https://fairchild-wheeler-golf-course-black-course.book.teeitup.golf/"
      ],
      linkCandidates: [
        {
          url: "https://fairchild-wheeler-red-course.book.teeitup.golf/",
          label: "Red Course Tee Times"
        },
        {
          url: "https://fairchild-wheeler-golf-course-black-course.book.teeitup.golf/",
          label: "Black Course Tee Times"
        }
      ],
      officialPage: {
        url: "https://www.fairchildwheelergolf.com/teetimes/",
        courseName: "Fairchild Wheeler Golf Course",
        linkCandidates: [
          {
            url: "https://fairchild-wheeler-red-course.book.teeitup.golf/",
            label: "Red Course Tee Times"
          },
          {
            url: "https://fairchild-wheeler-golf-course-black-course.book.teeitup.golf/",
            label: "Black Course Tee Times"
          }
        ]
      },
      visibleText: "Red Course Black Course"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.bookingUrl).toBe(
      "https://www.fairchildwheelergolf.com/teetimes/"
    );
    expect(discovery.apiEndpoint).toBeUndefined();
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe(
      "teeitup-target-scope-ambiguous"
    );
  });

  it("learns TeeItUp metadata from legacy .com booking links", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-richter",
      courseName: "Richter Park Golf Course",
      sourceUrl: "https://www.richterpark.com/request_tt/",
      finalUrl: "https://www.richterpark.com/request_tt/",
      observedUrls: ["https://richter-park-golf-course.book.teeitup.com/"],
      officialPage: {
        url: "https://www.richterpark.com/request_tt/",
        courseName: "Richter Park Golf Course",
        linkCandidates: [
          {
            url: "https://richter-park-golf-course.book.teeitup.com/",
            label: "Book a tee time online"
          }
        ]
      },
      visibleText: "Book a tee time online"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("LEARNED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.bookingUrl).toBe(
      "https://richter-park-golf-course.book.teeitup.com/"
    );
    expect(discovery.apiMetadata).toEqual({
      aliases: ["richter-park-golf-course"],
      bookingBaseUrl: "https://richter-park-golf-course.book.teeitup.com/"
    });
  });

  it("learns course-scoped TeeItUp metadata from a legacy play embed", () => {
    const alias = "11111111-2222-4333-8444-555555555555";
    const providerUrl = `https://${alias}.play.teeitup.golf/`;
    const bookingUrl =
      `https://${alias}.book.teeitup.golf/?course=24680`;
    const discovery = buildBrowserDiscovery({
      courseId: "wampanoag",
      courseName: "Wampanoag Golf Course",
      sourceUrl:
        "https://www.wampanoaggolfcourseswansea.com/teetimes/",
      finalUrl:
        "https://www.wampanoaggolfcourseswansea.com/teetimes/",
      observedUrls: [providerUrl],
      officialPage: {
        url: "https://www.wampanoaggolfcourseswansea.com/teetimes/",
        courseName: "Wampanoag Golf Course",
        linkCandidates: [{ url: providerUrl, label: "Book tee times" }]
      },
      visibleText: "Wampanoag Golf Course Book Tee Times Online",
      teeItUpLegacyConfigurations: [{
        providerUrl,
        alias,
        facilityIds: [24680],
        courseName: "Wampanoag Golf Course"
      }]
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingUrl,
      apiMetadata: {
        aliases: [alias],
        bookingBaseUrl: bookingUrl,
        facilityIds: [24680]
      },
      evidence: {
        learnedFrom: "teeitup-legacy-play-configuration"
      }
    });
  });

  it("enriches a corroborated legacy TeeItUp embed from its public configuration", async () => {
    const alias = "11111111-2222-4333-8444-555555555555";
    const providerUrl = `https://${alias}.play.teeitup.golf/`;
    const discovery = buildBrowserDiscovery({
      courseId: "wampanoag",
      courseName: "Wampanoag Golf Course",
      sourceUrl: "https://www.wampanoaggolfcourseswansea.com/teetimes/",
      finalUrl: "https://www.wampanoaggolfcourseswansea.com/teetimes/",
      observedUrls: [providerUrl],
      officialCourseWebsite: "https://www.wampanoaggolfcourseswansea.com/",
      officialPage: {
        url: "https://www.wampanoaggolfcourseswansea.com/teetimes/",
        courseName: "Wampanoag Golf Course",
        linkCandidates: [{ url: providerUrl, label: "Book tee times" }]
      },
      visibleText: "Wampanoag Golf Course Book Tee Times Online"
    });
    expect(discovery.evidence.courseIdentityCorroboration).toMatchObject({
      kind: "OFFICIAL_COURSE_PROVIDER_LINK",
      providerUrl
    });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: {
            location: `https://${alias}.book.teeitup.com/`
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          '<script>self.__next_f.push([1,"{\\\"gnFacilityIds\\\":[15969],\\\"name\\\":\\\"Wampanoag Golf Course\\\"}"])</script>',
          { status: 200 }
        )
      );
    const enriched = await enrichTeeItUpDiscovery(
      discovery,
      "Wampanoag Golf Course",
      fetchImpl as typeof fetch
    );

    expect(enriched).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingUrl: `https://${alias}.book.teeitup.golf/?course=15969`,
      apiMetadata: {
        aliases: [alias],
        facilityIds: [15969]
      },
      evidence: { learnedFrom: "teeitup-legacy-play-configuration" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not enrich a legacy TeeItUp embed whose configured course identity differs", async () => {
    const alias = "11111111-2222-4333-8444-555555555555";
    const providerUrl = `https://${alias}.play.teeitup.golf/`;
    const discovery = buildBrowserDiscovery({
      courseId: "wampanoag",
      courseName: "Wampanoag Golf Course",
      sourceUrl: "https://www.wampanoaggolfcourseswansea.com/teetimes/",
      observedUrls: [providerUrl],
      officialCourseWebsite: "https://www.wampanoaggolfcourseswansea.com/",
      officialPage: {
        url: "https://www.wampanoaggolfcourseswansea.com/teetimes/",
        courseName: "Wampanoag Golf Course",
        linkCandidates: [{ url: providerUrl, label: "Book tee times" }]
      }
    });

    const enriched = await enrichTeeItUpDiscovery(
      discovery,
      "Wampanoag Golf Course",
      vi.fn(async () =>
        new Response(
          '<script>self.__next_f.push([1,"{\\\"gnFacilityIds\\\":[15969],\\\"name\\\":\\\"Different Golf Course\\\"}"])</script>',
          { status: 200 }
        )
      ) as typeof fetch
    );

    expect(enriched).toEqual(discovery);
  });

  it("accepts only a credential-free HTTPS root for legacy TeeItUp play embeds", () => {
    const alias = "11111111-2222-4333-8444-555555555555";
    expect(
      isLegacyTeeItUpPlayUrl(`https://${alias}.play.teeitup.golf/`)
    ).toBe(true);
    for (const unsafeUrl of [
      `http://${alias}.play.teeitup.golf/`,
      `https://user:password@${alias}.play.teeitup.golf/`,
      `https://${alias}.play.teeitup.golf:8443/`,
      `https://${alias}.play.teeitup.golf/account`,
      `https://${alias}.play.teeitup.golf/?date=2026-07-24`,
      `https://${alias}.play.teeitup.golf/#checkout`,
      `https://sibling.${alias}.play.teeitup.golf/`,
      `https://${alias}.play.teeitup.golf.example/`
    ]) {
      expect(isLegacyTeeItUpPlayUrl(unsafeUrl)).toBe(false);
    }
  });

  it("rejects a legacy TeeItUp play embed whose provider identity names another course", () => {
    const alias = "11111111-2222-4333-8444-555555555555";
    const providerUrl = `https://${alias}.play.teeitup.golf/`;
    const discovery = buildBrowserDiscovery({
      courseId: "wampanoag",
      courseName: "Wampanoag Golf Course",
      sourceUrl:
        "https://www.wampanoaggolfcourseswansea.com/teetimes/",
      observedUrls: [providerUrl],
      officialPage: {
        url: "https://www.wampanoaggolfcourseswansea.com/teetimes/",
        courseName: "Wampanoag Golf Course",
        linkCandidates: [{ url: providerUrl, label: "Book tee times" }]
      },
      teeItUpLegacyConfigurations: [{
        providerUrl,
        alias,
        facilityIds: [24680],
        courseName: "Different Golf Course"
      }]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "TEEITUP",
      bookingUrl:
        "https://www.wampanoaggolfcourseswansea.com/teetimes/",
      evidence: { learnedFrom: "teeitup-target-scope-ambiguous" }
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("rejects a legacy TeeItUp play embed with multiple provider facilities", () => {
    const alias = "11111111-2222-4333-8444-555555555555";
    const providerUrl = `https://${alias}.play.teeitup.golf/`;
    const discovery = buildBrowserDiscovery({
      courseId: "wampanoag",
      courseName: "Wampanoag Golf Course",
      sourceUrl:
        "https://www.wampanoaggolfcourseswansea.com/teetimes/",
      observedUrls: [providerUrl],
      officialPage: {
        url: "https://www.wampanoaggolfcourseswansea.com/teetimes/",
        courseName: "Wampanoag Golf Course",
        linkCandidates: [{ url: providerUrl, label: "Book tee times" }]
      },
      teeItUpLegacyConfigurations: [{
        providerUrl,
        alias,
        facilityIds: [24680, 13579],
        courseName: "Wampanoag Golf Course"
      }]
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("does not trust TeeItUp links from an official page without an explicit course identity", () => {
    const siblingBookingUrl =
      "https://sibling-public.book.teeitup.com/?course=13579";
    const discovery = buildBrowserDiscovery({
      courseId: "target-course",
      courseName: "Target Golf Course",
      sourceUrl: "https://target.example/tee-times",
      observedUrls: [siblingBookingUrl],
      linkCandidates: [
        { url: siblingBookingUrl, label: "Sibling Course Tee Times" }
      ],
      officialPage: {
        url: "https://target.example/book-online",
        linkCandidates: [
          { url: siblingBookingUrl, label: "Sibling Course Tee Times" }
        ]
      },
      visibleText: "Target Golf Course tee times"
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.bookingUrl).toBe("https://target.example/tee-times");
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe(
      "teeitup-target-scope-unconfirmed"
    );
  });

  it("upgrades an official HTTP TeeItUp booking root to canonical HTTPS", () => {
    const httpBookingUrl = "http://legacy-public.book.teeitup.com/";
    const httpsBookingUrl = "https://legacy-public.book.teeitup.com/";
    const discovery = buildBrowserDiscovery({
      courseId: "legacy-course",
      courseName: "Legacy Golf Course",
      sourceUrl: "https://legacy.example/tee-times",
      observedUrls: [httpBookingUrl],
      officialPage: {
        url: "https://legacy.example/tee-times",
        courseName: "Legacy Golf Course",
        linkCandidates: [
          { url: httpBookingUrl, label: "General Public Tee Times" }
        ]
      },
      visibleText: "Legacy Golf Course public tee times"
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingUrl: httpsBookingUrl,
      apiMetadata: {
        aliases: ["legacy-public"],
        bookingBaseUrl: httpsBookingUrl
      }
    });
  });

  it("prefers a target-scoped General Public TeeItUp link and preserves its facility selector", () => {
    const publicBookingUrl =
      "https://play-dc-golf-public.book.teeitup.com/?course=24680";
    const discovery = buildBrowserDiscovery({
      courseId: "rock-creek",
      courseName: "Rock Creek Park Golf",
      sourceUrl: "https://www.playdcgolf.com/rock-creek-park-golf-course/",
      finalUrl: "https://www.playdcgolf.com/rock-creek-tee-times/",
      observedUrls: [
        publicBookingUrl,
        "https://play-dc-golf-senior.book.teeitup.com/?course=24680",
        "https://play-dc-golf-junior.book.teeitup.com/?course=24680",
        "https://play-dc-golf-military.book.teeitup.com/?course=24680"
      ],
      linkCandidates: [
        { url: publicBookingUrl, label: "General Public" },
        {
          url: "https://play-dc-golf-senior.book.teeitup.com/?course=24680",
          label: "Seniors"
        },
        {
          url: "https://play-dc-golf-junior.book.teeitup.com/?course=24680",
          label: "Juniors"
        },
        {
          url: "https://play-dc-golf-military.book.teeitup.com/?course=24680",
          label: "Military"
        }
      ],
      officialPage: {
        url: "https://www.playdcgolf.com/rock-creek-tee-times/",
        courseName: "Rock Creek Park Golf",
        linkCandidates: [
          { url: publicBookingUrl, label: "General Public" },
          {
            url: "https://play-dc-golf-senior.book.teeitup.com/?course=24680",
            label: "Seniors"
          },
          {
            url: "https://play-dc-golf-junior.book.teeitup.com/?course=24680",
            label: "Juniors"
          },
          {
            url: "https://play-dc-golf-military.book.teeitup.com/?course=24680",
            label: "Military"
          }
        ]
      },
      visibleText: "Reserve your tee time for the 9-Hole Course or the 5-Hole Loop."
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

  it("keeps provider scope across a canonicalized target course URL", () => {
    const siblingForeupUrl =
      "https://foreupsoftware.com/index.php/booking/19333/145#teetimes";
    const targetBookingUrl =
      "https://play-dc-golf-public.book.teeitup.com/?course=24680";
    const discovery = buildBrowserDiscovery({
      courseId: "rock-creek",
      courseName: "Rock Creek Park Golf",
      sourceUrl:
        "https://www.playdcgolf.com/rock-creek-park-golf-course/?utm_source=directory",
      finalUrl: "https://playdcgolf.com/rock-creek-tee-times/",
      observedUrls: [siblingForeupUrl, targetBookingUrl],
      linkCandidates: [
        { url: siblingForeupUrl, label: "East Potomac Golf Links Tee Times" },
        { url: targetBookingUrl, label: "Rock Creek Park Golf Tee Times" }
      ],
      officialPage: {
        url: "https://playdcgolf.com/rock-creek-tee-times/",
        courseName: "Rock Creek Park Golf",
        linkCandidates: [
          { url: targetBookingUrl, label: "Rock Creek Park Golf Tee Times" }
        ]
      },
      visibleText: "Rock Creek Park Golf public tee times"
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingUrl: targetBookingUrl,
      apiMetadata: {
        aliases: ["play-dc-golf-public"],
        bookingBaseUrl: targetBookingUrl,
        facilityIds: [24680]
      }
    });
    expect(discovery.bookingUrl).not.toBe(siblingForeupUrl);
  });

  it("keeps the source course provider authoritative over a later instructor page", () => {
    const targetBookingUrl =
      "https://foreupsoftware.com/index.php/booking/24680/975#teetimes";
    const discovery = buildBrowserDiscovery({
      courseId: "rock-creek",
      courseName: "Rock Creek Park Golf",
      sourceUrl:
        "https://www.playdcgolf.com/rock-creek-park-golf-course/",
      finalUrl: "https://www.playdcgolf.com/rock-creek-instructors/",
      observedUrls: [targetBookingUrl],
      linkCandidates: [
        { url: targetBookingUrl, label: "Book Rock Creek Park Golf" }
      ],
      officialPage: {
        url: "https://www.playdcgolf.com/rock-creek-instructors/",
        courseName: "Rock Creek Park Golf",
        linkCandidates: []
      },
      visibleText: "Rock Creek Park Golf public tee times"
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      bookingUrl: targetBookingUrl,
      apiMetadata: {
        scheduleId: 975,
        bookingBaseUrl: targetBookingUrl
      }
    });
  });

  it("learns embedded provider evidence from the verified target course page", () => {
    const targetBookingUrl =
      "https://foreupsoftware.com/index.php/booking/24680/975#teetimes";
    const sourceUrl =
      "https://www.playdcgolf.com/rock-creek-park-golf-course/";
    const discovery = buildBrowserDiscovery({
      courseId: "rock-creek",
      courseName: "Rock Creek Park Golf",
      sourceUrl,
      finalUrl: sourceUrl,
      observedUrls: [targetBookingUrl],
      linkCandidates: [],
      officialPage: {
        url: sourceUrl,
        courseName: "Rock Creek Park Golf",
        linkCandidates: [],
        observedUrls: [targetBookingUrl]
      },
      visibleText: "Rock Creek Park Golf public tee times"
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      bookingUrl: targetBookingUrl,
      apiMetadata: {
        scheduleId: 975,
        bookingBaseUrl: targetBookingUrl
      }
    });
  });

  it("fails closed when target TeeItUp links disagree on the facility selector", () => {
    const linkCandidates = [
      {
        url: "https://shared-public.book.teeitup.com/?course=24680",
        label: "General Public"
      },
      {
        url: "https://shared-public.book.teeitup.com/?course=13579",
        label: "General Public Tee Times"
      }
    ];
    const discovery = buildBrowserDiscovery({
      courseId: "shared-teeitup-course",
      courseName: "Shared TeeItUp Course",
      sourceUrl: "https://shared.example/tee-times",
      observedUrls: [
        "https://shared-public.book.teeitup.com/?course=24680",
        "https://shared-public.book.teeitup.com/?course=13579"
      ],
      linkCandidates,
      officialPage: {
        url: "https://shared.example/tee-times",
        courseName: "Shared TeeItUp Course",
        linkCandidates
      },
      visibleText: "Public tee times"
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.bookingUrl).toBe("https://shared.example/tee-times");
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe(
      "teeitup-target-scope-ambiguous"
    );
  });

  it("fails closed when a TeeItUp booking URL repeats its facility selector", () => {
    const duplicateSelectorUrl =
      "https://shared-public.book.teeitup.com/?course=24680&course=24680";
    const discovery = buildBrowserDiscovery({
      courseId: "shared-teeitup-course",
      courseName: "Shared TeeItUp Course",
      sourceUrl: "https://shared.example/tee-times",
      observedUrls: [duplicateSelectorUrl],
      linkCandidates: [
        { url: duplicateSelectorUrl, label: "General Public" }
      ],
      visibleText: "Public tee times"
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it.each([
    "https://shared-public.book.teeitup.com/?course=2147483648",
    "https://shared-public.book.teeitup.com/?course=24680&unexpected=value",
    "https://shared-public.book.teeitup.com/?course=24680&date=2026-99-99"
  ])("does not learn target-scoped TeeItUp metadata from an invalid landing %s", (invalidUrl) => {
    const officialUrl = "https://shared.example/tee-times";
    const discovery = buildBrowserDiscovery({
      courseId: "shared-teeitup-course",
      courseName: "Shared TeeItUp Course",
      sourceUrl: officialUrl,
      observedUrls: [invalidUrl],
      officialPage: {
        url: officialUrl,
        courseName: "Shared TeeItUp Course",
        linkCandidates: [{ url: invalidUrl, label: "General Public Tee Times" }]
      },
      visibleText: "Shared TeeItUp Course public tee times"
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "TEEITUP",
      bookingUrl: officialUrl
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("suppresses an ambiguous provider booking URL when no official course page is known", () => {
    const ambiguousProviderUrl =
      "https://shared-public.book.teeitup.com/?course=24680&course=13579";
    const discovery = buildBrowserDiscovery({
      courseId: "shared-teeitup-course",
      courseName: "Shared TeeItUp Course",
      sourceUrl: ambiguousProviderUrl,
      observedUrls: [ambiguousProviderUrl],
      visibleText: "Public tee times"
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.bookingUrl).toBeUndefined();
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("fails closed instead of applying one facility selector across TeeItUp aliases", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "shared-teeitup-course",
      courseName: "Shared TeeItUp Course",
      sourceUrl: "https://shared.example/tee-times",
      observedUrls: [
        "https://shared-public.book.teeitup.com/?course=24680",
        "https://alternate-public.book.teeitup.com/?course=24680"
      ],
      linkCandidates: [
        {
          url: "https://shared-public.book.teeitup.com/?course=24680",
          label: "General Public"
        },
        {
          url: "https://alternate-public.book.teeitup.com/?course=24680",
          label: "General Public"
        }
      ],
      visibleText: "Public tee times"
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("does not turn a TeeItUp gift-store link into booking metadata", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "little-harbor",
      courseName: "Little Harbor Golf Course",
      sourceUrl: "https://littleharborgolf.com/",
      finalUrl:
        "https://little-harbor-country-club.book.teeitup.com/store/gift-certificates",
      observedUrls: [
        "https://little-harbor-country-club.book.teeitup.com/store/gift-certificates"
      ],
      officialPage: {
        url: "https://littleharborgolf.com/",
        courseName: "Little Harbor Golf Course",
        linkCandidates: [
          {
            url: "https://little-harbor-country-club.book.teeitup.com/store/gift-certificates",
            label: "Book tee times"
          }
        ]
      },
      visibleText: "Book tee times"
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "TEEITUP",
      bookingUrl: "https://littleharborgolf.com/"
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("recognizes a CPS tenant without inventing course ids", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "The Tradition Golf Club at Oak Lane",
      sourceUrl: "https://www.traditionatoaklane.com/",
      finalUrl: "https://traditionoaklane.cps.golf/",
      observedUrls: ["https://traditionoaklane.cps.golf/onlineresweb/search-teetime"],
      visibleText: "Tradition Golf Club at Oak Lane"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("CUSTOM");
    expect(discovery.bookingUrl).toBe("https://traditionoaklane.cps.golf/");
    expect(discovery.apiEndpoint).toBe(
      "https://traditionoaklane.cps.golf/onlineres/onlineapi/api/v1/onlinereservation/TeeTimes"
    );
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe("cps-course-id-missing");
  });

  it("learns CPS metadata only when the selected tenant exposes a course id", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "course-with-provider-id",
      courseName: "Example Public Golf Course",
      sourceUrl: "https://example.test/golf",
      observedUrls: [
        "https://examplepublic.cps.golf/onlineresweb/search-teetime?CourseId=7"
      ]
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      bookingUrl: "https://examplepublic.cps.golf/",
      apiMetadata: {
        provider: "CPS",
        siteName: "examplepublic",
        bookingBaseUrl: "https://examplepublic.cps.golf/",
        courseIds: [7],
        holes: [18, 9]
      }
    });
  });

  it.each([
    "https://examplepublic.cps.golf/onlineresweb/search-teetime?CourseId=2147483648",
    "https://examplepublic.cps.golf/onlineresweb/search-teetime?CourseId=7&CourseId=8",
    "https://examplepublic.cps.golf/onlineresweb/search-teetime?CourseId=7&date=2026-07-24"
  ])("does not learn CPS metadata from an invalid public landing %s", (invalidUrl) => {
    const discovery = buildBrowserDiscovery({
      courseId: "course-with-provider-id",
      courseName: "Example Public Golf Course",
      sourceUrl: "https://example.test/golf",
      observedUrls: [invalidUrl],
      linkCandidates: [{ url: invalidUrl, label: "Example Public Golf Course" }]
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("selects the unique course-matching CPS tenant at a shared facility", () => {
    const oaksUrl = "https://oaksgolflinks.cps.golf/onlineresweb/search-teetime";
    const candiaUrl = "https://candiawoods.cps.golf/";
    const discovery = buildBrowserDiscovery({
      courseId: "candia-woods",
      courseName: "Candia Woods Golf Links",
      sourceUrl: "https://candiaoaks.example/",
      observedUrls: [oaksUrl, candiaUrl],
      linkCandidates: [
        { url: oaksUrl, label: "The Oaks Book A Tee Time" },
        { url: candiaUrl, label: "Candia Woods Book A Tee Time" }
      ]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      bookingUrl: "https://candiawoods.cps.golf/",
      evidence: { learnedFrom: "cps-course-id-missing" }
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("keeps same-tenant CPS course ids separate until the target course is selected", () => {
    const oaksUrl =
      "https://candiaoaks.cps.golf/onlineresweb/search-teetime?CourseId=11";
    const candiaUrl =
      "https://candiaoaks.cps.golf/onlineresweb/search-teetime?CourseId=22";
    const discovery = buildBrowserDiscovery({
      courseId: "candia-woods",
      courseName: "Candia Woods Golf Links",
      sourceUrl: "https://candiaoaks.example/",
      observedUrls: [oaksUrl, candiaUrl],
      linkCandidates: [
        { url: oaksUrl, label: "The Oaks Golf Links Book A Tee Time" },
        { url: candiaUrl, label: "Candia Woods Golf Links Book A Tee Time" }
      ]
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      bookingUrl: "https://candiaoaks.cps.golf/",
      apiMetadata: {
        provider: "CPS",
        siteName: "candiaoaks",
        bookingBaseUrl: "https://candiaoaks.cps.golf/",
        courseIds: [22]
      }
    });
  });

  it("does not merge unlabeled course ids from one shared CPS tenant", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "unresolved-shared-tenant-course",
      courseName: "Target Public Golf Course",
      sourceUrl: "https://shared.example/",
      observedUrls: [
        "https://sharedfacility.cps.golf/onlineresweb/search-teetime?CourseId=11",
        "https://sharedfacility.cps.golf/onlineresweb/search-teetime?CourseId=22"
      ]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      bookingUrl: "https://sharedfacility.cps.golf/",
      evidence: { learnedFrom: "cps-course-id-ambiguous" }
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("keeps a first managed-challenge CPS observation non-terminal", () => {
    const barrier = { url: "https://grassyhill.cps.golf/", status: 403 as const };
    const discovery = buildBrowserDiscovery({
      courseId: "grassy-hill",
      courseName: "Grassy Hill Country Club",
      sourceUrl: "http://www.grassyhillcountryclub.com/",
      finalUrl: "https://grassyhill.cps.golf/",
      observedUrls: [
        "https://secure.east.prophetservices.com/GrassyHillCCV3",
        "https://grassyhill.cps.golf/"
      ],
      accessBarriers: [barrier],
      visibleText: "Book Online Tee Times"
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      bookingUrl: "https://grassyhill.cps.golf/",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "NONE",
      evidence: { learnedFrom: "cps-managed-challenge-unconfirmed" }
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("classifies a corroborated managed-challenge CPS surface as technical", () => {
    const barrier = { url: "https://grassyhill.cps.golf/", status: 403 as const };
    const discovery = buildBrowserDiscovery({
      courseId: "grassy-hill",
      courseName: "Grassy Hill Country Club",
      sourceUrl: "https://grassyhillcountryclub.com/",
      finalUrl: barrier.url,
      observedUrls: [barrier.url],
      accessBarriers: [barrier],
      corroboratedAccessBarrier: barrier,
      visibleText: "Book Online Tee Times"
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      evidence: {
        learnedFrom: "cps-managed-challenge-booking",
        accessBarriers: [barrier]
      }
    });
  });

  it("learns reusable GolfBack metadata from an official public course link", () => {
    const bookingUrl =
      "https://golfback.com/#/course/5a90fb0c-b928-43f0-9486-d5d43c03d25d";
    const discovery = buildBrowserDiscovery({
      courseId: "windsor-parke",
      courseName: "Windsor Parke Golf Club",
      sourceUrl: "https://windsorparke.com/",
      finalUrl: "https://golfback.com/",
      observedUrls: [bookingUrl],
      visibleText: "Reserve tee times online for the guaranteed best rate"
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "CUSTOM",
      bookingUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiEndpoint:
        "https://api.golfback.com/api/v1/courses/5a90fb0c-b928-43f0-9486-d5d43c03d25d/date/{date}/teetimes",
      apiMetadata: {
        provider: "GOLFBACK",
        courseId: "5a90fb0c-b928-43f0-9486-d5d43c03d25d",
        bookingBaseUrl: bookingUrl
      },
      confidence: 0.95,
      evidence: { learnedFrom: "golfback-public-course-link" }
    });
  });

  it("does not learn GolfBack metadata from a malformed course id", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "golfback-under-review",
      courseName: "Example Public Golf Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://golfback.com/#/course/not-a-provider-id"],
      visibleText: "Book tee times online"
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.automationEligibility).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe("browser-visible-links");
  });

  it("maps Ponemah to its labeled Club Caddie tee sheet instead of Amherst or activity inventory", () => {
    const amherstUrl =
      "https://apimanager-cc28.clubcaddie.com/webapi/view/amherst-public/slots";
    const ponemahUrl =
      "https://apimanager-cc28.clubcaddie.com/webapi/view/ponemah-public/slots";
    const ponemahInteractionUrl = `${ponemahUrl}?Interaction=request-local-value`;
    const activityUrl =
      "https://apimanager-cc28.clubcaddie.com/webapi/view/simulator-public/slots";
    const discovery = buildBrowserDiscovery({
      courseId: "ponemah",
      courseName: "Ponemah Green Family Golf Center",
      sourceUrl: "https://www.playamherst.com/ponemah-green",
      observedUrls: [amherstUrl, ponemahInteractionUrl, activityUrl],
      linkCandidates: [
        { url: amherstUrl, label: "Book @ ACC" },
        { url: ponemahInteractionUrl, label: "Book @ PG" },
        { url: activityUrl, label: "Book Golf Simulator" }
      ],
      visibleText: "Book a public tee time"
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "CLUB_CADDIE",
      bookingUrl: ponemahUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiEndpoint: "https://apimanager-cc28.clubcaddie.com/webapi/TeeTimes",
      apiMetadata: {
        provider: "CLUB_CADDIE",
        bookingBaseUrl: ponemahUrl
      },
      evidence: { learnedFrom: "club-caddie-public-tee-time-link" }
    });
    expect(JSON.stringify(discovery)).not.toContain("Interaction");
    expect(JSON.stringify(discovery)).not.toContain("request-local-value");
    expect(
      buildBrowserDiscovery({
        courseId: "amherst",
        courseName: "Amherst Country Club",
        sourceUrl: "https://www.playamherst.com/",
        observedUrls: [amherstUrl, ponemahUrl],
        linkCandidates: [
          { url: amherstUrl, label: "Book @ ACC" },
          { url: ponemahUrl, label: "Book @ PG" }
        ]
      }).apiMetadata
    ).toEqual({
      provider: "CLUB_CADDIE",
      bookingBaseUrl: amherstUrl
    });
  });

  it("keeps Independence Championship and Bear Club Caddie inventories separate", () => {
    const championshipUrl =
      "https://apimanager-cc30.clubcaddie.com/webapi/view/championship-public/slots";
    const bearUrl =
      "https://apimanager-cc30.clubcaddie.com/webapi/view/bear-public/slots";
    const evidence = {
      sourceUrl: "https://independencegolfclub.com/overview/bear/",
      observedUrls: [championshipUrl, bearUrl],
      linkCandidates: [
        { url: championshipUrl, label: "Book Championship Course Tee Times" },
        { url: bearUrl, label: "Book The Bear Tee Times" }
      ]
    };

    expect(
      buildBrowserDiscovery({
        ...evidence,
        courseId: "independence",
        courseName: "Independence Golf Club"
      }).apiMetadata
    ).toEqual({
      provider: "CLUB_CADDIE",
      bookingBaseUrl: championshipUrl
    });
    expect(
      buildBrowserDiscovery({
        ...evidence,
        courseId: "bear",
        courseName: "The Bear at Independence Golf Club"
      }).apiMetadata
    ).toEqual({
      provider: "CLUB_CADDIE",
      bookingBaseUrl: bearUrl
    });
  });

  it("does not guess between multiple unlabeled Club Caddie tee sheets", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "ambiguous-club-caddie",
      courseName: "Shared Facility Golf Course",
      sourceUrl: "https://shared.example/golf",
      finalUrl:
        "https://apimanager-cc20.clubcaddie.com/webapi/view/first-public/slots",
      observedUrls: [
        "https://apimanager-cc20.clubcaddie.com/webapi/view/first-public/slots",
        "https://apimanager-cc20.clubcaddie.com/webapi/view/second-public/slots"
      ]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "CLUB_CADDIE",
      bookingUrl: "https://shared.example/golf"
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("learns one unambiguous safe Club Caddie public tee sheet", () => {
    const bookingUrl =
      "https://apimanager-cc12.clubcaddie.com/webapi/view/single-public/slots";
    const discovery = buildBrowserDiscovery({
      courseId: "single-club-caddie",
      courseName: "Single Public Golf Course",
      sourceUrl: "https://single.example/",
      observedUrls: [bookingUrl],
      linkCandidates: [{
        url: bookingUrl,
        label: "Book Tee Times"
      }]
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      bookingUrl,
      apiMetadata: { provider: "CLUB_CADDIE", bookingBaseUrl: bookingUrl }
    });
  });

  it("does not map a lone generic Club Caddie link to an uncorroborated sibling course", () => {
    const championshipUrl =
      "https://apimanager-cc30.clubcaddie.com/webapi/view/championship-public/slots";
    const discovery = buildBrowserDiscovery({
      courseId: "bear",
      courseName: "The Bear at Independence Golf Club",
      sourceUrl: "https://independencegolfclub.com/overview/bear/",
      observedUrls: [championshipUrl],
      linkCandidates: [{ url: championshipUrl, label: "Book Tee Times" }]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "CLUB_CADDIE",
      bookingUrl: "https://independencegolfclub.com/overview/bear/"
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("does not persist a Club Caddie request-local interaction URL as metadata", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "session-specific-club-caddie",
      courseName: "Session Specific Golf Course",
      sourceUrl: "https://session-specific.example/",
      observedUrls: [
        "https://apimanager-cc12.clubcaddie.com/webapi/view/public-course/slots?Interaction=request-local-value"
      ]
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
    const serialized = JSON.stringify(discovery);
    expect(serialized).not.toContain("Interaction");
    expect(serialized).not.toContain("request-local-value");
    expect(discovery.evidence.observedUrls).toEqual(
      expect.arrayContaining([
        "https://apimanager-cc12.clubcaddie.com/webapi/view/public-course/slots"
      ])
    );
  });

  it("does not learn a lone Club Caddie simulator or mini-golf inventory", () => {
    const bookingUrl =
      "https://apimanager-cc12.clubcaddie.com/webapi/view/activity-public/slots";
    const discovery = buildBrowserDiscovery({
      courseId: "activity-only-club-caddie",
      courseName: "Example Golf Course",
      sourceUrl: "https://example.test/golf",
      observedUrls: [bookingUrl],
      linkCandidates: [{
        url: bookingUrl,
        label: "Book Mini Golf Simulator Activity"
      }]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "CLUB_CADDIE",
      bookingUrl: "https://example.test/golf"
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("learns CPS metadata from an official tee-time widget config", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-stanley",
      courseName: "Stanley Golf Course SGC",
      sourceUrl: "https://www.stanleygolfcourse.com/bookteetimes",
      finalUrl: "https://www.stanleygolfcourse.com/bookteetimes",
      observedUrls: ["https://www.stanleygolfcourse.com/bookteetimes"],
      visibleText:
        '{"baseURL":"https://stanleygolf.cps.golf/onlineresweb/search-teetime","newBookingEngine":true,"locations":[{"name":"Stanley Golf","courseId":"0"}]}'
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("LEARNED");
    expect(discovery.detectedPlatform).toBe("CUSTOM");
    expect(discovery.bookingUrl).toBe("https://stanleygolf.cps.golf/");
    expect(discovery.apiMetadata).toEqual({
      provider: "CPS",
      siteName: "stanleygolf",
      bookingBaseUrl: "https://stanleygolf.cps.golf/",
      courseIds: [0],
      holes: [18, 9]
    });
  });

  it("selects only the uniquely matching course from a multi-location CPS widget", () => {
    const visibleText =
      '{"baseURL":"https://candiaoaks.cps.golf/onlineresweb/search-teetime","locations":[{"name":"The Oaks Golf Links","courseId":"11"},{"name":"Candia Woods Golf Links","courseId":"22"}]}';
    const discover = (courseId: string, courseName: string) =>
      buildBrowserDiscovery({
        courseId,
        courseName,
        sourceUrl: "https://candiaoaks.example/",
        observedUrls: ["https://candiaoaks.example/"],
        visibleText
      });

    expect(discover("candia-woods", "Candia Woods Golf Links").apiMetadata).toMatchObject({
      provider: "CPS",
      courseIds: [22]
    });
    expect(discover("the-oaks", "The Oaks Golf Links").apiMetadata).toMatchObject({
      provider: "CPS",
      courseIds: [11]
    });
  });

  it("leaves a multi-location CPS widget without a unique course match unrunnable", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "shared-facility",
      courseName: "Shared Facility Golf Course",
      sourceUrl: "https://shared.example/",
      observedUrls: ["https://shared.example/"],
      visibleText:
        '{"baseURL":"https://sharedfacility.cps.golf/onlineresweb/search-teetime","locations":[{"name":"North Course","courseId":"11"},{"name":"South Course","courseId":"22"}]}'
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      bookingUrl: "https://sharedfacility.cps.golf/",
      evidence: { learnedFrom: "cps-course-id-ambiguous" }
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("does not mistake a CPS webstore for a public tee-time reservation surface", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "bayberry-hills",
      courseName: "Bayberry Hills Golf Course",
      sourceUrl: "https://www.golfyarmouth.com/",
      finalUrl: "https://sc.cps.golf/BayberryHillsWebstore/",
      observedUrls: [
        "https://www.golfyarmouth.com/contact-us-/book-now",
        "https://sc.cps.golf/BayberryHillsWebstore/Products/Productlist/GiftCards/1"
      ],
      visibleText: "Bayberry Hills online store"
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("learns reusable Teesnap metadata from public tee-sheet pages", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-hunter",
      courseName: "Hunter Memorial Golf Course",
      sourceUrl: "https://www.huntergolfclub.com/tee-times-beta",
      finalUrl: "https://huntergolfclub.teesnap.net/",
      observedUrls: [
        "https://huntergolfclub.teesnap.net/",
        "https://huntergolfclub.teesnap.net/customer-api/teetimes-day?course=1210&date=2026-07-11&players=4&holes=18&addons=off&profileId="
      ],
      visibleText:
        'window.courses = [{"id":1210,"property_id":1060,"key":"huntergolfclub","name":"Hunter Golf Club","core_id":1389}]'
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("LEARNED");
    expect(discovery.detectedPlatform).toBe("CUSTOM");
    expect(discovery.bookingUrl).toBe("https://huntergolfclub.teesnap.net/");
    expect(discovery.apiEndpoint).toBe(
      "https://huntergolfclub.teesnap.net/customer-api/teetimes-day"
    );
    expect(discovery.apiMetadata).toEqual({
      provider: "TEESNAP",
      courseId: 1210,
      bookingBaseUrl: "https://huntergolfclub.teesnap.net/",
      defaultHoles: 18,
      defaultAddons: "off"
    });
  });

  it("does not let a stale TeeSnap course URL override current provider config", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "stale-teesnap-link",
      courseName: "Current Public Golf Course",
      sourceUrl: "https://current.example/",
      observedUrls: [
        "https://current.teesnap.net/customer-api/teetimes-day?course=999"
      ],
      visibleText:
        'window.courses = [{"id":1,"name":"Current Public Golf Course","holes_default":18}]'
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe(
      "teesnap-technical-evidence-without-public-landing:observed-course-config-mismatch"
    );
  });

  it.each([
    "https://evilforeupsoftware.com/api/booking/times?schedule_id=123",
    "https://public-course.teesnap.net/customer-api/teetimes-day?course=123",
    "https://golfback.com/?unexpected=value#/course/123e4567-e89b-42d3-a456-426614174000",
    "https://public-course.chelseareservations.com/api/config",
    "https://app.whoosh.io/patron/club/public-course?unexpected=value",
    "https://fox.tenfore.golf/public-course/checkout",
    "https://www.chronogolf.com/club/checkout",
    "https://public-course.cps.golf/onlineres/onlineapi/checkout?courseId=123",
    "https://apimanager-cc12.clubcaddie.com/webapi/view/public-course?unexpected=value"
  ])("never turns unsafe specialized-provider evidence into runnable metadata: %s", (unsafeUrl) => {
    const discovery = buildBrowserDiscovery({
      courseId: "unsafe-provider-evidence",
      courseName: "Public Course Golf Club",
      sourceUrl: "https://public-course.example/",
      observedUrls: [unsafeUrl],
      linkCandidates: [{ url: unsafeUrl, label: "Book now" }]
    });

    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.automationEligibility).not.toBe("ALLOWED");
    expect(discovery.status).not.toBe("LEARNED");
  });

  it("does not let mixed raw provider evidence replace the source provider family", () => {
    const sourceUrl = "https://public-course.ezlinksgolf.com/";
    const foreignUrl =
      "https://foreupsoftware.com/index.php/booking/21017/6654#/teetimes";
    const discovery = buildBrowserDiscovery({
      courseId: "mixed-provider-evidence",
      courseName: "Public Course Golf Club",
      sourceUrl,
      finalUrl: sourceUrl,
      observedUrls: [sourceUrl, foreignUrl],
      linkCandidates: [{ url: foreignUrl, label: "Book now" }]
    });

    expect(discovery.detectedPlatform).toBe("CUSTOM");
    expect(discovery.bookingUrl).toBe(sourceUrl);
    expect(discovery.apiMetadata).toBeUndefined();
    expect(JSON.stringify(discovery)).not.toContain("foreupsoftware.com");
  });

  it("does not let a sibling TeeItUp tenant become the target course", () => {
    const sourceUrl =
      "https://target-course.book.teeitup.golf/?course=111";
    const siblingUrl =
      "https://sibling-course.book.teeitup.golf/?course=222";
    const discovery = buildBrowserDiscovery({
      courseId: "target-course",
      courseName: "Target Course Golf Club",
      sourceUrl,
      finalUrl: sourceUrl,
      observedUrls: [sourceUrl, siblingUrl],
      linkCandidates: [{ url: siblingUrl, label: "Book tee times" }]
    });

    expect(discovery.apiMetadata).toBeUndefined();
    expect(JSON.stringify(discovery)).not.toContain("sibling-course");
    expect(JSON.stringify(discovery)).not.toContain("222");
  });

  it("drops a foreign provider access barrier from provider-scoped evidence", () => {
    const sourceUrl = "https://target-course.ezlinksgolf.com/";
    const foreignBarrierUrl = "https://sibling-course.cps.golf/";
    const discovery = buildBrowserDiscovery({
      courseId: "target-course",
      courseName: "Target Course Golf Club",
      sourceUrl,
      finalUrl: sourceUrl,
      observedUrls: [sourceUrl],
      accessBarriers: [{ url: foreignBarrierUrl, status: 403 }],
      corroboratedAccessBarrier: { url: foreignBarrierUrl, status: 403 }
    });

    expect(discovery.detectedPlatform).toBe("CUSTOM");
    expect(discovery.automationReason).not.toBe("CAPTCHA_OR_QUEUE");
    expect(discovery.apiMetadata).toBeUndefined();
    expect(JSON.stringify(discovery)).not.toContain("sibling-course.cps.golf");
  });

  it("classifies a corroborated managed challenge on an exact known-provider search landing", () => {
    const sourceUrl = "https://public-course.example/tee-times";
    const providerUrl =
      "https://public-course.ezlinksgolf.com/index.html#/search";
    const accessBarrier = { url: providerUrl, status: 403 as const };
    const discovery = buildBrowserDiscovery({
      courseId: "target-course",
      courseName: "Target Course Golf Club",
      sourceUrl,
      observedUrls: [sourceUrl, providerUrl],
      linkCandidates: [{ url: providerUrl, label: "Book now" }],
      accessBarriers: [accessBarrier],
      corroboratedAccessBarrier: accessBarrier
    });

    expect(discovery).toMatchObject({
      status: "BLOCKED",
      detectedPlatform: "CUSTOM",
      bookingUrl: providerUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      confidence: 0.95,
      evidence: {
        accessBarriers: [{
          url: "https://public-course.ezlinksgolf.com/index.html",
          status: 403
        }],
        learnedFrom: "known-provider-public-landing-access-barrier"
      }
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("keeps a first managed challenge retryable until it is corroborated", () => {
    const sourceUrl = "https://public-course.example/tee-times";
    const providerUrl =
      "https://public-course.ezlinksgolf.com/target-course/search";
    const discovery = buildBrowserDiscovery({
      courseId: "target-course",
      courseName: "Target Course Golf Club",
      sourceUrl,
      observedUrls: [sourceUrl, providerUrl],
      linkCandidates: [{ url: providerUrl, label: "Book now" }],
      accessBarriers: [{ url: providerUrl, status: 403 }]
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingUrl).toBe(providerUrl);
    expect(discovery.automationReason).not.toBe("CAPTCHA_OR_QUEUE");
  });

  it("fails closed when an official packet contains multiple unresolved provider families", () => {
    const foreupUrl =
      "https://foreupsoftware.com/index.php/booking/21017/6654#/teetimes";
    const teeItUpUrl =
      "https://public-course.book.teeitup.golf/?course=24680";
    const discovery = buildBrowserDiscovery({
      courseId: "provider-conflict",
      courseName: "Public Course Golf Club",
      sourceUrl: "https://public-course.example/",
      finalUrl: "https://public-course.example/",
      observedUrls: [foreupUrl, teeItUpUrl],
      linkCandidates: [
        { url: foreupUrl, label: "Book now" },
        { url: teeItUpUrl, label: "Book now" }
      ]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "UNKNOWN",
      evidence: { learnedFrom: "provider-evidence-conflict" }
    });
    expect(discovery.bookingUrl).toBeUndefined();
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it.each([
    [
      "FOREUP",
      "https://foreupsoftware.com/index.php/booking/21017/11#/teetimes",
      "https://foreupsoftware.com/index.php/booking/21017/22#/teetimes"
    ],
    [
      "CHELSEA",
      "https://sibling.chelseareservations.com/",
      "https://target.chelseareservations.com/"
    ],
    [
      "TEESNAP",
      "https://sibling.teesnap.net/",
      "https://target.teesnap.net/"
    ],
    [
      "WEBTRAC",
      "https://sibling.navyaims.com/webtrac/web/search.html?module=GR&secondarycode=11",
      "https://target.navyaims.com/webtrac/web/search.html?module=GR&secondarycode=22"
    ]
  ])("fails closed on unresolved same-family %s sibling landings", (_family, siblingUrl, targetUrl) => {
    const discovery = buildBrowserDiscovery({
      courseId: "same-family-conflict",
      courseName: "Target Course Golf Club",
      sourceUrl: "https://target-course.example/",
      finalUrl: "https://target-course.example/",
      observedUrls: [siblingUrl, targetUrl],
      linkCandidates: [
        { url: siblingUrl, label: "Sibling Golf Course" },
        { url: targetUrl, label: "Target Course Golf Club" }
      ],
      visibleText:
        'window.courses = [{"id":123,"name":"Target Course Golf Club"}]'
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "UNKNOWN",
      evidence: { learnedFrom: "provider-evidence-conflict" }
    });
    expect(discovery.bookingUrl).toBeUndefined();
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("fails closed when ForeUp API evidence disagrees with the target landing selector", () => {
    const targetUrl =
      "https://foreupsoftware.com/index.php/booking/222/22#/teetimes";
    const conflictingApiUrl =
      "https://foreupsoftware.com/index.php/api/booking/times?schedule_id=11&booking_class=111";
    const discovery = buildBrowserDiscovery({
      courseId: "foreup-selector-conflict",
      courseName: "Target Course Golf Club",
      sourceUrl: "https://target-course.example/",
      observedUrls: [targetUrl, conflictingApiUrl],
      linkCandidates: [{ url: targetUrl, label: "Target Course Golf Club" }]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "FOREUP",
      bookingUrl: targetUrl,
      evidence: { learnedFrom: "foreup-selector-conflict" }
    });
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("does not transfer a sibling ForeUp access barrier to the scoped target landing", () => {
    const targetUrl =
      "https://foreupsoftware.com/index.php/booking/222/22#/teetimes";
    const siblingUrl =
      "https://foreupsoftware.com/index.php/booking/111/11#/teetimes";
    const discovery = buildBrowserDiscovery({
      courseId: "foreup-barrier-scope",
      courseName: "Target Course Golf Club",
      sourceUrl: targetUrl,
      finalUrl: targetUrl,
      observedUrls: [targetUrl],
      accessBarriers: [{ url: siblingUrl, status: 403 }],
      corroboratedAccessBarrier: { url: siblingUrl, status: 403 }
    });

    expect(discovery.automationReason).not.toBe("CAPTCHA_OR_QUEUE");
    expect(JSON.stringify(discovery)).not.toContain("/booking/111/11");
    expect(discovery.apiMetadata).toEqual(
      expect.objectContaining({ scheduleId: 22, bookingBaseUrl: targetUrl })
    );
  });

  it("fails closed on two course paths inside one EZLinks tenant", () => {
    const siblingUrl =
      "https://public-course.ezlinksgolf.com/sibling/tee-times";
    const targetUrl =
      "https://public-course.ezlinksgolf.com/target/tee-times";
    const discovery = buildBrowserDiscovery({
      courseId: "ezlinks-path-conflict",
      courseName: "Target Course Golf Club",
      sourceUrl: "https://target-course.example/",
      observedUrls: [siblingUrl, targetUrl],
      linkCandidates: [
        { url: siblingUrl, label: "Sibling Golf Course" },
        { url: targetUrl, label: "Target Course Golf Club" }
      ]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "UNKNOWN",
      evidence: { learnedFrom: "provider-evidence-conflict" }
    });
    expect(discovery.bookingUrl).toBeUndefined();
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("does not treat social media links as booking pages just because facebook contains book", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "The Tradition Golf Club at Oak Lane",
      sourceUrl: "https://www.traditionatoaklane.com/",
      finalUrl: "https://www.traditionatoaklane.com/",
      observedUrls: [
        "https://facebook.com/limoanywhere",
        "https://www.traditionatoaklane.com/contact"
      ],
      visibleText: "Book a tee time by calling the pro shop"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.bookingUrl).toBe("https://www.traditionatoaklane.com/");
  });

  it("does not treat static plugin assets as booking pages", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "Fairchild Wheeler Golf Course",
      sourceUrl: "https://www.fairchildwheelergolf.com/",
      finalUrl: "https://www.fairchildwheelergolf.com/",
      observedUrls: [
        "https://www.fairchildwheelergolf.com/wp-content/plugins/golfnow-genesis-a11y/assets/dist/accessibility.css?ver=1.0",
        "https://www.fairchildwheelergolf.com/tee-times"
      ],
      visibleText: "Book your tee time online"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.bookingUrl).toBe("https://www.fairchildwheelergolf.com/tee-times");
  });

  it("prefers a safe recognized provider handoff over its official booking wrapper", () => {
    const sourceUrl = "https://public-course.example/";
    const bookingWrapperUrl = "https://public-course.example/book-now/";
    const providerConfigUrl = "https://api.ezlinksgolf.com/v1/config";
    const providerUrl = "https://public-course.ezlinksgolf.com/";
    const discovery = buildBrowserDiscovery({
      courseId: "public-course",
      courseName: "Public Course Golf Club",
      sourceUrl,
      finalUrl: "https://public-course.example/faq/",
      observedUrls: [bookingWrapperUrl, providerConfigUrl, providerUrl],
      officialPage: {
        url: sourceUrl,
        linkCandidates: [
          { url: bookingWrapperUrl, label: "Book now" },
          { url: providerUrl, label: "Book now" }
        ],
        courseName: "Public Course Golf Club",
        visibleText: "Public Course Golf Club tee times"
      },
      visibleText: "Frequently asked questions"
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      bookingUrl: providerUrl,
      evidence: { learnedFrom: "browser-visible-links" }
    });
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("does not select a sensitive recognized-provider destination", () => {
    const bookingWrapperUrl = "https://public-course.example/book-now/";
    const discovery = buildBrowserDiscovery({
      courseId: "public-course",
      courseName: "Public Course Golf Club",
      sourceUrl: "https://public-course.example/",
      observedUrls: [
        bookingWrapperUrl,
        "https://public-course.ezlinksgolf.com/checkout"
      ],
      visibleText: "Book tee times online"
    });

    expect(discovery.bookingUrl).toBe(bookingWrapperUrl);
    expect(discovery.bookingUrl).not.toContain("checkout");
  });

  it.each([
    "https://config-qa.ezlinksgolf.com/v1/config",
    "https://apiqa.ezlinksgolf.com/tee-times",
    "https://adminportal.ezlinksgolf.com/tee-times",
    "https://devportal.ezlinksgolf.com/tee-times",
    "https://public-course.ezlinksgolf.com/configprod/tee-times",
    "https://public-course.ezlinksgolf.com/%2561pi/tee-times",
    "https://apipublic.ezlinksgolf.com/tee-times",
    "https://adminpanel.ezlinksgolf.com/tee-times",
    "https://authcallback.ezlinksgolf.com/tee-times",
    "https://configstore.ezlinksgolf.com/tee-times",
    "https://graphqlproxy.ezlinksgolf.com/tee-times",
    "https://swaggerui.ezlinksgolf.com/tee-times",
    "https://openapiexplorer.ezlinksgolf.com/tee-times",
    "https://restendpoint.ezlinksgolf.com/tee-times",
    "https://public-course.ezlinksgolf.com/tee-times?format=application%2Fjson",
    "https://public-course.ezlinksgolf.com/tee-times?format=%256ason",
    "https://public-course.ezlinksgolf.com/v2beta/tee-times",
    "https://public-course.ezlinksgolf.com/v1alpha1/tee-times",
    "https://public-course.ezlinksgolf.com/restpublic/tee-times",
    "https://public-course.ezlinksgolf.com/tee-times?response=jsonp",
    "https://public-course.ezlinksgolf.com/tee-times?response_format=json",
    "https://public-course.ezlinksgolf.com/tee-times?responseFormat=application%2Fjson",
    "https://public-course.ezlinksgolf.com/tee-times?contentType=application%2Fjson",
    "https://public-course.ezlinksgolf.com/tee-times?mime=application%2Fxml",
    "https://public-course.ezlinksgolf.com/tee-times?format=application%2Fvnd.api%2Bjson",
    "https://public-course.ezlinksgolf.com/tee-times.jsonp",
    "https://public-course.ezlinksgolf.com/jsonp/tee-times",
    "https://public-course.ezlinksgolf.com/tee-times.geojson",
    "https://public-course.ezlinksgolf.com/tee-times?endpoint=api-v1",
    "https://public-course.ezlinksgolf.com/tee-times?api=v2",
    "https://public-course.ezlinksgolf.com/tee-times?route=%2Fapi%2Fv1",
    "https://public-course.ezlinksgolf.com/tee-times?format=application%2Fx-json",
    "https://public-course.ezlinksgolf.com/tee-times?format=application%252Fx-json",
    "https://public-course.ezlinksgolf.com/tee-times?format=application%2Fx-xml",
    "https://public-course.ezlinksgolf.com/tee-times?format=text%2Fx-yaml",
    "https://public-course.ezlinksgolf.com/tee-times?format=geojson",
    "https://public-course.ezlinksgolf.com/tee-times?output=geojson",
    "https://public-course.ezlinksgolf.com/tee-times?callback=handleResponse",
    "https://public-course.ezlinksgolf.com/tee-times?jsoncallback=handleResponse",
    "https://public-course.ezlinksgolf.com/tee-times?f=pjson",
    "https://public-course.ezlinksgolf.com/tee-times?format=application%2Fjson-seq",
    "https://public-course.ezlinksgolf.com/tee-times?jsonp=handleResponse",
    "https://public-course.ezlinksgolf.com/tee-times?path=%2Fapi%2Fv1"
  ])("does not select labeled provider infrastructure %s", (providerConfigUrl) => {
    const sourceUrl = "https://public-course.example/";
    const bookingWrapperUrl = "https://public-course.example/book-now/";
    const discovery = buildBrowserDiscovery({
      courseId: "public-course",
      courseName: "Public Course Golf Club",
      sourceUrl,
      observedUrls: [bookingWrapperUrl, providerConfigUrl],
      officialPage: {
        url: sourceUrl,
        linkCandidates: [
          { url: bookingWrapperUrl, label: "Book now" },
          { url: providerConfigUrl, label: "Book now" }
        ],
        courseName: "Public Course Golf Club",
        visibleText: "Public Course Golf Club tee times"
      },
      visibleText: "Book tee times online"
    });

    expect(discovery.bookingUrl).toBe(bookingWrapperUrl);
    expect(discovery.bookingUrl).not.toBe(providerConfigUrl);
  });

  it.each([
    "https://apipublic.ezlinksgolf.com/tee-times",
    "https://public-course.ezlinksgolf.com/tee-times.jsonp",
    "https://public-course.ezlinksgolf.com/tee-times?endpoint=api-v1",
    "https://public-course.book.teeitup.golf/?course=24680&course=99999",
    "https://public-course.book.teeitup.golf/?course=24680&date=2026-99-99",
    "https://public-course.book.teeitup.golf/?course=24680&players=999999999&holes=999&max=999999999",
    "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR&module=XX&secondarycode=25&secondarycode=99",
    "https://capitalhillsny.cps.golf/onlineresweb/search-teetime?CourseId=999999999999999999999999"
  ])(
    "does not let generic URL scoring select a direct provider infrastructure CTA %s",
    (providerInfrastructureUrl) => {
      const sourceUrl = "https://public-course.example/";
      const discovery = buildBrowserDiscovery({
        courseId: "public-course",
        courseName: "Public Course Golf Club",
        sourceUrl,
        finalUrl: sourceUrl,
        observedUrls: [sourceUrl, providerInfrastructureUrl],
        officialPage: {
          url: sourceUrl,
          linkCandidates: [
            { url: providerInfrastructureUrl, label: "Book now" }
          ],
          courseName: "Public Course Golf Club",
          visibleText: "Public Course Golf Club tee times"
        },
        visibleText: "Book tee times online"
      });

      expect(discovery.bookingUrl).not.toBe(providerInfrastructureUrl);
    }
  );

  it("prefers a Chelsea reservation surface over tee-time wording in event URLs", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "dennis-highlands",
      courseName: "Dennis Highland Course",
      sourceUrl: "https://www.dennisgolf.com/",
      finalUrl: "https://dennis.chelseareservations.com/",
      observedUrls: [
        "https://www.dennisgolf.com/dennis-golf-event/junior-championship-tee-times-tbd/",
        "https://dennis.chelseareservations.com/GPInprocess"
      ],
      visibleText: "Book tee times"
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "CUSTOM",
      bookingUrl: "https://dennis.chelseareservations.com/",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      apiMetadata: {
        provider: "CHELSEA",
        bookingBaseUrl: "https://dennis.chelseareservations.com/",
        courseCode: 2,
        courseLabel: "Highland"
      }
    });
  });

  it("matches the named golf course instead of colocated Teesnap range inventory", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "course-southers-marsh",
      courseName: "Southers Marsh Golf Club",
      sourceUrl: "https://southersmarsh.com/",
      finalUrl: "https://southersmarsh.teesnap.net/",
      observedUrls: [
        "https://southersmarsh.com/teetimes/",
        "https://southersmarsh.teesnap.net/"
      ],
      visibleText:
        'window.courses = [{"id":1196,"name":"Top Tracer Range","core_id":1301,"holes_default":18,"addons_default":"off"},{"id":655,"name":"Southers Marsh Golf Club","core_id":761,"holes_default":18,"addons_default":"on"}]; window.property = {"id":599}'
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "CUSTOM",
      apiMetadata: {
        provider: "TEESNAP",
        courseId: 655,
        bookingBaseUrl: "https://southersmarsh.teesnap.net/",
        defaultHoles: 18,
        defaultAddons: "on"
      }
    });
  });

  it("selects one compatible physical TeeSnap course and excludes disc golf", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "sunset-ridge",
      courseName: "Sunset Ridge Golf Links",
      sourceUrl: "https://sunset-ridge.example/",
      observedUrls: ["https://sunsetridge.teesnap.net/"],
      visibleText:
        'window.courses = [{"id":412,"name":"Sunset Ridge","holes_default":18},{"id":413,"name":"Sunset Ridge Disc Golf","course_type":"disc_golf"}]; window.bookingReady = true;'
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      apiMetadata: {
        provider: "TEESNAP",
        courseId: 412,
        bookingBaseUrl: "https://sunsetridge.teesnap.net/",
        defaultHoles: 18
      }
    });
  });

  it("does not infer TeeSnap identity from a sole unnamed config", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "unnamed-teesnap-config",
      courseName: "Expected Public Golf Course",
      sourceUrl: "https://expected.example/",
      observedUrls: ["https://expected.teesnap.net/"],
      visibleText: 'window.courses = [{"id":412,"holes_default":18}]'
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe(
      "teesnap-url-without-course-id:physical-course-config-missing"
    );
  });

  it("does not guess between multiple compatible physical TeeSnap courses", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "river-valley",
      courseName: "River Valley Golf Course",
      sourceUrl: "https://river-valley.example/",
      observedUrls: ["https://rivervalley.teesnap.net/"],
      visibleText:
        'window.courses = [{"id":41,"name":"River Valley North"},{"id":42,"name":"River Valley South"}];'
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe(
      "teesnap-url-without-course-id:course-config-ambiguous"
    );
  });

  it("enriches a public Teesnap page when the initial site crawl only found its URL", async () => {
    const discovery = buildBrowserDiscovery({
      courseId: "course-southers-marsh",
      courseName: "Southers Marsh Golf Club",
      sourceUrl: "https://southersmarsh.com/",
      observedUrls: ["https://southersmarsh.teesnap.net/"],
      visibleText: "Public tee times"
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        '<script>window.courses = [{"id":1196,"name":"Top Tracer Range","core_id":1301},{"id":655,"name":"Southers Marsh Golf Club","core_id":761,"holes_default":18,"addons_default":"on"}]; window.property = {"id":599};</script>',
        { status: 200, headers: { "content-type": "text/html" } }
      )
    );

    const enriched = await enrichTeesnapDiscovery(
      discovery,
      "Southers Marsh Golf Club",
      fetchImpl as typeof fetch
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://southersmarsh.teesnap.net/",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "text/html,application/xhtml+xml;q=0.9",
          "User-Agent": expect.stringContaining("Mozilla/5.0")
        }),
        redirect: "manual"
      })
    );
    expect(enriched).toMatchObject({
      status: "LEARNED",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      apiMetadata: {
        provider: "TEESNAP",
        courseId: 655,
        bookingBaseUrl: "https://southersmarsh.teesnap.net/",
        defaultHoles: 18,
        defaultAddons: "on"
      },
      evidence: { learnedFrom: "teesnap-public-course-config" }
    });
  });

  it("records a bounded reason when public TeeSnap config has no course data", async () => {
    const discovery = buildBrowserDiscovery({
      courseId: "missing-teesnap-config",
      courseName: "Missing TeeSnap Config Golf Course",
      sourceUrl: "https://missing.example/",
      observedUrls: ["https://missing.teesnap.net/"]
    });
    const enriched = await enrichTeesnapDiscovery(
      discovery,
      "Missing TeeSnap Config Golf Course",
      vi.fn().mockResolvedValue(
        new Response("<html><body>Public tee times</body></html>", { status: 200 })
      ) as typeof fetch
    );

    expect(enriched.status).toBe("INSPECTED");
    expect(enriched.apiMetadata).toBeUndefined();
    expect(enriched.evidence.learnedFrom).toBe(
      "teesnap-public-config-course-config-missing"
    );
  });

  it("classifies explicit official private-club access without a public adapter", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "old-sandwich",
      courseName: "Old Sandwich Golf Club",
      sourceUrl: "https://www.osgolfclub.com/public",
      finalUrl: "https://www.osgolfclub.com/public/guest-information",
      observedUrls: [
        "https://www.osgolfclub.com/public",
        "https://www.osgolfclub.com/public/guest-information"
      ],
      visibleText:
        "Old Sandwich Golf Club is a private club available to Local and National members. Club property is accessible to members and their guests, and guests may not remain without a member."
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER",
      confidence: 0.98,
      evidence: { learnedFrom: "official-private-club-access" }
    });
  });

  it("classifies an official private golf course limited to members and guests", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "great-neck",
      courseName: "Great Neck Country Club",
      sourceUrl: "https://www.greatneckgolf.com/",
      observedUrls: [
        "https://www.greatneckgolf.com/",
        "https://www.greatneckgolf.com/golf/membership",
        "https://www.greatneckgolf.com/golf/guests"
      ],
      visibleText:
        "Great Neck Country Club is an award-winning private 18 hole golf course. Our restaurant is open to the public. The golf course is open to our members and their guests."
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER",
      confidence: 0.98,
      evidence: { learnedFrom: "official-private-club-access" }
    });
  });

  it("retains Whoosh terms as evidence without blocking public read-only monitoring", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "yale",
      courseName: "Yale University Golf Course",
      sourceUrl: "https://yalebulldogs.com/sports/2026/2/24/yale-golf-course.aspx",
      finalUrl: "https://app.whoosh.io/patron/club/yale-golf-course",
      observedUrls: [
        "https://yalebulldogs.com/sports/2026/2/27/faqs.aspx",
        "https://app.whoosh.io/patron/club/yale-golf-course"
      ],
      providerPolicyUrl: "https://www.whoosh.io/terms",
      providerPolicyText:
        "Attempt to access or search the Whoosh Platform or Content or download Content through the use of any engine, software, tool, agent, device or mechanism (including spiders, robots, crawlers, data mining tools or the like) other than the software and search agents provided by Whoosh.",
      visibleText:
        "Players must register in Whoosh before booking. Once a player’s registration is confirmed, availability of tee times through Whoosh can be viewed once booking windows open."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "CUSTOM",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingUrl: "https://app.whoosh.io/patron/club/yale-golf-course",
      apiMetadata: {
        provider: "WHOOSH",
        clubSlug: "yale-golf-course",
        bookingBaseUrl: "https://app.whoosh.io/patron/club/yale-golf-course"
      },
      confidence: 0.95,
      evidence: { learnedFrom: "official-whoosh-booking-policy-evidence" }
    });
  });

  it("classifies Whoosh as account-required when the booking surface itself gates availability", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "gated-whoosh",
      courseName: "Gated Whoosh Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://app.whoosh.io/patron/club/gated-course"],
      visibleText: "Register and book online with Whoosh.",
      bookingSurfaceText:
        "Players must register in Whoosh before booking. Once a player's registration is confirmed, availability of tee times through Whoosh can be viewed."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      detectedPlatform: "CUSTOM",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      bookingAccessMode: "ACCOUNT_REQUIRED",
      evidence: { learnedFrom: "official-account-required-booking" }
    });
  });

  it("classifies official first-time staff setup without calling a public course private", () => {
    const officialUrl =
      "https://public-course.example/golf/play/book-a-tee-time.html";
    const discovery = buildBrowserDiscovery({
      courseId: "staff-provisioned",
      courseName: "Example Public Golf Course",
      sourceUrl: officialUrl,
      finalUrl: officialUrl,
      observedUrls: [officialUrl],
      bookingCallToAction: true,
      visibleText:
        "New to the Course? If you have never played here or are not a member, our team will help. To gain access and book your first tee time, please contact the Golf Shop or Reservations. They will assist with setting up your access."
    });

    expect(discovery).toMatchObject({
      isPublic: true,
      status: "VERIFIED",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      bookingAccessMode: "ACCOUNT_STAFF_PROVISIONED",
      bookingUrl: officialUrl,
      evidence: {
        learnedFrom: "official-staff-provisioned-account-access"
      }
    });
  });

  it("classifies self-service registration only from the observed booking surface", () => {
    const officialUrl = "https://public-course.example/tee-times";
    const discovery = buildBrowserDiscovery({
      courseId: "self-service",
      courseName: "Example Public Golf Course",
      sourceUrl: officialUrl,
      finalUrl: officialUrl,
      observedUrls: [officialUrl],
      bookingCallToAction: true,
      bookingSurfaceText:
        "Create an account to book tee times. Sign in to view tee-time availability."
    });

    expect(discovery).toMatchObject({
      isPublic: true,
      status: "VERIFIED",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      bookingAccessMode: "ACCOUNT_SELF_SERVICE",
      evidence: {
        learnedFrom: "official-self-service-account-access"
      }
    });
  });

  it("preserves direct public Whoosh booking while keeping policy evidence non-terminal", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "public-whoosh",
      courseName: "Example Public Golf Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://app.whoosh.io/patron/club/example-public-course"],
      providerPolicyText:
        "Attempt to search the Whoosh Platform or Content through the use of any engine, software, tool, agent, device or mechanism, including spiders, robots, crawlers, or data mining tools.",
      visibleText:
        "Public tee-time availability is visible to everyone. Players must register in Whoosh before booking."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      evidence: { learnedFrom: "official-whoosh-booking-policy-evidence" }
    });
  });

  it("learns reusable Whoosh metadata from the exact public club landing", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "unverified-whoosh",
      courseName: "Example Whoosh Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://app.whoosh.io/patron/club/example-course"],
      visibleText: "Public online booking with Whoosh."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        provider: "WHOOSH",
        clubSlug: "example-course",
        bookingBaseUrl: "https://app.whoosh.io/patron/club/example-course"
      },
      evidence: { learnedFrom: "official-whoosh-booking" }
    });
  });

  it("classifies explicit official first-come golf access as walk-in only", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "goose-run",
      courseName: "Goose Run Golf Course",
      sourceUrl:
        "https://www.navymwrnewlondon.com/programs/493b6c83-491b-4243-b9a1-f0090f288fb2",
      finalUrl:
        "https://www.navymwrnewlondon.com/programs/493b6c83-491b-4243-b9a1-f0090f288fb2",
      observedUrls: [
        "https://www.navymwrnewlondon.com/programs/493b6c83-491b-4243-b9a1-f0090f288fb2"
      ],
      visibleText:
        "Tee times are not neccessary at Goose Run, golf is on a first come, first serve basis. Online Golf Round Payment."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "WALK_IN",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      confidence: 0.98,
      evidence: { learnedFrom: "official-walk-in-access" }
    });
  });

  it("classifies an official public course that does not take tee times", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "sunset-hill",
      courseName: "Sunset Hill Golf Club",
      sourceUrl: "https://www.sunsethillgolfclub.com/",
      finalUrl: "https://www.sunsethillgolfclub.com/",
      observedUrls: ["https://www.sunsethillgolfclub.com/"],
      visibleText:
        "Home - Sunset Hill Golf Club. Skip to content. Sunset Hill Golf Club. The Friendly Place to Play. 9 Hole Public Golf Course. We are open for the 2026 Season! Please Note: We do not take tee times, but are on a first come, first served basis."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "WALK_IN",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      confidence: 0.98,
      evidence: { learnedFrom: "official-walk-in-access" }
    });
  });

  it("classifies and replays an exact official private course profile", () => {
    const sourceUrl = "https://community.example/golf/deer-creek";
    const discovery = buildBrowserDiscovery({
      courseId: "deer-creek-private-profile",
      courseName:
        "Deer Creek Golf Course at The Landings Golf & Athletic Club",
      sourceUrl: "https://community.example/",
      finalUrl: sourceUrl,
      observedUrls: ["https://community.example/", sourceUrl],
      officialPage: {
        url: sourceUrl,
        courseName:
          "Deer Creek Golf Course at The Landings Golf & Athletic Club",
        linkCandidates: [],
        visibleText:
          "Deer Creek\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
      },
      visibleText:
        "Deer Creek\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      sourceUrl,
      bookingUrl: sourceUrl,
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER",
      evidence: { learnedFrom: "official-private-course-profile" }
    });
    expect(evaluateBrowserDiscoveryMonitoringGate(discovery)).toMatchObject({
      disposition: "IDENTITY_FINAL",
      adapterAllowed: false
    });

    const replay = buildBrowserDiscovery({
      courseId: "deer-creek-private-profile-replay",
      courseName:
        "Deer Creek Golf Course at The Landings Golf & Athletic Club",
      sourceUrl: discovery.sourceUrl,
      finalUrl: discovery.evidence.finalUrl,
      observedUrls: discovery.evidence.observedUrls,
      visibleText: discovery.evidence.visibleText
    });
    expect(replay).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER",
      evidence: { learnedFrom: "official-private-course-profile" }
    });
  });

  it("keeps an exact structured private profile final even when the page links to a runnable provider", () => {
    const officialWebsite = "https://community.example/";
    const sourceUrl = "https://community.example/golf/deer-creek";
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes";
    const apiUrl =
      "https://foreupsoftware.com/index.php/api/booking/times?time=all&date=07-21-2026&holes=all&players=2&schedule_id=11739&booking_class=22739";
    const privateProfile =
      "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA";

    const discovery = buildBrowserDiscovery({
      courseId: "deer-creek-provider-contradiction",
      courseName:
        "Deer Creek Golf Course at The Landings Golf & Athletic Club",
      sourceUrl,
      finalUrl: sourceUrl,
      officialCourseWebsite: officialWebsite,
      observedUrls: [sourceUrl, bookingUrl, apiUrl],
      officialPage: {
        url: sourceUrl,
        courseName:
          "Deer Creek Golf Course at The Landings Golf & Athletic Club",
        linkCandidates: [{ url: bookingUrl, label: "Book tee times" }],
        observedUrls: [bookingUrl, apiUrl],
        visibleText: privateProfile
      },
      visibleText: privateProfile
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingUrl: sourceUrl,
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER",
      evidence: {
        learnedFrom: "official-private-course-profile"
      }
    });
    expect(discovery.evidence.courseIdentityCorroboration).toBeUndefined();
  });

  it("does not let a mismatched sibling page provider link reopen a private course", () => {
    const sourceUrl = "https://community.example/golf/deer-creek";
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes";
    const apiUrl =
      "https://foreupsoftware.com/index.php/api/booking/times?schedule_id=11739&booking_class=22739";
    const discovery = buildBrowserDiscovery({
      courseId: "deer-creek-sibling-provider",
      courseName: "Deer Creek Golf Course",
      sourceUrl,
      finalUrl: sourceUrl,
      officialCourseWebsite: "https://community.example/",
      observedUrls: [sourceUrl, bookingUrl, apiUrl],
      officialPage: {
        url: sourceUrl,
        courseName: "Sibling Hills Golf Course",
        linkCandidates: [{ url: bookingUrl, label: "Book tee times" }],
        observedUrls: [bookingUrl, apiUrl],
        visibleText: "Sibling Hills Golf Course tee times"
      },
      visibleText:
        "Deer Creek Golf Course is a private club available only to members and their guests."
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "UNKNOWN",
      evidence: { learnedFrom: "official-private-club-access" }
    });
    expect(discovery.evidence.courseIdentityCorroboration).toBeUndefined();
  });

  it("fails closed when private text is paired with two distinct runnable provider families", () => {
    const sourceUrl = "https://community.example/golf/deer-creek";
    const foreupUrl =
      "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes";
    const foreupApiUrl =
      "https://foreupsoftware.com/index.php/api/booking/times?schedule_id=11739&booking_class=22739";
    const teeItUpUrl = "https://deer-creek.book.teeitup.golf/";
    const privateProfile =
      "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA";
    const discovery = buildBrowserDiscovery({
      courseId: "deer-creek-ambiguous-providers",
      courseName: "Deer Creek Golf Course",
      sourceUrl,
      finalUrl: sourceUrl,
      officialCourseWebsite: "https://community.example/",
      observedUrls: [sourceUrl, foreupUrl, foreupApiUrl, teeItUpUrl],
      officialPage: {
        url: sourceUrl,
        courseName: "Deer Creek Golf Course",
        linkCandidates: [
          { url: foreupUrl, label: "Book with ForeUP" },
          { url: teeItUpUrl, label: "Book with TeeItUp" }
        ],
        observedUrls: [foreupUrl, foreupApiUrl, teeItUpUrl],
        visibleText: privateProfile
      },
      visibleText: privateProfile
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "UNKNOWN",
      evidence: { learnedFrom: "official-private-course-profile" }
    });
  });

  it.each([
    {
      label: "the structured status is public",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Public\nLocation: Savannah, GA"
    },
    {
      label: "the profile belongs to a sibling course",
      profile:
        "Sibling Hills Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "public play contradicts the private status",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA\nPublic tee times are available online."
    },
    {
      label: "public golfers are explicitly welcome",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA\nPublic golfers are welcome."
    },
    {
      label: "the course is semi-private",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA\nThis is a semi-private club."
    },
    {
      label: "the golf course is open to everyone",
      profile:
        "The golf course is open to everyone.\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "the golf course is open to resort guests and the public",
      profile:
        "The golf course is open to resort guests and the public.\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "the public is welcome to play the golf course",
      profile:
        "The public is welcome to play the golf course.\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "an account status appears outside a course profile",
      profile:
        "Deer Creek member portal. Architect: Tom Fazio. Account Status: Private. Location: Savannah, GA."
    },
    {
      label: "a nearer sibling profile owns the private status",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nSibling Hills Details\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a nearer membership-account section owns the private status",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nMembership Account Details\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "the page identifies a public golf course",
      profile:
        "Deer Creek is a public golf course.\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "the page identifies a public course",
      profile:
        "Deer Creek is a public course.\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a municipal course is open to all golfers",
      profile:
        "This municipal golf course is open to all golfers.\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "the page publishes Unicode-hyphen daily-fee play",
      profile:
        "Deer Creek offers daily‑fee play.\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "the page publishes soft-hyphen daily-fee play",
      profile:
        "Deer Creek offers daily­fee play.\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a sibling golf-course heading intervenes",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nSibling Hills Golf Course\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a short sibling heading intervenes",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nThe Lakes\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a member portal heading intervenes",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nMember Portal\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a membership account heading intervenes",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nMembership Account\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "an empty architect field consumes a sibling heading",
      profile:
        "Deer Creek Details\nArchitect:\nSibling Hills Golf Course\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "an empty architect field consumes a member portal heading",
      profile:
        "Deer Creek Details\nArchitect:\nMember Portal\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a longer sibling name contains the target alias",
      profile:
        "Deer Creek Championship Course Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "the parent club suffix is not a leading course alias",
      profile:
        "The Landings Golf & Athletic Club Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a shorter alias drops the target course layout",
      courseName: "Deer Creek North Golf Course",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a shorter alias drops an executive layout name",
      courseName: "Deer Creek Executive Golf Course",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a shorter alias drops a championship layout name",
      courseName: "Deer Creek Championship Golf Course",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a shorter alias drops a lakes layout name",
      courseName: "Deer Creek Lakes Golf Course",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a shorter alias drops a spelled numbered layout name",
      courseName: "Deer Creek Nine Golf Course",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a shorter alias drops a north course after at",
      courseName: "Deer Creek Golf Course at North Course",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a shorter alias drops an executive course after at",
      courseName: "Deer Creek at Executive Course",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a shorter alias drops a lakes course after at",
      courseName: "Deer Creek at Lakes Course",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a shorter alias drops a numeric course after at",
      courseName: "Deer Creek at Course 2",
      profile:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a country club profile conflicts with a golf course target",
      courseName: "Deer Creek Golf Course",
      profile:
        "Deer Creek Country Club Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a golf club profile conflicts with a golf course target",
      courseName: "Deer Creek Golf Course",
      profile:
        "Deer Creek Golf Club Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a golf course profile conflicts with a country club target",
      courseName: "Deer Creek Country Club",
      profile:
        "Deer Creek Golf Course Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a standalone club profile conflicts with a golf course target",
      courseName: "Deer Creek Golf Course",
      profile:
        "Deer Creek Club Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a golf course profile conflicts with a standalone club target",
      courseName: "Deer Creek Club",
      profile:
        "Deer Creek Golf Course Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    },
    {
      label: "a standalone links profile conflicts with a club target",
      courseName: "Deer Creek Club",
      profile:
        "Deer Creek Links Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    }
  ])("does not infer a private course profile when $label", ({ profile, courseName: suppliedCourseName }) => {
    const courseName = suppliedCourseName ??
      "Deer Creek Golf Course at The Landings Golf & Athletic Club";
    const sourceUrl = "https://community.example/golf/deer-creek";
    const discovery = buildBrowserDiscovery({
      courseId: "private-profile-negative",
      courseName,
      sourceUrl,
      finalUrl: sourceUrl,
      observedUrls: [sourceUrl],
      officialPage: {
        url: sourceUrl,
        courseName,
        linkCandidates: [],
        visibleText: profile
      },
      visibleText: profile
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("does not combine a target profile with a later aggregate status block", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "private-profile-aggregate-boundary",
      courseName:
        "Deer Creek Golf Course at The Landings Golf & Athletic Club",
      sourceUrl: "https://community.example/",
      observedUrls: ["https://community.example/"],
      visibleText:
        "Deer Creek Details. Architect: Tom Fazio. Stats: 7,094 Yards / Par 72. Established: 1991.\nStatus: Private. Location: Savannah, GA"
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it.each([
    {
      label: "the official page follows a cross-host redirect",
      sourceUrl: "https://official.example/",
      finalUrl: "https://untrusted.example/golf/deer-creek",
      officialPageUrl: "https://untrusted.example/golf/deer-creek"
    },
    {
      label: "the original source contains session state",
      sourceUrl: "https://official.example/?session_id=example-value",
      finalUrl: "https://official.example/golf/deer-creek",
      officialPageUrl: "https://official.example/golf/deer-creek"
    }
  ])("does not trust a private course profile when $label", ({
    sourceUrl,
    finalUrl,
    officialPageUrl
  }) => {
    const courseName =
      "Deer Creek Golf Course at The Landings Golf & Athletic Club";
    const profile =
      "Deer Creek\nDeer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA";
    const discovery = buildBrowserDiscovery({
      courseId: "private-profile-untrusted-source",
      courseName,
      sourceUrl,
      finalUrl,
      observedUrls: [sourceUrl, finalUrl],
      officialPage: {
        url: officialPageUrl,
        courseName,
        linkCandidates: [],
        visibleText: profile
      },
      visibleText: profile
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("classifies repeated weekday and weekend no-tee-time access as walk-in", () => {
    const sourceUrl = "http://www.quarry-view.example/";
    const discovery = buildBrowserDiscovery({
      courseId: "quarry-view",
      courseName: "Quarry View Golf Course",
      sourceUrl,
      finalUrl: "https://www.quarry-view.example/",
      observedUrls: [sourceUrl, "https://www.quarry-view.example/"],
      visibleText:
        "Quarry View Golf Course. Welcome to Quarry View Public Golf Course, Driving Range and Practice Center. This nine-hole course is open for daily-fee public play. Directions to Quarry View Golf Course. For Directions: Go. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. Weekdays. 9 Holes 15.00. 18 Holes 20.00. Weekends. 9 Holes 17.00. 18 Holes 22.00."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      sourceUrl: "https://www.quarry-view.example/",
      bookingUrl: "https://www.quarry-view.example/",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "WALK_IN",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      confidence: 0.98,
      evidence: {
        learnedFrom: "official-day-scoped-walk-in-access"
      }
    });
    expect(discovery.evidence.visibleText).toContain(
      "Weekdays: Tee times not needed"
    );
    expect(discovery.evidence.visibleText).toContain(
      "Weekends: Tee times not needed"
    );
  });

  it("ignores a standalone generic golf-center navigation label in walk-in evidence", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "quarry-view-generic-navigation",
      courseName: "Quarry View Golf Course",
      sourceUrl: "https://www.quarry-view.example/",
      finalUrl: "https://www.quarry-view.example/",
      observedUrls: ["https://www.quarry-view.example/"],
      visibleText:
        "Quarry View Golf Course\nWelcome to Quarry View Public Golf Course\nThis nine-hole course is open for daily-fee public play\nGolf Center\nDirections to Quarry View Golf Course\nFor Directions: Go\nStarting Times\nWeekdays: Tee times not needed.\nWeekends: Tee times not needed.\nFees\n9 Holes 15.00\n18 Holes 20.00"
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "WALK_IN",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      evidence: {
        learnedFrom: "official-day-scoped-walk-in-access"
      }
    });

    const replay = buildBrowserDiscovery({
      courseId: "quarry-view-generic-navigation-replay",
      courseName: "Quarry View Golf Course",
      sourceUrl: discovery.sourceUrl,
      finalUrl: discovery.evidence.finalUrl,
      observedUrls: discovery.evidence.observedUrls,
      visibleText: discovery.evidence.visibleText
    });
    expect(replay).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "WALK_IN",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      evidence: {
        learnedFrom: "official-day-scoped-walk-in-access"
      }
    });
  });

  it("does not ignore a generic golf-center phrase embedded in another line", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "quarry-view-inline-generic-identity",
      courseName: "Quarry View Golf Course",
      sourceUrl: "https://www.quarry-view.example/",
      finalUrl: "https://www.quarry-view.example/",
      observedUrls: ["https://www.quarry-view.example/"],
      visibleText:
        "Quarry View Golf Course\nWelcome to Quarry View Public Golf Course\nThis nine-hole course is open for daily-fee public play\nWelcome to Golf Center\nDirections to Quarry View Golf Course\nStarting Times\nWeekdays: Tee times not needed.\nWeekends: Tee times not needed.\nFees\n9 Holes 15.00\n18 Holes 20.00"
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it.each([
    {
      label: "only one day is corroborated",
      visibleText:
        "Quarry View Golf Course is a public nine-hole daily-fee course. Starting Times. Weekdays: Tee times not needed; play is first-come, first-served. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "the statements belong to a sibling course",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. Sibling Hills Golf Course Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "the statements describe a practice range",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. Driving Range Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "an abbreviated sibling section intervenes",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. South Course Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a non-directional sibling section intervenes",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. Lakeside Course Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a sibling title omits the word course",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. River Bend Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a lowercase sibling heading intervenes",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. lakes course Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a numeric sibling heading intervenes",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. South 9 Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a numbered course heading intervenes",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. Course No. 2 Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a sibling owner follows the heading",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. Starting Times: Executive Course. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a single-word sibling owner precedes the heading",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. Lakeside Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a punctuated sibling owner precedes the heading",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. South Course. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a semicolon-terminated sibling owner precedes the heading",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. river bend; Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a punctuated numbered owner precedes the heading",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. Course No. 2. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a named sibling has a generic physical-course description",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. South Course is a public nine-hole daily-fee course. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a sibling description begins with the word the",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. The Lakes is a public eighteen-hole course. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a sibling name follows the generic word course",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. The course at South Park is a public nine-hole daily-fee course. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a sibling owner is followed by a generic navigation label",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. South Course. Home. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a sibling heading is separated only by HTML text lines",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course\nSouth Course\nStarting Times\nWeekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a sibling and target share one owner segment",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. South Course at Target Municipal Golf Course Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a sibling heading uses pipe boundaries",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course | South Course | Starting Times | Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "weekday and weekend statements belong to different owners",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. Directions to Target Municipal Golf Course. Starting Times. Weekdays: Tee times not needed. South Course. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "a second starting-times section separates the statements",
      visibleText:
        "Target Municipal Golf Course is a public nine-hole daily-fee course. Directions to Target Municipal Golf Course. Starting Times. Weekdays: Tee times not needed. South Course. Starting Times. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    },
    {
      label: "the statements contain time-of-day qualifiers",
      visibleText:
        "Quarry View Golf Course is a public nine-hole daily-fee course. Starting Times. Weekdays: Tee times not needed after 5 PM. Weekends: Tee times not needed before noon. Fees. 9 Holes 15.00. 18 Holes 20.00."
    }
  ])("does not infer walk-in course access when $label", ({ visibleText }) => {
    const discovery = buildBrowserDiscovery({
      courseId: "day-scoped-walk-in-negative",
      courseName: visibleText.startsWith("Quarry")
        ? "Quarry View Golf Course"
        : "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf/",
      finalUrl: "https://parks.example/golf/",
      observedUrls: ["https://parks.example/golf/"],
      visibleText
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("keeps online booking stronger than repeated no-tee-time wording", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "day-scoped-walk-in-online",
      courseName: "Quarry View Golf Course",
      sourceUrl: "https://quarry-view.example/",
      finalUrl: "https://quarry-view.example/",
      observedUrls: [
        "https://quarry-view.example/",
        "https://quarry-view.example/tee-times"
      ],
      linkCandidates: [{
        url: "https://quarry-view.example/tee-times",
        label: "Book Tee Times Online"
      }],
      visibleText:
        "Quarry View Golf Course is a public nine-hole daily-fee course. Directions to Quarry View Golf Course. For Directions: Go. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it.each([
    {
      label: "an observed tee-time route has no link label",
      observedUrls: [
        "https://quarry-view.example/",
        "https://quarry-view.example/tee-times"
      ],
      suffix: ""
    },
    {
      label: "a full-page online CTA falls outside the persisted proof excerpt",
      observedUrls: ["https://quarry-view.example/"],
      suffix:
        `${" Course conditions and public-play details.".repeat(40)} Book tee times online now.`
    }
  ])("does not hide online booking when $label", ({ observedUrls, suffix }) => {
    const discovery = buildBrowserDiscovery({
      courseId: "day-scoped-walk-in-online-contradiction",
      courseName: "Quarry View Golf Course",
      sourceUrl: "https://quarry-view.example/",
      finalUrl: "https://quarry-view.example/",
      observedUrls,
      visibleText:
        `Quarry View Golf Course is a public nine-hole daily-fee course. Directions to Quarry View Golf Course. For Directions: Go. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00.${suffix}`
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it.each([
    {
      label: "an account route is redirected to the homepage",
      sourceUrl: "http://quarry-view.example/account/login",
      finalUrl: "https://quarry-view.example/"
    },
    {
      label: "a sensitive query is redirected to the homepage",
      sourceUrl: "http://quarry-view.example/?session_id=example-value",
      finalUrl: "https://quarry-view.example/"
    },
    {
      label: "an HTTP course route redirects to a different facility route",
      sourceUrl: "http://quarry-view.example/course",
      finalUrl: "https://quarry-view.example/practice-range"
    },
    {
      label: "an HTTPS course route redirects to an events route",
      sourceUrl: "https://quarry-view.example/course",
      finalUrl: "https://quarry-view.example/events"
    },
    {
      label: "an HTTPS course page is downgraded to HTTP",
      sourceUrl: "https://quarry-view.example/",
      finalUrl: "http://quarry-view.example/"
    }
  ])("does not trust walk-in evidence when $label", ({ sourceUrl, finalUrl }) => {
    const discovery = buildBrowserDiscovery({
      courseId: "day-scoped-walk-in-untrusted-transition",
      courseName: "Quarry View Golf Course",
      sourceUrl,
      finalUrl,
      observedUrls: [sourceUrl, finalUrl],
      visibleText:
        "Quarry View Golf Course is a public nine-hole daily-fee course. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("does not borrow walk-in text from a cross-host page labeled by an official URL", () => {
    const sourceUrl = "https://quarry-view.example/";
    const discovery = buildBrowserDiscovery({
      courseId: "day-scoped-walk-in-cross-host",
      courseName: "Quarry View Golf Course",
      sourceUrl,
      finalUrl: "https://unrelated.example/events",
      observedUrls: [sourceUrl, "https://unrelated.example/events"],
      officialPage: {
        url: sourceUrl,
        courseName: "Quarry View Golf Course",
        linkCandidates: [],
        visibleText:
          "Quarry View Golf Course is a public nine-hole daily-fee course."
      },
      visibleText:
        "Quarry View Golf Course is a public nine-hole daily-fee course. Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();

    const replayed = buildBrowserDiscovery({
      courseId: "day-scoped-walk-in-cross-host",
      courseName: "Quarry View Golf Course",
      sourceUrl: discovery.sourceUrl,
      ...(discovery.evidence.finalUrl
        ? { finalUrl: discovery.evidence.finalUrl }
        : {}),
      observedUrls: discovery.evidence.observedUrls,
      ...(discovery.evidence.visibleText
        ? { visibleText: discovery.evidence.visibleText }
        : {}),
      ...(discovery.evidence.bookingCallToAction !== undefined
        ? { bookingCallToAction: discovery.evidence.bookingCallToAction }
        : {})
    });
    expect(replayed.status).toBe("INSPECTED");
    expect(replayed.bookingMethod).toBeUndefined();
    expect(replayed.automationEligibility).toBeUndefined();
  });

  it("does not borrow a distant practice-range starting-times section", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "day-scoped-walk-in-distant-range",
      courseName: "Quarry View Golf Course",
      sourceUrl: "https://quarry-view.example/",
      finalUrl: "https://quarry-view.example/",
      observedUrls: ["https://quarry-view.example/"],
      visibleText:
        `Quarry View Golf Course is a public nine-hole daily-fee course. Driving Range ${"Range access details ".repeat(20)} Starting Times. Weekdays: Tee times not needed. Weekends: Tee times not needed. Fees. 9 Holes 15.00. 18 Holes 20.00.`
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it.each([
    "Sibling Hills Golf Course",
    "sibling hills golf course"
  ])("does not borrow a sibling course's no-tee-time statement (%s)", (siblingName) => {
    const discovery = buildBrowserDiscovery({
      courseId: "target-municipal",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf/",
      observedUrls: ["https://parks.example/golf/"],
      visibleText:
        `Target Municipal Golf Course is a public nine-hole course. ${siblingName} does not take tee times and is first come, first served.`
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("classifies an official course page that explicitly uses no tee times", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: "https://www.delcopa.gov/parks/clayton",
      finalUrl: "https://www.delcopa.gov/parks/clayton",
      observedUrls: ["https://www.delcopa.gov/parks/clayton"],
      visibleText:
        "Clayton Park Golf Course is a public nine-hole course. Open daily, weather permitting. No tee times. Call the course office with questions."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "WALK_IN",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      confidence: 0.98,
      evidence: { learnedFrom: "official-no-tee-times-access" }
    });
  });

  it.each([
    "No tee times needed",
    "No tee time reservation needed"
  ])("classifies first-come official course copy phrased as %s", (noTeeTimeCopy) => {
    const discovery = buildBrowserDiscovery({
      courseId: "fairlawn",
      courseName: "Fairlawn Golf Course",
      sourceUrl: "https://www.fairlawngolfri.com/the-course/",
      finalUrl: "https://www.fairlawngolfri.com/the-course/",
      observedUrls: ["https://www.fairlawngolfri.com/the-course/"],
      visibleText:
        `Fairlawn Golf Course is a public 9-hole Executive course. First come, first serve, ${noTeeTimeCopy}.`
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "WALK_IN",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      confidence: 0.98,
      evidence: { learnedFrom: "official-walk-in-access" }
    });
  });

  it("classifies the reviewed no-tee-times page without borrowing park or permit content", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: "https://www.delcopa.gov/parks/clayton",
      finalUrl: "https://www.delcopa.gov/parks/permits-forms",
      observedUrls: [
        "https://www.delcopa.gov/parks/clayton",
        "https://www.delcopa.gov/parks/permits-forms"
      ],
      linkCandidates: [
        {
          url: "https://www.delcopa.gov/parks/permits-forms",
          label: "Reservations and Permits"
        },
        {
          url: "https://www.delcopa.gov/parks/permits-forms/reservations",
          label: "Book a pavilion online"
        },
        {
          url: "https://accounts.example.gov/login?session=synthetic-session",
          label: "Employee login"
        }
      ],
      officialPage: {
        url: "https://www.delcopa.gov/parks/clayton",
        courseName: "Clayton Park Golf Course",
        linkCandidates: [
          {
            url: "https://www.delcopa.gov/parks/permits-forms",
            label: "Reservations and Permits"
          },
          {
            url: "https://accounts.example.gov/login?session=synthetic-session",
            label: "Employee login"
          }
        ],
        visibleText:
          "Clayton Park Golf Course The fairways of Clayton Golf Course provide a challenging round for players of all levels. Golfers can sneak in a quick round of 9 holes. The course is open daily, weather permitting. Clayton Golf Course is open to the public. Only golfers are permitted on the course. Every golfer must have their own bag of clubs. No tee times. Call 267-386-1969 with questions."
      },
      visibleText:
        "Clayton Park Golf Course The fairways of Clayton Golf Course provide a challenging round for players of all levels. Golfers can sneak in a quick round of 9 holes. The course is open daily, weather permitting. Clayton Golf Course is open to the public. Only golfers are permitted on the course. Every golfer must have their own bag of clubs. No tee times. Call 267-386-1969 with questions. Pavilion reservations can be booked online from the permits page."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      sourceUrl: "https://www.delcopa.gov/parks/clayton",
      bookingUrl: "https://www.delcopa.gov/parks/clayton",
      bookingMethod: "WALK_IN",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      evidence: {
        finalUrl: "https://www.delcopa.gov/parks/clayton",
        learnedFrom: "official-no-tee-times-access"
      }
    });
  });

  it("does not treat a temporary empty tee-time result as a walk-in course", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: "https://booking.example/search",
      finalUrl: "https://booking.example/search",
      observedUrls: ["https://booking.example/search"],
      visibleText:
        "Clayton Park Golf Course is a public nine-hole course. Open daily. Choose another date. No tee times. Call the course office with questions."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not terminally classify bare no-tee-times copy on a search route", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: "https://booking.example/search",
      finalUrl: "https://booking.example/search",
      observedUrls: ["https://booking.example/search"],
      visibleText:
        "Clayton Park Golf Course is a public nine-hole course. Open daily, weather permitting. No tee times. Call the course office with questions."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it.each([
    "https://booking.example/golf",
    "https://parks.example/calendar",
    "https://parks.example/%73%6c%6f%74%73",
    "https://parks.example/onlineBooking",
    "https://parks.example/teeTimeSearch"
  ])("does not terminally classify no-tee-times copy on booking state %s", (url) => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: url,
      finalUrl: url,
      observedUrls: [url],
      visibleText:
        "Clayton Park Golf Course is a public nine-hole course. Open daily, weather permitting. No tee times. Call the course office with questions."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not apply a sibling course's no-tee-times rule to the target course", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "target-municipal",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf",
      finalUrl: "https://parks.example/golf",
      observedUrls: ["https://parks.example/golf"],
      visibleText:
        "Target Municipal Golf Course is a public nine-hole course. Westwoods is open daily. No tee times. Call the course office with questions."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not treat a similarly named country club as the target golf course", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: "https://parks.example/golf",
      finalUrl: "https://parks.example/golf",
      observedUrls: ["https://parks.example/golf"],
      visibleText:
        "Clayton Park Golf Course is a public nine-hole course. Clayton Country Club is open daily. No tee times. Call the course office with questions."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not classify no-tee-times copy when the page exposes a booking call to action", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: "https://parks.example/clayton",
      finalUrl: "https://parks.example/clayton",
      observedUrls: ["https://parks.example/clayton"],
      linkCandidates: [
        { url: "https://parks.example/booking", label: "Book Online" }
      ],
      officialPage: {
        url: "https://parks.example/clayton",
        linkCandidates: [
          { url: "https://parks.example/booking", label: "Book Online" }
        ]
      },
      visibleText:
        "Clayton Park Golf Course is a public nine-hole course. Open daily, weather permitting. No tee times. Call the course office with questions."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not apply no-tee-times copy from a driving-range section", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: "https://parks.example/clayton",
      finalUrl: "https://parks.example/clayton",
      observedUrls: ["https://parks.example/clayton"],
      visibleText:
        "Clayton Park Golf Course is a public nine-hole course. Driving range open daily. No tee times. Call the course office with questions."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not borrow no-tee-times corroboration from the following sibling section", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "target-municipal",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf",
      finalUrl: "https://parks.example/golf",
      observedUrls: ["https://parks.example/golf"],
      visibleText:
        "Target Municipal Golf Course is open daily. No tee times. Westwoods is a public nine-hole course. Call the course office with questions."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not treat a booking instruction as question-only contact", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: "https://parks.example/clayton",
      finalUrl: "https://parks.example/clayton",
      observedUrls: ["https://parks.example/clayton"],
      visibleText:
        "Clayton Park Golf Course is a public nine-hole course. Open daily, weather permitting. No tee times. Call the course office to book a tee time or with questions."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not treat phone-reservation copy as question-only contact", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "clayton-park",
      courseName: "Clayton Park Golf Course",
      sourceUrl: "https://parks.example/clayton",
      finalUrl: "https://parks.example/clayton",
      observedUrls: ["https://parks.example/clayton"],
      visibleText:
        "Clayton Park Golf Course is a public nine-hole course. Open daily, weather permitting. No tee times. Call the course office with questions or reservations."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not mistake a one-segment ForeUP booking id for a schedule id", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-westwoods",
      courseName: "Westwoods Golf Course",
      sourceUrl: "https://westwoodsgc.com/",
      finalUrl: "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
      observedUrls: [
        "https://foreupsoftware.com/index.php/booking/22518#/teetimes"
      ],
      visibleText: "Book a tee time"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.detectedPlatform).toBe("FOREUP");
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe("foreup-url-without-schedule");
  });

  it("learns the real ForeUP schedule from an API request behind a one-segment booking root", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-westwoods",
      courseName: "Westwoods Golf Course",
      sourceUrl: "https://westwoodsgc.com/",
      finalUrl: "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
      observedUrls: [
        "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
        "https://foreupsoftware.com/index.php/api/booking/times?date=07-17-2026&schedule_id=6123&booking_class=4455"
      ],
      visibleText: "Book a tee time"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("LEARNED");
    expect(discovery.apiMetadata).toEqual({
      scheduleId: 6123,
      bookingClassId: 4455,
      bookingBaseUrl:
        "https://foreupsoftware.com/index.php/booking/22518#/teetimes"
    });
  });

  it("classifies a ForeUP access denial without attempting to bypass it", () => {
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22518#/teetimes";
    const barrier = {
      url: "https://foreupsoftware.com/index.php/booking/22518",
      status: 403 as const
    };
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-westwoods",
      courseName: "Westwoods Golf Course",
      sourceUrl: bookingUrl,
      finalUrl: bookingUrl,
      observedUrls: [bookingUrl],
      accessBarriers: [barrier],
      corroboratedAccessBarrier: barrier,
      visibleText: "403 Forbidden"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      detectedPlatform: "FOREUP",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-access-control"
      }
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("keeps a first ForeUP access denial non-terminal", () => {
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22518#/teetimes";
    const discovery = buildBrowserDiscovery({
      courseId: "course-westwoods",
      courseName: "Westwoods Golf Course",
      sourceUrl: bookingUrl,
      finalUrl: bookingUrl,
      observedUrls: [bookingUrl],
      accessBarriers: [
        {
          url: "https://foreupsoftware.com/index.php/booking/22518",
          status: 403
        }
      ],
      visibleText: "403 Forbidden"
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "NONE",
      evidence: { learnedFrom: "foreup-access-control-unconfirmed" }
    });
  });

  it("never treats a denied ForeUP API response as runnable metadata", () => {
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22518#/teetimes";
    const apiUrl =
      "https://foreupsoftware.com/index.php/api/booking/times?schedule_id=6123&booking_class=4455&challenge_token=secret-value";
    const barrier = { url: apiUrl, status: 403 as const };
    const discovery = buildBrowserDiscovery({
      courseId: "course-westwoods",
      courseName: "Westwoods Golf Course",
      sourceUrl: bookingUrl,
      finalUrl: bookingUrl,
      observedUrls: [bookingUrl, apiUrl],
      accessBarriers: [barrier],
      corroboratedAccessBarrier: barrier,
      visibleText: "403 Forbidden"
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE"
    });
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.accessBarriers).toEqual([
      {
        url: "https://foreupsoftware.com/index.php/api/booking/times",
        status: 403
      }
    ]);
    expect(discovery.evidence.observedUrls).toContain(
      "https://foreupsoftware.com/index.php/api/booking/times"
    );
    expect(discovery.evidence.observedUrls.join(" ")).not.toContain(
      "challenge_token"
    );
    expect(discovery.evidence.observedUrls).not.toContain(apiUrl);
    expect(discovery.evidence.accessBarrierProviderIds).toEqual({
      scheduleId: 6123,
      bookingClassId: 4455
    });
  });

  it("distinguishes a repeated ForeUP authentication barrier", () => {
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22518#/teetimes";
    const barrier = { url: bookingUrl, status: 401 as const };
    const discovery = buildBrowserDiscovery({
      courseId: "course-westwoods",
      courseName: "Westwoods Golf Course",
      sourceUrl: bookingUrl,
      finalUrl: bookingUrl,
      observedUrls: [bookingUrl],
      accessBarriers: [barrier],
      corroboratedAccessBarrier: barrier
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      automationReason: "ACCOUNT_REQUIRED"
    });
  });

  it("corroborates a barrier only against matching prior technical evidence", () => {
    const barrier = {
      url: "https://foreupsoftware.com/index.php/booking/22518",
      status: 403 as const
    };

    expect(
      findCorroboratingAccessBarrier(
        {
          visibleText: "403 Forbidden",
          observedUrls: [barrier.url]
        },
        [barrier]
      )
    ).toEqual(barrier);
    expect(
      findCorroboratingAccessBarrier(
        {
          accessBarriers: [{ ...barrier, status: 401 }]
        },
        [barrier]
      )
    ).toBeNull();
  });

  it("classifies only the exact current ForeUP barrier corroborated by prior evidence", () => {
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22518#/teetimes";
    const apiUrl =
      "https://foreupsoftware.com/index.php/api/booking/times?schedule_id=6123";
    const bookingBarrier = { url: bookingUrl, status: 403 as const };
    const apiBarrier = { url: apiUrl, status: 401 as const };
    const currentBarriers = [bookingBarrier, apiBarrier];
    const corroboratedAccessBarrier = findCorroboratingAccessBarrier(
      { accessBarriers: [apiBarrier] },
      currentBarriers
    );

    expect(corroboratedAccessBarrier).toEqual(apiBarrier);

    const discovery = buildBrowserDiscovery({
      courseId: "course-westwoods",
      courseName: "Westwoods Golf Course",
      sourceUrl: bookingUrl,
      finalUrl: bookingUrl,
      observedUrls: [bookingUrl, apiUrl],
      accessBarriers: currentBarriers,
      corroboratedAccessBarrier: corroboratedAccessBarrier ?? undefined
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      evidence: {
        accessBarriers: [
          {
            url: "https://foreupsoftware.com/index.php/api/booking/times",
            status: 401
          }
        ]
      }
    });
  });

  it("retains automation-policy text as non-terminal discovery evidence", () => {
    const legacyPolicyBlock = {
      courseId: "course-whoosh",
      status: "VERIFIED" as const,
      detectedPlatform: "CUSTOM" as const,
      sourceUrl: "https://example.com/tee-times",
      bookingUrl: "https://app.whoosh.io/patron/club/public-course",
      bookingMethod: "PUBLIC_ONLINE" as const,
      automationEligibility: "BLOCKED" as const,
      automationReason: "AUTOMATION_PROHIBITED" as const,
      confidence: 0.99,
      evidence: {
        observedUrls: ["https://app.whoosh.io/patron/club/public-course"],
        learnedFrom: "legacy-policy-block"
      }
    };

    expect(legacyPolicyBlock).toMatchObject({
      status: "VERIFIED",
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED"
    });

    const actionable = keepPolicyOnlyDiscoveryActionable(legacyPolicyBlock);
    expect(actionable).toMatchObject({
      status: "VERIFIED",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "AUTOMATION_PROHIBITED",
      bookingUrl: "https://app.whoosh.io/patron/club/public-course",
      confidence: 0.95,
      evidence: {
        learnedFrom: "legacy-policy-block:policy-evidence-only"
      }
    });
    expect(evaluateBrowserDiscoveryMonitoringGate(actionable)).toMatchObject({
      disposition: "ACTIONABLE",
      adapterAllowed: true,
      requiresRevalidation: true
    });
  });

  it("removes denied query credentials from every persisted discovery URL", () => {
    const deniedUrl =
      "https://booking.example.com/tee-times?course=12&session_token=secret-value";
    const barrier = { url: deniedUrl, status: 403 as const };
    const discovery = buildBrowserDiscovery({
      courseId: "course-generic",
      courseName: "Generic Public Course",
      sourceUrl: deniedUrl,
      finalUrl: deniedUrl,
      observedUrls: [deniedUrl],
      accessBarriers: [barrier]
    });

    const sanitized = sanitizeBrowserDiscoveryAccessEvidence(discovery, [barrier]);

    expect(sanitized.sourceUrl).toBe("https://booking.example.com/tee-times");
    expect(sanitized.bookingUrl).toBe("https://booking.example.com/tee-times");
    expect(sanitized.evidence.finalUrl).toBe(
      "https://booking.example.com/tee-times"
    );
    expect(sanitized.evidence.observedUrls).toEqual([
      "https://booking.example.com/tee-times"
    ]);
    expect(JSON.stringify(sanitized)).not.toContain("session_token");
    expect(JSON.stringify(sanitized)).not.toContain("secret-value");
  });

  it("classifies an official priced course page that directs golfers to contact the facility", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "contact-only-par-three",
      courseName: "Example Executive Golf Course",
      sourceUrl: "https://example-golf.test/",
      finalUrl: "https://example-golf.test/executive-course/",
      observedUrls: [
        "https://example-golf.test/",
        "https://example-golf.test/executive-course/",
        "https://example-golf.test/contact/"
      ],
      linkCandidates: [
        { url: "https://example-golf.test/contact/", label: "Contact Us" }
      ],
      visibleText:
        "Example Executive Golf Course is an Eighteen Hole Par 3 Golf Course open to the public. Prices Adult Weekdays - $17.00 Senior Weekdays - $13.00 Weekends and Holidays - $18.00. Location and Hours 112 Allen Street 413.525.4444. Hours of operation may vary by season. Please contact us for details."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "CONTACT_COURSE",
      bookingPhone: "413.525.4444",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      confidence: 0.9,
      evidence: { learnedFrom: "official-contact-only-course-access" }
    });
  });

  it("does not apply a sibling course's first-come policy to the selected course", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "shared-walk-in-page",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf/",
      observedUrls: ["https://parks.example/golf/access/"],
      visibleText:
        "Target Municipal Golf Course is next to Sibling Hills Golf Course, where tee times are not required and golf is first come, first served."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("does not apply a sibling course's contact-only evidence to the selected course", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "shared-municipal-page",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf/",
      finalUrl: "https://parks.example/golf/rates/",
      observedUrls: ["https://parks.example/golf/rates/"],
      visibleText:
        "Target Municipal Golf Course is listed in our parks directory. Sibling Hills Golf Course is an Eighteen Hole Golf Course open to the public. Prices Adult Weekdays - $22.00. Call 413-555-0100. Hours of operation may vary by season. Please contact us for details."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("uses the target course phone instead of an earlier sibling or footer phone", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "scoped-contact-phone",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf/",
      finalUrl: "https://parks.example/golf/target/",
      observedUrls: ["https://parks.example/golf/target/"],
      visibleText:
        "Parks office 413-555-0100. Sibling Hills Golf Course outings 413-555-0111. Target Municipal Golf Course is an Eighteen Hole Golf Course open to the public. Prices Adult Weekdays - $22.00. Call the pro shop at 413-555-0142 for seasonal hours. Hours of operation may vary by season. Please contact us for details."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      bookingPhone: "413-555-0142",
      automationReason: "NO_ONLINE_BOOKING"
    });
  });

  it("does not replace the target pro-shop phone with a later department footer phone", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "scoped-contact-footer-phone",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf/",
      finalUrl: "https://parks.example/golf/target/",
      observedUrls: ["https://parks.example/golf/target/"],
      visibleText:
        "Target Municipal Golf Course is an Eighteen Hole Golf Course open to the public. Prices Adult Weekdays - $22.00. Call the pro shop at 413-555-0142 for seasonal hours. Hours of operation may vary by season. Please contact us for details. Parks Department footer 413-555-0199."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      bookingPhone: "413-555-0142",
      automationReason: "NO_ONLINE_BOOKING"
    });
  });

  it("does not classify contact-only evidence when the selected course identity is absent", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "missing-contact-identity",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf/",
      observedUrls: ["https://parks.example/golf/rates/"],
      visibleText:
        "An Eighteen Hole Golf Course is open to the public. Prices Adult Weekdays - $22.00. Call 413-555-0142. Hours of operation may vary by season. Please contact us for details."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("classifies nonexclusive official phone reservations as contact-course access", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "knights-play",
      courseName: "Knights Play Golf Center",
      sourceUrl: "https://www.knightsplay.com/",
      finalUrl: "https://www.knightsplay.com/rates/",
      observedUrls: [
        "https://www.knightsplay.com/",
        "https://www.knightsplay.com/rates/",
        "https://static.wixstatic.com/media/course-photo.jpg"
      ],
      linkCandidates: [
        { url: "https://www.knightsplay.com/rates/", label: "Rates" }
      ],
      visibleText:
        "Knights Play Golf Center Rates. Tee times may be reserved one week in advance. Call the Pro Shop at (919) 555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      sourceUrl: "https://www.knightsplay.com/rates/",
      bookingUrl: "https://www.knightsplay.com/rates/",
      bookingMethod: "CONTACT_COURSE",
      bookingPhone: "(919) 555-0142",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      confidence: 0.92,
      evidence: {
        finalUrl: "https://www.knightsplay.com/rates/",
        learnedFrom: "official-phone-reservation-contact"
      }
    });
  });

  it("preserves phone-only access when the official evidence is explicitly exclusive", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "phone-only-course",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: [
        "https://night-golf.example/",
        "https://night-golf.example/rates/"
      ],
      visibleText:
        "Example Night Golf Center. Tee-time reservations are phone only and no online booking is offered. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "PHONE_ONLY",
      bookingPhone: "919-555-0142",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      confidence: 0.98,
      evidence: { learnedFrom: "official-phone-only-tee-time-access" }
    });
  });

  it("canonicalizes manual evidence URLs and strips query and fragment data", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "canonical-phone-contact",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/?campaign=summer#top",
      finalUrl: "https://night-golf.example/rates/?view=public#pricing",
      observedUrls: [
        "https://night-golf.example/?campaign=summer#top",
        "https://night-golf.example/rates/?view=public#pricing",
        "https://static.wixstatic.com/media/course.jpg?v=1#image"
      ],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      sourceUrl: "https://night-golf.example/rates/",
      bookingUrl: "https://night-golf.example/rates/",
      bookingMethod: "CONTACT_COURSE",
      evidence: {
        finalUrl: "https://night-golf.example/rates/",
        observedUrls: expect.arrayContaining([
          "https://night-golf.example/",
          "https://night-golf.example/rates/",
          "https://static.wixstatic.com/media/course.jpg"
        ])
      }
    });
    expect(discovery.evidence.observedUrls).toHaveLength(3);
    expect(JSON.stringify(discovery)).not.toContain("campaign=");
    expect(JSON.stringify(discovery)).not.toContain("view=");
  });

  it("ignores request-local asset state when the official phone evidence URLs are safe", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "phone-contact-with-request-state",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/rates/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: [
        "https://night-golf.example/rates/",
        "https://static-assets.example/runtime.js?session_token=request-local-value"
      ],
      linkCandidates: [
        {
          url: "https://night-golf.example/rates/",
          label: "Tee Times / Rates"
        }
      ],
      visibleText:
        "Example Night Golf Center. Tee Times are highly recommended and are taken one week in advance. Please call 919-555-0142 to reserve your tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      automationReason: "NO_ONLINE_BOOKING"
    });
    expect(JSON.stringify(discovery)).not.toContain("session_token");
    expect(JSON.stringify(discovery)).not.toContain("request-local-value");
  });

  it("still rejects an unsafe tee-time booking candidate", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "unsafe-phone-contact-booking-link",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/rates/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      linkCandidates: [
        {
          url: "https://booking.example/tee-times?session_token=private-value",
          label: "Book Tee Times Online"
        }
      ],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      evidence: {
        learnedFrom: "official-phone-reservation-rejected:unsafe-url-evidence"
      }
    });
    expect(discovery.bookingMethod).toBeUndefined();
    expect(JSON.stringify(discovery)).not.toContain("session_token");
    expect(JSON.stringify(discovery)).not.toContain("private-value");
  });

  it("rejects credentialed manual evidence without persisting URL userinfo", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "credentialed-phone-contact",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://user:secret@night-golf.example/rates/?session=private#pricing",
      observedUrls: [
        "https://user:secret@night-golf.example/rates/?session=private#pricing"
      ],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      evidence: {
        learnedFrom:
          "official-phone-reservation-rejected:unsafe-url-evidence"
      }
    });
    expect(discovery.bookingMethod).toBeUndefined();
    expect(JSON.stringify(discovery)).not.toContain("user:secret");
    expect(JSON.stringify(discovery)).not.toContain("session=private");
  });

  it("rejects session-bearing manual evidence instead of laundering its URL", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "session-phone-contact",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/?access_token=private-value",
      observedUrls: [
        "https://night-golf.example/rates/?access_token=private-value"
      ],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      evidence: {
        learnedFrom: "official-phone-reservation-rejected:unsafe-url-evidence"
      }
    });
    expect(discovery.bookingMethod).toBeUndefined();
    expect(JSON.stringify(discovery)).not.toContain("access_token");
    expect(JSON.stringify(discovery)).not.toContain("private-value");
  });

  it.each([
    "https://night-golf.example/checkout/private",
    "https://night-golf.example/account/login",
    "https://night-golf.example/session/private",
    "https://night-golf.example/signed/private",
    "https://night-golf.example/queue/private",
    "https://night-golf.example/captcha/private",
    "https://night-golf.example/my-account/private",
    "https://night-golf.example/waiting-room/private",
    "https://night-golf.example/challenge-platform/private",
    "https://night-golf.example/secure-checkout/private",
    "https://night-golf.example/user-login/private",
    "https://night-golf.example/auth0/callback",
    "https://night-golf.example/queueit/private",
    "https://night-golf.example/captchaChallenge/private",
    "https://night-golf.example/authorize",
    "https://night-golf.example/register",
    "https://night-golf.example/sign-up",
    "https://night-golf.example/forgot-password/start",
    "https://night-golf.example/account-recovery/start",
    "https://night-golf.example/login-callback",
    "https://night-golf.example/signin-oidc",
    "https://night-golf.example/oauth2-callback",
    "https://night-golf.example/checkout-flow/start",
    "https://night-golf.example/captcha-v2/start",
    "https://night-golf.example/queue-status",
    "https://night-golf.example/checkout-session/start",
    "https://night-golf.example/payment-confirm",
    "https://night-golf.example/account-settings",
    "https://night-golf.example/forgot-my-password",
    "https://night-golf.example/password-reset-confirm",
    "https://night-golf.example/captcha-verify",
    "https://night-golf.example/queue-redirect",
    "https://night-golf.example/challenge-response",
    "https://night-golf.example/authentication-callback",
    "https://night-golf.example/authorize-callback",
    "https://night-golf.example/saml-acs",
    "https://night-golf.example/openid-connect",
    "https://night-golf.example/login-flow",
    "https://night-golf.example/checkout-step",
    "https://night-golf.example/payment-flow",
    "https://night-golf.example/cart-checkout",
    "https://night-golf.example/queue-progress",
    "https://night-golf.example/authorizecallback",
    "https://night-golf.example/checkoutstep",
    "https://night-golf.example/checkoutstart",
    "https://night-golf.example/loginflow",
    "https://night-golf.example/queueprogress",
    "https://night-golf.example/paymentstep",
    "https://night-golf.example/samlauthnrequest",
    "https://night-golf.example/openidconnect",
    "https://night-golf.example/mfachallenge",
    "https://night-golf.example/hcaptcha/start",
    "https://night-golf.example/funcaptcha/start",
    "https://night-golf.example/member-dashboard",
    "https://night-golf.example/forgot-username",
    "https://night-golf.example/confirm-email",
    "https://night-golf.example/booking-payment",
    "https://night-golf.example/clientlogin",
    "https://night-golf.example/partnerlogin",
    "https://night-golf.example/regionallogin",
    "https://night-golf.example/authservice",
    "https://night-golf.example/authproxy",
    "https://night-golf.example/billing",
    "https://night-golf.example/billingportal",
    "https://night-golf.example/payment-method",
    "https://night-golf.example/paymentmethod",
    "https://night-golf.example/order-review",
    "https://night-golf.example/cartreview",
    "https://night-golf.example/members/booking",
    "https://night-golf.example/member/center",
    "https://night-golf.example/secure/portal",
    "https://night-golf.example/shopping/bag",
    "https://night-golf.example/place/order",
    "https://night-golf.example/complete/purchase",
    "https://night-golf.example/order/history",
    "https://night-golf.example/transaction/history",
    "https://night-golf.example/members/tee-times",
    "https://night-golf.example/member/book/tee-times",
    "https://night-golf.example/member/reserve/tee-times",
    "https://night-golf.example/members/golf/tee-times",
    "https://night-golf.example/secure/tee-times",
    "https://night-golf.example/customer/book/tee-times",
    "https://night-golf.example/user/reserve/tee-times",
    "https://night-golf.example/members/tee-times.aspx",
    "https://night-golf.example/member/book.php",
    "https://night-golf.example/secure/teetimes.html",
    "https://night-golf.example/customer/reserve.aspx",
    "https://night-golf.example/user/schedule.php",
    "https://night-golf.example/member/book.do",
    "https://night-golf.example/customer/reserve.action",
    "https://night-golf.example/user/schedule.do",
    "https://night-golf.example/members/tee-time-booking",
    "https://night-golf.example/customer/tee-time-search",
    "https://night-golf.example/user/online-tee-times",
    "https://night-golf.example/members2/tee/time",
    "https://night-golf.example/secure-v2/online/tee/times",
    "https://night-golf.example/magic-link/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "https://night-golf.example/reset-password/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "https://night-golf.example/invite/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "https://night-golf.example/go/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "https://night-golf.example/go/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "https://night-golf.example/go/a1b2c3d4e5f6g7h8i9j0",
    "https://night-golf.example/go/a1b2c3d4e5f6g7h8i9j",
    "https://night-golf.example/go/AbCdEfGhIjKlMnOpQrSt",
    "https://night-golf.example/%2561ccount%252Flogin",
    "https://night-golf.example/oauth/private-token",
    "https://night-golf.example/saml/private-assertion",
    "https://night-golf.example/ticket/private-ticket",
    "https://night-golf.example/password/reset-secret",
    "https://night-golf.example/rates;jsessionid=private"
  ])("rejects sensitive manual evidence paths at %s", (unsafeUrl) => {
    const discovery = buildBrowserDiscovery({
      courseId: "sensitive-path-phone-contact",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: unsafeUrl,
      observedUrls: [unsafeUrl],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      evidence: {
        learnedFrom: "official-phone-reservation-rejected:unsafe-url-evidence"
      }
    });
    expect(discovery.bookingMethod).toBeUndefined();
    expect(JSON.stringify(discovery)).not.toContain(new URL(unsafeUrl).pathname);
  });

  it.each([
    "https://night-golf.example/rates?ticket=private-ticket",
    "https://night-golf.example/rates?SAMLResponse=private-assertion",
    "https://night-golf.example/rates?apiKey=private-key",
    "https://night-golf.example/rates?authorization=private-authorization",
    "https://night-golf.example/callback?client_id=course&response_type=code",
    "https://night-golf.example/callback?%2563ode=private",
    "https://night-golf.example/callback?%2563lient_id=course&%2572esponse_type=code",
    "https://night-golf.example/callback?oauth_verifier=private",
    "https://night-golf.example/callback?session_state=private",
    "https://night-golf.example/rates?next=/hop-one?next=/hop-two?next=http://127.0.0.1/private",
    "https://night-golf.example/rates?next=/hop-one?next=/hop-two?next=/openings?JSESSIONID=private",
    "https://night-golf.example/rates?redirect=https://provider.example/tee-times",
    "https://night-golf.example/rates?JSESSIONID=private",
    "https://night-golf.example/rates?PHPSESSID=private",
    "https://night-golf.example/rates?PHPSESSIONID=private",
    "https://night-golf.example/rates?ASPSESSIONIDABC123=private",
    "https://night-golf.example/rates?ASP.NET_SessionId=private",
    "https://night-golf.example/rates?SESSION_ID=private",
    "https://night-golf.example/rates?sid=private",
    "https://night-golf.example/rates?CFID=private",
    "https://night-golf.example/rates?CFTOKEN=private",
    "https://night-golf.example/rates?osCsid=private",
    "https://night-golf.example/rates?connect.sid=private",
    "https://night-golf.example/callback?SAMLart=private",
    "https://night-golf.example/callback?login_ticket=private",
    "https://night-golf.example/callback2?code=PUBLIC",
    "https://night-golf.example/callbackv2?state=NC",
    "https://night-golf.example/ssocallback2?code=PUBLIC",
    "https://night-golf.example/callback?SAMLRequest=private",
    "https://night-golf.example/callback?oauth_nonce=private",
    "https://night-golf.example/callback?oauth_callback=private",
    "https://night-golf.example/callback?openid.mode=private",
    "https://night-golf.example/callback?SigAlg=private",
    "https://night-golf.example/rates?next=https%3A%2F%2Fmember-login.vendor.example%2Fstart",
    "https://night-golf.example/rates#access_token=private",
    "https://night-golf.example/rates#oauth_nonce=private",
    "https://night-golf.example/rates#https://evil.example/login",
    "https://night-golf.example/rates#//evil.example/path",
    "https://night-golf.example/rates#https:%5C%5Cevil.example%2Fpath",
    "https://night-golf.example/rates#%5C%5Cevil.example%5Cpath",
    "https://night-golf.example/rates?campaign=%5C%5Cevil.example%5Cpath",
    "https://night-golf.example/rates?redirect=https:%5C%5Cevil.example%2Fpath",
    "https://night-golf.example/rates?prompt=login",
    "https://night-golf.example/rates?code_challenge_method=S256",
    "https://night-golf.example/rates?response_mode=query",
    "https://night-golf.example/rates?returnUrl=%2Faccount%2Flogin",
    "https://night-golf.example/rates?next=%2Fcheckout%2Fstart",
    "https://night-golf.example/rates?redirect=%2Fcaptcha%2Fverify",
    "https://night-golf.example/rates?continue=%2Fqueue%2Fwait",
    "https://night-golf.example/rates?returnUrl=%2F%2Faccounts.vendor.example%2Flogin",
    "https://night-golf.example/rates?nextUrl=%2Faccount%2Flogin",
    "https://night-golf.example/rates?nextPath=%2Fcheckout%2Fstart",
    "https://night-golf.example/rates?continueUrl=%2Fqueue%2Fwait",
    "https://night-golf.example/rates?continueTo=%2Fcaptcha%2Fverify",
    "https://night-golf.example/rates?returnPath=%2Faccount%2Flogin",
    "https://night-golf.example/rates?redirectPath=%2Fcheckout%2Fstart",
    "https://night-golf.example/rates?successUrl=%2Faccount%2Fportal",
    "https://night-golf.example/rates?cancelUrl=%2Fcheckout%2Fcancel",
    "https://night-golf.example/rates?callbackTo=login",
    "https://night-golf.example/rates?destinationUrl=checkout",
    "https://night-golf.example/rates?next=ftp%3A%2F%2Fpublic.vendor.example%2Frates",
    "https://night-golf.example/rates#wresult",
    "https://night-golf.example/rates?view=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf",
    "https://night-golf.example/rates?view=AbCdEfGhIjKlMnOpQrS",
    "https://night-golf.example/rates?csrf=private",
    "https://night-golf.example/rates?xsrf=private",
    "https://night-golf.example/rates?form_key=private",
    "https://night-golf.example/rates?__RequestVerificationToken=private",
    "https://night-golf.example/rates?csrfmiddlewaretoken=private",
    "https://night-golf.example/rates?x-csrf-token=private",
    "https://night-golf.example/rates?anti_csrf_token=private",
    "https://night-golf.example/rates?verification_token=private",
    "https://night-golf.example/rates?checkout_session_id=private",
    "https://night-golf.example/rates?payment_intent=private",
    "https://night-golf.example/rates?order_id=private",
    "https://night-golf.example/rates?transaction_id=private",
    "https://night-golf.example/rates?invoice_id=private",
    "https://night-golf.example/rates?cart_id=private",
    "https://night-golf.example/rates?s=AbCdEfGhIjKlMnOpQrSt%3D%3D",
    "https://night-golf.example/rates?view=AbCdEfGhIjKlMnOp-_%3D%3D",
    "https://night-golf.example/rates?key=sk_test_abc123def456ghi789",
    "https://night-golf.example/rates?key=pk_live_abc123def456ghi789",
    "https://night-golf.example/rates?view=abcdefgh.ijklmnop.qrstuvwx"
  ])("rejects credential-like manual query evidence at %s", (unsafeUrl) => {
    const discovery = buildBrowserDiscovery({
      courseId: "sensitive-query-phone-contact",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: unsafeUrl,
      observedUrls: [unsafeUrl],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    const unsafeState = `${new URL(unsafeUrl).search}${new URL(unsafeUrl).hash}`;
    expect(JSON.stringify(discovery)).not.toContain(unsafeState);
  });

  it.each([
    "https://night-golf.example/golf-cart-rates/",
    "https://night-golf.example/the-challenge-at-manele/",
    "https://night-golf.example/missouri-golf-courses/",
    "https://night-golf.example/cartwright-golf-course/",
    "https://night-golf.example/key-west-golf-club/",
    "https://night-golf.example/keystone-golf-course/",
    "https://night-golf.example/key-largo-golf/",
    "https://keywestgolf.example/",
    "https://keystonegolf.example/",
    "https://key-largo-golf.example/",
    "https://night-golf.example/rates?state=NC",
    "https://night-golf.example/rates?code=PUBLIC",
    "https://night-golf.example/rates?key=course",
    "https://night-golf.example/rates?mapsId=public-course-map",
    "https://night-golf.example/rates?note=front%5Cnine",
    "https://night-golf.example/rates?redirect=/tee-times?date=2026-07-16",
    "https://night-golf.example/rates?destination=Raleigh",
    "https://night-golf.example/rates?target=public"
  ])("keeps legitimate public course paths eligible at %s", (publicUrl) => {
    const expectedBookingUrl = new URL(publicUrl);
    expectedBookingUrl.search = "";
    expectedBookingUrl.hash = "";
    const discovery = buildBrowserDiscovery({
      courseId: "public-course-path",
      courseName: "Example Night Golf Center",
      sourceUrl: `${new URL(publicUrl).origin}/`,
      finalUrl: publicUrl,
      observedUrls: [publicUrl],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      bookingUrl: expectedBookingUrl.toString()
    });
  });

  it.each([
    "https://localhost/rates/",
    "https://localhost./rates/",
    "https://10.0.0.1/rates/",
    "https://[::1]/rates/",
    "https://[fd00::1]/rates/",
    "https://[2001:4860:4860::8888]/rates/",
    "https://[::ffff:127.0.0.1]/rates/",
    "https://[::ffff:10.0.0.1]/rates/",
    "https://[::ffff:c0a8:101]/rates/",
    "https://198.18.0.1/rates/",
    "https://198.19.255.255/rates/",
    "https://192.0.0.1/rates/",
    "https://192.0.2.1/rates/",
    "https://192.88.99.1/rates/",
    "https://198.51.100.1/rates/",
    "https://203.0.113.1/rates/",
    "https://course.internal/rates/",
    "https://course.internal./rates/",
    "https://foo.local./rates/",
    "https://accounts.night-golf.example/rates/",
    "https://tenant.accounts.night-golf.example/rates/",
    "https://tenant.login.night-golf.example/rates/",
    "https://tenant.auth.night-golf.example/rates/",
    "https://secure-login.night-golf.example/rates/",
    "https://portal.auth.night-golf.example/rates/",
    "https://course.queue-it.net/rates/",
    "https://challenges.cloudflare.com/turnstile/v0/",
    "https://www.google.com/recaptcha/api2/anchor",
    "https://sso.night-golf.example/",
    "https://oauth.night-golf.example/",
    "https://oauth2.night-golf.example/",
    "https://auth0.night-golf.example/",
    "https://oidc.night-golf.example/",
    "https://idp.night-golf.example/",
    "https://identity.night-golf.example/",
    "https://identity-provider.night-golf.example/",
    "https://member-login.night-golf.example/",
    "https://customer-login.night-golf.example/",
    "https://prod-login.night-golf.example/",
    "https://login-us.night-golf.example/",
    "https://auth-prod.night-golf.example/",
    "https://sso2.night-golf.example/",
    "https://myaccount.night-golf.example/",
    "https://adminlogin.night-golf.example/",
    "https://stafflogin.night-golf.example/",
    "https://login2.night-golf.example/",
    "https://waitingroom.night-golf.example/",
    "https://turnstile.night-golf.example/",
    "https://recaptcha.night-golf.example/",
    "https://mfa.night-golf.example/",
    "https://identityserver.night-golf.example/",
    "https://saml.night-golf.example/",
    "https://openid.night-golf.example/",
    "https://adfs.night-golf.example/",
    "https://authorization.night-golf.example/",
    "https://openidconnect.night-golf.example/",
    "https://samlauthnrequest.night-golf.example/",
    "https://samlacs.night-golf.example/",
    "https://queueprogress.night-golf.example/",
    "https://captchachallenge.night-golf.example/",
    "https://challengeplatform.night-golf.example/",
    "https://memberdashboard.night-golf.example/",
    "https://accountsettings.night-golf.example/",
    "https://clientlogin.night-golf.example/",
    "https://partnerlogin.night-golf.example/",
    "https://employeelogin.night-golf.example/",
    "https://regionallogin.night-golf.example/",
    "https://authservice.night-golf.example/",
    "https://accountrecovery.night-golf.example/",
    "https://forgotpassword.night-golf.example/",
    "https://passwordreset.night-golf.example/",
    "https://resetpassword.night-golf.example/",
    "https://passwordless.night-golf.example/",
    "https://emailverification.night-golf.example/",
    "https://verifyemail.night-golf.example/",
    "https://magiclink.night-golf.example/",
    "https://invite.night-golf.example/",
    "https://session.night-golf.example/",
    "https://token.night-golf.example/",
    "https://arkose.night-golf.example/",
    "https://arkoselabs.night-golf.example/",
    "https://okta.night-golf.example/",
    "https://onelogin.night-golf.example/",
    "https://cloudflareaccess.night-golf.example/",
    "https://credential.night-golf.example/",
    "https://credentials.night-golf.example/",
    "https://secret.night-golf.example/",
    "https://signature.night-golf.example/",
    "https://signed.night-golf.example/",
    "https://ticket.night-golf.example/",
    "https://assertion.night-golf.example/",
    "https://relaystate.night-golf.example/",
    "https://consent.night-golf.example/",
    "https://jsessionid.night-golf.example/",
    "https://authcode.night-golf.example/",
    "https://nonce.night-golf.example/",
    "https://jwt.night-golf.example/",
    "https://signedurl.night-golf.example/",
    "https://serviceticket.night-golf.example/",
    "https://accesstoken.night-golf.example/",
    "https://clientsecret.night-golf.example/",
    "https://apikey.night-golf.example/",
    "https://night-golf.example:8443/rates/"
  ])("does not terminally classify unsafe manual host evidence at %s", (unsafeUrl) => {
    const discovery = buildBrowserDiscovery({
      courseId: "unsafe-host-phone-contact",
      courseName: "Example Night Golf Center",
      sourceUrl: unsafeUrl,
      finalUrl: unsafeUrl,
      observedUrls: [unsafeUrl],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("does not treat a neutral Book Now link as tee-time evidence", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "neutral-book-now",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: [
        "https://night-golf.example/rates/",
        "https://night-golf.example/go/42"
      ],
      linkCandidates: [
        { url: "https://night-golf.example/go/42", label: "Book Now" }
      ],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      automationReason: "NO_ONLINE_BOOKING"
    });
    expect(discovery.evidence.bookingCallToAction).toBeUndefined();
  });

  it.each([
    "Check Availability",
    "View Availability",
    "Find a Time",
    "Choose a Time",
    "Select a Time",
    "See Openings",
    "Availability",
    "Openings",
    "Search Availability",
    "Find Availability",
    "Reserve",
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
    "Call to Book Tee Times",
    "Phone to Reserve a Tee Time"
  ])("does not treat the ambiguous opaque %s label as tee-time evidence", (label) => {
    const discovery = buildBrowserDiscovery({
      courseId: "opaque-booking-action",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: [
        "https://night-golf.example/rates/",
        "https://night-golf.example/go/42"
      ],
      linkCandidates: [
        { url: "https://night-golf.example/go/42", label }
      ],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      automationReason: "NO_ONLINE_BOOKING"
    });
    expect(discovery.evidence.bookingCallToAction).toBeUndefined();
  });

  it.each([
    { label: "Continue", url: "https://night-golf.example/privacy/" },
    { label: "Get Started", url: "https://night-golf.example/membership/" },
    { label: "Availability", url: "https://night-golf.example/careers/" },
    { label: "Choose a Time", url: "https://night-golf.example/lessons/" },
    { label: "Book", url: "https://night-golf.example/lessons/book" },
    { label: "Reservations", url: "https://night-golf.example/restaurant/reservations" },
    { label: "Availability", url: "https://night-golf.example/lodging/availability" },
    { label: "Appointments", url: "https://night-golf.example/spa/appointments" },
    { label: "Book Now", url: "https://night-golf.example/pro-shop/fittings" },
    { label: "Tee Times Hat", url: "https://night-golf.example/store/tee-times-hat" },
    { label: "Reserve", url: "https://night-golf.example/banquets/reserve" },
    { label: "Reservations", url: "https://restaurant.night-golf.example/reservations" },
    { label: "Book", url: "https://lessons.night-golf.example/book" },
    { label: "Availability", url: "https://lodging.night-golf.example/availability" },
    { label: "Appointments", url: "https://spa.night-golf.example/appointments" },
    { label: "Book Now", url: "https://proshop.night-golf.example/fittings" },
    { label: "Reserve", url: "https://banquets.night-golf.example/reserve" },
    { label: "Reservations", url: "https://night-golf.example/go/42?service=restaurant" },
    { label: "Book Now", url: "https://night-golf.example/go/42?service=lessons" },
    { label: "Availability", url: "https://night-golf.example/go/42?service=lodging" },
    { label: "Book Now", url: "https://night-golf.example/go/42?service=spa" },
    { label: "Book Now", url: "https://night-golf.example/go/42?service=proshop" },
    { label: "Reserve", url: "https://night-golf.example/go/42?service=banquets" },
    { label: "Book Now", url: "https://academy.night-golf.example/book" },
    { label: "Book Now", url: "https://night-golf.example/go/42?service=simulator" },
    { label: "Reservations", url: "https://night-golf.example/driving-range/reservations" },
    { label: "Reservations", url: "https://night-golf.example/mini-golf/reservations" },
    { label: "Reservations", url: "https://toptracer.night-golf.example/reservations" },
    { label: "Restaurant Reservations", url: "https://night-golf.example/go/42" },
    { label: "Reserve Now - Lodging", url: "https://night-golf.example/go/42" },
    { label: "Book Now - Spa", url: "https://night-golf.example/go/42" },
    { label: "Book Now - Pro Shop", url: "https://night-golf.example/go/42" },
    { label: "Banquet/Wedding/Hotel Reservations", url: "https://night-golf.example/go/42" },
    { label: "Restaurant and Tee Time Reservations", url: "https://night-golf.example/go/42" },
    { label: "Academy Lessons", url: "https://night-golf.example/go/42" },
    { label: "Book a Simulator", url: "https://night-golf.example/go/42" },
    { label: "Pickleball Reservations", url: "https://night-golf.example/go/42" },
    { label: "Tennis Reservations", url: "https://night-golf.example/go/42" },
    { label: "Cabin Reservations", url: "https://night-golf.example/go/42" },
    { label: "Room Reservations", url: "https://night-golf.example/go/42" },
    { label: "Golf School Reservations", url: "https://night-golf.example/go/42" },
    { label: "Clinic Reservations", url: "https://night-golf.example/go/42" },
    { label: "Driving Range Reservations", url: "https://night-golf.example/go/42" },
    { label: "Mini Golf Reservations", url: "https://night-golf.example/go/42" },
    { label: "Toptracer Reservations", url: "https://night-golf.example/go/42" },
    { label: "Top-Tracer Reservations", url: "https://night-golf.example/go/42" },
    { label: "Pickle-Ball Reservations", url: "https://night-golf.example/go/42" },
    { label: "Practice Range Reservations", url: "https://night-golf.example/go/42" },
    { label: "Golf Range Reservations", url: "https://night-golf.example/go/42" },
    { label: "Golf Academy Reservations", url: "https://night-golf.example/go/42" },
    { label: "Indoor Golf Reservations", url: "https://night-golf.example/go/42" },
    { label: "Miniature Golf Reservations", url: "https://night-golf.example/go/42" },
    { label: "Stay Reservations", url: "https://night-golf.example/go/42" },
    { label: "Reservations", url: "https://top-tracer.night-golf.example/reservations" },
    { label: "Reservations", url: "https://pickle-ball.night-golf.example/reservations" },
    { label: "Book Now", url: "https://golfacademy.night-golf.example/book" },
    { label: "Reservations", url: "https://night-golf.example/practice-range/reservations" },
    { label: "Reservations", url: "https://night-golf.example/miniature-golf/reservations" },
    { label: "Reservations", url: "https://night-golf.example/stay/reservations" },
    { label: "Book Now", url: "https://night-golf.example/golf-camps/book" },
    { label: "Reservations", url: "https://night-golf.example/leagues/reservations" },
    { label: "Book Now", url: "https://night-golf.example/tournaments/book" },
    { label: "Book Now", url: "https://night-golf.example/gift-cards/book" },
    { label: "Reservations", url: "https://night-golf.example/pool/reservations" },
    { label: "Reserve", url: "https://night-golf.example/rv-sites/reserve" },
    { label: "Reserve", url: "https://night-golf.example/club-rentals/reserve" },
    { label: "Boat Rental Reservations", url: "https://night-golf.example/go/42" },
    { label: "Bike Rental Reservations", url: "https://night-golf.example/go/42" },
    { label: "Kayak Reservations", url: "https://night-golf.example/go/42" },
    { label: "Campsite Reservations", url: "https://night-golf.example/go/42" },
    { label: "Conference Reservations", url: "https://night-golf.example/go/42" },
    { label: "Bowling Reservations", url: "https://night-golf.example/go/42" },
    { label: "Cabana Reservations", url: "https://night-golf.example/go/42" },
    { label: "Fishing Charter Reservations", url: "https://night-golf.example/go/42" },
    { label: "Horseback Riding Reservations", url: "https://night-golf.example/go/42" },
    { label: "Ski Rental Reservations", url: "https://night-golf.example/go/42" }
  ])("does not treat unrelated $label navigation as booking evidence", ({ label, url }) => {
    const discovery = buildBrowserDiscovery({
      courseId: "unrelated-action-link",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/", url],
      linkCandidates: [{ url, label }],
      visibleText:
        "Example Night Golf Center. Tee-time reservations are phone only and no online booking is offered. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "PHONE_ONLY",
      automationReason: "NO_ONLINE_BOOKING"
    });
  });

  it.each([
    "Restaurant reservations: book now online",
    "Golf lessons: schedule online",
    "Lodging reservations: reserve online",
    "Spa appointments: book now online",
    "Simulator reservations: book online",
    "Top Tracer reservations: book online",
    "Pickle ball reservations: book online",
    "Banquet reservations: book online",
    "Pro shop appointments: book online",
    "Golf camps: book now online",
    "League reservations: book online",
    "Tournament registration: book online",
    "Gift cards: buy online",
    "Pool reservations: book online",
    "RV sites: reserve online",
    "Club rentals: reserve online"
  ])("does not treat unrelated visible copy as tee-time evidence: %s", (copy) => {
    const discovery = buildBrowserDiscovery({
      courseId: "unrelated-visible-booking-copy",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      visibleText:
        `${copy}. Example Night Golf Center. Tee-time reservations are phone only and no online booking is offered. Call the Pro Shop at 919-555-0142 to reserve a tee time.`
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "PHONE_ONLY",
      automationReason: "NO_ONLINE_BOOKING"
    });
  });

  it.each([
    "Academy course guests can Book Tee Times Online",
    "Academy course guests can Book Tee-Times Online",
    "Academy course guests can Book Tee‑Times Online",
    "Academy course guests can Book Tee–Times Online",
    "Resort golf tee times are available online",
    "View tee times online",
    "Search tee times online",
    "Current tee time availability is online"
  ])("keeps explicit online tee-time text stronger than auxiliary wording: %s", (copy) => {
    const discovery = buildBrowserDiscovery({
      courseId: "explicit-visible-tee-time-copy",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      visibleText:
        `${copy}. Example Night Golf Center. Tee-time reservations are phone only. Call the Pro Shop at 919-555-0142 to reserve a tee time.`
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it.each([
    "Book a tee time by calling the pro shop at 919-555-0142",
    "Reserve tee times by calling 919-555-0142"
  ])("keeps an explicit phone tee-time action manual: %s", (copy) => {
    const discovery = buildBrowserDiscovery({
      courseId: "explicit-phone-tee-time-action",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      visibleText: `Example Night Golf Center. ${copy}.`
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      automationReason: "NO_ONLINE_BOOKING"
    });
  });

  it("uses a Whoosh agenda route only to identify the club and never as tee-time metadata", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "windy-hill",
      courseName: "Windy Hill Golf Course and Sports Complex",
      sourceUrl: "https://windyhillsports.com/golf/",
      observedUrls: [
        "https://app.whoosh.io/patron/club/windy-hill/agenda/driving-range/today"
      ],
      visibleText: "Book the golf course or reserve a driving-range bay."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      bookingUrl: "https://app.whoosh.io/patron/club/windy-hill",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        provider: "WHOOSH",
        clubSlug: "windy-hill",
        bookingBaseUrl: "https://app.whoosh.io/patron/club/windy-hill"
      }
    });
  });

  it("accepts an official phone instruction when the page omits a generic word from the saved course name", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "official-phone-name-alias",
      courseName: "Portland Golf Course West",
      sourceUrl: "https://course.example/",
      finalUrl: "https://course.example/",
      observedUrls: ["https://course.example/"],
      linkCandidates: [
        {
          url: "https://course.example/foreupgolf.com",
          label: "TEE TIMES"
        }
      ],
      visibleText:
        "PORTLAND GOLF WEST. Come join us for your next round of golf. See you soon! Please Call The Pro Shop At (860) 342-6111 For Tee Times."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      automationReason: "NO_ONLINE_BOOKING",
      evidence: { learnedFrom: "official-phone-reservation-contact" }
    });
  });

  it("rejects a normalized name alias that is too remote from the phone instruction", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "remote-phone-name-alias",
      courseName: "Portland Golf Course West",
      sourceUrl: "https://course.example/",
      finalUrl: "https://course.example/",
      observedUrls: ["https://course.example/"],
      visibleText: `PORTLAND GOLF WEST. ${"Unscoped facility information. ".repeat(12)} Please Call The Pro Shop At (860) 342-6111 For Tee Times.`
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it.each([
    "https://academy-course.example/tee-times",
    "https://night-golf.example/academy-course/tee-times",
    "https://golf-and-lodging.example/tee-times",
    "https://night-golf.example/tee-times?source=lodging",
    "https://academy-course.example/book-a-tee-time",
    "https://golf-and-lodging.example/book-tee-times",
    "https://night-golf.example/academy-course/tee-time-booking",
    "https://night-golf.example/public/tee-times.html",
    "https://night-golf.example/public/tee-times.do",
    "https://great-resort.example/golf/booking/42",
    "https://great-resort.example/go/42",
    "https://academy-course.example/go/42"
  ])("keeps an explicit tee-time destination as online evidence at %s", (url) => {
    const discovery = buildBrowserDiscovery({
      courseId: "explicit-tee-time-action",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/", url],
      linkCandidates: [{ url, label: "Book Tee Times Online" }],
      visibleText:
        "Example Night Golf Center. Tee-time reservations are phone only and no online booking is offered. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.evidence.bookingCallToAction).toBe(true);
  });

  it.each([
    "Book Tee-Times Online",
    "Book Tee‑Times Online",
    "Book Tee–Times Online"
  ])("keeps the explicit hyphenated %s label as online evidence", (label) => {
    const discovery = buildBrowserDiscovery({
      courseId: "hyphenated-tee-time-action",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: [
        "https://night-golf.example/rates/",
        "https://night-golf.example/go/42"
      ],
      linkCandidates: [{ url: "https://night-golf.example/go/42", label }],
      visibleText:
        "Example Night Golf Center. Tee-time reservations are phone only. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.evidence.bookingCallToAction).toBe(true);
  });

  it("ignores telephone and email anchors while preserving safe manual evidence", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "phone-contact-anchors",
      courseName: "Knights Play Golf Center",
      sourceUrl: "https://www.knightsplay.com/",
      finalUrl: "https://www.knightsplay.com/rates/",
      observedUrls: [
        "https://www.knightsplay.com/rates/",
        "tel:+19195550142",
        "mailto:proshop@knightsplay.example"
      ],
      linkCandidates: [
        { url: "tel:+19195550142", label: "Call the Pro Shop" },
        { url: "mailto:proshop@knightsplay.example", label: "Email the Pro Shop" }
      ],
      visibleText:
        "Knights Play Golf Center. Call the Pro Shop at (919) 555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      bookingPhone: "(919) 555-0142",
      evidence: {
        observedUrls: expect.arrayContaining([
          "https://www.knightsplay.com/",
          "https://www.knightsplay.com/rates/"
        ])
      }
    });
    expect(discovery.evidence.observedUrls).toHaveLength(2);
    expect(JSON.stringify(discovery)).not.toContain("tel:");
    expect(JSON.stringify(discovery)).not.toContain("mailto:");
  });

  it("accepts an official phone-reservation notice followed by current last-tee-time hours", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "phone-contact-with-hours",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      officialPage: {
        url: "https://night-golf.example/rates/",
        courseName: "Example Night Golf Center",
        linkCandidates: [
          {
            url: "https://night-golf.example/rates/",
            label: "Tee Times / Rates"
          },
          {
            url: "https://night-golf.example/category/all-products",
            label: "Shop / Online Store"
          }
        ],
        visibleText:
          "Example Night Golf Center. Tee Times are HIGHLY recommended. Tee Times are taken ONE WEEK in advance. Please call 919-555-0142 to reserve your tee time. As of June 21, 2026: **weather permitting** Our last tee time for 18 holes is 7:30 PM. **Our last tee time for 9 holes is 9:00 PM.**"
      },
      visibleText:
        "Golf lessons and clinics book online Shop/Online Store Welcome to Example Night Golf Center\nExample Night Golf Center. Tee Times are HIGHLY recommended. Tee Times are taken ONE WEEK in advance. Please call 919-555-0142 to reserve your tee time. As of June 21, 2026: **weather permitting** Our last tee time for 18 holes is 7:30 PM. **Our last tee time for 9 holes is 9:00 PM.**"
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      bookingPhone: "919-555-0142",
      automationReason: "NO_ONLINE_BOOKING",
      evidence: { learnedFrom: "official-phone-reservation-contact" }
    });
  });

  it("treats visible Book your tee time now copy as online-booking evidence", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "visible-book-now",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      visibleText:
        "Example Night Golf Center. Book your tee time now. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.evidence.bookingCallToAction).toBe(true);
  });

  it("rejects generic course names as terminal phone-reservation identity", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "generic-phone-contact",
      courseName: "Golf Course",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      visibleText:
        "Golf Course rates. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not classify phone instructions when a known online provider is present", () => {
    const bookingUrl = "https://knights-play.book.teeitup.golf/";
    const discovery = buildBrowserDiscovery({
      courseId: "provider-and-phone",
      courseName: "Knights Play Golf Center",
      sourceUrl: "https://www.knightsplay.com/",
      finalUrl: "https://www.knightsplay.com/rates/",
      observedUrls: ["https://www.knightsplay.com/rates/", bookingUrl],
      linkCandidates: [{ url: bookingUrl, label: "Book Tee Times Online" }],
      officialPage: {
        url: "https://www.knightsplay.com/rates/",
        courseName: "Knights Play Golf Center",
        linkCandidates: [{ url: bookingUrl, label: "Book Tee Times Online" }]
      },
      visibleText:
        "Knights Play Golf Center. Call the Pro Shop at (919) 555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingUrl
    });
    expect(discovery.bookingMethod).not.toBe("PHONE_ONLY");
  });

  it("does not let ambiguous phone evidence suppress a known provider", () => {
    const bookingUrl = "https://knights-play.book.teeitup.golf/";
    const discovery = buildBrowserDiscovery({
      courseId: "provider-and-ambiguous-phone",
      courseName: "Knights Play Golf Center",
      sourceUrl: "https://www.knightsplay.com/",
      finalUrl: "https://www.knightsplay.com/rates/",
      observedUrls: ["https://www.knightsplay.com/rates/", bookingUrl],
      linkCandidates: [{ url: bookingUrl, label: "Book Tee Times Online" }],
      officialPage: {
        url: "https://www.knightsplay.com/rates/",
        courseName: "Knights Play Golf Center",
        linkCandidates: [{ url: bookingUrl, label: "Book Tee Times Online" }]
      },
      visibleText:
        "Knights Play Golf Center. Call 919-555-0142 to reserve a tee time. Call 919-555-0199 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingUrl
    });
  });

  it("does not classify phone-only access when the official page advertises online booking", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "online-and-phone",
      courseName: "Knights Play Golf Center",
      sourceUrl: "https://www.knightsplay.com/",
      finalUrl: "https://www.knightsplay.com/rates/",
      observedUrls: [
        "https://www.knightsplay.com/rates/",
        "https://www.knightsplay.com/book-online/"
      ],
      linkCandidates: [
        {
          url: "https://www.knightsplay.com/book-online/",
          label: "Book Tee Times Online"
        }
      ],
      visibleText:
        "Knights Play Golf Center. Online booking is available, or call the Pro Shop at (919) 555-0142 to reserve a tee time."
    });

    expect(discovery.bookingMethod).not.toBe("PHONE_ONLY");
    expect(discovery.status).toBe("INSPECTED");
  });

  it("treats a same-host tee-time URL as contradictory booking evidence", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "same-host-booking-signal",
      courseName: "Knights Play Golf Center",
      sourceUrl: "https://www.knightsplay.com/",
      finalUrl: "https://www.knightsplay.com/rates/",
      observedUrls: [
        "https://www.knightsplay.com/rates/",
        "https://www.knightsplay.com/tee-times/"
      ],
      visibleText:
        "Knights Play Golf Center. Call the Pro Shop at (919) 555-0142 to reserve a tee time."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("takes the booking phone only from the direct reservation phrase", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "separate-event-phone",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      visibleText:
        "Example Night Golf Center. Events and outings: call 919-555-0100. Call the Pro Shop at 919-555-0142 to reserve a tee time."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      bookingPhone: "919-555-0142"
    });
  });

  it("does not reuse an event phone from a separate sentence as the booking phone", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "event-phone-only",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      visibleText:
        "Example Night Golf Center. Tee times may be reserved one week in advance. For events and outings call 919-555-0100."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("does not attribute a sibling course phone instruction to the target course", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "shared-course-phone",
      courseName: "Knights Play Golf Center",
      sourceUrl: "https://www.knightsplay.com/",
      finalUrl: "https://www.knightsplay.com/rates/",
      observedUrls: ["https://www.knightsplay.com/rates/"],
      visibleText:
        "Knights Play Golf Center offers several facilities. Sibling Hills Golf Course. Call the Pro Shop at 919-555-0199 to reserve a tee time."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.bookingPhone).toBeUndefined();
  });

  it.each([
    "Knights Play Golf Center offers several facilities. sibling hills golf course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center offers several facilities. For Sibling Hills, call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center offers several facilities. Call the Pro Shop at 919-555-0199 to reserve a tee time at Sibling Hills Golf Course.",
    "Knights Play Golf Center. The Lakes. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Executive Nine. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. RIVER BEND. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. The Lakes Golf. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. The Lakes Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Executive Nine Rates. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. River Bend 18 Holes. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Executive Nine Tee Times. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. South Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Pines Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Par 3 Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Green Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Night Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Day Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. The Greens. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Night Golf. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. The Green Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Public Golf Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Night Golf Rates. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Rates Green Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Rates for The Green Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Tee times are taken by phone at The Public Course. Call the Pro Shop at 919-555-0199 to reserve a tee time.",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time (Green Course).",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time - Green Course.",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time — Green Course.",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time, Green Course.",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time / Green Course.",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time [Green Course].",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time on Green Course.",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time with Green Course.",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time, for Green Course.",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time\nThe Public Course",
    "Knights Play Golf Center. Call the Pro Shop at 919-555-0199 to reserve a tee time | The Public Course",
    "Example Valley Golf Course. Example Valley Pines Golf Course. Call the Pro Shop at 919-555-0199 to reserve a tee time."
  ])("fails closed for shared-page phone copy: %s", (visibleText) => {
    const discovery = buildBrowserDiscovery({
      courseId: "shared-course-phone-adversarial",
      courseName: visibleText.startsWith("Example Valley")
        ? "Example Valley Golf Course"
        : "Knights Play Golf Center",
      sourceUrl: "https://shared-golf.example/",
      finalUrl: "https://shared-golf.example/rates/",
      observedUrls: ["https://shared-golf.example/rates/"],
      visibleText
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.bookingPhone).toBeUndefined();
  });

  it("rejects ambiguous direct tee-time phone instructions", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "ambiguous-booking-phones",
      courseName: "Example Night Golf Center",
      sourceUrl: "https://night-golf.example/",
      finalUrl: "https://night-golf.example/rates/",
      observedUrls: ["https://night-golf.example/rates/"],
      visibleText:
        "Example Night Golf Center. Call the Pro Shop at 919-555-0142 to reserve a tee time. Call 919-555-0199 to book a tee time."
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      evidence: {
        learnedFrom: "official-phone-reservation-rejected:ambiguous-phone-evidence"
      }
    });
    expect(discovery.bookingMethod).toBeUndefined();
  });

  it("rejects weak or mismatched identity evidence for phone-only access", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "generic-course",
      courseName: "Municipal Golf Course",
      sourceUrl: "https://www.knightsplay.com/",
      finalUrl: "https://www.knightsplay.com/rates/",
      observedUrls: ["https://www.knightsplay.com/rates/"],
      visibleText:
        "Knights Play Golf Center. Call the Pro Shop at (919) 555-0142 to reserve a tee time."
    });

    expect(discovery.bookingMethod).not.toBe("PHONE_ONLY");
    expect(discovery.status).toBe("INSPECTED");
  });

  it("keeps non-reservation phone copy in the contact-course classification", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "seasonal-contact",
      courseName: "Example Executive Golf Course",
      sourceUrl: "https://example-golf.test/",
      finalUrl: "https://example-golf.test/rates/",
      observedUrls: [
        "https://example-golf.test/",
        "https://example-golf.test/rates/"
      ],
      visibleText:
        "Example Executive Golf Course is an Eighteen Hole Golf Course open to the public. Prices Adult Weekdays - $17.00. Call the pro shop at 413.555.0142 for seasonal hours. Hours of operation may vary by season. Please contact us for details."
    });

    expect(discovery).toMatchObject({
      bookingMethod: "CONTACT_COURSE",
      automationReason: "NO_ONLINE_BOOKING",
      evidence: { learnedFrom: "official-contact-only-course-access" }
    });
  });

  it("requires the final phone-reservation evidence page to stay on the official host", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "cross-host-phone-copy",
      courseName: "Knights Play Golf Center",
      sourceUrl: "https://www.knightsplay.com/",
      finalUrl: "https://unverified.example/rates/",
      observedUrls: ["https://unverified.example/rates/"],
      visibleText:
        "Knights Play Golf Center. Call the Pro Shop at (919) 555-0142 to reserve a tee time."
    });

    expect(discovery.bookingMethod).not.toBe("PHONE_ONLY");
    expect(discovery.status).toBe("INSPECTED");
  });

  it("preserves online booking when a priced course page also lists seasonal contact details", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "online-booking-with-seasonal-contact",
      courseName: "Example Public Golf Course",
      sourceUrl: "https://example-golf.test/",
      finalUrl: "https://example-golf.test/course/",
      observedUrls: [
        "https://example-golf.test/course/",
        "https://booking.example-golf.test/tee-times"
      ],
      linkCandidates: [
        {
          url: "https://booking.example-golf.test/tee-times",
          label: "Book a Tee Time"
        }
      ],
      visibleText:
        "An Eighteen Hole public golf course. Prices Adult Weekdays - $25.00. Call 413-555-0100. Hours of operation may vary by season. Please contact us for details. Book a tee time online."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("learns a reusable signed-out WebTrac golf search without entering cart", () => {
    const bookingUrl = "https://myffr.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=25";
    const discovery = buildBrowserDiscovery({
      courseId: "casa-linda",
      courseName: "Casa Linda Oaks Golf Club",
      sourceUrl: "https://www.navymwrjacksonville.com/programs/casa-linda",
      observedUrls: [bookingUrl, "https://myffr.navyaims.com/navyeast/jaxgolf.html"],
      visibleText: "Active duty may reserve 8 DAYS in advance. All other patrons may reserve 7 DAYS in advance. Tee Time Search Results."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "CUSTOM",
      bookingUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      apiMetadata: {
        provider: "WEBTRAC",
        courseCode: "25",
        bookingWindowDaysAhead: 7
      },
      evidence: { learnedFrom: "webtrac-public-golf-search" }
    });
  });

  it("does not treat an arbitrary WebTrac-shaped host as trusted provider metadata", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "untrusted",
      courseName: "Example Course",
      sourceUrl: "https://example.com",
      observedUrls: ["https://example.com/webtrac/web/search.html?module=GR&secondarycode=25"]
    });
    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("does not mistake first-come practice facilities for walk-in course access", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "public-course-with-range",
      courseName: "Example Public Golf Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://example.com/book-a-tee-time"],
      visibleText:
        "Tee times are not required for the driving range, which is first come, first served. Book a tee time online for the golf course."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("preserves public courses that merely mention private events", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "public-course",
      courseName: "Example Public Golf Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://example.com/"],
      visibleText: "An 18-hole public golf course with private event and outing packages."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("preserves public courses that offer benefits to members and guests", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "public-membership-course",
      courseName: "Example Public Golf Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://example.com/tee-times"],
      visibleText:
        "An 18-hole public golf course open to everyone. Members and their guests receive loyalty discounts, and public tee times are available online."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("does not apply a sibling club's private access rules to the selected public course", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "shared-private-page",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf/",
      observedUrls: ["https://parks.example/golf/clubs/"],
      visibleText:
        "Target Municipal Golf Course is open to the public. sibling hills country club is a private golf club. The sibling Hills golf course is available only to members and their guests."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("does not treat a longer sibling name containing the target name as equivalent", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "superset-private-page",
      courseName: "Valley Hills Golf Course",
      sourceUrl: "https://parks.example/golf/",
      observedUrls: ["https://parks.example/golf/clubs/"],
      visibleText:
        "Valley Hills Golf Course is open to the public. Pine Valley Hills Golf Course is a private golf club available only to members and their guests."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("keeps an exact three-token private-course identity distinct from its suffix", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "three-token-private-course",
      courseName: "Pine Valley Hills Golf Course",
      sourceUrl: "https://pinevalley.example/",
      observedUrls: ["https://pinevalley.example/membership/"],
      visibleText:
        "Pine Valley Hills Golf Course is a private golf club available only to members and their guests."
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER"
    });
  });

  it("ignores approved and hole-count descriptors before the exact private-course identity", () => {
    const bookingUrl =
      "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes";
    const discovery = buildBrowserDiscovery({
      courseId: "descriptor-private-course",
      courseName: "Pine Valley Hills Golf Course",
      sourceUrl: "https://pinevalley.example/",
      observedUrls: [bookingUrl],
      visibleText:
        "Our championship award-winning 18-hole Pine Valley Hills Golf Course is a private golf club available only to members and their guests."
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER"
    });
    expect(discovery.status).not.toBe("LEARNED");
  });

  it("recognizes an explicit one-token sibling course identity", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "one-token-sibling-page",
      courseName: "Target Municipal Golf Course",
      sourceUrl: "https://parks.example/golf/",
      observedUrls: ["https://parks.example/golf/clubs/"],
      visibleText:
        "Target Municipal Golf Course is open to the public. Yale Golf Course is a private golf club available only to members and their guests."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.bookingMethod).toBeUndefined();
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("classifies an exact one-token target course identity", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "shennecossett-private-course",
      courseName: "Shennecossett Golf Course",
      sourceUrl: "https://shennecossett.example/",
      observedUrls: ["https://shennecossett.example/membership/"],
      visibleText:
        "Shennecossett Golf Course is a private golf club available only to members and their guests."
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER"
    });
  });

  it("classifies an official resident social-club course as member access", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "oswegatchie-hills",
      courseName: "Oswegatchie Hills Golf Course",
      sourceUrl: "https://ohcniantic.org/",
      observedUrls: ["https://ohcniantic.org/membership-information/"],
      visibleText:
        "The Oswegatchie Hills Club is a neighborhood social club for residents of The Point and offers its members the use of clay tennis courts, a beach, and a 6 hole golf course."
    });

    expect(discovery).toMatchObject({
      isPublic: false,
      status: "VERIFIED",
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER",
      confidence: 0.98,
      evidence: { learnedFrom: "official-resident-member-access" }
    });
  });

  it("preserves public neighborhood courses that merely offer member benefits", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "public-neighborhood-course",
      courseName: "Example Municipal Golf Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://example.com/tee-times"],
      visibleText:
        "A public neighborhood golf course open to everyone. Members receive early booking benefits, and public tee times are available online."
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.automationEligibility).toBeUndefined();
  });

  it("maps Dennis Pines separately on the shared public Chelsea tee sheet", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "dennis-pines",
      courseName: "Dennis Pines Golf Course",
      sourceUrl: "https://www.dennisgolf.com/",
      finalUrl: "https://dennis.chelseareservations.com/",
      observedUrls: ["https://dennis.chelseareservations.com/GPInprocess"],
      visibleText: "Non Members Login"
    });

    expect(discovery.apiMetadata).toMatchObject({
      provider: "CHELSEA",
      courseCode: 1,
      courseLabel: "Pines"
    });
  });
});

describe("browser probe target selection", () => {
  it("queues unknown active courses with a website", () => {
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "UNKNOWN",
        automationEligibility: "UNKNOWN",
        website: "https://example.com",
        detectedBookingUrl: null,
        bookingMetadata: null
      })
    ).toBe(true);
  });

  it("keeps every stored block out of the interactive browser probe", () => {
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "CUSTOM",
        automationEligibility: "BLOCKED",
        automationReason: "AUTOMATION_PROHIBITED",
        website: "https://example.com",
        detectedBookingUrl: null,
        bookingMetadata: null
      })
    ).toBe(false);
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "FOREUP",
        automationEligibility: "BLOCKED",
        automationReason: "AUTOMATION_PROHIBITED",
        website: "https://example.com",
        detectedBookingUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
        bookingMetadata: {
          scheduleId: 6123,
          bookingBaseUrl:
            "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
        }
      })
    ).toBe(false);
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "CUSTOM",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        bookingMethod: "PUBLIC_ONLINE",
        intelligenceVerifiedAt: new Date(),
        intelligenceReviewAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        intelligenceConfidence: 0.95,
        website: "https://example.com",
        detectedBookingUrl: null,
        bookingMetadata: null
      })
    ).toBe(false);
  });

  it("skips courses that already have deterministic adapter metadata", () => {
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "FOREUP",
        automationEligibility: "ALLOWED",
        website: "https://example.com",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
        bookingMetadata: {
          scheduleId: 2,
          bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/1/2#/teetimes"
        }
      })
    ).toBe(false);

    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "CUSTOM",
        automationEligibility: "ALLOWED",
        website: "https://www.dennisgolf.com/",
        detectedBookingUrl: "https://dennis.chelseareservations.com/",
        bookingMetadata: {
          provider: "CHELSEA",
          bookingBaseUrl: "https://dennis.chelseareservations.com/",
          courseCode: 2,
          courseLabel: "Highland"
        }
      })
    ).toBe(false);
  });

  it("keeps repeated runnable-provider failures on non-interactive remediation", () => {
    const course = {
      detectedPlatform: "FOREUP",
      automationEligibility: "ALLOWED",
      website: "https://course.example/",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
      bookingMetadata: {
        scheduleId: 2,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/1/2#/teetimes"
      },
      monitoringFailureEvidence: {
        kind: "FETCH_FAILED" as const,
        occurrenceCount: 3,
        latestFailureAt: new Date()
      }
    };

    expect(shouldQueueBrowserProbe(course)).toBe(false);
    expect(getBestProbeUrl(course)).toBe("https://course.example/");
  });

  it("routes a recognized unsupported family to adapter repair, not repeat browser discovery", () => {
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "TENFORE",
        automationEligibility: "NEEDS_REVIEW",
        website: "https://course.example/",
        detectedBookingUrl: "https://fox.tenfore.golf/course",
        bookingMetadata: null
      })
    ).toBe(false);
  });

  it("preserves a runnable provider after newer successful evidence", () => {
    const latestFailureAt = new Date(Date.now() - 60_000);
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "FOREUP",
        automationEligibility: "ALLOWED",
        website: "https://course.example/",
        detectedBookingUrl:
          "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
        bookingMetadata: {
          scheduleId: 2,
          bookingBaseUrl:
            "https://foreupsoftware.com/index.php/booking/1/2#/teetimes"
        },
        monitoringFailureEvidence: {
          kind: "FETCH_FAILED",
          occurrenceCount: 3,
          latestFailureAt,
          latestSuccessfulAt: new Date()
        }
      })
    ).toBe(false);
  });

  it("skips TeeItUp courses that already have reusable alias metadata", () => {
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "TEEITUP",
        automationEligibility: "ALLOWED",
        website: "https://example.com",
        detectedBookingUrl: "https://example.book.teeitup.golf/",
        bookingMetadata: {
          aliases: ["example"],
          bookingBaseUrl: "https://example.book.teeitup.golf/"
        }
      })
    ).toBe(false);
  });

  it("skips custom courses that already have reusable metadata", () => {
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "CUSTOM",
        automationEligibility: "ALLOWED",
        website: "https://example.com",
        detectedBookingUrl: "https://example.cps.golf/",
        bookingMetadata: {
          provider: "CPS",
          siteName: "example",
          bookingBaseUrl: "https://example.cps.golf/",
          courseIds: [1, 2],
          holes: [18, 9]
        }
      })
    ).toBe(false);

    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "CUSTOM",
        automationEligibility: "ALLOWED",
        website: "https://example.com",
        detectedBookingUrl: "https://huntergolfclub.teesnap.net/",
        bookingMetadata: {
          provider: "TEESNAP",
          courseId: 1210,
          bookingBaseUrl: "https://huntergolfclub.teesnap.net/"
        }
      })
    ).toBe(false);
  });

  it("prefers a detected booking URL over a marketing website", () => {
    expect(
      getBestProbeUrl({
        website: "https://example.com",
        detectedBookingUrl: "https://booking.example.com/tee-times"
      })
    ).toBe("https://booking.example.com/tee-times");
  });

  it("prefers the official course source when a known provider needs discovery", () => {
    expect(
      getBestProbeUrl({
        website: "https://www.whitneyfarmsgc.com/",
        detectedBookingUrl:
          "https://whitneyfarmsgolfcourse.book.teeitup.golf/"
      })
    ).toBe("https://www.whitneyfarmsgc.com/");
  });

  it("keeps an already runnable TeeItUp booking root as the probe target", () => {
    const bookingUrl =
      "https://whitneyfarmsgolfcourse.book.teeitup.golf/";
    expect(
      getBestProbeUrl({
        website: "https://www.whitneyfarmsgc.com/",
        detectedBookingUrl: bookingUrl,
        detectedPlatform: "TEEITUP",
        bookingMetadata: {
          aliases: ["whitneyfarmsgolfcourse"],
          bookingBaseUrl: bookingUrl
        }
      })
    ).toBe(bookingUrl);
  });

  it("keeps an unsupported provider URL available for access classification", () => {
    const bookingUrl = "https://www.golfnow.com/tee-times/facility/example";
    expect(
      getBestProbeUrl({
        website: "https://course.example/",
        detectedBookingUrl: bookingUrl,
        detectedPlatform: "GOLFNOW"
      })
    ).toBe(bookingUrl);
  });

  it("prefers the official course page over a same-host generic permits page", () => {
    expect(
      getBestProbeUrl({
        website: "https://parks.example/courses/clayton",
        detectedBookingUrl: "https://parks.example/parks/permits-forms"
      })
    ).toBe("https://parks.example/courses/clayton");

    expect(
      getBestProbeUrl({
        website: "https://parks.example/courses/clayton",
        detectedBookingUrl: "https://parks.example/golf/tee-time-forms"
      })
    ).toBe("https://parks.example/golf/tee-time-forms");
  });

  it("falls back to the official website instead of probing an unsafe booking surface", () => {
    expect(
      getBestProbeUrl({
        website: "https://example.com/",
        detectedBookingUrl:
          "https://booking.example.com/checkout?session_token=synthetic-secret"
      })
    ).toBe("https://example.com/");

    expect(
      getBestProbeUrl({
        website: null,
        detectedBookingUrl:
          "https://booking.example.com/account/session/synthetic-secret"
      })
    ).toBeNull();
  });

  it.each([
    "https://[::1]/rates/",
    "https://[2001:4860:4860::8888]/rates/",
    "https://[::ffff:127.0.0.1]/rates/",
    "https://[::ffff:10.0.0.1]/rates/",
    "https://198.18.0.1/rates/",
    "https://198.19.255.255/rates/"
  ])("keeps an unsafe literal host out of the browser probe: %s", (unsafeUrl) => {
    expect(
      getBestProbeUrl({ website: null, detectedBookingUrl: unsafeUrl })
    ).toBeNull();
  });

  it("keeps a public IPv4 address outside the benchmark range eligible", () => {
    expect(
      getBestProbeUrl({
        website: null,
        detectedBookingUrl: "https://198.20.0.1/rates/"
      })
    ).toBe("https://198.20.0.1/rates/");
  });

  it("does not queue a legacy policy row whose only source is unsafe", () => {
    expect(
      shouldQueueBrowserProbe({
        detectedPlatform: "CUSTOM",
        automationEligibility: "BLOCKED",
        automationReason: "AUTOMATION_PROHIBITED",
        website: null,
        detectedBookingUrl:
          "https://booking.example.com/checkout?session_token=synthetic-secret",
        bookingMetadata: null
      })
    ).toBe(false);
  });
});

describe("Chronogolf public profile enrichment", () => {
  it("leases the follow-up fetch by its discovered destination family", async () => {
    const discovery = buildBrowserDiscovery({
      courseId: "public-chrono",
      courseName: "Public Chronogolf Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://www.chronogolf.com/club/public-chrono"]
    });
    const leasedFamilies: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://www.chronogolf.com/club/public-chrono",
      text: vi.fn().mockResolvedValue(
        chronogolfNextData({
          id: 4444,
          onlineBookingEnabled: true,
          courses: [{ uuid: "course-public-uuid" }]
        })
      )
    });

    const result = await enrichBrowserDiscoveryWithProviderLease(
      discovery,
      "Public Chronogolf Course",
      async (providerFamilyKey, worker) => {
        leasedFamilies.push(providerFamilyKey);
        return { acquired: true, value: await worker() };
      },
      fetchImpl as typeof fetch
    );

    expect(leasedFamilies).toEqual(["CHRONOGOLF"]);
    expect(result).toMatchObject({
      acquired: true,
      discovery: {
        status: "LEARNED",
        automationEligibility: "ALLOWED"
      }
    });
  });

  it("defers enrichment without a provider fetch or probe-ready result when its lease is busy", async () => {
    const discovery = buildBrowserDiscovery({
      courseId: "course-southers-marsh",
      courseName: "Southers Marsh Golf Club",
      sourceUrl: "https://southersmarsh.com/",
      observedUrls: ["https://southersmarsh.teesnap.net/"],
      visibleText: "Public tee times"
    });
    const fetchImpl = vi.fn();

    const result = await enrichBrowserDiscoveryWithProviderLease(
      discovery,
      "Southers Marsh Golf Club",
      async () => ({ acquired: false }),
      fetchImpl as typeof fetch
    );

    expect(result).toEqual({
      acquired: false,
      providerFamilyKey: "TEESNAP"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies a club with online booking disabled as direct-contact only", async () => {
    const discovery = buildBrowserDiscovery({
      courseId: "pequabuck",
      courseName: "Pequabuck Golf Club",
      sourceUrl: "https://pequabuckgolf.com/",
      observedUrls: ["https://chronogolf.com/club/3563/ping"]
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://www.chronogolf.com/club/pequabuck-golf-club-of-bristol",
      text: vi.fn().mockResolvedValue(
        chronogolfNextData({ id: 3563, onlineBookingEnabled: false, courses: [] })
      )
    });

    const enriched = await enrichChronogolfDiscovery(discovery, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.chronogolf.com/club/3563",
      expect.objectContaining({ redirect: "manual" })
    );
    expect(enriched).toEqual(
      expect.objectContaining({
        status: "VERIFIED",
        detectedPlatform: "CHRONOGOLF",
        bookingMethod: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        confidence: 0.95
      })
    );
    expect(enriched.policyNotes).toContain("onlineBookingEnabled=false");
  });

  it("learns current slug-based Chronogolf marketplace metadata", async () => {
    const discovery = buildBrowserDiscovery({
      courseId: "public-chrono",
      courseName: "Public Chronogolf Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://www.chronogolf.com/club/public-chrono"]
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://www.chronogolf.com/club/public-chrono",
      text: vi.fn().mockResolvedValue(
        chronogolfNextData({
          id: 4444,
          onlineBookingEnabled: true,
          courses: [{ uuid: "course-public-uuid" }]
        })
      )
    });

    const enriched = await enrichChronogolfDiscovery(discovery, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.chronogolf.com/club/public-chrono",
      expect.objectContaining({ redirect: "manual" })
    );
    expect(enriched).toEqual(
      expect.objectContaining({
        status: "LEARNED",
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        apiEndpoint: "https://www.chronogolf.com/marketplace/v2/teetimes",
        apiMetadata: {
          clubId: 4444,
          courseIds: ["course-public-uuid"],
          bookingBaseUrl: "https://www.chronogolf.com/club/public-chrono"
        }
      })
    );
  });
});

describe("CPS public configuration enrichment", () => {
  const configurationUrl =
    "https://colonie.cps.golf/onlineresweb/Home/Configuration";
  const missingCourseIdDiscovery = () =>
    buildBrowserDiscovery({
      courseId: "colonie-course",
      courseName: "Colonie Golf Course",
      sourceUrl: "https://example.test/colonie-golf",
      observedUrls: [
        "https://colonie.cps.golf/onlineresweb/search-teetime"
      ]
    });

  const validConfiguration = {
    courseId: 0,
    siteName: "colonie",
    websiteId: "public-website",
    onlineApi:
      "https://colonie.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
    authorityBaseUrl: "https://colonie.cps.golf/identityapi",
    buildNumber: "2026.07.21",
    terminalId: 9,
    apiKey: "must-not-be-persisted",
    accessToken: "must-not-persist-access-token",
    clientSecret: "must-not-persist-client-secret",
    cookies: ["must-not-persist-cookie"],
    nested: { credential: "must-not-persist-nested-secret" }
  };

  it("learns exact same-tenant metadata without persisting the published key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(cpsJsonResponse(configurationUrl, validConfiguration));

    const enriched = await enrichCpsDiscovery(
      missingCourseIdDiscovery(),
      "Colonie Golf Course",
      fetchImpl as typeof fetch
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://colonie.cps.golf/onlineresweb/Home/Configuration"),
      {
        headers: {
          Accept: "application/json",
          Referer: "https://colonie.cps.golf/",
          "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
        },
        redirect: "manual"
      }
    );
    expect(enriched).toMatchObject({
      status: "LEARNED",
      bookingUrl: "https://colonie.cps.golf/",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiEndpoint:
        "https://colonie.cps.golf/onlineres/onlineapi/api/v1/onlinereservation/TeeTimes",
      apiMetadata: {
        provider: "CPS",
        siteName: "colonie",
        bookingBaseUrl: "https://colonie.cps.golf/",
        courseIds: [0],
        holes: [18, 9],
        resolvePlaceholderCourseIds: true,
        clientId: "onlineresweb",
        websiteId: "public-website",
        onlineApi:
          "https://colonie.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
        authorityBaseUrl: "https://colonie.cps.golf/identityapi",
        buildNumber: "2026.07.21",
        terminalId: 9
      },
      confidence: 0.95,
      evidence: { learnedFrom: "cps-public-configuration" }
    });
    expect(JSON.stringify(enriched)).not.toMatch(/must-not-persist/i);
  });

  it("adds safe configuration to an exact CPS course without replacing its course id", async () => {
    const discovery = buildBrowserDiscovery({
      courseId: "capital-hills",
      courseName: "Capital Hills at Albany",
      sourceUrl: "https://www.caphills.com/bookteetimes",
      observedUrls: [
        "https://capitalhillsny.cps.golf/onlineresweb/search-teetime?CourseId=7"
      ]
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      cpsJsonResponse(
        "https://capitalhillsny.cps.golf/onlineresweb/Home/Configuration",
        {
          ...validConfiguration,
          courseId: 0,
          siteName: "capitalhillsny",
          websiteId: "capital-public-website",
          onlineApi:
            "https://capitalhillsny.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
          authorityBaseUrl: "https://capitalhillsny.cps.golf/identityapi"
        }
      )
    );

    const enriched = await enrichCpsDiscovery(
      discovery,
      "Capital Hills at Albany",
      fetchImpl as typeof fetch
    );

    expect(discovery).toMatchObject({
      status: "LEARNED",
      apiMetadata: { provider: "CPS", courseIds: [7] }
    });
    expect(enriched.apiMetadata).toEqual({
      provider: "CPS",
      siteName: "capitalhillsny",
      bookingBaseUrl: "https://capitalhillsny.cps.golf/",
      courseIds: [7],
      holes: [18, 9],
      clientId: "onlineresweb",
      websiteId: "capital-public-website",
      onlineApi:
        "https://capitalhillsny.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
      authorityBaseUrl: "https://capitalhillsny.cps.golf/identityapi",
      buildNumber: "2026.07.21",
      terminalId: 9
    });
    expect(JSON.stringify(enriched)).not.toMatch(/must-not-persist/i);
  });

  it.each([
    {
      name: "keeps a matching concrete course id",
      existingCourseIds: [7],
      configurationCourseId: 7,
      expectedCourseIds: [7],
      resolvesPlaceholder: false,
      accepted: true
    },
    {
      name: "rejects a conflicting concrete course id",
      existingCourseIds: [7],
      configurationCourseId: 8,
      expectedCourseIds: [7],
      resolvesPlaceholder: false,
      accepted: false
    },
    {
      name: "replaces a legacy placeholder with a concrete course id",
      existingCourseIds: [0],
      configurationCourseId: 7,
      expectedCourseIds: [7],
      resolvesPlaceholder: false,
      accepted: true
    },
    {
      name: "marks a configuration placeholder for runtime resolution",
      existingCourseIds: [0],
      configurationCourseId: 0,
      expectedCourseIds: [0],
      resolvesPlaceholder: true,
      accepted: true
    }
  ])("$name", async ({
    existingCourseIds,
    configurationCourseId,
    expectedCourseIds,
    resolvesPlaceholder,
    accepted
  }) => {
    const discovery = buildBrowserDiscovery({
      courseId: "example-course",
      courseName: "Example Public Golf Course",
      sourceUrl: "https://example.test/golf",
      observedUrls: [
        existingCourseIds[0] > 0
          ? `https://examplepublic.cps.golf/onlineresweb/search-teetime?CourseId=${existingCourseIds[0]}`
          : "https://examplepublic.cps.golf/onlineresweb/search-teetime"
      ]
    });
    const enriched = await enrichCpsDiscovery(
      discovery,
      "Example Public Golf Course",
      vi.fn().mockResolvedValue(
        cpsJsonResponse(
          "https://examplepublic.cps.golf/onlineresweb/Home/Configuration",
          {
            ...validConfiguration,
            courseId: configurationCourseId,
            siteName: "examplepublic",
            websiteId: "example-public-website",
            onlineApi:
              "https://examplepublic.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
            authorityBaseUrl: "https://examplepublic.cps.golf/identityapi"
          }
        )
      ) as typeof fetch
    );

    expect(enriched.apiMetadata).toMatchObject({
      provider: "CPS",
      courseIds: expectedCourseIds
    });
    if (resolvesPlaceholder) {
      expect(enriched.apiMetadata).toHaveProperty(
        "resolvePlaceholderCourseIds",
        true
      );
    } else {
      expect(enriched.apiMetadata).not.toHaveProperty(
        "resolvePlaceholderCourseIds"
      );
    }
    expect(enriched.evidence.learnedFrom).toBe(
      accepted
        ? "cps-public-configuration"
        : "cps-public-configuration-invalid"
    );
  });

  it("does not opt a concrete configuration course id into placeholder resolution", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      cpsJsonResponse(configurationUrl, {
        ...validConfiguration,
        courseId: 7
      })
    );

    const enriched = await enrichCpsDiscovery(
      missingCourseIdDiscovery(),
      "Colonie Golf Course",
      fetchImpl as typeof fetch
    );

    expect(enriched.apiMetadata).toMatchObject({
      provider: "CPS",
      courseIds: [7]
    });
    expect(enriched.apiMetadata).not.toHaveProperty(
      "resolvePlaceholderCourseIds"
    );
  });

  it("leases the configuration read under the CPS family", async () => {
    const leasedFamilies: string[] = [];
    const result = await enrichBrowserDiscoveryWithProviderLease(
      missingCourseIdDiscovery(),
      "Colonie Golf Course",
      async (providerFamilyKey, worker) => {
        leasedFamilies.push(providerFamilyKey);
        return { acquired: true, value: await worker() };
      },
      vi.fn().mockResolvedValue(
        cpsJsonResponse(configurationUrl, validConfiguration)
      ) as typeof fetch
    );

    expect(leasedFamilies).toEqual(["CPS"]);
    expect(result).toMatchObject({
      acquired: true,
      discovery: { status: "LEARNED" }
    });
  });

  it.each([
    {
      name: "a cross-tenant API endpoint",
      courseName: "Colonie Golf Course",
      responseUrl: "https://colonie.cps.golf/onlineresweb/Home/Configuration",
      configuration: {
        ...validConfiguration,
        onlineApi:
          "https://other.cps.golf/onlineres/onlineapi/api/v1/onlinereservation"
      }
    },
    {
      name: "a same-host authority path outside the identity API",
      courseName: "Colonie Golf Course",
      responseUrl: configurationUrl,
      configuration: {
        ...validConfiguration,
        authorityBaseUrl: "https://colonie.cps.golf/onlineres/onlineapi"
      }
    },
    {
      name: "a queried API endpoint",
      courseName: "Colonie Golf Course",
      responseUrl: configurationUrl,
      configuration: {
        ...validConfiguration,
        onlineApi:
          "https://colonie.cps.golf/onlineres/onlineapi/api/v1/onlinereservation?tenant=other"
      }
    },
    {
      name: "a mismatched tenant identity",
      courseName: "Different Municipal Golf Course",
      responseUrl: "https://colonie.cps.golf/onlineresweb/Home/Configuration",
      configuration: validConfiguration
    },
    {
      name: "an invalid course id",
      courseName: "Colonie Golf Course",
      responseUrl: "https://colonie.cps.golf/onlineresweb/Home/Configuration",
      configuration: { ...validConfiguration, courseId: -1 }
    },
    {
      name: "a fractional course id",
      courseName: "Colonie Golf Course",
      responseUrl: configurationUrl,
      configuration: { ...validConfiguration, courseId: 1.5 }
    },
    {
      name: "a string course id",
      courseName: "Colonie Golf Course",
      responseUrl: configurationUrl,
      configuration: { ...validConfiguration, courseId: "0" }
    }
  ])("rejects $name", async ({ courseName, responseUrl, configuration }) => {
    const enriched = await enrichCpsDiscovery(
      missingCourseIdDiscovery(),
      courseName,
      vi.fn().mockResolvedValue(
        cpsJsonResponse(responseUrl, configuration)
      ) as typeof fetch
    );

    expect(enriched.status).toBe("INSPECTED");
    expect(enriched.apiMetadata).toBeUndefined();
    expect(enriched.evidence.learnedFrom).toBe(
      "cps-public-configuration-invalid"
    );
  });

  it.each([
    {
      name: "a manual redirect",
      response: cpsResponseAt(configurationUrl, null, {
        status: 302,
        headers: { location: "https://other.cps.golf/configuration" }
      })
    },
    {
      name: "a followed redirect",
      response: cpsResponseAt(
        "https://other.cps.golf/onlineresweb/Home/Configuration",
        JSON.stringify(validConfiguration),
        { status: 200, headers: { "content-type": "application/json" } },
        true
      )
    },
    {
      name: "a wrong final path",
      response: cpsJsonResponse(
        "https://colonie.cps.golf/onlineresweb/Home/Other",
        validConfiguration
      )
    }
  ])("rejects $name", async ({ response }) => {
    const enriched = await enrichCpsDiscovery(
      missingCourseIdDiscovery(),
      "Colonie Golf Course",
      vi.fn().mockResolvedValue(response) as typeof fetch
    );

    expect(enriched.status).toBe("INSPECTED");
    expect(enriched.apiMetadata).toBeUndefined();
    expect(enriched.evidence.learnedFrom).toBe(
      "cps-public-configuration-redirected"
    );
  });

  it.each([
    {
      name: "a missing JSON content type",
      response: cpsResponseAt(configurationUrl, JSON.stringify(validConfiguration), {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    },
    {
      name: "malformed JSON",
      response: cpsResponseAt(configurationUrl, "{not-json", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    },
    {
      name: "an oversized declared body",
      response: cpsResponseAt(configurationUrl, JSON.stringify(validConfiguration), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(64 * 1024 + 1)
        }
      })
    },
    {
      name: "an oversized actual body",
      response: cpsResponseAt(
        configurationUrl,
        JSON.stringify({ ...validConfiguration, padding: "x".repeat(64 * 1024) }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }
  ])("keeps $name non-runnable", async ({ response }) => {
    const enriched = await enrichCpsDiscovery(
      missingCourseIdDiscovery(),
      "Colonie Golf Course",
      vi.fn().mockResolvedValue(response) as typeof fetch
    );

    expect(enriched.status).toBe("INSPECTED");
    expect(enriched.apiMetadata).toBeUndefined();
    expect(enriched.evidence.learnedFrom).toBe(
      "cps-public-configuration-invalid"
    );
  });

  it("does not enrich conflicting course IDs from a shared CPS tenant", async () => {
    const discovery = buildBrowserDiscovery({
      courseId: "shared-course",
      courseName: "Shared Facility Golf Course",
      sourceUrl: "https://shared.example/golf",
      observedUrls: [
        "https://sharedfacility.cps.golf/onlineresweb/search-teetime?CourseId=11",
        "https://sharedfacility.cps.golf/onlineresweb/search-teetime?CourseId=22"
      ]
    });
    const fetchImpl = vi.fn();

    const enriched = await enrichCpsDiscovery(
      discovery,
      "Shared Facility Golf Course",
      fetchImpl as typeof fetch
    );

    expect(discovery.evidence.learnedFrom).toBe("cps-course-id-ambiguous");
    expect(enriched).toBe(discovery);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps an unavailable public configuration retryable", async () => {
    const enriched = await enrichCpsDiscovery(
      missingCourseIdDiscovery(),
      "Colonie Golf Course",
      vi.fn().mockResolvedValue(
        cpsResponseAt(configurationUrl, "Denied", { status: 403 })
      ) as typeof fetch
    );

    expect(enriched.status).toBe("INSPECTED");
    expect(enriched.apiMetadata).toBeUndefined();
    expect(enriched.evidence.learnedFrom).toBe(
      "cps-public-configuration-unavailable"
    );
  });
});

describe("GolfNow public booking discovery", () => {
  it("learns reusable facility metadata from one exact public search page", () => {
    const bookingUrl =
      "https://www.golfnow.com/tee-times/facility/10296-hunter-golf-course/search";
    const discovery = buildBrowserDiscovery({
      courseId: "hunter",
      courseName: "Hunter Golf Course",
      sourceUrl: "https://stewarthunter.armymwr.com/programs/hunter-golf-course",
      finalUrl: bookingUrl,
      observedUrls: [bookingUrl],
      linkCandidates: [{ url: bookingUrl, label: "Book online tee times" }],
      officialPage: {
        url: "https://stewarthunter.armymwr.com/programs/hunter-golf-course",
        courseName: "Hunter Golf Course",
        linkCandidates: [{ url: bookingUrl, label: "Book online tee times" }]
      },
      visibleText: "We book tee times one week in advance. Book online."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "GOLFNOW",
      bookingUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      apiEndpoint:
        "https://www.golfnow.com/api/tee-times/tee-time-search-results",
      apiMetadata: {
        provider: "GOLFNOW",
        facilityId: 10296,
        bookingBaseUrl: bookingUrl
      },
      evidence: expect.objectContaining({
        learnedFrom: "golfnow-public-facility-search"
      })
    });
  });

  it("does not merge multiple GolfNow facility identities", () => {
    const first =
      "https://www.golfnow.com/tee-times/facility/10296-hunter-golf-course/search";
    const second =
      "https://www.golfnow.com/tee-times/facility/99999-other-course/search";
    const discovery = buildBrowserDiscovery({
      courseId: "hunter",
      courseName: "Hunter Golf Course",
      sourceUrl: "https://stewarthunter.armymwr.com/programs/hunter-golf-course",
      observedUrls: [first, second],
      linkCandidates: [
        { url: first, label: "Hunter tee times" },
        { url: second, label: "Other tee times" }
      ]
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
    expect(discovery.evidence.learnedFrom).toBe("provider-evidence-conflict");
  });
});

describe("Agilysys public booking discovery", () => {
  const bookingUrl =
    "https://book.onagilysys.com/onecart/golf/courses/553/biltmorehotel";
  const teeSheetUrl =
    "https://book.onagilysys.com/wbe-golf-service/golf/tenants/553/propertyId/biltmorehotel/getAvailableTeeSlots?fromDate=2026-07-23&toDate=2026-07-23&courseId=560&playerTypeId=2281&holes=0&appName=golf";

  it("learns reusable tenant and course metadata from the official public tee sheet", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "biltmore",
      courseName: "Biltmore Golf Course Miami",
      sourceUrl: "https://biltmorehotel.com/miami-golf-resort/",
      finalUrl: `${bookingUrl}?date=2026-07-23&id=560`,
      observedUrls: [
        `${bookingUrl}?date=2026-07-23&id=560`,
        teeSheetUrl
      ],
      linkCandidates: [{ url: bookingUrl, label: "Book Tee Time" }],
      officialPage: {
        url: "https://biltmorehotel.com/miami-golf-resort/",
        courseName: "Biltmore Golf Course Miami",
        linkCandidates: [{ url: bookingUrl, label: "Book Tee Time" }]
      },
      visibleText: "Championship Golf Course. Book Tee Time."
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "CUSTOM",
      bookingUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      apiMetadata: {
        provider: "AGILYSYS",
        tenantId: 553,
        propertyId: "biltmorehotel",
        courseId: 560,
        playerTypeId: 2281,
        bookingBaseUrl: bookingUrl
      },
      evidence: expect.objectContaining({
        learnedFrom: "agilysys-public-course-tee-sheet"
      })
    });
  });

  it("refuses ambiguous course or player identities", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "biltmore",
      courseName: "Biltmore Golf Course Miami",
      sourceUrl: "https://biltmorehotel.com/miami-golf-resort/",
      observedUrls: [
        bookingUrl,
        teeSheetUrl,
        teeSheetUrl.replace("courseId=560", "courseId=561")
      ],
      linkCandidates: [{ url: bookingUrl, label: "Book Tee Time" }]
    });

    expect(discovery.status).toBe("INSPECTED");
    expect(discovery.apiMetadata).toBeUndefined();
  });
});

describe("TenFore public booking enrichment", () => {
  it("keeps public browser-visible TenFore availability in adapter review", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "gainfield",
      courseName: "Gainfield Farms Golf Course",
      sourceUrl: "https://gainfieldgolf.com/",
      finalUrl: "https://gainfieldgolf.com/simulator-at-gainfield-farms/",
      observedUrls: [
        "https://fox.tenfore.golf/gainfieldfarms",
        "https://gainfieldgolf.com/simulator-at-gainfield-farms/"
      ]
    });

    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      bookingUrl: "https://fox.tenfore.golf/gainfieldfarms",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "NONE",
      confidence: 0.95,
      evidence: expect.objectContaining({
        learnedFrom: "tenfore-public-browser-availability"
      })
    });
    expect(discovery.policyNotes).toContain("renders public tee-time availability");
    expect(discovery.policyNotes).toContain("keep adapter work open");
  });
});

function chronogolfNextData(input: {
  id: number;
  onlineBookingEnabled: boolean;
  courses: Array<{ uuid?: string }>;
}) {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        club: {
          id: input.id,
          features: { onlineBookingEnabled: input.onlineBookingEnabled },
          courses: input.courses
        }
      }
    }
  })}</script></html>`;
}

function cpsJsonResponse(url: string, value: unknown) {
  return cpsResponseAt(url, JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function cpsResponseAt(
  url: string,
  body: BodyInit | null,
  init: ResponseInit,
  redirected = false
) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  Object.defineProperty(response, "redirected", { value: redirected });
  return response;
}
