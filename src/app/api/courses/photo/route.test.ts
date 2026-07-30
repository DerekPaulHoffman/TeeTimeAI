import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

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

  it("redirects successful photo lookups without exposing the API key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        photoUri: "https://lh3.googleusercontent.com/course-photo"
      })
    );

    const response = await GET(request());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://lh3.googleusercontent.com/course-photo"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const requestedUrl = fetchMock.mock.calls[0]?.[0];
    expect(requestedUrl).toBeInstanceOf(URL);
    expect(String(requestedUrl)).toContain("key=test-key");
    expect(response.headers.get("location")).not.toContain("test-key");
  });

  it("returns a valid local image when Google rate limits a photo burst", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Too many requests", { status: 429 })
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
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
