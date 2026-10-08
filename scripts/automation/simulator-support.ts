import "./load-local-env";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { resolveCodexOwnerThreadId } from "./git-output";
import { readDispatchGitState } from "./course-support-dispatch";
import { adoptSimulatorSupportSource, claimSimulatorSupportAssignment, claimSimulatorSupportPath, completeSimulatorSupport, heartbeatSimulatorSupport, queueSimulatorSupportRechecks, readSimulatorSupportClaim, readSimulatorSupportProgress, recordSimulatorSupportDeployment, registerSimulatorSupportRelease, retrySimulatorSupport, recoverSimulatorSupport, retireSimulatorSupport, configureSimulatorSupportOffering, classifySimulatorSupportOffering, readSimulatorSupportSource } from "@/lib/automation/simulator-support-ownership";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { SIMULATOR_RESEARCH_SOURCE_NAMES, type SimulatorResearchSource } from "@/lib/automation/simulator-support-research-policy";
import { classifySimulatorSupportFailure, readSafeSimulatorSupportFailure, type SimulatorSupportFailure, type SimulatorSupportFailureStage } from "@/lib/automation/simulator-support-failure";
import { waitForGitDeployment } from "@/lib/deployments/wait-for-git-deployment";
import type { VercelDeploymentInspection, VercelDeploymentList } from "@/lib/deployments/vercel-git";
import { SIMULATOR_ENGINEERING_VERIFICATION_FAILURE_CODES, type SimulatorEngineeringVerificationFailureCode } from "@/lib/automation/simulator-support-engineering-verification-policy";

export function readSimulatorSupportArguments(args: readonly string[]) {
  const [command, ...options] = args;
  if (!["claim", "source-read", "progress", "verify-engineering", "heartbeat", "recover", "retire", "configure", "classify", "path", "adopt-source", "release", "deployed", "recheck", "complete", "retry", "inspect"].includes(command)) throw new Error("Use a supported simulator-support command.");
  const values = new Map<string, string>();
  let apply = false;
  let repair = false;
  let rendered = false;
  for (let index = 0; index < options.length; index += 2) {
    if (options[index] === "--rendered") {
      if (rendered || command !== "source-read") throw new Error("Only simulator source research permits --rendered.");
      rendered = true; index -= 1; continue;
    }
    if (options[index] === "--apply") {
      if (apply || !["configure", "classify"].includes(command)) throw new Error("Only reviewed simulator configuration and classification permit --apply.");
      apply = true; index -= 1; continue;
    }
    if (options[index] === "--repair") {
      if (repair || command !== "configure") throw new Error("Only reviewed simulator configuration permits --repair.");
      repair = true; index -= 1; continue;
    }
    const name = options[index], value = options[index + 1]?.trim();
    if (!["--assignment-ref", "--token", "--revision", "--path", "--sha", "--retry-minutes", "--manifest", "--source", "--link"].includes(name) || values.has(name) || !value || value.startsWith("--")) throw new Error("Invalid simulator-support option.");
    values.set(name, value);
  }
  const allowed = new Set(["--assignment-ref", ...(command !== "claim" ? ["--token", "--revision"] : []),
    ...(command === "path" ? ["--path"] : []), ...(command === "release" ? ["--sha"] : []), ...(command === "retry" ? ["--retry-minutes"] : []), ...(["configure", "classify"].includes(command) ? ["--manifest"] : []), ...(command === "source-read" ? ["--source", "--link"] : [])]);
  if ([...values.keys()].some(value => !allowed.has(value)) || !values.get("--assignment-ref") ||
      (!["claim", "inspect"].includes(command) && (!values.get("--token") || !/^[1-9][0-9]*$/.test(values.get("--revision") ?? ""))) ||
      (command === "inspect" && (values.has("--token") !== values.has("--revision") ||
        values.has("--revision") && !/^[1-9][0-9]*$/.test(values.get("--revision")!))) ||
      (command === "path" && !values.get("--path")) || (command === "release" && !/^[a-f0-9]{40}$/i.test(values.get("--sha") ?? "")) ||
      (command === "retry" && !/^[1-9][0-9]*$/.test(values.get("--retry-minutes") ?? "")) ||
      (["configure", "classify"].includes(command) && !values.get("--manifest")) || (repair && !apply) ||
      (command === "source-read" && (values.has("--source") === values.has("--link") ||
        (values.has("--source") && !(SIMULATOR_RESEARCH_SOURCE_NAMES as readonly string[]).includes(values.get("--source")!)) ||
        (values.has("--link") && !/^(?:[1-9]|[12][0-9]|30)$/.test(values.get("--link")!))))) throw new Error("Simulator-support command arguments are incomplete.");
  return { command, assignmentRef: values.get("--assignment-ref")!, token: values.get("--token")!, revision: Number(values.get("--revision")), path: values.get("--path"), releaseSha: values.get("--sha"), retryMinutes: Number(values.get("--retry-minutes")), manifestPath: values.get("--manifest"), source: values.get("--source") as SimulatorResearchSource | undefined,
    linkIndex: values.has("--link") ? Number(values.get("--link")) : undefined, rendered, apply, repair };
}

function git(args: string[]) { return execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim(); }

export function assertSimulatorSupportCompletionCheckout(releaseSha: string, runGit: (args: string[]) => string = git) {
  if (!/^[a-f0-9]{40}$/iu.test(releaseSha) || runGit(["status", "--porcelain"]) ||
      runGit(["rev-parse", "HEAD"]) !== releaseSha) {
    throw new Error("Complete only from the clean exact owned release; unfinished repair needs its own reviewed release provenance.");
  }
}

export function prepareSimulatorSupportReleaseProvenance(input: { releaseSha: string; originalBaseSha: string; plannedPaths: readonly string[];
  priorReleaseSha?: string | null }, runGit: (args: string[]) => string = git) {
  if (runGit(["status", "--porcelain"]) || runGit(["rev-parse", "HEAD"]) !== input.releaseSha) throw new Error("Register a clean exact committed simulator release before publishing.");
  runGit(["fetch", "origin", "main"]);
  const fetchedMainSha = runGit(["rev-parse", "FETCH_HEAD"]);
  const trustedUpstreamSha = runGit(["rev-parse", "origin/main"]);
  if (!/^[a-f0-9]{40}$/i.test(trustedUpstreamSha) || fetchedMainSha !== trustedUpstreamSha) throw new Error("The current trusted upstream could not be verified.");
  runGit(["merge-base", "--is-ancestor", input.originalBaseSha, trustedUpstreamSha]);
  if (input.priorReleaseSha) runGit(["merge-base", "--is-ancestor", input.priorReleaseSha, input.releaseSha]);
  const metadataOnlyReuse = input.plannedPaths.length === 0 &&
    (input.releaseSha === input.originalBaseSha || input.releaseSha === trustedUpstreamSha) ||
    Boolean(input.priorReleaseSha && input.releaseSha === trustedUpstreamSha);
  if (input.plannedPaths.length === 0 && !metadataOnlyReuse) throw new Error("Metadata-only simulator release must reuse the original base or current trusted upstream.");
  if (!metadataOnlyReuse) runGit(["merge-base", "--is-ancestor", trustedUpstreamSha, input.releaseSha]);
  const committedPaths = metadataOnlyReuse ? [] : runGit(["diff", "--name-only", trustedUpstreamSha, input.releaseSha]).split(/\r?\n/).filter(Boolean);
  return { trustedUpstreamSha, upstreamDescendantVerified: true as const, descendantVerified: true as const,
    ...(input.priorReleaseSha ? { priorReleaseDescendantVerified: true as const } : {}), committedPaths };
}

/** Optional inspect guards must match the independently read original claim. */
export function assertSimulatorSupportInspectionFence(input: { token?: string; revision: number }, claim: { token: string; revision: number }) {
  if (input.token !== undefined && (input.token !== claim.token || input.revision !== claim.revision)) {
    throw new Error("Simulator inspection requires the supplied current owner token and revision.");
  }
}

function vercelJson<T>(args: string[]): T {
  if (args.some(value => !/^[A-Za-z0-9_./:=,-]+$/.test(value))) throw new Error("Unsupported Vercel argument.");
  const windows = process.platform === "win32";
  return JSON.parse(execFileSync(windows ? process.env.ComSpec ?? "cmd.exe" : "npx", windows ? ["/d", "/s", "/c", ["npx", "vercel", ...args].join(" ")] : ["vercel", ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 })) as T;
}

/** Original worker only: the fixed production endpoint derives all provider/date/party facts. */
class SimulatorEngineeringVerificationCommandError extends Error {
  constructor(readonly code: SimulatorEngineeringVerificationFailureCode, readonly httpStatus: number) {
    super("The deployed independent simulator verification could not complete; inspect the original worker.");
  }
}
export async function requestSimulatorEngineeringVerification(input: { assignmentRef: string; token: string; revision: number },
  dependencies: { apiKey?: string; fetchImpl?: typeof fetch } = {}) {
  const apiKey = dependencies.apiKey ?? process.env.AUTOMATION_API_KEY;
  if (!apiKey?.trim()) throw new Error("Simulator engineering verification requires the private automation authority.");
  const response = await (dependencies.fetchImpl ?? fetch)("https://teetimespot.com/api/automation/simulator-support/verify", {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(150_000),
    headers: { "content-type": "application/json", "x-automation-key": apiKey },
    body: JSON.stringify({ assignmentRef: input.assignmentRef, token: input.token, revision: input.revision }),
  });
  if (!response.ok) {
    const failed: unknown = await response.json().catch(() => null);
    const value = failed && typeof failed === "object" && !Array.isArray(failed) ? (failed as { code?: unknown }).code : null;
    const code = typeof value === "string" && (SIMULATOR_ENGINEERING_VERIFICATION_FAILURE_CODES as readonly string[]).includes(value)
      ? value as SimulatorEngineeringVerificationFailureCode : "VERIFICATION_FAILED";
    throw new SimulatorEngineeringVerificationCommandError(code, response.status);
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      (result as { engineeringOnly?: unknown }).engineeringOnly !== true ||
      (result as { customerAcceptance?: unknown }).customerAcceptance !== false) {
    throw new Error("Simulator engineering verification returned an invalid independent result.");
  }
  return result;
}

async function main() {
  const input = readSimulatorSupportArguments(process.argv.slice(2));
  if (!process.env.DATABASE_URL?.trim() || !/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL.trim())) throw new Error("Simulator support requires the explicit database environment.");
  const ownerThreadId = resolveCodexOwnerThreadId({ environmentOwnerThreadId: process.env.CODEX_THREAD_ID });
  const owner = { assignmentRef: input.assignmentRef, ownerThreadId, token: input.token, revision: input.revision };
  let result: unknown;
  if (input.command === "claim") {
    const { baseSha } = readDispatchGitState();
    result = await claimSimulatorSupportAssignment({ assignmentRef: input.assignmentRef, ownerThreadId, baseSha, branch: git(["branch", "--show-current"]) });
  } else if (input.command === "inspect") {
    const claim = await readSimulatorSupportClaim({ assignmentRef: input.assignmentRef, ownerThreadId });
    assertSimulatorSupportInspectionFence(input, claim);
    result = claim;
  }
  else if (input.command === "progress") result = await readSimulatorSupportProgress(owner);
  else if (input.command === "verify-engineering") {
    const claim = await readSimulatorSupportClaim(owner);
    assertSimulatorSupportInspectionFence(input, claim);
    result = await requestSimulatorEngineeringVerification(input);
  }
  else if (input.command === "heartbeat") result = await heartbeatSimulatorSupport(owner);
  else if (input.command === "recover") result = await recoverSimulatorSupport(owner);
  else if (input.command === "retire") result = await retireSimulatorSupport(owner);
  else if (input.command === "source-read") result = await readSimulatorSupportSource({ ...owner, source: input.source, linkIndex: input.linkIndex, rendered: input.rendered });
  else if (input.command === "configure") {
    const claim = await readSimulatorSupportClaim(owner);
    const offering = await prisma.courseOffering.findUniqueOrThrow({ where: { id: claim.offeringId } });
    result = await configureSimulatorSupportOffering({ ...owner, manifest: JSON.parse(await readFile(resolve(input.manifestPath!), "utf8")), apply: input.apply, repair: input.repair,
      expectedFingerprint: getSimulatorOfferingSourceFingerprint(offering), expectedOfferingRevision: offering.monitoringRevision });
  } else if (input.command === "classify") result = await classifySimulatorSupportOffering({ ...owner, evidence: JSON.parse(await readFile(resolve(input.manifestPath!), "utf8")), apply: input.apply });
  else if (input.command === "path") result = await claimSimulatorSupportPath({ ...owner, path: input.path! });
  else if (input.command === "adopt-source") {
    const claim = await readSimulatorSupportClaim(owner);
    const offering = await prisma.courseOffering.findUniqueOrThrow({ where: { id: claim.offeringId } });
    result = await adoptSimulatorSupportSource({ ...owner, expectedFingerprint: getSimulatorOfferingSourceFingerprint(offering), expectedOfferingRevision: offering.monitoringRevision });
  } else if (input.command === "release") {
    const claim = await readSimulatorSupportClaim(owner);
    const provenance = prepareSimulatorSupportReleaseProvenance({ releaseSha: input.releaseSha!, originalBaseSha: claim.baseSha,
      plannedPaths: claim.plannedPaths, priorReleaseSha: claim.releaseSha });
    result = await registerSimulatorSupportRelease({ ...owner, releaseSha: input.releaseSha!, branch: git(["branch", "--show-current"]),
      ...provenance });
  } else if (input.command === "deployed") {
    const claim = await readSimulatorSupportClaim(owner);
    if (!claim.releaseSha) throw new Error("Register the release SHA first.");
    const proof = await waitForGitDeployment({ commitSha: claim.releaseSha, pollSeconds: 30, timeoutSeconds: 300 }, {
      listDeployments: () => vercelJson<VercelDeploymentList>(["ls", "--environment", "production", "--meta", `githubCommitSha=${claim.releaseSha}`, "--format", "json", "--limit", "20"]),
      inspectAlias: alias => vercelJson<VercelDeploymentInspection>(["inspect", alias, "--format", "json"]),
    });
    result = await recordSimulatorSupportDeployment({ ...owner, proof });
  } else if (input.command === "recheck") result = await queueSimulatorSupportRechecks(owner);
  else if (input.command === "complete") {
    const claim = await readSimulatorSupportClaim(owner);
    if (!claim.releaseSha) throw new Error("Register the release SHA first.");
    assertSimulatorSupportCompletionCheckout(claim.releaseSha);
    const currentDeployment = await waitForGitDeployment({ commitSha: claim.releaseSha, timeoutSeconds: 60, pollSeconds: 15 }, {
      listDeployments: () => vercelJson<VercelDeploymentList>(["ls", "--environment", "production", "--meta", `githubCommitSha=${claim.releaseSha}`, "--format", "json", "--limit", "20"]),
      inspectAlias: alias => vercelJson<VercelDeploymentInspection>(["inspect", alias, "--format", "json"]),
    });
    result = await completeSimulatorSupport({ ...owner, currentDeployment });
  }
  else {
    const claim = await readSimulatorSupportClaim(owner);
    assertSimulatorSupportInspectionFence(input, claim);
    if (claim.supportAuthority === "ENGINEERING_INCIDENT" && claim.phase === "VERIFYING" && claim.releaseSha) {
      assertSimulatorSupportCompletionCheckout(claim.releaseSha);
      const currentDeployment = await waitForGitDeployment({ commitSha: claim.releaseSha, timeoutSeconds: 60, pollSeconds: 15 }, {
        listDeployments: () => vercelJson<VercelDeploymentList>(["ls", "--environment", "production", "--meta", `githubCommitSha=${claim.releaseSha}`, "--format", "json", "--limit", "20"]),
        inspectAlias: alias => vercelJson<VercelDeploymentInspection>(["inspect", alias, "--format", "json"]),
      });
      result = await retrySimulatorSupport({ ...owner, retryMinutes: input.retryMinutes, currentDeployment, releaseCheckoutVerified: true });
    } else result = await retrySimulatorSupport({ ...owner, retryMinutes: input.retryMinutes });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function reportSimulatorSupportFailure(error: unknown, stage: SimulatorSupportFailureStage = "COMMAND", latestOwnedRevision?: number, settledFailure?: SimulatorSupportFailure) {
  if (error instanceof SimulatorEngineeringVerificationCommandError) {
    process.stderr.write(`${JSON.stringify({ simulatorEngineeringVerificationFailure: { code: error.code, httpStatus: error.httpStatus } })}\n`);
  }
  const failure = readSafeSimulatorSupportFailure(settledFailure) ?? classifySimulatorSupportFailure(error, stage);
  const recovery = error as { durableCloseoutRecorded?: unknown; retryAt?: unknown } | null;
  const closedRetry = recovery?.durableCloseoutRecorded === true && typeof recovery.retryAt === "string" &&
    Number.isFinite(Date.parse(recovery.retryAt));
  process.stderr.write(`${JSON.stringify({ simulatorSupportFailure: { ...failure,
    ...(Number.isSafeInteger(latestOwnedRevision) && latestOwnedRevision! > 0 ? { latestOwnedRevision } : {}),
    ...(closedRetry ? { durableCloseoutRecorded: true, retryAt: recovery!.retryAt } : {}) } })}\n`);
  process.stderr.write(closedRetry ? "Simulator research failed; a durable automatic retry is recorded. Stop this operation.\n" :
    "Simulator support failed; preserve offering ownership and stop this operation.\n");
  process.exitCode = 1;
  return failure;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().catch(async error => {
  let latestOwnedRevision: number | undefined = error instanceof Error && "revision" in error && Number.isSafeInteger(error.revision)
    ? error.revision as number : undefined;
  if (error instanceof Error && error.message === "SIMULATOR_RESEARCH_HARD_FAILED" && process.argv[2] === "source-read") {
    try {
      const input = readSimulatorSupportArguments(process.argv.slice(2));
      const ownerThreadId = resolveCodexOwnerThreadId({ environmentOwnerThreadId: process.env.CODEX_THREAD_ID });
      const claim = await readSimulatorSupportClaim({ assignmentRef: input.assignmentRef, ownerThreadId });
      latestOwnedRevision ??= claim.revision;
    } catch { /* Diagnostic ownership read failure cannot replace the original hard fence. */ }
  }
  const settledFailure = error instanceof Error && error.message === "SIMULATOR_RESEARCH_HARD_FAILED"
    ? readSafeSimulatorSupportFailure((error as Error & { failure?: unknown }).failure) ?? undefined : undefined;
  reportSimulatorSupportFailure(error, "COMMAND", latestOwnedRevision, settledFailure);
}).finally(() => prisma.$disconnect());
