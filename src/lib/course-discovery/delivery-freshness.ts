import type { Prisma } from "@prisma/client";

type DeliveryMatch = { courseId: string; offeringId: string | null; lastConfirmedAt: Date | null };
type Execution = { status: string; sourceContext: unknown; result: unknown; jobExpiresAt: Date;
  createdAt: Date; updatedAt: Date; claimedAt: Date | null; completedAt: Date | null };
type Demand = { id: string; alertGeneration: number; mode: string; date: Date; startTime: string; endTime: string;
  players: number; durationMinutes: number | null };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN;

/** A later read is not customer truth until its canonical match reconciliation commits.
 * This gates pending sends only; it never changes a previously sent match's visibility. */
export function recipeExecutionBlocksDelivery(job: Execution, matches: DeliveryMatch[], demand: Demand, now: Date): boolean {
  const context = object(job.sourceContext), target = object(context?.target), input = object(context?.input);
  if (!context || !target || !input || context.searchId !== demand.id || context.alertGeneration !== demand.alertGeneration ||
    target.kind !== demand.mode || input.date !== demand.date.toISOString().slice(0, 10) || input.startTime !== demand.startTime ||
    input.endTime !== demand.endTime || input.players !== demand.players ||
    (demand.mode === "SIMULATOR" && input.durationMinutes !== demand.durationMinutes)) return false;
  const relevant = matches.filter(match => match.courseId === target.courseId && (match.offeringId ?? null) === (target.offeringId ?? null));
  if (!relevant.length) return false;
  const confirmedAt = Math.min(...relevant.map(match => match.lastConfirmedAt?.getTime() ?? 0));
  if (["PENDING", "LEASED"].includes(job.status)) {
    const queuedAt = time(context.queuedAt);
    return job.jobExpiresAt > now && (Number.isFinite(queuedAt) ? queuedAt : (job.claimedAt ?? job.updatedAt ?? job.createdAt).getTime()) >= confirmedAt;
  }
  if (job.status !== "COMPLETED") return false;
  const result = object(job.result), consumed = object(context.consumed);
  if (result && consumed && consumed.recipeHash === context.recipeHash && consumed.observedAt === result.observedAt &&
    Number.isFinite(time(consumed.consumedAt))) return false;
  // Failed or empty results also fence the older opening, even after their cache TTL.
  // A genuinely later canonical read may supersede an abandoned observation.
  return (job.completedAt?.getTime() ?? job.updatedAt.getTime()) >= confirmedAt;
}

export async function hasUnreconciledRecipeDeliveryObservation(transaction: Prisma.TransactionClient, input: {
  searchId: string; alertGeneration: number; matchIds: string[]; now: Date;
}): Promise<boolean> {
  if (!input.matchIds.length) return false;
  const demand = await transaction.teeSearch.findUnique({ where: { id: input.searchId }, select: {
    id: true, alertGeneration: true, mode: true, date: true, startTime: true, endTime: true, players: true, durationMinutes: true,
  } });
  if (!demand || demand.alertGeneration !== input.alertGeneration) return false;
  const matches = await transaction.teeTimeMatch.findMany({ where: { teeSearchId: input.searchId, id: { in: input.matchIds } },
    select: { courseId: true, offeringId: true, lastConfirmedAt: true } });
  if (!matches.length) return false;
  const jobs = await transaction.localReaderJob.findMany({ where: { purpose: "RECIPE_CHECK", courseId: { in: [...new Set(matches.map(match => match.courseId))] },
    status: { in: ["PENDING", "LEASED", "COMPLETED"] }, AND: [
      { sourceContext: { path: ["searchId"], equals: input.searchId } },
      { sourceContext: { path: ["alertGeneration"], equals: input.alertGeneration } },
    ] }, orderBy: { updatedAt: "desc" }, take: 101,
    select: { status: true, sourceContext: true, result: true, jobExpiresAt: true, createdAt: true, updatedAt: true, claimedAt: true, completedAt: true } });
  return jobs.length > 100 || jobs.some(job => recipeExecutionBlocksDelivery(job, matches, demand, input.now));
}
