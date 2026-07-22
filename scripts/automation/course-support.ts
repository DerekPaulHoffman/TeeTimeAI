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
  closeoutCourseSupportBatch,
  getCourseSupportBatchPacket,
  getCourseSupportBatchRecoveryProvenance,
  getOwnedCourseSupportLeaseToken,
  heartbeatCourseSupportBatch,
  inspectCourseSupportQueue,
  markCourseSupportBatchNeedsHuman,
  recoverCourseSupportBatch,
  resolveCourseSupportBatchReference,
  verifyCourseSupportBatch,
  type CourseSupportReleaseAdvanceProof
} from "@/lib/automation/course-support-batches";
import {
  getResponderThreadPolicy,
  sanitizeResponderText,
  sanitizeResponderValue,
  type ResponderFailureDomain,
  type ResponderOutcome
} from "@/lib/automation/course-support-responder-policy";

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

async function main() {
  const [command = "inspect", ...args] = process.argv.slice(2);
  switch (command) {
    case "inspect":
      writeResult(
        await inspectCourseSupportQueue({
          requestingThreadId: optionalOwnerThread(args)
        })
      );
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
        "Unknown course-support command. Use inspect, claim, packet, claim-path, mark-needs-human, heartbeat, verify, closeout, recover, or backfill."
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
  const releaseSha = readOption(args, "--release-sha");
  let releaseAdvanceProof: CourseSupportReleaseAdvanceProof | undefined;
  if (releaseSha) {
    ({ releaseAdvanceProof } = await assertReleaseGitProvenance(
      batchId,
      releaseSha
    ));
  }
  return heartbeatCourseSupportBatch({
    batchId,
    leaseToken: await getOwnedCourseSupportLeaseToken({ batchId, ownerThreadId }),
    ownerThreadId,
    status: requestedStatus as "IMPLEMENTING" | "VERIFYING" | undefined,
    releaseSha,
    releaseAdvanceProof
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
  const releaseSha = readOption(args, "--release-sha");
  if (releaseSha) {
    await assertReleaseGitProvenance(batchId, releaseSha);
  }
  return verifyCourseSupportBatch({
    batchId,
    leaseToken: await getOwnedCourseSupportLeaseToken({ batchId, ownerThreadId }),
    ownerThreadId,
    releaseSha,
    deployedAt
  });
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
  return closeoutCourseSupportBatch({
    batchId,
    leaseToken: await getOwnedCourseSupportLeaseToken({ batchId, ownerThreadId }),
    ownerThreadId,
    requestedOutcome: requestedOutcome as ResponderOutcome | undefined,
    failureDomain: failureDomain as ResponderFailureDomain | undefined,
    retryAfterSeconds:
      readIntegerOption(args, "--retry-after-seconds") ??
      numberValue(payload.retryAfterSeconds),
    summary: payload.summary ?? payload
  });
}

async function recover(args: string[]) {
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
    baseIsAncestor,
    committedPaths,
    releaseIsAncestor,
    releaseCommittedPaths
  });
}

async function resolveBatchId(args: string[]) {
  return resolveCourseSupportBatchReference(requireOption(args, "--batch-ref"));
}

async function assertReleaseGitProvenance(batchId: string, releaseSha: string) {
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
  const plannedPaths = new Set(provenance.plannedPaths);
  const committedPaths = readCommittedPaths(provenance.baseSha, git.headSha);
  const unplannedPaths = committedPaths.filter((path) => !plannedPaths.has(path));
  if (unplannedPaths.length > 0) {
    throw new Error(
      `Release contains paths not claimed by the responder: ${unplannedPaths.join(", ")}`
    );
  }
  if (!provenance.releaseSha || provenance.releaseSha === releaseSha) {
    return { releaseAdvanceProof: undefined };
  }
  if (!isGitAncestor(provenance.releaseSha, releaseSha)) {
    throw new Error(
      "A follow-up responder release must descend from the persisted release."
    );
  }
  const releaseCommittedPaths = readCommittedPaths(
    provenance.releaseSha,
    releaseSha
  );
  if (releaseCommittedPaths.length === 0) {
    throw new Error("A follow-up responder release must contain a committed change.");
  }
  const unplannedReleasePaths = releaseCommittedPaths.filter(
    (path) => !plannedPaths.has(path)
  );
  if (unplannedReleasePaths.length > 0) {
    throw new Error(
      `Follow-up release contains paths not claimed by the responder: ${unplannedReleasePaths.join(", ")}`
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
      committedPaths: releaseCommittedPaths,
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
