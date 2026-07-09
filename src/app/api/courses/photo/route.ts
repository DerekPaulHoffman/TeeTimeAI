import { NextRequest, NextResponse } from "next/server";

import { getGooglePlacesApiKey } from "@/lib/places/google";

const photoReferencePattern = /^places\/[^/]+\/photos\/[^/]+$/;

export async function GET(request: NextRequest) {
  const apiKey = getGooglePlacesApiKey();
  const photoReference = request.nextUrl.searchParams.get("ref");

  if (!apiKey) {
    return NextResponse.json({ error: "Google Places is not configured" }, { status: 404 });
  }

  if (!photoReference || !photoReferencePattern.test(photoReference)) {
    return NextResponse.json({ error: "Invalid photo reference" }, { status: 400 });
  }

  const photoUrl = new URL(`https://places.googleapis.com/v1/${photoReference}/media`);
  photoUrl.searchParams.set("maxWidthPx", "480");
  photoUrl.searchParams.set("maxHeightPx", "360");
  photoUrl.searchParams.set("skipHttpRedirect", "true");
  photoUrl.searchParams.set("key", apiKey);

  const response = await fetch(photoUrl, { cache: "no-store" });
  if (!response.ok) {
    return NextResponse.json({ error: "Could not load course photo" }, { status: response.status });
  }

  const payload = (await response.json()) as { photoUri?: string };
  if (!payload.photoUri) {
    return NextResponse.json({ error: "Course photo is unavailable" }, { status: 404 });
  }

  if (!payload.photoUri.startsWith("https://")) {
    return NextResponse.json({ error: "Course photo URL is invalid" }, { status: 502 });
  }

  const redirect = NextResponse.redirect(payload.photoUri, 302);
  redirect.headers.set("Cache-Control", "no-store");
  return redirect;
}
