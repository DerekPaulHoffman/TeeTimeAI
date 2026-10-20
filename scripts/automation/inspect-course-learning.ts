import "./load-local-env";

import {
  LEARNING_MATCHING_EMAIL_KINDS, learningInspectionDemand, learningInspectionMatchIds, learningInspectionRecipeId, parseLearningInspectionArgs, summarizeLearningJob,
} from "@/lib/course-discovery/inspection";

async function main() {
  const options = parseLearningInspectionArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL?.replace(/^\uFEFF/u, "").trim()) throw new Error("Database configuration required");
  const observedAt = new Date();
  const since = new Date(observedAt.getTime() - options.hours * 3_600_000);
  const [{ PrismaClient }, { PrismaNeon }, { PrismaPg }, { resolveRuntimeDatabaseUrl }, { isLocalPostgresUrl }] = await Promise.all([
    import("@prisma/client"), import("@prisma/adapter-neon"), import("@prisma/adapter-pg"), import("@/lib/database-url"), import("@/lib/prisma"),
  ]);
  const connectionString = resolveRuntimeDatabaseUrl();
  const adapter = isLocalPostgresUrl(connectionString) ? new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }) : new PrismaNeon({ connectionString });
  const database = new PrismaClient({ adapter, log: [] });
  try {
    const receipt = await database.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const jobs = await tx.courseDiscoveryJob.findMany({ where: options.jobIds.length ? { id: { in: options.jobIds } } : { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" }, take: options.limit, select: { id: true, courseId: true, offeringId: true, status: true, attempts: true,
          createdAt: true, firstPickedUpAt: true, deadlineAt: true, completedAt: true, request: true, result: true,
          course: { select: { activeAccessRecipeId: true } }, offering: { select: { activeAccessRecipeId: true } } } });
      const rows = [];
      for (const job of jobs) {
        const demand = learningInspectionDemand(job.request);
        const recipeId = learningInspectionRecipeId(job.result);
        const evidenceSince = new Date(Math.max(since.getTime(), (job.firstPickedUpAt ?? job.createdAt).getTime()));
        const recipe = recipeId ? await tx.courseAccessRecipe.findUnique({ where: { id: recipeId }, select: { id: true, version: true, hash: true, payload: true } }) : null;
        const executions = await tx.localReaderJob.findMany({ where: { purpose: "RECIPE_CHECK", courseId: job.courseId, updatedAt: { gte: evidenceSince }, AND: [
          { sourceContext: { path: ["target", "kind"], equals: job.offeringId ? "SIMULATOR" : "OUTDOOR" } },
          ...(job.offeringId ? [{ sourceContext: { path: ["target", "offeringId"], equals: job.offeringId } }] : []),
          ...(demand.searchId ? [{ sourceContext: { path: ["searchId"], equals: demand.searchId } }] : []),
        ] }, orderBy: { updatedAt: "desc" }, take: 11, select: { id: true, status: true, claimedAt: true, completedAt: true,
          jobExpiresAt: true, resultExpiresAt: true, sourceContext: true, result: true } });
        const deliveries = demand.searchId && demand.alertGeneration !== null ? await tx.searchEmailDelivery.findMany({
          where: { teeSearchId: demand.searchId, alertGeneration: demand.alertGeneration, kind: { in: [...LEARNING_MATCHING_EMAIL_KINDS] }, status: "SENT", sentAt: { gte: evidenceSince } },
          orderBy: { sentAt: "asc" }, take: 31, select: { id: true, status: true, kind: true, alertGeneration: true, sentAt: true, isOwnerRecipient: true, payload: true },
        }) : [];
        const candidateMatchIds = learningInspectionMatchIds(deliveries.slice(0, 30));
        const matches = demand.searchId && candidateMatchIds.length ? await tx.teeTimeMatch.findMany({ where: {
          id: { in: candidateMatchIds.slice(0, 500) }, teeSearchId: demand.searchId, courseId: job.courseId, offeringId: job.offeringId,
        }, take: 500, select: { id: true } }) : [];
        rows.push(summarizeLearningJob({ job, activatedRecipe: recipe, activeRecipeId: job.offering?.activeAccessRecipeId ?? (job.offeringId ? null : job.course.activeAccessRecipeId),
          executions: executions.slice(0, 10), deliveries: deliveries.slice(0, 30), targetMatchIds: matches.map(match => match.id), observedAt, evidenceSince,
          executionsTruncated: executions.length > 10, deliveriesTruncated: deliveries.length > 30 || candidateMatchIds.length > 500 }));
      }
      return { schemaVersion: 1, observedAt: observedAt.toISOString(), status: "OK", readOnly: true,
        bounds: { hours: options.hours, jobLimit: options.limit, warmExecutionsPerJob: 10, deliveriesPerJob: 30, matchReferencesPerJob: 500 },
        jobLimitReached: jobs.length === options.limit, missingJobIds: options.jobIds.filter(id => !jobs.some(job => job.id === id)), jobs: rows };
    }, { timeout: 30_000 });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally { await database.$disconnect().catch(() => undefined); }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(), status: "UNAVAILABLE",
    error: "Inspection failed. Use --limit 1..30, --hours 1..72 and optional repeated --job-id; verify database configuration." })}\n`);
  process.exitCode = 1;
});
