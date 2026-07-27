import { createHash, randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { prisma } from "@/lib/prisma";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import {
  LOCAL_READER_COURSES,
  localReaderCourseKeySchema,
  localReaderResultSchema,
  validateLocalReaderResultForJob,
  type LocalReaderResult,
} from "./contracts";
import { getLocalReaderCourseKey, getLocalReaderJobUrl } from "./course-key";

export { getLocalReaderCourseKey } from "./course-key";

const JOB_LIFETIME_MS = 30 * 60_000;
const LEASE_LIFETIME_MS = 3 * 60_000;
const RESULT_LIFETIME_MS = 10 * 60_000;

export async function queueLocalReaderCourseVerification(input: {
  courseId: string;
  targetDate: string;
  players: number;
  bookingUrl: string;
}) {
  const courseKey = getLocalReaderCourseKey(input.bookingUrl);
  if (!courseKey) return null;
  const now = new Date();
  const verificationKey = createHash("sha256")
    .update(
      [
        "local-reader-course-verification",
        input.courseId,
        input.targetDate,
        input.players
      ].join("\n")
    )
    .digest("hex");
  const existing = await prisma.localReaderJob.findUnique({
    where: { verificationKey }
  });
  if (
    existing &&
    existing.jobExpiresAt > now &&
    (existing.status === "PENDING" ||
      (existing.status === "LEASED" &&
        existing.leaseExpiresAt !== null &&
        existing.leaseExpiresAt > now) ||
      existing.status === "COMPLETED")
  ) {
    return existing;
  }
  return prisma.localReaderJob.upsert({
    where: { verificationKey },
    create: {
      teeSearchId: null,
      courseId: input.courseId,
      scheduleVersion: null,
      purpose: "COURSE_VERIFICATION",
      verificationKey,
      courseKey,
      targetDate: input.targetDate,
      players: input.players,
      bookingUrl: getLocalReaderJobUrl(courseKey, input.targetDate),
      jobExpiresAt: new Date(now.getTime() + JOB_LIFETIME_MS)
    },
    update: {
      purpose: "COURSE_VERIFICATION",
      courseKey,
      bookingUrl: getLocalReaderJobUrl(courseKey, input.targetDate),
      status: "PENDING",
      leaseToken: null,
      leaseExpiresAt: null,
      claimedAt: null,
      deviceId: null,
      jobExpiresAt: new Date(now.getTime() + JOB_LIFETIME_MS),
      result: undefined,
      resultExpiresAt: null,
      readerVersion: null,
      completedAt: null
    }
  });
}

export async function queueLocalReaderJob(input: {
  searchId: string;
  courseId: string;
  scheduleVersion: number;
  targetDate: string;
  players: number;
  bookingUrl: string;
}) {
  const courseKey = getLocalReaderCourseKey(input.bookingUrl);
  if (!courseKey) return null;
  const now = new Date();
  const reusableAcrossScheduleVersions = await prisma.localReaderJob.findFirst({
    where: {
      teeSearchId: input.searchId,
      courseId: input.courseId,
      targetDate: input.targetDate,
      players: input.players,
      OR: [
        {
          status: "PENDING",
          jobExpiresAt: { gt: now },
        },
        {
          status: "LEASED",
          jobExpiresAt: { gt: now },
          leaseExpiresAt: { gt: now },
        },
        {
          status: "COMPLETED",
          resultExpiresAt: { gt: now },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (reusableAcrossScheduleVersions) {
    return reusableAcrossScheduleVersions;
  }
  const unique = {
    teeSearchId: input.searchId,
    courseId: input.courseId,
    scheduleVersion: input.scheduleVersion,
    targetDate: input.targetDate,
    players: input.players,
  };
  const existing = await prisma.localReaderJob.findUnique({
    where: {
      teeSearchId_courseId_scheduleVersion_targetDate_players: unique,
    },
  });
  if (
    existing &&
    existing.jobExpiresAt > now &&
    (existing.status === "PENDING" ||
      (existing.status === "LEASED" &&
        existing.leaseExpiresAt !== null &&
        existing.leaseExpiresAt > now) ||
      (existing.status === "COMPLETED" &&
        existing.resultExpiresAt !== null &&
        existing.resultExpiresAt > now))
  ) {
    return existing;
  }
  return prisma.localReaderJob.upsert({
    where: {
      teeSearchId_courseId_scheduleVersion_targetDate_players: unique,
    },
    create: {
      teeSearchId: input.searchId,
      courseId: input.courseId,
      scheduleVersion: input.scheduleVersion,
      courseKey,
      targetDate: input.targetDate,
      players: input.players,
      bookingUrl: getLocalReaderJobUrl(courseKey, input.targetDate),
      jobExpiresAt: new Date(now.getTime() + JOB_LIFETIME_MS),
    },
    update: {
      courseKey,
      bookingUrl: getLocalReaderJobUrl(courseKey, input.targetDate),
      status: "PENDING",
      leaseToken: null,
      leaseExpiresAt: null,
      claimedAt: null,
      deviceId: null,
      jobExpiresAt: new Date(now.getTime() + JOB_LIFETIME_MS),
      result: undefined,
      resultExpiresAt: null,
      readerVersion: null,
      completedAt: null,
    },
  });
}

export async function claimNextLocalReaderJob(deviceId: string) {
  const now = new Date();
  await prisma.localReaderJob.updateMany({
    where: {
      status: { in: ["PENDING", "LEASED"] },
      jobExpiresAt: { lte: now },
    },
    data: { status: "EXPIRED", leaseToken: null, leaseExpiresAt: null },
  });
  const candidate = await prisma.localReaderJob.findFirst({
    where: {
      jobExpiresAt: { gt: now },
      OR: [
        { status: "PENDING" },
        { status: "LEASED", leaseExpiresAt: { lte: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_LIFETIME_MS);
  const claimed = await prisma.localReaderJob.updateMany({
    where: {
      id: candidate.id,
      jobExpiresAt: { gt: now },
      OR: [
        { status: "PENDING" },
        { status: "LEASED", leaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      status: "LEASED",
      leaseToken,
      leaseExpiresAt,
      claimedAt: now,
      deviceId,
    },
  });
  if (claimed.count !== 1) return null;
  const courseKey = localReaderCourseKeySchema.parse(candidate.courseKey);
  return {
    id: candidate.id,
    courseKey,
    targetDate: candidate.targetDate,
    players: candidate.players,
    requestedAt: candidate.createdAt.toISOString(),
    expiresAt: candidate.jobExpiresAt.toISOString(),
    courseName: LOCAL_READER_COURSES[courseKey].courseName,
    bookingUrl: candidate.bookingUrl,
    cardTextIncludes: [...LOCAL_READER_COURSES[courseKey].cardTextIncludes],
    leaseToken,
  };
}

export async function completeLocalReaderJob(input: {
  jobId: string;
  leaseToken: string;
  result: LocalReaderResult;
}) {
  const current = await prisma.localReaderJob.findUnique({
    where: { id: input.jobId },
  });
  if (
    !current ||
    current.status !== "LEASED" ||
    current.leaseToken !== input.leaseToken ||
    !current.leaseExpiresAt ||
    current.leaseExpiresAt <= new Date()
  ) {
    throw new Error("The local reader lease is no longer valid");
  }
  const courseKey = localReaderCourseKeySchema.parse(current.courseKey);
  validateLocalReaderResultForJob(
    {
      id: current.id,
      courseKey,
      targetDate: current.targetDate,
      players: current.players,
      requestedAt: current.createdAt.toISOString(),
      expiresAt: current.jobExpiresAt.toISOString(),
      courseName: LOCAL_READER_COURSES[courseKey].courseName,
      bookingUrl: current.bookingUrl,
      cardTextIncludes: [...LOCAL_READER_COURSES[courseKey].cardTextIncludes],
    },
    input.result,
  );
  const completedAt = new Date();
  const updated = await prisma.localReaderJob.updateMany({
    where: {
      id: current.id,
      status: "LEASED",
      leaseToken: input.leaseToken,
      leaseExpiresAt: { gt: completedAt },
    },
    data: {
      status: "COMPLETED",
      result: input.result as Prisma.InputJsonValue,
      resultExpiresAt: new Date(completedAt.getTime() + RESULT_LIFETIME_MS),
      readerVersion: input.result.readerVersion,
      completedAt,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (updated.count !== 1) throw new Error("The local reader lease changed");

  if (current.teeSearchId) {
    await prisma.localReaderJob.updateMany({
      where: {
        id: { not: current.id },
        teeSearchId: current.teeSearchId,
        courseId: current.courseId,
        targetDate: current.targetDate,
        players: current.players,
        status: "PENDING",
      },
      data: {
        status: "EXPIRED",
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    try {
      await startSearchSchedule(current.teeSearchId);
    } catch (error) {
      console.error("[local-reader:search-schedule-start-failed]", {
        message:
          error instanceof Error ? error.message : "Unknown scheduling error"
      });
    }
  }
  return { searchId: current.teeSearchId, completedAt };
}

export async function getFreshLocalReaderTeeSheet(input: {
  searchId: string;
  courseId: string;
  scheduleVersion: number;
  targetDate: string;
  players: number;
}) {
  const row = await prisma.localReaderJob.findFirst({
    where: {
      teeSearchId: input.searchId,
      courseId: input.courseId,
      targetDate: input.targetDate,
      players: input.players,
      status: "COMPLETED",
      resultExpiresAt: { gt: new Date() },
    },
    orderBy: { completedAt: "desc" },
  });
  if (!row?.result) return null;
  const result = localReaderResultSchema.parse(row.result);
  if (result.status !== "AVAILABLE" && result.status !== "NO_AVAILABILITY") {
    return null;
  }
  const slots: TeeTimeSlot[] = result.slots.map((slot) => {
    const holes = slot.holes.includes(18) ? 18 : slot.holes[0];
    return {
      sourceId: `local-${result.courseKey}-${slot.startsAtLocal}`,
      courseId: input.courseId,
      startsAt: slot.startsAtLocal,
      availableSpots: slot.availableSpots,
      bookingUrl: result.pageUrl,
      ...(slot.priceCents === null ? {} : { priceCents: slot.priceCents }),
      holes,
      bookableHoleCounts: slot.holes,
    };
  });
  return {
    slots,
    targetDateStatus:
      result.status === "AVAILABLE" ? ("OPEN" as const) : ("UNKNOWN" as const),
    bookingWindowEvidence: null,
    readerVersion: result.readerVersion,
  };
}
