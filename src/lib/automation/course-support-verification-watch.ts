import { isCourseSupportSearchExecutionFenceRetryError } from "./course-support-search-execution-fence";
import {
  getCourseSupportEvidenceRefreshReason,
  type CourseSupportEvidenceRefreshReason,
} from "./course-support-closeout-errors";
export const DEFAULT_COURSE_SUPPORT_VERIFICATION_WATCH_MINUTES = 18;
export const DEFAULT_COURSE_SUPPORT_VERIFICATION_POLL_MS = 20_000;
export const DEFAULT_COURSE_SUPPORT_VERIFICATION_RELEASE_CLEANUP_MS = 60_000;
export const DEFAULT_COURSE_SUPPORT_HEARTBEAT_RENEWAL_TIMEOUT_MS = 30_000;
export const MAX_COURSE_SUPPORT_EVIDENCE_REFRESH_RETRIES = 3;

export const COURSE_SUPPORT_VERIFICATION_WATCH_FAILURE_CODES = [
  "BROWSER_STAGE_PERSIST_FAILED",
  "BROWSER_STAGE_BATCH_LOAD_FAILED",
  "BROWSER_STAGE_RELEASE_FENCE_FAILED",
  "BROWSER_STAGE_TARGET_SELECTION_FAILED",
  "BROWSER_STAGE_PROVENANCE_FAILED",
  "BROWSER_STAGE_CURRENT_TARGET_FAILED",
  "BROWSER_STAGE_PROBE_SETUP_FAILED",
  "BROWSER_STAGE_RUN_CREATE_FAILED",
  "BROWSER_STAGE_NETWORK_FAILED",
  "BROWSER_STAGE_TIMEOUT",
  "BATCH_VERIFICATION_FAILED",
  "BATCH_VERIFICATION_RECOVERY_REQUIRED",
  "ASSIGNED_STAGE_ORCHESTRATION_GAP",
  "SETTLED_CLOSEOUT_FAILED"
] as const;

export const COURSE_SUPPORT_VERIFICATION_BROWSER_TRANSIENT_KINDS = [
  "NETWORK",
  "TIMEOUT"
] as const;

export type CourseSupportVerificationBrowserTransientKind =
  (typeof COURSE_SUPPORT_VERIFICATION_BROWSER_TRANSIENT_KINDS)[number];

export type CourseSupportVerificationWatchFailureCode =
  (typeof COURSE_SUPPORT_VERIFICATION_WATCH_FAILURE_CODES)[number];

export type CourseSupportBrowserStageControlFailureCode = Extract<
  CourseSupportVerificationWatchFailureCode,
  | "BROWSER_STAGE_BATCH_LOAD_FAILED"
  | "BROWSER_STAGE_RELEASE_FENCE_FAILED"
  | "BROWSER_STAGE_TARGET_SELECTION_FAILED"
  | "BROWSER_STAGE_PROVENANCE_FAILED"
  | "BROWSER_STAGE_CURRENT_TARGET_FAILED"
  | "BROWSER_STAGE_PROBE_SETUP_FAILED"
  | "BROWSER_STAGE_RUN_CREATE_FAILED"
>;

const COURSE_SUPPORT_VERIFICATION_WATCH_FAILURE_CODE_SET = new Set<string>(
  COURSE_SUPPORT_VERIFICATION_WATCH_FAILURE_CODES
);
const COURSE_SUPPORT_VERIFICATION_WATCH_SHORT_RETRY_CODES = new Set<
  CourseSupportVerificationWatchFailureCode
>([
  "BROWSER_STAGE_NETWORK_FAILED",
  "BROWSER_STAGE_TIMEOUT"
]);

const courseSupportVerificationWatchFailureCauses = new WeakMap<
  Error,
  unknown
>();
const courseSupportBrowserStageControlFailureCodes = new WeakMap<
  Error,
  CourseSupportBrowserStageControlFailureCode
>();

class CourseSupportVerificationWatchFailure extends Error {
  readonly failureCode: CourseSupportVerificationWatchFailureCode;

  constructor(
    failureCode: CourseSupportVerificationWatchFailureCode,
    cause: unknown
  ) {
    super(`Course-support verification step failed with ${failureCode}.`);
    this.name = "CourseSupportVerificationWatchFailure";
    this.failureCode = failureCode;
    courseSupportVerificationWatchFailureCauses.set(this, cause);
  }
}

export function isCourseSupportVerificationWatchFailureCode(
  value: unknown
): value is CourseSupportVerificationWatchFailureCode {
  return (
    typeof value === "string" &&
    COURSE_SUPPORT_VERIFICATION_WATCH_FAILURE_CODE_SET.has(value)
  );
}

export function isCourseSupportVerificationWatchShortRetryEligible(
  value: unknown
): value is CourseSupportVerificationWatchFailureCode {
  return (
    isCourseSupportVerificationWatchFailureCode(value) &&
    COURSE_SUPPORT_VERIFICATION_WATCH_SHORT_RETRY_CODES.has(value)
  );
}

export function getCourseSupportVerificationWatchFailureCode(
  error: unknown
): CourseSupportVerificationWatchFailureCode | null {
  return error instanceof CourseSupportVerificationWatchFailure
    ? error.failureCode
    : null;
}

export function tagCourseSupportBrowserStageControlFailure(
  failureCode: CourseSupportBrowserStageControlFailureCode,
  cause: unknown
) {
  const error =
    cause instanceof Error
      ? cause
      : new Error("Course-support browser control phase failed.");
  courseSupportBrowserStageControlFailureCodes.set(error, failureCode);
  return error;
}

function createCourseSupportVerificationWatchFailure(
  failureCode: CourseSupportVerificationWatchFailureCode,
  cause: unknown
) {
  return cause instanceof CourseSupportVerificationWatchFailure
    ? cause
    : new CourseSupportVerificationWatchFailure(failureCode, cause);
}

function selectBrowserStageFailureCode(
  kind: CourseSupportVerificationBrowserTransientKind | null | undefined,
  error: unknown
): CourseSupportVerificationWatchFailureCode {
  if (error instanceof Error) {
    const controlFailureCode =
      courseSupportBrowserStageControlFailureCodes.get(error);
    if (controlFailureCode) {
      return controlFailureCode;
    }
  }
  if (kind === "NETWORK") {
    return "BROWSER_STAGE_NETWORK_FAILED";
  }
  if (kind === "TIMEOUT") {
    return "BROWSER_STAGE_TIMEOUT";
  }
  return "BROWSER_STAGE_PERSIST_FAILED";
}

function unwrapCourseSupportVerificationWatchFailure(error: unknown) {
  return error instanceof CourseSupportVerificationWatchFailure
    ? courseSupportVerificationWatchFailureCauses.get(error) ?? error
    : error;
}

export async function runWithBoundedCourseSupportHeartbeat<T>(input: {
  renew: (signal: AbortSignal) => Promise<void>;
  operation: (signal: AbortSignal) => Promise<T>;
  intervalMs: number;
  renewalTimeoutMs?: number;
  allowDurableCloseout?: boolean;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  setIntervalTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearIntervalTimer?: (handle: unknown) => void;
}) {
  const renewalTimeoutMs =
    input.renewalTimeoutMs ??
    DEFAULT_COURSE_SUPPORT_HEARTBEAT_RENEWAL_TIMEOUT_MS;
  if (
    !Number.isInteger(renewalTimeoutMs) ||
    renewalTimeoutMs < 1 ||
    renewalTimeoutMs > DEFAULT_COURSE_SUPPORT_HEARTBEAT_RENEWAL_TIMEOUT_MS
  ) {
    throw new Error(
      "Course-support heartbeat renewal timeout must be an integer from 1 through 30000 milliseconds."
    );
  }
  if (!Number.isInteger(input.intervalMs) || input.intervalMs < 1) {
    throw new Error("Course-support heartbeat interval must be positive.");
  }
  const setTimer =
    input.setTimer ??
    ((callback: () => void, milliseconds: number) =>
      setTimeout(callback, milliseconds));
  const clearTimer =
    input.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const setIntervalTimer =
    input.setIntervalTimer ??
    ((callback: () => void, milliseconds: number) =>
      setInterval(callback, milliseconds));
  const clearIntervalTimer =
    input.clearIntervalTimer ??
    ((handle: unknown) =>
      clearInterval(handle as ReturnType<typeof setInterval>));

  const renewWithinBudget = async () => {
    const controller = new AbortController();
    const renewalResult = Promise.resolve()
      .then(() => input.renew(controller.signal))
      .then(
        () => ({ kind: "renewed" as const }),
        (error) => ({ kind: "error" as const, error })
      );
    let timerHandle: unknown;
    const timeoutResult = new Promise<{ kind: "timeout" }>((resolve) => {
      timerHandle = setTimer(() => {
        controller.abort(
          new Error("Course-support operation heartbeat renewal timed out.")
        );
        resolve({ kind: "timeout" });
      }, renewalTimeoutMs);
    });
    const result = await Promise.race([renewalResult, timeoutResult]);
    if (timerHandle !== undefined) {
      clearTimer(timerHandle);
    }
    if (result.kind === "timeout") {
      throw new Error(
        "Course-support operation heartbeat renewal timed out; ownership is unconfirmed."
      );
    }
    if (result.kind === "error") {
      throw result.error;
    }
  };

  await renewWithinBudget();

  const operationController = new AbortController();
  let heartbeatFailure: unknown = null;
  let heartbeatInFlight: Promise<void> | null = null;
  const interval = setIntervalTimer(() => {
    if (heartbeatInFlight || heartbeatFailure) {
      return;
    }
    heartbeatInFlight = renewWithinBudget()
      .catch((error) => {
        heartbeatFailure = error;
        if (!operationController.signal.aborted) {
          operationController.abort(error);
        }
      })
      .finally(() => {
        heartbeatInFlight = null;
      });
  }, input.intervalMs);
  if (
    interval &&
    typeof interval === "object" &&
    "unref" in interval &&
    typeof interval.unref === "function"
  ) {
    interval.unref();
  }

  let operationResult: T;
  try {
    operationResult = await input.operation(operationController.signal);
  } finally {
    clearIntervalTimer(interval);
    await heartbeatInFlight;
  }
  const durableCloseout = Boolean(
    operationResult &&
    typeof operationResult === "object" &&
    "durableCloseoutRecorded" in operationResult &&
    operationResult.durableCloseoutRecorded === true
  );
  if (
    heartbeatFailure &&
    !(input.allowDurableCloseout && durableCloseout)
  ) {
    throw heartbeatFailure;
  }
  return operationResult;
}

export function assertCourseSupportVerificationWatchFlags(input: {
  watch: boolean;
  closeout: boolean;
}) {
  if (!input.watch || !input.closeout) {
    throw new Error("Persisted course-support verification requires verify --watch --closeout.");
  }
}

export function selectCourseSupportVerificationEndpointDeadline(
  courses: readonly {
    result: string;
    escalationDeadlineAt?: string | null;
    terminalProofDurable?: boolean;
  }[]
) {
  let earliestDeadline: number | undefined;
  for (const course of courses) {
    if (
      course.result === "FINAL_DISPOSITION" &&
      course.terminalProofDurable === true
    ) {
      continue;
    }
    if (!course.escalationDeadlineAt) {
      continue;
    }
    const deadline = new Date(course.escalationDeadlineAt).getTime();
    if (
      Number.isFinite(deadline) &&
      (earliestDeadline === undefined || deadline < earliestDeadline)
    ) {
      earliestDeadline = deadline;
    }
  }
  return earliestDeadline;
}

export function selectCourseSupportVerificationStopMode(input: {
  reason: "endpoint" | "max" | "error";
  passCount: number;
  endpointDeadlineAt?: number | null;
  now?: number;
}) {
  if (!Number.isInteger(input.passCount) || input.passCount < 0) {
    throw new Error(
      "Course-support verification pass count must be a non-negative integer."
    );
  }
  const endpointReached =
    input.endpointDeadlineAt !== undefined &&
    input.endpointDeadlineAt !== null &&
    (input.now ?? Date.now()) >= input.endpointDeadlineAt;

  // An expired endpoint must not skip the owner-only browser stage and then
  // turn the absence of that attempt into course-level human work. A watch
  // that never completed its first persistence/verification pass releases the
  // batch as an automatic retry; endpoint closeout is available only after at
  // least one full pass had a chance to advance the owned stage.
  if (input.passCount === 0) {
    return "EARLY_RETRY" as const;
  }
  return input.reason === "endpoint" || endpointReached
    ? ("ENDPOINT" as const)
    : ("EARLY_RETRY" as const);
}

export type CourseSupportVerificationBrowserStages = {
  eligibleCount: number;
  persistedCount: number;
  renderedDiscoveryCount?: number;
  independentConfirmationCount?: number;
};

export type CourseSupportVerificationBrowserStageTotals = {
  passCountWithEligibleStages: number;
  passCountWithPersistedStages: number;
  eligibleCount: number;
  persistedCount: number;
  renderedDiscoveryCount: number;
  independentConfirmationCount: number;
};

export type CourseSupportVerificationPassResult<TVerification> = {
  browserStages: CourseSupportVerificationBrowserStages;
  verification: TVerification & {
    outcome?: string;
    verified?: boolean;
    detachedVerification?: {
      rerunNeeded?: boolean;
      assignedStageOrchestrationGapCount?: number;
      schedulerDispatchError?: boolean;
      schedulerIneligibleReasonCounts?: Record<string, number>;
    } | null;
    searchExecutionFence?: {
      rerunNeeded?: boolean;
    } | null;
  };
};

export async function runCourseSupportVerificationPass<
  TBrowserStages extends CourseSupportVerificationBrowserStages,
  TVerification extends {
    outcome?: string;
    verified?: boolean;
    detachedVerification?: {
      rerunNeeded?: boolean;
      assignedStageOrchestrationGapCount?: number;
      schedulerDispatchError?: boolean;
      schedulerIneligibleReasonCounts?: Record<string, number>;
    } | null;
    searchExecutionFence?: { rerunNeeded?: boolean } | null;
  }
>(input: {
  signal?: AbortSignal;
  persistBrowserStages: () => Promise<TBrowserStages>;
  classifyBrowserStageFailure?: (
    error: unknown
  ) => CourseSupportVerificationBrowserTransientKind | null;
  verifyBatch: (signal?: AbortSignal) => Promise<TVerification>;
}) {
  throwIfVerificationWatchAborted(input.signal);
  let browserStages: TBrowserStages;
  try {
    browserStages = await input.persistBrowserStages();
  } catch (error) {
    throwIfVerificationWatchAborted(input.signal);
    throw createCourseSupportVerificationWatchFailure(
      selectBrowserStageFailureCode(
        input.classifyBrowserStageFailure?.(error),
        error
      ),
      error
    );
  }
  throwIfVerificationWatchAborted(input.signal);
  let verification: TVerification;
  try {
    verification = await input.verifyBatch(input.signal);
  } catch (error) {
    throwIfVerificationWatchAborted(input.signal);
    throw createCourseSupportVerificationWatchFailure(
      "BATCH_VERIFICATION_FAILED",
      error
    );
  }
  throwIfVerificationWatchAborted(input.signal);
  return { browserStages, verification };
}

export async function closeoutSettledCourseSupportVerification<TCloseout>(input: {
  courses: Array<{
    ordinal: string | number;
    result: string;
    playbookExhausted: boolean | null;
  }>;
  closeout: (preCloseoutExplicitHumanCount: number) => Promise<TCloseout>;
}) {
  const humanReviewCourses = input.courses.filter(
    (course) => course.result === "NEEDS_HUMAN"
  );
  for (const course of input.courses) {
    const ordinal = Number(course.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new Error(
        "Course-support verification watch received an invalid course ordinal."
      );
    }
    if (
      course.result === "NEEDS_HUMAN" &&
      course.playbookExhausted !== true
    ) {
      throw new Error(
        "Course-support verification watch cannot close an explicit human result before its playbook is exhausted."
      );
    }
  }

  return {
    closeout: await input.closeout(humanReviewCourses.length),
    preCloseoutExplicitHumanCount: humanReviewCourses.length
  };
}

export async function runCourseSupportVerificationWatch<
  TVerification extends {
    outcome?: string;
    verified?: boolean;
    detachedVerification?: {
      rerunNeeded?: boolean;
      assignedStageOrchestrationGapCount?: number;
      schedulerDispatchError?: boolean;
      schedulerIneligibleReasonCounts?: Record<string, number>;
    } | null;
    searchExecutionFence?: { rerunNeeded?: boolean } | null;
  },
  TCloseout = never
>(input: {
  pass: (
    signal: AbortSignal
  ) => Promise<CourseSupportVerificationPassResult<TVerification>>;
  closeout?: (input: {
    passCount: number;
    evidenceRefreshRetryCount: number;
    lastEvidenceRefreshReason: CourseSupportEvidenceRefreshReason | null;
    settledPass: CourseSupportVerificationPassResult<TVerification>;
    signal: AbortSignal;
  }) => Promise<TCloseout>;
  onStopped?: (input: {
    reason: "endpoint" | "max" | "error";
    failureCode: CourseSupportVerificationWatchFailureCode | null;
    evidenceRefreshRetryCount: number;
    lastEvidenceRefreshReason: CourseSupportEvidenceRefreshReason | null;
    passCount: number;
    lastPass: CourseSupportVerificationPassResult<TVerification> | null;
    signal: AbortSignal;
  }) => Promise<TCloseout>;
  maxMinutes?: number;
  pollMs?: number;
  deadlineAt?: number | null;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  releaseCleanupMs?: number;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}) {
  throwIfVerificationWatchAborted(input.signal);
  const maxMinutes =
    input.maxMinutes ?? DEFAULT_COURSE_SUPPORT_VERIFICATION_WATCH_MINUTES;
  const pollMs = input.pollMs ?? DEFAULT_COURSE_SUPPORT_VERIFICATION_POLL_MS;
  if (
    !Number.isInteger(maxMinutes) ||
    maxMinutes < 1 ||
    maxMinutes > DEFAULT_COURSE_SUPPORT_VERIFICATION_WATCH_MINUTES
  ) {
    throw new Error("--max-minutes must be an integer from 1 through 18.");
  }
  if (!Number.isInteger(pollMs) || pollMs < 5_000 || pollMs > 60_000) {
    throw new Error("--poll-seconds must be an integer from 5 through 60.");
  }
  const releaseCleanupMs =
    input.releaseCleanupMs ??
    DEFAULT_COURSE_SUPPORT_VERIFICATION_RELEASE_CLEANUP_MS;
  if (
    !Number.isInteger(releaseCleanupMs) ||
    releaseCleanupMs < 1 ||
    releaseCleanupMs > DEFAULT_COURSE_SUPPORT_VERIFICATION_RELEASE_CLEANUP_MS
  ) {
    throw new Error(
      "Course-support verification release cleanup must be an integer from 1 through 60000 milliseconds."
    );
  }

  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const setTimer =
    input.setTimer ??
    ((callback: () => void, milliseconds: number) =>
      setTimeout(callback, milliseconds));
  const clearTimer =
    input.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const startedAt = now();
  const maxDeadline = startedAt + maxMinutes * 60_000;
  const endpointDeadline = input.deadlineAt ?? null;
  if (
    endpointDeadline !== null &&
    (!Number.isFinite(endpointDeadline) || endpointDeadline < 0)
  ) {
    throw new Error("Course-support verification endpoint must be a timestamp.");
  }
  const deadline =
    endpointDeadline === null
      ? maxDeadline
      : Math.min(maxDeadline, endpointDeadline);
  const deadlineReason =
    endpointDeadline !== null && endpointDeadline <= maxDeadline
      ? ("endpoint" as const)
      : ("max" as const);
  let passCount = 0;
  let evidenceRefreshRetryCount = 0;
  let lastEvidenceRefreshReason: CourseSupportEvidenceRefreshReason | null = null;
  let lastPass: CourseSupportVerificationPassResult<TVerification> | null = null;
  let consecutiveCleanPassCount = 0;
  let browserStageTotals = emptyCourseSupportVerificationBrowserStageTotals();

  const runForBudget = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    budgetMs: number,
    timeoutMessage: string
  ) => {
    if (budgetMs <= 0) {
      return { kind: "timeout" as const };
    }
    throwIfVerificationWatchAborted(input.signal);
    const controller = new AbortController();
    const operationResult = Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => ({ kind: "value" as const, value }),
        (error) => ({ kind: "error" as const, error })
      );
    let timerHandle: unknown;
    const timeoutResult = new Promise<{ kind: "timeout" }>((resolve) => {
      timerHandle = setTimer(() => {
        controller.abort(new Error(timeoutMessage));
        resolve({ kind: "timeout" });
      }, budgetMs);
    });
    let detachParentAbort: (() => void) | undefined;
    const parentAbortResult = input.signal
      ? new Promise<{ kind: "parent-abort"; error: unknown }>((resolve) => {
          const onAbort = () => {
            if (!controller.signal.aborted) {
              controller.abort(input.signal?.reason);
            }
            resolve({
              kind: "parent-abort",
              error:
                input.signal?.reason ??
                new Error("Course-support verification watch ownership was lost."),
            });
          };
          input.signal!.addEventListener("abort", onAbort, { once: true });
          detachParentAbort = () =>
            input.signal?.removeEventListener("abort", onAbort);
          if (input.signal!.aborted) {
            onAbort();
          }
        })
      : null;
    try {
      const result = await Promise.race([
        operationResult,
        timeoutResult,
        ...(parentAbortResult ? [parentAbortResult] : []),
      ]);
      if (result.kind === "parent-abort") {
        throw result.error;
      }
      throwIfVerificationWatchAborted(input.signal);
      return result;
    } finally {
      detachParentAbort?.();
      if (timerHandle !== undefined) {
        clearTimer(timerHandle);
      }
    }
  };

  const sleepWithOwnership = async (milliseconds: number) => {
    throwIfVerificationWatchAborted(input.signal);
    if (!input.signal) {
      await sleep(milliseconds);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () =>
        reject(
          input.signal?.reason ??
            new Error("Course-support verification watch ownership was lost."),
        );
      input.signal!.addEventListener("abort", onAbort, { once: true });
      if (input.signal!.aborted) {
        onAbort();
      }
      void sleep(milliseconds).then(resolve, reject).finally(() => {
        input.signal?.removeEventListener("abort", onAbort);
      });
    });
    throwIfVerificationWatchAborted(input.signal);
  };

  const runBounded = <T>(
    operation: (signal: AbortSignal) => Promise<T>
  ) =>
    runForBudget(
      operation,
      deadline - now(),
      "Course-support verification watch operation exceeded its deadline."
    );

  const stop = async (
    reason: "endpoint" | "max" | "error",
    error?: unknown,
    failureCode?: CourseSupportVerificationWatchFailureCode
  ) => {
    throwIfVerificationWatchAborted(input.signal);
    const safeFailureCode =
      reason === "error"
        ? (failureCode ??
          getCourseSupportVerificationWatchFailureCode(error) ??
          "BATCH_VERIFICATION_FAILED")
        : null;
    if (!input.onStopped) {
      if (error) {
        throw unwrapCourseSupportVerificationWatchFailure(error);
      }
      throw new Error(
        "Course-support verification watch timed out before a final clean pass."
      );
    }
    const releaseResult = await runForBudget(
      (signal) =>
        input.onStopped!({
          reason,
          failureCode: safeFailureCode,
          evidenceRefreshRetryCount,
          lastEvidenceRefreshReason,
          passCount,
          lastPass,
          signal
        }),
      releaseCleanupMs,
      "Course-support verification release cleanup exceeded its deadline."
    );
    if (releaseResult.kind === "timeout") {
      throw new Error(
        "Course-support verification release cleanup exceeded its finite budget; lease renewal stopped."
      );
    }
    if (releaseResult.kind === "error") {
      throw releaseResult.error;
    }
    return {
      outcome: "verification_watch_closed" as const,
      passCount,
      stoppedReason: reason,
      failureCode: safeFailureCode,
      evidenceRefreshRetryCount,
      lastEvidenceRefreshReason,
      browserStageTotals,
      closeout: releaseResult.value
    };
  };

  while (true) {
    throwIfVerificationWatchAborted(input.signal);
    if (now() >= deadline) {
      return stop(deadlineReason);
    }

    const passResult = await runBounded(input.pass);
    if (passResult.kind === "timeout") {
      return stop(deadlineReason);
    }
    if (passResult.kind === "error") {
      return stop(
        "error",
        passResult.error,
        getCourseSupportVerificationWatchFailureCode(passResult.error) ??
          "BATCH_VERIFICATION_FAILED"
      );
    }
    const settledPass = passResult.value;
    passCount += 1;
    lastPass = settledPass;
    browserStageTotals = addCourseSupportVerificationBrowserStageTotals(
      browserStageTotals,
      settledPass.browserStages
    );
    if (
      settledPass.verification.verified === false ||
      settledPass.verification.outcome === "recovery_required"
    ) {
      return stop(
        "error",
        new Error(
          "Course-support verification watch lost durable batch ownership."
        ),
        "BATCH_VERIFICATION_RECOVERY_REQUIRED"
      );
    }
    if (now() >= deadline) {
      return stop(deadlineReason);
    }

    const detachedVerification = settledPass.verification.detachedVerification;
    if (
      (detachedVerification?.assignedStageOrchestrationGapCount ?? 0) > 0
    ) {
      return stop(
        "error",
        new Error(
          "Course-support verification scheduling did not start the assigned remediation stage."
        ),
        "ASSIGNED_STAGE_ORCHESTRATION_GAP"
      );
    }

    const needsAnotherPass =
      settledPass.browserStages.eligibleCount > 0 ||
      settledPass.browserStages.persistedCount > 0 ||
      settledPass.verification.detachedVerification?.rerunNeeded === true ||
      settledPass.verification.searchExecutionFence?.rerunNeeded === true;
    // Verification can apply a detached result that advances the ledger into
    // an owner-only browser stage after this pass's browser scan. Requiring
    // two consecutive clean scans prevents that phase change from being
    // mistaken for a settled batch.
    if (needsAnotherPass) {
      consecutiveCleanPassCount = 0;
    } else {
      consecutiveCleanPassCount += 1;
    }
    if (!needsAnotherPass && consecutiveCleanPassCount >= 2) {
      let closeout: TCloseout | null;
      if (input.closeout) {
        const closeoutResult = await runBounded((signal) =>
          input.closeout!({
            passCount,
            evidenceRefreshRetryCount,
            lastEvidenceRefreshReason,
            settledPass,
            signal,
          })
        );
        if (closeoutResult.kind === "timeout") {
          return stop(deadlineReason);
        }
        if (closeoutResult.kind === "error") {
          const evidenceRefreshReason = getCourseSupportEvidenceRefreshReason(
            closeoutResult.error,
          );
          if (evidenceRefreshReason) {
            lastEvidenceRefreshReason = evidenceRefreshReason;
          }
          if (
            isCourseSupportSearchExecutionFenceRetryError(closeoutResult.error) ||
            (evidenceRefreshReason !== null &&
              evidenceRefreshRetryCount < MAX_COURSE_SUPPORT_EVIDENCE_REFRESH_RETRIES)
          ) {
            consecutiveCleanPassCount = 0;
            const remainingMs = deadline - now();
            if (remainingMs <= 0) {
              return stop(deadlineReason);
            }
            if (evidenceRefreshReason) {
              evidenceRefreshRetryCount += 1;
            }
            await sleepWithOwnership(Math.min(pollMs, remainingMs));
            continue;
          }
          return stop(
            "error",
            closeoutResult.error,
            "SETTLED_CLOSEOUT_FAILED"
          );
        }
        closeout = closeoutResult.value;
      } else {
        closeout = null;
      }
      return {
        outcome: "verification_watch_settled" as const,
        passCount,
        evidenceRefreshRetryCount,
        lastEvidenceRefreshReason,
        // Keep the final pass available for convergence diagnosis while also
        // exposing every browser-stage action observed during the watch. A
        // settled watch necessarily ends on clean scans, so final-pass counts
        // alone otherwise erase successful earlier browser work.
        browserStages: settledPass.browserStages,
        browserStageTotals,
        verification: settledPass.verification,
        closeout
      };
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return stop(deadlineReason);
    }
    await sleepWithOwnership(Math.min(pollMs, remainingMs));
  }
}

function emptyCourseSupportVerificationBrowserStageTotals(): CourseSupportVerificationBrowserStageTotals {
  return {
    passCountWithEligibleStages: 0,
    passCountWithPersistedStages: 0,
    eligibleCount: 0,
    persistedCount: 0,
    renderedDiscoveryCount: 0,
    independentConfirmationCount: 0
  };
}

function addCourseSupportVerificationBrowserStageTotals(
  totals: CourseSupportVerificationBrowserStageTotals,
  stages: CourseSupportVerificationBrowserStages
): CourseSupportVerificationBrowserStageTotals {
  return {
    passCountWithEligibleStages:
      totals.passCountWithEligibleStages + (stages.eligibleCount > 0 ? 1 : 0),
    passCountWithPersistedStages:
      totals.passCountWithPersistedStages + (stages.persistedCount > 0 ? 1 : 0),
    eligibleCount: totals.eligibleCount + stages.eligibleCount,
    persistedCount: totals.persistedCount + stages.persistedCount,
    renderedDiscoveryCount:
      totals.renderedDiscoveryCount + (stages.renderedDiscoveryCount ?? 0),
    independentConfirmationCount:
      totals.independentConfirmationCount +
      (stages.independentConfirmationCount ?? 0)
  };
}

function throwIfVerificationWatchAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error("Course-support verification watch operation was aborted.");
}
