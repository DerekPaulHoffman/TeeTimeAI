import { sleep } from "workflow";
import { start } from "workflow/api";

import {
  attachSearchWorkflowRun,
  getSearchScheduleState
} from "@/lib/automation/db-service";
import { executeScheduledSearchCheck } from "@/lib/automation/search-schedule-execution";

type SearchScheduleWorkflowResult = Awaited<ReturnType<typeof executeScheduledSearchCheck>> & {
  nextRunId?: string | null;
};

export async function searchScheduleWorkflow(
  searchId: string,
  scheduleVersion: number
): Promise<SearchScheduleWorkflowResult> {
  "use workflow";

  console.log(
    `[searchScheduleWorkflow] START searchId=${searchId} scheduleVersion=${scheduleVersion}`
  );
  const result = await executeSearchCheckStep(searchId, scheduleVersion);
  if (!result.nextCheckAt) {
    console.log(
      `[searchScheduleWorkflow] DONE searchId=${searchId} scheduleVersion=${scheduleVersion} outcome=${result.outcome}`
    );
    return result;
  }

  await sleep(new Date(result.nextCheckAt));
  const nextRunId: string | null = await startNextSearchCheckStep(searchId, scheduleVersion);
  console.log(
    `[searchScheduleWorkflow] RESCHEDULED searchId=${searchId} scheduleVersion=${scheduleVersion} nextRunId=${nextRunId ?? "stopped"}`
  );
  return { ...result, nextRunId };
}

async function executeSearchCheckStep(searchId: string, scheduleVersion: number) {
  "use step";

  console.log(
    `[executeSearchCheckStep] START searchId=${searchId} scheduleVersion=${scheduleVersion}`
  );
  const result = await executeScheduledSearchCheck(searchId, scheduleVersion);
  console.log(
    `[executeSearchCheckStep] DONE searchId=${searchId} scheduleVersion=${scheduleVersion} outcome=${result.outcome}`
  );
  return result;
}

async function startNextSearchCheckStep(
  searchId: string,
  scheduleVersion: number
): Promise<string | null> {
  "use step";

  console.log(
    `[startNextSearchCheckStep] START searchId=${searchId} scheduleVersion=${scheduleVersion}`
  );
  const state = await getSearchScheduleState(searchId, scheduleVersion);
  if (!state) {
    console.log(
      `[startNextSearchCheckStep] STOPPED searchId=${searchId} scheduleVersion=${scheduleVersion}`
    );
    return null;
  }

  const run: { runId: string } = await start(searchScheduleWorkflow, [searchId, scheduleVersion], {
    deploymentId: "latest"
  });
  await attachSearchWorkflowRun(searchId, scheduleVersion, run.runId);
  console.log(
    `[startNextSearchCheckStep] DONE searchId=${searchId} scheduleVersion=${scheduleVersion} runId=${run.runId}`
  );
  return run.runId;
}
