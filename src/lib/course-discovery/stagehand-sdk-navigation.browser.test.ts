// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { connect } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { createGuardedStagehandSourceBrowser } from "./stagehand-source-browser";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { openStagehandSession } from "../../../scripts/automation/stagehand/driver.mjs";

// Passive fixture-only protocol observation. No IDs/metadata are modified,
// reordered or supplied to a production admission/ownership decision.
const trace = vi.hoisted(() => ({ events: [] as Record<string, unknown>[], ids: new Map<string, string>(),
  seen: new WeakMap<object, Set<string>>(), enabled: false, inferenceCalls: 0 }));
vi.mock("./stagehand-owned-cdp", async original => {
  const actual = await original<typeof import("./stagehand-owned-cdp")>();
  const id = (value: unknown, kind: string) => {
    if (typeof value !== "string" || !value) return null;
    const key = kind + ":" + value;
    if (!trace.ids.has(key)) trace.ids.set(key, kind + "-" + [...trace.ids.keys()].filter(k => k.startsWith(kind + ":")).length);
    return trace.ids.get(key);
  };
  const urlKind = (value: unknown) => typeof value !== "string" ? null : value === "about:blank" ? "BLANK" :
    value === "https://owned-sdk-root.example/" ? "ROOT" : value === "https://owned-sdk-final.example/public/" ? "FINAL" : "OTHER";
  return { ...actual, connectOwnedSourceCdp: async (...args: Parameters<typeof actual.connectOwnedSourceCdp>) => {
    const connection = await actual.connectOwnedSourceCdp(...args);
    return { ...connection, session: (sessionId: string) => {
      const session = connection.session(sessionId);
      return { ...session, on: (method: string, listener: (value: Record<string, unknown>) => unknown) => session.on(method, value => {
        const key = sessionId + ":" + method, seen = trace.seen.get(value) ?? new Set<string>();
        if (trace.enabled && !seen.has(key) && trace.events.length < 200) {
          seen.add(key); trace.seen.set(value, seen);
          const request = value.request as Record<string, unknown> | undefined, frame = value.frame as Record<string, unknown> | undefined;
          if (["Network.requestWillBeSent", "Fetch.requestPaused", "Page.frameNavigated", "Page.frameRequestedNavigation", "Network.loadingFailed", "Network.loadingFinished"].includes(method))
            trace.events.push({ index: trace.events.length, method, network: id(method === "Fetch.requestPaused" ? value.networkId : value.requestId, "network"),
              fetch: method === "Fetch.requestPaused" ? id(value.requestId, "fetch") : null,
              loader: id(frame?.loaderId ?? value.loaderId, "loader"), frame: id(frame?.id ?? value.frameId, "frame"),
              parent: id(frame?.parentId, "frame"), redirectParent: id(value.redirectedRequestId, "fetch"),
              redirectResponse: value.redirectResponse !== undefined, responseStatus: value.responseStatusCode ?? null,
              kind: value.resourceType ?? value.type ?? null, requestMethod: request?.method ?? null,
              url: urlKind(frame?.url ?? request?.url ?? value.url), reason: value.reason ?? null,
              urlSha256: typeof (frame?.url ?? request?.url ?? value.url) === "string" ? createHash("sha256").update(String(frame?.url ?? request?.url ?? value.url)).digest("hex") : null,
              canceled: value.canceled ?? null });
        }
        return listener(value);
      }), send: async (...command: Parameters<typeof session.send>) => {
        const observed = trace.enabled && ["Page.stopLoading", "Fetch.continueRequest", "Fetch.continueResponse", "Fetch.failRequest"].includes(command[0]);
        if (observed && trace.events.length < 200) trace.events.push({ index: trace.events.length, method: command[0], phase: "SEND", fetch: id(command[1]?.requestId, "fetch") });
        const result = await session.send(...command);
        if (observed && trace.events.length < 200) trace.events.push({ index: trace.events.length, method: command[0], phase: "ACK", fetch: id(command[1]?.requestId, "fetch") });
        return result;
      } };
    } };
  } };
});

const material = readFileSync("src/lib/course-discovery/cps-browser-wiring.test.ts", "utf8");
const certificate = (name: string) => JSON.parse(new RegExp("const " + name + " = (\".*?\");").exec(material)![1]);
const root = "https://owned-sdk-root.example/", final = "https://owned-sdk-final.example/public/";
type Mode = "DIRECT" | "HTTP_REDIRECT" | "INITIAL_RELOAD" | "NON_REDIRECT_307_RELOAD";
const receipts: Record<string, unknown>[] = [];
afterEach(() => { trace.enabled = false; vi.unstubAllGlobals(); });

async function fixture(transport: "PLAYWRIGHT" | "STAGEHAND", mode: Mode) {
  trace.events.length = 0; trace.ids.clear(); trace.seen = new WeakMap(); trace.inferenceCalls = 0;
  const abort = new AbortController(), deadlineAt = new Date(Date.now() + 45_000);
  let active = 0, acquired = 0, released = 0, foreignResolvers = 0, foreignFetches = 0, connected = 0;
  const families = new Set<string>(), reads: string[] = [], originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (value: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(value instanceof Request ? value.url : String(value));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) { foreignFetches++; throw Error("NONLOCAL_FIXTURE_FETCH_FORBIDDEN"); }
    return originalFetch(value, init);
  });
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    reads.push(request.method + " " + request.headers.host + request.url);
    if (mode === "HTTP_REDIRECT" && request.headers.host === "owned-sdk-root.example") {
      response.writeHead(302, { location: final }).end(); return;
    }
    const reload = mode === "INITIAL_RELOAD" || mode === "NON_REDIRECT_307_RELOAD" ? '<script>if(!sessionStorage.getItem("owned-once")){sessionStorage.setItem("owned-once","1");location.reload();}</script>' : "";
    response.writeHead(mode === "NON_REDIRECT_307_RELOAD" ? 307 : 200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end('<!doctype html><html><head><link rel="icon" href="data:,">' + reload + '</head><body><h1>Public fixture course</h1><a href="/public-info/">Public information</a></body></html>');
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined, attached: Browser | undefined;
  let session: Awaited<ReturnType<typeof openStagehandSession>> | undefined;
  const receipt: Record<string, unknown> = { transport, mode, inferenceCalls: 0, startedAt: new Date().toISOString() };
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl: root, timeZone: "UTC", deadlineAt, signal: abort.signal }, {
      requestLease: async (family, work) => {
        if (active >= 2 || families.has(family)) return { acquired: false }; active++; acquired++; families.add(family);
        try { return { acquired: true, value: await work() }; } finally { active--; released++; families.delete(family); }
      },
      proxyDependencies: { resolveAddresses: async name => {
        if (!["owned-sdk-root.example", "owned-sdk-final.example"].includes(name)) { foreignResolvers++; throw Error("NOT_OWNED_FIXTURE"); }
        return [{ address: "93.184.216.34", family: 4 }];
      }, connect: () => { connected++; return connect({ host: "127.0.0.1", port: address.port }); } },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }),
      contextOptions: { ignoreHTTPSErrors: true },
    });
    trace.enabled = true;
    if (transport === "STAGEHAND") {
      session = await openStagehandSession({ model: "gpt-6.1-sol", modelDisabled: true, sourceRoutingOnly: true,
        deadline: deadlineAt.getTime(), cwd: process.cwd(), signal: abort.signal, ownedBrowser: host }, {
        createModel: async () => { trace.inferenceCalls++; throw Error("MODEL_FORBIDDEN_IN_LOCAL_FIXTURE"); },
      });
      // Observing readiness on about:blank is outside the source-document
      // contract and would record an unrelated NATIVE_URL_CHANGED failure.
      receipt.beforeNavigation = { eventCount: trace.events.length };
      await session.goto(root);
    } else {
      attached = await chromium.connectOverCDP(host.cdpUrl);
      const page = attached.contexts().flatMap(context => context.pages())[0];
      await host.prepareNavigation(root); await page.goto(root, { waitUntil: "domcontentloaded", timeout: 15_000 });
    }
    if (mode !== "INITIAL_RELOAD" && mode !== "NON_REDIRECT_307_RELOAD") {
      await expect.poll(() => host!.observeSourceReadiness(host!.targetId), { timeout: 5000 }).toMatchObject({
        mainDocumentStatus: 200, mainDocumentCurrent: true, mainDocumentComplete: true, mainReadPending: false });
      if (session) await session.settleSourceDocument();
    }
    receipt.readiness = await host.observeSourceReadiness(host.targetId).catch(() => null);
    receipt.success = true;
  } catch (error) {
    receipt.success = false;
    receipt.error = { name: error instanceof Error ? error.name : "UNKNOWN", code: error instanceof Error && /^[A-Z_0-9]{1,100}$/.test(error.message) ? error.message : "LOCAL_NAVIGATION_FAILED" };
  } finally {
    trace.enabled = false;
    receipt.failure = host?.snapshotFailures();
    receipt.events = [...trace.events]; receipt.reads = reads;
    receipt.inferenceCalls = trace.inferenceCalls;
    receipt.modelCounts = session?.modelCallCounts ?? { attempted: 0, completed: 0 };
    receipt.disabledModelCalls = session?.disabledModelCalls ?? 0;
    receipt.closed = await host?.close();
    await session?.close().catch(() => {}); await attached?.close().catch(() => {}); abort.abort();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    receipt.leases = { active, acquired, released }; receipt.connections = connected;
    receipt.foreignResolvers = foreignResolvers; receipt.foreignFetches = foreignFetches;
    receipt.finishedAt = new Date().toISOString(); receipts.push(receipt);
    const path = process.env.STAGEHAND_SDK_LOCAL_RECEIPT;
    if (path && /^C:[/\\]Users[/\\]Grim_Leaper[/\\]\.codex[/\\]outputs[/\\]course-stagehand-unseen-20261025[/\\][A-Za-z0-9._-]+\.json$/.test(path))
      writeFileSync(path, JSON.stringify({ kind: "ACTUAL_STAGEHAND_SDK_LOCAL_NAVIGATION_DIAGNOSTIC", providerCalls: 0, productionCalls: 0, receipts }, null, 2) + "\n");
  }
  expect(trace.inferenceCalls).toBe(0); expect(receipt.disabledModelCalls).toBe(0);
  expect(receipt.modelCounts).toEqual({ attempted: 0, completed: 0 });
  expect(foreignFetches).toBe(0); expect(active).toBe(0); expect(acquired).toBe(released);
  expect(receipt.closed).toMatchObject({ browserClosed: true, providerRequestsDrained: true });
  return receipt;
}

it.each(["DIRECT", "HTTP_REDIRECT"] as const)("proves Playwright owned-navigation control: %s", async mode => {
  expect(await fixture("PLAYWRIGHT", mode)).toMatchObject({ success: true, failure: {} });
}, 60_000);

it.each(["DIRECT", "HTTP_REDIRECT"] as const)("requires the actual Stagehand SDK to retain the same owned-document proof: %s", async mode => {
  const receipt = await fixture("STAGEHAND", mode);
  expect(receipt, JSON.stringify({ failure: receipt.failure, events: receipt.events })).toMatchObject({ success: true });
  expect(receipt.failure).toEqual({});
}, 60_000);

it("compares an early native duplicate document against both real navigation clients without weakening its guard", async () => {
  const plain = await fixture("PLAYWRIGHT", "INITIAL_RELOAD"), sdk = await fixture("STAGEHAND", "INITIAL_RELOAD");
  // This is a diagnostic negative: a page-initiated unknown loader must never
  // become evidence merely because DOM content loaded or a client goto ended.
  for (const receipt of [plain, sdk]) {
    expect(receipt.success).toBe(false);
    expect(receipt.failure).toMatchObject({ nativeRouterFailure: {
      code: "NATIVE_REDIRECT_LOADER_MISMATCH", phase: "LOADER_OWNER", loaderKnown: false,
      awaitingDocument: false, documentCommitted: true, documentIntentPresent: false, sourceResponseComplete: true,
    } });
    const events = receipt.events as Record<string, unknown>[];
    const committed = events.findIndex(value => value.method === "Page.frameNavigated" && value.loader === "loader-0");
    const successor = events.findIndex(value => value.method === "Network.requestWillBeSent" && value.loader === "loader-1");
    const rejected = events.findIndex(value => value.method === "Fetch.failRequest" && value.phase === "SEND");
    expect(committed).toBeGreaterThan(-1); expect(successor).toBeGreaterThan(committed); expect(rejected).toBeGreaterThan(successor);
    expect(receipt.reads).toEqual(["GET owned-sdk-root.example/"]);
  }
}, 120_000);

it("reproduces the observed non-2xx document followed by same-URL reload before any accepted source commit", async () => {
  // Synthetic response body: only its observed 307/reload event sequence is
  // grounded in the live trace. The public response body was not retained.
  for (const client of ["PLAYWRIGHT", "STAGEHAND"] as const) {
    const receipt = await fixture(client, "NON_REDIRECT_307_RELOAD");
    expect(receipt.success).toBe(false);
    expect(receipt.failure).toMatchObject({ nativeRouterFailure: {
      code: "NATIVE_REDIRECT_LOADER_MISMATCH", phase: "LOADER_OWNER", rootFrame: true,
      loaderKnown: false, awaitingDocument: false, documentCommitted: false, documentIntentPresent: false, sourceResponseComplete: false,
    } });
    const events = receipt.events as Record<string, unknown>[];
    const response = events.findIndex(value => value.method === "Fetch.requestPaused" && value.responseStatus === 307);
    const frame = events.findIndex(value => value.method === "Page.frameNavigated" && value.loader === "loader-0");
    const reload = events.findIndex(value => value.method === "Page.frameRequestedNavigation" && value.reason === "reload");
    const successor = events.findIndex(value => value.method === "Network.requestWillBeSent" && value.loader === "loader-1" && value.redirectResponse === false);
    expect(response).toBeGreaterThan(-1); expect(frame).toBeGreaterThan(response);
    expect(reload).toBeGreaterThan(frame); expect(successor).toBeGreaterThan(reload);
    expect(receipt.reads).toEqual(["GET owned-sdk-root.example/"]);
  }
}, 120_000);
