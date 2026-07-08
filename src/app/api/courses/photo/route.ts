import { NextRequest, NextResponse } from "next/server";

const photoNamePattern = /^places\/[^/]+\/photos\/[^/]+$/;

export async function GET(request: NextRequest) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const name = request.nextUrl.searchParams.get("name");

  if (!apiKey) {
    return NextResponse.json({ error: "Google Places is not configured" }, { status: 404 });
  }

  if (!name || !photoNamePattern.test(name)) {
    return NextResponse.json({ error: "Invalid photo name" }, { status: 400 });
  }

  const photoUrl = new URL(`https://places.googleapis.com/v1/${name}/media`);
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
