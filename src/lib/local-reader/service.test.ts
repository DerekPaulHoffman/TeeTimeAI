import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  course: {
    findUnique: vi.fn(),
  },
  localReaderJob: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  courseSupportIncident: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  localReaderAgent: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  courseMonitoringStatus: {
    updateMany: vi.fn(),
  },
  courseMonitoringEvent: {
    create: vi.fn(),
  },
  teeSearch: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));

const monitoringMocks = vi.hoisted(() => ({
  acquireCourseMonitoringWriteLockInTransaction: vi.fn(),
  getCourseMonitoringEscalationDeadline: vi.fn(),
  recordCourseMonitoringSuccess: vi.fn(),
  resolveCourseSupportIncident: vi.fn(),
  runSerializedCourseMonitoringWrite: vi.fn(),
}));

const providerObservationMocks = vi.hoisted(() => ({
  beginCourseProviderObservationInTransaction: vi.fn(),
  markCourseProviderObservationUnreconciledInTransaction: vi.fn(),
  releaseCourseProviderObservationInTransaction: vi.fn(),
  renewCourseProviderObservationInTransaction: vi.fn(),
}));

const workerMocks = vi.hoisted(() => ({
  startAutomationWorker: vi.fn(),
  completeAutomationWorker: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/automation/course-monitoring", () => ({
  acquireCourseMonitoringWriteLockInTransaction:
    monitoringMocks.acquireCourseMonitoringWriteLockInTransaction,
  getCourseMonitoringEscalationDeadline:
    monitoringMocks.getCourseMonitoringEscalationDeadline,
  recordCourseMonitoringSuccess: monitoringMocks.recordCourseMonitoringSuccess,
  runSerializedCourseMonitoringWrite:
    monitoringMocks.runSerializedCourseMonitoringWrite,
}));
vi.mock(
  "@/lib/automation/provider-execution-marker",
  () => providerObservationMocks,
);
vi.mock("@/lib/automation/support-incidents", () => ({
  resolveCourseSupportIncident: monitoringMocks.resolveCourseSupportIncident,
}));
vi.mock("@/lib/automation/worker-state", () => ({
  AUTOMATION_WORKERS: {
    LOCAL_READER: {
      workerKey: "local-tee-time-reader",
      cadenceSeconds: 120,
      graceSeconds: 180,
    },
  },
  startAutomationWorker: workerMocks.startAutomationWorker,
  completeAutomationWorker: workerMocks.completeAutomationWorker,
}));
import {
  claimNextLocalReaderJob,
  completeLocalReaderJob,
  expireOverdueLocalReaderJobs,
  getExpiredUnconsumedLocalReaderObservationForCanonicalResume,
  getFreshLocalReaderObservation,
  getLocalReaderCourseVerification,
  getFreshLocalReaderTeeSheet,
  getLocalReaderCourseKey,
  queueLocalReaderCourseVerification,
  queueLocalReaderJob,
  getNewestCompletedLocalReaderProviderObservationInTransaction,
  markCompletedLocalReaderProviderObservationConsumedInTransaction,
} from "./service";

const bookingUrl = "https://grassyhill.cps.golf/onlineresweb/search-teetime";
const chronogolfBookingUrl =
  "https://www.chronogolf.com/club/crestbrook-park-golf-course";
const tenForeBookingUrl = "https://fox.tenfore.golf/gainfieldfarms";
const ezLinksBookingUrl = "https://ballysapi.ezlinksgolf.com/";
const webTracBookingUrl =
  "https://ctguilfordweb.myvscloud.com/webtrac/web/search.html?module=GR";
const frearParkBookingUrl =
  "https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex";
const simsburyBookingUrl =
  "https://secure.east.prophetservices.com/SimsburyFarmsV3";

describe("local reader job service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T16:00:00.000Z"));
    prismaMocks.course.findUnique.mockResolvedValue({
      name: "Grassy Hill Country Club",
    });
    prismaMocks.localReaderAgent.findUnique.mockResolvedValue(null);
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.findFirst.mockReset().mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockReset().mockResolvedValue(null);
    prismaMocks.localReaderJob.findMany.mockReset().mockResolvedValue([]);
    prismaMocks.localReaderJob.updateMany
      .mockReset()
      .mockResolvedValue({ count: 1 });
    prismaMocks.teeSearch.findUnique.mockReset().mockResolvedValue(null);
    prismaMocks.teeSearch.updateMany
      .mockReset()
      .mockResolvedValue({ count: 0 });
    prismaMocks.$queryRaw
      .mockReset()
      .mockResolvedValue([
        { currentTime: new Date("2026-07-24T16:00:00.000Z") },
      ]);
    prismaMocks.$transaction.mockImplementation(async (callback) =>
      callback(prismaMocks),
    );
    monitoringMocks.acquireCourseMonitoringWriteLockInTransaction.mockResolvedValue(
      undefined,
    );
    monitoringMocks.runSerializedCourseMonitoringWrite.mockImplementation(
      async (_courseId, worker) => worker(prismaMocks),
    );
    providerObservationMocks.beginCourseProviderObservationInTransaction.mockImplementation(
      async (_transaction, input) => ({
        courseId: input.courseId,
        leaseToken: input.leaseToken,
        observationStartedAt: new Date("2026-07-24T16:00:00.000Z"),
        leaseExpiresAt: new Date(
          new Date("2026-07-24T16:00:00.000Z").getTime() + input.ttlMs,
        ),
        ttlMs: input.ttlMs,
        supersededUnresolvedObservationStartedAt: null,
      }),
    );
    providerObservationMocks.releaseCourseProviderObservationInTransaction.mockResolvedValue(
      undefined,
    );
    providerObservationMocks.markCourseProviderObservationUnreconciledInTransaction.mockResolvedValue(
      true,
    );
    providerObservationMocks.renewCourseProviderObservationInTransaction.mockResolvedValue(
      true,
    );
    workerMocks.startAutomationWorker.mockResolvedValue({ allowed: true });
    workerMocks.completeAutomationWorker.mockResolvedValue(undefined);
    monitoringMocks.getCourseMonitoringEscalationDeadline.mockReturnValue(
      new Date("2026-07-24T16:30:00.000Z"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires overdue reader jobs without sending operator email", async () => {
    prismaMocks.localReaderJob.findMany.mockResolvedValue([
      {
        id: "job-overdue-a",
        status: "PENDING",
        jobExpiresAt: new Date("2026-07-24T15:55:00.000Z"),
      },
      {
        id: "job-overdue-b",
        status: "LEASED",
        jobExpiresAt: new Date("2026-07-24T15:56:00.000Z"),
      },
    ]);
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 2 });

    await expect(expireOverdueLocalReaderJobs()).resolves.toEqual({
      considered: 2,
      expired: 2,
      notified: 0,
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["job-overdue-a", "job-overdue-b"] },
        status: { in: ["PENDING", "LEASED"] },
        jobExpiresAt: { lte: new Date("2026-07-24T16:00:00.000Z") },
      },
      data: {
        status: "EXPIRED",
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["job-overdue-a", "job-overdue-b"] },
        status: "EXPIRED",
        completedAt: null,
      },
      data: { completedAt: new Date("2026-07-24T16:00:00.000Z") },
    });
  });

  it("routes every safe CPS tenant through the local reader", () => {
    expect(getLocalReaderCourseKey(bookingUrl)).toBe("cps:grassyhill.cps.golf");
    expect(
      getLocalReaderCourseKey(
        "https://shennecossett.cps.golf/onlineresweb/search-teetime",
      ),
    ).toBe("cps:shennecossett.cps.golf");
    expect(
      getLocalReaderCourseKey(
        "https://colonie.cps.golf/onlineresweb/search-teetime?date=2026-07-25",
      ),
    ).toBe("cps:colonie.cps.golf");
    expect(
      getLocalReaderCourseKey(
        "https://grassyhill.cps.golf/onlineresweb/search-teetime/checkout",
      ),
    ).toBeNull();
    expect(
      getLocalReaderCourseKey(
        "https://fenwick.cps.golf/onlineresweb/search-teetime",
      ),
    ).toBe("cps:fenwick.cps.golf");
    expect(
      getLocalReaderCourseKey("https://cps.golf/onlineresweb/search-teetime"),
    ).toBeNull();
    expect(
      getLocalReaderCourseKey(
        "https://nested.future.cps.golf/onlineresweb/search-teetime",
      ),
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
      bookingUrl:
        "https://future-public.cps.golf/onlineresweb/search-teetime?CourseId=7",
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "cps:future-public.cps.golf",
          bookingUrl:
            "https://future-public.cps.golf/onlineresweb/search-teetime",
        }),
      }),
    );
  });

  it("queues a safe EZLinks tenant for the rendered reader", async () => {
    prismaMocks.course.findUnique.mockResolvedValue({
      name: "Bally's Golf Links at Ferry Point",
    });
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({ id: "job-ezlinks" });

    await queueLocalReaderJob({
      searchId: "search-ezlinks",
      courseId: "course-ezlinks",
      scheduleVersion: 1,
      targetDate: "2026-07-31",
      players: 3,
      bookingUrl: ezLinksBookingUrl,
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "ezlinks:ballysapi.ezlinksgolf.com",
          bookingUrl: "https://ballysapi.ezlinksgolf.com/index.html#!/search",
          requiredCapabilityKey: "EZLINKS_RENDERED",
          requiredParserVersion: 1,
        }),
      }),
    );
  });

  it("normalizes a legacy EZLinks search hash before queueing the reader", async () => {
    prismaMocks.course.findUnique.mockResolvedValue({
      name: "Harbor Golf Course",
    });
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({ id: "job-harbor" });

    await queueLocalReaderCourseVerification({
      courseId: "course-harbor",
      targetDate: "2026-08-01",
      players: 2,
      bookingUrl: "https://wilddunes.ezlinksgolf.com/index.html#/search",
      force: true,
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "ezlinks:wilddunes.ezlinksgolf.com",
          bookingUrl: "https://wilddunes.ezlinksgolf.com/index.html#!/search",
          requiredCapabilityKey: "EZLINKS_RENDERED",
        }),
      }),
    );
  });

  it("queues a safe MyVSCloud WebTrac tenant with the exact public search parameters", async () => {
    prismaMocks.course.findUnique.mockResolvedValue({
      name: "Guilford Lakes Golf Course",
    });
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({ id: "job-webtrac" });

    await queueLocalReaderCourseVerification({
      courseId: "course-webtrac",
      targetDate: "2026-08-01",
      players: 2,
      bookingUrl: webTracBookingUrl,
      force: true,
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "webtrac:ctguilfordweb.myvscloud.com",
          bookingUrl: expect.stringContaining(
            "https://ctguilfordweb.myvscloud.com/webtrac/web/search.html?",
          ),
          requiredCapabilityKey: "WEBTRAC_RENDERED",
          requiredParserVersion: 1,
        }),
      }),
    );
    const create =
      prismaMocks.localReaderJob.upsert.mock.calls.at(-1)?.[0].create;
    const url = new URL(create.bookingUrl);
    expect(url.searchParams.get("begindate")).toBe("08/01/2026");
    expect(url.searchParams.get("numberofplayers")).toBe("2");
    expect(url.searchParams.get("module")).toBe("GR");
    expect(url.pathname).toBe("/webtrac/web/search.html");
  });

  it("derives safe Chronogolf jobs from database booking URLs", () => {
    expect(getLocalReaderCourseKey(chronogolfBookingUrl)).toBe(
      "chronogolf:crestbrook-park-golf-course",
    );
    expect(
      getLocalReaderCourseKey(
        `${chronogolfBookingUrl}?date=2026-07-26&step=teetimes&groupSize=2`,
      ),
    ).toBe("chronogolf:crestbrook-park-golf-course");
    expect(
      getLocalReaderCourseKey(
        "https://www.chronogolf.com/club/unclaimed-course",
      ),
    ).toBe("chronogolf:unclaimed-course");
    expect(
      getLocalReaderCourseKey(
        `${chronogolfBookingUrl}/checkout?date=2026-07-26`,
      ),
    ).toBeNull();
    expect(
      getLocalReaderCourseKey(
        `${chronogolfBookingUrl}?date=2026-07-26&step=checkout`,
      ),
    ).toBeNull();
  });

  it("does not replace a pending or live leased job during a retry", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-1",
      status: "LEASED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T15:58:00.000Z"),
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
      }),
    ).resolves.toMatchObject({ id: "job-1", status: "LEASED" });
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("keeps an expired alert job terminal for its cycle and retries only in a new version", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique
      .mockResolvedValueOnce({
        id: "job-expired",
        status: "EXPIRED",
        courseKey: "cps:grassyhill.cps.golf",
        requiredCapabilityKey: "CPS_RENDERED",
        requiredParserVersion: 1,
        createdAt: new Date("2026-07-24T15:58:00.000Z"),
        completedAt: null,
        updatedAt: new Date("2026-07-24T15:59:00.000Z"),
        leaseToken: null,
        leaseExpiresAt: null,
        jobExpiresAt: new Date("2026-07-24T15:59:00.000Z"),
        resultExpiresAt: null,
        result: null,
      })
      .mockResolvedValueOnce(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-new-cycle",
      status: "PENDING",
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:58:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: "job-expired",
      status: "EXPIRED",
      queueDisposition: "TERMINAL",
      readerResultStatus: "EXPIRED",
      providerObservedAt: null,
      failureObservedAt: null,
    });
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 4,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: "job-new-cycle",
      status: "PENDING",
      queueDisposition: "ACTIVE",
    });
    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          scheduleVersion: 4,
          jobExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
        }),
      }),
    );
  });

  it("does not refresh an overdue pending alert job before the expiry sweep", async () => {
    vi.setSystemTime(new Date("2026-07-24T16:01:00.000Z"));
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-pending-overdue",
      status: "PENDING",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T15:55:00.000Z"),
      completedAt: null,
      updatedAt: new Date("2026-07-24T15:55:00.000Z"),
      leaseToken: null,
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:00:00.000Z"),
      resultExpiresAt: null,
      result: null,
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:55:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: "job-pending-overdue",
      status: "PENDING",
      queueDisposition: "TERMINAL",
      readerResultStatus: "EXPIRED",
      providerObservedAt: null,
      failureObservedAt: null,
    });
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("uses the server transition time for an early-expired reader job", async () => {
    const expiredAt = new Date("2026-07-24T15:59:00.000Z");
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-expired-early",
      status: "EXPIRED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T15:58:00.000Z"),
      updatedAt: expiredAt,
      claimedAt: null,
      completedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:03:00.000Z"),
      resultExpiresAt: null,
      result: null,
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:58:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: "job-expired-early",
      queueDisposition: "TERMINAL",
      providerObservedAt: null,
      failureObservedAt: null,
    });
  });

  it("preserves a completed terminal result after five minutes within the same playbook cycle", async () => {
    vi.setSystemTime(new Date("2026-07-24T16:06:00.000Z"));
    const terminalJob = {
      id: "job-terminal-current-cycle",
      scheduleVersion: 2,
      resumeFromScheduleVersion: 2,
      resumeScheduleVersion: 3,
      status: "COMPLETED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T16:00:00.000Z"),
      claimedAt: new Date("2026-07-24T16:00:30.000Z"),
      completedAt: new Date("2026-07-24T16:01:00.000Z"),
      updatedAt: new Date("2026-07-24T16:01:00.000Z"),
      leaseToken: null,
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:11:00.000Z"),
      result: {
        jobId: "job-terminal-current-cycle",
        courseKey: "cps:grassyhill.cps.golf",
        status: "PAGE_MISMATCH",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: "2026-07-24T16:00:30.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee times",
        slots: [],
        readerVersion: "reader-v1",
      },
    };
    prismaMocks.localReaderJob.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(terminalJob)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: terminalJob.id,
      status: "PENDING",
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: terminalJob.id,
      status: "COMPLETED",
      queueDisposition: "TERMINAL",
      readerResultStatus: "PAGE_MISMATCH",
      providerObservedAt: new Date("2026-07-24T16:00:30.000Z"),
      failureObservedAt: new Date("2026-07-24T16:00:30.000Z"),
    });
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:02:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: terminalJob.id,
      status: "PENDING",
      queueDisposition: "ACTIVE",
    });
    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledOnce();
  });

  it("reuses an expired-TTL terminal result across schedule recovery within one playbook cycle", async () => {
    vi.setSystemTime(new Date("2026-07-24T16:16:00.000Z"));
    const terminalJob = {
      id: "job-terminal-prior-version",
      scheduleVersion: 3,
      resumeFromScheduleVersion: 3,
      resumeScheduleVersion: 4,
      status: "COMPLETED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T16:00:00.000Z"),
      claimedAt: new Date("2026-07-24T16:00:30.000Z"),
      completedAt: new Date("2026-07-24T16:01:00.000Z"),
      updatedAt: new Date("2026-07-24T16:01:00.000Z"),
      leaseToken: null,
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:11:00.000Z"),
      result: {
        jobId: "job-terminal-prior-version",
        courseKey: "cps:grassyhill.cps.golf",
        status: "READER_ERROR",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: "2026-07-24T16:00:30.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee times",
        slots: [],
        readerVersion: "reader-v1",
      },
    };
    prismaMocks.localReaderJob.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(terminalJob)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-fresh-cycle",
      scheduleVersion: 4,
      status: "PENDING",
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 4,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: terminalJob.id,
      scheduleVersion: 3,
      status: "COMPLETED",
      queueDisposition: "TERMINAL",
      readerResultStatus: "READER_ERROR",
      providerObservedAt: new Date("2026-07-24T16:00:30.000Z"),
      failureObservedAt: new Date("2026-07-24T16:00:30.000Z"),
    });
    expect(prismaMocks.localReaderJob.findUnique).not.toHaveBeenCalled();
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 4,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:02:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: "job-fresh-cycle",
      scheduleVersion: 4,
      status: "PENDING",
      queueDisposition: "ACTIVE",
    });
    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledOnce();
  });

  it("reports an abandoned reader lease before requeueing it", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-abandoned",
      status: "LEASED",
      leaseExpiresAt: new Date("2026-07-24T15:59:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      resultExpiresAt: null,
    });
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-abandoned",
      status: "PENDING",
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      id: "job-abandoned",
      status: "PENDING",
      queueDisposition: "RETRYING_AFTER_TERMINAL_FAILURE",
      providerObservedAt: null,
      failureObservedAt: null,
    });
    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "PENDING",
          leaseToken: null,
          leaseExpiresAt: null,
          resumeFromScheduleVersion: null,
          resumeScheduleVersion: null,
        }),
      }),
    );
  });

  it("reports a repeatedly renewed reader lease after the customer wait limit", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-renewed",
      status: "LEASED",
      createdAt: new Date("2026-07-24T15:54:00.000Z"),
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      resultExpiresAt: null,
    });
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-renewed",
      status: "PENDING",
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      id: "job-renewed",
      status: "PENDING",
      queueDisposition: "RETRYING_AFTER_TERMINAL_FAILURE",
      providerObservedAt: null,
      failureObservedAt: null,
    });
    expect(prismaMocks.localReaderJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: "LEASED",
              createdAt: { gte: new Date("2026-07-24T15:55:00.000Z") },
            }),
          ]),
        }),
      }),
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
      bookingUrl: chronogolfBookingUrl,
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "chronogolf:crestbrook-park-golf-course",
          bookingUrl:
            "https://www.chronogolf.com/club/crestbrook-park-golf-course?date=2026-07-26&step=teetimes",
        }),
      }),
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
      bookingUrl: frearParkBookingUrl,
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "frear-park",
          bookingUrl:
            "https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex?CourseId=1,2&Date=2026-07-30&Time=AnyTime&Player=2&Hole=18",
        }),
      }),
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
      bookingUrl: simsburyBookingUrl,
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "simsbury-farms",
          bookingUrl:
            "https://secure.east.prophetservices.com/SimsburyFarmsV3/Home/NIndex?CourseId=1&Date=2026-07-30&Time=AnyTime&Player=2&Hole=18",
        }),
      }),
    );
  });

  it("queues an exact dated TenFore tenant for the rendered reader", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-tenfore",
    });

    await queueLocalReaderJob({
      searchId: "search-1",
      courseId: "course-gainfield",
      scheduleVersion: 3,
      targetDate: "2026-07-29",
      players: 3,
      bookingUrl: tenForeBookingUrl,
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          courseKey: "tenfore:gainfieldfarms",
          bookingUrl: "https://fox.tenfore.golf/gainfieldfarms?date=2026-07-29",
        }),
      }),
    );
  });

  it("queues a detached verification job without customer demand", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(null);
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-verification",
    });

    await queueLocalReaderCourseVerification({
      courseId: "course-lyman",
      targetDate: "2026-07-26",
      players: 2,
      bookingUrl: "https://www.chronogolf.com/club/lyman-orchards-golf-club",
    });

    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith({
      where: { verificationKey: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      create: expect.objectContaining({
        teeSearchId: null,
        scheduleVersion: null,
        purpose: "COURSE_VERIFICATION",
        verificationKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        courseKey: "chronogolf:lyman-orchards-golf-club",
        bookingUrl:
          "https://www.chronogolf.com/club/lyman-orchards-golf-club?date=2026-07-26&step=teetimes",
      }),
      update: {},
    });
  });

  it("forces an explicit operator retry after a completed verification", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-completed",
      status: "COMPLETED",
      courseKey: "ezlinks:ballysapi.ezlinksgolf.com",
      requiredCapabilityKey: "EZLINKS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T15:50:00.000Z"),
      updatedAt: new Date("2026-07-24T15:59:00.000Z"),
      leaseToken: null,
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      completedAt: new Date("2026-07-24T15:59:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      resumeFromScheduleVersion: 2,
      resumeScheduleVersion: 3,
    });

    await expect(
      queueLocalReaderCourseVerification({
        courseId: "course-ezlinks",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl: ezLinksBookingUrl,
        force: true,
      }),
    ).resolves.toMatchObject({ id: "job-completed", status: "PENDING" });

    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "job-completed",
          updatedAt: new Date("2026-07-24T15:59:00.000Z"),
          status: "COMPLETED",
        }),
        data: expect.objectContaining({
          status: "PENDING",
          createdAt: new Date("2026-07-24T16:00:00.000Z"),
          completedAt: null,
          readerVersion: null,
          resumeFromScheduleVersion: null,
          resumeScheduleVersion: null,
        }),
      }),
    );
  });

  it("requeues detached reader proof that predates the browser adapter retry boundary", async () => {
    const browserAdapterRetryCompletedAt = new Date("2026-07-24T15:55:00.000Z");
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-stale-proof",
      status: "COMPLETED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T15:45:00.000Z"),
      updatedAt: new Date("2026-07-24T15:50:00.000Z"),
      leaseToken: null,
      completedAt: new Date("2026-07-24T15:50:00.000Z"),
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
    });
    await expect(
      queueLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: browserAdapterRetryCompletedAt,
      }),
    ).resolves.toMatchObject({ id: "job-stale-proof", status: "PENDING" });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "job-stale-proof",
          updatedAt: new Date("2026-07-24T15:50:00.000Z"),
          status: "COMPLETED",
        }),
        data: expect.objectContaining({
          status: "PENDING",
          createdAt: new Date("2026-07-24T16:00:00.000Z"),
          result: undefined,
          completedAt: null,
        }),
      }),
    );
  });

  it("refreshes a stale attempt then preserves its current lease on a later retry", async () => {
    const notBefore = new Date("2026-07-24T15:55:00.000Z");
    const stale = {
      id: "job-retry-race",
      status: "COMPLETED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T15:45:00.000Z"),
      updatedAt: new Date("2026-07-24T15:50:00.000Z"),
      leaseToken: null,
      leaseExpiresAt: null,
      claimedAt: null,
      deviceId: null,
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      completedAt: new Date("2026-07-24T15:50:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      readerVersion: "reader-old",
    };
    const activeLease = {
      ...stale,
      status: "LEASED",
      createdAt: new Date("2026-07-24T16:00:00.000Z"),
      updatedAt: new Date("2026-07-24T16:00:10.000Z"),
      leaseToken: "lease-current-attempt",
      leaseExpiresAt: new Date("2026-07-24T16:03:00.000Z"),
      claimedAt: new Date("2026-07-24T16:00:10.000Z"),
      deviceId: "reader-home",
      jobExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
      completedAt: null,
      resultExpiresAt: null,
      readerVersion: null,
    };
    prismaMocks.localReaderJob.findUnique
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(activeLease);
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      queueLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore,
      }),
    ).resolves.toMatchObject({
      id: "job-retry-race",
      status: "PENDING",
      createdAt: new Date("2026-07-24T16:00:00.000Z"),
    });
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      ...stale,
      status: "PENDING",
      createdAt: new Date("2026-07-24T16:00:00.000Z"),
      updatedAt: new Date("2026-07-24T16:00:00.000Z"),
      completedAt: null,
      resultExpiresAt: null,
      readerVersion: null,
      jobExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
    });
    await expect(
      getLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore,
      }),
    ).resolves.toEqual({ status: "PENDING" });
    await expect(
      queueLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore,
      }),
    ).resolves.toMatchObject({
      id: "job-retry-race",
      status: "LEASED",
      leaseToken: "lease-current-attempt",
      createdAt: new Date("2026-07-24T16:00:00.000Z"),
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("reuses a pending job from an earlier schedule version", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      id: "job-earlier-version",
      scheduleVersion: 2,
      status: "PENDING",
      jobExpiresAt: new Date("2026-07-24T16:30:00.000Z"),
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 4,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      id: "job-earlier-version",
      scheduleVersion: 2,
      status: "PENDING",
    });
    expect(prismaMocks.localReaderJob.findUnique).not.toHaveBeenCalled();
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("does not erase an unexpired completed result during an overlapping retry", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-1",
      scheduleVersion: 3,
      resumeFromScheduleVersion: 3,
      resumeScheduleVersion: 4,
      status: "COMPLETED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      claimedAt: new Date("2026-07-24T15:58:30.000Z"),
      completedAt: new Date("2026-07-24T15:59:00.000Z"),
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
      result: {
        jobId: "job-1",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: "2026-07-24T15:58:30.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 4,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      id: "job-1",
      status: "COMPLETED",
      queueDisposition: "SUCCESS",
      readerResultStatus: "NO_AVAILABILITY",
      providerObservedAt: new Date("2026-07-24T15:58:30.000Z"),
      failureObservedAt: null,
    });
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("requeues an exact completed result that lacks resume-generation proof", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-proofless-completed",
      scheduleVersion: 3,
      resumeFromScheduleVersion: null,
      resumeScheduleVersion: null,
      status: "COMPLETED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      claimedAt: new Date("2026-07-24T15:58:30.000Z"),
      completedAt: new Date("2026-07-24T15:59:00.000Z"),
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
      result: {
        jobId: "job-proofless-completed",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: "2026-07-24T15:58:30.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-proofless-completed",
      status: "PENDING",
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 4,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      id: "job-proofless-completed",
      status: "PENDING",
      queueDisposition: "ACTIVE",
      readerResultStatus: null,
    });
    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "PENDING",
          result: undefined,
          resumeFromScheduleVersion: null,
          resumeScheduleVersion: null,
          completedAt: null,
        }),
      }),
    );
  });

  it("anchors a legacy completed retry to its server claim instead of callback receipt", async () => {
    const claimedAt = new Date("2026-07-24T15:58:30.000Z");
    const delayedSuccessObservedAt = new Date("2026-07-24T15:58:45.000Z");
    const callbackReceivedAt = new Date("2026-07-24T15:59:00.000Z");
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-legacy-completed",
      status: "COMPLETED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T15:58:00.000Z"),
      claimedAt,
      completedAt: callbackReceivedAt,
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
      result: {
        jobId: "job-legacy-completed",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T15:58:30.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-legacy-completed",
      status: "PENDING",
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 4,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      id: "job-legacy-completed",
      status: "PENDING",
      queueDisposition: "RETRYING_AFTER_TERMINAL_FAILURE",
      readerResultStatus: null,
      providerObservedAt: null,
      failureObservedAt: claimedAt,
    });
    expect(claimedAt.getTime()).toBeLessThan(
      delayedSuccessObservedAt.getTime(),
    );
    expect(delayedSuccessObservedAt.getTime()).toBeLessThan(
      callbackReceivedAt.getTime(),
    );
    expect(prismaMocks.localReaderJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "PENDING",
          claimedAt: null,
          completedAt: null,
          result: undefined,
          resumeFromScheduleVersion: null,
          resumeScheduleVersion: null,
        }),
      }),
    );
  });

  it("does not invent a provider failure time for an unanchored legacy completion", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-invalid-legacy-completed",
      status: "COMPLETED",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      createdAt: new Date("2026-07-24T15:58:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:30.000Z"),
      completedAt: new Date("2026-07-24T15:59:00.000Z"),
      updatedAt: new Date("2026-07-24T15:59:00.000Z"),
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
      result: {
        jobId: "job-invalid-legacy-completed",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T15:58:30.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });
    prismaMocks.localReaderJob.upsert.mockResolvedValue({
      id: "job-invalid-legacy-completed",
      status: "PENDING",
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 4,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      id: "job-invalid-legacy-completed",
      status: "PENDING",
      queueDisposition: "RETRYING_AFTER_TERMINAL_FAILURE",
      readerResultStatus: null,
      providerObservedAt: null,
      failureObservedAt: null,
    });
  });

  it("reuses a completed terminal result without turning it back into pending work", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      id: "job-challenge",
      status: "COMPLETED",
      claimedAt: new Date("2026-07-24T15:58:30.000Z"),
      completedAt: new Date("2026-07-24T15:59:00.000Z"),
      leaseExpiresAt: null,
      jobExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:05:00.000Z"),
      result: {
        jobId: "job-challenge",
        courseKey: "cps:grassyhill.cps.golf",
        status: "ACCESS_CHALLENGE",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: "2026-07-24T15:58:30.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      queueLocalReaderJob({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 3,
        targetDate: "2026-07-25",
        players: 4,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      id: "job-challenge",
      status: "COMPLETED",
      queueDisposition: "TERMINAL",
      readerResultStatus: "ACCESS_CHALLENGE",
      providerObservedAt: new Date("2026-07-24T15:58:30.000Z"),
      failureObservedAt: new Date("2026-07-24T15:58:30.000Z"),
    });
    expect(prismaMocks.localReaderJob.findUnique).not.toHaveBeenCalled();
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("claims an eligible job with a bounded lease", async () => {
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.localReaderJob.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "job-1",
          teeSearchId: "search-1",
          purpose: "ALERT_CHECK",
          courseId: "course-1",
          courseKey: "cps:grassyhill.cps.golf",
          requiredCapabilityKey: "CPS_RENDERED",
          targetDate: "2026-07-25",
          players: 2,
          createdAt: new Date("2026-07-24T15:59:00.000Z"),
          jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
          bookingUrl,
        },
      ]);

    await expect(claimNextLocalReaderJob("chrome-home")).resolves.toMatchObject(
      {
        id: "job-1",
        courseKey: "cps:grassyhill.cps.golf",
        targetDate: "2026-07-25",
        players: 2,
        courseName: "Grassy Hill Country Club",
        bookingUrl,
        cardTextIncludes: [],
        leaseExpiresAt: "2026-07-24T16:03:00.000Z",
        leaseToken: expect.any(String),
      },
    );
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "LEASED",
          claimedAt: new Date("2026-07-24T16:00:00.000Z"),
          deviceId: "chrome-home",
        }),
      }),
    );
    const claimedWrite =
      prismaMocks.localReaderJob.updateMany.mock.calls.at(-1)?.[0];
    expect(
      monitoringMocks.acquireCourseMonitoringWriteLockInTransaction,
    ).toHaveBeenCalledWith(prismaMocks, "course-1");
    expect(
      providerObservationMocks.beginCourseProviderObservationInTransaction,
    ).toHaveBeenCalledWith(prismaMocks, {
      courseId: "course-1",
      leaseToken: claimedWrite?.data?.leaseToken,
      ttlMs: 3 * 60_000,
    });
    expect(
      monitoringMocks.acquireCourseMonitoringWriteLockInTransaction.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      providerObservationMocks.beginCourseProviderObservationInTransaction.mock
        .invocationCallOrder[0],
    );
    expect(
      providerObservationMocks.beginCourseProviderObservationInTransaction.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      prismaMocks.localReaderJob.updateMany.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("does not return provider work when the per-course observation marker is busy", async () => {
    prismaMocks.localReaderJob.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "job-marker-busy",
          teeSearchId: "search-1",
          purpose: "ALERT_CHECK",
          courseId: "course-1",
          courseKey: "cps:grassyhill.cps.golf",
          requiredCapabilityKey: "CPS_RENDERED",
          targetDate: "2026-07-25",
          players: 2,
          createdAt: new Date("2026-07-24T15:59:00.000Z"),
          jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
          bookingUrl,
        },
      ]);
    providerObservationMocks.beginCourseProviderObservationInTransaction.mockResolvedValueOnce(
      null,
    );

    await expect(claimNextLocalReaderJob("chrome-home")).resolves.toBeNull();

    expect(
      providerObservationMocks.beginCourseProviderObservationInTransaction,
    ).toHaveBeenCalledOnce();
    expect(prismaMocks.localReaderJob.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.course.findUnique).not.toHaveBeenCalled();
  });

  it("rolls back a failed job CAS instead of deleting predecessor ambiguity", async () => {
    const predecessorStartedAt = new Date("2026-07-24T15:30:00.000Z");
    prismaMocks.localReaderJob.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "job-cas-lost",
          teeSearchId: "search-1",
          purpose: "ALERT_CHECK",
          courseId: "course-1",
          courseKey: "cps:grassyhill.cps.golf",
          requiredCapabilityKey: "CPS_RENDERED",
          targetDate: "2026-07-25",
          players: 2,
          createdAt: new Date("2026-07-24T15:59:00.000Z"),
          jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
          bookingUrl,
        },
      ]);
    providerObservationMocks.beginCourseProviderObservationInTransaction.mockResolvedValueOnce(
      {
        courseId: "course-1",
        leaseToken: "contender-token",
        observationStartedAt: new Date("2026-07-24T16:00:00.000Z"),
        leaseExpiresAt: new Date("2026-07-24T16:03:00.000Z"),
        ttlMs: 3 * 60_000,
        supersededUnresolvedObservationStartedAt: predecessorStartedAt,
      },
    );
    prismaMocks.localReaderJob.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(claimNextLocalReaderJob("chrome-home")).resolves.toBeNull();

    expect(
      providerObservationMocks.releaseCourseProviderObservationInTransaction,
    ).not.toHaveBeenCalled();
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciledInTransaction,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.course.findUnique).not.toHaveBeenCalled();
  });

  it("uses the DB claim anchor to reject a cached observation from a slow claim host", async () => {
    vi.setSystemTime(new Date("2026-07-24T15:58:00.000Z"));
    const databaseClaimedAt = new Date("2026-07-24T16:00:00.000Z");
    const databaseCompletedAt = new Date("2026-07-24T16:01:00.000Z");
    const candidate = {
      id: "job-slow-claim-host",
      teeSearchId: "search-1",
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:57:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      bookingUrl,
    };
    prismaMocks.localReaderJob.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate]);
    const claim = await claimNextLocalReaderJob("chrome-home");
    expect(claim).toMatchObject({ id: candidate.id });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ claimedAt: databaseClaimedAt }),
      }),
    );

    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      ...candidate,
      status: "LEASED",
      leaseToken: claim!.leaseToken,
      claimedAt: databaseClaimedAt,
      leaseExpiresAt: new Date("2026-07-24T16:03:00.000Z"),
      deviceId: "chrome-home",
    });
    prismaMocks.localReaderJob.updateMany.mockClear();
    prismaMocks.$queryRaw.mockResolvedValue([
      { currentTime: databaseCompletedAt },
    ]);

    await expect(
      completeLocalReaderJob({
        jobId: candidate.id,
        leaseToken: claim!.leaseToken,
        receivedAt: databaseCompletedAt,
        deviceRequestAt: databaseCompletedAt,
        result: {
          jobId: candidate.id,
          courseKey: candidate.courseKey,
          status: "NO_AVAILABILITY",
          observedAt: "2026-07-24T15:59:30.000Z",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          slots: [],
          readerVersion: "reader-v1",
        },
      }),
    ).rejects.toThrow("invalid authenticated timing");
    expect(prismaMocks.localReaderJob.updateMany).not.toHaveBeenCalled();
    expect(
      providerObservationMocks.releaseCourseProviderObservationInTransaction,
    ).not.toHaveBeenCalled();
  });

  it("claims active real customer work ahead of more than fifty older verification jobs", async () => {
    const olderVerificationJobs = Array.from({ length: 51 }, (_, index) => ({
      id: `verification-${String(index).padStart(2, "0")}`,
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseKey: `tenfore:verification-${index}`,
      requiredCapabilityKey: "TENFORE_RENDERED",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date(2026, 6, 24, 15, index),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      bookingUrl: `https://fox.tenfore.golf/verification-${index}`,
    }));
    const customerJob = {
      id: "customer-newer",
      teeSearchId: "search-real",
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      bookingUrl,
    };
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.localReaderJob.findMany.mockImplementation(async (query) => {
      if (query?.where?.status === "LEASED") return [];
      if (query?.where?.purpose === "ALERT_CHECK") return [customerJob];
      return olderVerificationJobs.slice(0, query?.take ?? 50);
    });

    await expect(claimNextLocalReaderJob("chrome-home")).resolves.toMatchObject(
      {
        id: "customer-newer",
        courseKey: "cps:grassyhill.cps.golf",
      },
    );
    expect(olderVerificationJobs).toHaveLength(51);
    expect(prismaMocks.localReaderJob.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          purpose: "ALERT_CHECK",
          teeSearch: {
            is: {
              status: "ACTIVE",
              trafficClass: { notIn: ["AUTOMATION", "TEST"] },
            },
          },
        }),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 50,
      }),
    );
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "customer-newer" }),
      }),
    );
  });

  it("prioritizes active customer work and skips a provider family already leased", async () => {
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.localReaderJob.findMany
      .mockResolvedValueOnce([
        {
          id: "active-cps-job",
          courseKey: "cps:other.cps.golf",
          requiredCapabilityKey: "CPS_RENDERED",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "older-verification",
          teeSearchId: null,
          purpose: "COURSE_VERIFICATION",
          courseKey: "tenfore:older",
          requiredCapabilityKey: "TENFORE_RENDERED",
          targetDate: "2026-07-25",
          players: 2,
          createdAt: new Date("2026-07-24T15:55:00.000Z"),
          jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
          bookingUrl: tenForeBookingUrl,
        },
        {
          id: "customer-cps",
          teeSearchId: "search-1",
          purpose: "ALERT_CHECK",
          courseKey: "cps:grassyhill.cps.golf",
          requiredCapabilityKey: "CPS_RENDERED",
          targetDate: "2026-07-25",
          players: 2,
          createdAt: new Date("2026-07-24T15:58:00.000Z"),
          jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
          bookingUrl,
        },
        {
          id: "customer-chronogolf",
          teeSearchId: "search-2",
          purpose: "ALERT_CHECK",
          courseKey: "chronogolf:crestbrook-park-golf-course",
          requiredCapabilityKey: "CHRONOGOLF_RENDERED",
          targetDate: "2026-07-25",
          players: 2,
          createdAt: new Date("2026-07-24T15:59:00.000Z"),
          jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
          bookingUrl: chronogolfBookingUrl,
        },
      ]);
    prismaMocks.course.findUnique.mockResolvedValue({
      name: "Crestbrook Park Golf Course",
    });

    await expect(claimNextLocalReaderJob("chrome-home")).resolves.toMatchObject(
      {
        id: "customer-chronogolf",
        courseKey: "chronogolf:crestbrook-park-golf-course",
      },
    );
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "customer-chronogolf" }),
      }),
    );
  });

  it("pages past fifty blocked-family customer jobs before considering background work", async () => {
    const blockedCustomerJobs = Array.from({ length: 50 }, (_, index) => ({
      id: `customer-cps-${String(index).padStart(2, "0")}`,
      teeSearchId: `search-cps-${index}`,
      purpose: "ALERT_CHECK",
      courseId: `course-cps-${index}`,
      courseKey: `cps:customer-${index}.cps.golf`,
      requiredCapabilityKey: "CPS_RENDERED",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date(2026, 6, 24, 15, index),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      bookingUrl,
    }));
    const eligibleCustomerJob = {
      id: "customer-chronogolf-51",
      teeSearchId: "search-chronogolf",
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "chronogolf:crestbrook-park-golf-course",
      requiredCapabilityKey: "CHRONOGOLF_RENDERED",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      bookingUrl: chronogolfBookingUrl,
    };
    const backgroundJob = {
      id: "background-tenfore",
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-background",
      courseKey: "tenfore:background",
      requiredCapabilityKey: "TENFORE_RENDERED",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:00:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      bookingUrl: tenForeBookingUrl,
    };
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.localReaderJob.findMany.mockImplementation(async (query) => {
      if (query?.where?.status === "LEASED") {
        return [
          {
            id: "active-cps-job",
            courseKey: "cps:active.cps.golf",
            requiredCapabilityKey: "CPS_RENDERED",
          },
        ];
      }
      if (query?.where?.purpose === "ALERT_CHECK") {
        return query.cursor ? [eligibleCustomerJob] : blockedCustomerJobs;
      }
      return [backgroundJob];
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      name: "Crestbrook Park Golf Course",
    });

    await expect(claimNextLocalReaderJob("chrome-home")).resolves.toMatchObject(
      {
        id: "customer-chronogolf-51",
        courseKey: "chronogolf:crestbrook-park-golf-course",
      },
    );

    expect(prismaMocks.localReaderJob.findMany).toHaveBeenCalledTimes(3);
    expect(prismaMocks.localReaderJob.findMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: expect.objectContaining({ purpose: "ALERT_CHECK" }),
        cursor: { id: "customer-cps-49" },
        skip: 1,
        take: 50,
      }),
    );
    expect(
      prismaMocks.localReaderJob.findMany.mock.calls.some(
        ([query]) => query?.where?.NOT !== undefined,
      ),
    ).toBe(false);
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "customer-chronogolf-51" }),
      }),
    );
  });

  it("does not lease a third global reader job", async () => {
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.localReaderJob.findMany.mockResolvedValueOnce([
      {
        id: "active-cps-job",
        courseKey: "cps:other.cps.golf",
        requiredCapabilityKey: "CPS_RENDERED",
      },
      {
        id: "active-tenfore-job",
        courseKey: "tenfore:active",
        requiredCapabilityKey: "TENFORE_RENDERED",
      },
    ]);

    await expect(claimNextLocalReaderJob("chrome-home")).resolves.toBeNull();
    expect(prismaMocks.localReaderJob.findMany).toHaveBeenCalledOnce();
  });

  it("does not claim reader work while the local-reader worker is paused", async () => {
    workerMocks.startAutomationWorker.mockResolvedValue({ allowed: false });

    await expect(claimNextLocalReaderJob("chrome-home")).resolves.toBeNull();

    expect(prismaMocks.localReaderJob.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.localReaderJob.findMany).not.toHaveBeenCalled();
    expect(workerMocks.completeAutomationWorker).not.toHaveBeenCalled();
  });

  it("does not reopen reader incidents for an unchanged heartbeat", async () => {
    const capabilities = [
      { key: "EZLINKS_RENDERED" as const, parserVersion: 1 },
    ];
    prismaMocks.localReaderAgent.findUnique.mockResolvedValue({
      readerVersion: "1.7.0",
      buildId: "reader-build-7",
      capabilities,
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);

    await expect(
      claimNextLocalReaderJob({
        deviceId: "reader-home",
        readerVersion: "1.7.0",
        buildId: "reader-build-7",
        capabilities,
      }),
    ).resolves.toBeNull();

    expect(prismaMocks.localReaderAgent.upsert).toHaveBeenCalledOnce();
    expect(prismaMocks.courseSupportIncident.findMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("gives a new compatible reader build a fresh investigation deadline", async () => {
    const capabilities = [
      { key: "EZLINKS_RENDERED" as const, parserVersion: 1 },
    ];
    prismaMocks.localReaderAgent.findUnique.mockResolvedValue({
      readerVersion: "1.6.0",
      buildId: "reader-build-6",
      capabilities,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      {
        id: "incident-harbor",
        cycle: 7,
        revision: 83,
        courseId: "course-harbor",
        activeRealSearchCount: 0,
        course: {
          name: "Harbor Golf Course",
          detectedBookingUrl: "https://wilddunes.ezlinksgolf.com/index.html",
          website:
            "https://www.wilddunesresort.com/activities/golf/golf-courses/harbor-course/",
          monitoringStatus: { revision: 91 },
        },
      },
    ]);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);

    await expect(
      claimNextLocalReaderJob({
        deviceId: "reader-home",
        readerVersion: "1.7.0",
        buildId: "reader-build-7",
        capabilities,
      }),
    ).resolves.toBeNull();

    expect(
      monitoringMocks.getCourseMonitoringEscalationDeadline,
    ).toHaveBeenCalledWith(new Date("2026-07-24T16:00:00.000Z"), 0);
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          escalationDeadlineAt: new Date("2026-07-24T16:30:00.000Z"),
        }),
      }),
    );
    const incidentUpdate =
      prismaMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0]?.data;
    expect(incidentUpdate).not.toHaveProperty("confirmedAt");
    expect(incidentUpdate).not.toHaveProperty("lastSeenAt");
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          courseId: "course-harbor",
          eventType: "REVALIDATION_REQUESTED",
          audit: {
            priorCycle: 7,
            cycle: 8,
            parserVersion: 1,
            readerVersion: "1.7.0",
            buildId: "reader-build-7",
            customerDataIncluded: false,
          },
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        preferences: { some: { courseId: "course-harbor" } },
      },
      data: {
        nextCheckAt: new Date("2026-07-24T16:00:00.000Z"),
        recheckRequestedAt: new Date("2026-07-24T16:00:00.000Z"),
      },
    });
  });

  it("preserves a t1 reader claim source through a t2 build requeue and t3 delayed result", async () => {
    const priorEvidenceAt = new Date("2026-07-24T15:55:00.000Z");
    const claimedAt = new Date("2026-07-24T16:00:00.000Z");
    const requeuedAt = new Date("2026-07-24T16:01:00.000Z");
    const completedAt = new Date("2026-07-24T16:02:00.000Z");
    const capabilities = [{ key: "CPS_RENDERED" as const, parserVersion: 1 }];
    const candidate = {
      id: "job-delayed-reader-proof",
      teeSearchId: "search-1",
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      bookingUrl,
    };
    const priorAgent = {
      readerVersion: "1.6.0",
      buildId: "reader-build-6",
      capabilities,
    };
    prismaMocks.localReaderAgent.findUnique.mockResolvedValue(priorAgent);
    prismaMocks.localReaderJob.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate]);

    const claim = await claimNextLocalReaderJob({
      deviceId: "reader-home",
      readerVersion: "1.6.0",
      buildId: "reader-build-6",
      capabilities,
    });
    expect(claim).toMatchObject({
      id: candidate.id,
      leaseToken: expect.any(String),
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ claimedAt }),
      }),
    );

    vi.setSystemTime(requeuedAt);
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      {
        id: "incident-reader-reload",
        cycle: 7,
        revision: 83,
        courseId: "course-1",
        activeRealSearchCount: 1,
        confirmedAt: priorEvidenceAt,
        lastSeenAt: priorEvidenceAt,
        course: {
          name: "Grassy Hill Country Club",
          detectedBookingUrl: bookingUrl,
          website: null,
          monitoringStatus: { revision: 91 },
        },
      },
    ]);
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.localReaderJob.findMany.mockReset().mockResolvedValue([
      {
        id: candidate.id,
        courseKey: candidate.courseKey,
        requiredCapabilityKey: candidate.requiredCapabilityKey,
      },
      {
        id: "job-other-active-family",
        courseKey: "tenfore:other",
        requiredCapabilityKey: "TENFORE_RENDERED",
      },
    ]);

    await expect(
      claimNextLocalReaderJob({
        deviceId: "reader-home",
        readerVersion: "1.7.0",
        buildId: "reader-build-7",
        capabilities,
      }),
    ).resolves.toBeNull();
    const requeueUpdate =
      prismaMocks.courseSupportIncident.updateMany.mock.calls.at(-1)?.[0]?.data;
    expect(requeueUpdate).toMatchObject({
      cycle: { increment: 1 },
      status: "AUTO_INVESTIGATING",
      nextAttemptAt: requeuedAt,
    });
    expect(requeueUpdate).not.toHaveProperty("confirmedAt");
    expect(requeueUpdate).not.toHaveProperty("lastSeenAt");

    vi.setSystemTime(completedAt);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      ...candidate,
      status: "LEASED",
      leaseToken: claim!.leaseToken,
      leaseExpiresAt: new Date("2026-07-24T16:03:00.000Z"),
      claimedAt,
      deviceId: "reader-home",
    });
    prismaMocks.localReaderJob.updateMany.mockClear().mockResolvedValue({
      count: 1,
    });
    prismaMocks.$queryRaw.mockResolvedValue([{ currentTime: completedAt }]);
    await expect(
      completeLocalReaderJob({
        jobId: candidate.id,
        leaseToken: claim!.leaseToken,
        receivedAt: completedAt,
        deviceRequestAt: completedAt,
        result: {
          jobId: candidate.id,
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          observedAt: "2026-07-24T16:01:30.000Z",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          slots: [],
          readerVersion: "1.7.0",
        },
      }),
    ).resolves.toEqual({
      searchId: "search-1",
      completedAt,
      resumeScheduleVersion: null,
    });
    const completedWrite =
      prismaMocks.localReaderJob.updateMany.mock.calls.find(
        ([call]) => call.data?.status === "COMPLETED",
      )?.[0];
    const persistedResult = completedWrite?.data?.result;
    expect(persistedResult).toMatchObject({
      evidenceAnchor: "SERVER_CLAIM",
      observedAt: claimedAt.toISOString(),
    });
    expect(completedWrite?.data).toMatchObject({
      resumeFromScheduleVersion: null,
      resumeScheduleVersion: null,
    });

    prismaMocks.localReaderJob.findFirst.mockResolvedValue(null);
    await expect(
      getFreshLocalReaderObservation({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 7,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:59:30.000Z"),
      }),
    ).resolves.toBeNull();
    expect(prismaMocks.localReaderJob.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          resumeFromScheduleVersion: { not: null },
          resumeScheduleVersion: 7,
        }),
      }),
    );
  });

  it("completes generation 7, queues generation 8, and consumes the exact reusable proof", async () => {
    const providerObservedAt = new Date("2026-07-24T15:59:30.000Z");
    const completedAt = new Date("2026-07-24T16:00:00.000Z");
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-1",
      teeSearchId: "search-1",
      scheduleVersion: 7,
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: providerObservedAt,
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl,
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.teeSearch.findUnique.mockResolvedValue({
      status: "ACTIVE",
      scheduleVersion: 7,
      checkStatus: "CHECKING",
      date: new Date("2026-07-25T00:00:00.000Z"),
      players: 2,
      preferences: [{ courseId: "course-1" }],
    });
    prismaMocks.teeSearch.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      completeLocalReaderJob({
        jobId: "job-1",
        leaseToken: "lease-1",
        receivedAt: completedAt,
        deviceRequestAt: completedAt,
        result: {
          jobId: "job-1",
          courseKey: "cps:grassyhill.cps.golf",
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
              cartIncluded: true,
            },
          ],
          readerVersion: "test",
        },
      }),
    ).resolves.toMatchObject({
      searchId: "search-1",
      completedAt,
      resumeScheduleVersion: 8,
    });
    const completedCallIndex =
      prismaMocks.localReaderJob.updateMany.mock.calls.findIndex(
        ([call]) => call.data?.status === "COMPLETED",
      );
    expect(completedCallIndex).toBeGreaterThanOrEqual(0);
    const completedWriteOrder =
      prismaMocks.localReaderJob.updateMany.mock.invocationCallOrder[
        completedCallIndex
      ];
    expect(
      providerObservationMocks.renewCourseProviderObservationInTransaction.mock
        .invocationCallOrder[0],
    ).toBeLessThan(completedWriteOrder);
    expect(completedWriteOrder).toBeLessThan(
      prismaMocks.teeSearch.updateMany.mock.invocationCallOrder[0],
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "search-1",
        status: "ACTIVE",
        scheduleVersion: 7,
      },
      data: {
        scheduleVersion: { increment: 1 },
        checkStatus: "QUEUED",
        nextCheckAt: new Date("2026-07-24T16:00:00.000Z"),
        lastCheckOutcome: null,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: new Date("2026-07-24T16:00:00.000Z"),
        updatedAt: new Date("2026-07-24T16:00:00.000Z"),
      },
    });
    expect(
      prismaMocks.teeSearch.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(
      providerObservationMocks.releaseCourseProviderObservationInTransaction
        .mock.invocationCallOrder[0],
    );
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: { not: "job-1" },
        teeSearchId: "search-1",
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        status: "PENDING",
      },
      data: {
        status: "EXPIRED",
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });

    const persistedResult =
      prismaMocks.localReaderJob.updateMany.mock.calls[completedCallIndex]?.[0]
        ?.data?.result;
    const resumeProofWrite =
      prismaMocks.localReaderJob.updateMany.mock.calls.find(
        ([call]) =>
          call.data?.resumeFromScheduleVersion === 7 &&
          call.data?.resumeScheduleVersion === 8,
      )?.[0];
    expect(resumeProofWrite).toEqual({
      where: {
        id: "job-1",
        status: "COMPLETED",
        completedAt,
        resumeFromScheduleVersion: null,
        resumeScheduleVersion: null,
      },
      data: {
        resumeFromScheduleVersion: 7,
        resumeScheduleVersion: 8,
      },
    });
    const resultExpiresAt = new Date("2026-07-24T16:10:00.000Z");
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      id: "job-1",
      scheduleVersion: 7,
      resumeFromScheduleVersion: 7,
      resumeScheduleVersion: 8,
      claimedAt: providerObservedAt,
      completedAt,
      resultExpiresAt,
      result: persistedResult,
    });

    const observation = await getFreshLocalReaderObservation({
      searchId: "search-1",
      courseId: "course-1",
      scheduleVersion: 8,
      targetDate: "2026-07-25",
      players: 2,
      bookingUrl,
      notBefore: providerObservedAt,
    });

    expect(observation).toMatchObject({
      jobId: "job-1",
      scheduleVersion: 8,
      status: "AVAILABLE",
      observedAt: providerObservedAt,
    });
    expect(prismaMocks.localReaderJob.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teeSearchId: "search-1",
          courseId: "course-1",
          scheduleVersion: { lte: 8 },
          resumeFromScheduleVersion: { not: null },
          resumeScheduleVersion: 8,
          courseKey: "cps:grassyhill.cps.golf",
          targetDate: "2026-07-25",
          players: 2,
          status: "COMPLETED",
          requiredCapabilityKey: "CPS_RENDERED",
          requiredParserVersion: 1,
          claimedAt: { gte: providerObservedAt },
          completedAt: { gte: providerObservedAt },
          resultExpiresAt: { gt: completedAt },
        }),
      }),
    );

    prismaMocks.$queryRaw.mockResolvedValue([{ id: "search-1" }]);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-1",
      teeSearchId: "search-1",
      courseId: "course-1",
      scheduleVersion: 7,
      resumeFromScheduleVersion: 7,
      resumeScheduleVersion: 8,
      status: "COMPLETED",
      claimedAt: providerObservedAt,
      completedAt,
      result: persistedResult,
      resultExpiresAt,
    });
    prismaMocks.localReaderJob.updateMany.mockClear().mockResolvedValue({
      count: 1,
    });

    await expect(
      markCompletedLocalReaderProviderObservationConsumedInTransaction(
        prismaMocks as never,
        {
          courseId: "course-1",
          searchId: "search-1",
          scheduleVersion: 8,
          checkLeaseToken: "generation-8-check-lease",
          jobId: observation!.jobId,
          providerObservedAt: observation!.observedAt,
          resultStatus: observation!.status,
        },
      ),
    ).resolves.toBe(true);
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        teeSearchId: "search-1",
        courseId: "course-1",
        scheduleVersion: { lte: 8 },
        resumeFromScheduleVersion: 7,
        resumeScheduleVersion: 8,
        status: "COMPLETED",
        claimedAt: providerObservedAt,
        completedAt,
        resultExpiresAt: { gt: completedAt },
      },
      data: { resultExpiresAt: completedAt },
    });
  });

  it("rereads and queues the newest compatible generation after a concurrent edit wins the first CAS", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-generation-race",
      teeSearchId: "search-1",
      scheduleVersion: 5,
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-generation-race",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl,
    });
    prismaMocks.teeSearch.findUnique
      .mockResolvedValueOnce({
        status: "ACTIVE",
        scheduleVersion: 7,
        date: new Date("2026-07-25T00:00:00.000Z"),
        players: 2,
        preferences: [{ courseId: "course-1" }],
      })
      .mockResolvedValueOnce({
        status: "ACTIVE",
        scheduleVersion: 8,
        date: new Date("2026-07-25T00:00:00.000Z"),
        players: 2,
        preferences: [{ courseId: "course-1" }],
      });
    prismaMocks.teeSearch.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(
      completeLocalReaderJob({
        jobId: "job-generation-race",
        leaseToken: "lease-generation-race",
        receivedAt: new Date("2026-07-24T16:00:00.000Z"),
        deviceRequestAt: new Date("2026-07-24T16:00:00.000Z"),
        result: {
          jobId: "job-generation-race",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          observedAt: "2026-07-24T16:00:00.000Z",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          slots: [],
          readerVersion: "test",
        },
      }),
    ).resolves.toMatchObject({
      searchId: "search-1",
      resumeScheduleVersion: 9,
    });
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: "search-1",
          status: "ACTIVE",
          scheduleVersion: 7,
        },
      }),
    );
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-generation-race",
        status: "COMPLETED",
        completedAt: new Date("2026-07-24T16:00:00.000Z"),
        resumeFromScheduleVersion: null,
        resumeScheduleVersion: null,
      },
      data: {
        resumeFromScheduleVersion: 8,
        resumeScheduleVersion: 9,
      },
    });
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: "search-1",
          status: "ACTIVE",
          scheduleVersion: 8,
        },
      }),
    );
  });

  it.each([
    ["fresh", new Date("2026-07-24T16:12:00.000Z"), "FRESH_UNCONSUMED"],
    ["expired", new Date("2026-07-24T16:09:00.000Z"), "EXPIRED_UNCONSUMED"],
    ["consumed", new Date("2026-07-24T16:01:00.000Z"), "CONSUMED"],
  ] as const)(
    "classifies the newest durable SERVER_CLAIM source as %s using DB time",
    async (_label, resultExpiresAt, state) => {
      const providerObservedAt = new Date("2026-07-24T16:00:00.000Z");
      const completedAt = new Date("2026-07-24T16:01:00.000Z");
      prismaMocks.$queryRaw.mockResolvedValue([
        { currentTime: new Date("2026-07-24T16:10:00.000Z") },
      ]);
      prismaMocks.localReaderJob.findMany.mockResolvedValue([
        {
          result: {
            jobId: "job-source",
            courseKey: "cps:grassyhill.cps.golf",
            status: "NO_AVAILABILITY",
            evidenceAnchor: "SERVER_CLAIM",
            observedAt: providerObservedAt.toISOString(),
            pageUrl: bookingUrl,
            pageTitle: "Grassy Hill Country Club",
            slots: [],
            readerVersion: "reader-v1",
          },
          claimedAt: providerObservedAt,
          completedAt,
          resultExpiresAt,
        },
        {
          result: {
            jobId: "job-invalid-receipt-anchor",
            courseKey: "cps:grassyhill.cps.golf",
            status: "NO_AVAILABILITY",
            evidenceAnchor: "SERVER_CLAIM",
            observedAt: completedAt.toISOString(),
            pageUrl: bookingUrl,
            pageTitle: "Grassy Hill Country Club",
            slots: [],
            readerVersion: "reader-v1",
          },
          claimedAt: providerObservedAt,
          completedAt,
          resultExpiresAt,
        },
      ]);

      await expect(
        getNewestCompletedLocalReaderProviderObservationInTransaction(
          prismaMocks as never,
          "course-1",
        ),
      ).resolves.toEqual({
        providerObservedAt,
        resultExpiresAt,
        state,
      });
    },
  );

  it.each([
    ["fresh", new Date("2026-07-24T16:20:00.000Z"), "FRESH_UNCONSUMED"],
    ["expired", new Date("2026-07-24T16:09:00.000Z"), "EXPIRED_UNCONSUMED"],
  ] as const)(
    "does not let a consumed equal-millisecond source hide an independent %s result",
    async (_label, unconsumedExpiresAt, expectedState) => {
      const providerObservedAt = new Date("2026-07-24T16:00:00.000Z");
      const consumedAt = new Date("2026-07-24T16:05:00.000Z");
      const unconsumedCompletedAt = new Date("2026-07-24T16:01:00.000Z");
      const result = (jobId: string) => ({
        jobId,
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: providerObservedAt.toISOString(),
        pageUrl: bookingUrl,
        pageTitle: "Grassy Hill Country Club",
        slots: [],
        readerVersion: "reader-v1",
      });
      prismaMocks.$queryRaw.mockResolvedValue([
        { currentTime: new Date("2026-07-24T16:10:00.000Z") },
      ]);
      prismaMocks.localReaderJob.findMany.mockResolvedValue([
        {
          result: result("job-consumed"),
          claimedAt: providerObservedAt,
          completedAt: consumedAt,
          resultExpiresAt: consumedAt,
        },
        {
          result: result("job-independent"),
          claimedAt: providerObservedAt,
          completedAt: unconsumedCompletedAt,
          resultExpiresAt: unconsumedExpiresAt,
        },
      ]);

      await expect(
        getNewestCompletedLocalReaderProviderObservationInTransaction(
          prismaMocks as never,
          "course-1",
        ),
      ).resolves.toEqual({
        providerObservedAt,
        resultExpiresAt: unconsumedExpiresAt,
        state: expectedState,
      });
    },
  );

  it("marks exact completed reader proof consumed without changing its source timestamp", async () => {
    const providerObservedAt = new Date("2026-07-24T16:00:00.000Z");
    const completedAt = new Date("2026-07-24T16:01:00.000Z");
    prismaMocks.$queryRaw.mockResolvedValue([{ id: "search-1" }]);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-consumed",
      teeSearchId: "search-1",
      courseId: "course-1",
      scheduleVersion: 7,
      resumeFromScheduleVersion: 7,
      resumeScheduleVersion: 8,
      status: "COMPLETED",
      claimedAt: providerObservedAt,
      completedAt,
      result: {
        jobId: "job-consumed",
        status: "NO_AVAILABILITY",
        courseKey: "cps:grassyhill.cps.golf",
        observedAt: providerObservedAt.toISOString(),
        evidenceAnchor: "SERVER_CLAIM",
        pageUrl: bookingUrl,
        pageTitle: "Grassy Hill Country Club",
        readerVersion: "reader-v1",
        slots: [],
      },
      resultExpiresAt: new Date("2026-07-24T16:11:00.000Z"),
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      markCompletedLocalReaderProviderObservationConsumedInTransaction(
        prismaMocks as never,
        {
          courseId: "course-1",
          searchId: "search-1",
          scheduleVersion: 8,
          checkLeaseToken: "check-lease",
          jobId: "job-consumed",
          providerObservedAt,
          resultStatus: "NO_AVAILABILITY",
        },
      ),
    ).resolves.toBe(true);

    const searchLockQuery = prismaMocks.$queryRaw.mock.calls.at(-1)?.[0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    expect(searchLockQuery.strings?.join(" ")).toContain("FOR UPDATE");
    expect(searchLockQuery.values).toEqual(
      expect.arrayContaining(["search-1", 8, "check-lease"]),
    );
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "job-consumed",
        teeSearchId: "search-1",
        courseId: "course-1",
        scheduleVersion: { lte: 8 },
        resumeFromScheduleVersion: 7,
        resumeScheduleVersion: 8,
        claimedAt: providerObservedAt,
        completedAt,
      }),
      data: { resultExpiresAt: completedAt },
    });
  });

  it.each([
    ["legacy", null, null],
    ["wrong target", 7, 9],
  ] as const)(
    "does not consume %s reader proof for generation 8",
    async (_label, resumeFromScheduleVersion, resumeScheduleVersion) => {
      const providerObservedAt = new Date("2026-07-24T16:00:00.000Z");
      const completedAt = new Date("2026-07-24T16:01:00.000Z");
      prismaMocks.$queryRaw.mockResolvedValue([{ id: "search-1" }]);
      prismaMocks.localReaderJob.findUnique.mockResolvedValue({
        id: "job-not-exact",
        teeSearchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 7,
        resumeFromScheduleVersion,
        resumeScheduleVersion,
        status: "COMPLETED",
        claimedAt: providerObservedAt,
        completedAt,
        result: {
          jobId: "job-not-exact",
          status: "NO_AVAILABILITY",
          courseKey: "cps:grassyhill.cps.golf",
          observedAt: providerObservedAt.toISOString(),
          evidenceAnchor: "SERVER_CLAIM",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          readerVersion: "reader-v1",
          slots: [],
        },
        resultExpiresAt: new Date("2026-07-24T16:11:00.000Z"),
      });
      prismaMocks.localReaderJob.updateMany.mockClear();

      await expect(
        markCompletedLocalReaderProviderObservationConsumedInTransaction(
          prismaMocks as never,
          {
            courseId: "course-1",
            searchId: "search-1",
            scheduleVersion: 8,
            checkLeaseToken: "check-lease",
            jobId: "job-not-exact",
            providerObservedAt,
            resultStatus: "NO_AVAILABILITY",
          },
        ),
      ).resolves.toBe(false);
      expect(prismaMocks.localReaderJob.updateMany).not.toHaveBeenCalled();
    },
  );

  it("returns an expired unconsumed compatible-generation result only as canonical resume evidence", async () => {
    const providerObservedAt = new Date("2026-07-24T15:45:00.000Z");
    const completedAt = new Date("2026-07-24T15:46:00.000Z");
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      id: "job-expired-resume",
      scheduleVersion: 6,
      resumeFromScheduleVersion: 6,
      resumeScheduleVersion: 7,
      claimedAt: providerObservedAt,
      completedAt,
      resultExpiresAt: new Date("2026-07-24T15:56:00.000Z"),
      result: {
        jobId: "job-expired-resume",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: providerObservedAt.toISOString(),
        pageUrl: bookingUrl,
        pageTitle: "Grassy Hill Country Club",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      getExpiredUnconsumedLocalReaderObservationForCanonicalResume({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 7,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      jobId: "job-expired-resume",
      scheduleVersion: 7,
      status: "NO_AVAILABILITY",
      observedAt: providerObservedAt,
      canonicalResumeOnly: true,
    });
    expect(prismaMocks.localReaderJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teeSearchId: "search-1",
          courseId: "course-1",
          scheduleVersion: { lte: 7 },
          resumeFromScheduleVersion: { not: null },
          resumeScheduleVersion: 7,
          resultExpiresAt: { lte: new Date("2026-07-24T16:00:00.000Z") },
        }),
      }),
    );
  });

  it("accepts authenticated clock-ahead timing but persists the server claim anchor", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-clock-ahead",
      teeSearchId: "search-1",
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:40.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-clock-ahead",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl,
    });

    await expect(
      completeLocalReaderJob({
        jobId: "job-clock-ahead",
        leaseToken: "lease-clock-ahead",
        receivedAt: new Date("2026-07-24T16:00:00.000Z"),
        deviceRequestAt: new Date("2026-07-24T16:01:00.000Z"),
        result: {
          jobId: "job-clock-ahead",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          observedAt: "2026-07-24T16:01:00.000Z",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          slots: [],
          readerVersion: "test",
        },
      }),
    ).resolves.toMatchObject({
      searchId: "search-1",
      completedAt: new Date("2026-07-24T16:00:00.000Z"),
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({
            observedAt: "2026-07-24T15:59:40.000Z",
            evidenceAnchor: "SERVER_CLAIM",
          }),
        }),
      }),
    );
  });

  it("accepts authenticated clock-behind timing but persists the server claim anchor", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-clock-behind",
      teeSearchId: "search-1",
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:58:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:10.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-clock-behind",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl,
    });

    await expect(
      completeLocalReaderJob({
        jobId: "job-clock-behind",
        leaseToken: "lease-clock-behind",
        receivedAt: new Date("2026-07-24T16:00:00.000Z"),
        deviceRequestAt: new Date("2026-07-24T15:59:00.000Z"),
        result: {
          jobId: "job-clock-behind",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          observedAt: "2026-07-24T15:58:50.000Z",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          slots: [],
          readerVersion: "test",
        },
      }),
    ).resolves.toMatchObject({
      searchId: "search-1",
      completedAt: new Date("2026-07-24T16:00:00.000Z"),
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({
            observedAt: "2026-07-24T15:59:10.000Z",
            evidenceAnchor: "SERVER_CLAIM",
          }),
        }),
      }),
    );
  });

  it.each([
    [
      "request clock exceeds authenticated skew",
      "2026-07-24T16:01:00.001Z",
      "2026-07-24T16:01:00.000Z",
    ],
    [
      "observation is later than the signed request",
      "2026-07-24T16:01:00.000Z",
      "2026-07-24T16:01:00.001Z",
    ],
  ])(
    "rejects result timing when %s",
    async (_label, deviceRequestAt, observedAt) => {
      await expect(
        completeLocalReaderJob({
          jobId: "job-invalid-timing",
          leaseToken: "lease-invalid-timing",
          receivedAt: new Date("2026-07-24T16:00:00.000Z"),
          deviceRequestAt: new Date(deviceRequestAt),
          result: {
            jobId: "job-invalid-timing",
            courseKey: "cps:grassyhill.cps.golf",
            status: "NO_AVAILABILITY",
            observedAt,
            pageUrl: bookingUrl,
            pageTitle: "Grassy Hill Country Club",
            slots: [],
            readerVersion: "test",
          },
        }),
      ).rejects.toThrow("invalid authenticated timing");
      expect(prismaMocks.localReaderJob.findUnique).not.toHaveBeenCalled();
      expect(prismaMocks.localReaderJob.updateMany).not.toHaveBeenCalled();
    },
  );

  it("rejects a cached device observation that predates the issued lease", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-cached-observation",
      teeSearchId: "search-1",
      purpose: "ALERT_CHECK",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:50.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-cached-observation",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl,
    });

    await expect(
      completeLocalReaderJob({
        jobId: "job-cached-observation",
        leaseToken: "lease-cached-observation",
        receivedAt: new Date("2026-07-24T16:00:00.000Z"),
        deviceRequestAt: new Date("2026-07-24T16:00:00.000Z"),
        result: {
          jobId: "job-cached-observation",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          observedAt: "2026-07-24T15:50:00.000Z",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          slots: [],
          readerVersion: "test",
        },
      }),
    ).rejects.toThrow("invalid authenticated timing");
    expect(prismaMocks.localReaderJob.updateMany).not.toHaveBeenCalled();
  });

  it("stores detached verification evidence without scheduling a search", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-verification",
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-verification",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl,
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      completeLocalReaderJob({
        jobId: "job-verification",
        leaseToken: "lease-verification",
        receivedAt: new Date("2026-07-24T16:00:00.000Z"),
        deviceRequestAt: new Date("2026-07-24T16:00:00.000Z"),
        result: {
          jobId: "job-verification",
          courseKey: "cps:grassyhill.cps.golf",
          status: "NO_AVAILABILITY",
          observedAt: "2026-07-24T16:00:00.000Z",
          pageUrl: bookingUrl,
          pageTitle: "Grassy Hill Country Club",
          slots: [],
          readerVersion: "1.3.2",
        },
      }),
    ).resolves.toMatchObject({
      searchId: null,
      completedAt: new Date("2026-07-24T16:00:00.000Z"),
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.teeSearch.findUnique).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(
      monitoringMocks.recordCourseMonitoringSuccess,
    ).not.toHaveBeenCalled();
    expect(monitoringMocks.resolveCourseSupportIncident).not.toHaveBeenCalled();
  });

  it("does not let detached proof from an older cycle reconcile a newer ledgerless incident", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-verification",
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-verification",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl,
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-new-cycle",
      cycle: 9,
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      attemptLedger: null,
    });

    await completeLocalReaderJob({
      jobId: "job-verification",
      leaseToken: "lease-verification",
      receivedAt: new Date("2026-07-24T16:00:00.000Z"),
      deviceRequestAt: new Date("2026-07-24T16:00:00.000Z"),
      result: {
        jobId: "job-verification",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T16:00:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Grassy Hill Country Club",
        slots: [],
        readerVersion: "1.7.0",
      },
    });

    expect(prismaMocks.courseSupportIncident.findUnique).not.toHaveBeenCalled();
    expect(
      monitoringMocks.recordCourseMonitoringSuccess,
    ).not.toHaveBeenCalled();
    expect(monitoringMocks.resolveCourseSupportIncident).not.toHaveBeenCalled();
  });

  it("leaves ordered detached-reader success to the verification consumer", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-verification",
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-verification",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl,
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue({
      activeBatchId: null,
      status: "AUTO_INVESTIGATING",
      attemptLedger: { version: 1, events: [] },
    });

    await completeLocalReaderJob({
      jobId: "job-verification",
      leaseToken: "lease-verification",
      receivedAt: new Date("2026-07-24T16:00:00.000Z"),
      deviceRequestAt: new Date("2026-07-24T16:00:00.000Z"),
      result: {
        jobId: "job-verification",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T16:00:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Grassy Hill Country Club",
        slots: [],
        readerVersion: "1.7.1",
      },
    });

    expect(
      monitoringMocks.recordCourseMonitoringSuccess,
    ).not.toHaveBeenCalled();
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
      claimedAt: new Date("2026-07-24T16:00:45.000Z"),
      completedAt: new Date("2026-07-24T16:01:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      result: {
        jobId: "job-verification",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: "2026-07-24T16:00:45.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee Times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      getLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:00:30.000Z"),
      }),
    ).resolves.toEqual({
      status: "COMPLETED",
      observedAt: new Date("2026-07-24T16:00:45.000Z"),
      readerVersion: "reader-v1",
      slots: [],
    });
  });

  it("returns terminal detached reader evidence instead of making it pending again", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      targetDate: "2026-07-25",
      players: 2,
      status: "COMPLETED",
      createdAt: new Date("2026-07-24T16:00:00.000Z"),
      claimedAt: new Date("2026-07-24T16:00:45.000Z"),
      completedAt: new Date("2026-07-24T16:01:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      result: {
        jobId: "job-verification",
        courseKey: "cps:grassyhill.cps.golf",
        status: "PAGE_MISMATCH",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: "2026-07-24T16:00:45.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Unexpected public page",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      getLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:00:30.000Z"),
      }),
    ).resolves.toEqual({
      status: "TERMINAL",
      observedAt: new Date("2026-07-24T16:00:45.000Z"),
      readerVersion: "reader-v1",
      resultStatus: "PAGE_MISMATCH",
    });
  });

  it("rejects detached evidence whose server lease began before the verification boundary", async () => {
    const notBefore = new Date("2026-07-24T16:00:10.000Z");
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      targetDate: "2026-07-25",
      players: 2,
      status: "COMPLETED",
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: new Date("2026-07-24T16:00:01.000Z"),
      completedAt: new Date("2026-07-24T16:00:20.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      result: {
        jobId: "job-delayed-verification",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T16:00:19.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee Times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      getLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore,
      }),
    ).resolves.toBeNull();
    expect(prismaMocks.localReaderJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: "COMPLETED",
              claimedAt: { gte: notBefore },
              completedAt: { gte: notBefore },
            }),
          ]),
        }),
      }),
    );
  });

  it("rejects a legacy ahead-clock detached result without a server anchor marker", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      targetDate: "2026-07-25",
      players: 2,
      status: "COMPLETED",
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:30.000Z"),
      completedAt: new Date("2026-07-24T16:00:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:20:00.000Z"),
      resultExpiresAt: new Date("2026-07-24T16:10:00.000Z"),
      result: {
        jobId: "job-clock-ahead-verification",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T16:01:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee Times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      getLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:59:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("returns one expired detached attempt as terminal and only retries it in a later cycle", async () => {
    const expiredJob = {
      id: "job-expired-verification",
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      status: "EXPIRED",
      createdAt: new Date("2026-07-24T15:55:00.000Z"),
      updatedAt: new Date("2026-07-24T16:00:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:00:00.000Z"),
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: null,
      resultExpiresAt: null,
      result: null,
    };
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(expiredJob);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(expiredJob);

    await expect(
      getLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:55:00.000Z"),
      }),
    ).resolves.toEqual({
      status: "TERMINAL",
      observedAt: new Date("2026-07-24T16:00:00.000Z"),
      readerVersion: null,
      resultStatus: "EXPIRED",
    });
    await expect(
      queueLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:55:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: "job-expired-verification",
      status: "EXPIRED",
    });
    expect(prismaMocks.localReaderJob.updateMany).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-07-24T16:01:00.000Z"));
    await expect(
      queueLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:00:30.000Z"),
      }),
    ).resolves.toMatchObject({
      id: "job-expired-verification",
      status: "PENDING",
    });
    expect(prismaMocks.localReaderJob.updateMany).toHaveBeenCalledOnce();
  });

  it("treats an overdue pending verification as terminal before the expiry sweep runs", async () => {
    vi.setSystemTime(new Date("2026-07-24T16:01:00.000Z"));
    const overdueJob = {
      id: "job-overdue-before-sweep",
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      status: "PENDING",
      createdAt: new Date("2026-07-24T15:55:00.000Z"),
      updatedAt: new Date("2026-07-24T15:55:00.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:00:00.000Z"),
      requiredCapabilityKey: "CPS_RENDERED",
      requiredParserVersion: 1,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: null,
      resultExpiresAt: null,
      result: null,
    };
    prismaMocks.localReaderJob.findFirst.mockResolvedValue(overdueJob);
    prismaMocks.localReaderJob.findUnique.mockResolvedValue(overdueJob);

    await expect(
      getLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:55:00.000Z"),
      }),
    ).resolves.toEqual({
      status: "TERMINAL",
      observedAt: new Date("2026-07-24T16:00:00.000Z"),
      readerVersion: null,
      resultStatus: "EXPIRED",
    });
    await expect(
      queueLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:55:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: "job-overdue-before-sweep",
      status: "PENDING",
    });
    expect(prismaMocks.localReaderJob.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.localReaderJob.upsert).not.toHaveBeenCalled();
  });

  it("returns a post-boundary lease that expires as current-cycle terminal evidence", async () => {
    vi.setSystemTime(new Date("2026-07-24T16:01:00.000Z"));
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      id: "job-overdue-leased",
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: "course-1",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      status: "LEASED",
      createdAt: new Date("2026-07-24T15:55:00.000Z"),
      claimedAt: new Date("2026-07-24T16:00:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:01:00.000Z"),
      result: null,
    });

    await expect(
      getLocalReaderCourseVerification({
        courseId: "course-1",
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:00:00.000Z"),
      }),
    ).resolves.toEqual({
      status: "TERMINAL",
      observedAt: new Date("2026-07-24T16:01:00.000Z"),
      readerVersion: null,
      resultStatus: "EXPIRED",
    });
  });

  it("keeps challenged detached verification in engineering", async () => {
    prismaMocks.localReaderJob.findUnique.mockResolvedValue({
      id: "job-challenge",
      teeSearchId: null,
      courseId: "course-1",
      purpose: "COURSE_VERIFICATION",
      courseKey: "cps:grassyhill.cps.golf",
      targetDate: "2026-07-25",
      players: 2,
      createdAt: new Date("2026-07-24T15:59:00.000Z"),
      claimedAt: new Date("2026-07-24T15:59:30.000Z"),
      jobExpiresAt: new Date("2026-07-24T16:09:00.000Z"),
      status: "LEASED",
      leaseToken: "lease-challenge",
      leaseExpiresAt: new Date("2026-07-24T16:02:00.000Z"),
      bookingUrl,
    });
    prismaMocks.localReaderJob.updateMany.mockResolvedValue({ count: 1 });

    await completeLocalReaderJob({
      jobId: "job-challenge",
      leaseToken: "lease-challenge",
      receivedAt: new Date("2026-07-24T16:00:00.000Z"),
      deviceRequestAt: new Date("2026-07-24T16:00:00.000Z"),
      result: {
        jobId: "job-challenge",
        courseKey: "cps:grassyhill.cps.golf",
        status: "ACCESS_CHALLENGE",
        observedAt: "2026-07-24T16:00:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Checking your browser",
        slots: [],
        readerVersion: "1.4.0",
      },
    });

    expect(
      monitoringMocks.recordCourseMonitoringSuccess,
    ).not.toHaveBeenCalled();
    expect(monitoringMocks.resolveCourseSupportIncident).not.toHaveBeenCalled();
  });

  it("reuses fresh availability from a compatible generation and builds provider-compatible slots", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      claimedAt: new Date("2026-07-24T16:00:00.000Z"),
      completedAt: new Date("2026-07-24T16:00:30.000Z"),
      result: {
        jobId: "job-1",
        courseKey: "cps:grassyhill.cps.golf",
        status: "AVAILABLE",
        evidenceAnchor: "SERVER_CLAIM",
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
            cartIncluded: true,
          },
        ],
        readerVersion: "test",
      },
    });

    await expect(
      getFreshLocalReaderTeeSheet({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 7,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
      }),
    ).resolves.toMatchObject({
      slots: [
        {
          sourceId: "local-cps:grassyhill.cps.golf-2026-07-25T09:02:00",
          holes: 18,
          bookableHoleCounts: [9, 18],
          availableSpots: 4,
        },
      ],
    });
    expect(prismaMocks.localReaderJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teeSearchId: "search-1",
          courseId: "course-1",
          targetDate: "2026-07-25",
          players: 2,
          status: "COMPLETED",
        }),
        orderBy: [{ claimedAt: "desc" }, { completedAt: "desc" }],
      }),
    );
    expect(
      prismaMocks.localReaderJob.findFirst.mock.calls[0]?.[0]?.where,
    ).toHaveProperty("scheduleVersion", { lte: 7 });
  });

  it("returns a fresh access challenge as a terminal reader observation", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      claimedAt: new Date("2026-07-24T16:00:00.000Z"),
      completedAt: new Date("2026-07-24T16:00:30.000Z"),
      result: {
        jobId: "job-challenge",
        courseKey: "cps:grassyhill.cps.golf",
        status: "ACCESS_CHALLENGE",
        evidenceAnchor: "SERVER_CLAIM",
        observedAt: "2026-07-24T16:00:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Checking your browser",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      getFreshLocalReaderObservation({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 7,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T15:55:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "ACCESS_CHALLENGE",
      readerVersion: "reader-v1",
      teeSheet: null,
    });
    expect(prismaMocks.localReaderJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          courseKey: "cps:grassyhill.cps.golf",
          requiredCapabilityKey: "CPS_RENDERED",
          requiredParserVersion: 1,
          claimedAt: {
            gte: new Date("2026-07-24T15:55:00.000Z"),
          },
          completedAt: {
            gte: new Date("2026-07-24T15:55:00.000Z"),
          },
        }),
      }),
    );
  });

  it("rejects a still-live pre-cutover result without a server anchor marker", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      claimedAt: new Date("2026-07-24T16:00:20.000Z"),
      completedAt: new Date("2026-07-24T16:00:30.000Z"),
      result: {
        jobId: "job-pre-cutover",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T16:00:05.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee Times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      getFreshLocalReaderObservation({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 7,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore: new Date("2026-07-24T16:00:10.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("rejects delayed search evidence whose server lease began before the freshness boundary", async () => {
    const notBefore = new Date("2026-07-24T16:00:10.000Z");
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      claimedAt: new Date("2026-07-24T16:00:01.000Z"),
      completedAt: new Date("2026-07-24T16:00:20.000Z"),
      result: {
        jobId: "job-delayed-search",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T16:00:19.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Tee Times",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      getFreshLocalReaderObservation({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 7,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
        notBefore,
      }),
    ).resolves.toBeNull();
    expect(prismaMocks.localReaderJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          claimedAt: { gte: notBefore },
          completedAt: { gte: notBefore },
        }),
      }),
    );
  });

  it("rejects a legacy ahead-clock search result without a server anchor marker", async () => {
    prismaMocks.localReaderJob.findFirst.mockResolvedValue({
      claimedAt: new Date("2026-07-24T15:59:30.000Z"),
      completedAt: new Date("2026-07-24T16:00:00.000Z"),
      result: {
        jobId: "job-clock-ahead",
        courseKey: "cps:grassyhill.cps.golf",
        status: "NO_AVAILABILITY",
        observedAt: "2026-07-24T16:01:00.000Z",
        pageUrl: bookingUrl,
        pageTitle: "Grassy Hill Country Club",
        slots: [],
        readerVersion: "reader-v1",
      },
    });

    await expect(
      getFreshLocalReaderObservation({
        searchId: "search-1",
        courseId: "course-1",
        scheduleVersion: 7,
        targetDate: "2026-07-25",
        players: 2,
        bookingUrl,
      }),
    ).resolves.toBeNull();
  });
});
