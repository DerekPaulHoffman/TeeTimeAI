import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isSearchWindowActive } from "@/lib/automation/date-boundary";
import { isDiscoveryPilotSearch } from "./config";
import { parseCourseLocalWindowEnd } from "@/lib/searches/window-end";
import { zonedDateTimeToDate } from "@/lib/timezones";
import { assertActiveAccessRecipeInTransaction, getActiveAccessRecipe, type DiscoveryTarget } from "./service";
import { accessExecutionInputSchema, accessExecutionResultSchema, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import { isReaderObservationCurrent } from "./observation-clock";
import { isTeeItUpRecipeSlotLink } from "./teeitup-recipe-source";
import { isChronogolfRecipeSlotLink } from "./chronogolf-source";

const EXECUTION_TTL_MS = 180_000;
const RESULT_TTL_MS = 90_000;
const contextSchema = accessExecutionInputSchema;
export type ColdStartTrace = { discoveryJobId: string; firstPickedUpAt: string; deadlineAt: string; firstWarmQueuedAt: string;
  initialExecution: boolean; firstWarmExceeded: boolean; currentLateFromColdDeadline?: boolean; firstWarmFinishedAt?: string; firstWarmStatus?: string };
type Context = { target: DiscoveryTarget; recipeId: string; recipeHash: string; input: AccessExecutionInput; alertGeneration: number;
  queuedAt?: string; consumed?: { recipeHash: string; observedAt: string; consumedAt: string };
  coldStart?: ColdStartTrace; resumeScheduleVersion?: number };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

function readContext(value: unknown): Context {
  const context = value as Context;
  if (!context || typeof context.recipeId !== "string" || typeof context.recipeHash !== "string" ||
      !context.target?.courseId || !Number.isInteger(context.alertGeneration)) throw new Error("Invalid recipe execution context");
  contextSchema.parse(context.input);
  return context;
}

export function recipeExecutionDeadline(now: Date, coldStart?: ColdStartTrace) {
  const normal = now.getTime() + EXECUTION_TTL_MS;
  const coldDeadline = coldStart?.initialExecution ? Date.parse(coldStart.deadlineAt) : NaN;
  // A missed SLO never suppresses useful later availability. Only the first
  // on-time attempt uses the original budget; normal retries retain their TTL.
  return new Date(Number.isFinite(coldDeadline) && coldDeadline > now.getTime() ? Math.min(normal, coldDeadline) : normal);
}
export function resumeColdStartTrace(prior: ColdStartTrace, now: Date): ColdStartTrace {
  return { ...prior, initialExecution: false,
    firstWarmExceeded: prior.firstWarmExceeded || !prior.firstWarmFinishedAt && now.getTime() > Date.parse(prior.deadlineAt),
    currentLateFromColdDeadline: now.getTime() > Date.parse(prior.deadlineAt) };
}

/** Browser work remains on the local runner; the deployed workflow only queues and consumes evidence. */
export async function getOrQueueRecipeExecution(input: { searchId: string; target: DiscoveryTarget; input: AccessExecutionInput }) {
  if (!await isDiscoveryPilotSearch(input.searchId)) return null;
  const active = await getActiveAccessRecipe(input.target);
  if (!active) return null;
  const parameters = accessExecutionInputSchema.parse(input.input);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "TeeSearch" WHERE "id" = ${input.searchId} FOR UPDATE`;
    const search = await tx.teeSearch.findUnique({ where: { id: input.searchId } });
    if (!search || search.status !== "ACTIVE") return null;
    const preference = await tx.coursePreference.findFirst({ where: { teeSearchId: search.id, courseId: input.target.courseId,
      ...(input.target.offeringId ? { offeringId: input.target.offeringId } : {}) } });
    if (!preference || search.date.toISOString().slice(0, 10) !== parameters.date || search.players !== parameters.players ||
      search.startTime !== parameters.startTime || search.endTime !== parameters.endTime ||
      (input.target.kind === "SIMULATOR" && search.durationMinutes !== parameters.durationMinutes)) return null;
    const key = createHash("sha256").update(JSON.stringify([search.id, search.alertGeneration, active.record.id, parameters])).digest("hex");
    const verificationKey = `recipe:${key}`;
    const now = new Date();
    const previous = await tx.localReaderJob.findUnique({ where: { verificationKey } });
    if (previous?.status === "COMPLETED" && previous.resultExpiresAt && previous.resultExpiresAt > now &&
        (previous.scheduleVersion === search.scheduleVersion || readContext(previous.sourceContext).resumeScheduleVersion === search.scheduleVersion)) {
      const result = accessExecutionResultSchema.parse(previous.result);
      return { state: "ready" as const, jobId: previous.id, recipeId: active.record.id, recipeHash: active.record.hash, result };
    }
    if (previous && ["PENDING", "LEASED"].includes(previous.status) && previous.jobExpiresAt > now) return { state: "pending" as const };
    const priorExecution = previous ?? await tx.localReaderJob.findFirst({ where: { purpose: "RECIPE_CHECK", courseId: input.target.courseId,
      AND: [{ sourceContext: { path: ["searchId"], equals: search.id } }, { sourceContext: { path: ["recipeId"], equals: active.record.id } },
        { sourceContext: { path: ["alertGeneration"], equals: search.alertGeneration } }] }, orderBy: { createdAt: "asc" }, select: { sourceContext: true } });
    let coldStart: ColdStartTrace | undefined;
    if (priorExecution) {
      const prior = readContext(priorExecution.sourceContext).coldStart;
      if (prior) coldStart = resumeColdStartTrace(prior, now);
    } else {
      const origin = await tx.courseDiscoveryJob.findFirst({ where: { courseId: input.target.courseId, offeringId: input.target.offeringId ?? null, status: "SUCCEEDED",
        AND: [{ result: { path: ["recipeId"], equals: active.record.id } }, { request: { path: ["demand", "searchId"], equals: search.id } },
          { request: { path: ["demand", "alertGeneration"], equals: search.alertGeneration } }] },
        orderBy: { completedAt: "desc" }, select: { id: true, firstPickedUpAt: true, deadlineAt: true } });
      if (origin?.firstPickedUpAt && origin.deadlineAt) coldStart = { discoveryJobId: origin.id, firstPickedUpAt: origin.firstPickedUpAt.toISOString(),
        deadlineAt: origin.deadlineAt.toISOString(), firstWarmQueuedAt: now.toISOString(), initialExecution: true,
        firstWarmExceeded: origin.deadlineAt <= now, currentLateFromColdDeadline: origin.deadlineAt <= now };
    }
    const context: Context = { target: input.target, recipeId: active.record.id, recipeHash: active.record.hash, input: parameters, alertGeneration: search.alertGeneration, queuedAt: now.toISOString(),
      ...(coldStart ? { coldStart } : {}) };
    const data = { teeSearchId: search.id, courseId: input.target.courseId, scheduleVersion: search.scheduleVersion,
      purpose: "RECIPE_CHECK" as const, courseKey: `recipe:${active.record.id}`, targetDate: parameters.date, players: parameters.players,
      bookingUrl: active.recipe.source.bookingUrl, status: "PENDING" as const, sourceContext: json(context),
      jobExpiresAt: recipeExecutionDeadline(now, coldStart), leaseToken: null, leaseExpiresAt: null,
      result: Prisma.DbNull, resultExpiresAt: null, claimedAt: null, completedAt: null, resumeScheduleVersion: null };
    // Recipe checks use their own unique execution key, not the legacy alert-check compound key.
    await tx.localReaderJob.upsert({ where: { verificationKey }, create: { ...data, verificationKey, teeSearchId: null, sourceContext: json({ ...context, searchId: search.id }) },
      update: { ...data, teeSearchId: null, sourceContext: json({ ...context, searchId: search.id }) } });
    return { state: "pending" as const };
  });
}

export async function claimNextRecipeExecution(workerId: string) {
  if (!/^[A-Za-z0-9._-]{1,100}$/u.test(workerId)) throw new Error("Invalid worker id");
  const candidates = await prisma.localReaderJob.findMany({ where: { purpose: "RECIPE_CHECK", jobExpiresAt: { gt: new Date() },
    OR: [{ status: "PENDING" }, { status: "LEASED", leaseExpiresAt: { lt: new Date() } }] }, orderBy: { createdAt: "asc" }, take: 10 });
  for (const row of candidates) {
    const context = readContext(row.sourceContext);
    const searchId = (row.sourceContext as unknown as { searchId: string }).searchId;
    if (!await isDiscoveryPilotSearch(searchId)) continue;
    const active = await getActiveAccessRecipe(context.target);
    const search = await prisma.teeSearch.findUnique({ where: { id: searchId }, include: { preferences: true } });
    if (!active || active.record.id !== context.recipeId || active.record.hash !== context.recipeHash || !search ||
        search.status !== "ACTIVE" || search.alertGeneration !== context.alertGeneration || search.scheduleVersion !== row.scheduleVersion ||
        !search.preferences.some(pref => pref.courseId === context.target.courseId && (!context.target.offeringId || pref.offeringId === context.target.offeringId)) ||
        !isSearchWindowActive({ date: search.date, endTime: search.endTime, courseTimeZones: [context.input.timeZone], fallbackTimeZone: search.userTimeZone, now: new Date() })) {
      await prisma.localReaderJob.updateMany({ where: { id: row.id, status: row.status, leaseToken: row.leaseToken }, data: { status: "EXPIRED" } });
      continue;
    }
    const token = randomUUID();
    const claimed = await prisma.localReaderJob.updateMany({ where: { id: row.id, status: row.status, leaseToken: row.leaseToken, jobExpiresAt: { gt: new Date() } },
      data: { status: "LEASED", deviceId: workerId, leaseToken: token, claimedAt: new Date(), leaseExpiresAt: row.jobExpiresAt } });
    if (claimed.count === 1) return { id: row.id, leaseToken: token, deadlineAt: row.jobExpiresAt.toISOString(), recipe: active.recipe, input: context.input,
      ...(context.coldStart ? { coldStart: context.coldStart, firstPickedUpAt: context.coldStart.firstPickedUpAt } : {}) };
  }
  return null;
}

export async function completeRecipeExecution(id: string, leaseToken: string, value: unknown) {
  const result = accessExecutionResultSchema.parse(value);
  return prisma.$transaction(async tx => {
    const initial = await tx.localReaderJob.findUnique({ where: { id } });
    if (!initial) throw new Error("Recipe execution is missing");
    const initialSearchId = (initial.sourceContext as unknown as { searchId: string }).searchId;
    await tx.$queryRaw`SELECT "id" FROM "TeeSearch" WHERE "id" = ${initialSearchId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "LocalReaderJob" WHERE "id" = ${id} FOR UPDATE`;
    const job = await tx.localReaderJob.findUnique({ where: { id } });
    const now = new Date();
    if (job?.purpose === "RECIPE_CHECK" && job.status === "COMPLETED" && job.leaseToken === leaseToken && isDeepStrictEqual(job.result, result)) {
      const context = readContext(job.sourceContext);
      return { searchId: (job.sourceContext as unknown as { searchId: string }).searchId, target: context.target, recipeId: context.recipeId, complete: result.complete,
        ...(context.coldStart ? { coldStart: context.coldStart } : {}) };
    }
    if (!job || job.purpose !== "RECIPE_CHECK" || job.status !== "LEASED" || job.leaseToken !== leaseToken ||
        !job.leaseExpiresAt || job.leaseExpiresAt <= now || job.jobExpiresAt <= now) throw new Error("Recipe execution lease expired");
    const context = readContext(job.sourceContext);
    const searchId = (job.sourceContext as unknown as { searchId: string }).searchId;
    await tx.$queryRaw`SELECT "id" FROM "TeeSearch" WHERE "id" = ${searchId} FOR UPDATE`;
    const search = await tx.teeSearch.findUnique({ where: { id: searchId }, include: { preferences: true } });
    const target = context.target.offeringId ? await tx.courseOffering.findUnique({ where: { id: context.target.offeringId } }) : await tx.course.findUnique({ where: { id: context.target.courseId } });
    if (!search || search.status !== "ACTIVE" || !await isDiscoveryPilotSearch(search.id) || search.alertGeneration !== context.alertGeneration ||
        search.scheduleVersion !== job.scheduleVersion || target?.activeAccessRecipeId !== context.recipeId ||
        !search.preferences.some(pref => pref.courseId === context.target.courseId && (!context.target.offeringId || pref.offeringId === context.target.offeringId)) ||
        result.evidence.recipeHash !== context.recipeHash || !job.claimedAt ||
        !isReaderObservationCurrent(Date.parse(result.observedAt), job.claimedAt.getTime(), now.getTime())) throw new Error("Recipe execution is no longer current");
    if (result.complete && (!result.evidence.venueVerified || !result.evidence.dateVerified || !result.evidence.capacityVerified ||
        !result.evidence.durationVerified || !result.evidence.completeVerified)) throw new Error("Incomplete recipe evidence");
    const stored = await tx.courseAccessRecipe.findUniqueOrThrow({ where: { id: context.recipeId } });
    await assertActiveAccessRecipeInTransaction(tx, context.target, context.recipeId);
    const bookingUrl = (stored.payload as unknown as { source: { bookingUrl: string } }).source.bookingUrl;
    const storedRecipe = stored.payload as unknown as { engine: string; adapter?: { family: string; facilityIds?: number[] } };
    if (result.sourceUrl !== bookingUrl) throw new Error("Recipe source changed");
    for (const slot of result.slots) {
      const correctBookingUrl = storedRecipe.engine === "EXISTING_ADAPTER" && storedRecipe.adapter?.family === "TEEITUP"
        ? isTeeItUpRecipeSlotLink(bookingUrl, context.input.date, storedRecipe.adapter.facilityIds ?? [], slot)
        : storedRecipe.engine === "EXISTING_ADAPTER" && storedRecipe.adapter?.family === "CHRONOGOLF"
          ? isChronogolfRecipeSlotLink(bookingUrl, storedRecipe.adapter, context.input.date, slot) : slot.bookingUrl === bookingUrl;
      if (!correctBookingUrl || (context.target.kind === "OUTDOOR" && slot.availableSpots < context.input.players) ||
          !isRecipeSlotWithinWindow(slot, context.input, now) ||
          (context.input.durationMinutes && (!slot.endsAt || Date.parse(slot.endsAt) - Date.parse(slot.startsAt) !== context.input.durationMinutes * 60_000))) throw new Error("Invalid recipe slot");
    }
    const coldStart = context.coldStart ? { ...context.coldStart,
      firstWarmExceeded: context.coldStart.firstWarmExceeded || context.coldStart.initialExecution && now.getTime() > Date.parse(context.coldStart.deadlineAt),
      currentLateFromColdDeadline: now.getTime() > Date.parse(context.coldStart.deadlineAt),
      ...(context.coldStart.initialExecution ? { firstWarmFinishedAt: now.toISOString(), firstWarmStatus: result.status } : {}) } : undefined;
    await tx.localReaderJob.update({ where: { id }, data: { status: "COMPLETED", result: json(result), completedAt: now,
      resultExpiresAt: new Date(now.getTime() + RESULT_TTL_MS), leaseExpiresAt: null,
      ...(coldStart ? { sourceContext: json({ ...context, searchId, coldStart }) } : {}) } });
    return { searchId, target: context.target, recipeId: context.recipeId, complete: result.complete, ...(coldStart ? { coldStart } : {}) };
  });
}

export async function attachRecipeResumeVersion(jobId: string, scheduleVersion: number, expectedSearchId?: string) {
  return prisma.$transaction(async tx => {
    const job = await tx.localReaderJob.findUnique({ where: { id: jobId } });
    if (!job || job.purpose !== "RECIPE_CHECK" || job.status !== "COMPLETED" || !job.resultExpiresAt || job.resultExpiresAt <= new Date()) return false;
    const context = readContext(job.sourceContext);
    const searchId = (job.sourceContext as unknown as { searchId: string }).searchId;
    if (expectedSearchId && searchId !== expectedSearchId) return false;
    await tx.$queryRaw`SELECT "id" FROM "TeeSearch" WHERE "id" = ${searchId} FOR UPDATE`;
    const search = await tx.teeSearch.findUnique({ where: { id: searchId } });
    if (!search || search.status !== "ACTIVE" || search.scheduleVersion !== scheduleVersion || search.alertGeneration !== context.alertGeneration ||
        search.date.toISOString().slice(0, 10) !== context.input.date || search.players !== context.input.players ||
        search.startTime !== context.input.startTime || search.endTime !== context.input.endTime ||
        (context.target.kind === "SIMULATOR" && search.durationMinutes !== context.input.durationMinutes)) return false;
    const updated = await tx.localReaderJob.updateMany({ where: { id: jobId, purpose: "RECIPE_CHECK", status: "COMPLETED", resultExpiresAt: { gt: new Date() } },
      data: { sourceContext: json({ ...context, searchId, resumeScheduleVersion: scheduleVersion }) } });
    return updated.count === 1;
  });
}

export async function assertRecipeObservationCurrent(tx: Prisma.TransactionClient, input: { jobId: string; recipeId: string; courseId: string; offeringId?: string; searchId: string }) {
  const row = await tx.localReaderJob.findUnique({ where: { id: input.jobId } });
  if (!row || row.status !== "COMPLETED" || row.purpose !== "RECIPE_CHECK" || !row.resultExpiresAt || row.resultExpiresAt <= new Date() ||
      row.courseId !== input.courseId || (row.sourceContext as unknown as { searchId: string }).searchId !== input.searchId) throw new Error("Recipe observation was superseded");
  const context = readContext(row.sourceContext);
  const expectedKind = input.offeringId ? "SIMULATOR" : "OUTDOOR";
  if (context.recipeId !== input.recipeId || context.target.courseId !== input.courseId ||
      (context.target.offeringId ?? null) !== (input.offeringId ?? null) || context.target.kind !== expectedKind ||
      row.targetDate !== context.input.date || row.players !== context.input.players) throw new Error("Recipe observation target changed");
  const search = await tx.teeSearch.findUnique({ where: { id: input.searchId } });
  if (!search || search.status !== "ACTIVE" || search.mode !== expectedKind || search.alertGeneration !== context.alertGeneration ||
      (row.scheduleVersion !== search.scheduleVersion && context.resumeScheduleVersion !== search.scheduleVersion) ||
      search.date.toISOString().slice(0, 10) !== context.input.date || search.players !== context.input.players ||
      search.startTime !== context.input.startTime || search.endTime !== context.input.endTime ||
      (expectedKind === "SIMULATOR" && search.durationMinutes !== context.input.durationMinutes)) throw new Error("Recipe observation demand changed");
  const record = await assertActiveAccessRecipeInTransaction(tx, input, input.recipeId);
  const result = accessExecutionResultSchema.parse(row.result);
  if (record.hash !== context.recipeHash || result.evidence.recipeHash !== context.recipeHash || !recipeResultIsSuccessful(result)) throw new Error("Recipe observation version changed");
}

/** Only the canonical match transaction may release an observation's delivery fence. */
export async function markRecipeObservationConsumed(tx: Prisma.TransactionClient, input: { jobId: string; recipeId: string; courseId: string; offeringId?: string; searchId: string }) {
  await assertRecipeObservationCurrent(tx, input);
  const row = await tx.localReaderJob.findUniqueOrThrow({ where: { id: input.jobId } });
  const context = readContext(row.sourceContext);
  const result = accessExecutionResultSchema.parse(row.result);
  const marked = await tx.localReaderJob.updateMany({ where: { id: row.id, status: "COMPLETED", sourceContext: { equals: row.sourceContext as Prisma.InputJsonValue },
    result: { equals: row.result as Prisma.InputJsonValue }, resultExpiresAt: { gt: new Date() } }, data: { sourceContext: json({ ...context, searchId: input.searchId,
      consumed: { recipeHash: context.recipeHash, observedAt: result.observedAt, consumedAt: new Date().toISOString() } }) } });
  if (marked.count !== 1) throw new Error("Recipe observation changed before canonical consumption");
}

export function recipeResultIsSuccessful(result: AccessExecutionResult) { return result.complete && ["AVAILABLE", "EMPTY"].includes(result.status); }
export function recipeFailureIsRetryable(reason?: string) {
  return ["BROWSER_UNAVAILABLE", "PROVIDER_THROTTLED", "PIPELINE_DEADLINE", "DEADLINE_EXCEEDED", "DISCOVERY_EXECUTION_TIMEOUT"].includes(reason ?? "");
}

/** A missing local capability does not invalidate a method already proven on
 * the provider. Keep that recipe for the next normal execution after recovery. */
export function recipeExecutionNeedsRepair(result: AccessExecutionResult) {
  return !recipeResultIsSuccessful(result) && !recipeFailureIsRetryable(result.evidence.reason);
}

/** Server-side acceptance uses absolute bounds too: 24:00 is the following
 * venue-local midnight, and a rental must finish no later than that instant. */
export function isRecipeSlotWithinWindow(slot: { startsAt: string; endsAt?: string }, input: AccessExecutionInput, now = new Date()) {
  const startsAt = Date.parse(slot.startsAt);
  const endsAt = slot.endsAt === undefined ? undefined : Date.parse(slot.endsAt);
  const windowStart = zonedDateTimeToDate(`${input.date}T${input.startTime}:00`, input.timeZone).getTime();
  const windowEnd = parseCourseLocalWindowEnd(input.date, input.endTime, input.timeZone).getTime();
  return Number.isFinite(startsAt) && Number.isFinite(windowStart) && Number.isFinite(windowEnd) &&
    startsAt > now.getTime() && startsAt >= windowStart && startsAt < windowEnd &&
    (endsAt === undefined || Number.isFinite(endsAt) && endsAt > startsAt && endsAt <= windowEnd);
}
