import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertAutomationRequest } from "@/lib/api/automation-auth";
import { recordCourseProbe } from "@/lib/automation/db-service";

const probeSchema = z.object({
  searchId: z.string().min(1),
  courseId: z.string().min(1),
  outcome: z.enum([
    "MATCH_FOUND",
    "NO_MATCH",
    "BLOCKED_POLICY",
    "BLOCKED_AUTH",
    "BLOCKED_TOOLING",
    "FETCH_FAILED",
    "NEEDS_ADAPTER"
  ]),
  message: z.string().optional(),
  evidenceUrl: z.string().url().optional(),
  rawSummary: z.unknown().optional(),
  automationRunId: z.string().optional()
});

export async function POST(request: NextRequest) {
  const authError = assertAutomationRequest(request);
  if (authError) {
    return authError;
  }

  const input = probeSchema.parse(await request.json());
  const probe = await recordCourseProbe({
    ...input,
    rawSummary: input.rawSummary as Prisma.InputJsonValue | undefined
  });
  return NextResponse.json({ probe }, { status: 201 });
}
