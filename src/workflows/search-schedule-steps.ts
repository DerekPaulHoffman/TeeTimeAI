import { start } from "workflow/api";

import {
  attachSearchWorkflowRun,
  failScheduledSearchCheck,
  getSearchScheduleState
} from "@/lib/automation/db-service";
import {
  buildSearchScheduleReference,
  recoverSearchScheduleStartFailure
} from "@/lib/automation/search-recheck-queue";
import { executeScheduledSearchCheck } from "@/lib/automation/search-schedule-execution";

import { searchScheduleWorkflow } from "./search-schedule";

export async function executeSearchCheckStep(
  searchId: string,
  scheduleVersion: number
) {
  "use step";

  const searchRef = buildSearchScheduleReference(searchId);
  console.log(
    `[executeSearchCheckStep] START searchRef=${searchRef} scheduleVersion=${scheduleVersion}`
  );
  const result = await executeScheduledSearchCheck(searchId, scheduleVersion);
  console.log(
    `[executeSearchCheckStep] DONE searchRef=${searchRef} scheduleVersion=${scheduleVersion} outcome=${result.outcome}`
  );
  return result;
}

export async function startNextSearchCheckStep(
  searchId: string,
  scheduleVersion: number
): Promise<string | null> {
  "use step";

  const searchRef = buildSearchScheduleReference(searchId);
  console.log(
    `[startNextSearchCheckStep] START searchRef=${searchRef} scheduleVersion=${scheduleVersion}`
  );
  const state = await getSearchScheduleState(searchId, scheduleVersion);
  if (!state) {
    console.log(
      `[startNextSearchCheckStep] STOPPED searchRef=${searchRef} scheduleVersion=${scheduleVersion}`
    );
    return null;
  }

  try {
    const run: { runId: string } = await start(
      searchScheduleWorkflow,
      [searchId, scheduleVersion],
      { deploymentId: "latest" }
    );
    await attachSearchWorkflowRun(
      searchId,
      scheduleVersion,
      run.runId,
      state.workflowRunId
    );
    console.log(
      `[startNextSearchCheckStep] DONE searchRef=${searchRef} scheduleVersion=${scheduleVersion}`
    );
    return run.runId;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not start successor search workflow";
    const failed = await failScheduledSearchCheck({
      searchId,
      scheduleVersion,
      message,
      nextCheckAt: new Date(Date.now() + 5 * 60 * 1000),
      expectedWorkflowRunId: state.workflowRunId
    });
    if (failed.count !== 1) {
      return null;
    }
    const recovery = await recoverSearchScheduleStartFailure({
      searchId,
      scheduleVersion,
      trigger: "START_FAILED"
    });
    if (recovery.outcome === "failed") {
      console.error("[startNextSearchCheckStep] QUEUE_FALLBACK_FAILED", {
        searchRef,
        scheduleVersion,
        message: "Could not enqueue or directly restart successor recovery"
      });
    }
    return null;
  }
}
