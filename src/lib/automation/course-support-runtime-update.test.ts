import { describe, expect, it, vi } from "vitest";
import { buildCourseSupportCommandFailure } from "../../../scripts/automation/course-support";
import { CourseSupportRuntimeUpdateFailure, prepareCourseSupportRuntime, projectRuntimeUpdateDiagnostic } from "./course-support-runtime-update";

const input = { executable: "powershell.exe", scriptPath: "fixture-updater.ps1", runtimeVersion: "a".repeat(40), ownerThreadId: "fixture-owner" };
const blocked = { schemaVersion: 1, outcome: "blocked", reasonCode: "ORIGINAL_NATIVE_OWNER_REQUIRED", phase: "VALIDATE_NATIVE_OWNER",
  apply: true, stateChanged: false, mutationAttempted: false, drainAttempted: false, taskStopAttempted: false,
  runtimeUpdateAttempted: false, taskStartAttempted: false, activationWriteAttempted: false, acceptanceRestartProof: false };

describe("safe managed runtime update diagnostics", () => {
  it("distinguishes missing managed source from a dependency or extension rollout", () => {
    const result = projectRuntimeUpdateDiagnostic(JSON.stringify({ ...blocked,
      reasonCode: "MANAGED_RUNTIME_CHECKOUT_MISSING", phase: "VALIDATE_MANAGED_CHECKOUT" }));
    expect(result).toMatchObject({ attributed: true, reasonCode: "MANAGED_RUNTIME_CHECKOUT_MISSING",
      phase: "VALIDATE_MANAGED_CHECKOUT", mutationAttempted: false, taskStopAttempted: false });
  });
  it("retains bounded stopped-start reconciliation evidence without guessing fields from older receipts", () => {
    expect(projectRuntimeUpdateDiagnostic(JSON.stringify({ ...blocked, phase: "RECONCILE_STOPPED_UPDATED_RUNTIME",
      taskStartRequests: 2, firstStoppedTaskResult: 1 }))).toMatchObject({ attributed: true, taskStartRequests: 2, firstStoppedTaskResult: 1 });
    for (const count of [undefined, -1, 3, true, "2"]) expect(projectRuntimeUpdateDiagnostic(JSON.stringify({ ...blocked,
      taskStartRequests: count, firstStoppedTaskResult: "private" }))).toMatchObject({ taskStartRequests: null, firstStoppedTaskResult: null });
  });
  it.each(["RUNTIME_CI_REQUIRED", "RUNTIME_CI_PENDING_TIMEOUT", "RUNTIME_CANONICAL_ALIASES_REQUIRED", "RUNTIME_RELEASE_PROOF_UNAVAILABLE"])("retains the closed %s release diagnostic without forwarding command output", reasonCode => {
    const result = projectRuntimeUpdateDiagnostic(JSON.stringify({ ...blocked, reasonCode, phase: "QUALIFY_RELEASE",
      rawOutput: "fixture-private" }));
    expect(result).toMatchObject({ attributed: true, reasonCode, phase: "QUALIFY_RELEASE", stateChanged: false, mutationAttempted: false });
    expect(JSON.stringify(result)).not.toContain("fixture-private");
  });
  it("retains the original closed failure projection from a nonzero child and through CLI reporting", async () => {
    const execute = vi.fn(async () => { throw Object.assign(Error("private exception"), {
      stdout: JSON.stringify({ ...blocked, privateField: "private stdout field" }), stderr: "secret-bearing stderr",
    }); });
    let failure: unknown;
    try { await prepareCourseSupportRuntime(input, execute); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CourseSupportRuntimeUpdateFailure);
    const result = buildCourseSupportCommandFailure(failure);
    expect(result).toMatchObject({ outcome: "command_failed", error: "LOCAL_RUNTIME_UPDATE_NOT_PROVED",
      runtimeUpdate: { attributed: true, reasonCode: blocked.reasonCode, phase: blocked.phase, mutationAttempted: false,
        stateChanged: false }, durableCloseoutRecorded: false });
    expect(JSON.stringify(result)).not.toMatch(/private|secret-bearing|stdout|stderr/u);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["already_current", "runtime_updated"])("requires exact runtime proof for %s", async outcome => {
    await expect(prepareCourseSupportRuntime(input, async () => ({ stdout: JSON.stringify({ outcome, runtimeVersion: input.runtimeVersion }) }))).resolves.toBeUndefined();
    await expect(prepareCourseSupportRuntime(input, async () => ({ stdout: JSON.stringify({ outcome, runtimeVersion: "b".repeat(40) }) }))).rejects.toThrow("LOCAL_RUNTIME_UPDATE_NOT_PROVED");
  });

  it("preserves attempted mutations even when a Git change was not proved", () => {
    const result = projectRuntimeUpdateDiagnostic(JSON.stringify({ ...blocked, phase: "STOP_MANAGED_TASK",
      reasonCode: "RUNTIME_PROOF_COMMAND_FAILED", mutationAttempted: true, drainAttempted: true, taskStopAttempted: true }));
    expect(result).toMatchObject({ attributed: true, stateChanged: false, mutationAttempted: true, taskStopAttempted: true });
  });

  it.each([undefined, "not json", "x".repeat(16_385), JSON.stringify({ ...blocked, phase: "PRIVATE_PATH" }),
    JSON.stringify({ ...blocked, reasonCode: "PRIVATE_SECRET" }), JSON.stringify({ ...blocked, taskStopAttempted: undefined }),
    JSON.stringify({ ...blocked, schemaVersion: undefined }), JSON.stringify({ ...blocked, acceptanceRestartProof: true })])(
    "never guesses side effects or leaks unrecognized output", stdout => {
      const result = projectRuntimeUpdateDiagnostic(stdout);
      expect(result).toMatchObject({ attributed: false, reasonCode: "UNATTRIBUTED_RUNTIME_UPDATE_FAILURE", phase: "UNKNOWN",
        stateChanged: null, mutationAttempted: null, taskStopAttempted: null });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PATH|PRIVATE_SECRET/u);
    });

  it("does not treat a nominally successful child with blocked output as runtime proof", async () => {
    await expect(prepareCourseSupportRuntime(input, async () => ({ stdout: JSON.stringify(blocked) })))
      .rejects.toMatchObject({ diagnostic: { attributed: true, phase: "VALIDATE_NATIVE_OWNER" } });
  });
});
