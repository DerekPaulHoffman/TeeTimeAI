import { NextRequest, NextResponse } from "next/server";

import { assertAutomationRequest } from "@/lib/api/automation-auth";
import { markMatchAlertSent } from "@/lib/automation/db-service";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const authError = assertAutomationRequest(request);
  if (authError) {
    return authError;
  }

  const { id } = await context.params;
  const match = await markMatchAlertSent(id);
  return NextResponse.json({ match });
}
