import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { chromium, type CDPSession } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createCourseDiscoveryBrowserSession, discoveryDefiniteUncorrelatedPostDenial, discoveryBrowserRequestLimit, discoveryBrowserActionSchema, discoveryPublicAnchorKind, discoveryPublicChoiceKind, normalizeDiscoveryNavigationUrl, publicHeaderFailureDiagnostic, redactDiscoveryFailureUrl, redactDiscoveryJson, redactDiscoveryRequestUrl, sameDiscoveryMainDocument } from "./browser-session";
import { isAnonymousBrowserReadPost } from "@/lib/automation/simulator-interactive-browser";
import mindbodyObserved from "./fixtures/mindbody-appointment-grid-observed.json";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";
import { deriveTeeItUpOfficialIdentityProof } from "./teeitup-official-identity";
import type { DiscoveryBrowserSnapshot } from "./browser-session";
import { launchPublicReadBrowser } from "./public-browser-launch";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
vi.mock("@/lib/automation/address-pinned-public-fetch", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/automation/address-pinned-public-fetch")>(), createAddressPinnedPublicFetchTransport: vi.fn(),
}));

describe("discovery browser public protocol", () => {
  it("uses the current unchanged public POST policy only to confirm denial, never to accept an uncorrelated read", () => {
    const request = { url: "https://example.org/data", method: "POST" as const, resourceType: "xhr" as const, headers: { "content-type": "application/json" }, body: '{"event":"page-view"}' };
    const addHeaders = vi.fn(() => true);
    expect(discoveryDefiniteUncorrelatedPostDenial(request, "https://example.org/", isAnonymousBrowserReadPost, addHeaders)).toBe(true);
    expect(discoveryDefiniteUncorrelatedPostDenial({ ...request, body: '{"query":"query { availability { start } }"}' }, "https://example.org/", isAnonymousBrowserReadPost, addHeaders)).toBe(false);
    const readPost = vi.fn((_url: URL, headers: Headers) => headers.get("referer") === "https://example.org/");
    expect(discoveryDefiniteUncorrelatedPostDenial(request, "https://example.org/", readPost, (_url, _method, _original, headers) => { headers.set("referer", "https://example.org/"); return true; })).toBe(false);
    expect(readPost).toHaveBeenCalledOnce();
    for (const uncertain of [() => undefined as never, () => { throw Error("POLICY_UNCERTAIN"); }])
      expect(discoveryDefiniteUncorrelatedPostDenial(request, "https://example.org/", uncertain, addHeaders)).toBe(false);
    expect(discoveryDefiniteUncorrelatedPostDenial(request, "https://example.org/", () => false, () => false)).toBe(false);
  });
  it.each(["REX", "Membersports", "document", "OPTIONS", "GET", "body", "unsafe document", "unsafe URL", "Mindbody private header"])
  ("does not classify a possible typed/private or uncertain %s request as definite denial", mode => {
    const request = { url: "https://example.org/data", method: "POST" as const, resourceType: "xhr" as const, headers: { "content-type": "application/json" } as Record<string, string>, body: '{}' };
    let documentUrl = "https://example.org/";
    if (mode === "REX") request.url = "https://public.reservewithrex.com/api/venue/get";
    if (mode === "Membersports") {
      request.url = "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes"; request.headers.origin = "https://app.membersports.com";
      documentUrl = "https://app.membersports.com/tee-times/1/2/0";
      request.body = JSON.stringify({ configurationTypeId: 1, date: "2030-01-03", golfClubGroupId: 1, golfClubId: 2, golfCourseId: 3, groupSheetTypeId: 4 });
    }
    if (mode === "document") request.resourceType = "document" as never;
    if (["GET", "OPTIONS"].includes(mode)) request.method = mode as never;
    if (mode === "body") request.body = "x".repeat(32769);
    if (mode === "unsafe document") documentUrl = "https://example.org/account/";
    if (mode === "unsafe URL") request.url = "https://example.org/checkout/";
    if (mode === "Mindbody private header") request.headers["next-action"] = "unverified-action";
    const readPost = vi.fn(() => false);
    expect(discoveryDefiniteUncorrelatedPostDenial(request, documentUrl, readPost, () => true)).toBe(false);
    expect(readPost).not.toHaveBeenCalled();
  });
  it("keeps the generic request allocation and grants only the private fixed Mindbody profile", () => {
    const source = mindbodyObserved.source, input = { initialUrls: [source.bookingUrl], timeZone: source.timeZone, venueName: source.venueName,
      venueAddress: source.venueAddress, venueOfficialUrl: source.officialUrl, requestedInput: mindbodyObserved.input };
    expect(discoveryBrowserRequestLimit(input, {})).toBe(192);
    expect(discoveryBrowserRequestLimit(input, { browserTransport: "NATIVE_CHROME", localCapabilities: ["LOCAL_CHROME"] })).toBe(192);
    expect(discoveryBrowserRequestLimit(input, { fixedReaderProfile: "MINDBODY_APPOINTMENTS", browserTransport: "NATIVE_CHROME", localCapabilities: ["LOCAL_CHROME"] })).toBe(512);
    expect(discoveryBrowserRequestLimit({ initialUrls: ["https://example.org/"] }, {})).toBe(192);
  });
  it.each(["unknown profile", "numeric profile", "pinned", "no capability", "no context", "no duration", "bad duration", "timezone", "other provider", "malformed source", "extra source", "missing identity"])(
    "rejects fixed Mindbody profile %s before any browser launch", async mode => {
      const source = mindbodyObserved.source, input = { initialUrls: [source.bookingUrl], timeZone: source.timeZone, venueName: source.venueName,
        venueAddress: source.venueAddress, venueOfficialUrl: source.officialUrl, requestedInput: structuredClone(mindbodyObserved.input), deadlineAt: new Date(Date.now() + 20_000) };
      const launchBrowser = vi.fn(), deps = { fixedReaderProfile: "MINDBODY_APPOINTMENTS", browserTransport: "NATIVE_CHROME", localCapabilities: ["LOCAL_CHROME"], launchBrowser };
      if (mode === "unknown profile") deps.fixedReaderProfile = "OTHER";
      if (mode === "numeric profile") (deps as Record<string, unknown>).fixedReaderProfile = 512;
      if (mode === "pinned") deps.browserTransport = "PINNED_HTTP";
      if (mode === "no capability") deps.localCapabilities = [];
      if (mode === "no context") (input as Record<string, unknown>).requestedInput = undefined;
      if (mode === "no duration") (input.requestedInput as Record<string, unknown>).durationMinutes = undefined;
      if (mode === "bad duration") input.requestedInput.durationMinutes = 0;
      if (mode === "timezone") input.timeZone = "America/Los_Angeles";
      if (mode === "other provider") input.initialUrls = ["https://example.org/"];
      if (mode === "malformed source") input.initialUrls = ["https://clients.mindbodyonline.com/classic/ws?studioid=invalid&stype=-9"];
      if (mode === "extra source") input.initialUrls.push(source.bookingUrl);
      if (mode === "missing identity") input.venueName = "";
      expect(() => discoveryBrowserRequestLimit(input, deps as Parameters<typeof discoveryBrowserRequestLimit>[1])).toThrow("INVALID_FIXED_READER_PROFILE");
      await expect(createCourseDiscoveryBrowserSession(input, deps as Parameters<typeof createCourseDiscoveryBrowserSession>[1])).rejects.toThrow();
      expect(launchBrowser).not.toHaveBeenCalled();
    });
  it("does not accept a request allocation/profile/capability through model actions", () => {
    for (const extra of [{ fixedReaderProfile: "MINDBODY_APPOINTMENTS" }, { requestLimit: 512 }, { localCapabilities: ["LOCAL_CHROME"] }])
      expect(discoveryBrowserActionSchema.safeParse({ id: 1, action: "open", url: mindbodyObserved.source.bookingUrl, ...extra }).success).toBe(false);
  });
  it("rejects invalid fixed inspection context before starting a browser and does not admit it as a model action", async () => {
    const requestedInput = { date: "2030-01-02", players: 2, durationMinutes: 60, startTime: "08:00", endTime: "18:00", timeZone: "America/New_York" };
    const launchBrowser = vi.fn();
    const base = { initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 20_000), timeZone: "America/New_York" };
    await expect(createCourseDiscoveryBrowserSession({ ...base, requestedInput: { ...requestedInput, durationMinutes: 0 } }, { launchBrowser })).rejects.toThrow();
    await expect(createCourseDiscoveryBrowserSession({ ...base, requestedInput: { ...requestedInput, timeZone: "America/Los_Angeles" } }, { launchBrowser }))
      .rejects.toThrow("REQUEST_CONTEXT_TIME_ZONE_MISMATCH");
    expect(launchBrowser).not.toHaveBeenCalled();
    expect(discoveryBrowserActionSchema.safeParse({ id: 1, action: "inspect_adapter", url: base.initialUrls[0], requestedInput }).success).toBe(false);
  });
  it("projects header-denial facts as closed categories without header names, values or digests", () => {
    const diagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", "OPTIONS", {
      Authorization: "Bearer null", "x-api-key": "private-key-value", "x-ms-request-id": "private-correlation-value",
      "X-Private-Token-Name": "private-companion-value", "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,x-api-key,x-private-token-name",
    }, null);
    expect(diagnostic).toMatchObject({ stage: "HEADER_PROOF_MISSING", requestedPreflightMethod: "GET", ordinaryPreflightMethod: null,
      authorizationShape: "BEARER_NULL", apiKeyPresent: true, sensitiveCompanionPresent: true,
      requestedAuthorization: true, requestedApiKey: true, requestedUnknownHeader: true, requestedHeaderSyntaxValid: true,
      privateProofFailureReason: "UNOBSERVED" });
    for (const privateText of ["private-key-value", "private-correlation-value", "private-companion-value", "x-private-token-name"])
      expect(JSON.stringify(diagnostic)).not.toContain(privateText);
    const duplicate = publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", "OPTIONS", { Authorization: "Bearer null", authorization: "Bearer null",
      "Access-Control-Request-Method": "GET", "access-control-request-method": "POST", "access-control-request-headers": "x-api-key,x-api-key" }, null);
    expect(duplicate).toMatchObject({ authorizationShape: "OTHER_REDACTED", duplicateHeaderNames: true,
      requestedPreflightMethod: "OTHER", requestedHeaderDuplicates: true });
    expect(publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "GET", {}, null)).not.toHaveProperty("requestedPreflightMethod");
    const observed = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "OPTIONS", {}, null,
      { reason: "NATIVE_RECORD_NOT_CURRENT", nativeRequestCancelled: true, nativeRecordFailed: "private-value", headers: "private-value", digest: "private-value" } as never);
    expect(observed).toMatchObject({ privateProofFailureReason: "NATIVE_RECORD_NOT_CURRENT", nativeRequestCancelled: true });
    expect(observed).not.toHaveProperty("nativeRecordFailed"); expect(observed).not.toHaveProperty("headers");
    expect(JSON.stringify(observed)).not.toContain("private-value");
    expect(publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "GET", {}, null,
      { reason: "private-value" } as never).privateProofFailureReason).toBe("UNOBSERVED");
    const loadingFailed = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "OPTIONS", {}, null,
      { reason: "NATIVE_RECORD_NOT_CURRENT", nativeSourceFetchRecordPresent: true, nativeSourceFetchAdmitted: true, nativeSourceFetchFailed: false,
        nativeSourceFetchHandlerDone: false, nativeSourceLoadingFailedCanceledPresent: true, nativeSourceLoadingFailedCanceled: false,
        nativeSourceLoadingFailedCorsErrorPresent: true, nativeSourceLoadingFailedErrorKind: "TIMED_OUT",
        nativeSourceLoadingFailedCorsError: "HeaderDisallowedByPreflightResponse", errorText: "private-value", failedParameter: "private-value" } as never);
    expect(loadingFailed).toMatchObject({ nativeSourceFetchRecordPresent: true, nativeSourceFetchAdmitted: true, nativeSourceFetchFailed: false,
      nativeSourceFetchHandlerDone: false, nativeSourceLoadingFailedCanceledPresent: true, nativeSourceLoadingFailedCanceled: false,
      nativeSourceLoadingFailedCorsErrorPresent: true, nativeSourceLoadingFailedErrorKind: "TIMED_OUT", nativeSourceLoadingFailedCorsError: "HeaderDisallowedByPreflightResponse" });
    expect(JSON.stringify(loadingFailed)).not.toContain("private-value");
    const unknown = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "GET", {}, null,
      { reason: "NATIVE_RECORD_NOT_CURRENT", nativeSourceLoadingFailedErrorKind: "private-value", nativeSourceLoadingFailedCorsError: "private-value" } as never);
    expect(unknown).not.toHaveProperty("nativeSourceLoadingFailedErrorKind"); expect(unknown).not.toHaveProperty("nativeSourceLoadingFailedCorsError");
  });
  it("admits public reservation navigation while excluding slot and transaction controls", () => {
    const control = { tag: "a", name: "Click here to reserve a tee time", label: "", href: "https://example.org/tee-times", sensitiveForm: false };
    expect(discoveryPublicAnchorKind(control)).toBe("link");
    expect(discoveryPublicAnchorKind({ ...control, name: "Reserve 09:30" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/checkout" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/tee-times?slot=123" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/tee-times?Time=AnyTime&Player=99" })).toBe("link");
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/tee-times?Time=09:30" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/tee-times?teeTimeId=123" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/review" })).toBeNull();
  });
  it("normalizes only the known observed ForeUP public bootstrap login bookmark", () => {
    expect(normalizeDiscoveryNavigationUrl("https://foreupsoftware.com/index.php/booking/21017#/login")).toBe("https://foreupsoftware.com/index.php/booking/21017");
    expect(normalizeDiscoveryNavigationUrl("https://other.example.org/index.php/booking/21017#/login")).toContain("#/login");
    expect(normalizeDiscoveryNavigationUrl("https://foreupsoftware.com/account#/login")).toContain("#/login");
  });
  it("matches a main document across fragments without borrowing another path, query, or origin status", () => {
    const observed = "https://example.org/booking?course=12";
    expect(sameDiscoveryMainDocument(observed, `${observed}#teetimes`)).toBe(true);
    expect(sameDiscoveryMainDocument(`${observed}#old`, `${observed}#new`)).toBe(true);
    for (const current of ["https://example.org/booking?course=13#teetimes", "https://example.org/other?course=12#teetimes",
      "https://another.example.org/booking?course=12#teetimes", "http://example.org/booking?course=12#teetimes", ""]) {
      expect(sameDiscoveryMainDocument(observed, current)).toBe(false);
    }
  });
  it("recognizes calendar cells and bounded numeric filter choices without selecting slots", () => {
    const cell = { tag: "td", name: "22", calendar: true, sensitiveForm: false };
    expect(discoveryPublicChoiceKind(cell)).toBe("calendar");
    expect(discoveryPublicChoiceKind({ ...cell, disabledChoice: true })).toBeNull();
    const choice = { tag: "a", name: "2", calendar: false, sensitiveForm: false, choiceValue: "2", choiceContext: "Players 1 2 3 4 Any" };
    expect(discoveryPublicChoiceKind(choice)).toBe("option");
    expect(discoveryPublicChoiceKind({ ...choice, choiceContext: "Products" })).toBeNull();
    expect(discoveryPublicChoiceKind({ ...choice, name: "Reserve 09:30" })).toBeNull();
  });
  it("rejects eval and arbitrary actions", () => {
    expect(discoveryBrowserActionSchema.safeParse({ id: 1, action: "evaluate", code: "document.cookie" }).success).toBe(false);
    expect(discoveryBrowserActionSchema.safeParse({ id: 1, action: "click", target: "#book" }).success).toBe(false);
    expect(discoveryBrowserActionSchema.safeParse({ id: 1, action: "open", url: "https://example.org/", extra: true }).success).toBe(false);
  });
  it("redacts nested credentials and bounds extracted bodies", () => {
    expect(redactDiscoveryJson({ token: "secret", nested: [{ email: "a@example.org", start: "09:00", capacity: 4 }],
      text: "Contact a@example.org" })).toEqual({ token: "[redacted]", nested: [{ email: "[redacted]", start: "09:00", capacity: 4 }], text: "Contact [redacted-email]" });
    expect((redactDiscoveryJson(Array.from({ length: 300 }, (_, index) => index)) as unknown[])).toHaveLength(100);
    expect(redactDiscoveryRequestUrl("https://maps.example.org/api?key=private-value&date=2026-10-22")).toBe("https://maps.example.org/api?key=REDACTED&date=2026-10-22");
  });
  it("exposes only safe session-free diagnostic paths without query or fragment values", () => {
    expect(redactDiscoveryFailureUrl("https://public.example.org/calendar?token=secret&date=2030-10-23#private", "fetch")).toBe("https://public.example.org/calendar");
    expect(redactDiscoveryFailureUrl("https://sc.cps.golf/ExampleV3/(S(abc123abc123abc123abc123))/Home/nIndex?CourseId=1", "document"))
      .toBe("https://sc.cps.golf/ExampleV3/Home/nIndex");
    for (const value of ["https://user:secret@example.org/calendar", "https://127.0.0.1/calendar", "https://example.org/account/token-secret", "not-url"])
      expect(redactDiscoveryFailureUrl(value, "fetch")).toBeUndefined();
  });
  it("requires prebound safe sources before launching a browser", async () => {
    const launchBrowser = vi.fn();
    await expect(createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://127.0.0.1/"] }, { launchBrowser })).rejects.toThrow("INVALID_INITIAL_URLS");
    expect(launchBrowser).not.toHaveBeenCalled();
  });
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
describe.runIf(existsSync(executablePath))("isolated discovery browser", () => {
  it.each(["duplicates", "differentDestination", "unsafeForm", "staleForm"] as const)
  ("earns one native public-entry disclosure and freshly reveals its exact public frame: %s", async mode => {
    const official = "https://owned-disclosure.example/", href = official + "public-entry", frame = "https://app.acuityscheduling.com/schedule.php?owner=123456&ref=embedded_csp";
    const name = "Public Indoor Golf", address = "10 Public Road, Example, NY 12345, USA";
    const material = readFileSync("src/lib/course-discovery/cps-browser-wiring.test.ts", "utf8"), tls = (key: string): string => JSON.parse(new RegExp(`^const ${key} = (".*");$`, "m").exec(material)![1]);
    const reads: string[] = [], families = new Set<string>(); let active = 0, acquired = 0, released = 0, foreign = 0;
    const lease = async <T>(family: string, work: () => Promise<T>) => {
      if (active >= 2 || families.has(family)) return { acquired: false } as const;
      active++; acquired++; families.add(family); try { return { acquired: true, value: await work() } as const; }
      finally { active--; released++; families.delete(family); }
    };
    const anchors = ["hero", "secondary", "sticky"].map((id, i) => `<a id="${id}" href="${mode === "differentDestination" && i === 1 ? official + "another-entry" : href}">Reserve Your Bay</a>`);
    anchors[1] = `<article>Public indoor golf details. ${anchors[1]}</article>`;
    if (mode === "unsafeForm") anchors[1] = `<form>${anchors[1]}</form>`;
    const html = `<!doctype html><title>${name}</title><link rel="icon" href="data:,"><body><h1>${name}</h1><p>${address}</p>${anchors.join("")}
      <div id="public-panel" hidden><iframe title="Schedule Appointment" src="${frame}" style="width:400px;height:300px"></iframe></div>
      <script>window.disclosureCount=0;document.addEventListener('click',e=>{if(e.target.closest('a')){e.preventDefault();window.disclosureCount++;document.getElementById('public-panel').hidden=false;}})</script></body>`;
    const server = createServer({ key: tls("fixtureKey"), cert: tls("fixtureCertificate") }, (request, response) => {
      expect(active).toBeGreaterThan(0); reads.push(String(request.url));
      if (request.method !== "GET" || request.url !== "/") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html" }).end(html);
    });
    const originalProxy = nativeBrowser.createNativePublicBrowserProxy;
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let proxy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
      proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(input => originalProxy({ ...input, requireHostAdmission: true }, {
        resolveAddresses: async hostname => { if (hostname !== "owned-disclosure.example") { foreign++; throw Error("UNOWNED_FIXTURE_HOST"); } return [{ address: "93.184.216.34", family: 4 }]; },
        connect: () => connect({ host: "127.0.0.1", port }),
      }));
      session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], venueOfficialUrl: official, venueName: name, venueAddress: address, deadlineAt: new Date(Date.now() + 25_000) }, {
        browserTransport: "NATIVE_CHROME", requestLease: lease, launchBrowser: async () => browser = await launchPublicReadBrowser({ executablePath, headless: true, args: ["--ignore-certificate-errors"] }),
      });
      const snapshot = await session.execute({ id: 1, action: "open", url: official }); expect(snapshot.navigationStatus).toBe(200);
      expect(snapshot.frames.filter(row => row.source === "OFFICIAL_IFRAME_SRC")).toEqual([]);
      const disclosures = snapshot.controls.filter(control => control.kind === "public-entry-disclosure");
      if (["differentDestination", "unsafeForm"].includes(mode)) expect(disclosures).toEqual([]);
      else {
        expect(disclosures).toHaveLength(1); expect(disclosures[0].href).toBe(href);
        const page = browser!.contexts().flatMap(context => context.pages()).find(page => page.url() === official)!;
        if (mode === "staleForm") {
          await page.locator(disclosures[0].selector).evaluate(node => { const form = document.createElement("form"); node.parentElement!.append(form); form.append(node); });
          await expect(session.execute({ id: 2, action: "click", target: disclosures[0].target })).rejects.toThrow("STALE_OR_UNKNOWN_CONTROL");
          expect(await page.evaluate(() => (window as Window & { disclosureCount: number }).disclosureCount)).toBe(0);
        } else {
          const opened = await session.execute({ id: 2, action: "click", target: disclosures[0].target });
          expect(opened.url).toBe(official); expect(opened.navigationStatus).toBe(200); expect(opened.controls.some(control => control.kind === "public-entry-disclosure")).toBe(false);
          expect(opened.frames).toContainEqual({ url: frame, source: "OFFICIAL_IFRAME_SRC" });
          expect(await page.evaluate(() => (window as Window & { disclosureCount: number }).disclosureCount)).toBe(1);
        }
      }
      expect(reads).toEqual(["/"]);
    } finally { await session?.close(); proxy?.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(foreign).toBe(0); expect(active).toBe(0); expect(acquired).toBeGreaterThan(0); expect(released).toBe(acquired);
  }, 35_000);
  it.each(["current", "loader", "foreignFrame", "differentRequest", "differentUrl", "pendingAck", "failedIdentity", "nonSuccess", "newDocument"] as const)
  ("retains only the completed native main GET status across an owned same-document path and query change: %s", async mode => {
    const entry = "https://owned-status.example/", current = entry + "public-search?view=day";
    const material = readFileSync("src/lib/course-discovery/cps-browser-wiring.test.ts", "utf8");
    const tls = (name: string): string => JSON.parse(new RegExp(`^const ${name} = (".*");$`, "m").exec(material)![1]);
    const reads: string[] = [], families = new Set<string>(); let active = 0, acquired = 0, released = 0, foreign = 0;
    const lease = async <T>(family: string, work: () => Promise<T>) => {
      if (active >= 2 || families.has(family)) return { acquired: false } as const;
      active++; acquired++; families.add(family);
      try { return { acquired: true, value: await work() } as const; }
      finally { active--; released++; families.delete(family); }
    };
    let releaseAck!: () => void, ackObserved = false, queryCalls = 0, statusSessions = 0, statusDetached = 0;
    const statusSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    const ack = new Promise<void>(resolve => { releaseAck = resolve; });
    const server = createServer({ key: tls("fixtureKey"), cert: tls("fixtureCertificate") }, (request, response) => {
      expect(active).toBeGreaterThan(0); reads.push(String(request.url));
      if (request.method !== "GET" || !["/", "/replacement"].includes(String(request.url))) { response.writeHead(500).end(); return; }
      const replaced = request.url === "/replacement";
      response.writeHead(mode === "nonSuccess" || replaced ? 503 : 200, { "content-type": "text/html" }).end('<!doctype html><link rel="icon" href="data:,"><body>Public document<a href="/replacement">Public booking</a>' +
        (mode === "nonSuccess" || replaced ? "" : '<script>history.replaceState(null,"","/public-search?view=day");</script>') + '</body>');
    });
    const originalProxy = nativeBrowser.createNativePublicBrowserProxy;
    const originalRouter = nativeRouting.installNativeRedirectRouting;
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (page, handler, options) => {
      const context = page.context(), newSession = context.newCDPSession.bind(context);
      let ownerCdp: CDPSession | undefined, networkId: string | undefined;
      const pending = ["pendingAck", "failedIdentity"].includes(mode) ? vi.spyOn(context, "newCDPSession").mockImplementation(async target => {
        const cdp = await newSession(target), send = cdp.send.bind(cdp);
        ownerCdp = cdp;
        cdp.on("Network.requestWillBeSent", event => { if (event.type === "Document") networkId = event.requestId; });
        cdp.send = (async (...args: Parameters<typeof cdp.send>) => {
          const result = await send(...args);
          if (mode === "pendingAck" && args[0] === "Fetch.continueResponse") { ackObserved = true; await ack; }
          return result;
        }) as typeof cdp.send;
        return cdp;
      }) : undefined;
      let router: Awaited<ReturnType<typeof originalRouter>>;
      try { router = await originalRouter(page, handler, options); } finally { pending?.mockRestore(); }
      statusSpies.push(vi.spyOn(context, "newCDPSession").mockImplementation(async target => {
        const cdp = await newSession(target), detach = cdp.detach.bind(cdp); statusSessions++;
        statusSpies.push(vi.spyOn(cdp, "detach").mockImplementation(async () => { statusDetached++; await detach(); }));
        return cdp;
      }));
      const currentRead = router.isCurrentCompletedDocumentRead.bind(router);
      router.isCurrentCompletedDocumentRead = (request, frame, captured) => {
        queryCalls++;
        if (mode === "loader") return currentRead(request, frame, { ...captured, loaderId: captured.loaderId + "-foreign" });
        if (mode === "foreignFrame") return currentRead(request, {} as typeof frame, captured);
        if (mode === "differentRequest") return currentRead({ ...request }, frame, captured);
        if (mode === "differentUrl") return currentRead(request, frame, { ...captured, url: "https://foreign.example/" });
        if (mode === "failedIdentity") {
          // Owned protocol-fault injection: a completed read's exact identity
          // is subsequently failed; it cannot keep lending a successful status.
          expect(networkId).toBeTruthy();
          ownerCdp!.emit("Network.loadingFailed", { requestId: networkId!, timestamp: 0, type: "Document", errorText: "net::ERR_FAILED", canceled: false });
        }
        return currentRead(request, frame, captured);
      };
      return router;
    });
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
    let proxy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
      proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(input => originalProxy({ ...input, requireHostAdmission: true }, {
        resolveAddresses: async hostname => { if (hostname !== "owned-status.example") { foreign++; throw Error("UNOWNED_FIXTURE_HOST"); } return [{ address: "93.184.216.34", family: 4 }]; },
        connect: () => connect({ host: "127.0.0.1", port }),
      }));
      session = await createCourseDiscoveryBrowserSession({ initialUrls: [entry], deadlineAt: new Date(Date.now() + 20_000) }, {
        browserTransport: "NATIVE_CHROME", requestLease: lease,
        launchBrowser: () => launchPublicReadBrowser({ executablePath, headless: true, args: ["--ignore-certificate-errors"] }),
      });
      const snapshot = await session.execute({ id: 1, action: "open", url: entry });
      expect(snapshot.url).toBe(mode === "nonSuccess" ? entry : current); expect(snapshot.nativeFirstFatal).toBeUndefined(); expect(reads).toEqual(["/"]);
      if (mode === "nonSuccess") { expect(snapshot.navigationStatus).toBe(503); expect(queryCalls).toBe(0); }
      else {
        if (mode !== "pendingAck") expect(queryCalls).toBeGreaterThan(0);
        expect(snapshot.navigationStatus).toBe(["current", "newDocument"].includes(mode) ? 200 : undefined);
        if (mode === "pendingAck") { expect(ackObserved).toBe(true); releaseAck(); expect((await session.execute({ id: 2, action: "observe" })).navigationStatus).toBe(200); expect(queryCalls).toBeGreaterThan(0); }
        if (mode === "current") expect((await session.execute({ id: 2, action: "observe" })).navigationStatus).toBe(200);
        if (mode === "newDocument") {
          const next = await session.execute({ id: 2, action: "open", url: entry + "replacement" });
          expect(next.url).toBe(entry + "replacement"); expect(next.navigationStatus).toBe(503); expect(reads).toEqual(["/", "/replacement"]);
        }
      }
      if (["current", "newDocument"].includes(mode)) {
        const proof = snapshot.nativeMainDocumentContinuity;
        expect(proof).toMatchObject({ kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", status: 200 });
        expect(proof?.originalUrlSha256).toMatch(/^[a-f0-9]{64}$/u); expect(proof?.currentUrlSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(proof?.documentBindingSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(JSON.stringify(proof)).not.toMatch(/https:|frameId|loaderId|view=day/u);
      } else expect(snapshot).not.toHaveProperty("nativeMainDocumentContinuity");
    } finally { releaseAck(); await session?.close(); proxy?.mockRestore(); routing.mockRestore(); for (const spy of statusSpies) spy.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(statusSessions).toBe(mode === "nonSuccess" ? 0 : 1); expect(statusDetached).toBe(statusSessions);
    expect(foreign).toBe(0); expect(active).toBe(0); expect(acquired).toBeGreaterThan(0); expect(released).toBe(acquired);
  }, 30_000);
  it.each([true, false])("forwards only immutable constructor fixed inspection context when present: %s", async supplied => {
    const source = "https://example.org/";
    const requestedInput = { date: "2030-01-02", players: 2, durationMinutes: 60, startTime: "08:00", endTime: "18:00", timeZone: "America/New_York" };
    const inspectAdapter = vi.fn(async () => ({ adapter: { family: "FOREUP" as const, facilityId: 1, scheduleId: 2, bookingClassId: 3 } }));
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], venueName: "Public venue", timeZone: requestedInput.timeZone,
      deadlineAt: new Date(Date.now() + 20_000), ...(supplied ? { requestedInput } : {}) }, {
      inspectAdapter, fetch: vi.fn(async () => new Response("<html><body><h1>Public venue</h1></body></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    requestedInput.durationMinutes = 120;
    try {
      await session.execute({ id: 1, action: "open", url: source });
      await session.execute({ id: 2, action: "inspect_adapter", url: source });
      const received = inspectAdapter.mock.calls[0] as unknown as [unknown, { requestedInput?: typeof requestedInput }];
      if (supplied) expect(received[1].requestedInput).toEqual({ ...requestedInput, durationMinutes: 60 });
      else expect(received[1]).not.toHaveProperty("requestedInput");
    } finally { await session.close(); }
  });
  it.each(["valid", "valid query", "wrong query", "missing", "revoked", "invalid body", "redirect 302", "redirect 303", "redirect unproven", "redirect 307"] as const)("independently checks a native classic bootstrap before queued transport: %s", async mode => {
    const entry = "https://clients.mindbodyonline.com/classic/ws?studioid=685163&stype=-9", target = "https://clients.mindbodyonline.com/classic/home" + (mode === "valid query" ? "?studioid=685163" : mode === "wrong query" ? "?studioid=12345" : "");
    const empty = "tg vt lvl qParam view page catid prodid prodGroupId sSU optForwardingLink singleUseToken oAuthToken launchGUID launchUID launchPWDChange launchPWDChangeKey launchLostPWD launchResetPWD launchBizModeLogin launchBizModeLoginWithRedirectLink key consumerModeRedirect extLink giftCardID".split(" ");
    const fields = new URLSearchParams([...empty.map(key => [key, ""]), ["studioId", "685163"], ["stype", "-9"], ["trn", "0"], ["classid", "0"], ["date", "10/23/2026"]]);
    if (mode === "invalid body") fields.set("launchUID", "unapproved");
    const html = `<link rel="icon" href="data:,"><h1>Public site entry</h1><form method="post" action="${target}">` +
      [...fields].map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`).join("") + '</form><script>onload=()=>document.forms[0].submit()</script>';
    const proof = Object.freeze({ sourceUrl: entry }), reads: string[] = [], failures: string[] = [];
    const destination = "https://clients.mindbodyonline.com/ASP/adm/adm_appt_search.asp";
    const redirect = mode.startsWith("redirect "), attestedRedirect = mode === "redirect 302" || mode === "redirect 303";
    let postRequest: nativeRouting.NativeReadRequest | undefined, live = true, leases = 0, release!: () => void, held!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; }), queued = new Promise<void>(resolve => { held = resolve; });
    const proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: async () => {}, allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
    const sourceProof = vi.spyOn(nativeRouting, "nativeMindbodyBootstrapSource").mockImplementation(request => request === postRequest && live && mode !== "missing" ? proof : null);
    const redirectTarget = vi.spyOn(nativeBrowser, "isObservedNativeRedirectTarget").mockImplementation((request, next, roots) =>
      attestedRedirect && request === postRequest && next === destination && roots.has(entry));
    const redirectChild = vi.spyOn(nativeBrowser, "isObservedNativeRedirect").mockImplementation((request, roots) =>
      attestedRedirect && request.url() === destination && request.redirectedFrom() === postRequest && roots.has(entry));
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, pendingReads: 0, lastFailure: undefined,
      releasePlaywrightRoute: async route => {
        const raw = route.request(), request: nativeRouting.NativeReadRequest = { url: () => raw.url(), method: () => raw.method(), headers: () => raw.headers(), postData: () => raw.postData(),
          resourceType: () => raw.resourceType(), isNavigationRequest: () => raw.isNavigationRequest(), frame: () => raw.frame(), redirectedFrom: () => raw.redirectedFrom() && postRequest || null, response: () => raw.response() };
        if (raw.url() === target) postRequest = request;
        await handler({ request: () => request, continue: options => route.continue(options), abort: reason => route.abort(reason), fulfill: options => route.fulfill(options) });
      },
    }));
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      reads.push(`${route.request().method()} ${route.request().url()}`); const body = Buffer.from(route.request().url() === entry ? html : '<link rel="icon" href="data:,"><h1>Public schedule</h1>');
      const redirected = redirect && route.request().method() === "POST", status = redirected ? mode === "redirect 303" ? 303 : mode === "redirect 307" ? 307 : 302 : 200;
      const headers = { "content-type": "text/html", ...(redirected ? { location: destination } : {}) };
      await route.fulfill({ status, headers, body }); return { status, url: route.request().url(), headers, body };
    });
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [entry], deadlineAt: new Date(Date.now() + 15_000) }, {
      browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => { if (++leases === 2 && mode === "revoked") { held(); await released; } return { acquired: true, value: await work() }; },
      onRequestFailure: value => { failures.push(value.reason); },
    });
    try {
      const opening = session.execute({ id: 1, action: "open", url: entry });
      if (mode === "revoked") { await queued; live = false; release(); }
      await opening;
      const valid = mode === "valid" || mode === "valid query" || attestedRedirect;
      await vi.waitFor(() => expect(valid ? reads.length === (attestedRedirect ? 3 : 2) : failures.length > 0).toBe(true));
      expect(reads).toEqual(attestedRedirect ? [`GET ${entry}`, `POST ${target}`, `GET ${destination}`]
        : valid || redirect ? [`GET ${entry}`, `POST ${target}`] : [`GET ${entry}`]);
      if (valid) expect(failures).toEqual([]);
      if (!valid) expect(failures).toContain(redirect ? "UNSAFE_REDIRECT" : mode === "missing" ? "UNSAFE_METHOD" : "MINDBODY_BOOTSTRAP_READ_REJECTED");
    } finally { release(); await session.close(); native.mockRestore(); routing.mockRestore(); sourceProof.mockRestore(); redirectTarget.mockRestore(); redirectChild.mockRestore(); proxy.mockRestore(); }
  }, 20_000);

  it.each(["missing", "revoked"] as const)("classifies native public header proof failure without changing denial: %s", async mode => {
    // Synthetic private-proof/native bridge; real Chrome uses only in-memory replies.
    const entry = "https://example.org/header-diagnostic", data = "https://example.org/public-data";
    let release!: () => void, held!: () => void, live = true, leases = 0;
    let diagnosticAtDenial: ReturnType<Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>>["diagnostics"]> | undefined;
    const released = new Promise<void>(resolve => { release = resolve; });
    const queued = new Promise<void>(resolve => { held = resolve; });
    const proof = Object.freeze({}) as NonNullable<Awaited<ReturnType<typeof nativeRouting.authorizePublicClientReadHeaders>>>;
    const reads: string[] = [];
    const proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9",
      close: async () => {}, allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
    const authorize = vi.spyOn(nativeRouting, "authorizePublicClientReadHeaders").mockResolvedValue(mode === "missing" ? null : proof);
    const current = vi.spyOn(nativeRouting, "isCurrentPublicClientReadHeaders").mockImplementation(() => live);
    const firstFailure = vi.spyOn(nativeRouting, "publicClientReadHeaderProofFailure").mockImplementation(() => live ? null :
      { reason: "NATIVE_RECORD_NOT_CURRENT", nativeRequestCancelled: true });
    const preflight = vi.spyOn(nativeRouting, "nativePublicClientPreflightMethod").mockReturnValue("GET");
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, pendingReads: 0, lastFailure: undefined,
      releasePlaywrightRoute: async route => {
        const raw = route.request(), isData = raw.url() === data;
        const request: nativeRouting.NativeReadRequest = { url: () => raw.url(), method: () => isData ? "OPTIONS" : raw.method(),
          headers: () => isData ? { authorization: "Bearer null", "x-api-key": "fixture-public-literal", origin: "https://example.org",
            "access-control-request-method": "GET", "access-control-request-headers": "authorization,x-api-key" } : raw.headers(),
          postData: () => null, resourceType: () => isData ? "xhr" : raw.resourceType(), isNavigationRequest: () => raw.isNavigationRequest(),
          frame: () => raw.frame(), redirectedFrom: () => null, response: () => raw.response() };
        await handler({ request: () => request, continue: options => route.continue(options), abort: reason => route.abort(reason), fulfill: options => route.fulfill(options) });
      },
    }));
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      reads.push(route.request().url());
      const body = Buffer.from(`<h1>Public calendar</h1><script>fetch('/public-data').catch(()=>{}).finally(()=>window.fixtureDone=true)</script>`);
      const headers = { "content-type": "text/html" };
      await route.fulfill({ status: 200, headers, body }); return { status: 200, url: route.request().url(), headers, body };
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [entry], deadlineAt: new Date(Date.now() + 15_000) }, {
      browserTransport: "NATIVE_CHROME", launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => { if (++leases === 2 && mode === "revoked") { held(); await released; } return { acquired: true, value: await work() }; },
      onRequestFailure: () => { diagnosticAtDenial = session.diagnostics(); },
    });
    try {
      const opening = session.execute({ id: 1, action: "open", url: entry });
      if (mode === "revoked") { await queued; live = false; release(); }
      const first = await opening;
      await browser!.contexts()[0].pages()[0].waitForFunction(() => Boolean((window as Window & { fixtureDone?: boolean }).fixtureDone));
      const next = await session.execute({ id: 2, action: "observe" });
      const denied = [...first.requests, ...next.requests].find(row => row.url === data && row.blockedReason);
      expect(denied).toMatchObject({ blockedReason: "CREDENTIAL_HEADERS", publicHeaderDiagnostic: {
        stage: mode === "missing" ? "HEADER_PROOF_MISSING" : "HEADER_PROOF_REVOKED_AFTER_QUEUE", requestedPreflightMethod: "GET",
        authorizationShape: "BEARER_NULL", apiKeyPresent: true, requestedAuthorization: true, requestedApiKey: true,
      } });
      expect(next.requestFailures?.find(row => row.url === data)).toMatchObject({ reason: "CREDENTIAL_HEADERS", publicHeaderDiagnostic: { stage: mode === "missing" ? "HEADER_PROOF_MISSING" : "HEADER_PROOF_REVOKED_AFTER_QUEUE" } });
      expect(diagnosticAtDenial?.requests.find(row => row.url === data)).toMatchObject({ blockedReason: "CREDENTIAL_HEADERS",
        publicHeaderDiagnostic: { stage: mode === "missing" ? "HEADER_PROOF_MISSING" : "HEADER_PROOF_REVOKED_AFTER_QUEUE",
          privateProofFailureReason: mode === "missing" ? "UNOBSERVED" : "NATIVE_RECORD_NOT_CURRENT",
          ...(mode === "revoked" ? { nativeRequestCancelled: true } : {}) } });
      if (mode === "missing") expect(firstFailure).not.toHaveBeenCalled();
      expect(reads).toEqual([entry]); expect(JSON.stringify([first, next])).not.toContain("fixture-public-literal");
    } finally { release(); await session.close(); native.mockRestore(); routing.mockRestore(); preflight.mockRestore(); current.mockRestore(); firstFailure.mockRestore(); authorize.mockRestore(); proxy.mockRestore(); }
  }, 20_000);

  it("keeps a successful inventory GET out of document roots while preserving an actual public href", async () => {
    const source = "https://example.org/public-calendar", inventory = "https://example.org/availability", linked = "https://example.org/tee-times";
    const fetcher = vi.fn(async value => String(value) === source
      ? new Response(`<h1>Public calendar</h1><a href="${linked}">Tee times</a><script>fetch('/availability').then(r=>r.json()).then(()=>window.fixtureDone=true)</script>`, { headers: { "content-type": "text/html" } })
      : String(value) === inventory ? new Response('{"slots":[]}', { headers: { "content-type": "application/json" } })
        : new Response("<h1>Linked public tee times</h1>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now() + 15_000) }, {
      launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }), fetch: fetcher,
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const first = await session.execute({ id: 1, action: "open", url: source });
      await browser!.contexts()[0].pages()[0].waitForFunction(() => Boolean((window as Window & { fixtureDone?: boolean }).fixtureDone));
      const observed = await session.execute({ id: 2, action: "observe" });
      expect([...first.requests, ...observed.requests].some(row => row.url === inventory && row.status === 200)).toBe(true);
      await expect(session.execute({ id: 3, action: "open", url: inventory })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      const opened = await session.execute({ id: 4, action: "open", url: linked });
      expect(opened.text).toContain("Linked public tee times");
    } finally { await session.close(); }
  }, 20_000);

  it("observes a public language-bearing inventory response without promoting it to navigation", async () => {
    const source = "https://www.sevenrooms.com/reservations/publicrental";
    const inventory = "https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=publicrental&time_slot=12:00&party_size=1&halo_size_interval=16&start_date=10-23-2026&num_days=1&channel=SEVENROOMS_WIDGET&selected_lang_code=en&picked_duration=60";
    const html = `<h1>Public rental</h1><script>fetch(${JSON.stringify(inventory)}).then(r=>r.json()).then(()=>document.querySelector('h1').textContent='Public inventory ready')</script>`;
    const fetch = vi.fn(async url => String(url) === inventory
      ? new Response(JSON.stringify({ status: "success", data: { times: ["10:00"] } }), { headers: { "content-type": "application/json" } })
      : new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now() + 20_000) }, {
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), fetch,
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: source });
      expect(snapshot.text).toContain("Public inventory ready");
      expect(snapshot.requests.find(row => row.url === inventory)).toMatchObject({ status: 200, method: "GET" });
      expect(snapshot.requests.find(row => row.url === inventory)?.readPurpose).toBe("PUBLIC_AVAILABILITY");
      expect(snapshot.responses.find(row => row.url === inventory)?.body).toMatchObject({ status: "success" });
      await expect(session.execute({ id: 2, action: "open", url: inventory })).rejects.toThrow();
    } finally { await session.close(); }
  }, 25_000);

  it("exposes and safely opens a readonly date input labelled by its placeholder", async () => {
    const source = "https://example.org/public-times";
    const html = `<h1>Public Golf</h1><input id="date-input" readonly placeholder="Choose date" aria-haspopup="dialog" value="Thu, Oct 22, 2026" onclick="document.getElementById('calendar').hidden=false"><div id="calendar" role="dialog" hidden>Calendar ready</div>`;
    const fetch = vi.fn(async () => new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now() + 20_000) }, {
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), fetch,
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const first = await session.execute({ id: 1, action: "open", url: source });
      const date = first.controls.find(control => control.selector === '[id="date-input"]')!;
      expect(date).toMatchObject({ kind: "calendar", name: "Choose date", currentValue: "Thu, Oct 22, 2026", readOnly: true });
      await expect(session.execute({ id: 2, action: "fill", target: date.target, text: "2026-10-23" })).rejects.toThrow("UNSAFE_CONTROL");
      const next = await session.execute({ id: 3, action: "click", target: date.target });
      expect(next.text).toContain("Calendar ready");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await session.close(); }
  }, 25_000);

  it("retires native work only after exact admitted document navigation and preserves cumulative budgets/deadline", async () => {
    const boundaries: string[] = [], originalDeadline = new Date(Date.now() + 30_000);
    const deadlineMillis = originalDeadline.getTime();
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const body = Buffer.from('<h1>Public golf document</h1><a href="https://example.org/next">View tee times</a>'), headers = { "content-type": "text/html" };
      await route.fulfill({ status: 200, headers, body }); return { status: 200, url: route.request().url(), headers, body };
    });
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async frame => { expect(frame).toBe(page.mainFrame()); boundaries.push(page.url()); },
      close: async () => {}, pendingReads: 0, lastFailure: undefined, releasePlaywrightRoute: route => handler(route),
    }));
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: originalDeadline }, {
      browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      await expect(session.execute({ id: 1, action: "open", url: "https://unobserved.example.org/" })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(boundaries).toEqual([]);
      const first = await session.execute({ id: 2, action: "open", url: "https://example.org/" });
      expect(boundaries).toEqual(["about:blank"]);
      await session.execute({ id: 3, action: "observe" });
      await expect(session.execute({ id: 4, action: "click", target: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow("STALE_OR_UNKNOWN_CONTROL");
      expect(boundaries).toHaveLength(1);
      const observed = await session.execute({ id: 5, action: "observe" });
      const link = observed.controls.find(control => control.href === "https://example.org/next")!;
      const next = await session.execute({ id: 6, action: "click", target: link.target });
      expect(boundaries).toEqual(["about:blank", "https://example.org/"]); expect(next.url).toBe("https://example.org/next");
      expect(next.requestCount).toBeGreaterThan(first.requestCount); expect(next.responseBytes).toBeGreaterThan(first.responseBytes);
      expect(next.interceptCount).toBeGreaterThan(first.interceptCount); expect(originalDeadline.getTime()).toBe(deadlineMillis);
    } finally { await session.close(); native.mockRestore(); routing.mockRestore(); }
  }, 20_000);
  it.each(["open", "observed document link"])("returns committed public controls before deferred assets finish: %s", async mode => {
    const source = "https://example.org/", destination = "https://example.org/tee-times", asset = "https://assets.example.org/pending.js";
    let release!: () => void;
    const pendingAsset = new Promise<void>(resolve => { release = resolve; });
    const fixture = `<html><body><h1>Public Golf</h1><a href="${destination}">Book tee times</a>` +
      `<script>window.publicDomReady=false;document.addEventListener('DOMContentLoaded',()=>{window.publicDomReady=true})</script>` +
      `<script defer src="${asset}"></script></body></html>`;
    const fetcher = vi.fn(async value => {
      if (String(value) === asset) { await pendingAsset; return new Response("/* public asset */", { headers: { "content-type": "application/javascript" } }); }
      return new Response(mode === "observed document link" && String(value) === source
        ? `<h1>Public Golf</h1><a href="${destination}">Book tee times</a>` : fixture, { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now() + 20_000) }, {
      fetch: fetcher, launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const initial = mode === "observed document link" ? await session.execute({ id: 1, action: "open", url: source }) : undefined;
      const startedAt = Date.now();
      const opening = initial ? session.execute({ id: 2, action: "click", target: initial.controls.find(control => control.href === destination)!.target })
        : session.execute({ id: 1, action: "open", url: source });
      const snapshot = await Promise.race([opening, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("COMMITTED_CONTROLS_NOT_RETURNED")), 7_000); })]);
      clearTimeout(timer);
      expect(Date.now() - startedAt).toBeLessThan(7_000);
      expect(snapshot.url).toBe(initial ? destination : source); expect(snapshot.navigationStatus).toBe(200);
      expect(snapshot.controls).toContainEqual(expect.objectContaining({ kind: "link", name: "Book tee times", href: destination }));
      expect(snapshot.loading).toBe(true); expect(snapshot.pendingRequestCount).toBeGreaterThan(0);
      expect(snapshot.requests).toContainEqual({ url: asset, method: "GET", resourceType: "script" });
      expect(snapshot.completedPublicAssetRequests ?? []).not.toContainEqual(expect.objectContaining({ url: asset }));
      expect(await browser!.contexts()[0].pages()[0].evaluate(() => (window as unknown as { publicDomReady: boolean }).publicDomReady)).toBe(false);
      expect(snapshot.responses).toEqual([]);
      expect(snapshot).not.toHaveProperty("complete"); expect(snapshot).not.toHaveProperty("slots");
    } finally { clearTimeout(timer); release(); await session.close(); }
    await expect(session.execute({ id: 3, action: "open", url: source })).rejects.toThrow("BROWSER_CLOSED");
  }, 25_000);

  it("gives a later admitted document its own content clock and retains that clock on observe", async () => {
    const source = "https://example.org/", destination = "https://example.org/tee-times", asset = "https://assets.example.org/pending.js";
    const deadlineAt = new Date(Date.now() + 90_000), originalDeadline = deadlineAt.getTime(), realNow = Date.now.bind(Date);
    let release!: () => void;
    const pendingAsset = new Promise<void>(resolve => { release = resolve; });
    const fixture = `<html><body><span>Loading</span><script>setTimeout(()=>{const a=document.createElement('a');a.href='/availability';a.textContent='View tee times';document.body.append(a)},1500)</script>` +
      `<script defer src="${asset}"></script></body></html>`;
    const fetcher = vi.fn(async value => {
      if (String(value) === asset) { await pendingAsset; return new Response("/* public asset */", { headers: { "content-type": "application/javascript" } }); }
      return new Response(String(value) === source ? `<h1>Public Golf</h1><a href="${destination}">Book tee times</a>` : fixture,
        { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const initial = await session.execute({ id: 1, action: "open", url: source });
      clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 35_000);
      const followed = await session.execute({ id: 2, action: "click", target: initial.controls.find(control => control.href === destination)!.target });
      expect(followed.controls).toContainEqual(expect.objectContaining({ name: "View tee times", href: "https://example.org/availability" }));
      expect(followed.initialContentWaitMs).toBeGreaterThan(200);
      expect(followed.navigationElapsedMs).toBeLessThan(7_000);
      expect(followed.loading).toBe(true);
      const observed = await session.execute({ id: 3, action: "observe" });
      expect(observed.navigationElapsedMs!).toBeGreaterThan(followed.navigationElapsedMs! + 600);
      expect(observed.navigationElapsedMs).toBeLessThan(9_000);
      expect(deadlineAt.getTime()).toBe(originalDeadline);
    } finally { clock?.mockRestore(); release(); await session.close(); }
  }, 25_000);

  it("uses the exact observed document href instead of unrelated delegated click handlers", async () => {
    const source = "https://example.org/", destination = "https://example.org/tee-times";
    const fetcher = vi.fn(async value => new Response(String(value) === source
      ? `<html><body><h1>Public golf</h1><a id="book" href="${destination}">Book tee times</a><script>document.addEventListener('click',e=>{e.preventDefault();document.body.append(' delegated click ran');});</script></body></html>`
      : "<html><body><h1>Next booking page</h1></body></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now()+20_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless:true }),
      requestLease: async (_family, work) => ({ acquired:true, value:await work() }),
    });
    try {
      const snapshot = await session.execute({id:1,action:"open",url:source});
      const link = snapshot.controls.find(control=>control.name==="Book tee times")!;
      const next = await session.execute({id:2,action:"click",target:link.target});
      expect(next.url).toBe(destination); expect(next.text).toContain("Next booking page");
      expect(next.text).not.toContain("delegated click ran");
    } finally { await session.close(); }
  },25_000);
  it.each(["https://public-rentals.book.teeitup.com/", "https://public-rentals.book-v2.teeitup.golf/"])("opens only an exact visible official iframe source as a separate guarded main page: %s", async visible => {
    const official = "https://example.org/", hidden = "https://hidden-rentals.book.teeitup.com/";
    const fetcher = vi.fn(async value => new Response(String(value) === official
      ? `<html><body><h1>Public golf rentals</h1><iframe src="${visible}" style="width:400px;height:200px"></iframe><iframe hidden src="${hidden}"></iframe></body></html>`
      : "<html><body><h1>Public availability page</h1></body></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], venueOfficialUrl: official, deadlineAt: new Date(Date.now() + 20_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: official });
      expect(snapshot.frames).toContainEqual({ url: visible, source: "OFFICIAL_IFRAME_SRC" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(session.execute({ id: 2, action: "open", url: hidden })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      const standalone = await session.execute({ id: 3, action: "open", url: visible });
      expect(standalone.text).toContain("Public availability page");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { await session.close(); }
  }, 25_000);
  it("admits the actual unlabeled play iframe after following the official Tee Times page without inventing its book destination", async () => {
    const official = "https://example.org/", teeTimes = `${official}tee-times/`;
    const play = "https://public-course.play.teeitup.com/", book = "https://public-course.book.teeitup.com/";
    const hidden = "https://hidden-course.play.teeitup.com/";
    const fetcher = vi.fn(async value => {
      const url = String(value);
      const html = url === official ? `<h1>Example Golf Club</h1><a href="${teeTimes}">Book Now</a>` : url === teeTimes
        ? `<h1>Book a Tee Time</h1><iframe src="${play}" style="width:400px;height:200px"></iframe><iframe hidden src="${hidden}"></iframe>`
        : url === play ? `<h1>Public tee times</h1><a href="${book}">View tee times</a>` : "<h1>Official booking availability</h1>";
      return new Response(`<html><body>${html}</body></html>`, { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], venueOfficialUrl: official, deadlineAt: new Date(Date.now() + 25_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const home = await session.execute({ id: 1, action: "open", url: official });
      const booking = await session.execute({ id: 2, action: "click", target: home.controls.find(control => control.href === teeTimes)!.target });
      expect(booking).toMatchObject({ url: teeTimes, navigationStatus: 200, frames: [{ url: play, source: "OFFICIAL_IFRAME_SRC" }] });
      expect(fetcher.mock.calls.map(args => String(args[0]))).toEqual([official, teeTimes]);
      await expect(session.execute({ id: 3, action: "open", url: book })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      await expect(session.execute({ id: 4, action: "open", url: hidden })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      const standalone = await session.execute({ id: 5, action: "open", url: play });
      expect(standalone.controls).toContainEqual(expect.objectContaining({ href: book, name: "View tee times" }));
      expect(fetcher.mock.calls.map(args => String(args[0]))).toEqual([official, teeTimes, play]);
      const observedBook = await session.execute({ id: 6, action: "open", url: book });
      expect(observedBook.text).toContain("Official booking availability");
    } finally { await session.close(); }
  }, 30_000);
  it.each(["unverified client URL", "failed document"])("does not expose a new play frame using an old or unsuccessful main-document response: %s", async scenario => {
    const official = "https://example.org/", play = "https://public-course.play.teeitup.com/";
    const html = `<html><body><h1>Public golf</h1><iframe src="${play}" style="width:400px;height:200px"></iframe>` +
      (scenario === "unverified client URL" ? '<script>history.replaceState(null,"","/unverified-booking-page");</script>' : "") + "</body></html>";
    const fetcher = vi.fn(async () => new Response(html, { status: scenario === "failed document" ? 403 : 200,
      headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], venueOfficialUrl: official, deadlineAt: new Date(Date.now() + 20_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: official });
      expect(snapshot.frames).not.toContainEqual(expect.objectContaining({ url: play, source: "OFFICIAL_IFRAME_SRC" }));
      expect(fetcher).toHaveBeenCalledOnce();
      await expect(session.execute({ id: 2, action: "open", url: play })).rejects.toThrow("UNOBSERVED_NAVIGATION");
    } finally { await session.close(); }
  }, 25_000);
  it.each([100, 129])("retains completed public assets independently of the lossy model request window (%i assets)", async count => {
    const source = "https://example.org/", urls = Array.from({ length: count }, (_, index) =>
      `https://example.org/public-${index}-${"a".repeat(120)}.js`);
    const html = `<h1>Public golf</h1><a href="/times">Book tee times</a>${urls.map(url => `<script defer src="${url}"></script>`).join("")}`;
    const fetcher = vi.fn(async value => {
      const url = String(value);
      if (url === source) return new Response(html, { headers: { "content-type": "text/html" } });
      if (urls.includes(url)) return new Response(`window.assetCount=(window.assetCount||0)+1;${url === urls.at(-1) ?
        "Promise.all(Array.from({length:20},(_,i)=>fetch('/public-data-'+i).then(r=>r.json()))).then(()=>window.fixtureDone=true)" : ""}`,
      { headers: { "content-type": "application/javascript" } });
      return new Response('{"ready":true}', { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now() + 25_000) }, {
      fetch: fetcher, launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const first = await session.execute({ id: 1, action: "open", url: source });
      await browser!.contexts()[0].pages()[0].waitForFunction(() => (window as unknown as { fixtureDone?: boolean }).fixtureDone === true);
      const settled = await session.execute({ id: 2, action: "observe" });
      const completed = [...(first.completedPublicAssetRequests ?? []), ...(settled.completedPublicAssetRequests ?? [])];
      expect(new Set(completed.map(row => row.url)).size).toBe(Math.min(count, 128));
      expect(completed.every(row => Object.keys(row).sort().join(",") === "method,resourceType,status,url" && row.method === "GET" && row.resourceType === "script" && row.status === 200)).toBe(true);
      expect(first.requests.length + settled.requests.length).toBeLessThan(count + 21);
      expect(settled.completedPublicAssetRequestsOverflow).toBe(count > 128);
      const next = await session.execute({ id: 3, action: "observe" });
      expect(next.completedPublicAssetRequests).toEqual([]); expect(next.completedPublicAssetRequestsOverflow).toBe(count > 128);
      expect(Buffer.byteLength(JSON.stringify(completed))).toBeLessThanOrEqual(64_000);
    } finally { await session.close(); }
  }, 30_000);

  it("retains completed assets when an adapter action fails after building its snapshot", async () => {
    const source = "https://example.org/", asset = "https://example.org/late-public.js";
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    // The synthetic returned source proof cannot replace the missing private
    // document token. Its existing post-snapshot gate must still reject.
    const inspectAdapter = vi.fn(async () => ({ adapter: { family: "TEEITUP", officialBookingSourceProof: {} } as unknown as NonNullable<DiscoveryBrowserSnapshot["adapter"]> }));
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], venueName: "Public venue", deadlineAt: new Date(Date.now() + 20_000) }, {
      inspectAdapter, fetch: vi.fn(async value => new Response(String(value) === source ? "<h1>Public golf</h1>" : "/* public script */",
        { headers: { "content-type": String(value) === source ? "text/html" : "application/javascript" } })) as unknown as typeof fetch,
      launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      await session.execute({ id: 1, action: "open", url: source });
      await browser!.contexts()[0].pages()[0].evaluate(url => new Promise<void>((resolve, reject) => {
        const script = document.createElement("script"); script.src = url; script.onload = () => resolve(); script.onerror = () => reject(new Error("FIXTURE_SCRIPT_FAILED")); document.head.append(script);
      }), asset);
      await expect(session.execute({ id: 2, action: "inspect_adapter", url: source })).rejects.toThrow("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
      const recovered = await session.execute({ id: 3, action: "observe" });
      expect(recovered.completedPublicAssetRequests).toEqual([{ url: asset, method: "GET", resourceType: "script", status: 200 }]);
      expect((await session.execute({ id: 4, action: "observe" })).completedPublicAssetRequests).toEqual([]);
    } finally { await session.close(); }
  }, 25_000);

  it("publishes only fulfilled successful script and stylesheet evidence, excluding failed, redirected and data requests", async () => {
    const source = "https://example.org/", good = "https://example.org/public.js", style = "https://example.org/public.css";
    const html = '<h1>Public golf</h1><link rel="stylesheet" href="/public.css"><script defer src="/public.js"></script>' +
      '<script defer src="/failed.js"></script><script defer src="/redirect.js"></script><script defer src="/denied.js?access_token=private"></script>';
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const fetcher = vi.fn(async value => {
      const url = String(value);
      if (url === source) return new Response(html, { headers: { "content-type": "text/html" } });
      if (url.endsWith("/failed.js")) return new Response("/* unavailable */", { status: 503 });
      if (url.endsWith("/redirect.js")) return new Response("", { status: 302, headers: { location: "/redirect-target.js" } });
      if (url === style) return new Response("body{}", { headers: { "content-type": "text/css" } });
      if (url === good) return new Response("fetch('/public-data').then(()=>window.fixtureDone=true)", { headers: { "content-type": "application/javascript" } });
      return new Response('{"ready":true}', { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now() + 20_000) }, {
      fetch: fetcher, launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const first = await session.execute({ id: 1, action: "open", url: source });
      await browser!.contexts()[0].pages()[0].waitForFunction(() => (window as unknown as { fixtureDone?: boolean }).fixtureDone === true);
      const second = await session.execute({ id: 2, action: "observe" });
      expect([...(first.completedPublicAssetRequests ?? []), ...(second.completedPublicAssetRequests ?? [])].sort((a, b) => a.url.localeCompare(b.url)))
        .toEqual([{ url: style, method: "GET", resourceType: "stylesheet", status: 200 }, { url: good, method: "GET", resourceType: "script", status: 200 }]);
      expect(vi.mocked(fetcher).mock.calls.some(([url]) => String(url).includes("access_token") || String(url).includes("redirect-target"))).toBe(false);
    } finally { await session.close(); }
  }, 25_000);

  it("loads observed public versioned scripts while blocking credential-bearing companions", async () => {
    const official = "https://example.org/", asset = "https://example.org/wp-includes/js/dist/hooks.min.js?ver=f0f188028580e8dc1255";
    const denied = `${asset}&token=private`;
    const fetcher = vi.fn(async value => String(value) === official
      ? new Response(`<html><body><h1>Public Golf</h1><script src="${asset}"></script><script src="${denied}"></script></body></html>`, { headers: { "content-type": "text/html" } })
      : new Response('document.querySelector("h1").textContent="Public availability loaded"', { headers: { "content-type": "application/javascript" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], deadlineAt: new Date(Date.now() + 20_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: official });
      expect(snapshot.text).toContain("Public availability loaded");
      expect(fetcher.mock.calls.map(args => String(args[0]))).toEqual([official, asset]);
      expect(snapshot.requestFailures).toContainEqual(expect.objectContaining({ url: "https://example.org/wp-includes/js/dist/hooks.min.js", reason: "UNSAFE_URL" }));
      expect(JSON.stringify(snapshot.requestFailures)).not.toContain("private");
    } finally { await session.close(); }
  }, 25_000);
  it("initializes public widgets through ancillary reads without exposing them as inventory or navigation", async () => {
    const official = "https://example.org/";
    const settings = "https://example.org/App/GlobalTenantSettings";
    const authentication = "https://example.org/AuthenticationSettings?AuthenticationType=";
    const venue = "https://example.org/api/venue_info?venue_url_key=public-golf-club&widget_type=reservations&modify_upgrades=false";
    const denied = `${venue}&token=private-fixture`;
    const urls = [settings, authentication, venue, "https://example.org/Booking/Teetimes/GetReadOnlyTeeSheet"];
    const fetcher = vi.fn(async value => String(value) === official
      ? new Response(`<html><body><h1>Loading public filters</h1><script>
        Promise.all(${JSON.stringify(urls)}.map(url=>fetch(url).then(response=>response.json())))
          .then(()=>document.querySelector('h1').textContent='Public filters ready');
        fetch(${JSON.stringify(denied)}).catch(()=>{});
        </script></body></html>`, { headers: { "content-type": "text/html" } })
      : new Response(JSON.stringify({ venue: "Example Golf", complete: true, empty: true, settings: "public" }),
        { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], deadlineAt: new Date(Date.now() + 20_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: official });
      expect(snapshot.text).toContain("Public filters ready");
      expect(fetcher.mock.calls.map(args => String(args[0]))).toEqual([official, ...urls]);
      expect(snapshot.requests.filter(row => urls.includes(row.url))).toHaveLength(urls.length);
      expect(snapshot.requests.filter(row => urls.includes(row.url)).every(row => row.readPurpose === "PUBLIC_BOOTSTRAP")).toBe(true);
      expect(snapshot.responses).toEqual([]);
      for (const url of urls) await expect(session.execute({ id: url, action: "open", url })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(snapshot.requestFailures).toContainEqual(expect.objectContaining({ reason: "UNSAFE_URL" }));
      expect(JSON.stringify(snapshot.requestFailures)).not.toContain("private-fixture");
    } finally { await session.close(); }
  }, 25_000);
  it("keeps native bootstrap redirects out of navigation and inventory authority", async () => {
    const official = "https://example.org/", bootstrap = `${official}App/GlobalTenantSettings`, redirected = `${official}public-data`;
    const seen: string[] = [];
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const url = route.request().url(); seen.push(url);
      const status = url === bootstrap ? 302 : 200;
      const body = Buffer.from(url === official ? '<h1>Public Golf</h1><script>fetch("/App/GlobalTenantSettings").catch(()=>{});</script>' : "");
      const headers = url === bootstrap ? { "content-type": "application/json", location: redirected } : { "content-type": "text/html" };
      await route.fulfill({ status, headers, body }); return { status, url, headers, body };
    });
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, pendingReads: 0, lastFailure: undefined, releasePlaywrightRoute: route => handler(route),
    }));
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], deadlineAt: new Date(Date.now() + 20_000) }, {
      browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: official });
      expect(seen).toEqual([official, bootstrap]);
      expect(snapshot.responses).toEqual([]);
      expect(snapshot.requestFailures).toContainEqual(expect.objectContaining({ reason: "UNSAFE_REDIRECT" }));
      await expect(session.execute({ id: 2, action: "open", url: redirected })).rejects.toThrow("UNOBSERVED_NAVIGATION");
    } finally { await session.close(); native.mockRestore(); routing.mockRestore(); }
  }, 25_000);
  it("retains body-free request diagnostics after the first navigation fails", async () => {
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 15_000) }, {
      fetch: vi.fn(async () => { throw new Error("FIXTURE_NETWORK_FAILURE"); }) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      await expect(session.execute({ id: 1, action: "open", url: "https://example.org/" })).rejects.toThrow();
      expect(session.diagnostics()).toMatchObject({ requests: [expect.objectContaining({ url: "https://example.org/", blockedReason: "FIXTURE_NETWORK_FAILURE" })],
        requestFailures: [expect.objectContaining({ reason: "FIXTURE_NETWORK_FAILURE" })] });
      expect(session.diagnostics()).not.toHaveProperty("text");
      expect(session.diagnostics().requests[0]).not.toHaveProperty("body");
    } finally { await session.close(); }
  }, 20_000);
  it("bounds a 3000-control scan before per-control inspection without losing its lower public link", async () => {
    const fixture = '<h1>Public Golf</h1>' + Array.from({ length: 2999 }, (_, index) => `<button>Decorative ${index}</button>`).join('') +
      '<a href="https://booking.example.org/calendar">Book Your Tee Time</a>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 25_000), initialUrls: ['https://example.org/'] }, {
      fetch: async () => new Response(fixture, { headers: { 'content-type': 'text/html' } }),
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const startedAt = Date.now();
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(initial.controls).toHaveLength(1);
      expect(initial.controls[0]).toMatchObject({ name: 'Book Your Tee Time', href: 'https://booking.example.org/calendar' });
    } finally { await session.close(); }
  }, 30_000);
  it("rebuilds a snapshot after client navigation replaces an enumerated control list without repeating the click", async () => {
    const fixture = `<html><body><h1>Public Golf</h1><a href="/times" onclick="event.preventDefault();window.publicClicks=(window.publicClicks||0)+1;history.pushState({},'',this.href);document.body.innerHTML='<h1>Loading public choices</h1>'+Array.from({length:120},(_,i)=>'<button>Next '+i+'</button>').join('');setTimeout(()=>{document.body.innerHTML='<h1>Public availability ready</h1><button>Next date</button>'},425)">Book Your Tee Time</a></body></html>`;
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const fetch = vi.fn(async () => new Response(fixture, { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 25_000), initialUrls: ['https://example.org/'] }, {
      fetch, launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      const link = initial.controls.find(control => control.name === 'Book Your Tee Time')!;
      const startedAt = Date.now();
      const followed = await session.execute({ id: 2, action: 'click', target: link.target });
      expect(Date.now() - startedAt).toBeLessThan(6000);
      expect(followed.url).toBe('https://example.org/times');
      expect(followed.text).toBe('Public availability ready\nNext date');
      expect(followed.controls.map(control => control.name)).toEqual(['Next date']);
      expect(await browser!.contexts()[0].pages()[0].evaluate(() => (window as unknown as { publicClicks: number }).publicClicks)).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await session.close(); }
  }, 30_000);
  it("preserves safe same-tab client navigation while following a public any-time filter", async () => {
    const fixture = '<html><body><h1>Public Golf</h1><a href="/times?Time=AnyTime" onclick="event.preventDefault();history.pushState({},\'\',this.href);document.querySelector(\'h1\').textContent=\'Client rendered availability\'">Book Your Tee Time</a></body></html>';
    const fetch = vi.fn(async () => new Response(fixture, { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 25_000), initialUrls: ['https://example.org/'] }, {
      fetch, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      const link = initial.controls.find(control => control.name === 'Book Your Tee Time')!;
      const followed = await session.execute({ id: 2, action: 'click', target: link.target });
      expect(followed.url).toBe('https://example.org/times?Time=AnyTime');
      expect(followed.text).toContain('Client rendered availability');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await session.close(); }
  }, 30_000);
  it("finds a public booking link beyond 180 hidden, irrelevant and ordinary navigation controls", async () => {
    const fixture = '<html><body><h1>Public Golf</h1>' +
      Array.from({ length: 190 }, (_, i) => `<button hidden>Hidden${i}</button><button>Decorative${i}</button><a href="/section${i}">Section${i}</a>`).join('') +
      '<a id="book-link" href="https://booking.example.org/calendar">Book Your Tee Time</a></body></html>';
    const fetch = vi.fn(async value => new Response(String(value).includes('booking.example.org') ? '<h1>Public tee times</h1>' : fixture,
      { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 45_000), initialUrls: ['https://example.org/'] }, {
      fetch, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      expect(initial.controls.length).toBeLessThanOrEqual(180);
      const link = initial.controls.find(control => control.name === 'Book Your Tee Time')!;
      expect(link).toMatchObject({ kind: 'link', href: 'https://booking.example.org/calendar' });
      expect((await session.execute({ id: 2, action: 'click', target: link.target })).url).toBe(link.href);
    } finally { await session.close(); }
  }, 50_000);
  it.each(['follow', 'stale'])("promotes a unique rendered inspected public link beyond the output cap: %s", async mode => {
    const fixture = '<html><body><h1>Public Golf</h1>' +
      Array.from({ length: 190 }, (_, i) => `<a href="/booking${i}">Book a session${i}</a>`).join('') +
      '<a id="late-public-link" href="https://booking.example.org/calendar">Golf Tee Times</a></body></html>';
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 45_000), initialUrls: ['https://example.org/'] }, {
      fetch: async value => new Response(String(value).includes('booking.example.org') ? '<h1>Public tee times</h1>' : fixture, { headers: { 'content-type': 'text/html' } }),
      launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      expect(initial.controls.some(control => control.name === 'Golf Tee Times')).toBe(false);
      const observed = initial.elements.find(element => element.text === 'Golf Tee Times')!;
      expect(observed).toBeDefined();
      await expect(session.execute({ id: 10, action: 'open', url: 'https://booking.example.org/calendar' })).rejects.toThrow('UNOBSERVED_NAVIGATION');
      const inspected = await session.execute({ id: 2, action: 'inspect', selector: observed.selector });
      const link = inspected.controls.find(control => control.selector === observed.selector)!;
      expect(link).toMatchObject({ kind: 'link', href: 'https://booking.example.org/calendar' });
      expect(inspected.controls).toHaveLength(180);
      expect(inspected.structure?.ancestors[0]).toMatchObject({ href: link.href, target: link.target });
      if (mode === 'follow') expect((await session.execute({ id: 3, action: 'click', target: link.target })).url).toBe(link.href);
      else {
        await browser!.contexts()[0].pages()[0].evaluate(() => { (document.getElementById('late-public-link') as HTMLAnchorElement).href = 'https://example.org/checkout'; });
        await expect(session.execute({ id: 3, action: 'click', target: link.target })).rejects.toThrow('STALE_OR_UNKNOWN_CONTROL');
      }
    } finally { await session.close(); }
  }, 50_000);
  it("does not promote inspected unsafe, private, transaction or hidden links", async () => {
    const urls = ['https://127.0.0.1/private', 'https://example.org/login', 'https://example.org/checkout', 'https://example.org/calendar?slot=123'];
    const fixture = '<html><body><h1>Public Golf</h1>' +
      Array.from({ length: 190 }, (_, i) => `<a href="/booking${i}">Book a session${i}</a>`).join('') +
      urls.map((url, i) => `<a id="denied${i}" href="${url}">Golf availability${i}</a>`).join('') +
      '<a id="hidden-link" hidden href="https://hidden.example.org/calendar">Hidden golf availability</a></body></html>';
    const fetch = vi.fn(async () => new Response(fixture, { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 60_000), initialUrls: ['https://example.org/'] }, {
      fetch, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      let current = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      for (let index = 0; index < urls.length; index++) {
        const node = current.elements.find(element => element.text === `Golf availability${index}`)!;
        current = await session.execute({ id: index + 2, action: 'inspect', selector: node.selector });
        expect(current.controls.some(control => control.href === urls[index])).toBe(false);
        expect(current.structure?.ancestors[0].href).toBeUndefined();
        await expect(session.execute({ id: 10 + index, action: 'open', url: urls[index] })).rejects.toThrow('UNOBSERVED_NAVIGATION');
      }
      expect(current.elements.some(element => element.text === 'Hidden golf availability')).toBe(false);
      await expect(session.execute({ id: 20, action: 'inspect', selector: '[id="hidden-link"]' })).rejects.toThrow('STALE_OR_UNKNOWN_ELEMENT');
    } finally { await session.close(); }
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 65_000);
  it.each([false, true])("corroborates official address visibility, including transparent ancestors: %s", async hidden => {
    const officialUrl = "https://example.org/", bookingUrl = "https://harbor.book.teeitup.com/";
    const fixture = '<html><head><title>Harbor Golf Club</title></head><body><h1>Harbor Golf Club</h1>' +
      `<div${hidden ? ' style="opacity:0"' : ''}><p>20 Harbor Road<br>Example, NY 12345, US</p></div>` +
      `<a href="${bookingUrl}">Tee Times</a><script>document.querySelector("p").className="browser-added-layout";</script></body></html>`;
    const inspectAdapter = vi.fn(async (source, deps) => ({ adapter: { family: "TEEITUP" as const, alias: "harbor", facilityIds: [11],
      officialIdentityProof: deriveTeeItUpOfficialIdentityProof(source, deps.officialIdentityPage!, { requireVisibleEvidence: true }) } }));
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: [officialUrl],
      venueOfficialUrl: officialUrl, venueName: "Harbor Golf Course", venueAddress: "10 Harbor Drive, Example, NY 12345, US", timeZone: "America/New_York" }, {
      fetch: async () => new Response(fixture, { headers: { "content-type": "text/html" } }),
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }), inspectAdapter,
    });
    try {
      await session.execute({ id: 1, action: "open", url: officialUrl });
      const result = session.execute({ id: 2, action: "inspect_adapter", url: bookingUrl });
      if (hidden) await expect(result).rejects.toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
      else expect((await result).adapter).toMatchObject({ officialIdentityProof: deriveTeeItUpOfficialIdentityProof({ officialUrl, bookingUrl,
        venueName: "Harbor Golf Course", venueAddress: "10 Harbor Drive, Example, NY 12345, US", timeZone: "America/New_York" }, { url: officialUrl, html: fixture }) });
    } finally { await session.close(); }
  }, 25_000);
  it("exposes proven numeric div dates as opaque controls and clicks only the current calendar", async () => {
    const fixture = '<!doctype html><html><body><h1>Public simulator</h1><div data-testid="variable-week-calendar"><h2>October 2030</h2><div>Mo Tu We Th Fr Sa Su</div>' +
      '<div data-testid="calendar-day-2030-10-23" aria-label="2030-10-23 AvailabilityLoaded"><span>23</span></div></div><p id="result">Unselected</p>' +
      '<script>document.querySelector("[data-testid=calendar-day-2030-10-23]").onclick=()=>document.querySelector("#result").textContent="Selected October 23";</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 20_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      const dates = snapshot.controls.filter(control => control.kind === "calendar" && control.name === "23");
      expect(dates).toHaveLength(1);
      const selected = await session.execute({ id: 2, action: "click", target: dates[0].target });
      expect(selected.text).toContain("Selected October 23");
      await expect(session.execute({ id: 3, action: "click", target: dates[0].target })).rejects.toThrow("STALE_OR_UNKNOWN_CONTROL");
    } finally { await session.close(); }
  }, 25_000);
  it.each([
    { text: "You must sign in to view tee times.", expected: true },
    { text: "You must sign in to book. Public tee times are shown below.", expected: false },
  ])("reports observed access requirements without treating booking policy as access: $expected", async ({ text, expected }) => {
    const url = "https://example.org/";
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: [url] }, {
      fetch: async () => new Response(`<!doctype html><html><body><h1>Public golf</h1><p>${text}</p></body></html>`,
        { headers: { "content-type": "text/html" } }),
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try { expect((await session.execute({ id: 1, action: "open", url })).accessRequirementObserved).toBe(expected); }
    finally { await session.close(); }
  }, 20_000);
  it.each([403, 429])("retains main-document HTTP %i for a hash-routed public link", async status => {
    const url = "https://example.org/booking?course=12#teetimes";
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: [url] }, {
      browserTransport: "PINNED_HTTP",
      fetch: vi.fn(async () => new Response("<!doctype html><html><body><h1>Public booking document unavailable</h1></body></html>",
        { status, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const result = await session.execute({ id: 1, action: "open", url });
      expect(result.url).toBe(url);
      expect(result.navigationStatus).toBe(status);
    } finally { await session.close(); }
  }, 20_000);
  it("does not reuse a document's status after a client-side query change", async () => {
    const url = "https://example.org/booking?course=12#teetimes";
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: [url] }, {
      browserTransport: "PINNED_HTTP",
      fetch: vi.fn(async () => new Response('<!doctype html><html><body><h1>Public booking document unavailable</h1><script>history.replaceState(null,"","?course=13#teetimes")</script></body></html>',
        { status: 403, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const result = await session.execute({ id: 1, action: "open", url });
      expect(result.url).toBe("https://example.org/booking?course=13#teetimes");
      expect(result.navigationStatus).toBeUndefined();
    } finally { await session.close(); }
  }, 20_000);
  it("waits for initial delayed public content without a manual observe or reload", async () => {
    const fixture = '<!doctype html><html><body><a href="#">×</a><script>fetch("/api/content").then(r=>r.json()).then(()=>{document.body.innerHTML="<h1>Public golf</h1><a href=\'/times\'>Book a tee time</a>";});</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 20_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async value => {
        if (String(value).endsWith("/api/content")) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          return new Response("{}", { headers: { "content-type": "application/json" } });
        }
        return new Response(fixture, { headers: { "content-type": "text/html" } });
      }) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(snapshot.text).toContain("Public golf");
      expect(snapshot.controls).toContainEqual(expect.objectContaining({ name: "Book a tee time", kind: "link" }));
      expect(snapshot.initialContentWaitMs).toBeGreaterThan(900);
      expect(snapshot.navigationElapsedMs).toBeGreaterThanOrEqual(1500);
      expect(snapshot.pendingRequestCount).toBe(0);
      expect(snapshot.requests).toContainEqual(expect.objectContaining({ url: "https://example.org/api/content", status: 200 }));
    } finally { await session.close(); }
  }, 25_000);
  it("returns usable public controls promptly while unrelated reads are pending", async () => {
    const fixture = '<!doctype html><html><body><a href="/times">Book a tee time</a><script>fetch("/slow").catch(()=>{});</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 20_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async (value, options) => {
        if (String(value).endsWith("/slow")) return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response("{}")), 5000);
          options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("CANCELLED")); }, { once: true });
        });
        return new Response(fixture, { headers: { "content-type": "text/html" } });
      }) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const startedAt = Date.now();
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(snapshot.controls).toContainEqual(expect.objectContaining({ name: "Book a tee time", kind: "link" }));
      expect(snapshot.loading).toBe(true);
      expect(snapshot.initialContentWaitMs).toBeLessThan(500);
    } finally { await session.close(); }
  }, 25_000);
  it("keeps a rendered page loading until native response capture finishes after the shared handler", async () => {
    const fixture = '<!doctype html><html><body><h1>Public golf availability ready</h1><a href="/times">View tee times</a><script>fetch("/api/public").catch(()=>{})</script></body></html>';
    let release: () => void = () => {}, pending = 0;
    const captured = new Promise<void>(resolve => { release = resolve; });
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, get lastFailure() { return undefined; },
      get pendingReads() { return pending; },
      releasePlaywrightRoute: async route => {
        pending++;
        try {
          // Unit transport seam: real CDP owns this invocation in production.
          await handler(route);
          if (route.request().url().endsWith("/api/public")) await captured;
        } finally { pending--; }
      },
    }));
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const isJson = route.request().url().endsWith("/api/public");
      const body = Buffer.from(isJson ? '{"complete":true}' : fixture), headers = { "content-type": isJson ? "application/json" : "text/html" };
      await route.fulfill({ status: 200, headers, body });
      return { status: 200, url: route.request().url(), headers, body };
    });
    try {
      session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 20_000) }, {
        browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
        requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      });
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(opened.text).toContain("Public golf availability ready");
      expect(opened.loading).toBe(true); expect(opened.pendingRequestCount).toBe(1);
      expect(session.diagnostics()).toMatchObject({ loading: true, pendingRequestCount: 1 });
      expect(opened.requestCount).toBe(2);
      expect(opened.responses).toContainEqual(expect.objectContaining({ url: "https://example.org/api/public", status: 200 }));
      release();
      const settled = await session.execute({ id: 2, action: "observe" });
      expect(settled.loading).toBe(false); expect(settled.pendingRequestCount).toBe(0);
      expect(settled.requestCount).toBe(2);
      expect(settled.responses).toEqual([]); // Each response snapshot drains once.
    } finally { release(); await session?.close(); native.mockRestore(); routing.mockRestore(); }
  }, 25_000);
  it("retains the first fatal native guard projection when later open and observe calls fail", async () => {
    const fatal = { code: "NATIVE_REDIRECT_POST_BODY_MISSING", url: "https://example.org/collect", method: "POST", resourceType: "xhr",
      interceptedRequests: 12, recordCount: 8, requestLimit: 1024, hasPostData: true, postDataPresent: false, postDataBytes: 0 };
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, _handler, options) => {
      options?.onFailure?.(fatal.code);
      return { prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, pendingReads: 0, lastFailure: fatal.code,
        get firstFatal() { return { ...fatal }; }, releasePlaywrightRoute: async route => { await route.abort(); } };
    });
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
    try {
      session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 10_000) }, {
        browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
        requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      });
      await expect(session.execute({ id: 1, action: "open", url: "https://example.org/" })).rejects.toThrow(fatal.code);
      expect(session.diagnostics().nativeFirstFatal).toEqual(fatal);
      expect(session.diagnostics().requestFailures).toContainEqual({ reason: fatal.code, resourceType: "other" });
      await expect(session.execute({ id: 2, action: "observe" })).rejects.toThrow(fatal.code);
      expect(session.diagnostics().nativeFirstFatal).toEqual(fatal);
    } finally { await session?.close(); routing.mockRestore(); }
  }, 15_000);
  it("rejects a fatal native guard that arrives after document commit while its snapshot is settling", async () => {
    const fatal = { code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT" as const, url: "https://example.org/public.js", method: "GET", resourceType: "script" };
    let notifyFailure: ((code: string) => void) | undefined, failed = false;
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler, options) => {
      notifyFailure = options?.onFailure;
      return { prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, pendingReads: 0, get lastFailure() { return failed ? fatal.code : undefined; },
        get firstFatal() { return failed ? { ...fatal } : undefined; }, releasePlaywrightRoute: route => handler(route) };
    });
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const body = Buffer.from('<h1>Public golf</h1><a href="/times">View tee times</a>'), headers = { "content-type": "text/html" };
      await route.fulfill({ status: 200, headers, body });
      setTimeout(() => { failed = true; notifyFailure?.(fatal.code); }, 10);
      return { status: 200, url: route.request().url(), headers, body };
    });
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
    try {
      session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 15_000) }, {
        browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
        requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      });
      await expect(session.execute({ id: 1, action: "open", url: "https://example.org/" })).rejects.toThrow(fatal.code);
      expect(session.diagnostics().nativeFirstFatal).toEqual(fatal);
    } finally { await session?.close(); native.mockRestore(); routing.mockRestore(); }
  }, 20_000);
  it.each([
    { code: "NATIVE_REDIRECT_POST_BODY_LIMIT", url: "https://example.org/collect", method: "POST", resourceType: "xhr", postDataBytes: 40000 },
    { code: "NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED", url: "https://cdn.example.net/public.js", method: "GET", resourceType: "script" },
    { code: "NATIVE_REDIRECT_RESOURCE_KIND_REJECTED", url: "https://example.org/public.js", method: "GET", resourceType: "other" },
  ])("keeps $code rejection diagnostics nonterminal while public controls render", async rejected => {
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler, options) => {
      options?.onRequestRejected?.(rejected);
      return { prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, pendingReads: 0, lastFailure: undefined,
        get rejectedRequests() { return [{ ...rejected }]; }, releasePlaywrightRoute: route => handler(route) };
    });
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const body = Buffer.from('<!doctype html><h1>Public golf availability</h1><a href="/times">View tee times</a>'), headers = { "content-type": "text/html" };
      await route.fulfill({ status: 200, headers, body }); return { status: 200, url: route.request().url(), headers, body };
    });
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
    try {
      session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 10_000) }, {
        browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
        requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      });
      const observed = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(observed.controls).toContainEqual(expect.objectContaining({ name: "View tee times", kind: "link" }));
      expect(observed.nativeFirstFatal).toBeUndefined(); expect(observed.nativeRejectedRequests).toEqual([rejected]);
      expect(observed.requestFailures).toContainEqual({ reason: rejected.code, url: rejected.url, resourceType: rejected.resourceType });
      const again = await session.execute({ id: 2, action: "observe" });
      expect(again.controls).toContainEqual(expect.objectContaining({ name: "View tee times", kind: "link" }));
      expect(again.nativeFirstFatal).toBeUndefined(); expect(session.diagnostics().nativeRejectedRequests).toEqual([rejected]);
    } finally { await session?.close(); native.mockRestore(); routing.mockRestore(); }
  }, 15_000);
  const pageHtml = '<!doctype html><html><body><h1>Sample simulator</h1><label for="duration">Duration</label>' +
    '<p>First time, you will have to select a picture in CAPTCHA when booking.</p>' +
    '<span id="visible-date">Thursday, October 22, 2026</span>' +
    '<select id="duration"><option value="30">30 minutes</option><option value="60">60 minutes</option></select>' +
    '<button id="book">Book now</button><a href="/times">View available times</a>' +
    '<input type="date" aria-label="Date" value="2026-10-22"><script>fetch("/api/public");</script></body></html>';
  async function setup() {
    const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const json = String(url).endsWith("/api/public");
      return new Response(json ? JSON.stringify({ date: "2026-10-22", capacity: 4, token: "keep-private" }) : pageHtml,
        { headers: { "content-type": json ? "application/json" : "text/html" } });
    }) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 40_000), initialUrls: ["https://example.org/simulator"] }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    return { session, fetcher };
  }
  it("observes selectors, public JSON and safe selects, without offering Book", async () => {
    const { session } = await setup();
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      expect(opened.text).toContain("Sample simulator");
      expect(opened.text).toContain("CAPTCHA");
      expect(opened.controls.some(control => control.name === "Book now")).toBe(false);
      const duration = opened.controls.find(control => control.selector === '[id="duration"]');
      expect(duration?.options).toEqual([{ value: "30", label: "30 minutes" }, { value: "60", label: "60 minutes" }]);
      expect(JSON.stringify(opened.responses)).not.toContain("keep-private");
      expect(opened.responses[0]?.body).toMatchObject({ capacity: 4, token: "[redacted]" });
      expect(opened.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ url: "https://example.org/simulator", method: "GET", resourceType: "document", status: 200 }),
        expect.objectContaining({ url: "https://example.org/api/public", method: "GET", resourceType: "fetch", status: 200 }),
      ]));
      expect(opened.requestCount).toBeGreaterThanOrEqual(2); expect(opened.responseBytes).toBeGreaterThan(0);
      expect(opened.elements).toEqual(expect.arrayContaining([expect.objectContaining({ selector: '[id="visible-date"]', text: "Thursday, October 22, 2026" })]));
      const selected = await session.execute({ id: 2, action: "select", target: duration!.target, option: "60" });
      expect(selected.controls.find(control => control.selector === '[id="duration"]')?.currentValue).toBe("60");
      await expect(session.execute({ id: 3, action: "select", target: duration!.target, option: "30" })).rejects.toThrow("STALE_OR_UNKNOWN_CONTROL");
    } finally { await session.close(); }
  }, 25_000);
  it("opens only initial or observed destinations and rejects fabricated options", async () => {
    const { session, fetcher } = await setup();
    try {
      await expect(session.execute({ id: 1, action: "open", url: "https://outside.example.org/" })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(fetcher).not.toHaveBeenCalled();
      const opened = await session.execute({ id: 2, action: "open", url: "https://example.org/simulator" });
      const duration = opened.controls.find(control => control.selector === '[id="duration"]')!;
      await expect(session.execute({ id: 3, action: "select", target: duration.target, option: "private" })).rejects.toThrow("UNOBSERVED_OPTION");
      const linked = await session.execute({ id: 4, action: "open", url: "https://example.org/times" });
      expect(linked.url).toBe("https://example.org/times");
      const beforeDataNavigation = fetcher.mock.calls.length;
      await expect(session.execute({ id: 5, action: "open", url: "https://example.org/api/public" })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(fetcher).toHaveBeenCalledTimes(beforeDataNavigation);
    } finally { await session.close(); }
  }, 25_000);
  it("inspects only a current observed element and returns bounded real parent structure", async () => {
    const { session, fetcher } = await setup();
    try {
      await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      const before = fetcher.mock.calls.length;
      const inspected = await session.execute({ id: 2, action: "inspect", selector: '[id="visible-date"]' });
      expect(inspected.structure?.selected).toBe('[id="visible-date"]');
      expect(inspected.structure?.ancestors[0]).toMatchObject({ tag: "span", matches: 1, text: "Thursday, October 22, 2026" });
      expect(inspected.structure?.ancestors.some(row => row.tag === "body")).toBe(true);
      expect(JSON.stringify(inspected.structure).length).toBeLessThanOrEqual(6000);
      expect(fetcher).toHaveBeenCalledTimes(before);
      await expect(session.execute({ id: 3, action: "inspect", selector: "#unobserved" })).rejects.toThrow("STALE_OR_UNKNOWN_ELEMENT");
      expect(JSON.stringify(inspected.structure)).not.toContain("fetch(");
    } finally { await session.close(); }
  }, 25_000);
  it("inspects returned focusable controls and continues through returned ancestors without accepting stale or unseen nodes", async () => {
    const fixture = '<!doctype html><html><body><section id="layout"><div id="outer"><div id="middle"><div id="field">' +
      '<div>Duration</div><div tabindex="0" aria-haspopup="listbox"><span>1 Hr</span></div>' +
      '</div></div></div></section><aside><div><b id="unseen">Neutral content</b></div></aside></body></html>';
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as typeof fetch,
      launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      const duration = opened.controls.find(control => control.label === "Duration");
      expect(duration).toBeDefined();
      const inspected = await session.execute({ id: 2, action: "inspect", selector: duration!.selector });
      expect(inspected.structure?.ancestors[0].text).toBe("1 Hr");
      const outer = inspected.structure!.ancestors.find(row => row.selector === '[id="outer"]');
      expect(outer).toBeDefined();
      const continued = await session.execute({ id: 3, action: "inspect", selector: outer!.selector });
      expect(continued.structure?.ancestors[0].selector).toBe('[id="outer"]');
      await expect(session.execute({ id: 4, action: "inspect", selector: '[id="unseen"]' })).rejects.toThrow("STALE_OR_UNKNOWN_ELEMENT");
      await browser!.contexts()[0].pages()[0].locator('[id="outer"]').evaluate(element => element.setAttribute("id", "changed"));
      await expect(session.execute({ id: 5, action: "inspect", selector: '[id="outer"]' })).rejects.toThrow("STALE_OR_UNKNOWN_ELEMENT");
    } finally { await session.close(); }
  }, 25_000);
  it("observes and inspects public time and rental leaves despite generated CSS without granting slot clicks", async () => {
    const fixture = '<!doctype html><html><body><h1>Public golf</h1><main><div id="grid"><div class="r-abc">' +
      '<div>10:00 am</div><div>Sims</div><div>30 min-3 hr</div></div></div></main>' +
      '<div hidden><span>11:00 am</span></div><form><input type="email" value="private@example.org"><div>Private Bay</div><div>12:00 pm</div></form>' +
      '<div>Reserve Bay</div><div id="unseen">Neutral content</div></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(opened.elements).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "10:00 am" }), expect.objectContaining({ text: "Sims" }), expect.objectContaining({ text: "30 min-3 hr" }),
      ]));
      expect(opened.elements.some(element => /Private Bay|11:00 am|12:00 pm|Reserve Bay/u.test(element.text))).toBe(false);
      expect(opened.controls.some(control => /10:00 am|Sims|30 min-3 hr/u.test(control.name))).toBe(false);
      const rental = opened.elements.find(element => element.text === "Sims")!;
      const inspected = await session.execute({ id: 2, action: "inspect", selector: rental.selector });
      expect(inspected.structure?.ancestors.some(row => row.text.includes("10:00 am") && row.text.includes("Sims"))).toBe(true);
      await expect(session.execute({ id: 3, action: "inspect", selector: '[id="unseen"]' })).rejects.toThrow("STALE_OR_UNKNOWN_ELEMENT");
    } finally { await session.close(); }
  }, 25_000);
  it("projects only authorized public-read JSON request bodies", async () => {
    const body = { query: "query Availability { times { startsAt } }", variables: { date: "2026-10-22" } };
    const fixture = '<!doctype html><html><body><h1>Calendar</h1><script>fetch("/graphql",{method:"POST",headers:{"content-type":"application/json"},body:' + JSON.stringify(JSON.stringify(body)) + '});</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/simulator"] }, {
      fetch: vi.fn(async (url: Parameters<typeof fetch>[0]) => new Response(String(url).endsWith("/graphql") ? '{"times":[]}' : fixture, { headers: { "content-type": String(url).endsWith("/graphql") ? "application/json" : "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      expect(snapshot.requests).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", body })]));
      expect(JSON.stringify(snapshot.requests)).not.toContain("headers");
    } finally { await session.close(); }
  }, 25_000);
  it("adds bounded structural evidence for deeply nested public JSON while retaining value redaction", async () => {
    const fixture = '<!doctype html><html><body><h1>Public golf</h1><script>fetch("/api/public");</script></body></html>';
    const payload = { data: { node: { agendas: { edges: [{ node: { availableTimes: [{ startsAt: "2030-10-23T10:00:00-04:00", id: "private-opaque-id", session: { token: "private-token" } }] } }] } } } };
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async url => new Response(String(url).endsWith("/api/public") ? JSON.stringify(payload) : fixture,
        { headers: { "content-type": String(url).endsWith("/api/public") ? "application/json" : "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      const response = opened.responses.find(item => item.url.endsWith("/api/public"))!;
      expect(JSON.stringify(response.body)).toContain("[depth limit]");
      expect(response.schemaEvidence?.kind).toBe("SAMPLED_SCHEMA_ONLY");
      expect(response.schemaEvidence?.fields).toContainEqual(expect.objectContaining({
        path: "data.node.agendas.edges[].node.availableTimes[].startsAt", examples: ["2030-10-23T10:00:00-04:00"],
      }));
      expect(JSON.stringify(response)).not.toMatch(/private-opaque-id|private-token/u);
    } finally { await session.close(); }
  }, 25_000);
  it("caps schema evidence at 24KB across one response snapshot and explicitly marks omitted evidence", async () => {
    const fixture = '<!doctype html><html><body><h1>Public golf</h1><script>Promise.all([1,2,3,4].map(n=>fetch("/api/"+n)));</script></body></html>';
    const payload = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`field_${String(index).padStart(3, "0")}_${"a".repeat(60)}`, "value"]));
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async url => new Response(String(url).includes("/api/") ? JSON.stringify(payload) : fixture,
        { headers: { "content-type": String(url).includes("/api/") ? "application/json" : "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(opened.responses).toHaveLength(4);
      expect(opened.responses.reduce((sum, response) => sum + (response.schemaEvidence ? JSON.stringify(response.schemaEvidence).length : 0), 0)).toBeLessThanOrEqual(24_000);
      expect(opened.responses.some(response => response.schemaEvidenceOmitted === true)).toBe(true);
      expect(opened.responses.every(response => response.body && (response.schemaEvidence || response.schemaEvidenceOmitted))).toBe(true);
    } finally { await session.close(); }
  }, 25_000);
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("retains a bounded %s schema when the projected public body exceeds its limit", async browserTransport => {
    const fixture = '<!doctype html><html><body><h1>Public golf</h1><script>fetch("/api/public");</script></body></html>';
    const payload = JSON.stringify({ publicRows: Array.from({ length: 100 }, () => ({ label: "x".repeat(600), startsAt: "2030-10-23T10:00:00-04:00" })),
      token: "never-expose-token" });
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const json = route.request().url().endsWith("/api/public");
      const body = Buffer.from(json ? payload : fixture), headers = { "content-type": json ? "application/json" : "text/html" };
      await route.fulfill({ status: 200, headers, body });
      return { status: 200, url: route.request().url(), headers, body };
    });
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, get lastFailure() { return undefined; }, get pendingReads() { return 0; },
      releasePlaywrightRoute: route => handler(route),
    }));
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      browserTransport,
      fetch: (async url => new Response(String(url).endsWith("/api/public") ? payload : fixture,
        { headers: { "content-type": String(url).endsWith("/api/public") ? "application/json" : "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      const response = opened.responses.find(item => item.url.endsWith("/api/public"))!;
      expect(response.body).toBeUndefined();
      expect(response.bodyOmitted).toBe(true);
      expect(response.schemaEvidence?.fields).toContainEqual(expect.objectContaining({ path: "publicRows[].startsAt", examples: ["2030-10-23T10:00:00-04:00"] }));
      expect(JSON.stringify(response.schemaEvidence).length).toBeLessThanOrEqual(12_000);
      expect(JSON.stringify(response)).not.toContain("never-expose-token");
    } finally { await session.close(); native.mockRestore(); routing.mockRestore(); }
  }, 25_000);
  it("inspects only observed adapter sources with the trusted venue identity", async () => {
    const inspectAdapter = vi.fn(async () => ({ adapter: { family: "FOREUP" as const, facilityId: 1, scheduleId: 2, bookingClassId: 3 } }));
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/simulator"], venueName: "Trusted venue", timeZone: "America/New_York" }, {
      fetch: vi.fn(async () => new Response(pageHtml, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }), inspectAdapter,
    });
    try {
      await expect(session.execute({ id: 1, action: "inspect_adapter", url: "https://unobserved.example.org/" })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(inspectAdapter).not.toHaveBeenCalled();
      await session.execute({ id: 2, action: "open", url: "https://example.org/simulator" });
      const result = await session.execute({ id: 3, action: "inspect_adapter", url: "https://example.org/times" });
      expect(result.adapter).toMatchObject({ family: "FOREUP", facilityId: 1 });
      expect(inspectAdapter).toHaveBeenCalledWith({ bookingUrl: "https://example.org/times", venueName: "Trusted venue", timeZone: "America/New_York" }, expect.objectContaining({ venueMatches: expect.any(Function) }));
      expect(discoveryBrowserActionSchema.safeParse({ id: 4, action: "inspect_adapter", url: "https://example.org/times", venueName: "Forged venue" }).success).toBe(false);
    } finally { await session.close(); }
  }, 25_000);
  it("admits the actual public SPA route for inspection without admitting invented same-origin URLs", async () => {
    const inspectAdapter = vi.fn(async () => ({ adapter: { family: "FOREUP" as const, facilityId: 1, scheduleId: 2, bookingClassId: 3 } }));
    const fixture = '<!doctype html><html><body><h1>Public venue</h1><script>history.replaceState(null,"","/schedule/public-room");</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"], venueName: "Trusted venue", timeZone: "America/New_York" }, {
      fetch: vi.fn(async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }), inspectAdapter,
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(snapshot.url).toBe("https://example.org/schedule/public-room");
      await expect(session.execute({ id: 2, action: "inspect_adapter", url: "https://example.org/schedule/invented" })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      await session.execute({ id: 3, action: "inspect_adapter", url: snapshot.url });
      expect(inspectAdapter).toHaveBeenCalledWith({ bookingUrl: snapshot.url, venueName: "Trusted venue", timeZone: "America/New_York" }, expect.any(Object));
    } finally { await session.close(); }
  }, 25_000);
  it("loads a fourteen MB pinned script while retaining six MB styles and two MB data limits", async () => {
    const fixture = '<!doctype html><html><head><link rel="stylesheet" href="/assets/style.css"></head><body><h1>Public venue</h1>' +
      '<script src="/assets/app.js"></script><script>fetch("/large-data").catch(()=>{});</script></body></html>';
    const largeComment = '/*' + 'x'.repeat(3_000_000) + '*/';
    const limits = new Map<string, number>();
    vi.mocked(createAddressPinnedPublicFetchTransport).mockImplementation(options => async value => {
      const url = options.parseUrl(String(value));
      limits.set(url.pathname, options.maxResponseBytes!);
      const script = url.pathname.endsWith(".js"), style = url.pathname.endsWith(".css"), data = url.pathname === "/large-data";
      return new Response(script ? `/*${"x".repeat(14_500_000)}*/;document.body.append(" script loaded");` : style ? largeComment : data ? JSON.stringify({ text: largeComment }) : fixture,
        { headers: { "content-type": script ? "application/javascript" : style ? "text/css" : data ? "application/json" : "text/html" } });
    });
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(snapshot.text).toContain("script loaded");
      expect(limits.get("/assets/app.js")).toBe(16_000_000);
      expect(limits.get("/assets/style.css")).toBe(6_000_000);
      expect(limits.get("/large-data")).toBe(2_000_000);
      expect(snapshot.requests).toContainEqual(expect.objectContaining({ url: "https://example.org/large-data", blockedReason: "BODY_LIMIT" }));
      expect(snapshot.responseBytes).toBeGreaterThan(6_000_000);
    } finally { await session.close(); vi.mocked(createAddressPinnedPublicFetchTransport).mockReset(); }
  }, 25_000);
  it("stops cumulative decoded responses at the finite session budget", async () => {
    const fixture = '<!doctype html><html><body><h1>Public venue</h1>' + [1, 2, 3, 4].map(id => `<script src="/bundle-${id}.js"></script>`).join("") + '</body></html>';
    const body = `/*${"x".repeat(14_000_000)}*/`;
    const failures: string[] = [];
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 20_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async value => new Response(String(value).endsWith('.js') ? body : fixture,
        { headers: { "content-type": String(value).endsWith('.js') ? "application/javascript" : "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      onRequestFailure: failure => failures.push(failure.reason),
    });
    try {
      await session.execute({ id: 1, action: "open", url: "https://example.org/" }).catch(() => {});
      expect(failures).toContain("PUBLIC_READ_BYTE_LIMIT");
    } finally { await session.close(); }
  }, 25_000);
  it("does not spend public-read capacity on denied POSTs or decorative images", async () => {
    const fixture = '<!doctype html><html><body><h1>Sample simulator</h1><img src="/photo.png"><script>' +
      'Promise.all(Array.from({length:200},(_,i)=>fetch("/denied/"+i,{method:"POST",body:"blocked"}).catch(()=>{}))).then(()=>{document.body.append(" settled");fetch("/api/public")});' +
      '</script></body></html>';
    const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) => new Response(String(url).endsWith("/api/public") ? '{}' : fixture, { headers: { "content-type": String(url).endsWith("/api/public") ? "application/json" : "text/html" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/simulator"] }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      let observed = await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      for (let index = 0; index < 6 && (!observed.text.includes("settled") || observed.requestCount < 2); index++) observed = await session.execute({ id: index + 2, action: "observe" });
      expect(observed.requestCount).toBe(2);
      expect(observed.interceptCount).toBeGreaterThanOrEqual(202);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(observed.navigationStatus).toBe(200);
    } finally { await session.close(); }
  }, 25_000);
  it("exposes Book only inside a proved rental product, and labels adjacent unnamed comboboxes", async () => {
    const fixture = '<!doctype html><html><body><article id="product"><h2>Simulator rental</h2>1 hour<button id="choose">Book</button></article>' +
      '<div><span class="label">Party size</span><button id="party" role="combobox" aria-haspopup="listbox">2</button></div>' +
      '<article id="slot">1 hour at 09:00<button>Book</button></article></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/simulator"] }, {
      fetch: vi.fn(async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const result = await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      expect(result.controls.find(control => control.selector === '[id="choose"]')).toMatchObject({ kind: "product", product: { durationMinutes: 60, selector: '[id="product"]' } });
      expect(result.controls.find(control => control.selector === '[id="party"]')).toMatchObject({ kind: "filter", label: "Party size" });
      expect(result.controls.filter(control => control.name === "Book")).toHaveLength(1);
    } finally { await session.close(); }
  }, 20_000);
});
