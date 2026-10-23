// @vitest-environment node
import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { installNativeRedirectRouting, nativeMindbodyControllerForm, type NativeReadRoute } from "./native-redirect-routing";
import { createMindbodyPublicDayFormIntent, createMindbodyPublicFormIntent, type MindbodyPublicFormIntent } from "./mindbody-public-form-read";
import categoryObserved from "./fixtures/mindbody-public-category-form-observed.json";
import dayObserved from "./fixtures/mindbody-public-day-form-observed.json";
const source = "https://clients.mindbodyonline.com/ASP/adm/adm_appt_search.asp?reSchedule=", target = source;
const headers = { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://clients.mindbodyonline.com" };
const body = new URLSearchParams([
  ["CSRFToken", "synthetic-private-csrf"], ..."frmApptRefNo alertGen origTrn origDate cType origId fromTabby optPreDateRange".split(" ").map(key => [key, ""]),
  ["frmTabID", "9"], ["scrollTop", "0"], ["optLoc", "1"], ["optTG", "2"], ["optVT", "5"], ["optTrnID", ""],
  ...Array.from({ length: 7 }, (_, i) => ["optDay" + (i + 1), "on"]), ["optDates", "1"], ["optDateRange", "0"],
  ["requiredtxtDateStart", "10/23/2026"], ["requiredtxtDateEnd", "10/23/2026"], ["optTimes", "0"], ["optTimeRange", "0"], ["optStartTime", "5:00:00 AM"], ["optEndTime", "5:00:00 AM"],
]).toString();
async function setup(formBody = body, sourceUrl = source, day = false) {
  const targetUrl = day ? dayObserved.targetUrl : target;
  const events = new Map<string, (event: unknown) => void>(), routes: NativeReadRoute[] = [], failures: string[] = [];
  let sourceCurrent = true;
  const send = vi.fn(async (name: string, value?: { requestId?: string }) => name === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } :
    name === "Fetch.getResponseBody" ? { body: "<html><body>public" + (value?.requestId ?? "") + "</body></html>", base64Encoded: false } : {});
  const cdp = { on: (name: string, fn: (event: unknown) => void) => { events.set(name, fn); }, send, detach: vi.fn(async () => {}) };
  const main = { page: () => page }, page = { context: () => ({ newCDPSession: async () => cdp }), mainFrame: () => main, close: vi.fn(async () => {}) } as unknown as Page;
  const guard = await installNativeRedirectRouting(page, async route => { routes.push(route); }, { timeoutMs: 100,
    controllerFormIntent: (from, to) => form?.sourceUrl === from && form.targetUrl === to ? form : undefined,
    onFailure: code => failures.push(code) });
  const network = (id: string, loaderId: string, request: object) => events.get("Network.requestWillBeSent")!({ requestId: "network-" + id, loaderId, frameId: "main", type: "Document", request });
  const request = (id: string, value: object) => events.get("Fetch.requestPaused")!({ requestId: id, networkId: "network-" + id, frameId: "main", resourceType: "Document", request: value });
  const response = (id: string, value: object) => events.get("Fetch.requestPaused")!({ requestId: id, networkId: "network-" + id, frameId: "main", resourceType: "Document", request: value,
    responseStatusCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
  await guard.beginDocumentNavigation(main as never);
  const initial = { url: sourceUrl, method: "GET", headers: {} }; network("source", "source-loader", initial); request("source", initial);
  await vi.waitFor(() => expect(routes).toHaveLength(1)); await routes[0].continue(); response("source", initial); await routes[0].request().response();
  events.get("Page.frameNavigated")!({ frame: { id: "main", loaderId: "source-loader", url: sourceUrl } });
  const formInput = { sourceUrl, targetUrl, body: formBody, deadlineAt: Date.now() + 5000, sourceCurrent: () => sourceCurrent };
  const form: MindbodyPublicFormIntent = day ? createMindbodyPublicDayFormIntent({ ...formInput, currentDate: dayObserved.currentDate, direction: 1 }) : createMindbodyPublicFormIntent(formInput);
  const post = (change: { networkBody?: string; fetchBody?: string; origin?: string; intent?: boolean } = {}) => {
    if (change.intent !== false) events.get("Page.frameRequestedNavigation")!({ frameId: "main", reason: "formSubmissionPost", disposition: "currentTab", url: targetUrl });
    const requestHeaders = change.origin === undefined ? headers : { ...headers, Origin: change.origin };
    const wire = { url: targetUrl, method: "POST", headers: requestHeaders, hasPostData: true, postData: change.networkBody ?? formBody };
    network("post", "post-loader", wire); request("post", { ...wire, postData: change.fetchBody ?? formBody });
    return wire;
  };
  return { guard, routes, events, form, post, send, failures, response, main, current: (value: boolean) => { sourceCurrent = value; } };
}
describe("native one-use Mindbody public form ownership", () => {
  it.each(["exact", "date offset", "nonempty authentication", "queued revoke"])("binds actual DAY display form to native ownership: %s", async mode => {
    const fields = new URLSearchParams(dayObserved.fields.map(row => [row.name, row.value])); fields.set("txtDate", "10/24/2026"); const dayBody = fields.toString();
    const test = await setup(dayBody, dayObserved.sourceUrl, true);
    try {
      if (mode === "date offset") fields.set("txtDate", "10/25/2026"); if (mode === "nonempty authentication") fields.set("requiredtxtPassword", "private");
      const wire = test.post({ fetchBody: fields.toString() });
      if (mode === "date offset" || mode === "nonempty authentication") { await vi.waitFor(() => expect(test.guard.firstFatal).toBeDefined()); expect(test.routes).toHaveLength(1); }
      else {
        await vi.waitFor(() => expect(test.routes).toHaveLength(2)); const route = test.routes[1];
        expect(nativeMindbodyControllerForm(route.request())).toBe(test.form); expect(test.routes[0].request().signal?.aborted).toBe(true);
        if (mode === "queued revoke") { test.form.revoke(); await expect(route.continue()).rejects.toThrow("NATIVE_REDIRECT_CONTINUE_REJECTED"); }
        else { await route.continue(); test.response("post", wire); await route.request().response(); expect(test.form.consume()).toBe(false); expect(test.failures).toEqual([]); }
      }
    } finally { test.form.revoke(); await test.guard.close(); }
  });
  it("continues the exact actual initial category form only after native source retirement", async () => {
    const categoryBody = new URLSearchParams(categoryObserved.fields.map(row => [row.name, row.value])).toString();
    const test = await setup(categoryBody, categoryObserved.sourceUrl);
    try {
      const wire = test.post(); await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(test.routes[0].request().signal?.aborted).toBe(true); expect(nativeMindbodyControllerForm(test.routes[1].request())).toBe(test.form);
      await test.routes[1].continue(); test.response("post", wire); await test.routes[1].request().response(); expect(test.failures).toEqual([]);
      expect(test.form.consume()).toBe(false);
    } finally { test.form.revoke(); await test.guard.close(); }
  });
  it.each(["stale source", "revoked while queued", "expired while queued", "new navigation while queued"])("rejects category %s before native transmission", async mode => {
    const categoryBody = new URLSearchParams(categoryObserved.fields.map(row => [row.name, row.value])).toString();
    const test = await setup(categoryBody, categoryObserved.sourceUrl); let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (mode === "stale source") { test.current(false); test.post(); await vi.waitFor(() => expect(test.guard.firstFatal).toBeDefined()); expect(test.routes).toHaveLength(1); }
      else {
        test.post(); await vi.waitFor(() => expect(test.routes).toHaveLength(2));
        if (mode === "revoked while queued") test.form.revoke();
        if (mode === "expired while queued") { const later = Date.now() + 6000; clock = vi.spyOn(Date, "now").mockReturnValue(later); }
        if (mode === "new navigation while queued") await test.guard.beginDocumentNavigation(test.main as never);
        expect(nativeMindbodyControllerForm(test.routes[1].request())).toBeNull(); await expect(test.routes[1].continue()).rejects.toThrow();
      }
      expect(test.send.mock.calls.some(([name, args]) => name === "Fetch.continueRequest" && args?.requestId === "post")).toBe(false);
    } finally { clock?.mockRestore(); await test.guard.close(); }
  });
  it("binds exact two-stream body/source loader, retires source and preserves native wire headers", async () => {
    const test = await setup(); try {
      const wire = test.post(); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); const route = test.routes[1];
      expect(nativeMindbodyControllerForm(route.request())).toBe(test.form); expect(nativeMindbodyControllerForm({ ...route.request() })).toBeNull();
      expect(test.routes[0].request().signal?.aborted).toBe(true); expect(test.form.consume()).toBe(false);
      await route.continue(); expect(test.send.mock.calls.find(([name, args]) => name === "Fetch.continueRequest" && (args as { requestId: string })?.requestId === "post"))
        .toEqual(["Fetch.continueRequest", { requestId: "post" }]);
      test.response("post", wire); await route.request().response(); expect(test.failures).toEqual([]);
    } finally { test.form.revoke(); await test.guard.close(); }
  });
  it.each(["network body", "fetch body", "origin", "missing intent", "stale source", "revoked"])("rejects %s before transmission", async mode => {
    const test = await setup(); try {
      if (mode === "stale source") test.current(false); if (mode === "revoked") test.form.revoke();
      test.post({ ...(mode === "network body" ? { networkBody: body.replace("optVT=5", "optVT=6") } : {}),
        ...(mode === "fetch body" ? { fetchBody: body.replace("synthetic-private-csrf", "different-private-csrf") } : {}),
        ...(mode === "origin" ? { origin: "https://foreign.example" } : {}), ...(mode === "missing intent" ? { intent: false } : {}) });
      await vi.waitFor(() => expect(test.guard.firstFatal).toBeDefined()); expect(test.routes).toHaveLength(1);
      expect(test.send.mock.calls.filter(([name, args]) => name === "Fetch.continueRequest" && (args as { requestId: string })?.requestId === "post")).toHaveLength(0);
      expect(JSON.stringify(test.guard.firstFatal)).not.toMatch(/synthetic-private|CSRFToken/u);
    } finally { await test.guard.close(); }
  });
  it("revokes queued authority before continue and refuses a second consumption", async () => {
    const test = await setup(); try {
      test.post(); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); expect(test.form.consume()).toBe(false);
      test.form.revoke(); expect(nativeMindbodyControllerForm(test.routes[1].request())).toBeNull();
      await expect(test.routes[1].continue()).rejects.toThrow("NATIVE_REDIRECT_CONTINUE_REJECTED");
    } finally { await test.guard.close(); }
  });
  it("expires exact queued authority before native continuation", async () => {
    const test = await setup(); let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      test.post(); await vi.waitFor(() => expect(test.routes).toHaveLength(2)); const later = Date.now() + 6000;
      clock = vi.spyOn(Date, "now").mockReturnValue(later);
      expect(nativeMindbodyControllerForm(test.routes[1].request())).toBeNull();
      await expect(test.routes[1].continue()).rejects.toThrow("NATIVE_REDIRECT_CONTINUE_REJECTED");
    } finally { clock?.mockRestore(); await test.guard.close(); }
  });
});
