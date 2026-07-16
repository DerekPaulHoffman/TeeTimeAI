import "./load-local-env";

import { listActiveSearchesForAutomation } from "@/lib/automation/db-service";
import { buildSearchScheduleReference } from "@/lib/automation/search-recheck-queue";
import { queueOperatorSearchScheduleRecovery } from "@/lib/automation/search-schedule-operator";

async function main() {
  const searches = await listActiveSearchesForAutomation();
  const results = [];
  const observedAt = new Date();

  for (const search of searches) {
    const hasLiveLease = Boolean(
      search.checkLeaseExpiresAt && search.checkLeaseExpiresAt > observedAt
    );
    if (search.checkStatus !== "WAITING" || hasLiveLease) {
      results.push({
        searchRef: buildSearchScheduleReference(search.id),
        outcome: "not_eligible",
        scheduleVersion: null
      });
      continue;
    }

    const schedule = await queueOperatorSearchScheduleRecovery(search.id, {
      scheduleVersion: search.scheduleVersion,
      updatedAt: search.updatedAt,
      observedAt
    });
    results.push({
      searchRef: buildSearchScheduleReference(search.id),
      outcome: schedule.outcome,
      scheduleVersion: schedule.scheduleVersion
    });
  }

  console.log(
    JSON.stringify(
      {
        processed: results.length,
        searches: results.map((result) => ({
          searchRef: result.searchRef,
          outcome: result.outcome,
          scheduleVersion: result.scheduleVersion
        }))
      },
      null,
      2
    )
  );
}

main().catch(() => {
  console.error("Automation poll could not persist schedule recovery.");
  process.exitCode = 1;
});
