import { start } from "workflow/api";

export async function launchSearchScheduleWorkflow(
  searchId: string,
  scheduleVersion: number
) {
  // Keep workflow identity resolution behind this launcher so scheduling consumers
  // never import the workflow that owns them during module initialization.
  const { searchScheduleWorkflow } = await import("@/workflows/search-schedule");
  const run = await start(searchScheduleWorkflow, [searchId, scheduleVersion], {
    deploymentId: "latest"
  });
  return { runId: run.runId };
}
