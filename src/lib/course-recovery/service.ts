import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { loadActiveGooglePlaceReviewIndex } from "@/lib/places/google-place-reviews";
import { isSafeManualEvidenceUrl } from "@/lib/automation/browser-discovery";
import { investigateCourseRecovery } from "./investigate";
import {
  RECOVERY_LEASE_MS, RECOVERY_MAX_ATTEMPTS, RECOVERY_MAX_DUE, RECOVERY_RETRY_MS,
  recoveryInputSchema, type RecoveryInput, type RecoveryInvestigation, type RecoveryView,
  type RecoveryWorkflowInput,
} from "./contracts";

const ACTIVE = ["QUEUED", "INVESTIGATING", "RETRY_WAIT"] as const;
const DAY = 24 * 60 * 60_000;
export class RecoveryAdmissionError extends Error {}

export function recoveryIdentityKey(input: RecoveryInput) {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
  let officialWebsite = "";
  if (input.officialWebsite) {
    const url = new URL(input.officialWebsite);
    url.hash = "";
    officialWebsite = url.toString();
  }
  return createHash("sha256").update(JSON.stringify([normalize(input.name), normalize(input.town),
    input.address ? normalize(input.address) : "", officialWebsite])).digest("hex");
}

/** Anonymous admission stores no identity/recipient authority and never resets existing work. */
export async function retainRecoveryRequest(input: RecoveryInput, sourceBucket: string, now = new Date()) {
  const parsed = recoveryInputSchema.parse(input);
  const identityKey = recoveryIdentityKey(parsed);
  return prisma.$transaction(async transaction => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tee-time-spot:course-recovery-admission'))`;
    const existing = await transaction.courseRecoveryRequest.findUnique({ where: { identityKey } });
    if (existing) return { id: existing.id, created: false };
    const day = now.toISOString().slice(0, 10);
    const expiresAt = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * DAY);
    const sourceKey = `source:${day}:${sourceBucket}`;
    const globalKey = `global:${day}`;
    for (const [key, max] of [[globalKey, 100], [sourceKey, 10]] as const) {
      const bucket = await transaction.courseRecoveryAdmission.findUnique({ where: { key } });
      if ((bucket?.count ?? 0) >= max) throw new RecoveryAdmissionError("Please try again tomorrow. Today's course request limit has been reached.");
    }
    if (await transaction.courseRecoveryRequest.count({ where: { status: { in: [...ACTIVE] } } }) >= 100) {
      throw new RecoveryAdmissionError("Course research is busy. Please try again later.");
    }
    for (const key of [globalKey, sourceKey]) {
      await transaction.courseRecoveryAdmission.upsert({ where: { key },
        create: { key, count: 1, expiresAt }, update: { count: { increment: 1 } } });
    }
    await transaction.courseRecoveryAdmission.deleteMany({ where: { expiresAt: { lt: now } } });
    const row = await transaction.courseRecoveryRequest.create({ data: {
      ...parsed, identityKey, nextAttemptAt: now, deadlineAt: new Date(now.getTime() + DAY),
    } });
    return { id: row.id, created: true };
  });
}

export async function readRecoveryView(id: string): Promise<RecoveryView | null> {
  const request = await prisma.courseRecoveryRequest.findUnique({ where: { id }, include: { course: true,
    attempts: { orderBy: { revision: "desc" }, take: 1, select: { evidenceUrl: true } } } });
  if (!request) return null;
  if (request.status === "VERIFIED" && request.course?.isPublic === false) {
    return { id, status: "NOT_PUBLIC", message: "This course is not currently verified for public play.", question: null, course: null, nextAttemptAt: null };
  }
  let course: RecoveryView["course"] = null;
  if (request.status === "VERIFIED" && request.course && request.course.isPublic === true) {
    const reviews = await loadActiveGooglePlaceReviewIndex();
    const review = reviews.byPlaceId.get(request.course.googlePlaceId ?? "");
    const canonical = review?.canonicalPlaceId ? reviews.byPlaceId.get(review.canonicalPlaceId) : undefined;
    if ([review, canonical].some(value => value?.accessOverride === "VERIFIED_PRIVATE" || value?.accessOverride === "VERIFIED_NON_COURSE")) {
      return { id, status: "NOT_PUBLIC", message: "This course is not currently verified for public play.", question: null, course: null, nextAttemptAt: null };
    }
    const row = request.course;
    course = { courseId: row.id, googlePlaceId: row.googlePlaceId ?? `recovered:${row.id}`,
      name: row.name, address: row.address ?? undefined, city: row.city ?? undefined,
      stateCode: row.stateCode ?? undefined, latitude: row.latitude, longitude: row.longitude,
      timeZone: row.timeZone, website: row.website ?? undefined, phone: row.phone ?? undefined,
      publicAccessStatus: "PUBLIC", monitoringSupport: "UNCONFIRMED", firstTimeLookup: true };
  }
  const messages: Record<RecoveryView["status"], string> = {
    QUEUED: "Your course request is saved. We'll look for its official site.",
    INVESTIGATING: "We're checking the course's identity and official booking source.",
    RETRY_WAIT: "The course request is saved. We'll try again automatically after a temporary lookup problem.",
    VERIFIED: course ? "The public course is verified. You can add it to your list." : "The verified course is temporarily unavailable. Please try again.",
    NEEDS_DETAILS: "We need one detail to identify the right course.",
    NOT_PUBLIC: "The evidence does not identify a public golf course available for this alert.",
    UNRESOLVED: "We couldn't verify this course yet. An empty lookup does not mean it doesn't exist. Check the course name and town.",
    ACCESS_LIMITED: "The official source needs a step we can't complete automatically. You can use the official site directly.",
  };
  let officialSiteUrl: string | null = null;
  try {
    const url = new URL(request.attempts[0]?.evidenceUrl ?? "");
    if (isSafeManualEvidenceUrl(url)) officialSiteUrl = url.toString();
  } catch { /* Missing evidence is not an official link. */ }
  return { id, status: request.status, message: messages[request.status], officialSiteUrl,
    question: request.status === "NEEDS_DETAILS" || request.status === "ACCESS_LIMITED" ? request.reason : null,
    course, nextAttemptAt: ACTIVE.includes(request.status as typeof ACTIVE[number]) ? request.nextAttemptAt.toISOString() : null };
}

export async function claimRecoveryRequest(id: string, now = new Date()): Promise<RecoveryWorkflowInput | null> {
  return prisma.$transaction(async transaction => {
    const request = await transaction.courseRecoveryRequest.findUnique({ where: { id } });
    if (!request || !ACTIVE.includes(request.status as typeof ACTIVE[number]) || request.nextAttemptAt > now ||
      (request.leaseExpiresAt && request.leaseExpiresAt > now)) return null;
    if (request.deadlineAt <= now || request.attemptCount >= RECOVERY_MAX_ATTEMPTS) {
      await transaction.courseRecoveryRequest.updateMany({ where: { id, revision: request.revision, status: request.status }, data: {
        status: "UNRESOLVED", reason: "The bounded research window ended without verified identity.", leaseToken: null, leaseExpiresAt: null,
      } });
      return null;
    }
    const leaseToken = randomUUID();
    const claimed = await transaction.courseRecoveryRequest.updateMany({ where: {
      id, revision: request.revision, status: request.status,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    }, data: { status: "INVESTIGATING", revision: { increment: 1 }, attemptCount: { increment: 1 },
      leaseToken, leaseExpiresAt: new Date(now.getTime() + RECOVERY_LEASE_MS), workflowRunId: null } });
    return claimed.count === 1 ? { requestId: id, revision: request.revision + 1, leaseToken } : null;
  });
}

function ownedWhere(input: RecoveryWorkflowInput, now: Date) {
  return { id: input.requestId, revision: input.revision, leaseToken: input.leaseToken,
    leaseExpiresAt: { gt: now }, status: "INVESTIGATING" as const };
}

export async function failRecoveryAttempt(input: RecoveryWorkflowInput, now = new Date()) {
  return prisma.$transaction(async transaction => {
    const row = await transaction.courseRecoveryRequest.findFirst({ where: ownedWhere(input, now) });
    if (!row) return false;
    const retryAt = new Date(now.getTime() + (RECOVERY_RETRY_MS[Math.min(row.attemptCount - 1, RECOVERY_RETRY_MS.length - 1)]));
    const retry = row.attemptCount < RECOVERY_MAX_ATTEMPTS && retryAt < row.deadlineAt;
    const saved = await transaction.courseRecoveryRequest.updateMany({ where: ownedWhere(input, now), data: {
      status: retry ? "RETRY_WAIT" : "UNRESOLVED", nextAttemptAt: retryAt,
      reason: "Temporary source lookup failure; no identity or availability was inferred.", leaseToken: null, leaseExpiresAt: null,
    } });
    if (saved.count !== 1) return false;
    await transaction.courseRecoveryAttempt.create({ data: { requestId: row.id, revision: input.revision,
      outcome: "LOOKUP_FAILED", evidenceSummary: "A bounded source read failed. Automatic retry retained when within the research window.", observedAt: now } });
    return true;
  });
}

export async function completeRecoveryAttempt(input: RecoveryWorkflowInput, result: RecoveryInvestigation, now = new Date()) {
  return prisma.$transaction(async transaction => {
    const row = await transaction.courseRecoveryRequest.findFirst({ where: ownedWhere(input, now) });
    if (!row) return false;
    let courseId: string | null = null;
    if (result.status === "VERIFIED") {
      const candidate = result.course;
      // Include current exact/canonical facts in the transaction's read set;
      // a concurrent review change must conflict rather than publish stale trust.
      const exactReview = await transaction.googlePlaceReview.findUnique({ where: { googlePlaceId: candidate.googlePlaceId } });
      const review = exactReview?.active ? exactReview : null;
      const canonicalReview = review?.canonicalPlaceId ? await transaction.googlePlaceReview.findUnique({ where: { googlePlaceId: review.canonicalPlaceId } }) : null;
      const canonical = canonicalReview?.active ? canonicalReview : null;
      if ([review, canonical].some(value => value?.accessOverride === "VERIFIED_PRIVATE" || value?.accessOverride === "VERIFIED_NON_COURSE")) throw new Error("Course access evidence changed.");
      if (review?.canonicalPlaceId && review.canonicalPlaceId !== candidate.googlePlaceId) throw new Error("Course canonical identity changed.");
      // Preserve existing provider support and metadata. Discovery is not a monitoring proof.
      const byPlace = await transaction.course.findUnique({ where: { googlePlaceId: candidate.googlePlaceId } });
      const byId = !byPlace && candidate.courseId ? await transaction.course.findUnique({ where: { id: candidate.courseId } }) : null;
      if (byId?.googlePlaceId && byId.googlePlaceId !== candidate.googlePlaceId) {
        const alias = await transaction.googlePlaceReview.findUnique({ where: { googlePlaceId: byId.googlePlaceId } });
        if (!alias?.active || alias.canonicalPlaceId !== candidate.googlePlaceId ||
          alias.accessOverride === "VERIFIED_PRIVATE" || alias.accessOverride === "VERIFIED_NON_COURSE") {
          throw new Error("Course reference no longer represents the verified identity.");
        }
      }
      const existing = byPlace ?? byId;
      if (existing?.isPublic === false) throw new Error("Existing course is not public.");
      if (existing) {
        courseId = existing.id;
        await transaction.course.update({ where: { id: existing.id }, data: { isPublic: true,
          googlePlaceId: candidate.googlePlaceId, name: candidate.name, address: candidate.address,
          city: candidate.city, stateCode: candidate.stateCode, latitude: candidate.latitude,
          longitude: candidate.longitude, timeZone: candidate.timeZone, website: candidate.website,
          ...(existing.detectedBookingUrl || !result.bookingUrl ? {} : { detectedBookingUrl: result.bookingUrl }),
        } });
      } else {
        const course = await transaction.course.create({ data: {
          googlePlaceId: candidate.googlePlaceId, name: candidate.name, address: candidate.address,
          city: candidate.city, stateCode: candidate.stateCode, stateName: candidate.stateName,
          county: candidate.county, countryCode: candidate.countryCode, latitude: candidate.latitude,
          longitude: candidate.longitude, timeZone: candidate.timeZone, website: candidate.website,
          phone: candidate.phone, isPublic: true, detectedBookingUrl: result.bookingUrl,
          automationEligibility: "UNKNOWN", providerFamilyKey: "SOURCE_MISSING",
        } });
        courseId = course.id;
      }
    }
    const saved = await transaction.courseRecoveryRequest.updateMany({ where: ownedWhere(input, now), data: {
      status: result.status, courseId, reason: result.status === "VERIFIED" ? null : result.reason.slice(0, 500),
      verifiedAt: result.status === "VERIFIED" ? now : null,
      humanRequiredAt: result.status === "NEEDS_DETAILS" || result.status === "ACCESS_LIMITED" ? now : null,
      leaseToken: null, leaseExpiresAt: null,
    } });
    if (saved.count !== 1) throw new Error("Recovery ownership changed before completion.");
    await transaction.courseRecoveryAttempt.create({ data: { requestId: row.id, revision: input.revision,
      outcome: result.status, evidenceUrl: result.evidenceUrl,
      evidenceSummary: result.evidenceSummary.slice(0, 2000), observedAt: now } });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function executeRecoveryAttempt(input: RecoveryWorkflowInput) {
  const request = await prisma.courseRecoveryRequest.findFirst({ where: ownedWhere(input, new Date()) });
  if (!request) return { outcome: "stale" };
  try {
    const result = await investigateCourseRecovery({ name: request.name, town: request.town,
      address: request.address ?? undefined, officialWebsite: request.officialWebsite ?? undefined,
      latitude: request.latitude ?? undefined, longitude: request.longitude ?? undefined });
    return { outcome: await completeRecoveryAttempt(input, result) ? result.status : "stale" };
  } catch {
    return { outcome: await failRecoveryAttempt(input) ? "retry_retained" : "stale" };
  }
}

export async function listDueRecoveryRequests(now = new Date()) {
  return prisma.courseRecoveryRequest.findMany({ where: { status: { in: [...ACTIVE] }, nextAttemptAt: { lte: now },
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }], take: RECOVERY_MAX_DUE, select: { id: true } });
}
