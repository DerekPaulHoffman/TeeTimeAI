import { afterEach, describe, expect, it, vi } from "vitest";
import { connectOwnedSourceCdp, projectOwnedSocketError } from "./stagehand-owned-cdp";

const { FakeSocket } = vi.hoisted(() => { class FakeSocket extends EventTarget {
  static last: FakeSocket;
  sent: Array<{ id: number; method: string }> = [];
  options: unknown;
  constructor(_endpoint: string, options: unknown) { super(); this.options = options; FakeSocket.last = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.dispatchEvent(new Event("close")); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
} return { FakeSocket }; });
vi.mock("ws", () => ({ default: FakeSocket }));
const endpoint = "ws://127.0.0.1:12345/devtools/browser/" + "a".repeat(32);
afterEach(() => vi.unstubAllGlobals());
describe("owned CDP first-failure diagnostics", () => {
  it("keeps a retired target cleanup rejection local while another guarded target remains usable", async () => {
    const cdp = await connectOwnedSourceCdp(endpoint, new AbortController().signal);
    const cleanup = cdp.session("retired").detach();
    FakeSocket.last.receive({ id: 1, error: { code: -32602, message: "No session with given id" } });
    await expect(cleanup).rejects.toThrow("OWNED_STAGEHAND_CDP_UNAVAILABLE");
    expect(cdp.failureDiagnostic()).toBeUndefined();
    const active = cdp.session("active").send("Page.enable");
    FakeSocket.last.receive({ id: 2, result: {} });
    await expect(active).resolves.toEqual({});
    const rawDetach = cdp.root.send("Target.detachFromTarget", { sessionId: "other" });
    FakeSocket.last.receive({ id: 3, error: { code: -32602, message: "PRIVATE" } });
    await expect(rawDetach).rejects.toThrow("OWNED_STAGEHAND_CDP_UNAVAILABLE");
    expect(cdp.failureDiagnostic()).toMatchObject({ layer: "RPC", method: "Target.detachFromTarget", rpcCode: -32602 });
    const laterCleanup = cdp.session("retired").detach();
    FakeSocket.last.receive({ id: 4, error: { code: -32602, message: "PRIVATE" } });
    await expect(laterCleanup).rejects.toThrow("OWNED_STAGEHAND_CDP_UNAVAILABLE");
    expect(cdp.failureDiagnostic()).toMatchObject({ layer: "RPC", method: "Target.detachFromTarget", rpcCode: -32602 });
    cdp.close();
  });
  it("keeps an exact invalidated image-abort RPC recoverable only by its owning session and request", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const cdp = await connectOwnedSourceCdp(endpoint, new AbortController().signal);
    const child = cdp.session("PRIVATE_CHILD"), other = cdp.session("OTHER_CHILD");
    const failed = child.send("Fetch.failRequest", { requestId: "PRIVATE_IMAGE", errorReason: "BlockedByClient" });
    FakeSocket.last.receive({ id: 1, error: { code: -32602, message: "Invalid interception id PRIVATE_IMAGE" } });
    let commandError: unknown; try { await failed; } catch (error) { commandError = error; }
    expect(commandError).toBeInstanceOf(Error);
    expect(cdp.failureDiagnostic()).toEqual({ layer: "RPC", method: "Fetch.failRequest", rpcCode: -32602,
      lifecycle: "UNKNOWN", pendingRequests: 0 });
    expect(other.recoverTerminalExcludedImageAbort(commandError, "PRIVATE_IMAGE")).toBe(false);
    expect(child.recoverTerminalExcludedImageAbort(commandError, "WRONG_IMAGE")).toBe(false);
    expect(child.recoverTerminalExcludedImageAbort(Error("OWNED_STAGEHAND_CDP_UNAVAILABLE"), "PRIVATE_IMAGE")).toBe(false);
    expect(child.recoverTerminalExcludedImageAbort(commandError, "PRIVATE_IMAGE")).toBe(true);
    expect(child.recoverTerminalExcludedImageAbort(commandError, "PRIVATE_IMAGE")).toBe(false);
    expect(cdp.failureDiagnostic()).toBeUndefined();
    const later = child.send("Page.enable");
    FakeSocket.last.receive({ id: 2, error: { code: -32001, message: "Session with given id not found PRIVATE_LATER" } });
    await expect(later).rejects.toThrow("OWNED_STAGEHAND_CDP_UNAVAILABLE");
    expect(cdp.failureDiagnostic()).toEqual({ layer: "RPC", method: "Page.enable", rpcCode: -32001,
      lifecycle: "SESSION_NOT_FOUND", pendingRequests: 0 });
    expect(JSON.stringify(cdp.failureDiagnostic())).not.toMatch(/PRIVATE|IMAGE|https:|requestId/u);
    cdp.close();
  });
  it("never recovers a different RPC code, method, or a candidate after another hard failure", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const cdp = await connectOwnedSourceCdp(endpoint, new AbortController().signal);
    const child = cdp.session("PRIVATE_CHILD");
    const wrongCode = child.send("Fetch.failRequest", { requestId: "IMAGE_A" });
    FakeSocket.last.receive({ id: 1, error: { code: -32601, message: "PRIVATE" } });
    let wrongError: unknown; try { await wrongCode; } catch (error) { wrongError = error; }
    expect(child.recoverTerminalExcludedImageAbort(wrongError, "IMAGE_A")).toBe(false);
    const later = child.send("Fetch.failRequest", { requestId: "IMAGE_B" });
    FakeSocket.last.receive({ id: 2, error: { code: -32602, message: "PRIVATE" } });
    let laterError: unknown; try { await later; } catch (error) { laterError = error; }
    expect(child.recoverTerminalExcludedImageAbort(laterError, "IMAGE_B")).toBe(false);
    expect(cdp.failureDiagnostic()).toEqual({ layer: "RPC", method: "Fetch.failRequest", rpcCode: -32601,
      lifecycle: "UNKNOWN", pendingRequests: 0 });
    cdp.close();
    const another = await connectOwnedSourceCdp(endpoint, new AbortController().signal);
    const wrongMethod = another.root.send("Page.enable", { requestId: "IMAGE_C" });
    FakeSocket.last.receive({ id: 1, error: { code: -32602, message: "PRIVATE" } });
    let methodError: unknown; try { await wrongMethod; } catch (error) { methodError = error; }
    expect(another.root.recoverTerminalExcludedImageAbort(methodError, "IMAGE_C")).toBe(false);
    expect(another.failureDiagnostic()).toEqual({ layer: "RPC", method: "Page.enable", rpcCode: -32602,
      lifecycle: "UNKNOWN", pendingRequests: 0 });
    another.close();
  });
  it("uses the pinned module with compression/redirects disabled and the unchanged 32MB payload cap", async () => {
    vi.stubGlobal("WebSocket", class { constructor() { throw Error("GLOBAL_WEBSOCKET_MUST_NOT_BE_USED"); } });
    const cdp = await connectOwnedSourceCdp(endpoint, new AbortController().signal);
    expect(FakeSocket.last.options).toEqual({ perMessageDeflate: false, maxPayload: 32_000_000, followRedirects: false, handshakeTimeout: 5000 });
    cdp.close(); expect(cdp.failureDiagnostic()).toBeUndefined();
  });
  it("retains exact RPC method/code and a known lifecycle marker without identifiers or payloads", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const cdp = await connectOwnedSourceCdp(endpoint, new AbortController().signal);
    const send = cdp.root.send("Target.closeTarget", { targetId: "PRIVATE_TARGET" });
    FakeSocket.last.receive({ id: 1, error: { code: -32001, message: "Session with given id not found. PRIVATE_SESSION https://private.example/" } });
    await expect(send).rejects.toThrow("OWNED_STAGEHAND_CDP_UNAVAILABLE");
    expect(cdp.failureDiagnostic()).toEqual({ layer: "RPC", method: "Target.closeTarget", rpcCode: -32001, lifecycle: "SESSION_NOT_FOUND", pendingRequests: 0 });
    const first = cdp.failureDiagnostic()!; first.method = "UNKNOWN";
    expect(cdp.failureDiagnostic()?.method).toBe("Target.closeTarget");
    cdp.root.on("Target.attachedToTarget", async () => { throw Error("PRIVATE_LISTENER"); });
    FakeSocket.last.receive({ method: "Target.attachedToTarget", params: { targetId: "PRIVATE" } });
    await Promise.resolve(); await Promise.resolve();
    expect(cdp.failureDiagnostic()?.layer).toBe("RPC");
    expect(JSON.stringify(cdp.failureDiagnostic())).not.toMatch(/PRIVATE|https:|sessionId|targetId|message|12345/u);
    cdp.close();
  });
  it("distinguishes a rejecting async target listener and still closes the guardian and pending requests", async () => {
    vi.stubGlobal("WebSocket", FakeSocket); const lost = vi.fn();
    const cdp = await connectOwnedSourceCdp(endpoint, new AbortController().signal, lost);
    cdp.root.on("Target.attachedToTarget", async () => { throw Error("PRIVATE"); });
    const waiting = cdp.root.send("Page.getFrameTree");
    const rejected = expect(waiting).rejects.toThrow("OWNED_STAGEHAND_CDP_UNAVAILABLE");
    FakeSocket.last.receive({ method: "Target.attachedToTarget", params: { targetInfo: { url: "https://private.example/" } } });
    await rejected;
    expect(lost).toHaveBeenCalledOnce();
    expect(cdp.failureDiagnostic()).toEqual({ layer: "ASYNC_LISTENER", event: "Target.attachedToTarget", pendingRequests: 1 });
    await expect(cdp.root.send("Page.enable")).rejects.toThrow("OWNED_STAGEHAND_CDP_UNAVAILABLE");
  });
  it("does not manufacture a failure for deliberate cleanup; unknown method/error text remains closed", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const cancellation = new AbortController(), cdp = await connectOwnedSourceCdp(endpoint, cancellation.signal);
    cancellation.abort("STAGEHAND_SOURCE_CLOSED"); cdp.close(); expect(cdp.failureDiagnostic()).toBeUndefined();
    const other = await connectOwnedSourceCdp(endpoint, new AbortController().signal);
    const waiting = other.root.send("Secret.Token", { secret: "PRIVATE" });
    FakeSocket.last.receive({ id: 1, error: { code: 99, message: "PRIVATE arbitrary lifecycle" } });
    await expect(waiting).rejects.toThrow();
    expect(other.failureDiagnostic()).toEqual({ layer: "RPC", method: "UNKNOWN", rpcCode: 99, lifecycle: "UNKNOWN", pendingRequests: 0 });
    other.close();
  });
  it("retains only closed built-in socket error codes before failure cleanup and never adopts a later cleanup close", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const cdp = await connectOwnedSourceCdp(endpoint, new AbortController().signal);
    const event = new Event("error");
    Object.defineProperty(event, "error", { value: { name: "MessageSizeExceededError", code: "UND_ERR_WS_MESSAGE_SIZE_EXCEEDED", message: "SECRET", cause: { code: "ECONNRESET", address: "PRIVATE" } } });
    FakeSocket.last.dispatchEvent(event);
    expect(cdp.failureDiagnostic()).toEqual({ layer: "SOCKET_ERROR", pendingRequests: 0, socketErrorName: "MessageSizeExceededError", socketFailureCategory: "UNKNOWN", socketErrorCode: "UND_ERR_WS_MESSAGE_SIZE_EXCEEDED", socketCauseCode: "ECONNRESET" });
    expect(cdp.failureDiagnostic()?.socketCloseCode).toBeUndefined();
    expect(projectOwnedSocketError({ name: "PRIVATE", code: "PRIVATE", cause: { code: "PRIVATE" } })).toEqual({ socketErrorName: "UNKNOWN", socketFailureCategory: "UNKNOWN", socketErrorCode: "UNKNOWN", socketCauseCode: "UNKNOWN" });
    expect(projectOwnedSocketError(Error("Max decompressed message size exceeded"))).toEqual({ socketErrorName: "Error", socketFailureCategory: "DECOMPRESSED_MESSAGE_LIMIT" });
    expect(projectOwnedSocketError(Error("Max decompressed message size exceeded PRIVATE"))).toEqual({ socketErrorName: "Error", socketFailureCategory: "UNKNOWN" });
  });
  it("retains an actual first close code and cleanliness but omits its arbitrary reason", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const cdp = await connectOwnedSourceCdp(endpoint, new AbortController().signal);
    const event = new Event("close"); Object.defineProperties(event, { code: { value: 1006 }, wasClean: { value: false }, reason: { value: "SECRET" } });
    FakeSocket.last.dispatchEvent(event);
    expect(cdp.failureDiagnostic()).toEqual({ layer: "SOCKET_CLOSE", pendingRequests: 0, socketCloseCode: 1006, socketWasClean: false });
    expect(JSON.stringify(cdp.failureDiagnostic())).not.toContain("SECRET");
  });
  it("still shuts down the guardian and pending work when an error diagnostic accessor throws", async () => {
    vi.stubGlobal("WebSocket", FakeSocket); const failed = vi.fn();
    const cdp = await connectOwnedSourceCdp(endpoint, new AbortController().signal, failed);
    const pending = cdp.root.send("Runtime.evaluate"), rejected = expect(pending).rejects.toThrow("OWNED_STAGEHAND_CDP_UNAVAILABLE");
    const event = new Event("error"); Object.defineProperty(event, "error", { get() { throw Error("PRIVATE_DIAGNOSTIC_GETTER"); } });
    FakeSocket.last.dispatchEvent(event); await rejected;
    expect(failed).toHaveBeenCalledOnce(); expect(cdp.failureDiagnostic()).toEqual({ layer: "SOCKET_ERROR", pendingRequests: 1 });
  });
});
