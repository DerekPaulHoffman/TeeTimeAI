import { NextRequest, NextResponse } from "next/server";

import { getGooglePlacesApiKey } from "@/lib/places/google";
import {
  coursePhotoFallbackCacheHeaders,
  coursePhotoSuccessCacheHeaders
} from "@/lib/places/course-data-cache";
import {
  getCoursePhotoCacheKey,
  readCourseRuntimeCache,
  writeCourseRuntimeCache
} from "@/lib/places/course-runtime-cache";

const photoReferencePattern = /^places\/[^/]+\/photos\/[^/]+$/;
const rateLimitedPhotoFallback = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" role="img" aria-label="Golf course photo unavailable">
  <rect width="480" height="360" fill="#dceaf2"/>
  <path d="M0 188C78 133 155 171 235 143c86-30 153-18 245-79v296H0Z" fill="#456f3b"/>
  <path d="M0 238c96-47 176-20 253-55 84-38 151-20 227-52v229H0Z" fill="#79a955"/>
  <path d="M203 160c55 45 94 113 111 200H135c14-86 35-151 68-200Z" fill="#a8cd78"/>
  <path d="M270 148v91" stroke="#fff" stroke-width="6"/>
  <path d="m273 151 57 20-57 21Z" fill="#df6f4c"/>
</svg>`;
const MAX_RUNTIME_CACHED_PHOTO_BYTES = 1_900_000;

type CachedCoursePhoto = {
  contentType: string;
  data: string;
};

export async function GET(request: NextRequest) {
  const apiKey = getGooglePlacesApiKey();
  const photoReference = request.nextUrl.searchParams.get("ref");

  if (!apiKey) {
    return NextResponse.json({ error: "Google Places is not configured" }, { status: 404 });
  }

  if (!photoReference || !photoReferencePattern.test(photoReference)) {
    return NextResponse.json({ error: "Invalid photo reference" }, { status: 400 });
  }

  const cacheKey = getCoursePhotoCacheKey(photoReference);
  const cachedPhoto = await readCourseRuntimeCache<CachedCoursePhoto>(cacheKey);
  if (isCachedCoursePhoto(cachedPhoto)) {
    return coursePhotoResponse(Buffer.from(cachedPhoto.data, "base64"), cachedPhoto.contentType);
  }

  const photoUrl = new URL(`https://places.googleapis.com/v1/${photoReference}/media`);
  photoUrl.searchParams.set("maxWidthPx", "480");
  photoUrl.searchParams.set("maxHeightPx", "360");
  photoUrl.searchParams.set("key", apiKey);

  const response = await fetch(photoUrl);
  if (response.status === 429) {
    return new NextResponse(rateLimitedPhotoFallback, {
      headers: {
        ...coursePhotoFallbackCacheHeaders,
        "Content-Type": "image/svg+xml; charset=utf-8",
        "X-Course-Photo-Fallback": "rate-limited"
      },
      status: 200
    });
  }

  if (!response.ok) {
    return NextResponse.json({ error: "Could not load course photo" }, { status: response.status });
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("image/")) {
    return NextResponse.json({ error: "Course photo is unavailable" }, { status: 502 });
  }

  const photo = Buffer.from(await response.arrayBuffer());
  if (photo.byteLength <= MAX_RUNTIME_CACHED_PHOTO_BYTES) {
    await writeCourseRuntimeCache(
      cacheKey,
      { contentType, data: photo.toString("base64") } satisfies CachedCoursePhoto,
      "course-photo"
    );
  }

  return coursePhotoResponse(photo, contentType);
}

function coursePhotoResponse(photo: Buffer, contentType: string) {
  const body = photo.buffer.slice(
    photo.byteOffset,
    photo.byteOffset + photo.byteLength
  ) as ArrayBuffer;
  return new NextResponse(body, {
    headers: {
      ...coursePhotoSuccessCacheHeaders,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff"
    },
    status: 200
  });
}

function isCachedCoursePhoto(value: CachedCoursePhoto | null): value is CachedCoursePhoto {
  return Boolean(
    value &&
      typeof value.data === "string" &&
      value.data.length > 0 &&
      typeof value.contentType === "string" &&
      value.contentType.toLowerCase().startsWith("image/")
  );
}
