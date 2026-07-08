import { NextRequest, NextResponse } from "next/server";

import { geocodeLocation } from "@/lib/places/geocode";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
  }

  try {
    const result = await geocodeLocation(query);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not geocode location" },
      { status: 502 }
    );
  }
}
