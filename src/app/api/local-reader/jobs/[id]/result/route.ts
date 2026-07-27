import { NextRequest, NextResponse } from "next/server";

import { hasDatabaseConfig } from "@/lib/env";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { assertLocalReaderRequest } from "@/lib/local-reader/auth";
import { localReaderResultSchema } from "@/lib/local-reader/contracts";
import { completeLocalReaderJob } from "@/lib/local-reader/service";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const body = await request.text();
  const authError = assertLocalReaderRequest(request, body);
  if (authError) return authError;
  if (!hasDatabaseConfig()) {
    return NextResponse.json({ error: "Local reader jobs are unavailable." }, { status: 503 });
  }
  const { id } = await context.params;
  const result = localReaderResultSchema.parse(JSON.parse(body));
  if (result.jobId !== id) {
    return NextResponse.json({ error: "Job mismatch" }, { status: 409 });
  }
  const leaseToken = request.headers.get("x-local-reader-lease") || "";
  try {
    const completed = await completeLocalReaderJob({
      jobId: id,
      leaseToken,
      result
    });
    if (completed.searchId) {
      try {
        await startSearchSchedule(completed.searchId);
      } catch (error) {
        console.error("[local-reader:search-schedule-start-failed]", {
          message:
            error instanceof Error ? error.message : "Unknown scheduling error"
        });
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
