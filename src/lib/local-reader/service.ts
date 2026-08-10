import { createHash, randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import {
  getCourseMonitoringEscalationDeadline,
  recordCourseMonitoringSuccess
} from "@/lib/automation/course-monitoring";
import { resolveCourseSupportIncident } from "@/lib/automation/support-incidents";
import { prisma } from "@/lib/prisma";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import {
  localReaderCourseKeySchema,
  localReaderResultSchema,
  validateLocalReaderResultForJob,
  type LocalReaderResult
} from "./contracts";
import { getLocalReaderCourse, getLocalReaderCourseKey, getLocalReaderJobUrl } from "./course-key";
import {
  LEGACY_READER_1_6_CAPABILITIES,
  getRequiredLocalReaderCapability,
  localReaderCapabilitiesSchema,
  readerSupportsCapability,
  type LocalReaderAgentHandshake
} from "./capabilities";

export { getLocalReaderCourseKey } from "./course-key";

const JOB_LIFETIME_MS = 30 * 60_000;
const LEASE_LIFETIME_MS = 3 * 60_000;
const RESULT_LIFETIME_MS = 10 * 60_000;

export type LocalReaderQueueDisposition = "PENDING" | "RETRYING_AFTER_TERMINAL_FAILURE";

async function resolveRequiredCapability(
  courseId: string,
  courseKey: ReturnType<typeof getLocalReaderCourseKey> & {}
) {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { name: true }
  });
  return getRequiredLocalReaderCapability(courseKey, course?.name);
}

export async function queueLocalReaderCourseVerification(input: {
  courseId: string;
  targetDate: string;
  players: number;
  bookingUrl: string;
  force?: boolean;
}) {
  const courseKey = getLocalReaderCourseKey(input.bookingUrl);
  if (!courseKey) return null;
  const requiredCapability = await resolveRequiredCapability(input.courseId, courseKey);
  const now = new Date();
  const verificationKey = createHash("sha256")
    .update(
      ["local-reader-course-verification", input.courseId, input.targetDate, input.players].join(
        "\n"
      )
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
      (existing.status === "COMPLETED" && !input.force))
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
      bookingUrl: getLocalReaderJobUrl(courseKey, input.targetDate, input.players),
      jobExpiresAt: new Date(now.getTime() + JOB_LIFETIME_MS),
      requiredCapabilityKey: requiredCapability.key,
      requiredParserVersion: requiredCapability.parserVersion
    },
    update: {
      purpose: "COURSE_VERIFICATION",
      courseKey,
      bookingUrl: getLocalReaderJobUrl(courseKey, input.targetDate, input.players),
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
      requiredParserVersion: requiredCapability.parserVersion
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
  const requiredCapability = await resolveRequiredCapability(input.courseId, courseKey);
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
          jobExpiresAt: { gt: now }
        },
        {
          status: "LEASED",
          jobExpiresAt: { gt: now },
          leaseExpiresAt: { gt: now }
        },
        {
          status: "COMPLETED",
          resultExpiresAt: { gt: now }
        }
      ]
    },
    orderBy: { createdAt: "asc" }
  });
  if (reusableAcrossScheduleVersions) {
    return {
      ...reusableAcrossScheduleVersions,
      queueDisposition: "PENDING" as const
    };
  }
  const unique = {
    teeSearchId: input.searchId,
    courseId: input.courseId,
    scheduleVersion: input.scheduleVersion,
    targetDate: input.targetDate,
    players: input.players
  };
  const existing = await prisma.localReaderJob.findUnique({
    where: {
      teeSearchId_courseId_scheduleVersion_targetDate_players: unique
    }
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
    return {
      ...existing,
      queueDisposition: "PENDING" as const
    };
  }
  const retryingAfterTerminalFailure =
    existing !== null &&
    (existing.status === "FAILED" ||
      existing.status === "EXPIRED" ||
      ((existing.status === "PENDING" || existing.status === "LEASED") &&
        existing.jobExpiresAt <= now));
  const job = await prisma.localReaderJob.upsert({
    where: {
      teeSearchId_courseId_scheduleVersion_targetDate_players: unique
    },
    create: {
      teeSearchId: input.searchId,
      courseId: input.courseId,
      scheduleVersion: input.scheduleVersion,
      courseKey,
      targetDate: input.targetDate,
      players: input.players,
      bookingUrl: getLocalReaderJobUrl(courseKey, input.targetDate, input.players),
      jobExpiresAt: new Date(now.getTime() + JOB_LIFETIME_MS),
      requiredCapabilityKey: requiredCapability.key,
      requiredParserVersion: requiredCapability.parserVersion
    },
    update: {
      courseKey,
      bookingUrl: getLocalReaderJobUrl(courseKey, input.targetDate, input.players),
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
      requiredParserVersion: requiredCapability.parserVersion
    }
  });
  return {
    ...job,
    queueDisposition: retryingAfterTerminalFailure
      ? ("RETRYING_AFTER_TERMINAL_FAILURE" as const)
      : ("PENDING" as const)
  };
}

export async function claimNextLocalReaderJob(input: string | LocalReaderAgentHandshake) {
  const handshake = normalizeReaderHandshake(input);
  const deviceId = handshake.deviceId;
  const now = new Date();
  await recordReaderHeartbeat(handshake, now);
  await prisma.localReaderJob.updateMany({
    where: {
      status: { in: ["PENDING", "LEASED"] },
      jobExpiresAt: { lte: now }
    },
    data: { status: "EXPIRED", leaseToken: null, leaseExpiresAt: null }
  });
  const candidate = await prisma.localReaderJob.findFirst({
    where: {
      jobExpiresAt: { gt: now },
      AND: [
        {
          OR: [{ status: "PENDING" }, { status: "LEASED", leaseExpiresAt: { lte: now } }]
        },
        {
          OR: [
            {
              requiredCapabilityKey: null,
              requiredParserVersion: null
            },
            ...handshake.capabilities.map((capability) => ({
              requiredCapabilityKey: capability.key,
              requiredParserVersion: { lte: capability.parserVersion }
            }))
          ]
        }
      ]
    },
    orderBy: { createdAt: "asc" }
  });
  if (!candidate) return null;

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_LIFETIME_MS);
  const claimed = await prisma.localReaderJob.updateMany({
    where: {
      id: candidate.id,
      jobExpiresAt: { gt: now },
      OR: [{ status: "PENDING" }, { status: "LEASED", leaseExpiresAt: { lte: now } }]
    },
    data: {
      status: "LEASED",
      leaseToken,
      leaseExpiresAt,
      claimedAt: now,
      deviceId
    }
  });
  if (claimed.count !== 1) return null;
  const courseKey = localReaderCourseKeySchema.parse(candidate.courseKey);
  const course = await prisma.course.findUnique({
    where: { id: candidate.courseId },
    select: { name: true }
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
        getRequiredLocalReaderCapability(courseKey, course?.name).parserVersion
    },
    leaseToken
  };
}

export async function completeLocalReaderJob(input: {
  jobId: string;
  leaseToken: string;
  result: LocalReaderResult;
}) {
  const current = await prisma.localReaderJob.findUnique({
    where: { id: input.jobId }
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
  const course = await prisma.course.findUnique({
    where: { id: current.courseId },
    select: { name: true }
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
          getRequiredLocalReaderCapability(courseKey, course?.name).parserVersion
      }
    },
    input.result
  );
  const completedAt = new Date();
  const updated = await prisma.localReaderJob.updateMany({
    where: {
      id: current.id,
      status: "LEASED",
      leaseToken: input.leaseToken,
      leaseExpiresAt: { gt: completedAt }
    },
    data: {
      status: "COMPLETED",
      result: input.result as Prisma.InputJsonValue,
      resultExpiresAt: new Date(completedAt.getTime() + RESULT_LIFETIME_MS),
      readerVersion: input.result.readerVersion,
      completedAt,
      leaseToken: null,
      leaseExpiresAt: null
    }
  });
  if (updated.count !== 1) throw new Error("The local reader lease changed");
  await recordReaderSuccess({
    deviceId: current.deviceId,
    readerVersion: input.result.readerVersion,
    capability:
      current.requiredCapabilityKey ??
      getRequiredLocalReaderCapability(courseKey, course?.name).key,
    now: completedAt
  });

  if (
    current.purpose === "COURSE_VERIFICATION" &&
    (input.result.status === "AVAILABLE" || input.result.status === "NO_AVAILABILITY")
  ) {
    try {
      const outcome = input.result.status === "AVAILABLE" ? "MATCH_FOUND" : "NO_MATCH";
      await recordCourseMonitoringSuccess({
        courseId: current.courseId,
        outcome,
        source: "LOCAL_READER",
        message:
          input.result.status === "AVAILABLE"
            ? "Fresh signed local public-page verification found availability."
            : "Fresh signed local public-page verification completed without availability.",
        now: completedAt,
        runtimeVersion: input.result.readerVersion
      });
      const incidentModel = (
        prisma as typeof prisma & {
          courseSupportIncident?: {
            findUnique: (input: unknown) => Promise<{
              activeBatchId: string | null;
            } | null>;
          };
        }
      ).courseSupportIncident;
      const activeIncident = incidentModel
        ? await incidentModel.findUnique({
            where: { courseId: current.courseId },
            select: { activeBatchId: true }
          })
        : null;
      if (!activeIncident?.activeBatchId) {
        await resolveCourseSupportIncident({
          courseId: current.courseId,
          resolution: "MONITORING_RESTORED",
          message: `Fresh signed local public-page verification completed successfully with outcome ${outcome}.`,
          now: completedAt
        });
      }
    } catch {
      console.error("[local-reader:course-verification-reconciliation-failed]", {
        category: "monitoring_reconciliation_failed"
      });
    }
  }

  if (current.teeSearchId) {
    await prisma.localReaderJob.updateMany({
      where: {
        id: { not: current.id },
        teeSearchId: current.teeSearchId,
        courseId: current.courseId,
        targetDate: current.targetDate,
        players: current.players,
        status: "PENDING"
      },
      data: {
        status: "EXPIRED",
        leaseToken: null,
        leaseExpiresAt: null
      }
    });
  }
  return { searchId: current.teeSearchId, completedAt };
}

function normalizeReaderHandshake(
  input: string | LocalReaderAgentHandshake
): LocalReaderAgentHandshake {
  if (typeof input === "string") {
    return {
      deviceId: input,
      readerVersion: "1.6.0",
      buildId: "legacy-1.6.0",
      capabilities: LEGACY_READER_1_6_CAPABILITIES
    };
  }
  return {
    deviceId: input.deviceId,
    readerVersion: input.readerVersion.trim().slice(0, 64),
    buildId: input.buildId.trim().slice(0, 100),
    capabilities: localReaderCapabilitiesSchema.parse(input.capabilities)
  };
}

async function recordReaderHeartbeat(handshake: LocalReaderAgentHandshake, now: Date) {
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
  if (!model) return;
  const previous = await model.findUnique({
    where: { deviceId: handshake.deviceId },
    select: {
      readerVersion: true,
      buildId: true,
      capabilities: true
    }
  });
  await model.upsert({
    where: { deviceId: handshake.deviceId },
    create: {
      deviceId: handshake.deviceId,
      readerVersion: handshake.readerVersion,
      buildId: handshake.buildId,
      capabilities: handshake.capabilities as Prisma.InputJsonValue,
      lastSeenAt: now
    },
    update: {
      readerVersion: handshake.readerVersion,
      buildId: handshake.buildId,
      capabilities: handshake.capabilities as Prisma.InputJsonValue,
      lastSeenAt: now
    }
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
    return;
  }
  await requeueReaderBlockedIncidents({
    capabilities: handshake.capabilities,
    previousCapabilities: previousCapabilities?.success ? previousCapabilities.data : null,
    readerDeploymentChanged,
    readerVersion: handshake.readerVersion,
    buildId: handshake.buildId,
    now
  });
}

function haveSameCapabilities(
  left: LocalReaderAgentHandshake["capabilities"],
  right: LocalReaderAgentHandshake["capabilities"]
) {
  if (left.length !== right.length) return false;
  return left.every((capability) =>
    right.some(
      (candidate) =>
        candidate.key === capability.key && candidate.parserVersion === capability.parserVersion
    )
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
      lastSuccessfulCapability: input.capability
    }
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
      activeBatchId: null
    },
    select: {
      id: true,
      revision: true,
      courseId: true,
      activeRealSearchCount: true,
      course: {
        select: {
          name: true,
          detectedBookingUrl: true,
          website: true,
          monitoringStatus: {
            select: { revision: true }
          }
        }
      }
    }
  });
  for (const incident of incidents) {
    const courseKey = getLocalReaderCourseKey(
      incident.course.detectedBookingUrl ?? incident.course.website
    );
    if (!courseKey) continue;
    const required = getRequiredLocalReaderCapability(courseKey, incident.course.name);
    if (!readerSupportsCapability(input.capabilities, required.key, required.parserVersion)) {
      continue;
    }
    if (
      !input.readerDeploymentChanged &&
      input.previousCapabilities &&
      readerSupportsCapability(
        input.previousCapabilities,
        required.key,
        required.parserVersion
      )
    ) {
      continue;
    }
    await prisma.$transaction(async (transaction) => {
      const incidentUpdated = await transaction.courseSupportIncident.updateMany({
        where: {
          id: incident.id,
          revision: incident.revision,
          status: "NEEDS_HUMAN",
          activeBatchId: null
        },
        data: {
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          nextReminderAt: null,
          nextAttemptAt: input.now,
          escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
            input.now,
            incident.activeRealSearchCount
          ),
          latestMessage:
            "A compatible signed local reader is online; exact public-page revalidation was requeued.",
          revision: { increment: 1 }
        }
      });
      if (incidentUpdated.count !== 1) return;
      if (incident.course.monitoringStatus) {
        await transaction.courseMonitoringStatus.updateMany({
          where: {
            courseId: incident.courseId,
            revision: incident.course.monitoringStatus.revision
          },
          data: {
            state: "AUTO_INVESTIGATING",
            nextAutomaticAttemptAt: input.now,
            revalidationRequestedAt: input.now,
            stateChangedAt: input.now,
            revision: { increment: 1 }
          }
        });
      }
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
            parserVersion: required.parserVersion,
            readerVersion: input.readerVersion,
            buildId: input.buildId,
            customerDataIncluded: false
          }
        }
      });
    });
  }
}

export async function getFreshLocalReaderTeeSheet(input: {
  searchId: string;
  courseId: string;
  targetDate: string;
  players: number;
}) {
  return (await getFreshLocalReaderObservation(input))?.teeSheet ?? null;
}

export async function getFreshLocalReaderObservation(input: {
  searchId: string;
  courseId: string;
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
      resultExpiresAt: { gt: new Date() }
    },
    orderBy: { completedAt: "desc" }
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
              result.status === "AVAILABLE" ? ("OPEN" as const) : ("UNKNOWN" as const),
            bookingWindowEvidence: null,
            readerVersion: result.readerVersion
          }
        : null
  };
}

export async function getLocalReaderCourseVerification(input: {
  courseId: string;
  targetDate: string;
  players: number;
  notBefore: Date;
}) {
  const now = new Date();
  const row = await prisma.localReaderJob.findFirst({
    where: {
      teeSearchId: null,
      purpose: "COURSE_VERIFICATION",
      courseId: input.courseId,
      targetDate: input.targetDate,
      players: input.players,
      status: { in: ["PENDING", "LEASED", "COMPLETED"] }
    },
    orderBy: { createdAt: "desc" }
  });
  if (!row) return null;
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
  if (result.status !== "AVAILABLE" && result.status !== "NO_AVAILABILITY") {
    return null;
  }
  const observedAt = new Date(result.observedAt);
  if (observedAt < input.notBefore) return null;
  return {
    status: "COMPLETED" as const,
    observedAt,
    readerVersion: result.readerVersion,
    slots: buildLocalReaderSlots(input.courseId, result)
  };
}

function buildLocalReaderSlots(courseId: string, result: LocalReaderResult): TeeTimeSlot[] {
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
      bookableHoleCounts: slot.holes
    };
  });
}
