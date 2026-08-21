import { recoverDueCourseSupportVerificationRequests } from "@/lib/automation/course-support-verification-scheduler";
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

  try {
    const result = await recoverDueCourseSupportVerificationRequests();
    return Response.json(result, { status: result.failed > 0 ? 503 : 200 });
  } catch {
    return Response.json(
      {
        error:
          "Course-support verification recovery is temporarily unavailable.",
      },
      { status: 503 },
    );
  }
}
