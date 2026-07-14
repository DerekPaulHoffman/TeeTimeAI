import { listSearchesNeedingScheduleRecovery } from "@/lib/automation/db-service";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { hasDatabaseConfig } from "@/lib/env";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!hasDatabaseConfig()) {
    return Response.json(
      { error: "Search schedule recovery is temporarily unavailable." },
      { status: 503 }
    );
  }

  const searches = await listSearchesNeedingScheduleRecovery();
  const results = await Promise.allSettled(
    searches.map((search) => startSearchSchedule(search.id))
  );

  return Response.json({
    considered: searches.length,
    restarted: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length
  });
}
