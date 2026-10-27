import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { parse } from "acorn";
import { resolvePinnedPublicAddress } from "@/lib/automation/address-pinned-public-fetch";
import { CPS_API_PATH, parseCpsConfiguration, parseCpsSource, type CpsConfiguration, type CpsSource } from "./cps-source";

export const CPS_ANONYMOUS_BUILD = "26.3.0.34794395074";
const BOOTSTRAP_LIMIT = 32_768, PUBLIC_LIMIT = 2_000_000;
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
class PublicSessionFailure extends Error {}
function fail(code: string): never { throw new PublicSessionFailure(code); }
type Ast = { type: string; [key: string]: unknown };
const node = (value: unknown): value is Ast => Boolean(value && typeof value === "object" && "type" in value);
function member(value: unknown, path: string[]): boolean {
  if (!node(value)) return false;
  return path.length === 1 ? value.type === "Identifier" && value.name === path[0] : value.type === "MemberExpression" &&
    value.computed === false && node(value.property) && value.property.type === "Identifier" && value.property.name === path.at(-1) && member(value.object, path.slice(0, -1));
}
/** Parse, never execute, the exact published startup-env IIFE. An optional
 * inert CLIENT_SECRET literal is syntax only: it is never returned or used. */
export function parseCps26PublicEnvironment(script: string): string {
  let program: Ast; try { program = parse(script, { ecmaVersion: "latest", sourceType: "script" }) as unknown as Ast; }
  catch { fail("CPS_PUBLIC_SESSION_ENV_UNVERIFIED"); }
  const body = program.body as Ast[];
  const call = body?.length === 1 && body[0].type === "ExpressionStatement" ? body[0].expression as Ast : undefined;
  const fn = call?.type === "CallExpression" ? call.callee as Ast : undefined, args = call?.arguments as Ast[] | undefined;
  if (!fn || fn.type !== "FunctionExpression" || fn.id !== null || fn.async || fn.generator || !Array.isArray(args) || args.length !== 1 || args[0].type !== "ThisExpression" ||
      !Array.isArray(fn.params) || fn.params.length !== 1 || !member(fn.params[0], ["window"]) || !node(fn.body)) fail("CPS_PUBLIC_SESSION_ENV_UNVERIFIED");
  const statements = fn.body.body as Ast[];
  if (!Array.isArray(statements) || ![4, 5].includes(statements.length)) fail("CPS_PUBLIC_SESSION_ENV_UNVERIFIED");
  const assignments = statements.map(s => s.type === "ExpressionStatement" && node(s.expression) ? s.expression : undefined);
  const first = assignments[0], right = first?.right as Ast;
  if (first?.type !== "AssignmentExpression" || first.operator !== "=" || !member(first.left, ["window", "__env"]) ||
      right?.type !== "LogicalExpression" || right.operator !== "||" || !member(right.left, ["window", "__env"]) || !node(right.right) ||
      right.right.type !== "ObjectExpression" || !Array.isArray(right.right.properties) || right.right.properties.length) fail("CPS_PUBLIC_SESSION_ENV_UNVERIFIED");
  const optionalSecret = statements.length === 5;
  if (optionalSecret) {
    const inert = assignments[2], literal = inert?.right;
    if (inert?.type !== "AssignmentExpression" || inert.operator !== "=" || !member(inert.left, ["window", "__env", "CLIENT_SECRET"]) ||
        !node(literal) || literal.type !== "Literal" || typeof literal.value !== "string" ||
        literal.value.length < 1 || literal.value.length > 128) fail("CPS_PUBLIC_SESSION_ENV_UNVERIFIED");
  }
  let clientId: string | undefined;
  for (const [i, key] of ["AUTH_CLIENT_ID", "SHORT_LIVED_CLIENT_ID", "PRODUCTION"].entries()) {
    const assignment = assignments[i + 1 + (optionalSecret && i > 0 ? 1 : 0)];
    if (assignment?.type !== "AssignmentExpression" || assignment.operator !== "=" || !member(assignment.left, ["window", "__env", key]) ||
        !node(assignment.right) || assignment.right.type !== "Literal" || typeof assignment.right.value !== "string") fail("CPS_PUBLIC_SESSION_ENV_UNVERIFIED");
    if (key === "SHORT_LIVED_CLIENT_ID") clientId = assignment.right.value;
  }
  if (typeof clientId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(clientId)) fail("CPS_PUBLIC_SESSION_ENV_UNVERIFIED");
  return clientId;
}
type Dependencies = {
  deadlineAt: Date; signal?: AbortSignal; bootstrapHeaders: Headers;
  /** Fixed-reader injection seam only; never a model/recipe field. */
  fetch?: typeof fetch;
  /** Called twice: exact env GET, then anonymous token POST; same total/lease. */
  runBootstrap: <T>(work: () => Promise<T>) => Promise<T>;
  /** The existing invocation charges the same aggregate response-byte budget. */
  accountBootstrapBytes: (bytes: number) => void;
};

/** Only this exact controller-owned public session may send its ephemeral bearer.
 * No account, cookie, storage, credential, generic header or generic POST lane. */
export function createCps26PublicSession(source: CpsSource, configuration: CpsConfiguration, date: string, deps: Dependencies) {
  const context = parseCpsSource(source.bookingUrl), config = parseCpsConfiguration(configuration, source);
  if (!context || config.buildNumber !== CPS_ANONYMOUS_BUILD || !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      !Number.isFinite(Date.parse(date + "T00:00:00Z")) || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date ||
      !Number.isFinite(deps.deadlineAt.getTime()) || deps.deadlineAt.getTime() <= Date.now()) fail("CPS_PUBLIC_SESSION_SCOPE_INVALID");
  const origin = context.origin, api = origin + CPS_API_PATH;
  const deadline = Math.min(deps.deadlineAt.getTime(), Date.now() + 120_000), cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now())), ...(deps.signal ? [deps.signal] : [])]);
  let bearer: string | undefined, tokenExpiresAt = 0, initialized = false, closed = false, reads = 0;
  const check = () => { if (closed || signal.aborted || Date.now() >= deadline) fail("CPS_PUBLIC_SESSION_EXPIRED"); };
  const allowedHeaders = new Set(["accept", "client-id", "x-websiteid", "x-terminalid", "x-timezoneid", "x-timezone-offset",
    "x-siteid", "x-moduleid", "x-productid", "x-componentid", "x-ismobile", "referer", "x-requestid"]);
  const routingHeaders = (value: HeadersInit | undefined) => {
    let h: Headers; try { h = new Headers(value); } catch { fail("CPS_PUBLIC_SESSION_HEADERS_INVALID"); }
    if ([...h].some(([name, v]) => !allowedHeaders.has(name) || v.length > 2048 || /[\u0000-\u001f\u007f]/u.test(v)) ||
        h.get("client-id") !== config.clientId || h.get("referer") !== origin + "/" || h.get("x-timezoneid") !== source.timeZone ||
        !uuid(h.get("x-requestid") ?? "") || !/^\d{1,10}$/u.test(h.get("x-terminalid") ?? "") || !h.get("x-websiteid") ||
        !/^-?\d{1,4}$/u.test(h.get("x-timezone-offset") ?? "") || h.get("x-siteid") !== "1" || h.get("x-moduleid") !== "7" ||
        h.get("x-productid") !== "1" || h.get("x-componentid") !== "1" || h.get("x-ismobile") !== "false" ||
        !h.get("accept")?.includes("application/json")) fail("CPS_PUBLIC_SESSION_HEADERS_INVALID");
    return h;
  };
  // Validate the fixed caller's routing context before any network operation.
  const initialHeaders = routingHeaders(deps.bootstrapHeaders);
  if (initialHeaders.get("x-websiteid") !== config.websiteId) fail("CPS_PUBLIC_SESSION_HEADERS_INVALID");
  const targetAllowed = (url: string, method: string, body: unknown) => {
    if (url.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(url)) return false;
    if (url === api + "/GetAllOptions/" + context.tenant + "?" + new URLSearchParams({ version: config.buildNumber, product: "3" }))
      return method === "GET" && body === undefined;
    if (url === api + "/OnlineCourses") return method === "GET" && body === undefined;
    // This existing published public browsing nonce registers no slot/customer.
    if (url === api + "/RegisterTransactionId" && method === "POST" && typeof body === "string") {
      try { const v = JSON.parse(body); return v && typeof v === "object" && Object.keys(v).length === 1 && uuid(v.transactionId) && body === JSON.stringify({ transactionId: v.transactionId }); }
      catch { return false; }
    }
    if (method !== "GET" || body !== undefined || !url.startsWith(api + "/TeeTimes?")) return false;
    const u = new URL(url), ids = u.searchParams.get("courseIds") ?? "", transactionId = u.searchParams.get("transactionId") ?? "";
    const courseIds = ids.split(",").map(Number);
    if (!/^[1-9]\d*(?:,[1-9]\d*){0,39}$/u.test(ids) || courseIds.some(id => !Number.isSafeInteger(id) || id > 2_147_483_647) ||
        new Set(courseIds).size !== courseIds.length || !uuid(transactionId)) return false;
    const d = new Date(date + "T00:00:00Z"), days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const expected = new URLSearchParams({ searchDate: `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")} ${d.getUTCFullYear()}`,
      holes: "0", numberOfPlayer: "0", courseIds: ids, searchTimeType: "0", transactionId, teeOffTimeMin: "0", teeOffTimeMax: "23",
      isChangeTeeOffTime: "true", teeSheetSearchView: "5", classCode: "R", defaultOnlineRate: "N", isUseCapacityPricing: "false", memberStoreId: "1", searchType: "1" });
    return url === api + "/TeeTimes?" + expected;
  };
  const wait = <T>(work: Promise<T>, requestSignal: AbortSignal) => new Promise<T>((resolve, reject) => {
    const abort = () => reject(new PublicSessionFailure("CPS_PUBLIC_SESSION_REQUEST_DEADLINE"));
    if (requestSignal.aborted) { abort(); return; }
    requestSignal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => requestSignal.removeEventListener("abort", abort));
  });
  const boundedResponse = async (response: Response, url: string, limit: number, kind: "JSON" | "SCRIPT", requestSignal: AbortSignal) => {
    const contentType = response.headers.get("content-type") ?? "";
    if (response.redirected || response.url && response.url !== url || response.status !== 200 ||
        !(kind === "JSON" ? /^application\/json(?:;|$)/iu : /^(?:text|application)\/(?:javascript|x-javascript)(?:;|$)/iu).test(contentType)) {
      await response.body?.cancel().catch(() => {}); fail("CPS_PUBLIC_SESSION_RESPONSE_INVALID");
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (!Number.isFinite(declared) || declared < 0 || declared > limit) { await response.body?.cancel().catch(() => {}); fail("CPS_PUBLIC_SESSION_RESPONSE_LIMIT"); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      if (reader) for (;;) { check(); const { done, value } = await wait(reader.read(), requestSignal); if (done) break; bytes += value.byteLength;
        if (bytes > limit) fail("CPS_PUBLIC_SESSION_RESPONSE_LIMIT"); chunks.push(value); }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    const result = Buffer.concat(chunks); check();
    return { bytes, response: new Response(result, { status: 200, headers: { "content-type": kind === "JSON" ? "application/json" : "text/javascript" } }) };
  };
  const transport = async (url: string, init: RequestInit, limit: number, kind: "JSON" | "SCRIPT" = "JSON") => {
    check();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now())))]);
    try {
      const request = { ...init, signal: requestSignal };
      const response = await wait(deps.fetch ? deps.fetch(url, request) : pinnedJsonRequest(new URL(url), request, limit, requestSignal), requestSignal);
      return await boundedResponse(response, url, limit, kind, requestSignal);
    } catch (error) {
      // Never let Node errors, provider body text, request headers or tokens escape.
      if (error instanceof PublicSessionFailure) throw error;
      fail("CPS_PUBLIC_SESSION_TRANSPORT_FAILED");
    }
  };
  return {
    async initialize() {
      check(); if (initialized) fail("CPS_PUBLIC_SESSION_ALREADY_INITIALIZED"); initialized = true;
      const clientId = await deps.runBootstrap(async () => {
        const value = await transport(origin + "/onlineresweb/assets/env.js", { method: "GET", headers: { accept: "text/javascript, application/javascript", referer: origin + "/onlineresweb/" },
          credentials: "omit", redirect: "manual", cache: "no-store", signal }, 1_048_576, "SCRIPT");
        deps.accountBootstrapBytes(value.bytes); return parseCps26PublicEnvironment(await value.response.text());
      });
      await deps.runBootstrap(async () => {
        check(); const url = config.authorityBaseUrl + "/myconnect/token/short", form = new FormData(); form.append("client_id", clientId);
        const formRequest = new Request(url, { method: "POST", body: form }), body = await formRequest.text(), headers = new Headers(initialHeaders);
        headers.set("content-type", formRequest.headers.get("content-type")!);
        const value = await transport(url, { method: "POST", headers, body, credentials: "omit", redirect: "manual", cache: "no-store", signal }, BOOTSTRAP_LIMIT);
        deps.accountBootstrapBytes(value.bytes);
        let payload: Record<string, unknown>;
        try { payload = await value.response.json() as Record<string, unknown>; } catch { fail("CPS_PUBLIC_SESSION_TOKEN_INVALID"); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.access_token !== "string" ||
            !/^[A-Za-z0-9._~+\/-]{16,8192}={0,2}$/u.test(payload.access_token) ||
            payload.token_type !== undefined && payload.token_type !== "Bearer" ||
            ["refresh_token", "id_token", "username", "password", "user", "customer"].some(k => Object.hasOwn(payload, k)) ||
            payload.expires_in !== undefined && (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0 || payload.expires_in > 86400))
          fail("CPS_PUBLIC_SESSION_TOKEN_INVALID");
        tokenExpiresAt = Math.min(deadline, Date.now() + (typeof payload.expires_in === "number" ? payload.expires_in * 1000 : deadline - Date.now()));
        bearer = payload.access_token; check();
      });
    },
    fetchPublic: (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      check(); if (!bearer || Date.now() >= tokenExpiresAt || ++reads > 4) fail("CPS_PUBLIC_SESSION_UNAVAILABLE");
      if (!(typeof input === "string" || input instanceof URL)) fail("CPS_PUBLIC_SESSION_SCOPE_INVALID");
      const url = String(input), method = init.method ?? "GET";
      let h: Headers; try { h = new Headers(init.headers); } catch { fail("CPS_PUBLIC_SESSION_HEADERS_INVALID"); }
      const contentType = h.get("content-type");
      if (contentType !== null) h.delete("content-type");
      if (!targetAllowed(url, method, init.body) || init.credentials !== undefined && init.credentials !== "omit" ||
          init.redirect !== undefined && init.redirect !== "manual" || method === "POST" && contentType !== "application/json" ||
          method === "GET" && contentType !== null) fail("CPS_PUBLIC_SESSION_SCOPE_INVALID");
      const headers = routingHeaders(h); if (method === "POST") headers.set("content-type", "application/json");
      headers.set("authorization", "Bearer " + bearer);
      return (await transport(url, { method, headers, ...(typeof init.body === "string" ? { body: init.body } : {}),
        credentials: "omit", redirect: "manual", cache: "no-store", signal }, PUBLIC_LIMIT)).response;
    }) as typeof fetch,
    close() { bearer = undefined; tokenExpiresAt = 0; closed = true; cancellation.abort(); },
  };
}

/** Reuses the app's strict public-DNS resolver; credentials never enter its
 * generic transport. TLS/SNI stays on the exact checked host, redirects stop. */
async function pinnedJsonRequest(url: URL, init: RequestInit, limit: number, signal: AbortSignal): Promise<Response> {
  const pinned = await resolvePinnedPublicAddress(url.hostname, { signal });
  const lookup = ((_hostname: string, options: { all?: boolean } | number, callback: (...args: unknown[]) => void) => {
    if (typeof options === "object" && options.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
  }) as LookupFunction;
  return new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init.headers); headers.set("accept-encoding", "identity");
    const request = httpsRequest(url, { method: init.method, headers: Object.fromEntries(headers), lookup, family: pinned.family,
      servername: url.hostname, agent: false, signal }, incoming => {
      const chunks: Buffer[] = []; let bytes = 0;
      const rejectClosed = () => reject(new Error("CPS_PUBLIC_SESSION_TRANSPORT_FAILED"));
      incoming.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) incoming.destroy(new Error("CPS_PUBLIC_SESSION_RESPONSE_LIMIT")); else chunks.push(chunk); });
      incoming.on("error", rejectClosed);
      incoming.on("end", () => {
        try { resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 502,
          headers: { "content-type": String(incoming.headers["content-type"] ?? ""), "content-length": String(bytes) } })); } catch { rejectClosed(); }
      });
    });
    request.on("error", () => reject(new Error("CPS_PUBLIC_SESSION_TRANSPORT_FAILED")));
    request.once("upgrade", (_response, socket) => { socket.destroy(); reject(new Error("CPS_PUBLIC_SESSION_TRANSPORT_FAILED")); });
    request.end(typeof init.body === "string" ? init.body : undefined);
  });
}
