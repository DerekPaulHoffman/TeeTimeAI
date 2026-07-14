import { NextRequest, NextResponse } from "next/server";

import { assertAutomationRequest } from "@/lib/api/automation-auth";
import { markMatchAlertSent } from "@/lib/automation/db-service";
import { hasDatabaseConfig } from "@/lib/env";

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
  const match = await markMatchAlertSent(id);
  return NextResponse.json({ match });
}
