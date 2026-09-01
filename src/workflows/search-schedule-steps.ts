import { getWorkflowMetadata } from "workflow";

import {
  attachSearchWorkflowRun,
  getSearchScheduleState
} from "@/lib/automation/db-service";
import {
  buildSearchScheduleReference,
  startSearchScheduleWorkflowWithReservation
} from "@/lib/automation/search-recheck-queue";
import { executeScheduledSearchCheck } from "@/lib/automation/search-schedule-execution";
import { launchSearchScheduleWorkflow } from "@/lib/automation/search-schedule-launcher";

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
  const parentWorkflowRunId = getWorkflowMetadata().workflowRunId;
  const state = await getSearchScheduleState(searchId, scheduleVersion);
  if (
    !state ||
    !parentWorkflowRunId ||
    state.workflowRunId !== parentWorkflowRunId
  ) {
    console.log(
      `[startNextSearchCheckStep] STOPPED searchRef=${searchRef} scheduleVersion=${scheduleVersion}`
    );
    return null;
  }

  try {
    const started = await startSearchScheduleWorkflowWithReservation(
      {
        searchId,
        scheduleVersion,
        expectedWorkflowRunId: parentWorkflowRunId,
      },
      {
        startWorkflow: launchSearchScheduleWorkflow,
        attachWorkflowRun: attachSearchWorkflowRun,
      },
    );
    if (started.outcome !== "started") {
      console.log(
        `[startNextSearchCheckStep] STOPPED searchRef=${searchRef} scheduleVersion=${scheduleVersion} reason=${started.outcome}`,
      );
      return null;
    }
    console.log(
      `[startNextSearchCheckStep] DONE searchRef=${searchRef} scheduleVersion=${scheduleVersion}`
    );
    return started.runId;
  } catch {
    console.error("[startNextSearchCheckStep] START_UNCERTAIN", {
      searchRef,
      scheduleVersion,
      message:
        "Successor Workflow start outcome is uncertain; generation-fenced deployed recovery remains pending",
    });
    return null;
  }
}
