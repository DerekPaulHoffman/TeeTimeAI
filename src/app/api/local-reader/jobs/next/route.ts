import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { hasDatabaseConfig } from "@/lib/env";
import { assertLocalReaderRequest } from "@/lib/local-reader/auth";
import { claimNextLocalReaderJob } from "@/lib/local-reader/service";

const querySchema = z.object({
  deviceId: z.string().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/u)
});

export async function GET(request: NextRequest) {
  const authError = assertLocalReaderRequest(request);
  if (authError) return authError;
  if (!hasDatabaseConfig()) {
    return NextResponse.json({ error: "Local reader jobs are unavailable." }, { status: 503 });
  }
  const query = querySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries())
  );
  const job = await claimNextLocalReaderJob(query.deviceId);
  return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
}
