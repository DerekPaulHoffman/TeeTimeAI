import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import {
  coursePhotoFallbackCacheHeaders,
  coursePhotoSuccessCacheHeaders
} from "@/lib/places/course-data-cache";

const mocks = vi.hoisted(() => ({
  getGooglePlacesApiKey: vi.fn()
}));

vi.mock("@/lib/places/google", () => ({
  getGooglePlacesApiKey: mocks.getGooglePlacesApiKey
}));

describe("GET /api/courses/photo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getGooglePlacesApiKey.mockReturnValue("test-key");
  });

  it("proxies successful photos with long-lived shared caching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([255, 216, 255]), {
        headers: { "Content-Type": "image/jpeg" }
      })
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe(
      coursePhotoSuccessCacheHeaders["Cache-Control"]
    );
    expect(response.headers.get("vercel-cdn-cache-control")).toBe(
      coursePhotoSuccessCacheHeaders["Vercel-CDN-Cache-Control"]
    );
    await expect(response.arrayBuffer()).resolves.toEqual(
      new Uint8Array([255, 216, 255]).buffer
    );
    const requestedUrl = fetchMock.mock.calls[0]?.[0];
    expect(requestedUrl).toBeInstanceOf(URL);
    expect(String(requestedUrl)).toContain("key=test-key");
    expect(String(requestedUrl)).not.toContain("skipHttpRedirect=true");
  });

  it("returns a valid local image when Google rate limits a photo burst", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Too many requests", { status: 429 })
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(
      coursePhotoFallbackCacheHeaders["Cache-Control"]
    );
    expect(response.headers.get("x-course-photo-fallback")).toBe("rate-limited");
    await expect(response.text()).resolves.toContain("<svg");
  });

  it("preserves non-rate-limit provider failures for diagnosis", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unavailable", { status: 503 })
    );

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Could not load course photo"
    });
  });
});

function request() {
  return new NextRequest(
    "http://localhost/api/courses/photo?ref=places%2Fplace-id%2Fphotos%2Fphoto-id"
  );
}
