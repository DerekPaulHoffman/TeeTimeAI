import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { enrichCoursesWithBookingEvidence, findPricingCourse, type PricingCourseRecord } from "./course-price-enrichment";

vi.mock("@/lib/prisma", () => ({ prisma: { course: { findMany: vi.fn() } } }));
const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("course price enrichment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds recent official observations to a discovery result", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([pricingCourse({
      probes: [{
        observedAt: new Date("2026-07-10T12:00:00Z"),
        rawSummary: {
          bookableHoleCounts: [9, 18],
          pricing: {
            observedAt: "2026-07-10T12:00:00Z",
            nineHoles: { minPriceCents: 3200, maxPriceCents: 3900, sampleSize: 8 },
            eighteenHoles: { minPriceCents: 5400, maxPriceCents: 6800, sampleSize: 12 }
          }
        }
      }]
    })] as never);
    const [course] = await enrichCoursesWithBookingEvidence([candidate()]);
    expect(course.priceEstimate?.nineHoles?.minPriceCents).toBe(3200);
    expect(course.priceEstimate?.eighteenHoles?.maxPriceCents).toBe(6800);
    expect(course.bookableHoleCounts).toEqual([9, 18]);
  });

  it("adds observed booking options when no price was published", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([pricingCourse({
      matches: [{
        holes: 9,
        priceCents: null,
        lastConfirmedAt: new Date("2026-07-10T12:00:00Z")
      }]
    })] as never);

    const [course] = await enrichCoursesWithBookingEvidence([candidate()]);

    expect(course.priceEstimate).toBeUndefined();
    expect(course.bookableHoleCounts).toEqual([9]);
  });

  it("matches a seeded course by coordinates and meaningful name", () => {
    const course = pricingCourse({ googlePlaceId: null });
    expect(findPricingCourse(candidate(), [course])).toBe(course);
    expect(findPricingCourse({ ...candidate(), name: "General Store" }, [course])).toBeUndefined();
  });
});

function candidate() {
  return { googlePlaceId: "smith", name: "H. Smith Richardson Golf Course", latitude: 41.1906, longitude: -73.2704 };
}

function pricingCourse(overrides: Partial<PricingCourseRecord> = {}): PricingCourseRecord {
  return {
    googlePlaceId: "smith",
    name: "H Smith Richardson Golf Course",
    latitude: 41.1906,
    longitude: -73.2704,
    probes: [],
    matches: [],
    ...overrides
  };
}
