import { NextRequest, NextResponse } from "next/server";

export function assertAutomationRequest(request: NextRequest) {
  const expected = process.env.AUTOMATION_API_KEY;
  if (!expected) {
    return NextResponse.json(
      { error: "AUTOMATION_API_KEY is not configured" },
      { status: 503 }
    );
  }

  const actual = request.headers.get("x-automation-key");
  if (actual !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
