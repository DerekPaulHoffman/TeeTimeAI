import { createHash, randomUUID } from "node:crypto";

import type { LocalReaderJob, Prisma } from "@prisma/client";

import { getCourseMonitoringEscalationDeadline } from "@/lib/automation/course-monitoring";
import {
  AUTOMATION_WORKERS,
  completeAutomationWorker,
  startAutomationWorker,
} from "@/lib/automation/worker-state";
import { prisma } from "@/lib/prisma";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import {
  localReaderCourseKeySchema,
  localReaderResultSchema,
  validateLocalReaderResultForJob,
  type LocalReaderResult,
} from "./contracts";
import {
  getLocalReaderCourse,
  getLocalReaderCourseKey,
  getLocalReaderJobUrl,
} from "./course-key";
import {
  LEGACY_READER_1_6_CAPABILITIES,
  getRequiredLocalReaderCapability,
  localReaderCapabilitiesSchema,
  readerSupportsCapability,
  type LocalReaderAgentHandshake,
} from "./capabilities";

export { getLocalReaderCourseKey } from "./course-key";

const JOB_LIFETIME_MS = 5 * 60_000;
const LEASE_LIFETIME_MS = 3 * 60_000;
const RESULT_LIFETIME_MS = 10 * 60_000;
const ALERT_READER_ATTEMPT_LIFETIME_MS = 5 * 60_000;

export async function expireOverdueLocalReaderJobs(now = new Date()) {
  const overdueJobs = await prisma.localReaderJob.findMany({
    where: {
      OR: [
        {
          status: { in: ["PENDING", "LEASED"] },
          jobExpiresAt: { lte: now },
        },
        {
          status: "EXPIRED",
          completedAt: null,
          jobExpiresAt: { lte: now },
        },
      ],
    },
    orderBy: { jobExpiresAt: "asc" },
    select: { id: true, status: true, jobExpiresAt: true },
    take: 100,
  });
  if (overdueJobs.length === 0) {
    return { considered: 0, expired: 0, notified: 0 };
  }

  const newlyOverdueIds = overdueJobs
    .filter((job) => job.status === "PENDING" || job.status === "LEASED")
    .map((job) => job.id);
  const expired = await prisma.localReaderJob.updateMany({
    where: {
      id: { in: newlyOverdueIds },
      status: { in: ["PENDING", "LEASED"] },
      jobExpiresAt: { lte: now },
    },
    data: {
      status: "EXPIRED",
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  await prisma.localReaderJob.updateMany({
    where: {
      id: { in: overdueJobs.map((job) => job.id) },
      status: "EXPIRED",
      completedAt: null,
    },
    data: { completedAt: now },
  });
  return {
    considered: overdueJobs.length,
    expired: expired.count,
    notified: 0,
  };
}

export type LocalReaderQueueDisposition =
  "ACTIVE" | "SUCCESS" | "TERMINAL" | "RETRYING_AFTER_TERMINAL_FAILURE";

const EXPIRED_READER_RESULT_STATUS = "EXPIRED" as const;

const SUCCESSFUL_READER_RESULTS = new Set<LocalReaderResult["status"]>([
  "AVAILABLE",
  "NO_AVAILABILITY",
]);

function readStoredReaderResultStatus(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = "status" in value ? value.status : null;
  return typeof status === "string" &&
    [
      "AVAILABLE",
      "NO_AVAILABILITY",
      "ACCESS_CHALLENGE",
      "PAGE_MISMATCH",
      "READER_ERROR",
    ].includes(status)
    ? (status as LocalReaderResult["status"])
    : null;
}

function getReusableReaderDisposition(job: {
  status: string;
  result: Prisma.JsonValue | null;
  jobExpiresAt: Date;
}, now = new Date()) {
  if (
    job.status === "EXPIRED" ||
    ((job.status === "PENDING" || job.status === "LEASED") &&
      job.jobExpiresAt <= now)
  ) {
    return {
      queueDisposition: "TERMINAL" as const,
      readerResultStatus: EXPIRED_READER_RESULT_STATUS,
    };
  }
  if (job.status !== "COMPLETED") {
    return {
      queueDisposition: "ACTIVE" as const,
      readerResultStatus: null,
    };
  }
  const readerResultStatus = readStoredReaderResultStatus(job.result);
  return {
    queueDisposition:
      readerResultStatus && SUCCESSFUL_READER_RESULTS.has(readerResultStatus)
        ? ("SUCCESS" as const)
        : ("TERMINAL" as const),
    readerResultStatus,
  };
}

function isCurrentCycleTerminalReaderJob(input: {
  job: Pick<
    LocalReaderJob,
    | "status"
    | "courseKey"
    | "requiredCapabilityKey"
    | "requiredParserVersion"
    | "createdAt"
    | "jobExpiresAt"
    | "completedAt"
    | "resultExpiresAt"
    | "result"
  >;
  courseKey: string;
  capabilityKey: string;
  parserVersion: number;
  cycleStartedAt?: Date;
  now: Date;
}) {
  if (
    !input.cycleStartedAt ||
    input.job.courseKey !== input.courseKey ||
    input.job.requiredCapabilityKey !== input.capabilityKey ||
    input.job.requiredParserVersion !== input.parserVersion ||
    input.job.createdAt < input.cycleStartedAt
  ) {
    return false;
  }
  if (
    input.job.status === "EXPIRED" ||
    ((input.job.status === "PENDING" || input.job.status === "LEASED") &&
      input.job.jobExpiresAt <= input.now)
  ) {
    return true;
  }
  if (
    input.job.status !== "COMPLETED" ||
    !input.job.completedAt ||
    input.job.completedAt < input.cycleStartedAt
  ) {
    return false;
  }
  const resultStatus = readStoredReaderResultStatus(input.job.result);
  return Boolean(
    resultStatus && !SUCCESSFUL_READER_RESULTS.has(resultStatus),
  );
}

async function resolveRequiredCapability(
  courseId: string,
  courseKey: ReturnType<typeof getLocalReaderCourseKey> & {},
) {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { name: true },
  });
  return getRequiredLocalReaderCapability(courseKey, course?.name);
}

function hasCurrentReaderLease(
  job: Pick<LocalReaderJob, "status" | "jobExpiresAt" | "leaseExpiresAt">,
  now: Date,
) {
  return (
    job.status === "LEASED" &&
    job.jobExpiresAt > now &&
    job.leaseExpiresAt !== null &&
    job.leaseExpiresAt > now
  );
}

function canReuseCourseVerification(input: {
  job: LocalReaderJob;
  courseKey: string;
  capabilityKey: string;
  parserVersion: number;
  freshnessCutoff: Date;
  cycleStartedAt?: Date;
  force: boolean;
  now: Date;
}) {
  if (
    !input.force &&
    isCurrentCycleTerminalReaderJob({
      job: input.job,
      courseKey: input.courseKey,
      capabilityKey: input.capabilityKey,
      parserVersion: input.parserVersion,
      cycleStartedAt: input.cycleStartedAt,
      now: input.now,
    })
  ) {
    return true;
  }
  if (hasCurrentReaderLease(input.job, input.now)) return true;
  if (
    input.job.courseKey !== input.courseKey ||
    input.job.requiredCapabilityKey !== input.capabilityKey ||
    input.job.requiredParserVersion !== input.parserVersion ||
    input.job.jobExpiresAt <= input.now ||
    input.job.createdAt < input.freshnessCutoff
  ) {
    return false;
  }
  if (input.job.status === "PENDING") return true;
  return (
    input.job.status === "COMPLETED" &&
    !input.force &&
    input.job.completedAt !== null &&
    input.job.completedAt >= input.freshnessCutoff &&
    input.job.resultExpiresAt !== null &&
    input.job.resultExpiresAt > input.now
  );
}

export async function queueLocalReaderCourseVerification(input: {
  courseId: string;
  targetDate: string;
  players: number;
  bookingUrl: string;
  force?: boolean;
  notBefore?: Date;
}) {
  const courseKey = getLocalReaderCourseKey(input.bookingUrl);
  if (!courseKey) return null;
  const requiredCapability = await resolveRequiredCapability(
    input.courseId,
    courseKey,
  );
  const now = new Date();
  const verificationKey = createHash("sha256")
    .update(
      [
        "local-reader-course-verification",
        input.courseId,
        input.targetDate,
        input.players,
      ].join("\n"),
    )
    .digest("hex");
  let existing = await prisma.localReaderJob.findUnique({
    where: { verificationKey },
  });
  const freshnessCutoff = input.notBefore ?? new Date(0);
  const bookingUrl = getLocalReaderJobUrl(
    courseKey,
    input.targetDate,
    input.players,
  );
  if (!existing) {
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
        bookingUrl,
        jobExpiresAt: new Date(now.getTime() + JOB_LIFETIME_MS),
        requiredCapabilityKey: requiredCapability.key,
        requiredParserVersion: requiredCapability.parserVersion,
      },
      update: {},
    });
  }

  for (
    let attempt = 0;
    attempt < READER_CLAIM_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    if (
      canReuseCourseVerification({
        job: existing,
        courseKey,
        capabilityKey: requiredCapability.key,
        parserVersion: requiredCapability.parserVersion,
        freshnessCutoff,
        cycleStartedAt: input.notBefore,
        force: input.force === true,
        now,
      })
    ) {
      return existing;
    }
    const jobExpiresAt = new Date(now.getTime() + JOB_LIFETIME_MS);
    const reset = await prisma.localReaderJob.updateMany({
      where: {
        id: existing.id,
        updatedAt: existing.updatedAt,
        status: existing.status,
        leaseToken: existing.leaseToken,
        leaseExpiresAt: existing.leaseExpiresAt,
      },
      data: {
        purpose: "COURSE_VERIFICATION",
        courseKey,
        bookingUrl,
        status: "PENDING",
        leaseToken: null,
        leaseExpiresAt: null,
        claimedAt: null,
        deviceId: null,
        createdAt: now,
        jobExpiresAt,
        result: undefined,
        resultExpiresAt: null,
        readerVersion: null,
        completedAt: null,
        requiredCapabilityKey: requiredCapability.key,
        requiredParserVersion: requiredCapability.parserVersion,
      },
    });
    if (reset.count === 1) {
      return {
        ...existing,
        purpose: "COURSE_VERIFICATION" as const,
        courseKey,
        bookingUrl,
        status: "PENDING" as const,
        leaseToken: null,
        leaseExpiresAt: null,
        claimedAt: null,
        deviceId: null,
        createdAt: now,
        updatedAt: now,
        jobExpiresAt,
        resultExpiresAt: null,
        readerVersion: null,
        completedAt: null,
        requiredCapabilityKey: requiredCapability.key,
        requiredParserVersion: requiredCapability.parserVersion,
      };
    }
    const latest = await prisma.localReaderJob.findUnique({
      where: { verificationKey },
    });
    if (!latest) return null;
    existing = latest;
  }
  throw new Error("The local reader verification job changed while retrying");
}

export async function queueLocalReaderJob(input: {
  searchId: string;
  courseId: string;
  scheduleVersion: number;
  targetDate: string;
  players: number;
  bookingUrl: string;
  notBefore?: Date;
}) {
  const courseKey = getLocalReaderCourseKey(input.bookingUrl);
  if (!courseKey) return null;
  const requiredCapability = await resolveRequiredCapability(
    input.courseId,
    courseKey,
  );
  const now = new Date();
  const freshnessCutoff = new Date(
    Math.max(
      now.getTime() - ALERT_READER_ATTEMPT_LIFETIME_MS,
      input.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY,
    ),
  );
  const reusableAcrossScheduleVersions = await prisma.localReaderJob.findFirst({
    where: {
      teeSearchId: input.searchId,
      courseId: input.courseId,
      courseKey,
      targetDate: input.targetDate,
      players: input.players,
      requiredCapabilityKey: requiredCapability.key,
      requiredParserVersion: requiredCapability.parserVersion,
      OR: [
        {
          status: "PENDING",
          createdAt: { gte: freshnessCutoff },
          jobExpiresAt: { gt: now },
        },
        {
          status: "LEASED",
          createdAt: { gte: freshnessCutoff },
          jobExpiresAt: { gt: now },
          leaseExpiresAt: { gt: now },
        },
        {
          status: "COMPLETED",
          createdAt: { gte: freshnessCutoff },
          completedAt: { gte: freshnessCutoff },
          resultExpiresAt: { gt: now },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (reusableAcrossScheduleVersions) {
    return {
      ...reusableAcrossScheduleVersions,
      ...getReusableReaderDisposition(reusableAcrossScheduleVersions),
    };
  }
  const terminalAcrossScheduleVersions = input.notBefore
    ? await prisma.localReaderJob.findFirst({
        where: {
          teeSearchId: input.searchId,
          courseId: input.courseId,
          courseKey,
          targetDate: input.targetDate,
          players: input.players,
          requiredCapabilityKey: requiredCapability.key,
          requiredParserVersion: requiredCapability.parserVersion,
          createdAt: { gte: input.notBefore },
          OR: [
            { status: "EXPIRED" },
            {
              status: { in: ["PENDING", "LEASED"] },
              jobExpiresAt: { lte: now },
            },
            {
              status: "COMPLETED",
              completedAt: { gte: input.notBefore },
            },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    : null;
  if (
    terminalAcrossScheduleVersions &&
    isCurrentCycleTerminalReaderJob({
      job: terminalAcrossScheduleVersions,
      courseKey,
      capabilityKey: requiredCapability.key,
      parserVersion: requiredCapability.parserVersion,
      cycleStartedAt: input.notBefore,
      now,
    })
  ) {
    return {
      ...terminalAcrossScheduleVersions,
      ...getReusableReaderDisposition(terminalAcrossScheduleVersions, now),
    };
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
    isCurrentCycleTerminalReaderJob({
      job: existing,
      courseKey,
      capabilityKey: requiredCapability.key,
      parserVersion: requiredCapability.parserVersion,
      cycleStartedAt: input.notBefore,
      now,
    })
  ) {
    return {
      ...existing,
      ...getReusableReaderDisposition(existing, now),
    };
  }
  if (
    existing &&
    existing.jobExpiresAt > now &&
    ((existing.status === "PENDING" &&
      existing.courseKey === courseKey &&
      existing.requiredCapabilityKey === requiredCapability.key &&
      existing.requiredParserVersion === requiredCapability.parserVersion &&
      existing.createdAt >= freshnessCutoff) ||
      (existing.status === "LEASED" &&
        existing.courseKey === courseKey &&
        existing.requiredCapabilityKey === requiredCapability.key &&
        existing.requiredParserVersion === requiredCapability.parserVersion &&
        existing.createdAt >= freshnessCutoff &&
        existing.leaseExpiresAt !== null &&
        existing.leaseExpiresAt > now) ||
      (existing.status === "COMPLETED" &&
        existing.courseKey === courseKey &&
        existing.requiredCapabilityKey === requiredCapability.key &&
        existing.requiredParserVersion === requiredCapability.parserVersion &&
        existing.completedAt !== null &&
        existing.completedAt >= freshnessCutoff &&
        existing.resultExpiresAt !== null &&
        existing.resultExpiresAt > now))
  ) {
    return {
      ...existing,
      ...getReusableReaderDisposition(existing),
    };
  }
  const retryingAfterTerminalFailure =
    existing !== null &&
    (existing.status === "FAILED" ||
      existing.status === "EXPIRED" ||
      (existing.status === "LEASED" &&
        (existing.leaseExpiresAt === null || existing.leaseExpiresAt <= now)) ||
      ((existing.status === "PENDING" || existing.status === "LEASED") &&
        (existing.createdAt < freshnessCutoff ||
          existing.jobExpiresAt <= now)));
  const job = await prisma.localReaderJob.upsert({
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
      bookingUrl: getLocalReaderJobUrl(
        courseKey,
        input.targetDate,
        input.players,
      ),
      jobExpiresAt: new Date(now.getTime() + JOB_LIFETIME_MS),
      requiredCapabilityKey: requiredCapability.key,
      requiredParserVersion: requiredCapability.parserVersion,
    },
    update: {
      courseKey,
      bookingUrl: getLocalReaderJobUrl(
        courseKey,
        input.targetDate,
        input.players,
      ),
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
      requiredCapabilityKey: requiredCapability.key,
      requiredParserVersion: requiredCapability.parserVersion,
    },
  });
  return {
    ...job,
    queueDisposition: retryingAfterTerminalFailure
      ? ("RETRYING_AFTER_TERMINAL_FAILURE" as const)
      : ("ACTIVE" as const),
    readerResultStatus: null,
  };
}

const MAX_GLOBAL_ACTIVE_READER_JOBS = 2;
const READER_CLAIM_TRANSACTION_ATTEMPTS = 3;
const READER_CLAIM_BATCH_SIZE = 50;
const ACTIVE_REAL_CUSTOMER_READER_JOB_WHERE = {
  purpose: "ALERT_CHECK",
  teeSearch: {
    is: {
      status: "ACTIVE",
      trafficClass: { notIn: ["AUTOMATION", "TEST"] },
    },
  },
} satisfies Prisma.LocalReaderJobWhereInput;
const READER_CLAIM_ORDER = [
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.LocalReaderJobOrderByWithRelationInput[];

function getReaderProviderFamily(job: {
  courseKey: string;
  requiredCapabilityKey: string | null;
}) {
  const capability = job.requiredCapabilityKey?.replace(/_RENDERED.*$/u, "");
  if (capability) return capability;
  const separator = job.courseKey.indexOf(":");
  return separator > 0
    ? job.courseKey.slice(0, separator).toUpperCase()
    : "LEGACY_PROPHET";
}

function isRetryableReaderClaimConflict(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2034",
  );
}

function pickReaderCandidate(
  candidates: LocalReaderJob[],
  activeFamilies: Set<string>,
) {
  return candidates
    .sort((left, right) => {
      const purposeDifference =
        (left.purpose === "ALERT_CHECK" ? 0 : 1) -
        (right.purpose === "ALERT_CHECK" ? 0 : 1);
      if (purposeDifference) return purposeDifference;
      const createdAtDifference =
        left.createdAt.getTime() - right.createdAt.getTime();
      return createdAtDifference || left.id.localeCompare(right.id);
    })
    .find((job) => !activeFamilies.has(getReaderProviderFamily(job)));
}

async function findActiveCustomerReaderCandidate(input: {
  transaction: Prisma.TransactionClient;
  claimableWhere: Prisma.LocalReaderJobWhereInput;
  activeFamilies: Set<string>;
}): Promise<LocalReaderJob | null> {
  let cursorId: string | null = null;
  for (;;) {
    const candidates: LocalReaderJob[] =
      await input.transaction.localReaderJob.findMany({
      where: {
        ...input.claimableWhere,
        ...ACTIVE_REAL_CUSTOMER_READER_JOB_WHERE,
      },
      orderBy: READER_CLAIM_ORDER,
      take: READER_CLAIM_BATCH_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    const candidate = pickReaderCandidate(candidates, input.activeFamilies);
    if (candidate) return candidate;
    if (candidates.length < READER_CLAIM_BATCH_SIZE) return null;
    cursorId = candidates.at(-1)?.id ?? null;
    if (!cursorId) return null;
  }
}

async function claimReaderCandidate(
  handshake: LocalReaderAgentHandshake,
  now: Date,
) {
  for (
    let attempt = 1;
    attempt <= READER_CLAIM_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          const activeJobs = await transaction.localReaderJob.findMany({
            where: {
              status: "LEASED",
              jobExpiresAt: { gt: now },
              leaseExpiresAt: { gt: now },
            },
            select: {
              id: true,
              courseKey: true,
              requiredCapabilityKey: true,
            },
          });
          if (activeJobs.length >= MAX_GLOBAL_ACTIVE_READER_JOBS) return null;

          const activeFamilies = new Set(
            activeJobs.map(getReaderProviderFamily),
          );
          const claimableWhere = {
            jobExpiresAt: { gt: now },
            AND: [
              {
                OR: [
                  { status: "PENDING" },
                  { status: "LEASED", leaseExpiresAt: { lte: now } },
                ],
              },
              {
                OR: [
                  {
                    requiredCapabilityKey: null,
                    requiredParserVersion: null,
                  },
                  ...handshake.capabilities.map((capability) => ({
                    requiredCapabilityKey: capability.key,
                    requiredParserVersion: { lte: capability.parserVersion },
                  })),
                ],
              },
            ],
          } satisfies Prisma.LocalReaderJobWhereInput;
          let candidate = await findActiveCustomerReaderCandidate({
            transaction,
            claimableWhere,
            activeFamilies,
          });
          if (!candidate) {
            const backgroundCandidates =
              await transaction.localReaderJob.findMany({
                where: {
                  ...claimableWhere,
                  NOT: ACTIVE_REAL_CUSTOMER_READER_JOB_WHERE,
                },
                orderBy: READER_CLAIM_ORDER,
                take: READER_CLAIM_BATCH_SIZE,
              });
            candidate =
              pickReaderCandidate(backgroundCandidates, activeFamilies) ?? null;
          }
          if (!candidate) return null;

          const leaseToken = randomUUID();
          const leaseExpiresAt = new Date(
            Math.min(
              candidate.jobExpiresAt.getTime(),
              now.getTime() + LEASE_LIFETIME_MS,
            ),
          );
          const claimed = await transaction.localReaderJob.updateMany({
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
              deviceId: handshake.deviceId,
            },
          });
          return claimed.count === 1
            ? { candidate, leaseToken, leaseExpiresAt }
            : null;
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (
        !isRetryableReaderClaimConflict(error) ||
        attempt === READER_CLAIM_TRANSACTION_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  return null;
}

export async function claimNextLocalReaderJob(
  input: string | LocalReaderAgentHandshake,
) {
  const handshake = normalizeReaderHandshake(input);
  const now = new Date();
  if (!(await recordReaderHeartbeat(handshake, now))) return null;
  const claimed = await claimReaderCandidate(handshake, now);
  if (!claimed) return null;
  const { candidate, leaseToken, leaseExpiresAt } = claimed;
  const courseKey = localReaderCourseKeySchema.parse(candidate.courseKey);
  const course = await prisma.course.findUnique({
    where: { id: candidate.courseId },
    select: { name: true },
  });
  const readerCourse = getLocalReaderCourse(courseKey, course?.name);
  if (!readerCourse) {
    throw new Error("The local reader course is no longer available");
  }
  return {
    id: candidate.id,
    courseKey,
    targetDate: candidate.targetDate,
    players: candidate.players,
    requestedAt: candidate.createdAt.toISOString(),
    expiresAt: candidate.jobExpiresAt.toISOString(),
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    courseName: readerCourse.courseName,
    bookingUrl: candidate.bookingUrl,
    cardTextIncludes: [...readerCourse.cardTextIncludes],
    requiredCapability: {
      key:
        candidate.requiredCapabilityKey ??
        getRequiredLocalReaderCapability(courseKey, course?.name).key,
      parserVersion:
        candidate.requiredParserVersion ??
        getRequiredLocalReaderCapability(courseKey, course?.name).parserVersion,
    },
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
  const completedAt = new Date();
  if (
    !current ||
    current.status !== "LEASED" ||
    current.leaseToken !== input.leaseToken ||
    !current.leaseExpiresAt ||
    current.leaseExpiresAt <= completedAt ||
    current.jobExpiresAt <= completedAt
  ) {
    throw new Error("The local reader lease is no longer valid");
  }
  const courseKey = localReaderCourseKeySchema.parse(current.courseKey);
  const course = await prisma.course.findUnique({
    where: { id: current.courseId },
    select: { name: true },
  });
  const readerCourse = getLocalReaderCourse(courseKey, course?.name);
  if (!readerCourse) {
    throw new Error("The local reader course is no longer available");
  }
  validateLocalReaderResultForJob(
    {
      id: current.id,
      courseKey,
      targetDate: current.targetDate,
      players: current.players,
      requestedAt: current.createdAt.toISOString(),
      expiresAt: current.jobExpiresAt.toISOString(),
      courseName: readerCourse.courseName,
      bookingUrl: current.bookingUrl,
      cardTextIncludes: [...readerCourse.cardTextIncludes],
      requiredCapability: {
        key:
          current.requiredCapabilityKey ??
          getRequiredLocalReaderCapability(courseKey, course?.name).key,
        parserVersion:
          current.requiredParserVersion ??
          getRequiredLocalReaderCapability(courseKey, course?.name)
            .parserVersion,
      },
    },
    input.result,
  );
  const updated = await prisma.localReaderJob.updateMany({
    where: {
      id: current.id,
      status: "LEASED",
      leaseToken: input.leaseToken,
      leaseExpiresAt: { gt: completedAt },
      jobExpiresAt: { gt: completedAt },
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
  await recordReaderSuccess({
    deviceId: current.deviceId,
    readerVersion: input.result.readerVersion,
    capability:
      current.requiredCapabilityKey ??
      getRequiredLocalReaderCapability(courseKey, course?.name).key,
    now: completedAt,
  });

  // Detached verification jobs are not incident-cycle bound. Their ordered
  // consumer owns monitoring reconciliation after validating stage freshness.
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
  }
  return { searchId: current.teeSearchId, completedAt };
}

function normalizeReaderHandshake(
  input: string | LocalReaderAgentHandshake,
): LocalReaderAgentHandshake {
  if (typeof input === "string") {
    return {
      deviceId: input,
      readerVersion: "1.6.0",
      buildId: "legacy-1.6.0",
      capabilities: LEGACY_READER_1_6_CAPABILITIES,
    };
  }
  return {
    deviceId: input.deviceId,
    readerVersion: input.readerVersion.trim().slice(0, 64),
    buildId: input.buildId.trim().slice(0, 100),
    capabilities: localReaderCapabilitiesSchema.parse(input.capabilities),
  };
}

async function recordReaderHeartbeat(
  handshake: LocalReaderAgentHandshake,
  now: Date,
) {
  const worker = await startAutomationWorker(AUTOMATION_WORKERS.LOCAL_READER, {
    runnerVersion: handshake.readerVersion,
    now,
  });
  if (!worker.allowed) return false;
  const model = (
    prisma as typeof prisma & {
      localReaderAgent?: {
        findUnique: (input: unknown) => Promise<{
          readerVersion: string;
          buildId: string;
          capabilities: Prisma.JsonValue;
        } | null>;
        upsert: (input: unknown) => Promise<unknown>;
      };
    }
  ).localReaderAgent;
  if (!model) {
    await completeAutomationWorker(
      AUTOMATION_WORKERS.LOCAL_READER,
      "reader_heartbeat",
      now,
    );
    return true;
  }
  const previous = await model.findUnique({
    where: { deviceId: handshake.deviceId },
    select: {
      readerVersion: true,
      buildId: true,
      capabilities: true,
    },
  });
  await model.upsert({
    where: { deviceId: handshake.deviceId },
    create: {
      deviceId: handshake.deviceId,
      readerVersion: handshake.readerVersion,
      buildId: handshake.buildId,
      capabilities: handshake.capabilities as Prisma.InputJsonValue,
      lastSeenAt: now,
    },
    update: {
      readerVersion: handshake.readerVersion,
      buildId: handshake.buildId,
      capabilities: handshake.capabilities as Prisma.InputJsonValue,
      lastSeenAt: now,
    },
  });
  const previousCapabilities = previous
    ? localReaderCapabilitiesSchema.safeParse(previous.capabilities)
    : null;
  const readerDeploymentChanged =
    !previous ||
    previous.readerVersion !== handshake.readerVersion ||
    previous.buildId !== handshake.buildId;
  if (
    !readerDeploymentChanged &&
    previousCapabilities?.success &&
    haveSameCapabilities(previousCapabilities.data, handshake.capabilities)
  ) {
    await completeAutomationWorker(
      AUTOMATION_WORKERS.LOCAL_READER,
      "reader_heartbeat",
      now,
    );
    return true;
  }
  await requeueReaderBlockedIncidents({
    capabilities: handshake.capabilities,
    previousCapabilities: previousCapabilities?.success
      ? previousCapabilities.data
      : null,
    readerDeploymentChanged,
    readerVersion: handshake.readerVersion,
    buildId: handshake.buildId,
    now,
  });
  await completeAutomationWorker(
    AUTOMATION_WORKERS.LOCAL_READER,
    "reader_heartbeat",
    now,
  );
  return true;
}

function haveSameCapabilities(
  left: LocalReaderAgentHandshake["capabilities"],
  right: LocalReaderAgentHandshake["capabilities"],
) {
  if (left.length !== right.length) return false;
  return left.every((capability) =>
    right.some(
      (candidate) =>
        candidate.key === capability.key &&
        candidate.parserVersion === capability.parserVersion,
    ),
  );
}

async function recordReaderSuccess(input: {
  deviceId: string | null;
  readerVersion: string;
  capability: string;
  now: Date;
}) {
  if (!input.deviceId) return;
  const model = (
    prisma as typeof prisma & {
      localReaderAgent?: {
        updateMany: (input: unknown) => Promise<unknown>;
      };
    }
  ).localReaderAgent;
  if (!model) return;
  await model.updateMany({
    where: { deviceId: input.deviceId },
    data: {
      readerVersion: input.readerVersion,
      lastSeenAt: input.now,
      lastSuccessfulAt: input.now,
      lastSuccessfulCapability: input.capability,
    },
  });
}

async function requeueReaderBlockedIncidents(input: {
  capabilities: LocalReaderAgentHandshake["capabilities"];
  previousCapabilities: LocalReaderAgentHandshake["capabilities"] | null;
  readerDeploymentChanged: boolean;
  readerVersion: string;
  buildId: string;
  now: Date;
}) {
  const incidents = await prisma.courseSupportIncident.findMany({
    where: {
      status: "NEEDS_HUMAN",
      humanReviewReason: "READER_RELOAD_REQUIRED",
      activeBatchId: null,
    },
    select: {
      id: true,
      cycle: true,
      revision: true,
      courseId: true,
      activeRealSearchCount: true,
      course: {
        select: {
          name: true,
          detectedBookingUrl: true,
          website: true,
          monitoringStatus: {
            select: { revision: true },
          },
        },
      },
    },
  });
  for (const incident of incidents) {
    const courseKey = getLocalReaderCourseKey(
      incident.course.detectedBookingUrl ?? incident.course.website,
    );
    if (!courseKey) continue;
    const required = getRequiredLocalReaderCapability(
      courseKey,
      incident.course.name,
    );
    if (
      !readerSupportsCapability(
        input.capabilities,
        required.key,
        required.parserVersion,
      )
    ) {
      continue;
    }
    if (
      !input.readerDeploymentChanged &&
      input.previousCapabilities &&
      readerSupportsCapability(
        input.previousCapabilities,
        required.key,
        required.parserVersion,
      )
    ) {
      continue;
    }
    await prisma.$transaction(async (transaction) => {
      const incidentUpdated =
        await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            revision: incident.revision,
            status: "NEEDS_HUMAN",
            activeBatchId: null,
          },
          data: {
            cycle: { increment: 1 },
            status: "AUTO_INVESTIGATING",
            humanReviewReason: null,
            nextReminderAt: null,
            nextAttemptAt: input.now,
            confirmedAt: input.now,
            escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
              input.now,
              incident.activeRealSearchCount,
            ),
            latestMessage:
              "A compatible signed local reader is online; exact public-page revalidation was requeued.",
            revision: { increment: 1 },
          },
        });
      if (incidentUpdated.count !== 1) return;
      if (incident.course.monitoringStatus) {
        await transaction.courseMonitoringStatus.updateMany({
          where: {
            courseId: incident.courseId,
            revision: incident.course.monitoringStatus.revision,
          },
          data: {
            state: "AUTO_INVESTIGATING",
            nextAutomaticAttemptAt: input.now,
            revalidationRequestedAt: input.now,
            stateChangedAt: input.now,
            revision: { increment: 1 },
          },
        });
      }
      await transaction.teeSearch.updateMany({
        where: {
          status: "ACTIVE",
          preferences: { some: { courseId: incident.courseId } },
        },
        data: {
          nextCheckAt: input.now,
          recheckRequestedAt: input.now,
        },
      });
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: incident.courseId,
          incidentId: incident.id,
          eventType: "REVALIDATION_REQUESTED",
          source: "LOCAL_READER",
          fromState: "ENGINEERING_VERIFICATION_NEEDED",
          toState: "AUTO_INVESTIGATING",
          readPath: required.key,
          message:
            "A compatible reader capability came online, so exact runtime verification was requeued.",
          occurredAt: input.now,
          audit: {
            priorCycle: incident.cycle,
            cycle: incident.cycle + 1,
            parserVersion: required.parserVersion,
            readerVersion: input.readerVersion,
            buildId: input.buildId,
            customerDataIncluded: false,
          },
        },
      });
    });
  }
}

export async function getFreshLocalReaderTeeSheet(input: {
  searchId: string;
  courseId: string;
  targetDate: string;
  players: number;
  bookingUrl: string;
  notBefore?: Date;
}) {
  return (await getFreshLocalReaderObservation(input))?.teeSheet ?? null;
}

export async function getFreshLocalReaderObservation(input: {
  searchId: string;
  courseId: string;
  targetDate: string;
  players: number;
  bookingUrl: string;
  notBefore?: Date;
}) {
  const courseKey = getLocalReaderCourseKey(input.bookingUrl);
  if (!courseKey) return null;
  const requiredCapability = await resolveRequiredCapability(
    input.courseId,
    courseKey,
  );
  const row = await prisma.localReaderJob.findFirst({
    where: {
      teeSearchId: input.searchId,
      courseId: input.courseId,
      courseKey,
      targetDate: input.targetDate,
      players: input.players,
      status: "COMPLETED",
      requiredCapabilityKey: requiredCapability.key,
      requiredParserVersion: requiredCapability.parserVersion,
      ...(input.notBefore
        ? {
            createdAt: { gte: input.notBefore },
            completedAt: { gte: input.notBefore },
          }
        : {}),
      resultExpiresAt: { gt: new Date() },
    },
    orderBy: { completedAt: "desc" },
  });
  if (!row?.result) return null;
  const result = localReaderResultSchema.parse(row.result);
  return {
    status: result.status,
    observedAt: new Date(result.observedAt),
    readerVersion: result.readerVersion,
    teeSheet:
      result.status === "AVAILABLE" || result.status === "NO_AVAILABILITY"
        ? {
            slots: buildLocalReaderSlots(input.courseId, result),
            targetDateStatus:
              result.status === "AVAILABLE"
                ? ("OPEN" as const)
                : ("UNKNOWN" as const),
            bookingWindowEvidence: null,
            readerVersion: result.readerVersion,
          }
        : null,
  };
}

export async function getLocalReaderCourseVerification(input: {
  courseId: string;
  targetDate: string;
  players: number;
  bookingUrl: string;
  notBefore: Date;
}) {
  const courseKey = getLocalReaderCourseKey(input.bookingUrl);
  if (!courseKey) return null;
  const requiredCapability = await resolveRequiredCapability(
    input.courseId,
    courseKey,
  );
  const now = new Date();
  const row = await prisma.localReaderJob.findFirst({
    where: {
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: input.courseId,
      courseKey,
      targetDate: input.targetDate,
      players: input.players,
      requiredCapabilityKey: requiredCapability.key,
      requiredParserVersion: requiredCapability.parserVersion,
      status: { in: ["PENDING", "LEASED", "COMPLETED", "EXPIRED"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  if (
    row.createdAt >= input.notBefore &&
    (row.status === "EXPIRED" ||
      ((row.status === "PENDING" || row.status === "LEASED") &&
        row.jobExpiresAt <= now))
  ) {
    return {
      status: "TERMINAL" as const,
      observedAt: row.jobExpiresAt,
      readerVersion: null,
      resultStatus: EXPIRED_READER_RESULT_STATUS,
    };
  }
  if (
    (row.status === "PENDING" || row.status === "LEASED") &&
    row.jobExpiresAt > now &&
    row.createdAt >= input.notBefore
  ) {
    return { status: "PENDING" as const };
  }
  if (
    row.status !== "COMPLETED" ||
    !row.result ||
    !row.resultExpiresAt ||
    row.resultExpiresAt <= now
  ) {
    return null;
  }
  const result = localReaderResultSchema.parse(row.result);
  const observedAt = new Date(result.observedAt);
  if (observedAt < input.notBefore) return null;
  if (result.status !== "AVAILABLE" && result.status !== "NO_AVAILABILITY") {
    return {
      status: "TERMINAL" as const,
      observedAt,
      readerVersion: result.readerVersion,
      resultStatus: result.status,
    };
  }
  return {
    status: "COMPLETED" as const,
    observedAt,
    readerVersion: result.readerVersion,
    slots: buildLocalReaderSlots(input.courseId, result),
  };
}

function buildLocalReaderSlots(
  courseId: string,
  result: LocalReaderResult,
): TeeTimeSlot[] {
  return result.slots.map((slot) => {
    const holes = slot.holes.includes(18) ? 18 : slot.holes[0];
    return {
      sourceId: `local-${result.courseKey}-${slot.startsAtLocal}`,
      courseId,
      startsAt: slot.startsAtLocal,
      availableSpots: slot.availableSpots,
      bookingUrl: result.pageUrl,
      ...(slot.priceCents === null ? {} : { priceCents: slot.priceCents }),
      holes,
      bookableHoleCounts: slot.holes,
    };
  });
}
