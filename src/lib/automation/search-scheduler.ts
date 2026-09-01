import { start } from "workflow/api";

import {
  attachSearchWorkflowRun,
  getSearchCheckRequestState,
  queueSearchCheck,
  type QueuedSearchCheck,
  type SearchScheduleExpectedState,
  type SearchScheduleNotEligible
} from "@/lib/automation/db-service";
import { searchScheduleWorkflow } from "@/workflows/search-schedule";
import {
  buildSearchScheduleReference,
  startSearchScheduleWorkflowWithReservation
} from "@/lib/automation/search-recheck-queue";

const MANUAL_CHECK_COOLDOWN_MS = 60_000;

export type StartedSearchSchedule = {
  runId: string;
  scheduleVersion: number | null;
  reused: boolean;
};

type StartSearchScheduleOptions = {
  reuseIfRecent?: boolean;
  expectedState?: never;
};

type GuardedStartSearchScheduleOptions = {
  reuseIfRecent?: false;
  expectedState: SearchScheduleExpectedState;
};

function isSearchScheduleNotEligible(
  result: QueuedSearchCheck | SearchScheduleNotEligible | null
): result is SearchScheduleNotEligible {
  return result !== null && "outcome" in result && result.outcome === "not_eligible";
}

export function startSearchSchedule(
  searchId: string,
  options?: StartSearchScheduleOptions
): Promise<StartedSearchSchedule>;
export function startSearchSchedule(
  searchId: string,
  options: GuardedStartSearchScheduleOptions
): Promise<StartedSearchSchedule | SearchScheduleNotEligible>;

export async function startSearchSchedule(
  searchId: string,
  options: {
    reuseIfRecent?: boolean;
    expectedState?: SearchScheduleExpectedState;
  } = {}
): Promise<StartedSearchSchedule | SearchScheduleNotEligible> {
  if (options.reuseIfRecent && options.expectedState) {
    throw new Error("Expected-state guards cannot reuse a recent search schedule.");
  }
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

  const queued = options.expectedState
    ? await queueSearchCheck(searchId, undefined, options.expectedState)
    : await queueSearchCheck(searchId);
  if (isSearchScheduleNotEligible(queued)) {
    return queued;
  }
  if (!queued || queued.status !== "ACTIVE") {
    if (options.expectedState) {
      return {
        outcome: "not_eligible",
        reason: "state_changed"
      };
    }
    throw new Error("Only active searches can be checked");
  }

  try {
    const started = await startSearchScheduleWorkflowWithReservation(
      {
        searchId,
        scheduleVersion: queued.scheduleVersion,
        expectedWorkflowRunId: queued.workflowRunId,
      },
      {
        startWorkflow: async (nextSearchId, nextScheduleVersion) => {
          const run = await start(
            searchScheduleWorkflow,
            [nextSearchId, nextScheduleVersion],
            { deploymentId: "latest" },
          );
          return { runId: run.runId };
        },
        attachWorkflowRun: attachSearchWorkflowRun,
      },
    );
    if (started.outcome !== "started") {
      if (!options.expectedState) {
        throw new Error(
          "The search schedule changed before its Workflow start could be attached.",
        );
      }
      return {
        outcome: "not_eligible",
        reason: "state_changed"
      };
    }

    return {
      runId: started.runId,
      scheduleVersion: queued.scheduleVersion,
      reused: false
    };
  } catch (error) {
    console.error("[search-schedule:start-uncertain]", {
      searchRef: buildSearchScheduleReference(searchId),
      scheduleVersion: queued.scheduleVersion,
      message:
        "Workflow start outcome is uncertain; generation-fenced deployed recovery remains pending",
    });
    throw error;
  }
}
