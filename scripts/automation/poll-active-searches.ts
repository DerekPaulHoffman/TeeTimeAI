import "./load-local-env";

import { listActiveSearchesForAutomation } from "@/lib/automation/db-service";
import { buildSearchScheduleReference } from "@/lib/automation/search-recheck-queue";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";

async function main() {
  const searches = await listActiveSearchesForAutomation();
  const results = [];

  for (const search of searches) {
    try {
      const schedule = await startSearchSchedule(search.id);
      results.push({ searchRef: buildSearchScheduleReference(search.id), outcome: "queued", schedule });
    } catch {
      results.push({
        searchRef: buildSearchScheduleReference(search.id),
        outcome: "start_failed",
        schedule: null
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        processed: results.length,
        searches: results.map((result) => ({
          searchRef: result.searchRef,
          outcome: result.outcome,
          scheduleVersion: result.schedule?.scheduleVersion ?? null
        }))
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
