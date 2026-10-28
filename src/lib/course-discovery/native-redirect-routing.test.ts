// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Page, type Route } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { authorizePublicClientReadHeaders, installNativeRedirectRouting, isCurrentPublicClientReadHeaders,
  publicClientReadHeaderProofFailure, nativeSourceLoadingFailedCorsErrors, nativePublicClientPreflightMethod, isNativeReadSupersededFailure, isNativeReadTerminalFailure, nativeMindbodyBootstrapSource, nativeGestureNavigationSource, attestedNativeDocumentRedirects, projectNativeOfficialRenderGate, type NativeGestureIntent, type NativeReadRoute, type NativeRequestDiagnostic, type NativeUncorrelatedPost } from "./native-redirect-routing";
import { createPublicBookingParentScope } from "./public-booking-parent";
import { continueNativeBrowserRead, isObservedNativeRedirect, isObservedNativeRedirectTarget, nativeReadPreflightMethod } from "./native-public-browser";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { type PublicBrowserResponseProfile } from "./browser-resource-limits";
import { canonicalStagehandHostEntry } from "./stagehand-source-browser";
import { isSafeRecipeUrl, isSafeBrowserBootstrapReadUrl } from "./recipe";
import { discoveryDefiniteUncorrelatedPostDenial } from "./browser-session";
import { isAnonymousBrowserReadPost } from "@/lib/automation/simulator-interactive-browser";
import { discoveryBrowserFeedback } from "../../../scripts/automation/course-discovery-worker.mjs";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it("retains only closed official render gate facts", () => {
  const raw = { nativeTransport: true, mainFrame: true, navigationRequestPresent: true, navigationStatus200: true,
    witnessPresent: true, witnessRequestMatches: true, witnessUrlMatches: true, completedDocumentRead: true,
    officialRootProof: false, officialSubpageProof: false, pendingSubpagePresent: false, subpageTokenPresent: false,
    linkCount: "MULTIPLE", linkFailure: "LINK_COUNT", anchorFailure: "SIGNATURE_CHANGED", anchorOrdinal: "SECOND",
    url: "https://private.example/?token=SECRET" };
  const projected = projectNativeOfficialRenderGate(raw);
  expect(projected).toMatchObject({ linkCount: "MULTIPLE", linkFailure: "LINK_COUNT", anchorFailure: "SIGNATURE_CHANGED",
    anchorOrdinal: "SECOND", officialSubpageProof: false });
  expect(JSON.stringify(projected)).not.toMatch(/private|SECRET|https:|"url":/iu);
  expect(projectNativeOfficialRenderGate({ ...raw, witnessPresent: "true" })).toBeUndefined();
  expect(projectNativeOfficialRenderGate({ ...raw, anchorFailure: "https://private.example/" })).toBeUndefined();
});
async function installed(maxRequests?: number, signal?: AbortSignal, afterRoute?: (route: NativeReadRoute) => Promise<void>, responseProfile?: PublicBrowserResponseProfile,
  onCommandFailure?: (diagnostic: NativeRequestDiagnostic) => void, controllerGetIntent?: (sourceUrl: string, targetUrl: string) => boolean,
  denyUncorrelatedPost?: (request: NativeUncorrelatedPost) => boolean, controllerScriptGetIntent?: (sourceUrl: string, targetUrl: string) => NativeGestureIntent | undefined) {
  const events = new Map<string, (event: unknown) => void>(), routes: NativeReadRoute[] = [];
  const close = vi.fn(async () => {}), detach = vi.fn(async () => {}), failures: string[] = [], subframes: object[] = [], rejections: NativeRequestDiagnostic[] = [];
  const main = { page: () => page };
  const cdp = { on: (name: string, listener: (event: unknown) => void) => { events.set(name, listener); },
    send: vi.fn(async (name: string, value?: { requestId?: string }) => name === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } }
      : name === "Fetch.getResponseBody" ? { body: `body-${value?.requestId}`, base64Encoded: false } : {}), detach };
  const page = { context: () => ({ newCDPSession: async () => cdp }), mainFrame: () => main, close } as unknown as Page;
  const handler = vi.fn(async (route: NativeReadRoute) => { routes.push(route); await afterRoute?.(route); });
  const guard = await installNativeRedirectRouting(page, handler, { timeoutMs: 100, maxRequests, signal, responseProfile, onCommandFailure, controllerGetIntent, controllerScriptGetIntent, denyUncorrelatedPost,
    onFailure: code => failures.push(code), onSubframeBlocked: request => subframes.push(request), onRequestRejected: request => rejections.push(request) });
  const request = (id: string, values: object = {}) => events.get("Fetch.requestPaused")!({ requestId: id, networkId: `network-${id}`,
    frameId: "main", resourceType: "XHR", request: { url: "https://example.org/data", method: "GET", headers: {} }, ...values });
  const response = (id: string, values: object = {}) => request(id, { responseStatusCode: 200, responseHeaders: [], ...values });
  return { guard, events, close, failures, main, cdp, subframes, rejections, handler, routes, request, response };
}
function playwrightRoute(test: Awaited<ReturnType<typeof installed>>) {
  return { request: () => ({ frame: () => test.main }), continue: vi.fn(async () => {}), abort: vi.fn(async () => {}), fulfill: vi.fn() } as unknown as Route;
}

describe("closed native initiating-failure diagnostics", () => {
  it("retains an orphan stylesheet correlation timeout before cleanup without dispatch or a duplicate claim", async () => {
    const t = await installed(), url = "https://example.org/public.css?version=1";
    try {
      await t.guard.beginDocumentNavigation(t.main as never);
      t.request("orphan-style", { resourceType: "Stylesheet", request: { url, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce());
      expect(t.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_LOADER_TIMEOUT", phase: "LOADER_IDENTITY_WAIT",
        operation: "LOADER_CORRELATION", method: "GET", resourceType: "stylesheet", framePresent: true, networkIdPresent: true,
        identityPresent: false, loaderPresent: false, duplicateRequestId: false, requestUrlSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(t.handler).not.toHaveBeenCalled();
      expect(t.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueRequest")).toBe(false);
    } finally { await t.guard.close(); }
  });
  it("retains the actual body RPC failure operation while leaving its fatal behavior unchanged", async () => {
    const t = await installed(), send = t.cdp.send.getMockImplementation()!;
    t.cdp.send.mockImplementation(async (name, value) => {
      if (name === "Fetch.getResponseBody") throw Error("Protocol error (Fetch.getResponseBody): No data found for resource with given identifier PRIVATE_BODY_COOKIE");
      return send(name, value);
    });
    try {
      t.request("style", { resourceType: "Stylesheet" }); await t.routes[0].continue();
      t.response("style", { resourceType: "Stylesheet" });
      await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce());
      expect(t.failures).toEqual(["NATIVE_REDIRECT_ROUTING_FAILED"]);
      expect(t.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_ROUTING_FAILED", operation: "RESPONSE_BODY",
        errorName: "Error", errorCategory: "BODY_UNAVAILABLE", method: "GET", resourceType: "stylesheet" });
      expect(JSON.stringify(t.guard.firstFatal)).not.toMatch(/PRIVATE_BODY_COOKIE|Protocol error|postData"|headers"/u);
      expect(t.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false);
    } finally { await t.guard.close(); }
  });
});

describe("native child-asset denial", () => {
  const root = "https://example.org/", asset = "https://assets.example.org/public.js";
  async function prepared(profile: PublicBrowserResponseProfile | null = "SOURCE_ROUTING", maxRequests?: number, signal?: AbortSignal) {
    const t = await installed(maxRequests, signal, undefined, profile ?? undefined);
    await t.guard.beginDocumentNavigation(t.main as never);
    t.events.get("Network.requestWillBeSent")!({ requestId: "network-document", frameId: "main", loaderId: "root-loader", type: "Document", request: { url: root, method: "GET" } });
    t.request("document", { resourceType: "Document", request: { url: root, method: "GET", headers: {} } });
    await t.routes[0].continue();
    t.response("document", { resourceType: "Document", request: { url: root, method: "GET", headers: {} }, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
    await t.routes[0].request().response();
    t.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "root-loader", url: root } });
    await vi.waitFor(() => expect(t.guard.pendingReads).toBe(0));
    return t;
  }
  function child(t: Awaited<ReturnType<typeof prepared>>, values: object = {}) {
    t.events.get("Page.frameNavigated")!({ frame: { id: "child", parentId: "main", loaderId: "child-loader", url: "about:srcdoc", ...values } });
  }
  function network(t: Awaited<ReturnType<typeof prepared>>, resourceType = "Script", values: object = {}) {
    t.events.get("Network.requestWillBeSent")!({ requestId: "network-asset", frameId: "child", loaderId: "child-loader", type: resourceType,
      request: { url: asset, method: "GET" }, ...values });
  }
  const proof = (t: Awaited<ReturnType<typeof prepared>>) => t.guard.isCurrentCompletedDocumentRead(t.routes[0].request(), t.main as never,
    { frameId: "main", loaderId: "root-loader", url: root });
  it.each(["exact terminal", "missing terminal", "late terminal", "wrong network", "finished", "wrong kind", "not canceled", "unbranded RPC", "wrong loader", "wrong frame", "other profile"] as const)(
    "drains only an exact source-profile excluded image whose failed abort has independent terminal proof: %s", async mode => {
      const t = await prepared(mode === "other profile" ? null : "SOURCE_ROUTING"), url = "https://example.org/photo.jpg";
      const abortError = Error("OWNED_STAGEHAND_CDP_UNAVAILABLE"), send = t.cdp.send.getMockImplementation()!;
      const recover = vi.fn((error: unknown, id: string) => mode !== "unbranded RPC" && error === abortError && id === "decoration");
      Object.assign(t.cdp, { recoverTerminalExcludedImageAbort: recover });
      t.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "decoration"
        ? Promise.reject(abortError) : send(name, value));
      try {
        t.events.get("Network.requestWillBeSent")!({ requestId: "network-decoration", frameId: mode === "wrong frame" ? "child" : "main",
          loaderId: mode === "wrong loader" ? "other-loader" : "root-loader", type: "Image", request: { url, method: "GET" } });
        t.request("decoration", { resourceType: "Image", networkId: "network-decoration", request: { url, method: "GET", headers: {} } });
        await vi.waitFor(() => expect(t.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "decoration")).toBe(true));
        if (mode === "finished") t.events.get("Network.loadingFinished")!({ requestId: "network-decoration" });
        else if (mode !== "missing terminal" && mode !== "late terminal") t.events.get("Network.loadingFailed")!({ requestId: mode === "wrong network" ? "network-other" : "network-decoration",
          type: mode === "wrong kind" ? "Script" : "Image", canceled: mode !== "not canceled", errorText: "net::ERR_ABORTED" });
        await vi.waitFor(() => expect(t.guard.pendingReads).toBe(0), { timeout: 1000 });
        if (mode === "late terminal") t.events.get("Network.loadingFailed")!({ requestId: "network-decoration", type: "Image", canceled: true, errorText: "net::ERR_ABORTED" });
        if (mode === "exact terminal") {
          expect(recover).toHaveBeenCalledOnce(); expect(t.close).not.toHaveBeenCalled(); expect(t.guard.firstFatal).toBeUndefined();
          expect(t.handler).toHaveBeenCalledOnce(); expect(proof(t)).toBe(true);
        } else {
          expect(t.close).toHaveBeenCalledOnce(); expect(t.guard.firstFatal).toBeDefined();
          expect(t.handler).toHaveBeenCalledOnce();
        }
        expect(t.cdp.send.mock.calls.filter(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "decoration")).toHaveLength(1);
        expect(t.cdp.send.mock.calls.filter(([name, value]) => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.getResponseBody"].includes(name) &&
          value?.requestId === "decoration")).toHaveLength(0);
      } finally { await t.guard.close(); }
    });
  it("stops the excluded image terminal wait when the source aborts", async () => {
    const cancellation = new AbortController(), t = await prepared("SOURCE_ROUTING", undefined, cancellation.signal);
    const url = "https://example.org/photo.jpg", abortError = Error("OWNED_STAGEHAND_CDP_UNAVAILABLE");
    const send = t.cdp.send.getMockImplementation()!, recover = vi.fn(() => true);
    Object.assign(t.cdp, { recoverTerminalExcludedImageAbort: recover });
    t.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "decoration"
      ? Promise.reject(abortError) : send(name, value));
    try {
      t.events.get("Network.requestWillBeSent")!({ requestId: "network-decoration", frameId: "main", loaderId: "root-loader",
        type: "Image", request: { url, method: "GET" } });
      t.request("decoration", { resourceType: "Image", networkId: "network-decoration", request: { url, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "decoration")).toBe(true));
      cancellation.abort();
      await vi.waitFor(() => expect(t.guard.pendingReads).toBe(0), { timeout: 500 });
      expect(t.close).toHaveBeenCalledOnce(); expect(recover).not.toHaveBeenCalled();
      expect(t.guard.firstFatal?.code).toBe("NATIVE_REDIRECT_CANCELLED");
      expect(t.cdp.send.mock.calls.some(([name, value]) => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.getResponseBody"].includes(name) &&
        value?.requestId === "decoration")).toBe(false);
    } finally { await t.guard.close(); }
  });
  it.each([["Script", "SOURCE_ROUTING"], ["Stylesheet", "SOURCE_ROUTING"], ["Script", null], ["Stylesheet", null]] as const)(
    "denies a root-labelled %s in profile %s from a positively owned child Network event without poisoning the main read", async (resourceType, profile) => {
    const t = await prepared(profile);
    try {
      child(t);
      // Chrome can label the Fetch pause with the root while its exact Network
      // request belongs to a child. Network arrives independently one tick later.
      t.request("asset", { resourceType, request: { url: asset, method: "GET", headers: {} } });
      await new Promise(resolve => setTimeout(resolve, 1)); network(t, resourceType);
      await vi.waitFor(() => expect(t.subframes).toHaveLength(1));
      expect(t.cdp.send.mock.calls.filter(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "asset")).toHaveLength(1);
      expect(t.handler).toHaveBeenCalledOnce(); expect(t.routes).toHaveLength(1);
      expect(t.cdp.send.mock.calls.filter(([name, value]) => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.getResponseBody"].includes(name) && value?.requestId === "asset")).toEqual([]);
      expect(t.guard.firstFatal).toBeUndefined(); expect(t.close).not.toHaveBeenCalled(); expect(proof(t)).toBe(true);
    } finally { await t.guard.close(); }
  });
  it("requires the exact abort ACK and keeps the denied pause tombstoned against late responses", async () => {
    const t = await prepared(), ack = deferred<object>(), send = t.cdp.send.getMockImplementation()!;
    t.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "asset" ? ack.promise : send(name, value));
    try {
      child(t); network(t); t.request("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      expect(t.subframes).toEqual([]); expect(t.guard.pendingReads).toBe(1); expect(proof(t)).toBe(true); expect(t.handler).toHaveBeenCalledOnce();
      ack.resolve({}); await vi.waitFor(() => expect(t.subframes).toHaveLength(1));
      expect(t.rejections).toEqual([expect.objectContaining({ code: "NATIVE_REDIRECT_FRAME_UNGUARDED", duplicateRequestId: false })]);
      expect(JSON.stringify(t.rejections)).not.toMatch(/example\.org|"url"|"frameId"|"networkId"|"headers"/u);
      t.response("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce());
      expect(t.handler).toHaveBeenCalledOnce();
    } finally { ack.resolve({}); await t.guard.close(); }
  });
  it("accepts rooted nested-child negative ownership but never adopts its loader", async () => {
    const t = await prepared();
    try {
      child(t, { id: "parent", loaderId: "parent-loader" }); child(t, { parentId: "parent" }); network(t);
      t.request("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.subframes).toHaveLength(1)); expect(proof(t)).toBe(true);
      t.events.get("Network.requestWillBeSent")!({ requestId: "network-root-impostor", frameId: "main", loaderId: "child-loader", type: "Script", request: { url: asset, method: "GET" } });
      t.request("root-impostor", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce()); expect(t.handler).toHaveBeenCalledOnce();
    } finally { await t.guard.close(); }
  });
  it.each(["SOURCE_ROUTING", null] as const)("requires abort ACK despite an exact child terminal while it is pending in profile %s", async profile => {
    const t = await prepared(profile), ack = deferred<object>(), send = t.cdp.send.getMockImplementation()!;
    t.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "asset" ? ack.promise : send(name, value));
    try {
      child(t); network(t); t.request("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      t.events.get("Network.loadingFailed")!({ requestId: "network-asset", type: "Script", canceled: false, errorText: "net::ERR_BLOCKED_BY_CLIENT" });
      await Promise.resolve(); expect(t.subframes).toEqual([]); expect(t.guard.pendingReads).toBe(1); expect(proof(t)).toBe(true);
      ack.resolve({}); await vi.waitFor(() => expect(t.subframes).toHaveLength(1));
      expect(t.close).not.toHaveBeenCalled(); expect(t.handler).toHaveBeenCalledOnce(); expect(t.guard.firstFatal).toBeUndefined(); expect(proof(t)).toBe(true);
    } finally { ack.resolve({}); await t.guard.close(); }
  });
  it("does not use an exact child terminal as a substitute for a rejected abort ACK", async () => {
    const t = await prepared(), ack = deferred<object>(), send = t.cdp.send.getMockImplementation()!;
    t.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "asset" ? ack.promise.then(() => { throw Error("abort rejected"); }) : send(name, value));
    try {
      child(t); network(t); t.request("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      t.events.get("Network.loadingFailed")!({ requestId: "network-asset", type: "Script", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
      ack.resolve({}); await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce()); expect(t.subframes).toEqual([]); expect(t.handler).toHaveBeenCalledOnce();
    } finally { ack.resolve({}); await t.guard.close(); }
  });
  it.each(["no-child", "unrooted", "child-loader", "missing-loader", "root-loader", "detached", "parent-navigated", "wrong-network", "wrong-url", "wrong-method", "wrong-kind", "network-body", "fetch-body", "redirect", "conflict", "document", "XHR", "Fetch", "HEAD"])(
    "does not replace strict correlation with denial-only ownership for %s", async mode => {
      const t = await prepared();
      try {
        if (mode !== "no-child") child(t, mode === "unrooted" ? { parentId: "unknown" } : mode === "root-loader" ? { loaderId: "root-loader" } : {});
        if (mode === "detached") t.events.get("Page.frameDetached")!({ frameId: "child" });
        if (mode === "parent-navigated") {
          child(t, { id: "parent", loaderId: "parent-loader" }); child(t, { parentId: "parent" });
          child(t, { id: "parent", loaderId: "changed-parent-loader" });
        }
        const resourceType = ["document", "XHR", "Fetch"].includes(mode) ? mode === "document" ? "Document" : mode : "Script";
        t.request("asset", { resourceType, ...(mode === "fetch-body" ? { request: { url: asset, method: "GET", headers: {}, hasPostData: true, postData: "x" } }
          : { request: { url: asset, method: mode === "HEAD" ? "HEAD" : "GET", headers: {} } }), ...(mode === "redirect" ? { redirectedRequestId: "unknown" } : {}) });
        network(t, mode === "wrong-kind" ? "Stylesheet" : resourceType, mode === "wrong-network" ? { requestId: "other-network" }
          : mode === "child-loader" ? { loaderId: "unknown-loader" } : mode === "missing-loader" ? { loaderId: undefined }
            : ["wrong-url", "wrong-method", "network-body"].includes(mode) ? { request: { url: mode === "wrong-url" ? asset + "?different" : asset,
              method: mode === "wrong-method" ? "POST" : "GET", ...(mode === "network-body" ? { hasPostData: true, postData: "x" } : {}) } } : {});
        if (mode === "conflict") network(t);
        await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce());
        expect(t.subframes).toEqual([]); expect(t.handler).toHaveBeenCalledOnce();
        expect(t.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "asset")).toBe(false);
      } finally { await t.guard.close(); }
    });
  it.each(["root-before", "root-after", "child-conflict", "finished", "failed"])("cannot heal conflicting or terminal negative facts for %s", async mode => {
    const t = await prepared(null);
    const rootNetwork = () => network(t, "Script", { frameId: "main", loaderId: "root-loader" });
    try {
      child(t); if (mode === "root-before") rootNetwork(); network(t);
      if (mode === "root-after") rootNetwork();
      if (mode === "child-conflict") network(t, "XHR");
      if (mode === "finished") t.events.get("Network.loadingFinished")!({ requestId: "network-asset" });
      if (mode === "failed") t.events.get("Network.loadingFailed")!({ requestId: "network-asset", errorText: "net::ERR_FAILED" });
      t.request("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce()); expect(t.subframes).toEqual([]); expect(t.handler).toHaveBeenCalledOnce();
    } finally { await t.guard.close(); }
  });
  it("retains no child denial authority across an explicit document boundary", async () => {
    const t = await prepared();
    try {
      child(t); network(t); await t.guard.beginDocumentNavigation(t.main as never);
      t.request("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce()); expect(t.subframes).toEqual([]); expect(t.handler).toHaveBeenCalledOnce();
    } finally { await t.guard.close(); }
  });
  it("counts acknowledged child denials against the unchanged request cap", async () => {
    const t = await prepared("SOURCE_ROUTING", 2);
    try {
      child(t); network(t); t.request("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.subframes).toHaveLength(1));
      t.request("extra", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce()); expect(t.failures).toEqual(["NATIVE_REDIRECT_INTERCEPT_LIMIT"]);
      expect(t.handler).toHaveBeenCalledOnce();
    } finally { await t.guard.close(); }
  });
  it.each(["abort-reject", "duplicate", "boundary", "child-navigated", "terminal-wrong-kind", "conflict-after-terminal"])("fails closed on %s while an exact child abort is pending", async mode => {
    const t = await prepared(), ack = deferred<object>(), send = t.cdp.send.getMockImplementation()!;
    t.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "asset"
      ? mode === "abort-reject" ? Promise.reject(Error("closed abort failure")) : ack.promise : send(name, value));
    try {
      child(t); network(t); t.request("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      if (mode === "duplicate") t.request("asset", { resourceType: "Script", request: { url: asset, method: "GET", headers: {} } });
      if (mode === "child-navigated") child(t, { loaderId: "new-child-loader" });
      if (mode === "terminal-wrong-kind") t.events.get("Network.loadingFailed")!({ requestId: "network-asset", type: "XHR", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
      if (mode === "conflict-after-terminal") {
        t.events.get("Network.loadingFailed")!({ requestId: "network-asset", type: "Script", errorText: "net::ERR_BLOCKED_BY_CLIENT" }); network(t);
      }
      const boundary = mode === "boundary" ? t.guard.beginDocumentNavigation(t.main as never).catch(() => {}) : undefined;
      ack.resolve({}); await boundary;
      await vi.waitFor(() => expect(t.close).toHaveBeenCalledOnce());
      expect(t.subframes).toEqual([]); expect(t.handler).toHaveBeenCalledOnce();
    } finally { ack.resolve({}); await t.guard.close(); }
  });
});

describe("fixed caller deny-only uncorrelated POST", () => {
  const url = "https://example.org/public", body = "x".repeat(442);
  const denied = { networkId: undefined, request: { url, method: "POST", headers: { "Content-Type": "application/json" }, hasPostData: true, postData: body } };
  it("aborts a categorically forbidden POST URL only after its exact ACK and without read authority", async () => {
    const policy = vi.fn((request: NativeUncorrelatedPost) => discoveryDefiniteUncorrelatedPostDenial(request, url, isAnonymousBrowserReadPost, () => true));
    const test = await installed(undefined, undefined, undefined, undefined, undefined, undefined, policy);
    const ack = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "forbidden" ? ack.promise : send(name, value));
    try {
      test.request("forbidden", { ...denied, request: { ...denied.request, url: "https://example.org/checkout/" } });
      expect(test.guard.pendingReads).toBe(1); expect(test.handler).not.toHaveBeenCalled();
      ack.resolve({}); await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(policy).toHaveBeenCalledOnce(); expect(test.guard.firstFatal).toBeUndefined(); expect(test.close).not.toHaveBeenCalled();
      expect(test.rejections).toHaveLength(1);
      expect(test.cdp.send.mock.calls.filter(([name, value]) => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.getResponseBody"].includes(name) && value?.requestId === "forbidden")).toEqual([]);
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it("awaits exact denied POST abort ACK without handler authority while an independent native main GET remains provable", async () => {
    const policy = vi.fn((request: NativeUncorrelatedPost) => discoveryDefiniteUncorrelatedPostDenial(request, url, isAnonymousBrowserReadPost, () => true));
    const test = await installed(undefined, undefined, undefined, undefined, undefined, undefined, policy);
    const ack = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "denied" ? ack.promise : send(name, value));
    try {
      await test.guard.beginDocumentNavigation(test.main as never);
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-document", frameId: "main", loaderId: "loader-document", type: "Document", request: { url, method: "GET" } });
      test.request("document", { resourceType: "Document", request: { url, method: "GET", headers: {} } });
      await test.routes[0].continue(); test.response("document", { resourceType: "Document", request: { url, method: "GET", headers: {} }, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
      await test.routes[0].request().response(); test.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "loader-document", url } });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      test.request("denied", denied);
      expect(test.guard.pendingReads).toBe(1); expect(test.handler).toHaveBeenCalledOnce(); expect(test.rejections).toEqual([]);
      // The denied pause is diagnostic-only: no response record, proof or lease can be minted.
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-independent", frameId: "main", loaderId: "loader-document", type: "XHR", request: { url, method: "GET" } });
      test.request("independent", { request: { url, method: "GET", headers: {} } }); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); await test.routes[1].continue(); test.response("independent", { request: { url, method: "GET", headers: {} } });
      await test.routes[1].request().response();
      expect(test.guard.isCurrentCompletedDocumentRead(test.routes[0].request(), test.main as never, { frameId: "main", loaderId: "loader-document", url })).toBe(true);
      ack.resolve({}); await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(policy).toHaveBeenCalledOnce(); expect(test.handler).toHaveBeenCalledTimes(2);
      expect(test.cdp.send.mock.calls.filter(([name, value]) => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.getResponseBody"].includes(name) && value?.requestId === "denied")).toEqual([]);
      expect(test.rejections).toHaveLength(1); expect(test.rejections[0]).toMatchObject({ code: "NATIVE_REDIRECT_REQUEST_REJECTED", networkIdPresent: false, duplicateRequestId: false, recordCount: 2 });
      expect(JSON.stringify(test.rejections)).not.toMatch(/example.org|"postData"|"headers"|"requestId"|"networkId"/u);
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.close).not.toHaveBeenCalled();
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it.each(["allowed", "unknown", "throw", "GET", "documentPOST", "OPTIONS"])("retains missing-ID fatal cleanup for %s", async mode => {
    const policy = vi.fn(() => { if (mode === "throw") throw Error("POLICY_UNKNOWN"); return mode === "allowed" ? false : mode === "unknown" ? undefined as never : true; });
    const test = await installed(undefined, undefined, undefined, undefined, undefined, undefined, policy);
    try {
      test.request("unknown", { ...denied, ...(mode === "documentPOST" ? { resourceType: "Document" } : {}),
        request: { ...denied.request, method: mode === "GET" ? "GET" : mode === "OPTIONS" ? "OPTIONS" : "POST" } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.guard.firstFatal?.code).toBe("NATIVE_REDIRECT_NETWORK_ID_MISSING");
      expect(test.guard.firstFatal).toMatchObject({ missingNetworkClosed: false, missingNetworkAborted: false,
        uncorrelatedPostCallerInvoked: !["GET", "documentPOST", "OPTIONS"].includes(mode), uncorrelatedPostCallerDenied: false });
      expect(test.handler).not.toHaveBeenCalled(); expect(test.rejections).toEqual([]);
      if (["GET", "documentPOST", "OPTIONS"].includes(mode)) expect(policy).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });
  it.each(["missing frame", "malformed headers", "missing body", "large body", "redirect", "empty network"])("validates %s before calling the deny-only policy", async mode => {
    const policy = vi.fn(() => true), test = await installed(undefined, undefined, undefined, undefined, undefined, undefined, policy);
    try {
      const value = structuredClone(denied) as Record<string, unknown> & { request: Record<string, unknown> };
      if (mode === "missing frame") value.frameId = undefined;
      if (mode === "malformed headers") value.request.headers = Array(129).fill("invalid");
      if (mode === "missing body") delete value.request.postData;
      if (mode === "large body") value.request.postData = "x".repeat(32769);
      if (mode === "redirect") value.redirectedRequestId = "parent";
      if (mode === "empty network") value.networkId = "";
      test.request("denied", value); await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      if (["malformed headers", "redirect", "empty network"].includes(mode))
        expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_NETWORK_ID_MISSING", uncorrelatedPostCallerInvoked: false });
      expect(policy).not.toHaveBeenCalled(); expect(test.handler).not.toHaveBeenCalled(); expect(test.rejections).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it.each(["reject", "hang"])("requires the actual denied pause's abort ACK: %s", async mode => {
    vi.useFakeTimers(); const test = await installed(undefined, undefined, undefined, undefined, undefined, undefined, () => true);
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" ? mode === "reject" ? Promise.reject(Error("Protocol abort rejected")) : new Promise(() => {}) : send(name, value));
    try {
      test.request("denied", denied); await vi.advanceTimersByTimeAsync(101);
      expect(test.close).toHaveBeenCalledOnce(); expect(test.rejections).toEqual([]); expect(test.handler).not.toHaveBeenCalled();
      expect(test.guard.firstFatal?.code).toBe(mode === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : "NATIVE_REDIRECT_ROUTING_FAILED");
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });
  it.each(["duplicate", "late response", "rotation"])("never revives a policy-denied interception after %s", async mode => {
    const test = await installed(undefined, undefined, undefined, undefined, undefined, undefined, () => true);
    const ack = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "denied" ? ack.promise : send(name, value));
    try {
      test.request("denied", denied);
      if (mode === "duplicate") test.request("denied", denied);
      if (mode === "rotation") await test.guard.beginDocumentNavigation(test.main as never);
      ack.resolve({}); await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      if (mode === "late response") test.response("denied", denied);
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.handler).not.toHaveBeenCalled();
      expect(test.guard.firstFatal?.code).toBe(mode === "duplicate" ? "NATIVE_REDIRECT_DUPLICATE_FETCH_ID" : mode === "rotation" ? "NATIVE_REDIRECT_LOADER_MISMATCH" : "NATIVE_REDIRECT_RESPONSE_UNKNOWN");
      expect(test.cdp.send.mock.calls.some(([name]) => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.getResponseBody"].includes(name))).toBe(false);
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it("keeps the original interception cap ahead of caller denial", async () => {
    const policy = vi.fn(() => true), test = await installed(1, undefined, undefined, undefined, undefined, undefined, policy);
    try {
      test.request("first", denied); await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      test.request("second", denied); await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(policy).toHaveBeenCalledOnce(); expect(test.guard.firstFatal?.code).toBe("NATIVE_REDIRECT_INTERCEPT_LIMIT"); expect(test.handler).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });
  it("never invokes caller policy or creates a read for an uncorrelated foreign frame", async () => {
    const policy = vi.fn(() => true), test = await installed(undefined, undefined, undefined, undefined, undefined, undefined, policy);
    try {
      test.request("foreign", { ...denied, frameId: "foreign" }); await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(policy).not.toHaveBeenCalled(); expect(test.handler).not.toHaveBeenCalled(); expect(test.subframes).toHaveLength(1);
      expect(test.close).not.toHaveBeenCalled(); expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueRequest")).toBe(false);
    } finally { await test.guard.close(); }
  });
});

describe("closed redirect rejection reasons", () => {
  const root = "https://example.org/first", target = "https://example.org/next";
  it.each(["missing", "unadmitted", "failed", "reserved"] as const)("records the exact initial parent guard: %s", async mode => {
    const test = await installed();
    try {
      if (mode !== "missing") {
        test.request("parent", { request: { url: root, method: "GET", headers: {} } });
        if (mode !== "unadmitted") await test.routes[0].continue();
        if (mode === "failed") test.events.get("Network.loadingFailed")!({ requestId: "network-parent" });
        if (mode === "reserved") {
          test.response("parent", { request: { url: root, method: "GET", headers: {} }, responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
          await test.routes[0].request().response();
          test.request("first-child", { redirectedRequestId: "parent", request: { url: target, method: "GET", headers: {} } });
          await vi.waitFor(() => expect(test.routes).toHaveLength(2));
        }
      }
      test.request("child", { redirectedRequestId: "parent", request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_PROVENANCE_REJECTED", phase: "REDIRECT_PROVENANCE",
        redirectRejection: { missing: "PARENT_MISSING", unadmitted: "PARENT_UNADMITTED", failed: "PARENT_FAILED", reserved: "PARENT_CHILD_RESERVED" }[mode] });
    } finally { await test.guard.close(); }
  });
  it.each(["missing location", "wrong location", "method", "document kind", "cross host"] as const)("records the exact released-parent gate: %s", async mode => {
    const test = await installed(), next = mode === "cross host" ? "https://other.example.net/next" : target;
    try {
      test.request("parent", { request: { url: root, method: "GET", headers: {} } }); await test.routes[0].continue();
      test.response("parent", { request: { url: root, method: "GET", headers: {} }, responseStatusCode: 302,
        responseHeaders: mode === "missing location" ? [] : [{ name: "Location", value: mode === "wrong location" ? target + "/different" : next }] });
      await test.routes[0].request().response();
      test.request("child", { redirectedRequestId: "parent", resourceType: mode === "document kind" ? "Document" : "XHR",
        request: { url: next, method: mode === "method" ? "HEAD" : "GET", headers: {} } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_PROVENANCE_REJECTED", phase: "REDIRECT_PROVENANCE", duplicateRequestId: false,
        redirectRejection: { "missing location": "LOCATION_MISSING", "wrong location": "LOCATION_MISMATCH", method: "METHOD_MISMATCH", "document kind": "DOCUMENT_PARENT_KIND", "cross host": "CROSS_HOST" }[mode] });
      expect(test.routes).toHaveLength(1); expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { await test.guard.close(); }
  });
  it("retains the parent depth guard and never dispatches a sixth redirected child", async () => {
    const test = await installed();
    try {
      for (let n = 0; n <= 5; n++) {
        test.request(`hop-${n}`, { ...(n ? { redirectedRequestId: `hop-${n - 1}` } : {}), request: { url: `${root}/${n}`, method: "GET", headers: {} } });
        await vi.waitFor(() => expect(test.routes).toHaveLength(n + 1)); await test.routes[n].continue();
        test.response(`hop-${n}`, { request: { url: `${root}/${n}`, method: "GET", headers: {} }, responseStatusCode: 302, responseHeaders: [{ name: "Location", value: `${root}/${n + 1}` }] });
        await test.routes[n].request().response();
      }
      test.request("over-depth", { redirectedRequestId: "hop-5", request: { url: `${root}/6`, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.guard.firstFatal?.redirectRejection).toBe("PARENT_DEPTH_LIMIT"); expect(test.routes).toHaveLength(6);
    } finally { await test.guard.close(); }
  });
  it("captures failed parent response while the exact child is waiting without inventing a redirect", async () => {
    const test = await installed();
    try {
      test.request("parent"); await test.routes[0].continue(); test.request("child", { redirectedRequestId: "parent" });
      test.events.get("Network.loadingFailed")!({ requestId: "network-parent" });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.guard.firstFatal?.redirectRejection).toBe("PARENT_RESPONSE_FAILED"); expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });
});

describe("source-only public data redirect provenance", () => {
  const source = "https://example.org/public-data", target = "https://data.example.net/public-data";
  const network = (test: Awaited<ReturnType<typeof installed>>, id: string, url: string, kind: string, method = "GET", body = false) =>
    test.events.get("Network.requestWillBeSent")!({ requestId: id, frameId: "main", loaderId: "loader-source", type: kind,
      request: { url, method, ...(body ? { hasPostData: true, postData: "body" } : {}) } });
  async function prepared(profile: PublicBrowserResponseProfile | undefined, rejectChild = false, parentKind = "XHR", parentUrl = source,
    readPolicy?: (route: NativeReadRoute) => Promise<void>) {
    const test = await installed(undefined, undefined, async route => { if (rejectChild && route.request().url() === target) await route.abort(); await readPolicy?.(route); }, profile);
    await test.guard.beginDocumentNavigation(test.main as never);
    network(test, "network-document", "https://example.org/", "Document");
    test.request("document", { resourceType: "Document", request: { url: "https://example.org/", method: "GET", headers: {} } });
    await test.routes[0].continue(); test.response("document", { resourceType: "Document", request: { url: "https://example.org/", method: "GET", headers: {} }, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
    await test.routes[0].request().response();
    test.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "loader-source", url: "https://example.org/" } });
    network(test, "network-parent", parentUrl, parentKind);
    test.request("parent", { networkId: "network-parent", resourceType: parentKind, request: { url: parentUrl, method: "GET", headers: {} } });
    await vi.waitFor(() => expect(test.routes).toHaveLength(2)); await test.routes[1].continue();
    return test;
  }
  it.each([["XHR", "XHR"], ["Fetch", "Fetch"], ["XHR", "Fetch"], ["Fetch", "XHR"]])("reaches unchanged caller policy only for source-profile %s→%s GET", async (from, to) => {
    const test = await prepared("SOURCE_ROUTING", false, from);
    try {
      test.response("parent", { networkId: "network-parent", resourceType: from, request: { url: source, method: "GET", headers: {} }, responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
      await test.routes[1].request().response(); network(test, "network-parent", target, to);
      test.request("child", { networkId: "network-parent", redirectedRequestId: "parent", resourceType: to, request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3));
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(false);
      await test.routes[2].continue();
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(true);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it("retains caller denial before destination dispatch even with valid source redirect provenance", async () => {
    const test = await prepared("SOURCE_ROUTING", true);
    try {
      test.response("parent", { networkId: "network-parent", request: { url: source, method: "GET", headers: {} }, responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
      await test.routes[1].request().response(); network(test, "network-parent", target, "XHR");
      test.request("child", { networkId: "network-parent", redirectedRequestId: "parent", request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3));
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "child")).toBe(true));
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it.each(["parent", "child", "both"])("delegates existing anonymous bootstrap URL policy for the redirect %s", async side => {
    const from = side === "child" ? source : "https://example.org/AuthenticationSettings?AuthenticationType=",
      to = side === "parent" ? target : "https://data.example.net/AuthenticationSettings?AuthenticationType=";
    for (const url of [from, to].filter(value => value.includes("AuthenticationSettings"))) {
      expect(isSafeRecipeUrl(url)).toBe(false); expect(isSafeBrowserBootstrapReadUrl(url, "xhr", "GET")).toBe(true);
    }
    const test = await prepared("SOURCE_ROUTING", false, "XHR", from);
    try {
      test.response("parent", { networkId: "network-parent", request: { url: from, method: "GET", headers: {} }, responseStatusCode: 302, responseHeaders: [{ name: "Location", value: to }] });
      await test.routes[1].request().response(); network(test, "network-parent", to, "XHR");
      test.request("child", { networkId: "network-parent", redirectedRequestId: "parent", request: { url: to, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3));
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(false);
      await test.routes[2].continue(); expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it.each(["https://data.example.net/account", "https://data.example.net/checkout", "https://data.example.net/public?token=private", "https://127.0.0.1/public"])(
    "leaves unsafe final URL rejection to caller before dispatch: %s", async url => {
      const policy = vi.fn(async (route: NativeReadRoute) => {
        const request = route.request();
        if (!isSafeRecipeUrl(request.url()) && !isSafeBrowserBootstrapReadUrl(request.url(), request.resourceType(), request.method())) await route.abort();
      });
      const test = await prepared("SOURCE_ROUTING", false, "XHR", source, policy);
      try {
        test.response("parent", { networkId: "network-parent", request: { url: source, method: "GET", headers: {} }, responseStatusCode: 302, responseHeaders: [{ name: "Location", value: url }] });
        await test.routes[1].request().response(); network(test, "network-parent", url, "XHR");
        test.request("child", { networkId: "network-parent", redirectedRequestId: "parent", request: { url, method: "GET", headers: {} } });
        await vi.waitFor(() => expect(test.routes).toHaveLength(3));
        await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "child")).toBe(true));
        expect(policy).toHaveBeenCalledTimes(3); expect(test.close).not.toHaveBeenCalled();
        expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(false);
      } finally { await test.guard.close(); }
    });
  it.each(["default", "HEAD", "POST", "body", "missing location", "wrong location", "network", "loader", "frame"])("still rejects %s before source data destination handler", async mode => {
    const test = await prepared(mode === "default" ? undefined : "SOURCE_ROUTING"), url = target;
    try {
      test.response("parent", { networkId: "network-parent", request: { url: source, method: "GET", headers: {} }, responseStatusCode: 302,
        responseHeaders: mode === "missing location" ? [] : [{ name: "Location", value: mode === "wrong location" ? target + "/other" : url }] });
      await test.routes[1].request().response();
      const id = mode === "network" ? "network-other" : "network-parent", method = mode === "HEAD" ? "HEAD" : mode === "POST" ? "POST" : "GET";
      test.events.get("Network.requestWillBeSent")!({ requestId: id, frameId: mode === "frame" ? "foreign" : "main", loaderId: mode === "loader" ? "foreign" : "loader-source", type: "XHR", request: { url, method, ...(mode === "body" ? { hasPostData: true, postData: "body" } : {}) } });
      test.request("child", { networkId: id, redirectedRequestId: "parent", request: { url, method, headers: {}, ...(mode === "body" ? { hasPostData: true, postData: "body" } : {}) } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.routes).toHaveLength(2);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(false);
    } finally { await test.guard.close(); }
  });
});

describe("current completed native main-document read", () => {
  const url = "https://booking.example.org/", spa = "https://booking.example.org/book-a-tee-time/";
  async function prepared(ack?: ReturnType<typeof deferred<object>>, drain?: ReturnType<typeof deferred<void>>) {
    const test = await installed(undefined, undefined, async () => { if (drain) await drain.promise; });
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueResponse" && ack ? ack.promise : send(name, value));
    await test.guard.beginDocumentNavigation(test.main as never);
    test.events.get("Network.requestWillBeSent")!({ requestId: "document-network", frameId: "main", loaderId: "document-loader", type: "Document",
      request: { url, method: "GET", headers: {} } });
    const values = { networkId: "document-network", resourceType: "Document", request: { url, method: "GET", headers: {} } };
    test.request("document", values); await vi.waitFor(() => expect(test.routes).toHaveLength(1)); await test.routes[0].continue();
    test.response("document", { ...values, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
    await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(true));
    test.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "document-loader", url } });
    const request = test.routes[0].request(), captured = (current = url) => ({ frameId: "main", loaderId: "document-loader", url: current });
    const current = (value = captured()) => test.guard.isCurrentCompletedDocumentRead(request, test.main as never, value);
    return { ...test, request, captured, current };
  }
  it("requires the actual response ACK and handler drain before retaining a same-loader history transition", async () => {
    const ack = deferred<object>(), drain = deferred<void>(), test = await prepared(ack, drain);
    try {
      expect(test.current()).toBe(false); ack.resolve({}); await test.request.response(); expect(test.current()).toBe(false);
      drain.resolve(); await vi.waitFor(() => expect(test.current()).toBe(true));
      expect(test.current(test.captured(spa))).toBe(false);
      test.events.get("Page.navigatedWithinDocument")!({ frameId: "foreign", url: spa }); expect(test.current(test.captured(spa))).toBe(false);
      test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: spa }); expect(test.current(test.captured(spa))).toBe(true);
      expect(test.current()).toBe(false); expect(test.request.url()).toBe(url);
      expect(attestedNativeDocumentRedirects(test.request, new Set([url]))).toBeUndefined();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { ack.resolve({}); drain.resolve(); await test.guard.close(); }
  });
  it.each(["foreign frame", "foreign loader", "copied request", "foreign owner", "identity revised", "network failed", "unsafe", "foreign URL", "boundary", "closed"])(
    "rejects %s without replacing transport evidence", async mode => {
      const test = await prepared(), foreign = mode === "foreign owner" ? await installed() : undefined;
      try {
        await test.request.response(); await vi.waitFor(() => expect(test.current()).toBe(true));
        test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: spa }); const captured = test.captured(spa);
        if (mode === "foreign frame") captured.frameId = "foreign";
        if (mode === "foreign loader") captured.loaderId = "foreign";
        if (mode === "identity revised") test.events.get("Network.requestWillBeSent")!({ requestId: "document-network", frameId: "main", loaderId: "document-loader", type: "Document", request: { url, method: "GET", headers: {} } });
        if (mode === "network failed") test.events.get("Network.loadingFailed")!({ requestId: "document-network" });
        if (mode === "unsafe" || mode === "foreign URL") { captured.url = mode === "unsafe" ? "https://booking.example.org/account" : "https://other.example.org/public";
          test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: captured.url }); }
        if (mode === "boundary") await test.guard.beginDocumentNavigation(test.main as never);
        if (mode === "closed") await test.guard.close();
        const guard = foreign?.guard ?? test.guard;
        const request = mode === "copied request" ? { ...test.request } : test.request;
        expect(guard.isCurrentCompletedDocumentRead(request, test.main as never, captured)).toBe(false);
      } finally { await test.guard.close(); await foreign?.guard.close(); }
    });
});

describe("closed continuation request lifecycle diagnostics", () => {
  it("captures exact failed request role before wrapping without changing the thrown error", async () => {
    const facts: NativeRequestDiagnostic[] = [], test = await installed(undefined, undefined, undefined, "SOURCE_ROUTING", value => facts.push(value));
    const original = new Error("OWNED_STAGEHAND_CDP_UNAVAILABLE"), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueRequest" ? Promise.reject(original) : send(name, value));
    try {
      test.request("closed-request"); await vi.waitFor(() => expect(test.routes).toHaveLength(1));
      await expect(test.routes[0].continue()).rejects.toBe(original);
      expect(facts).toHaveLength(1); expect(facts[0]).toMatchObject({ code: "OWNED_STAGEHAND_CDP_UNAVAILABLE", phase: "CONTINUE_REQUEST_ACK", method: "GET", resourceType: "xhr", rootFrame: true,
        recordGenerationCurrent: true, recordGenerationRetired: false, recordAdmitted: true, recordPaused: false, recordFailed: false, recordComplete: false, recordTerminalObserved: false });
      expect(JSON.stringify(facts)).not.toMatch(/example.org|closed-request|"networkId":|"url":|"headers":/u);
      expect(test.close).not.toHaveBeenCalled(); expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it("never lets a diagnostic listener replace the primary continuation failure or invent a CDP cause", async () => {
    const facts = vi.fn(() => { throw Error("PRIVATE_LISTENER"); }), test = await installed(undefined, undefined, undefined, "SOURCE_ROUTING", facts);
    const original = new Error("OWNED_STAGEHAND_CDP_UNAVAILABLE"), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueRequest" ? Promise.reject(original) : send(name, value));
    try {
      test.request("one"); await vi.waitFor(() => expect(test.routes).toHaveLength(1)); await expect(test.routes[0].continue()).rejects.toBe(original); expect(facts).toHaveBeenCalledOnce();
      facts.mockClear(); const unknown = new Error("PRIVATE_UNKNOWN_COMMAND_ERROR");
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueRequest" ? Promise.reject(unknown) : send(name, value));
      test.request("two"); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); await expect(test.routes[1].continue()).rejects.toBe(unknown); expect(facts).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });
});

describe("source-only confirmed uncorrelated denial", () => {
  const unknown = { networkId: undefined, request: { url: "https://example.org/unclassified?private=not-retained", method: "POST", headers: {}, hasPostData: true, postData: "not-availability-evidence" } };
  it("waits for exact abort ACK, grants no handler/data authority, and leaves independent public reads usable", async () => {
    const test = await installed(undefined, undefined, undefined, "SOURCE_ROUTING"), ack = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "uncorrelated" ? ack.promise : send(name, value));
    try {
      test.request("uncorrelated", unknown);
      expect(test.guard.pendingReads).toBe(1); expect(test.handler).not.toHaveBeenCalled(); expect(test.rejections).toEqual([]);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest")).toEqual([["Fetch.failRequest", { requestId: "uncorrelated", errorReason: "BlockedByClient" }]]);
      ack.resolve({}); await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.failures).toEqual([]); expect(test.close).not.toHaveBeenCalled();
      expect(test.rejections).toHaveLength(1); expect(test.rejections[0]).toMatchObject({ code: "NATIVE_REDIRECT_NETWORK_ID_MISSING", networkIdPresent: false, duplicateRequestId: false, recordCount: 0 });
      expect(JSON.stringify(test.rejections)).not.toMatch(/example.org|unclassified|private|not-availability/);
      test.request("independent"); await test.routes[0].continue(); const response = test.routes[0].request().response(); test.response("independent");
      expect((await response)?.status()).toBe(200); expect(test.handler).toHaveBeenCalledOnce();
      expect(test.cdp.send.mock.calls.filter(([name, value]) => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.getResponseBody"].includes(name) && value?.requestId === "uncorrelated")).toEqual([]);
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it("keeps the default native reader fatal for the same event", async () => {
    const test = await installed(); try { test.request("uncorrelated", unknown); await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_NETWORK_ID_MISSING"));
      expect(test.handler).not.toHaveBeenCalled(); expect(test.rejections).toEqual([]); expect(test.close).toHaveBeenCalledOnce();
    } finally { await test.guard.close(); }
  });
  it.each(["concurrent", "reused", "late response"])("tombstone rejects %s work without any continuation", async mode => {
    const test = await installed(undefined, undefined, undefined, "SOURCE_ROUTING"), ack = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "uncorrelated" ? ack.promise : send(name, value));
    try { test.request("uncorrelated", unknown); if (mode !== "concurrent") { ack.resolve({}); await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0)); }
      if (mode === "late response") test.response("uncorrelated", unknown); else test.request("uncorrelated", unknown);
      ack.resolve({}); await vi.waitFor(() => expect(test.failures).toContain(mode === "late response" ? "NATIVE_REDIRECT_RESPONSE_UNKNOWN" : "NATIVE_REDIRECT_DUPLICATE_FETCH_ID"));
      if (mode !== "late response") expect(test.guard.firstFatal?.duplicateRequestId).toBe(true);
      expect(test.handler).not.toHaveBeenCalled(); expect(test.close).toHaveBeenCalledOnce();
      expect(test.cdp.send.mock.calls.some(([name]) => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.getResponseBody"].includes(name))).toBe(false);
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it.each(["reject", "hang", "abort"])("retains fatal cleanup for abort ACK %s", async mode => {
    vi.useFakeTimers(); const control = new AbortController(), test = await installed(undefined, control.signal, undefined, "SOURCE_ROUTING"), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" ? mode === "reject" ? Promise.reject(Error("abort rejected")) : new Promise(() => {}) : send(name, value));
    try { test.request("uncorrelated", unknown); if (mode === "abort") control.abort(); await vi.advanceTimersByTimeAsync(101);
      expect(test.close).toHaveBeenCalledOnce(); expect(test.rejections).toEqual([]); expect(test.handler).not.toHaveBeenCalled(); expect(test.failures.length).toBeGreaterThan(0);
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });
  it.each(["empty id", "empty network", "redirect", "frame missing", "unknown resource", "unknown method", "body missing", "body malformed", "body overlimit", "headers overlimit", "headers malformed", "url malformed"])("keeps malformed/uncertain %s fatal", async mode => {
    const test = await installed(undefined, undefined, undefined, "SOURCE_ROUTING");
    const value = structuredClone(unknown) as Record<string, unknown> & { request: Record<string, unknown> };
    if (mode === "empty network") value.networkId = "";
    if (mode === "redirect") value.redirectedRequestId = "unknown-parent";
    if (mode === "frame missing") value.frameId = undefined;
    if (mode === "unknown resource") value.resourceType = "Unexpected";
    if (mode === "unknown method") value.request.method = "UNEXPECTED";
    if (mode === "body missing") delete value.request.postData;
    if (mode === "body malformed") value.request.postData = {};
    if (mode === "body overlimit") value.request.postData = "x".repeat(32769);
    if (mode === "headers overlimit") value.request.headers = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`X-${i}`, "value"]));
    if (mode === "headers malformed") value.request.headers = { Unexpected: {} };
    if (mode === "url malformed") value.request.url = "not a URL";
    try { test.request(mode === "empty id" ? "" : "uncorrelated", value); await vi.waitFor(() => expect(test.failures.length).toBeGreaterThan(0));
      expect(test.close).toHaveBeenCalledOnce(); expect(test.rejections).toEqual([]); expect(test.handler).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });
  it("retains intercept accounting for denied IDs and cannot hide a later actual fatal cause", async () => {
    const test = await installed(2, undefined, undefined, "SOURCE_ROUTING");
    try { test.request("one", unknown); test.request("two", unknown); await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.rejections).toHaveLength(2); expect(test.guard.firstFatal).toBeUndefined();
      test.request("over", unknown); await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_INTERCEPT_LIMIT"));
      expect(test.guard.firstFatal?.code).toBe("NATIVE_REDIRECT_INTERCEPT_LIMIT"); expect(test.handler).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });
});

describe("native response limit metadata", () => {
  it("captures one private official-render GET XHR byte cap before continuation without selecting source routing behavior", async () => {
    const test=await installed(undefined,undefined,async route=>{ expect(route.admitOfficialRenderDataLimit?.()).toBe(true); });
    const original=test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation(async(method,value)=>method==="Fetch.getResponseBody"
      ? {body:"x".repeat(15_187_944),base64Encoded:false} : original(method,value));
    try {
      test.request("official-render");await vi.waitFor(()=>expect(test.routes).toHaveLength(1));
      await test.routes[0].continue();expect(test.routes[0].admitOfficialRenderDataLimit?.()).toBe(false);
      test.response("official-render",{responseHeaders:[{name:"Content-Length",value:"1082366"}]});
      const response=await test.routes[0].request().response();expect((await response!.body()).length).toBe(15_187_944);
      expect(test.guard.firstFatal).toBeUndefined();expect(test.close).not.toHaveBeenCalled();
    } finally {await test.guard.close();}
  });
  it("does not accept a private cap bit when the source routing profile already owns the session",async()=>{
    const test=await installed(undefined,undefined,async route=>{expect(route.admitOfficialRenderDataLimit?.()).toBe(false);},"SOURCE_ROUTING");
    try{test.request("source");await vi.waitFor(()=>expect(test.routes).toHaveLength(1));await test.routes[0].abort();}
    finally{await test.guard.close();}
  });
  it.each(["Document","Script"])("keeps private official-render cap unavailable for %s",async kind=>{
    const test=await installed(undefined,undefined,async route=>{expect(route.admitOfficialRenderDataLimit?.()).toBe(false);});
    try{test.request("other-kind",{resourceType:kind});await vi.waitFor(()=>expect(test.routes).toHaveLength(1));await test.routes[0].abort();}
    finally{await test.guard.close();}
  });
  it("keeps the 16 MB response and 48 MB total caps after private byte admission",async()=>{
    const gate = { nativeTransport: true, mainFrame: true, navigationRequestPresent: true, navigationStatus200: true,
      witnessPresent: true, witnessRequestMatches: true, witnessUrlMatches: true, completedDocumentRead: true,
      officialRootProof: true, officialSubpageProof: false, pendingSubpagePresent: false, subpageTokenPresent: false,
      linkCount: "ONE", linkFailure: "PENDING_SET", url: "https://private.example/?token=SECRET" } as const;
    const test=await installed(undefined,undefined,async route=>{
      route.noteOfficialRenderGate?.(gate);
      expect(route.admitOfficialRenderDataLimit?.()).toBe(true);
    });
    const original=test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation(async(method,value)=>method==="Fetch.getResponseBody"
      ? {body:"x".repeat(16_000_001),base64Encoded:false} : original(method,value));
    try{
      test.request("over-cap");await vi.waitFor(()=>expect(test.routes).toHaveLength(1));await test.routes[0].continue();test.response("over-cap");
      await vi.waitFor(()=>expect(test.guard.firstFatal?.limitKind).toBe("DECODED_BODY"));
      expect(test.guard.firstFatal?.allowedBytes).toBe(16_000_000);expect(test.guard.firstFatal?.bodyBytes).toBe(16_000_001);
      expect(test.guard.firstFatal).toMatchObject({ limitOrigin: "NATIVE_ROUTER", officialRenderDataLimit: true,
        recordGenerationCurrent: true, recordGenerationRetired: false, officialRenderGate: { linkCount: "ONE", linkFailure: "PENDING_SET" } });
      expect(JSON.stringify(test.guard.firstFatal)).not.toMatch(/SECRET|https:|"url":/u);
    }finally{await test.guard.close();}
  });
  it("does not grant a larger body cap from closed anchor failure diagnostics",async()=>{
    const gate = { nativeTransport: true, mainFrame: true, navigationRequestPresent: true, navigationStatus200: true,
      witnessPresent: true, witnessRequestMatches: true, witnessUrlMatches: true, completedDocumentRead: true,
      officialRootProof: false, officialSubpageProof: false, pendingSubpagePresent: false, subpageTokenPresent: false,
      linkCount: "MULTIPLE", linkFailure: "LINK_COUNT", anchorFailure: "NOT_RENDERED", anchorOrdinal: "SECOND" } as const;
    const test=await installed(undefined,undefined,async route=>{route.noteOfficialRenderGate?.(gate);});
    const original=test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation(async(method,value)=>method==="Fetch.getResponseBody"
      ? {body:"x".repeat(2_000_001),base64Encoded:false} : original(method,value));
    try{
      test.request("closed-only");await vi.waitFor(()=>expect(test.routes).toHaveLength(1));await test.routes[0].continue();test.response("closed-only");
      await vi.waitFor(()=>expect(test.guard.firstFatal?.limitKind).toBe("DECODED_BODY"));
      expect(test.guard.firstFatal).toMatchObject({allowedBytes:2_000_000,officialRenderDataLimit:false,
        officialRenderGate:{anchorFailure:"NOT_RENDERED",anchorOrdinal:"SECOND"}});
    }finally{await test.guard.close();}
  });
  it.each([undefined, "SOURCE_ROUTING"] as const)("applies fixed source allocation only with explicit profile=%s", async profile => {
    const test = await installed(undefined, undefined, undefined, profile), original = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation(async (method, value) => method === "Fetch.getResponseBody" ? { body: "x".repeat(15_170_216), base64Encoded: false } : original(method, value));
    try {
      test.request("source-data"); await vi.waitFor(() => expect(test.routes).toHaveLength(1)); await test.routes[0].continue();
      test.response("source-data", { responseHeaders: [{ name: "Content-Length", value: "1079018" }] });
      if (profile) {
        const response = await test.routes[0].request().response(); expect((await response!.body()).length).toBe(15_170_216);
        expect(test.guard.firstFatal).toBeUndefined(); expect(test.close).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(test.guard.firstFatal?.limitKind).toBe("DECODED_BODY"));
        expect(test.guard.firstFatal?.allowedBytes).toBe(2_000_000);
      }
    } finally { await test.guard.close(); }
  });
  it("still rejects source XHR above 16MB and rejects an unknown profile before creating a CDP session", async () => {
    const context = vi.fn();
    await expect(Reflect.apply(installNativeRedirectRouting, undefined, [{ context }, async () => {}, { responseProfile: "UNKNOWN" }])).rejects.toThrow("PUBLIC_READ_RESPONSE_PROFILE_INVALID");
    expect(context).not.toHaveBeenCalled();
    const test = await installed(undefined, undefined, undefined, "SOURCE_ROUTING"), original = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation(async (method, value) => method === "Fetch.getResponseBody" ? { body: "x".repeat(16_000_001), base64Encoded: false } : original(method, value));
    try {
      test.request("large"); await vi.waitFor(() => expect(test.routes).toHaveLength(1)); await test.routes[0].continue(); test.response("large");
      await vi.waitFor(() => expect(test.guard.firstFatal?.allowedBytes).toBe(16_000_000));
      expect(test.guard.firstFatal?.limitKind).toBe("DECODED_BODY"); expect(test.guard.firstFatal?.bodyBytes).toBe(16_000_001);
    } finally { await test.guard.close(); }
  });
  it.each(["not-a-number", "-1", "Infinity"])("records invalid declared length without preserving raw headers: %s", async length => {
    const test = await installed();
    try {
      test.request("limit"); await vi.waitFor(() => expect(test.routes).toHaveLength(1)); await test.routes[0].continue();
      test.response("limit", { responseHeaders: [{ name: "Content-Length", value: length }] });
      await vi.waitFor(() => expect(test.guard.lastFailure).toBe("NATIVE_RESPONSE_LIMIT"));
      expect(test.guard.firstFatal).toEqual({ code: "NATIVE_RESPONSE_LIMIT", limitKind: "DECLARED_INVALID", limitOrigin: "NATIVE_ROUTER",
        officialRenderDataLimit: false, recordGenerationCurrent: true, recordGenerationRetired: false,
        method: "GET", resourceType: "xhr", allowedBytes: 2_000_000,
        totalBytes: 0, declaredLengthPresent: true, documentResponse: false, ancillaryResponse: false });
      expect(test.cdp.send.mock.calls.some(([method]) => method === "Fetch.getResponseBody")).toBe(false);
      expect(test.close).toHaveBeenCalledOnce();
    } finally { await test.guard.close(); }
  });
  it("distinguishes declared per-resource rejection from a decoded body rejection without changing either cap", async () => {
    for (const declared of [2_000_001, 128]) {
      const test = await installed();
      const original = test.cdp.send.getMockImplementation()!;
      test.cdp.send.mockImplementation(async (method, value) => method === "Fetch.getResponseBody" ? { body: "x".repeat(2_000_001), base64Encoded: false } : original(method, value));
      try {
        test.request("limit"); await vi.waitFor(() => expect(test.routes).toHaveLength(1)); await test.routes[0].continue();
        test.response("limit", { responseHeaders: [{ name: "Content-Length", value: String(declared) }] });
        await vi.waitFor(() => expect(test.guard.lastFailure).toBe("NATIVE_RESPONSE_LIMIT"));
        expect(test.guard.firstFatal).toEqual({ code: "NATIVE_RESPONSE_LIMIT", limitKind: declared > 2_000_000 ? "DECLARED_TOO_LARGE" : "DECODED_BODY",
          limitOrigin: "NATIVE_ROUTER", officialRenderDataLimit: false, recordGenerationCurrent: true, recordGenerationRetired: false,
          method: "GET", resourceType: "xhr", allowedBytes: 2_000_000, declaredBytes: declared, ...(declared > 2_000_000 ? {} : { bodyBytes: 2_000_001 }),
          totalBytes: declared > 2_000_000 ? 0 : 2_000_001, declaredLengthPresent: true, documentResponse: false, ancillaryResponse: false });
        expect(test.cdp.send.mock.calls.some(([method]) => method === "Fetch.continueResponse")).toBe(false);
      } finally { await test.guard.close(); }
    }
  });
  it.each(["Script", "XHR"])("records the unchanged total decoded cap independently from source/script allocation: %s", async kind => {
    const test = await installed(undefined, undefined, undefined, kind === "XHR" ? "SOURCE_ROUTING" : undefined); const original = test.cdp.send.getMockImplementation()!;
    const body = "x".repeat(13_000_000);
    test.cdp.send.mockImplementation(async (method, value) => method === "Fetch.getResponseBody" ? { body, base64Encoded: false } : original(method, value));
    try {
      for (let index = 0; index < 4; index++) {
        const id = "script-" + index;
        test.request(id, { resourceType: kind }); await vi.waitFor(() => expect(test.routes).toHaveLength(index + 1)); await test.routes[index].continue();
        test.response(id, { resourceType: kind });
        if (index < 3) await test.routes[index].request().response();
      }
      await vi.waitFor(() => expect(test.guard.lastFailure).toBe("NATIVE_RESPONSE_LIMIT"));
      expect(test.guard.firstFatal).toEqual({ code: "NATIVE_RESPONSE_LIMIT", limitKind: "TOTAL_DECODED", limitOrigin: "NATIVE_ROUTER",
        officialRenderDataLimit: false, recordGenerationCurrent: true, recordGenerationRetired: false,
        method: "GET", resourceType: kind === "Script" ? "script" : "xhr", allowedBytes: 48_000_000,
        declaredBytes: 0, bodyBytes: 13_000_000, totalBytes: 52_000_000, declaredLengthPresent: false, documentResponse: false, ancillaryResponse: kind === "Script" });
      expect(test.cdp.send.mock.calls.filter(([method]) => method === "Fetch.continueResponse")).toHaveLength(3);
    } finally { await test.guard.close(); }
  });
});

describe("native private public-client header proofs", () => {
  it("projects exactly the installed structured CORS error union plus a closed OTHER category", () => {
    const protocol = readFileSync("node_modules/playwright-core/types/protocol.d.ts", "utf8");
    const match = protocol.match(/export type CorsError = ([^;]+);/u);
    expect(match).not.toBeNull();
    const allowed = match![1].split("|").map(value => JSON.parse(value));
    expect(allowed).toHaveLength(28); expect(nativeSourceLoadingFailedCorsErrors).toEqual([...allowed, "OTHER"]);
  });
  const documentUrl = "https://booking.example.org/calendar", scriptUrl = "https://booking.example.org/main.js";
  const apiUrl = "https://api.example.org/public/calendar", literal = "public-display-literal";
  const readHeaders = { Accept: "application/json", Authorization: "Bearer null", "x-api-key": literal };
  const scriptBody = `function intercept(r){return r.clone({setHeaders:merge({"x-api-key":"${literal}"},other)});}`;
  async function prepared(ack?: ReturnType<typeof deferred<object>>, afterRoute?: (route: NativeReadRoute) => Promise<void>,
    urls = { document: documentUrl, script: scriptUrl }) {
    const test = await installed(undefined, undefined, afterRoute);
    const original = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation(async (name, value) => {
      if (name === "Fetch.getResponseBody" && value?.requestId === "public-script") return { body: scriptBody, base64Encoded: false };
      if (name === "Fetch.continueResponse" && value?.requestId === "public-script" && ack) return await ack.promise;
      return await original(name, value);
    });
    await test.guard.beginDocumentNavigation(test.main as never);
    const network = (id: string, url: string, type: string, method = "GET", headers: Record<string, string> = {}) =>
      test.events.get("Network.requestWillBeSent")!({ requestId: id, loaderId: "current-loader", frameId: "main", type,
        request: { url, method, headers } });
    network("document-network", urls.document, "Document");
    test.request("public-document", { networkId: "document-network", resourceType: "Document", request: { url: urls.document, method: "GET", headers: {} } });
    await test.routes[0].continue();
    test.response("public-document", { networkId: "document-network", resourceType: "Document", request: { url: urls.document, method: "GET", headers: {} },
      responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
    await test.routes[0].request().response();
    test.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "current-loader", url: urls.document } });
    network("script-network", urls.script, "Script");
    test.request("public-script", { networkId: "script-network", resourceType: "Script", request: { url: urls.script, method: "GET", headers: {} } });
    await test.routes[1].continue();
    test.response("public-script", { networkId: "script-network", resourceType: "Script", request: { url: urls.script, method: "GET", headers: {} },
      responseHeaders: [{ name: "Content-Type", value: "text/javascript" }] });
    if (!ack) await test.routes[1].request().response();
    const get = async (headers: Record<string, string> = readHeaders, method = "GET") => {
      const index = test.routes.length;
      network("actual-network", apiUrl, "Fetch", method, headers);
      test.request("actual-read", { networkId: "actual-network", resourceType: "Fetch", request: { url: apiUrl, method, headers } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(index + 1)); return test.routes[index];
    };
    return { ...test, network, get };
  }

  it.each(["same", "different", "missing", "source-origin-missing", "fetch-origin-missing"] as const)("binds public tee-sheet POST preflight and actual body without rewriting: %s", bodyMode => {
    return (async () => {
      const doc = "https://app.membersports.com/tee-times/21/34/0";
      const url = "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes";
      const data = { configurationTypeId: 0, date: "2026-10-23", golfClubGroupId: 0, golfClubId: 21, golfCourseId: 34, groupSheetTypeId: 0 };
      const body = JSON.stringify(data), actualBody = bodyMode === "different" ? JSON.stringify({ ...data, date: "2026-10-24" }) : body;
      const headers = { ...readHeaders, "Content-Type": "application/json", Origin: "https://app.membersports.com" };
      const sourceHeaders = bodyMode === "source-origin-missing" ? Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "Origin")) : headers;
      const fetchHeaders = bodyMode === "fetch-origin-missing" ? Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "Origin")) : headers;
      const test = await prepared(undefined, undefined, { document: doc, script: "https://app.membersports.com/main.js" });
      try {
        test.events.get("Network.requestWillBeSent")!({ requestId: "sheet-network", loaderId: "current-loader", frameId: "main", type: "Fetch",
          request: { url, method: "POST", headers: sourceHeaders, hasPostData: true, ...(bodyMode === "missing" ? {} : { postData: body }) } });
        test.events.get("Network.requestWillBeSent")!({ requestId: "sheet-options-network", loaderId: "", type: "Other",
          initiator: { type: "preflight", requestId: "sheet-network" }, request: { url, method: "OPTIONS", headers: {} } });
        test.request("sheet-options", { networkId: "sheet-options-network", resourceType: "Other", request: { url, method: "OPTIONS", headers: {
          Origin: "https://app.membersports.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,x-api-key" } } });
        await vi.waitFor(() => expect(test.routes).toHaveLength(3));
        const options = test.routes[2], preflight = await authorizePublicClientReadHeaders(options.request());
        if (bodyMode === "missing") expect(preflight).toBeNull();
        else {
          expect(preflight).not.toBeNull();
          expect(nativePublicClientPreflightMethod(options.request(), preflight!)).toBe("POST");
          await options.continue();
        }
        test.request("sheet-read", { networkId: "sheet-network", resourceType: "Fetch", request: { url, method: "POST", headers: fetchHeaders, hasPostData: true, postData: actualBody } });
        await vi.waitFor(() => expect(test.routes).toHaveLength(4));
        const actual = test.routes[3], proof = await authorizePublicClientReadHeaders(actual.request());
        if (bodyMode === "same" || bodyMode === "source-origin-missing") {
          expect(proof).not.toBeNull(); expect(isCurrentPublicClientReadHeaders(proof!)).toBe(true);
          await actual.continue();
          expect(test.cdp.send.mock.calls.find(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "sheet-read"))
            .toEqual(["Fetch.continueRequest", { requestId: "sheet-read" }]);
        } else expect(proof).toBeNull();
      } finally { await test.guard.close(); }
    })();
  });
  it.each(["GET", "HEAD"])("authorizes only the current actual %s adapter and continues unchanged", async method => {
    const test = await prepared();
    try {
      const route = await test.get(readHeaders, method), proof = await authorizePublicClientReadHeaders(route.request());
      expect(proof).not.toBeNull(); expect(Object.keys(proof!)).toEqual([]); expect(isCurrentPublicClientReadHeaders(proof!)).toBe(true);
      expect(publicClientReadHeaderProofFailure(proof!)).toBeNull();
      expect(nativePublicClientPreflightMethod(route.request(), proof!)).toBeNull();
      expect(await authorizePublicClientReadHeaders({ ...route.request() })).toBeNull();
      await route.continue();
      expect(test.cdp.send.mock.calls.find(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "actual-read"))
        .toEqual(["Fetch.continueRequest", { requestId: "actual-read" }]);
    } finally { await test.guard.close(); }
  });
  it("waits outside dispatch for the exact in-flight script response ACK, without early authority", async () => {
    const ack = deferred<object>(), test = await prepared(ack);
    try {
      const route = await test.get(); let settled = false;
      const proof = authorizePublicClientReadHeaders(route.request()).then(value => { settled = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 5)); expect(settled).toBe(false);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "actual-read")).toBe(false);
      ack.resolve({}); const actual = await proof; expect(actual).not.toBeNull(); expect(isCurrentPublicClientReadHeaders(actual!)).toBe(true);
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it("never publishes a script whose exact read fails while its response ACK is held", async () => {
    const ack = deferred<object>(), test = await prepared(ack);
    try {
      const route = await test.get(), proof = authorizePublicClientReadHeaders(route.request());
      test.events.get("Network.loadingFailed")!({ requestId: "script-network" });
      expect(await proof).toBeNull(); ack.resolve({});
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(await authorizePublicClientReadHeaders(route.request())).toBeNull();
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "actual-read")).toBe(false);
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it.each(["wrong-key", "real-token", "case-duplicate", "proxy-auth", "session-companion"])("does not authorize actual header mismatch: %s", async fault => {
    const test = await prepared();
    try {
      const headers: Record<string, string> = { ...readHeaders };
      if (fault === "wrong-key") headers["x-api-key"] = "other-display-literal";
      if (fault === "real-token") headers.Authorization = "Bearer real-value";
      if (fault === "case-duplicate") headers["X-API-Key"] = literal;
      if (fault === "proxy-auth") headers["Proxy-Authorization"] = "do-not-expose";
      if (fault === "session-companion") headers["x-session-id"] = "do-not-expose";
      const route = await test.get(headers); expect(await authorizePublicClientReadHeaders(route.request())).toBeNull();
    } finally { await test.guard.close(); }
  });
  it.each(["GET", "HEAD"])("uses only the exact private %s identity for OPTIONS before its Fetch pause", async method => {
    const test = await prepared();
    try {
      test.network("original-get", apiUrl, "Fetch", method, readHeaders);
      test.events.get("Network.requestWillBeSent")!({ requestId: "options-network", loaderId: "", type: "Other",
        initiator: { type: "preflight", requestId: "original-get" }, request: { url: apiUrl, method: "OPTIONS", headers: {} } });
      test.request("public-options", { networkId: "options-network", resourceType: "Other", request: { url: apiUrl, method: "OPTIONS", headers: {
        Origin: "https://booking.example.org", "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization,x-api-key" } } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3));
      const route = test.routes[2], proof = await authorizePublicClientReadHeaders(route.request());
      expect(proof).not.toBeNull(); expect(route.request().resourceType()).toBe("other");
      expect(nativePublicClientPreflightMethod(route.request(), proof!)).toBe(method);
      expect(nativePublicClientPreflightMethod(test.routes[1].request(), proof!)).toBeNull();
      test.events.get("Network.loadingFailed")!({ requestId: "original-get", canceled: true, errorText: "net::ERR_ABORTED" });
      // Reading diagnostics does not run the check, so the first failure is
      // recorded only by the existing queued/current validation below.
      expect(publicClientReadHeaderProofFailure(proof!)).toBeNull();
      expect(isCurrentPublicClientReadHeaders(proof!)).toBe(false);
      const firstFailure = publicClientReadHeaderProofFailure(proof!);
      expect(firstFailure).toMatchObject({ reason: "NATIVE_RECORD_NOT_CURRENT", nativeDocumentCurrent: true,
        nativeRecordFailed: false, nativeRequestCancelled: false, nativeSourceIdentityCurrent: true, nativeSourceFailed: true,
        nativeSourceFetchRecordPresent: false, nativeSourceLoadingFailedCanceledPresent: true, nativeSourceLoadingFailedCanceled: true,
        nativeSourceLoadingFailedErrorKind: "ABORTED", nativeSourceLoadingFailedCorsErrorPresent: false });
      expect(firstFailure).not.toHaveProperty("nativeSourceFetchAdmitted");
      expect(firstFailure).not.toHaveProperty("url"); expect(JSON.stringify(firstFailure)).not.toContain(literal);
      await expect(route.continue()).rejects.toThrow("NATIVE_REDIRECT_CONTINUE_REJECTED");
      await test.guard.close(); expect(isCurrentPublicClientReadHeaders(proof!)).toBe(false);
      expect(publicClientReadHeaderProofFailure(proof!)).toEqual(firstFailure);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "public-options")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it("retains the first exact source loadingFailed snapshot before mutating an admitted Fetch record", async () => {
    const held = deferred<void>(), test = await prepared(undefined, async route => {
      if (route.request().url() === apiUrl && route.request().method() === "GET") await held.promise;
    });
    try {
      const get = await test.get(); await get.continue();
      test.events.get("Network.requestWillBeSent")!({ requestId: "options-network", loaderId: "", type: "Other",
        initiator: { type: "preflight", requestId: "actual-network" }, request: { url: apiUrl, method: "OPTIONS", headers: {} } });
      test.request("public-options", { networkId: "options-network", resourceType: "Other", request: { url: apiUrl, method: "OPTIONS", headers: {
        Origin: "https://booking.example.org", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-api-key" } } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(4));
      const request = test.routes[3].request(), first = await authorizePublicClientReadHeaders(request), later = await authorizePublicClientReadHeaders(request);
      expect(first).not.toBeNull(); expect(later).not.toBeNull();
      test.events.get("Network.loadingFailed")!({ requestId: "unrelated-network", canceled: true, errorText: "net::ERR_ABORTED" });
      expect(isCurrentPublicClientReadHeaders(first!)).toBe(true);
      test.events.get("Network.loadingFailed")!({ requestId: "actual-network", canceled: false, errorText: "net::ERR_TIMED_OUT", corsErrorStatus: { corsError: "private-value" } });
      expect(isCurrentPublicClientReadHeaders(first!)).toBe(false);
      const observed = publicClientReadHeaderProofFailure(first!);
      expect(observed).toMatchObject({ nativeSourceFetchRecordPresent: true, nativeSourceFetchAdmitted: true, nativeSourceFetchFailed: false,
        nativeSourceFetchHandlerDone: false, nativeSourceLoadingFailedCanceledPresent: true, nativeSourceLoadingFailedCanceled: false,
        nativeSourceLoadingFailedErrorKind: "TIMED_OUT", nativeSourceLoadingFailedCorsErrorPresent: true, nativeSourceLoadingFailedCorsError: "OTHER" });
      test.events.get("Network.loadingFailed")!({ requestId: "actual-network", canceled: true, errorText: "private-value" });
      expect(isCurrentPublicClientReadHeaders(later!)).toBe(false);
      expect(publicClientReadHeaderProofFailure(later!)).toEqual(observed);
      expect(JSON.stringify(observed)).not.toContain("private-value"); expect(JSON.stringify(observed)).not.toContain("actual-network");
      expect(JSON.stringify(observed)).not.toContain("net::ERR_TIMED_OUT");
    } finally { held.resolve(); await test.guard.close(); }
  });
  it.each([
    { errorText: "net::ERR_BLOCKED_BY_CLIENT", kind: "BLOCKED_BY_CLIENT", cors: "HeaderDisallowedByPreflightResponse" },
    { errorText: "net::ERR_FAILED", kind: "FAILED", cors: "MissingAllowOriginHeader" },
    { errorText: "private person@example.org detail", kind: "OTHER", cors: "private person@example.org detail" }, { errorText: undefined, kind: "OTHER", cors: undefined },
  ])("classifies only closed source error categories without inventing a missing canceled flag: %j", async ({ errorText, kind, cors }) => {
    const test = await prepared();
    try {
      test.network("original-get", apiUrl, "Fetch", "GET", readHeaders);
      test.events.get("Network.requestWillBeSent")!({ requestId: "options-network", loaderId: "", type: "Other",
        initiator: { type: "preflight", requestId: "original-get" }, request: { url: apiUrl, method: "OPTIONS", headers: {} } });
      test.request("public-options", { networkId: "options-network", resourceType: "Other", request: { url: apiUrl, method: "OPTIONS", headers: {
        Origin: "https://booking.example.org", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-api-key" } } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3));
      const proof = await authorizePublicClientReadHeaders(test.routes[2].request()); expect(proof).not.toBeNull();
      test.events.get("Network.loadingFailed")!({ requestId: "original-get", ...(errorText === undefined ? {} : { errorText }),
        ...(cors === undefined ? {} : { corsErrorStatus: { corsError: cors, failedParameter: "private person@example.org detail" } }) });
      expect(isCurrentPublicClientReadHeaders(proof!)).toBe(false);
      const observed = publicClientReadHeaderProofFailure(proof!);
      expect(observed).toMatchObject({ nativeSourceFetchRecordPresent: false, nativeSourceLoadingFailedCanceledPresent: false,
        nativeSourceLoadingFailedErrorKind: kind, nativeSourceLoadingFailedCorsErrorPresent: cors !== undefined,
        ...(cors === undefined ? {} : { nativeSourceLoadingFailedCorsError: cors.startsWith("private") ? "OTHER" : cors }) });
      if (cors === undefined) expect(observed).not.toHaveProperty("nativeSourceLoadingFailedCorsError");
      expect(observed).not.toHaveProperty("nativeSourceLoadingFailedCanceled");
      expect(JSON.stringify(observed)).not.toContain("person@example.org"); expect(JSON.stringify(observed)).not.toContain("net::ERR_");
    } finally { await test.guard.close(); }
  });
  it("retains Network header aliases and independently rejects source key duplicates before source Fetch exists", async () => {
    const test = await prepared();
    try {
      test.network("original-get", apiUrl, "Fetch", "GET", { ...readHeaders, "X-API-Key": literal });
      test.events.get("Network.requestWillBeSent")!({ requestId: "options-network", loaderId: "", type: "Other",
        initiator: { type: "preflight", requestId: "original-get" }, request: { url: apiUrl, method: "OPTIONS" } });
      test.request("public-options", { networkId: "options-network", resourceType: "Other", request: { url: apiUrl, method: "OPTIONS", headers: {
        Origin: "https://booking.example.org", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-api-key" } } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3));
      expect(await authorizePublicClientReadHeaders(test.routes[2].request())).toBeNull();
    } finally { await test.guard.close(); }
  });
  it.each(["source-failed", "document-failed", "request-failed", "identity-revised", "unsafe-spa", "boundary", "close"])(
    "rechecks exact proof after a queued wait and blocks dispatch on %s", async fault => {
      const test = await prepared();
      try {
        const route = await test.get(), proof = await authorizePublicClientReadHeaders(route.request()); expect(proof).not.toBeNull();
        if (fault === "source-failed") test.events.get("Network.loadingFailed")!({ requestId: "script-network" });
        if (fault === "document-failed") test.events.get("Network.loadingFailed")!({ requestId: "document-network" });
        if (fault === "request-failed") test.events.get("Network.loadingFailed")!({ requestId: "actual-network" });
        if (fault === "identity-revised") test.network("actual-network", apiUrl, "Fetch", "GET", readHeaders);
        if (fault === "unsafe-spa") test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: "https://booking.example.org/account" });
        if (fault === "boundary") await test.guard.beginDocumentNavigation(test.main as never);
        if (fault === "close") await test.guard.close();
        expect(publicClientReadHeaderProofFailure(proof!)).toBeNull();
        expect(isCurrentPublicClientReadHeaders(proof!)).toBe(false);
        const firstFailure = publicClientReadHeaderProofFailure(proof!);
        expect(firstFailure).not.toBeNull();
        if (fault === "source-failed") expect(firstFailure?.reason).toBe("REVOCATION_EPOCH_CHANGED");
        if (fault === "request-failed") expect(firstFailure).toMatchObject({ reason: "NATIVE_RECORD_NOT_CURRENT", nativeIdentityFailed: true });
        if (fault === "close") expect(firstFailure?.reason).toBe("OWNER_CLOSED");
        if (fault === "identity-revised") expect(firstFailure).toMatchObject({ reason: "NATIVE_RECORD_NOT_CURRENT", nativeIdentityRevisionCurrent: false });
        await expect(route.continue()).rejects.toThrow();
        await test.guard.close(); expect(isCurrentPublicClientReadHeaders(proof!)).toBe(false);
        expect(publicClientReadHeaderProofFailure(proof!)).toEqual(firstFailure);
        expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "actual-read")).toBe(false);
      } finally { await test.guard.close(); }
    });
  it("retains the same-loader safe SPA proof and does not leak keys into diagnostics", async () => {
    const test = await prepared();
    try {
      const route = await test.get(), proof = await authorizePublicClientReadHeaders(route.request());
      test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: `${documentUrl}?date=2026-10-24` });
      expect(isCurrentPublicClientReadHeaders(proof!)).toBe(true);
      expect(JSON.stringify([proof, test.guard.firstFatal, test.guard.rejectedRequests])).not.toContain(literal);
    } finally { await test.guard.close(); }
  });
  it("does not retire a good native witness when a different ordinary chunk completes", async () => {
    const test = await prepared();
    try {
      const route = await test.get(), proof = await authorizePublicClientReadHeaders(route.request());
      const url = "https://booking.example.org/chunk.js";
      test.network("chunk-network", url, "Script");
      test.request("benign-chunk", { networkId: "chunk-network", resourceType: "Script", request: { url, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(4)); await test.routes[3].continue();
      test.response("benign-chunk", { networkId: "chunk-network", resourceType: "Script", request: { url, method: "GET", headers: {} },
        responseHeaders: [{ name: "Content-Type", value: "text/javascript" }] });
      await test.routes[3].request().response(); expect(isCurrentPublicClientReadHeaders(proof!)).toBe(true);
    } finally { await test.guard.close(); }
  });
});

describe("native root GET CORS preflight ownership", () => {
  const url = "https://api.example.org/public-data";
  const source = (test: Awaited<ReturnType<typeof installed>>, values: object = {}) => test.events.get("Network.requestWillBeSent")!({
    requestId: "original-get", loaderId: "current-loader", frameId: "main", type: "Fetch", request: { url, method: "GET" }, ...values });
  const metadata = (test: Awaited<ReturnType<typeof installed>>, values: object = {}) => test.events.get("Network.requestWillBeSent")!({
    requestId: "preflight", loaderId: "", type: "Other", initiator: { type: "preflight", requestId: "original-get" }, request: { url, method: "OPTIONS" }, ...values });
  const pause = (test: Awaited<ReturnType<typeof installed>>, values: object = {}) => test.request("options", {
    networkId: "preflight", request: { url, method: "OPTIONS", headers: { Origin: "https://example.org", "Access-Control-Request-Method": "GET" } }, ...values });
  const prepare = async (sourceValues: object = {}, withSource = true) => {
    const test = await installed(); await test.guard.beginDocumentNavigation(test.main as never);
    test.events.get("Network.requestWillBeSent")!({ requestId: "document", loaderId: "current-loader", frameId: "main", type: "Document", request: { url: "https://example.org", method: "GET" } });
    test.request("document", { networkId: "document", resourceType: "Document", request: { url: "https://example.org", method: "GET", headers: {} } });
    await test.routes[0].continue(); test.response("document", { networkId: "document", resourceType: "Document", request: { url: "https://example.org", method: "GET", headers: {} } });
    await test.routes[0].request().response(); if (withSource) source(test, sourceValues); return test;
  };
  it("diagnoses an exact rejected bodyful HEAD preflight source without granting it read authority", async () => {
    const test = await prepare({ request: { url, method: "HEAD", hasPostData: true, postData: "private-body-not-retained" } });
    try {
      metadata(test);
      pause(test, { request: { url, method: "OPTIONS", headers: { Origin: "https://example.org", "Access-Control-Request-Method": "HEAD", "X-Private": "private-header-not-retained" } } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT"));
      expect(test.guard.firstFatal).toMatchObject({ requestedPreflightMethod: "HEAD", phase: "LOADER_IDENTITY_WAIT",
        preflightCandidatePresent: true, preflightCandidateInvalid: true, preflightSourceKnown: true, preflightSourceMethod: "HEAD",
        preflightRegistrationGate: "SOURCE_METHOD_OR_BODY", preflightGateParentKnown: true,
        preflightSourceCurrentGeneration: true, preflightSourceFailed: false, preflightSourceBodyPresent: true,
        preflightSourceRootFrame: true, preflightSourceLoaderKnown: true, preflightSourceUrlMatches: true });
      const serialized = JSON.stringify(test.guard.firstFatal);
      expect(serialized).not.toContain("private-body-not-retained"); expect(serialized).not.toContain("private-header-not-retained");
      expect(serialized).not.toContain("original-get"); expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it("omits unavailable preflight source facts instead of reporting unobserved negative facts", async () => {
    const test = await prepare({}, false);
    try {
      pause(test, { request: { url, method: "OPTIONS", headers: { "Access-Control-Request-Method": "DELETE" } } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT"));
      expect(test.guard.firstFatal).toMatchObject({ requestedPreflightMethod: "DELETE", preflightCandidatePresent: false,
        preflightSourceKnown: false, preflightRegistrationGate: "NOT_SEEN" });
      for (const field of ["preflightCandidateInvalid", "preflightSourceMethod", "preflightSourceCurrentGeneration", "preflightSourceFailed", "preflightSourceBodyPresent", "preflightSourceRootFrame", "preflightSourceLoaderKnown", "preflightSourceUrlMatches"])
        expect(test.guard.firstFatal).not.toHaveProperty(field);
      expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });
  it("projects only the exact rejected preflight registration gate and current source facts", async () => {
    const test = await prepare();
    try {
      metadata(test, { frameId: "foreign", request: { url, method: "OPTIONS", headers: { "X-Private": "private-header-canary" } } });
      pause(test);
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT"));
      expect(test.guard.firstFatal).toMatchObject({ phase: "LOADER_IDENTITY_WAIT", preflightRegistrationGate: "NONROOT_FRAME",
        preflightGateGenerationCurrent: true, preflightGateRootFrame: false, preflightGateParentKnown: true,
        preflightGateParentCurrentGeneration: true, preflightGateParentLoaderCurrent: true, preflightGateParentFailed: false,
        preflightCandidatePresent: false, preflightSourceKnown: false });
      expect(JSON.stringify(test.guard.firstFatal)).not.toMatch(/foreign|original-get|private-header-canary|preflight"/u);
      expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it.each([
    { headers: { Origin: "https://example.org", "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-api-key" }, category: "SENSITIVE", originSafe: true },
    { headers: { Origin: "https://private.invalid", "Access-Control-Request-Method": "DELETE",
      "Access-Control-Request-Headers": "x-private\r\nsecret" }, category: "MALFORMED", originSafe: false },
    { headers: { Origin: "https://example.org", "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "accept", "access-control-request-headers": "x-other" }, category: "DUPLICATE", originSafe: true },
  ] as const)("projects closed OPTIONS header categories without changing the strict timeout: $category", async ({ headers, category, originSafe }) => {
    const test = await prepare({}, false);
    try {
      pause(test, { request: { url, method: "OPTIONS", headers } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT"));
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_LOADER_TIMEOUT", phase: "LOADER_IDENTITY_WAIT",
        preflightOriginPresent: true, preflightOriginSafe: originSafe, preflightRequestedHeadersCategory: category });
      expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
      expect(JSON.stringify(test.guard.firstFatal)).not.toMatch(/private\.invalid|x-private|x-other|x-api-key|secret/iu);
    } finally { await test.guard.close(); }
  });
  it.each([
    { "Access-Control-Request-Method": "POST", "access-control-request-method": "GET" },
    { "Access-Control-Request-Method": "private-method-not-retained" },
  ])("projects conflicting or unrecognized preflight method text only as OTHER: %j", async requestHeaders => {
    const test = await prepare({}, false);
    try {
      pause(test, { request: { url, method: "OPTIONS", headers: requestHeaders } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT"));
      expect(test.guard.firstFatal?.requestedPreflightMethod).toBe("OTHER");
      expect(JSON.stringify(test.guard.firstFatal)).not.toContain("private-method-not-retained"); expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });
  it("waits for the exact frameless loaderless preflight and independently routes the later GET", async () => {
    const test = await prepare();
    try {
      pause(test); await new Promise(resolve => setTimeout(resolve, 5)); expect(test.routes).toHaveLength(1);
      metadata(test); await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(test.routes[1].request().method()).toBe("OPTIONS"); await test.routes[1].continue();
      test.response("options", { networkId: "preflight", responseStatusCode: 204, request: { url, method: "OPTIONS", headers: {} } });
      expect((await test.routes[1].request().response())?.status()).toBe(204);
      test.request("actual", { networkId: "original-get", resourceType: "Fetch", request: { url, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3)); await test.routes[2].continue();
      test.response("actual", { networkId: "original-get", resourceType: "Fetch", request: { url, method: "GET", headers: {} } });
      expect((await test.routes[2].request().response())?.status()).toBe(200); expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it.each([false, true])("correlates an exact bodyful POST preflight for caller denial without poisoning later public GETs (OPTIONS first: %s)", async optionsFirst => {
    const test = await prepare({}, false);
    const postSource = { request: { url, method: "POST", hasPostData: true, postData: '{"unapproved":"public-rest-operation"}' } };
    const postPause = { request: { url, method: "OPTIONS", headers: { origin: "https://example.org", "access-control-request-method": "POST", "access-control-request-headers": "authorization,x-api-key" } } };
    try {
      if (optionsFirst) { metadata(test); pause(test, postPause); expect(test.routes).toHaveLength(1); source(test, postSource); }
      else { source(test, postSource); metadata(test); pause(test, postPause); }
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      // Ownership only reaches the unchanged caller policy. It never creates
      // a public-client-key proof or sends either the preflight or actual POST.
      const route = test.routes[1];
      expect(nativeReadPreflightMethod(route.request().headers())).toBeNull();
      expect(await authorizePublicClientReadHeaders(route.request())).toBeNull();
      await route.abort();
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.failures).toEqual([]);
      source(test, { requestId: "later-get", request: { url: `${url}/later`, method: "GET" } });
      test.request("later-get-pause", { networkId: "later-get", resourceType: "Fetch", request: { url: `${url}/later`, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3)); await test.routes[2].continue();
      test.response("later-get-pause", { networkId: "later-get", resourceType: "Fetch", request: { url: `${url}/later`, method: "GET", headers: {} } });
      expect((await test.routes[2].request().response())?.status()).toBe(200); expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it("leaves credentialless POST preflight permission and eventual POST dispatch as separate caller decisions", async () => {
    const test = await prepare({ request: { url, method: "POST", hasPostData: true, postData: '{"unapproved":"operation"}' } });
    try {
      metadata(test); pause(test, { request: { url, method: "OPTIONS", headers: { origin: "https://example.org", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(nativeReadPreflightMethod(test.routes[1].request().headers())).toBe("POST");
      await test.routes[1].continue();
      test.response("options", { networkId: "preflight", responseStatusCode: 204, request: { url, method: "OPTIONS", headers: {} } });
      expect((await test.routes[1].request().response())?.status()).toBe(204);
      test.request("actual-post", { networkId: "original-get", resourceType: "Fetch", request: { url, method: "POST", hasPostData: true, postData: '{"unapproved":"operation"}', headers: { "content-type": "application/json" } } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3));
      expect(test.routes[2].request().postData()).toBe('{"unapproved":"operation"}');
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "actual-post")).toBe(false);
      // This unapproved REST operation is rejected by the caller; the successful
      // OPTIONS response has granted no authority to continue the actual POST.
      await test.routes[2].abort(); expect(test.guard.firstFatal).toBeUndefined(); expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it.each([false, true])("waits for a late exact GET identity when OPTIONS Network arrives first (Fetch before both: %s)", async fetchFirst => {
    const test = await prepare({}, false);
    try {
      if (fetchFirst) pause(test);
      metadata(test); if (!fetchFirst) pause(test);
      await new Promise(resolve => setTimeout(resolve, 5)); expect(test.routes).toHaveLength(1);
      source(test); await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      await test.routes[1].continue(); test.response("options", { networkId: "preflight", responseStatusCode: 204, request: { url, method: "OPTIONS", headers: {} } });
      expect((await test.routes[1].request().response())?.status()).toBe(204);
      test.request("actual", { networkId: "original-get", resourceType: "Fetch", request: { url, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3)); await test.routes[2].continue();
      test.response("actual", { networkId: "original-get", resourceType: "Fetch", request: { url, method: "GET", headers: {} } });
      expect((await test.routes[2].request().response())?.status()).toBe(200); expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it.each([false, true])("binds an exact body-free HEAD preflight in either CDP order (OPTIONS before source: %s)", async optionsFirst => {
    const test = await prepare({}, false), headSource = { request: { url, method: "HEAD" } };
    const headPause = { request: { url, method: "OPTIONS", headers: { Origin: "https://example.org", "Access-Control-Request-Method": "HEAD" } } };
    try {
      if (optionsFirst) { pause(test, headPause); metadata(test); expect(test.routes).toHaveLength(1); source(test, headSource); }
      else { source(test, headSource); metadata(test); pause(test, headPause); }
      await vi.waitFor(() => expect(test.routes).toHaveLength(2)); await test.routes[1].continue();
      test.response("options", { networkId: "preflight", responseStatusCode: 204, request: { url, method: "OPTIONS", headers: {} } });
      expect((await test.routes[1].request().response())?.status()).toBe(204);
      test.request("actual-head", { networkId: "original-get", resourceType: "Fetch", request: { url, method: "HEAD", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3)); await test.routes[2].continue();
      test.response("actual-head", { networkId: "original-get", resourceType: "Fetch", request: { url, method: "HEAD", headers: {} } });
      const response = await test.routes[2].request().response(); expect(response?.status()).toBe(200); expect((await response?.body())?.length).toBe(0);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.getResponseBody" && ["options", "actual-head"].includes(value?.requestId ?? ""))).toBe(false);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it.each(["HEAD requested GET", "GET requested HEAD", "HEAD with body", "terminal HEAD"])("rejects mismatched or noncurrent HEAD preflight evidence: %s", async mismatch => {
    const test = await prepare({}, false), sourceMethod = mismatch === "GET requested HEAD" ? "GET" : "HEAD";
    try {
      metadata(test); source(test, { request: { url, method: sourceMethod, ...(mismatch === "HEAD with body" ? { hasPostData: true, postData: "opaque" } : {}) } });
      if (mismatch === "terminal HEAD") test.events.get("Network.loadingFailed")!({ requestId: "original-get" });
      pause(test, { request: { url, method: "OPTIONS", headers: { "Access-Control-Request-Method": mismatch === "HEAD requested GET" ? "GET" : "HEAD" } } });
      await vi.waitFor(() => expect(test.failures.length).toBeGreaterThan(0)); expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it("correlates seven earlier OPTIONS identities only to their independently reordered GET parents", async () => {
    const test = await prepare({}, false), order = [6, 0, 4, 2, 1, 5, 3];
    try {
      for (let index = 0; index < 7; index++) {
        const target = `${url}/${index}`;
        test.request(`options-${index}`, { networkId: `preflight-${index}`, request: { url: target, method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } } });
        metadata(test, { requestId: `preflight-${index}`, initiator: { type: "preflight", requestId: `get-${index}` }, request: { url: target, method: "OPTIONS" } });
      }
      expect(test.routes).toHaveLength(1);
      for (const index of order) source(test, { requestId: `get-${index}`, request: { url: `${url}/${index}`, method: "GET" } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(8));
      expect(test.routes.slice(1).map(route => route.request().url())).toEqual(order.map(index => `${url}/${index}`));
      for (const [offset, index] of order.entries()) {
        await test.routes[offset + 1].continue();
        test.response(`options-${index}`, { networkId: `preflight-${index}`, responseStatusCode: 204, request: { url: `${url}/${index}`, method: "OPTIONS", headers: {} } });
        expect((await test.routes[offset + 1].request().response())?.status()).toBe(204);
      }
      for (let index = 0; index < 7; index++) test.request(`actual-${index}`, { networkId: `get-${index}`, resourceType: "Fetch", request: { url: `${url}/${index}`, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(15));
      expect(test.routes.slice(8).every(route => route.request().method() === "GET")).toBe(true); expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });
  it.each(["URL", "frame", "loader", "method", "body", "kind"])("does not bind earlier OPTIONS to a late GET with mismatched %s", async mismatch => {
    const test = await prepare({}, false);
    try {
      metadata(test); pause(test);
      source(test, mismatch === "URL" ? { request: { url: "https://api.example.org/other", method: "GET" } }
        : mismatch === "frame" ? { frameId: "foreign" } : mismatch === "loader" ? { loaderId: "foreign-loader" }
          : mismatch === "method" ? { request: { url, method: "POST" } } : mismatch === "body" ? { request: { url, method: "GET", hasPostData: true, postData: "opaque" } } : { type: "Script" });
      await vi.waitFor(() => expect(test.failures.length).toBeGreaterThan(0)); expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });
  it.each(["duplicate OPTIONS", "conflicting OPTIONS", "invalid first parent", "unknown parent", "parent terminal", "OPTIONS terminal"])(
    "never heals pending preflight evidence after %s", async mismatch => {
      const test = await prepare({}, false);
      try {
        metadata(test, mismatch === "unknown parent" ? { initiator: { type: "preflight", requestId: "missing" } } : {});
        if (mismatch === "duplicate OPTIONS" || mismatch === "conflicting OPTIONS") metadata(test,
          mismatch === "conflicting OPTIONS" ? { request: { url: "https://api.example.org/other", method: "OPTIONS" } } : {});
        if (mismatch === "invalid first parent") source(test, { request: { url, method: "POST" } });
        if (mismatch.endsWith("terminal")) test.events.get("Network.loadingFailed")!({ requestId: mismatch === "parent terminal" ? "original-get" : "preflight" });
        source(test); pause(test);
        await vi.waitFor(() => expect(test.failures.length).toBeGreaterThan(0)); expect(test.routes).toHaveLength(1);
      } finally { await test.guard.close(); }
    });
  it("expires pending preflight evidence under the unchanged identity timeout", async () => {
    const test = await prepare({}, false), clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValueOnce(Date.now() - 101); metadata(test); clock.mockRestore(); source(test); pause(test);
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT")); expect(test.routes).toHaveLength(1);
    } finally { clock.mockRestore(); await test.guard.close(); }
  });
  it("does not move pending preflight evidence to a new document generation", async () => {
    const test = await prepare({}, false);
    try {
      metadata(test); await test.guard.beginDocumentNavigation(test.main as never);
      test.events.get("Network.requestWillBeSent")!({ requestId: "next-document", loaderId: "next-loader", frameId: "main", type: "Document", request: { url: "https://example.org/next", method: "GET" } });
      test.request("next-document", { networkId: "next-document", resourceType: "Document", request: { url: "https://example.org/next", method: "GET", headers: {} } });
      await test.routes[1].continue(); test.response("next-document", { networkId: "next-document", resourceType: "Document", request: { url: "https://example.org/next", method: "GET", headers: {} } });
      await test.routes[1].request().response(); source(test, { loaderId: "next-loader" }); pause(test);
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT")); expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });
  it("cannot publish pending preflight evidence after its waiting pause is cancelled", async () => {
    const test = await prepare({}, false); pause(test); metadata(test); await test.guard.close(); source(test);
    await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0)); expect(test.routes).toHaveLength(1);
  });
  it("does not share one late GET parent between two earlier OPTIONS identities", async () => {
    const test = await prepare({}, false);
    try {
      metadata(test); metadata(test, { requestId: "second-preflight" }); source(test); pause(test);
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      test.request("second-options", { networkId: "second-preflight", request: { url, method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT")); expect(test.routes).toHaveLength(2);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "second-options")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it("bounds pending OPTIONS and existing Network identities together at the original record limit", async () => {
    const test = await installed(2); await test.guard.beginDocumentNavigation(test.main as never);
    test.events.get("Network.requestWillBeSent")!({ requestId: "document", loaderId: "current-loader", frameId: "main", type: "Document", request: { url: "https://example.org", method: "GET" } });
    test.request("document", { networkId: "document", resourceType: "Document", request: { url: "https://example.org", method: "GET", headers: {} } });
    await test.routes[0].continue(); test.response("document", { networkId: "document", resourceType: "Document", request: { url: "https://example.org", method: "GET", headers: {} } });
    await test.routes[0].request().response();
    try {
      metadata(test); metadata(test, { requestId: "second-preflight", initiator: { type: "preflight", requestId: "second-get" } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_RECORD_LIMIT")); expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });
  it.each(["initiator", "source id", "source URL", "source frame", "source loader", "source method", "source body", "source kind", "preflight frame", "preflight loader", "preflight URL", "preflight body", "network id"])(
    "does not infer preflight ownership from mismatched %s", async mismatch => {
      const test = await prepare(mismatch === "source URL" ? { request: { url: "https://api.example.org/other", method: "GET" } }
        : mismatch === "source frame" ? { frameId: "foreign" } : mismatch === "source loader" ? { loaderId: "foreign-loader" }
          : mismatch === "source method" ? { request: { url, method: "POST" } } : mismatch === "source body" ? { request: { url, method: "GET", hasPostData: true, postData: "opaque" } }
            : mismatch === "source kind" ? { type: "Script" } : {});
      try {
        metadata(test, mismatch === "initiator" ? { initiator: { type: "other" } } : mismatch === "source id" ? { initiator: { type: "preflight", requestId: "missing" } }
          : mismatch === "preflight frame" ? { frameId: "foreign" } : mismatch === "preflight loader" ? { loaderId: "foreign-loader" }
            : mismatch === "preflight URL" ? { request: { url: "https://api.example.org/other", method: "OPTIONS" } }
              : mismatch === "preflight body" ? { request: { url, method: "OPTIONS", hasPostData: true, postData: "opaque" } } : {});
        pause(test, mismatch === "network id" ? { networkId: "foreign-preflight" } : {});
        await vi.waitFor(() => expect(test.failures.length).toBeGreaterThan(0)); expect(test.routes).toHaveLength(1);
        expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
      } finally { await test.guard.close(); }
    });
  it.each(["requested POST", "fetch body", "revised initiator"])("rejects a changed %s after exact network correlation", async mismatch => {
    const test = await prepare();
    try {
      metadata(test); if (mismatch === "revised initiator") source(test);
      pause(test, mismatch === "requested POST" ? { request: { url, method: "OPTIONS", headers: { Origin: "https://example.org", "Access-Control-Request-Method": "POST" } } }
        : mismatch === "fetch body" ? { request: { url, method: "OPTIONS", hasPostData: true, postData: "opaque", headers: { "Access-Control-Request-Method": "GET" } } } : {});
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_MISMATCH")); expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });
  it("never reuses an original GET correlation for a second preflight", async () => {
    const test = await prepare();
    try {
      metadata(test); pause(test); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); await test.routes[1].continue();
      test.response("options", { networkId: "preflight", responseStatusCode: 204, request: { url, method: "OPTIONS", headers: {} } }); await test.routes[1].request().response();
      metadata(test, { requestId: "preflight-two" }); test.request("options-two", { networkId: "preflight-two", request: { url, method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT")); expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });
  it.each(["GET", "POST"])("cannot dispatch a queued %s preflight after its original source identity changes", async method => {
    const sourceValues = { request: { url, method, ...(method === "POST" ? { hasPostData: true, postData: "{}" } : {}) } };
    const test = await prepare(sourceValues);
    try {
      metadata(test); pause(test, { request: { url, method: "OPTIONS", headers: { "Access-Control-Request-Method": method } } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(2)); source(test, sourceValues);
      await expect(test.routes[1].continue()).rejects.toThrow("NATIVE_REDIRECT_CONTINUE_REJECTED");
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it.each(["GET", "POST"].flatMap(method => [false, true].map(replacement => ({ method, replacement }))))("aborts a preflight held for its lease when the exact source fails: %j", async ({ method, replacement }) => {
    const sourceValues = { request: { url, method, ...(method === "POST" ? { hasPostData: true, postData: "{}" } : {}) } };
    const test = await prepare(sourceValues), leaseReady = deferred<object>(), signal = new AbortController(), failures: string[] = [];
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => { await leaseReady.promise; return { acquired: true as const, value: await work() }; }, signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { await queue.run("api.example.org", () => route.continue()); }
      catch (error) { failures.push((error as Error).message); await route.abort(); }
    });
    try {
      metadata(test); pause(test, { request: { url, method: "OPTIONS", headers: { "Access-Control-Request-Method": method } } }); await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      test.events.get("Network.loadingFailed")!({ requestId: "original-get" });
      if (replacement) source(test, sourceValues);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
      leaseReady.resolve({}); await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(failures).toEqual(["NATIVE_REDIRECT_CONTINUE_REJECTED"]); });
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, value]) => value?.requestId)).toEqual(["options"]);
      expect(test.cdp.send.mock.calls.some(([name, value]) => ["Fetch.continueRequest", "Fetch.getResponseBody", "Fetch.continueResponse"].includes(name) && value?.requestId === "options")).toBe(false);
      expect(test.routes).toHaveLength(2); expect(test.guard.firstFatal).toBeUndefined();
    } finally { leaseReady.resolve({}); queue.dispose(); signal.abort(); await test.guard.close(); }
  });
  it.each(["before binding", "before Fetch admission"])("never dispatches preflight when its exact source GET terminates %s", async timing => {
    const test = await prepare();
    try {
      if (timing === "before Fetch admission") metadata(test);
      test.events.get("Network.loadingFailed")!({ requestId: "original-get" });
      if (timing === "before binding") metadata(test);
      pause(test); await vi.waitFor(() => expect(test.failures.length).toBeGreaterThan(0));
      expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => ["Fetch.continueRequest", "Fetch.getResponseBody"].includes(name) && value?.requestId === "options")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it("never admits a terminal OPTIONS identity published before its Fetch pause", async () => {
    const test = await prepare();
    try {
      metadata(test); test.events.get("Network.loadingFailed")!({ requestId: "preflight" }); pause(test);
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_MISMATCH")); expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => ["Fetch.continueRequest", "Fetch.getResponseBody"].includes(name) && value?.requestId === "options")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it("retires a paused preflight without dispatching or transferring its source ownership", async () => {
    const test = await prepare();
    try {
      metadata(test); pause(test); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); await test.guard.beginDocumentNavigation(test.main as never);
      await expect(test.routes[1].continue()).rejects.toThrow(); expect(test.routes[1].request().signal?.aborted).toBe(true);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it("does not borrow the original GET from a retired document generation", async () => {
    const test = await prepare();
    try {
      await test.guard.beginDocumentNavigation(test.main as never); metadata(test); pause(test);
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT")); expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });
  it("does not give a second Fetch pause the consumed preflight identity", async () => {
    const test = await prepare();
    try {
      metadata(test); pause(test); await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      test.request("duplicate-options", { networkId: "preflight", request: { url, method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_MISMATCH")); expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });
  it("cannot publish a late preflight identity after cancellation of its wait", async () => {
    const test = await prepare(); pause(test); await test.guard.close(); metadata(test);
    await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0)); expect(test.routes).toHaveLength(1);
    expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "options")).toBe(false);
  });
});

describe("native document-generation retirement", () => {
  const identity = (test: Awaited<ReturnType<typeof installed>>, id: string, loaderId: string, kind = "XHR", url = "https://example.org/data") =>
    test.events.get("Network.requestWillBeSent")!({ requestId: `network-${id}`, loaderId, frameId: "main", type: kind, request: { url, method: "GET" } });
  const startDocument = async (test: Awaited<ReturnType<typeof installed>>, id = "document", loader = "loader-one") => {
    await test.guard.beginDocumentNavigation(test.main as never);
    identity(test, id, loader, "Document"); test.request(id, { resourceType: "Document" });
  };

  it.each(["https://example.org/booking", "https://example.org/data"])("waits for a fresh network hop for redirect %s before its network event", async target => {
    const test = await installed();
    try {
      await startDocument(test); await test.routes[0].continue();
      test.response("document", { resourceType: "Document", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
      await test.routes[0].request().response();
      test.request("child", { networkId: "network-document", resourceType: "Document", redirectedRequestId: "document",
        request: { url: target, method: "GET", headers: {} } });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(test.failures).toEqual([]); expect(test.routes).toHaveLength(1);
      identity(test, "document", "loader-one", "Document", target);
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      await test.routes[1].continue();
      test.response("child", { networkId: "network-document", resourceType: "Document", request: { url: target, method: "GET", headers: {} } });
      expect((await test.routes[1].request().response())?.status()).toBe(200);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["URL", "method", "kind", "loader"])("rejects fresh redirect metadata with the wrong %s before dispatch", async mismatch => {
    const test = await installed(), target = "https://example.org/booking";
    try {
      await startDocument(test); await test.routes[0].continue();
      test.response("document", { resourceType: "Document", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
      await test.routes[0].request().response();
      test.request("child", { networkId: "network-document", resourceType: "Document", redirectedRequestId: "document",
        request: { url: target, method: "GET", headers: {} } });
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-document", loaderId: mismatch === "loader" ? "unknown" : "loader-one",
        frameId: "main", type: mismatch === "kind" ? "Script" : "Document",
        request: { url: mismatch === "URL" ? "https://example.org/wrong" : target, method: mismatch === "method" ? "HEAD" : "GET" } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_MISMATCH"));
      expect(test.routes).toHaveLength(1);
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_LOADER_MISMATCH", identityFresh: true,
        phase: mismatch === "loader" ? "LOADER_OWNER" : "LOADER_IDENTITY" });
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["missing", "foreign network", "foreign frame"])("times out without admitting a redirect from %s metadata", async mismatch => {
    const test = await installed(), target = "https://example.org/booking";
    try {
      await startDocument(test); await test.routes[0].continue();
      test.response("document", { resourceType: "Document", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
      await test.routes[0].request().response();
      test.request("child", { networkId: "network-document", resourceType: "Document", redirectedRequestId: "document",
        request: { url: target, method: "GET", headers: {} } });
      if (mismatch !== "missing") test.events.get("Network.requestWillBeSent")!({
        requestId: mismatch === "foreign network" ? "network-other" : "network-document", loaderId: "loader-one",
        frameId: mismatch === "foreign frame" ? "child" : "main", type: "Document", request: { url: target, method: "GET" } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_TIMEOUT"));
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.routes).toHaveLength(1);
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_LOADER_TIMEOUT", phase: "LOADER_IDENTITY_WAIT", identityFresh: false });
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["cancel", "retire"])("never dispatches a waiting redirect after document %s", async mode => {
    const abort = new AbortController(), test = await installed(undefined, abort.signal), target = "https://example.org/booking";
    try {
      await startDocument(test); await test.routes[0].continue();
      test.response("document", { resourceType: "Document", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
      await test.routes[0].request().response();
      test.request("child", { networkId: "network-document", resourceType: "Document", redirectedRequestId: "document",
        request: { url: target, method: "GET", headers: {} } });
      if (mode === "cancel") abort.abort(); else await test.guard.beginDocumentNavigation(test.main as never);
      identity(test, "document", "loader-one", "Document", target);
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it("reserves one redirect child while its network metadata is pending", async () => {
    const test = await installed(), target = "https://example.org/booking";
    try {
      await startDocument(test); await test.routes[0].continue();
      test.response("document", { resourceType: "Document", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
      await test.routes[0].request().response();
      for (const id of ["child", "duplicate-child"]) test.request(id, { networkId: "network-document", resourceType: "Document", redirectedRequestId: "document",
        request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED"));
      identity(test, "document", "loader-one", "Document", target);
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it.each(["cancel", "retire"])("settles a pending redirect on %s without any late network event or fatal timer", async mode => {
    const abort = new AbortController(), test = await installed(undefined, abort.signal), target = "https://example.org/booking";
    try {
      await startDocument(test); await test.routes[0].continue();
      test.response("document", { resourceType: "Document", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
      await test.routes[0].request().response();
      test.request("child", { networkId: "network-document", resourceType: "Document", redirectedRequestId: "document",
        request: { url: target, method: "GET", headers: {} } });
      if (mode === "cancel") abort.abort(); else await test.guard.beginDocumentNavigation(test.main as never);
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.routes).toHaveLength(1);
      if (mode === "retire") {
        const commands = test.cdp.send.mock.calls;
        const abortIndex = commands.findIndex(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "child");
        expect(abortIndex).toBeGreaterThanOrEqual(0);
        expect(commands.slice(abortIndex + 1).some(([name]) => name === "Page.stopLoading")).toBe(true);
        identity(test, "successor", "loader-two", "Document"); test.request("successor", { resourceType: "Document" });
        await test.routes[1].continue(); test.response("successor", { resourceType: "Document" });
        expect((await test.routes[1].request().response())?.status()).toBe(200);
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(test.failures).toEqual(mode === "cancel" ? ["NATIVE_REDIRECT_CANCELLED"] : []);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "child")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("requires the pending redirect pause's abort ACK before retirement when it %s", async mode => {
    const test = await installed(), target = "https://example.org/booking", send = test.cdp.send.getMockImplementation()!;
    try {
      await startDocument(test); await test.routes[0].continue();
      test.response("document", { resourceType: "Document", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }] });
      await test.routes[0].request().response();
      test.request("child", { networkId: "network-document", resourceType: "Document", redirectedRequestId: "document",
        request: { url: target, method: "GET", headers: {} } });
      const stopsBefore = test.cdp.send.mock.calls.filter(([name]) => name === "Page.stopLoading").length;
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "child" ?
        mode === "hang" ? new Promise(() => {}) : Promise.reject(new Error("pending pause abort rejected")) : send(name, value));
      await expect(test.guard.beginDocumentNavigation(test.main as never)).rejects.toThrow("NATIVE_REDIRECT_ABORT_TIMEOUT");
      expect(test.close).toHaveBeenCalledOnce();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Page.stopLoading")).toHaveLength(stopsBefore);
      expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it.each([["XHR", "Fetch"], ["Fetch", "XHR"]])("settles an owned retired %s pause only after its actual %s Network terminal event", async (fetchKind, networkKind) => {
    const test = await installed(), initialAck = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    let boundary: Promise<void> | undefined;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      let lateAborts = 0, complete = false;
      test.cdp.send.mockImplementation((name, value) => {
        if (name === "Fetch.failRequest" && value?.requestId === "initial") return initialAck.promise;
        if (name === "Fetch.failRequest" && value?.requestId === "late") { lateAborts++; return Promise.reject(new Error("Invalid InterceptionId")); }
        return send(name, value);
      });
      test.request("initial"); boundary = test.guard.beginDocumentNavigation(test.main as never).then(() => { complete = true; }); boundary.catch(() => {});
      identity(test, "late", "loader-one", networkKind); test.request("late", { resourceType: fetchKind });
      await vi.waitFor(() => expect(lateAborts).toBe(1), { interval: 1 });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(test.failures).toEqual([]); expect(complete).toBe(false); expect(test.routes).toHaveLength(1);
      test.events.get("Network.loadingFailed")!({ requestId: "network-late", type: networkKind }); initialAck.resolve({});
      await boundary; await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.failures).toEqual([]); expect(test.guard.firstFatal).toBeUndefined();
      expect(test.cdp.send.mock.calls.some(([name, value]) => ["Fetch.continueRequest", "Fetch.getResponseBody"].includes(name) && value?.requestId === "late")).toBe(false);
    } finally { initialAck.resolve({}); await boundary?.catch(() => {}); await test.guard.close(); }
  });

  it.each(["no event", "wrong network", "wrong URL", "wrong method", "foreign frame", "unknown loader", "foreign generation", "wrong kind", "unknown kind"])("does not settle a rejected initial abort from %s terminal evidence", async mismatch => {
    const test = await installed(), initialAck = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    let boundary: Promise<void> | undefined;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      if (mismatch === "foreign generation") {
        await test.guard.beginDocumentNavigation(test.main as never);
        identity(test, "successor", "loader-two", "Document"); test.request("successor", { resourceType: "Document" });
        await test.routes[1].continue(); test.response("successor", { resourceType: "Document" }); await test.routes[1].request().response();
      }
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "initial" ? initialAck.promise
        : name === "Fetch.failRequest" && value?.requestId === "late" ? Promise.reject(new Error("Invalid InterceptionId")) : send(name, value));
      test.request("initial"); boundary = test.guard.beginDocumentNavigation(test.main as never); boundary.catch(() => {});
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-late", loaderId: mismatch === "unknown loader" ? "foreign-loader" : "loader-one",
        frameId: mismatch === "foreign frame" ? "foreign" : "main", type: mismatch === "wrong kind" ? "Script" : mismatch === "unknown kind" ? "Unknown" : "Fetch",
        request: { url: mismatch === "wrong URL" ? "https://example.org/foreign" : "https://example.org/data", method: mismatch === "wrong method" ? "POST" : "GET" } });
      test.request("late", { resourceType: "XHR" });
      if (mismatch !== "no event") test.events.get("Network.loadingFailed")!({ requestId: mismatch === "wrong network" ? "foreign-network" : "network-late" });
      initialAck.resolve({});
      await expect(boundary).rejects.toThrow(); await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.failures).toContain("NATIVE_REDIRECT_ABORT_TIMEOUT"); expect(test.routes).toHaveLength(mismatch === "foreign generation" ? 2 : 1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => ["Fetch.continueRequest", "Fetch.getResponseBody"].includes(name) && value?.requestId === "late")).toBe(false);
    } finally { initialAck.resolve({}); await boundary?.catch(() => {}); await test.guard.close(); }
  });

  it.each(["unknown loader", "foreign generation"])("never publishes a successor after a rejected late-pause abort closes during drain (%s)", async mismatch => {
    const test = await installed(), initialAck = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    let boundary: Promise<void> | undefined;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      if (mismatch === "foreign generation") {
        await test.guard.beginDocumentNavigation(test.main as never);
        identity(test, "successor", "loader-two", "Document"); test.request("successor", { resourceType: "Document" });
        await test.routes[1].continue(); test.response("successor", { resourceType: "Document" }); await test.routes[1].request().response();
      }
      vi.useFakeTimers();
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "initial" ? initialAck.promise
        : name === "Fetch.failRequest" && value?.requestId === "late" ? Promise.reject(new Error("Invalid InterceptionId")) : send(name, value));
      test.request("initial"); boundary = test.guard.beginDocumentNavigation(test.main as never); boundary.catch(() => {});
      identity(test, "late", mismatch === "unknown loader" ? "unknown" : "loader-one", "Fetch");
      test.request("late", { resourceType: "XHR" });
      test.events.get("Network.loadingFailed")!({ requestId: "network-late" });
      // Let the late abort's existing timeout precede the drain timeout. The
      // mismatched terminal event cannot ACK either unknown/foreign ownership.
      await vi.advanceTimersByTimeAsync(10); initialAck.resolve({});
      await vi.advanceTimersByTimeAsync(100);
      await expect(boundary).rejects.toThrow();
      expect(test.failures).toContain("NATIVE_REDIRECT_ABORT_TIMEOUT");
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_ABORT_TIMEOUT" });
      expect(test.guard.lastFailure).toBe("NATIVE_REDIRECT_ABORT_TIMEOUT");
      expect(test.close).toHaveBeenCalledOnce();
      expect(test.routes).toHaveLength(mismatch === "foreign generation" ? 2 : 1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => ["Fetch.continueRequest", "Fetch.getResponseBody"].includes(name) && value?.requestId === "late")).toBe(false);
    } finally { initialAck.resolve({}); await boundary?.catch(() => {}); await test.guard.close(); vi.useRealTimers(); }
  });

  it.each([
    ["Script", "Fetch", "GET"], ["Fetch", "Script", "GET"], ["Image", "Stylesheet", "HEAD"],
  ])("denies exact non-document %s/%s %s disagreement without dispatch and retains independent reads", async (networkKind, fetchKind, method) => {
    const test = await installed();
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await test.routes[0].request().response();
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-denied", loaderId: "loader-one", frameId: "main", type: networkKind,
        request: { url: "https://example.org/optional.js", method } });
      test.request("denied", { resourceType: fetchKind, request: { url: "https://example.org/optional.js", method, headers: {} } });
      await vi.waitFor(() => expect(test.rejections).toHaveLength(1));
      expect(test.rejections[0]).toMatchObject({ code: "NATIVE_REDIRECT_RESOURCE_KIND_REJECTED", method });
      expect(test.routes).toHaveLength(1); expect(test.failures).toEqual([]); expect(test.guard.firstFatal).toBeUndefined();
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "denied")).toBe(false);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.getResponseBody" && value?.requestId === "denied")).toBe(false);
      identity(test, "availability", "loader-one"); test.request("availability"); await test.routes[1].continue(); test.response("availability");
      expect((await (await test.routes[1].request().response())?.body())?.toString()).toBe("body-availability");
      expect(test.routes).toHaveLength(2); expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["network document", "fetch document", "POST", "OPTIONS", "unknown kind", "URL", "method", "loader"])(
    "keeps %s disagreement fatal rather than downgrading identity or authority", async mismatch => {
      const test = await installed(), method = ["POST", "OPTIONS"].includes(mismatch) ? mismatch : "GET";
      try {
        await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
        await test.routes[0].request().response();
        test.events.get("Network.requestWillBeSent")!({ requestId: "network-denied", loaderId: mismatch === "loader" ? "unknown" : "loader-one", frameId: "main",
          type: mismatch === "network document" ? "Document" : mismatch === "unknown kind" ? "UNRECOGNIZED" : "Script",
          request: { url: mismatch === "URL" ? "https://example.org/other" : "https://example.org/optional.js", method: mismatch === "method" ? "HEAD" : method } });
        test.request("denied", { resourceType: mismatch === "fetch document" ? "Document" : "Fetch",
          request: { url: "https://example.org/optional.js", method, headers: {} } });
        await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_MISMATCH"));
        expect(test.rejections).toEqual([]); expect(test.routes).toHaveLength(1);
      } finally { await test.guard.close(); }
    });

  it("does not downgrade a retired loader's resource-kind disagreement", async () => {
    const test = await installed();
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await test.routes[0].request().response(); await test.guard.beginDocumentNavigation(test.main as never);
      identity(test, "successor", "loader-two", "Document"); test.request("successor", { resourceType: "Document" });
      await test.routes[1].continue(); test.response("successor", { resourceType: "Document" }); await test.routes[1].request().response();
      identity(test, "denied", "loader-one", "Script"); test.request("denied", { resourceType: "Fetch" });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_MISMATCH"));
      expect(test.guard.firstFatal).toMatchObject({ phase: "LOADER_OWNER" });
      expect(test.rejections).toEqual([]); expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });

  it.each(["Location", "network ID"])("requires exact redirect %s before a resource-kind denial", async mismatch => {
    const test = await installed(), target = "https://example.org/optional.js";
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      identity(test, "parent", "loader-one", "Fetch"); test.request("parent", { resourceType: "Fetch" }); await test.routes[1].continue();
      test.response("parent", { resourceType: "Fetch", responseStatusCode: 302,
        responseHeaders: [{ name: "Location", value: mismatch === "Location" ? "https://example.org/wrong" : target }] });
      await test.routes[1].request().response();
      identity(test, mismatch === "network ID" ? "other" : "parent", "loader-one", "Script", target);
      test.request("denied", { networkId: mismatch === "network ID" ? "network-other" : "network-parent", resourceType: "Fetch", redirectedRequestId: "parent",
        request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED"));
      expect(test.rejections).toEqual([]); expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });

  it("deduplicates and awaits the exact kind-denial abort ACK during document retirement", async () => {
    const test = await installed(), ack = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "denied" ? ack.promise : send(name, value));
      identity(test, "denied", "loader-one", "Script"); test.request("denied", { resourceType: "Fetch" });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "denied")).toBe(true));
      const stopsBefore = test.cdp.send.mock.calls.filter(([name]) => name === "Page.stopLoading").length;
      let finished = false; const boundary = test.guard.beginDocumentNavigation(test.main as never).then(() => { finished = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(finished).toBe(false); expect(test.rejections).toEqual([]); expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Page.stopLoading")).toHaveLength(stopsBefore);
      expect(test.cdp.send.mock.calls.filter(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "denied")).toHaveLength(1);
      ack.resolve({}); await boundary;
      expect(test.guard.pendingReads).toBe(0); expect(test.failures).toEqual([]); expect(test.rejections).toEqual([]);
    } finally { ack.resolve({}); await test.guard.close(); }
  });

  it.each(["exact", "no terminal", "foreign terminal", "revised identity", "foreign response"])("drains an independently terminal retired late response only for exact native identity (%s)", async mode => {
    const test = await installed(), stopped = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    let boundary: Promise<void> | undefined;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      identity(test, "active", "loader-one", "Script"); test.request("active", { resourceType: "Script" }); await test.routes[1].continue();
      test.cdp.send.mockImplementation((name, value) => name === "Page.stopLoading" ? stopped.promise : name === "Fetch.failRequest" && value?.requestId === "active" ? Promise.reject(new Error("Invalid InterceptionId")) : send(name, value));
      boundary = test.guard.beginDocumentNavigation(test.main as never); boundary.catch(() => {});
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Page.stopLoading")).toBe(true));
      if (mode === "revised identity") identity(test, "active", "loader-one", "Script");
      if (mode !== "no terminal") test.events.get("Network.loadingFailed")!({ requestId: mode === "foreign terminal" ? "network-foreign" : "network-active", canceled: true, errorText: "net::ERR_ABORTED" });
      test.response("active", { resourceType: "Script", ...(mode === "foreign response" ? { frameId: "foreign" } : {}) });
      if (mode === "exact") {
        await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0)); stopped.resolve({}); await boundary;
        expect(test.failures).toEqual([]); expect(test.guard.firstFatal).toBeUndefined();
        expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "active")).toBe(false);
      } else { await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); stopped.resolve({}); await boundary.catch(() => {}); }
      expect(test.cdp.send.mock.calls.some(([name, value]) => ["Fetch.getResponseBody", "Fetch.continueResponse"].includes(name) && value?.requestId === "active")).toBe(false);
      await expect(test.routes[1].request().response()).rejects.toThrow();
    } finally { stopped.resolve({}); await boundary?.catch(() => {}); await test.guard.close(); }
  });

  it("deduplicates one retired response abort while the boundary awaits an initial pause", async () => {
    const test = await installed(), initialAck = deferred<object>(), responseAck = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    let boundary: Promise<void> | undefined;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      identity(test, "active", "loader-one", "Script"); test.request("active", { resourceType: "Script" }); await test.routes[1].continue();
      let responseAborts = 0;
      test.cdp.send.mockImplementation((name, value) => {
        if (name === "Fetch.failRequest" && value?.requestId === "initial") return initialAck.promise;
        if (name === "Fetch.failRequest" && value?.requestId === "active") {
          if (++responseAborts > 1) return Promise.reject(new Error("Invalid InterceptionId"));
          return responseAck.promise;
        }
        return send(name, value);
      });
      // Actual initial pause is waiting for its Network identity; it has no lease.
      test.request("initial", { resourceType: "Script" });
      boundary = test.guard.beginDocumentNavigation(test.main as never); boundary.catch(() => {});
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "initial")).toBe(true), { interval: 1 });
      test.response("active", { resourceType: "Script" });
      await vi.waitFor(() => expect(responseAborts).toBe(1), { interval: 1 });
      initialAck.resolve({}); await new Promise(resolve => setTimeout(resolve, 10));
      expect(responseAborts).toBe(1); expect(test.close).not.toHaveBeenCalled();
      responseAck.resolve({}); await boundary;
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.failures).toEqual([]); expect(test.guard.firstFatal).toBeUndefined();
    } finally { initialAck.resolve({}); responseAck.resolve({}); await boundary?.catch(() => {}); await test.guard.close(); }
  });

  it("requires a distinct later response-pause ACK after the same request-pause ACK", async () => {
    const test = await installed(), requestAck = deferred<object>(), responseAck = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    let boundary: Promise<void> | undefined;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      identity(test, "queued", "loader-one", "Script"); test.request("queued", { resourceType: "Script" });
      let aborts = 0, boundaryComplete = false;
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "queued"
        ? ++aborts === 1 ? requestAck.promise : responseAck.promise : send(name, value));
      boundary = test.guard.beginDocumentNavigation(test.main as never).then(() => { boundaryComplete = true; }); boundary.catch(() => {});
      await vi.waitFor(() => expect(aborts).toBe(1), { interval: 1 });
      test.response("queued", { resourceType: "Script", responseStatusCode: undefined, responseErrorReason: "Aborted" });
      await vi.waitFor(() => expect(aborts).toBe(2), { interval: 1 });
      requestAck.resolve({}); await new Promise(resolve => setTimeout(resolve, 10));
      expect(boundaryComplete).toBe(false); expect(test.guard.pendingReads).toBeGreaterThan(0);
      responseAck.resolve({}); await boundary;
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(aborts).toBe(2); expect(test.failures).toEqual([]); expect(test.guard.firstFatal).toBeUndefined();
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "queued")).toBe(false);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.getResponseBody" && value?.requestId === "queued")).toBe(false);
    } finally { requestAck.resolve({}); responseAck.resolve({}); await boundary?.catch(() => {}); await test.guard.close(); }
  });

  it.each(["reject", "hang"])("still closes when a distinct retired response abort %s after a successful request abort", async mode => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      identity(test, "queued", "loader-one", "Script"); test.request("queued", { resourceType: "Script" });
      await test.guard.beginDocumentNavigation(test.main as never);
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "queued"
        ? mode === "hang" ? new Promise(() => {}) : Promise.reject(new Error("Invalid InterceptionId")) : send(name, value));
      test.response("queued", { resourceType: "Script", responseStatusCode: undefined, responseErrorReason: "Aborted" });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.firstFatal).toBeDefined();
      if (mode === "reject") expect(test.guard.firstFatal).toMatchObject({ operation: "RESPONSE_METADATA",
        responseFailureBranch: "RETIRED_RESPONSE_ABORT", recordGenerationRetired: true,
        responseIdentityMatched: true, correlatedNetworkLoadingFailed: false, correlatedNetworkLoadingFinished: false });
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.getResponseBody" && value?.requestId === "queued")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("closes if a resource-kind denial's exact abort ACK %s", async mode => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" }); await test.routes[0].request().response();
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "denied" ?
        mode === "hang" ? new Promise(() => {}) : Promise.reject(new Error("denial abort failed")) : send(name, value));
      identity(test, "denied", "loader-one", "Script"); test.request("denied", { resourceType: "Fetch" });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.rejections).toEqual([]); expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "denied")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it("waits for exact old-network terminal ACK and handler/lease drain; queued/late old reads never dispatch or become evidence", async () => {
    const test = await installed(), session = new AbortController(), stop = vi.fn(async () => {});
    let active = 0, released = 0; const completed: string[] = [], errors: unknown[] = [];
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => {
      active++; try { return { acquired: true as const, value: await work() }; } finally { active--; released++; }
    }, session.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { const value = await queue.run("example.org", () => continueNativeBrowserRead(route, session.signal, 1000, stop), route.request().signal); completed.push(value.body.toString()); }
      catch (error) { errors.push(error); if (!isNativeReadSupersededFailure(error)) throw error; }
    });
    try {
      await startDocument(test); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(completed).toEqual(["body-document"]));
      identity(test, "active", "loader-one", "Script"); test.request("active", { resourceType: "Script" });
      identity(test, "queued", "loader-one", "Script"); test.request("queued", { resourceType: "Script" });
      await vi.waitFor(() => expect(active).toBe(1));
      let boundaryComplete = false;
      const boundary = test.guard.beginDocumentNavigation(test.main as never).then(() => { boundaryComplete = true; });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "queued")).toBe(true));
      expect(boundaryComplete).toBe(false); expect(active).toBe(1); expect(released).toBe(1);
      test.events.get("Network.loadingFailed")!({ requestId: "network-active" });
      await boundary;
      expect(active).toBe(0); expect(errors).toHaveLength(2); expect(errors.every(isNativeReadSupersededFailure)).toBe(true);
      // An old loader's late request/response is denied, never offered to the shared handler.
      identity(test, "late", "loader-one", "Script"); test.request("late", { resourceType: "Script" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      test.response("late", { resourceType: "Script", responseStatusCode: undefined, responseErrorReason: "Failed" });
      identity(test, "next", "loader-two", "Document"); test.request("next", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.routes).toHaveLength(4)); test.response("next", { resourceType: "Document" });
      await vi.waitFor(() => expect(completed).toEqual(["body-document", "body-next"]));
      const dispatches = test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest").map(([, value]) => value?.requestId);
      expect(dispatches).toEqual(["document", "active", "next"]); expect(stop).not.toHaveBeenCalled();
      expect(test.failures).toEqual([]); expect(test.guard.firstFatal).toBeUndefined();
    } finally { session.abort(); queue.dispose(); await test.guard.close(); }
  });

  it("never treats stopLoading ACK as terminal proof for an active read", async () => {
    const test = await installed();
    test.handler.mockImplementation(async route => { test.routes.push(route); await route.continue(); });
    try {
      await startDocument(test); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      identity(test, "held", "loader-one", "Script"); test.request("held", { resourceType: "Script" });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "held")).toBe(true));
      await expect(test.guard.beginDocumentNavigation(test.main as never)).rejects.toThrow("NATIVE_REDIRECT_DRAIN_TIMEOUT");
      expect(test.close).toHaveBeenCalledOnce(); expect(test.failures).toContain("NATIVE_REDIRECT_DRAIN_TIMEOUT");
    } finally { await test.guard.close(); }
  });

  it.each(["unknown loader", "wrong URL", "wrong method", "document kind"])("fails closed on %s, even for an otherwise public read", async mismatch => {
    const test = await installed();
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-other", loaderId: mismatch === "unknown loader" ? "unknown" : "loader-one",
        frameId: "main", type: mismatch === "document kind" ? "Document" : "XHR", request: { url: mismatch === "wrong URL" ? "https://example.org/other" : "https://example.org/data", method: mismatch === "wrong method" ? "POST" : "GET" } });
      test.request("other"); await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_MISMATCH"));
      expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it("retains the cumulative request cap across boundaries", async () => {
    const test = await installed(2);
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      await test.guard.beginDocumentNavigation(test.main as never);
      identity(test, "next", "loader-two", "Document"); test.request("next", { resourceType: "Document" });
      await test.routes[1].continue(); test.response("next", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      identity(test, "over", "loader-two"); test.request("over");
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_RECORD_LIMIT"));
      expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });

  it("still closes for an uncompleted response on the current successor document", async () => {
    const test = await installed();
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      await test.guard.beginDocumentNavigation(test.main as never);
      identity(test, "next", "loader-two", "Document"); test.request("next", { resourceType: "Document" }); await test.routes[1].continue();
      await expect(test.routes[1].request().response()).rejects.toThrow("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT", resourceType: "document" });
      expect(test.close).toHaveBeenCalledOnce();
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("closes if the exact paused-read cancellation %s cannot be acknowledged", async mode => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      identity(test, "queued", "loader-one"); test.request("queued");
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" ? mode === "hang" ? new Promise(() => {}) : Promise.reject(new Error("offline abort rejection")) : send(name, value));
      await expect(test.guard.beginDocumentNavigation(test.main as never)).rejects.toThrow(mode === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : "offline abort rejection");
      expect(test.close).toHaveBeenCalledOnce();
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "queued")).toBe(false);
    } finally { await test.guard.close(); }
  });
});

describe("native anonymous Mindbody bootstrap ownership", () => {
  const source = "https://clients.mindbodyonline.com/classic/ws?studioid=685163&stype=-9", target = "https://clients.mindbodyonline.com/classic/home";
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://clients.mindbodyonline.com" };
  const fields = "tg vt lvl qParam view page catid prodid prodGroupId sSU optForwardingLink singleUseToken oAuthToken launchGUID launchUID launchPWDChange launchPWDChangeKey launchLostPWD launchResetPWD launchBizModeLogin launchBizModeLoginWithRedirectLink key consumerModeRedirect extLink giftCardID".split(" ");
  const body = new URLSearchParams([...fields.map(key => [key, ""]), ["studioId", "685163"], ["stype", "-9"], ["trn", "0"], ["classid", "0"], ["date", "10/23/2026"]]).toString();
  type Test = Awaited<ReturnType<typeof installed>>;
  const intent = (test: Test, changes: object = {}) => test.events.get("Page.frameRequestedNavigation")!({ frameId: "main", reason: "formSubmissionPost", disposition: "currentTab", url: target, ...changes });
  const network = (test: Test, changes: object = {}) => test.events.get("Network.requestWillBeSent")!({ requestId: "network-bootstrap", loaderId: "loader-post", frameId: "main", type: "Document",
    request: { url: target, method: "POST", headers, hasPostData: true, postData: body }, ...changes });
  const post = (test: Test, changes: object = {}) => test.request("bootstrap", { resourceType: "Document", request: { url: target, method: "POST", headers, hasPostData: true, postData: body }, ...changes });
  const prepare = async (test: Test, commit = true, ack?: ReturnType<typeof deferred<object>>, method = "GET", sourceBody?: string) => {
    const send = test.cdp.send.getMockImplementation()!;
    if (ack) test.cdp.send.mockImplementation((name, values) => name === "Fetch.continueResponse" && values?.requestId === "document" ? ack.promise : send(name, values));
    await test.guard.beginDocumentNavigation(test.main as never);
    const sourceRequest = { url: source, method, headers: {}, ...(sourceBody === undefined ? {} : { hasPostData: true, postData: sourceBody }) };
    test.events.get("Network.requestWillBeSent")!({ requestId: "network-document", loaderId: "loader-source", frameId: "main", type: "Document", request: sourceRequest });
    test.request("document", { resourceType: "Document", request: sourceRequest }); await test.routes[0].continue();
    test.response("document", { resourceType: "Document", request: sourceRequest, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
    if (!ack) await test.routes[0].request().response();
    else await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(true));
    if (commit) test.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "loader-source", url: source } });
  };

  it.each([{ held: false, queried: false }, { held: true, queried: false }, { held: false, queried: true }, { held: true, queried: true }])("attests one public form successor only after source completion and ACK (held=$held query=$queried)", async ({ held, queried }) => {
    const test = await installed(), ack = deferred<object>();
    const actualTarget = queried ? target + "?studioid=685163" : target;
    try {
      await prepare(test, true, held ? ack : undefined); intent(test, { url: actualTarget });
      network(test, { request: { url: actualTarget, method: "POST", headers, hasPostData: true, postData: body } });
      post(test, { request: { url: actualTarget, method: "POST", headers, hasPostData: true, postData: body } });
      if (held) { await new Promise(resolve => setTimeout(resolve, 5)); expect(test.routes).toHaveLength(1); ack.resolve({}); }
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      const request = test.routes[1].request(), proof = nativeMindbodyBootstrapSource(request);
      expect(proof).toEqual({ sourceUrl: source }); expect(Object.isFrozen(proof)).toBe(true);
      expect(nativeMindbodyBootstrapSource({ ...request })).toBeNull();
      expect(request.redirectedFrom()).toBeNull(); expect(test.routes[0].request().signal?.aborted).toBe(true);
      await test.routes[1].continue(); expect(test.failures).toEqual([]);
      expect(test.cdp.send.mock.calls.find(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "bootstrap"))
        .toEqual(["Fetch.continueRequest", { requestId: "bootstrap" }]);
      test.response("bootstrap", { resourceType: "Document", request: { url: actualTarget, method: "POST", headers, hasPostData: true, postData: body } });
      await request.response();
      await test.guard.beginDocumentNavigation(test.main as never); expect(nativeMindbodyBootstrapSource(request)).toBeNull();
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it.each(["missing intent", "script intent", "foreign frame", "new tab", "uncommitted", "changed document", "network body", "missing network body", "fetch body", "fetch origin", "network origin", "nonempty launch"])(
    "rejects a public-looking bootstrap with %s", async mode => {
      const test = await installed();
      try {
        await prepare(test, mode !== "uncommitted");
        if (mode === "changed document") test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: source + "&extra=1" });
        if (mode !== "missing intent") intent(test, mode === "script intent" ? { reason: "scriptInitiated" } : mode === "foreign frame" ? { frameId: "child" } : mode === "new tab" ? { disposition: "newTab" } : {});
        const changed = body.replace("launchUID=", "launchUID=private");
        network(test, { request: { url: target, method: "POST", headers: mode === "network origin" ? { "Content-Type": headers["Content-Type"] } : headers,
          hasPostData: true, ...(mode === "missing network body" ? {} : { postData: mode === "network body" ? body.replace("10%2F23", "10%2F24") : mode === "nonempty launch" ? changed : body }) } });
        post(test, { request: { url: target, method: "POST", headers: mode === "fetch origin" ? { "Content-Type": headers["Content-Type"] } : headers,
          hasPostData: true, postData: mode === "fetch body" ? body.replace("10%2F23", "10%2F24") : mode === "nonempty launch" ? changed : body } });
        await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.routes).toHaveLength(1);
        expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "bootstrap")).toBe(false);
      } finally { await test.guard.close(); }
    });
  it("does not attest an ordinary same-loader POST or reuse another request's source", async () => {
    const test = await installed();
    try { await prepare(test); network(test, { loaderId: "loader-source" }); post(test); await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(nativeMindbodyBootstrapSource(test.routes[1].request())).toBeNull();
    } finally { await test.guard.close(); }
  });
  it.each(["fetch flag", "network origin", "fetch origin", "encoding", "missing intent", "revision", "source binding", "no source", "navigation reason"] as const)("projects closed bootstrap predicates without changing denial: %s", async mode => {
    const test = await installed();
    try {
      await prepare(test, mode !== "no source");
      if (mode === "source binding") test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: source + "&extra=1" });
      const postBody = mode === "encoding" ? body.replaceAll("%2F", "%2f") : body;
      const withoutOrigin = { "Content-Type": headers["Content-Type"] };
      const identity = () => network(test, { request: { url: target, method: "POST", headers: mode === "network origin" ? withoutOrigin : headers, hasPostData: true, postData: postBody } });
      if (mode === "revision") identity();
      if (mode !== "missing intent") intent(test, mode === "navigation reason" ? { reason: "anchorClick" } : {});
      if (mode !== "revision") identity();
      post(test, { request: { url: target, method: "POST", headers: mode === "fetch origin" ? withoutOrigin : headers, ...(mode === "fetch flag" ? {} : { hasPostData: true }), postData: postBody } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.routes).toHaveLength(1);
      const diagnostic = test.guard.firstFatal!;
      const noIntent = ["missing intent", "source binding", "no source", "navigation reason"].includes(mode);
      expect(diagnostic).toMatchObject({ phase: "LOADER_OWNER", documentIntentKind: noIntent ? "NONE" : "PUBLIC_FORM_POST",
        documentIntentStatus: mode === "missing intent" ? "NO_EVENT" : mode === "source binding" ? "PUBLIC_SOURCE_NOT_ELIGIBLE" : mode === "no source" ? "NO_COMMITTED_SOURCE" : mode === "navigation reason" ? "NAVIGATION_NOT_ELIGIBLE" : "RETAINED",
        networkHasBody: true, networkBodyPresent: true, networkBodyMatches: true, postDataPresent: true, hasPostData: mode !== "fetch flag" });
      if (noIntent) { expect(diagnostic).not.toHaveProperty("fetchBootstrapPolicy"); expect(diagnostic).not.toHaveProperty("networkBootstrapPolicy"); }
      else expect(diagnostic).toMatchObject({ intentSourceIsGet: true, intentSourceBodyAbsent: true, intentSourceHtml: true, intentSourceUrlCurrent: true,
        intentSourceBindingValid: true, intentRevisionFresh: mode !== "revision", intentWithinDeadline: true,
        fetchBootstrapPolicy: mode === "encoding" ? "FORM_ENCODING" : mode === "fetch origin" ? "ORIGIN" : "VALID",
        networkBootstrapPolicy: mode === "encoding" ? "FORM_ENCODING" : mode === "network origin" ? "ORIGIN" : "VALID" });
      expect(diagnostic).not.toHaveProperty("body"); expect(diagnostic).not.toHaveProperty("headers"); expect(diagnostic).not.toHaveProperty("sourceUrl");
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "bootstrap")).toBe(false);
    } finally { await test.guard.close(); }
  });
  it.each(["source URL changes", "cancelled"] as const)("does not transfer bootstrap ownership while source ACK waits and %s", async mode => {
    const cancelled = new AbortController(), test = await installed(undefined, cancelled.signal), ack = deferred<object>();
    try {
      await prepare(test, true, ack); intent(test); network(test); post(test);
      await new Promise(resolve => setTimeout(resolve, 5)); expect(test.routes).toHaveLength(1);
      if (mode === "cancelled") cancelled.abort();
      else test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: source + "&changed=1" });
      ack.resolve({}); await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "bootstrap")).toBe(false);
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it.each(["target query", "source method", "source body", "current URL"] as const)("retains the rejected callback facts even without an intent: %s", async mode => {
    const test = await installed(), attemptedTarget = mode === "target query" ? target + "?studioid=12345" : target;
    try {
      await prepare(test, true, undefined, mode === "source method" ? "HEAD" : "GET", mode === "source body" ? "" : undefined);
      if (mode === "current URL") test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: source + "&extra=1" });
      intent(test, { url: attemptedTarget });
      network(test, { request: { url: attemptedTarget, method: "POST", headers, hasPostData: true, postData: body } });
      post(test, { request: { url: attemptedTarget, method: "POST", headers, hasPostData: true, postData: body } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.routes).toHaveLength(1);
      expect(test.guard.firstFatal).toMatchObject({ documentIntentKind: "NONE", documentIntentStatus: "PUBLIC_SOURCE_NOT_ELIGIBLE",
        intentCallbackSourceIsGet: mode !== "source method", intentCallbackSourceBodyAbsent: mode !== "source body", intentCallbackSourceUrlCurrent: mode !== "current URL",
        intentCallbackSourceBinding: mode === "target query" ? "TARGET" : mode === "current URL" ? "SOURCE_QUERY_COUNT" : "VALID",
        intentCallbackKnownSourceEndpoint: true, intentCallbackSourceQueryCount: mode === "current URL" ? 3 : 2,
        intentCallbackTargetOriginMatches: true, intentCallbackTargetPathMatches: true, intentCallbackTargetQueryPresent: mode === "target query", intentCallbackTargetFragmentPresent: false,
        intentCallbackTargetQueryCount: mode === "target query" ? 1 : 0,
        intentCallbackTargetQuery: mode === "target query" ? [{ key: "studioid", occurrences: 1, canonicalKeys: true, valueClasses: ["NONEMPTY"] }] : [] });
      expect(JSON.stringify(test.guard.firstFatal?.intentCallbackTargetQuery)).not.toContain("685163");
    } finally { await test.guard.close(); }
  });
  it.each([302, 303])("attests the exact released public bootstrap %i to a bodyless same-origin GET", async status => {
    const test = await installed();
    const destination = "https://clients.mindbodyonline.com/ASP/adm/adm_appt_search.asp", roots = new Set([source]);
    try {
      await prepare(test); intent(test); network(test); post(test); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); await test.routes[1].continue();
      const parent = test.routes[1].request();
      expect(isObservedNativeRedirectTarget(parent, destination, roots)).toBe(false);
      test.response("bootstrap", { resourceType: "Document", request: { url: target, method: "POST", headers, hasPostData: true, postData: body }, responseStatusCode: status, responseHeaders: [{ name: "Location", value: destination }] });
      await test.routes[1].request().response();
      expect(isObservedNativeRedirectTarget(parent, destination, roots)).toBe(true);
      expect(isObservedNativeRedirectTarget(parent, destination, new Set([target]))).toBe(false);
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-bootstrap", loaderId: "loader-post", frameId: "main", type: "Document", request: { url: destination, method: "GET", headers: {} } });
      test.request("redirected", { networkId: "network-bootstrap", redirectedRequestId: "bootstrap", resourceType: "Document", request: { url: destination, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(3));
      const child = test.routes[2].request();
      expect(child.redirectedFrom()).toBe(parent); expect(child.postData()).toBeNull();
      expect(isObservedNativeRedirect(child, roots)).toBe(true);
      expect(isObservedNativeRedirect({ ...child }, roots)).toBe(false);
      await test.routes[2].continue();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(3);
      expect(test.failures).toEqual([]);
      await test.guard.close(); expect(isObservedNativeRedirect(child, roots)).toBe(false);
    } finally { await test.guard.close(); }
  });
  it("waits for the exact bootstrap redirect response ACK before releasing its GET child", async () => {
    const test = await installed(), ack = deferred<object>(), destination = "https://clients.mindbodyonline.com/ASP/adm/adm_appt_search.asp";
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, values) => name === "Fetch.continueResponse" && values?.requestId === "bootstrap" ? ack.promise : send(name, values));
    try {
      await prepare(test); intent(test); network(test); post(test); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); await test.routes[1].continue();
      test.response("bootstrap", { resourceType: "Document", request: { url: target, method: "POST", headers, hasPostData: true, postData: body }, responseStatusCode: 302, responseHeaders: [{ name: "Location", value: destination }] });
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-bootstrap", loaderId: "loader-post", frameId: "main", type: "Document", request: { url: destination, method: "GET", headers: {} } });
      test.request("redirected", { networkId: "network-bootstrap", redirectedRequestId: "bootstrap", resourceType: "Document", request: { url: destination, method: "GET", headers: {} } });
      await new Promise(resolve => setTimeout(resolve, 5)); expect(test.routes).toHaveLength(2);
      expect(isObservedNativeRedirectTarget(test.routes[1].request(), destination, new Set([source]))).toBe(false);
      ack.resolve({}); await vi.waitFor(() => expect(test.routes).toHaveLength(3));
      expect(isObservedNativeRedirect(test.routes[2].request(), new Set([source]))).toBe(true); expect(test.failures).toEqual([]);
    } finally { ack.resolve({}); await test.guard.close(); }
  });
  it("keeps an ordinary POST 303 untrusted even with the exact public-looking form", async () => {
    const test = await installed(), destination = "https://clients.mindbodyonline.com/ASP/adm/adm_appt_search.asp";
    try {
      post(test); await test.routes[0].continue();
      test.response("bootstrap", { resourceType: "Document", request: { url: target, method: "POST", headers, hasPostData: true, postData: body }, responseStatusCode: 303, responseHeaders: [{ name: "Location", value: destination }] });
      await test.routes[0].request().response();
      expect(isObservedNativeRedirectTarget(test.routes[0].request(), destination, new Set([source, target]))).toBe(false);
      test.request("redirected", { networkId: "network-bootstrap", redirectedRequestId: "bootstrap", resourceType: "Document", request: { url: destination, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.routes).toHaveLength(1);
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_PROVENANCE_REJECTED", redirectParentStatus: 303, redirectBootstrapAttested: false });
    } finally { await test.guard.close(); }
  });
  it.each(["200", "301", "307", "308", "body", "network body", "POST", "HEAD", "different network", "different origin", "login", "checkout", "credential query", "wrong Location", "duplicate Location"] as const)("keeps the public bootstrap redirect bounded: %s", async mode => {
    const test = await installed();
    const destination = mode === "different origin" ? "https://other.example.org/calendar" : mode === "login" ? "https://clients.mindbodyonline.com/login"
      : mode === "checkout" ? "https://clients.mindbodyonline.com/checkout" : mode === "credential query" ? "https://clients.mindbodyonline.com/calendar?token=private-value"
        : "https://clients.mindbodyonline.com/ASP/adm/adm_appt_search.asp";
    const status = ["200", "301", "307", "308"].includes(mode) ? Number(mode) : 302;
    const childMethod = mode === "POST" || mode === "HEAD" ? mode : "GET";
    const networkId = mode === "different network" ? "network-other" : "network-bootstrap";
    try {
      await prepare(test); intent(test); network(test); post(test); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); await test.routes[1].continue();
      test.response("bootstrap", { resourceType: "Document", request: { url: target, method: "POST", headers, hasPostData: true, postData: body }, responseStatusCode: status,
        responseHeaders: [{ name: "Location", value: mode === "wrong Location" ? source : destination }, ...(mode === "duplicate Location" ? [{ name: "location", value: destination }] : [])] });
      await test.routes[1].request().response();
      test.events.get("Network.requestWillBeSent")!({ requestId: networkId, loaderId: "loader-post", frameId: "main", type: "Document",
        request: { url: destination, method: childMethod, headers: {}, ...(mode === "network body" ? { hasPostData: true, postData: "" } : {}) } });
      test.request("redirected", { networkId, redirectedRequestId: "bootstrap", resourceType: "Document",
        request: { url: destination, method: childMethod, headers: {}, ...(mode === "body" ? { hasPostData: true, postData: "" } : {}) } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce()); expect(test.routes).toHaveLength(2); expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED");
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_PROVENANCE_REJECTED", phase: "REDIRECT_PROVENANCE", method: childMethod,
        parentPresent: true, redirectParentMethod: "POST", redirectParentStatus: status, redirectParentComplete: true, redirectBootstrapAttested: true });
      expect(JSON.stringify(test.guard.firstFatal)).not.toContain("private-value");
    } finally { await test.guard.close(); }
  });
});

describe("native one-shot renderer navigation ownership", () => {
  const source = "https://example.org/data", target = "https://example.org/teetimes";
  type Test = Awaited<ReturnType<typeof installed>>;
  const identity = (test: Test, id: string, loader: string, url = target, method = "GET") => test.events.get("Network.requestWillBeSent")!({
    requestId: `network-${id}`, loaderId: loader, frameId: "main", type: "Document", request: { url, method } });
  const intent = (test: Test, values: object = {}) => test.events.get("Page.frameRequestedNavigation")!({
    frameId: "main", reason: "scriptInitiated", disposition: "currentTab", url: target, ...values });
  const successor = (test: Test, id = "successor", values: object = {}) => test.request(id, { resourceType: "Document",
    request: { url: target, method: "GET", headers: {} }, ...values });
  const prepare = async (test: Test, commit = true, html = false) => {
    await test.guard.beginDocumentNavigation(test.main as never);
    identity(test, "document", "loader-source", source);
    test.request("document", { resourceType: "Document" }); await test.routes[0].continue();
    test.response("document", { resourceType: "Document", ...(html ? { responseHeaders: [{ name: "Content-Type", value: "text/html" }] } : {}) });
    await test.routes[0].request().response();
    if (commit) test.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "loader-source", url: source } });
  };

  it("holds the exact successor until its committed source response ACK completes", async () => {
    const test = await installed(), ack = deferred<void>(), send = test.cdp.send.getMockImplementation()!;
    try {
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueResponse" && value?.requestId === "document" ? ack.promise : send(name, value));
      await test.guard.beginDocumentNavigation(test.main as never);
      identity(test, "document", "loader-source", source); test.request("document", { resourceType: "Document" });
      await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(true));
      test.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "loader-source", url: source } });
      intent(test); identity(test, "successor", "loader-next"); successor(test);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(test.routes).toHaveLength(1);
      expect(test.routes[0].request().signal?.aborted).toBe(false);
      ack.resolve(); await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(test.routes[0].request().signal?.aborted).toBe(true);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Page.stopLoading")).toHaveLength(1);
      expect(test.failures).toEqual([]);
    } finally { ack.resolve(); await test.guard.close(); }
  });

  it("admits one exact observed anchor GET through native successor retirement without claiming an HTTP redirect", async () => {
    let available = true;
    const grant = vi.fn((from: string, to: string) => { const admitted = available && from === source && to === target; available = false; return admitted; });
    const test = await installed(undefined, undefined, undefined, undefined, undefined, grant);
    try {
      await prepare(test, true, true); intent(test, { reason: "anchorClick" });
      expect(grant).toHaveBeenCalledExactlyOnceWith(source, target);
      identity(test, "successor", "loader-next"); successor(test);
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(test.routes[0].request().signal?.aborted).toBe(true);
      expect(test.routes[1].request().url()).toBe(target);
      expect(test.routes[1].request().redirectedFrom()).toBeNull();
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["current", "revised", "failed"])("checks completed anchor GET then same-loader SPA document ownership (%s)", async mode => {
    const test = await installed(undefined, undefined, undefined, undefined, undefined, (from, to) => from === source && to === target);
    try {
      await prepare(test, true, true); intent(test, { reason: "anchorClick" });
      identity(test, "successor", "loader-next"); successor(test);
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      await test.routes[1].continue();
      test.response("successor", { resourceType: "Document", request: { url: target, method: "GET", headers: {} }, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
      await test.routes[1].request().response();
      test.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "loader-next", url: target } });
      const request = test.routes[1].request(), spa = target + "/public", captured = { frameId: "main", loaderId: "loader-next", url: spa };
      test.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: spa });
      await vi.waitFor(() => expect(test.guard.isCurrentCompletedDocumentRead(request, test.main as never, captured)).toBe(true));
      if (mode === "revised") identity(test, "successor", "loader-next", target);
      if (mode === "failed") test.events.get("Network.loadingFailed")!({ requestId: "network-successor" });
      expect(test.guard.isCurrentCompletedDocumentRead(request, test.main as never, captured)).toBe(mode === "current");
      expect(request.url()).toBe(target);
      expect(test.guard.isCurrentCompletedDocumentRead(test.routes[0].request(), test.main as never, captured)).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["denied", "foreign frame", "wrong target", "stale identity", "expired", "POST", "HEAD", "GET body", "reused"])(
    "rejects an observed anchor with %s without dispatching its successor", async mode => {
      let available = true;
      const grant = vi.fn((from: string, to: string) => { const admitted = mode !== "denied" && available && from === source && to === target; available = false; return admitted; });
      const test = await installed(undefined, undefined, undefined, undefined, undefined, grant);
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await prepare(test, true, true);
        if (mode === "stale identity") identity(test, "document", "loader-source", source);
        intent(test, { reason: "anchorClick", ...(mode === "foreign frame" ? { frameId: "child" } : mode === "wrong target" ? { url: source + "/other" } : {}) });
        if (mode === "foreign frame" || mode === "stale identity") expect(grant).not.toHaveBeenCalled();
        if (mode === "reused") intent(test, { reason: "anchorClick" });
        if (mode === "expired") clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 101);
        const method = mode === "POST" ? "POST" : mode === "HEAD" ? "HEAD" : "GET";
        identity(test, "successor", "loader-next", target, method);
        successor(test, "successor", { request: { url: target, method, headers: {}, ...(mode === "GET body" ? { hasPostData: true, postData: "body" } : {}) } });
        await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
        expect(test.routes).toHaveLength(1);
        expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "successor")).toBe(false);
      } finally { clock?.mockRestore(); await test.guard.close(); }
    });

  it.each(["missing", "wrong target", "foreign frame", "anchor", "new tab", "uncommitted", "wrong commit URL", "wrong commit loader", "expired", "network before intent", "POST", "GET body"])(
    "rejects unknown document ownership with %s intent", async mode => {
      const test = await installed(); let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await prepare(test, !["uncommitted", "wrong commit URL", "wrong commit loader"].includes(mode));
        if (mode.startsWith("wrong commit")) test.events.get("Page.frameNavigated")!({ frame: { id: "main",
          loaderId: mode === "wrong commit loader" ? "unknown" : "loader-source", url: mode === "wrong commit URL" ? target : source } });
        if (mode === "network before intent") identity(test, "successor", "loader-next");
        if (mode !== "missing") intent(test, mode === "wrong target" ? { url: "https://example.org/other" }
          : mode === "foreign frame" ? { frameId: "child" } : mode === "anchor" ? { reason: "anchorClick" }
            : mode === "new tab" ? { disposition: "newTab" } : {});
        if (mode === "expired") clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 101);
        if (mode !== "network before intent") identity(test, "successor", "loader-next", target, mode === "POST" ? "POST" : "GET");
        successor(test, "successor", { request: { url: target, method: mode === "POST" ? "POST" : "GET", headers: {},
          ...(mode === "GET body" ? { hasPostData: true, postData: "body" } : {}) } });
        await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
        expect(test.routes).toHaveLength(1);
        expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "successor")).toBe(false);
        expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_LOADER_MISMATCH", phase: "LOADER_OWNER" });
      } finally { clock?.mockRestore(); await test.guard.close(); }
    });

  it("cannot transfer an intent across an explicit document boundary", async () => {
    const test = await installed();
    try {
      await prepare(test); intent(test); await test.guard.beginDocumentNavigation(test.main as never);
      identity(test, "new-document", "loader-explicit", source); test.request("new-document", { resourceType: "Document" });
      identity(test, "successor", "loader-next"); successor(test);
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.routes).toHaveLength(2);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "successor")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["success", "target cancelled", "session cancelled", "duplicate", "explicit boundary overlap", "old handler hangs"])("protects the paused successor while its old handler drains (%s)", async mode => {
    const held = deferred<void>(), cancellation = new AbortController(), test = await installed(undefined, cancellation.signal, async route => {
      if (route.request().url() === source) await held.promise;
    });
    try {
      await prepare(test); intent(test); identity(test, "successor", "loader-next"); successor(test);
      await vi.waitFor(() => expect(test.routes[0].request().signal?.aborted).toBe(true));
      expect(test.routes).toHaveLength(1);
      if (mode === "target cancelled") test.events.get("Network.loadingFailed")!({ requestId: "network-successor" });
      if (mode === "session cancelled") cancellation.abort();
      if (mode === "duplicate") { identity(test, "duplicate", "loader-duplicate"); successor(test, "duplicate"); }
      if (mode === "explicit boundary overlap") await expect(test.guard.beginDocumentNavigation(test.main as never)).rejects.toThrow("NATIVE_REDIRECT_NAVIGATION_REJECTED");
      if (mode !== "old handler hangs") held.resolve();
      if (mode === "target cancelled" || mode === "session cancelled" || mode === "old handler hangs") {
        await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
        expect(test.routes).toHaveLength(1);
        expect(test.failures).toContain(mode === "target cancelled" ? "NATIVE_REDIRECT_NETWORK_FAILED"
          : mode === "session cancelled" ? "NATIVE_REDIRECT_CANCELLED" : "NATIVE_REDIRECT_DRAIN_TIMEOUT");
      } else {
        await vi.waitFor(() => expect(test.routes).toHaveLength(2)); expect(test.failures).toEqual([]);
      }
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "successor")).toBe(false);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "duplicate")).toBe(false);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Page.stopLoading")).toHaveLength(1);
    } finally { held.resolve(); await test.guard.close(); }
  });

  it.each(["missing", "URL", "method", "kind", "frame"])("cannot adopt a renderer intent with %s Network identity", async mismatch => {
    const test = await installed();
    try {
      await prepare(test); intent(test);
      if (mismatch !== "missing") test.events.get("Network.requestWillBeSent")!({ requestId: "network-successor", loaderId: "loader-next",
        frameId: mismatch === "frame" ? "foreign" : "main", type: mismatch === "kind" ? "XHR" : "Document",
        request: { url: mismatch === "URL" ? source : target, method: mismatch === "method" ? "POST" : "GET" } });
      successor(test);
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "successor")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("never dispatches the successor if an old pause abort ACK %s", async mode => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    try {
      await prepare(test);
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-old", loaderId: "loader-source", frameId: "main", type: "XHR", request: { url: source, method: "GET" } });
      test.request("old");
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "old"
        ? mode === "hang" ? new Promise(() => {}) : Promise.reject(new Error("offline abort rejected")) : send(name, value));
      intent(test); identity(test, "successor", "loader-next"); successor(test);
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.routes).toHaveLength(2);
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "successor")).toBe(false);
    } finally { await test.guard.close(); }
  });
});

const nativeChromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
describe.runIf(existsSync(nativeChromePath))("offline Chrome document ownership", () => {
  it.each(["HTTP redirect", "SPA replacement", "denied SPA replacement", "late old navigation"] as const)("tracks actual root to tee-times document ownership with unchanged shared read guards (%s)", async mode => {
    const reads: string[] = [], failures: string[] = [], bodies: string[] = [], handled: string[] = [];
    const trace: Array<Record<string, unknown>> = [], stopEntered = deferred<void>(), stopReleased = deferred<void>();
    let retiring = false;
    const server = createServer((request, response) => {
      const path = request.url!; reads.push(path);
      if (path === "/teetimes" && mode === "HTTP redirect") { response.writeHead(302, { Location: "/" }); response.end(); return; }
      response.setHeader("Content-Type", "text/html");
      response.end('<link rel="icon" href="data:,"><h1>' + (path === "/" ? "Public root" : "Public tee times") + '</h1>' +
        (path === "/teetimes" && mode.includes("SPA replacement") ? `<script>location.replace(${JSON.stringify(mode === "denied SPA replacement" ? "/checkout" : "/")});</script>` : ""));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ executablePath: nativeChromePath, headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage(), session = new AbortController();
    const cdp = await context.newCDPSession(page), rootFrame = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    cdp.on("Page.frameNavigated", event => {
      if (event.frame.id === rootFrame && event.frame.url.startsWith(url)) trace.push({ event: "Page.frameNavigated",
        path: new URL(event.frame.url).pathname, loaderId: event.frame.loaderId, rootFrame: true, boundaryPending: retiring });
    });
    cdp.on("Page.frameRequestedNavigation", event => {
      if (event.frameId === rootFrame && event.url.startsWith(url)) trace.push({ event: "Page.frameRequestedNavigation",
        path: new URL(event.url).pathname, reason: event.reason, disposition: event.disposition, rootFrame: true, boundaryPending: retiring });
    });
    await cdp.send("Page.enable");
    const controlled = {
      on(name: string, listener: (event: unknown) => void) {
        cdp.on(name as never, (event: unknown) => {
          const value = event as { requestId?: string; networkId?: string; redirectedRequestId?: string; resourceType?: string; type?: string;
            frameId?: string; loaderId?: string; responseStatusCode?: number; responseErrorReason?: string; request?: { url?: string }; redirectResponse?: { status: number } };
          if (value.request?.url?.startsWith(url)) trace.push({ event: name, path: new URL(value.request.url).pathname,
            requestId: value.requestId, networkId: value.networkId, loaderId: value.loaderId, parentId: value.redirectedRequestId,
            kind: value.type ?? value.resourceType, rootFrame: value.frameId === rootFrame,
            responseStage: value.responseStatusCode !== undefined || value.responseErrorReason !== undefined,
            redirectStatus: value.redirectResponse?.status, boundaryPending: retiring });
          listener(event);
        });
      },
      send(name: string, values?: object) {
        if (name === "Page.stopLoading" && retiring && mode === "late old navigation") {
          const stopped = cdp.send(name as never, values as never);
          stopEntered.resolve(); return stopped.then(result => stopReleased.promise.then(() => result));
        }
        return cdp.send(name as never, values as never);
      }, detach: () => cdp.detach(),
    };
    vi.spyOn(context, "newCDPSession").mockResolvedValue(controlled as never);
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => ({ acquired: true as const, value: await work() }), session.signal);
    const guard = await installNativeRedirectRouting(page, async route => {
      handled.push(new URL(route.request().url()).pathname);
      if (new URL(route.request().url()).pathname === "/checkout") { await route.abort(); return; }
      const reply = await queue.run("fixture", () => continueNativeBrowserRead(route, session.signal, 10_000), route.request().signal);
      if (!route.request().signal?.aborted) bodies.push(reply.body.toString());
    }, { timeoutMs: 3000, maxRequests: 16, onFailure: code => failures.push(code) });
    let boundary: Promise<void> | undefined;
    try {
      await context.route("**/*", route => guard.releasePlaywrightRoute(route));
      await guard.beginDocumentNavigation(page.mainFrame()); await page.goto(`${url}/`, { waitUntil: "load", timeout: 5000 });
      await vi.waitFor(() => expect(guard.pendingReads).toBe(0));
      retiring = true; boundary = guard.beginDocumentNavigation(page.mainFrame()); boundary.catch(() => {});
      if (mode === "late old navigation") {
        await stopEntered.promise;
        await page.evaluate(() => { location.assign("/"); }).catch(() => {});
        await vi.waitFor(() => expect(trace.filter(row => row.event === "Fetch.requestPaused" && row.path === "/" && !row.responseStage)).toHaveLength(2));
        await vi.waitFor(() => expect(guard.pendingReads).toBe(0));
        expect(reads.filter(path => path === "/")).toHaveLength(1);
        expect(handled).toEqual(["/"]); stopReleased.resolve();
      }
      await boundary; retiring = false;
      let navigationError: string | undefined;
      try { await page.goto(`${url}/teetimes`, { waitUntil: "load", timeout: 5000 }); }
      catch (error) { navigationError = error instanceof Error ? error.name : "UNKNOWN"; }
      await vi.waitFor(() => expect(guard.pendingReads).toBe(0));
      console.info("LOCAL_NATIVE_NAVIGATION_TRACE", JSON.stringify({ mode, trace, handled, reads, failures, firstFatal: guard.firstFatal ?? null, navigationError }));
      expect(failures).toEqual([]);
      expect(guard.firstFatal).toBeUndefined();
      if (mode === "denied SPA replacement") {
        expect(handled).toEqual(["/", "/teetimes", "/checkout"]);
        expect(reads).toEqual(["/", "/teetimes"]);
        expect(bodies).toHaveLength(2); return;
      }
      expect(bodies.some(body => body.includes(mode === "late old navigation" ? "Public tee times" : "Public root"))).toBe(true);
      expect(await page.locator("h1").innerText()).toBe(mode === "late old navigation" ? "Public tee times" : "Public root");
    } finally {
      stopReleased.resolve(); await boundary?.catch(() => {}); session.abort(); await guard.close(); queue.dispose(); await browser.close();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20_000);

  it.each(["inline icon", "late incidental fetch"])("drains one real response pause once while another initial abort ACK is held (%s)", async icon => {
    const reads: string[] = [], bodies: string[] = [], failures: string[] = [], commandFailures: { command: string; path: string | null; error: string }[] = [];
    const faviconLifecycle: { event: string; kind?: string; responseStage?: boolean; networkKnown?: boolean; rootFrame?: boolean; loaderMatchesDocument?: boolean }[] = [];
    const initialAck = deferred<void>(), responseAck = deferred<void>(), stopAck = deferred<void>();
    let releaseOldResponse: (() => void) | undefined, publishFaviconFailure: (() => void) | undefined, retiring = false, faviconAborts = 0;
    const server = createServer((request, response) => {
      reads.push(request.url!);
      if (request.url === "/old.js") {
        response.setHeader("Content-Type", "application/javascript");
        releaseOldResponse = () => response.end("window.oldRetiredScriptExecuted = true;"); return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end('<link rel="icon" href="data:,">' + (request.url === "/" ? '<h1>Old public document</h1><script async src="/old.js"></script><script async src="/provisional.js"></script>' : '<h1>Successor public document</h1>'));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ executablePath: nativeChromePath, headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage(), session = new AbortController();
    const cdp = await context.newCDPSession(page), requestUrls = new Map<string, string>(), networkUrls = new Map<string, string>();
    const rootFrame = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    let documentLoader: string | undefined;
    let initialAborts = 0, responseAborts = 0, active = 0, maximum = 0;
    const send = (name: string, values?: { requestId?: string }) => cdp.send(name as never, values as never).catch(error => {
      const target = values?.requestId ? requestUrls.get(values.requestId) : undefined;
      if (target === `${url}/favicon.ico`) faviconLifecycle.push({ event: `${name}:REJECTED` });
      commandFailures.push({ command: name, path: target ? new URL(target).pathname : null, error: error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN" });
      throw error;
    });
    const controlled = {
      on(name: string, listener: (event: unknown) => void) {
        cdp.on(name as never, (event: unknown) => {
          const value = event as { requestId?: string; networkId?: string; resourceType?: string; type?: string; frameId?: string; loaderId?: string; responseStatusCode?: number; responseErrorReason?: string; request?: { url?: string } };
          if (name === "Network.requestWillBeSent" && value.requestId && value.request?.url) networkUrls.set(value.requestId, value.request.url);
          if (name === "Network.requestWillBeSent" && value.type === "Document" && value.request?.url === `${url}/`) documentLoader = value.loaderId;
          if (name === "Fetch.requestPaused" && value.requestId && value.request?.url) requestUrls.set(value.requestId, value.request.url);
          if (name === "Network.requestWillBeSent" && value.request?.url === `${url}/favicon.ico`) faviconLifecycle.push({ event: name, kind: value.type, rootFrame: value.frameId === rootFrame, loaderMatchesDocument: value.loaderId === documentLoader });
          if (name === "Fetch.requestPaused" && value.request?.url === `${url}/favicon.ico`) faviconLifecycle.push({ event: name, kind: value.resourceType,
            responseStage: value.responseStatusCode !== undefined || value.responseErrorReason !== undefined, networkKnown: Boolean(value.networkId && networkUrls.get(value.networkId) === value.request.url) });
          if (name === "Network.loadingFailed" && value.requestId && networkUrls.get(value.requestId) === `${url}/favicon.ico`) {
            faviconLifecycle.push({ event: name, kind: value.type });
            // Retain this actual exact-ID event, but do not publish terminal
            // proof until after checking that the failed command alone cannot
            // settle the navigation boundary.
            publishFaviconFailure = () => listener(event); return;
          }
          // Delay only this real local request's Network metadata. The actual
          // Fetch pause remains guarded and cannot reach the shared lease lane.
          if (name === "Network.requestWillBeSent" && value.request?.url === `${url}/provisional.js`) return;
          listener(event);
        });
      },
      send(name: string, values?: { requestId?: string }) {
        const target = values?.requestId ? requestUrls.get(values.requestId) : undefined;
        if (name === "Page.stopLoading" && retiring) return send(name, values).then(value => { stopAck.resolve(); return value; });
        if (name === "Fetch.failRequest" && target === `${url}/favicon.ico`) {
          faviconAborts++; return stopAck.promise.then(() => send(name, values));
        }
        if (name === "Fetch.failRequest" && target === `${url}/provisional.js`) {
          initialAborts++; return initialAck.promise.then(() => send(name, values));
        }
        if (name === "Fetch.failRequest" && target === `${url}/old.js`) {
          responseAborts++; return responseAck.promise.then(() => send(name, values));
        }
        return send(name, values);
      },
      detach: () => cdp.detach(),
    };
    vi.spyOn(context, "newCDPSession").mockResolvedValue(controlled as never);
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => {
      active++; maximum = Math.max(maximum, active);
      try { return { acquired: true as const, value: await work() }; } finally { active--; }
    }, session.signal);
    // Loopback admission belongs only to this isolated test. All real CDP
    // pause/response/body and lease handling uses the production helper.
    const guard = await installNativeRedirectRouting(page, async route => {
      try {
        const reply = await queue.run("fixture", () => continueNativeBrowserRead(route, session.signal, 10_000), route.request().signal);
        if (!route.request().signal?.aborted) bodies.push(reply.body.toString());
      } catch (error) { if (!isNativeReadSupersededFailure(error)) throw error; }
    }, { timeoutMs: 5_000, maxRequests: 16, onFailure: value => failures.push(value) });
    let boundary: Promise<void> | undefined;
    try {
      await context.route("**/*", route => guard.releasePlaywrightRoute(route));
      await guard.beginDocumentNavigation(page.mainFrame()); await page.goto(`${url}/`, { waitUntil: "commit" });
      await vi.waitFor(() => { expect(releaseOldResponse).toBeDefined(); expect([...requestUrls.values()]).toContain(`${url}/provisional.js`); });
      expect(reads).not.toContain("/provisional.js"); expect(active).toBe(1);
      let finished = false;
      retiring = true;
      boundary = guard.beginDocumentNavigation(page.mainFrame()).then(() => { finished = true; }); boundary.catch(() => {});
      await vi.waitFor(() => expect(initialAborts).toBe(1));
      if (icon === "late incidental fetch") {
        await page.evaluate(() => { void fetch("/favicon.ico").catch(() => {}); });
        await vi.waitFor(() => expect(faviconAborts).toBe(1));
        expect(reads).not.toContain("/favicon.ico");
      }
      releaseOldResponse!(); await vi.waitFor(() => expect(responseAborts).toBe(1));
      initialAck.resolve(); await new Promise(resolve => setTimeout(resolve, 20));
      expect(responseAborts).toBe(1); expect(finished).toBe(false); expect(active).toBe(1);
      responseAck.resolve();
      if (icon === "late incidental fetch") {
        await vi.waitFor(() => { expect(commandFailures.some(item => item.path === "/favicon.ico")).toBe(true); expect(publishFaviconFailure).toBeDefined(); });
        expect({ failures, boundaryComplete: finished, terminalCaptured: Boolean(publishFaviconFailure) }).toEqual({ failures: [], boundaryComplete: false, terminalCaptured: true });
        publishFaviconFailure!();
      }
      await boundary;
      expect(active).toBe(0); expect(reads).not.toContain("/provisional.js");
      expect(bodies.some(body => body.includes("oldRetiredScriptExecuted"))).toBe(false);
      expect(commandFailures).toEqual(icon === "inline icon" ? [] : [{ command: "Fetch.failRequest", path: "/favicon.ico", error: expect.stringContaining("Invalid InterceptionId") }]);
      expect(faviconLifecycle.some(item => item.event === "Network.loadingFailed")).toBe(icon === "late incidental fetch");
      expect(failures, JSON.stringify(faviconLifecycle)).toEqual([]); expect(guard.firstFatal).toBeUndefined();
      await page.goto(`${url}/next`, { waitUntil: "commit" });
      await expect(page.locator("h1").innerText()).resolves.toBe("Successor public document");
      await vi.waitFor(() => expect(guard.pendingReads).toBe(0));
      expect(failures).toEqual([]); expect(guard.firstFatal).toBeUndefined(); expect(maximum).toBe(1);
      expect(initialAborts).toBe(1); expect(responseAborts).toBe(1);
    } finally {
      initialAck.resolve(); responseAck.resolve(); stopAck.resolve(); publishFaviconFailure?.(); await boundary?.catch(() => {});
      session.abort(); await guard.close(); queue.dispose(); await browser.close();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20_000);

  it("loads actual document and script HTTP redirects with document-generation tracking enabled", async () => {
    const reads: string[] = [], bodies: string[] = [], failures: string[] = [];
    const server = createServer((request, response) => {
      const path = request.url!; reads.push(path);
      if (path === "/start" || path === "/old.js") {
        response.writeHead(302, { Location: path === "/start" ? "/" : "/current.js" }); response.end(); return;
      }
      response.setHeader("Content-Type", path === "/current.js" ? "application/javascript" : "text/html");
      response.end(path === "/current.js" ? 'document.documentElement.dataset.publicRead="complete";' :
        '<h1>Public redirected course</h1><script defer src="/old.js"></script>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ executablePath: nativeChromePath, headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage(), session = new AbortController();
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => ({ acquired: true as const, value: await work() }), session.signal);
    const guard = await installNativeRedirectRouting(page, async route => {
      const reply = await queue.run("fixture", () => continueNativeBrowserRead(route, session.signal, 5000), route.request().signal);
      bodies.push(reply.body.toString());
    }, { timeoutMs: 3000, maxRequests: 16, onFailure: code => failures.push(code) });
    try {
      await guard.beginDocumentNavigation(page.mainFrame()); await page.goto(`${url}/start`, { waitUntil: "domcontentloaded" });
      await vi.waitFor(() => expect(guard.pendingReads).toBe(0));
      expect(await page.locator("h1").innerText()).toBe("Public redirected course");
      expect(await page.locator("html").getAttribute("data-public-read")).toBe("complete");
      expect(reads).toEqual(expect.arrayContaining(["/start", "/", "/old.js", "/current.js"]));
      expect(bodies.some(body => body.includes("Public redirected course"))).toBe(true);
      expect(failures).toEqual([]); expect(guard.firstFatal).toBeUndefined();
    } finally {
      session.abort(); await guard.close(); queue.dispose(); await browser.close();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15_000);

  it("terminates an old real document's active/queued assets before the next document uses the same lease lane", async () => {
    const reads: string[] = [], closed: string[] = [], bodies: string[] = [], failures: string[] = [];
    const server = createServer((request, response) => {
      const path = request.url!; reads.push(path);
      if (path === "/old.js" || path === "/queued.js") { request.on("close", () => closed.push(path)); return; }
      response.setHeader("Content-Type", "text/html");
      response.end(path === "/" ? '<h1>Public old golf document</h1><a href="/next">Book tee times</a><script defer src="/old.js"></script><script defer src="/queued.js"></script>' : '<h1>Public successor golf document</h1>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ executablePath: nativeChromePath, headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage(), session = new AbortController();
    let active = 0, maximum = 0, releases = 0;
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => {
      active++; maximum = Math.max(maximum, active);
      try { return { acquired: true as const, value: await work() }; } finally { active--; releases++; }
    }, session.signal);
    // Only this isolated local fixture admits loopback; production still runs
    // the unchanged public URL/DNS/provider checks in its shared route handler.
    const guard = await installNativeRedirectRouting(page, async route => {
      try {
        const reply = await queue.run("fixture", () => continueNativeBrowserRead(route, session.signal, 10_000), route.request().signal);
        if (!route.request().signal?.aborted) bodies.push(reply.body.toString());
      } catch (error) { if (!isNativeReadSupersededFailure(error)) throw error; }
    }, { timeoutMs: 5_000, maxRequests: 16, onFailure: value => failures.push(value) });
    try {
      await guard.beginDocumentNavigation(page.mainFrame()); await page.goto(`${url}/`, { waitUntil: "commit" });
      await vi.waitFor(() => { expect(reads).toContain("/old.js"); expect(guard.pendingReads).toBeGreaterThanOrEqual(2); });
      expect(reads).not.toContain("/queued.js");
      await guard.beginDocumentNavigation(page.mainFrame());
      expect(active).toBe(0); expect(releases).toBeGreaterThanOrEqual(2);
      await vi.waitFor(() => expect(closed).toContain("/old.js"));
      await page.goto(`${url}/next`, { waitUntil: "commit" });
      await expect(page.locator("h1").innerText()).resolves.toBe("Public successor golf document");
      await vi.waitFor(() => expect(guard.pendingReads).toBe(0));
      expect(bodies.some(body => body.includes("Public successor"))).toBe(true);
      expect(reads).not.toContain("/queued.js"); expect(failures).toEqual([]); expect(maximum).toBe(1);
      expect(guard.firstFatal).toBeUndefined();
    } finally {
      session.abort(); await guard.close(); queue.dispose(); await browser.close();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20_000);
});

describe("native exact request and response ownership", () => {
  it("gives two identical reads distinct exact response/body identities without Playwright matching", async () => {
    const test = await installed();
    try {
      test.request("one"); test.request("two"); expect(test.routes).toHaveLength(2);
      await Promise.all(test.routes.map(route => route.continue()));
      const responses = test.routes.map(route => route.request().response());
      test.response("two"); test.response("one");
      expect(await Promise.all(responses.map(async promise => (await (await promise)?.body())?.toString()))).toEqual(["body-one", "body-two"]);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest").map(([, value]) => value?.requestId)).toEqual(["one", "two"]);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it("preserves exact POST bodies and all Chrome request headers on independent records", async () => {
    const test = await installed();
    try {
      for (const date of ["2026-10-23", "2026-10-24"]) test.request(date, { request: { url: "https://example.org/data", method: "POST",
        headers: { "Next-Action": date, Cookie: `anonymous=${date}`, "X-Requested-With": "XMLHttpRequest" }, hasPostData: true, postData: JSON.stringify({ date }) } });
      expect(test.routes.map(route => JSON.parse(route.request().postData()!).date)).toEqual(["2026-10-23", "2026-10-24"]);
      expect(test.routes[1].request().headers()).toMatchObject({ "next-action": "2026-10-24", cookie: "anonymous=2026-10-24", "x-requested-with": "XMLHttpRequest" });
      await test.routes[0].abort(); await test.routes[1].continue();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it.each(["Document", "Script", "XHR", "Fetch", "Other"])("retains exact Chrome resource kind %s", async kind => {
    const test = await installed();
    try { test.request(kind, { resourceType: kind }); expect(test.routes[0].request().resourceType()).toBe(kind.toLowerCase()); }
    finally { await test.guard.close(); }
  });

  it("holds completion and pending reads through body capture and successful unchanged response release", async () => {
    const test = await installed(), body = deferred<{ body: string; base64Encoded: boolean }>(), released = deferred<object>();
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? body.promise : name === "Fetch.continueResponse" ? released.promise : send(name, value));
    test.handler.mockImplementation(async route => { test.routes.push(route); await route.continue(); await route.request().response(); });
    try {
      test.request("one"); expect(test.guard.pendingReads).toBe(1);
      await vi.waitFor(() => expect(test.routes).toHaveLength(1));
      let complete = false; const response = test.routes[0].request().response().then(value => { complete = true; return value; });
      test.response("one"); expect(test.guard.pendingReads).toBe(2);
      body.resolve({ body: "source bytes", base64Encoded: false });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(true));
      expect(complete).toBe(false); expect(test.guard.pendingReads).toBe(2);
      released.resolve({}); const value = await response;
      expect(await value?.finished()).toBeNull(); expect((await value?.body())?.toString()).toBe("source bytes");
      expect(test.cdp.send.mock.calls.find(([name]) => name === "Fetch.continueResponse")?.[1]).toEqual({ requestId: "one" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
    } finally { await test.guard.close(); }
  });

  it("binds response to the exact permitted canonical continuation while preserving original provenance", async () => {
    const test = await installed(), original = "https://foreupsoftware.com/index.php/api/booking/times?date=2026-10-23&api_key=public",
      continued = "https://foreupsoftware.com/index.php/api/booking/times?date=2026-10-23";
    try {
      test.request("one", { request: { url: original, method: "GET", headers: {} } });
      await test.routes[0].continue({ url: continued }); const response = test.routes[0].request().response();
      test.response("one", { request: { url: continued, method: "GET", headers: {} } });
      expect((await response)?.url()).toBe(continued); expect(test.routes[0].request().url()).toBe(original);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["network", "url", "method", "frame", "unknown", "unadmitted"])("rejects mismatched response %s", async kind => {
    const test = await installed();
    try {
      test.request("one"); if (kind !== "unadmitted") await test.routes[0].continue();
      const values = kind === "network" ? { networkId: "other" } : kind === "url" ? { request: { url: "https://example.org/other", method: "GET", headers: {} } }
        : kind === "method" ? { request: { url: "https://example.org/data", method: "POST", headers: {} } }
          : kind === "frame" ? { frameId: "child" } : {};
      test.response(kind === "unknown" ? "other" : "one", values);
      const codes: Record<string, string> = { network: "NETWORK_MISMATCH", url: "URL_MISMATCH", method: "METHOD_MISMATCH", frame: "FRAME_MISMATCH",
        unknown: "UNKNOWN", unadmitted: "UNADMITTED" };
      await vi.waitFor(() => expect(test.failures).toContain(`NATIVE_REDIRECT_RESPONSE_${codes[kind]}`));
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.getResponseBody")).toBe(false);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each([false, true])("settles only the exact failed optional read while independent document/data evidence completes (prior loadingFailed: %s)", async loadingFailed => {
    const test = await installed(), results: string[] = [];
    test.handler.mockImplementation(async route => { test.routes.push(route); await route.continue();
      const response = await route.request().response(); results.push((await response?.body())?.toString() ?? "missing"); });
    try {
      test.request("document", { resourceType: "Document" }); test.request("optional", { resourceType: "Script" }); test.request("availability");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(3));
      if (loadingFailed) test.events.get("Network.loadingFailed")!({ requestId: "network-optional" });
      test.response("optional", { responseStatusCode: undefined, responseErrorReason: "Failed" });
      test.response("document"); test.response("availability");
      await vi.waitFor(() => { expect(results.sort()).toEqual(["body-availability", "body-document"]); expect(test.guard.pendingReads).toBe(0); });
      expect(test.failures).toEqual([]); expect(test.close).not.toHaveBeenCalled();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, values]) => values?.requestId)).toEqual(["optional"]);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody").map(([, values]) => values?.requestId)).not.toContain("optional");
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueResponse").map(([, values]) => values?.requestId)).not.toContain("optional");
    } finally { await test.guard.close(); }
  });

  it("keeps same-host queued peers alive when Chrome terminates one read before its provider lane opens", async () => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {});
    const completed: string[] = [], errors: unknown[] = [];
    let active = 0, maxActive = 0;
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => {
      active++; maxActive = Math.max(maxActive, active);
      try { return { acquired: true as const, value: await work() }; }
      finally { active--; }
    }, signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try {
        const value = await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop));
        completed.push(value.body.toString());
      } catch (error) {
        errors.push(error);
        // This is the production discovery handler's cleanup path. It must not
        // overwrite the controller's original terminal Network failure.
        await route.abort();
      }
    });
    try {
      test.request("holding", { resourceType: "Document" });
      test.request("failed", { resourceType: "Script" });
      test.request("later");
      test.events.get("Network.loadingFailed")!({ requestId: "network-failed" });
      expect(test.guard.pendingReads).toBe(3);
      test.response("holding");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["holding", "later"]));
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(true);
      expect((errors[0] as Error).message).toBe("NATIVE_REDIRECT_NETWORK_FAILED");
      test.response("failed", { responseStatusCode: undefined, responseErrorReason: "Failed" });
      test.response("later");
      await vi.waitFor(() => {
        expect(test.guard.pendingReads).toBe(0);
        expect(errors.map(error => (error as Error).message)).toEqual(["NATIVE_REDIRECT_NETWORK_FAILED"]);
        expect(completed).toEqual(["body-holding", "body-later"]);
      });
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
      expect(maxActive).toBe(1); expect(test.failures).toEqual([]);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody")
        .map(([, value]) => value?.requestId)).not.toContain("failed");
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it("does not cancel host peers for an exact terminal response failure after dispatch", async () => {
    const test = await installed(), stop = vi.fn(async () => {}), errors: unknown[] = [];
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { await continueNativeBrowserRead(route, new AbortController().signal, 1000, stop); }
      catch (error) { errors.push(error); await route.abort(); }
    });
    try {
      test.request("optional", { resourceType: "Script" });
      test.response("optional", { responseStatusCode: undefined, responseErrorReason: "Failed" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(true);
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["network", "url", "method", "frame"])("still rejects a queued terminal callback with wrong %s identity", async kind => {
    const test = await installed();
    try {
      test.request("queued");
      test.events.get("Network.loadingFailed")!({ requestId: "network-queued" });
      const values = kind === "network" ? { networkId: "foreign" } : kind === "frame" ? { frameId: "foreign" }
        : { request: { url: kind === "url" ? "https://example.org/foreign" : "https://example.org/data",
          method: kind === "method" ? "POST" : "GET", headers: {} } };
      test.response("queued", { responseStatusCode: undefined, responseErrorReason: "Failed", ...values });
      await vi.waitFor(() => expect(test.failures).toContain(`NATIVE_REDIRECT_RESPONSE_${kind.toUpperCase()}_MISMATCH`));
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueRequest" || name === "Fetch.getResponseBody" || name === "Fetch.continueResponse")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("preserves a terminal read failure while its continuation command is pending and then %ss", async kind => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {});
    const completed: string[] = [], errors: unknown[] = [];
    let rejectCommand!: (error: Error) => void;
    const command = new Promise<object>((_resolve, reject) => { rejectCommand = reject; });
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueRequest" && value?.requestId === "failed" ? command : send(name, value));
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => ({ acquired: true as const, value: await work() }), signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { completed.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString()); }
      catch (error) { errors.push(error); await route.abort(); }
    });
    try {
      test.request("failed", { resourceType: "Script" }); test.request("later");
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
      test.events.get("Network.loadingFailed")!({ requestId: "network-failed" });
      if (kind === "reject") rejectCommand(new Error("CDP_COMMAND_REJECTED"));
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["failed", "later"]));
      test.response("later");
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(completed).toEqual(["body-later"]); });
      // Leave the command hanging past its old timer. The trusted terminal
      // attestation must clear that timer instead of closing healthy peers.
      if (kind === "hang") await new Promise(resolve => setTimeout(resolve, 125));
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(true);
      expect((errors[0] as Error).message).toBe("NATIVE_REDIRECT_NETWORK_FAILED");
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled(); expect(test.failures).toEqual([]);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody")
        .map(([, value]) => value?.requestId)).toEqual(["later"]);
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it("still closes a hanging continuation when no exact terminal read is attested", async () => {
    const test = await installed(), stop = vi.fn(async () => {}), errors: unknown[] = [];
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueRequest" ? new Promise(() => {}) : send(name, value));
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { await continueNativeBrowserRead(route, new AbortController().signal, 1000, stop); }
      catch (error) { errors.push(error); }
    });
    try {
      test.request("hanging");
      await vi.waitFor(() => { expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0); });
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(false);
      // response() is observed before dispatch, so its unchanged bounded
      // response timer wins before the continuation-command timer here.
      expect(stop).toHaveBeenCalledOnce(); expect(test.failures).toContain("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
    } finally { await test.guard.close(); }
  });

  it.each([
    ["Fetch.getResponseBody", "reject"], ["Fetch.getResponseBody", "hang"], ["Fetch.getResponseBody", "resolve"],
    ["Fetch.continueResponse", "reject"], ["Fetch.continueResponse", "hang"], ["Fetch.continueResponse", "resolve"],
  ])("drains an exact terminal read during %s while its command later %ss without affecting queued peers", async (phase, kind) => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {});
    const completed: string[] = [], errors: unknown[] = [];
    let rejectCommand!: (error: Error) => void, resolveCommand!: (value: object) => void;
    const command = new Promise<object>((resolve, reject) => { rejectCommand = reject; resolveCommand = resolve; });
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === phase && value?.requestId === "failed" ? command : send(name, value));
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => ({ acquired: true as const, value: await work() }), signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { completed.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString()); }
      catch (error) { errors.push(error); await route.abort(); }
    });
    try {
      test.request("failed", { resourceType: "Script" }); test.request("later");
      test.response("failed");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === phase && value?.requestId === "failed")).toBe(true));
      test.events.get("Network.loadingFailed")!({ requestId: "network-failed" });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["failed", "later"]));
      test.response("later");
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(completed).toEqual(["body-later"]); });
      // A late protocol rejection remains observed, even after the failed read
      // released its provider lane. A hang may not leave a stale close timer.
      if (kind === "reject") { rejectCommand(new Error("CDP_COMMAND_REJECTED")); await new Promise<void>(resolve => setImmediate(resolve)); }
      else if (kind === "resolve") {
        resolveCommand(phase === "Fetch.getResponseBody" ? { body: "late body is not evidence", base64Encoded: false } : {});
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      else await new Promise(resolve => setTimeout(resolve, 125));
      expect(completed).toEqual(["body-later"]);
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(true);
      expect((errors[0] as Error).message).toBe("NATIVE_REDIRECT_NETWORK_FAILED");
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled(); expect(test.failures).toEqual([]);
      if (phase === "Fetch.getResponseBody") expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueResponse" && value?.requestId === "failed")).toBe(false);
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it.each([
    ["Fetch.getResponseBody", "reject"], ["Fetch.getResponseBody", "hang"],
    ["Fetch.continueResponse", "reject"], ["Fetch.continueResponse", "hang"],
  ])("keeps fail-closed cleanup for an unattested %s command that %ss", async (phase, kind) => {
    const test = await installed(), stop = vi.fn(async () => {}), errors: unknown[] = [];
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === phase
      ? kind === "hang" ? new Promise(() => {}) : Promise.reject(new Error("CDP_COMMAND_REJECTED")) : send(name, value));
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { await continueNativeBrowserRead(route, new AbortController().signal, 1000, stop); }
      catch (error) { errors.push(error); }
    });
    try {
      test.request("failed"); test.response("failed");
      await vi.waitFor(() => { expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0); });
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(false);
      expect(stop).toHaveBeenCalledOnce(); expect(test.failures.length).toBeGreaterThan(0);
    } finally { await test.guard.close(); }
  });

  it("never creates response evidence for failed root navigation", async () => {
    const test = await installed();
    try {
      test.request("root", { resourceType: "Document" }); await test.routes[0].continue();
      const response = expect(test.routes[0].request().response()).rejects.toThrow("NATIVE_REDIRECT_NETWORK_FAILED");
      test.response("root", { responseStatusCode: undefined, responseErrorReason: "Failed" }); await response;
      expect(test.cdp.send.mock.calls.some(([name]) => ["Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))).toBe(false);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it("keeps a failed active response abort fatal while recording only closed terminal facts", async () => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    try {
      test.request("one"); await test.routes[0].continue();
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "one"
        ? Promise.reject(new Error("Invalid InterceptionId")) : send(name, value));
      test.response("one", { responseStatusCode: undefined, responseErrorReason: "Failed" });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.firstFatal).toMatchObject({ operation: "RESPONSE_METADATA", errorCategory: "INVALID_INTERCEPTION_ID",
        responseFailureBranch: "ACTIVE_RESPONSE_ERROR_ABORT", recordGenerationCurrent: true,
        recordGenerationRetired: false, responseIdentityMatched: false,
        correlatedNetworkLoadingFailed: false, correlatedNetworkLoadingFinished: false });
      expect(test.cdp.send.mock.calls.some(([name]) => ["Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["network", "url", "frame", "unknown"])("still closes failed responses with wrong %s identity", async kind => {
    const test = await installed();
    try {
      test.request("one"); await test.routes[0].continue();
      test.response(kind === "unknown" ? "other" : "one", { responseStatusCode: undefined, responseErrorReason: "Failed",
        ...(kind === "network" ? { networkId: "other" } : kind === "url" ? { request: { url: "https://example.org/other", method: "GET", headers: {} } }
          : kind === "frame" ? { frameId: "child" } : {}) });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.failures.some(code => code.startsWith("NATIVE_REDIRECT_RESPONSE_"))).toBe(true);
    } finally { await test.guard.close(); }
  });

  it.each(["failed", "duplicate", "status"])("diagnoses rejected response state %s without granting response authority", async kind => {
    const test = await installed();
    try {
      test.request("one"); await test.routes[0].continue();
      if (kind === "failed") test.events.get("Network.loadingFailed")!({ requestId: "network-one" });
      if (kind === "duplicate") { test.response("one"); await test.routes[0].request().response(); }
      const previousBodyReads = test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody").length;
      test.response("one", kind === "status" ? { responseStatusCode: 0 } : {});
      const suffix = kind === "failed" ? "PRIOR_FAILURE" : kind === "duplicate" ? "DUPLICATE" : "STATUS_INVALID";
      await vi.waitFor(() => expect(test.failures).toContain(`NATIVE_REDIRECT_RESPONSE_${suffix}`));
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody")).toHaveLength(previousBodyReads);
    } finally { await test.guard.close(); }
  });

  it.each([204, 205, 300, 302, 304, 305])("completes bodyless HTTP%s from response stage without Network fallback", async status => {
    const test = await installed();
    try {
      test.request("one"); await test.routes[0].continue(); const promise = test.routes[0].request().response();
      let completed = false; void promise.then(() => { completed = true; });
      test.events.get("Network.loadingFinished")!({ requestId: "network-one" });
      await Promise.resolve(); expect(completed).toBe(false);
      test.response("one", { responseStatusCode: status }); const response = await promise;
      expect(response?.status()).toBe(status); expect(await response?.body()).toEqual(Buffer.alloc(0));
      expect(test.events.has("Network.responseReceived")).toBe(false);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.getResponseBody")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it("preserves a non-success status/body and decodes actual base64 bytes", async () => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? Promise.resolve({ body: Buffer.from("source unavailable").toString("base64"), base64Encoded: true }) : send(name, value));
    try {
      test.request("one"); await test.routes[0].continue(); const promise = test.routes[0].request().response();
      test.response("one", { responseStatusCode: 503 }); const response = await promise;
      expect(response?.status()).toBe(503); expect((await response?.body())?.toString()).toBe("source unavailable");
    } finally { await test.guard.close(); }
  });

  it.each(["declared", "decoded", "malformed", "conflicting"])("rejects invalid response size/headers %s", async kind => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    if (kind === "decoded") test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? Promise.resolve({ body: "x".repeat(2_000_001), base64Encoded: false }) : send(name, value));
    try {
      test.request("one"); await test.routes[0].continue(); const rejected = expect(test.routes[0].request().response()).rejects.toThrow();
      test.response("one", { responseHeaders: kind === "declared" ? [{ name: "Content-Length", value: "2000001" }]
        : kind === "malformed" ? [{ name: "Content-Length", value: "invalid" }]
          : kind === "conflicting" ? [{ name: "Content-Type", value: "text/html" }, { name: "content-type", value: "application/json" }] : [] });
      await rejected; expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false);
      if (kind === "conflicting") expect(test.failures).toContain("NATIVE_REDIRECT_RESPONSE_HEADERS_CONFLICT");
    } finally { await test.guard.close(); }
  });

  it("fails body capture on timeout and clears its pending operation", async () => {
    vi.useFakeTimers(); const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? new Promise(() => {}) : send(name, value));
    try {
      test.request("one"); await test.routes[0].continue(); test.response("one");
      await vi.advanceTimersByTimeAsync(101);
      expect(test.failures).toContain("NATIVE_REDIRECT_BODY_TIMEOUT"); expect(test.guard.pendingReads).toBe(0);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false);
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });

  it("retains copied request facts and response-wait phase before timeout cleanup", async () => {
    vi.useFakeTimers(); const test = await installed();
    try {
      test.request("private-fetch-id", { networkId: "private-network-id", resourceType: "Script", request: {
        url: "https://example.org/public.js?token=private-query#private-fragment", method: "GET",
        headers: { Authorization: "private-header" },
      } });
      await test.routes[0].continue();
      const rejected = expect(test.routes[0].request().response()).rejects.toThrow("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
      await vi.advanceTimersByTimeAsync(101); await rejected;
      expect(test.guard.firstFatal).toEqual({ code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT",
        operation: "RESPONSE_WAIT", requestUrlSha256: "860ee34a74d6bbff7e13256ff0cb0bdd104fcf2971e96c78d993afc3bb7cf594",
        url: "https://example.org/public.js", method: "GET", resourceType: "script", interceptedRequests: 1,
        recordCount: 1, requestLimit: 256, framePresent: true, rootFrame: true, networkIdPresent: true,
        duplicateRequestId: false, hasPostData: false, postDataPresent: false, postDataBytes: 0 });
      const copy = test.guard.firstFatal!; copy.phase = "CONTINUE_RESPONSE_ACK"; copy.url = "https://mutated.example/";
      expect(test.guard.firstFatal?.phase).toBe("RESPONSE_WAIT"); expect(test.guard.firstFatal?.url).toBe("https://example.org/public.js");
      expect(JSON.stringify(test.guard.firstFatal)).not.toMatch(/private-|Authorization|token|networkId"|frameId"|headers|postData"/u);
      expect(test.close).toHaveBeenCalledOnce(); expect(test.failures).toEqual(["NATIVE_REDIRECT_RESPONSE_TIMEOUT"]);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false);
      expect(test.guard.pendingReads).toBe(0);
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });

  it("distinguishes a timed-out unchanged response acknowledgement and produces no response proof", async () => {
    vi.useFakeTimers(); const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueResponse" ? new Promise(() => {}) : send(name, value));
    try {
      test.request("one", { resourceType: "Script" }); await test.routes[0].continue(); test.response("one", { resourceType: "Script" });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(true), { interval: 1, timeout: 50 });
      await vi.advanceTimersByTimeAsync(101);
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "CONTINUE_RESPONSE_ACK",
        url: "https://example.org/data", method: "GET", resourceType: "script", duplicateRequestId: false });
      await expect(test.routes[0].request().response()).rejects.toThrow("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
      expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0);
      expect(test.failures[0]).toBe("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });

  it.each(["https://example.org/account/session-secret/collect", "https://sc.cps.golf/(S(abcdefghijklmnopqrstuvwx))/v3.5/teetimes"])("omits unsafe response-timeout URLs %s", async url => {
    vi.useFakeTimers(); const test = await installed();
    try {
      test.request("one", { request: { url, method: "GET", headers: {} } }); await test.routes[0].continue();
      const rejected = expect(test.routes[0].request().response()).rejects.toThrow("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
      await vi.advanceTimersByTimeAsync(101); await rejected;
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT" });
      expect(test.guard.firstFatal?.url).toBeUndefined(); expect(test.close).toHaveBeenCalledOnce();
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });

  it("does not release a captured response after cancellation", async () => {
    const cancellation = new AbortController(), test = await installed(undefined, cancellation.signal), body = deferred<{ body: string; base64Encoded: boolean }>();
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? body.promise : send(name, value));
    try {
      test.request("one"); await test.routes[0].continue(); test.response("one"); cancellation.abort(); body.resolve({ body: "late", base64Encoded: false });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false); expect(test.failures).toContain("NATIVE_REDIRECT_CANCELLED");
    } finally { await test.guard.close(); }
  });

  it("preserves an exact released 302 repeated-slash document through the source host URL guard", async () => {
    const test = await installed(), root = "https://public.example/", target = "https://www.public.example//", roots = new Set([root]);
    try {
      test.request("root", { resourceType: "Document", networkId: "same-native-document", request: { url: root, method: "GET", headers: {} } });
      const original = test.routes[0].request(); await test.routes[0].continue();
      test.response("root", { resourceType: "Document", networkId: "same-native-document", responseStatusCode: 302,
        responseHeaders: [{ name: "Location", value: target }], request: { url: root, method: "GET", headers: {} } });
      await original.response();
      test.request("redirect", { resourceType: "Document", networkId: "same-native-document", redirectedRequestId: "root",
        request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      const child = test.routes[1].request();
      expect(isObservedNativeRedirect(child, roots)).toBe(true);
      expect(isObservedNativeRedirect({ ...child }, roots)).toBe(false);
      expect(canonicalStagehandHostEntry(child.url())).toBe(target);
      await test.routes[1].continue();
      test.response("redirect", { resourceType: "Document", networkId: "same-native-document", responseStatusCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html" }], request: { url: target, method: "GET", headers: {} } });
      await child.response();
      expect(attestedNativeDocumentRedirects(child, roots)).toEqual([{ fromUrl: root, toUrl: target, status: 302, completed: true }]);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it("preserves an exact admitted redirect parent and rejects unknown or denied provenance", async () => {
    const test = await installed();
    try {
      test.request("one"); await test.routes[0].continue();
      test.response("one", { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: "/data" }] });
      await test.routes[0].request().response();
      test.request("two", { redirectedRequestId: "one" });
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(test.routes[1].request().redirectedFrom()).toBe(test.routes[0].request());
      test.request("three", { redirectedRequestId: "missing" });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED"));
      expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });

  it.each([301, 302, 303, 307, 308])("attests only the exact released %i document Location rooted at an authorized full URL", async status => {
    const test = await installed(), root = "https://book.example.org/booking?course=7", target = "https://booking.example.net/booking?course=7";
    const roots = new Set([root]);
    try {
      test.request("root", { resourceType: "Document", request: { url: root, method: "GET", headers: {} } });
      const original = test.routes[0].request(); await test.routes[0].continue();
      expect(isObservedNativeRedirectTarget(original, target, roots)).toBe(false);
      test.response("root", { responseStatusCode: status, responseHeaders: [{ name: "Location", value: target }], request: { url: root, method: "GET", headers: {} } });
      await original.response();
      expect(isObservedNativeRedirectTarget(original, target, roots)).toBe(true);
      expect(isObservedNativeRedirectTarget(original, `${target}&other=1`, roots)).toBe(false);
      test.request("child", { resourceType: "Document", redirectedRequestId: "root", request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      const child = test.routes[1].request();
      expect(isObservedNativeRedirect(child, roots)).toBe(true);
      expect(isObservedNativeRedirect(child, new Set([new URL(root).origin]))).toBe(false);
      expect(isObservedNativeRedirect(child, new Set([`${root}&different=1`]))).toBe(false);
      expect(isObservedNativeRedirect({ ...child }, roots)).toBe(false);
      expect(attestedNativeDocumentRedirects(child, roots)).toBeUndefined();
      await test.routes[1].continue();
      test.response("child", { resourceType: "Document", request: { url: target, method: "GET", headers: {} }, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
      await child.response();
      expect(attestedNativeDocumentRedirects(child, roots)).toEqual([{ fromUrl: root, toUrl: target, status, completed: true }]);
      expect(attestedNativeDocumentRedirects({ ...child }, roots)).toBeUndefined();
      expect(attestedNativeDocumentRedirects(child, new Set([new URL(root).origin]))).toBeUndefined();
      const scope = createPublicBookingParentScope({ officialUrl: root });
      scope.observeDocument({ url: root, status });
      scope.observeDocument({ url: target, status: 200, redirectedFrom: root, nativeRequest: child });
      expect(scope.authorizeParent(target)).toEqual({ kind: "VERIFIED_OFFICIAL_DOCUMENT", officialUrl: root, documentUrl: target });
      // Replaying a public URL or copied adapter cannot reuse that authority.
      scope.beginDocument(target); scope.observeDocument({ url: target, status: 200, redirectedFrom: root, nativeRequest: { ...child } });
      expect(scope.authorizeParent(target)).toBeUndefined();
      await test.guard.close();
      expect(isObservedNativeRedirect(child, roots)).toBe(false);
      expect(attestedNativeDocumentRedirects(child, roots)).toBeUndefined();
      expect(isObservedNativeRedirectTarget(original, target, roots)).toBe(false);
    } finally { await test.guard.close(); }
  });

  it("holds a child outside its handler until its exact parent response is successfully released", async () => {
    const test = await installed(), released = deferred<object>(), root = "https://book.example.org/booking", target = "https://booking.example.net/booking";
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueResponse" ? released.promise : send(name, value));
    try {
      test.request("root", { resourceType: "Document", request: { url: root, method: "GET", headers: {} } });
      const original = test.routes[0].request(); await test.routes[0].continue();
      test.request("child", { resourceType: "Document", redirectedRequestId: "root", request: { url: target, method: "GET", headers: {} } });
      expect(test.routes).toHaveLength(1); expect(test.guard.pendingReads).toBeGreaterThan(0);
      test.response("root", { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }], request: { url: root, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(true));
      expect(test.routes).toHaveLength(1); expect(isObservedNativeRedirectTarget(original, target, new Set([root]))).toBe(false);
      released.resolve({});
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(isObservedNativeRedirect(test.routes[1].request(), new Set([root]))).toBe(true);
      expect(test.failures).toEqual([]);
    } finally { released.resolve({}); await test.guard.close(); }
  });

  it.each(["wrong-target", "status-200", "missing-location", "duplicate-location", "method-change", "post", "xhr-parent", "crosshost-script"])("rejects an unattested redirected document/asset: %s", async failure => {
    const test = await installed(), root = "https://book.example.org/booking", target = "https://booking.example.net/booking";
    const method = failure === "post" ? "POST" : "GET", kind = failure === "xhr-parent" ? "XHR" : "Document";
    try {
      test.request("root", { resourceType: kind, request: { url: root, method, headers: {} } }); await test.routes[0].continue();
      const location = failure === "wrong-target" ? `${target}/different` : target;
      test.response("root", { responseStatusCode: failure === "status-200" ? 200 : 302,
        responseHeaders: failure === "missing-location" ? [] : [{ name: "Location", value: location }, ...(failure === "duplicate-location" ? [{ name: "Location", value: location }] : [])],
        request: { url: root, method, headers: {} } });
      await test.routes[0].request().response();
      test.request("child", { resourceType: failure === "crosshost-script" ? "Script" : "Document", redirectedRequestId: "root",
        request: { url: target, method: failure === "method-change" ? "HEAD" : method, headers: {} } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED"));
      expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it.each(["GET", "HEAD"])("denies only an exactly attested cross-host Script→Script %s while document/data peers finish", async method => {
    const test = await installed(), root = "https://example.org/optional.js", target = "https://cdn.example.net/optional.js?v=public-build";
    try {
      test.request("script", { resourceType: "Script", request: { url: root, method, headers: {} } });
      await test.routes[0].continue();
      test.response("script", { resourceType: "Script", responseStatusCode: 307, responseHeaders: [{ name: "Location", value: target }],
        request: { url: root, method, headers: {} } });
      await test.routes[0].request().response();
      test.request("denied-child", { networkId: "network-script", resourceType: "Script", redirectedRequestId: "script",
        request: { url: target, method, headers: {} } });
      await vi.waitFor(() => expect(test.rejections).toHaveLength(1));
      expect(test.rejections[0]).toMatchObject({ code: "NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED", resourceType: "script", method,
        url: "https://cdn.example.net/optional.js", recordCount: 1 });
      expect(JSON.stringify(test.rejections)).not.toContain("public-build");
      expect(JSON.stringify(test.rejections)).not.toContain("network-script");
      expect(test.routes).toHaveLength(1); expect(test.handler).toHaveBeenCalledTimes(1);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
      expect(test.cdp.send.mock.calls.filter(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "denied-child")).toHaveLength(1);
      test.request("document", { resourceType: "Document" }); test.request("availability");
      await Promise.all(test.routes.slice(1).map(route => route.continue()));
      test.response("document", { resourceType: "Document" }); test.response("availability");
      const values = await Promise.all(test.routes.slice(1).map(async route => (await (await route.request().response())?.body())?.toString()));
      expect(values).toEqual(["body-document", "body-availability"]);
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.failures).toEqual([]); expect(test.close).not.toHaveBeenCalled();
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.guard.rejectedRequests).toEqual(test.rejections);
    } finally { await test.guard.close(); }
  });

  it.each(["wrong-target", "status-200", "missing-location", "method", "kind", "network", "missing-parent", "denied-parent", "unsafe-target"])(
    "retains fatal provenance rejection for an invalid script redirect: %s", async failure => {
      const test = await installed(), root = "https://example.org/optional.js", target = failure === "unsafe-target" ? "https://127.0.0.1/optional.js" : "https://cdn.example.net/optional.js";
      try {
        test.request("script", { resourceType: "Script", request: { url: root, method: "GET", headers: {} } });
        if (failure === "denied-parent") await test.routes[0].abort();
        else {
          await test.routes[0].continue(); test.response("script", { resourceType: "Script", responseStatusCode: failure === "status-200" ? 200 : 302,
            responseHeaders: failure === "missing-location" ? [] : [{ name: "Location", value: failure === "wrong-target" ? `${target}/wrong` : target }],
            request: { url: root, method: "GET", headers: {} } });
          await test.routes[0].request().response();
        }
        test.request("child", { networkId: failure === "network" ? "wrong-network" : "network-script", resourceType: failure === "kind" ? "Document" : "Script",
          redirectedRequestId: failure === "missing-parent" ? "missing" : "script", request: { url: target, method: failure === "method" ? "HEAD" : "GET", headers: {} } });
        await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED"));
        expect(test.rejections).toEqual([]); expect(test.routes).toHaveLength(1); expect(test.close).toHaveBeenCalledOnce();
      } finally { await test.guard.close(); }
    });

  it.each(["failure", "hang", "cancel"])("fails closed if attested script-hop rejection ends in %s", async outcome => {
    vi.useFakeTimers(); const cancellation = new AbortController(), test = await installed(undefined, cancellation.signal);
    const root = "https://example.org/optional.js", target = "https://cdn.example.net/optional.js", rejected = deferred<object>();
    const send = test.cdp.send.getMockImplementation()!;
    try {
      test.request("script", { resourceType: "Script", request: { url: root, method: "GET", headers: {} } }); await test.routes[0].continue();
      test.response("script", { resourceType: "Script", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }],
        request: { url: root, method: "GET", headers: {} } }); await test.routes[0].request().response();
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "child"
        ? outcome === "failure" ? Promise.reject(new Error("offline rejection failed")) : rejected.promise : send(name, value));
      test.request("child", { networkId: "network-script", resourceType: "Script", redirectedRequestId: "script", request: { url: target, method: "GET", headers: {} } });
      await Promise.resolve(); await Promise.resolve();
      if (outcome === "cancel") { cancellation.abort(); rejected.resolve({}); }
      await vi.advanceTimersByTimeAsync(101);
      expect(test.close).toHaveBeenCalledOnce(); expect(test.rejections).toEqual([]);
      expect(test.failures).toContain(outcome === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : outcome === "cancel" ? "NATIVE_REDIRECT_CANCELLED" : "NATIVE_REDIRECT_ROUTING_FAILED");
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
      expect(test.routes).toHaveLength(1); expect(test.guard.pendingReads).toBe(0);
    } finally { rejected.resolve({}); await test.guard.close(); vi.useRealTimers(); }
  });

  it.each(["https://127.0.0.1/booking", "https://user:secret@example.net/booking", "https://booking.example.net/checkout", "http://booking.example.net/booking"])("does not grant public document authority to unsafe Location %s", async target => {
    const test = await installed(), root = "https://book.example.org/booking";
    try {
      test.request("root", { resourceType: "Document", request: { url: root, method: "GET", headers: {} } }); await test.routes[0].continue();
      test.response("root", { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }], request: { url: root, method: "GET", headers: {} } });
      await test.routes[0].request().response();
      expect(isObservedNativeRedirectTarget(test.routes[0].request(), target, new Set([root]))).toBe(false);
      test.handler.mockImplementation(async route => { test.routes.push(route);
        expect(isObservedNativeRedirect(route.request(), new Set([root]))).toBe(false); await route.abort(); });
      test.request("child", { resourceType: "Document", redirectedRequestId: "root", request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it("bounds redirect depth at five actual HTTP hops and never treats the final origin as a root", async () => {
    const test = await installed(), root = "https://first.example.org/booking";
    let url = root;
    try {
      test.request("0", { resourceType: "Document", request: { url, method: "GET", headers: {} } });
      for (let index = 0; index < 5; index++) {
        const next = `https://hop${index}.example.net/booking`;
        await test.routes[index].continue(); test.response(String(index), { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: next }], request: { url, method: "GET", headers: {} } });
        await test.routes[index].request().response();
        test.request(String(index + 1), { resourceType: "Document", redirectedRequestId: String(index), request: { url: next, method: "GET", headers: {} } });
        await vi.waitFor(() => expect(test.routes).toHaveLength(index + 2)); url = next;
      }
      expect(isObservedNativeRedirect(test.routes[5].request(), new Set([root]))).toBe(true);
      await test.routes[5].continue(); test.response("5", { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: "https://sixth.example.net/booking" }], request: { url, method: "GET", headers: {} } });
      await test.routes[5].request().response();
      expect(isObservedNativeRedirectTarget(test.routes[5].request(), "https://sixth.example.net/booking", new Set([root]))).toBe(false);
      test.request("6", { resourceType: "Document", redirectedRequestId: "5", request: { url: "https://sixth.example.net/booking", method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED")); expect(test.routes).toHaveLength(6);
    } finally { await test.guard.close(); }
  });

  it.each(["timeout", "failure", "cancel"])("does not attest a redirect while parent release ends in %s", async outcome => {
    const cancellation = new AbortController(), test = await installed(undefined, cancellation.signal), root = "https://book.example.org/booking", target = "https://booking.example.net/booking";
    try {
      test.request("root", { resourceType: "Document", request: { url: root, method: "GET", headers: {} } }); await test.routes[0].continue();
      test.request("child", { resourceType: "Document", redirectedRequestId: "root", request: { url: target, method: "GET", headers: {} } });
      if (outcome === "failure") test.events.get("Network.loadingFailed")!({ requestId: "network-root" });
      if (outcome === "cancel") cancellation.abort();
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.routes).toHaveLength(1); expect(isObservedNativeRedirectTarget(test.routes[0].request(), target, new Set([root]))).toBe(false);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it.each(["XHR", "Ping"])("denies %s subframes before policy/dispatch without invalidating main evidence", async resourceType => {
    const test = await installed();
    try {
      test.request("child", { frameId: "child", resourceType, networkId: undefined, redirectedRequestId: "unknown" });
      await vi.waitFor(() => expect(test.subframes).toHaveLength(1));
      expect(test.handler).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled(); expect(test.failures).toEqual([]);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueRequest")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["cap", "missing-frame", "missing-network", "missing-body", "oversized-body", "duplicate-id"])("fails closed with an exact bounded diagnostic for malformed request %s", async kind => {
    const test = await installed(kind === "cap" ? 1 : undefined);
    try {
      if (kind === "cap" || kind === "duplicate-id") test.request("one");
      test.request(kind === "cap" ? "two" : "one", kind === "missing-frame" ? { frameId: undefined } : kind === "missing-network" ? { networkId: undefined }
        : kind === "missing-body" ? { request: { url: "https://example.org/data", method: "POST", hasPostData: true, headers: {} } }
          : kind === "oversized-body" ? { request: { url: "https://example.org/data", method: "GET", postData: "x".repeat(32769), headers: {} } } : {});
      const suffixes: Record<string, string> = { cap: "INTERCEPT_LIMIT", "missing-frame": "FRAME_MISSING", "missing-network": "NETWORK_ID_MISSING",
        "missing-body": "POST_BODY_MISSING", "oversized-body": "POST_BODY_LIMIT", "duplicate-id": "DUPLICATE_FETCH_ID" };
      await vi.waitFor(() => expect(test.failures).toContain(`NATIVE_REDIRECT_${suffixes[kind]}`));
      expect(test.guard.firstFatal?.code).toBe(`NATIVE_REDIRECT_${suffixes[kind]}`);
      expect(test.close).toHaveBeenCalledOnce();
    } finally { await test.guard.close(); }
  });

  it("rejects an oversized POST before admission while same-host document and data peers complete", async () => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {}), bodies: string[] = [];
    let active = 0, maxActive = 0;
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => {
      active++; maxActive = Math.max(maxActive, active);
      try { return { acquired: true as const, value: await work() }; } finally { active--; }
    }, signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      bodies.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString());
    });
    try {
      test.request("oversized", { request: { url: "https://example.org/collect?private=never-retain", method: "POST", hasPostData: true,
        postData: "x".repeat(32769), headers: { authorization: "never-retain-header" } } });
      test.request("document", { resourceType: "Document" }); test.request("availability");
      test.response("document");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["document", "availability"]));
      test.response("availability");
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(bodies).toEqual(["body-document", "body-availability"]); });
      expect(test.handler).toHaveBeenCalledTimes(2); expect(maxActive).toBe(1);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, value]) => value?.requestId)).toEqual(["oversized"]);
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.guard.lastFailure).toBeUndefined(); expect(test.failures).toEqual([]);
      expect(test.rejections).toHaveLength(1); expect(test.rejections[0]).toMatchObject({ code: "NATIVE_REDIRECT_POST_BODY_LIMIT",
        url: "https://example.org/collect", method: "POST", postDataBytes: 32769, recordCount: 0, hasPostData: true, postDataPresent: true });
      expect(JSON.stringify(test.guard.rejectedRequests)).not.toMatch(/never-retain|authorization|postData"/u);
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it.each([
    ["Image", "https://example.org/photo"], ["Font", "https://example.org/type"], ["Media", "https://example.org/video"],
    ["Other", "https://example.org/photo.png"], ["Other", "https://example.org/type.woff2"],
  ])("aborts non-evidence browser %s without a network ID while a legitimate GET still completes (%s)", async (resourceType, url) => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {}), bodies: string[] = [];
    const lease = vi.fn(async (_host: string, work: () => Promise<unknown>) => ({ acquired: true as const, value: await work() }));
    const queue = createSimulatorBrowserRequestQueue(lease, signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      bodies.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString());
    });
    try {
      test.request("decoration", { resourceType, networkId: undefined, request: { url, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.handler).not.toHaveBeenCalled(); expect(lease).not.toHaveBeenCalled();
      test.request("availability");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "availability")).toBe(true));
      test.response("availability");
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(bodies).toEqual(["body-availability"]); });
      expect(test.handler).toHaveBeenCalledOnce(); expect(lease).toHaveBeenCalledOnce();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, value]) => value?.requestId)).toEqual(["decoration"]);
      expect(test.cdp.send.mock.calls.filter(([name]) => ["Fetch.continueRequest", "Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))
        .map(([, value]) => value?.requestId)).not.toContain("decoration");
      expect(test.guard.rejectedRequests).toEqual([]); expect(test.rejections).toEqual([]);
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.failures).toEqual([]); expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it("keeps a non-evidence abort pending until its exact ACK without consuming another read's budget", async () => {
    const test = await installed(), ack = deferred<object>(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "decoration" ? ack.promise : send(name, value));
    try {
      test.request("decoration", { resourceType: "Image", networkId: undefined });
      expect(test.guard.pendingReads).toBe(1); expect(test.guard.rejectedRequests).toEqual([]);
      test.request("availability"); await test.routes[0].continue(); test.response("availability");
      expect((await (await test.routes[0].request().response())?.body())?.toString()).toBe("body-availability");
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(1));
      expect(test.handler).toHaveBeenCalledOnce(); expect(test.close).not.toHaveBeenCalled();
      ack.resolve({}); await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.guard.rejectedRequests).toEqual([]); expect(test.rejections).toEqual([]); expect(test.guard.firstFatal).toBeUndefined();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, value]) => value?.requestId)).toEqual(["decoration"]);
    } finally { ack.resolve({}); await test.guard.close(); }
  });

  it.each(["Document", "Script", "XHR", "Fetch", "Stylesheet", "Other"])("keeps missing network identity fatal for evidence-capable %s", async resourceType => {
    const test = await installed();
    try {
      test.request("critical", { resourceType, networkId: undefined, request: { url: "https://example.org/availability.json", method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.firstFatal?.code).toBe("NATIVE_REDIRECT_NETWORK_ID_MISSING"); expect(test.handler).not.toHaveBeenCalled();
      expect(test.guard.rejectedRequests).toEqual([]);
      expect(test.cdp.send.mock.calls.some(([name]) => ["Fetch.continueRequest", "Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["cap", "missing-frame", "duplicate-id"])("retains the %s fatal guard before non-evidence denial", async kind => {
    const test = await installed(kind === "cap" ? 1 : undefined);
    try {
      if (kind === "cap" || kind === "duplicate-id") test.request("one");
      test.request(kind === "cap" ? "two" : "one", { resourceType: "Image", networkId: undefined,
        ...(kind === "missing-frame" ? { frameId: undefined } : {}) });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      const suffix = kind === "cap" ? "INTERCEPT_LIMIT" : kind === "missing-frame" ? "FRAME_MISSING" : "DUPLICATE_FETCH_ID";
      expect(test.failures).toContain(`NATIVE_REDIRECT_${suffix}`); expect(test.guard.rejectedRequests).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("still closes when the exact non-evidence abort %ss", async kind => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest"
      ? kind === "hang" ? new Promise(() => {}) : Promise.reject(new Error("Protocol abort rejected")) : send(name, value));
    try {
      test.request("decoration", { resourceType: "Image", networkId: undefined });
      await vi.waitFor(() => { expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0); });
      expect(test.failures).toContain(kind === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : "NATIVE_REDIRECT_ROUTING_FAILED");
      expect(test.handler).not.toHaveBeenCalled(); expect(test.guard.rejectedRequests).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it("cannot turn a denied non-evidence request's late response into evidence", async () => {
    const test = await installed();
    try {
      test.request("decoration", { resourceType: "Image", networkId: undefined });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      test.response("decoration", { resourceType: "Image", networkId: undefined });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_RESPONSE_UNKNOWN"));
      expect(test.handler).not.toHaveBeenCalled();
      expect(test.cdp.send.mock.calls.some(([name]) => ["Fetch.continueRequest", "Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))).toBe(false);
    } finally { await test.guard.close(); }
  });

  it("counts acknowledged non-evidence denials toward the unchanged intercept budget", async () => {
    const test = await installed(1);
    try {
      test.request("decoration", { resourceType: "Image", networkId: undefined });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.guard.rejectedRequests).toEqual([]); expect(test.rejections).toEqual([]);
      test.request("availability");
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_INTERCEPT_LIMIT"));
      expect(test.guard.firstFatal).toMatchObject({ interceptedRequests: 2, requestLimit: 1, recordCount: 0 });
      expect(test.handler).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });

  it.each([
    ["https://e.clarity.ms/collect", "Ping"],
    ["https://example.org/cdn-cgi/zaraz/s.js?z=opaque", "Script"],
    ["https://example.org/cdn-cgi/challenge-platform/scripts/jsd/main.js", "Script"],
  ])("quietly denies excluded %s before loader identity without closing public peers", async (url, resourceType) => {
    const test = await installed();
    try {
      test.request("excluded", { resourceType, networkId: undefined, request: { url, method: resourceType === "Ping" ? "POST" : "GET", headers: {} } });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.handler).not.toHaveBeenCalled();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, value]) => value?.requestId)).toEqual(["excluded"]);
      expect(test.guard.rejectedRequests).toEqual([]);
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.failures).toEqual([]); expect(test.close).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });

  it.each([false, true])("aborts Ping without dispatch or evidence while same-host document/data peers complete (network ID present: %s)", async networkIdPresent => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {}), bodies: string[] = [];
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => ({ acquired: true as const, value: await work() }), signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      bodies.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString());
    });
    try {
      test.request("ping", { resourceType: "Ping", networkId: networkIdPresent ? "network-ping" : undefined,
        request: { url: "https://example.org/collect?private=not-retained", method: "POST", hasPostData: true,
          postData: "x".repeat(672), headers: { authorization: "not-retained" } } });
      test.request("document", { resourceType: "Document" }); test.request("availability");
      test.response("document");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["document", "availability"]));
      test.response("availability");
      test.events.get("Network.loadingFailed")!({ requestId: "network-ping" });
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(bodies).toEqual(["body-document", "body-availability"]); });
      expect(test.handler).toHaveBeenCalledTimes(2);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, value]) => value?.requestId)).toEqual(["ping"]);
      expect(test.cdp.send.mock.calls.filter(([name]) => ["Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))
        .map(([, value]) => value?.requestId)).not.toContain("ping");
      expect(test.guard.rejectedRequests).toEqual([expect.objectContaining({ code: "NATIVE_REDIRECT_PING_UNSUPPORTED",
        method: "POST", resourceType: "ping", networkIdPresent, postDataBytes: 672, recordCount: 0 })]);
      expect(JSON.stringify(test.guard.rejectedRequests)).not.toMatch(/not-retained|authorization|postData"/u);
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.failures).toEqual([]); expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it.each(["missing", "empty", "oversized"])("never constructs a read record for Ping with %s POST data", async kind => {
    const test = await installed();
    try {
      test.request("ping", { resourceType: "Ping", networkId: undefined, request: { url: "https://example.org/collect", method: "POST",
        hasPostData: true, ...(kind === "missing" ? {} : { postData: kind === "empty" ? "" : "x".repeat(32769) }), headers: {} } });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.handler).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
      expect(test.guard.rejectedRequests?.[0].code).toBe("NATIVE_REDIRECT_PING_UNSUPPORTED");
      expect(test.cdp.send.mock.calls.filter(([name]) => ["Fetch.continueRequest", "Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it("keeps a successfully blocked metadata-only POST Ping non-causal while owned document and GET reads complete", async () => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {}), bodies: string[] = [];
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => ({ acquired: true as const, value: await work() }), signal.signal);
    test.handler.mockImplementation(async route => {
      bodies.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString());
    });
    try {
      test.request("ping", { resourceType: "Ping", networkId: "network-ping", request: {
        url: "https://example.org/collect?private=not-retained#not-retained", method: "POST", hasPostData: true, headers: {} } });
      test.request("document", { resourceType: "Document" }); test.request("availability");
      test.response("document");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["document", "availability"]));
      test.response("availability");
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(bodies).toEqual(["body-document", "body-availability"]); });
      expect(test.guard.rejectedRequests).toEqual([expect.objectContaining({ code: "NATIVE_REDIRECT_PING_UNSUPPORTED",
        operation: "REQUEST_METADATA", method: "POST", resourceType: "ping", framePresent: true, rootFrame: true,
        url: "https://example.org/collect", hasPostData: true, postDataPresent: false, postDataBytes: 0 })]);
      const rejected = test.guard.rejectedRequests![0];
      expect(JSON.stringify(rejected)).not.toContain("not-retained");
      expect(discoveryBrowserFeedback({ loading: false, pendingRequestCount: 0, nativeRejectedRequests: [rejected],
        requestFailures: [{ reason: rejected.code, resourceType: rejected.resourceType, url: rejected.url }] }, "observe")).toBeUndefined();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, value]) => value?.requestId)).toEqual(["ping"]);
      expect(test.cdp.send.mock.calls.filter(([name]) => ["Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))
        .map(([, value]) => value?.requestId)).not.toContain("ping");
      expect(test.handler).toHaveBeenCalledTimes(2); expect(test.guard.firstFatal).toBeUndefined();
      expect(test.failures).toEqual([]); expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it("does not let a late response fabricate evidence for a denied Ping", async () => {
    const test = await installed();
    try {
      test.request("ping", { resourceType: "Ping", networkId: undefined });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      test.response("ping", { resourceType: "Ping", networkId: undefined });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_RESPONSE_UNKNOWN"));
      expect(test.handler).not.toHaveBeenCalled();
      expect(test.cdp.send.mock.calls.some(([name]) => ["Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["cap", "missing-frame", "duplicate-id"])("retains the %s fatal guard before Ping denial", async kind => {
    const test = await installed(kind === "cap" ? 1 : undefined);
    try {
      if (kind === "cap" || kind === "duplicate-id") test.request("one");
      test.request(kind === "cap" ? "two" : "one", { resourceType: "Ping", networkId: undefined,
        ...(kind === "missing-frame" ? { frameId: undefined } : {}) });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      const suffix = kind === "cap" ? "INTERCEPT_LIMIT" : kind === "missing-frame" ? "FRAME_MISSING" : "DUPLICATE_FETCH_ID";
      expect(test.failures).toContain(`NATIVE_REDIRECT_${suffix}`); expect(test.guard.rejectedRequests).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("still closes when the exact Ping abort %ss", async kind => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest"
      ? kind === "hang" ? new Promise(() => {}) : Promise.reject(new Error("Protocol abort rejected")) : send(name, value));
    try {
      test.request("ping", { resourceType: "Ping", networkId: undefined });
      await vi.waitFor(() => { expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0); });
      expect(test.failures).toContain(kind === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : "NATIVE_REDIRECT_ROUTING_FAILED");
      expect(test.handler).not.toHaveBeenCalled(); expect(test.guard.rejectedRequests).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it("counts denied Pings toward the intercept limit and bounds copied diagnostics", async () => {
    const test = await installed(14);
    try {
      for (let index = 0; index < 14; index++) test.request(`ping-${index}`, { resourceType: "Ping", networkId: undefined });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.guard.rejectedRequests).toHaveLength(12);
      const copy = test.guard.rejectedRequests!; copy[0].code = "MUTATED"; copy.pop();
      expect(test.guard.rejectedRequests).toHaveLength(12); expect(test.guard.rejectedRequests?.[0].code).toBe("NATIVE_REDIRECT_PING_UNSUPPORTED");
      test.request("availability");
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_INTERCEPT_LIMIT"));
      expect(test.handler).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("still closes when aborting an oversized POST %ss", async kind => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest"
      ? kind === "hang" ? new Promise(() => {}) : Promise.reject(new Error("Protocol abort rejected")) : send(name, value));
    try {
      test.request("oversized", { request: { url: "https://example.org/collect", method: "POST", postData: "x".repeat(32769), headers: {} } });
      await vi.waitFor(() => { expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0); });
      expect(test.failures).toContain(kind === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : "NATIVE_REDIRECT_ROUTING_FAILED");
      expect(test.handler).not.toHaveBeenCalled(); expect(test.guard.rejectedRequests).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["cap", "missing-frame", "missing-network", "duplicate-id"])("does not bypass the %s guard for oversized POSTs", async kind => {
    const test = await installed(kind === "cap" ? 1 : undefined);
    try {
      if (kind === "cap" || kind === "duplicate-id") test.request("one");
      test.request(kind === "cap" ? "two" : "one", { ...(kind === "missing-frame" ? { frameId: undefined } : {}),
        ...(kind === "missing-network" ? { networkId: undefined } : {}), request: {
          url: "https://example.org/collect", method: "POST", postData: "x".repeat(32769), headers: {} } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.rejectedRequests).toEqual([]); expect(test.failures).not.toContain("NATIVE_REDIRECT_POST_BODY_LIMIT");
    } finally { await test.guard.close(); }
  });

  it("bounds independently rejected POST diagnostics and returns copies", async () => {
    const test = await installed();
    try {
      for (let index = 0; index < 14; index++) test.request(String(index), { request: {
        url: `https://example.org/collect${index}`, method: "POST", postData: "x".repeat(32769), headers: {} } });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.rejections).toHaveLength(14); expect(test.guard.rejectedRequests).toHaveLength(12);
      expect(test.guard.rejectedRequests?.[0].url).toBe("https://example.org/collect2");
      const copy = test.guard.rejectedRequests!; copy[0].code = "MUTATED"; copy.pop();
      expect(test.guard.rejectedRequests).toHaveLength(12); expect(test.guard.rejectedRequests?.[0].code).toBe("NATIVE_REDIRECT_POST_BODY_LIMIT");
      expect(test.handler).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });

  it.each([16384, 16385])("enforces the 32768-byte body limit without truncating multibyte text (%s characters)", async characters => {
    const test = await installed(), body = "é".repeat(characters);
    try {
      test.request("unicode", { request: { url: "https://example.org/public-read", method: "POST", hasPostData: true, postData: body, headers: {} } });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      if (characters === 16384) {
        expect(test.handler).toHaveBeenCalledOnce(); expect(test.routes[0].request().postData()).toBe(body);
        expect(test.guard.rejectedRequests).toEqual([]);
      } else {
        expect(test.handler).not.toHaveBeenCalled();
        expect(test.guard.rejectedRequests?.[0]).toMatchObject({ code: "NATIVE_REDIRECT_POST_BODY_LIMIT", postDataBytes: 32770 });
      }
      expect(test.close).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });

  it("retains only the first fatal guard's public path and bounded facts without secrets or raw identifiers", async () => {
    const test = await installed();
    try {
      test.request("private-fetch-id", { networkId: "private-network-id", request: {
        url: "https://example.org/collect?token=private-query-value", method: "POST", hasPostData: true,
        headers: { Authorization: "private-header-value" },
      } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.firstFatal).toEqual({ code: "NATIVE_REDIRECT_POST_BODY_MISSING", url: "https://example.org/collect", method: "POST", resourceType: "xhr",
        operation: "REQUEST_METADATA", requestUrlSha256: "c95c13f6859bf61e084f9b8bc977b2c7a02de60bd3d174a3c2fe617ee05f777a",
        interceptedRequests: 1, recordCount: 0, requestLimit: 256, framePresent: true, rootFrame: true, networkIdPresent: true,
        duplicateRequestId: false, hasPostData: true, postDataPresent: false, postDataBytes: 0 });
      const copy = test.guard.firstFatal!; copy.code = "MUTATED_COPY";
      test.request("later", { networkId: undefined });
      expect(test.guard.firstFatal?.code).toBe("NATIVE_REDIRECT_POST_BODY_MISSING");
      expect(JSON.stringify(test.guard.firstFatal)).not.toMatch(/private-|Authorization|token|networkId"|frameId"|postData"/u);
    } finally { await test.guard.close(); }
  });

  it.each(["https://example.org/account/session-secret/collect", "https://sc.cps.golf/(S(abcdefghijklmnopqrstuvwx))/v3.5/teetimes"])("omits unsafe or session-bearing fatal paths %s", async url => {
    const test = await installed();
    try {
      test.request("one", { networkId: undefined, request: { url, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.firstFatal?.url).toBeUndefined();
    } finally { await test.guard.close(); }
  });

  it("only releases active same-page Playwright pauses; foreign/unavailable/closed routes abort", async () => {
    const test = await installed(), same = playwrightRoute(test), foreign = playwrightRoute(test), unavailable = playwrightRoute(test), closed = playwrightRoute(test);
    vi.spyOn(foreign, "request").mockReturnValue({ frame: () => ({}) } as ReturnType<Route["request"]>);
    vi.spyOn(unavailable, "request").mockImplementation(() => { throw new Error("frame unavailable"); });
    await test.guard.releasePlaywrightRoute(same); await test.guard.releasePlaywrightRoute(foreign); await test.guard.releasePlaywrightRoute(unavailable);
    expect(same.continue).toHaveBeenCalledOnce(); expect(foreign.abort).toHaveBeenCalledOnce(); expect(unavailable.abort).toHaveBeenCalledOnce();
    expect(test.handler).not.toHaveBeenCalled(); await test.guard.close(); await test.guard.releasePlaywrightRoute(closed);
    expect(closed.continue).not.toHaveBeenCalled(); expect(closed.abort).toHaveBeenCalledOnce();
  });

  it("reports an unsupported frame explicitly", async () => {
    const test = await installed();
    expect(() => test.guard.prepare(test.main as Parameters<typeof test.guard.prepare>[0])).not.toThrow();
    expect(() => test.guard.prepare({} as Parameters<typeof test.guard.prepare>[0])).toThrow("NATIVE_REDIRECT_FRAME_UNGUARDED");
    await test.guard.close();
  });
});

describe("private placeholder-click native gesture provenance", () => {
  const source = "https://example.org/data", target = "https://booking.example.org/services";
  async function prepare(callback?: (sourceUrl: string, targetUrl: string) => NativeGestureIntent | undefined) {
    const t = await installed(undefined, undefined, async route => {
      if (route.request().url() !== source && !nativeGestureNavigationSource(route.request())) await route.abort();
    }, "SOURCE_ROUTING", undefined, undefined, undefined, callback);
    await t.guard.beginDocumentNavigation(t.main as never);
    t.events.get("Network.requestWillBeSent")!({ requestId: "network-document", frameId: "main", loaderId: "source-loader", type: "Document", request: { url: source, method: "GET" } });
    t.request("document", { resourceType: "Document", request: { url: source, method: "GET", headers: {} } });
    await t.routes[0].continue();
    t.response("document", { resourceType: "Document", request: { url: source, method: "GET", headers: {} }, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
    await t.routes[0].request().response();
    t.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "source-loader", url: source } });
    return t;
  }
  const pageIntent = (t: Awaited<ReturnType<typeof prepare>>, extra = {}) => t.events.get("Page.frameRequestedNavigation")!({
    frameId: "main", reason: "scriptInitiated", disposition: "currentTab", url: target, ...extra });
  const network = (t: Awaited<ReturnType<typeof prepare>>, extra = {}) => t.events.get("Network.requestWillBeSent")!({
    requestId: "network-next", frameId: "main", loaderId: "next-loader", type: "Document", hasUserGesture: true, initiator: { type: "script" }, request: { url: target, method: "GET" }, ...extra });
  const pause = (t: Awaited<ReturnType<typeof prepare>>, extra = {}) => t.request("next", {
    resourceType: "Document", request: { url: target, method: "GET", headers: {} }, ...extra });
  function proof(from = source) {
    let used = false, alive = true;
    const value: NativeGestureIntent = { sourceUrl: from, href: from + "#", text: "Book Bay 1", label: "", targetUrl: target,
      observedAt: new Date().toISOString(), documentHash: "a".repeat(64),
      active: () => alive, consume: () => { if (used || !alive) return false; used = true; return true; } };
    return { value, consumed: () => used, retire: () => { alive = false; } };
  }
  it("binds a fresh gesture after an attested same-document history navigation", async () => {
    const spa = "https://example.org/leagues", p = proof(spa), callback = vi.fn(() => p.value), t = await prepare(callback);
    try {
      t.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: spa });
      expect(t.guard.isCurrentCompletedDocumentRead(t.routes[0].request(), t.main as never,
        { frameId: "main", loaderId: "source-loader", url: spa })).toBe(true);
      pageIntent(t); network(t); pause(t);
      await vi.waitFor(() => expect(t.routes).toHaveLength(2));
      expect(callback).toHaveBeenCalledExactlyOnceWith(spa, target);
      expect(p.consumed()).toBe(true);
      expect(nativeGestureNavigationSource(t.routes[1].request())).toBe(p.value);
    } finally { await t.guard.close(); }
  });
  it("carries that same-document gesture only through its exact released HTTP redirect", async () => {
    const spa = "https://example.org/leagues", final = "https://booking.example.org/final";
    const p = proof(spa), t = await prepare(() => p.value);
    try {
      t.events.get("Page.navigatedWithinDocument")!({ frameId: "main", url: spa });
      pageIntent(t); network(t); pause(t);
      await vi.waitFor(() => expect(t.routes).toHaveLength(2));
      const first = t.routes[1].request();
      expect(nativeGestureNavigationSource(first)).toBe(p.value);
      await t.routes[1].continue();
      t.response("next", { resourceType: "Document", request: { url: target, method: "GET", headers: {} }, responseStatusCode: 302,
        responseHeaders: [{ name: "Location", value: final }] });
      await first.response();
      t.events.get("Network.requestWillBeSent")!({ requestId: "network-next", frameId: "main", loaderId: "next-loader", type: "Document",
        redirectResponse: { status: 302 }, request: { url: final, method: "GET" } });
      t.request("redirected", { networkId: "network-next", redirectedRequestId: "next", resourceType: "Document",
        request: { url: final, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(t.routes).toHaveLength(3));
      const child = t.routes[2].request();
      expect(child.redirectedFrom()).toBe(first);
      expect(nativeGestureNavigationSource(child)).toBe(p.value);
      expect(isObservedNativeRedirect(child, new Set([target]))).toBe(true);
      await t.routes[2].continue();
      t.response("redirected", { resourceType: "Document", networkId: "network-next", request: { url: final, method: "GET", headers: {} },
        responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
      await child.response();
      t.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "next-loader", url: final } });
      expect(t.guard.isCurrentCompletedDocumentRead(child, t.main as never, { frameId: "main", loaderId: "next-loader", url: final })).toBe(true);
      expect(attestedNativeDocumentRedirects(child, new Set([target]))).toEqual([{ fromUrl: target, toUrl: final, status: 302, completed: true }]);
    } finally { await t.guard.close(); }
  });
  it.each(["foreign frame", "wrong origin", "unsafe route", "revised source", "replacement document"])(
    "does not grant a same-document gesture from %s", async mode => {
      const spa = "https://example.org/leagues", p = proof(spa), callback = vi.fn(() => p.value), t = await prepare(callback);
      try {
        t.events.get("Page.navigatedWithinDocument")!({ frameId: mode === "foreign frame" ? "child" : "main",
          url: mode === "wrong origin" ? "https://foreign.example/leagues" : mode === "unsafe route" ? "https://example.org/account" : spa });
        if (mode === "revised source") t.events.get("Network.requestWillBeSent")!({ requestId: "network-document", frameId: "main",
          loaderId: "source-loader", type: "Document", request: { url: source, method: "GET" } });
        if (mode === "replacement document") t.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "replacement-loader", url: spa } });
        pageIntent(t); network(t); pause(t);
        await vi.waitFor(() => expect(t.routes.length > 1 || t.close.mock.calls.length > 0).toBe(true));
        expect(t.routes.slice(1).every(route => nativeGestureNavigationSource(route.request()) === null)).toBe(true);
        expect(p.consumed()).toBe(false);
        expect(t.cdp.send.mock.calls.some(([name, params]) => name === "Fetch.continueRequest" && params?.requestId === "next")).toBe(false);
      } finally { await t.guard.close(); }
    });
  it("binds actual Page then gesture Network then Fetch to one private request; copied and second use grant nothing", async () => {
    const p = proof(), callback = vi.fn(() => p.value), t = await prepare(callback);
    try {
      pageIntent(t); network(t); pause(t);
      await vi.waitFor(() => expect(t.routes).toHaveLength(2));
      const request = t.routes[1].request();
      expect(p.consumed()).toBe(true); expect(nativeGestureNavigationSource(request)).toBe(p.value);
      expect(nativeGestureNavigationSource({ ...request })).toBeNull();
      expect(callback).toHaveBeenCalledExactlyOnceWith(source, target);
      await t.routes[1].continue();
      t.response("next", { resourceType: "Document", request: { url: target, method: "GET", headers: {} }, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
      await request.response(); t.events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "next-loader", url: target } });
      expect(t.guard.isCurrentCompletedDocumentRead(request, t.main as never, { frameId: "main", loaderId: "next-loader", url: target })).toBe(true);
      p.retire(); expect(nativeGestureNavigationSource(request)).toBeNull(); expect(p.value.consume()).toBe(false);
      expect(t.failures).toEqual([]);
    } finally { await t.guard.close(); }
  });
  for (const mode of ["no action", "inactive", "consumed", "no gesture", "no initiator", "wrong source", "wrong target", "no Page event", "foreign Page", "new window", "foreign Network", "wrong Network URL", "same loader", "body", "source revision"]) {
    it("grants no placeholder provenance for " + mode, async () => {
      const p = proof();
      if (mode === "inactive") p.retire();
      if (mode === "consumed") p.value.consume();
      const t = await prepare(mode === "no action" ? undefined : () => mode === "wrong source" ? { ...p.value, sourceUrl: source + "/other" }
        : mode === "wrong target" ? { ...p.value, targetUrl: target + "/other" } : p.value);
      try {
        if (mode === "source revision") t.events.get("Network.requestWillBeSent")!({ requestId: "network-document", frameId: "main", loaderId: "source-loader", type: "Document", request: { url: source, method: "GET" } });
        if (mode !== "no Page event") pageIntent(t, mode === "foreign Page" ? { frameId: "child" } : mode === "new window" ? { disposition: "newWindow" } : {});
        network(t, mode === "no gesture" ? { hasUserGesture: false } : mode === "no initiator" ? { initiator: { type: "other" } }
          : mode === "foreign Network" ? { frameId: "child" } : mode === "wrong Network URL" ? { request: { url: target + "/different", method: "GET" } }
          : mode === "same loader" ? { loaderId: "source-loader" } : mode === "body" ? { request: { url: target, method: "GET", hasPostData: true, postData: "x" } } : {});
        pause(t, mode === "body" ? { request: { url: target, method: "GET", hasPostData: true, postData: "x", headers: {} } } : {});
        await vi.waitFor(() => expect(t.routes.length > 1 || t.close.mock.calls.length > 0).toBe(true));
        expect(t.routes.slice(1).every(route => nativeGestureNavigationSource(route.request()) === null)).toBe(true);
        expect(t.cdp.send.mock.calls.some(([name, params]) => name === "Fetch.continueRequest" && params?.requestId === "next")).toBe(false);
      } finally { await t.guard.close(); }
    });
  }
});
