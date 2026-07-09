import { NextRequest, NextResponse } from "next/server";

import { submitWebsiteFeedback } from "@/lib/engagement/engagement";
import { hasDatabaseConfig } from "@/lib/env";

export async function POST(request: NextRequest) {
  if (!hasDatabaseConfig()) {
    return NextResponse.json(
      { error: "Feedback is temporarily unavailable. Try again later." },
      { status: 503 }
    );
  }

  try {
    const feedback = await submitWebsiteFeedback(await request.json());
    return NextResponse.json({ feedback }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
