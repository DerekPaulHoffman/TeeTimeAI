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
      update: vi.fn()
    },
    courseAutomationDiscovery: {
      create: vi.fn(),
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
    mockedPrisma.course.update.mockResolvedValue({ id: "course-1" } as never);

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

    expect(mockedPrisma.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: {
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
        intelligenceVerifiedAt: expect.any(Date),
        intelligenceReviewAt: null,
        intelligenceConfidence: 0.95
      }
    });
  });

  it("applies a high-confidence phone-only finding without adapter metadata", async () => {
    mockedPrisma.course.update.mockResolvedValue({ id: "fairview" } as never);

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

    expect(mockedPrisma.course.update).toHaveBeenCalledWith({
      where: { id: "fairview" },
      data: {
        detectedPlatform: "UNKNOWN",
        automationEligibility: "BLOCKED",
        detectedBookingUrl: null,
        bookingMetadata: Prisma.DbNull,
        bookingMethod: "PHONE_ONLY",
        bookingPhone: "(860) 689-1000",
        automationReason: "NO_ONLINE_BOOKING",
        intelligenceVerifiedAt: expect.any(Date),
        intelligenceReviewAt: new Date("2026-10-10T00:00:00.000Z"),
        intelligenceConfidence: 1
      }
    });
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
});
