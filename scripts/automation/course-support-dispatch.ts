import "./load-local-env";

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import {
  beginCourseSupportCourseDispatch,
  bindCourseSupportCourseDispatch,
  cancelCourseSupportCourseDispatch,
  getCourseSupportCourseDispatchAssignment,
  listCourseSupportStartupReceiptBindings,
  planCourseSupportCourseDispatch,
  reconcileCourseSupportStartupTerminal,
  type CourseDispatchStartupTerminalProof,
} from "@/lib/automation/course-support-course-dispatch";
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
  const commands = new Set(["plan", "start", "bind", "cancel", "assignment", "reconcile-startup"]);
  if (!command || !commands.has(command)) throw new Error("Use plan, start, bind, cancel, assignment, or reconcile-startup.");
  const allowedValues = new Set(["--assignment-ref", "--child-thread", "--max-starts", "--receipt"]);
  const allowedFlags = new Set(["--scheduled-cycle", "--confirmed-not-started", "--legacy-bind"]);
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
  const receiptPath = readDispatchOption(options, "--receipt");
  const maxStartsValue = readDispatchOption(options, "--max-starts");
  const maxStarts = maxStartsValue === undefined ? undefined : Number(maxStartsValue);
  if (maxStarts !== undefined && (!Number.isSafeInteger(maxStarts) || maxStarts < 1 || maxStarts > 5)) {
    throw new Error("--max-starts must be an integer from 1 to 5.");
  }
  if (receiptPath) {
    if (!isAbsolute(receiptPath)) throw new Error("Worker receipt paths must be absolute.");
    if (!["bind", "reconcile-startup"].includes(command) || assignmentRef || childThreadId ||
        maxStarts !== undefined || [...allowedFlags].some(flag => options.includes(flag))) {
      throw new Error("Receipt commands accept only the validated local receipt path.");
    }
    return { command, receiptPath, assignmentRef, childThreadId, maxStarts, scheduledCycle: false };
  }
  if (command === "reconcile-startup") throw new Error("Startup reconciliation requires --receipt.");
  if (options.includes("--legacy-bind") && command !== "bind") throw new Error("Legacy binding is reserved for bind.");
  if (command === "bind" && !options.includes("--legacy-bind")) throw new Error("New worker bindings require --receipt; old workers require explicit --legacy-bind.");
  if (command === "plan" && (assignmentRef || childThreadId || options.includes("--confirmed-not-started"))) {
    throw new Error("Plan accepts only a start limit and the scheduled-cycle flag.");
  }
  if (command !== "plan" && (!assignmentRef || maxStarts !== undefined || options.includes("--scheduled-cycle"))) {
    throw new Error("This command requires one assignment reference and no plan flags.");
  }
  if ((command === "bind") !== Boolean(childThreadId)) throw new Error("Only bind requires --child-thread.");
  if (options.includes("--confirmed-not-started") && command !== "cancel") {
    throw new Error("--confirmed-not-started is reserved for cancellation.");
  }
  if (command === "cancel" && !options.includes("--confirmed-not-started")) {
    throw new Error("Cancellation requires proof that no native worker was started.");
  }
  return { command, receiptPath, assignmentRef, childThreadId, maxStarts, scheduledCycle: options.includes("--scheduled-cycle") };
}

type PreparedReceipt = { assignmentRef: string; childThreadId: string; preparedReceiptSha256: string };
type TerminalReceipt = CourseDispatchStartupTerminalProof | { outcome: "NOT_TERMINAL" };
async function nativeReceiptReaders() {
  // The launcher is executable JavaScript with no import-time launch or environment load.
  // @ts-expect-error The native launcher exposes validated receipt readers without a TS declaration.
  return import("./course-support-worker-launcher.mjs") as Promise<{
    readPreparedWorkerReceipt(path: string): PreparedReceipt;
    readTerminalWorkerReceipt(path: string): TerminalReceipt;
  }>;
}
async function readPreparedReceipt(path: string) {
  return (await nativeReceiptReaders()).readPreparedWorkerReceipt(path);
}
async function readTerminalReceipt(path: string) {
  return (await nativeReceiptReaders()).readTerminalWorkerReceipt(path);
}
function absoluteReceiptPath(path: string) {
  if (!isAbsolute(path)) throw new Error("Worker receipt paths must be absolute.");
  return resolve(path);
}

export async function bindCourseDispatchReceipt(ownerThreadId: string, receiptPath: string,
  dependencies = { read: readPreparedReceipt, bind: bindCourseSupportCourseDispatch }) {
  const path = absoluteReceiptPath(receiptPath);
  const receipt = await dependencies.read(path);
  return dependencies.bind({ ownerThreadId, assignmentRef: receipt.assignmentRef,
    childThreadId: receipt.childThreadId, startupReceipt: {
      schemaVersion: 1, receiptPath: path, preparedReceiptSha256: receipt.preparedReceiptSha256,
    } });
}

export async function reconcileCourseDispatchReceipt(requestingThreadId: string, receiptPath: string,
  dependencies = { read: readTerminalReceipt, reconcile: reconcileCourseSupportStartupTerminal }) {
  const path = absoluteReceiptPath(receiptPath);
  const proof = await dependencies.read(path);
  if (proof.outcome !== "READY") return { outcome: "startup_unproven" as const, retiredCount: 0 };
  return dependencies.reconcile({ requestingThreadId, receiptPath: path, proof });
}

export async function reconcileCourseDispatchStartups(requestingThreadId: string,
  dependencies = { list: listCourseSupportStartupReceiptBindings,
    read: readTerminalReceipt, reconcile: reconcileCourseSupportStartupTerminal }) {
  const { bindings, legacyBoundCount } = await dependencies.list();
  const summary = { inspectedCount: 0, retiredCount: 0, unknownOrLegacyCount: legacyBoundCount,
    invalidReceiptCount: 0, reconciliationRefusedCount: 0 };
  for (const binding of bindings) {
    summary.inspectedCount += 1;
    let proof: TerminalReceipt;
    try { proof = await dependencies.read(binding.receiptPath); }
    catch { summary.invalidReceiptCount += 1; continue; }
    if (proof.outcome !== "READY") { summary.unknownOrLegacyCount += 1; continue; }
    if (proof.assignmentRef !== binding.assignmentRef || proof.childThreadId !== binding.childThreadId ||
        proof.preparedReceiptSha256 !== binding.preparedReceiptSha256) {
      summary.invalidReceiptCount += 1; continue;
    }
    try {
      const result = await dependencies.reconcile({ requestingThreadId, receiptPath: binding.receiptPath, proof });
      if (result.acquired) summary.retiredCount += result.value.retiredCount;
      else summary.reconciliationRefusedCount += 1;
    } catch { summary.reconciliationRefusedCount += 1; }
  }
  return summary;
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
    plan.value.attention.boundCount === 0;
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
    reconcile: reconcileCourseDispatchStartups,
  },
) {
  // Read local proof once, before acquiring each DB writer transition. No worker polling loop.
  const startupReconciliation = await dependencies.reconcile?.(input.ownerThreadId);
  const rawPlan = await dependencies.plan({
    ownerThreadId: input.ownerThreadId, baseSha: input.baseSha, maxStarts: input.maxStarts,
  });
  const plan = rawPlan.acquired && startupReconciliation
    ? { ...rawPlan, value: { ...rawPlan.value, startupReconciliation } } : rawPlan;
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
  const { baseSha } = readDispatchGitState(input.command === "plan");
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
      result = input.receiptPath ? await bindCourseDispatchReceipt(ownerThreadId, input.receiptPath) :
        await bindCourseSupportCourseDispatch({ ownerThreadId, assignmentRef: input.assignmentRef!, childThreadId: input.childThreadId! });
    } else if (input.command === "reconcile-startup") {
      result = await reconcileCourseDispatchReceipt(ownerThreadId, input.receiptPath!);
    } else if (input.command === "cancel") {
      result = await cancelCourseSupportCourseDispatch({ ownerThreadId, assignmentRef: input.assignmentRef!, confirmedNotCreated: true });
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
  main().catch(() => {
    process.stderr.write("Course dispatch failed; preserve assignment state and stop this launch.\n");
    process.exitCode = 1;
  });
}
