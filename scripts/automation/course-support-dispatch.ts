import "./load-local-env";

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  beginCourseSupportCourseDispatch,
  bindCourseSupportCourseDispatch,
  cancelCourseSupportCourseDispatch,
  getCourseSupportCourseDispatchAssignment,
  planCourseSupportCourseDispatch,
  recordCourseSupportContinuationSent,
  reserveCourseSupportContinuation,
} from "@/lib/automation/course-support-course-dispatch";
import {
  courseSupportContinuationRequestSchema,
  courseSupportContinuationSentRequestSchema,
} from "@/lib/automation/course-support-continuation";
import { classifySimulatorSupportFailure } from "@/lib/automation/simulator-support-failure";
import { inspectCourseSupportQueue } from "@/lib/automation/course-support-batches";
import { refreshPendingCustomerRecoveries } from "@/lib/automation/course-support-customer-recovery";
import {
  AUTOMATION_WORKERS,
  completeAutomationWorker,
  startAutomationWorker,
} from "@/lib/automation/worker-state";
import { prisma } from "@/lib/prisma";
import { resolveCodexOwnerThreadId } from "./git-output";

export function readDispatchOption(args: readonly string[], name: string) {
  const indices = args.flatMap((value, index) => value === name ? [index] : []);
  if (indices.length > 1) throw new Error(`${name} may be provided only once.`);
  if (indices.length === 0) return undefined;
  const value = args[indices[0] + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export function readDispatchArguments(args: readonly string[]) {
  const [command, ...options] = args;
  const commands = new Set(["plan", "start", "bind", "cancel", "assignment", "continue", "continued"]);
  if (!command || !commands.has(command)) throw new Error("Use plan, start, bind, cancel, assignment, continue, or continued.");
  const allowedValues = new Set(["--assignment-ref", "--child-thread", "--max-starts", "--receipt-file", "--launcher-receipt"]);
  const allowedFlags = new Set(["--scheduled-cycle", "--confirmed-not-started"]);
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (allowedFlags.has(option)) continue;
    if (!allowedValues.has(option)) throw new Error("Unknown course-dispatch option.");
    index += 1;
    if (!options[index] || options[index].startsWith("--")) throw new Error(`${option} requires a value.`);
  }
  for (const flag of allowedFlags) {
    if (options.filter(value => value === flag).length > 1) throw new Error(`${flag} may be provided only once.`);
  }
  const assignmentRef = readDispatchOption(options, "--assignment-ref");
  const childThreadId = readDispatchOption(options, "--child-thread");
  const maxStartsValue = readDispatchOption(options, "--max-starts");
  const receiptFile = readDispatchOption(options, "--receipt-file");
  const launcherReceiptPath = readDispatchOption(options, "--launcher-receipt");
  const maxStarts = maxStartsValue === undefined ? undefined : Number(maxStartsValue);
  if (maxStarts !== undefined && (!Number.isSafeInteger(maxStarts) || maxStarts < 1 || maxStarts > 15)) {
    throw new Error("--max-starts must be an integer from 1 to 15.");
  }
  if (command === "plan" && (assignmentRef || childThreadId || options.includes("--confirmed-not-started"))) {
    throw new Error("Plan accepts only a start limit and the scheduled-cycle flag.");
  }
  if (command !== "plan" && (!assignmentRef || maxStarts !== undefined || options.includes("--scheduled-cycle"))) {
    throw new Error("This command requires one assignment reference and no plan flags.");
  }
  if ((command === "bind") !== Boolean(childThreadId)) throw new Error("Only bind requires --child-thread.");
  if (launcherReceiptPath && command !== "bind") throw new Error("The original launcher receipt belongs to binding.");
  if (["continue", "continued"].includes(command) !== Boolean(receiptFile)) {
    throw new Error("Only same-worker continuation commands require --receipt-file.");
  }
  if (options.includes("--confirmed-not-started") && command !== "cancel") {
    throw new Error("--confirmed-not-started is reserved for cancellation.");
  }
  if (command === "cancel" && !options.includes("--confirmed-not-started")) {
    throw new Error("Cancellation requires proof that no native worker was started.");
  }
  return { command, assignmentRef, childThreadId, launcherReceiptPath, maxStarts, receiptFile, scheduledCycle: options.includes("--scheduled-cycle") };
}

export function readDispatchGitState(requireCurrentMain = true) {
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
  const baseSha = git(["rev-parse", "HEAD"]);
  const currentMain = git(["rev-parse", "origin/main"]);
  const branch = git(["branch", "--show-current"]);
  if (!branch || branch === "main" || git(["status", "--porcelain"]) || (requireCurrentMain && baseSha !== currentMain) || !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error("Course dispatch requires a clean named task branch at current origin/main.");
  }
  return { baseSha };
}

type DispatchPlan = Awaited<ReturnType<typeof planCourseSupportCourseDispatch>>;
type LegacyInspection = Awaited<ReturnType<typeof inspectCourseSupportQueue>>;

export function courseDispatchMayInspectLegacy(plan: DispatchPlan) {
  if (!plan.acquired) return false;
  return plan.value.launchItems.length === 0 && plan.value.reservedCount === 0 &&
    plan.value.eligibleCount === 0 && plan.value.attention.startingCount === 0 &&
    plan.value.attention.boundCount === 0 && (plan.value.continuationItems?.length ?? 0) === 0 &&
    (plan.value.continuationAttentionCount ?? 0) === 0;
}

export function readCourseDispatchContinuationReceipt(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 16_384) {
    throw new Error("Continuation requires one bounded private JSON receipt file.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function formatCourseDispatchFailure(error: unknown) {
  const failure = classifySimulatorSupportFailure(error, "COMMAND");
  return `${JSON.stringify({ outcome: "course_dispatch_failed", failure, preserveAssignment: true })}\n` +
    "Course dispatch failed; preserve assignment state and stop this launch.\n";
}

export function selectCourseDispatchLegacyHandoff(inspection: LegacyInspection) {
  const { handoff } = inspection;
  if (handoff.action === "RESUME" && inspection.ownedByCurrentTask && inspection.activeWriter?.batchRef) {
    return { ...handoff, batchRef: inspection.activeWriter.batchRef };
  }
  if (handoff.action === "RECOVER" && inspection.expiredBatch?.batchRef &&
      !inspection.expiredBatch.dispatchAssigned) {
    return { ...handoff, batchRef: inspection.expiredBatch.batchRef };
  }
  if (handoff.action === "CLAIM" && inspection.dueRealCount === 0 &&
      handoff.maxCourses === 1 && inspection.candidateHistoryEvidenceStatus === "COMPLETE" &&
      ["ORDINARY_DISPATCH", "PARKED_CAMPAIGN"].includes(handoff.source)) {
    return handoff;
  }
  return null;
}

export async function planCourseDispatchCycle(
  input: { ownerThreadId: string; baseSha: string; maxStarts?: number; scheduledCycle: boolean },
  dependencies = {
    plan: planCourseSupportCourseDispatch,
    refresh: refreshPendingCustomerRecoveries,
    inspect: inspectCourseSupportQueue,
  },
) {
  const plan = await dependencies.plan({
    ownerThreadId: input.ownerThreadId, baseSha: input.baseSha, maxStarts: input.maxStarts,
  });
  if (!plan.acquired || !courseDispatchMayInspectLegacy(plan)) return plan;
  // The plan's writer transition has committed before this legacy read.
  // Native reservations and pending active-future courses fence fallback.
  const customerRecovery = await dependencies.refresh();
  const inspection = await dependencies.inspect({
    requestingThreadId: input.ownerThreadId,
    completeParkedCampaignIfDone: input.scheduledCycle,
    admissionRuntimeVersion: input.baseSha,
  });
  return {
    ...plan,
    value: { ...plan.value, legacyInspection: {
      outcome: inspection.outcome,
      handoff: selectCourseDispatchLegacyHandoff(inspection),
      customerRecovery: {
        inspectedCount: customerRecovery.inspectedCount,
        completedCount: customerRecovery.completedCount,
        pendingCount: customerRecovery.pendingCount,
      },
      dueRealCount: inspection.dueRealCount,
      dueEngineeringCount: inspection.dueEngineeringCount,
      candidateHistoryEvidenceStatus: inspection.candidateHistoryEvidenceStatus,
    } },
  };
}

async function main() {
  const input = readDispatchArguments(process.argv.slice(2));
  if (!process.env.DATABASE_URL?.trim() || !/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL.trim())) {
    throw new Error("Course dispatch requires the explicit database environment.");
  }
  const ownerThreadId = resolveCodexOwnerThreadId({ environmentOwnerThreadId: process.env.CODEX_THREAD_ID });
  // Binding an already-created child must survive another worker's legitimate
  // main advance. The durable assignment still supplies its own exact fences.
  const { baseSha } = readDispatchGitState(["plan", "continue"].includes(input.command));
  let scheduled = false;
  try {
    if (input.scheduledCycle) {
      const worker = await startAutomationWorker(AUTOMATION_WORKERS.COURSE_SUPPORT, { runnerVersion: baseSha });
      if (!worker.allowed) {
        process.stdout.write(`${JSON.stringify({ outcome: "paused_by_control_plane", launchItems: [] })}\n`);
        return;
      }
      scheduled = true;
    }
    let result: unknown;
    if (input.command === "plan") {
      result = await planCourseDispatchCycle({
        ownerThreadId, baseSha, maxStarts: input.maxStarts, scheduledCycle: input.scheduledCycle,
      });
    } else if (input.command === "start") {
      result = await beginCourseSupportCourseDispatch({ ownerThreadId, assignmentRef: input.assignmentRef! });
    } else if (input.command === "bind") {
      result = await bindCourseSupportCourseDispatch({ ownerThreadId, assignmentRef: input.assignmentRef!, childThreadId: input.childThreadId!, launcherReceiptPath: input.launcherReceiptPath });
    } else if (input.command === "cancel") {
      result = await cancelCourseSupportCourseDispatch({ ownerThreadId, assignmentRef: input.assignmentRef!, confirmedNotCreated: true });
    } else if (input.command === "continue") {
      const receipt = courseSupportContinuationRequestSchema.parse(readCourseDispatchContinuationReceipt(input.receiptFile!));
      result = await reserveCourseSupportContinuation({ ownerThreadId, assignmentRef: input.assignmentRef!,
        currentMainSha: baseSha, ...receipt });
    } else if (input.command === "continued") {
      const receipt = courseSupportContinuationSentRequestSchema.parse(readCourseDispatchContinuationReceipt(input.receiptFile!));
      result = await recordCourseSupportContinuationSent({ ownerThreadId, assignmentRef: input.assignmentRef!, ...receipt });
    } else {
      result = await getCourseSupportCourseDispatchAssignment({ assignmentRef: input.assignmentRef!, childThreadId: ownerThreadId });
    }
    if (scheduled) await completeAutomationWorker(AUTOMATION_WORKERS.COURSE_SUPPORT, "course_dispatch_complete");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (scheduled) await completeAutomationWorker(AUTOMATION_WORKERS.COURSE_SUPPORT, "course_dispatch_failed").catch(() => {});
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(formatCourseDispatchFailure(error));
    process.exitCode = 1;
  });
}
