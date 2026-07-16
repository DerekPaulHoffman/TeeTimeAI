import { start } from "workflow/api";

import {
  attachSearchWorkflowRun,
  failScheduledSearchCheck,
  getSearchCheckRequestState,
  queueSearchCheck
} from "@/lib/automation/db-service";
import { searchScheduleWorkflow } from "@/workflows/search-schedule";
import {
  buildSearchScheduleReference,
  recoverSearchScheduleStartFailure
} from "@/lib/automation/search-recheck-queue";

const MANUAL_CHECK_COOLDOWN_MS = 60_000;

export async function startSearchSchedule(
  searchId: string,
  options: { reuseIfRecent?: boolean } = {}
) {
  if (options.reuseIfRecent) {
    const existing = await getSearchCheckRequestState(searchId);
    if (!existing) {
      throw new Error("Search not found");
    }
    if (existing.status !== "ACTIVE") {
      throw new Error("Only active searches can be checked");
    }
    const recentlyChecked =
      existing.lastCheckedAt &&
      Date.now() - existing.lastCheckedAt.getTime() < MANUAL_CHECK_COOLDOWN_MS;
    if (
      existing.workflowRunId &&
      (existing.checkStatus === "QUEUED" || existing.checkStatus === "CHECKING" || recentlyChecked)
    ) {
      return {
        runId: existing.workflowRunId,
        scheduleVersion: null,
        reused: true
      };
    }
  }

  const queued = await queueSearchCheck(searchId);
  if (!queued || queued.status !== "ACTIVE") {
    throw new Error("Only active searches can be checked");
  }

  try {
    const run = await start(searchScheduleWorkflow, [searchId, queued.scheduleVersion], {
      deploymentId: "latest"
    });
    await attachSearchWorkflowRun(
      searchId,
      queued.scheduleVersion,
      run.runId,
      queued.workflowRunId
    );

    return {
      runId: run.runId,
      scheduleVersion: queued.scheduleVersion,
      reused: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start search workflow";
    const failed = await failScheduledSearchCheck({
      searchId,
      scheduleVersion: queued.scheduleVersion,
      message,
      nextCheckAt: new Date(Date.now() + 5 * 60 * 1000),
      expectedWorkflowRunId: queued.workflowRunId
    });
    if (failed.count === 1) {
      const recovery = await recoverSearchScheduleStartFailure({
        searchId,
        scheduleVersion: queued.scheduleVersion,
        trigger: "START_FAILED"
      });
      if (recovery.outcome === "failed") {
        console.error("[search-schedule:queue-fallback-failed]", {
          searchRef: buildSearchScheduleReference(searchId),
          scheduleVersion: queued.scheduleVersion,
          message: "Could not enqueue or directly restart workflow recovery"
        });
      }
    }
    throw error;
  }
}
