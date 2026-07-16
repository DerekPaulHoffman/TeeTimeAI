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

  it("does not let a stale access-barrier discovery downgrade a now-runnable course", async () => {
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
      updatedAt: new Date("2026-07-16T12:05:00.000Z")
    } as never);

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
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-access-control",
        observedUrls: []
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
