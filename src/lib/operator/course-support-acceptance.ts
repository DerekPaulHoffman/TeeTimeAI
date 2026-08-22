import { z } from "zod";

import {
  PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION,
  PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT,
  PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
  parseParkedCourseCampaignAudit,
} from "@/lib/automation/course-support-campaign";
import { prisma } from "@/lib/prisma";

import { loadOperatorCourseFleetCounts } from "./course-fleet";
import {
  loadOperatorCourseSupportCampaign,
  type CampaignInspection,
  type OperatorCourseSupportCampaign,
} from "./course-support-campaign";

const ACCEPTANCE_SCHEMA_VERSION = 1 as const;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

type CampaignAudit = NonNullable<
  ReturnType<typeof parseParkedCourseCampaignAudit>
>;

export type CourseSupportAcceptanceObservedCampaign = {
  status: string;
  capturedAt: string;
  expectedCount: number;
  terminalCount: number;
  pendingCount: number;
  readyCount: number;
  activeCount: number;
  monitoredCount: number;
  bookingNotOpenCount: number;
  factualLimitationCount: number;
  technicalLimitationCount: number;
  sourceUnverifiedCount: number;
  engineeringBlockerCount: number;
  currentResultMissingCount: number;
  humanReviewCount: number;
  terminalWithin24HoursCount: number;
  automaticWithin24HoursCount: number;
  remainingGlobalParkedCount: number;
  membershipDigest: string;
};

type LatestCampaignRecord = {
  id: string;
  status: string;
  audit: unknown;
  notes: string | null;
};

type CourseFleetCounts = Awaited<
  ReturnType<typeof loadOperatorCourseFleetCounts>
>;

type CourseSupportAcceptanceDependencies = {
  loadCourseFleetCounts: (input: { now: Date }) => Promise<CourseFleetCounts>;
  loadLatestCampaignRecord: () => Promise<LatestCampaignRecord | null>;
  loadFreshGlobalParkedCount: () => Promise<number>;
  loadCampaignSummary: (input: {
    now: Date;
    campaignInspection: CampaignInspection;
    campaignAudit: CampaignAudit;
  }) => Promise<OperatorCourseSupportCampaign | null>;
};

const campaignProgressSchema = z
  .object({
    capturedAt: z.string().datetime(),
    expectedCount: z.number().int().positive(),
    totalCount: z.number().int().positive(),
    terminalCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    readyCount: z.number().int().nonnegative(),
    activeCount: z.number().int().nonnegative(),
    monitoredCount: z.number().int().nonnegative(),
    bookingNotOpenCount: z.number().int().nonnegative(),
    factualLimitationCount: z.number().int().nonnegative(),
    technicalLimitationCount: z.number().int().nonnegative(),
    sourceUnverifiedCount: z.number().int().nonnegative(),
    engineeringBlockerCount: z.number().int().nonnegative(),
    currentResultMissingCount: z.number().int().nonnegative(),
    humanReviewCount: z.number().int().nonnegative(),
    terminalWithin24HoursCount: z.number().int().nonnegative(),
    automaticWithin24HoursCount: z.number().int().nonnegative(),
    remainingGlobalParkedCount: z.number().int().nonnegative(),
    membershipDigest: z.string().regex(DIGEST_PATTERN),
  })
  .strict();

const completedCampaignNotesSchema = z
  .object({
    schemaVersion: z.literal(PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION),
    lifecycle: z.literal("closeout"),
    outcome: z.literal("completed"),
    progress: campaignProgressSchema,
    customerDataIncluded: z.literal(false),
  })
  .strict();

const nonnegativeCountSchema = z.number().int().nonnegative();
const fleetAcceptanceSchema = z
  .object({
    attention: z
      .object({
        actionCount: nonnegativeCountSchema,
        watchCount: nonnegativeCountSchema,
        totalCount: nonnegativeCountSchema,
      })
      .strict()
      .refine(
        (attention) =>
          attention.totalCount === attention.actionCount + attention.watchCount,
      ),
    engineeringNeededCount: nonnegativeCountSchema,
  })
  .strict();
const campaignEvidenceCategoriesSchema = z
  .object({
    sourceMissingCount: nonnegativeCountSchema,
    sourceConflictCount: nonnegativeCountSchema,
    providerSpecificCount: nonnegativeCountSchema,
    priorProbeCount: nonnegativeCountSchema,
    priorDiscoveryCount: nonnegativeCountSchema,
    noPriorEvidenceCount: nonnegativeCountSchema,
  })
  .strict();
const operationalFutureAutomaticSchema = z
  .object({
    windowDays: z.literal(30),
    eligibleCount: nonnegativeCountSchema,
    automaticCount: nonnegativeCountSchema,
    nonAutomaticCount: nonnegativeCountSchema,
    pendingCount: nonnegativeCountSchema,
    unknownCount: nonnegativeCountSchema,
    ratePercent: z.number().finite().nonnegative().max(100).nullable(),
    targetPercent: z.literal(95),
    status: z.enum(["PASS", "FAIL", "IN_PROGRESS", "NO_DATA", "UNKNOWN"]),
  })
  .strict();
const operationalRollingHumanReviewSchema = z
  .object({
    windowDays: z.literal(30),
    humanReviewCount: nonnegativeCountSchema,
    endpointCount: nonnegativeCountSchema,
    ratePercent: z.number().finite().nonnegative().max(100).nullable(),
    targetPercent: z.literal(5),
    ambiguousEndpointCount: nonnegativeCountSchema,
    status: z.enum(["PASS", "FAIL", "NO_DATA", "UNKNOWN"]),
  })
  .strict();
const operationalRepeatImplementationsSchema = z
  .object({
    repeatImplementationCount: nonnegativeCountSchema,
    implementationBatchCount: nonnegativeCountSchema,
    implementationGroupCount: nonnegativeCountSchema,
    status: z.enum(["PASS", "FAIL", "UNKNOWN"]),
  })
  .strict();
const availableAcceptanceProjectionSchema = z
  .object({
    schemaVersion: z.literal(ACCEPTANCE_SCHEMA_VERSION),
    status: z.enum(["PASS", "FAIL", "IN_PROGRESS", "UNKNOWN"]),
    reason: z.enum([
      "ALL_GATES_PASS",
      "ACCEPTANCE_GATE_FAILED",
      "BASELINE_OR_OPERATIONAL_IN_PROGRESS",
      "ACCEPTANCE_EVIDENCE_UNAVAILABLE",
    ]),
    fleet: fleetAcceptanceSchema,
    latestCampaign: z
      .object({
        lifecycleStatus: z.enum(["RUNNING", "COMPLETED", "FAILED"]),
        capturedAt: z.string().datetime(),
        expectedCount: z.literal(PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT),
        totalCount: z.literal(PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT),
        membershipDigest: z.string().regex(DIGEST_PATTERN),
        aggregateEvidenceCategories: campaignEvidenceCategoriesSchema,
        progress: z
          .object({
            terminalCount: nonnegativeCountSchema,
            totalCount: z.literal(PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT),
            pendingCount: nonnegativeCountSchema,
            remainingGlobalParkedCount: nonnegativeCountSchema,
            status: z.enum(["COMPLETE", "IN_PROGRESS", "UNKNOWN"]),
          })
          .strict(),
        currentResults: z
          .object({
            resultCount: nonnegativeCountSchema,
            accountedCount: nonnegativeCountSchema,
            totalCount: z.literal(PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT),
            missingCount: nonnegativeCountSchema,
            monitoredCount: nonnegativeCountSchema,
            bookingNotOpenCount: nonnegativeCountSchema,
            factualLimitationCount: nonnegativeCountSchema,
            technicalLimitationCount: nonnegativeCountSchema,
            sourceUnverifiedCount: nonnegativeCountSchema,
            readyCount: nonnegativeCountSchema,
            activeCount: nonnegativeCountSchema,
            engineeringBlockerCount: nonnegativeCountSchema,
            campaignHumanReviewCount: nonnegativeCountSchema,
            bucketInvariantStatus: z.enum(["PASS", "UNKNOWN"]),
            status: z.enum(["PASS", "UNKNOWN"]),
          })
          .strict(),
        baselineAutomaticWithin24Hours: z
          .object({
            automaticCount: nonnegativeCountSchema,
            totalCount: z.literal(PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT),
            deadlineAt: z.string().datetime(),
            targetPercent: z.literal(95),
            status: z.enum(["PASS", "FAIL", "IN_PROGRESS", "UNKNOWN"]),
          })
          .strict(),
      })
      .strict(),
    operational: z
      .object({
        futureAutomaticWithin24Hours: operationalFutureAutomaticSchema,
        rollingHumanReview: operationalRollingHumanReviewSchema,
        repeatImplementations: operationalRepeatImplementationsSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((projection, context) => {
    const expectedReason =
      projection.status === "PASS"
        ? "ALL_GATES_PASS"
        : projection.status === "FAIL"
          ? "ACCEPTANCE_GATE_FAILED"
          : projection.status === "IN_PROGRESS"
            ? "BASELINE_OR_OPERATIONAL_IN_PROGRESS"
            : "ACCEPTANCE_EVIDENCE_UNAVAILABLE";
    if (projection.reason !== expectedReason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Acceptance status and reason must agree.",
      });
    }
  });
const unavailableAcceptanceProjectionSchema = z
  .object({
    schemaVersion: z.literal(ACCEPTANCE_SCHEMA_VERSION),
    status: z.literal("UNKNOWN"),
    reason: z.enum([
      "ACCEPTANCE_READ_FAILED",
      "ACCEPTANCE_READ_TIMEOUT",
      "ACCEPTANCE_EVIDENCE_UNAVAILABLE",
      "LATEST_CAMPAIGN_UNAVAILABLE",
    ]),
    fleet: fleetAcceptanceSchema.nullable(),
    latestCampaign: z.null(),
    operational: z.null(),
  })
  .strict();
const courseSupportAcceptanceProjectionSchema = z.union([
  availableAcceptanceProjectionSchema,
  unavailableAcceptanceProjectionSchema,
]);

export function parseCourseSupportAcceptanceProjection(value: unknown) {
  const parsed = courseSupportAcceptanceProjectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type CourseSupportAcceptanceProjection =
  | ReturnType<typeof buildAvailableCourseSupportAcceptanceProjection>
  | ReturnType<typeof buildUnavailableCourseSupportAcceptanceProjection>;

export async function loadCourseSupportAcceptanceProjection(
  input: {
    now?: Date;
    observedCampaign?: CourseSupportAcceptanceObservedCampaign | null;
  } = {},
  dependencies: CourseSupportAcceptanceDependencies = defaultDependencies,
): Promise<CourseSupportAcceptanceProjection> {
  const now = input.now ?? new Date();
  const [fleetCounts, latestCampaignRecord] = await Promise.all([
    dependencies.loadCourseFleetCounts({ now }),
    dependencies.loadLatestCampaignRecord(),
  ]);
  const fleet = buildFleetAcceptance(fleetCounts);
  if (!fleet) {
    return buildUnavailableCourseSupportAcceptanceProjection(
      "ACCEPTANCE_EVIDENCE_UNAVAILABLE",
    );
  }
  if (!latestCampaignRecord) {
    return buildUnavailableCourseSupportAcceptanceProjection(
      "LATEST_CAMPAIGN_UNAVAILABLE",
      fleet,
    );
  }

  const audit = parseParkedCourseCampaignAudit(latestCampaignRecord.audit);
  if (
    !audit ||
    audit.expectedCount !== PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT ||
    !hasCoherentCampaignEvidencePartition(audit)
  ) {
    return buildUnavailableCourseSupportAcceptanceProjection(
      "LATEST_CAMPAIGN_UNAVAILABLE",
      fleet,
    );
  }
  const campaignInspection = await resolveCampaignInspection({
    audit,
    dependencies,
    latestCampaignRecord,
    observedCampaign: input.observedCampaign,
  });
  if (!campaignInspection) {
    return buildUnavailableCourseSupportAcceptanceProjection(
      "LATEST_CAMPAIGN_UNAVAILABLE",
      fleet,
    );
  }
  const campaignSummary = await dependencies.loadCampaignSummary({
    now,
    campaignInspection,
    campaignAudit: audit,
  });
  if (
    !campaignSummary ||
    !campaignSummaryMatchesAudit(campaignSummary, audit)
  ) {
    return buildUnavailableCourseSupportAcceptanceProjection(
      "LATEST_CAMPAIGN_UNAVAILABLE",
      fleet,
    );
  }

  return buildAvailableCourseSupportAcceptanceProjection({
    audit,
    campaign: campaignSummary,
    fleet,
  });
}

export async function attachCourseSupportAcceptanceProjection<
  T extends {
    observedAt: string;
    parkedCampaign: CourseSupportAcceptanceObservedCampaign | null;
  },
>(
  inspection: T,
  loadProjection: typeof loadCourseSupportAcceptanceProjection = loadCourseSupportAcceptanceProjection,
) {
  let acceptanceProjection: CourseSupportAcceptanceProjection;
  try {
    acceptanceProjection = await loadProjection({
      now: new Date(inspection.observedAt),
      observedCampaign: inspection.parkedCampaign,
    });
  } catch {
    acceptanceProjection = buildCourseSupportAcceptanceReadFailureProjection();
  }
  return { ...inspection, acceptanceProjection };
}

export function buildCourseSupportAcceptanceReadFailureProjection() {
  return buildUnavailableCourseSupportAcceptanceProjection(
    "ACCEPTANCE_READ_FAILED",
  );
}

export function buildCourseSupportAcceptanceTimeoutProjection() {
  return buildUnavailableCourseSupportAcceptanceProjection(
    "ACCEPTANCE_READ_TIMEOUT",
  );
}

function buildAvailableCourseSupportAcceptanceProjection(input: {
  audit: CampaignAudit;
  campaign: OperatorCourseSupportCampaign;
  fleet: CourseSupportAcceptanceFleet;
}) {
  const futureAutomatic = input.campaign.futureAutomaticWithin24Hours;
  const rollingHumanReview = input.campaign.rollingHumanReview;
  const repeatImplementations = input.campaign.repeatImplementations;
  const hasUnknownEvidence =
    input.campaign.progress.status === "UNKNOWN" ||
    input.campaign.currentResults.status === "UNKNOWN" ||
    ["UNKNOWN", "NO_DATA"].includes(futureAutomatic.status) ||
    ["UNKNOWN", "NO_DATA"].includes(rollingHumanReview.status) ||
    repeatImplementations.status === "UNKNOWN";
  const hasFailedGate =
    input.campaign.status === "FAILED" ||
    futureAutomatic.status === "FAIL" ||
    rollingHumanReview.status === "FAIL" ||
    repeatImplementations.status === "FAIL";
  const hasIncompleteBaseline =
    input.campaign.status !== "COMPLETED" ||
    input.campaign.progress.status !== "COMPLETE" ||
    input.campaign.currentResults.engineeringBlockerCount !== 0 ||
    input.fleet.engineeringNeededCount !== 0 ||
    futureAutomatic.status === "IN_PROGRESS";
  const status = hasFailedGate
    ? "FAIL"
    : hasUnknownEvidence
      ? "UNKNOWN"
      : hasIncompleteBaseline
        ? "IN_PROGRESS"
        : "PASS";

  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    status,
    reason:
      status === "PASS"
        ? ("ALL_GATES_PASS" as const)
        : status === "FAIL"
          ? ("ACCEPTANCE_GATE_FAILED" as const)
          : status === "IN_PROGRESS"
            ? ("BASELINE_OR_OPERATIONAL_IN_PROGRESS" as const)
            : ("ACCEPTANCE_EVIDENCE_UNAVAILABLE" as const),
    fleet: input.fleet,
    latestCampaign: {
      lifecycleStatus: input.campaign.status,
      capturedAt: input.campaign.capturedAt.toISOString(),
      expectedCount: input.campaign.expectedCount,
      totalCount: input.campaign.progress.totalCount,
      membershipDigest: input.audit.membershipDigest,
      aggregateEvidenceCategories: input.audit.aggregateEvidenceCategories,
      progress: input.campaign.progress,
      currentResults: input.campaign.currentResults,
      baselineAutomaticWithin24Hours: {
        ...input.campaign.automaticWithin24Hours,
        deadlineAt:
          input.campaign.automaticWithin24Hours.deadlineAt.toISOString(),
      },
    },
    operational: {
      futureAutomaticWithin24Hours: futureAutomatic,
      rollingHumanReview,
      repeatImplementations,
    },
  } as const;
}

type CourseSupportAcceptanceFleet = {
  attention: {
    actionCount: number;
    watchCount: number;
    totalCount: number;
  };
  engineeringNeededCount: number;
};

function buildFleetAcceptance(
  counts: CourseFleetCounts,
): CourseSupportAcceptanceFleet | null {
  if (
    ![counts.action, counts.watch, counts.engineeringNeeded].every(
      (value) => Number.isInteger(value) && value >= 0,
    )
  ) {
    return null;
  }
  return {
    attention: {
      actionCount: counts.action,
      watchCount: counts.watch,
      totalCount: counts.action + counts.watch,
    },
    engineeringNeededCount: counts.engineeringNeeded,
  };
}

function buildUnavailableCourseSupportAcceptanceProjection(
  reason:
    | "ACCEPTANCE_READ_FAILED"
    | "ACCEPTANCE_READ_TIMEOUT"
    | "ACCEPTANCE_EVIDENCE_UNAVAILABLE"
    | "LATEST_CAMPAIGN_UNAVAILABLE",
  fleet: CourseSupportAcceptanceFleet | null = null,
) {
  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    status: "UNKNOWN" as const,
    reason,
    fleet,
    latestCampaign: null,
    operational: null,
  };
}

async function resolveCampaignInspection(input: {
  audit: CampaignAudit;
  dependencies: CourseSupportAcceptanceDependencies;
  latestCampaignRecord: LatestCampaignRecord;
  observedCampaign?: CourseSupportAcceptanceObservedCampaign | null;
}): Promise<CampaignInspection | null> {
  if (input.observedCampaign) {
    return campaignInspectionFromObserved(
      input.latestCampaignRecord,
      input.audit,
      input.observedCampaign,
    );
  }
  if (input.latestCampaignRecord.status !== "COMPLETED") return null;
  const storedProgress = parseCompletedCampaignProgress(
    input.latestCampaignRecord.notes,
  );
  if (!storedProgress) return null;
  const remainingGlobalParkedCount =
    await input.dependencies.loadFreshGlobalParkedCount();
  if (
    !Number.isInteger(remainingGlobalParkedCount) ||
    remainingGlobalParkedCount < 0
  ) {
    return null;
  }
  return campaignInspectionFromProgress({
    audit: input.audit,
    progress: {
      ...storedProgress,
      remainingGlobalParkedCount,
    },
    runId: input.latestCampaignRecord.id,
    status: input.latestCampaignRecord.status,
  });
}

function campaignInspectionFromObserved(
  run: LatestCampaignRecord,
  audit: CampaignAudit,
  observed: CourseSupportAcceptanceObservedCampaign,
): CampaignInspection | null {
  if (
    !["RUNNING", "COMPLETED", "FAILED"].includes(observed.status) ||
    observed.status !== run.status
  ) {
    return null;
  }
  const { status: _status, ...observedProgress } = observed;
  void _status;
  const progress = campaignProgressSchema.safeParse({
    ...observedProgress,
    totalCount: observed.terminalCount + observed.pendingCount,
  });
  if (!progress.success) return null;
  return campaignInspectionFromProgress({
    audit,
    progress: progress.data,
    runId: run.id,
    status: run.status,
  });
}

function campaignInspectionFromProgress(input: {
  audit: CampaignAudit;
  progress: z.infer<typeof campaignProgressSchema>;
  runId: string;
  status: string;
}): CampaignInspection | null {
  if (
    !["RUNNING", "COMPLETED", "FAILED"].includes(input.status) ||
    input.progress.capturedAt !== input.audit.capturedAt ||
    input.progress.expectedCount !== input.audit.expectedCount ||
    input.progress.totalCount !== input.audit.expectedCount ||
    input.progress.terminalCount + input.progress.pendingCount !==
      input.progress.totalCount ||
    input.progress.membershipDigest !== input.audit.membershipDigest
  ) {
    return null;
  }
  return {
    runId: input.runId,
    status: input.status as CampaignInspection["status"],
    ...input.progress,
  };
}

function parseCompletedCampaignProgress(value: string | null) {
  if (!value) return null;
  try {
    const parsed = completedCampaignNotesSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data.progress : null;
  } catch {
    return null;
  }
}

function hasCoherentCampaignEvidencePartition(audit: CampaignAudit) {
  const categories = audit.aggregateEvidenceCategories;
  return (
    categories.sourceMissingCount +
      categories.sourceConflictCount +
      categories.providerSpecificCount ===
    audit.expectedCount
  );
}

function campaignSummaryMatchesAudit(
  campaign: OperatorCourseSupportCampaign,
  audit: CampaignAudit,
) {
  return (
    Number.isFinite(campaign.capturedAt.getTime()) &&
    campaign.capturedAt.toISOString() === audit.capturedAt &&
    campaign.expectedCount === audit.expectedCount &&
    campaign.progress.totalCount === audit.expectedCount &&
    campaign.currentResults.totalCount === audit.expectedCount
  );
}

const defaultDependencies: CourseSupportAcceptanceDependencies = {
  loadCourseFleetCounts: ({ now }) => loadOperatorCourseFleetCounts({ now }),
  loadLatestCampaignRecord: () =>
    prisma.automationRun.findFirst({
      where: { promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        audit: true,
        notes: true,
      },
    }),
  loadFreshGlobalParkedCount: () =>
    prisma.courseSupportIncident.count({
      where: {
        status: "NEEDS_HUMAN",
        humanReviewReason: "AUTOMATION_STALLED",
        activeBatchId: null,
        nextAttemptAt: null,
      },
    }),
  loadCampaignSummary: ({ now, campaignInspection, campaignAudit }) =>
    loadOperatorCourseSupportCampaign({
      now,
      campaignInspection,
      campaignAudit,
    }),
};
