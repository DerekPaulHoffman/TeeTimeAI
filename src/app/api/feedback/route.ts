import { NextRequest, NextResponse } from "next/server";

import { submitWebsiteFeedback } from "@/lib/engagement/engagement";
import { deriveSameOriginPagePath } from "@/lib/engagement/page-path";
import { hasDatabaseConfig } from "@/lib/env";

export async function POST(request: NextRequest) {
  if (!hasDatabaseConfig()) {
    return NextResponse.json(
      { error: "Feedback is temporarily unavailable. Try again later." },
      { status: 503 }
    );
  }

  try {
    const body = await request.json();
    const input = isRecord(body)
      ? { ...body, page: deriveSameOriginPagePath(request) }
      : body;
    const feedback = await submitWebsiteFeedback(input);
    return NextResponse.json({ feedback }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
