import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertAutomationRequest } from "@/lib/api/automation-auth";
import { markMatchAlertSent } from "@/lib/automation/db-service";
import { hasDatabaseConfig } from "@/lib/env";

const sentAlertSchema = z.object({
  availabilityCycle: z.number().int().min(0)
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const authError = assertAutomationRequest(request);
  if (authError) {
    return authError;
  }

  if (!hasDatabaseConfig()) {
    return NextResponse.json(
      { error: "Alert status updates are temporarily unavailable." },
      { status: 503 }
    );
  }

  const { id } = await context.params;
  const parsed = sentAlertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A valid availability cycle is required." },
      { status: 400 }
    );
  }

  const match = await markMatchAlertSent({
    matchId: id,
    availabilityCycle: parsed.data.availabilityCycle
  });
  if (!match) {
    return NextResponse.json(
      { error: "The alert is no longer pending for that availability cycle." },
      { status: 409 }
    );
  }
  return NextResponse.json({ match });
}
