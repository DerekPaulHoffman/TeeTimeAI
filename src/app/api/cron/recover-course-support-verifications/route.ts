import { recoverDueCourseSupportVerificationRequests } from "@/lib/automation/course-support-verification-scheduler";
import { expireOverdueDiscoveryJobs } from "@/lib/course-discovery/service";
import { hasDatabaseConfig } from "@/lib/env";
import { recoverDueCourseSetupReceipts } from "@/lib/searches/course-setup-receipts";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!hasDatabaseConfig()) {
    return Response.json(
      {
        error:
          "Course-support verification recovery is temporarily unavailable.",
      },
      { status: 503 },
    );
  }

  const [verification, discovery, setup] = await Promise.allSettled([
    recoverDueCourseSupportVerificationRequests(),
    expireOverdueDiscoveryJobs(),
    recoverDueCourseSetupReceipts(),
  ]);
  if (verification.status === "rejected") {
    return Response.json(
      {
        error:
          "Course-support verification recovery is temporarily unavailable.",
      },
      { status: 503 },
    );
  }

  const discoveryDeadlines = discovery.status === "fulfilled" ? discovery.value : { failed: true };
  const setupDeadlines = setup.status === "fulfilled" ? setup.value : { failed: true };
  return Response.json({ ...verification.value, discoveryDeadlines, setupDeadlines }, {
    status: verification.value.failed > 0 || discovery.status === "rejected" || setup.status === "rejected" ? 503 : 200,
  });
}
