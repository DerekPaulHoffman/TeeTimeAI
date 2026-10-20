// @vitest-environment node
import type { Page, Route } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { installNativeRedirectRouting } from "./native-redirect-routing";

async function installed() {
  const events = new Map<string, (event: unknown) => void>();
  const close = vi.fn(async () => {}), detach = vi.fn(async () => {});
  const main = {}, failures: string[] = [];
  const cdp = { on: (name: string, listener: (event: unknown) => void) => { events.set(name, listener); },
    send: vi.fn(async (name: string) => name === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {}), detach };
  const page = { context: () => ({ newCDPSession: async () => cdp }), mainFrame: () => main, close } as unknown as Page;
  const guard = await installNativeRedirectRouting(page, vi.fn(), { timeoutMs: 100, onFailure: code => failures.push(code) });
  return { guard, events, close, failures, main };
}

describe("native redirect metadata boundaries", () => {
  it("ignores browser-local image metadata but rejects untracked HTTPS evidence", async () => {
    const test = await installed();
    const emit = test.events.get("Network.responseReceived")!;
    for (const url of ["data:image/svg+xml;base64,AA==", "blob:https://example.org/offline-id"]) {
      emit({ requestId: "untracked", response: { url, status: 200, headers: {} } });
    }
    expect(test.failures).toEqual([]); expect(test.close).not.toHaveBeenCalled();
    emit({ requestId: "untracked", response: { url: "https://example.org/availability", status: 200, headers: {} } });
    expect(test.failures).toEqual(["NATIVE_REDIRECT_RESPONSE_MISMATCH"]);
    expect(test.close).toHaveBeenCalledOnce();
    await test.guard.close();
  });

  it("reports an unguarded frame explicitly instead of assuming main-frame coverage", async () => {
    const test = await installed();
    expect(() => test.guard.prepare(test.main as Parameters<typeof test.guard.prepare>[0])).not.toThrow();
    expect(() => test.guard.prepare({} as Parameters<typeof test.guard.prepare>[0])).toThrow("NATIVE_REDIRECT_FRAME_UNGUARDED");
    expect(test.guard.lastFailure).toBe("NATIVE_REDIRECT_FRAME_UNGUARDED");
    await test.guard.close();
  });

  it.each([300, 304, 305])("completes terminal HTTP %s without requiring another redirect event", async status => {
    const test = await installed(), url = "https://example.org/style.css";
    try {
      test.events.get("Fetch.requestPaused")!({ requestId: "fetch-1", networkId: "network-1", frameId: "main", resourceType: "Stylesheet",
        request: { url, method: "GET", headers: {} } });
      const route = { request: () => ({ url: () => url, method: () => "GET", frame: () => test.main }),
        continue: vi.fn(), abort: vi.fn(), fulfill: vi.fn() } as unknown as Route;
      const response = test.guard.wrapRoute(route).request().response();
      test.events.get("Network.responseReceived")!({ requestId: "network-1", response: { url, status, headers: {} } });
      test.events.get("Network.loadingFinished")!({ requestId: "network-1" });
      const completed = await response;
      expect(completed?.status()).toBe(status);
      expect(await completed?.finished()).toBeNull();
      expect(await completed?.body()).toEqual(Buffer.alloc(0));
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
});
