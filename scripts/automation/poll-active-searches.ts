import "./load-local-env";

import { listActiveSearchesForAutomation } from "@/lib/automation/db-service";
import { runSearchCheck } from "@/lib/automation/search-check";

async function main() {
  const searches = await listActiveSearchesForAutomation();
  const results = [];

  for (const search of searches) {
    results.push(await runSearchCheck(search.id, "manual-recovery"));
  }

  console.log(
    JSON.stringify(
      {
        processed: results.length,
        searches: results.map((result) => ({
          searchId: result.searchId,
          outcome: result.outcome,
          availableMatches: result.availableMatches,
          newlyAlertedMatches: result.newlyAlertedMatches
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
