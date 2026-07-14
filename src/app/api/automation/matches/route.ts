import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertAutomationRequest } from "@/lib/api/automation-auth";
import { recordTeeTimeMatch } from "@/lib/automation/db-service";
import { hasDatabaseConfig } from "@/lib/env";

const matchSchema = z.object({
  searchId: z.string().min(1),
  courseId: z.string().min(1),
  sourceId: z.string().min(1),
  startsAt: z.coerce.date(),
  availableSpots: z.number().int().min(1),
  bookingUrl: z.string().url(),
  priceCents: z.number().int().min(0).optional(),
  holes: z.number().int().min(1).optional(),
  evidenceUrl: z.string().url().optional()
});

export async function POST(request: NextRequest) {
  const authError = assertAutomationRequest(request);
  if (authError) {
    return authError;
  }

  if (!hasDatabaseConfig()) {
    return NextResponse.json(
      { error: "Automation match recording is temporarily unavailable." },
      { status: 503 }
    );
  }

  const match = await recordTeeTimeMatch(matchSchema.parse(await request.json()));
  return NextResponse.json({ match }, { status: 201 });
}
