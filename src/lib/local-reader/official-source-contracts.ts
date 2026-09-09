import { createHash } from "node:crypto";
import { z } from "zod";

import type { CourseSupportBrowserPersistenceFence } from "@/lib/automation/course-support-browser-stages";
import { haveCompatibleTeeItUpCourseNames } from "@/lib/adapters/teeitup-facility-identity";

export const OFFICIAL_SOURCE_ORIGIN = "https://parks.cityofomaha.org";
export const OFFICIAL_SOURCE_CAPABILITY = "OFFICIAL_SOURCE_RENDERED";
export const OFFICIAL_SOURCE_PARSER_VERSION = 2;
export const OFFICIAL_SOURCE_LIFETIME_MS = 5 * 60_000;

export function normalizeOfficialSourceUrl(value: string) {
  try {
    const url = new URL(value);
    // The retained historical URL may be HTTP. Only HTTPS is ever requested.
    if (url.protocol === "http:" && url.hostname === "parks.cityofomaha.org") url.protocol = "https:";
    if (url.origin !== OFFICIAL_SOURCE_ORIGIN || url.username || url.password || url.search || url.hash ||
      !/^\/[a-z0-9/-]*$/u.test(url.pathname) ||
      /(?:login|signin|account|checkout|reserve|payment|captcha|challenge)/iu.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

const sourceUrl = z.string().url().max(2048).refine(value => normalizeOfficialSourceUrl(value) === value);
const boundedText = z.string().trim().min(1).max(160).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const identitySchema = z.object({
  id: boundedText, name: boundedText, address: z.string().min(1).max(500),
  city: boundedText, stateCode: boundedText, timeZone: boundedText, website: z.string().url(),
}).strict();

export const officialSourceJobSchema = z.object({
  id: boundedText,
  purpose: z.literal("OFFICIAL_SOURCE_DISCOVERY"),
  courseKey: z.literal("official-source:parks.cityofomaha.org"),
  contextKey: z.string().regex(/^[a-f0-9]{64}$/u),
  course: identitySchema,
  sourceUrl,
  requestedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict().superRefine((job, context) => {
  const lifetime = Date.parse(job.expiresAt) - Date.parse(job.requestedAt);
  if (lifetime <= 0 || lifetime > OFFICIAL_SOURCE_LIFETIME_MS ||
    normalizeOfficialSourceUrl(job.course.website) !== job.sourceUrl) {
    context.addIssue({ code: "custom", message: "Invalid retained source or job lifetime" });
  }
});

const bookingLinkSchema = z.object({
  label: z.literal("Book tee time"),
  url: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.book\.teeitup\.(?:com|golf)$/u.test(url.hostname) &&
      url.pathname === "/" && [...url.searchParams.keys()].every(key => key === "course") &&
      url.searchParams.getAll("course").length <= 1 && (!url.searchParams.has("course") ||
        /^[1-9]\d*(?:,[1-9]\d*){0,19}$/u.test(url.searchParams.get("course")!));
  }),
}).strict();

export const officialSourcePageSchema = z.object({
  pageUrl: sourceUrl,
  status: z.enum(["OBSERVED", "ACCESS_RESTRICTED"]),
  courseName: boundedText.nullable(), street: boundedText.nullable(),
  city: boundedText.nullable(), stateCode: boundedText.nullable(),
  bookingLinks: z.array(bookingLinkSchema).max(20),
  nextUrls: z.array(sourceUrl).max(12),
}).strict();

export const officialSourceResultSchema = z.object({
  purpose: z.literal("OFFICIAL_SOURCE_DISCOVERY"), jobId: boundedText,
  contextKey: z.string().regex(/^[a-f0-9]{64}$/u), observedAt: z.string().datetime(),
  readerVersion: z.literal("official-source-v1"),
  pages: z.array(officialSourcePageSchema).min(1).max(12),
}).strict();

export type OfficialSourceJob = z.infer<typeof officialSourceJobSchema>;
export type OfficialSourceResult = z.infer<typeof officialSourceResultSchema>;
export type OfficialSourcePage = z.infer<typeof officialSourcePageSchema>;

export function createOfficialSourceContextKey(input: {
  fence: CourseSupportBrowserPersistenceFence;
  providerSnapshotFingerprint: string;
  course: OfficialSourceJob["course"];
}) {
  const { fence, course, providerSnapshotFingerprint } = input;
  if (fence.courseId !== course.id || !/^[a-f0-9]{64}$/u.test(providerSnapshotFingerprint) ||
    fence.runtimeVersion !== fence.releaseSha || !normalizeOfficialSourceUrl(course.website)) {
    throw new Error("Invalid owned official source context");
  }
  return createHash("sha256").update(JSON.stringify([
    fence.batchId, fence.leaseToken, fence.ownerThreadId, fence.releaseSha,
    fence.deployedAt.toISOString(), fence.runtimeVersion, fence.incidentId,
    fence.courseId, fence.cycle, fence.stage, providerSnapshotFingerprint,
    course.id, course.name, course.address, course.city, course.stateCode, course.timeZone, course.website,
  ])).digest("hex");
}

function words(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function isCorroboratedOfficialSourcePage(page: OfficialSourcePage, course: OfficialSourceJob["course"]) {
  return page.status === "OBSERVED" && page.courseName !== null &&
    haveCompatibleTeeItUpCourseNames(course.name, page.courseName) &&
    /^\d+\s/u.test(page.street ?? "") && page.street === words(course.address.split(",")[0]) &&
    page.city === words(course.city) && page.stateCode === words(course.stateCode);
}

export function validateOfficialSourceResult(jobValue: OfficialSourceJob, resultValue: OfficialSourceResult, now: Date) {
  const job = officialSourceJobSchema.parse(jobValue);
  const result = officialSourceResultSchema.parse(resultValue);
  const observed = Date.parse(result.observedAt);
  if (!Number.isFinite(now.getTime()) || result.jobId !== job.id || result.contextKey !== job.contextKey ||
    observed < Date.parse(job.requestedAt) || observed > now.getTime() ||
    now.getTime() >= Date.parse(job.expiresAt)) throw new Error("Official source result is stale or belongs to another owned job");
  const navigationKey = (url: string) => url.replace(/\/$/u, "");
  const depths = new Map<string, number>([[navigationKey(job.sourceUrl), 0]]);
  const seen = new Set<string>();
  for (const [index, page] of result.pages.entries()) {
    // An initial same-origin redirect is allowed; subsequent visits must have
    // appeared in an earlier page's bounded, course-specific navigation list.
    const depth = index === 0 ? 0 : depths.get(navigationKey(page.pageUrl));
    if (depth === undefined || depth > 2 || seen.has(navigationKey(page.pageUrl))) throw new Error("Unbound official source navigation");
    seen.add(navigationKey(page.pageUrl));
    if (page.status === "ACCESS_RESTRICTED" && (page.bookingLinks.length || page.nextUrls.length ||
      page.courseName || page.street || page.city || page.stateCode)) throw new Error("Restricted source cannot authorize discovery");
    if (page.bookingLinks.length && !isCorroboratedOfficialSourcePage(page, job.course)) throw new Error("Booking links lack course identity");
    for (const next of page.nextUrls) if (!depths.has(navigationKey(next))) depths.set(navigationKey(next), depth + 1);
  }
  return { job, result };
}
