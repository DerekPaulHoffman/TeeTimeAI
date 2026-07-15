import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildCourseProfileSlug, withStableSlugSuffix } from "@/lib/course-profiles/slug";
import {
  hashCourseProfileDraft,
  validateCourseProfileDraft,
  type CourseProfileDraft
} from "@/lib/course-profiles/validation";

export const COURSE_PROFILE_REVIEW_DAYS = 180;
export const COURSE_PROFILE_QUEUE_BATCH_SIZE = 3;

export async function ensurePendingCourseProfile(courseId: string) {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, name: true, city: true, stateCode: true, profile: { select: { id: true } } }
  });
  if (!course || course.profile || !course.city || !course.stateCode) return null;
  const baseSlug = buildCourseProfileSlug({ name: course.name, city: course.city, stateCode: course.stateCode });
  const collision = await prisma.courseProfile.findUnique({ where: { canonicalSlug: baseSlug }, select: { id: true } });
  return prisma.courseProfile.create({
    data: { courseId, canonicalSlug: collision ? withStableSlugSuffix(baseSlug, courseId) : baseSlug }
  });
}

export async function queuePendingCourseProfiles(courseIds: readonly string[]) {
  const uniqueCourseIds = [...new Set(courseIds)];
  const results = await Promise.allSettled(uniqueCourseIds.map(ensurePendingCourseProfile));
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected.length > 0) {
    console.warn(
      `Course profile queueing failed for ${rejected.length} course${rejected.length === 1 ? "" : "s"}`,
      rejected.map((result) => result.reason instanceof Error ? result.reason.message : "Unknown queueing error")
    );
  }
}

export async function listCourseProfileQueue(limit = COURSE_PROFILE_QUEUE_BATCH_SIZE) {
  const now = new Date();
  return prisma.course.findMany({
    where: {
      isPublic: true,
      automationEligibility: { in: ["ALLOWED", "BLOCKED"] },
      OR: [
        { profile: null },
        { profile: { status: { in: ["PENDING", "STALE", "BLOCKED_EVIDENCE"] } } },
        { profile: { status: "PUBLISHED", reviewDueAt: { lte: now } } }
      ]
    },
    orderBy: [{ automationEligibility: "asc" }, { updatedAt: "desc" }],
    take: Math.min(Math.max(limit, 1), 25),
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      stateCode: true,
      county: true,
      website: true,
      detectedBookingUrl: true,
      automationEligibility: true,
      profile: { select: { status: true, reviewDueAt: true, failureReason: true } }
    }
  });
}

export async function getCourseProfileResearchPacket(courseId: string) {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    include: { profile: { include: { sources: true } } }
  });
  if (!course) throw new Error(`Course ${courseId} was not found`);
  const sourceUrls = [...new Set([course.website, course.detectedBookingUrl].filter((value): value is string => Boolean(value)))];
  const sourcePages = await Promise.all(sourceUrls.map(fetchResearchPage));
  return { course, sourcePages };
}

export async function applyCourseProfileDraft(value: unknown, apply = false) {
  const validation = validateCourseProfileDraft(value);
  const courseId = validation.draft?.courseId ?? (isRecord(value) && typeof value.courseId === "string" ? value.courseId : null);
  if (!validation.valid || !validation.draft) {
    if (apply && courseId) {
      await markCourseProfileBlocked(courseId, validation.errors.join("; "));
    }
    return { mode: apply ? "blocked" : "dry-run", valid: false, errors: validation.errors };
  }
  const draft = validation.draft;
  const course = await prisma.course.findUnique({
    where: { id: draft.courseId },
    select: { id: true, name: true, isPublic: true, automationEligibility: true, profile: { select: { canonicalSlug: true, contentVersion: true } } }
  });
  if (!course) return { mode: "dry-run", valid: false, errors: [`Course ${draft.courseId} was not found`] };
  const eligibilityErrors = [
    ...(!course.isPublic ? ["Course is not public"] : []),
    ...(!["ALLOWED", "BLOCKED"].includes(course.automationEligibility) ? ["Course support status is not verified"] : [])
  ];
  if (eligibilityErrors.length > 0) {
    if (apply) await markCourseProfileBlocked(course.id, eligibilityErrors.join("; "));
    return { mode: apply ? "blocked" : "dry-run", valid: false, errors: eligibilityErrors };
  }

  const baseSlug = buildCourseProfileSlug({ name: course.name, city: draft.location.city, stateCode: draft.location.stateCode });
  let canonicalSlug = course.profile?.canonicalSlug ?? baseSlug;
  if (!course.profile) {
    const collision = await prisma.courseProfile.findUnique({ where: { canonicalSlug }, select: { courseId: true } });
    if (collision && collision.courseId !== course.id) canonicalSlug = withStableSlugSuffix(baseSlug, course.id);
  }
  if (!apply) return { mode: "dry-run", valid: true, errors: [], canonicalSlug, draft };

  const verifiedAt = new Date(draft.profileVerifiedAt);
  const reviewDueAt = new Date(verifiedAt.getTime() + COURSE_PROFILE_REVIEW_DAYS * 86_400_000);
  const now = new Date();
  const contentHash = hashCourseProfileDraft(draft);
  const result = await prisma.$transaction(async (tx) => {
    await tx.course.update({
      where: { id: course.id },
      data: { ...draft.location, ...(draft.officialWebsiteUrl ? { website: draft.officialWebsiteUrl } : {}) }
    });
    const profile = await tx.courseProfile.upsert({
      where: { courseId: course.id },
      create: profileCreateData(course.id, canonicalSlug, draft, contentHash, verifiedAt, reviewDueAt, now),
      update: {
        courseType: draft.courseType,
        accessSummary: draft.accessSummary,
        overview: draft.overview,
        courseCharacter: draft.courseCharacter,
        notableFacts: draft.notableFacts,
        contentHash,
        contentVersion: (course.profile?.contentVersion ?? 0) + 1,
        profileVerifiedAt: verifiedAt,
        reviewDueAt,
        publishedAt: now,
        lastResearchAttemptAt: now,
        lastRefreshedAt: now,
        failedResearchAt: null,
        failureReason: null,
        status: "PUBLISHED"
      }
    });
    await tx.courseProfileSource.deleteMany({ where: { courseProfileId: profile.id } });
    await tx.courseProfileSource.createMany({
      data: draft.sources.map((source) => ({ ...source, accessedAt: new Date(source.accessedAt), courseProfileId: profile.id }))
    });
    return profile;
  });
  return { mode: "applied", valid: true, errors: [], canonicalSlug: result.canonicalSlug, courseId: course.id };
}

export async function getPublishedCourseProfile(slug: string) {
  const direct = await prisma.courseProfile.findFirst({
    where: { canonicalSlug: slug, status: "PUBLISHED" },
    include: { course: true, sources: { orderBy: [{ sourceType: "asc" }, { publisher: "asc" }] } }
  });
  if (direct) return { profile: direct, redirectSlug: null };
  const alias = await prisma.courseProfileSlugAlias.findUnique({
    where: { slug },
    include: { courseProfile: { include: { course: true, sources: true } } }
  });
  if (!alias || alias.courseProfile.status !== "PUBLISHED") return null;
  return { profile: alias.courseProfile, redirectSlug: alias.courseProfile.canonicalSlug };
}

export async function createCourseProfileSlugAlias(courseId: string, slug: string, apply = false) {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug) || normalizedSlug.length > 120) {
    return { mode: "dry-run", valid: false, errors: ["Alias must be a lowercase URL slug of 120 characters or fewer"] };
  }
  const profile = await prisma.courseProfile.findUnique({
    where: { courseId },
    select: { id: true, canonicalSlug: true }
  });
  if (!profile) return { mode: "dry-run", valid: false, errors: [`Course ${courseId} has no profile`] };
  if (profile.canonicalSlug === normalizedSlug) {
    return { mode: "dry-run", valid: false, errors: ["Alias cannot equal the canonical slug"] };
  }
  const [canonicalCollision, aliasCollision] = await Promise.all([
    prisma.courseProfile.findUnique({ where: { canonicalSlug: normalizedSlug }, select: { id: true } }),
    prisma.courseProfileSlugAlias.findUnique({ where: { slug: normalizedSlug }, select: { courseProfileId: true } })
  ]);
  if (canonicalCollision || (aliasCollision && aliasCollision.courseProfileId !== profile.id)) {
    return { mode: "dry-run", valid: false, errors: ["Alias is already owned by another profile"] };
  }
  if (!apply || aliasCollision) {
    return { mode: apply ? "unchanged" : "dry-run", valid: true, errors: [], slug: normalizedSlug };
  }
  await prisma.courseProfileSlugAlias.create({ data: { courseProfileId: profile.id, slug: normalizedSlug } });
  return { mode: "applied", valid: true, errors: [], slug: normalizedSlug };
}

export async function getRelatedSupportedCourses(course: { id: string; latitude: number; longitude: number; stateCode: string | null }) {
  const candidates = await prisma.course.findMany({
    where: { id: { not: course.id }, isPublic: true, automationEligibility: "ALLOWED", profile: { status: "PUBLISHED" } },
    select: { id: true, name: true, city: true, stateCode: true, latitude: true, longitude: true, profile: { select: { canonicalSlug: true } } }
  });
  return candidates
    .map((candidate) => ({ ...candidate, distanceMiles: haversineMiles(course, candidate) }))
    .filter((candidate) => candidate.distanceMiles <= 50 || candidate.stateCode === course.stateCode)
    .sort((left, right) => left.distanceMiles - right.distanceMiles)
    .slice(0, 4);
}

async function markCourseProfileBlocked(courseId: string, failureReason: string) {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { id: true, name: true, city: true, stateCode: true, profile: { select: { canonicalSlug: true } } } });
  if (!course || !course.city || !course.stateCode) return;
  const baseSlug = buildCourseProfileSlug({ name: course.name, city: course.city, stateCode: course.stateCode });
  let canonicalSlug = course.profile?.canonicalSlug ?? baseSlug;
  if (!course.profile) {
    const collision = await prisma.courseProfile.findUnique({ where: { canonicalSlug }, select: { courseId: true } });
    if (collision && collision.courseId !== course.id) canonicalSlug = withStableSlugSuffix(baseSlug, course.id);
  }
  await prisma.courseProfile.upsert({
    where: { courseId },
    create: { courseId, canonicalSlug, status: "BLOCKED_EVIDENCE", failureReason: failureReason.slice(0, 1000), lastResearchAttemptAt: new Date(), failedResearchAt: new Date() },
    update: { status: "BLOCKED_EVIDENCE", failureReason: failureReason.slice(0, 1000), lastResearchAttemptAt: new Date(), failedResearchAt: new Date() }
  });
}

function profileCreateData(courseId: string, canonicalSlug: string, draft: CourseProfileDraft, contentHash: string, verifiedAt: Date, reviewDueAt: Date, now: Date): Prisma.CourseProfileCreateInput {
  return {
    course: { connect: { id: courseId } }, canonicalSlug, status: "PUBLISHED", courseType: draft.courseType,
    accessSummary: draft.accessSummary, overview: draft.overview, courseCharacter: draft.courseCharacter,
    notableFacts: draft.notableFacts, contentHash, profileVerifiedAt: verifiedAt, reviewDueAt,
    publishedAt: now, lastResearchAttemptAt: now, lastRefreshedAt: now, failedResearchAt: null
  };
}

async function fetchResearchPage(url: string) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "TeeTimeSpotCourseResearch/1.0 (+https://teetimespot.com/about)" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { url, status: response.status, text: null };
    const html = (await response.text()).slice(0, 400_000);
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim().slice(0, 8_000);
    return { url: response.url, status: response.status, text };
  } catch (error) {
    return { url, status: null, text: null, error: error instanceof Error ? error.message : "Fetch failed" };
  }
}

function haversineMiles(left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }) {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(right.latitude - left.latitude);
  const deltaLongitude = toRadians(right.longitude - left.longitude);
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(toRadians(left.latitude)) * Math.cos(toRadians(right.latitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
