import { listSearchesNeedingScheduleRecovery } from "@/lib/automation/db-service";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { recoverDueCourseSupportVerificationRequests } from "@/lib/automation/course-support-verification-scheduler";
import { checkAutomationWorkerHealth } from "@/lib/automation/worker-state";
import { hasDatabaseConfig } from "@/lib/env";
import { recoverPendingClerkEmailUpdates } from "@/lib/users/pending-email";

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

  const pendingEmailRecovery = await recoverPendingClerkEmailUpdates();
  const searches = await listSearchesNeedingScheduleRecovery();
  const results = await Promise.allSettled(
    searches.map((search) => startSearchSchedule(search.id))
  );

  let courseSupportVerification = {
    considered: 0,
    started: 0,
    skipped: 0,
    failed: 1
  };
  try {
    courseSupportVerification =
      await recoverDueCourseSupportVerificationRequests();
  } catch {
    // Provider-verification recovery must not suppress customer schedule recovery.
  }

  let automationWorkerHealth = {
    considered: 0,
    overdue: 0,
    notified: 0,
    recovered: 0,
    failed: 0
  };
  try {
    automationWorkerHealth = {
      ...(await checkAutomationWorkerHealth()),
      failed: 0
    };
  } catch {
    // Engineering-worker health must never suppress customer recovery.
    automationWorkerHealth.failed = 1;
  }

  return Response.json({
    pendingEmailRecovery,
    courseSupportVerification,
    automationWorkerHealth,
    considered: searches.length,
    restarted: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length
  });
}
