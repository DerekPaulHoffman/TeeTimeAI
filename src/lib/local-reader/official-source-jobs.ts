import { randomUUID } from "node:crypto";
import { Prisma, type LocalReaderJob } from "@prisma/client";
import { z } from "zod";

import { runSerializedCourseMonitoringWrite } from "@/lib/automation/course-monitoring";
import { runCourseSupportBrowserPersistenceWrite, type CourseSupportBrowserPersistenceFence } from "@/lib/automation/course-support-browser-stages";
import { buildCourseSupportProviderSnapshotFingerprint } from "@/lib/automation/course-support-verification";
import { prisma } from "@/lib/prisma";
import { createOfficialSourceContextKey, normalizeOfficialSourceUrl, OFFICIAL_SOURCE_CAPABILITY, OFFICIAL_SOURCE_LIFETIME_MS,
  officialSourceJobSchema, officialSourceResultSchema, validateOfficialSourceResult, type OfficialSourceJob } from "./official-source-contracts";

const storedContextSchema = z.object({
  job: officialSourceJobSchema,
  providerSnapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  fence: z.object({ batchId: z.string().min(1), leaseToken: z.string().min(1), ownerThreadId: z.string().min(1),
    releaseSha: z.string().regex(/^[a-f0-9]{40}$/u), runtimeVersion: z.string().regex(/^[a-f0-9]{40}$/u),
    deployedAt: z.string().datetime(), incidentId: z.string().min(1), courseId: z.string().min(1), cycle: z.number().int().min(0),
    stage: z.enum(["RENDERED_BROWSER_DISCOVERY", "INDEPENDENT_CONFIRMATION"]),
  }).strict(),
}).strict();

function readContext(row: LocalReaderJob) {
  const stored = storedContextSchema.parse(row.sourceContext);
  const fence = { ...stored.fence, deployedAt: new Date(stored.fence.deployedAt) };
  if (row.purpose !== "OFFICIAL_SOURCE_DISCOVERY" || row.teeSearchId !== null || row.scheduleVersion !== null ||
    row.id !== stored.job.id || row.courseId !== stored.job.course.id || row.bookingUrl !== stored.job.sourceUrl ||
    row.courseKey !== stored.job.courseKey || row.requiredCapabilityKey !== OFFICIAL_SOURCE_CAPABILITY ||
    row.requiredParserVersion !== 1 || row.jobExpiresAt.toISOString() !== stored.job.expiresAt ||
    stored.job.contextKey !== createOfficialSourceContextKey({ ...stored, fence, course: stored.job.course })) {
    throw new Error("Official source job binding changed");
  }
  return { ...stored, fence };
}

async function assertCurrentSource(transaction: Prisma.TransactionClient, input: {
  fence: CourseSupportBrowserPersistenceFence; course: OfficialSourceJob["course"]; providerSnapshotFingerprint: string;
}) {
  const clock = await transaction.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Source job database clock unavailable");
  const [course, batch] = await Promise.all([
    transaction.course.findUnique({ where: { id: input.course.id } }),
    transaction.courseSupportBatch.findUnique({ where: { id: input.fence.batchId }, select: { leaseExpiresAt: true } }),
  ]);
  if (!course || !batch?.leaseExpiresAt || batch.leaseExpiresAt <= now ||
    buildCourseSupportProviderSnapshotFingerprint(course) !== input.providerSnapshotFingerprint ||
    ["id", "name", "address", "city", "stateCode", "timeZone", "website"].some(key =>
      course[key as keyof typeof course] !== input.course[key as keyof typeof input.course])) {
    throw new Error("Official source course or ownership changed");
  }
  return now;
}

export async function assertOwnedOfficialSourceJobInTransaction(transaction: Prisma.TransactionClient, row: LocalReaderJob) {
  const context = readContext(row);
  return runCourseSupportBrowserPersistenceWrite({ transaction, fence: context.fence,
    runtimeVersion: context.fence.runtimeVersion, mutate: async transaction => {
      const now = await assertCurrentSource(transaction, { ...context, course: context.job.course });
      if (row.jobExpiresAt <= now) throw new Error("Official source job expired");
      return { ...context, now };
    } });
}

export async function buildOwnedOfficialSourceClaim(row: LocalReaderJob, leaseToken: string, leaseExpiresAt: Date) {
  const { job } = await runSerializedCourseMonitoringWrite(row.courseId,
    transaction => assertOwnedOfficialSourceJobInTransaction(transaction, row));
  return { ...job, leaseToken, leaseExpiresAt: leaseExpiresAt.toISOString(),
    bookingUrl: job.sourceUrl, courseName: job.course.name, cardTextIncludes: [],
    requiredCapability: { key: OFFICIAL_SOURCE_CAPABILITY, parserVersion: 1 } };
}

/** Pending returns without a stage attempt. The existing owned verification
 * watch polls this same durable job, and cannot replace an expired observation.
 */
export async function getOwnedOfficialSourceObservation(input: {
  fence: CourseSupportBrowserPersistenceFence;
  course: OfficialSourceJob["course"];
  providerSnapshotFingerprint: string;
}) {
  const sourceUrl = normalizeOfficialSourceUrl(input.course.website);
  if (!sourceUrl) throw new Error("Official source is outside the approved origin");
  const contextKey = createOfficialSourceContextKey(input);
  return runSerializedCourseMonitoringWrite(input.course.id, transaction =>
    runCourseSupportBrowserPersistenceWrite({ transaction, fence: input.fence, mutate: async transaction => {
      const now = await assertCurrentSource(transaction, input);
      const existing = await transaction.localReaderJob.findUnique({ where: { verificationKey: `official-source:${contextKey}` } });
      if (existing) {
        const context = readContext(existing);
        if (existing.jobExpiresAt <= now || ["EXPIRED", "FAILED"].includes(existing.status)) return { status: "EXPIRED" as const };
        if (existing.status !== "COMPLETED") return { status: "PENDING" as const };
        const result = officialSourceResultSchema.parse(existing.result);
        validateOfficialSourceResult(context.job, result, now);
        if (!existing.claimedAt || result.observedAt !== existing.claimedAt.toISOString()) throw new Error("Source observation lacks server claim timing");
        return { status: "READY" as const, job: context.job, result, now };
      }
      const job = officialSourceJobSchema.parse({ id: randomUUID(), purpose: "OFFICIAL_SOURCE_DISCOVERY",
        courseKey: "official-source:parks.cityofomaha.org", contextKey, course: input.course, sourceUrl,
        requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + OFFICIAL_SOURCE_LIFETIME_MS).toISOString() });
      await transaction.localReaderJob.create({ data: {
        id: job.id, purpose: "OFFICIAL_SOURCE_DISCOVERY", courseId: input.course.id, courseKey: job.courseKey,
        verificationKey: `official-source:${contextKey}`, targetDate: now.toISOString().slice(0, 10), players: 1,
        bookingUrl: sourceUrl, jobExpiresAt: new Date(job.expiresAt), createdAt: now,
        requiredCapabilityKey: OFFICIAL_SOURCE_CAPABILITY, requiredParserVersion: 1,
        sourceContext: { job, providerSnapshotFingerprint: input.providerSnapshotFingerprint,
          fence: { ...input.fence, deployedAt: input.fence.deployedAt.toISOString() } } as Prisma.InputJsonValue,
      } });
      return { status: "PENDING" as const };
    } }));
}

export async function expireInvalidOfficialSourceClaim(jobId: string) {
  await prisma.localReaderJob.updateMany({ where: { id: jobId, purpose: "OFFICIAL_SOURCE_DISCOVERY", status: "PENDING" },
    data: { status: "EXPIRED", completedAt: new Date() } });
}
