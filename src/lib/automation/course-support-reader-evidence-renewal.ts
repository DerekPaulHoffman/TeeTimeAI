import { createHash } from "node:crypto";
import type { LocalReaderJob, Prisma } from "@prisma/client";
import { z } from "zod";
import { getLocalReaderCourse, getLocalReaderCourseKey, getLocalReaderJobUrl } from "@/lib/local-reader/course-key";
import { localReaderResultSchema, validateLocalReaderResultForJob } from "@/lib/local-reader/contracts";
import { createLocalReaderCourseVerificationKey } from "@/lib/local-reader/course-verification-key";
import { isSafeManualEvidenceUrl } from "./browser-discovery";
import { stableCourseProviderExecutionEvidenceValue } from "./course-provider-execution-evidence";

export const READER_EVIDENCE_RENEWAL_BASIS = "LEGACY_UNANCHORED_READER_EVIDENCE_RENEWAL" as const;
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const renewalSchema = z.object({
  kind: z.literal(READER_EVIDENCE_RENEWAL_BASIS),
  historicalJobId: z.string().min(1), historicalJobFingerprint: fingerprint,
  historicalVerificationKey: fingerprint, historicalTargetDate: localDate,
  historicalPlayers: z.number().int().min(1).max(4),
  newTargetDateAtAdmission: localDate, newPlayersAtAdmission: z.literal(1),
}).strict();
export type CourseSupportReaderEvidenceRenewal = z.infer<typeof renewalSchema>;

export function createCourseSupportReaderRenewalJobFingerprint(job: LocalReaderJob) {
  return createHash("sha256").update(stableCourseProviderExecutionEvidenceValue(job)).digest("hex");
}

export async function readCourseSupportReaderRenewalJobs(
  database: Partial<Pick<Prisma.TransactionClient, "localReaderJob">>,
  input: { courseId: string; bookingUrl: string | null; batchCreatedAt: Date },
) {
  const courseKey = getLocalReaderCourseKey(input.bookingUrl);
  if (!database.localReaderJob?.findMany || !courseKey || !Number.isFinite(input.batchCreatedAt.getTime())) return null;
  return database.localReaderJob.findMany({
    where: { courseId: input.courseId, courseKey, purpose: "COURSE_VERIFICATION",
      OR: [{ createdAt: { gte: input.batchCreatedAt } }, { claimedAt: { gte: input.batchCreatedAt } }, { completedAt: { gte: input.batchCreatedAt } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 2,
  });
}

export function assessCourseSupportReaderEvidenceRenewal(input: {
  jobs: readonly LocalReaderJob[] | null | undefined;
  courseId: string; courseName: string; bookingUrl: string | null;
  requiredCapabilityKey: string; requiredParserVersion: number;
  targetDateLocal: string | undefined; players: number | undefined;
  startedReaderAt: Date; requestUpdatedAt: Date; batchCompletedAt: Date;
  currentIntent: { targetDateLocal: string; players: number }; now: Date;
}): CourseSupportReaderEvidenceRenewal | null {
  if (input.jobs?.length !== 1) return null;
  const job = input.jobs[0]!;
  const courseKey = getLocalReaderCourseKey(input.bookingUrl);
  const course = courseKey && getLocalReaderCourse(courseKey, input.courseName);
  const result = localReaderResultSchema.safeParse(job.result);
  const parserName = input.requiredCapabilityKey === "PROPHET_FREAR_RENDERED"
    ? "legacy-prophet" : input.requiredCapabilityKey.replace(/_RENDERED$/u, "").toLowerCase();
  if (!courseKey || !course || !result.success ||
    job.courseId !== input.courseId || job.courseKey !== courseKey || job.teeSearchId !== null || job.scheduleVersion !== null ||
    job.purpose !== "COURSE_VERIFICATION" || job.status !== "COMPLETED" ||
    job.requiredCapabilityKey !== input.requiredCapabilityKey || job.requiredParserVersion !== input.requiredParserVersion ||
    job.targetDate !== input.targetDateLocal || job.players !== input.players ||
    !localDate.safeParse(job.targetDate).success || !localDate.safeParse(input.currentIntent.targetDateLocal).success ||
    job.targetDate >= input.currentIntent.targetDateLocal || input.currentIntent.players !== 1 ||
    ![job.createdAt, job.claimedAt, job.completedAt, job.jobExpiresAt, job.resultExpiresAt, job.updatedAt,
      input.startedReaderAt, input.requestUpdatedAt, input.batchCompletedAt, input.now].every(
      (value) => value instanceof Date && Number.isFinite(value.getTime()),
    ) || !job.claimedAt || !job.completedAt || !job.resultExpiresAt ||
    job.createdAt < input.startedReaderAt || job.claimedAt < job.createdAt || job.completedAt < job.claimedAt ||
    job.completedAt > input.requestUpdatedAt || job.completedAt > input.batchCompletedAt ||
    job.completedAt > job.jobExpiresAt || job.updatedAt < job.completedAt || job.updatedAt > input.now ||
    job.resultExpiresAt <= job.completedAt || job.resultExpiresAt > input.now ||
    result.data.status !== "NO_AVAILABILITY" || result.data.evidenceAnchor !== undefined ||
    Date.parse(result.data.observedAt) === job.claimedAt.getTime() || result.data.readerVersion !== job.readerVersion ||
    Date.parse(result.data.observedAt) < job.claimedAt.getTime() || Date.parse(result.data.observedAt) > job.completedAt.getTime() ||
    result.data.readerVersion !== `${parserName}-rendered-v${input.requiredParserVersion}` ||
    !isSafeManualEvidenceUrl(new URL(result.data.pageUrl)) ||
    job.bookingUrl !== getLocalReaderJobUrl(courseKey, job.targetDate, job.players) ||
    job.verificationKey !== createLocalReaderCourseVerificationKey(input.courseId, job.targetDate, job.players)
  ) return null;
  try {
    validateLocalReaderResultForJob({
      id: job.id, courseKey, targetDate: job.targetDate, players: job.players,
      requestedAt: job.createdAt.toISOString(), expiresAt: job.jobExpiresAt.toISOString(),
      courseName: course.courseName, bookingUrl: job.bookingUrl, cardTextIncludes: [...course.cardTextIncludes],
      requiredCapability: { key: input.requiredCapabilityKey, parserVersion: input.requiredParserVersion },
    }, result.data);
  } catch { return null; }
  const newKey = createLocalReaderCourseVerificationKey(input.courseId, input.currentIntent.targetDateLocal, input.currentIntent.players);
  if (newKey === job.verificationKey) return null;
  return {
    kind: READER_EVIDENCE_RENEWAL_BASIS, historicalJobId: job.id,
    historicalJobFingerprint: createCourseSupportReaderRenewalJobFingerprint(job),
    historicalVerificationKey: job.verificationKey, historicalTargetDate: job.targetDate, historicalPlayers: job.players,
    newTargetDateAtAdmission: input.currentIntent.targetDateLocal, newPlayersAtAdmission: 1,
  };
}

/** Read the existing one-shot receipt at the actual queue tuple; never rewrite its historical job. */
export async function readCourseSupportReaderRenewalQueueGuard(
  database: Pick<Prisma.TransactionClient, "courseMonitoringEvent" | "localReaderJob">,
  input: { courseId: string; incidentId: string; cycle: number; targetDate: string; players: number; bookingUrl: string },
): Promise<{ historicalVerificationKey: string } | undefined> {
  const receipt = await database.courseMonitoringEvent.findUnique({
    where: { idempotencyKey: `course-support-started-local-reader-continuation:${input.incidentId}:${input.cycle}:LOCAL_READER` },
    select: { courseId: true, incidentId: true, source: true, eventType: true, audit: true },
  });
  const audit = receipt?.audit && typeof receipt.audit === "object" && !Array.isArray(receipt.audit)
    ? receipt.audit as Record<string, unknown> : {};
  if (audit.readerEvidenceRenewal === undefined && audit.proofBasis !== READER_EVIDENCE_RENEWAL_BASIS) return undefined;
  const parsed = renewalSchema.safeParse(audit.readerEvidenceRenewal);
  if (!parsed.success || receipt?.courseId !== input.courseId || receipt.incidentId !== input.incidentId ||
    receipt.source !== "COURSE_SUPPORT_RESPONDER" || receipt.eventType !== "REVALIDATION_REQUESTED" ||
    audit.cycle !== input.cycle || audit.oneShot !== true || audit.proofBasis !== READER_EVIDENCE_RENEWAL_BASIS ||
    audit.priorRequestOutcome !== null || audit.priorRequestProviderExecution !== "UNKNOWN") {
    throw new Error("The reader evidence-renewal receipt is unavailable or changed.");
  }
  const proof = parsed.data;
  const oldJob = await database.localReaderJob.findUnique({ where: { id: proof.historicalJobId } });
  const actualKey = createLocalReaderCourseVerificationKey(input.courseId, input.targetDate, input.players);
  if (!oldJob || oldJob.courseId !== input.courseId || oldJob.courseKey !== getLocalReaderCourseKey(input.bookingUrl) ||
    createCourseSupportReaderRenewalJobFingerprint(oldJob) !== proof.historicalJobFingerprint ||
    oldJob.verificationKey !== proof.historicalVerificationKey ||
    proof.historicalVerificationKey !== createLocalReaderCourseVerificationKey(input.courseId, proof.historicalTargetDate, proof.historicalPlayers) ||
    !localDate.safeParse(input.targetDate).success || input.targetDate < proof.newTargetDateAtAdmission ||
    input.targetDate <= proof.historicalTargetDate || input.players !== proof.newPlayersAtAdmission || actualKey === proof.historicalVerificationKey) {
    throw new Error("The reader evidence-renewal queue would reuse or change historical evidence.");
  }
  return { historicalVerificationKey: proof.historicalVerificationKey };
}
