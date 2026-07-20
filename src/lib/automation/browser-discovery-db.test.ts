import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  applyBrowserDiscoveryToCourse,
  listBrowserProbeTargets,
  recordBrowserDiscovery
} from "./db-service";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    course: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    courseAutomationDiscovery: {
      create: vi.fn(),
      findMany: vi.fn()
    },
    courseSupportIncident: {
      findMany: vi.fn()
    },
    teeSearch: {
      findMany: vi.fn()
    }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });
const chronogolfOfficialLinkProof = {
  kind: "OFFICIAL_COURSE_PROVIDER_LINK" as const,
  officialWebsiteUrl: "https://westwoodsgc.com/",
  officialPageUrl: "https://westwoodsgc.com/",
  providerUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
};

describe("browser discovery persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.courseSupportIncident.findMany.mockResolvedValue([]);
  });

  it("records browser evidence and learned API metadata", async () => {
    mockedPrisma.courseAutomationDiscovery.create.mockResolvedValue({ id: "discovery-1" } as never);

    await recordBrowserDiscovery({
      courseId: "course-1",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://course.example.com",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      apiEndpoint: "https://foreupsoftware.com/index.php/api/booking/times",
      apiMetadata: {
        scheduleId: 11739,
        bookingClassId: 22739,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-api-request",
        observedUrls: ["https://foreupsoftware.com/index.php/api/booking/times?schedule_id=11739"]
      }
    });

    expect(mockedPrisma.courseAutomationDiscovery.create).toHaveBeenCalledWith({
      data: {
        courseId: "course-1",
        status: "LEARNED",
        detectedPlatform: "FOREUP",
        bookingMethod: "PUBLIC_ONLINE",
        bookingPhone: undefined,
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        sourceUrl: "https://course.example.com",
        bookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
        apiEndpoint: "https://foreupsoftware.com/index.php/api/booking/times",
        apiMetadata: {
          scheduleId: 11739,
          bookingClassId: 22739,
          bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
        },
        confidence: 0.95,
        evidence: {
          learnedFrom: "foreup-api-request",
          observedUrls: ["https://foreupsoftware.com/index.php/api/booking/times?schedule_id=11739"]
        }
      }
    });
  });

  it("applies learned ForeUP metadata to the reusable course adapter fields", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl:
          "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
        website: "https://course.example.com",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-1" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "course-1",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://course.example.com",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      apiMetadata: {
        scheduleId: 11739,
        bookingClassId: 22739,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-api-request",
        observedUrls: []
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "course-1", updatedAt },
      data: {
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        automationEligibility: "ALLOWED",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
        bookingMetadata: {
          scheduleId: 11739,
          bookingClassId: 22739,
          bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
        },
        bookingMethod: "PUBLIC_ONLINE",
        bookingPhone: undefined,
        automationReason: "NONE",
        policyNotes: undefined,
        intelligenceVerifiedAt: expect.any(Date),
        intelligenceReviewAt: null,
        intelligenceConfidence: 0.95
      }
    });
  });

  it("applies learned Chronogolf metadata to the reusable course adapter fields", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "CHRONOGOLF",
        detectedPlatform: "CHRONOGOLF",
        detectedBookingUrl:
          "https://www.chronogolf.com/club/blue-rock-golf-course",
        website: "https://bluerockgolfcourse.com/",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "blue-rock" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "blue-rock",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://bluerockgolfcourse.com/",
      bookingUrl: "https://www.chronogolf.com/club/blue-rock-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiEndpoint: "https://www.chronogolf.com/marketplace/v2/teetimes",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
        bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: []
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "blue-rock", updatedAt },
        data: expect.objectContaining({
          detectedPlatform: "CHRONOGOLF",
          automationEligibility: "ALLOWED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: {
            clubId: 7221,
            courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
            bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
          }
        })
      })
    );
  });

  it("persists only known provider identity from an inspected booking surface", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "bluerockgolfcourse.com",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: "https://bluerockgolfcourse.com/book-a-tee-time",
        website: "https://bluerockgolfcourse.com/",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "blue-rock" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "blue-rock",
      status: "INSPECTED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://bluerockgolfcourse.com/",
      bookingUrl: "https://www.chronogolf.com/club/blue-rock-golf-course",
      confidence: 0.45,
      evidence: {
        learnedFrom: "browser-visible-links",
        observedUrls: [
          "https://www.chronogolf.com/club/blue-rock-golf-course"
        ]
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "blue-rock", updatedAt },
      data: {
        detectedPlatform: "CHRONOGOLF",
        providerFamilyKey: "CHRONOGOLF",
        detectedBookingUrl:
          "https://www.chronogolf.com/club/blue-rock-golf-course"
      }
    });
  });

  it("does not apply a stale inspected identity after the course changed", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "course.example.com",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: "https://course.example.com/book-a-tee-time",
      website: "https://course.example.com/",
      bookingMetadata: null,
      updatedAt
    } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 0 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-1",
      status: "INSPECTED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://course.example.com/",
      bookingUrl: "https://www.chronogolf.com/club/example-course",
      confidence: 0.95,
      evidence: { learnedFrom: "browser-visible-links", observedUrls: [] }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "course-1", updatedAt } })
    );
  });

  it("rejects a platform label that is not corroborated by the selected booking URL", async () => {
    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-1",
      status: "INSPECTED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://course.example.com/",
      bookingUrl: "https://course.example.com/book-a-tee-time",
      confidence: 0.95,
      evidence: { learnedFrom: "browser-visible-links", observedUrls: [] }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("does not persist an unrecognized inspected official-site host", async () => {
    const result = await applyBrowserDiscoveryToCourse({
      courseId: "unknown-course",
      status: "INSPECTED",
      detectedPlatform: "UNKNOWN",
      sourceUrl: "https://course.example.com/",
      bookingUrl: "https://course.example.com/book-a-tee-time",
      confidence: 0.45,
      evidence: {
        learnedFrom: "browser-visible-links",
        observedUrls: ["https://course.example.com/book-a-tee-time"]
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
  });

  it("applies a high-confidence phone-only finding without adapter metadata", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "fairviewfarmgc.com",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://fairviewfarmgc.com/",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "fairview" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "fairview",
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "PHONE_ONLY",
      bookingPhone: "(860) 689-1000",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      intelligenceReviewAt: "2026-10-10T00:00:00.000Z",
      sourceUrl: "https://fairviewfarmgc.com/",
      confidence: 1,
      evidence: {
        learnedFrom: "official-site-research",
        observedUrls: ["https://fairviewfarmgc.com/golf/"]
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "fairview", updatedAt },
      data: {
        providerFamilyKey: "fairviewfarmgc.com",
        detectedPlatform: "UNKNOWN",
        automationEligibility: "BLOCKED",
        detectedBookingUrl: null,
        bookingMetadata: Prisma.DbNull,
        bookingMethod: "PHONE_ONLY",
        bookingPhone: "(860) 689-1000",
        automationReason: "NO_ONLINE_BOOKING",
        policyNotes: undefined,
        intelligenceVerifiedAt: expect.any(Date),
        intelligenceReviewAt: new Date("2026-10-10T00:00:00.000Z"),
        intelligenceConfidence: 1
      }
    });
  });

  it("lets newer corroborated technical evidence outrank historical runnable metadata", async () => {
    const updatedAt = new Date("2026-07-16T12:05:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: {
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      intelligenceVerifiedAt: new Date("2026-07-15T12:00:00.000Z"),
      intelligenceReviewAt: null,
      intelligenceConfidence: 0.95,
      updatedAt
    } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "VERIFIED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      intelligenceReviewAt: "2026-08-16T00:00:00.000Z",
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-access-control",
        observedUrls: []
      }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({
          automationEligibility: "BLOCKED",
          automationReason: "CAPTCHA_OR_QUEUE",
          bookingMetadata: undefined
        })
      })
    );
  });

  it("does not let a corroborated cross-provider discovery overwrite a current technical final", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: {
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      intelligenceVerifiedAt: new Date("2026-07-16T12:00:00.000Z"),
      intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
      intelligenceConfidence: 0.95,
      updatedAt: new Date("2026-07-16T12:05:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: chronogolfOfficialLinkProof
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("lets a corroborated cross-provider discovery replace stale known metadata", async () => {
    const updatedAt = new Date("2026-07-16T12:05:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
        website: "https://westwoodsgc.com/",
        bookingMetadata: {
          scheduleId: 6123,
          bookingBaseUrl:
            "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
        },
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: chronogolfOfficialLinkProof
      }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({
          providerFamilyKey: "CHRONOGOLF",
          detectedPlatform: "CHRONOGOLF",
          automationEligibility: "ALLOWED",
          automationReason: "NONE"
        })
      })
    );
  });

  it("rejects provider-page self-attestation for cross-provider replacement", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: {
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
      intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
      intelligenceConfidence: 0.95,
      updatedAt: new Date("2026-07-16T12:05:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_PROVIDER_LINK",
          officialWebsiteUrl: "https://westwoodsgc.com/",
          officialPageUrl:
            "https://www.chronogolf.com/club/westwoods-golf-course",
          providerUrl:
            "https://www.chronogolf.com/club/westwoods-golf-course"
        }
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("keeps current coherent provider metadata despite cross-provider corroboration", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: {
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      intelligenceVerifiedAt: new Date("2026-07-16T12:00:00.000Z"),
      intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
      intelligenceConfidence: 0.95,
      updatedAt: new Date("2026-07-16T12:05:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: chronogolfOfficialLinkProof
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("lets corroborated learned metadata replace stale conflicting provider evidence", async () => {
    const updatedAt = new Date("2026-07-16T12:07:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "GOLFNOW",
        detectedPlatform: "GOLFNOW",
        detectedBookingUrl: "https://www.golfnow.com/course/westwoods",
        website: "https://westwoodsgc.com/",
        bookingMetadata: {
          provider: "GOLFBACK",
          courseId: "123e4567-e89b-42d3-a456-426614174000",
          bookingBaseUrl:
            "https://golfback.com/#/course/123e4567-e89b-42d3-a456-426614174000"
        },
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: chronogolfOfficialLinkProof
      }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({ providerFamilyKey: "CHRONOGOLF" })
      })
    );
  });

  it("lets learned runnable metadata replace a stale manual final", async () => {
    const updatedAt = new Date("2026-07-16T12:05:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl: null,
        website: "https://westwoodsgc.com/",
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      confidence: 0.95,
      evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "ALLOWED",
          automationReason: "NONE"
        })
      })
    );
  });

  it("lets learned runnable metadata replace a stale technical final", async () => {
    const updatedAt = new Date("2026-07-16T12:06:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl: null,
        website: "https://westwoodsgc.com/",
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      confidence: 0.95,
      evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "ALLOWED",
          automationReason: "NONE"
        })
      })
    );
  });

  it("does not let learned runnable metadata replace a current manual final", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl: null,
      website: "https://westwoodsgc.com/",
      bookingMetadata: null,
      isPublic: true,
      bookingMethod: "CONTACT_COURSE",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      intelligenceVerifiedAt: new Date("2026-07-16T12:00:00.000Z"),
      intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
      intelligenceConfidence: 0.95,
      updatedAt: new Date("2026-07-16T12:05:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      confidence: 0.95,
      evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "the booking method is unknown",
      bookingMethod: "UNKNOWN" as const,
      automationEligibility: "BLOCKED" as const,
      automationReason: "NO_ONLINE_BOOKING" as const
    },
    {
      label: "the discovery is allowed",
      bookingMethod: "PHONE_ONLY" as const,
      automationEligibility: "ALLOWED" as const,
      automationReason: "NO_ONLINE_BOOKING" as const
    },
    {
      label: "the reason is not no-online-booking",
      bookingMethod: "CONTACT_COURSE" as const,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const
    }
  ])("does not accept an incoherent manual discovery when $label", async (scenario) => {
    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-manual",
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      sourceUrl: "https://course.example/",
      bookingUrl: "https://course.example/tee-times",
      bookingMethod: scenario.bookingMethod,
      automationEligibility: scenario.automationEligibility,
      automationReason: scenario.automationReason,
      intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
      confidence: 0.95,
      evidence: {
        learnedFrom: "official-site-research",
        observedUrls: ["https://course.example/tee-times"]
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("uses updatedAt compare-and-set for learned provider writes", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: null,
      updatedAt
    } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 0 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      apiMetadata: {
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      confidence: 0.95,
      evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "course-westwoods", updatedAt } })
    );
  });

  it("lists active unknown courses with websites as browser probe targets", async () => {
    mockedPrisma.teeSearch.findMany.mockResolvedValue([
      {
        id: "search-1",
        date: new Date("2026-07-10T00:00:00Z"),
        startTime: "13:40",
        endTime: "16:00",
        players: 3,
        preferences: [
          {
            rank: 1,
            course: {
              id: "course-1",
              name: "Longshore Golf Course",
              website: "https://longshoregolfcourse.com",
              detectedBookingUrl: null,
              detectedPlatform: "UNKNOWN",
              automationEligibility: "UNKNOWN",
              bookingMetadata: null
            }
          }
        ]
      }
    ] as never);

    await listBrowserProbeTargets();

    expect(mockedPrisma.teeSearch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ACTIVE"
        })
      })
    );
  });

  it("keeps repeated runnable-provider failures on the non-interactive adapter path", async () => {
    mockedPrisma.teeSearch.findMany.mockResolvedValue([]);
    mockedPrisma.courseSupportIncident.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        status: "AUTO_INVESTIGATING",
        kind: "FETCH_FAILED",
        occurrenceCount: 3,
        lastSeenAt: new Date(),
        course: {
          id: "course-1",
          name: "Repeated Failure Course",
          website: "https://course.example/",
          detectedBookingUrl:
            "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
          detectedPlatform: "FOREUP",
          providerFamilyKey: "FOREUP",
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
          bookingMethod: "PUBLIC_ONLINE",
          isPublic: true,
          intelligenceVerifiedAt: null,
          intelligenceReviewAt: null,
          intelligenceConfidence: null,
          bookingMetadata: {
            scheduleId: 2,
            bookingBaseUrl:
              "https://foreupsoftware.com/index.php/booking/1/2#/teetimes"
          },
          probes: [{ outcome: "FETCH_FAILED", observedAt: new Date() }]
        }
      }
    ] as never);

    const targets = await listBrowserProbeTargets();

    expect(targets).toEqual([]);
  });

  it("limits a targeted browser probe to the exact requested course", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-westwoods",
        name: "Westwoods Golf Course",
        website: "https://westwoodsgc.com/",
        detectedBookingUrl:
          "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
        detectedPlatform: "FOREUP",
        providerFamilyKey: "FOREUP",
        automationEligibility: "NEEDS_REVIEW",
        bookingMetadata: null,
        preferences: []
      }
    ] as never);

    const targets = await listBrowserProbeTargets(1, " westwoods golf course ");

    expect(targets).toHaveLength(1);
    expect(targets[0]?.course.name).toBe("Westwoods Golf Course");
    expect(targets[0]?.course.providerFamilyKey).toBe("FOREUP");
    expect(targets[0]?.searchId).toBeUndefined();
  });

  it("keeps a policy-only stored block off the interactive browser path", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "policy-course",
        name: "Policy Course",
        website: "https://policy-course.example/",
        detectedBookingUrl: "https://policy-course.example/tee-times",
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "policy-course.example",
        automationEligibility: "BLOCKED",
        automationReason: "AUTOMATION_PROHIBITED",
        bookingMethod: "PUBLIC_ONLINE",
        isPublic: true,
        intelligenceVerifiedAt: new Date("2026-07-16T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
        intelligenceConfidence: 0.99,
        bookingMetadata: null,
        preferences: []
      }
    ] as never);

    const targets = await listBrowserProbeTargets(1, "Policy Course");

    expect(targets).toEqual([]);
  });

  it("does not target a current corroborated technical final", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "account-course",
        name: "Account Course",
        website: "https://account-course.example/",
        detectedBookingUrl: "https://account-course.example/tee-times",
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "account-course.example",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        bookingMethod: "PUBLIC_ONLINE",
        isPublic: true,
        intelligenceVerifiedAt: new Date(),
        intelligenceReviewAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        intelligenceConfidence: 0.95,
        bookingMetadata: null,
        preferences: []
      }
    ] as never);

    await expect(
      listBrowserProbeTargets(1, "Account Course")
    ).resolves.toEqual([]);
  });

  it("rejects an ambiguous targeted course name", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "westwoods-a",
        name: "Westwoods Golf Course",
        website: "https://westwoods-a.example.com",
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        automationEligibility: "UNKNOWN",
        bookingMetadata: null,
        preferences: []
      },
      {
        id: "westwoods-b",
        name: "Westwoods Golf Course",
        website: "https://westwoods-b.example.com",
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        automationEligibility: "UNKNOWN",
        bookingMetadata: null,
        preferences: []
      }
    ] as never);

    await expect(
      listBrowserProbeTargets(1, "Westwoods Golf Course")
    ).rejects.toThrow("ambiguous");
  });

  it("does not target an open incident whose course is already runnable", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-westwoods",
        name: "Westwoods Golf Course",
        website: "https://westwoodsgc.com/",
        detectedBookingUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
        detectedPlatform: "FOREUP",
        providerFamilyKey: "FOREUP",
        automationEligibility: "ALLOWED",
        bookingMetadata: {
          scheduleId: 6123,
          bookingBaseUrl:
            "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
        },
        preferences: []
      }
    ] as never);

    await expect(
      listBrowserProbeTargets(1, "Westwoods Golf Course")
    ).resolves.toEqual([]);
  });
});
