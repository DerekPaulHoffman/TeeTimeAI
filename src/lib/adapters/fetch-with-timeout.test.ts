import { describe, expect, it, vi } from "vitest";

import { fetchWithProviderTimeout } from "./fetch-with-timeout";

describe("fetchWithProviderTimeout", () => {
  it("adds an abort signal to provider requests", async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("ok");
    }) as unknown as typeof fetch;

    await fetchWithProviderTimeout("https://example.com", {}, fetchImpl, 100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled provider request", async () => {
    const fetchImpl = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    ) as unknown as typeof fetch;

    await expect(
      fetchWithProviderTimeout("https://example.com", {}, fetchImpl, 1)
    ).rejects.toBeTruthy();
  });
});
