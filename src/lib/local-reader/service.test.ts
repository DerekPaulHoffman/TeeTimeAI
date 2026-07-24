import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  localReaderJob: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn()
  }
}));

const schedulerMocks = vi.hoisted(() => ({
  startSearchSchedule: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/automation/search-scheduler", () => schedulerMocks);

import {
  claimNextLocalReaderJob,
  completeLocalReaderJob,
  getFreshLocalReaderTeeSheet,
  getLocalReaderCourseKey,
  queueLocalReaderJob
} from "./service";

const bookingUrl =
  "https://grassyhill.cps.golf/onlineresweb/search-teetime";

describe("local reader job service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T16:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allowlists only Grassy Hill's exact public reader route", () => {
    expect(getLocalReaderCourseKey(bookingUrl)).toBe("grassy-hill");
    expect(
      getLocalReaderCourseKey(
        "https://grassyhill.cps.golf/onlineresweb/search-teetime/checkout"
      )
    ).toBeNull();
    expect(
      getLocalReaderCourseKey(
        "https://another-course.cps.golf/onlineresweb/search-teetime"
      )
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

  it("does not erase an unexpired completed result during an overlapping retry", async () => {
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
      bookingUrl,
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

  it("stores a valid result and schedules the normal search workflow", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-1",
      teeSearchId: "search-1",
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
    schedulerMocks.startSearchSchedule.mockResolvedValue({ runId: "run-1" });

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
    expect(schedulerMocks.startSearchSchedule).toHaveBeenCalledWith("search-1");
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
        { holes: 9, availableSpots: 4 },
        { holes: 18, availableSpots: 4 }
      ]
    });
  });
});
