import "./load-local-env";

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  getOwnedCourseSupportLeaseToken,
  heartbeatCourseSupportBatch,
  inspectCourseSupportQueue,
  markCourseSupportBatchNeedsHuman,
  recoverCourseSupportBatch,
  renewCourseSupportBatchOperationLease,
  resolveCourseSupportBatchReference,
  verifyCourseSupportBatch,
  type CourseSupportReleaseAdvanceProof
} from "@/lib/automation/course-support-batches";
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
  selectCourseSupportVerificationEndpointDeadline
} from "@/lib/automation/course-support-verification-watch";
import { getProviderCoverageDashboard } from "@/lib/automation/provider-coverage";
import { persistOwnedCourseSupportBrowserPlaybookStages } from "@/lib/automation/course-support-browser-stages";
import {
  getResponderThreadPolicy,
  sanitizeResponderText,
  sanitizeResponderValue,
  type ResponderFailureDomain,
  type ResponderOutcome
} from "@/lib/automation/course-support-responder-policy";

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

async function main() {
  const [command = "inspect", ...args] = process.argv.slice(2);
  const scheduledCycle = shouldRecordAutomationWorkerCycle({ command, args });
  if (!scheduledCycle) {
    if (!(await isAutomationWorkerExecutionAllowed(AUTOMATION_WORKERS.COURSE_SUPPORT))) {
      writeResult({ outcome: "paused_by_control_plane" });
      return;
    }
    await runCommand(command, args);
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
      () => runCommand(command, args),
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

async function runCommand(command: string, args: string[]) {
  switch (command) {
    case "inspect":
      writeResult(
        await inspectCourseSupportQueue({
          requestingThreadId: optionalOwnerThread(args)
        })
      );
      return;
    case "coverage":
      writeResult(await getProviderCoverageDashboard());
      return;
    case "claim":
      writeResult(await claim(args));
      return;
    case "packet":
      writeResult(await packet(args));
      return;
    case "claim-path":
      writeResult(await claimPath(args));
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
        "Unknown course-support command. Use inspect, coverage, claim, packet, claim-path, mark-needs-human, heartbeat, verify, closeout, recover, or backfill."
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

async function verify(args: string[]) {
  const deployedAtValue = readOption(args, "--deployed-at");
  const deployedAt = deployedAtValue ? new Date(deployedAtValue) : null;
  if (deployedAt && !Number.isFinite(deployedAt.getTime())) {
    throw new Error("--deployed-at must be an ISO timestamp.");
  }
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
  if (currentRuntime && requestedReleaseSha) {
    throw new Error("--current-runtime cannot be combined with --release-sha.");
  }
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
    async (leaseToken) => {
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
                    beforePersist: ({ requireCurrentStage }) =>
                      signal?.aborted
                        ? Promise.reject(signal.reason)
                        : beforePersist({ requireCurrentStage })
                  })
              }
            ),
          verifyBatch: () =>
            verifyCourseSupportBatch({
              batchId,
              leaseToken,
              ownerThreadId,
              releaseSha,
              deployedAt
            })
        });

      if (!watch) {
        const pass = await runPass();
        return { ...pass.verification, browserStages: pass.browserStages };
      }

      const initialPacket = await getCourseSupportBatchPacket({
        batchId,
        leaseToken,
        ownerThreadId
      });
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
                mode:
                  reason === "endpoint" ||
                  (endpointDeadlineAt !== undefined &&
                    Date.now() >= endpointDeadlineAt)
                    ? "ENDPOINT"
                    : "EARLY_RETRY"
              })
          : undefined
      });
      return closeoutAfterWatch
        ? {
            ...watchResult,
            durableCloseoutRecorded:
              watchResult.closeout?.durableCloseoutRecorded === true
          }
        : watchResult;
    }
  );
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
    closeout: (humanReviewCount) =>
      closeoutCourseSupportBatch({
        batchId: input.batchId,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        verificationWatchMode: "WATCH_SETTLED",
        summary: {
          verificationWatch: {
            settled: true,
            passCount: input.passCount,
            humanReviewCount
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
  return { ...result, humanReviewCount: settled.humanReviewCount };
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
    (leaseToken) =>
      closeoutCourseSupportBatch({
        batchId,
        leaseToken,
        ownerThreadId,
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
  operation: (leaseToken: string) => Promise<T>
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
    operation: () => operation(leaseToken),
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
  if (!provenance.releaseSha) {
    return { releaseAdvanceProof: undefined };
  }
  if (!isGitAncestor(provenance.releaseSha, releaseSha)) {
    throw new Error(
      "A follow-up responder release must descend from the persisted release."
    );
  }
  if (!provenance.branch) {
    throw new Error("The responder batch is missing its claimed branch provenance.");
  }
  return {
    releaseAdvanceProof: {
      fromSha: provenance.releaseSha,
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

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function writeResult(value: unknown) {
  process.stdout.write(`${JSON.stringify(sanitizeResponderValue(value), null, 2)}\n`);
}

main().catch((error) => {
  const message = sanitizeResponderText(
    error instanceof Error ? error.message : "Unknown course-support command failure."
  );
  const outcome = classifyCommandFailure(message);
  const policy = getResponderThreadPolicy({
    outcome,
    durableCloseoutRecorded: false
  });
  writeResult({
    outcome,
    error: message,
    durableCloseoutRecorded: false,
    ...policy
  });
  process.exitCode = 1;
});

function classifyCommandFailure(message: string): ResponderOutcome {
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
