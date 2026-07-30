import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  course: {
    findUnique: vi.fn()
  },
  localReaderJob: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn()
  },
  courseSupportIncident: {
    findUnique: vi.fn()
  }
}));

const monitoringMocks = vi.hoisted(() => ({
  recordCourseMonitoringSuccess: vi.fn(),
  resolveCourseSupportIncident: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/automation/course-monitoring", () => ({
  recordCourseMonitoringSuccess: monitoringMocks.recordCourseMonitoringSuccess
}));
vi.mock("@/lib/automation/support-incidents", () => ({
  resolveCourseSupportIncident: monitoringMocks.resolveCourseSupportIncident
}));

import {
  claimNextLocalReaderJob,
  completeLocalReaderJob,
  getLocalReaderCourseVerification,
  getFreshLocalReaderTeeSheet,
  getLocalReaderCourseKey,
  queueLocalReaderCourseVerification,
  queueLocalReaderJob
} from "./service";

const bookingUrl = "https://grassyhill.cps.golf/onlineresweb/search-teetime";
const chronogolfBookingUrl = "https://www.chronogolf.com/club/crestbrook-park-golf-course";
const tenForeBookingUrl = "https://fox.tenfore.golf/gainfieldfarms";
const frearParkBookingUrl = "https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex";
const simsburyBookingUrl = "https://secure.east.prophetservices.com/SimsburyFarmsV3";

describe("local reader job service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T16:00:00.000Z"));
    prismaMocks.course.findUnique.mockResolvedValue({
      name: "Grassy Hill Country Club"
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes every safe CPS tenant through the local reader", () => {
    expect(getLocalReaderCourseKey(bookingUrl)).toBe("cps:grassyhill.cps.golf");
    expect(
      getLocalReaderCourseKey("https://shennecossett.cps.golf/onlineresweb/search-teetime")
    ).toBe("cps:shennecossett.cps.golf");
    expect(
      getLocalReaderCourseKey(
        "https://colonie.cps.golf/onlineresweb/search-teetime?date=2026-07-25"
      )
    ).toBe("cps:colonie.cps.golf");
    expect(
      getLocalReaderCourseKey("https://grassyhill.cps.golf/onlineresweb/search-teetime/checkout")
    ).toBeNull();
    expect(getLocalReaderCourseKey("https://fenwick.cps.golf/onlineresweb/search-teetime")).toBe(
      "cps:fenwick.cps.golf"
    );
    expect(getLocalReaderCourseKey("https://cps.golf/onlineresweb/search-teetime")).toBeNull();
    expect(
      getLocalReaderCourseKey("https://nested.future.cps.golf/onlineresweb/search-teetime")
    ).toBeNull();
  });

  it("queues a future CPS tenant without a course-specific release", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({ id: "job-future" });

    await queueLocalReaderJob({
      searchId: "search-1",
      courseId: "course-future",
      scheduleVersion: 1,
      targetDate: "2026-07-26",
      players: 2,
      bookingUrl: "https://future-public.cps.golf/onlineresweb/search-teetime?CourseId=7"
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "cps:future-public.cps.golf",
          bookingUrl: "https://future-public.cps.golf/onlineresweb/search-teetime"
        })
      })
    );
  });

  it("allowlists only the exact supported public Chronogolf profiles", () => {
    expect(getLocalReaderCourseKey(chronogolfBookingUrl)).toBe("crestbrook");
    expect(
      getLocalReaderCourseKey(`${chronogolfBookingUrl}?date=2026-07-26&step=teetimes&groupSize=2`)
    ).toBe("crestbrook");
    expect(getLocalReaderCourseKey("https://www.chronogolf.com/club/unclaimed-course")).toBe(
      "chronogolf:unclaimed-course"
    );
    expect(getLocalReaderCourseKey(`${chronogolfBookingUrl}/checkout?date=2026-07-26`)).toBeNull();
    expect(
      getLocalReaderCourseKey(`${chronogolfBookingUrl}?date=2026-07-26&step=checkout`)
    ).toBeNull();
  });

  it("does not replace a pending or live leased job during a retry", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-1",
      status: "LEASED",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:10:00.000Z")
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl
      })
    ).resolves.toMatchObject({ id: "job-1", status: "LEASED" });
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("requeues an expired reader job and reports the terminal attempt", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-expired",
      status: "EXPIRED",
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T15:59:00.000Z"),
      resultExpiresAt: null
    });
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-expired",
      status: "PENDING"
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl
      })
    ).resolves.toMatchObject({
      id: "job-expired",
      status: "PENDING",
      queueDisposition: "RETRYING_AFTER_TERMINAL_FAILURE"
    });
    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "PENDING",
          jobExpiresAt: new Date("2026-07-24T16:30:00.000Z")
        })
      })
    );
  });

  it("queues a dated public Chronogolf profile for the rendered reader", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({ id: "job-chrono" });

    await queueLocalReaderJob({
      searchId: "search-1",
      courseId: "course-1",
      scheduleVersion: 3,
      targetDate: "2026-07-26",
      players: 2,
      bookingUrl: chronogolfBookingUrl
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "crestbrook",
          bookingUrl:
            "https://www.chronogolf.com/club/crestbrook-park-golf-course?date=2026-07-26&step=teetimes"
        })
      })
    );
  });

  it("queues Frear Park with an exact dated rendered-page URL", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({ id: "job-frear" });

    expect(getLocalReaderCourseKey(frearParkBookingUrl)).toBe("frear-park");
    await queueLocalReaderCourseVerification({
      courseId: "course-frear",
      targetDate: "2026-07-30",
      players: 2,
      bookingUrl: frearParkBookingUrl
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "frear-park",
          bookingUrl:
            "https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex?CourseId=1,2&Date=2026-07-30&Time=AnyTime&Player=2&Hole=18"
        })
      })
    );
  });

  it("queues Simsbury Farms with its exact public Prophet course id", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({ id: "job-simsbury" });

    expect(getLocalReaderCourseKey(simsburyBookingUrl)).toBe("simsbury-farms");
    await queueLocalReaderCourseVerification({
      courseId: "course-simsbury",
      targetDate: "2026-07-30",
      players: 2,
      bookingUrl: simsburyBookingUrl
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "simsbury-farms",
          bookingUrl:
            "https://secure.east.prophetservices.com/SimsburyFarmsV3?CourseId=1&Date=2026-07-30&Time=AnyTime&Player=2&Hole=18"
        })
      })
    );
  });

  it("queues an exact dated TenFore tenant for the rendered reader", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-tenfore"
    });

    await queueLocalReaderJob({
      searchId: "search-1",
      courseId: "course-gainfield",
      scheduleVersion: 3,
      targetDate: "2026-07-29",
      players: 3,
      bookingUrl: tenForeBookingUrl
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "tenfore:gainfieldfarms",
          bookingUrl: "https://fox.tenfore.golf/gainfieldfarms?date=2026-07-29"
        })
      })
    );
  });

  it("queues a detached verification job without customer demand", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-verification"
    });

    await queueLocalReaderCourseVerification({
      courseId: "course-lyman",
      targetDate: "2026-07-26",
      players: 2,
      bookingUrl: "https://www.chronogolf.com/club/lyman-orchards-golf-club"
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith({
      where: { verificationKey: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      create: expect.objectContaining({
        teeSearchId: null,
        scheduleVersion: null,
        purpose: "COURSE_VERIFICATION",
        verificationKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        courseKey: "lyman-orchards",
        bookingUrl:
          "https://www.chronogolf.com/club/lyman-orchards-golf-club?date=2026-07-26&step=teetimes"
      }),
      update: expect.objectContaining({
        purpose: "COURSE_VERIFICATION",
        status: "PENDING"
      })
    });
  });

  it("reuses a pending job from an earlier schedule version", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      id: "job-earlier-version",
      scheduleVersion: 2,
      status: "PENDING",
      jobExpiresAt: new Date("2026-07-24T16:30:00.000Z")
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 4,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl
      })
    ).resolves.toMatchObject({
      id: "job-earlier-version",
      scheduleVersion: 2,
      status: "PENDING"
    });
    expect(prismaMocks.localReaderJob.findUnique).not.toHaveBeenCalled();
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("does not erase an unexpired completed result during an overlapping retry", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-1",
      status: "COMPLETED",
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
      result: {
        status: "NO_AVAILABILITY",
        slots: []
      }
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 4,
        bookingUrl
      })
    ).resolves.toMatchObject({ id: "job-1", status: "COMPLETED" });
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("claims an eligible job with a bounded lease", async () => {
    prismaMocks.localReaderJob.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      id: "job-1",
      courseKey: "grassy-hill",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      bookingUrl
    });

    await expect(claimNextLocalReaderJob("chrome-home")).resolves.toMatchObject({
      id: "job-1",
      courseKey: "grassy-hill",
      targetDate: "2026-07-25",
      players: 2,
      courseName: "Grassy Hill Country Club",
      bookingUrl,
      cardTextIncludes: [],
      leaseExpiresAt: "2026-07-24T16:03:00.000Z",
      leaseToken: expect.any(String)
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "LEASED",
          claimedAt: new Date("2026-07-24T16:00:00.000Z"),
          deviceId: "chrome-home"
        })
      })
    );
  });

  it("stores a valid result and returns the search that should resume", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-1",
      teeSearchId: "search-1",
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "grassy-hill",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      completeLocalReaderJob({
        jobId: "job-1",
        leaseToken: "lease-1",
        result: {
          jobId: "job-1",
          courseKey: "grassy-hill",
          status: "AVAILABLE",
          observedAt: "2026-07-24T16:00:00.000Z",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          slots: [
            {
              startsAtLocal: "2026-07-25T09:02:00",
              timeLabel: "9:02 AM",
              holes: [9, 18],
              minimumPlayers: 2,
              availableSpots: 4,
              priceCents: 8200,
              cartIncluded: true
            }
          ],
          readerVersion: "test"
        }
      })
    ).resolves.toMatchObject({
      searchId: "search-1",
      completedAt: new Date("2026-07-24T16:00:00.000Z")
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: { not: "job-1" },
        teeSearchId: "search-1",
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        status: "PENDING"
      },
      data: {
        status: "EXPIRED",
        leaseToken: null,
        leaseExpiresAt: null
      }
    });
  });

  it("stores detached verification evidence without scheduling a search", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-verification",
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      courseKey: "grassy-hill",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-verification",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      completeLocalReaderJob({
        jobId: "job-verification",
        leaseToken: "lease-verification",
        result: {
          jobId: "job-verification",
          courseKey: "grassy-hill",
          status: "NO_AVAILABILITY",
          observedAt: "2026-07-24T16:00:00.000Z",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          slots: [],
          readerVersion: "1.3.2"
        }
      })
    ).resolves.toMatchObject({
      searchId: null,
      completedAt: new Date("2026-07-24T16:00:00.000Z")
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledTimes(1);
    expect(monitoringMocks.recordCourseMonitoringSuccess).toHaveBeenCalledWith({
      courseId: "course-1",
      outcome: "NO_MATCH",
      source: "LOCAL_READER",
      message: "Fresh signed local public-page verification completed without availability.",
      now: new Date("2026-07-24T16:00:00.000Z"),
      runtimeVersion: "1.3.2"
    });
    expect(monitoringMocks.resolveCourseSupportIncident).toHaveBeenCalledWith({
      courseId: "course-1",
      resolution: "MONITORING_RESTORED",
      message:
        "Fresh signed local public-page verification completed successfully with outcome NO_MATCH.",
      now: new Date("2026-07-24T16:00:00.000Z")
    });
  });

  it("leaves incident resolution to the owned responder batch", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-verification",
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      courseKey: "grassy-hill",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-verification",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue({
      activeBatchId: "owned-batch"
    });

    await completeLocalReaderJob({
      jobId: "job-verification",
      leaseToken: "lease-verification",
      result: {
        jobId: "job-verification",
        courseKey: "grassy-hill",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T16:00:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Grassy Hill Country Club",
        slots: [],
        readerVersion: "1.7.0"
      }
    });

    expect(monitoringMocks.recordCourseMonitoringSuccess).toHaveBeenCalledOnce();
    expect(monitoringMocks.resolveCourseSupportIncident).not.toHaveBeenCalled();
  });

  it("returns fresh detached verification results without a customer search", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      targetDate: "2026-07-25",
      players: 2,
      status: "COMPLETED",
      createdAt: new Date("2026-07-24T16:00:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      result: {
        jobId: "job-verification",
        courseKey: "grassy-hill",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T16:01:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee Times",
        slots: [],
        readerVersion: "reader-v1"
      }
    });

    await expect(
      getLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        notBefore: new Date("2026-07-24T16:00:30.000Z")
      })
    ).resolves.toEqual({
      status: "COMPLETED",
      observedAt: new Date("2026-07-24T16:01:00.000Z"),
      readerVersion: "reader-v1",
      slots: []
    });
  });

  it("keeps challenged detached verification in engineering", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-challenge",
      teeSearchId: null,
      courseId: "course-1",
      purpose: "COURSE_VERIFICATION",
      courseKey: "grassy-hill",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-challenge",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });

    await completeLocalReaderJob({
      jobId: "job-challenge",
      leaseToken: "lease-challenge",
      result: {
        jobId: "job-challenge",
        courseKey: "grassy-hill",
        status: "ACCESS_CHALLENGE",
        observedAt: "2026-07-24T16:00:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Checking your browser",
        slots: [],
        readerVersion: "1.4.0"
      }
    });

    expect(monitoringMocks.recordCourseMonitoringSuccess).not.toHaveBeenCalled();
    expect(monitoringMocks.resolveCourseSupportIncident).not.toHaveBeenCalled();
  });

  it("turns only availability results into provider-compatible slots", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      result: {
        jobId: "job-1",
        courseKey: "grassy-hill",
        status: "AVAILABLE",
        observedAt: "2026-07-24T16:00:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Grassy Hill Country Club",
        slots: [
          {
            startsAtLocal: "2026-07-25T09:02:00",
            timeLabel: "9:02 AM",
            holes: [9, 18],
            minimumPlayers: 2,
            availableSpots: 4,
            priceCents: 8200,
            cartIncluded: true
          }
        ],
        readerVersion: "test"
      }
    });

    await expect(
      getFreshLocalReaderTeeSheet({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 4,
        targetDate: "2026-07-25",
        players: 2
      })
    ).resolves.toMatchObject({
      slots: [
        {
          sourceId: "local-grassy-hill-2026-07-25T09:02:00",
          holes: 18,
          bookableHoleCounts: [9, 18],
          availableSpots: 4
        }
      ]
    });
  });
});
