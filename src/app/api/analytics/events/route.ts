import { NextRequest, NextResponse } from "next/server";

import { createWebsiteEvent } from "@/lib/engagement/engagement";
import { hasDatabaseConfig } from "@/lib/env";

export async function POST(request: NextRequest) {
  if (!hasDatabaseConfig()) {
    return NextResponse.json(
      { error: "Analytics are temporarily unavailable." },
      { status: 503 }
    );
  }

  try {
    const event = await createWebsiteEvent(await request.json());
    return NextResponse.json({ event }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
