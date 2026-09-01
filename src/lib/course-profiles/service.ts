import { createHash } from "node:crypto";

import type { CourseProfileStatus, Prisma } from "@prisma/client";

import {
  revalidateCourseMonitoringForProviderEvidenceChangeInTransaction,
  runSerializedCourseMonitoringWrite
} from "@/lib/automation/course-monitoring";
import {
  createAddressPinnedPublicFetchTransport,
  type AddressPinnedPublicFetchDependencies
} from "@/lib/automation/address-pinned-public-fetch";
import { isSafeManualEvidenceUrl } from "@/lib/automation/browser-discovery";
import {
  beginCourseProviderObservation,
  markCourseProviderObservationUnreconciled,
  releaseCourseProviderObservation,
  renewCourseProviderObservationInTransaction,
  startCourseProviderObservationHeartbeat
} from "@/lib/automation/provider-execution-marker";
import { buildCourseSupportProviderSnapshotFingerprint } from "@/lib/automation/course-support-verification";
import { prisma } from "@/lib/prisma";
import { buildCourseProfileSlug, withStableSlugSuffix } from "@/lib/course-profiles/slug";
import {
  haveCompatibleOfficialPageCourseNamesWithVerifiedLayout,
  normalizeOfficialPagePresentationIdentity
} from "@/lib/places/course-identity";
import {
  hashCourseProfileDraft,
  validateCourseProfileDraft,
  type CourseProfileDraft
} from "@/lib/course-profiles/validation";

export const COURSE_PROFILE_REVIEW_DAYS = 180;
export const COURSE_PROFILE_QUEUE_BATCH_SIZE = 3;
export const PUBLIC_COURSE_PROFILE_STATUSES: readonly CourseProfileStatus[] = [
  "PUBLISHED",
  "STALE"
];

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
  const courses = await prisma.course.findMany({
    where: {
      isPublic: true,
      automationEligibility: { in: ["ALLOWED", "BLOCKED"] },
      city: { not: null },
      stateCode: { not: null },
      OR: [
        { profile: null },
        { profile: { status: { in: ["PENDING", "STALE", "BLOCKED_EVIDENCE"] } } },
        { profile: { status: "PUBLISHED", reviewDueAt: { lte: now } } }
      ]
    },
    orderBy: [{ automationEligibility: "asc" }, { createdAt: "asc" }],
    take: 100,
    select: {
      id: true,
      createdAt: true,
      name: true,
      address: true,
      city: true,
      stateCode: true,
      county: true,
      website: true,
      detectedBookingUrl: true,
      automationEligibility: true,
      profile: {
        select: {
          status: true,
          createdAt: true,
          reviewDueAt: true,
          failureReason: true
        }
      }
    }
  });
  return courses
    .sort(
      (left, right) =>
        getCourseProfileQueueDate(left).getTime() -
        getCourseProfileQueueDate(right).getTime()
    )
    .slice(0, Math.min(Math.max(limit, 1), 25));
}

export async function listCourseProfileLocationEnrichmentQueue(
  limit = COURSE_PROFILE_QUEUE_BATCH_SIZE
) {
  return prisma.course.findMany({
    where: {
      isPublic: true,
      automationEligibility: { in: ["ALLOWED", "BLOCKED"] },
      profile: null,
      OR: [{ city: null }, { stateCode: null }]
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 25),
    select: {
      id: true,
      createdAt: true,
      name: true,
      address: true,
      city: true,
      stateCode: true,
      county: true,
      website: true,
      detectedBookingUrl: true,
      automationEligibility: true
    }
  });
}

export async function getCourseProfileQueueHealth() {
  const actionableWhere: Prisma.CourseWhereInput = {
    isPublic: true,
    automationEligibility: { in: ["ALLOWED", "BLOCKED"] },
    city: { not: null },
    stateCode: { not: null },
    OR: [
      { profile: null },
      { profile: { status: { in: ["PENDING", "STALE", "BLOCKED_EVIDENCE"] } } },
      { profile: { status: "PUBLISHED", reviewDueAt: { lte: new Date() } } }
    ]
  };
  const locationWhere: Prisma.CourseWhereInput = {
    isPublic: true,
    automationEligibility: { in: ["ALLOWED", "BLOCKED"] },
    profile: null,
    OR: [{ city: null }, { stateCode: null }]
  };
  const [
    publicCourseCount,
    publishedCount,
    staleCount,
    missingProfileCount,
    actionableCount,
    locationEnrichmentCount,
    oldestActionable,
    oldestLocation
  ] = await Promise.all([
    prisma.course.count({ where: { isPublic: true } }),
    prisma.courseProfile.count({
      where: { course: { isPublic: true }, status: "PUBLISHED" }
    }),
    prisma.courseProfile.count({
      where: { course: { isPublic: true }, status: "STALE" }
    }),
    prisma.course.count({ where: { isPublic: true, profile: null } }),
    prisma.course.count({ where: actionableWhere }),
    prisma.course.count({ where: locationWhere }),
    listCourseProfileQueue(1),
    listCourseProfileLocationEnrichmentQueue(1)
  ]);
  return {
    publicCourseCount,
    publishedCount,
    staleCount,
    missingProfileCount,
    visibleProfileCount: publishedCount + staleCount,
    actionableCount,
    locationEnrichmentCount,
    oldestActionableAt: oldestActionable[0]
      ? getCourseProfileQueueDate(oldestActionable[0])
      : null,
    oldestLocationEnrichmentAt: oldestLocation[0]?.createdAt ?? null
  };
}

export async function getCourseProfileResearchPacket(
  courseId: string,
  publicFetch: typeof fetch = courseProfilePublicFetch
) {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    include: { profile: { include: { sources: true } } }
  });
  if (!course) throw new Error(`Course ${courseId} was not found`);
  const sourceUrls = [
    ...new Set(
      [course.website, course.detectedBookingUrl]
        .map(getSafeCourseProfileResearchUrl)
        .filter((value): value is string => value !== null)
    )
  ];
  const sourcePages = (
    await Promise.all(
      sourceUrls.map((sourceUrl) => fetchResearchPage(sourceUrl, publicFetch))
    )
  ).map((page) => ({
    url: page.url,
    status: page.status,
    text: page.text,
    ...(page.error ? { error: page.error } : {})
  }));
  return { course, sourcePages };
}

export async function applyCourseProfileDraft(
  value: unknown,
  apply = false,
  publicFetch: typeof fetch = courseProfilePublicFetch
) {
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
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      stateCode: true,
      isPublic: true,
      automationEligibility: true,
      layoutHoleCounts: true,
      updatedAt: true,
      profile: { select: { canonicalSlug: true, contentVersion: true } }
    }
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

  const providerObservation = await beginCourseProviderObservation({
    courseId: course.id
  });
  if (!providerObservation) {
    throw new Error(
      "Another provider observation is already in progress for this course; retry the profile apply."
    );
  }

  const heartbeat = startCourseProviderObservationHeartbeat(providerObservation);
  let providerExecutionStarted = false;
  let heartbeatStopped = false;
  let settlementError: unknown = null;
  try {
    const sourceUrls = getCourseProfileApplySourceUrls(draft);
    providerExecutionStarted = true;
    const freshSources = await Promise.all(
      sourceUrls.map(async (sourceUrl) => ({
        sourceUrl,
        page: await fetchResearchPage(sourceUrl, publicFetch)
      }))
    );
    assertFreshCourseProfileSources(course, draft, freshSources);
    heartbeat.assertOwned();
    await heartbeat.stop();
    heartbeatStopped = true;

    const observedAt = providerObservation.observationStartedAt;
    const observedAtIso = observedAt.toISOString();
    const reconciledDraft: CourseProfileDraft = {
      ...draft,
      profileVerifiedAt: observedAtIso,
      ...(draft.physicalLayout
        ? {
            physicalLayout: {
              ...draft.physicalLayout,
              verifiedAt: observedAtIso
            }
          }
        : {}),
      ...(draft.par
        ? {
            par: {
              ...draft.par,
              verifiedAt: observedAtIso
            }
          }
        : {}),
      sources: draft.sources.map((source) => ({
        ...source,
        accessedAt: observedAtIso
      }))
    };
    const verifiedAt = observedAt;
    const reviewDueAt = new Date(
      verifiedAt.getTime() + COURSE_PROFILE_REVIEW_DAYS * 86_400_000
    );
    const contentHash = hashFreshCourseProfileEvidence(
      reconciledDraft,
      freshSources
    );
    const result = await runSerializedCourseMonitoringWrite(
      course.id,
      async (tx) => {
        if (
          !(await renewCourseProviderObservationInTransaction(
            tx,
            providerObservation
          ))
        ) {
          throw new Error(
            "Provider observation ownership expired before the course profile could be persisted."
          );
        }
        const current = await tx.course.findUnique({ where: { id: course.id } });
        if (!current) {
          throw new Error(`Course ${course.id} was not found`);
        }
        if (current.updatedAt.getTime() !== course.updatedAt.getTime()) {
          throw new Error(
            "Course provider evidence changed during profile verification; rerun the profile apply."
          );
        }
        const applied = await tx.course.update({
          where: {
            id: course.id,
            updatedAt: course.updatedAt
          },
          data: {
            ...reconciledDraft.location,
            ...(reconciledDraft.officialWebsiteUrl
              ? { website: reconciledDraft.officialWebsiteUrl }
              : {}),
            ...(reconciledDraft.physicalLayout
              ? {
                  layoutHoleCounts: reconciledDraft.physicalLayout.holeCounts,
                  layoutHolesEvidenceUrl:
                    reconciledDraft.physicalLayout.evidenceUrl,
                  layoutHolesVerifiedAt: verifiedAt
                }
              : {}),
            ...(reconciledDraft.par
              ? {
                  par: reconciledDraft.par.value,
                  parEvidenceUrl: reconciledDraft.par.evidenceUrl,
                  parVerifiedAt: verifiedAt
                }
              : {})
          }
        });
        await revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
          tx,
          {
            courseId: course.id,
            before: current,
            after: applied,
            providerSnapshotFingerprint:
              buildCourseSupportProviderSnapshotFingerprint(applied),
            source: "OPERATOR_CLI",
            now: observedAt
          }
        );
        const profile = await tx.courseProfile.upsert({
          where: { courseId: course.id },
          create: profileCreateData(
            course.id,
            canonicalSlug,
            reconciledDraft,
            contentHash,
            verifiedAt,
            reviewDueAt,
            observedAt
          ),
          update: {
            courseType: reconciledDraft.courseType,
            accessSummary: reconciledDraft.accessSummary,
            overview: reconciledDraft.overview,
            courseCharacter: reconciledDraft.courseCharacter,
            notableFacts: reconciledDraft.notableFacts,
            contentHash,
            contentVersion: (course.profile?.contentVersion ?? 0) + 1,
            profileVerifiedAt: verifiedAt,
            reviewDueAt,
            publishedAt: observedAt,
            lastResearchAttemptAt: observedAt,
            lastRefreshedAt: observedAt,
            failedResearchAt: null,
            failureReason: null,
            status: "PUBLISHED"
          }
        });
        await tx.courseProfileSource.deleteMany({
          where: { courseProfileId: profile.id }
        });
        await tx.courseProfileSource.createMany({
          data: reconciledDraft.sources.map((source) => ({
            ...source,
            accessedAt: observedAt,
            courseProfileId: profile.id
          }))
        });

        return profile;
      }
    );
    return {
      mode: "applied",
      valid: true,
      errors: [],
      canonicalSlug: result.canonicalSlug,
      courseId: course.id
    };
  } finally {
    if (!heartbeatStopped) {
      try {
        await heartbeat.stop();
      } catch (error) {
        settlementError = error;
      }
    }
    try {
      if (providerExecutionStarted) {
        const retained = await markCourseProviderObservationUnreconciled(
          providerObservation
        );
        if (!retained && !settlementError) {
          settlementError = new Error(
            "Course profile provider source could not be retained for reconciliation."
          );
        }
      } else if (
        providerObservation.supersededUnresolvedObservationStartedAt
      ) {
        const retained = await markCourseProviderObservationUnreconciled(
          providerObservation,
          { preserveSupersededSource: true }
        );
        if (!retained && !settlementError) {
          settlementError = new Error(
            "Superseded course profile provider source could not be retained."
          );
        }
      } else {
        await releaseCourseProviderObservation(providerObservation);
      }
    } catch (error) {
      settlementError ??= error;
    }
    if (settlementError) throw settlementError;
  }
}

export async function getPublishedCourseProfile(slug: string) {
  const direct = await prisma.courseProfile.findFirst({
    where: {
      canonicalSlug: slug,
      status: { in: [...PUBLIC_COURSE_PROFILE_STATUSES] },
      course: { isPublic: true }
    },
    include: {
      course: {
        include: {
          bookingFacts: {
            orderBy: { holes: "asc" }
          }
        }
      },
      sources: { orderBy: [{ sourceType: "asc" }, { publisher: "asc" }] }
    }
  });
  if (direct) return { profile: direct, redirectSlug: null };
  const alias = await prisma.courseProfileSlugAlias.findUnique({
    where: { slug },
    include: {
      courseProfile: {
        include: {
          course: {
            include: {
              bookingFacts: {
                orderBy: { holes: "asc" }
              }
            }
          },
          sources: true
        }
      }
    }
  });
  if (
    !alias ||
    !alias.courseProfile.course.isPublic ||
    !PUBLIC_COURSE_PROFILE_STATUSES.includes(alias.courseProfile.status)
  ) return null;
  return { profile: alias.courseProfile, redirectSlug: alias.courseProfile.canonicalSlug };
}

export async function listPublishedCourseAlertProfiles() {
  return prisma.courseProfile.findMany({
    where: {
      status: { in: [...PUBLIC_COURSE_PROFILE_STATUSES] },
      course: {
        isPublic: true,
        automationEligibility: "ALLOWED"
      }
    },
    orderBy: [
      { course: { stateCode: "asc" } },
      { course: { city: "asc" } },
      { course: { name: "asc" } }
    ],
    select: {
      canonicalSlug: true,
      accessSummary: true,
      updatedAt: true,
      course: {
        select: {
          name: true,
          city: true,
          stateCode: true
        }
      }
    }
  });
}

export async function listPublishedDirectCourseProfiles() {
  return prisma.courseProfile.findMany({
    where: {
      status: { in: [...PUBLIC_COURSE_PROFILE_STATUSES] },
      course: {
        isPublic: true,
        automationEligibility: { not: "ALLOWED" }
      }
    },
    orderBy: [
      { course: { stateCode: "asc" } },
      { course: { city: "asc" } },
      { course: { name: "asc" } }
    ],
    select: {
      canonicalSlug: true,
      accessSummary: true,
      updatedAt: true,
      course: {
        select: {
          name: true,
          city: true,
          stateCode: true
        }
      }
    }
  });
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
    where: {
      id: { not: course.id },
      isPublic: true,
      automationEligibility: "ALLOWED",
      profile: { status: { in: [...PUBLIC_COURSE_PROFILE_STATUSES] } }
    },
    select: { id: true, name: true, city: true, stateCode: true, latitude: true, longitude: true, profile: { select: { canonicalSlug: true } } }
  });
  return candidates
    .map((candidate) => ({ ...candidate, distanceMiles: haversineMiles(course, candidate) }))
    .filter((candidate) => candidate.distanceMiles <= 50 || candidate.stateCode === course.stateCode)
    .sort((left, right) => left.distanceMiles - right.distanceMiles)
    .slice(0, 4);
}

async function markCourseProfileBlocked(courseId: string, failureReason: string) {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: {
      id: true,
      name: true,
      city: true,
      stateCode: true,
      profile: {
        select: {
          canonicalSlug: true,
          publishedAt: true
        }
      }
    }
  });
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
    update: {
      status: course.profile?.publishedAt ? "STALE" : "BLOCKED_EVIDENCE",
      failureReason: failureReason.slice(0, 1000),
      lastResearchAttemptAt: new Date(),
      failedResearchAt: new Date()
    }
  });
}

function getCourseProfileQueueDate(course: {
  createdAt: Date;
  profile: {
    createdAt: Date;
    reviewDueAt: Date | null;
  } | null;
}) {
  return (
    course.profile?.reviewDueAt ??
    course.profile?.createdAt ??
    course.createdAt
  );
}

function profileCreateData(courseId: string, canonicalSlug: string, draft: CourseProfileDraft, contentHash: string, verifiedAt: Date, reviewDueAt: Date, now: Date): Prisma.CourseProfileCreateInput {
  return {
    course: { connect: { id: courseId } }, canonicalSlug, status: "PUBLISHED", courseType: draft.courseType,
    accessSummary: draft.accessSummary, overview: draft.overview, courseCharacter: draft.courseCharacter,
    notableFacts: draft.notableFacts, contentHash, profileVerifiedAt: verifiedAt, reviewDueAt,
    publishedAt: now, lastResearchAttemptAt: now, lastRefreshedAt: now, failedResearchAt: null
  };
}

const COURSE_PROFILE_RESEARCH_REDIRECT_LIMIT = 3;
const COURSE_PROFILE_RESEARCH_MAX_RESPONSE_BYTES = 400_000;
const COURSE_PROFILE_RESEARCH_TIMEOUT_MS = 10_000;

export function createCourseProfilePublicFetchTransport(
  dependencies: AddressPinnedPublicFetchDependencies = {}
) {
  return createAddressPinnedPublicFetchTransport(
    {
      parseUrl: parseCourseProfilePublicUrl,
      maxResponseBytes: COURSE_PROFILE_RESEARCH_MAX_RESPONSE_BYTES,
      // The service follows redirects manually so each hop is independently
      // revalidated and address-pinned before any bytes are read.
      redirectLimit: 0,
      timeoutMs: COURSE_PROFILE_RESEARCH_TIMEOUT_MS
    },
    dependencies
  );
}

const courseProfilePublicFetch = createCourseProfilePublicFetchTransport();

type CourseProfileResearchPage = {
  url: string;
  status: number | null;
  text: string | null;
  error?: string;
  evidenceText: string | null;
  pageIdentities: string[];
};

type FreshCourseProfileSource = {
  sourceUrl: string;
  page: CourseProfileResearchPage;
};

function getCourseProfileApplySourceUrls(draft: CourseProfileDraft) {
  const sourceUrls = [
    ...draft.sources.map((source) => source.url),
    draft.officialWebsiteUrl,
    draft.physicalLayout?.evidenceUrl,
    draft.par?.evidenceUrl
  ].filter((value): value is string => Boolean(value));
  const normalized = sourceUrls.map((sourceUrl) => {
    const safeUrl = getSafeCourseProfileResearchUrl(sourceUrl);
    if (!safeUrl) {
      throw new Error(
        "A course profile source cannot be freshly verified as a public signed-out page."
      );
    }
    return safeUrl;
  });
  return [...new Set(normalized)];
}

function assertFreshCourseProfileSources(
  course: {
    name: string;
    address: string | null;
    city: string | null;
    stateCode: string | null;
    layoutHoleCounts: readonly unknown[];
  },
  draft: CourseProfileDraft,
  sources: readonly FreshCourseProfileSource[]
) {
  const pages = new Map(
    sources.map(({ sourceUrl, page }) => [normalizeCourseProfileSourceUrl(sourceUrl), page])
  );
  const unavailable = sources.filter(
    ({ page }) =>
      page.status === null ||
      page.status < 200 ||
      page.status >= 300 ||
      typeof page.text !== "string" ||
      !page.text.trim()
  );
  if (unavailable.length > 0) {
    throw new Error(
      "Course profile source freshness verification failed for one or more public pages."
    );
  }

  if (draft.officialWebsiteUrl) {
    const page = pages.get(
      normalizeCourseProfileSourceUrl(draft.officialWebsiteUrl)
    );
    if (
      !page ||
      !doesFreshOfficialWebsiteCorroborateCourse(course, draft, page)
    ) {
      throw new Error(
        "Fresh official website evidence does not corroborate the selected course identity and locality."
      );
    }
  }

  if (draft.physicalLayout) {
    const page = pages.get(
      normalizeCourseProfileSourceUrl(draft.physicalLayout.evidenceUrl)
    );
    if (
      !page?.text ||
      !draft.physicalLayout.holeCounts.every((holes) =>
        doesFreshProfileTextCorroborateHoleCount(page.text!, holes)
      )
    ) {
      throw new Error(
        "Fresh physical-layout evidence no longer corroborates every requested hole count."
      );
    }
  }

  if (draft.par) {
    const page = pages.get(normalizeCourseProfileSourceUrl(draft.par.evidenceUrl));
    if (!page?.text || !doesFreshProfileTextCorroboratePar(page.text, draft.par.value)) {
      throw new Error("Fresh course-profile evidence no longer corroborates the requested par.");
    }
  }
}

function hashFreshCourseProfileEvidence(
  draft: CourseProfileDraft,
  sources: readonly FreshCourseProfileSource[]
) {
  const sourceEvidence = sources
    .map(({ sourceUrl, page }) => ({
      sourceUrl: normalizeCourseProfileSourceUrl(sourceUrl),
      finalUrl: page.url,
      status: page.status,
      textHash: createHash("sha256")
        .update(page.evidenceText ?? page.text ?? "")
        .digest("hex")
    }))
    .sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  return createHash("sha256")
    .update(
      JSON.stringify({
        draftHash: hashCourseProfileDraft(draft),
        sourceEvidence
      })
    )
    .digest("hex");
}

function doesFreshProfileTextCorroborateHoleCount(text: string, holes: 9 | 18) {
  const word = holes === 9 ? "nine" : "eighteen";
  return new RegExp(
    `\\b(?:${holes}|${word})(?:\\s*[- ]?\\s*holes?)\\b`,
    "iu"
  ).test(text);
}

function doesFreshProfileTextCorroboratePar(text: string, par: number) {
  return new RegExp(
    `(?:\\bpar\\s*(?:of\\s*)?[-:]?\\s*${par}\\b|\\b${par}\\s*[- ]?\\s*par\\b)`,
    "iu"
  ).test(text);
}

function normalizeCourseProfileSourceUrl(value: string) {
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.toString();
}

function doesFreshOfficialWebsiteCorroborateCourse(
  course: {
    name: string;
    city: string | null;
    stateCode: string | null;
    layoutHoleCounts: readonly unknown[];
  },
  draft: CourseProfileDraft,
  page: CourseProfileResearchPage
) {
  const verifiedLayouts =
    draft.physicalLayout?.holeCounts ?? course.layoutHoleCounts;
  const identityCorroborated = page.pageIdentities
    .flatMap(getCourseProfileIdentityVariants)
    .some((identity) =>
      haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
        course.name,
        identity,
        verifiedLayouts
      )
    );
  if (!identityCorroborated || !page.evidenceText) return false;

  const localityAnchors = [
    ...(course.city && course.stateCode
      ? [
          {
            city: course.city,
            stateCode: course.stateCode,
            stateName:
              course.stateCode === draft.location.stateCode
                ? draft.location.stateName
                : null
          }
        ]
      : []),
    {
      city: draft.location.city,
      stateCode: draft.location.stateCode,
      stateName: draft.location.stateName
    }
  ].filter(
    (anchor, index, anchors) =>
      anchors.findIndex(
        (candidate) =>
          candidate.city.toLocaleLowerCase("en-US") ===
            anchor.city.toLocaleLowerCase("en-US") &&
          candidate.stateCode.toLocaleUpperCase("en-US") ===
            anchor.stateCode.toLocaleUpperCase("en-US")
      ) === index
  );

  return localityAnchors.every(
    ({ city, stateCode, stateName }) =>
      freshProfileTextContainsPhrase(page.evidenceText!, city) &&
      [stateCode, stateName]
        .filter((value): value is string => Boolean(value))
        .some((value) =>
          freshProfileTextContainsPhrase(page.evidenceText!, value)
        )
  );
}

function getCourseProfileIdentityVariants(value: string) {
  return [value, ...value.split(/\s+(?:\||-|\u2013|\u2014)\s+/gu)]
    .map(normalizeOfficialPagePresentationIdentity)
    .map((identity) => identity.trim())
    .filter(Boolean);
}

function freshProfileTextContainsPhrase(text: string, phrase: string) {
  const normalize = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/gu, " ")
      .trim();
  const normalizedPhrase = normalize(phrase);
  return Boolean(
    normalizedPhrase &&
      ` ${normalize(text)} `.includes(` ${normalizedPhrase} `)
  );
}

function parseCourseProfilePublicUrl(value: string) {
  const parsed = new URL(value);
  if (!isSafeManualEvidenceUrl(parsed)) {
    throw new Error("Course profile source is not a safe public page.");
  }
  return parsed;
}

function getSafeCourseProfileResearchUrl(value: string | null) {
  if (!value) return null;
  try {
    return parseCourseProfilePublicUrl(value).toString();
  } catch {
    return null;
  }
}

async function fetchResearchPage(
  url: string,
  publicFetch: typeof fetch
): Promise<CourseProfileResearchPage> {
  try {
    let currentUrl = parseCourseProfilePublicUrl(url);
    for (let redirectCount = 0; redirectCount <= COURSE_PROFILE_RESEARCH_REDIRECT_LIMIT; redirectCount += 1) {
      const response = await publicFetch(currentUrl, {
        headers: { "User-Agent": "TeeTimeSpotCourseResearch/1.0 (+https://teetimespot.com/about)" },
        redirect: "manual",
        signal: AbortSignal.timeout(COURSE_PROFILE_RESEARCH_TIMEOUT_MS)
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === COURSE_PROFILE_RESEARCH_REDIRECT_LIMIT) {
          return {
            url: currentUrl.toString(),
            status: response.status,
            text: null,
            evidenceText: null,
            pageIdentities: []
          };
        }
        let redirectUrl: URL;
        try {
          redirectUrl = parseCourseProfilePublicUrl(
            new URL(location, currentUrl).toString()
          );
        } catch {
          return {
            url: currentUrl.toString(),
            status: response.status,
            text: null,
            evidenceText: null,
            pageIdentities: []
          };
        }
        currentUrl = redirectUrl;
        continue;
      }
      if (!response.ok) {
        return {
          url: currentUrl.toString(),
          status: response.status,
          text: null,
          evidenceText: null,
          pageIdentities: []
        };
      }
      const html = (await response.text()).slice(
        0,
        COURSE_PROFILE_RESEARCH_MAX_RESPONSE_BYTES
      );
      const evidenceText = getCourseProfileHtmlText(html);
      return {
        url: currentUrl.toString(),
        status: response.status,
        text: evidenceText.slice(0, 8_000),
        evidenceText,
        pageIdentities: getCourseProfilePageIdentities(html)
      };
    }
    return {
      url,
      status: null,
      text: null,
      error: "Fresh public source exceeded the redirect limit.",
      evidenceText: null,
      pageIdentities: []
    };
  } catch {
    return {
      url,
      status: null,
      text: null,
      error: "Fresh public source could not be read safely.",
      evidenceText: null,
      pageIdentities: []
    };
  }
}

function getCourseProfilePageIdentities(html: string) {
  return [
    ...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/giu),
    ...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/giu)
  ]
    .map((match) => getCourseProfileHtmlText(match[1] ?? ""))
    .filter(Boolean);
}

function getCourseProfileHtmlText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;|&#38;/giu, "&")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&lt;|&#60;/giu, "<")
    .replace(/&gt;|&#62;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
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
