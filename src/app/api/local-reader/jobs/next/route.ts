import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { hasDatabaseConfig } from "@/lib/env";
import { assertLocalReaderRequest } from "@/lib/local-reader/auth";
import { parseLocalReaderCapabilities } from "@/lib/local-reader/capabilities";
import { claimNextLocalReaderJob } from "@/lib/local-reader/service";

const querySchema = z.object({
  deviceId: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-zA-Z0-9._-]+$/u),
  readerVersion: z.string().min(1).max(64).optional(),
  buildId: z.string().min(1).max(100).optional(),
  capabilities: z.string().min(1).max(1000).optional()
});

export async function GET(request: NextRequest) {
  const authError = assertLocalReaderRequest(request);
  if (authError) return authError;
  if (!hasDatabaseConfig()) {
    return NextResponse.json({ error: "Local reader jobs are unavailable." }, { status: 503 });
  }
  const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  const job = await claimNextLocalReaderJob({
    deviceId: query.deviceId,
    readerVersion: query.readerVersion ?? "1.6.0",
    buildId: query.buildId ?? "legacy-1.6.0",
    capabilities: parseLocalReaderCapabilities(query.capabilities)
  });
  return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
}
