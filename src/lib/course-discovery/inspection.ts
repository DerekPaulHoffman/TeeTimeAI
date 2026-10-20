type JsonRecord = Record<string, unknown>;
export const LEARNING_MATCHING_EMAIL_KINDS = ["MATCH", "SETUP", "DAILY", "MONITORING_STATUS_UPDATE"] as const;
const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : null;
const timestamp = (value: Date | null | undefined) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const milliseconds = (start: Date | null, end: Date | null) => start && end && end >= start ? end.getTime() - start.getTime() : null;
const allowed = (value: unknown, values: string[]) => typeof value === "string" && values.includes(value) ? value : "UNKNOWN";

export type LearningInspectionJob = {
  id: string; courseId: string; offeringId: string | null; status: string; attempts: number;
  createdAt: Date; firstPickedUpAt: Date | null; deadlineAt: Date | null; completedAt: Date | null;
  request: unknown; result: unknown;
};
export type LearningInspectionRecipe = { id: string; version: number; hash: string; payload: unknown };
export type LearningInspectionExecution = { id: string; status: string; claimedAt: Date | null; completedAt: Date | null;
  jobExpiresAt: Date; resultExpiresAt: Date | null; sourceContext: unknown; result: unknown };
export type LearningInspectionDelivery = { id: string; status: string; kind: string; alertGeneration: number;
  sentAt: Date | null; isOwnerRecipient: boolean; payload: unknown };

export function learningInspectionDemand(request: unknown) {
  const demand = record(record(request).demand);
  return { searchId: id(demand.searchId), alertGeneration: Number.isSafeInteger(demand.alertGeneration) ? Number(demand.alertGeneration) : null };
}

export function learningInspectionRecipeId(result: unknown) { return id(record(result).recipeId); }

export function learningInspectionMatchIds(deliveries: LearningInspectionDelivery[]) {
  return [...new Set(deliveries.flatMap(delivery => {
    const values = record(delivery.payload).matchIds;
    return Array.isArray(values) ? values.map(id).filter((value): value is string => value !== null) : [];
  }))];
}

export function summarizeLearningJob(input: {
  job: LearningInspectionJob; activatedRecipe: LearningInspectionRecipe | null; activeRecipeId: string | null;
  executions: LearningInspectionExecution[]; deliveries: LearningInspectionDelivery[]; targetMatchIds: string[];
  observedAt: Date; evidenceSince: Date; executionsTruncated: boolean; deliveriesTruncated: boolean;
}) {
  const { job, observedAt } = input;
  const demand = learningInspectionDemand(job.request);
  const matchIds = new Set(input.targetMatchIds);
  const deliveries = input.deliveries.filter(delivery => (LEARNING_MATCHING_EMAIL_KINDS as readonly string[]).includes(delivery.kind) && delivery.status === "SENT" &&
    delivery.alertGeneration === demand.alertGeneration && delivery.sentAt && job.firstPickedUpAt && delivery.sentAt >= job.firstPickedUpAt &&
    learningInspectionMatchIds([delivery]).some(matchId => matchIds.has(matchId))).sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime());
  const acceptedAt = deliveries[0]?.sentAt ?? null;
  const ownerAcceptedAt = deliveries.find(delivery => delivery.isOwnerRecipient)?.sentAt ?? null;
  const ownerAcceptanceTiming = !job.deadlineAt ? "UNKNOWN" : ownerAcceptedAt
    ? ownerAcceptedAt <= job.deadlineAt ? "WITHIN_DEADLINE" : "AFTER_DEADLINE"
    : observedAt > job.deadlineAt ? "MISSED" : "WAITING";
  const recipe = input.activatedRecipe;
  const payload = record(recipe?.payload);
  return {
    jobId: id(job.id), target: { courseId: id(job.courseId), offeringId: id(job.offeringId), kind: job.offeringId ? "SIMULATOR" : "OUTDOOR" },
    searchId: demand.searchId, alertGeneration: demand.alertGeneration,
    status: allowed(job.status, ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"]), attempts: job.attempts,
    createdAt: timestamp(job.createdAt), firstPickedUpAt: timestamp(job.firstPickedUpAt), deadlineAt: timestamp(job.deadlineAt), completedAt: timestamp(job.completedAt),
    elapsedSincePickupMs: milliseconds(job.firstPickedUpAt, job.completedAt ?? observedAt),
    activatedRecipe: recipe ? { id: id(recipe.id), version: recipe.version, hash: /^[a-f0-9]{64}$/u.test(recipe.hash) ? recipe.hash : null,
      engine: allowed(payload.engine, ["HTTP_JSON", "BROWSER_DOM", "EXISTING_ADAPTER"]),
      browserTransport: payload.engine === "BROWSER_DOM" ? allowed(payload.browserTransport ?? "PINNED_HTTP", ["PINNED_HTTP", "NATIVE_CHROME"]) : null,
      currentlyActive: recipe.id === input.activeRecipeId } : null,
    matchDelivery: { channel: "MATCHING_EMAIL", evidence: "PROVIDER_ACCEPTED_NOT_INBOX", correlation: "TARGET_AND_ALERT_GENERATION_NOT_RECIPE_CAUSATION",
      acceptedCount: deliveries.length, firstAcceptedAt: timestamp(acceptedAt), ownerAcceptedAt: timestamp(ownerAcceptedAt), ownerAcceptanceTiming,
      pickupToFirstAcceptedMs: milliseconds(job.firstPickedUpAt, acceptedAt), pickupToOwnerAcceptedMs: milliseconds(job.firstPickedUpAt, ownerAcceptedAt) },
    warmExecutions: input.executions.map(execution => ({ id: id(execution.id),
      recipeId: id(record(execution.sourceContext).recipeId), status: allowed(execution.status, ["PENDING", "LEASED", "COMPLETED", "FAILED", "EXPIRED"]),
      claimedAt: timestamp(execution.claimedAt), completedAt: timestamp(execution.completedAt), expiresAt: timestamp(execution.resultExpiresAt ?? execution.jobExpiresAt),
      resultStatus: allowed(record(execution.result).status, ["AVAILABLE", "EMPTY", "INCOMPLETE", "ACCESS_REQUIRED", "FAILED"]),
      fresh: execution.status === "COMPLETED" && Boolean(execution.resultExpiresAt && execution.resultExpiresAt > observedAt) })),
    evidenceBounds: { since: timestamp(input.evidenceSince), executionsTruncated: input.executionsTruncated, deliveriesTruncated: input.deliveriesTruncated },
  };
}

export function parseLearningInspectionArgs(args: string[]) {
  let limit = 10; let hours = 24; const jobIds: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!value) throw new Error("Invalid arguments");
    if (flag === "--job-id" && id(value)) jobIds.push(value);
    else if (flag === "--limit" && /^\d+$/u.test(value)) limit = Number(value);
    else if (flag === "--hours" && /^\d+$/u.test(value)) hours = Number(value);
    else throw new Error("Invalid arguments");
  }
  if (limit < 1 || limit > 30 || hours < 1 || hours > 72 || jobIds.length > 30) throw new Error("Invalid arguments");
  if (jobIds.length > limit) limit = jobIds.length;
  return { limit, hours, jobIds: [...new Set(jobIds)] };
}
