import { describe, expect, it, vi } from "vitest";

import {
  buildBrowserDiscovery,
  enrichBrowserDiscoveryWithProviderLease,
  enrichChronogolfDiscovery,
  enrichTeesnapDiscovery,
  findCorroboratingAccessBarrier,
  getBestProbeUrl,
  keepPolicyOnlyDiscoveryActionable,
  sanitizeBrowserDiscoveryAccessEvidence,
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

  it("canonicalizes TeeItUp store links to the provider booking root", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "little-harbor",
      courseName: "Little Harbor Golf Course",
      sourceUrl: "https://littleharborgolf.com/",
      finalUrl:
        "https://little-harbor-country-club.book.teeitup.com/store/gift-certificates",
      observedUrls: [
        "https://little-harbor-country-club.book.teeitup.com/store/gift-certificates"
      ],
      visibleText: "Book tee times"
    });

    expect(discovery).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingUrl: "https://little-harbor-country-club.book.teeitup.com/",
      apiMetadata: {
        aliases: ["little-harbor-country-club"],
        bookingBaseUrl: "https://little-harbor-country-club.book.teeitup.com/"
      }
    });
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
      evidence: { learnedFrom: "cps-course-id-missing" }
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("classifies a managed-challenge CPS surface as direct booking", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "grassy-hill",
      courseName: "Grassy Hill Country Club",
      sourceUrl: "http://www.grassyhillcountryclub.com/",
      finalUrl: "https://grassyhill.cps.golf/",
      observedUrls: [
        "https://secure.east.prophetservices.com/GrassyHillCCV3",
        "https://grassyhill.cps.golf/"
      ],
      accessBarrierUrls: ["https://grassyhill.cps.golf/"],
      visibleText: "Book Online Tee Times"
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      detectedPlatform: "CUSTOM",
      bookingUrl: "https://grassyhill.cps.golf/",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      evidence: { learnedFrom: "cps-managed-challenge-booking" }
    });
    expect(discovery.apiMetadata).toBeUndefined();
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
      evidence: { learnedFrom: "cps-course-id-missing" }
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
      "teesnap-url-without-course-id:observed-course-config-mismatch"
    );
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
        redirect: "follow"
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
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "CONTACT_COURSE",
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
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "CONTACT_COURSE",
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
      status: "VERIFIED",
      detectedPlatform: "CUSTOM",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
      bookingUrl: "https://app.whoosh.io/patron/club/yale-golf-course",
      confidence: 0.9,
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
      evidence: { learnedFrom: "official-account-required-booking" }
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
      status: "VERIFIED",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
      evidence: { learnedFrom: "official-whoosh-booking-policy-evidence" }
    });
  });

  it("keeps Whoosh under review when current provider terms cannot be verified", () => {
    const discovery = buildBrowserDiscovery({
      courseId: "unverified-whoosh",
      courseName: "Example Whoosh Course",
      sourceUrl: "https://example.com/",
      observedUrls: ["https://app.whoosh.io/patron/club/example-course"],
      visibleText: "Public online booking with Whoosh."
    });

    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
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
    const policyDiscovery = buildBrowserDiscovery({
      courseId: "course-whoosh",
      courseName: "Public Whoosh Course",
      sourceUrl: "https://example.com/tee-times",
      finalUrl: "https://app.whoosh.io/patron/club/public-course",
      observedUrls: ["https://app.whoosh.io/patron/club/public-course"],
      providerPolicyUrl: "https://www.whoosh.io/terms",
      providerPolicyText:
        "You may not attempt to access or search the Whoosh platform or content using any engine, software, tool, agent, device, or mechanism, including robots, spiders, crawlers, or data mining tools."
    });

    expect(policyDiscovery).toMatchObject({
      status: "VERIFIED",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM"
    });

    const legacyPolicyBlock = {
      ...policyDiscovery,
      automationEligibility: "BLOCKED" as const,
      automationReason: "AUTOMATION_PROHIBITED" as const,
      confidence: 0.99,
      evidence: {
        ...policyDiscovery.evidence,
        learnedFrom: "legacy-policy-block"
      }
    };
    expect(keepPolicyOnlyDiscoveryActionable(legacyPolicyBlock)).toMatchObject({
      status: "VERIFIED",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
      bookingUrl: "https://app.whoosh.io/patron/club/public-course",
      confidence: 0.95,
      evidence: {
        learnedFrom: "legacy-policy-block:policy-evidence-only"
      }
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
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
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
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
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
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
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
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
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

  it("keeps all blocked courses out of the interactive browser probe", () => {
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
      expect.objectContaining({ redirect: "follow" })
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
      expect.objectContaining({ redirect: "follow" })
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

describe("TenFore public booking enrichment", () => {
  it("keeps the official booking link while blocking captcha-protected retrieval", () => {
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
      status: "VERIFIED",
      detectedPlatform: "CUSTOM",
      bookingUrl: "https://fox.tenfore.golf/gainfieldfarms",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      confidence: 0.98,
      evidence: expect.objectContaining({
        learnedFrom: "tenfore-captcha-protected-booking"
      })
    });
    expect(discovery.policyNotes).toContain("reCAPTCHA token");
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
