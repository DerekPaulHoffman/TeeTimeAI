import {
  queueSearchCheck,
  type QueuedSearchCheck,
  type SearchScheduleExpectedState,
  type SearchScheduleNotEligible
} from "@/lib/automation/db-service";

type OperatorSearchScheduleDependencies = {
  queueSearch: (
    searchId: string,
    expectedState: SearchScheduleExpectedState
  ) => Promise<QueuedSearchCheck | SearchScheduleNotEligible>;
};

export type OperatorSearchScheduleOutcome =
  | "queued_for_recovery"
  | "not_eligible";

export type OperatorSearchScheduleResult = {
  outcome: OperatorSearchScheduleOutcome;
  scheduleVersion: number | null;
};

const defaultDependencies: OperatorSearchScheduleDependencies = {
  queueSearch: (searchId, expectedState) =>
    queueSearchCheck(searchId, undefined, expectedState)
};

export async function queueOperatorSearchScheduleRecovery(
  searchId: string,
  expectedState: SearchScheduleExpectedState,
  dependencies: OperatorSearchScheduleDependencies = defaultDependencies
): Promise<OperatorSearchScheduleResult> {
  const queued = await dependencies.queueSearch(searchId, expectedState);
  if ("outcome" in queued || queued.status !== "ACTIVE") {
    return { outcome: "not_eligible", scheduleVersion: null };
  }

  // The guarded write leaves a durable QUEUED row for deployed recovery;
  // local automation must not call Workflow or publish a dev queue.
  return {
    outcome: "queued_for_recovery",
    scheduleVersion: queued.scheduleVersion
  };
}
