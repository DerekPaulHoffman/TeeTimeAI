import { isCourseSupportSearchExecutionFenceRetryError } from "./course-support-search-execution-fence";
export const DEFAULT_COURSE_SUPPORT_VERIFICATION_WATCH_MINUTES = 18;
export const DEFAULT_COURSE_SUPPORT_VERIFICATION_POLL_MS = 20_000;
export const DEFAULT_COURSE_SUPPORT_VERIFICATION_RELEASE_CLEANUP_MS = 60_000;
export const DEFAULT_COURSE_SUPPORT_HEARTBEAT_RENEWAL_TIMEOUT_MS = 30_000;

export async function runWithBoundedCourseSupportHeartbeat<T>(input: {
  renew: (signal: AbortSignal) => Promise<void>;
  operation: () => Promise<T>;
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

  let heartbeatFailure: unknown = null;
  let heartbeatInFlight: Promise<void> | null = null;
  const interval = setIntervalTimer(() => {
    if (heartbeatInFlight || heartbeatFailure) {
      return;
    }
    heartbeatInFlight = renewWithinBudget()
      .catch((error) => {
        heartbeatFailure = error;
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
    operationResult = await input.operation();
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
  if (input.watch && !input.closeout) {
    throw new Error("verify --watch requires --closeout.");
  }
  if (input.closeout && !input.watch) {
    throw new Error("verify --closeout requires --watch.");
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

export type CourseSupportVerificationBrowserStages = {
  eligibleCount: number;
  persistedCount: number;
};

export type CourseSupportVerificationPassResult<TVerification> = {
  browserStages: CourseSupportVerificationBrowserStages;
  verification: TVerification & {
    outcome?: string;
    verified?: boolean;
    detachedVerification?: {
      rerunNeeded?: boolean;
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
    detachedVerification?: { rerunNeeded?: boolean } | null;
    searchExecutionFence?: { rerunNeeded?: boolean } | null;
  }
>(input: {
  signal?: AbortSignal;
  persistBrowserStages: () => Promise<TBrowserStages>;
  verifyBatch: () => Promise<TVerification>;
}) {
  throwIfVerificationWatchAborted(input.signal);
  const browserStages = await input.persistBrowserStages();
  throwIfVerificationWatchAborted(input.signal);
  const verification = await input.verifyBatch();
  throwIfVerificationWatchAborted(input.signal);
  return { browserStages, verification };
}

export async function closeoutSettledCourseSupportVerification<TCloseout>(input: {
  courses: Array<{
    ordinal: string | number;
    result: string;
    playbookExhausted: boolean;
  }>;
  closeout: (humanReviewCount: number) => Promise<TCloseout>;
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
    if (course.result === "NEEDS_HUMAN" && !course.playbookExhausted) {
      throw new Error(
        "Course-support verification watch cannot close an explicit human result before its playbook is exhausted."
      );
    }
  }

  return {
    closeout: await input.closeout(humanReviewCourses.length),
    humanReviewCount: humanReviewCourses.length
  };
}

export async function runCourseSupportVerificationWatch<
  TVerification extends {
    outcome?: string;
    verified?: boolean;
    detachedVerification?: { rerunNeeded?: boolean } | null;
    searchExecutionFence?: { rerunNeeded?: boolean } | null;
  },
  TCloseout = never
>(input: {
  pass: (
    signal: AbortSignal
  ) => Promise<CourseSupportVerificationPassResult<TVerification>>;
  closeout?: (input: {
    passCount: number;
    settledPass: CourseSupportVerificationPassResult<TVerification>;
    signal: AbortSignal;
  }) => Promise<TCloseout>;
  onStopped?: (input: {
    reason: "endpoint" | "max" | "error";
    error?: unknown;
    passCount: number;
    lastPass: CourseSupportVerificationPassResult<TVerification> | null;
    signal: AbortSignal;
  }) => Promise<TCloseout>;
  maxMinutes?: number;
  pollMs?: number;
  deadlineAt?: number | null;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  releaseCleanupMs?: number;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}) {
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
  let lastPass: CourseSupportVerificationPassResult<TVerification> | null = null;
  let consecutiveCleanPassCount = 0;

  const runForBudget = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    budgetMs: number,
    timeoutMessage: string
  ) => {
    if (budgetMs <= 0) {
      return { kind: "timeout" as const };
    }
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
    const result = await Promise.race([operationResult, timeoutResult]);
    if (timerHandle !== undefined) {
      clearTimer(timerHandle);
    }
    return result;
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
    error?: unknown
  ) => {
    if (!input.onStopped) {
      if (error) {
        throw error;
      }
      throw new Error(
        "Course-support verification watch timed out before a final clean pass."
      );
    }
    const releaseResult = await runForBudget(
      (signal) =>
        input.onStopped!({
          reason,
          error,
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
      closeout: releaseResult.value
    };
  };

  while (true) {
    if (now() >= deadline) {
      return stop(deadlineReason);
    }

    const passResult = await runBounded(input.pass);
    if (passResult.kind === "timeout") {
      return stop(deadlineReason);
    }
    if (passResult.kind === "error") {
      return stop("error", passResult.error);
    }
    const settledPass = passResult.value;
    passCount += 1;
    lastPass = settledPass;
    if (
      settledPass.verification.verified === false ||
      settledPass.verification.outcome === "recovery_required"
    ) {
      return stop(
        "error",
        new Error(
          "Course-support verification watch lost durable batch ownership."
        )
      );
    }
    if (now() >= deadline) {
      return stop(deadlineReason);
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
          input.closeout!({ passCount, settledPass, signal })
        );
        if (closeoutResult.kind === "timeout") {
          return stop(deadlineReason);
        }
        if (closeoutResult.kind === "error") {
          if (
            isCourseSupportSearchExecutionFenceRetryError(closeoutResult.error)
          ) {
            consecutiveCleanPassCount = 0;
            const remainingMs = deadline - now();
            if (remainingMs <= 0) {
              return stop(deadlineReason);
            }
            await sleep(Math.min(pollMs, remainingMs));
            continue;
          }
          return stop("error", closeoutResult.error);
        }
        closeout = closeoutResult.value;
      } else {
        closeout = null;
      }
      return {
        outcome: "verification_watch_settled" as const,
        passCount,
        browserStages: settledPass.browserStages,
        verification: settledPass.verification,
        closeout
      };
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return stop(deadlineReason);
    }
    await sleep(Math.min(pollMs, remainingMs));
  }
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
