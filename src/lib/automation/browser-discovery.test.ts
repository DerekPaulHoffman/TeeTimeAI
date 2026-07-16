import { describe, expect, it, vi } from "vitest";

import {
  buildBrowserDiscovery,
  enrichChronogolfDiscovery,
  enrichTeesnapDiscovery,
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
      courseName: "New London Golf Course",
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

  it("blocks automated Whoosh retrieval under the current provider terms while preserving direct booking", () => {
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
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED",
      bookingUrl: "https://app.whoosh.io/patron/club/yale-golf-course",
      confidence: 0.99,
      evidence: { learnedFrom: "whoosh-automation-prohibited-booking" }
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

  it("preserves direct public Whoosh booking while blocking prohibited automated retrieval", () => {
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
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED",
      evidence: { learnedFrom: "whoosh-automation-prohibited-booking" }
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
        "Our Eighteen Hole Par 3 Golf Course is open to the public. Prices Adult Weekdays - $17.00 Senior Weekdays - $13.00 Weekends and Holidays - $18.00. Location and Hours 112 Allen Street 413.525.4444. Hours of operation may vary by season. Please contact us for details."
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
});

describe("Chronogolf public profile enrichment", () => {
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
