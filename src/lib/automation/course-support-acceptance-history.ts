import { Prisma } from "@prisma/client";

import { DELIVERY_SYNTHETIC_MULTI_CYCLE_DRY_RUN } from "@/lib/email/delivery-policy";
import { parseSearchEmailPayload } from "@/lib/email/search-delivery-payload";
import { prisma } from "@/lib/prisma";

import { parseCourseSupportActionExecution } from "./course-support-action-execution";
import { hasStrictCourseSupportImplementationExecutionProof } from "./course-support-batches";
import { getProviderExecutionEvidenceObservedAt } from "./provider-execution-marker";

export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_SCHEMA_VERSION = 1;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_RECORD_TYPE =
  "course_support_acceptance_history";
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_SCHEMA_VERSION = 1;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_WINDOW_MS =
  24 * 60 * 60 * 1_000;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_BATCHES = 256;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_INCIDENTS_PER_BATCH = 20;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_REQUESTS_PER_INCIDENT = 64;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_SEARCH_DISPATCHES_PER_BATCH = 256;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_DELIVERIES_PER_SEARCH = 256;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_MATCHES_PER_SEARCH = 256;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_LOCAL_READER_JOBS_PER_SEARCH = 256;
export const COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_PROBES_PER_SEARCH = 256;
export const COURSE_SUPPORT_RELEASE_LINEAGE_FAILURE_CLASS =
  "RELEASE_LINEAGE_UNVERIFIED";

const SUCCESSFUL_PROVIDER_OUTCOMES = new Set(["MATCH_FOUND", "NO_MATCH"]);
const DEPLOYMENT_REVALIDATION_PROMPT_VERSION =
  "course-monitoring-deployment-revalidation-v1";
const SAFE_ADAPTER_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const LOCAL_READER_ADAPTER_PREFIX = "LOCAL_READER:";
const MACHINE_OUTCOMES = new Set([
  "ready",
  "paused_by_control_plane",
  "blocked_env",
  "command_failed",
]);
const FAILURE_DOMAINS = new Set([
  "NONE",
  "PRIVACY",
  "DELIVERY",
  "UNSAFE_PROVIDER",
  "MIGRATION",
  "DEPLOYMENT",
  "PRODUCTION_VERIFICATION",
  "AUTH",
  "ENV",
  "GIT",
  "SLA",
]);

export type CourseSupportAcceptanceHistoryOptions = {
  machine: true;
  releaseSha: string;
  deployedAt: Date;
  windowStartedAt: Date;
  windowEndedAt: Date;
};

export type CourseSupportAcceptanceHistoryAvailability =
  "available" | "partial" | "unavailable";

type CourseSupportAcceptanceHistoryMetric = {
  count: number | null;
  unavailableCount: number;
  availability: CourseSupportAcceptanceHistoryAvailability;
};

export type CourseSupportAcceptanceHistory = {
  schemaVersion: typeof COURSE_SUPPORT_ACCEPTANCE_HISTORY_SCHEMA_VERSION;
  releaseSelection: "EXACT_DEPLOYMENT";
  windowBoundary: "HALF_OPEN";
  deployedAt: string;
  windowStartedAt: string;
  windowEndedAt: string;
  completedBatchCount: number;
  localReaderSuccessCount: number | null;
  localReaderSuccessUnavailableCount: number;
  localReaderSuccessAvailability: CourseSupportAcceptanceHistoryAvailability;
  strictReusableSupportExecutionCount: number | null;
  strictReusableSupportExecutionUnavailableCount: number;
  strictReusableSupportExecutionAvailability: CourseSupportAcceptanceHistoryAvailability;
  nonVacuousSearchRecheckSuccessCount: number | null;
  nonVacuousSearchRecheckUnavailableCount: number;
  nonVacuousSearchRecheckAvailability: CourseSupportAcceptanceHistoryAvailability;
  orchestrationOnlyCount: number | null;
  orchestrationOnlyUnavailableCount: number;
  orchestrationOnlyAvailability: CourseSupportAcceptanceHistoryAvailability;
  syntheticCanaryDispatchCount: number;
  syntheticCanaryProviderSuccessCount: number;
  syntheticCanarySenderBypassCount: number;
  syntheticCanaryExternalSendAttemptCount: number | null;
  syntheticCanaryExternalSendAttemptUnavailableCount: number;
  syntheticCanaryExternalSendAttemptAvailability: CourseSupportAcceptanceHistoryAvailability;
  localReaderSearchResumeSuccessCount: number;
  syntheticCanaryLocalReaderResumeSuccessCount: number;
};

export type CourseSupportAcceptanceHistoryMachineValue = {
  schemaVersion: typeof COURSE_SUPPORT_ACCEPTANCE_HISTORY_SCHEMA_VERSION | null;
  releaseSelection: "EXACT_DEPLOYMENT" | null;
  windowBoundary: "HALF_OPEN" | null;
  deployedAt: string | null;
  windowStartedAt: string | null;
  windowEndedAt: string | null;
  completedBatchCount: number | null;
  localReaderSuccessCount: number | null;
  localReaderSuccessUnavailableCount: number | null;
  localReaderSuccessAvailability: CourseSupportAcceptanceHistoryAvailability;
  strictReusableSupportExecutionCount: number | null;
  strictReusableSupportExecutionUnavailableCount: number | null;
  strictReusableSupportExecutionAvailability: CourseSupportAcceptanceHistoryAvailability;
  nonVacuousSearchRecheckSuccessCount: number | null;
  nonVacuousSearchRecheckUnavailableCount: number | null;
  nonVacuousSearchRecheckAvailability: CourseSupportAcceptanceHistoryAvailability;
  orchestrationOnlyCount: number | null;
  orchestrationOnlyUnavailableCount: number | null;
  orchestrationOnlyAvailability: CourseSupportAcceptanceHistoryAvailability;
  syntheticCanaryDispatchCount: number | null;
  syntheticCanaryProviderSuccessCount: number | null;
  syntheticCanarySenderBypassCount: number | null;
  syntheticCanaryExternalSendAttemptCount: number | null;
  syntheticCanaryExternalSendAttemptUnavailableCount: number | null;
  syntheticCanaryExternalSendAttemptAvailability: CourseSupportAcceptanceHistoryAvailability;
  localReaderSearchResumeSuccessCount: number | null;
  syntheticCanaryLocalReaderResumeSuccessCount: number | null;
};

export type CourseSupportAcceptanceHistoryBatch = {
  baseSha: string;
  completedAt: Date | null;
  releaseSha: string | null;
  deployedAt: Date | null;
  summary: unknown;
  incidents: ReadonlyArray<{
    verificationRequests: ReadonlyArray<{
      status: string;
      outcome: string | null;
      runtimeVersion: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      evidence: unknown;
    }>;
  }>;
  searchDispatches: ReadonlyArray<{
    searchRef: string;
    scheduleVersion: number;
    teeSearch: {
      syntheticMultiCycle: boolean;
      scheduleVersion: number;
      alertGeneration: number;
      lastCheckedAt: Date | null;
      emailDeliveries: ReadonlyArray<{
        id: string;
        alertGeneration: number;
        kind: string;
        payload: unknown;
        status: string;
        attemptCount: number;
        lastError: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>;
      matches: ReadonlyArray<{
        id: string;
        courseId: string;
        availabilityCycle: number;
        lastConfirmedAt: Date;
      }>;
      localReaderJobs: ReadonlyArray<{
        courseId: string;
        scheduleVersion: number | null;
        claimedAt: Date | null;
        completedAt: Date | null;
        resultExpiresAt: Date | null;
        readerVersion: string | null;
      }>;
      probes: ReadonlyArray<{
        courseId: string;
        outcome: string;
        observedAt: Date;
        runtimeVersion: string | null;
        rawSummary: unknown;
        automationRun: {
          kind: string;
          status: string;
          runtimeVersion: string | null;
          startedAt: Date;
          completedAt: Date | null;
          outcome: string | null;
          audit: unknown;
        } | null;
      }>;
    } | null;
  }>;
};

export class CourseSupportReleaseLineageError extends Error {
  readonly failureDomain = "DEPLOYMENT" as const;
  readonly failureClass = COURSE_SUPPORT_RELEASE_LINEAGE_FAILURE_CLASS;

  constructor() {
    super(
      "The requested course-support deployment does not have durable responder release lineage.",
    );
    this.name = "CourseSupportReleaseLineageError";
  }
}

function hasExactCourseSupportReleasePair(input: {
  releaseSha: string | null;
  deployedAt: Date | null;
  expectedReleaseSha: string;
  expectedDeployedAt: Date;
}) {
  return Boolean(
    input.releaseSha === input.expectedReleaseSha &&
    input.deployedAt?.getTime() === input.expectedDeployedAt.getTime(),
  );
}

export function parseCourseSupportAcceptanceHistoryOptions(
  args: readonly string[],
): CourseSupportAcceptanceHistoryOptions {
  const valueOptions = new Set([
    "--release-sha",
    "--deployed-at",
    "--window-started-at",
    "--window-ended-at",
  ]);
  const values = new Map<string, string>();
  let machineCount = 0;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--machine") {
      machineCount += 1;
      continue;
    }
    if (!valueOptions.has(argument)) {
      throw new Error("Unknown acceptance-history option.");
    }
    if (values.has(argument)) {
      throw new Error(
        "An acceptance-history option was provided more than once.",
      );
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("An acceptance-history option requires a value.");
    }
    values.set(argument, value);
    index += 1;
  }

  if (machineCount !== 1) {
    throw new Error("acceptance-history requires exactly one --machine flag.");
  }
  const releaseSha = values.get("--release-sha");
  if (!releaseSha || !/^[a-f0-9]{40}$/.test(releaseSha)) {
    throw new Error("--release-sha must be a full lowercase Git commit SHA.");
  }
  const deployedAt = parseRequiredCanonicalTimestamp(
    values.get("--deployed-at"),
    "--deployed-at",
  );
  const windowStartedAt = parseRequiredCanonicalTimestamp(
    values.get("--window-started-at"),
    "--window-started-at",
  );
  const windowEndedAt = parseRequiredCanonicalTimestamp(
    values.get("--window-ended-at"),
    "--window-ended-at",
  );
  if (windowStartedAt.getTime() < deployedAt.getTime()) {
    throw new Error("The acceptance window cannot start before deployment.");
  }
  const windowMs = windowEndedAt.getTime() - windowStartedAt.getTime();
  if (
    windowMs <= 0 ||
    windowMs > COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_WINDOW_MS
  ) {
    throw new Error(
      "The acceptance window must be positive and no longer than 24 hours.",
    );
  }

  return {
    machine: true,
    releaseSha,
    deployedAt,
    windowStartedAt,
    windowEndedAt,
  };
}

export async function getCourseSupportAcceptanceHistory(
  input: Omit<CourseSupportAcceptanceHistoryOptions, "machine">,
) {
  const releaseLineage = await prisma.courseMonitoringEvent.findFirst({
    where: {
      eventType: "DEPLOYMENT_VERIFIED",
      source: "DEPLOYMENT",
      runtimeVersion: input.releaseSha,
      deploymentSha: input.releaseSha,
      occurredAt: input.deployedAt,
      audit: {
        path: ["customerDataIncluded"],
        equals: false,
      },
    },
    select: { audit: true },
  });
  const releaseLineageAudit = asRecord(releaseLineage?.audit);
  if (
    typeof releaseLineageAudit.batchRef !== "string" ||
    releaseLineageAudit.batchRef.trim().length === 0 ||
    releaseLineageAudit.batchRef !== releaseLineageAudit.batchRef.trim() ||
    releaseLineageAudit.customerDataIncluded !== false
  ) {
    throw new CourseSupportReleaseLineageError();
  }
  const lineageBatch = await prisma.courseSupportBatch.findUnique({
    where: { reference: releaseLineageAudit.batchRef },
    select: {
      releaseSha: true,
      deployedAt: true,
      summary: true,
    },
  });
  const lineageReleasePairIsCurrent = Boolean(
    lineageBatch &&
    hasExactCourseSupportReleasePair({
      releaseSha: lineageBatch.releaseSha,
      deployedAt: lineageBatch.deployedAt,
      expectedReleaseSha: input.releaseSha,
      expectedDeployedAt: input.deployedAt,
    }),
  );
  // releaseHistory retains provenance but not the full search/probe/delivery
  // snapshot. Once this row advances, an empty query for the old pair cannot
  // distinguish true zero activity from evidence that moved off the live row.
  if (!lineageBatch || !lineageReleasePairIsCurrent) {
    throw new CourseSupportReleaseLineageError();
  }
  const [laterCourseDeploymentEvents, laterDeploymentRun] = await Promise.all([
    prisma.courseMonitoringEvent.findMany({
      where: {
        eventType: "DEPLOYMENT_VERIFIED",
        source: "DEPLOYMENT",
        runtimeVersion: { not: input.releaseSha },
        deploymentSha: { not: input.releaseSha },
        occurredAt: { gt: input.deployedAt },
        audit: {
          path: ["customerDataIncluded"],
          equals: false,
        },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 1,
      select: {
        runtimeVersion: true,
        deploymentSha: true,
        occurredAt: true,
        audit: true,
      },
    }),
    prisma.automationRun.findFirst({
      where: {
        id: { startsWith: "cm_deploy_" },
        promptVersion: DEPLOYMENT_REVALIDATION_PROMPT_VERSION,
        kind: "MAINTENANCE",
        status: "COMPLETED",
        outcome: "deployment_observed",
        runtimeVersion: { not: input.releaseSha },
        startedAt: { gt: input.deployedAt },
        auditSchemaVersion: 1,
        audit: {
          path: ["customerDataIncluded"],
          equals: false,
        },
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        runtimeVersion: true,
        startedAt: true,
        completedAt: true,
        audit: true,
      },
    }),
  ]);
  const releaseRemainedCurrent = Boolean(
    lineageReleasePairIsCurrent &&
    laterCourseDeploymentEvents.length === 0 &&
    !laterDeploymentRun,
  );
  const batches = await prisma.courseSupportBatch.findMany({
    where: {
      releaseSha: input.releaseSha,
      deployedAt: input.deployedAt,
      completedAt: {
        gte: input.windowStartedAt,
        lt: input.windowEndedAt,
      },
    },
    orderBy: { completedAt: "asc" },
    take: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_BATCHES + 1,
    select: {
      baseSha: true,
      completedAt: true,
      releaseSha: true,
      deployedAt: true,
      summary: true,
      incidents: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_INCIDENTS_PER_BATCH + 1,
        select: {
          verificationRequests: {
            where: { releaseSha: input.releaseSha },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take:
              COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_REQUESTS_PER_INCIDENT + 1,
            select: {
              status: true,
              outcome: true,
              runtimeVersion: true,
              startedAt: true,
              completedAt: true,
              evidence: true,
            },
          },
        },
      },
      searchDispatches: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take:
          COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_SEARCH_DISPATCHES_PER_BATCH + 1,
        select: {
          searchRef: true,
          scheduleVersion: true,
          teeSearch: {
            select: {
              syntheticMultiCycle: true,
              scheduleVersion: true,
              alertGeneration: true,
              lastCheckedAt: true,
              emailDeliveries: {
                where: {
                  OR: [
                    {
                      createdAt: {
                        gte: input.windowStartedAt,
                        lt: input.windowEndedAt,
                      },
                    },
                    {
                      updatedAt: {
                        gte: input.windowStartedAt,
                        lt: input.windowEndedAt,
                      },
                    },
                  ],
                },
                orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
                take:
                  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_DELIVERIES_PER_SEARCH +
                  1,
                select: {
                  id: true,
                  alertGeneration: true,
                  kind: true,
                  payload: true,
                  status: true,
                  attemptCount: true,
                  lastError: true,
                  createdAt: true,
                  updatedAt: true,
                },
              },
              matches: {
                where: {
                  lastConfirmedAt: {
                    gte: input.windowStartedAt,
                    lt: input.windowEndedAt,
                  },
                },
                orderBy: [{ lastConfirmedAt: "asc" }, { id: "asc" }],
                take:
                  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_MATCHES_PER_SEARCH + 1,
                select: {
                  id: true,
                  courseId: true,
                  availabilityCycle: true,
                  lastConfirmedAt: true,
                },
              },
              localReaderJobs: {
                where: {
                  purpose: "ALERT_CHECK",
                  status: "COMPLETED",
                  completedAt: {
                    gte: input.windowStartedAt,
                    lt: input.windowEndedAt,
                  },
                },
                orderBy: [{ completedAt: "asc" }, { id: "asc" }],
                take:
                  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_LOCAL_READER_JOBS_PER_SEARCH +
                  1,
                select: {
                  courseId: true,
                  scheduleVersion: true,
                  claimedAt: true,
                  completedAt: true,
                  resultExpiresAt: true,
                  readerVersion: true,
                },
              },
              probes: {
                where: {
                  outcome: { in: ["MATCH_FOUND", "NO_MATCH"] },
                  runtimeVersion: input.releaseSha,
                  observedAt: {
                    gte: input.windowStartedAt,
                    lt: input.windowEndedAt,
                  },
                },
                orderBy: [{ observedAt: "asc" }, { id: "asc" }],
                take:
                  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_PROBES_PER_SEARCH + 1,
                select: {
                  courseId: true,
                  outcome: true,
                  observedAt: true,
                  runtimeVersion: true,
                  rawSummary: true,
                  automationRun: {
                    select: {
                      kind: true,
                      status: true,
                      runtimeVersion: true,
                      startedAt: true,
                      completedAt: true,
                      outcome: true,
                      audit: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (batches.length > COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_BATCHES) {
    throw new Error(
      "The acceptance window exceeds the bounded completed-batch limit.",
    );
  }
  if (
    batches.some(
      (batch) =>
        batch.incidents.length >
        COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_INCIDENTS_PER_BATCH,
    )
  ) {
    throw new Error(
      "The acceptance window contains a batch beyond the bounded incident limit.",
    );
  }
  if (
    batches.some((batch) =>
      batch.incidents.some(
        (incident) =>
          incident.verificationRequests.length >
          COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_REQUESTS_PER_INCIDENT,
      ),
    )
  ) {
    throw new Error(
      "The acceptance window contains an incident beyond the bounded verification-request limit.",
    );
  }
  if (
    batches.some(
      (batch) =>
        batch.searchDispatches.length >
        COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_SEARCH_DISPATCHES_PER_BATCH,
    )
  ) {
    throw new Error(
      "The acceptance window contains a batch beyond the bounded search-dispatch limit.",
    );
  }
  if (
    batches.some((batch) =>
      batch.searchDispatches.some(
        (dispatch) =>
          (dispatch.teeSearch?.emailDeliveries.length ?? 0) >
          COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_DELIVERIES_PER_SEARCH,
      ),
    )
  ) {
    throw new Error(
      "The acceptance window contains a synthetic canary beyond the bounded delivery limit.",
    );
  }
  if (
    batches.some((batch) =>
      batch.searchDispatches.some(
        (dispatch) =>
          (dispatch.teeSearch?.matches.length ?? 0) >
          COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_MATCHES_PER_SEARCH,
      ),
    )
  ) {
    throw new Error(
      "The acceptance window contains a synthetic canary beyond the bounded match limit.",
    );
  }
  if (
    batches.some((batch) =>
      batch.searchDispatches.some(
        (dispatch) =>
          (dispatch.teeSearch?.localReaderJobs.length ?? 0) >
          COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_LOCAL_READER_JOBS_PER_SEARCH,
      ),
    )
  ) {
    throw new Error(
      "The acceptance window contains a search beyond the bounded local-reader-job limit.",
    );
  }
  if (
    batches.some((batch) =>
      batch.searchDispatches.some(
        (dispatch) =>
          (dispatch.teeSearch?.probes.length ?? 0) >
          COURSE_SUPPORT_ACCEPTANCE_HISTORY_MAX_PROBES_PER_SEARCH,
      ),
    )
  ) {
    throw new Error(
      "The acceptance window contains a search beyond the bounded probe limit.",
    );
  }
  return aggregateCourseSupportAcceptanceHistory({
    ...input,
    releaseRemainedCurrent,
    batches,
  });
}

export function aggregateCourseSupportAcceptanceHistory(input: {
  releaseSha: string;
  deployedAt: Date;
  windowStartedAt: Date;
  windowEndedAt: Date;
  releaseRemainedCurrent?: boolean;
  batches: readonly CourseSupportAcceptanceHistoryBatch[];
}): CourseSupportAcceptanceHistory {
  let localReaderSuccessCount = 0;
  let localReaderAvailableBatchCount = 0;
  let localReaderUnavailableCount = 0;
  let strictReusableSupportExecutionCount = 0;
  let strictReusableSupportAvailableBatchCount = 0;
  let strictReusableSupportUnavailableCount = 0;
  let nonVacuousSearchRecheckSuccessCount = 0;
  let nonVacuousSearchRecheckAvailableBatchCount = 0;
  let nonVacuousSearchRecheckUnavailableCount = 0;
  let orchestrationOnlyCount = 0;
  let orchestrationOnlyAvailableBatchCount = 0;
  let orchestrationOnlyUnavailableCount = 0;
  let syntheticCanaryDispatchCount = 0;
  let syntheticCanaryProviderSuccessCount = 0;
  let syntheticCanarySenderBypassCount = 0;
  let syntheticCanaryExternalSendAttemptUnavailableCount = 0;
  let syntheticCanaryExternalSendAttemptAvailableCount = 0;
  let localReaderSearchResumeSuccessCount = 0;
  let syntheticCanaryLocalReaderResumeSuccessCount = 0;
  const syntheticSenderBoundaryByDeliveryId = new Map<
    string,
    SyntheticSenderBoundary
  >();
  const observedLocalReaderResumeKeys = new Set<string>();

  for (const batch of input.batches) {
    if (
      batch.releaseSha !== input.releaseSha ||
      batch.deployedAt?.getTime() !== input.deployedAt.getTime() ||
      !batch.completedAt ||
      batch.completedAt.getTime() < input.windowStartedAt.getTime() ||
      batch.completedAt.getTime() >= input.windowEndedAt.getTime()
    ) {
      throw new Error(
        "Acceptance history received a batch outside the exact deployment window.",
      );
    }
    const localReader = classifyLocalReaderSuccesses(batch, input);
    if (localReader === null) {
      localReaderUnavailableCount += 1;
    } else {
      localReaderAvailableBatchCount += 1;
      localReaderSuccessCount += localReader;
    }

    const strictReusableSupport =
      classifyStrictReusableSupportExecutions(batch);
    if (strictReusableSupport === null) {
      strictReusableSupportUnavailableCount += 1;
    } else {
      strictReusableSupportAvailableBatchCount += 1;
      strictReusableSupportExecutionCount += strictReusableSupport;
    }

    const nonVacuousSearchRecheck = classifyNonVacuousSearchRecheckSuccess(
      batch.summary,
      input,
    );
    if (nonVacuousSearchRecheck === null) {
      nonVacuousSearchRecheckUnavailableCount += 1;
    } else {
      nonVacuousSearchRecheckAvailableBatchCount += 1;
      nonVacuousSearchRecheckSuccessCount += Number(nonVacuousSearchRecheck);
    }

    const syntheticDispatches = batch.searchDispatches.filter(
      (dispatch) => dispatch.teeSearch?.syntheticMultiCycle === true,
    );
    syntheticCanaryDispatchCount += syntheticDispatches.length;
    const dispatchRelationIsComplete =
      nonVacuousSearchRecheck === true &&
      hasCompleteCurrentSearchDispatchRelation(batch);
    if (dispatchRelationIsComplete) {
      for (const resume of classifyLocalReaderSearchResumes(batch, input)) {
        if (observedLocalReaderResumeKeys.has(resume.key)) continue;
        observedLocalReaderResumeKeys.add(resume.key);
        localReaderSearchResumeSuccessCount += 1;
        if (resume.syntheticMultiCycle) {
          syntheticCanaryLocalReaderResumeSuccessCount += 1;
        }
      }
    }
    for (const dispatch of syntheticDispatches) {
      const providerProofs = dispatchRelationIsComplete
        ? getExactSyntheticProviderCheckProofs(batch, dispatch, input)
        : [];
      if (providerProofs.length > 0) {
        syntheticCanaryProviderSuccessCount += 1;
      }
      for (const delivery of dispatch.teeSearch?.emailDeliveries ?? []) {
        const senderBoundary = classifySyntheticSenderBoundary(delivery, {
          releaseRemainedCurrent: input.releaseRemainedCurrent === true,
          deployedAt: input.deployedAt,
          windowStartedAt: input.windowStartedAt,
          windowEndedAt: input.windowEndedAt,
          dispatch,
          providerProofs,
        });
        const previous = syntheticSenderBoundaryByDeliveryId.get(delivery.id);
        syntheticSenderBoundaryByDeliveryId.set(
          delivery.id,
          combineSyntheticSenderBoundaries(previous, senderBoundary),
        );
      }
    }

    const orchestrationOnly = readOrchestrationOnlyCount(batch.summary);
    if (orchestrationOnly === null) {
      orchestrationOnlyUnavailableCount += 1;
    } else {
      orchestrationOnlyAvailableBatchCount += 1;
      orchestrationOnlyCount += orchestrationOnly;
    }
  }

  for (const senderBoundary of syntheticSenderBoundaryByDeliveryId.values()) {
    if (senderBoundary === "BYPASSED") {
      syntheticCanarySenderBypassCount += 1;
      syntheticCanaryExternalSendAttemptAvailableCount += 1;
    } else if (senderBoundary === "NOT_CLAIMED") {
      syntheticCanaryExternalSendAttemptAvailableCount += 1;
    } else {
      syntheticCanaryExternalSendAttemptUnavailableCount += 1;
    }
  }

  const localReaderMetric = finalizeMetric({
    count: localReaderSuccessCount,
    availableCount: localReaderAvailableBatchCount,
    unavailableCount: localReaderUnavailableCount,
  });
  const strictReusableSupportMetric = finalizeMetric({
    count: strictReusableSupportExecutionCount,
    availableCount: strictReusableSupportAvailableBatchCount,
    unavailableCount: strictReusableSupportUnavailableCount,
  });
  const nonVacuousSearchRecheckMetric = finalizeMetric({
    count: nonVacuousSearchRecheckSuccessCount,
    availableCount: nonVacuousSearchRecheckAvailableBatchCount,
    unavailableCount: nonVacuousSearchRecheckUnavailableCount,
  });
  const orchestrationOnlyMetric = finalizeMetric({
    count: orchestrationOnlyCount,
    availableCount: orchestrationOnlyAvailableBatchCount,
    unavailableCount: orchestrationOnlyUnavailableCount,
  });
  const syntheticExternalSendAttemptMetric = finalizeMetric({
    count: 0,
    availableCount: syntheticCanaryExternalSendAttemptAvailableCount,
    unavailableCount: syntheticCanaryExternalSendAttemptUnavailableCount,
  });

  return {
    schemaVersion: COURSE_SUPPORT_ACCEPTANCE_HISTORY_SCHEMA_VERSION,
    releaseSelection: "EXACT_DEPLOYMENT",
    windowBoundary: "HALF_OPEN",
    deployedAt: input.deployedAt.toISOString(),
    windowStartedAt: input.windowStartedAt.toISOString(),
    windowEndedAt: input.windowEndedAt.toISOString(),
    completedBatchCount: input.batches.length,
    localReaderSuccessCount: localReaderMetric.count,
    localReaderSuccessUnavailableCount: localReaderMetric.unavailableCount,
    localReaderSuccessAvailability: localReaderMetric.availability,
    strictReusableSupportExecutionCount: strictReusableSupportMetric.count,
    strictReusableSupportExecutionUnavailableCount:
      strictReusableSupportMetric.unavailableCount,
    strictReusableSupportExecutionAvailability:
      strictReusableSupportMetric.availability,
    nonVacuousSearchRecheckSuccessCount: nonVacuousSearchRecheckMetric.count,
    nonVacuousSearchRecheckUnavailableCount:
      nonVacuousSearchRecheckMetric.unavailableCount,
    nonVacuousSearchRecheckAvailability:
      nonVacuousSearchRecheckMetric.availability,
    orchestrationOnlyCount: orchestrationOnlyMetric.count,
    orchestrationOnlyUnavailableCount: orchestrationOnlyMetric.unavailableCount,
    orchestrationOnlyAvailability: orchestrationOnlyMetric.availability,
    syntheticCanaryDispatchCount,
    syntheticCanaryProviderSuccessCount,
    syntheticCanarySenderBypassCount,
    syntheticCanaryExternalSendAttemptCount:
      syntheticExternalSendAttemptMetric.count,
    syntheticCanaryExternalSendAttemptUnavailableCount:
      syntheticExternalSendAttemptMetric.unavailableCount,
    syntheticCanaryExternalSendAttemptAvailability:
      syntheticExternalSendAttemptMetric.availability,
    localReaderSearchResumeSuccessCount,
    syntheticCanaryLocalReaderResumeSuccessCount,
  };
}

export function buildCourseSupportAcceptanceHistoryMachineRecord(input: {
  outcome: string;
  acceptanceHistory?: unknown;
  failure?: unknown;
}) {
  return {
    outcome: MACHINE_OUTCOMES.has(input.outcome)
      ? input.outcome
      : "command_failed",
    recordType: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_RECORD_TYPE,
    schemaVersion: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_SCHEMA_VERSION,
    acceptanceHistory:
      input.acceptanceHistory === undefined
        ? null
        : projectCourseSupportAcceptanceHistory(input.acceptanceHistory),
    failure:
      input.failure === undefined || input.failure === null
        ? null
        : projectMachineFailure(input.failure),
  };
}

function classifyLocalReaderSuccesses(
  batch: CourseSupportAcceptanceHistoryBatch,
  input: {
    releaseSha: string;
    deployedAt: Date;
    windowStartedAt: Date;
    windowEndedAt: Date;
  },
) {
  let localReaderSuccessCount = 0;
  for (const request of batch.incidents.flatMap(
    (incident) => incident.verificationRequests,
  )) {
    if (request.status !== "SUCCEEDED") continue;
    if (!request.completedAt) return null;
    if (
      request.completedAt.getTime() < input.windowStartedAt.getTime() ||
      request.completedAt.getTime() >= input.windowEndedAt.getTime()
    ) {
      continue;
    }
    const evidence = asRecord(request.evidence);
    const observedAt = parseCanonicalTimestamp(evidence.observedAt);
    const adapterKey = evidence.adapterKey;
    if (
      !request.startedAt ||
      !request.outcome ||
      !observedAt ||
      typeof adapterKey !== "string" ||
      !SAFE_ADAPTER_KEY.test(adapterKey) ||
      evidence.schemaVersion !== 1 ||
      evidence.kind !== "PROVIDER_VERIFICATION" ||
      evidence.providerExecution !== true ||
      evidence.releaseSha !== input.releaseSha ||
      evidence.runtimeVersion !== input.releaseSha ||
      evidence.outcome !== request.outcome ||
      request.runtimeVersion !== input.releaseSha ||
      request.startedAt.getTime() < input.windowStartedAt.getTime() ||
      request.startedAt.getTime() < input.deployedAt.getTime() ||
      request.startedAt.getTime() > observedAt.getTime() ||
      observedAt.getTime() < input.windowStartedAt.getTime() ||
      observedAt.getTime() >= input.windowEndedAt.getTime() ||
      request.completedAt.getTime() < observedAt.getTime()
    ) {
      return null;
    }
    if (
      SUCCESSFUL_PROVIDER_OUTCOMES.has(request.outcome) &&
      adapterKey.startsWith(LOCAL_READER_ADAPTER_PREFIX)
    ) {
      localReaderSuccessCount += 1;
    }
  }
  return localReaderSuccessCount;
}

function classifyStrictReusableSupportExecutions(
  batch: CourseSupportAcceptanceHistoryBatch,
) {
  const summary = asRecord(batch.summary);
  const closeout = asRecord(summary.closeout);
  if (!Array.isArray(closeout.remediationAttempts)) return null;
  let count = 0;
  for (const rawAttempt of closeout.remediationAttempts) {
    const attempt = asRecord(rawAttempt);
    const execution = parseCourseSupportActionExecution(
      attempt.actionExecution,
    );
    if (!execution) return null;
    if (
      execution.action === "IMPLEMENT_REUSABLE_SUPPORT" &&
      execution.state === "EXECUTED" &&
      execution.reason === "STRICT_RUNTIME_RELEASE_DEPLOYMENT_PROOF"
    ) {
      if (
        !hasStrictCourseSupportImplementationExecutionProof({
          summary: batch.summary as Prisma.JsonValue | null,
          baseSha: batch.baseSha,
          releaseSha: batch.releaseSha,
          deployedAt: batch.deployedAt,
        })
      ) {
        return null;
      }
      count += 1;
    }
  }
  return count;
}

function classifyNonVacuousSearchRecheckSuccess(
  summaryValue: unknown,
  input: {
    deployedAt: Date;
    windowStartedAt: Date;
    windowEndedAt: Date;
  },
) {
  const summary = asRecord(summaryValue);
  const dispatch = asRecord(summary.recheckDispatch);
  if (typeof dispatch.attempted !== "boolean") return null;
  if (dispatch.attempted === false) {
    return dispatch.dispatchError === false &&
      dispatch.reason === "FINAL_DISPOSITION_ONLY"
      ? false
      : null;
  }
  if (
    dispatch.dispatchError !== false ||
    dispatch.dispatchKeyPersisted !== true ||
    dispatch.detachedVerificationDispatchError !== false ||
    dispatch.detachedVerificationAssignedStageOrchestrationGapCount !== 0 ||
    dispatch.detachedVerificationPendingCount !== 0 ||
    dispatch.detachedVerificationRerunNeeded !== false ||
    !isNonnegativeInteger(dispatch.affectedSearchCount) ||
    !isNonnegativeInteger(dispatch.queuedCount) ||
    !isNonnegativeInteger(dispatch.queueFailureCount) ||
    !isNonnegativeInteger(dispatch.directStartCount) ||
    !isNonnegativeInteger(dispatch.currentAffectedSearchCount) ||
    !isNonnegativeInteger(dispatch.healthySchedulerCount) ||
    !isNonnegativeInteger(dispatch.freshSearchCheckCount) ||
    !isNonnegativeInteger(dispatch.restoredCourseCount) ||
    !isNonnegativeInteger(dispatch.provenRunnableCourseCount) ||
    !isNonnegativeInteger(dispatch.affectedCourseSearchPairCount) ||
    !isNonnegativeInteger(dispatch.healthyCourseSearchPairCount) ||
    typeof dispatch.schedulerHealthComplete !== "boolean" ||
    typeof dispatch.courseOutcomeHealthComplete !== "boolean"
  ) {
    return null;
  }
  const dispatchedAt = parseCanonicalTimestamp(dispatch.dispatchedAt);
  const dispatchCompletedAt = parseCanonicalTimestamp(
    dispatch.dispatchCompletedAt,
  );
  const healthObservedAt = parseCanonicalTimestamp(
    dispatch.schedulerHealthObservedAt,
  );
  const fence = asRecord(summary.searchExecutionFence);
  if (
    !dispatchedAt ||
    !dispatchCompletedAt ||
    !healthObservedAt ||
    fence.schemaVersion !== 1 ||
    fence.settled !== true
  ) {
    return null;
  }
  const withinWindow =
    dispatchedAt.getTime() >= input.windowStartedAt.getTime() &&
    dispatchedAt.getTime() >= input.deployedAt.getTime() &&
    dispatchCompletedAt.getTime() >= dispatchedAt.getTime() &&
    healthObservedAt.getTime() >= dispatchCompletedAt.getTime() &&
    healthObservedAt.getTime() < input.windowEndedAt.getTime();
  if (!withinWindow) return false;

  return Boolean(
    dispatch.affectedSearchCount > 0 &&
    dispatch.queuedCount === dispatch.affectedSearchCount &&
    dispatch.queueFailureCount === dispatch.directStartCount &&
    dispatch.currentAffectedSearchCount === dispatch.affectedSearchCount &&
    dispatch.healthySchedulerCount === dispatch.currentAffectedSearchCount &&
    dispatch.freshSearchCheckCount === dispatch.currentAffectedSearchCount &&
    dispatch.restoredCourseCount > 0 &&
    dispatch.provenRunnableCourseCount === dispatch.restoredCourseCount &&
    dispatch.affectedCourseSearchPairCount > 0 &&
    dispatch.healthyCourseSearchPairCount ===
      dispatch.affectedCourseSearchPairCount &&
    dispatch.schedulerHealthComplete === true &&
    dispatch.courseOutcomeHealthComplete === true,
  );
}

function classifyLocalReaderSearchResumes(
  batch: CourseSupportAcceptanceHistoryBatch,
  input: {
    releaseSha: string;
    deployedAt: Date;
    windowStartedAt: Date;
    windowEndedAt: Date;
  },
) {
  const resumes: Array<{ key: string; syntheticMultiCycle: boolean }> = [];
  for (const dispatch of batch.searchDispatches) {
    const search = dispatch.teeSearch;
    if (!search) continue;
    for (const job of search.localReaderJobs) {
      if (
        typeof job.courseId !== "string" ||
        job.courseId.length === 0 ||
        !isNonnegativeInteger(job.scheduleVersion) ||
        !job.claimedAt ||
        !job.completedAt ||
        !job.resultExpiresAt ||
        typeof job.readerVersion !== "string" ||
        job.readerVersion.trim().length === 0 ||
        job.readerVersion.length > 64 ||
        job.claimedAt.getTime() > job.completedAt.getTime() ||
        job.completedAt.getTime() < input.deployedAt.getTime() ||
        job.completedAt.getTime() < input.windowStartedAt.getTime() ||
        job.completedAt.getTime() >= input.windowEndedAt.getTime() ||
        job.resultExpiresAt.getTime() !== job.completedAt.getTime()
      ) {
        continue;
      }
      const probe = search.probes.find((candidate) => {
        const automationRun = candidate.automationRun;
        const summary = asRecord(candidate.rawSummary);
        const providerObservedAt = parseCanonicalTimestamp(
          summary.providerObservedAt,
        );
        return Boolean(
          candidate.courseId === job.courseId &&
          SUCCESSFUL_PROVIDER_OUTCOMES.has(candidate.outcome) &&
          candidate.runtimeVersion === input.releaseSha &&
          candidate.observedAt.getTime() > job.completedAt!.getTime() &&
          candidate.observedAt.getTime() >= input.deployedAt.getTime() &&
          candidate.observedAt.getTime() >= input.windowStartedAt.getTime() &&
          candidate.observedAt.getTime() < input.windowEndedAt.getTime() &&
          summary.providerExecution === "LOCAL_BROWSER_READER" &&
          providerObservedAt?.getTime() === job.claimedAt!.getTime() &&
          automationRun?.kind === "SEARCH_CHECK" &&
          automationRun.status === "COMPLETED" &&
          automationRun.runtimeVersion === input.releaseSha &&
          automationRun.outcome === "success" &&
          automationRun.startedAt.getTime() > job.completedAt!.getTime() &&
          automationRun.startedAt.getTime() <= candidate.observedAt.getTime() &&
          automationRun.completedAt &&
          automationRun.completedAt.getTime() >=
            candidate.observedAt.getTime() &&
          automationRun.completedAt.getTime() <= batch.completedAt!.getTime() &&
          automationRun.completedAt.getTime() < input.windowEndedAt.getTime(),
        );
      });
      if (!probe) continue;
      resumes.push({
        key: [
          job.courseId,
          job.scheduleVersion,
          job.claimedAt.toISOString(),
          job.completedAt.toISOString(),
        ].join(":"),
        syntheticMultiCycle: search.syntheticMultiCycle,
      });
    }
  }
  return resumes;
}

function readOrchestrationOnlyCount(summaryValue: unknown) {
  const closeout = asRecord(asRecord(summaryValue).closeout);
  const decisionBasis = asRecord(closeout.decisionBasis);
  if (
    decisionBasis.schemaVersion !== 3 ||
    !isNonnegativeInteger(decisionBasis.orchestrationOnlyCount) ||
    closeout.orchestrationOnlyCount !== decisionBasis.orchestrationOnlyCount
  ) {
    return null;
  }
  return decisionBasis.orchestrationOnlyCount;
}

function finalizeMetric(input: {
  count: number;
  availableCount: number;
  unavailableCount: number;
}): CourseSupportAcceptanceHistoryMetric {
  return {
    count: input.unavailableCount === 0 ? input.count : null,
    unavailableCount: input.unavailableCount,
    availability:
      input.unavailableCount === 0
        ? "available"
        : input.availableCount === 0
          ? "unavailable"
          : "partial",
  };
}

function projectCourseSupportAcceptanceHistory(
  value: unknown,
): CourseSupportAcceptanceHistoryMachineValue {
  const history = asRecord(value);
  return {
    schemaVersion:
      history.schemaVersion === COURSE_SUPPORT_ACCEPTANCE_HISTORY_SCHEMA_VERSION
        ? COURSE_SUPPORT_ACCEPTANCE_HISTORY_SCHEMA_VERSION
        : null,
    releaseSelection:
      history.releaseSelection === "EXACT_DEPLOYMENT"
        ? "EXACT_DEPLOYMENT"
        : null,
    windowBoundary: history.windowBoundary === "HALF_OPEN" ? "HALF_OPEN" : null,
    deployedAt: machineTimestamp(history.deployedAt),
    windowStartedAt: machineTimestamp(history.windowStartedAt),
    windowEndedAt: machineTimestamp(history.windowEndedAt),
    completedBatchCount: machineCount(history.completedBatchCount),
    localReaderSuccessCount: machineNullableCount(
      history.localReaderSuccessCount,
    ),
    localReaderSuccessUnavailableCount: machineCount(
      history.localReaderSuccessUnavailableCount,
    ),
    localReaderSuccessAvailability: machineAvailability(
      history.localReaderSuccessAvailability,
    ),
    strictReusableSupportExecutionCount: machineNullableCount(
      history.strictReusableSupportExecutionCount,
    ),
    strictReusableSupportExecutionUnavailableCount: machineCount(
      history.strictReusableSupportExecutionUnavailableCount,
    ),
    strictReusableSupportExecutionAvailability: machineAvailability(
      history.strictReusableSupportExecutionAvailability,
    ),
    nonVacuousSearchRecheckSuccessCount: machineNullableCount(
      history.nonVacuousSearchRecheckSuccessCount,
    ),
    nonVacuousSearchRecheckUnavailableCount: machineCount(
      history.nonVacuousSearchRecheckUnavailableCount,
    ),
    nonVacuousSearchRecheckAvailability: machineAvailability(
      history.nonVacuousSearchRecheckAvailability,
    ),
    orchestrationOnlyCount: machineNullableCount(
      history.orchestrationOnlyCount,
    ),
    orchestrationOnlyUnavailableCount: machineCount(
      history.orchestrationOnlyUnavailableCount,
    ),
    orchestrationOnlyAvailability: machineAvailability(
      history.orchestrationOnlyAvailability,
    ),
    syntheticCanaryDispatchCount: machineCount(
      history.syntheticCanaryDispatchCount,
    ),
    syntheticCanaryProviderSuccessCount: machineCount(
      history.syntheticCanaryProviderSuccessCount,
    ),
    syntheticCanarySenderBypassCount: machineCount(
      history.syntheticCanarySenderBypassCount,
    ),
    syntheticCanaryExternalSendAttemptCount: machineNullableCount(
      history.syntheticCanaryExternalSendAttemptCount,
    ),
    syntheticCanaryExternalSendAttemptUnavailableCount: machineCount(
      history.syntheticCanaryExternalSendAttemptUnavailableCount,
    ),
    syntheticCanaryExternalSendAttemptAvailability: machineAvailability(
      history.syntheticCanaryExternalSendAttemptAvailability,
    ),
    localReaderSearchResumeSuccessCount: machineCount(
      history.localReaderSearchResumeSuccessCount,
    ),
    syntheticCanaryLocalReaderResumeSuccessCount: machineCount(
      history.syntheticCanaryLocalReaderResumeSuccessCount,
    ),
  };
}

function hasCompleteCurrentSearchDispatchRelation(
  batch: CourseSupportAcceptanceHistoryBatch,
) {
  const dispatch = asRecord(asRecord(batch.summary).recheckDispatch);
  return (
    isNonnegativeInteger(dispatch.currentAffectedSearchCount) &&
    batch.searchDispatches.length === dispatch.currentAffectedSearchCount &&
    batch.searchDispatches.every((entry) => entry.teeSearch !== null)
  );
}

type AcceptanceSearchDispatch =
  CourseSupportAcceptanceHistoryBatch["searchDispatches"][number];

type ExactSyntheticProviderCheckProof = {
  courseId: string;
  outcome: string;
  providerObservedAt: Date;
  probeObservedAt: Date;
  runStartedAt: Date;
  runCompletedAt: Date;
};

type SyntheticSenderBoundary = "BYPASSED" | "NOT_CLAIMED" | "UNAVAILABLE";

function getExactSyntheticProviderCheckProofs(
  batch: CourseSupportAcceptanceHistoryBatch,
  dispatch: AcceptanceSearchDispatch,
  input: {
    releaseSha: string;
    deployedAt: Date;
    windowStartedAt: Date;
    windowEndedAt: Date;
  },
): ExactSyntheticProviderCheckProof[] {
  const search = dispatch.teeSearch;
  const recheckDispatch = asRecord(asRecord(batch.summary).recheckDispatch);
  const dispatchedAt = parseCanonicalTimestamp(recheckDispatch.dispatchedAt);
  const dispatchCompletedAt = parseCanonicalTimestamp(
    recheckDispatch.dispatchCompletedAt,
  );
  const lastCheckedAt = search?.lastCheckedAt;
  const completedAt = batch.completedAt;
  if (
    !search ||
    search.syntheticMultiCycle !== true ||
    !/^[a-f0-9]{64}$/.test(dispatch.searchRef) ||
    !isNonnegativeInteger(dispatch.scheduleVersion) ||
    search.scheduleVersion !== dispatch.scheduleVersion ||
    !isNonnegativeInteger(search.alertGeneration) ||
    !dispatchedAt ||
    !dispatchCompletedAt ||
    !isFiniteDate(lastCheckedAt) ||
    !isFiniteDate(completedAt) ||
    dispatchedAt.getTime() < input.deployedAt.getTime() ||
    dispatchedAt.getTime() < input.windowStartedAt.getTime() ||
    dispatchCompletedAt.getTime() < dispatchedAt.getTime() ||
    lastCheckedAt.getTime() < dispatchedAt.getTime() ||
    lastCheckedAt.getTime() > completedAt.getTime() ||
    completedAt.getTime() >= input.windowEndedAt.getTime()
  ) {
    return [];
  }

  return search.probes.flatMap((probe) => {
    const automationRun = probe.automationRun;
    const providerObservedAt = getProviderExecutionEvidenceObservedAt({
      rawSummary: probe.rawSummary,
      probeObservedAt: probe.observedAt,
    });
    if (
      !SUCCESSFUL_PROVIDER_OUTCOMES.has(probe.outcome) ||
      probe.runtimeVersion !== input.releaseSha ||
      !providerObservedAt ||
      providerObservedAt.getTime() < dispatchedAt.getTime() ||
      providerObservedAt.getTime() < input.deployedAt.getTime() ||
      providerObservedAt.getTime() < input.windowStartedAt.getTime() ||
      !isFiniteDate(probe.observedAt) ||
      probe.observedAt.getTime() < providerObservedAt.getTime() ||
      probe.observedAt.getTime() >= input.windowEndedAt.getTime() ||
      !automationRun ||
      automationRun.kind !== "SEARCH_CHECK" ||
      automationRun.status !== "COMPLETED" ||
      automationRun.runtimeVersion !== input.releaseSha ||
      automationRun.outcome !== "success" ||
      !isFiniteDate(automationRun.startedAt) ||
      !isFiniteDate(automationRun.completedAt) ||
      automationRun.startedAt.getTime() < dispatchedAt.getTime() ||
      automationRun.startedAt.getTime() < input.deployedAt.getTime() ||
      automationRun.startedAt.getTime() < input.windowStartedAt.getTime() ||
      automationRun.completedAt.getTime() < probe.observedAt.getTime() ||
      automationRun.completedAt.getTime() > lastCheckedAt.getTime() ||
      automationRun.completedAt.getTime() > completedAt.getTime() ||
      automationRun.completedAt.getTime() >= input.windowEndedAt.getTime() ||
      !hasExactSyntheticSearchRunAudit({
        audit: automationRun.audit,
        searchRef: dispatch.searchRef,
        probeOutcome: probe.outcome,
      }) ||
      !hasCausalProviderExecutionForSyntheticRun({
        dispatch,
        probe,
        providerObservedAt,
        runStartedAt: automationRun.startedAt,
      })
    ) {
      return [];
    }
    return [
      {
        courseId: probe.courseId,
        outcome: probe.outcome,
        providerObservedAt,
        probeObservedAt: probe.observedAt,
        runStartedAt: automationRun.startedAt,
        runCompletedAt: automationRun.completedAt,
      },
    ];
  });
}

function hasExactSyntheticSearchRunAudit(input: {
  audit: unknown;
  searchRef: string;
  probeOutcome: string;
}) {
  const audit = asRecord(input.audit);
  const courseOutcomes = asRecord(audit.courseOutcomes);
  const outcomeCounts = Object.values(courseOutcomes);
  return Boolean(
    audit.trigger === "workflow" &&
    audit.searchRef === input.searchRef.slice(0, 16) &&
    audit.outcome === "success" &&
    isNonnegativeInteger(audit.checkedCourses) &&
    audit.checkedCourses > 0 &&
    outcomeCounts.length > 0 &&
    outcomeCounts.every(isNonnegativeInteger) &&
    outcomeCounts.reduce((total, count) => total + Number(count), 0) ===
      audit.checkedCourses &&
    isNonnegativeInteger(courseOutcomes[input.probeOutcome]) &&
    Number(courseOutcomes[input.probeOutcome]) > 0,
  );
}

function hasCausalProviderExecutionForSyntheticRun(input: {
  dispatch: AcceptanceSearchDispatch;
  probe: NonNullable<AcceptanceSearchDispatch["teeSearch"]>["probes"][number];
  providerObservedAt: Date;
  runStartedAt: Date;
}) {
  const providerExecution = asRecord(input.probe.rawSummary).providerExecution;
  if (providerExecution === "RUNNABLE_PROVIDER_CHECK") {
    return input.runStartedAt.getTime() <= input.providerObservedAt.getTime();
  }
  if (providerExecution !== "LOCAL_BROWSER_READER") {
    return false;
  }
  return Boolean(
    input.dispatch.teeSearch?.localReaderJobs.some(
      (job) =>
        job.courseId === input.probe.courseId &&
        job.scheduleVersion === input.dispatch.scheduleVersion &&
        typeof job.readerVersion === "string" &&
        job.readerVersion.trim().length > 0 &&
        job.readerVersion.length <= 64 &&
        isFiniteDate(job.claimedAt) &&
        isFiniteDate(job.completedAt) &&
        isFiniteDate(job.resultExpiresAt) &&
        job.claimedAt.getTime() === input.providerObservedAt.getTime() &&
        job.completedAt.getTime() >= job.claimedAt.getTime() &&
        job.resultExpiresAt.getTime() === job.completedAt.getTime() &&
        job.completedAt.getTime() < input.runStartedAt.getTime(),
    ),
  );
}

function classifySyntheticSenderBoundary(
  delivery: {
    alertGeneration: number;
    kind: string;
    payload: unknown;
    status: string;
    attemptCount: number;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  input: {
    releaseRemainedCurrent: boolean;
    deployedAt: Date;
    windowStartedAt: Date;
    windowEndedAt: Date;
    dispatch: AcceptanceSearchDispatch;
    providerProofs: readonly ExactSyntheticProviderCheckProof[];
  },
): SyntheticSenderBoundary {
  const createdAt = delivery.createdAt;
  const updatedAt = delivery.updatedAt;
  const search = input.dispatch.teeSearch;
  const createdUnderAcceptedRelease = Boolean(
    input.releaseRemainedCurrent &&
    search &&
    delivery.alertGeneration === search.alertGeneration &&
    isNonnegativeInteger(delivery.attemptCount) &&
    createdAt instanceof Date &&
    Number.isFinite(createdAt.getTime()) &&
    updatedAt instanceof Date &&
    Number.isFinite(updatedAt.getTime()) &&
    createdAt >= input.deployedAt &&
    createdAt >= input.windowStartedAt &&
    createdAt < input.windowEndedAt &&
    updatedAt >= createdAt &&
    updatedAt < input.windowEndedAt,
  );
  if (
    !createdUnderAcceptedRelease ||
    !search ||
    !isDeliveryBoundToExactSyntheticCheck(
      delivery,
      search,
      input.providerProofs,
    )
  ) {
    return "UNAVAILABLE" as const;
  }
  if (delivery.attemptCount === 0) {
    return delivery.status === "PENDING" && delivery.lastError === null
      ? ("NOT_CLAIMED" as const)
      : ("UNAVAILABLE" as const);
  }
  return isSyntheticSenderBypass(delivery)
    ? ("BYPASSED" as const)
    : ("UNAVAILABLE" as const);
}

function isDeliveryBoundToExactSyntheticCheck(
  delivery: {
    kind: string;
    payload: unknown;
    createdAt: Date;
    updatedAt: Date;
  },
  search: NonNullable<AcceptanceSearchDispatch["teeSearch"]>,
  providerProofs: readonly ExactSyntheticProviderCheckProof[],
) {
  const payload = parseExactAcceptanceDeliveryPayload(
    delivery.payload,
    delivery.kind,
  );
  if (!payload) return false;

  return providerProofs.some((candidate) => {
    if (
      payload.checkedAt.getTime() < candidate.probeObservedAt.getTime() ||
      payload.checkedAt.getTime() > candidate.runCompletedAt.getTime() ||
      delivery.createdAt.getTime() < payload.checkedAt.getTime() ||
      delivery.createdAt.getTime() > candidate.runCompletedAt.getTime() ||
      delivery.updatedAt.getTime() > candidate.runCompletedAt.getTime()
    ) {
      return false;
    }
    const sameRunProofs = providerProofs.filter(
      (proof) =>
        proof.runStartedAt.getTime() === candidate.runStartedAt.getTime() &&
        proof.runCompletedAt.getTime() === candidate.runCompletedAt.getTime(),
    );
    return payload.matchRefs.every((matchRef) => {
      const match = search.matches.find(
        (candidateMatch) =>
          candidateMatch.id === matchRef.matchId &&
          candidateMatch.availabilityCycle === matchRef.availabilityCycle,
      );
      if (!match || !isFiniteDate(match.lastConfirmedAt)) return false;
      return sameRunProofs.some(
        (proof) =>
          proof.courseId === match.courseId &&
          proof.outcome === "MATCH_FOUND" &&
          match.lastConfirmedAt.getTime() >=
            proof.providerObservedAt.getTime() &&
          match.lastConfirmedAt.getTime() <= payload.checkedAt.getTime(),
      );
    });
  });
}

function parseExactAcceptanceDeliveryPayload(value: unknown, kind: string) {
  const raw = asRecord(value);
  const payload = parseSearchEmailPayload(value);
  const checkedAt = parseCanonicalTimestamp(payload?.checkedAt);
  if (!payload || !checkedAt) return null;

  const rawMatchRefs = raw.matchRefs;
  const rawMatchIds = raw.matchIds;
  if (
    (rawMatchRefs !== undefined && !Array.isArray(rawMatchRefs)) ||
    (rawMatchIds !== undefined && !Array.isArray(rawMatchIds)) ||
    (Array.isArray(rawMatchRefs) &&
      payload.matchRefs?.length !== rawMatchRefs.length) ||
    (Array.isArray(rawMatchIds) &&
      payload.matchIds?.length !== rawMatchIds.length)
  ) {
    return null;
  }
  const matchRefs = payload.matchRefs ?? [];
  const matchIds = payload.matchIds ?? [];
  const uniqueMatchRefKeys = new Set(
    matchRefs.map(
      (matchRef) => `${matchRef.matchId}:${matchRef.availabilityCycle}`,
    ),
  );
  const uniqueMatchIds = new Set(matchIds);
  if (
    uniqueMatchRefKeys.size !== matchRefs.length ||
    uniqueMatchIds.size !== matchIds.length ||
    new Set(matchRefs.map((matchRef) => matchRef.matchId)).size !==
      matchRefs.length ||
    (matchIds.length > 0 &&
      (matchIds.length !== matchRefs.length ||
        matchRefs.some((matchRef) => !uniqueMatchIds.has(matchRef.matchId)))) ||
    (kind === "MATCH" &&
      (matchRefs.length === 0 || matchIds.length !== matchRefs.length))
  ) {
    return null;
  }
  return { checkedAt, matchRefs };
}

function combineSyntheticSenderBoundaries(
  previous: SyntheticSenderBoundary | undefined,
  next: SyntheticSenderBoundary,
): SyntheticSenderBoundary {
  if (!previous || previous === next) return next;
  if (previous === "UNAVAILABLE") return next;
  if (next === "UNAVAILABLE") return previous;
  return "UNAVAILABLE";
}

function isFiniteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isSyntheticSenderBypass(delivery: {
  status: string;
  lastError: string | null;
}) {
  return (
    delivery.status === "SUPPRESSED" &&
    delivery.lastError === DELIVERY_SYNTHETIC_MULTI_CYCLE_DRY_RUN
  );
}

function projectMachineFailure(value: unknown) {
  const failure = asRecord(value);
  return {
    failureDomain:
      typeof failure.failureDomain === "string" &&
      FAILURE_DOMAINS.has(failure.failureDomain)
        ? failure.failureDomain
        : null,
    failureClass:
      failure.failureClass === "DATABASE_URL_MISSING" ||
      failure.failureClass === COURSE_SUPPORT_RELEASE_LINEAGE_FAILURE_CLASS
        ? failure.failureClass
        : null,
    durableCloseoutRecorded:
      typeof failure.durableCloseoutRecorded === "boolean"
        ? failure.durableCloseoutRecorded
        : null,
    threadDisposition:
      failure.threadDisposition === "ARCHIVE" ||
      failure.threadDisposition === "KEEP_VISIBLE"
        ? failure.threadDisposition
        : null,
  };
}

function machineTimestamp(value: unknown) {
  return parseCanonicalTimestamp(value)?.toISOString() ?? null;
}

function machineNullableCount(value: unknown) {
  return value === null ? null : machineCount(value);
}

function machineCount(value: unknown) {
  return isNonnegativeInteger(value) ? value : null;
}

function machineAvailability(
  value: unknown,
): CourseSupportAcceptanceHistoryAvailability {
  return value === "available" || value === "partial" || value === "unavailable"
    ? value
    : "unavailable";
}

function parseRequiredCanonicalTimestamp(
  value: string | undefined,
  name: string,
) {
  const parsed = parseCanonicalTimestamp(value);
  if (!parsed) {
    throw new Error(`${name} must be an exact canonical UTC ISO timestamp.`);
  }
  return parsed;
}

function parseCanonicalTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : null;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
