import { NextRequest, NextResponse } from "next/server";

import { assertAutomationRequest } from "@/lib/api/automation-auth";
import { listActiveSearchesForAutomation } from "@/lib/automation/db-service";
import { hasDatabaseConfig } from "@/lib/env";

export async function GET(request: NextRequest) {
  const authError = assertAutomationRequest(request);
  if (authError) {
    return authError;
  }

  if (!hasDatabaseConfig()) {
    return NextResponse.json(
      { error: "Automation searches are temporarily unavailable." },
      { status: 503 }
    );
  }

  const searches = await listActiveSearchesForAutomation();
  return NextResponse.json({ searches });
}
