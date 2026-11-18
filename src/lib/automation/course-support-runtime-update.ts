import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const reasons = new Set([
  "ORIGINAL_NATIVE_OWNER_REQUIRED", "EXPECTED_RUNNING_MANAGED_TASK_REQUIRED", "MANAGED_TASK_ACTION_CHANGED",
  "MANAGED_TASK_PATHS_CHANGED", "ACTIVE_SOL_READER_SCOPE_REQUIRED", "CLEAN_COMMITTED_SOURCE_REQUIRED", "OWNED_SOURCE_BRANCH_REQUIRED",
  "CURRENT_PUBLISHED_RUNTIME_REQUIRED", "RUNTIME_REPOSITORY_CHANGED", "DIRTY_MANAGED_RUNTIME",
  "DEPENDENCY_SCHEMA_OR_INSTALLED_READER_ROLLOUT_REQUIRED", "EXACT_RELEASE_PROOF_REQUIRED", "RUNTIME_VALIDATION_FAILED",
  "NATIVE_DRAIN_PROTOCOL_BOOTSTRAP_REQUIRED", "CURRENT_STAGEHAND_MODE_REQUIRED", "SINGLE_MANAGED_SUPERVISOR_REQUIRED",
  "INVALID_DRAIN_CONTROL", "DRAIN_CONTROL_CHANGED", "RUNTIME_DRAIN_OR_STARTUP_NOT_PROVED", "MANAGED_RUNTIME_CHANGED_DURING_DRAIN",
  "OLD_SUPERVISOR_STILL_RUNNING", "EXACT_RUNTIME_UPDATE_FAILED", "RUNTIME_CONFIGURATION_CHANGED", "NEW_SINGLETON_RUNTIME_NOT_PROVED",
  "RUNTIME_PROOF_COMMAND_FAILED", "RUNTIME_UPDATE_FAILED",
  "INVALID_RUNTIME_VERSION", "RUNTIME_CI_REQUIRED", "RUNTIME_CI_PENDING_TIMEOUT", "RUNTIME_GIT_DEPLOYMENT_REQUIRED",
  "RUNTIME_CANONICAL_ALIASES_REQUIRED", "INVALID_RUNTIME_PROOF_ARGUMENT", "RUNTIME_RELEASE_PROOF_UNAVAILABLE",
]);
const phases = new Set([
  "VALIDATE_NATIVE_OWNER", "VALIDATE_MANAGED_TASK", "VALIDATE_ACTIVATION", "VALIDATE_SOURCE", "QUALIFY_RELEASE", "VALIDATE_READER",
  "ACQUIRE_UPDATE_LOCK", "CAPTURE_CONFIGURATION", "VALIDATE_SINGLETON", "VALIDATE_DRAIN_CONTROL", "WRITE_DRAIN_CONTROL",
  "RECONCILE_STOPPED_UPDATED_RUNTIME", "RESTART_STOPPED_UPDATED_TASK",
  "WAIT_DRAIN_ACKNOWLEDGEMENT", "REVALIDATE_DRAINED_RUNTIME", "STOP_MANAGED_TASK", "WAIT_SUPERVISOR_STOP", "UPDATE_RUNTIME",
  "VALIDATE_UPDATED_RUNTIME", "START_MANAGED_TASK", "VERIFY_UPDATED_SINGLETON", "WRITE_ACTIVATION_RECEIPT",
]);
const flags = ["apply", "stateChanged", "mutationAttempted", "drainAttempted", "taskStopAttempted",
  "runtimeUpdateAttempted", "taskStartAttempted", "activationWriteAttempted"] as const;

type Flag = typeof flags[number];
export type RuntimeUpdateDiagnostic = {
  attributed: boolean; reasonCode: string; phase: string; acceptanceRestartProof: false;
  taskStartRequests: number | null; firstStoppedTaskResult: 1 | null;
} & Record<Flag, boolean | null>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parse(stdout: unknown) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 16_384) return null;
  try { return record(JSON.parse(stdout)); } catch { return null; }
}

/** Never forward stderr, exception text, extra JSON fields or partial guesses.
 * Unattributed output has unknown mutation state, even if the host looks idle. */
export function projectRuntimeUpdateDiagnostic(stdout: unknown): RuntimeUpdateDiagnostic {
  const value = parse(stdout);
  const valid = value?.schemaVersion === 1 && value.outcome === "blocked" && value.acceptanceRestartProof === false &&
    typeof value.reasonCode === "string" && reasons.has(value.reasonCode) && typeof value.phase === "string" && phases.has(value.phase) &&
    flags.every(key => typeof value[key] === "boolean");
  return { attributed: Boolean(valid), reasonCode: valid ? value.reasonCode as string : "UNATTRIBUTED_RUNTIME_UPDATE_FAILURE",
    phase: valid ? value.phase as string : "UNKNOWN", acceptanceRestartProof: false,
    taskStartRequests: valid && Number.isSafeInteger(value.taskStartRequests) && Number(value.taskStartRequests) >= 0 && Number(value.taskStartRequests) <= 2
      ? value.taskStartRequests as number : null,
    firstStoppedTaskResult: valid && value.firstStoppedTaskResult === 1 ? 1 : null,
    ...Object.fromEntries(flags.map(key => [key, valid ? value[key] : null])) as Record<Flag, boolean | null> };
}

export class CourseSupportRuntimeUpdateFailure extends Error {
  readonly diagnostic: RuntimeUpdateDiagnostic;
  constructor(stdout: unknown) {
    super("LOCAL_RUNTIME_UPDATE_NOT_PROVED");
    this.name = "CourseSupportRuntimeUpdateFailure";
    this.diagnostic = projectRuntimeUpdateDiagnostic(stdout);
  }
}

type Execute = (executable: string, args: string[], options: {
  encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: boolean;
}) => Promise<{ stdout: string }>;

export async function prepareCourseSupportRuntime(input: {
  executable: string; scriptPath: string; runtimeVersion: string; ownerThreadId: string;
}, execute: Execute = executeFile) {
  let stdout: string;
  try {
    ({ stdout } = await execute(input.executable, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File",
      input.scriptPath, "-RuntimeVersion", input.runtimeVersion, "-OwnerThreadId", input.ownerThreadId, "-Apply"],
    // Includes bounded read-only CI qualification before the existing idle
    // drain/start protocol. It changes no learning-job clock or read budget.
    { encoding: "utf8", timeout: 36 * 60_000, maxBuffer: 128 * 1024, windowsHide: true }));
  } catch (error) {
    // execFile rejects for nonzero exits but carries the updater's JSON stdout.
    // Reading only that bounded closed projection preserves the original cause.
    throw new CourseSupportRuntimeUpdateFailure(record(error)?.stdout);
  }
  const value = parse(stdout);
  if (!value || !["already_current", "runtime_updated"].includes(String(value.outcome)) || value.runtimeVersion !== input.runtimeVersion) {
    throw new CourseSupportRuntimeUpdateFailure(stdout);
  }
}
