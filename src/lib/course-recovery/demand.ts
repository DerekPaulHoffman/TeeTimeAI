import { Prisma, type CourseRecoveryDemand, type WebsiteTrafficClass } from "@prisma/client";
import { z } from "zod";

import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { prisma } from "@/lib/prisma";
import {
  assertQueueCapacityInTransaction,
  createTeeSearchForUser,
  lockUserAlertCapacity,
  RecoveryDemandNoLongerEligibleError,
  SearchCourseValidationError,
} from "@/lib/searches/service";
import {
  MAX_QUEUED_SEARCHES_PER_USER,
  teeSearchDetailsSchema,
  type TeeSearchDetailsInput,
} from "@/lib/validation/search";

export const recoveryDemandInputSchema = z.object(teeSearchDetailsSchema.shape)
  .omit({ alertEmail: true }).strict().transform(value => teeSearchDetailsSchema.parse(value));
export type RecoveryDemandInput = Omit<TeeSearchDetailsInput, "alertEmail">;
export type RecoveryDemandView = {
  id: string;
  status: CourseRecoveryDemand["status"];
  revision: number;
  teeSearchId: string | null;
  expiresAt: string;
  message: string;
};
export type PendingRecoveryDemandView = RecoveryDemandView & {
  requestId: string;
  courseName: string;
  town: string;
  date: string;
  startTime: string;
  endTime: string;
  players: number;
};

export class RecoveryDemandNotFoundError extends Error {
  constructor() {
    super("Pending alert not found.");
    this.name = "RecoveryDemandNotFoundError";
  }
}

export class RecoveryDemandInputError extends Error {}

const terminalReasons = {
  NEEDS_DETAILS: "We need the exact course or town to confirm its identity. Review the course question before creating your alert.",
  NOT_PUBLIC: "This course is not verified as a public golf course. Choose another course.",
  UNRESOLVED: "We could not verify this course from the available public sources. Confirm its official name and town before creating your alert.",
  ACCESS_LIMITED: "The official course source requires access we cannot use. Review the course status and official site before creating your alert.",
} as const;

export function getRecoveryDemandExpiry(date: string) {
  // Identity is not established yet, so a recipient/server timezone cannot
  // define the course's window. UTC date + 2 days safely exceeds its latest
  // possible absolute end. The verified course's future-date check is stricter.
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 2 * 86_400_000);
}

function toView(demand: CourseRecoveryDemand): RecoveryDemandView {
  const messages = {
    WAITING: "Your alert settings are saved. We will start your alert when this public course is verified and your date is still in the future.",
    ACTIVATED: "Your course is verified and your alert is saved. View it on your dashboard.",
    CANCELLED: "This pending alert was cancelled. It will not start automatically.",
    EXPIRED: "Your requested date is no longer in the future. Choose a new date after the course is verified.",
    ACTION_REQUIRED: "Your pending alert needs updated course or alert details. Once the course is verified, review it and create an alert with current settings.",
  };
  const message = demand.status === "ACTIVATED" && !demand.teeSearchId
    ? "This alert was removed from your dashboard. It will not start again automatically."
    : demand.reason ?? messages[demand.status];
  return { id: demand.id, status: demand.status, revision: demand.revision,
    teeSearchId: demand.teeSearchId, expiresAt: demand.expiresAt.toISOString(), message };
}

async function expireWaitingDemand(transaction: Prisma.TransactionClient, userId: string, requestId?: string) {
  const ownerScope = { userId, ...(requestId === undefined ? {} : { requestId }) };
  await transaction.courseRecoveryDemand.updateMany({
    where: { ...ownerScope, status: "WAITING", expiresAt: { lte: new Date() } },
    data: { status: "EXPIRED", revision: { increment: 1 } },
  });
  for (const status of Object.keys(terminalReasons) as Array<keyof typeof terminalReasons>) {
    await transaction.courseRecoveryDemand.updateMany({
      where: { ...ownerScope, status: "WAITING", request: { status } },
      data: { status: "ACTION_REQUIRED", reason: terminalReasons[status], revision: { increment: 1 } },
    });
  }
}

export async function saveRecoveryDemandForUser(
  requestId: string,
  user: { id: string; email: string },
  submitted: RecoveryDemandInput,
  trafficClass: WebsiteTrafficClass = "UNCLASSIFIED",
) {
  const parsed = recoveryDemandInputSchema.parse(submitted);
  const expiresAt = getRecoveryDemandExpiry(parsed.date);
  if (expiresAt <= new Date()) throw new RecoveryDemandInputError("Choose a future date for your pending alert.");
  const demand = await prisma.$transaction(async transaction => {
    await lockUserAlertCapacity(transaction, user.id);
    const request = await transaction.courseRecoveryRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new RecoveryDemandNotFoundError();
    if (request.status === "NOT_PUBLIC") throw new RecoveryDemandInputError("This course is not verified as a public golf course. Choose another course.");
    await expireWaitingDemand(transaction, user.id, requestId);
    const existing = await transaction.courseRecoveryDemand.findUnique({
      where: { requestId_userId: { requestId, userId: user.id } },
    });
    if (existing && existing.status !== "WAITING") return existing;
    const owner = await transaction.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true } });
    const primaryEmail = owner.email.trim().toLowerCase();
    const settings = { ...parsed, alertEmail: primaryEmail,
      additionalEmails: [...new Set(parsed.additionalEmails.map(email => email.trim().toLowerCase()))]
        .filter(email => email !== primaryEmail) };
    if (existing && JSON.stringify(teeSearchDetailsSchema.parse(existing.settings)) ===
        JSON.stringify(teeSearchDetailsSchema.parse(settings)) && existing.trafficClass === trafficClass) return existing;
    await assertQueueCapacityInTransaction(transaction, user.id, { excludeDemandId: existing?.id });
    const terminalStatus = request.status in terminalReasons ? request.status as keyof typeof terminalReasons : null;
    if (existing) {
      return transaction.courseRecoveryDemand.update({
        where: { id: existing.id },
        data: { settings, expiresAt, trafficClass, revision: { increment: 1 } },
      });
    }
    return transaction.courseRecoveryDemand.create({
      data: { requestId, userId: user.id, settings, expiresAt, trafficClass,
        ...(terminalStatus ? { status: "ACTION_REQUIRED", reason: terminalReasons[terminalStatus] } : {}) },
    });
  });
  if (demand.status === "WAITING") await activateVerifiedRecoveryDemands(requestId, demand.id);
  return getRecoveryDemandForUser(requestId, user.id);
}

export async function getRecoveryDemandForUser(requestId: string, userId: string) {
  return prisma.$transaction(async transaction => {
    await lockUserAlertCapacity(transaction, userId);
    await expireWaitingDemand(transaction, userId, requestId);
    const demand = await transaction.courseRecoveryDemand.findUnique({ where: { requestId_userId: { requestId, userId } } });
    return demand ? toView(demand) : null;
  });
}

export async function listPendingRecoveryDemandsForUser(userId: string): Promise<PendingRecoveryDemandView[]> {
  return prisma.$transaction(async transaction => {
    await lockUserAlertCapacity(transaction, userId);
    await expireWaitingDemand(transaction, userId);
    const demands = await transaction.courseRecoveryDemand.findMany({
      where: { userId, status: "WAITING", expiresAt: { gt: new Date() } },
      include: { request: { select: { name: true, town: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_QUEUED_SEARCHES_PER_USER,
    });
    return demands.map(demand => {
      // Only validated display fields leave the owner-scoped service. A corrupt
      // settings row fails this read closed without creating or cancelling demand.
      const settings = teeSearchDetailsSchema.parse(demand.settings);
      return { ...toView(demand), requestId: demand.requestId,
        courseName: demand.request.name, town: demand.request.town,
        date: settings.date, startTime: settings.startTime, endTime: settings.endTime,
        players: settings.players };
    });
  });
}

export async function cancelRecoveryDemandForUser(requestId: string, userId: string) {
  return prisma.$transaction(async transaction => {
    await lockUserAlertCapacity(transaction, userId);
    await expireWaitingDemand(transaction, userId, requestId);
    const demand = await transaction.courseRecoveryDemand.findUnique({ where: { requestId_userId: { requestId, userId } } });
    if (!demand) throw new RecoveryDemandNotFoundError();
    if (demand.status === "ACTIVATED") throw new RecoveryDemandInputError("This alert has already started. Manage or stop it on your dashboard.");
    if (demand.status !== "WAITING" && demand.status !== "ACTION_REQUIRED") return toView(demand);
    return toView(await transaction.courseRecoveryDemand.update({
      where: { id: demand.id }, data: { status: "CANCELLED", revision: { increment: 1 } },
    }));
  });
}

async function finishDemand(id: string, revision: number, status: "EXPIRED" | "ACTION_REQUIRED", reason?: string) {
  return prisma.courseRecoveryDemand.updateMany({
    where: { id, status: "WAITING", revision },
    data: { status, ...(reason ? { reason } : {}), revision: { increment: 1 } },
  });
}

export async function activateVerifiedRecoveryDemands(requestId: string, demandId?: string) {
  const result = { activated: 0, expired: 0, actionRequired: 0, skipped: 0 };
  const request = await prisma.courseRecoveryRequest.findUnique({ where: { id: requestId }, include: { course: true } });
  if (!request || request.status !== "VERIFIED" || !request.course) return result;
  const demands = await prisma.courseRecoveryDemand.findMany({
    where: { requestId, status: "WAITING", ...(demandId ? { id: demandId } : {}) },
    orderBy: { createdAt: "asc" }, take: 20,
  });
  for (const demand of demands) {
    if (demand.expiresAt <= new Date()) {
      result.expired += (await finishDemand(demand.id, demand.revision, "EXPIRED")).count;
      continue;
    }
    try {
      const settings = teeSearchDetailsSchema.parse(demand.settings);
      const course = request.course;
      const search = await createTeeSearchForUser(demand.userId, {
        ...settings,
        courses: [{ courseId: course.id, ...(course.googlePlaceId ? { googlePlaceId: course.googlePlaceId } : {}),
          name: course.name, address: course.address ?? undefined,
          latitude: course.latitude, longitude: course.longitude, publicAccessStatus: "PUBLIC", rank: 1,
          ...(course.website ? { website: course.website } : {}) }],
      }, demand.trafficClass, false, { demandId: demand.id, requestId, expectedRevision: demand.revision });
      result.activated += 1;
      try { await startSearchSchedule(search.id); }
      catch {
        // Creation is durable. The existing search recovery cron retries starts;
        // a failed launch must never reopen demand or create a second alert.
        console.error("[course-recovery:search-start-failed]", { pendingAlertRetained: true });
      }
    } catch (error) {
      if (error instanceof RecoveryDemandNoLongerEligibleError) {
        if (error.reason === "course_unavailable") {
          result.actionRequired += (await finishDemand(demand.id, demand.revision, "ACTION_REQUIRED", error.message)).count;
        } else result.skipped += 1;
        continue;
      }
      const message = error instanceof Error ? error.message : "";
      if (message === "Search date must be in the future for every selected course") {
        result.expired += (await finishDemand(demand.id, demand.revision, "EXPIRED")).count;
      } else if (error instanceof SearchCourseValidationError || error instanceof z.ZodError) {
        result.actionRequired += (await finishDemand(demand.id, demand.revision, "ACTION_REQUIRED",
          error instanceof z.ZodError ? "Review the date, time window, players, and recipient settings before creating this alert." : error.message)).count;
      } else {
        // Transient persistence/review/configuration failures keep the waiting
        // row for the existing recovery cron. Unknown failure is not success.
        result.skipped += 1;
      }
    }
  }
  return result;
}

export async function expireRecoveryDemands() {
  const expired = await prisma.courseRecoveryDemand.updateMany({
    where: { status: "WAITING", expiresAt: { lte: new Date() } },
    data: { status: "EXPIRED", revision: { increment: 1 } },
  });
  let actionRequired = 0;
  for (const status of Object.keys(terminalReasons) as Array<keyof typeof terminalReasons>) {
    actionRequired += (await prisma.courseRecoveryDemand.updateMany({
      where: { status: "WAITING", request: { status } },
      data: { status: "ACTION_REQUIRED", reason: terminalReasons[status], revision: { increment: 1 } },
    })).count;
  }
  return { expired: expired.count, actionRequired };
}
