// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/automation/address-pinned-public-fetch", () => ({ resolvePinnedPublicAddress: mocks.resolve }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { CPS_API_PATH } from "./cps-source";
import { CPS_ANONYMOUS_BUILD, createCps26PublicSession, parseCps26PublicEnvironment } from "./cps-public-session";
import { cpsAvailabilityQuery } from "./cps-executor";

const origin = "https://publicgolf.cps.golf", date = "2030-01-02", transactionId = "12345678-1234-4123-8123-123456789abc";
const source = { officialUrl: "https://official.example.org/", bookingUrl: origin + "/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=23.99999999999999",
  venueName: "Public Golf", venueAddress: "100 Golf Road, Denver, CO 80001, USA", timeZone: "America/Denver" };
const token = "SYNTHETIC_ANONYMOUS_RAM_ONLY_BEARER";
const config = () => ({ siteName: "publicgolf", onlineApi: origin + CPS_API_PATH, authorityBaseUrl: origin + "/identityapi",
  clientId: "published-public-client", websiteId: "public-site", buildNumber: CPS_ANONYMOUS_BUILD });
const routing = () => new Headers({ accept: "application/json, text/plain, */*", "client-id": config().clientId, "x-websiteid": config().websiteId,
  "x-terminalid": "1", "x-timezoneid": source.timeZone, "x-timezone-offset": "420", "x-siteid": "1", "x-moduleid": "7",
  "x-productid": "1", "x-componentid": "1", "x-ismobile": "false", referer: origin + "/", "x-requestid": transactionId });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const envScript = '(function(window){window.__env=window.__env||{};window.__env.AUTH_CLIENT_ID="separate-account-client";window.__env.SHORT_LIVED_CLIENT_ID="separate-published-short-client";window.__env.PRODUCTION="true";})(this);';
const inertPublishedLiteral = "SYNTHETIC_UNUSED_PUBLIC_LITERAL";
const envWithInertLiteral = envScript.replace('window.__env.SHORT_LIVED_CLIENT_ID=',
  `window.__env.CLIENT_SECRET="${inertPublishedLiteral}";window.__env.SHORT_LIVED_CLIENT_ID=`);
const envResponse = () => new Response(envScript, {headers:{"content-type":"text/javascript"}});
const tokenResponse = () => json({ access_token: token, token_type: "Bearer", expires_in: 60 });
function setup(change?: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [], charged: number[] = []; let leases = 0;
  const session = createCps26PublicSession(source, config(), date, { deadlineAt: new Date(Date.now() + 60_000), bootstrapHeaders: routing(),
    fetch: (async (url, init = {}) => { const value = String(url); calls.push({ url: value, init }); return value.endsWith("/assets/env.js") ? envResponse() : change ? change(value, init) : value.endsWith("/token/short") ? tokenResponse() : json({ complete: true }); }) as typeof fetch,
    runBootstrap: async work => { leases++; return work(); }, accountBootstrapBytes: count => charged.push(count) });
  return { session, calls, charged, get leases() { return leases; } };
}
const optionsUrl = () => origin + CPS_API_PATH + "/GetAllOptions/publicgolf?" + new URLSearchParams({ version: CPS_ANONYMOUS_BUILD, product: "3" });
const init = (headers: Headers = routing()) => ({ method: "GET", headers, credentials: "omit" as const, redirect: "manual" as const, cache: "no-store" as const });
beforeEach(() => { vi.restoreAllMocks(); mocks.resolve.mockReset(); mocks.request.mockReset(); });

describe("exact CPS26 anonymous public browsing session", () => {
  it("derives only a literal public short-lived id from the reviewed env shape, never routing/account/storage or executable code", () => {
    expect(parseCps26PublicEnvironment(envScript)).toBe("separate-published-short-client");
    expect(parseCps26PublicEnvironment(envWithInertLiteral)).toBe("separate-published-short-client");
    expect(parseCps26PublicEnvironment(envWithInertLiteral)).not.toContain(inertPublishedLiteral);
    expect(parseCps26PublicEnvironment(envScript)).not.toBe(config().clientId);
    for (const script of [envScript.replace('window.__env.SHORT_LIVED_CLIENT_ID="separate-published-short-client";', ''),
      envScript.replace('"separate-published-short-client"', 'localStorage.access_token'), envScript.replace('"separate-published-short-client"', 'document.cookie'),
      envScript.replace('window.__env.SHORT_LIVED_CLIENT_ID', 'window.__env.AUTH_CLIENT_ID'), envScript.replace('})(this)', '})(otherContext)'),
      envScript.replace('window.__env.PRODUCTION', 'window.__env.access_token'), envScript + 'fetch("https://private.example/");',
      envScript.replace('"separate-published-short-client"', '"bad id"')]) expect(() => parseCps26PublicEnvironment(script)).toThrow("CPS_PUBLIC_SESSION_ENV_UNVERIFIED");
    for (const script of [
      envWithInertLiteral.replace('window.__env.CLIENT_SECRET', 'window.__env.UNKNOWN'),
      envWithInertLiteral.replace('window.__env.CLIENT_SECRET', 'window.__env.AUTH_CLIENT_ID'),
      envWithInertLiteral.replace(`"${inertPublishedLiteral}"`, 'window.accountSecret'),
      envWithInertLiteral.replace(`"${inertPublishedLiteral}"`, 'readSecret()'),
      envWithInertLiteral.replace(`"${inertPublishedLiteral}"`, '({value:1})'),
      envWithInertLiteral.replace(`"${inertPublishedLiteral}"`, '42'),
      envWithInertLiteral.replace(`"${inertPublishedLiteral}"`, '""'),
      envWithInertLiteral.replace(`"${inertPublishedLiteral}"`, `"${'x'.repeat(129)}"`),
      envWithInertLiteral.replace('window.__env.CLIENT_SECRET', 'window["__env"].CLIENT_SECRET'),
      envWithInertLiteral.replace('window.__env.CLIENT_SECRET', 'window.__env.__proto__.CLIENT_SECRET'),
      envWithInertLiteral.replace('window.__env.SHORT_LIVED_CLIENT_ID=', `window.__env.CLIENT_SECRET="duplicate";window.__env.SHORT_LIVED_CLIENT_ID=`),
      envWithInertLiteral.replace(`window.__env.CLIENT_SECRET="${inertPublishedLiteral}";`, '')
        .replace('window.__env.PRODUCTION=', `window.__env.CLIENT_SECRET="${inertPublishedLiteral}";window.__env.PRODUCTION=`),
    ]) expect(() => parseCps26PublicEnvironment(script)).toThrow("CPS_PUBLIC_SESSION_ENV_UNVERIFIED");
  });
  it("uses only SHORT_LIVED_CLIENT_ID for the anonymous bootstrap when the published inert literal is present", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const session = createCps26PublicSession(source, config(), date, { deadlineAt: new Date(Date.now() + 10_000),
      bootstrapHeaders: routing(), runBootstrap: async work => work(), accountBootstrapBytes: () => {},
      fetch: (async (url, init = {}) => { calls.push({ url: String(url), init }); return String(url).endsWith('/env.js')
        ? new Response(envWithInertLiteral, { headers: { 'content-type': 'text/javascript' } }) : tokenResponse(); }) as typeof fetch });
    await session.initialize();
    expect(calls).toHaveLength(2);
    const headers = new Headers(calls[1].init.headers);
    expect(headers.has('authorization')).toBe(false);
    const form = await new Response(calls[1].init.body, { headers }).formData();
    expect([...form]).toEqual([["client_id", "separate-published-short-client"]]);
    expect(JSON.stringify(calls[1])).not.toContain(inertPublishedLiteral);
    session.close();
  });
  it("rejects an unavailable fresh env binding before token or API and does not guess the published main fallback", async () => {
    const calls: string[] = [];
    const s = createCps26PublicSession(source, config(), date, { deadlineAt: new Date(Date.now() + 10000), bootstrapHeaders: routing(),
      runBootstrap: async work => work(), accountBootstrapBytes: () => {}, fetch: (async url => { calls.push(String(url)); return new Response(envScript.replace('window.__env.SHORT_LIVED_CLIENT_ID="separate-published-short-client";', ''), {headers:{"content-type":"text/javascript"}}); }) as typeof fetch });
    await expect(s.initialize()).rejects.toThrow("CPS_PUBLIC_SESSION_ENV_UNVERIFIED"); expect(calls).toEqual([origin + "/onlineresweb/assets/env.js"]); s.close();
  });
  it("keeps the original deadline and external cancellation while no response arrives", async () => {
    const cancellation = new AbortController(); let calls = 0;
    const s = createCps26PublicSession(source, config(), date, { deadlineAt: new Date(Date.now() + 10000), signal: cancellation.signal,
      bootstrapHeaders: routing(), runBootstrap: async work => work(), accountBootstrapBytes: () => {},
      fetch: (() => { calls++; queueMicrotask(() => cancellation.abort("SYNTHETIC_PRIVATE_ABORT_REASON")); return new Promise<Response>(() => {}); }) as typeof fetch });
    await expect(s.initialize()).rejects.toThrow("CPS_PUBLIC_SESSION_REQUEST_DEADLINE"); expect(calls).toBe(1); s.close();
    const f = setup(); await f.session.initialize(); const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 61000);
    await expect(f.session.fetchPublic(optionsUrl(), init())).rejects.toThrow("CPS_PUBLIC_SESSION_EXPIRED"); expect(f.calls).toHaveLength(2); f.session.close();
  });
  it("charges public source bytes before token and stops when the existing invocation byte budget rejects", async () => {
    let calls = 0;
    const s = createCps26PublicSession(source, config(), date, { deadlineAt: new Date(Date.now() + 10000), bootstrapHeaders: routing(),
      runBootstrap: async work => work(), accountBootstrapBytes: () => { throw new Error("ADAPTER_RESPONSE_LIMIT"); },
      fetch: (async () => { calls++; return envResponse(); }) as typeof fetch });
    await expect(s.initialize()).rejects.toThrow("ADAPTER_RESPONSE_LIMIT"); expect(calls).toBe(1); s.close();
  });
  it("bootstraps once using only the published client_id field, existing budget hook and no account/cookie authority", async () => {
    const f = setup(); await f.session.initialize(); expect(f.leases).toBe(2); expect(f.charged).toHaveLength(2);
    const call = f.calls[1]; expect(call.url).toBe(config().authorityBaseUrl + "/myconnect/token/short");
    expect(call.init).toMatchObject({ method: "POST", credentials: "omit", redirect: "manual", cache: "no-store" });
    const h = new Headers(call.init.headers); expect(h.has("authorization")).toBe(false); expect(h.has("cookie")).toBe(false); expect(h.has("x-apikey")).toBe(false);
    const form = await new Response(call.init.body, { headers: h }).formData(); expect([...form]).toEqual([["client_id", "separate-published-short-client"]]);
    await expect(f.session.initialize()).rejects.toThrow("CPS_PUBLIC_SESSION_ALREADY_INITIALIZED"); expect(f.calls).toHaveLength(2); f.session.close();
  });
  it("retains bearer only inside its closure for the exact public GET and UUID browse POST roles", async () => {
    const f = setup(); await f.session.initialize();
    const urls = [optionsUrl(), origin + CPS_API_PATH + "/OnlineCourses", origin + CPS_API_PATH + "/TeeTimes?" + cpsAvailabilityQuery(date, [1], transactionId)];
    for (const url of urls) expect(await (await f.session.fetchPublic(url, init())).json()).toEqual({ complete: true });
    const h = routing(); h.set("content-type", "application/json");
    await f.session.fetchPublic(origin + CPS_API_PATH + "/RegisterTransactionId", { ...init(h), method: "POST", body: JSON.stringify({ transactionId }) });
    expect(f.calls.slice(2).every(c => new Headers(c.init.headers).get("authorization") === "Bearer " + token)).toBe(true);
    expect(Object.keys(f.session).sort()).toEqual(["close", "fetchPublic", "initialize"]); expect(JSON.stringify(f.session)).not.toContain(token);
    await expect(f.session.fetchPublic(optionsUrl(), init())).rejects.toThrow("CPS_PUBLIC_SESSION_UNAVAILABLE");
    f.session.close(); await expect(f.session.fetchPublic(optionsUrl(), init())).rejects.toThrow("CPS_PUBLIC_SESSION_EXPIRED");
  });
  it("rejects every guessed host/path/query/account/booking operation before dispatch", async () => {
    for (const [url, request] of [
      [optionsUrl().replace("publicgolf.cps.golf", "other.cps.golf"), init()], [optionsUrl() + "&user=9", init()],
      [origin + "/identityapi/connect/userinfo", init()], [origin + CPS_API_PATH + "/Reserve", { ...init(), method: "POST", body: "{}" }],
      [origin + CPS_API_PATH + "/TeeTimes?" + cpsAvailabilityQuery("2030-01-03", [1], transactionId), init()],
      [origin + CPS_API_PATH + "/OnlineCourses?accountId=9", init()], [origin + CPS_API_PATH + "/OnlineCourses", { ...init(), credentials: "include" }],
      [origin + CPS_API_PATH + "/RegisterTransactionId", { ...init(), method: "POST", body: JSON.stringify({ transactionId, teeSheetId: 1 }) }],
      [origin + CPS_API_PATH + "/RegisterTransactionId", { ...init(), method: "POST", body: JSON.stringify({ transactionId: "not-a-uuid" }) }],
    ] as [string, RequestInit][]) {
      const f = setup(); await f.session.initialize(); await expect(f.session.fetchPublic(url, request)).rejects.toThrow("CPS_PUBLIC_SESSION_SCOPE_INVALID"); expect(f.calls).toHaveLength(2); f.session.close();
    }
  });
  it.each(["authorization", "cookie", "proxy-authorization", "x-apikey", "x-api-key", "x-user-id"])("rejects caller %s header rather than upgrading it", async name => {
    const f = setup(); await f.session.initialize(); const h = routing(); h.set(name, "SYNTHETIC_ACCOUNT_SECRET");
    await expect(f.session.fetchPublic(optionsUrl(), init(h))).rejects.toThrow("CPS_PUBLIC_SESSION_HEADERS_INVALID"); expect(f.calls).toHaveLength(2); f.session.close();
  });
  it("rejects old build and changed authority/client routing before any bootstrap", () => {
    for (const changed of [{ ...config(), buildNumber: "25.3.4.21239412485", apiKey: "published-old" }, { ...config(), authorityBaseUrl: "https://other.example.org/identityapi" },
      { ...config(), onlineApi: origin + "/account" }, { ...config(), clientId: "different-client" }]) {
      expect(() => createCps26PublicSession(source, changed, date, { deadlineAt: new Date(Date.now() + 10000), bootstrapHeaders: routing(),
        runBootstrap: async work => work(), accountBootstrapBytes: () => {} })).toThrow();
    }
  });
  it.each([
    () => new Response(null, { status: 302, headers: { location: "https://other.example.org/" } }),
    () => json({ message: token }, 401), () => new Response(token, { headers: { "content-type": "text/html" } }),
    () => json({ access_token: token, refresh_token: "SYNTHETIC_ACCOUNT_REFRESH" }), () => json({ access_token: token, expires_in: -1 }),
    () => json({ access_token: token, token_type: "Other" }), () => json({ access_token: token + "\n" }), () => json({ access_token: "x".repeat(33000) }),
  ])("fails closed on malformed/redirect/account/oversized bootstrap response without exposing payload", async response => {
    const f = setup(response); let error: unknown; try { await f.session.initialize(); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(token); expect(String(error)).not.toContain("SYNTHETIC_ACCOUNT_REFRESH"); expect(f.calls).toHaveLength(2); f.session.close();
  });
  it("does not forward provider exceptions or reflected response headers and clears an expired session", async () => {
    const f = setup(url => url.endsWith("/token/short") ? tokenResponse() : (() => { throw new Error("CPS_PUBLIC_SESSION_" + token); })());
    await f.session.initialize(); await expect(f.session.fetchPublic(optionsUrl(), init())).rejects.toThrow("CPS_PUBLIC_SESSION_TRANSPORT_FAILED"); f.session.close();
    const g = setup(url => url.endsWith("/token/short") ? tokenResponse() : new Response("{}", { headers: { "content-type": "application/json", "set-cookie": token, authorization: token } }));
    await g.session.initialize(); const response = await g.session.fetchPublic(optionsUrl(), init()); expect([...response.headers.keys()]).toEqual(["content-type"]); g.session.close();
  });
  it("keeps public DNS pinning/TLS exact and forwards no cookie jar on the actual default transport seam", async () => {
    mocks.resolve.mockResolvedValue({ address: "8.8.8.8", family: 4 });
    const sent: { url: URL; options: Record<string, unknown>; body?: string }[] = [];
    mocks.request.mockImplementation((url: URL, options: Record<string, unknown>, callback: (value: EventEmitter) => void) => {
      const request = new EventEmitter() as EventEmitter & { end(body?: string): void };
      request.end = body => { sent.push({ url, options, body }); const incoming = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": url.pathname.endsWith("/env.js")?"text/javascript":"application/json" } });
        queueMicrotask(() => { callback(incoming); incoming.emit("data", Buffer.from(url.pathname.endsWith("/env.js")?envScript:JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 60 }))); incoming.emit("end"); }); };
      return request;
    });
    const s = createCps26PublicSession(source, config(), date, { deadlineAt: new Date(Date.now() + 10000), bootstrapHeaders: routing(), runBootstrap: async work => work(), accountBootstrapBytes: () => {} });
    await s.initialize(); expect(mocks.resolve).toHaveBeenCalledWith("publicgolf.cps.golf", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sent[0].options).toMatchObject({ servername: "publicgolf.cps.golf", agent: false, family: 4 });
    const lookup = sent[0].options.lookup as (hostname: string, options: object, callback: (...args: unknown[]) => void) => void;
    const resolved = vi.fn(); lookup("publicgolf.cps.golf", {}, resolved); expect(resolved).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(sent[0].options.headers).not.toHaveProperty("cookie"); expect(sent[0].options.headers).not.toHaveProperty("authorization"); s.close();
    mocks.resolve.mockRejectedValue(new Error("PRIVATE_DNS_DETAILS"));
    const blocked = createCps26PublicSession(source, config(), date, { deadlineAt: new Date(Date.now() + 10000), bootstrapHeaders: routing(), runBootstrap: async work => work(), accountBootstrapBytes: () => {} });
    await expect(blocked.initialize()).rejects.toThrow("CPS_PUBLIC_SESSION_TRANSPORT_FAILED"); expect(sent).toHaveLength(2); blocked.close();
  });
});
