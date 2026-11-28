import { recoverDueCourseSupportVerificationRequests } from "@/lib/automation/course-support-verification-scheduler";
import { expireOverdueDiscoveryJobs } from "@/lib/course-discovery/service";
import { hasDatabaseConfig } from "@/lib/env";

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

  const [verification, discovery] = await Promise.allSettled([
    recoverDueCourseSupportVerificationRequests(),
    expireOverdueDiscoveryJobs(),
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
  return Response.json({ ...verification.value, discoveryDeadlines }, {
    status: verification.value.failed > 0 || discovery.status === "rejected" ? 503 : 200,
  });
}
