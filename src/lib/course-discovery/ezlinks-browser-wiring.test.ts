// @vitest-environment node
// Real isolated Chrome/CDP/CONNECT, with DNS and sockets pinned to a local TLS
// fixture. No provider, model, database or installed browser profile is used.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { connect, type AddressInfo } from "node:net";
import type { BinaryLike, BinaryToTextEncoding, Hash } from "node:crypto";
import type { Browser } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession, discoveryBrowserActionSchema, sameDiscoveryMainDocument } from "./browser-session";
import * as nativeBrowser from "./native-public-browser";
import { launchPublicReadBrowser } from "./public-browser-launch";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const contractFixture = vi.hoisted(() => ({ assets: [
  { path: "/assets/index-DsLbHQvf.js", sha256: "4e2bb6ea29fa910e04620c1551d737aecaff9df23bf6be99f9da6d72e9b1addb", body: 'void "offline-unpaged-loadData";' },
  { path: "/assets/index-CvL6jQuU.js", sha256: "6547b7841afb6945817f5c354437875bd5f1fb59031ed511cf16d30bca72262f", body: 'void "offline-public-search-model";' },
], substitutions: [] as Array<{ path: string; actual: string; substituted: string }> }));
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: (...args: Parameters<typeof actual.createHash>) => {
    const hash = actual.createHash(...args);
    if (args[0] !== "sha256") return hash;
    const update = hash.update.bind(hash), digest = hash.digest.bind(hash), chunks: Buffer[] = [];
    // Portable TLS fixture only: compute real SHA256, then substitute the two
    // exact tiny fixture bodies. All other bytes/algorithms/methods delegate.
    // Production contains no injectable digest or downloaded bundle fixture.
    hash.update = ((data: BinaryLike, encoding?: Parameters<Hash["update"]>[1]) => {
      chunks.push(typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      update(data, encoding); return hash;
    }) as Hash["update"];
    hash.digest = ((encoding?: BinaryToTextEncoding) => {
      const result = encoding ? digest(encoding) : digest();
      const fixture = contractFixture.assets.find(asset => Buffer.concat(chunks).equals(Buffer.from(asset.body)));
      if (!fixture || encoding !== "hex") return result;
      contractFixture.substitutions.push({ path: fixture.path, actual: String(result), substituted: fixture.sha256 });
      return fixture.sha256;
    }) as Hash["digest"];
    return hash;
  } };
});
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://public-course.ezlinksgolf.com";
const configuration = () => ({ MasterSponsorID: "1234", AllCourseIDs: "11,22", Courses: [{ CourseID: 11 }, { CourseID: 22 }],
  SearchMinDate: "2030-10-21T17:51:21.03", SearchMaxDate: "2030-11-04T17:51:21.03", StartTimeSet: "05:00:00", EndTimeSet: "19:00:00",
  NumPlayersList: ["1", "2", "3", "4"], HolesList: ["Any", "18", "9"] });
const listingBody = () => ({ p01: [11, 22], p02: "10/23/2030", p03: "8:00 AM", p04: "6:00 PM", p05: 0, p06: 2, p07: false });
const bearer = "fixture-offer-bearer-MUST-STAY-PRIVATE";
const availability = () => ({ rows: [{ r01: bearer, time: "09:00", players: 4 }] });
// Reuse the existing, explicitly public throwaway test certificate literals;
// parse JSON strings only, never import/execute another test file.
const certificateSource = readFileSync(new URL("./cps-browser-wiring.test.ts", import.meta.url), "utf8");
function certificateLiteral(name: string) {
  const match = new RegExp(`^const ${name} = ("[^\\r\\n]+");$`, "mu").exec(certificateSource);
  if (!match) throw new Error("OFFLINE_CERTIFICATE_FIXTURE_MISSING");
  return JSON.parse(match[1]) as string;
}
const realProxy = nativeBrowser.createNativePublicBrowserProxy, realContinue = nativeBrowser.continueNativeBrowserRead;

describe.runIf(existsSync(chrome))("controller-only EZLinks native reads", () => {
  let server: Server, browsers: Browser[], seen: Array<{ path: string; method: string; body: string; nonce?: string }>;
  let automaticInit: boolean, delayPublication: boolean, initStatus: number, htmlChallenge: boolean, holdAvailability: boolean, echoNonce: boolean;
  let contractMode: "none" | "matching" | "mutated" | "partial" | "redirect" | "wrong MIME" | "missing" | "fetch" | "iframe";
  let delayHtmlPublication: boolean, htmlPublished: boolean, releaseHtmlPublication: (() => void) | undefined;
  let releasePublicRead: (() => void) | undefined;
  let spaPath: string | undefined;
  let active: number, maximum: number;
  beforeEach(async () => {
    browsers = []; seen = []; automaticInit = true; delayPublication = false; initStatus = 200; htmlChallenge = false; holdAvailability = false; echoNonce = false; active = 0; maximum = 0;
    contractMode = "none"; delayHtmlPublication = false; htmlPublished = false; contractFixture.substitutions = [];
    releasePublicRead = undefined; releaseHtmlPublication = undefined; spaPath = undefined;
    server = createServer({ cert: certificateLiteral("fixtureCertificate"), key: certificateLiteral("fixtureKey") }, (request, response) => {
      if (request.headers.host !== "public-course.ezlinksgolf.com") { response.writeHead(500); response.end("Unbound local fixture"); return; }
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const path = request.url!; seen.push({ path, method: request.method!, body, nonce: request.headers["x-tts-public-read"] as string | undefined });
        if (path === "/held-public-read") { releasePublicRead = () => { releasePublicRead = undefined; response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); }; return; }
        const asset = contractFixture.assets.find(asset => asset.path === path);
        if (asset) {
          if (contractMode === "redirect") { response.writeHead(302, { location: "/scripts/redirected-client.js" }); response.end(); return; }
          response.writeHead(contractMode === "partial" ? 206 : 200, { "content-type": contractMode === "wrong MIME" ? "text/plain" : "application/javascript; charset=utf-8" });
          response.end(asset.body + (contractMode === "mutated" ? "void 0;" : "")); return;
        }
        if (path === "/scripts/redirected-client.js") { response.writeHead(200, { "content-type": "application/javascript" }); response.end(contractFixture.assets[0].body); return; }
        if (path === "/api/search/init") {
          response.writeHead(initStatus, { "content-type": "application/json" }); response.end(JSON.stringify({ ...configuration(), ...(echoNonce ? { echoHeader: `x${request.headers["x-tts-public-read"]}x` } : {}) })); return;
        }
        if (path === "/api/search/search") { if (!holdAvailability) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(availability())); } return; }
        if (path === "/api/search/gsahs") { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
        const script = automaticInit ? `<script>fetch('/api/search/init').then(()=>fetch('/api/search/gsahs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sponsorId:1234})})).catch(()=>{});</script>` : "";
        const assets = contractMode === "none" ? "" : contractMode === "iframe" ? "<iframe src='/frame-client'></iframe>" : contractMode === "fetch" ?
          `<script>Promise.all(${JSON.stringify(contractFixture.assets.map(asset => asset.path))}.map(path=>fetch(path).then(response=>response.text()))).catch(()=>{});</script>` :
          (contractMode === "missing" ? contractFixture.assets.slice(0, 1) : contractFixture.assets).map(asset => `<script src='${asset.path}'></script>`).join("");
        const route = spaPath ? `<script>history.replaceState(null,'',${JSON.stringify(spaPath)});</script>` : "";
        response.writeHead(htmlChallenge ? 403 : 200, { "content-type": "text/html", "set-cookie": "fixture-anonymous=opaque-public-session; Secure; SameSite=Lax" });
        response.end(htmlChallenge ? "<h1>Verify you are human</h1><p>Checking your browser before continuing.</p>" :
          `<h1>Offline public golf availability and course information</h1><a href='/index.html'>View tee times</a>${assets}${route}${script}`);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(config => realProxy(config, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }], connect: () => connect(port, "127.0.0.1"),
    }));
    vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async (...args) => {
      const result = await realContinue(...args);
      if (delayPublication && args[0].request().url().endsWith("/api/search/init")) await new Promise(resolve => setTimeout(resolve, 200));
      if (args[0].request().url() === `${origin}/search`) {
        if (delayHtmlPublication) await new Promise<void>(resolve => { releaseHtmlPublication = resolve; });
        htmlPublished = true;
      }
      return result;
    });
  });
  afterEach(async () => {
    await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks();
  });
  const session = (durationMs = 20_000, entry = "/search") => createCourseDiscoveryBrowserSession({ initialUrls: [`${origin}${entry}`],
    deadlineAt: new Date(Date.now() + durationMs), timeZone: "America/New_York", venueName: "Offline public golf" }, {
    browserTransport: "NATIVE_CHROME",
    launchBrowser: async () => { const browser = await launchPublicReadBrowser({ executablePath: chrome, headless: true, args: ["--ignore-certificate-errors"] }); browsers.push(browser); return browser; },
    requestLease: async (_family, work) => { active++; maximum = Math.max(maximum, active); try { return { acquired: true, value: await work() }; } finally { active--; } },
  });
  const currentPage = () => browsers[0].contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(origin))!;
  it("bridges only the actual same-document root-to-search SPA route with both pinned native clients", async () => {
    contractMode = "matching"; spaPath = "/search"; const reader = await session(20_000, "/");
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/` });
      await vi.waitFor(() => expect(currentPage().url()).toBe(`${origin}/search`));
      expect(await reader.readEzLinksConfiguration()).toEqual(configuration());
      expect((await reader.readEzLinksReadContract()).kind).toBe("EZLINKS_UNPAGED_SEARCH_V1");
      expect(await reader.readEzLinksAvailability(listingBody())).toEqual(availability());
      expect(seen.filter(row => row.path === "/")).toHaveLength(1);
      expect(seen.some(row => row.path === "/search")).toBe(false);
      expect(sameDiscoveryMainDocument(`${origin}/`, `${origin}/search`)).toBe(false);
      const before = seen.length;
      await expect(reader.execute({ id: 2, action: "open", url: "https://foreign-public.example.org/search" })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(seen.length).toBe(before); expect(reader.diagnostics().nativeFirstFatal).toBeUndefined();
    } finally { await reader.close(); }
  }, 20_000);
  it.each([
    { entry: "/", route: "/account" }, { entry: "/", route: "/search?filter=1" }, { entry: "/", route: "/search#calendar" },
    { entry: "/", route: "/other" }, { entry: "/index.html", route: "/search" },
  ])("does not bridge the unapproved SPA route $entry -> $route", async ({ entry, route }) => {
    contractMode = "matching"; spaPath = route; automaticInit = false; const reader = await session(20_000, entry);
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}${entry}` });
      await vi.waitFor(() => expect(currentPage().url()).toBe(`${origin}${route}`));
      await expect(reader.readEzLinksConfiguration()).rejects.toThrow("EZLINKS_DOCUMENT_CHANGED");
      expect(seen.some(row => row.path.startsWith("/api/"))).toBe(false);
    } finally { await reader.close(); }
  }, 15_000);
  it.each(["missing", "mutated"] as const)("requires both unchanged native scripts for the root SPA bridge (%s)", async mode => {
    contractMode = mode; spaPath = "/search"; automaticInit = false; const reader = await session(20_000, "/");
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/` });
      await vi.waitFor(() => expect(currentPage().url()).toBe(`${origin}/search`));
      await expect(reader.readEzLinksConfiguration()).rejects.toThrow("EZLINKS_READ_CONTRACT_UNVERIFIED");
      expect(seen.some(row => row.path.startsWith("/api/"))).toBe(false);
    } finally { await reader.close(); }
  }, 15_000);
  it("rejects a root SPA contract after a new same-document pinned script becomes stale", async () => {
    contractMode = "matching"; spaPath = "/search"; const reader = await session(20_000, "/");
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/` });
      await reader.readEzLinksConfiguration(); await reader.readEzLinksReadContract();
      contractMode = "mutated";
      await currentPage().evaluate(path => new Promise<void>(resolve => {
        const script = document.createElement("script"); script.src = path; script.onload = () => resolve(); script.onerror = () => resolve(); document.head.append(script);
      }), contractFixture.assets[0].path);
      await expect(reader.readEzLinksAvailability(listingBody())).rejects.toThrow("EZLINKS_READ_CONTRACT_UNVERIFIED");
      expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
    } finally { await reader.close(); }
  }, 20_000);
  it("never lends root SPA client proof to a new full document at the observed search URL", async () => {
    contractMode = "matching"; spaPath = "/search"; const reader = await session(20_000, "/");
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/` }); await reader.readEzLinksConfiguration(); await reader.readEzLinksReadContract();
      await reader.execute({ id: 2, action: "observe" });
      contractMode = "none"; spaPath = undefined;
      await reader.execute({ id: 3, action: "open", url: `${origin}/search` });
      await expect(reader.readEzLinksReadContract()).rejects.toThrow("EZLINKS_READ_CONTRACT_UNVERIFIED");
      expect(seen.filter(row => row.path === "/search")).toHaveLength(1);
      expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
    } finally { await reader.close(); }
  }, 20_000);
  it("attests only already captured main-frame script bytes across the HTML publication ACK race", async () => {
    contractMode = "matching"; delayHtmlPublication = true; const reader = await session();
    try {
      const opening = reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      await vi.waitFor(() => {
        expect(releaseHtmlPublication).toBeDefined();
        expect(reader.diagnostics().requests).toContainEqual(expect.objectContaining({ url: `${origin}${contractFixture.assets[0].path}`, resourceType: "script" }));
      }, { timeout: 3000 });
      expect(htmlPublished).toBe(false);
      releaseHtmlPublication!(); await opening;
      const count = seen.length, proof = await reader.readEzLinksReadContract();
      expect(proof).toEqual({ kind: "EZLINKS_UNPAGED_SEARCH_V1", assets: contractFixture.assets.map(({ path, sha256 }) => ({ path, sha256 })) });
      expect(maximum).toBe(1);
      expect(new Set(contractFixture.substitutions.map(row => row.path)))
        .toEqual(new Set(contractFixture.assets.map(asset => asset.path)));
      expect(contractFixture.substitutions.every(row => row.actual !== row.substituted && /^[a-f0-9]{64}$/u.test(row.actual))).toBe(true);
      proof.assets[0].sha256 = "changed caller copy";
      expect((await reader.readEzLinksReadContract()).assets[0].sha256).toBe(contractFixture.assets[0].sha256);
      expect(seen.length).toBe(count);
      expect(discoveryBrowserActionSchema.safeParse({ id: 2, action: "readEzLinksReadContract" }).success).toBe(false);
    } finally { releaseHtmlPublication?.(); await reader.close(); }
  }, 20_000);
  it.each(["mutated", "partial", "redirect", "wrong MIME"] as const)("rejects %s client bytes without certifying an unpaged listing", async mode => {
    contractMode = mode; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      await expect(reader.readEzLinksReadContract()).rejects.toThrow("EZLINKS_READ_CONTRACT_UNVERIFIED");
      expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
      expect(contractFixture.substitutions).toHaveLength(0);
    } finally { await reader.close(); }
  }, 15_000);
  it.each(["missing", "fetch", "iframe"] as const)("does not fetch missing proof or attest %s lookalikes", async mode => {
    contractMode = mode; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      const before = seen.length;
      await expect(reader.readEzLinksReadContract()).rejects.toThrow("EZLINKS_READ_CONTRACT_UNVERIFIED");
      expect(seen.length).toBe(before); expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
      if (mode === "iframe") {
        expect(seen.some(row => row.path === "/frame-client" || row.path.startsWith("/assets/"))).toBe(false);
        expect(reader.diagnostics().capabilityDiagnostics).toContainEqual(expect.objectContaining({ code: "SUBFRAME_UNSUPPORTED" }));
      }
      if (mode === "fetch") expect(contractFixture.substitutions).toHaveLength(0);
    } finally { await reader.close(); }
  }, 15_000);
  it("never carries a prior script contract across same-URL document replacement", async () => {
    contractMode = "matching"; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` }); await reader.readEzLinksReadContract();
      contractMode = "missing";
      await reader.execute({ id: 2, action: "open", url: `${origin}/search` });
      await expect(reader.readEzLinksReadContract()).rejects.toThrow("EZLINKS_READ_CONTRACT_UNVERIFIED");
      expect(reader.diagnostics().nativeFirstFatal).toBeUndefined(); expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
    } finally { await reader.close(); }
  }, 20_000);
  it("rechecks the exact asset version after provider-lease wait before dispatching a listing", async () => {
    contractMode = "matching"; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      await reader.readEzLinksConfiguration(); await reader.readEzLinksReadContract();
      await currentPage().evaluate(() => { void fetch("/held-public-read").then(response => response.text()).catch(() => {}); });
      await vi.waitFor(() => expect(releasePublicRead).toBeDefined());
      const pending = reader.readEzLinksAvailability(listingBody()).then(() => "unexpected success", error => error as Error);
      await vi.waitFor(() => expect(reader.diagnostics().requests).toContainEqual(expect.objectContaining({ method: "POST", url: `${origin}/api/search/search` })));
      await currentPage().evaluate(path => { const script = document.createElement("script"); script.src = path; document.head.append(script); }, contractFixture.assets[0].path);
      await expect(pending).resolves.toMatchObject({ message: "EZLINKS_READ_CONTRACT_UNVERIFIED" });
      releasePublicRead!();
      await reader.execute({ id: 2, action: "observe" });
      expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
      expect(reader.diagnostics().nativeFirstFatal).toBeUndefined();
    } finally { releasePublicRead?.(); await reader.close(); }
  }, 20_000);
  it("does not publish a held listing after the same-document script contract changes", async () => {
    contractMode = "matching"; holdAvailability = true; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      await reader.readEzLinksConfiguration(); await reader.readEzLinksReadContract();
      const pending = reader.readEzLinksAvailability(listingBody()).then(() => "unexpected success", error => error as Error);
      await vi.waitFor(() => expect(seen.some(row => row.path === "/api/search/search")).toBe(true));
      contractMode = "mutated";
      await currentPage().evaluate(path => { const script = document.createElement("script"); script.src = path; document.head.append(script); }, contractFixture.assets[0].path);
      await expect(pending).resolves.toMatchObject({ message: "EZLINKS_READ_CONTRACT_UNVERIFIED" });
      expect(reader.diagnostics().nativeFirstFatal).toBeUndefined();
    } finally { await reader.close(); }
  }, 20_000);
  it("masks exact known nonce echoes in model DOM/JSON/inspection while preserving private raw configuration", async () => {
    automaticInit = false; echoNonce = true; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      await currentPage().evaluate(() => {
        const original = window.fetch;
        window.fetch = (url, init) => {
          const nonce = new Headers(init?.headers).get("x-tts-public-read");
          if (nonce) { const element = document.createElement("h2"); element.id = "echo"; element.textContent = `Private echo x${nonce}x`; document.body.append(element); }
          return original(url, init);
        };
      });
      const raw = await reader.readEzLinksConfiguration() as Record<string, unknown>;
      const nonce = seen.find(row => row.path === "/api/search/init")!.nonce!;
      expect(raw.echoHeader).toBe(`x${nonce}x`);
      const snapshot = await reader.execute({ id: 2, action: "observe" });
      expect(JSON.stringify(snapshot)).not.toContain(nonce); expect(snapshot.text).toContain("[private-read-id]");
      expect(snapshot.responses).toContainEqual(expect.objectContaining({ body: expect.objectContaining({ echoHeader: "x[private-read-id]x" }) }));
      const selector = snapshot.elements.find(element => element.attributes.id === "echo")?.selector;
      expect(selector).toBeDefined();
      const inspected = await reader.execute({ id: 3, action: "inspect", selector: selector! });
      expect(JSON.stringify(inspected)).not.toContain(nonce); expect(inspected.structure?.ancestors[0].text).toContain("[private-read-id]");
    } finally { await reader.close(); }
  }, 20_000);
  it("captures fresh native init before settings/listing despite response-ACK publication race, without leaking offer tokens", async () => {
    delayPublication = true;
    const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      const init = await reader.readEzLinksConfiguration(); expect(init).toEqual(configuration());
      (init as ReturnType<typeof configuration>).MasterSponsorID = "9999";
      expect((await reader.readEzLinksConfiguration() as ReturnType<typeof configuration>).MasterSponsorID).toBe("1234");
      const raw = await reader.readEzLinksAvailability(listingBody()); expect(raw).toEqual(availability());
      const snapshot = await reader.execute({ id: 2, action: "observe" });
      const post = seen.find(row => row.path === "/api/search/search")!;
      expect(post.method).toBe("POST"); expect(JSON.parse(post.body).p07).toBe(false); expect(post.nonce).toMatch(/^[a-f0-9-]{36}$/u);
      expect(seen.some(row => row.path === "/api/search/gsahs")).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain(bearer); expect(JSON.stringify(snapshot)).not.toContain(post.nonce);
      expect(JSON.stringify(snapshot)).not.toContain("fixture-anonymous"); expect(snapshot.requestFailures).toEqual([]); expect(maximum).toBe(1);
      expect(discoveryBrowserActionSchema.safeParse({ id: 3, action: "readEzLinksAvailability", body: listingBody() }).success).toBe(false);
    } finally { await reader.close(); }
  }, 20_000);
  it("uses one fixed GET/init when no automatic init was observed", async () => {
    automaticInit = false; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      expect(await reader.readEzLinksConfiguration()).toEqual(configuration());
      const init = seen.filter(row => row.path === "/api/search/init"); expect(init).toHaveLength(1); expect(init[0].nonce).toBeDefined();
      expect(await reader.readEzLinksAvailability(listingBody())).toEqual(availability());
    } finally { await reader.close(); }
  }, 20_000);
  it("rejects hold/unknown bodies before dispatch and never uses generic GraphQL fallback in the provider namespace", async () => {
    const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` }); await reader.readEzLinksConfiguration();
      for (const body of [{ ...listingBody(), p07: true }, { ...listingBody(), p01: [9999] }, { query: "query { publicRows }" }])
        await expect(reader.readEzLinksAvailability(body)).rejects.toThrow("EZLINKS_PUBLIC_READ_REJECTED");
      const page = currentPage();
      await page.evaluate(async () => {
        await Promise.all(["/api/search/FindTeeTimes", "/graphql"].map(url => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"query":"query { publicRows }"}' }).catch(() => {})));
      });
      expect(seen.some(row => ["/api/search/search", "/api/search/FindTeeTimes", "/graphql"].includes(row.path))).toBe(false);
    } finally { await reader.close(); }
  }, 20_000);
  it("does not trust a monkeypatched fetch returning fabricated JSON without an actual correlated native read", async () => {
    const reader = await session(4_000);
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` }); await reader.readEzLinksConfiguration();
      await currentPage().evaluate(() => { window.fetch = async () => new Response('{"fake":"must-not-return"}', { headers: { "content-type": "application/json" } }); });
      await expect(reader.readEzLinksAvailability(listingBody())).rejects.toThrow();
      expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
    } finally { await reader.close(); }
  }, 10_000);
  it.each(["x-auth-token", "api-key"])("rejects an actual credential header%s added by page fetch before the matched POST dispatches", async header => {
    const reader = await session(4_000);
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` }); await reader.readEzLinksConfiguration();
      await currentPage().evaluate(name => {
        const original = window.fetch;
        window.fetch = (url, init) => {
          const headers = new Headers(init?.headers); headers.set(name, "never-send-credential");
          return original(url, { ...init, headers });
        };
      }, header);
      await expect(reader.readEzLinksAvailability(listingBody())).rejects.toThrow();
      expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
      expect(reader.diagnostics().requestFailures).toContainEqual(expect.objectContaining({ reason: "CREDENTIAL_HEADERS" }));
      expect(JSON.stringify(reader.diagnostics())).not.toContain("never-send-credential");
    } finally { await reader.close(); }
  }, 10_000);
  it("rejects duplicate correlation before either response can qualify the controller read", async () => {
    holdAvailability = true; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` }); await reader.readEzLinksConfiguration();
      await currentPage().evaluate(() => {
        const original = window.fetch;
        window.fetch = (url, init) => { const first = original(url, init); void original(url, init).catch(() => {}); return first; };
      });
      await expect(reader.readEzLinksAvailability(listingBody())).rejects.toThrow("EZLINKS_PUBLIC_READ_FAILED");
      expect(seen.filter(row => row.path === "/api/search/search").length).toBeLessThanOrEqual(1);
      expect(reader.diagnostics().requestFailures).toContainEqual(expect.objectContaining({ reason: "EZLINKS_PUBLIC_READ_REJECTED" }));
    } finally { await reader.close(); }
  }, 20_000);
  it("invalidates a pending read/token across a same-URL document replacement, then requires freshly captured init", async () => {
    holdAvailability = true; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` }); await reader.readEzLinksConfiguration();
      const pending = reader.readEzLinksAvailability(listingBody()).then(() => "unexpected success", error => error as Error);
      await vi.waitFor(() => expect(seen.some(row => row.path === "/api/search/search")).toBe(true));
      await reader.execute({ id: 2, action: "open", url: `${origin}/search` });
      expect(await pending).toBeInstanceOf(Error); expect(seen.filter(row => row.path === "/api/search/init")).toHaveLength(2);
      holdAvailability = false;
      expect(await reader.readEzLinksConfiguration()).toEqual(configuration());
      expect(await reader.readEzLinksAvailability(listingBody())).toEqual(availability());
      expect(reader.diagnostics().nativeFirstFatal).toBeUndefined();
    } finally { await reader.close(); }
  }, 20_000);
  it("does not silently rebind an availability body to a newer same-document configuration", async () => {
    const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` }); await reader.readEzLinksConfiguration();
      await currentPage().evaluate(async () => { await (await fetch("/api/search/init")).arrayBuffer(); });
      await reader.execute({ id: 2, action: "observe" });
      await expect(reader.readEzLinksAvailability(listingBody())).rejects.toThrow("EZLINKS_DOCUMENT_CHANGED");
      expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
      await reader.readEzLinksConfiguration(); expect(await reader.readEzLinksAvailability(listingBody())).toEqual(availability());
    } finally { await reader.close(); }
  }, 20_000);
  it.each([206, 403])("never accepts/retries an observed incomplete or inaccessible init response%s", async status => {
    initStatus = status; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      await expect(reader.readEzLinksConfiguration()).rejects.toThrow("EZLINKS_CONFIGURATION_UNAVAILABLE");
      expect(seen.filter(row => row.path === "/api/search/init")).toHaveLength(1);
      expect(seen.some(row => row.path === "/api/search/search")).toBe(false);
    } finally { await reader.close(); }
  }, 20_000);
  it("reports an actual main-document access challenge without issuing a fixed API read", async () => {
    htmlChallenge = true; automaticInit = false; const reader = await session();
    try {
      await reader.execute({ id: 1, action: "open", url: `${origin}/search` });
      await expect(reader.readEzLinksConfiguration()).rejects.toThrow("ACCESS_REQUIRED");
      expect(seen.filter(row => row.path.startsWith("/api/"))).toHaveLength(0);
    } finally { await reader.close(); }
  }, 20_000);
});
