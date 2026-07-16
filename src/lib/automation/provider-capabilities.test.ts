import { describe, expect, it } from "vitest";

import {
  buildProviderFailureFingerprint,
  classifyProviderFailure,
  deriveConsumerDisposition,
  getKnownProviderFamilyForHostname,
  getProviderReadinessFailure,
  isEffectiveConsumerCoverage,
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
  WEBTRAC: {
    provider: "WEBTRAC",
    bookingBaseUrl:
      "https://public.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=25",
    courseCode: "25"
  }
} as const;

describe("provider capability registry", () => {
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
      WEBTRAC: [true, "CUSTOM"],
      GOLFNOW: [false, "GOLFNOW"],
      CLUB_CADDIE: [false, "CLUB_CADDIE"],
      WHOOSH: [false, "CUSTOM"],
      TENFORE: [false, "CUSTOM"]
    });
  });

  it.each(Object.entries(runnableMetadata))(
    "validates reusable %s metadata from one registry",
    (family, metadata) => {
      expect(isProviderMetadataReady(family, metadata)).toBe(true);
      expect(
        resolveProviderCapability({
          detectedPlatform: ["FOREUP", "TEEITUP", "CHRONOGOLF"].includes(family)
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
    ["course.navyaims.com", "WEBTRAC"],
    ["www.golfnow.com", "GOLFNOW"],
    ["app.clubcaddie.com", "CLUB_CADDIE"],
    ["app.whoosh.io", "WHOOSH"],
    ["fox.tenfore.golf", "TENFORE"]
  ])("maps %s to the canonical %s family", (hostname, family) => {
    expect(getKnownProviderFamilyForHostname(hostname)).toBe(family);
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
    ).toBe("UNSUPPORTED_FAMILY");
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

  it.each<[Partial<Parameters<typeof deriveConsumerDisposition>[0]>, ConsumerDisposition]>([
    [{ ...source, invalidCourse: true }, "PRIVATE_OR_INVALID"],
    [{ ...source, automationReason: "ACCOUNT_REQUIRED" }, "ACCOUNT_REQUIRED"],
    [{ ...source, automationReason: "CAPTCHA_OR_QUEUE" }, "CAPTCHA_OR_QUEUE"],
    [{ ...source, automationReason: "AUTOMATION_PROHIBITED" }, "POLICY_BLOCKED"],
    [{ ...source, bookingMethod: "PHONE_ONLY" }, "PHONE_OR_WALK_IN"],
    [{ ...source, automationEligibility: "BLOCKED" }, "DIRECT_SITE_ONLY"],
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
    [{ ...source, finalClassification: true }, "DIRECT_SITE_ONLY"]
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
});
