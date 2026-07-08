import { NextRequest, NextResponse } from "next/server";

import { assertAutomationRequest } from "@/lib/api/automation-auth";
import { listActiveSearchesForAutomation } from "@/lib/automation/db-service";

export async function GET(request: NextRequest) {
  const authError = assertAutomationRequest(request);
  if (authError) {
    return authError;
  }

  const searches = await listActiveSearchesForAutomation();
  return NextResponse.json({ searches });
}
