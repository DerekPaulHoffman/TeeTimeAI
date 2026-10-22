import { describe, expect, it, vi } from "vitest";
import { createPublicClientReadHeaderScope, type PublicClientDocumentFacts, type PublicClientRequestFacts,
  type PublicClientScriptFacts } from "./public-client-read-headers";

const publicLiteral = "public-display-literal";
const source = (literal = publicLiteral) => `function intercept(request) {
  return request.clone({setHeaders: merge(merge({"x-api-key":${JSON.stringify(literal)}}, flag?{}:{}), other?{}:{})});
}`;
function fixture(body = source()) {
  const document = {}, loader = {}, script = {}, request = {}, options = {};
  const documentFacts: PublicClientDocumentFacts = { url: "https://booking.example.com/calendar", loader, live: true, rootFrame: true };
  const scriptFacts: PublicClientScriptFacts = { document, loader, url: "https://booking.example.com/main.js", method: "GET",
    resourceType: "script", rootFrame: true, live: true, hasBody: false, status: 200, mimeType: "text/javascript",
    admitted: true, complete: true, redirected: false, body };
  const requestFacts: PublicClientRequestFacts = { document, loader, url: "https://api.example.com/public/calendar", method: "GET",
    resourceType: "fetch", rootFrame: true, live: true, hasBody: false,
    headers: [["Accept", "application/json"], ["Authorization", "Bearer null"], ["x-api-key", publicLiteral]] };
  const optionsFacts: PublicClientRequestFacts = { ...requestFacts, method: "OPTIONS", sourceRequest: request,
    headers: [["Origin", "https://booking.example.com"], ["Access-Control-Request-Method", "GET"],
      ["Access-Control-Request-Headers", "authorization,x-api-key"]] };
  const documents = new WeakMap<object, unknown>([[document, documentFacts]]);
  const scripts = new WeakMap<object, unknown>([[script, scriptFacts]]);
  const requests = new WeakMap<object, unknown>([[request, requestFacts], [options, optionsFacts]]);
  const scope = createPublicClientReadHeaderScope(document, {
    document: value => documents.get(value), script: value => scripts.get(value), request: value => requests.get(value),
  });
  return { document, loader, script, request, options, documentFacts, scriptFacts, requestFacts, optionsFacts,
    documents, scripts, requests, scope, capture: () => scope.captureScript(script) };
}
function replaceHeader(f: ReturnType<typeof fixture>, key: string, value?: string) {
  f.requestFacts.headers = f.requestFacts.headers.filter(([name]) => name.toLowerCase() !== key.toLowerCase());
  if (value !== undefined) f.requestFacts.headers = [...f.requestFacts.headers, [key, value]];
}

describe("public client read header value publicity", () => {
  it("keeps only opaque RAM proofs and supports attested GET/HEAD, without claiming API-base or merge causality", () => {
    const f = fixture();
    // No API-base literal is present in the script. The private request attestor
    // supplies route scope; unknown merge semantics are deliberately not proved.
    const captured = f.capture();
    const read = f.scope.proveRead(f.request);
    expect(captured).not.toBeNull(); expect(read).not.toBeNull();
    expect(f.scope.isCurrent(read!)).toBe(true);
    expect(Reflect.ownKeys(captured!)).toEqual([]);
    expect(JSON.stringify([captured, read])).toBe("[{},{}]");
    f.requestFacts.method = "HEAD";
    const head = f.scope.proveRead(f.request);
    expect(head).not.toBeNull(); expect(f.scope.isCurrent(head!)).toBe(true);
    expect(f.scope.isCurrent(read!)).toBe(false);
  });

  it("allows missing Authorization but rejects every non-placeholder authorization", () => {
    const f = fixture(); f.capture(); replaceHeader(f, "authorization");
    expect(f.scope.proveRead(f.request)).not.toBeNull();
    for (const value of ["", "Bearer undefined", "Bearer a-real-value", "bearer null", "Bearer null ", "Basic null"]) {
      replaceHeader(f, "authorization", value); expect(f.scope.proveRead(f.request)).toBeNull();
    }
  });

  it.each([
    'const unrelated = {"x-api-key":"public-display-literal"};',
    'request.clone({setHeaders:{"x-api-key":getValue()}});',
    'request.clone({setHeaders:{"x-api-key":`public-${value}-literal`}});',
    'request.clone({setHeaders:{"x-api-key":tag`public-display-literal`}});',
    'request.clone({setHeaders:{"x-api-key":`bad\\unicode`}});',
    'request.clone({setHeaders:{["x-api-key"]:"public-display-literal"}});',
    'request.clone({["setHeaders"]:{"x-api-key":"public-display-literal"}});',
    'request["clone"]({setHeaders:{"x-api-key":"public-display-literal"}});',
    'request.clone({setHeaders:{nested:{"x-api-key":"public-display-literal"}}});',
    'request.clone({setHeaders:()=>({"x-api-key":"public-display-literal"})});',
    '{"x-api-key":"public-display-literal"}',
    'invalid javascript {',
  ])("does not attest dynamic, computed, unrelated, JSON, or nonliteral source: %s", body => {
    const f = fixture(body); expect(f.capture()).toBeNull(); expect(f.scope.proveRead(f.request)).toBeNull();
  });

  it("accepts one static cooked template inside the actual nested clone/setHeaders shape, without evaluating helpers", () => {
    const f = fixture('request.clone({setHeaders:merge(merge({"x-api-key":`public-display-literal`}, flag?{}:{}), other?{}:{})});');
    expect(f.capture()).not.toBeNull(); const proof = f.scope.proveRead(f.request);
    expect(proof).not.toBeNull(); expect(f.scope.isCurrent(proof!)).toBe(true);
    expect(JSON.stringify(proof)).toBe("{}");
  });

  it.each([
    { status: 302 }, { status: 304 }, { admitted: false }, { complete: false }, { live: false }, { redirected: true },
    { hasBody: true }, { method: "POST" }, { resourceType: "fetch" }, { rootFrame: false },
    { document: {} }, { loader: {} }, { url: "https://other.example.com/main.js" },
    { url: "https://booking.example.com/account/main.js" }, { mimeType: "application/json" },
    { body: "x".repeat(2 * 1024 * 1024 + 1) },
  ])("requires the actual complete admitted current-root same-origin JavaScript source: %j", patch => {
    const f = fixture(); Object.assign(f.scriptFacts, patch);
    expect(f.capture()).toBeNull(); expect(f.scope.proveRead(f.request)).toBeNull();
  });

  it("bounds distinct literal hashes and clears earlier authority rather than sampling", () => {
    const f = fixture(Array.from({ length: 8 }, (_, i) => `{${source(`public-literal-${i}`)}}`).join("\n"));
    replaceHeader(f, "x-api-key", "public-literal-0");
    expect(f.capture()).not.toBeNull();
    const read = f.scope.proveRead(f.request); expect(read).not.toBeNull();
    const extra = {}; f.scripts.set(extra, { ...f.scriptFacts, body: source("ninth-public-literal") });
    expect(f.scope.captureScript(extra)).toBeNull();
    expect(f.scope.isCurrent(read!)).toBe(false); expect(f.scope.proveRead(f.request)).toBeNull();
  });

  it("keeps a good witness when a different safely admitted chunk has no candidate", () => {
    const f = fixture(); const captured = f.capture()!; const read = f.scope.proveRead(f.request)!;
    const benign = {}; f.scripts.set(benign, { ...f.scriptFacts, url: "https://booking.example.com/chunk.js", body: "const publicLabel = 'calendar';" });
    expect(f.scope.captureScript(benign)).toBeNull();
    expect(f.scope.isCurrent(captured)).toBe(true); expect(f.scope.isCurrent(read)).toBe(true);
    // The same token's lost/changed witnessed source still retires all proofs.
    f.scriptFacts.body = "const publicLabel = 'calendar';";
    expect(f.capture()).toBeNull(); expect(f.scope.isCurrent(read)).toBe(false);
    f.scriptFacts.body = source(); expect(f.capture()).toBeNull();
  });

  it("requires private token lookup and never invokes data-boundary accessors", () => {
    const f = fixture(); f.capture();
    expect(f.scope.proveRead(f.requestFacts)).toBeNull();
    expect(f.scope.isCurrent({} as NonNullable<ReturnType<typeof f.scope.proveRead>>)).toBe(false);
    const getter = vi.fn(() => f.requestFacts.url);
    f.requests.set(f.request, { ...f.requestFacts, get url() { return getter(); } });
    expect(f.scope.proveRead(f.request)).toBeNull(); expect(getter).not.toHaveBeenCalled();
    const scriptGetter = vi.fn(() => source());
    f.scripts.set(f.script, { ...f.scriptFacts, get body() { return scriptGetter(); } });
    expect(f.capture()).toBeNull(); expect(scriptGetter).not.toHaveBeenCalled();
  });

  it.each([
    { method: "POST" }, { method: "OPTIONS" }, { method: "get" }, { hasBody: true }, { live: false },
    { rootFrame: false }, { resourceType: "document" }, { document: {} }, { loader: {} },
    { url: "http://api.example.com/public/calendar" }, { url: "https://127.0.0.1/calendar" },
    { url: "https://api.example.com/account/calendar" }, { url: "https://user:pass@api.example.com/calendar" },
    { url: "https://api.example.com/calendar?token=not-public" },
  ])("keeps current request, body, method, and ordinary URL guards: %j", patch => {
    const f = fixture(); f.capture(); Object.assign(f.requestFacts, patch);
    expect(f.scope.proveRead(f.request)).toBeNull();
  });

  it.each(["Proxy-Authorization", "x-session-id", "x-device-id", "x-correlation-id", "x-waf-token", "x-other-key"]) (
    "rejects sensitive or unattested companions: %s", name => {
      const f = fixture(); f.capture(); f.requestFacts.headers = [...f.requestFacts.headers, [name, "do-not-expose"]];
      expect(f.scope.proveRead(f.request)).toBeNull();
    });

  it("accepts only the four reviewed anonymous correlation names with actual canonical UUIDv4 values", () => {
    const f = fixture(); f.capture();
    const names = ["x-ms-device-id", "x-ms-client-session-id", "x-ms-request-id", "x-ms-attempt-id"];
    const value = "11111111-2222-4333-8444-555555555555";
    f.requestFacts.headers = [...f.requestFacts.headers, ...names.map(name => [name, value] as [string, string])];
    const proof = f.scope.proveRead(f.request); expect(proof).not.toBeNull(); expect(f.scope.isCurrent(proof!)).toBe(true);
    f.optionsFacts.headers = f.optionsFacts.headers.map(([name, original]) => [name,
      name === "Access-Control-Request-Headers" ? "authorization,x-api-key," + names.join(",") : original]);
    expect(f.scope.provePreflight(f.options, f.request)).not.toBeNull();
    replaceHeader(f, "x-ms-request-id", "11111111-2222-4333-8444-666666666666");
    expect(f.scope.isCurrent(proof!)).toBe(false);
    expect(JSON.stringify(proof)).not.toContain(value);
  });

  it.each(["", "opaque-storage-value", "11111111-2222-3333-8444-555555555555", "11111111-2222-4333-7444-555555555555",
    "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "11111111-2222-4333-8444-555555555555 ", "00000000-0000-0000-0000-000000000000"])(
    "rejects noncanonical, non-v4 or fallback correlation values %s", value => {
      for (const name of ["x-ms-device-id", "x-ms-client-session-id", "x-ms-request-id", "x-ms-attempt-id"]) {
        const f = fixture(); f.capture(); f.requestFacts.headers = [...f.requestFacts.headers, [name, value]];
        expect(f.scope.proveRead(f.request)).toBeNull();
        f.optionsFacts.headers = f.optionsFacts.headers.map(([key, original]) => [key,
          key === "Access-Control-Request-Headers" ? `authorization,x-api-key,${name}` : original]);
        expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
      }
    });

  it.each(["x-ms-session-id", "x-ms-auth-token", "x-ms-waf-token", "x-ms-user-id"])("does not infer any related companion name %s", name => {
    const f = fixture(); f.capture(); f.requestFacts.headers = [...f.requestFacts.headers, [name, "11111111-2222-4333-8444-555555555555"]];
    expect(f.scope.proveRead(f.request)).toBeNull();
  });

  it("rejects missing/wrong keys and duplicate case-folded headers without exposing values", () => {
    for (const value of [undefined, "", "different-public-literal"]) {
      const f = fixture(); f.capture(); replaceHeader(f, "x-api-key", value); expect(f.scope.proveRead(f.request)).toBeNull();
    }
    for (const name of ["X-API-Key", "AUTHORIZATION", "accept"]) {
      const f = fixture(); f.capture();
      f.requestFacts.headers = [...f.requestFacts.headers, [name, name === "X-API-Key" ? publicLiteral : "Bearer null"]];
      expect(f.scope.proveRead(f.request)).toBeNull();
    }
  });

  it("does not grant or return cookie authority; the caller cookie guard remains required", () => {
    const f = fixture(); f.capture();
    f.requestFacts.headers = [...f.requestFacts.headers, ["Cookie", "caller-policy-still-required"]];
    const proof = f.scope.proveRead(f.request);
    expect(proof).not.toBeNull(); expect(JSON.stringify(proof)).toBe("{}");
  });

  it("proves only exact correlated preflights, independently rechecking the actual GET or HEAD headers", () => {
    const f = fixture(); f.capture();
    const options = f.scope.provePreflight(f.options, f.request);
    expect(options).not.toBeNull(); expect(f.scope.isCurrent(options!)).toBe(true);
    f.requestFacts.method = "HEAD";
    expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
    f.optionsFacts.headers = f.optionsFacts.headers.map(([name, value]) =>
      [name, name === "Access-Control-Request-Method" ? "HEAD" : value]);
    const headOptions = f.scope.provePreflight(f.options, f.request);
    expect(headOptions).not.toBeNull(); expect(f.scope.isCurrent(headOptions!)).toBe(true);
    replaceHeader(f, "Authorization", "Bearer real-value");
    expect(f.scope.isCurrent(headOptions!)).toBe(false);
    expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
  });

  it.each([
    { sourceRequest: {} }, { url: "https://api.example.com/public/other" }, { hasBody: true }, { live: false },
    { method: "POST" }, { document: {} }, { loader: {} }, { rootFrame: false },
    { headers: [["Origin", "https://foreign.example.com"], ["Access-Control-Request-Method", "GET"], ["Access-Control-Request-Headers", "authorization,x-api-key"]] },
  ])("denies uncorrelated, stale, body-bearing, and foreign preflights: %j", patch => {
    const f = fixture(); f.capture(); Object.assign(f.optionsFacts, patch);
    expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
  });

  it.each(["authorization,x-api-key,x-session-id", "authorization,x-api-key,proxy-authorization", "authorization",
    "authorization,x-api-key,X-API-Key", "authorization,x-api-key,", "authorization,x-api-key,content-type"]) (
    "denies extra, duplicate, missing, or unattested requested headers: %s", names => {
      const f = fixture(); f.capture();
      f.optionsFacts.headers = f.optionsFacts.headers.map(([name, value]) =>
        [name, name === "Access-Control-Request-Headers" ? names : value]);
      expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
    });

  it("has no preflight fallback if actual source token or placeholder evidence is missing", () => {
    const f = fixture(); f.capture();
    expect(f.scope.provePreflight(f.options, {})).toBeNull();
    replaceHeader(f, "authorization");
    expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
    f.optionsFacts.headers = [...f.optionsFacts.headers, ["Authorization", "Bearer null"]];
    expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
  });

  it("retains value publicity across a safe SPA URL change in the same live root loader", () => {
    const f = fixture(); f.capture(); const proof = f.scope.proveRead(f.request)!;
    f.documentFacts.url = "https://booking.example.com/calendar?date=2026-10-24";
    expect(f.scope.isCurrent(proof)).toBe(true);
  });

  it.each(["clear", "close", "source-failure", "source-replaced", "source-url-replaced", "document-retired", "loader-replaced", "foreign-document", "unsafe-route"] as const)(
    "invalidates queued proofs on %s without healing old authority", action => {
      const f = fixture(); const capture = f.capture()!; const read = f.scope.proveRead(f.request)!;
      const preflight = f.scope.provePreflight(f.options, f.request)!;
      if (action === "clear") f.scope.invalidate();
      if (action === "close") f.scope.close();
      if (action === "source-failure") f.scriptFacts.live = false;
      if (action === "source-replaced") f.scriptFacts.body = source("replacement-public-literal");
      if (action === "source-url-replaced") f.scriptFacts.url = "https://booking.example.com/replacement.js";
      if (action === "document-retired") f.documentFacts.live = false;
      if (action === "loader-replaced") f.documentFacts.loader = {};
      if (action === "foreign-document") f.documentFacts.url = "https://foreign.example.com/calendar";
      if (action === "unsafe-route") f.documentFacts.url = "https://booking.example.com/login";
      expect(f.scope.isCurrent(read)).toBe(false); expect(f.scope.isCurrent(preflight)).toBe(false);
      expect(f.scope.isCurrent(capture)).toBe(false);
      f.documentFacts.live = true; f.documentFacts.loader = f.loader; f.documentFacts.url = "https://booking.example.com/calendar";
      f.scriptFacts.live = true; f.scriptFacts.body = source();
      expect(f.scope.isCurrent(read)).toBe(false);
    });

  it("changes the opaque version when a newly captured source is added and rechecks cancellation after lease wait", () => {
    const f = fixture(); f.capture(); const old = f.scope.proveRead(f.request)!;
    const extra = {}; f.scripts.set(extra, { ...f.scriptFacts, body: source("second-public-literal") });
    expect(f.scope.captureScript(extra)).not.toBeNull(); expect(f.scope.isCurrent(old)).toBe(false);
    const current = f.scope.proveRead(f.request)!; expect(f.scope.isCurrent(current)).toBe(true);
    f.requestFacts.live = false; expect(f.scope.isCurrent(current)).toBe(false);
    f.requestFacts.live = true; expect(f.scope.isCurrent(current)).toBe(false);
    expect(f.scope.proveRead(f.request)).toBeNull();
  });
});
