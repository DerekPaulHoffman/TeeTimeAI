import { listSearchesNeedingScheduleRecovery } from "@/lib/automation/db-service";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { consumeSearchScheduleQueueMessage } from "@/lib/automation/search-schedule-consumer";
import { checkAutomationWorkerHealth } from "@/lib/automation/worker-state";
import {
  revalidateHumanReviewCoursesForDeployment,
  runCourseMonitoringWatchdog
} from "@/lib/automation/course-monitoring";
import { hasDatabaseConfig } from "@/lib/env";
import { expireOverdueLocalReaderJobs } from "@/lib/local-reader/service";
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

  let courseMonitoring = {
    checked: 0,
    scheduled: 0,
    escalated: 0,
    remindersSent: 0,
    failed: 0
  };
  let deploymentCourseRevalidation = {
    considered: 0,
    requeued: 0,
    retainedAuthoritativeFinals: 0,
    failed: 0
  };
  try {
    deploymentCourseRevalidation = {
      ...(await revalidateHumanReviewCoursesForDeployment({
        deploymentSha: process.env.VERCEL_GIT_COMMIT_SHA
      })),
      failed: 0
    };
  } catch {
    // Deployment-triggered course revalidation must not suppress other recovery paths.
    deploymentCourseRevalidation.failed = 1;
  }
  try {
    courseMonitoring = {
      ...(await runCourseMonitoringWatchdog()),
      failed: 0
    };
  } catch {
    // Course-lifecycle recovery must never suppress customer or delivery recovery.
    courseMonitoring.failed = 1;
  }

  // Reconcile course deadlines before selecting due searches. A search waking
  // at the thirty-minute boundary must see the human-review customer state,
  // not race ahead with an obsolete automatic-retry notice.
  const recoveryObservedAt = new Date();
  const searches = await listSearchesNeedingScheduleRecovery(
    recoveryObservedAt
  );
  const results = await Promise.allSettled(
    searches.map((search) => {
      if (
        search.checkStatus === "QUEUED" &&
        search.workflowRunId === null
      ) {
        return consumeSearchScheduleQueueMessage({
          searchId: search.id,
          scheduleVersion: search.scheduleVersion,
          trigger: "START_FAILED"
        });
      }
      if (
        search.checkStatus === "WAITING" ||
        search.checkStatus === "QUEUED"
      ) {
        return startSearchSchedule(search.id, {
          expectedState: {
            scheduleVersion: search.scheduleVersion,
            updatedAt: search.updatedAt,
            observedAt: recoveryObservedAt,
            checkStatus: search.checkStatus,
            workflowRunId: search.workflowRunId,
            ...("endpointRecoveryDispatchKey" in search &&
            search.endpointRecoveryDispatchKey
              ? {
                  recoveryDispatchKey:
                    search.endpointRecoveryDispatchKey
                }
              : {})
          }
        });
      }
      return startSearchSchedule(search.id);
    })
  );

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

  let localReaderJobDeadlines = {
    considered: 0,
    expired: 0,
    notified: 0,
    failed: 0
  };
  try {
    localReaderJobDeadlines = {
      ...(await expireOverdueLocalReaderJobs()),
      failed: 0
    };
  } catch {
    // One reader deadline sweep must never suppress any other recovery path.
    localReaderJobDeadlines.failed = 1;
  }

  return Response.json({
    pendingEmailRecovery,
    automationWorkerHealth,
    localReaderJobDeadlines,
    deploymentCourseRevalidation,
    courseMonitoring,
    considered: searches.length,
    restarted: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length
  });
}
