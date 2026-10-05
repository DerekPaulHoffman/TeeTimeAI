import "./load-local-env";

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  beginCourseSupportCourseDispatch,
  bindCourseSupportCourseDispatch,
  cancelCourseSupportCourseDispatch,
  getCourseSupportCourseDispatchAssignment,
  planCourseSupportCourseDispatch,
} from "@/lib/automation/course-support-course-dispatch";
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
  const commands = new Set(["plan", "start", "bind", "cancel", "assignment"]);
  if (!command || !commands.has(command)) throw new Error("Use plan, start, bind, cancel, or assignment.");
  const allowedValues = new Set(["--assignment-ref", "--child-thread", "--max-starts"]);
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
  if (options.includes("--confirmed-not-started") && command !== "cancel") {
    throw new Error("--confirmed-not-started is reserved for cancellation.");
  }
  if (command === "cancel" && !options.includes("--confirmed-not-started")) {
    throw new Error("Cancellation requires proof that no native worker was started.");
  }
  return { command, assignmentRef, childThreadId, maxStarts, scheduledCycle: options.includes("--scheduled-cycle") };
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
      result = await planCourseSupportCourseDispatch({ ownerThreadId, baseSha, maxStarts: input.maxStarts });
    } else if (input.command === "start") {
      result = await beginCourseSupportCourseDispatch({ ownerThreadId, assignmentRef: input.assignmentRef! });
    } else if (input.command === "bind") {
      result = await bindCourseSupportCourseDispatch({ ownerThreadId, assignmentRef: input.assignmentRef!, childThreadId: input.childThreadId! });
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
