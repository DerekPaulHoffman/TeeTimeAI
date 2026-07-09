import { start } from "workflow/api";

import {
  attachSearchWorkflowRun,
  failScheduledSearchCheck,
  getSearchCheckRequestState,
  queueSearchCheck
} from "@/lib/automation/db-service";
import { searchScheduleWorkflow } from "@/workflows/search-schedule";

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
  if (queued.status !== "ACTIVE") {
    throw new Error("Only active searches can be checked");
  }

  try {
    const run = await start(searchScheduleWorkflow, [searchId, queued.scheduleVersion], {
      deploymentId: "latest"
    });
    await attachSearchWorkflowRun(searchId, queued.scheduleVersion, run.runId);

    return {
      runId: run.runId,
      scheduleVersion: queued.scheduleVersion,
      reused: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start search workflow";
    await failScheduledSearchCheck({
      searchId,
      scheduleVersion: queued.scheduleVersion,
      message,
      nextCheckAt: new Date(Date.now() + 5 * 60 * 1000)
    });
    throw error;
  }
}
