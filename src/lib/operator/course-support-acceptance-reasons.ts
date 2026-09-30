import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";

import { inspectLatestParkedCourseCampaign, parseParkedCourseCampaignAudit,
  PARKED_COURSE_CAMPAIGN_PROMPT_VERSION } from "@/lib/automation/course-support-campaign";
import { loadOperatorCourseFleetCounts } from "./course-fleet";
import { loadCourseSupportAcceptanceProjection, parseCourseSupportAcceptanceProjection,
  type CourseSupportAcceptanceProjection } from "./course-support-acceptance";
import { assessFutureAutomaticResolution, assessRollingHumanReview,
  createOperatorCourseSupportCampaignDependencies, loadOperatorCourseSupportCampaign,
  COURSE_SUPPORT_ACCEPTANCE_PRIMARY_REASONS, type CourseSupportAcceptancePrimaryReasonCounts,
  type OperatorFutureAutomaticResolution, type OperatorRollingHumanReview } from "./course-support-campaign";
import { ACCEPTANCE_READ_LIMITS, AcceptanceReadFence, createBoundedAcceptanceReadClient } from "./course-support-acceptance-read-boundary";
import { parseAcceptanceReadFenceDetails, type AcceptanceReadFenceDetails,
  type AcceptanceReadPhase } from "./course-support-acceptance-read-fence";
import { parseAcceptanceReadCost, type AcceptanceReadCost } from "./course-support-acceptance-read-cost";

export type AcceptanceReasonsUnavailable = "INVALID_ARGUMENTS" | "DATABASE_UNAVAILABLE" |
  "CAMPAIGN_UNAVAILABLE" | "READ_TIMEOUT" | "READ_FAILED" | "EVIDENCE_BOUND_EXCEEDED" |
  "PROJECTION_SNAPSHOT_UNAVAILABLE" | "COUNT_RECONCILIATION_FAILED";
type FutureAssessment = { summary: OperatorFutureAutomaticResolution; primaryReasonCounts: CourseSupportAcceptancePrimaryReasonCounts };
type RollingAssessment = { summary: OperatorRollingHumanReview; primaryReasonCounts: CourseSupportAcceptancePrimaryReasonCounts };

class PhaseTaggedAcceptanceReadFence extends AcceptanceReadFence {
  constructor(error: AcceptanceReadFence, public readonly phase: AcceptanceReadPhase) {
    super(error.reason, error.boundary, error.readCost);
  }
}

/** Attach the throwing loader's phase without mutable state or new budgets. */
export async function withAcceptanceReadPhase<T>(phase: AcceptanceReadPhase, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof PhaseTaggedAcceptanceReadFence) throw error;
    if (error instanceof AcceptanceReadFence && error.reason === "EVIDENCE_BOUND_EXCEEDED" &&
        parseAcceptanceReadFenceDetails({ phase, boundary: error.boundary })) {
      throw new PhaseTaggedAcceptanceReadFence(error, phase);
    }
    throw error;
  }
}

export function unavailableAcceptanceReasons(input: {
  sourceSha: string | null; observedAt?: Date | null; reason: AcceptanceReasonsUnavailable;
  acceptanceProjection?: CourseSupportAcceptanceProjection | null;
  readFence?: AcceptanceReadFenceDetails | null;
  readCost?: AcceptanceReadCost | null;
}) {
  const readFence = input.reason === "EVIDENCE_BOUND_EXCEEDED" ? parseAcceptanceReadFenceDetails(input.readFence) : null;
  return {
    recordType: "course_support_acceptance_reasons" as const, schemaVersion: 4 as const,
    sourceSha: input.sourceSha, observedAt: input.observedAt?.toISOString() ?? null,
    status: "UNAVAILABLE" as const, reason: input.reason,
    acceptanceProjection: input.acceptanceProjection ?? null,
    futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false,
    readFence,
    readCost: readFence?.boundary === "SELECTED_EVIDENCE_BYTES" ? parseAcceptanceReadCost(input.readCost) : null,
    customerDataIncluded: false as const,
  };
}

/** Native summaries and one native reason per gap must reconcile exactly. */
export function buildAcceptanceReasonsReport(input: {
  sourceSha: string; observedAt: Date; acceptanceProjection: CourseSupportAcceptanceProjection;
  future: FutureAssessment; rolling: RollingAssessment;
}) {
  const projection = parseCourseSupportAcceptanceProjection(input.acceptanceProjection);
  const failure = (reason: AcceptanceReasonsUnavailable, readFence: AcceptanceReadFenceDetails | null = null) => unavailableAcceptanceReasons({
    sourceSha: input.sourceSha, observedAt: input.observedAt, reason,
    acceptanceProjection: projection ? input.acceptanceProjection : null,
    readFence,
  });
  if (!/^[a-f0-9]{40}$/u.test(input.sourceSha) || !Number.isFinite(input.observedAt.getTime())) {
    return unavailableAcceptanceReasons({ sourceSha: null, reason: "INVALID_ARGUMENTS" });
  }
  if (!projection?.operational) return failure("PROJECTION_SNAPSHOT_UNAVAILABLE");
  const countReasons = (reasons: CourseSupportAcceptancePrimaryReasonCounts) => {
    let total = 0;
    for (const [reason, count] of Object.entries(reasons)) {
      if (!(COURSE_SUPPORT_ACCEPTANCE_PRIMARY_REASONS as readonly string[]).includes(reason) ||
          !Number.isSafeInteger(count) || count < 0) return null;
      total += count;
    }
    return Number.isSafeInteger(total) ? total : null;
  };
  const futureCount = countReasons(input.future.primaryReasonCounts);
  const rollingCount = countReasons(input.rolling.primaryReasonCounts);
  if (!isDeepStrictEqual(input.future.summary, projection.operational.futureAutomaticWithin24Hours) ||
      !isDeepStrictEqual(input.rolling.summary, projection.operational.rollingHumanReview) ||
      futureCount !== projection.operational.futureAutomaticWithin24Hours.unknownCount ||
      rollingCount !== projection.operational.rollingHumanReview.ambiguousEndpointCount) {
    return failure("COUNT_RECONCILIATION_FAILED");
  }
  const result = {
    recordType: "course_support_acceptance_reasons" as const, schemaVersion: 4 as const,
    sourceSha: input.sourceSha, observedAt: input.observedAt.toISOString(),
    status: "AVAILABLE" as const, reason: "COMPLETE_NATIVE_TRACE" as const,
    acceptanceProjection: input.acceptanceProjection,
    futureUnknown: { nativeCount: input.future.summary.unknownCount, classifiedCount: futureCount,
      primaryReasonCounts: input.future.primaryReasonCounts, reconciliation: "MATCH" as const },
    rollingAmbiguous: { nativeCount: input.rolling.summary.ambiguousEndpointCount, classifiedCount: rollingCount,
      primaryReasonCounts: input.rolling.primaryReasonCounts, reconciliation: "MATCH" as const },
    evidenceReadComplete: true, customerDataIncluded: false as const, readFence: null, readCost: null,
  };
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= ACCEPTANCE_READ_LIMITS.outputBytes
    ? result : failure("EVIDENCE_BOUND_EXCEEDED", { phase: "REPORT_CONSTRUCTION", boundary: "OUTPUT_BYTES" });
}

/** All native evidence, projection and reasons share one bounded read-only snapshot. */
export async function loadCourseSupportAcceptanceReasons(
  database: Pick<PrismaClient, "$transaction">, sourceSha: string,
) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) return unavailableAcceptanceReasons({ sourceSha: null, reason: "INVALID_ARGUMENTS" });
  let observedAt: Date | null = null;
  try {
    return await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '25000ms'");
      const clock = await transaction.$queryRaw<Array<{ now: Date }>>`SELECT transaction_timestamp() AS now`;
      const now = clock[0]?.now;
      if (clock.length !== 1 || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AcceptanceReadFence("READ_FAILED");
      observedAt = now;
      const read = createBoundedAcceptanceReadClient(transaction);
      const campaign = await withAcceptanceReadPhase("CAMPAIGN_INSPECTION", () =>
        inspectLatestParkedCourseCampaign(read, { now, admissionRuntimeVersion: sourceSha }));
      if (!campaign) return unavailableAcceptanceReasons({ sourceSha, observedAt: now, reason: "CAMPAIGN_UNAVAILABLE" });
      const record = await withAcceptanceReadPhase("LATEST_CAMPAIGN_RECORD", () => read.automationRun.findFirst({
        where: { promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: { id: true, status: true, audit: true, notes: true },
      }));
      const audit = parseParkedCourseCampaignAudit(record?.audit);
      if (!record || record.id !== campaign.runId || !audit) {
        return unavailableAcceptanceReasons({ sourceSha, observedAt: now, reason: "CAMPAIGN_UNAVAILABLE" });
      }
      const base = createOperatorCourseSupportCampaignDependencies(read, { now, admissionRuntimeVersion: sourceSha });
      const evidence: {
        future: Awaited<ReturnType<typeof base.loadFutureUnfamiliarIncidents>> | null;
        rolling: Awaited<ReturnType<typeof base.loadRollingEndpointEvents>> | null;
      } = { future: null, rolling: null };
      const dependencies = {
        ...base,
        loadCampaignAudit: (runId: Parameters<typeof base.loadCampaignAudit>[0]) =>
          withAcceptanceReadPhase("LATEST_CAMPAIGN_RECORD", () => base.loadCampaignAudit(runId)),
        loadImplementationBatches: (input: Parameters<typeof base.loadImplementationBatches>[0]) =>
          withAcceptanceReadPhase("IMPLEMENTATION_HISTORY", () => base.loadImplementationBatches(input)),
        loadFutureUnfamiliarIncidents: (input: Parameters<typeof base.loadFutureUnfamiliarIncidents>[0]) => withAcceptanceReadPhase("FUTURE_CYCLES", async () => {
          evidence.future = await base.loadFutureUnfamiliarIncidents(input);
          if (evidence.future.length > ACCEPTANCE_READ_LIMITS.incidentRows) throw new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "COMBINED_FUTURE_ROWS");
          return evidence.future;
        }),
        loadRollingEndpointEvents: (input: Parameters<typeof base.loadRollingEndpointEvents>[0]) => withAcceptanceReadPhase("ROLLING_ENDPOINTS", async () => {
          evidence.rolling = await base.loadRollingEndpointEvents(input);
          return evidence.rolling;
        }),
      };
      // Remove private run identity and native total (the projection validates
      // its own total) while retaining the actual fresh campaign observation.
      const { runId, totalCount, ...observedCampaign } = campaign;
      void runId; void totalCount;
      const projection = await loadCourseSupportAcceptanceProjection({ now, observedCampaign }, {
        loadCourseFleetCounts: (input) => withAcceptanceReadPhase("FLEET", () => loadOperatorCourseFleetCounts(input, read)),
        loadLatestCampaignRecord: async () => record,
        loadFreshGlobalParkedCount: () => withAcceptanceReadPhase("GLOBAL_PARKED_COUNT", () => read.courseSupportIncident.count({
          where: { status: "NEEDS_HUMAN", humanReviewReason: "AUTOMATION_STALLED", activeBatchId: null, nextAttemptAt: null },
        })),
        loadCampaignSummary: (input) => loadOperatorCourseSupportCampaign(input, dependencies),
      });
      if (!evidence.future || !evidence.rolling) return unavailableAcceptanceReasons({ sourceSha, observedAt: now,
        reason: "PROJECTION_SNAPSHOT_UNAVAILABLE", acceptanceProjection: projection });
      return buildAcceptanceReasonsReport({ sourceSha, observedAt: now, acceptanceProjection: projection,
        future: assessFutureAutomaticResolution({ campaignCapturedAt: new Date(campaign.capturedAt),
          campaignRunId: campaign.runId, campaignMembershipDigest: campaign.membershipDigest,
          campaignIncidentCycles: audit.members.map(({ incidentId, cycle }) => ({ incidentId, cycle })),
          incidents: evidence.future, now }), rolling: assessRollingHumanReview(evidence.rolling) });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 30_000 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    const reason = error instanceof AcceptanceReadFence
      ? error.reason === "EVIDENCE_BOUND_EXCEEDED" ? "EVIDENCE_BOUND_EXCEEDED" : "READ_FAILED"
      : code === "P2028" || code === "57014" ? "READ_TIMEOUT" : "READ_FAILED";
    const readFence = error instanceof PhaseTaggedAcceptanceReadFence && reason === "EVIDENCE_BOUND_EXCEEDED"
      ? parseAcceptanceReadFenceDetails({ phase: error.phase, boundary: error.boundary }) : null;
    const readCost = error instanceof PhaseTaggedAcceptanceReadFence && readFence?.boundary === "SELECTED_EVIDENCE_BYTES"
      ? parseAcceptanceReadCost(error.readCost) : null;
    return unavailableAcceptanceReasons({ sourceSha, observedAt, reason, readFence, readCost });
  }
}

export async function runAcceptanceReasonsDiagnostic(input: { args: readonly string[] }, dependencies: {
  loadEnvironment: () => Promise<unknown>; getDatabaseUrl: () => string | undefined;
  readGitSourceSha: () => string; isCheckoutClean: () => boolean;
  read: (sourceSha: string) => ReturnType<typeof loadCourseSupportAcceptanceReasons>;
}) {
  const [mode, option, sourceSha] = input.args;
  if (input.args.length !== 3 || mode !== "--read-only" || option !== "--source-sha" ||
      !/^[a-f0-9]{40}$/u.test(sourceSha ?? "")) {
    return unavailableAcceptanceReasons({ sourceSha: null, reason: "INVALID_ARGUMENTS" });
  }
  try {
    if (dependencies.readGitSourceSha() !== sourceSha || !dependencies.isCheckoutClean()) {
      return unavailableAcceptanceReasons({ sourceSha: null, reason: "INVALID_ARGUMENTS" });
    }
    await dependencies.loadEnvironment();
    if (!dependencies.getDatabaseUrl()?.trim()) return unavailableAcceptanceReasons({ sourceSha, reason: "DATABASE_UNAVAILABLE" });
    return await dependencies.read(sourceSha);
  } catch {
    return unavailableAcceptanceReasons({ sourceSha, reason: "READ_FAILED" });
  }
}
