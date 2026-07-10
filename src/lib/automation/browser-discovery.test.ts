import { describe, expect, it } from "vitest";

import {
  buildBrowserDiscovery,
  getBestProbeUrl,
  shouldQueueBrowserProbe,
  type BrowserDiscoveryEvidence
} from "./browser-discovery";

describe("buildBrowserDiscovery", () => {
  it("learns reusable ForeUP metadata from browser-observed API requests", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "Oak Hills Park Golf Course",
      sourceUrl: "https://www.oakhillsgc.com/tee-times",
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

  it("learns reusable TeeItUp metadata from booking links", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "Fairchild Wheeler Golf Course",
      sourceUrl: "https://www.fairchildwheelergolf.com/teetimes/",
      finalUrl: "https://www.fairchildwheelergolf.com/teetimes/",
      observedUrls: [
        "https://fairchild-wheeler-red-course.book.teeitup.golf/",
        "https://fairchild-wheeler-golf-course-black-course.book.teeitup.golf/"
      ],
      visibleText: "Red Course Black Course"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("LEARNED");
    expect(discovery.detectedPlatform).toBe("TEEITUP");
    expect(discovery.bookingUrl).toBe("https://fairchild-wheeler-red-course.book.teeitup.golf/");
    expect(discovery.apiEndpoint).toBe("https://phx-api-be-east-1b.kenna.io/v2/tee-times");
    expect(discovery.apiMetadata).toEqual({
      aliases: [
        "fairchild-wheeler-red-course",
        "fairchild-wheeler-golf-course-black-course"
      ],
      bookingBaseUrl: "https://fairchild-wheeler-red-course.book.teeitup.golf/"
    });
  });

  it("learns TeeItUp metadata from legacy .com booking links", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-richter",
      courseName: "Richter Park Golf Course",
      sourceUrl: "https://www.richterpark.com/request_tt/",
      finalUrl: "https://www.richterpark.com/request_tt/",
      observedUrls: ["https://richter-park-golf-course.book.teeitup.com/"],
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

  it("learns reusable CPS metadata from CPS booking links", () => {
    const evidence: BrowserDiscoveryEvidence = {
      courseId: "course-1",
      courseName: "The Tradition Golf Club at Oak Lane",
      sourceUrl: "https://www.traditionatoaklane.com/",
      finalUrl: "https://traditionoaklane.cps.golf/",
      observedUrls: ["https://traditionoaklane.cps.golf/onlineresweb/search-teetime"],
      visibleText: "Tradition Golf Club at Oak Lane"
    };

    const discovery = buildBrowserDiscovery(evidence);

    expect(discovery.status).toBe("LEARNED");
    expect(discovery.detectedPlatform).toBe("CUSTOM");
    expect(discovery.bookingUrl).toBe("https://traditionoaklane.cps.golf/");
    expect(discovery.apiEndpoint).toBe(
      "https://traditionoaklane.cps.golf/onlineres/onlineapi/api/v1/onlinereservation/TeeTimes"
    );
    expect(discovery.apiMetadata).toEqual({
      provider: "CPS",
      siteName: "traditionoaklane",
      bookingBaseUrl: "https://traditionoaklane.cps.golf/",
      courseIds: [1, 2],
      holes: [18, 9]
    });
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
});
