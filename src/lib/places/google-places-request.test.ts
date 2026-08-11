import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchGooglePlacesJsonWithRetry,
  fetchGooglePlacesWithRetry
} from "./google-places-request";

describe("Google Places transient request retries", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([429, 503])("retries one transient %s response", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("temporarily unavailable", {
          status,
          headers: { "Retry-After": "0" }
        })
      )
      .mockResolvedValueOnce(Response.json({ places: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchGooglePlacesWithRetry("https://example.test/places");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops after the bounded second attempt", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("busy", {
        status: 503,
        headers: { "Retry-After": "0" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchGooglePlacesWithRetry("https://example.test/places");

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry sooner than a long Retry-After instruction", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "30" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchGooglePlacesWithRetry("https://example.test/places");

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-transient provider response", async () => {
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchGooglePlacesWithRetry("https://example.test/places");

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a transient response body before starting the retry", async () => {
    const transientResponse = new Response("temporarily unavailable", {
      status: 503,
      headers: { "Retry-After": "0" }
    });
    const cancelSpy = vi
      .spyOn(transientResponse.body!, "cancel")
      .mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(transientResponse)
      .mockImplementationOnce(async () => {
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        return Response.json({ places: [] });
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchGooglePlacesWithRetry("https://example.test/places");

    expect(response.status).toBe(200);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors a caller abort during an in-flight attempt without retrying", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("caller stopped the request", "AbortError");
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchGooglePlacesWithRetry("https://example.test/places", {
      signal: controller.signal
    });
    controller.abort(abortReason);

    await expect(request).rejects.toBe(abortReason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors a caller abort while waiting to retry", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("caller stopped the retry", "AbortError");
    const transientResponse = new Response("temporarily unavailable", {
      status: 429,
      headers: { "Retry-After": "1" }
    });
    const cancelSpy = vi.spyOn(transientResponse.body!, "cancel");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(transientResponse)
      .mockResolvedValueOnce(Response.json({ places: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchGooglePlacesWithRetry("https://example.test/places", {
      signal: controller.signal
    });
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledTimes(1));
    controller.abort(abortReason);

    await expect(request).rejects.toBe(abortReason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries an attempt timeout but remains bounded by the second attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      () => new Promise<Response>(() => undefined)
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchGooglePlacesWithRetry(
      "https://example.test/places",
      undefined,
      { attemptTimeoutMs: 50, totalTimeoutMs: 500 }
    );
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
  });

  it("enforces the total deadline while waiting to retry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchGooglePlacesWithRetry(
      "https://example.test/places",
      undefined,
      { attemptTimeoutMs: 500, totalTimeoutMs: 50 }
    );
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful response body under each attempt deadline", async () => {
    vi.useFakeTimers();
    const cancelBody = vi.fn();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
            cancel: cancelBody
          }),
          { status: 200 }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchGooglePlacesJsonWithRetry(
      "https://example.test/places",
      undefined,
      { attemptTimeoutMs: 50, totalTimeoutMs: 500 }
    );
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(cancelBody).toHaveBeenCalledTimes(2);
  });

  it("cancels a never-settling response body at the total deadline", async () => {
    vi.useFakeTimers();
    const cancelBody = vi.fn();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
            cancel: cancelBody
          }),
          { status: 200 }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchGooglePlacesJsonWithRetry(
      "https://example.test/places",
      undefined,
      { attemptTimeoutMs: 500, totalTimeoutMs: 50 }
    );
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });
});
