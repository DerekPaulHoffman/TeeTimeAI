import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { isSearchWindowActive } from "@/lib/automation/date-boundary";
import { getSyntheticMultiCycleExpiresAt } from "@/lib/automation/synthetic-test-window";
import { parseCourseLocalWindowEnd } from "@/lib/searches/window-end";
import { activeDiscoveryPilotSearchIds, isDiscoveryPilotSearch } from "./config";
import { hasLegacyDiscoveryOwner } from "./legacy-exclusion";
import { isReaderObservationCurrent } from "./observation-clock";
import { isTeeItUpRecipeSlotLink } from "./teeitup-recipe-source";
import { isChronogolfRecipeSlotLink } from "./chronogolf-source";
import { normalizeDiscoverySourceUrl } from "./source-url";
import {
  accessExecutionInputSchema,
  accessExecutionResultSchema,
  hashAccessRecipe,
  isSafeRecipeUrl,
  parseAccessRecipe,
  type AccessExecutionInput,
  type CourseAccessRecipeData,
} from "./recipe";

export const DISCOVERY_LEASE_MS = 90_000;
export const DISCOVERY_DEADLINE_MS = 15 * 60_000;
export const DISCOVERY_MAX_ATTEMPTS = 2;

export type DiscoveryTarget = { courseId: string; offeringId?: string; kind: "OUTDOOR" | "SIMULATOR" };
export type DiscoveryRequest = {
  target: DiscoveryTarget;
  identity: { name: string; officialUrl: string | null; bookingUrl: string | null; timeZone: string; providerFamily: string | null; address?: string };
  input: AccessExecutionInput;
  demand?: { searchId: string; alertGeneration: number };
};
export class DiscoveryConflictError extends Error {
  constructor() { super("Course discovery state changed."); }
}

const sourceEvidenceUrl = z.string().url().max(2048).refine(isSafeRecipeUrl);
export const discoverySourceEvidenceSchema = z.object({
  officialUrl: sourceEvidenceUrl, observedBookingUrl: sourceEvidenceUrl,
}).strict();
type DiscoverySourceEvidence = z.infer<typeof discoverySourceEvidenceSchema>;

export function isRetryableDiscoveryTransactionError(error: unknown) {
  // Prisma's PostgreSQL adapter can surface a commit-time serialization
  // conflict directly instead of wrapping it in a known request error.
  if (error instanceof Error && error.name === "DriverAdapterError" &&
      error.cause && typeof error.cause === "object" &&
      "kind" in error.cause && error.cause.kind === "TransactionWriteConflict") return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;
  const meta = error.meta as { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const code = meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
  return code === "40001" || code === "40P01";
}

const courseSelect = {
  id: true, name: true, address: true, website: true, detectedBookingUrl: true, timeZone: true,
  providerFamilyKey: true, bookingMetadata: true, isPublic: true, activeAccessRecipeId: true,
  bookingMethod: true, bookingAccessMode: true, automationEligibility: true, automationReason: true,
} satisfies Prisma.CourseSelect;
const offeringSelect = {
  id: true, courseId: true, kind: true, active: true, publicAccessStatus: true,
  bookingUrl: true, providerFamilyKey: true, providerMetadata: true,
  maxPartySize: true, supportedDurationsMinutes: true, activeAccessRecipeId: true,
  automationEligibility: true,
} satisfies Prisma.CourseOfferingSelect;
const searchSelect = {
  id: true, date: true, startTime: true, endTime: true, players: true, mode: true,
  durationMinutes: true, status: true, scheduleVersion: true, userTimeZone: true,
  createdAt: true, trafficClass: true, syntheticMultiCycle: true,
  syntheticTestWindow: true, alertGeneration: true,
} satisfies Prisma.TeeSearchSelect;
type Tx = Prisma.TransactionClient;
type Source = Awaited<ReturnType<typeof loadSource>>;
type Search = Prisma.TeeSearchGetPayload<{ select: typeof searchSelect }>;

type FingerprintCourse = Prisma.CourseGetPayload<{ select: typeof courseSelect }>;
type FingerprintOffering = Prisma.CourseOfferingGetPayload<{ select: typeof offeringSelect }>;

/** Pure current-source binding shared with the read-only customer projection. */
export function getDiscoverySourceFingerprint(course: FingerprintCourse, offering: FingerprintOffering | null = null) {
  return digest({ identity: {
    name: course.name, officialUrl: course.website, bookingUrl: offering ? offering.bookingUrl : course.detectedBookingUrl,
    timeZone: course.timeZone, providerFamily: offering ? offering.providerFamilyKey : course.providerFamilyKey,
  }, metadata: offering ? offering.providerMetadata : course.bookingMetadata,
  access: offering ? { publicAccessStatus: offering.publicAccessStatus, automationEligibility: offering.automationEligibility }
    : { bookingMethod: course.bookingMethod, bookingAccessMode: course.bookingAccessMode, automationEligibility: course.automationEligibility, automationReason: course.automationReason },
  offering: offering ? { id: offering.id, maxPartySize: offering.maxPartySize, supportedDurationsMinutes: offering.supportedDurationsMinutes } : null });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function digest(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function targetKey(target: Pick<DiscoveryTarget, "courseId" | "offeringId">) { return target.offeringId ? `offering:${target.offeringId}` : `course:${target.courseId}`; }
function conflict(): never { throw new DiscoveryConflictError(); }

async function transaction<T>(action: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000 }); }
    catch (error) {
      if (attempt >= 4 || !isRetryableDiscoveryTransactionError(error)) throw error;
      // Spread competing workers before retrying the whole transaction. Its
      // ownership and database deadline checks run again on every attempt.
      await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt + Math.floor(Math.random() * 30)));
    }
  }
}
async function databaseNow(tx: Tx) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!(row?.now instanceof Date) || !Number.isFinite(row.now.getTime())) conflict();
  return row.now;
}
async function lockSource(tx: Tx, courseId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Course" WHERE "id" = ${courseId} FOR UPDATE`;
}
async function loadSource(tx: Tx, target: Pick<DiscoveryTarget, "courseId" | "offeringId">) {
  const course = await tx.course.findUnique({ where: { id: target.courseId }, select: courseSelect });
  if (!course || !target.offeringId && course.isPublic === false) conflict();
  const offering = target.offeringId ? await tx.courseOffering.findUnique({ where: { id: target.offeringId }, select: offeringSelect }) : null;
  if (target.offeringId && (!offering || offering.courseId !== course.id || offering.kind !== "SIMULATOR" || !offering.active || offering.publicAccessStatus === "NOT_PUBLIC")) conflict();
  const fingerprintIdentity = {
    name: course.name, officialUrl: course.website, bookingUrl: offering ? offering.bookingUrl : course.detectedBookingUrl,
    timeZone: course.timeZone, providerFamily: offering ? offering.providerFamilyKey : course.providerFamilyKey,
  };
  // Preserve existing fingerprints; address-bound recipes separately recheck
  // the trusted address at proposal, proof, activation and every later replay.
  const identity = { ...fingerprintIdentity, officialUrl: normalizeDiscoverySourceUrl(fingerprintIdentity.officialUrl),
    bookingUrl: normalizeDiscoverySourceUrl(fingerprintIdentity.bookingUrl), ...(course.address ? { address: course.address } : {}) };
  const sourceFingerprint = getDiscoverySourceFingerprint(course, offering);
  return { course, offering, identity, sourceFingerprint, activeRecipeId: offering ? offering.activeAccessRecipeId : course.activeAccessRecipeId,
    target: { courseId: course.id, ...(offering ? { offeringId: offering.id } : {}), kind: offering ? "SIMULATOR" as const : "OUTDOOR" as const } };
}
function activeSearch(search: Search, source: Source, now: Date) {
  const synthetic = search.trafficClass === "TEST" || search.trafficClass === "AUTOMATION";
  const expiry = getSyntheticMultiCycleExpiresAt(search, now);
  return search.status === "ACTIVE" && search.mode === source.target.kind &&
    (!synthetic || search.syntheticMultiCycle && expiry !== null && expiry > now) &&
    isSearchWindowActive({ date: search.date, endTime: search.endTime, courseTimeZones: [source.identity.timeZone], fallbackTimeZone: search.userTimeZone, now });
}
function requestFor(source: Source, search: Search): DiscoveryRequest {
  return { target: source.target, identity: source.identity, demand: { searchId: search.id, alertGeneration: search.alertGeneration }, input: accessExecutionInputSchema.parse({
    date: search.date.toISOString().slice(0, 10), timeZone: source.identity.timeZone, players: search.players,
    startTime: search.startTime, endTime: search.endTime, ...(search.durationMinutes ? { durationMinutes: search.durationMinutes } : {}),
  }) };
}
async function currentDemand(tx: Tx, source: Source, now: Date, searchId?: string) {
  const pilotIds = await activeDiscoveryPilotSearchIds(process.env, tx);
  const eligibleIds = searchId ? pilotIds.filter(id => id === searchId) : pilotIds;
  if (!eligibleIds.length) return null;
  const preferences = await tx.coursePreference.findMany({ where: {
    courseId: source.course.id, offeringId: source.offering?.id ?? null,
    teeSearchId: { in: eligibleIds }, teeSearch: { status: "ACTIVE" },
  }, select: { teeSearch: { select: searchSelect } }, orderBy: { teeSearch: { createdAt: "asc" } }, take: 100 });
  for (const { teeSearch } of preferences) {
    if (activeSearch(teeSearch, source, now)) return teeSearch;
  }
  return null;
}

/** Demand and source are re-read here; the caller cannot grant ownership or supply identity. */
export async function ensureDiscoveryJob(input: { courseId: string; offeringId?: string; searchId: string; request?: DiscoveryRequest }) {
  if (!await isDiscoveryPilotSearch(input.searchId)) return null;
  return transaction(async tx => {
    const now = await databaseNow(tx);
    await lockSource(tx, input.courseId);
    const source = await loadSource(tx, input);
    const demand = await currentDemand(tx, source, now, input.searchId);
    if (!demand) return null;
    if (await hasLegacyDiscoveryOwner(tx, source.target)) return null;
    const request = requestFor(source, demand);
    if (input.request && (canonical(input.request.target) !== canonical(request.target) || canonical(input.request.input) !== canonical(request.input))) conflict();
    if (source.activeRecipeId) {
      const previous = await tx.courseAccessRecipe.findUnique({ where: { id: source.activeRecipeId } });
      if (previous && previous.targetKey === targetKey(input) && previous.sourceFingerprint === source.sourceFingerprint) {
        try {
          const recipe = parseAccessRecipe(previous.payload);
          bindRecipe(recipe, source);
          if (hashAccessRecipe(recipe) === previous.hash) return null;
        } catch (error) {
          if (!(error instanceof z.ZodError) && !(error instanceof DiscoveryConflictError)) throw error;
        }
      }
      const cleared = source.offering
        ? await tx.courseOffering.updateMany({ where: { id: source.offering.id, activeAccessRecipeId: source.activeRecipeId }, data: { activeAccessRecipeId: null, monitoringRevision: { increment: 1 } } })
        : await tx.course.updateMany({ where: { id: source.course.id, activeAccessRecipeId: source.activeRecipeId }, data: { activeAccessRecipeId: null } });
      if (cleared.count !== 1) conflict();
      source.activeRecipeId = null;
    }
    const key = targetKey(input);
    const existing = await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: key } });
    if (existing && existing.sourceFingerprint === source.sourceFingerprint && existing.baseRecipeId === source.activeRecipeId) return existing;
    if (existing) await tx.courseDiscoveryJob.update({ where: { id: existing.id }, data: {
      status: "CANCELLED", activeTargetKey: null, leaseToken: null, leaseExpiresAt: null,
      outcome: "SOURCE_CHANGED", completedAt: now,
    } });
    const prior = await tx.courseDiscoveryJob.findFirst({ where: { targetKey: key,
      sourceFingerprint: source.sourceFingerprint, baseRecipeId: source.activeRecipeId,
      status: { in: ["FAILED", "TIMED_OUT", "CANCELLED"] },
      AND: [
        { request: { path: ["demand", "searchId"], equals: demand.id } },
        { request: { path: ["demand", "alertGeneration"], equals: demand.alertGeneration } },
      ],
    }, orderBy: { createdAt: "desc" } });
    // An ordinary scheduled check cannot turn an exhausted incident into a new
    // first attempt. A new alert generation or changed source is required.
    if (prior) return prior;
    return tx.courseDiscoveryJob.create({ data: { targetKey: key, activeTargetKey: key, courseId: source.course.id,
      offeringId: source.offering?.id, sourceFingerprint: source.sourceFingerprint, baseRecipeId: source.activeRecipeId, request: json(request) } });
  });
}

export async function claimNextDiscoveryJob(workerId: string) {
  z.string().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/u).parse(workerId);
  return transaction(async tx => {
    const now = await databaseNow(tx);
    const candidates = await tx.courseDiscoveryJob.findMany({ where: { activeTargetKey: { not: null }, OR: [
      { status: "QUEUED" }, { status: "RUNNING", leaseExpiresAt: { lte: now } },
    ] }, orderBy: { createdAt: "asc" }, take: 10 });
    for (const candidate of candidates) {
      await lockSource(tx, candidate.courseId);
      const current = await tx.courseDiscoveryJob.findUnique({ where: { id: candidate.id } });
      if (!current?.activeTargetKey || current.status !== "QUEUED" && (current.status !== "RUNNING" || !current.leaseExpiresAt || current.leaseExpiresAt > now)) continue;
      const finish = async (status: "CANCELLED" | "TIMED_OUT" | "FAILED", outcome: string) => tx.courseDiscoveryJob.update({ where: { id: current.id }, data: {
        status, outcome, activeTargetKey: null, leaseToken: null, leaseExpiresAt: null, completedAt: now,
      } });
      if (current.deadlineAt && current.deadlineAt <= now) { await finish("TIMED_OUT", "DEADLINE"); continue; }
      if (current.attempts >= DISCOVERY_MAX_ATTEMPTS) { await finish("FAILED", "ATTEMPTS_EXHAUSTED"); continue; }
      let source: Source;
      try { source = await loadSource(tx, { courseId: current.courseId, offeringId: current.offeringId ?? undefined }); }
      catch (error) { if (!(error instanceof DiscoveryConflictError)) throw error; await finish("CANCELLED", "SOURCE_CHANGED"); continue; }
      if (source.sourceFingerprint !== current.sourceFingerprint || source.activeRecipeId !== current.baseRecipeId) { await finish("CANCELLED", "SOURCE_CHANGED"); continue; }
      const previousRequest = current.request as unknown as DiscoveryRequest;
      const originalDemandId = typeof previousRequest.demand?.searchId === "string" ? previousRequest.demand.searchId : undefined;
      const demand = originalDemandId ? await currentDemand(tx, source, now, originalDemandId) ?? await currentDemand(tx, source, now) : await currentDemand(tx, source, now);
      if (!demand) { await finish("CANCELLED", "NO_ACTIVE_DEMAND"); continue; }
      if (await hasLegacyDiscoveryOwner(tx, source.target)) continue;
      const deadlineAt = current.deadlineAt ?? new Date(now.getTime() + DISCOVERY_DEADLINE_MS);
      return tx.courseDiscoveryJob.update({ where: { id: current.id }, data: {
        status: "RUNNING", attempts: { increment: 1 }, workerId, firstPickedUpAt: current.firstPickedUpAt ?? now,
        deadlineAt, leaseToken: randomUUID(), leaseExpiresAt: new Date(Math.min(deadlineAt.getTime(), now.getTime() + DISCOVERY_LEASE_MS)),
        request: json(requestFor(source, demand)), outcome: null,
      } });
    }
    return null;
  });
}

async function owned(tx: Tx, jobId: string, leaseToken: string) {
  const identity = await tx.courseDiscoveryJob.findUnique({ where: { id: jobId }, select: { courseId: true } });
  if (!identity) conflict();
  await lockSource(tx, identity.courseId);
  await tx.$queryRaw`SELECT "id" FROM "CourseDiscoveryJob" WHERE "id" = ${jobId} FOR UPDATE`;
  const now = await databaseNow(tx);
  const job = await tx.courseDiscoveryJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "RUNNING" || !job.activeTargetKey || job.leaseToken !== leaseToken || !job.leaseExpiresAt || job.leaseExpiresAt <= now || !job.deadlineAt || job.deadlineAt <= now) conflict();
  const source = await loadSource(tx, { courseId: job.courseId, offeringId: job.offeringId ?? undefined });
  if (source.sourceFingerprint !== job.sourceFingerprint || source.activeRecipeId !== job.baseRecipeId || !await currentDemand(tx, source, now) || await hasLegacyDiscoveryOwner(tx, source.target)) conflict();
  return { job, now, source };
}

export async function heartbeatDiscoveryJob(jobId: string, leaseToken: string) {
  return transaction(async tx => {
    const { job, now } = await owned(tx, jobId, leaseToken);
    return tx.courseDiscoveryJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(Math.min(job.deadlineAt!.getTime(), now.getTime() + DISCOVERY_LEASE_MS)) } });
  });
}
export async function checkpointDiscoveryJob(jobId: string, leaseToken: string, checkpoint: unknown) {
  if (Buffer.byteLength(JSON.stringify(checkpoint) ?? "", "utf8") > 32_768) throw new Error("Checkpoint is too large.");
  return transaction(async tx => {
    const { job } = await owned(tx, jobId, leaseToken);
    return tx.courseDiscoveryJob.update({ where: { id: job.id }, data: { checkpoint: checkpoint === null ? Prisma.JsonNull : json(checkpoint) } });
  });
}
export async function failDiscoveryJob(jobId: string, leaseToken: string, reason: string, retryable = false) {
  z.enum(["TOOL_FAILURE", "UNSUPPORTED", "ACCESS_REQUIRED", "DEADLINE", "CANCELLED"]).parse(reason);
  return transaction(async tx => {
    const { job, now } = await owned(tx, jobId, leaseToken);
    const retry = retryable && reason === "TOOL_FAILURE" && job.attempts < DISCOVERY_MAX_ATTEMPTS;
    return tx.courseDiscoveryJob.update({ where: { id: job.id }, data: {
      status: retry ? "QUEUED" : reason === "CANCELLED" ? "CANCELLED" : reason === "DEADLINE" ? "TIMED_OUT" : "FAILED",
      activeTargetKey: retry ? job.activeTargetKey : null, leaseToken: null, leaseExpiresAt: null,
      outcome: reason, completedAt: retry ? null : now,
    } });
  });
}

const challengeSchema = z.object({
  id: z.string().uuid(), recipeHash: z.string().regex(/^[a-f0-9]{64}$/u), issuedAt: z.string().datetime(),
  input: accessExecutionInputSchema, result: accessExecutionResultSchema.optional(), receivedAt: z.string().datetime().optional(),
}).strict();
const verificationSchema = z.object({ version: z.literal(1), challenges: z.array(challengeSchema).length(2),
  sourceEvidence: discoverySourceEvidenceSchema.optional() }).strict();
const activationSchema = z.object({ jobId: z.string(), target: z.object({ courseId: z.string(), offeringId: z.string().optional(), kind: z.enum(["OUTDOOR", "SIMULATOR"]) }).strict(),
  recipeId: z.string(), version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

function localSlotTime(iso: string, timeZone: string) {
  const parts = new Map(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso)).map(part => [part.type, part.value]));
  return { date: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`, time: `${parts.get("hour")}:${parts.get("minute")}` };
}
function bindRecipe(recipe: CourseAccessRecipeData, source: Source, sourceEvidence?: DiscoverySourceEvidence) {
  const normalizeName = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  if (canonical(recipe.target) !== canonical(source.target) || recipe.source.timeZone !== source.identity.timeZone ||
    normalizeName(recipe.source.venueName) !== normalizeName(source.identity.name) ||
    recipe.source.venueAddress !== undefined && normalizeName(recipe.source.venueAddress) !== normalizeName(source.identity.address ?? "") ||
    source.identity.officialUrl && recipe.source.officialUrl !== source.identity.officialUrl) conflict();
  if (sourceEvidence && (sourceEvidence.officialUrl !== recipe.source.officialUrl ||
      sourceEvidence.observedBookingUrl !== recipe.source.bookingUrl)) conflict();
  if (source.identity.bookingUrl && recipe.source.bookingUrl !== source.identity.bookingUrl && !sourceEvidence) conflict();
}

export async function proposeDiscoveryRecipe(jobId: string, leaseToken: string, proposed: unknown, observedSource?: unknown) {
  const recipe = parseAccessRecipe(proposed);
  const recipeHash = hashAccessRecipe(recipe);
  const sourceEvidence = discoverySourceEvidenceSchema.optional().parse(observedSource);
  return transaction(async tx => {
    const { job, now, source } = await owned(tx, jobId, leaseToken);
    if (job.candidateHash === recipeHash && job.verification) {
      const verification = verificationSchema.parse(job.verification);
      if (sourceEvidence && canonical(sourceEvidence) !== canonical(verification.sourceEvidence)) conflict();
      bindRecipe(recipe, source, verification.sourceEvidence);
      return { recipeHash, challenges: verification.challenges.map(challenge => ({ id: challenge.id, recipeHash: challenge.recipeHash, input: challenge.input, issuedAt: challenge.issuedAt, completed: Boolean(challenge.result) })) };
    }
    bindRecipe(recipe, source, sourceEvidence);
    const input = accessExecutionInputSchema.parse((job.request as unknown as DiscoveryRequest).input);
    // Verification inputs never become customer demand or customer matches.
    // A neighboring outdoor party tests parameterization, not universal party support.
    const alternate = { ...input, players: source.offering ? input.players : input.players < 4 ? input.players + 1 : input.players - 1 };
    if (source.offering) {
      const next = new Date(`${input.date}T12:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      alternate.date = next.toISOString().slice(0, 10);
    }
    const challenges = [input, alternate].map(value => ({ id: randomUUID(), recipeHash, input: accessExecutionInputSchema.parse(value), issuedAt: now.toISOString() }));
    await tx.courseDiscoveryJob.update({ where: { id: job.id }, data: { candidate: json(recipe), candidateHash: recipeHash,
      verification: json({ version: 1, challenges, ...(sourceEvidence ? { sourceEvidence } : {}) }) } });
    return { recipeHash, challenges: challenges.map(challenge => ({ ...challenge, completed: false })) };
  });
}

/** Only the fixed HMAC-authenticated executor calls this; model proposals cannot supply proofs. */
export async function recordDiscoveryVerification(input: { jobId: string; leaseToken: string; challengeId: string; recipeHash: string; input: AccessExecutionInput; result: unknown }) {
  const result = accessExecutionResultSchema.parse(input.result);
  return transaction(async tx => {
    const { job, now, source } = await owned(tx, input.jobId, input.leaseToken);
    const recipe = parseAccessRecipe(job.candidate);
    const verification = verificationSchema.parse(job.verification);
    bindRecipe(recipe, source, verification.sourceEvidence);
    const challenge = verification.challenges.find(item => item.id === input.challengeId);
    if (!challenge || input.recipeHash !== job.candidateHash || result.evidence.recipeHash !== job.candidateHash ||
      hashAccessRecipe(recipe) !== job.candidateHash || canonical(input.input) !== canonical(challenge.input)) conflict();
    if (challenge.result) {
      if (canonical(challenge.result) !== canonical(result)) conflict();
      return { verifiedCount: verification.challenges.filter(item => item.result).length };
    }
    const observed = Date.parse(result.observedAt);
    if (!isReaderObservationCurrent(observed, Date.parse(challenge.issuedAt), now.getTime()) ||
      result.sourceUrl !== recipe.source.bookingUrl || !result.complete || !["AVAILABLE", "EMPTY"].includes(result.status) ||
      !result.evidence.venueVerified || !result.evidence.dateVerified || !source.offering && !result.evidence.capacityVerified ||
      !result.evidence.durationVerified || !result.evidence.completeVerified ||
      (result.status === "AVAILABLE") !== (result.slots.length > 0)) conflict();
    for (const slot of result.slots) {
      const start = localSlotTime(slot.startsAt, challenge.input.timeZone);
      const correctBookingLink = recipe.engine === "EXISTING_ADAPTER" && recipe.adapter.family === "CHRONOGOLF"
        ? isChronogolfRecipeSlotLink(recipe.source.bookingUrl, recipe.adapter, challenge.input.date, slot)
        : new URL(slot.bookingUrl).origin === new URL(recipe.source.bookingUrl).origin;
      if (start.date !== challenge.input.date || start.time < challenge.input.startTime || start.time >= challenge.input.endTime ||
        !correctBookingLink) conflict();
      if (recipe.engine === "EXISTING_ADAPTER" && recipe.adapter.family === "TEEITUP" &&
          !isTeeItUpRecipeSlotLink(recipe.source.bookingUrl, challenge.input.date, recipe.adapter.facilityIds, slot)) conflict();
      if (!source.offering && slot.availableSpots < challenge.input.players) conflict();
      if (challenge.input.durationMinutes) {
        if (!slot.endsAt || Date.parse(slot.endsAt) - Date.parse(slot.startsAt) !== challenge.input.durationMinutes * 60_000) conflict();
        const windowEnd = parseCourseLocalWindowEnd(challenge.input.date, challenge.input.endTime, challenge.input.timeZone);
        if (Date.parse(slot.endsAt) > windowEnd.getTime()) conflict();
      }
    }
    challenge.result = result;
    challenge.receivedAt = now.toISOString();
    await tx.courseDiscoveryJob.update({ where: { id: job.id }, data: { verification: json(verification) } });
    return { verifiedCount: verification.challenges.filter(item => item.result).length };
  });
}

export async function activateDiscoveryRecipe(jobId: string, leaseToken: string) {
  return transaction(async tx => {
    const completed = await tx.courseDiscoveryJob.findUnique({ where: { id: jobId } });
    if (completed?.status === "SUCCEEDED" && completed.leaseToken === leaseToken) return activationSchema.parse(completed.result);
    const { job, now, source } = await owned(tx, jobId, leaseToken);
    const recipe = parseAccessRecipe(job.candidate);
    const verification = verificationSchema.parse(job.verification);
    bindRecipe(recipe, source, verification.sourceEvidence);
    if (hashAccessRecipe(recipe) !== job.candidateHash || verification.challenges.some(challenge => !challenge.result || !challenge.receivedAt || challenge.recipeHash !== job.candidateHash)) conflict();
    const verifiedDurations = verification.challenges.flatMap(challenge => challenge.input.durationMinutes ? [challenge.input.durationMinutes] : []);
    if (source.offering && verifiedDurations.length !== verification.challenges.length) conflict();
    const latest = await tx.courseAccessRecipe.findFirst({ where: { targetKey: job.targetKey }, orderBy: { version: "desc" }, select: { version: true } });
    const stored = await tx.courseAccessRecipe.create({ data: { targetKey: job.targetKey, courseId: job.courseId,
      offeringId: job.offeringId, version: (latest?.version ?? 0) + 1, hash: job.candidateHash!, sourceFingerprint: job.sourceFingerprint,
      payload: json(recipe), verification: json(verification) } });
    const updated = source.offering
      ? await tx.courseOffering.updateMany({ where: { id: source.offering.id, activeAccessRecipeId: job.baseRecipeId }, data: {
          activeAccessRecipeId: stored.id, monitoringRevision: { increment: 1 }, publicAccessStatus: "PUBLIC",
          automationEligibility: "ALLOWED",
          verifiedAt: now, evidenceUrl: recipe.source.officialUrl, bookingUrl: recipe.source.bookingUrl,
          supportedDurationsMinutes: [...new Set([...source.offering.supportedDurationsMinutes, ...verifiedDurations])].sort((a, b) => a - b),
        } })
      : await tx.course.updateMany({ where: { id: source.course.id, activeAccessRecipeId: job.baseRecipeId }, data: {
          activeAccessRecipeId: stored.id, bookingMethod: "PUBLIC_ONLINE", bookingAccessMode: "PUBLIC_SIGNED_OUT",
          automationEligibility: "ALLOWED", automationReason: "NONE", detectedBookingUrl: recipe.source.bookingUrl,
        } });
    if (updated.count !== 1) conflict();
    // The recipe row has not left this transaction. Bind it to the final
    // proven access facts before publishing the active pointer.
    const adopted = await loadSource(tx, source.target);
    await tx.courseAccessRecipe.update({ where: { id: stored.id }, data: { sourceFingerprint: adopted.sourceFingerprint } });
    const result = { jobId, target: source.target, recipeId: stored.id, version: stored.version, hash: stored.hash };
    await tx.courseDiscoveryJob.update({ where: { id: job.id }, data: {
      // Retain the finished token solely to make an ambiguous activation response
      // idempotent. No operation can renew or write a SUCCEEDED job.
      status: "SUCCEEDED", activeTargetKey: null, leaseExpiresAt: null, completedAt: now, outcome: "RECIPE_READY", result: json(result),
    } });
    return result;
  });
}

export async function getActiveAccessRecipe(target: { courseId: string; offeringId?: string }) {
  return transaction(async tx => {
    const source = await loadSource(tx, target);
    if (!source.activeRecipeId) return null;
    const stored = await tx.courseAccessRecipe.findUnique({ where: { id: source.activeRecipeId } });
    if (!stored || stored.targetKey !== targetKey(target) || stored.sourceFingerprint !== source.sourceFingerprint) return null;
    try {
      const recipe = parseAccessRecipe(stored.payload);
      bindRecipe(recipe, source);
      return hashAccessRecipe(recipe) === stored.hash ? { record: stored, recipe } : null;
    } catch (error) {
      // An obsolete or invalid recipe is missing coverage. Let admission clear
      // its pointer and repair it, while database/runtime failures still surface.
      if (error instanceof z.ZodError || error instanceof DiscoveryConflictError) return null;
      throw error;
    }
  });
}
export const getActiveRecipe = getActiveAccessRecipe;

/** Called inside the search result transaction, before canonical match writes. */
export async function assertActiveAccessRecipeInTransaction(tx: Tx, target: { courseId: string; offeringId?: string }, recipeId: string) {
  await lockSource(tx, target.courseId);
  const source = await loadSource(tx, target);
  if (source.activeRecipeId !== recipeId) conflict();
  const record = await tx.courseAccessRecipe.findUnique({ where: { id: recipeId } });
  if (!record || record.targetKey !== targetKey(target) || record.sourceFingerprint !== source.sourceFingerprint) conflict();
  const recipe = parseAccessRecipe(record.payload);
  bindRecipe(recipe, source);
  if (hashAccessRecipe(recipe) !== record.hash) conflict();
  return record;
}

export async function degradeRecipe(target: { courseId: string; offeringId?: string }, recipeId: string) {
  return transaction(async tx => {
    await lockSource(tx, target.courseId);
    const source = await loadSource(tx, target);
    if (source.activeRecipeId !== recipeId) return false;
    const updated = source.offering
      ? await tx.courseOffering.updateMany({ where: { id: source.offering.id, activeAccessRecipeId: recipeId }, data: { activeAccessRecipeId: null, monitoringRevision: { increment: 1 } } })
      : await tx.course.updateMany({ where: { id: source.course.id, activeAccessRecipeId: recipeId }, data: { activeAccessRecipeId: null } });
    return updated.count === 1;
  });
}
