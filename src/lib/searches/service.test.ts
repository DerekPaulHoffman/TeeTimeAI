import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  createTeeSearchForUser,
  deleteTeeSearchForUser,
  listTeeSearchesForUser,
  updateTeeSearchForUser,
  updateTeeSearchStatusForUser
} from "./service";

const deliveryOutboxMocks = vi.hoisted(() => ({
  lockSearchForAlertMutation: vi.fn()
}));

const courseMonitoringMocks = vi.hoisted(() => ({
  requestTechnicalFinalRevalidationForDemand: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    course: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    },
    courseProbe: {
      findMany: vi.fn()
    },
    googlePlaceReview: {
      findMany: vi.fn()
    },
    coursePreference: {
      updateMany: vi.fn()
    },
    courseSupportBatchSearch: {
      updateMany: vi.fn()
    },
    teeSearch: {
      count: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      delete: vi.fn(),
      update: vi.fn()
    }
  }
}));
vi.mock("@/lib/email/search-delivery-outbox", () => deliveryOutboxMocks);
vi.mock("@/lib/automation/course-monitoring", () => courseMonitoringMocks);

const mockedPrisma = vi.mocked(prisma, { deep: true });

beforeEach(() => {
  mockedPrisma.$transaction.mockImplementation(async (callback) =>
    (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma)
  );
  deliveryOutboxMocks.lockSearchForAlertMutation.mockResolvedValue({
    id: "search-1"
  });
  courseMonitoringMocks.requestTechnicalFinalRevalidationForDemand.mockResolvedValue({
    requestedCourseIds: []
  });
});

describe("listTeeSearchesForUser", () => {
  it("returns the newest probe for every selected course after repeated multi-course checks", async () => {
    mockedPrisma.teeSearch.findMany.mockResolvedValue([
      {
        id: "search-1",
        preferences: [
          { course: { id: "course-1" } },
          { course: { id: "course-2" } },
          { course: { id: "course-3" } },
          { course: { id: "course-4" } },
          { course: { id: "course-5" } }
        ],
        matches: []
      }
    ] as never);
    mockedPrisma.$queryRaw.mockResolvedValue([
      { id: "probe-course-1-latest" },
      { id: "probe-course-2-latest" },
      { id: "probe-course-3-latest" },
      { id: "probe-course-4-unchanged" },
      { id: "probe-course-5-unchanged" }
    ] as never);
    mockedPrisma.courseProbe.findMany.mockResolvedValue([
      {
        id: "probe-course-3-latest",
        teeSearchId: "search-1",
        courseId: "course-3",
        outcome: "FETCH_FAILED",
        observedAt: new Date("2026-07-27T17:19:31.000Z")
      },
      {
        id: "probe-course-2-latest",
        teeSearchId: "search-1",
        courseId: "course-2",
        outcome: "MATCH_FOUND",
        observedAt: new Date("2026-07-27T17:19:30.000Z")
      },
      {
        id: "probe-course-1-latest",
        teeSearchId: "search-1",
        courseId: "course-1",
        outcome: "MATCH_FOUND",
        observedAt: new Date("2026-07-27T17:19:29.000Z")
      },
      {
        id: "probe-course-5-unchanged",
        teeSearchId: "search-1",
        courseId: "course-5",
        outcome: "NEEDS_ADAPTER",
        observedAt: new Date("2026-07-27T17:15:27.000Z")
      },
      {
        id: "probe-course-4-unchanged",
        teeSearchId: "search-1",
        courseId: "course-4",
        outcome: "NEEDS_ADAPTER",
        observedAt: new Date("2026-07-27T17:15:26.000Z")
      }
    ] as never);

    const searches = await listTeeSearchesForUser("user-1");

    expect(mockedPrisma.teeSearch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        include: expect.objectContaining({ probes: false })
      })
    );
    expect(mockedPrisma.courseProbe.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: {
            in: [
              "probe-course-1-latest",
              "probe-course-2-latest",
              "probe-course-3-latest",
              "probe-course-4-unchanged",
              "probe-course-5-unchanged"
            ]
          }
        }
      })
    );
    expect(searches[0]?.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ courseId: "course-1", outcome: "MATCH_FOUND" }),
        expect.objectContaining({ courseId: "course-2", outcome: "MATCH_FOUND" }),
        expect.objectContaining({ courseId: "course-3", outcome: "FETCH_FAILED" }),
        expect.objectContaining({ courseId: "course-4", outcome: "NEEDS_ADAPTER" }),
        expect.objectContaining({ courseId: "course-5", outcome: "NEEDS_ADAPTER" })
      ])
    );
    expect(searches[0]?.probes).toHaveLength(5);
  });
});

describe("createTeeSearchForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.course.findMany.mockResolvedValue([]);
    mockedPrisma.course.update.mockResolvedValue({ id: "course-1" } as never);
    mockedPrisma.googlePlaceReview.findMany.mockResolvedValue([]);
    mockedPrisma.teeSearch.count.mockResolvedValue(0);
  });

  it("persists a review-pending direct lookup candidate without marking it public", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2027-08-15",
      startTime: "13:00",
      endTime: "17:00",
      players: 2,
      cadenceMinutes: 15,
      courses: [
        {
          googlePlaceId: "review-pending-course",
          name: "Review Pending Golf Club",
          publicAccessStatus: "UNVERIFIED",
          website: "https://review-pending.example/",
          latitude: 41.47,
          longitude: -72.8,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              expect.objectContaining({
                course: {
                  connectOrCreate: expect.objectContaining({
                    create: expect.objectContaining({
                      isPublic: null,
                      website: "https://review-pending.example/"
                    })
                  })
                }
              })
            ]
          }
        })
      })
    );
  });

  it("connects demo selections to an existing supported nearby course", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "foreup-course-1",
        name: "Tashua Knolls Golf Course",
        automationEligibility: "ALLOWED"
      }
    ]);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "13:00",
      endTime: "17:00",
      userTimeZone: "America/Los_Angeles",
      players: 2,
      cadenceMinutes: 15,
      alertEmail: "GOLFER@example.com",
      additionalEmails: ["FRIEND@example.com", "friend@example.com"],
      courses: [
        {
          googlePlaceId: "tashua-knolls",
          name: "Tashua Knolls Golf Course",
          address: "40 Tashua Knolls Ln, Trumbull, CT",
          latitude: 41.242,
          longitude: -73.209,
          distanceMeters: 2092,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              automationEligibility: "ALLOWED",
              detectedPlatform: { not: "UNKNOWN" }
            },
            { automationEligibility: "BLOCKED" },
            { layoutHolesVerifiedAt: { not: null } }
          ])
        })
      })
    );
    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          alertEmail: "golfer@example.com",
          additionalEmails: ["friend@example.com"],
          userTimeZone: "America/Los_Angeles",
          preferences: {
            create: [
              {
                rank: 1,
                distanceMetersAtSelection: 2092,
                course: {
                  connect: { id: "foreup-course-1" }
                }
              }
            ]
          }
        })
      })
    );
  });

  it("refreshes a reusable course rating without clearing it when Places omits one", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "course-1",
      googlePlaceId: "course-place",
      name: "Example Golf Course",
      address: "1 Main St",
      latitude: 41.2,
      longitude: -72.8,
      website: null,
      phone: null,
      isPublic: true,
      automationEligibility: "ALLOWED",
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null
    } as never);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "13:00",
      endTime: "17:00",
      players: 2,
      cadenceMinutes: 15,
      courses: [
        {
          googlePlaceId: "course-place",
          name: "Example Golf Course",
          address: "1 Main St",
          latitude: 41.2,
          longitude: -72.8,
          rating: 4.6,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.course.update).toHaveBeenCalledWith({
      where: { id: "course-1" },
      data: {
        rating: 4.6,
        ratingObservedAt: expect.any(Date)
      }
    });

    vi.clearAllMocks();
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "course-1",
      googlePlaceId: "course-place",
      name: "Example Golf Course",
      address: "1 Main St",
      latitude: 41.2,
      longitude: -72.8,
      website: null,
      phone: null,
      isPublic: true,
      automationEligibility: "ALLOWED",
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null
    } as never);
    mockedPrisma.googlePlaceReview.findMany.mockResolvedValue([]);
    mockedPrisma.teeSearch.count.mockResolvedValue(0);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-2"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-16",
      startTime: "13:00",
      endTime: "17:00",
      players: 2,
      cadenceMinutes: 15,
      courses: [
        {
          googlePlaceId: "course-place",
          name: "Example Golf Course",
          address: "1 Main St",
          latitude: 41.2,
          longitude: -72.8,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
  });

  it("connects composite Google facility names to an existing supported nearby course", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "foreup-course-1",
        name: "Tashua Knolls Golf Course",
        automationEligibility: "ALLOWED"
      }
    ]);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "13:00",
      endTime: "17:00",
      players: 2,
      cadenceMinutes: 15,
      alertEmail: "golfer@example.com",
      courses: [
        {
          googlePlaceId: "tashua-knolls-and-glen",
          name: "Tashua Knolls & Tashua Glen Golf Course",
          address: "40 Tashua Knolls Ln, Trumbull, CT",
          latitude: 41.2888889,
          longitude: -73.2494444,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              {
                rank: 1,
                course: {
                  connect: { id: "foreup-course-1" }
                }
              }
            ]
          }
        })
      })
    );
  });

  it("does not connect unrelated nearby supported courses", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "foreup-course-1",
        name: "Tashua Knolls Golf Course",
        automationEligibility: "ALLOWED"
      }
    ]);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "13:00",
      endTime: "17:00",
      players: 2,
      cadenceMinutes: 15,
      alertEmail: "golfer@example.com",
      courses: [
        {
          googlePlaceId: "oak-hills",
          name: "Oak Hills Park Golf Course",
          address: "165 Fillow St, Norwalk, CT",
          latitude: 41.242,
          longitude: -73.209,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              expect.objectContaining({
                course: {
                  connectOrCreate: expect.objectContaining({
                    where: {
                      googlePlaceId: "oak-hills"
                    }
                  })
                }
              })
            ]
          }
        })
      })
    );
  });

  it("uses a stable manual place key when creating manual courses", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([]);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "13:00",
      endTime: "17:00",
      players: 2,
      cadenceMinutes: 15,
      alertEmail: "golfer@example.com",
      courses: [
        {
          name: "Manual Public Course",
          latitude: 41.2,
          longitude: -73.2,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              expect.objectContaining({
                course: {
                  connectOrCreate: expect.objectContaining({
                    where: {
                      googlePlaceId: "manual-Manual Public Course-41.2--73.2"
                    },
                    create: expect.objectContaining({
                      googlePlaceId: "manual-Manual Public Course-41.2--73.2",
                      isManual: true
                    })
                  })
                }
              })
            ]
          }
        })
      })
    );
  });

  it("saves and revalidates a search when every selected course is technical", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "fairview-farm",
      automationEligibility: "BLOCKED"
    } as never);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "06:00",
        endTime: "16:00",
        players: 4,
        cadenceMinutes: 5,
        alertEmail: "golfer@example.com",
        courses: [
          {
            googlePlaceId: "fairview-farm",
            name: "Fairview Farm Golf Course",
            latitude: 41.815,
            longitude: -73.071,
            rank: 1
          }
        ]
      })
    ).resolves.toEqual({ id: "search-1" });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledOnce();
    expect(courseMonitoringMocks.requestTechnicalFinalRevalidationForDemand).toHaveBeenCalledWith({
      courseIds: ["fairview-farm"]
    });
  });

  it("allows an alert containing only the exact Grassy Hill local-reader course", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "grassy-hill",
      googlePlaceId: "grassy-hill-place",
      name: "Grassy Hill Country Club",
      address: "441 Clark Ln, Orange, CT 06477",
      latitude: 41.27,
      longitude: -73.02,
      website: "http://www.grassyhillcountryclub.com/",
      detectedBookingUrl: "https://grassyhill.cps.golf/",
      phone: null,
      isPublic: true,
      automationEligibility: "BLOCKED",
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null
    } as never);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "06:00",
        endTime: "16:00",
        players: 4,
        cadenceMinutes: 5,
        courses: [
          {
            courseId: "grassy-hill",
            googlePlaceId: "grassy-hill-place",
            name: "Grassy Hill Country Club",
            latitude: 41.27,
            longitude: -73.02,
            rank: 1
          }
        ]
      })
    ).resolves.toEqual({ id: "search-1" });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledOnce();
  });

  it("reuses a nearby official-site-only course when its Google place id changed", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "fairview-farm",
        name: "Fairview Farm Golf Course",
        automationEligibility: "BLOCKED"
      }
    ] as never);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "06:00",
        endTime: "16:00",
        players: 4,
        cadenceMinutes: 5,
        alertEmail: "golfer@example.com",
        courses: [
          {
            googlePlaceId: "replacement-fairview-place-id",
            name: "Fairview Farm Golf Course",
            latitude: 41.8151,
            longitude: -73.0711,
            rank: 1
          }
        ]
      })
    ).resolves.toEqual({ id: "search-1" });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledOnce();
  });

  it("reuses a blocked course when Google returns a generic label at the same location", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "fairview-farm",
        name: "Fairview Farm Golf Course",
        latitude: 41.7470436,
        longitude: -73.07518,
        automationEligibility: "BLOCKED"
      }
    ] as never);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "06:00",
        endTime: "16:00",
        players: 4,
        cadenceMinutes: 5,
        alertEmail: "golfer@example.com",
        courses: [
          {
            googlePlaceId: "generic-fairview-place-id",
            name: "Golf Course",
            latitude: 41.7478038,
            longitude: -73.074469,
            rank: 1
          }
        ]
      })
    ).resolves.toEqual({ id: "search-1" });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledOnce();
  });

  it("does not reuse an arbitrary blocked course for an ambiguous generic label", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "bethpage-black",
        name: "Bethpage Black Golf Course",
        latitude: 40.7445,
        longitude: -73.455,
        automationEligibility: "BLOCKED"
      },
      {
        id: "bethpage-red",
        name: "Bethpage Red Golf Course",
        latitude: 40.7435,
        longitude: -73.455,
        automationEligibility: "BLOCKED"
      }
    ] as never);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "06:00",
      endTime: "16:00",
      players: 4,
      cadenceMinutes: 5,
      courses: [
        {
          googlePlaceId: "generic-bethpage",
          name: "Golf Course",
          latitude: 40.744,
          longitude: -73.455,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              expect.objectContaining({
                course: {
                  connectOrCreate: expect.objectContaining({
                    where: { googlePlaceId: "generic-bethpage" }
                  })
                }
              })
            ]
          }
        })
      })
    );
  });

  it("does not reuse a different numbered course at the same resort", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "pinehurst-no-4",
        name: "Pinehurst No. 4",
        latitude: 35.194,
        longitude: -79.469,
        automationEligibility: "ALLOWED"
      }
    ] as never);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "06:00",
      endTime: "16:00",
      players: 4,
      cadenceMinutes: 5,
      courses: [
        {
          googlePlaceId: "pinehurst-no-2",
          name: "Pinehurst No. 2",
          latitude: 35.195,
          longitude: -79.47,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              expect.objectContaining({
                course: {
                  connectOrCreate: expect.objectContaining({
                    where: { googlePlaceId: "pinehurst-no-2" }
                  })
                }
              })
            ]
          }
        })
      })
    );
  });

  it("keeps a clearly identified official-site-only preference in a mixed search", async () => {
    mockedPrisma.course.findUnique.mockImplementation(async ({ where }) => {
      if ("googlePlaceId" in where && where.googlePlaceId === "fairview-farm") {
        return {
          id: "fairview-farm",
          automationEligibility: "BLOCKED"
        } as never;
      }
      if ("googlePlaceId" in where && where.googlePlaceId === "timberlin") {
        return { id: "timberlin", automationEligibility: "ALLOWED" } as never;
      }
      return null;
    });
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "06:00",
      endTime: "16:00",
      players: 4,
      cadenceMinutes: 5,
      alertEmail: "golfer@example.com",
      courses: [
        {
          googlePlaceId: "fairview-farm",
          name: "Fairview Farm Golf Course",
          latitude: 41.815,
          longitude: -73.071,
          rank: 1
        },
        {
          googlePlaceId: "timberlin",
          name: "Timberlin Golf Course",
          latitude: 41.62,
          longitude: -72.77,
          rank: 2
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              expect.objectContaining({
                course: { connect: { id: "fairview-farm" } }
              }),
              expect.objectContaining({
                course: { connect: { id: "timberlin" } }
              })
            ]
          }
        })
      })
    );
  });

  it("rejects a mixed search containing a known private course", async () => {
    mockedPrisma.course.findUnique.mockImplementation(async ({ where }) => {
      if ("googlePlaceId" in where && where.googlePlaceId === "private-course") {
        return {
          id: "private-course",
          name: "Private Course",
          isPublic: false,
          automationEligibility: "BLOCKED",
          layoutHoleCounts: [],
          layoutHolesVerifiedAt: null
        } as never;
      }
      if ("googlePlaceId" in where && where.googlePlaceId === "public-course") {
        return {
          id: "public-course",
          name: "Public Course",
          isPublic: true,
          automationEligibility: "ALLOWED",
          layoutHoleCounts: [],
          layoutHolesVerifiedAt: null
        } as never;
      }
      return null;
    });

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "06:00",
        endTime: "16:00",
        players: 4,
        cadenceMinutes: 15,
        courses: [
          {
            googlePlaceId: "private-course",
            name: "Private Course",
            latitude: 41.8,
            longitude: -73.1,
            rank: 1
          },
          {
            googlePlaceId: "public-course",
            name: "Public Course",
            latitude: 41.7,
            longitude: -73,
            rank: 2
          }
        ]
      })
    ).rejects.toThrow("only create alerts for public golf courses");

    expect(mockedPrisma.teeSearch.create).not.toHaveBeenCalled();
  });

  it("does not bypass an exact private place with a nearby supported alias", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "exact-private",
      name: "Example Golf Course",
      isPublic: false,
      automationEligibility: "BLOCKED",
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null
    } as never);
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "nearby-public-alias",
        name: "Example Golf Course",
        isPublic: true,
        latitude: 41.8,
        longitude: -73.1,
        automationEligibility: "ALLOWED",
        layoutHoleCounts: [],
        layoutHolesVerifiedAt: null
      }
    ] as never);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "06:00",
        endTime: "16:00",
        players: 2,
        cadenceMinutes: 15,
        courses: [
          {
            googlePlaceId: "exact-private-place",
            name: "Example Golf Course",
            latitude: 41.8,
            longitude: -73.1,
            rank: 1
          }
        ]
      })
    ).rejects.toThrow("only create alerts for public golf courses");

    expect(mockedPrisma.course.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.create).not.toHaveBeenCalled();
  });

  it("rejects mismatched persisted and Google course identifiers", async () => {
    mockedPrisma.course.findUnique.mockImplementation(async ({ where }) => {
      if ("id" in where && where.id === "public-course-row") {
        return {
          id: "public-course-row",
          name: "Public Course",
          googlePlaceId: "public-course-place",
          isPublic: true,
          automationEligibility: "ALLOWED",
          layoutHoleCounts: [],
          layoutHolesVerifiedAt: null
        } as never;
      }
      if ("googlePlaceId" in where && where.googlePlaceId === "private-course-place") {
        return {
          id: "private-course-row",
          name: "Private Course",
          googlePlaceId: "private-course-place",
          isPublic: false,
          automationEligibility: "BLOCKED",
          layoutHoleCounts: [],
          layoutHolesVerifiedAt: null
        } as never;
      }
      return null;
    });

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "06:00",
        endTime: "16:00",
        players: 2,
        cadenceMinutes: 15,
        courses: [
          {
            courseId: "public-course-row",
            googlePlaceId: "private-course-place",
            name: "Private Course",
            latitude: 41.8,
            longitude: -73.1,
            rank: 1
          }
        ]
      })
    ).rejects.toThrow("only create alerts for public golf courses");

    expect(mockedPrisma.course.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.create).not.toHaveBeenCalled();
  });

  it("accepts a strongly linked supported canonical course for a Google alias", async () => {
    mockedPrisma.course.findUnique.mockImplementation(async ({ where }) => {
      if ("id" in where && where.id === "course-tashua-confirmed") {
        return {
          id: "course-tashua-confirmed",
          googlePlaceId: "demo-tashua-knolls",
          name: "Tashua Knolls Golf Course",
          address: "40 Tashua Knolls Ln, Trumbull, CT",
          latitude: 41.242,
          longitude: -73.209,
          website: "https://www.tashuaknolls.com/",
          phone: null,
          isPublic: true,
          automationEligibility: "ALLOWED",
          layoutHoleCounts: [],
          layoutHolesVerifiedAt: null
        } as never;
      }
      if ("googlePlaceId" in where && where.googlePlaceId === "google-tashua-facility") {
        return {
          id: "course-tashua-unreviewed",
          googlePlaceId: "google-tashua-facility",
          name: "Tashua Knolls & Tashua Glen Golf Course",
          address: "40 Tashua Knolls Ln, Trumbull, CT 06611, USA",
          latitude: 41.2888889,
          longitude: -73.2494444,
          website: "http://www.tashuaknolls.com/",
          phone: null,
          isPublic: true,
          automationEligibility: "UNKNOWN",
          layoutHoleCounts: [],
          layoutHolesVerifiedAt: null
        } as never;
      }
      return null;
    });
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "06:00",
      endTime: "16:00",
      players: 2,
      cadenceMinutes: 15,
      courses: [
        {
          courseId: "course-tashua-confirmed",
          googlePlaceId: "google-tashua-facility",
          name: "Tashua Knolls & Tashua Glen Golf Course",
          address: "40 Tashua Knolls Ln, Trumbull, CT 06611, USA",
          latitude: 41.2888889,
          longitude: -73.2494444,
          website: "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              {
                rank: 1,
                course: { connect: { id: "course-tashua-confirmed" } }
              }
            ]
          }
        })
      })
    );
  });

  it.each(["VERIFIED_PRIVATE", "VERIFIED_NON_COURSE"] as const)(
    "rejects an active %s place review even when no Course row exists",
    async (accessOverride) => {
      mockedPrisma.googlePlaceReview.findMany.mockResolvedValue([
        {
          googlePlaceId: "review-blocked-place",
          accessOverride,
          name: "Reviewed Place",
          classification: "Reviewed exclusion",
          evidenceUrl: "https://evidence.example/review",
          reviewedAt: new Date("2026-07-20T00:00:00.000Z"),
          active: true,
          canonicalPlaceId: null,
          canonicalName: null,
          canonicalAddress: null,
          canonicalWebsiteUrl: null,
          canonicalPhone: null,
          latitude: null,
          longitude: null,
          retainWhenCanonicalAbsent: false
        }
      ] as never);
      mockedPrisma.course.findUnique.mockResolvedValue(null);

      await expect(
        createTeeSearchForUser("user-1", {
          date: "2026-08-15",
          startTime: "06:00",
          endTime: "16:00",
          players: 2,
          cadenceMinutes: 15,
          courses: [
            {
              googlePlaceId: "review-blocked-place",
              name: "Reviewed Place",
              latitude: 41.8,
              longitude: -73.1,
              rank: 1
            }
          ]
        })
      ).rejects.toThrow("only create alerts for public golf courses");

      expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
      expect(mockedPrisma.teeSearch.create).not.toHaveBeenCalled();
    }
  );

  it("rejects an alias whose canonical place has an active private review", async () => {
    mockedPrisma.googlePlaceReview.findMany.mockResolvedValue([
      {
        googlePlaceId: "alias-place",
        accessOverride: null,
        name: "Alias Course",
        classification: "Canonical alias",
        evidenceUrl: "https://evidence.example/alias",
        reviewedAt: new Date("2026-07-20T00:00:00.000Z"),
        active: true,
        canonicalPlaceId: "canonical-private-place",
        canonicalName: "Canonical Private Course",
        canonicalAddress: null,
        canonicalWebsiteUrl: null,
        canonicalPhone: null,
        latitude: null,
        longitude: null,
        retainWhenCanonicalAbsent: true
      },
      {
        googlePlaceId: "canonical-private-place",
        accessOverride: "VERIFIED_PRIVATE",
        name: "Canonical Private Course",
        classification: "Verified private",
        evidenceUrl: "https://evidence.example/private",
        reviewedAt: new Date("2026-07-20T00:00:00.000Z"),
        active: true,
        canonicalPlaceId: null,
        canonicalName: null,
        canonicalAddress: null,
        canonicalWebsiteUrl: null,
        canonicalPhone: null,
        latitude: null,
        longitude: null,
        retainWhenCanonicalAbsent: false
      }
    ] as never);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "06:00",
        endTime: "16:00",
        players: 2,
        cadenceMinutes: 15,
        courses: [
          {
            googlePlaceId: "alias-place",
            name: "Alias Course",
            latitude: 41.8,
            longitude: -73.1,
            rank: 1
          }
        ]
      })
    ).rejects.toThrow("only create alerts for public golf courses");

    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.create).not.toHaveBeenCalled();
  });

  it("does not overwrite reusable course identity fields from alert input", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "public-course-row",
      name: "Canonical Public Course",
      googlePlaceId: "public-course-place",
      isPublic: true,
      automationEligibility: "ALLOWED",
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null
    } as never);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "06:00",
      endTime: "16:00",
      players: 2,
      cadenceMinutes: 15,
      courses: [
        {
          courseId: "public-course-row",
          name: "Tampered Course Name",
          city: "Wrong City",
          stateCode: "ZZ",
          latitude: -20,
          longitude: 120,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              {
                rank: 1,
                course: { connect: { id: "public-course-row" } }
              }
            ]
          }
        })
      })
    );
  });

  it("persists a verified compatible physical course-layout preference", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "eighteen-hole-course",
      name: "Verified Eighteen Golf Course",
      automationEligibility: "ALLOWED",
      layoutHoleCounts: [18],
      layoutHolesVerifiedAt: new Date("2026-07-11T12:00:00.000Z")
    } as never);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "09:00",
      endTime: "18:00",
      players: 4,
      cadenceMinutes: 5,
      requestedLayoutHoles: 18,
      courses: [
        {
          courseId: "eighteen-hole-course",
          name: "Verified Eighteen Golf Course",
          latitude: 41.2,
          longitude: -73.2,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestedLayoutHoles: 18 })
      })
    );
  });

  it("rejects Woodhaven for an 18-hole physical course-layout search", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "woodhaven",
      name: "Woodhaven Country Club",
      automationEligibility: "UNKNOWN",
      layoutHoleCounts: [9],
      layoutHolesVerifiedAt: new Date("2026-07-11T12:00:00.000Z")
    } as never);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "09:00",
        endTime: "18:00",
        players: 4,
        cadenceMinutes: 5,
        requestedLayoutHoles: 18,
        courses: [
          {
            courseId: "woodhaven",
            name: "Woodhaven Country Club",
            latitude: 41.415596,
            longitude: -73.039627,
            rank: 1
          }
        ]
      })
    ).rejects.toThrow(
      "The selected course layout does not match this 18-hole search: Woodhaven Country Club (9-hole)."
    );

    expect(mockedPrisma.teeSearch.create).not.toHaveBeenCalled();
  });

  it("reuses verified nearby Woodhaven evidence when Google returns an alternate id", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "woodhaven",
        name: "Woodhaven Golf Course",
        automationEligibility: "UNKNOWN",
        layoutHoleCounts: [9],
        layoutHolesVerifiedAt: new Date("2026-07-11T12:00:00.000Z")
      }
    ] as never);
    mockedPrisma.course.findUnique.mockResolvedValue(null);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "09:00",
        endTime: "18:00",
        players: 4,
        cadenceMinutes: 5,
        requestedLayoutHoles: 18,
        courses: [
          {
            googlePlaceId: "alternate-woodhaven-id",
            name: "Woodhaven Country Club",
            latitude: 41.4157,
            longitude: -73.0395,
            rank: 1
          }
        ]
      })
    ).rejects.toThrow(/Woodhaven Golf Course \(9-hole\)/);

    expect(mockedPrisma.teeSearch.create).not.toHaveBeenCalled();
  });

  it("allows an unverified course in a layout-specific search", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "unverified-course",
      name: "Unverified Public Course",
      automationEligibility: "ALLOWED",
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null
    } as never);
    mockedPrisma.teeSearch.create.mockResolvedValue({
      id: "search-1"
    } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "09:00",
      endTime: "18:00",
      players: 4,
      cadenceMinutes: 5,
      requestedLayoutHoles: 18,
      courses: [
        {
          courseId: "unverified-course",
          name: "Unverified Public Course",
          latitude: 41.2,
          longitude: -73.2,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledOnce();
  });

  it("rejects a fourth queued search for the same user", async () => {
    mockedPrisma.teeSearch.count.mockResolvedValue(3);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "13:00",
        endTime: "17:00",
        players: 2,
        cadenceMinutes: 15,
        alertEmail: "golfer@example.com",
        courses: [
          {
            googlePlaceId: "tashua-knolls",
            name: "Tashua Knolls Golf Course",
            latitude: 41.242,
            longitude: -73.209,
            rank: 1
          }
        ]
      })
    ).rejects.toThrow("You can keep up to 3 active or paused searches in the queue.");

    expect(mockedPrisma.teeSearch.create).not.toHaveBeenCalled();
  });
});

describe("updateTeeSearchStatusForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.teeSearch.count.mockResolvedValue(0);
  });

  it("excludes the current search when enforcing queue capacity on resume", async () => {
    mockedPrisma.teeSearch.update.mockResolvedValue({
      id: "search-1"
    } as never);

    await updateTeeSearchStatusForUser("user-1", "search-1", "ACTIVE");

    expect(mockedPrisma.teeSearch.count).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        status: { in: ["ACTIVE", "PAUSED"] },
        id: { not: "search-1" }
      }
    });
    expect(mockedPrisma.teeSearch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "ACTIVE",
          alertGeneration: { increment: 1 }
        })
      })
    );
  });
});

describe("updateTeeSearchForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.teeSearch.findUniqueOrThrow
      .mockResolvedValueOnce({ id: "search-1" } as never)
      .mockResolvedValueOnce({ id: "search-1", preferences: [] } as never);
    mockedPrisma.coursePreference.updateMany.mockResolvedValue({
      count: 1
    } as never);
  });

  it("reorders course preferences without colliding with existing ranks", async () => {
    await updateTeeSearchForUser("user-1", "search-1", {
      coursePreferences: [
        { id: "pref-b", rank: 1 },
        { id: "pref-a", rank: 2 }
      ]
    });

    expect(deliveryOutboxMocks.lockSearchForAlertMutation).toHaveBeenCalledWith(prisma, {
      searchId: "search-1",
      userId: "user-1"
    });
    expect(mockedPrisma.coursePreference.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "pref-b", teeSearchId: "search-1" },
      data: { rank: -1 }
    });
    expect(mockedPrisma.coursePreference.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "pref-a", teeSearchId: "search-1" },
      data: { rank: -2 }
    });
    expect(mockedPrisma.coursePreference.updateMany).toHaveBeenNthCalledWith(3, {
      where: { id: "pref-b", teeSearchId: "search-1" },
      data: { rank: 1 }
    });
    expect(mockedPrisma.coursePreference.updateMany).toHaveBeenNthCalledWith(4, {
      where: { id: "pref-a", teeSearchId: "search-1" },
      data: { rank: 2 }
    });
  });

  it("rejects changing a search to an incompatible verified layout", async () => {
    mockedPrisma.teeSearch.findUniqueOrThrow.mockReset().mockResolvedValue({
      id: "search-1",
      preferences: [
        {
          course: {
            name: "Woodhaven Country Club",
            layoutHoleCounts: [9],
            layoutHolesVerifiedAt: new Date("2026-07-11T12:00:00.000Z")
          }
        }
      ]
    } as never);

    await expect(
      updateTeeSearchForUser("user-1", "search-1", {
        requestedLayoutHoles: 18
      })
    ).rejects.toThrow("Woodhaven Country Club (9-hole)");

    expect(mockedPrisma.teeSearch.update).not.toHaveBeenCalled();
  });
});

describe("deleteTeeSearchForUser", () => {
  it("records an owner-deletion tombstone before the search row is removed", async () => {
    mockedPrisma.courseSupportBatchSearch.updateMany.mockResolvedValue({
      count: 1
    } as never);
    mockedPrisma.teeSearch.delete.mockResolvedValue({
      id: "search-1"
    } as never);

    await deleteTeeSearchForUser("user-1", "search-1");

    expect(mockedPrisma.courseSupportBatchSearch.updateMany).toHaveBeenCalledWith({
      where: { teeSearchId: "search-1", removedAt: null },
      data: {
        removedAt: expect.any(Date),
        removalReason: "SEARCH_DELETED_BY_OWNER"
      }
    });
    expect(mockedPrisma.teeSearch.delete).toHaveBeenCalledWith({
      where: { id: "search-1", userId: "user-1" }
    });
  });
});
