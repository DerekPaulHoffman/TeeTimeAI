import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { acquireCourseMonitoringWriteLockInTransaction } from "@/lib/automation/course-monitoring";
import { getCourseLocalDateStorageBoundary } from "@/lib/automation/date-boundary";
import { DEFAULT_SYNTHETIC_TEST_WINDOW_MINUTES, syntheticTestWindowSchema } from "@/lib/automation/synthetic-test-window";
import { lockSearchForAlertMutation } from "@/lib/email/search-delivery-outbox";
import { prisma } from "@/lib/prisma";
import { buildAlertGenerationStartMarker } from "@/lib/searches/generation-clock";
import { zonedDateTimeToDate } from "@/lib/timezones";

export const SYNTHETIC_REACTIVATION_PROMPT_VERSION = "operator-synthetic-reactivation-v1";
const timestamp = z.string().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
});
const reference = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
export const syntheticReactivationInputSchema = z.object({
  searchId: reference,
  actorId: reference,
  idempotencyKey: reference,
  expectedScheduleVersion: z.number().int().nonnegative().safe(),
  expectedAlertGeneration: z.number().int().nonnegative().safe(),
  expectedUpdatedAt: timestamp,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }),
  durationMinutes: z.number().int().min(1).max(18 * 60).default(DEFAULT_SYNTHETIC_TEST_WINDOW_MINUTES),
}).strict();

const searchSelect = {
  id: true, userId: true, status: true, trafficClass: true, syntheticMultiCycle: true,
  syntheticTestWindow: true, createdAt: true, updatedAt: true, date: true,
  startTime: true, endTime: true, userTimeZone: true, players: true,
  scheduleVersion: true, alertGeneration: true, checkStatus: true,
  workflowRunId: true, checkLeaseToken: true, checkLeaseExpiresAt: true,
  preferences: {
    take: 6, orderBy: { rank: "asc" },
    select: { courseId: true, rank: true, course: {
      select: { timeZone: true, supportIncident: { select: { activeBatchId: true } } },
    } },
  },
} as const satisfies Prisma.TeeSearchSelect;
type Search = Prisma.TeeSearchGetPayload<{ select: typeof searchSelect }>;
type Input = z.infer<typeof syntheticReactivationInputSchema>;

const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("EXPLICIT_SYNTHETIC_REACTIVATION"),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  searchDigest: z.string().regex(/^[a-f0-9]{64}$/),
  date: z.string(),
  scheduleVersion: z.number().int().nonnegative().safe(),
  window: syntheticTestWindowSchema,
}).passthrough();

export type SyntheticReactivationResult = {
  outcome: "ready" | "queued_for_recovery" | "already_applied";
  applied: boolean;
  replayed: boolean;
  selectedSearchCount: 1;
  scheduleVersion: number;
  alertGeneration: number;
  expiresAt: string;
  providerCalls: 0;
  emailSendCalls: 0;
  workflowStartCalls: 0;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message: string): never {
  throw new Error(`Synthetic reactivation: ${message}`);
}

function assertSnapshot(search: Search | null, input: Input, now: Date): asserts search is Search {
  if (!search || search.status !== "PAUSED" || !search.syntheticMultiCycle ||
      !["TEST", "AUTOMATION"].includes(search.trafficClass)) fail("selected search is not a paused multi-cycle test");
  if (search.scheduleVersion !== input.expectedScheduleVersion ||
      search.alertGeneration !== input.expectedAlertGeneration ||
      search.updatedAt.toISOString() !== input.expectedUpdatedAt) fail("expected search state changed");
  if (!Number.isSafeInteger(search.scheduleVersion + 1) || !Number.isSafeInteger(search.alertGeneration + 1)) fail("invalid generation");
  if (search.workflowRunId || search.checkStatus === "CHECKING" || search.checkLeaseToken ||
      (search.checkLeaseExpiresAt && search.checkLeaseExpiresAt > now)) fail("search still has execution ownership");
  if (search.preferences.length < 1 || search.preferences.length > 5 ||
      new Set(search.preferences.map((preference) => preference.courseId)).size !== search.preferences.length) fail("invalid preference scope");
  if (search.preferences.some((preference) => preference.course.supportIncident?.activeBatchId)) fail("course has responder ownership");
  if (!Number.isFinite(search.createdAt.getTime()) || search.createdAt > now) fail("invalid creation clock");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(search.startTime) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(search.endTime) || search.endTime <= search.startTime) fail("invalid existing time window");
  const date = new Date(`${input.date}T00:00:00.000Z`);
  for (const preference of search.preferences) {
    const zone = preference.course.timeZone;
    try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(now); }
    catch { fail("invalid course time zone"); }
    if (date <= getCourseLocalDateStorageBoundary(zone, now) ||
        zonedDateTimeToDate(`${input.date}T${search.startTime}:00`, zone) <= now) fail("play date is not future for every course");
  }
}

async function databaseNow(transaction: Prisma.TransactionClient) {
  const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) fail("database clock unavailable");
  return clock.now;
}

async function assertNoPendingExecution(transaction: Prisma.TransactionClient, search: Search, now: Date) {
  const courseIds = search.preferences.map((preference) => preference.courseId);
  const [reader, verification, delivery] = await Promise.all([
    transaction.localReaderJob.findFirst({
      where: { OR: [{ teeSearchId: search.id }, { courseId: { in: courseIds } }],
        status: { in: ["PENDING", "LEASED"] } }, select: { id: true },
    }),
    transaction.courseSupportVerificationRequest.findFirst({
      where: { courseId: { in: courseIds }, status: { in: ["QUEUED", "CHECKING"] },
        OR: [{ deadlineAt: { gt: now } }, { leaseExpiresAt: { gt: now } }] }, select: { id: true },
    }),
    transaction.searchEmailDelivery.findFirst({
      where: { teeSearchId: search.id, status: "SENDING" }, select: { id: true },
    }),
  ]);
  if (reader || verification || delivery) fail("reader, provider verification, or delivery work is still pending");
}

function summary(outcome: SyntheticReactivationResult["outcome"], scheduleVersion: number,
  window: z.infer<typeof syntheticTestWindowSchema>): SyntheticReactivationResult {
  return { outcome, applied: outcome === "queued_for_recovery", replayed: outcome === "already_applied",
    selectedSearchCount: 1, scheduleVersion, alertGeneration: window.alertGeneration,
    expiresAt: window.expiresAt, providerCalls: 0, emailSendCalls: 0, workflowStartCalls: 0 };
}

/** Explicit operator-only renewal. Dry-run by default; never starts local Workflow or sends email. */
export async function reactivateSyntheticTestSearch(rawInput: unknown, options: {
  apply?: boolean;
  runtimeVersion: string;
}): Promise<SyntheticReactivationResult> {
  const input = syntheticReactivationInputSchema.parse(rawInput);
  if (!/^[a-f0-9]{40}$/.test(options.runtimeVersion)) fail("exact operator runtime is required");
  const apply = options.apply === true;
  const requestDigest = hash(JSON.stringify(input));
  const searchDigest = hash(input.searchId);
  const receiptId = `synthetic-reactivation-${hash(`${input.actorId}:${input.idempotencyKey}`)}`;
  return prisma.$transaction(async (transaction) => {
    if (!apply) await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
    const initial = await transaction.teeSearch.findUnique({ where: { id: input.searchId }, select: searchSelect });
    const existing = await transaction.automationRun.findUnique({ where: { id: receiptId },
      select: { promptVersion: true, status: true, completedAt: true, audit: true } });
    if (existing) {
      const receipt = receiptSchema.safeParse(existing.audit);
      const now = await databaseNow(transaction);
      if (!receipt.success || existing.promptVersion !== SYNTHETIC_REACTIVATION_PROMPT_VERSION ||
          existing.status !== "COMPLETED" || !existing.completedAt ||
          receipt.data.requestDigest !== requestDigest || receipt.data.searchDigest !== searchDigest) fail("idempotency scope conflicts");
      if (!initial || initial.status !== "ACTIVE" || !initial.syntheticMultiCycle ||
          !["TEST", "AUTOMATION"].includes(initial.trafficClass) ||
          initial.alertGeneration !== receipt.data.window.alertGeneration ||
          initial.date.toISOString().slice(0, 10) !== receipt.data.date ||
          !isDeepStrictEqual(initial.syntheticTestWindow, receipt.data.window) ||
          new Date(receipt.data.window.expiresAt) <= now) fail("prior reactivation is no longer current");
      return summary("already_applied", receipt.data.scheduleVersion, receipt.data.window);
    }
    let now = await databaseNow(transaction);
    assertSnapshot(initial, input, now);
    const courseIds = initial.preferences.map((preference) => preference.courseId).sort();
    if (apply) {
      for (const courseId of courseIds) {
        await acquireCourseMonitoringWriteLockInTransaction(transaction, courseId);
        // Locks fence inserted child execution/ownership rows through their Course FK.
        await transaction.$queryRaw`SELECT id FROM "Course" WHERE id=${courseId} FOR UPDATE`;
      }
      await assertNoPendingExecution(transaction, initial, now);
      await lockSearchForAlertMutation(transaction, { searchId: input.searchId, userId: initial.userId, now });
    }
    const current = apply
      ? await transaction.teeSearch.findUnique({ where: { id: input.searchId }, select: searchSelect })
      : initial;
    now = await databaseNow(transaction);
    assertSnapshot(current, input, now);
    if (JSON.stringify(current.preferences.map((preference) => [preference.courseId, preference.rank])) !==
        JSON.stringify(initial.preferences.map((preference) => [preference.courseId, preference.rank]))) fail("preference scope changed");
    await assertNoPendingExecution(transaction, current, now);
    const window = syntheticTestWindowSchema.parse({ schemaVersion: 1,
      alertGeneration: current.alertGeneration + 1, activatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.durationMinutes * 60000).toISOString() });
    const scheduleVersion = current.scheduleVersion + 1;
    if (!apply) return summary("ready", scheduleVersion, window);
    const updated = await transaction.teeSearch.updateMany({
      where: { id: input.searchId, status: "PAUSED", syntheticMultiCycle: true,
        trafficClass: { in: ["TEST", "AUTOMATION"] }, scheduleVersion: input.expectedScheduleVersion,
        alertGeneration: input.expectedAlertGeneration, updatedAt: new Date(input.expectedUpdatedAt),
        workflowRunId: null, checkLeaseToken: null,
        OR: [{ checkLeaseExpiresAt: null }, { checkLeaseExpiresAt: { lte: now } }] },
      data: { status: "ACTIVE", date: new Date(`${input.date}T00:00:00.000Z`),
        scheduleVersion, alertGeneration: window.alertGeneration, syntheticTestWindow: window,
        checkStatus: "QUEUED", nextCheckAt: now, lastCheckOutcome: null,
        workflowRunId: null, checkLeaseToken: null, checkLeaseExpiresAt: null,
        recheckRequestedAt: null, remediationDispatchKey: null, remediationDispatchVersion: null,
        statusEmailSentAt: null, statusEmailSnapshot: buildAlertGenerationStartMarker({
          alertGeneration: window.alertGeneration, generationStartedAt: now }), updatedAt: now },
    });
    if (updated.count !== 1) fail("compare-and-set lost ownership");
    await transaction.automationRun.create({ data: {
      id: receiptId, promptVersion: SYNTHETIC_REACTIVATION_PROMPT_VERSION, kind: "OTHER",
      status: "COMPLETED", runtimeVersion: options.runtimeVersion, ownerThreadId: input.actorId,
      startedAt: now, completedAt: now, outcome: "synthetic_search_reactivated", auditSchemaVersion: 1,
      audit: { schemaVersion: 1, kind: "EXPLICIT_SYNTHETIC_REACTIVATION", requestDigest, searchDigest,
        date: input.date, scheduleVersion, window,
        previous: { createdAt: current.createdAt.toISOString(), date: current.date.toISOString(),
          scheduleVersion: current.scheduleVersion, alertGeneration: current.alertGeneration,
          syntheticTestWindow: current.syntheticTestWindow },
        preservedPreferenceCount: current.preferences.length, syntheticOnly: true,
        providerExecution: false, customerDeliveryProof: false, queuedForDeployedRecovery: true },
    } });
    return summary("queued_for_recovery", scheduleVersion, window);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 });
}
