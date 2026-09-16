import { NextRequest, NextResponse } from "next/server";

import { consumeSearchScheduleQueueMessage } from "@/lib/automation/search-schedule-consumer";
import { hasDatabaseConfig } from "@/lib/env";
import { assertLocalReaderRequest } from "@/lib/local-reader/auth";
import { localReaderResultSchema } from "@/lib/local-reader/contracts";
import { officialSourceResultSchema } from "@/lib/local-reader/official-source-contracts";
import { completeLocalReaderJob } from "@/lib/local-reader/service";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const receivedAt = new Date();
  const body = await request.text();
  const authError = assertLocalReaderRequest(request, body);
  if (authError) return authError;
  if (!hasDatabaseConfig()) {
    return NextResponse.json({ error: "Local reader jobs are unavailable." }, { status: 503 });
  }
  const { id } = await context.params;
  const result = localReaderResultSchema.or(officialSourceResultSchema).parse(JSON.parse(body));
  if (result.jobId !== id) {
    return NextResponse.json({ error: "Job mismatch" }, { status: 409 });
  }
  const leaseToken = request.headers.get("x-local-reader-lease") || "";
  const deviceRequestAt = new Date(
    Number(request.headers.get("x-local-reader-timestamp"))
  );
  try {
    const completed = await completeLocalReaderJob({
      jobId: id,
      leaseToken,
      result,
      receivedAt,
      deviceRequestAt
    });
    if (completed.searchId && completed.resumeScheduleVersion !== null) {
      try {
        // Completion already queued and generation-fenced this search. Use the
        // deployed recovery consumer to start that exact generation immediately;
        // starting a new schedule would invalidate the saved reader proof.
        await consumeSearchScheduleQueueMessage({
          searchId: completed.searchId,
          scheduleVersion: completed.resumeScheduleVersion,
          trigger: "START_FAILED"
        });
      } catch {
        // The result and QUEUED row are durable. A failed or uncertain start
        // must retain its reservation for recovery, not reject the reader result.
        console.warn("[local-reader:resume-pending] Deployed recovery will resume the completed result.");
      }
    }
    return NextResponse.json({
      status: "COMPLETED",
      completedAt: completed.completedAt.toISOString()
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not complete job" },
      { status: 409 }
    );
  }
}
