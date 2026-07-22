import { describe, expect, it } from "vitest";

import {
  buildProviderFailureFingerprint,
  classifyProviderFailure,
  deriveConsumerDisposition,
  getKnownProviderFamilyForHostname,
  getProviderPublicBookingLandingIdentity,
  getProviderReadinessFailure,
  isEffectiveConsumerCoverage,
  isProviderInfrastructureUrl,
  isProviderPublicBookingLandingUrl,
  isProviderMetadataReady,
  normalizeProviderFamilyKey,
  PROVIDER_CAPABILITIES,
  resolveProviderCapability,
  resolveProviderDiscoveryIdentity,
  SOURCE_CONFLICT_PROVIDER_FAMILY,
  SOURCE_MISSING_PROVIDER_FAMILY,
  type ConsumerDisposition,
  type CourseSupportFailureClass
} from "./provider-capabilities";

const runnableMetadata = {
  FOREUP: {
    scheduleId: 6654,
    bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
  },
  TEEITUP: {
    aliases: ["public-course"],
    bookingBaseUrl: "https://public-course.book.teeitup.golf/"
  },
  CHRONOGOLF: {
    clubId: 7221,
    courseIds: ["public-course-uuid"],
    bookingBaseUrl: "https://www.chronogolf.com/club/public-course"
  },
  CPS: {
    provider: "CPS",
    siteName: "public-course",
    bookingBaseUrl: "https://public-course.cps.golf/",
    courseIds: [1]
  },
  CHELSEA: {
    provider: "CHELSEA",
    bookingBaseUrl: "https://public-course.chelseareservations.com/",
    courseCode: 1,
    courseLabel: "Public"
  },
  TEESNAP: {
    provider: "TEESNAP",
    courseId: 1210,
    bookingBaseUrl: "https://public-course.teesnap.net/"
  },
  GOLFBACK: {
    provider: "GOLFBACK",
    courseId: "123e4567-e89b-42d3-a456-426614174000",
    bookingBaseUrl:
      "https://golfback.com/#/course/123e4567-e89b-42d3-a456-426614174000"
  },
  GOLF_WITH_ACCESS: {
    provider: "GOLF_WITH_ACCESS",
    courseIds: ["123e4567-e89b-42d3-a456-426614174000"],
    bookingBaseUrl:
      "https://golfwithaccess.com/course/public-course/reserve-tee-time"
  },
  WEBTRAC: {
    provider: "WEBTRAC",
    bookingBaseUrl:
      "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=25",
    courseCode: "25"
  },
  CLUB_CADDIE: {
    provider: "CLUB_CADDIE",
    bookingBaseUrl:
      "https://apimanager-cc12.clubcaddie.com/webapi/view/public-course/slots"
  },
  WHOOSH: {
    provider: "WHOOSH",
    clubSlug: "public-course",
    bookingBaseUrl: "https://app.whoosh.io/patron/club/public-course"
  }
} as const;

describe("provider capability registry", () => {
  it.each([
    "https://api.ezlinksgolf.com/v1/public-tee-times",
    "https://public-api.ezlinksgolf.com/tee-times",
    "https://booking-api.ezlinksgolf.com/",
    "https://public-course.ezlinksgolf.com/api.php",
    "https://public-course.ezlinksgolf.com/api-v1/public-tee-times",
    "https://public-course.ezlinksgolf.com/api2/public-tee-times",
    "https://public-course.ezlinksgolf.com/openapi/tee-times",
    "https://public-course.ezlinksgolf.com/swagger/tee-times",
    "https://public-course.ezlinksgolf.com/tee-times.json",
    "https://public-course.ezlinksgolf.com/tee-times?format=json",
    "https://apiqa.ezlinksgolf.com/tee-times",
    "https://api-v2.book.teeitup.golf/",
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
    "https://public-course.ezlinksgolf.com/tee-times?response=application%2Fxml",
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
    "https://public-course.ezlinksgolf.com/tee-times?format=application%2Fx-ndjson",
    "https://public-course.ezlinksgolf.com/tee-times?format=geojson",
    "https://public-course.ezlinksgolf.com/tee-times?output=geojson",
    "https://public-course.ezlinksgolf.com/tee-times?callback=handleResponse",
    "https://public-course.ezlinksgolf.com/tee-times?jsoncallback=handleResponse",
    "https://public-course.ezlinksgolf.com/tee-times?f=pjson",
    "https://public-course.ezlinksgolf.com/tee-times?format=application%2Fjson-seq",
    "https://public-course.ezlinksgolf.com/tee-times?jsonp=handleResponse",
    "https://public-course.ezlinksgolf.com/tee-times?path=%2Fapi%2Fv1",
    "https://public-course.ezlinksgolf.com/tee-times#/api/config",
    "https://foreupsoftware.com/index.php/booking/21017#/api/config"
  ])("rejects provider infrastructure discovery URL %s", (url) => {
    expect(isProviderInfrastructureUrl(url)).toBe(true);
  });

  it.each([
    "https://public-course.book.teeitup.golf/?course=24680&course=99999",
    "https://public-course.book.teeitup.golf/?course=24680&date=2026-99-99",
    "https://public-course.book.teeitup.golf/?course=24680&players=999999999&holes=999&max=999999999",
    "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR&module=XX&secondarycode=25&secondarycode=99",
    "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR",
    "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR&utm_source=course",
    "https://capitalhillsny.cps.golf/onlineresweb/search-teetime?CourseId=999999999999999999999999"
  ])("rejects invalid provider booking query shape %s", (url) => {
    expect(isProviderPublicBookingLandingUrl(url)).toBe(false);
  });

  it.each([
    "https://public-course.ezlinksgolf.com/",
    "https://public-course.ezlinksgolf.com/tee-times",
    "https://public-course.ezlinksgolf.com/public-booking",
    "https://forest.ezlinksgolf.com/tee-times",
    "https://public-course.ezlinksgolf.com/oak-forest/tee-times",
    "https://public-course.ezlinksgolf.com/oak-forest/search",
    "https://public-course.ezlinksgolf.com/index.html#/search",
    "https://cedar-ridge-golf-course-v2.book.teeitup.com/",
    "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
    "https://fox.tenfore.golf/gainfieldfarms",
    "https://dennis.chelseareservations.com/GPInprocess"
  ])("keeps public booking landing URL %s", (url) => {
    expect(isProviderInfrastructureUrl(url)).toBe(false);
    expect(isProviderPublicBookingLandingUrl(url)).toBe(true);
  });

  it.each([
    "https://capitalhillsny.cps.golf/onlineresweb/search-teetime?CourseId=7",
    "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=25",
    "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=25&interfaceparameter=webtrac_se",
    "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=course-code-123456789012",
    "https://public-course.book.teeitup.golf/?course=24680&date=2026-07-24&max=10"
  ])("keeps an explicit provider-family booking query shape %s", (url) => {
    expect(isProviderPublicBookingLandingUrl(url)).toBe(true);
  });

  it.each([
    "https://public-course.ezlinksgolf.com/?utm_source=json&utm_medium=course",
    "https://capitalhillsny.cps.golf/onlineresweb/search-teetime?CourseId=7&utm_source=course",
    "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=25&gclid=tracking",
    "https://public-course.book.teeitup.golf/?course=24680&date=2026-07-24&fbclid=tracking",
    "https://fox.tenfore.golf/gainfieldfarms?utm_campaign=summer",
    "https://dennis.chelseareservations.com/GPInprocess?_gl=tracking"
  ])("ignores tracking-only query parameters on a valid provider landing %s", (url) => {
    expect(isProviderInfrastructureUrl(url)).toBe(false);
    expect(isProviderPublicBookingLandingUrl(url)).toBe(true);
  });

  it("allows tracking-only state on the exact Club Caddie public view exception", () => {
    expect(
      isProviderPublicBookingLandingUrl(
        "https://apimanager-cc12.clubcaddie.com/webapi/view/public-course/slots?utm_source=course"
      )
    ).toBe(true);
  });

  it("keeps provider landing identity stable across harmless variants but distinct across course selectors", () => {
    expect(
      getProviderPublicBookingLandingIdentity(
        "https://public-course.ezlinksgolf.com/?utm_source=course"
      )
    ).toBe(
      getProviderPublicBookingLandingIdentity(
        "https://public-course.ezlinksgolf.com/"
      )
    );
    expect(
      getProviderPublicBookingLandingIdentity(
        "https://foreupsoftware.com/index.php/booking/21017/6654#teetimes"
      )
    ).toBe(
      getProviderPublicBookingLandingIdentity(
        "https://foreupsoftware.com/index.php/booking/21017/6654#/teetimes"
      )
    );
    expect(
      getProviderPublicBookingLandingIdentity(
        "https://apimanager-cc12.clubcaddie.com/webapi/view/public-course"
      )
    ).toBe(
      getProviderPublicBookingLandingIdentity(
        "https://apimanager-cc12.clubcaddie.com/webapi/view/public-course/slots"
      )
    );
    expect(
      getProviderPublicBookingLandingIdentity(
        "https://public-course.ezlinksgolf.com/sibling/tee-times"
      )
    ).not.toBe(
      getProviderPublicBookingLandingIdentity(
        "https://public-course.ezlinksgolf.com/target/tee-times"
      )
    );
    expect(
      getProviderPublicBookingLandingIdentity(
        "https://public-course.ezlinksgolf.com/sibling/search"
      )
    ).not.toBe(
      getProviderPublicBookingLandingIdentity(
        "https://public-course.ezlinksgolf.com/target/search"
      )
    );
    expect(
      getProviderPublicBookingLandingIdentity(
        "https://public-course.ezlinksgolf.com/index.html#/search"
      )
    ).toBe(
      getProviderPublicBookingLandingIdentity(
        "https://public-course.ezlinksgolf.com/"
      )
    );
    expect(
      getProviderPublicBookingLandingIdentity(
        "https://target.book.teeitup.golf/?course=111"
      )
    ).not.toBe(
      getProviderPublicBookingLandingIdentity(
        "https://target.book.teeitup.golf/?course=222"
      )
    );
  });

  it.each([
    "https://public-course.ezlinksgolf.com/?utm_source=course&date=2026-07-24",
    "https://capitalhillsny.cps.golf/onlineresweb/search-teetime?CourseId=7&CourseId=8&utm_source=course",
    "https://public-course.book.teeitup.golf/?course=24680&unexpected=value&utm_source=course"
  ])("still rejects functional unknowns or duplicates beside tracking %s", (url) => {
    expect(isProviderPublicBookingLandingUrl(url)).toBe(false);
  });

  it.each([
    "https://public-course.ezlinksgolf.com/tee-times/checkout",
    "https://public-course.ezlinksgolf.com/oak-forest/search/checkout",
    "https://public-course.ezlinksgolf.com/tee-times/account",
    "https://public-course.ezlinksgolf.com/tee-times/cart",
    "https://public-course.ezlinksgolf.com/tee-times/payment",
    "https://course.whoosh.io/patron/club/public-course/checkout",
    "https://capitalhillsny.cps.golf/onlineresweb/search-teetime/checkout?CourseId=7",
    "https://foreupsoftware.com/index.php/booking/21017/checkout#/teetimes",
    "https://public-course.ezlinksgolf.com/tee-times#checkout",
    "https://public-course.ezlinksgolf.com/index.html#/checkout",
    "https://public-course.ezlinksgolf.com/index.html#/account",
    "https://public-course.ezlinksgolf.com/index.html#/offers",
    "https://public-course.ezlinksgolf.com/booking/transaction",
    "https://public-course.ezlinksgolf.com/tee-times/confirm",
    "https://public-course.ezlinksgolf.com/tee-times/confirmation",
    "https://public-course.ezlinksgolf.com/tee-times/complete",
    "https://public-course.ezlinksgolf.com/tee-times/success",
    "https://public-course.ezlinksgolf.com/members/tee-times",
    "https://public-course.ezlinksgolf.com/profile/tee-times",
    "https://public-course.ezlinksgolf.com/sign-in/tee-times",
    "https://public-course.ezlinksgolf.com/log-in/tee-times",
    "https://public-course.ezlinksgolf.com/my-account/tee-times",
    "https://public-course.ezlinksgolf.com/session/tee-times",
    "https://cart.ezlinksgolf.com/tee-times",
    "https://transaction.ezlinksgolf.com/tee-times",
    "https://order.ezlinksgolf.com/tee-times",
    "https://purchase.ezlinksgolf.com/tee-times"
  ])("rejects provider transaction or access surface %s", (url) => {
    expect(isProviderPublicBookingLandingUrl(url)).toBe(false);
  });

  it.each([
    "https://finalize.ezlinksgolf.com/tee-times",
    "https://public-course.ezlinksgolf.com/submit/tee-times",
    "https://www.chronogolf.com/club/commit",
    "https://public.navyaims.com/completion/webtrac/web/search.html?module=GR&secondarycode=25",
    "https://www.golfnow.com/course/finish",
    "https://www.golfnow.com/tee-times/facility/finished",
    "https://app.whoosh.io/patron/club/done",
    "https://fox.tenfore.golf/finalise",
    "https://apimanager-cc12.clubcaddie.com/webapi/view/completion"
  ])("rejects provider action aliases in tenant or course identifier slots %s", (url) => {
    expect(isProviderPublicBookingLandingUrl(url)).toBe(false);
  });

  it.each([
    "https://www.chronogolf.com/club/donegal",
    "https://fox.tenfore.golf/donegal",
    "https://apimanager-cc12.clubcaddie.com/webapi/view/donegal"
  ])("does not reject a real identifier merely because it contains an action substring %s", (url) => {
    expect(isProviderPublicBookingLandingUrl(url)).toBe(true);
  });

  it.each([
    "https://apimanager-cc12.clubcaddie.com/webapi/view/public-course",
    "https://apimanager-cc12.clubcaddie.com/webapi/view/public-course/slots"
  ])("keeps the exact public Club Caddie view surface %s", (url) => {
    expect(isProviderPublicBookingLandingUrl(url)).toBe(true);
  });

  it("keeps a plausible Gateway course tenant while rejecting technical gateway query routes", () => {
    expect(
      isProviderPublicBookingLandingUrl(
        "https://gateway.ezlinksgolf.com/tee-times"
      )
    ).toBe(true);
    expect(
      isProviderPublicBookingLandingUrl(
        "https://gateway.ezlinksgolf.com/tee-times?endpoint=gateway"
      )
    ).toBe(false);
  });

  it("keeps every current adapter distinct while preserving the external platform enum", () => {
    expect(
      Object.fromEntries(
        Object.entries(PROVIDER_CAPABILITIES).map(([family, capability]) => [
          family,
          [capability.supportsAutomation, capability.detectedPlatform]
        ])
      )
    ).toMatchObject({
      FOREUP: [true, "FOREUP"],
      TEEITUP: [true, "TEEITUP"],
      CHRONOGOLF: [true, "CHRONOGOLF"],
      CPS: [true, "CUSTOM"],
      CHELSEA: [true, "CUSTOM"],
      TEESNAP: [true, "CUSTOM"],
      GOLFBACK: [true, "CUSTOM"],
      GOLF_WITH_ACCESS: [true, "CUSTOM"],
      WEBTRAC: [true, "CUSTOM"],
      EZLINKS: [false, "CUSTOM"],
      GOLFNOW: [false, "GOLFNOW"],
      CLUB_CADDIE: [true, "CLUB_CADDIE"],
      WHOOSH: [true, "CUSTOM"],
      TENFORE: [false, "CUSTOM"]
    });
  });

  it.each(Object.entries(runnableMetadata))(
    "validates reusable %s metadata from one registry",
    (family, metadata) => {
      expect(isProviderMetadataReady(family, metadata)).toBe(true);
      expect(
        resolveProviderCapability({
          detectedPlatform: [
            "FOREUP",
            "TEEITUP",
            "CHRONOGOLF",
            "CLUB_CADDIE"
          ].includes(family)
            ? family
            : "CUSTOM",
          bookingMetadata: metadata
        })
      ).toMatchObject({
        providerFamilyKey: family,
        metadataReady: true,
        isRunnable: true
      });
    }
  );

  it.each(Object.keys(runnableMetadata))(
    "keeps the production %s schema responsible for requiring a booking base URL",
    (family) => {
      expect(isProviderMetadataReady(family, { courseId: "test-only" })).toBe(
        false
      );
    }
  );

  it("refuses to run when provider metadata contradicts the platform and booking host", () => {
    expect(
      resolveProviderCapability({
        detectedPlatform: "GOLFNOW",
        detectedBookingUrl: "https://www.golfnow.com/course/example",
        bookingMetadata: runnableMetadata.GOLFBACK
      })
    ).toMatchObject({
      providerFamilyKey: SOURCE_CONFLICT_PROVIDER_FAMILY,
      detectedPlatform: "GOLFNOW",
      metadataReady: false,
      isRunnable: false,
      evidenceConflict: true
    });
  });

  it("runs only when reusable metadata agrees with current provider evidence", () => {
    expect(
      resolveProviderCapability({
        detectedPlatform: "CUSTOM",
        detectedBookingUrl:
          "https://golfback.com/#/course/123e4567-e89b-42d3-a456-426614174000",
        providerFamilyKey: "GOLFBACK",
        bookingMetadata: runnableMetadata.GOLFBACK
      })
    ).toMatchObject({
      providerFamilyKey: "GOLFBACK",
      metadataReady: true,
      isRunnable: true,
      evidenceConflict: false
    });
  });

  it.each([
    ["foreupsoftware.com", "FOREUP"],
    ["course.book.teeitup.golf", "TEEITUP"],
    ["www.chronogolf.com", "CHRONOGOLF"],
    ["course.cps.golf", "CPS"],
    ["course.chelseareservations.com", "CHELSEA"],
    ["course.teesnap.net", "TEESNAP"],
    ["api.golfback.com", "GOLFBACK"],
    ["golfwithaccess.com", "GOLF_WITH_ACCESS"],
    ["cdn.golfwithaccess.com", "GOLF_WITH_ACCESS"],
    ["course.navyaims.com", "WEBTRAC"],
    ["public-course.ezlinksgolf.com", "EZLINKS"],
    ["www.golfnow.com", "GOLFNOW"],
    ["app.clubcaddie.com", "CLUB_CADDIE"],
    ["app.whoosh.io", "WHOOSH"],
    ["fox.tenfore.golf", "TENFORE"]
  ])("maps %s to the canonical %s family", (hostname, family) => {
    expect(getKnownProviderFamilyForHostname(hostname)).toBe(family);
  });

  it("keeps only the generic public Golf with Access course landing", () => {
    expect(
      isProviderPublicBookingLandingUrl(
        "https://golfwithaccess.com/course/public-course/reserve-tee-time"
      )
    ).toBe(true);
    expect(
      isProviderPublicBookingLandingUrl(
        "https://golfwithaccess.com/course/public-course/reserve-tee-time?filterFacilities=north-course&filterFacilities=south-course&utm_source=official-course"
      )
    ).toBe(true);
    expect(
      isProviderPublicBookingLandingUrl(
        "https://golfwithaccess.com/course/public-course/reserve-tee-time/opaque-slot"
      )
    ).toBe(false);
    expect(
      isProviderPublicBookingLandingUrl(
        "https://golfwithaccess.com/course/public-course/reserve-tee-time?rateId=private"
      )
    ).toBe(false);
    expect(
      isProviderPublicBookingLandingUrl(
        "https://golfwithaccess.com/course/public-course/reserve-tee-time?filterFacilities=north-course&filterFacilities=north-course"
      )
    ).toBe(false);
    expect(
      isProviderPublicBookingLandingUrl(
        "https://cdn.golfwithaccess.com/course/public-course/reserve-tee-time"
      )
    ).toBe(false);
  });

  it("keeps only the generic Whoosh club landing and rejects driving-range inventory", () => {
    expect(
      isProviderPublicBookingLandingUrl(
        "https://app.whoosh.io/patron/club/yale-golf-course"
      )
    ).toBe(true);
    expect(
      isProviderPublicBookingLandingUrl(
        "https://app.whoosh.io/patron/club/windy-hill/agenda/driving-range/today"
      )
    ).toBe(false);
  });

  it("recognizes EZLinks without treating provider identity as runnable coverage", () => {
    const resolution = resolveProviderCapability({
      detectedPlatform: "CUSTOM",
      detectedBookingUrl: "https://public-course.ezlinksgolf.com/"
    });

    expect(resolution).toMatchObject({
      providerFamilyKey: "EZLINKS",
      detectedPlatform: "CUSTOM",
      metadataReady: false,
      isRunnable: false,
      evidenceConflict: false
    });
    expect(getProviderReadinessFailure(resolution)).toBe(
      "UNSUPPORTED_FAMILY"
    );
    expect(getKnownProviderFamilyForHostname("ezlinksgolf.com")).toBe(
      "EZLINKS"
    );
    expect(
      getKnownProviderFamilyForHostname("ezlinksgolf.com.attacker.example")
    ).toBeNull();
    expect(
      getKnownProviderFamilyForHostname("not-ezlinksgolf.com")
    ).toBeNull();
  });

  it("uses only a normalized hostname for unknown sources", () => {
    const resolution = resolveProviderCapability({
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl:
        "https://Bookings.Example.org/customer/42?token=do-not-persist#signed-fragment"
    });

    expect(resolution).toMatchObject({
      providerFamilyKey: "bookings.example.org",
      capability: null,
      metadataReady: false,
      isRunnable: false
    });
    expect(resolution.providerFamilyKey).not.toMatch(/customer|token|signed|42/i);
  });

  it("rejects credentialed, non-HTTP, and malformed source values", () => {
    expect(
      resolveProviderCapability({
        detectedBookingUrl: "https://user:password@example.org/private",
        website: "javascript:alert(1)"
      }).providerFamilyKey
    ).toBe(SOURCE_MISSING_PROVIDER_FAMILY);
    expect(normalizeProviderFamilyKey("example.org/path?token=value")).toBe(
      SOURCE_MISSING_PROVIDER_FAMILY
    );
  });

  it("requires the selected booking URL or metadata to corroborate a discovered provider", () => {
    expect(
      resolveProviderDiscoveryIdentity({
        detectedPlatform: "CHRONOGOLF",
        bookingUrl: "https://course.example.com/book-a-tee-time",
        confidence: 0.95
      })
    ).toBeNull();
    expect(
      resolveProviderDiscoveryIdentity({
        detectedPlatform: "CHRONOGOLF",
        bookingUrl: "https://example-course.book.teeitup.golf/",
        confidence: 0.95
      })
    ).toBeNull();
    expect(
      resolveProviderDiscoveryIdentity({
        detectedPlatform: "CHRONOGOLF",
        bookingUrl: "https://www.chronogolf.com/club/example-course",
        confidence: 0.39
      })
    ).toBeNull();
    expect(
      resolveProviderDiscoveryIdentity({
        detectedPlatform: "CHRONOGOLF",
        bookingUrl: "https://www.chronogolf.com/club/example-course",
        confidence: 0.4
      })
    ).toMatchObject({ providerFamilyKey: "CHRONOGOLF" });
  });

  it("classifies missing source, missing metadata, and unsupported families separately", () => {
    expect(
      getProviderReadinessFailure(resolveProviderCapability({ detectedPlatform: "UNKNOWN" }))
    ).toBe("MISSING_SOURCE");
    expect(
      getProviderReadinessFailure(
        resolveProviderCapability({
          detectedPlatform: "CUSTOM",
          detectedBookingUrl: "https://golfback.com/#/course/not-a-valid-id",
          bookingMetadata: { provider: "GOLFBACK" }
        })
      )
    ).toBe("MISSING_METADATA");
    expect(
      getProviderReadinessFailure(
        resolveProviderCapability({
          detectedPlatform: "CUSTOM",
          detectedBookingUrl: "https://app.whoosh.io/patron/club/public-course"
        })
      )
    ).toBe("MISSING_METADATA");
    expect(
      getProviderReadinessFailure(
        resolveProviderCapability({
          detectedPlatform: "GOLFNOW",
          bookingMetadata: runnableMetadata.GOLFBACK
        })
      )
    ).toBe("MISSING_METADATA");
  });
});

describe("provider failure classification", () => {
  it.each<[unknown, CourseSupportFailureClass]>([
    [{ status: 401 }, "AUTH"],
    [new Error("Provider returned 429"), "RATE_LIMIT"],
    [new Error("Cloudflare managed challenge"), "CHALLENGE"],
    [new Error("Provider returned 404"), "NOT_FOUND"],
    [new Error("Provider returned 503"), "HTTP_5XX"],
    [Object.assign(new Error("request timed out"), { name: "TimeoutError" }), "TIMEOUT"],
    [Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" }), "NETWORK"],
    [new Error("Unexpected JSON payload"), "SCHEMA"],
    [new Error("Unclassified provider failure"), "UNKNOWN"]
  ])("maps a bounded failure signal to %s", (error, failureClass) => {
    expect(classifyProviderFailure({ error }).failureClass).toBe(failureClass);
  });

  it("preserves readiness failures and parses Retry-After without storing an error message", () => {
    expect(
      classifyProviderFailure({
        error: new Error("irrelevant raw details"),
        readinessFailure: "MISSING_METADATA",
        retryAfter: "90"
      })
    ).toEqual({
      failureClass: "MISSING_METADATA",
      httpStatus: null,
      retryAfterSeconds: 90
    });
  });

  it("groups equivalent failures with an opaque, redacted fingerprint", () => {
    const first = buildProviderFailureFingerprint({
      providerFamilyKey: "GOLFBACK",
      failureClass: "HTTP_5XX",
      operation: "AVAILABILITY",
      httpStatus: 500
    });
    const second = buildProviderFailureFingerprint({
      providerFamilyKey: "golfback",
      failureClass: "HTTP_5XX",
      operation: "AVAILABILITY",
      httpStatus: 503
    });
    const unsafe = buildProviderFailureFingerprint({
      providerFamilyKey: "example.org/private?token=secret",
      failureClass: "UNKNOWN",
      operation: "DISCOVERY"
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(unsafe).toMatch(/^[a-f0-9]{64}$/);
    expect(unsafe).not.toContain("secret");
  });
});

describe("consumer disposition", () => {
  const source = { website: "https://course.example.org/" };
  const currentClassification = {
    automationEligibility: "BLOCKED" as const,
    intelligenceVerifiedAt: new Date("2026-07-16T11:00:00.000Z"),
    intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
    intelligenceConfidence: 0.95,
    now: new Date("2026-07-16T12:00:00.000Z")
  };

  it.each<[Partial<Parameters<typeof deriveConsumerDisposition>[0]>, ConsumerDisposition]>([
    [{ ...source, invalidCourse: true }, "PRIVATE_OR_INVALID"],
    [{ ...source, ...currentClassification, isPublic: false }, "PRIVATE_OR_INVALID"],
    [
      {
        ...source,
        isPublic: false,
        intelligenceVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-07-15T00:00:00.000Z"),
        intelligenceConfidence: 0.98,
        now: new Date("2026-07-16T12:00:00.000Z")
      },
      "SOURCE_UNVERIFIED"
    ],
    [
      { ...source, ...currentClassification, automationReason: "ACCOUNT_REQUIRED" },
      "ACCOUNT_REQUIRED"
    ],
    [
      { ...source, ...currentClassification, automationReason: "CAPTCHA_OR_QUEUE" },
      "CAPTCHA_OR_QUEUE"
    ],
    [{ ...source, automationReason: "AUTOMATION_PROHIBITED" }, "ENGINEERING"],
    [
      {
        ...source,
        ...currentClassification,
        bookingMethod: "PHONE_ONLY",
        automationReason: "NO_ONLINE_BOOKING"
      },
      "PHONE_OR_WALK_IN"
    ],
    [{ ...source, automationEligibility: "BLOCKED" }, "ENGINEERING"],
    [{ currentEvidenceTrusted: false }, "SOURCE_UNVERIFIED"],
    [
      {
        ...source,
        currentEvidenceTrusted: true,
        latestOutcome: "MATCH_FOUND",
        availableMatchCount: 2
      },
      "MATCH_AVAILABLE"
    ],
    [
      { ...source, currentEvidenceTrusted: true, latestOutcome: "NO_MATCH" },
      "CHECKED_NO_MATCH"
    ],
    [
      {
        ...source,
        currentEvidenceTrusted: true,
        latestOutcome: "NO_MATCH",
        targetDateStatus: "NOT_OPEN"
      },
      "BOOKING_NOT_OPEN"
    ],
    [{ ...source, failureClass: "TIMEOUT" }, "RETRYING"],
    [{ ...source, failureClass: "MISSING_METADATA" }, "ENGINEERING"],
    [
      {
        detectedPlatform: "GOLFNOW",
        bookingMetadata: runnableMetadata.GOLFBACK
      },
      "SOURCE_UNVERIFIED"
    ],
    [{ ...source, finalClassification: true }, "ENGINEERING"]
  ])("derives %s from persisted evidence", (input, expected) => {
    expect(deriveConsumerDisposition(input)).toBe(expected);
  });

  it("counts only current runnable outcomes as effective consumer coverage", () => {
    expect(isEffectiveConsumerCoverage("MATCH_AVAILABLE")).toBe(true);
    expect(isEffectiveConsumerCoverage("CHECKED_NO_MATCH")).toBe(true);
    expect(isEffectiveConsumerCoverage("BOOKING_NOT_OPEN")).toBe(true);
    expect(isEffectiveConsumerCoverage("DIRECT_SITE_ONLY")).toBe(false);
    expect(isEffectiveConsumerCoverage("RETRYING")).toBe(false);
    expect(isEffectiveConsumerCoverage("ENGINEERING")).toBe(false);
  });

  it("lets fresh runnable evidence outrank stale blocking metadata", () => {
    expect(deriveConsumerDisposition({
      ...source,
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED",
      currentEvidenceTrusted: true,
      latestOutcome: "NO_MATCH"
    })).toBe("CHECKED_NO_MATCH");
  });

  it("does not let historical runnable evidence outrank newer metadata", () => {
    expect(deriveConsumerDisposition({
      ...source,
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED",
      intelligenceVerifiedAt: new Date("2026-07-16T12:00:00.000Z"),
      currentEvidenceTrusted: true,
      currentEvidenceObservedAt: new Date("2026-07-15T12:00:00.000Z"),
      latestOutcome: "NO_MATCH"
    })).toBe("ENGINEERING");
  });

  it("lets only newer runnable proof supersede policy-only metadata", () => {
    expect(deriveConsumerDisposition({
      ...source,
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED",
      intelligenceVerifiedAt: new Date("2026-07-15T12:00:00.000Z"),
      currentEvidenceTrusted: true,
      currentEvidenceObservedAt: new Date("2026-07-16T12:00:00.000Z"),
      latestOutcome: "NO_MATCH"
    })).toBe("CHECKED_NO_MATCH");
  });

  it("keeps current technical evidence ahead of runnable history", () => {
    expect(deriveConsumerDisposition({
      ...source,
      ...currentClassification,
      automationReason: "CAPTCHA_OR_QUEUE",
      currentEvidenceTrusted: true,
      currentEvidenceObservedAt: new Date("2026-07-15T12:00:00.000Z"),
      latestOutcome: "NO_MATCH"
    })).toBe("CAPTCHA_OR_QUEUE");
  });

  it("keeps a current coherent manual final ahead of newer runnable evidence", () => {
    expect(deriveConsumerDisposition({
      ...source,
      ...currentClassification,
      bookingMethod: "WALK_IN",
      automationReason: "NO_ONLINE_BOOKING",
      currentEvidenceTrusted: true,
      currentEvidenceObservedAt: new Date("2026-07-16T12:05:00.000Z"),
      latestOutcome: "NO_MATCH"
    })).toBe("PHONE_OR_WALK_IN");
  });

  it("lets newer exact-runtime proof supersede stale technical metadata", () => {
    expect(deriveConsumerDisposition({
      ...source,
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
      intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
      intelligenceConfidence: 0.95,
      currentEvidenceTrusted: true,
      currentEvidenceObservedAt: new Date("2026-07-16T12:00:00.000Z"),
      latestOutcome: "NO_MATCH"
    })).toBe("CHECKED_NO_MATCH");
  });

  it("lets newer exact-runtime proof supersede stale manual metadata", () => {
    expect(deriveConsumerDisposition({
      ...source,
      bookingMethod: "PHONE_ONLY",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
      intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
      intelligenceConfidence: 0.95,
      currentEvidenceTrusted: true,
      currentEvidenceObservedAt: new Date("2026-07-16T12:00:00.000Z"),
      latestOutcome: "NO_MATCH"
    })).toBe("CHECKED_NO_MATCH");
  });
});
