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

function teeSheetFixture() {
  const f = fixture();
  f.documentFacts.url = "https://app.membersports.com/tee-times/21/34/0";
  f.scriptFacts.url = "https://app.membersports.com/main.js";
  const body = { configurationTypeId: 0, date: "2026-10-23", golfClubGroupId: 0,
    golfClubId: 21, golfCourseId: 34, groupSheetTypeId: 0 };
  Object.assign(f.requestFacts, { url: "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes",
    method: "POST", hasBody: true, body: JSON.stringify(body) });
  replaceHeader(f, "content-type", "application/json");
  replaceHeader(f, "origin", "https://app.membersports.com");
  Object.assign(f.optionsFacts, { url: f.requestFacts.url, headers: [["Origin", "https://app.membersports.com"],
    ["Access-Control-Request-Method", "POST"], ["Access-Control-Request-Headers", "authorization,content-type,x-api-key"]] });
  return { ...f, body };
}

describe("source-bound public tee-sheet POST header proofs", () => {
  it("uses only linked OPTIONS Origin for validation of an early source with Origin absent", () => {
    const f = teeSheetFixture(); replaceHeader(f, "origin"); f.capture();
    const before = JSON.stringify(f.requestFacts.headers);
    expect(f.scope.proveRead(f.request)).toBeNull();
    const proof = f.scope.provePreflight(f.options, f.request);
    expect(proof).not.toBeNull(); expect(f.scope.isCurrent(proof!)).toBe(true);
    expect(f.scope.proveRead(f.request)).toBeNull();
    expect(JSON.stringify(f.requestFacts.headers)).toBe(before);
    f.optionsFacts.headers = f.optionsFacts.headers.map(([key, value]) => [key, key === "Origin" ? "https://other.example.org" : value]);
    expect(f.scope.isCurrent(proof!)).toBe(false);
  });
  it.each(["", "https://other.example.org", "https://app.membersports.com/", " https://app.membersports.com", "https://app.membersports.com "])("never replaces a present source Origin: %j", origin => {
    const f = teeSheetFixture(); replaceHeader(f, "origin", origin); f.capture();
    expect(f.scope.proveRead(f.request)).toBeNull(); expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
  });
  it.each(["missing", "wrong", "duplicate", "unlinked"] as const)("requires a valid linked OPTIONS before inferring an absent source Origin: %s", fault => {
    const f = teeSheetFixture(); replaceHeader(f, "origin"); f.capture();
    if (fault === "missing") f.optionsFacts.headers = f.optionsFacts.headers.filter(([key]) => key !== "Origin");
    if (fault === "wrong") f.optionsFacts.headers = f.optionsFacts.headers.map(([key, value]) => [key, key === "Origin" ? "https://other.example.org" : value]);
    if (fault === "duplicate") f.optionsFacts.headers = [...f.optionsFacts.headers, ["origin", "https://app.membersports.com"]];
    if (fault === "unlinked") f.optionsFacts.sourceRequest = {};
    expect(f.scope.provePreflight(f.options, f.request)).toBeNull(); expect(f.scope.proveRead(f.request)).toBeNull();
  });
  it("requires both the current published key and the reviewed anonymous body for read and preflight", () => {
    const f = teeSheetFixture();
    expect(f.scope.proveRead(f.request)).toBeNull();
    f.capture();
    const read = f.scope.proveRead(f.request), options = f.scope.provePreflight(f.options, f.request);
    expect(read).not.toBeNull(); expect(options).not.toBeNull();
    expect(f.scope.isCurrent(read!)).toBe(true); expect(f.scope.isCurrent(options!)).toBe(true);
    expect(JSON.stringify([read, options])).toBe("[{},{}]");
    replaceHeader(f, "x-api-key", "unpublished-value");
    expect(f.scope.proveRead(f.request)).toBeNull(); expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
  });

  it.each(["body", "document", "profile", "endpoint", "missing-body", "real-token"] as const)(
    "permanently revokes queued read and preflight when the exact public request changes: %s", change => {
      const f = teeSheetFixture(); f.capture();
      const read = f.scope.proveRead(f.request)!, options = f.scope.provePreflight(f.options, f.request)!;
      expect(read).not.toBeNull(); expect(options).not.toBeNull();
      const original = { ...f.requestFacts }, originalDocument = f.documentFacts.url;
      if (change === "body") f.requestFacts.body = JSON.stringify({ ...f.body, date: "2026-10-24" });
      if (change === "document") f.documentFacts.url = "https://app.membersports.com/tee-times/21/35/0";
      if (change === "profile") f.requestFacts.body = JSON.stringify({ ...f.body, memberProfileId: 1 });
      if (change === "endpoint") f.requestFacts.url = "https://api.membersports.com/api/v1/golfclubs/createBooking";
      if (change === "missing-body") f.requestFacts.body = null;
      if (change === "real-token") replaceHeader(f, "authorization", "Bearer account-value");
      expect(f.scope.isCurrent(read)).toBe(false); expect(f.scope.isCurrent(options)).toBe(false);
      Object.assign(f.requestFacts, original); f.documentFacts.url = originalDocument;
      expect(f.scope.isCurrent(read)).toBe(false); expect(f.scope.isCurrent(options)).toBe(false);
    });
});

describe("exact public course events header proofs", () => {
  const events = "https://api.membersports.com/api/v1/Events/eventsByDateForCourses/golfClubId/21/searchDate/2026-10-23?golfCourseIds=34";
  function eventFixture() {
    const f = fixture(); f.documentFacts.url = "https://app.membersports.com/tee-times/21/34/0";
    f.scriptFacts.url = "https://app.membersports.com/main.js"; f.requestFacts.url = events;
    f.optionsFacts.url = events; f.optionsFacts.headers = f.optionsFacts.headers.map(([key, value]) =>
      [key, key === "Origin" ? "https://app.membersports.com" : value]);
    f.capture(); return f;
  }
  it("requires the published value and exact linked GET, retaining current signature checks", () => {
    const f = eventFixture(), before = JSON.stringify([f.requestFacts, f.optionsFacts]);
    const read = f.scope.proveRead(f.request), options = f.scope.provePreflight(f.options, f.request);
    expect(read).not.toBeNull(); expect(options).not.toBeNull();
    expect(f.scope.isCurrent(read!)).toBe(true); expect(f.scope.isCurrent(options!)).toBe(true);
    expect(JSON.stringify([f.requestFacts, f.optionsFacts])).toBe(before);
    f.requestFacts.url = events.replace("golfCourseIds=34", "golfCourseIds=35");
    expect(f.scope.isCurrent(read!)).toBe(false); expect(f.scope.isCurrent(options!)).toBe(false);
  });
  it.each(["body", "auth", "key", "source", "loader", "query", "link", "method", "bootstrap"] as const)(
    "does not expand existing proof authority: %s", fault => {
      const f = eventFixture();
      if (fault === "body") f.requestFacts.hasBody = true;
      if (fault === "auth") replaceHeader(f, "authorization", "Bearer real-account-token");
      if (fault === "key") replaceHeader(f, "x-api-key", "not-published");
      if (fault === "source") f.scriptFacts.live = false;
      if (fault === "loader") f.requestFacts.loader = {};
      if (fault === "query") f.requestFacts.url += "&golfCourseIds=34";
      if (fault === "link") f.optionsFacts.sourceRequest = {};
      if (fault === "method") f.requestFacts.method = "HEAD";
      if (fault === "bootstrap") f.requestFacts.url = "https://api.membersports.com/App/AuthenticationSettings";
      if (fault !== "link") expect(f.scope.proveRead(f.request)).toBeNull();
      expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
    });
});

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

  it.each(["", "{}"])("rejects contradictory body bytes on an attested body-free GET: %j", body => {
    const f = fixture(); f.capture();
    f.requestFacts.body = body;
    expect(f.scope.proveRead(f.request)).toBeNull();
    expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
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

  it.each(["clear", "close", "source-failure", "source-removed", "source-replaced", "source-url-replaced", "additional-source-failure", "document-retired", "loader-replaced", "foreign-document", "unsafe-route"] as const)(
    "invalidates queued proofs on %s without healing old authority", action => {
      const f = fixture(); const capture = f.capture()!; const read = f.scope.proveRead(f.request)!;
      const preflight = f.scope.provePreflight(f.options, f.request)!;
      const additional = {}, additionalFacts = { ...f.scriptFacts, url: "https://booking.example.com/chunk.js", body: source("additional-public-literal") };
      f.scripts.set(additional, additionalFacts); expect(f.scope.captureScript(additional)).not.toBeNull();
      if (action === "clear") f.scope.invalidate();
      if (action === "close") f.scope.close();
      if (action === "source-failure") f.scriptFacts.live = false;
      if (action === "source-removed") f.scripts.delete(f.script);
      if (action === "source-replaced") f.scriptFacts.body = source("replacement-public-literal");
      if (action === "source-url-replaced") f.scriptFacts.url = "https://booking.example.com/replacement.js";
      if (action === "additional-source-failure") additionalFacts.live = false;
      if (action === "document-retired") f.documentFacts.live = false;
      if (action === "loader-replaced") f.documentFacts.loader = {};
      if (action === "foreign-document") f.documentFacts.url = "https://foreign.example.com/calendar";
      if (action === "unsafe-route") f.documentFacts.url = "https://booking.example.com/login";
      expect(f.scope.isCurrent(read)).toBe(false); expect(f.scope.isCurrent(preflight)).toBe(false);
      expect(f.scope.isCurrent(capture)).toBe(false);
      f.documentFacts.live = true; f.documentFacts.loader = f.loader; f.documentFacts.url = "https://booking.example.com/calendar";
      f.scriptFacts.live = true; f.scriptFacts.body = source();
      const renewed = {}; f.scripts.set(renewed, { ...f.scriptFacts, url: "https://booking.example.com/renewed.js" });
      f.scope.captureScript(renewed);
      expect(f.scope.isCurrent(read)).toBe(false);
      expect(f.scope.isCurrent(preflight)).toBe(false);
    });

  it.each([publicLiteral, "second-public-literal"])("keeps queued read and preflight proofs current after additive public script capture: %s", async literal => {
    const f = fixture(); const capture = f.capture()!;
    const read = f.scope.proveRead(f.request)!, preflight = f.scope.provePreflight(f.options, f.request)!;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const queued = (async () => { await wait; return [f.scope.isCurrent(read), f.scope.isCurrent(preflight)]; })();
    const extra = {}; f.scripts.set(extra, { ...f.scriptFacts, url: "https://booking.example.com/chunk.js", body: source(literal) });
    const additional = f.scope.captureScript(extra);
    expect(additional).not.toBeNull();
    release(); expect(await queued).toEqual([true, true]);
    // Script captures remain version-specific; read proofs recheck all current
    // witnesses and the unchanged private request rather than borrowing that version.
    expect(f.scope.isCurrent(capture)).toBe(false); expect(f.scope.isCurrent(additional!)).toBe(true);
    expect(JSON.stringify([read, preflight, additional])).toBe("[{},{},{}]");
  });

  it("does not preserve queued authority after an additive script when request cancellation occurs", () => {
    const f = fixture(); f.capture(); const current = f.scope.proveRead(f.request)!;
    const preflight = f.scope.provePreflight(f.options, f.request)!;
    const extra = {}; f.scripts.set(extra, { ...f.scriptFacts, body: source("second-public-literal") });
    expect(f.scope.captureScript(extra)).not.toBeNull();
    f.requestFacts.live = false; expect(f.scope.isCurrent(current)).toBe(false);
    expect(f.scope.isCurrent(preflight)).toBe(false);
    f.requestFacts.live = true; expect(f.scope.isCurrent(current)).toBe(false);
    expect(f.scope.isCurrent(preflight)).toBe(false);
    expect(f.scope.proveRead(f.request)).toBeNull();
  });

  it.each(["url", "public-key", "authorization", "duplicate-header", "root", "loader", "document", "body", "resource-type"] as const)(
    "rechecks unchanged private request facts after additive capture: %s", change => {
      const f = fixture(); f.capture();
      const read = f.scope.proveRead(f.request)!, preflight = f.scope.provePreflight(f.options, f.request)!;
      const extra = {}; f.scripts.set(extra, { ...f.scriptFacts, body: source("second-public-literal") });
      f.scope.captureScript(extra);
      const original = { ...f.requestFacts };
      if (change === "url") f.requestFacts.url = "https://api.example.com/public/other";
      if (change === "public-key") replaceHeader(f, "x-api-key", "second-public-literal");
      if (change === "authorization") replaceHeader(f, "authorization", "Bearer real-value");
      if (change === "duplicate-header") f.requestFacts.headers = [...f.requestFacts.headers, ["X-API-Key", publicLiteral]];
      if (change === "root") f.requestFacts.rootFrame = false;
      if (change === "loader") f.requestFacts.loader = {};
      if (change === "document") f.requestFacts.document = {};
      if (change === "body") f.requestFacts.hasBody = true;
      if (change === "resource-type") f.requestFacts.resourceType = "xhr";
      expect(f.scope.isCurrent(read)).toBe(false); expect(f.scope.isCurrent(preflight)).toBe(false);
      Object.assign(f.requestFacts, original);
      expect(f.scope.isCurrent(read)).toBe(false); expect(f.scope.isCurrent(preflight)).toBe(false);
      expect(f.scope.proveRead(f.request)).toBeNull();
    });

  it.each(["source-correlation", "requested-headers"] as const)("rechecks exact preflight facts after additive capture: %s", change => {
    const f = fixture(); f.capture();
    const read = f.scope.proveRead(f.request)!, preflight = f.scope.provePreflight(f.options, f.request)!;
    const extra = {}; f.scripts.set(extra, { ...f.scriptFacts, body: source("second-public-literal") }); f.scope.captureScript(extra);
    const original = { ...f.optionsFacts };
    if (change === "source-correlation") f.optionsFacts.sourceRequest = {};
    if (change === "requested-headers") f.optionsFacts.headers = [...f.optionsFacts.headers, ["Authorization", "Bearer null"]];
    expect(f.scope.isCurrent(preflight)).toBe(false); expect(f.scope.isCurrent(read)).toBe(true);
    Object.assign(f.optionsFacts, original);
    expect(f.scope.isCurrent(preflight)).toBe(false); expect(f.scope.provePreflight(f.options, f.request)).toBeNull();
  });

  it.each(["epoch", "source", "document", "request", "script-version"] as const)("retains only the observed first current-proof failure: %s", fault => {
    const f = fixture(), captured = f.capture()!;
    const read = f.scope.proveRead(f.request)!, options = f.scope.provePreflight(f.options, f.request)!;
    const checked = fault === "script-version" ? captured : fault === "request" ? options : read;
    expect(f.scope.failureReason(checked)).toBeNull();
    let reason: string;
    if (fault === "epoch") { f.scope.invalidate(); reason = "REVOCATION_EPOCH_CHANGED"; }
    else if (fault === "source") { f.scripts.delete(f.script); reason = "PUBLIC_SOURCE_INVALID"; }
    else if (fault === "document") { f.documentFacts.live = false; reason = "DOCUMENT_NOT_CURRENT"; }
    else if (fault === "request") { f.requestFacts.live = false; reason = "REQUEST_SIGNATURE_CHANGED"; }
    else { const extra = {}; f.scripts.set(extra, { ...f.scriptFacts, body: source("second-public-literal") }); f.scope.captureScript(extra); reason = "SCRIPT_VERSION_CHANGED"; }
    // The accessor alone must not revalidate facts or invent a failure.
    expect(f.scope.failureReason(checked)).toBeNull();
    expect(f.scope.isCurrent(checked)).toBe(false); expect(f.scope.failureReason(checked)).toBe(reason);
    f.scope.close(); expect(f.scope.isCurrent(checked)).toBe(false); expect(f.scope.failureReason(checked)).toBe(reason);
  });
});
