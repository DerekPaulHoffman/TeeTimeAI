import { sleep } from "workflow";

import {
  executeSearchCheckStep,
  startNextSearchCheckStep
} from "./search-schedule-steps";

type SearchScheduleWorkflowResult = Awaited<ReturnType<typeof executeSearchCheckStep>> & {
  nextRunId?: string | null;
};

export async function searchScheduleWorkflow(
  searchId: string,
  scheduleVersion: number
): Promise<SearchScheduleWorkflowResult> {
  "use workflow";

  console.log(`[searchScheduleWorkflow] START scheduleVersion=${scheduleVersion}`);
  const result = await executeSearchCheckStep(searchId, scheduleVersion);
  if (!result.nextCheckAt) {
    console.log(
      `[searchScheduleWorkflow] DONE scheduleVersion=${scheduleVersion} outcome=${result.outcome}`
    );
    return result;
  }

  await sleep(new Date(result.nextCheckAt));
  const nextRunId: string | null = await startNextSearchCheckStep(searchId, scheduleVersion);
  console.log(
    `[searchScheduleWorkflow] RESCHEDULED scheduleVersion=${scheduleVersion} successor=${nextRunId ? "started" : "stopped"}`
  );
  return { ...result, nextRunId };
}
