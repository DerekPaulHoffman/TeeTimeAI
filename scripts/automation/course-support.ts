import "./load-local-env";

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  normalizeGitCommandOutput,
  parseGitNulPaths,
  parseGitPorcelainV1ZPaths,
  resolveCodexOwnerThreadId
} from "./git-output";

import {
  appendCourseSupportBatchPath,
  backfillCourseSupportResponderState,
  claimCourseSupportBatch,
  chooseCourseSupportReleaseDiffBase,
  closeoutCourseSupportBatch,
  canVerifyUnchangedCourseSupportRuntime,
  getCourseSupportBatchPacket,
  getCourseSupportBatchRecoveryProvenance,
  grantOwnedCourseSupportVerificationStageDeadline,
  getOwnedCourseSupportLeaseToken,
  getOwnedCourseSupportSourceSearchContext,
  heartbeatCourseSupportBatch,
  inspectCourseSupportQueue,
  markCourseSupportBatchNeedsHuman,
  recordOwnedCourseSupportSourceSearchResult,
  recoverCourseSupportBatch,
  renewCourseSupportBatchOperationLease,
  resolveCourseSupportBatchReference,
  verifyCourseSupportBatch,
  type CourseSupportReleaseAdvanceProof
} from "@/lib/automation/course-support-batches";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import {
  AUTOMATION_WORKERS,
  completeAutomationWorker,
  isAutomationWorkerExecutionAllowed,
  runWithAutomationWorkerHeartbeat,
  shouldRecordAutomationWorkerCycle,
  startAutomationWorker
} from "@/lib/automation/worker-state";
import { runCourseSupportLeaseWatch } from "@/lib/automation/course-support-lease-watch";
import {
  assertCourseSupportVerificationWatchFlags,
  closeoutSettledCourseSupportVerification,
  runWithBoundedCourseSupportHeartbeat,
  runCourseSupportVerificationPass,
  runCourseSupportVerificationWatch,
  selectCourseSupportVerificationEndpointDeadline,
  selectCourseSupportVerificationStopMode
} from "@/lib/automation/course-support-verification-watch";
import { getProviderCoverageDashboard } from "@/lib/automation/provider-coverage";
import { persistOwnedCourseSupportBrowserPlaybookStages } from "@/lib/automation/course-support-browser-stages";
import { attachCourseSupportAcceptanceProjectionFromWorker } from "@/lib/operator/course-support-acceptance-process";
import {
  getResponderThreadPolicy,
  sanitizeResponderText,
  sanitizeResponderValue,
  type ResponderFailureDomain,
  type ResponderOutcome
} from "@/lib/automation/course-support-responder-policy";
import { inspectOwnedCourseSupportProviderContract } from "@/lib/automation/provider-contract-inspection";
import type {
  VercelDeploymentInspection,
  VercelDeploymentList,
} from "@/lib/deployments/vercel-git";
import { waitForGitDeployment } from "@/lib/deployments/wait-for-git-deployment";

import { runBrowserProbe } from "./browser-probe-needed-adapters";

const RESPONDER_OUTCOMES = new Set<ResponderOutcome>([
  "success",
  "classification_only",
  "partial",
  "retryable_failed",
  "needs_human",
  "blocked_auth",
  "blocked_env",
  "blocked_git",
  "migration_failed",
  "deploy_failed",
  "production_verification_failed",
  "privacy_incident",
  "delivery_incident",
  "unsafe_provider",
  "repeated_sla_failure",
  "command_failed"
]);
const FAILURE_DOMAINS = new Set<ResponderFailureDomain>([
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
  "SLA"
]);
const COURSE_SUPPORT_OPERATION_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1_000;
const execFileAsync = promisify(execFile);

type CourseSupportDatabaseEnvironment = {
  [key: string]: string | undefined;
  DATABASE_URL?: string;
};

export const COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS =
  "DATABASE_URL_MISSING";
export const COURSE_SUPPORT_COVERAGE_MACHINE_RECORD_TYPE =
  "course_support_coverage";
export const COURSE_SUPPORT_COVERAGE_MACHINE_SCHEMA_VERSION = 1;
const COURSE_SUPPORT_COVERAGE_MACHINE_OUTCOMES = new Set<string>([
  ...RESPONDER_OUTCOMES,
  "ready",
  "paused_by_control_plane"
]);

type CourseSupportCoverageOptions = {
  machine: boolean;
};

export type CourseSupportCoverageMachineFailure = {
  failureDomain: ResponderFailureDomain | null;
  failureClass: typeof COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS | null;
  durableCloseoutRecorded: boolean | null;
  threadDisposition: "ARCHIVE" | "KEEP_VISIBLE" | null;
};

const COURSE_SUPPORT_COVERAGE_MACHINE_CATEGORIES = [
  "MONITORED",
  "SUPPORTED_READY",
  "SUPPORTED_DEGRADED",
  "TECHNICAL_CONSTRAINT",
  "PHONE_OR_WALK_IN",
  "UNSUPPORTED_FAMILY",
  "SOURCE_UNVERIFIED",
  "PRIVATE_OR_INVALID"
] as const;
const COURSE_SUPPORT_COVERAGE_MACHINE_RECOMMENDED_ACTIONS = [
  "RUN_TYPED_ADAPTER",
  "DISCOVER_WITH_HTTP",
  "DISCOVER_WITH_BROWSER",
  "VERIFY_TECHNICAL_CONSTRAINT",
  "RETRY_PROVIDER",
  "REPAIR_PROVIDER_ADAPTER",
  "FINAL_TECHNICAL_CONSTRAINT",
  "FINAL_MANUAL_BOOKING",
  "FINAL_PRIVATE_OR_INVALID"
] as const;
const COURSE_SUPPORT_COVERAGE_MACHINE_CLAIM_ACTIONS = [
  "VERIFY_CURRENT_RUNTIME",
  "SEARCH_FOR_OFFICIAL_SOURCE",
  "INSPECT_PROVIDER_CONTRACT",
  "IMPLEMENT_REUSABLE_SUPPORT",
  "COMPLETE_CLASSIFICATION",
  "WAIT_FOR_MATERIAL_CHANGE"
] as const;

type CourseSupportCoverageMachineActionMetric = {
  selectedCount: number | null;
  confirmedExecutedCount: number | null;
  executionUnavailableCount: number | null;
  zeroExecutionCount: number | null;
  nonzeroExecutionCount: number | null;
  zeroExecutionUnavailableCount: number | null;
  executedCount: number | null;
  executionAvailability: "available" | "partial" | "unavailable" | null;
  zeroExecutionTotal: number | null;
};

type CourseSupportCoverageMachineActionTelemetry = {
  schemaVersion: 1 | null;
  windowDays: number | null;
  windowStartedAt: string | null;
  windowEndedAt: string | null;
  completedBatchCount: number | null;
  completedEntryCount: number | null;
  selectedActionCount: number | null;
  selectedActionUnavailableCount: number | null;
  confirmedExecutedActionCount: number | null;
  executedActionCount: number | null;
  executionUnavailableCount: number | null;
  zeroExecutionCount: number | null;
  nonzeroExecutionCount: number | null;
  zeroExecutionTotal: number | null;
  zeroExecutionUnavailableCount: number | null;
  actions: Record<
    (typeof COURSE_SUPPORT_COVERAGE_MACHINE_CLAIM_ACTIONS)[number],
    CourseSupportCoverageMachineActionMetric
  >;
};

export type CourseSupportCoverageMachineValue = {
  schemaVersion: 3 | null;
  observedAt: string | null;
  totalCourseCount: number | null;
  eligibleCourseCount: number | null;
  effectiveMonitoredCourseCount: number | null;
  effectiveCoveragePercent: number | null;
  categories: Record<
    (typeof COURSE_SUPPORT_COVERAGE_MACHINE_CATEGORIES)[number],
    number | null
  >;
  recommendedActions: Record<
    (typeof COURSE_SUPPORT_COVERAGE_MACHINE_RECOMMENDED_ACTIONS)[number],
    number | null
  >;
  sourceUnverifiedFinalCandidateCount: number | null;
  actionTelemetry: CourseSupportCoverageMachineActionTelemetry | null;
  providerGroupCount: number | null;
  providerGroupLimit: number | null;
  omittedProviderGroupCount: number | null;
};

export function parseCourseSupportCoverageOptions(
  args: readonly string[]
): CourseSupportCoverageOptions {
  const unknownArguments = args.filter((argument) => argument !== "--machine");
  if (unknownArguments.length > 0) {
    throw new Error("Unknown coverage option. Only --machine is supported.");
  }
  if (args.filter((argument) => argument === "--machine").length > 1) {
    throw new Error("--machine may be provided only once.");
  }
  return { machine: args.includes("--machine") };
}

export function buildCourseSupportCoverageMachineRecord(input: {
  outcome: string;
  coverage?: unknown;
  failure?: unknown;
}) {
  return {
    outcome: COURSE_SUPPORT_COVERAGE_MACHINE_OUTCOMES.has(input.outcome)
      ? input.outcome
      : "command_failed",
    recordType: COURSE_SUPPORT_COVERAGE_MACHINE_RECORD_TYPE,
    schemaVersion: COURSE_SUPPORT_COVERAGE_MACHINE_SCHEMA_VERSION,
    coverage:
      input.coverage === undefined
        ? null
        : projectCourseSupportCoverageMachineValue(input.coverage),
    failure:
      input.failure === undefined || input.failure === null
        ? null
        : projectCourseSupportCoverageMachineFailure(input.failure)
  };
}

function projectCourseSupportCoverageMachineFailure(
  value: unknown
): CourseSupportCoverageMachineFailure {
  const failure =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    failureDomain:
      typeof failure.failureDomain === "string" &&
      FAILURE_DOMAINS.has(failure.failureDomain as ResponderFailureDomain)
        ? (failure.failureDomain as ResponderFailureDomain)
        : null,
    failureClass:
      failure.failureClass === COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS
        ? COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS
        : null,
    durableCloseoutRecorded:
      typeof failure.durableCloseoutRecorded === "boolean"
        ? failure.durableCloseoutRecorded
        : null,
    threadDisposition:
      failure.threadDisposition === "ARCHIVE" ||
      failure.threadDisposition === "KEEP_VISIBLE"
        ? failure.threadDisposition
        : null
  };
}

function projectCourseSupportCoverageMachineValue(
  value: unknown
): CourseSupportCoverageMachineValue {
  const coverage = courseSupportCoverageMachineRecord(value);
  return {
    schemaVersion: coverage.schemaVersion === 3 ? 3 : null,
    observedAt: courseSupportCoverageMachineTimestamp(coverage.observedAt),
    totalCourseCount: courseSupportCoverageMachineCount(
      coverage.totalCourseCount
    ),
    eligibleCourseCount: courseSupportCoverageMachineCount(
      coverage.eligibleCourseCount
    ),
    effectiveMonitoredCourseCount: courseSupportCoverageMachineCount(
      coverage.effectiveMonitoredCourseCount
    ),
    effectiveCoveragePercent: courseSupportCoverageMachineFiniteNumber(
      coverage.effectiveCoveragePercent
    ),
    categories: projectCourseSupportCoverageMachineCounts(
      coverage.categories,
      COURSE_SUPPORT_COVERAGE_MACHINE_CATEGORIES
    ),
    recommendedActions: projectCourseSupportCoverageMachineCounts(
      coverage.recommendedActions,
      COURSE_SUPPORT_COVERAGE_MACHINE_RECOMMENDED_ACTIONS
    ),
    sourceUnverifiedFinalCandidateCount: courseSupportCoverageMachineCount(
      coverage.sourceUnverifiedFinalCandidateCount
    ),
    actionTelemetry: projectCourseSupportCoverageMachineActionTelemetry(
      coverage.actionTelemetry
    ),
    providerGroupCount: courseSupportCoverageMachineCount(
      coverage.providerGroupCount
    ),
    providerGroupLimit: courseSupportCoverageMachineCount(
      coverage.providerGroupLimit
    ),
    omittedProviderGroupCount: courseSupportCoverageMachineCount(
      coverage.omittedProviderGroupCount
    )
  };
}

function projectCourseSupportCoverageMachineActionTelemetry(
  value: unknown
): CourseSupportCoverageMachineActionTelemetry | null {
  if (!courseSupportCoverageMachineIsRecord(value)) return null;
  const telemetry = value;
  const actions = courseSupportCoverageMachineRecord(telemetry.actions);
  return {
    schemaVersion: telemetry.schemaVersion === 1 ? 1 : null,
    windowDays: courseSupportCoverageMachineCount(telemetry.windowDays),
    windowStartedAt: courseSupportCoverageMachineTimestamp(
      telemetry.windowStartedAt
    ),
    windowEndedAt: courseSupportCoverageMachineTimestamp(telemetry.windowEndedAt),
    completedBatchCount: courseSupportCoverageMachineCount(
      telemetry.completedBatchCount
    ),
    completedEntryCount: courseSupportCoverageMachineCount(
      telemetry.completedEntryCount
    ),
    selectedActionCount: courseSupportCoverageMachineCount(
      telemetry.selectedActionCount
    ),
    selectedActionUnavailableCount: courseSupportCoverageMachineCount(
      telemetry.selectedActionUnavailableCount
    ),
    confirmedExecutedActionCount: courseSupportCoverageMachineCount(
      telemetry.confirmedExecutedActionCount
    ),
    executedActionCount: courseSupportCoverageMachineCount(
      telemetry.executedActionCount
    ),
    executionUnavailableCount: courseSupportCoverageMachineCount(
      telemetry.executionUnavailableCount
    ),
    zeroExecutionCount: courseSupportCoverageMachineCount(
      telemetry.zeroExecutionCount
    ),
    nonzeroExecutionCount: courseSupportCoverageMachineCount(
      telemetry.nonzeroExecutionCount
    ),
    zeroExecutionTotal: courseSupportCoverageMachineCount(
      telemetry.zeroExecutionTotal
    ),
    zeroExecutionUnavailableCount: courseSupportCoverageMachineCount(
      telemetry.zeroExecutionUnavailableCount
    ),
    actions: Object.fromEntries(
      COURSE_SUPPORT_COVERAGE_MACHINE_CLAIM_ACTIONS.map((action) => [
        action,
        projectCourseSupportCoverageMachineActionMetric(actions[action])
      ])
    ) as CourseSupportCoverageMachineActionTelemetry["actions"]
  };
}

function projectCourseSupportCoverageMachineActionMetric(
  value: unknown
): CourseSupportCoverageMachineActionMetric {
  const metric = courseSupportCoverageMachineRecord(value);
  const executionAvailability = metric.executionAvailability;
  return {
    selectedCount: courseSupportCoverageMachineCount(metric.selectedCount),
    confirmedExecutedCount: courseSupportCoverageMachineCount(
      metric.confirmedExecutedCount
    ),
    executionUnavailableCount: courseSupportCoverageMachineCount(
      metric.executionUnavailableCount
    ),
    zeroExecutionCount: courseSupportCoverageMachineCount(
      metric.zeroExecutionCount
    ),
    nonzeroExecutionCount: courseSupportCoverageMachineCount(
      metric.nonzeroExecutionCount
    ),
    zeroExecutionUnavailableCount: courseSupportCoverageMachineCount(
      metric.zeroExecutionUnavailableCount
    ),
    executedCount: courseSupportCoverageMachineCount(metric.executedCount),
    executionAvailability:
      executionAvailability === "available" ||
      executionAvailability === "partial" ||
      executionAvailability === "unavailable"
        ? executionAvailability
        : null,
    zeroExecutionTotal: courseSupportCoverageMachineCount(
      metric.zeroExecutionTotal
    )
  };
}

function projectCourseSupportCoverageMachineCounts<Key extends string>(
  value: unknown,
  keys: readonly Key[]
) {
  const source = courseSupportCoverageMachineRecord(value);
  return Object.fromEntries(
    keys.map((key) => [key, courseSupportCoverageMachineCount(source[key])])
  ) as Record<Key, number | null>;
}

function courseSupportCoverageMachineCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function courseSupportCoverageMachineFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function courseSupportCoverageMachineTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function courseSupportCoverageMachineRecord(
  value: unknown
): Record<string, unknown> {
  return courseSupportCoverageMachineIsRecord(value) ? value : {};
}

function courseSupportCoverageMachineIsRecord(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export class CourseSupportDatabaseEnvironmentError extends Error {
  readonly outcome: ResponderOutcome = "blocked_env";
  readonly failureDomain: ResponderFailureDomain = "ENV";
  readonly failureClass = COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS;

  constructor() {
    super(
      "Course-support database access requires an explicit DATABASE_URL; run the command through the configured environment wrapper."
    );
    this.name = "CourseSupportDatabaseEnvironmentError";
  }
}

export function requireExplicitCourseSupportDatabaseUrl(
  environment: CourseSupportDatabaseEnvironment
) {
  const databaseUrl = environment.DATABASE_URL?.replace(/^\uFEFF/, "").trim();
  if (!databaseUrl) {
    throw new CourseSupportDatabaseEnvironmentError();
  }
  return databaseUrl;
}

export async function runWithExplicitCourseSupportDatabaseUrl<T>(
  environment: CourseSupportDatabaseEnvironment,
  operation: () => Promise<T> | T
) {
  requireExplicitCourseSupportDatabaseUrl(environment);
  return operation();
}

async function main() {
  await runWithExplicitCourseSupportDatabaseUrl(
    process.env,
    runConfiguredCommand
  );
}

async function runConfiguredCommand() {
  const [command = "inspect", ...args] = process.argv.slice(2);
  const coverageOptions =
    command === "coverage" ? parseCourseSupportCoverageOptions(args) : null;
  const scheduledCycle = shouldRecordAutomationWorkerCycle({ command, args });
  if (!scheduledCycle) {
    if (!(await isAutomationWorkerExecutionAllowed(AUTOMATION_WORKERS.COURSE_SUPPORT))) {
      const pausedResult = { outcome: "paused_by_control_plane" };
      writeResult(
        coverageOptions?.machine
          ? buildCourseSupportCoverageMachineRecord({
              outcome: pausedResult.outcome
            })
          : pausedResult,
        { machine: coverageOptions?.machine }
      );
      return;
    }
    await runCommand(command, args, coverageOptions);
    return;
  }
  const worker = await startAutomationWorker(AUTOMATION_WORKERS.COURSE_SUPPORT, {
    runnerVersion: "course-support-v3"
  });
  if (!worker.allowed) {
    writeResult({ outcome: "paused_by_control_plane" });
    return;
  }
  try {
    await runWithAutomationWorkerHeartbeat(
      AUTOMATION_WORKERS.COURSE_SUPPORT,
      () => runCommand(command, args, coverageOptions),
      { intervalMs: COURSE_SUPPORT_OPERATION_HEARTBEAT_INTERVAL_MS }
    );
    await completeAutomationWorker(
      AUTOMATION_WORKERS.COURSE_SUPPORT,
      `${command}_completed`
    );
  } catch (error) {
    await completeAutomationWorker(
      AUTOMATION_WORKERS.COURSE_SUPPORT,
      `${command}_failed`
    );
    throw error;
  }
}

async function runCommand(
  command: string,
  args: string[],
  coverageOptions: CourseSupportCoverageOptions | null
) {
  switch (command) {
    case "inspect":
      writeResult(
        await attachCourseSupportAcceptanceProjectionFromWorker(
          await inspectCourseSupportQueue({
            requestingThreadId: optionalOwnerThread(args),
            completeParkedCampaignIfDone:
              shouldCompleteParkedCampaignForInspection(args)
          })
        )
      );
      return;
    case "coverage": {
      const options =
        coverageOptions ?? parseCourseSupportCoverageOptions(args);
      const coverage = await getProviderCoverageDashboard();
      writeResult(
        options.machine
          ? buildCourseSupportCoverageMachineRecord({
              outcome: "ready",
              coverage
            })
          : coverage,
        { machine: options.machine }
      );
      return;
    }
    case "claim":
      writeResult(await claim(args));
      return;
    case "packet":
      writeResult(await packet(args));
      return;
    case "inspect-provider-contract":
      writeResult(await inspectProviderContract(args));
      return;
    case "claim-path":
      writeResult(await claimPath(args));
      return;
    case "source-search-context":
      writeResult(await sourceSearchContext(args));
      return;
    case "record-source-search":
      writeResult(await recordSourceSearch(args));
      return;
    case "mark-needs-human":
      writeResult(await markNeedsHuman(args));
      return;
    case "heartbeat":
      writeResult(await heartbeat(args));
      return;
    case "verify":
      writeResult(await verify(args));
      return;
    case "verify-release":
      writeResult(await verifyRelease(args));
      return;
    case "closeout":
      writeResult(await closeout(args));
      return;
    case "recover":
      writeResult(await recover(args));
      return;
    case "backfill":
      writeResult(
        await backfillCourseSupportResponderState({ apply: args.includes("--apply") })
      );
      return;
    default:
      throw new Error(
        "Unknown course-support command. Use inspect, coverage, claim, packet, inspect-provider-contract, claim-path, source-search-context, record-source-search, mark-needs-human, heartbeat, verify-release, verify, closeout, recover, or backfill."
      );
  }
}

async function claim(args: string[]) {
  const git = readGitState();
  if (git.dirtyPaths.length > 0) {
    throw new Error(
      `Course-support claim requires a clean checkout; dirty paths: ${git.dirtyPaths.join(", ")}`
    );
  }
  if (git.headSha !== git.originMainSha) {
    throw new Error(
      "Course-support claim requires HEAD to match current origin/main."
    );
  }
  const plannedPaths = readRepeatedOption(args, "--path");
  const retryBatchRef = readSingleOption(args, "--retry-batch-ref");
  const retryOrdinal = readSingleIntegerOption(args, "--retry-ordinal");
  const maxCourses = readSingleIntegerOption(args, "--max-courses");
  if (retryOrdinal !== undefined && !retryBatchRef) {
    throw new Error("--retry-ordinal requires --retry-batch-ref.");
  }
  return claimCourseSupportBatch({
    ownerThreadId: requireOwnerThread(args),
    branch: git.branch,
    baseSha: git.headSha,
    plannedPaths,
    maxCourses,
    retryBatchId: retryBatchRef
      ? await resolveCourseSupportBatchReference(retryBatchRef)
      : undefined,
    retryOrdinal
  });
}

async function packet(args: string[]) {
  const ownerThreadId = requireOwnerThread(args);
  const batchId = await resolveBatchId(args);
  return getCourseSupportBatchPacket({
    batchId,
    leaseToken: await getOwnedCourseSupportLeaseToken({ batchId, ownerThreadId }),
    ownerThreadId
  });
}

async function inspectProviderContract(args: string[]) {
  const options = parseCourseSupportProviderContractInspectionOptions(args);
  const ownerThreadId = requireOwnerThread(args);
  const batchId = await resolveCourseSupportBatchReference(options.batchRef);
  return inspectOwnedCourseSupportProviderContract({
    batchId,
    leaseToken: await getOwnedCourseSupportLeaseToken({
      batchId,
      ownerThreadId
    }),
    ownerThreadId,
    ordinal: options.ordinal
  });
}

export function parseCourseSupportProviderContractInspectionOptions(
  args: readonly string[]
) {
  const allowed = new Set(["--batch-ref", "--ordinal", "--owner-thread"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !allowed.has(option)) {
      throw new Error(
        "inspect-provider-contract accepts only --batch-ref, --ordinal, and --owner-thread."
      );
    }
    if (seen.has(option)) {
      throw new Error(`${option} may be provided only once.`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    seen.add(option);
  }
  const batchRef = readSingleOption([...args], "--batch-ref");
  if (!batchRef) {
    throw new Error("Missing required --batch-ref value.");
  }
  const rawOrdinal = readSingleOption([...args], "--ordinal");
  if (!rawOrdinal || !/^\d{1,2}$/u.test(rawOrdinal)) {
    throw new Error(
      "inspect-provider-contract requires --ordinal from 01 through 20."
    );
  }
  const ordinal = Number(rawOrdinal);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 20) {
    throw new Error(
      "inspect-provider-contract requires --ordinal from 01 through 20."
    );
  }
  return { batchRef, ordinal };
}

async function claimPath(args: string[]) {
  const ownerThreadId = requireOwnerThread(args);
  const batchId = await resolveBatchId(args);
  return appendCourseSupportBatchPath({
    batchId,
    leaseToken: await getOwnedCourseSupportLeaseToken({ batchId, ownerThreadId }),
    ownerThreadId,
    path: requireOption(args, "--path")
  });
}

export function shouldCompleteParkedCampaignForInspection(args: readonly string[]) {
  return args.includes("--scheduled-cycle");
}

async function sourceSearchContext(args: string[]) {
  const ownerThreadId = requireOwnerThread(args);
  const batchId = await resolveBatchId(args);
  const ordinal = readSingleIntegerOption(args, "--ordinal");
  if (!ordinal || ordinal < 1) {
    throw new Error("source-search-context requires a positive --ordinal.");
  }
  return getOwnedCourseSupportSourceSearchContext({
    batchId,
    leaseToken: await getOwnedCourseSupportLeaseToken({ batchId, ownerThreadId }),
    ownerThreadId,
    ordinal
  });
}

async function recordSourceSearch(args: string[]) {
  const ownerThreadId = requireOwnerThread(args);
  const batchId = await resolveBatchId(args);
  const options = parseCourseSupportSourceSearchResultOptions(args);
  return recordOwnedCourseSupportSourceSearchResult({
    batchId,
    leaseToken: await getOwnedCourseSupportLeaseToken({ batchId, ownerThreadId }),
    ownerThreadId,
    ordinal: options.ordinal,
    attemptRef: options.attemptRef,
    candidateUrl: options.candidateUrl,
    noUnique: options.noUnique,
    runtimeVersion: getAutomationRuntimeVersion()
  });
}

export function parseCourseSupportSourceSearchResultOptions(args: string[]) {
  const ordinal = readSingleIntegerOption(args, "--ordinal");
  if (!ordinal || ordinal < 1) {
    throw new Error("record-source-search requires a positive --ordinal.");
  }
  if (args.filter((argument) => argument === "--no-unique").length > 1) {
    throw new Error("--no-unique may be provided only once.");
  }
  const attemptRef = readSingleOption(args, "--attempt-ref");
  if (!attemptRef) {
    throw new Error("--attempt-ref requires a value.");
  }
  return {
    ordinal,
    attemptRef,
    candidateUrl: readSingleOption(args, "--candidate-url"),
    noUnique: args.includes("--no-unique")
  };
}

async function markNeedsHuman(args: string[]) {
  const ownerThreadId = requireOwnerThread(args);
  const batchId = await resolveBatchId(args);
  const ordinal = readIntegerOption(args, "--ordinal");
  if (!ordinal) {
    throw new Error("mark-needs-human requires a positive --ordinal.");
  }
  return markCourseSupportBatchNeedsHuman({
    batchId,
    leaseToken: await getOwnedCourseSupportLeaseToken({ batchId, ownerThreadId }),
    ownerThreadId,
    ordinal,
    evidence: requireOption(args, "--evidence"),
    nextAction: requireOption(args, "--next-action")
  });
}

async function heartbeat(args: string[]) {
  const requestedStatus = readOption(args, "--status");
  if (
    requestedStatus &&
    requestedStatus !== "IMPLEMENTING" &&
    requestedStatus !== "VERIFYING"
  ) {
    throw new Error("Heartbeat status must be IMPLEMENTING or VERIFYING.");
  }
  const batchId = await resolveBatchId(args);
  const ownerThreadId = requireOwnerThread(args);
  const currentRuntime = args.includes("--current-runtime");
  const requestedReleaseSha = readOption(args, "--release-sha");
  const watch = args.includes("--watch");
  if (watch && (currentRuntime || requestedReleaseSha)) {
    throw new Error(
      "--watch cannot be combined with --current-runtime or --release-sha."
    );
  }
  if (currentRuntime && requestedReleaseSha) {
    throw new Error("--current-runtime cannot be combined with --release-sha.");
  }
  const provenance = currentRuntime
    ? await getCourseSupportBatchRecoveryProvenance(batchId)
    : null;
  const releaseSha = currentRuntime ? provenance!.baseSha : requestedReleaseSha;
  let releaseAdvanceProof: CourseSupportReleaseAdvanceProof | undefined;
  if (releaseSha) {
    ({ releaseAdvanceProof } = await assertReleaseGitProvenance(
      batchId,
      releaseSha,
      { allowUnchangedRuntime: currentRuntime }
    ));
  }
  const leaseToken = await getOwnedCourseSupportLeaseToken({
    batchId,
    ownerThreadId
  });
  const transition = async () =>
    heartbeatCourseSupportBatch({
      batchId,
      leaseToken,
      ownerThreadId,
      status: requestedStatus as "IMPLEMENTING" | "VERIFYING" | undefined,
      releaseSha,
      releaseAdvanceProof
    });
  if (!watch) {
    return transition();
  }

  let statusRecorded = !requestedStatus;
  const renew = async () => {
    if (!statusRecorded) {
      const result = await transition();
      statusRecorded = result.heartbeatRecorded;
      return result;
    }
    return renewCourseSupportBatchOperationLease({
      batchId,
      leaseToken,
      ownerThreadId
    });
  };

  const intervalSeconds =
    readIntegerOption(args, "--interval-seconds") ?? 4 * 60;
  return runCourseSupportLeaseWatch({
    maxMinutes: readIntegerOption(args, "--max-minutes"),
    intervalMs: intervalSeconds * 1_000,
    renew,
    onRenewed: ({ renewalCount, leaseExpiresAt }) =>
      writeResult({
        outcome: "lease_watch_heartbeat",
        renewalCount,
        leaseExpiresAt
      })
  });
}

async function verify(
  args: string[],
  options?: { allowOwnerBoundChangedReleaseProof?: boolean }
) {
  const deployedAt = parseCanonicalCourseSupportDeployedAt(args);
  const batchId = await resolveBatchId(args);
  const ownerThreadId = requireOwnerThread(args);
  const watch = args.includes("--watch");
  const closeoutAfterWatch = args.includes("--closeout");
  const maxMinutes = readSingleIntegerOption(args, "--max-minutes");
  const pollSeconds = readSingleIntegerOption(args, "--poll-seconds");
  assertCourseSupportVerificationWatchFlags({
    watch,
    closeout: closeoutAfterWatch
  });
  if (!watch && (maxMinutes !== undefined || pollSeconds !== undefined)) {
    throw new Error("Verification watch timing options require --watch.");
  }
  const currentRuntime = args.includes("--current-runtime");
  const requestedReleaseSha = readOption(args, "--release-sha");
  assertCourseSupportVerificationReleaseLane({
    currentRuntime,
    requestedReleaseSha,
    deployedAt,
    allowOwnerBoundChangedReleaseProof:
      options?.allowOwnerBoundChangedReleaseProof === true
  });
  const provenance = currentRuntime
    ? await getCourseSupportBatchRecoveryProvenance(batchId)
    : null;
  const releaseSha = currentRuntime ? provenance!.baseSha : requestedReleaseSha;
  if (releaseSha) {
    await assertReleaseGitProvenance(batchId, releaseSha, {
      allowUnchangedRuntime: currentRuntime
    });
  }
  return runWithCourseSupportOperationHeartbeat(
    {
      batchId,
      ownerThreadId,
      allowDurableCloseout: closeoutAfterWatch
    },
    async (leaseToken, operationSignal) => {
      operationSignal.throwIfAborted();
      if (deployedAt) {
        const deploymentProof = await heartbeatCourseSupportBatch({
          batchId,
          leaseToken,
          ownerThreadId,
          status: "VERIFYING",
          releaseSha,
          deployedAt
        });
        if (!deploymentProof.heartbeatRecorded) {
          throw new Error(
            "Course-support deployment proof could not be persisted before browser verification."
          );
        }
        operationSignal.throwIfAborted();
      }
      const runPass = (signal?: AbortSignal) =>
        runCourseSupportVerificationPass({
          signal,
          persistBrowserStages: () =>
            persistOwnedCourseSupportBrowserPlaybookStages(
              {
                batchId,
                leaseToken,
                ownerThreadId,
                requestedReleaseSha: releaseSha,
                requestedDeployedAt: deployedAt
              },
              {
                validateReleaseFence: async (fence) => {
                  await assertReleaseGitProvenance(batchId, fence.releaseSha, {
                    allowUnchangedRuntime: currentRuntime
                  });
                },
                runBrowserProbe: ({
                  courseId,
                  beforePersist,
                  persistenceFence,
                  deferTerminalCloseout,
                  persistSearchProbe
                }) =>
                  runBrowserProbe({
                    courseName: undefined,
                    courseId,
                    dryRun: false,
                    expectedDisposition: undefined,
                    limit: 1,
                    traceJson: false,
                    persistenceFence,
                    deferTerminalCloseout,
                    persistSearchProbe,
                    signal,
                    beforePersist: ({ requireCurrentStage }) =>
                      signal?.aborted
                        ? Promise.reject(signal.reason)
                        : beforePersist({ requireCurrentStage })
                  })
              }
            ),
          verifyBatch: (verificationSignal) =>
            verifyCourseSupportBatch({
              batchId,
              leaseToken,
              ownerThreadId,
              releaseSha,
              deployedAt,
              signal: verificationSignal
            })
        });

      if (!watch) {
        const pass = await runPass();
        return { ...pass.verification, browserStages: pass.browserStages };
      }

      const deadlineGrant =
        await grantOwnedCourseSupportVerificationStageDeadline({
          batchId,
          leaseToken,
          ownerThreadId
        });
      operationSignal.throwIfAborted();
      const initialPacket = await getCourseSupportBatchPacket({
        batchId,
        leaseToken,
        ownerThreadId
      });
      operationSignal.throwIfAborted();
      if (initialPacket.outcome !== "ready") {
        throw new Error(
          "Course-support verification watch lost ownership before it started."
        );
      }
      const endpointDeadlineAt =
        selectCourseSupportVerificationEndpointDeadline(initialPacket.courses);

      const watchResult = await runCourseSupportVerificationWatch({
        pass: runPass,
        maxMinutes,
        pollMs: pollSeconds === undefined ? undefined : pollSeconds * 1_000,
        deadlineAt: endpointDeadlineAt,
        signal: operationSignal,
        closeout: closeoutAfterWatch
          ? async ({ passCount, signal }) =>
              closeoutSettledCourseSupportBatch({
                batchId,
                leaseToken,
                ownerThreadId,
                passCount,
                signal
              })
          : undefined,
        onStopped: closeoutAfterWatch
          ? ({ reason, passCount, signal }) =>
              closeoutStoppedCourseSupportBatch({
                batchId,
                leaseToken,
                ownerThreadId,
                passCount,
                signal,
                mode: selectCourseSupportVerificationStopMode({
                  reason,
                  passCount,
                  endpointDeadlineAt
                })
              })
          : undefined
      });
      return closeoutAfterWatch
        ? {
            ...watchResult,
            verificationStageDeadlineGrant: deadlineGrant,
            durableCloseoutRecorded:
              watchResult.closeout?.durableCloseoutRecorded === true
          }
        : {
            ...watchResult,
            verificationStageDeadlineGrant: deadlineGrant
          };
    }
  );
}

async function verifyRelease(args: string[]) {
  assertCourseSupportVerifyReleaseOptions(args);
  const batchRef = requireOption(args, "--batch-ref");
  const batchId = await resolveCourseSupportBatchReference(batchRef);
  const ownerThreadId = requireOwnerThread(args);
  const releaseSha = requireOption(args, "--release-sha");
  const deploymentTimeoutSeconds =
    readSingleIntegerOption(args, "--deployment-timeout-seconds") ?? 900;
  const deploymentPollSeconds =
    readSingleIntegerOption(args, "--deployment-poll-seconds") ?? 10;
  if (deploymentTimeoutSeconds < 1 || deploymentTimeoutSeconds > 1_800) {
    throw new Error(
      "--deployment-timeout-seconds must be an integer from 1 through 1800."
    );
  }
  if (deploymentPollSeconds < 1 || deploymentPollSeconds > 60) {
    throw new Error(
      "--deployment-poll-seconds must be an integer from 1 through 60."
    );
  }
  const releaseProvenance = await getCourseSupportBatchRecoveryProvenance(batchId);
  assertCourseSupportPersistedReleaseFence({
    persistedReleaseSha: releaseProvenance.releaseSha,
    requestedReleaseSha: releaseSha
  });
  await assertReleaseGitProvenance(batchId, releaseSha);

  const deploymentProof = await runWithCourseSupportOperationHeartbeat(
    { batchId, ownerThreadId },
    async (leaseToken, signal) => {
      signal.throwIfAborted();
      const releaseHeartbeat = await heartbeatCourseSupportBatch({
        batchId,
        leaseToken,
        ownerThreadId,
        status: "VERIFYING",
        releaseSha
      });
      if (!releaseHeartbeat.heartbeatRecorded) {
        throw new Error(
          "Course-support release verification lost durable batch ownership."
        );
      }
      signal.throwIfAborted();
      try {
        const proof = await waitForGitDeployment(
          {
            commitSha: releaseSha,
            timeoutSeconds: deploymentTimeoutSeconds,
            pollSeconds: deploymentPollSeconds,
            signal
          },
          {
            listDeployments: ({ signal: deploymentSignal }) =>
              runCourseSupportVercelJson<VercelDeploymentList>([
                "ls",
                "--environment",
                "production",
                "--meta",
                `githubCommitSha=${releaseSha}`,
                "--format",
                "json",
                "--limit",
                "20"
              ], deploymentSignal),
            inspectAlias: (alias, { signal: deploymentSignal } = {}) =>
              runCourseSupportVercelJson<VercelDeploymentInspection>([
                "inspect",
                alias,
                "--format",
                "json"
              ], deploymentSignal),
            onStatus: (status) =>
              writeResult({ outcome: "deployment_wait", status })
          }
        );
        signal.throwIfAborted();
        const deploymentHeartbeat = await heartbeatCourseSupportBatch({
          batchId,
          leaseToken,
          ownerThreadId,
          status: "VERIFYING",
          releaseSha,
          deployedAt: new Date(proof.deployedAt)
        });
        if (!deploymentHeartbeat.heartbeatRecorded) {
          throw new Error(
            "Course-support deployment proof could not be persisted."
          );
        }
        signal.throwIfAborted();
        return proof;
      } catch (error) {
        signal.throwIfAborted();
        try {
          await recordCourseSupportOwnerFailureCheckpoint({
            batchId,
            leaseToken,
            ownerThreadId,
            stage: "DEPLOYMENT_WAIT",
            failureDomain: "DEPLOYMENT",
            reasonCode: classifyCourseSupportDeploymentWaitFailure(error)
          });
        } catch {
          // Preserve the original deployment failure when ownership or the
          // database prevents the resumable checkpoint from being written.
        }
        throw error;
      }
    }
  );

  const verificationArgs = [
    "--batch-ref",
    batchRef,
    "--release-sha",
    releaseSha,
    "--deployed-at",
    deploymentProof.deployedAt,
    "--watch",
    "--closeout"
  ];
  const explicitOwnerThread = readSingleOption(args, "--owner-thread");
  if (explicitOwnerThread) {
    verificationArgs.push("--owner-thread", explicitOwnerThread);
  }
  try {
    const verification = await verify(verificationArgs, {
      allowOwnerBoundChangedReleaseProof: true
    });
    return {
      outcome: "release_verification_completed" as const,
      deployment: {
        source: deploymentProof.source,
        state: deploymentProof.state,
        deployedAt: deploymentProof.deployedAt,
        verifiedAliasCount: deploymentProof.aliases.length
      },
      verification
    };
  } catch (error) {
    await recordCourseSupportOwnerFailureCheckpointIfOwned({
      batchId,
      ownerThreadId,
      stage: "VERIFICATION",
      failureDomain: "PRODUCTION_VERIFICATION",
      reasonCode: "VERIFICATION_TOOLING_FAILED"
    });
    throw error;
  }
}

export function assertCourseSupportVerificationReleaseLane(input: {
  currentRuntime: boolean;
  requestedReleaseSha?: string | null;
  deployedAt?: Date | null;
  allowOwnerBoundChangedReleaseProof?: boolean;
}) {
  if (input.currentRuntime && input.requestedReleaseSha) {
    throw new Error("--current-runtime cannot be combined with --release-sha.");
  }
  const changedReleaseProofRequested = Boolean(
    input.requestedReleaseSha || (input.deployedAt && !input.currentRuntime)
  );
  if (
    changedReleaseProofRequested &&
    input.allowOwnerBoundChangedReleaseProof !== true
  ) {
    throw new Error(
      "Changed-release verification requires the owner-bound verify-release command."
    );
  }
  if (
    input.allowOwnerBoundChangedReleaseProof === true &&
    !input.requestedReleaseSha
  ) {
    throw new Error(
      "Owner-bound changed-release verification requires an exact release SHA."
    );
  }
}

export function assertCourseSupportPersistedReleaseFence(input: {
  persistedReleaseSha?: string | null;
  requestedReleaseSha: string;
}) {
  if (input.persistedReleaseSha !== input.requestedReleaseSha) {
    throw new Error(
      "verify-release requires the exact release SHA to be persisted by the pre-push heartbeat."
    );
  }
}

export function assertCourseSupportVerifyReleaseOptions(args: readonly string[]) {
  const valuedOptions = new Set([
    "--batch-ref",
    "--release-sha",
    "--owner-thread",
    "--deployment-timeout-seconds",
    "--deployment-poll-seconds"
  ]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !valuedOptions.has(option)) {
      throw new Error(
        "verify-release accepts only batch, release, owner, and deployment timing options."
      );
    }
    if (seen.has(option)) {
      throw new Error(`${option} may be provided only once.`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    seen.add(option);
  }
}

export function classifyCourseSupportDeploymentWaitFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Timed out after")) {
    return "DEPLOYMENT_TIMEOUT" as const;
  }
  if (message.startsWith("Git deployment")) {
    return "DEPLOYMENT_FAILED" as const;
  }
  return "DEPLOYMENT_TOOLING_FAILED" as const;
}

async function recordCourseSupportOwnerFailureCheckpoint(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  stage: "DEPLOYMENT_WAIT" | "VERIFICATION";
  failureDomain: "DEPLOYMENT" | "PRODUCTION_VERIFICATION" | "SLA";
  reasonCode:
    | "DEPLOYMENT_FAILED"
    | "DEPLOYMENT_TIMEOUT"
    | "DEPLOYMENT_TOOLING_FAILED"
    | "VERIFICATION_TOOLING_FAILED";
}) {
  const result = await heartbeatCourseSupportBatch({
    batchId: input.batchId,
    leaseToken: input.leaseToken,
    ownerThreadId: input.ownerThreadId,
    status: "VERIFYING",
    ownerFailureCheckpoint: {
      stage: input.stage,
      failureDomain: input.failureDomain,
      reasonCode: input.reasonCode
    }
  });
  if (!result.heartbeatRecorded) {
    throw new Error(
      "Course-support owner failure checkpoint lost durable batch ownership."
    );
  }
}

async function recordCourseSupportOwnerFailureCheckpointIfOwned(input: {
  batchId: string;
  ownerThreadId: string;
  stage: "DEPLOYMENT_WAIT" | "VERIFICATION";
  failureDomain: "DEPLOYMENT" | "PRODUCTION_VERIFICATION" | "SLA";
  reasonCode:
    | "DEPLOYMENT_FAILED"
    | "DEPLOYMENT_TIMEOUT"
    | "DEPLOYMENT_TOOLING_FAILED"
    | "VERIFICATION_TOOLING_FAILED";
}) {
  try {
    const leaseToken = await getOwnedCourseSupportLeaseToken(input);
    await recordCourseSupportOwnerFailureCheckpoint({
      ...input,
      leaseToken
    });
  } catch {
    // The original verification failure remains authoritative. A batch that
    // already closed or lost ownership cannot accept another checkpoint.
  }
}

async function runCourseSupportVercelJson<T>(
  commandArgs: string[],
  signal?: AbortSignal
) {
  const isWindows = process.platform === "win32";
  const executable = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "npx";
  const executableArgs = isWindows
    ? [
        "/d",
        "/s",
        "/c",
        ["npx", "vercel", ...commandArgs]
          .map(quoteCourseSupportVercelToken)
          .join(" ")
      ]
    : ["vercel", ...commandArgs];
  signal?.throwIfAborted();
  try {
    const { stdout } = await execFileAsync(executable, executableArgs, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      signal,
      windowsHide: true
    });
    signal?.throwIfAborted();
    return JSON.parse(stdout) as T;
  } catch (error) {
    signal?.throwIfAborted();
    const code =
      typeof error === "object" && error
        ? "status" in error && error.status !== null
          ? String(error.status)
          : "code" in error
            ? String(error.code)
            : "unknown"
        : "unknown";
    throw new Error(`Vercel CLI command failed with exit code ${code}.`);
  }
}

function quoteCourseSupportVercelToken(value: string) {
  if (!/^[A-Za-z0-9_./:=,-]+$/u.test(value)) {
    throw new Error("Vercel CLI argument contains unsupported characters.");
  }
  return value;
}

async function closeoutSettledCourseSupportBatch(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  passCount: number;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const packet = await getCourseSupportBatchPacket({
    batchId: input.batchId,
    leaseToken: input.leaseToken,
    ownerThreadId: input.ownerThreadId
  });
  input.signal?.throwIfAborted();
  if (packet.outcome !== "ready") {
    throw new Error(
      "Course-support verification watch lost ownership before closeout."
    );
  }

  const settled = await closeoutSettledCourseSupportVerification({
    courses: packet.courses,
    closeout: (preCloseoutExplicitHumanCount) =>
       closeoutCourseSupportBatch({
         batchId: input.batchId,
         leaseToken: input.leaseToken,
         ownerThreadId: input.ownerThreadId,
         signal: input.signal,
         verificationWatchMode: "WATCH_SETTLED",
        summary: {
          verificationWatch: {
            settled: true,
            passCount: input.passCount,
            preCloseoutExplicitHumanCount
          }
        }
      })
  });
  input.signal?.throwIfAborted();
  const result = settled.closeout;
  if (!result.durableCloseoutRecorded) {
    throw new Error(
      "Course-support verification watch did not record durable closeout."
    );
  }
  return {
    ...result,
    verificationWatchPassCount: input.passCount,
    preCloseoutExplicitHumanCount: settled.preCloseoutExplicitHumanCount
  };
}

async function closeoutStoppedCourseSupportBatch(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  passCount: number;
  mode: "EARLY_RETRY" | "ENDPOINT";
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const result = await closeoutCourseSupportBatch({
    batchId: input.batchId,
    leaseToken: input.leaseToken,
    ownerThreadId: input.ownerThreadId,
    signal: input.signal,
    requestedOutcome:
      input.mode === "EARLY_RETRY" ? "command_failed" : undefined,
    failureDomain: "SLA",
    verificationWatchMode: input.mode,
    summary: {
      verificationWatch: {
        settled: false,
        stopped: true,
        stopMode: input.mode,
        passCount: input.passCount
      }
    }
  });
  input.signal?.throwIfAborted();
  if (!result.durableCloseoutRecorded) {
    throw new Error(
      "Course-support verification watch could not release durable batch ownership."
    );
  }
  return result;
}

async function closeout(args: string[]) {
  const payload = args.includes("--stdin-json")
    ? readJsonPayload()
    : ({} as Record<string, unknown>);
  const requestedOutcome =
    readOption(args, "--outcome") ?? stringValue(payload.requestedOutcome);
  const failureDomain =
    readOption(args, "--failure-domain") ?? stringValue(payload.failureDomain);
  if (requestedOutcome && !RESPONDER_OUTCOMES.has(requestedOutcome as ResponderOutcome)) {
    throw new Error("Unsupported course-support closeout outcome.");
  }
  if (failureDomain && !FAILURE_DOMAINS.has(failureDomain as ResponderFailureDomain)) {
    throw new Error("Unsupported course-support failure domain.");
  }
  const batchId = await resolveBatchId(args);
  const ownerThreadId = requireOwnerThread(args);
  return runWithCourseSupportOperationHeartbeat(
    { batchId, ownerThreadId, allowDurableCloseout: true },
    (leaseToken, signal) =>
      closeoutCourseSupportBatch({
        batchId,
        leaseToken,
        ownerThreadId,
        signal,
        requestedOutcome: requestedOutcome as ResponderOutcome | undefined,
        failureDomain: failureDomain as ResponderFailureDomain | undefined,
        retryAfterSeconds:
          readIntegerOption(args, "--retry-after-seconds") ??
          numberValue(payload.retryAfterSeconds),
        summary: payload.summary ?? payload
      })
  );
}

async function runWithCourseSupportOperationHeartbeat<T>(
  input: {
    batchId: string;
    ownerThreadId: string;
    allowDurableCloseout?: boolean;
  },
  operation: (leaseToken: string, signal: AbortSignal) => Promise<T>
) {
  const leaseToken = await getOwnedCourseSupportLeaseToken(input);
  const renewWithSignal = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const result = await renewCourseSupportBatchOperationLease({
      batchId: input.batchId,
      leaseToken,
      ownerThreadId: input.ownerThreadId
    });
    signal?.throwIfAborted();
    if (!result.heartbeatRecorded) {
      throw new Error("Course-support operation heartbeat lost durable batch ownership.");
    }
  };
  return runWithBoundedCourseSupportHeartbeat({
    renew: renewWithSignal,
    operation: (signal) => operation(leaseToken, signal),
    intervalMs: COURSE_SUPPORT_OPERATION_HEARTBEAT_INTERVAL_MS,
    allowDurableCloseout: input.allowDurableCloseout
  });
}

async function recover(args: string[]) {
  runGit(["fetch", "origin", "main"]);
  const git = readGitState();
  const batchId = await resolveBatchId(args);
  const provenance = await getCourseSupportBatchRecoveryProvenance(batchId);
  const baseIsAncestor = isGitAncestor(provenance.baseSha, git.headSha);
  const committedPaths = baseIsAncestor
    ? readCommittedPaths(provenance.baseSha, git.headSha)
    : [];
  const releaseIsAncestor = provenance.releaseSha
    ? isGitAncestor(provenance.releaseSha, git.headSha)
    : undefined;
  const releaseIsPublished = provenance.releaseSha
    ? isGitAncestor(provenance.releaseSha, git.originMainSha)
    : false;
  const releaseCommittedPaths =
    provenance.releaseSha && releaseIsAncestor
      ? readCommittedPaths(provenance.releaseSha, git.headSha)
      : [];
  return recoverCourseSupportBatch({
    batchId,
    requestingThreadId: requireOwnerThread(args),
    currentBranch: git.branch,
    currentHeadSha: git.headSha,
    dirtyPaths: git.dirtyPaths,
    releaseIsPublished,
    baseIsAncestor,
    committedPaths,
    releaseIsAncestor,
    releaseCommittedPaths
  });
}

async function resolveBatchId(args: string[]) {
  return resolveCourseSupportBatchReference(requireOption(args, "--batch-ref"));
}

async function assertReleaseGitProvenance(
  batchId: string,
  releaseSha: string,
  options?: { allowUnchangedRuntime?: boolean }
) {
  if (!/^[a-f0-9]{40}$/i.test(releaseSha)) {
    throw new Error("--release-sha must be a full 40-character Git commit SHA.");
  }
  const git = readGitState();
  if (git.dirtyPaths.length > 0) {
    throw new Error("Release verification requires a clean responder checkout.");
  }
  if (git.headSha !== releaseSha) {
    throw new Error("--release-sha must equal the checked-out responder HEAD.");
  }
  const provenance = await getCourseSupportBatchRecoveryProvenance(batchId);
  if (
    options?.allowUnchangedRuntime === true &&
    provenance.remediationDirective?.allowUnchangedRuntime !== true
  ) {
    throw new Error(
      "This remediation route requires a reusable implementation or material change; unchanged-runtime verification is not allowed."
    );
  }
  if (provenance.branch && git.branch !== provenance.branch) {
    throw new Error("Release verification branch does not match the claimed batch.");
  }
  if (!isGitAncestor(provenance.baseSha, git.headSha)) {
    throw new Error("The claimed base SHA is not an ancestor of the responder release.");
  }
  const releaseDiffBase = chooseCourseSupportReleaseDiffBase({
    baseSha: provenance.baseSha,
    persistedReleaseSha: provenance.releaseSha,
    requestedReleaseSha: releaseSha,
    originMainSha: git.originMainSha,
    claimedBaseIsAncestorOfOriginMain: isGitAncestor(
      provenance.baseSha,
      git.originMainSha
    ),
    originMainIsAncestorOfRequestedRelease: isGitAncestor(
      git.originMainSha,
      releaseSha
    )
  });
  if (!releaseDiffBase) {
    return { releaseAdvanceProof: undefined };
  }
  const plannedPaths = new Set(provenance.plannedPaths);
  const committedPaths = readCommittedPaths(releaseDiffBase, git.headSha);
  if (committedPaths.length === 0) {
    if (
      !canVerifyUnchangedCourseSupportRuntime({
        allowUnchangedRuntime: options?.allowUnchangedRuntime === true,
        remediationAllowsUnchangedRuntime:
          provenance.remediationDirective?.allowUnchangedRuntime === true,
        baseSha: provenance.baseSha,
        persistedReleaseSha: provenance.releaseSha,
        requestedReleaseSha: releaseSha,
        plannedPaths: provenance.plannedPaths
      })
    ) {
      throw new Error("Responder release must contain a committed planned change.");
    }
    return { releaseAdvanceProof: undefined };
  }
  const unplannedPaths = committedPaths.filter((path) => !plannedPaths.has(path));
  if (unplannedPaths.length > 0) {
    throw new Error(
      `Release contains paths not claimed by the responder: ${unplannedPaths.join(", ")}`
    );
  }
  if (provenance.releaseSha && !isGitAncestor(provenance.releaseSha, releaseSha)) {
    throw new Error(
      "A follow-up responder release must descend from the persisted release."
    );
  }
  if (!provenance.branch) {
    throw new Error("The responder batch is missing its claimed branch provenance.");
  }
  return {
    releaseAdvanceProof: {
      fromSha: provenance.releaseSha ?? releaseDiffBase,
      toSha: releaseSha,
      branch: provenance.branch,
      committedPaths,
      descendantVerified: true as const
    }
  };
}

function readCommittedPaths(fromSha: string, toSha: string) {
  return parseGitNulPaths(
    runGit([
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${fromSha}..${toSha}`
    ])
  );
}

function readGitState() {
  const branch = runGit(["branch", "--show-current"]);
  if (!branch) {
    throw new Error("Course-support responder checkout is detached.");
  }
  const headSha = runGit(["rev-parse", "HEAD"]);
  const originMainSha = runGit(["rev-parse", "origin/main"]);
  const dirtyPaths = parseGitPorcelainV1ZPaths(
    runGit(["status", "--porcelain=v1", "-z"])
  );
  return { branch, headSha, originMainSha, dirtyPaths };
}

function runGit(args: string[]) {
  return normalizeGitCommandOutput(
    execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
  );
}

function isGitAncestor(baseSha: string, headSha: string) {
  try {
    runGit(["merge-base", "--is-ancestor", baseSha, headSha]);
    return true;
  } catch {
    return false;
  }
}

function readJsonPayload() {
  const raw = readFileSync(0, "utf8").trim();
  if (!raw) {
    throw new Error("--stdin-json requires one JSON object on stdin.");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Course-support closeout payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requireOwnerThread(args: string[]) {
  return resolveCodexOwnerThreadId({
    environmentOwnerThreadId: process.env.CODEX_THREAD_ID,
    requestedOwnerThreadId: readOption(args, "--owner-thread")
  });
}

function optionalOwnerThread(args: string[]) {
  const environmentOwnerThreadId = process.env.CODEX_THREAD_ID?.trim();
  const requestedOwnerThreadId = readOption(args, "--owner-thread");
  if (!environmentOwnerThreadId && !requestedOwnerThreadId) {
    return undefined;
  }
  return resolveCodexOwnerThreadId({
    environmentOwnerThreadId,
    requestedOwnerThreadId
  });
}

function requireOption(args: string[], name: string) {
  const value = readOption(args, name);
  if (!value) {
    throw new Error(`Missing required ${name} value.`);
  }
  return value;
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function readRepeatedOption(args: string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires a value.`);
      }
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function readIntegerOption(args: string[], name: string) {
  const raw = readOption(args, name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  return parsed;
}

function readSingleOption(args: string[], name: string) {
  if (args.filter((argument) => argument === name).length > 1) {
    throw new Error(`${name} may be provided only once.`);
  }
  return readOption(args, name);
}

function readSingleIntegerOption(args: string[], name: string) {
  const raw = readSingleOption(args, name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  return parsed;
}

export function parseCanonicalCourseSupportDeployedAt(args: readonly string[]) {
  const optionIndexes = args.flatMap((argument, index) =>
    argument === "--deployed-at" ? [index] : []
  );
  if (optionIndexes.length > 1) {
    throw new Error("--deployed-at may be provided only once.");
  }
  if (optionIndexes.length === 0) {
    return null;
  }
  const raw = args[optionIndexes[0] + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error("--deployed-at requires a value.");
  }
  const deployedAt = new Date(raw);
  if (
    !Number.isFinite(deployedAt.getTime()) ||
    raw !== deployedAt.toISOString()
  ) {
    throw new Error(
      "--deployed-at must be an exact canonical UTC ISO timestamp."
    );
  }
  return deployedAt;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function serializeCourseSupportResult(
  value: unknown,
  options?: { machine?: boolean }
) {
  return `${JSON.stringify(
    sanitizeResponderValue(value),
    null,
    options?.machine ? undefined : 2
  )}\n`;
}

function writeResult(value: unknown, options?: { machine?: boolean }) {
  process.stdout.write(serializeCourseSupportResult(value, options));
}

const directEntry = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (directEntry) {
  main().catch((error) => {
    const failure = buildCourseSupportCommandFailure(error);
    const [command = "inspect", ...args] = process.argv.slice(2);
    const machineCoverage =
      command === "coverage" && args.includes("--machine");
    writeResult(
      machineCoverage
        ? buildCourseSupportCoverageMachineRecord({
            outcome: failure.outcome,
            failure
          })
        : failure,
      { machine: machineCoverage }
    );
    process.exitCode = 1;
  });
}

export function buildCourseSupportCommandFailure(error: unknown) {
  const message = sanitizeResponderText(
    error instanceof Error ? error.message : "Unknown course-support command failure."
  );
  const outcome =
    error instanceof CourseSupportDatabaseEnvironmentError
      ? error.outcome
      : classifyCommandFailure(message);
  const failureDomain = commandFailureDomain(outcome);
  const policy = getResponderThreadPolicy({
    outcome,
    failureDomain,
    durableCloseoutRecorded: false
  });
  return {
    outcome,
    ...(failureDomain ? { failureDomain } : {}),
    ...(error instanceof CourseSupportDatabaseEnvironmentError
      ? { failureClass: error.failureClass }
      : {}),
    error: message,
    durableCloseoutRecorded: false,
    ...policy
  };
}

export function classifyCommandFailure(message: string): ResponderOutcome {
  const normalized = message.toLowerCase();
  if (normalized.includes("git") || normalized.includes("checkout")) {
    return "blocked_git";
  }
  if (normalized.includes("auth") || normalized.includes("credential")) {
    return "blocked_auth";
  }
  if (
    normalized.includes("database") ||
    normalized.includes("environment") ||
    normalized.includes("missing required")
  ) {
    return "blocked_env";
  }
  return "command_failed";
}

function commandFailureDomain(
  outcome: ResponderOutcome
): ResponderFailureDomain | undefined {
  return outcome === "blocked_env" ? "ENV" : undefined;
}
