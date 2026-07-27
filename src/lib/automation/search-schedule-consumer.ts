import {
  attachSearchWorkflowRun,
  getSearchScheduleState
} from "@/lib/automation/db-service";
import { launchSearchScheduleWorkflow } from "@/lib/automation/search-schedule-launcher";
import {
  consumeSearchScheduleMessage,
  type SearchScheduleQueueDependencies
} from "@/lib/automation/search-recheck-queue";
const dependencies: SearchScheduleQueueDependencies = {
  getScheduleState: getSearchScheduleState,
  startWorkflow: launchSearchScheduleWorkflow,
  attachWorkflowRun: attachSearchWorkflowRun
};

export function consumeSearchScheduleQueueMessage(input: unknown) {
  return consumeSearchScheduleMessage(input, dependencies);
}
