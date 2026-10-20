// @vitest-environment node
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePinnedPublicAddress } from "@/lib/automation/address-pinned-public-fetch";
import { continueNativeBrowserRead, createNativePublicBrowserProxy, isObservedNativeRedirect, nativeReadPreflightMethod, type NativePublicProxy } from "./native-public-browser";
import type { Route } from "@playwright/test";

const opened: NativePublicProxy[] = [];
const sockets: Socket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy(); for (const proxy of opened.splice(0)) await proxy.close(); });
async function request(proxy: NativePublicProxy, line: string) {
  const url = new URL(proxy.server);
  const socket = connect(Number(url.port), "127.0.0.1"); sockets.push(socket);
  const response = new Promise<string>((resolve, reject) => { socket.once("data", data => resolve(data.toString())); socket.once("error", reject); });
  socket.write(`${line}\r\nHost: example.org\r\n\r\n`);
  return { response: await response, socket };
}
describe("public-address native Chrome CONNECT transport", () => {
  it("admits only read preflights and keeps the requested method available for recipe checks", () => {
    expect(nativeReadPreflightMethod({ origin: "https://example.org", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-requested-with" })).toBe("POST");
    expect(nativeReadPreflightMethod({ origin: "https://example.org", "access-control-request-method": "DELETE" })).toBeNull();
    expect(nativeReadPreflightMethod({ origin: "https://127.0.0.1", "access-control-request-method": "GET" })).toBeNull();
    expect(nativeReadPreflightMethod({ origin: "https://example.org", "access-control-request-method": "POST", "access-control-request-headers": "authorization" })).toBeNull();
  });
  it("accepts an observed www redirect chain without allowing external, POST or unbounded redirects", () => {
    type Request = Parameters<typeof isObservedNativeRedirect>[0];
    const request = (url: string, previous: Request | null = null, method = "GET"): Request => ({ url: () => url, method: () => method, redirectedFrom: () => previous });
    const original = request("https://www.example.org/golf");
    const observed = new Set(["https://www.example.org"]);
    expect(isObservedNativeRedirect(request("https://example.org/golf", original), observed)).toBe(true);
    expect(isObservedNativeRedirect(request("https://other.example.org/golf", original), observed)).toBe(false);
    expect(isObservedNativeRedirect(request("https://example.org/golf", request("https://www.example.org/golf", null, "POST")), observed)).toBe(false);
    let chain = original;
    for (let index = 0; index < 6; index++) chain = request(`https://example.org/${index}`, chain);
    expect(isObservedNativeRedirect(chain, observed)).toBe(false);
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "203.0.113.1"])("rejects a private/reserved DNS answer %s", async address => {
    await expect(resolvePinnedPublicAddress("golf.example.org", { resolveAddresses: async () => [{ address, family: 4 }] })).rejects.toThrow("non-public");
  });
  it("rejects mixed answers and literal or credential hosts", async () => {
    await expect(resolvePinnedPublicAddress("golf.example.org", { resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] })).rejects.toThrow();
    await expect(resolvePinnedPublicAddress("user@example.org")).rejects.toThrow();
    await expect(resolvePinnedPublicAddress("127.0.0.1")).rejects.toThrow();
  });
  it("rejects non-CONNECT, non-443, credentials and denied DNS without connecting", async () => {
    const dial = vi.fn();
    const proxy = await createNativePublicBrowserProxy({ signal: AbortSignal.timeout(10_000) }, {
      resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }], connect: dial,
    }); opened.push(proxy);
    expect((await request(proxy, "GET http://example.org/ HTTP/1.1")).response).toContain("405");
    expect((await request(proxy, "CONNECT example.org:80 HTTP/1.1")).response).toContain("403");
    expect((await request(proxy, "CONNECT user:pass@example.org:443 HTTP/1.1")).response).toContain("403");
    expect((await request(proxy, "CONNECT example.org:443 HTTP/1.1")).response).toContain("403");
    expect(dial).not.toHaveBeenCalled();
  });
  it("pins an opaque tunnel to the checked address and closes all sockets on abort", async () => {
    const echo = createTcpServer(socket => socket.pipe(socket));
    await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
    const address = echo.address() as AddressInfo;
    const abort = new AbortController();
    const dial = vi.fn(() => connect(address.port, "127.0.0.1"));
    const proxy = await createNativePublicBrowserProxy({ signal: abort.signal }, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }], connect: dial,
    }); opened.push(proxy);
    try {
      const openedTunnel = await request(proxy, "CONNECT golf.example.org:443 HTTP/1.1");
      expect(openedTunnel.response).toContain("200 Connection Established");
      expect(dial).toHaveBeenCalledWith({ host: "93.184.216.34", family: 4, port: 443 });
      const echoed = new Promise<string>(resolve => openedTunnel.socket.once("data", data => resolve(data.toString())));
      openedTunnel.socket.write("opaque TLS bytes"); expect(await echoed).toBe("opaque TLS bytes");
      const closed = new Promise<void>(resolve => openedTunnel.socket.once("close", () => resolve()));
      abort.abort(); await closed;
    } finally { await proxy.close(); await new Promise<void>(resolve => echo.close(() => resolve())); }
  });
  it("does not release the native read until the browser response body completes", async () => {
    let bodyReady: (value: Buffer) => void = () => {};
    const body = new Promise<Buffer>(resolve => { bodyReady = resolve; });
    const route = { continue: vi.fn(async () => {}), request: () => ({ response: async () => ({
      status: () => 200, allHeaders: async () => ({ "content-type": "application/json" }), url: () => "https://example.org/slots", finished: async () => null, body: () => body,
    }) }) } as unknown as Route;
    let completed = false;
    const response = continueNativeBrowserRead(route, AbortSignal.timeout(10_000)).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 5)); expect(completed).toBe(false);
    bodyReady(Buffer.from("[]")); expect((await response).body.toString()).toBe("[]");
  });
  it("cancels one host's live tunnels and resumes only a new admitted host generation", async () => {
    const echo = createTcpServer(socket => socket.pipe(socket));
    await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
    const address = echo.address() as AddressInfo;
    const proxy = await createNativePublicBrowserProxy({ signal: AbortSignal.timeout(10_000) }, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: () => connect(address.port, "127.0.0.1"),
    }); opened.push(proxy);
    try {
      const first = await request(proxy, "CONNECT one.example.org:443 HTTP/1.1");
      const other = await request(proxy, "CONNECT two.example.org:443 HTTP/1.1");
      const firstClosed = new Promise<void>(resolve => first.socket.once("close", resolve));
      await proxy.cancelHostConnections("one.example.org"); await firstClosed;
      const echoed = new Promise<string>(resolve => other.socket.once("data", data => resolve(data.toString())));
      other.socket.write("other host alive"); expect(await echoed).toBe("other host alive");
      proxy.allowHostConnections("one.example.org");
      expect((await request(proxy, "CONNECT one.example.org:443 HTTP/1.1")).response).toContain("200 Connection Established");
    } finally { await proxy.close(); await new Promise<void>(resolve => echo.close(() => resolve())); }
  });
  it("stops native network before an over-limit read can release its lease", async () => {
    const lifecycle: string[] = [];
    const route = { continue: vi.fn(async () => {}), request: () => ({ response: async () => ({
      allHeaders: async () => ({ "content-length": "100" }),
    }) }) } as unknown as Route;
    await expect(continueNativeBrowserRead(route, AbortSignal.timeout(10_000), 10, async () => {
      await Promise.resolve(); lifecycle.push("network-closed");
    }).finally(() => { lifecycle.push("lease-released"); })).rejects.toThrow("NATIVE_RESPONSE_LIMIT");
    expect(lifecycle).toEqual(["network-closed", "lease-released"]);
  });
  it("stops native network on cancellation while response body remains open", async () => {
    const signal = new AbortController();
    const stop = vi.fn(async () => {});
    const route = { continue: vi.fn(async () => {}), request: () => ({ response: async () => ({
      status: () => 200, allHeaders: async () => ({}), url: () => "https://example.org/events", finished: () => new Promise(() => {}),
    }) }) } as unknown as Route;
    const pending = continueNativeBrowserRead(route, signal.signal, 100, stop);
    signal.abort(new Error("CANCELLED"));
    await expect(pending).rejects.toThrow("CANCELLED"); expect(stop).toHaveBeenCalledOnce();
  });
  it("does not tear down the venue for an already-finished failed ancillary request", async () => {
    const stop = vi.fn(async () => {});
    const route = { continue: vi.fn(async () => {}), request: () => ({ response: async () => ({
      allHeaders: async () => ({}), finished: async () => new Error("request failed"),
    }) }) } as unknown as Route;
    await expect(continueNativeBrowserRead(route, AbortSignal.timeout(1000), 100, stop)).rejects.toThrow("NATIVE_REQUEST_FAILED");
    expect(stop).not.toHaveBeenCalled();
  });
});
