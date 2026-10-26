// @vitest-environment node
// All HTTPS/CONNECT traffic terminates on this owned throwaway TLS fixture.
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { createGuardedStagehandSourceBrowser } from "./stagehand-source-browser";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import * as nativeBrowser from "./native-public-browser";
import { launchPublicReadBrowser } from "./public-browser-launch";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const material = readFileSync(new URL("./cps-browser-wiring.test.ts", import.meta.url), "utf8");
const tls = (name: string): string => JSON.parse(new RegExp(`^const ${name} = (".*");$`, "m").exec(material)![1]);

it("earns an owned hidden duplicate public document edge without a visible click and freshly rechecks it in fixed inspection", async () => {
  const official = "https://owned-intermediary.example/", booking = official + "tee-times/";
  const name = "Example Ridge Golf Course", address = "10 Public Road, Example, NY 12345, USA";
  const home = `<!doctype html><title>${name}</title><body><h1>${name}</h1><p>${address}</p>
    <nav id="menu" hidden><a id="tee" href="${booking}">Tee Times</a><a href="${booking}">Book Online</a></nav></body>`;
  const paths: string[] = [], families = new Set<string>(), cancellation = new AbortController();
  let active = 0, acquired = 0, released = 0, unleased = 0, foreign = 0, maxGlobal = 0;
  const lease = async <T>(family: string, work: () => Promise<T>) => {
    if (active >= 2 || families.has(family)) return { acquired: false } as const;
    active++; acquired++; families.add(family); maxGlobal = Math.max(maxGlobal, active);
    try { return { acquired: true, value: await work() } as const; }
    finally { active--; released++; families.delete(family); }
  };
  const server = createServer({ key: tls("fixtureKey"), cert: tls("fixtureCertificate") }, (request, response) => {
    if (!active) unleased++;
    const url = `https://${request.headers.host}${request.url}`; paths.push(`${request.method} ${url}`);
    if (request.method !== "GET" || ![official, booking].includes(url)) { response.writeHead(500).end("UNOWNED_FIXTURE_ROUTE"); return; }
    response.writeHead(200, { "content-type": "text/html" }).end(url === official ? home : "<!doctype html><body>Public booking document</body>");
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined;
  let fixed: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
  let sourceBrowser: Browser | undefined, fixedBrowser: Browser | undefined;
  const originalProxy = nativeBrowser.createNativePublicBrowserProxy;
  let proxy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const proxyDependencies = { resolveAddresses: async (hostname: string) => {
      if (hostname !== "owned-intermediary.example") { foreign++; throw Error("NOT_OWNED_FIXTURE"); }
      return [{ address: "93.184.216.34", family: 4 as const }];
    }, connect: () => connect({ host: "127.0.0.1", port }) };
    // Only this fixture's self-signed certificate is ignored. Production
    // defaults, native request policy, DNS admission and response limits remain.
    host = await createGuardedStagehandSourceBrowser({ initialUrl: official, timeZone: "America/New_York", deadlineAt: new Date(Date.now() + 60_000), signal: cancellation.signal }, {
      requestLease: lease, proxyDependencies, contextOptions: { ignoreHTTPSErrors: true },
      launchBrowser: options => launchPublicReadBrowser({ ...options, headless: true, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }),
    });
    sourceBrowser = await chromium.connectOverCDP(host.cdpUrl);
    const page = sourceBrowser.contexts().flatMap(context => context.pages())[0];
    await host.prepareNavigation(official); await page.goto(official, { waitUntil: "load" });
    expect(await page.locator("a:visible").count()).toBe(0);
    await expect(host.beforeAction(host.targetId, booking)).rejects.toThrow("STAGEHAND_GUARDED_SOURCE_REJECTED");
    expect(await host.observeUniqueSource(host.targetId)).toBeNull();

    for (const content of [
      `<form><a href="${booking}">Tee Times</a></form>`,
      `<a href="https://foreign.example/tee-times/">Tee Times</a>`,
      `<a download href="${booking}">Tee Times</a>`,
      `<a onclick="return false" href="${booking}">Tee Times</a>`,
      `<a href="${booking}">Tee Times</a><a href="${official}booking">Book Online</a>`,
    ]) {
      await page.evaluate(html => { document.getElementById("menu")!.innerHTML = html; }, content);
      expect(await host.preparePublicBookingIntermediary(host.targetId)).toBeNull();
      const diagnostic = host.snapshotFailures().nativeIntermediaryPreparation;
      expect(diagnostic).toMatchObject({ stage: "SELECT", reason: "NO_UNIQUE_GATEWAY", firstOverflow: false, secondOverflow: false,
        firstSettled: true, secondSettled: true, samePage: true, sameNativeDocument: true, sameDocumentHash: true,
        sameReadinessState: true, sameRoutingInventory: true });
      expect(JSON.stringify(diagnostic)).not.toMatch(/https:|href|loaderId|documentHash|text|PRIVATE/u);
      diagnostic!.reason = "READY";expect(host.snapshotFailures().nativeIntermediaryPreparation?.reason).toBe("NO_UNIQUE_GATEWAY");
    }
    await page.evaluate(html => { document.body.innerHTML = html; }, home);
    const witness = await host.preparePublicBookingIntermediary(host.targetId);
    expect(witness).toMatchObject({ kind: "NATIVE_PUBLIC_BOOKING_INTERMEDIARY", pageUrl: official, links: [{ href: booking, visible: false }] });
    expect(witness?.documentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(host.snapshotFailures().nativeIntermediaryPreparation).toMatchObject({ stage: "GRANT", reason: "READY", firstRows: 2, secondRows: 2,
      firstCandidatePresent: true, secondCandidatePresent: true, sameDocumentHash: true, sameNativeDocument: true });
    await page.goto(booking, { waitUntil: "load" });
    expect(await host.completePublicBookingIntermediary(host.targetId)).toMatchObject({ kind: "NATIVE_PUBLIC_BOOKING_INTERMEDIARY_OPEN", pageUrl: official, finalUrl: booking });
    expect(host.diagnostics().admittedRequests).toBe(2);
    expect(await host.close()).toMatchObject({ browserClosed: true, providerRequestsDrained: true }); host = undefined;
    await sourceBrowser.close(); sourceBrowser = undefined;
    expect(active).toBe(0); expect(acquired).toBe(released);

    proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(input => originalProxy(input, proxyDependencies));
    fixed = await createCourseDiscoveryBrowserSession({ initialUrls: [official], venueOfficialUrl: official, venueName: name, venueAddress: address,
      timeZone: "America/New_York", deadlineAt: new Date(Date.now() + 60_000) }, {
      browserTransport: "NATIVE_CHROME", requestLease: lease,
      launchBrowser: async () => fixedBrowser = await launchPublicReadBrowser({ headless: true, args: ["--ignore-certificate-errors"] }),
    });
    const initial = await fixed.execute({ id: 1, action: "open", url: official });
    expect(initial.nativeFirstFatal).toBeUndefined();
    const edge = initial.controls.find(control => control.kind === "public-document-link");
    expect(edge).toMatchObject({ kind: "public-document-link", href: booking, readOnly: true });
    expect(initial.controls.some(control => control.href === booking && control.kind !== "public-document-link")).toBe(false);
    const opened = await fixed.execute({ id: 2, action: "open", url: edge!.href! });
    expect(opened.url).toBe(booking); expect(opened.navigationStatus).toBe(200); expect(opened.nativeFirstFatal).toBeUndefined();

    for (const [index, mode] of ["form", "competing"].entries()) {
      const fresh = await fixed.execute({ id: index * 2 + 3, action: "open", url: official });
      expect(fresh.controls.some(control => control.kind === "public-document-link" && control.href === booking)).toBe(true);
      const document = fixedBrowser!.contexts().flatMap(context => context.pages()).find(page => page.url() === official)!;
      await document.evaluate(({ mode, booking, official }) => {
        const menu = window.document.getElementById("menu")!;
        menu.innerHTML = mode === "form" ? `<form><a href="${booking}">Tee Times</a></form>` : `<a href="${booking}">Tee Times</a><a href="${official}booking">Book Online</a>`;
      }, { mode, booking, official });
      const reads = paths.filter(path => path === `GET ${booking}`).length;
      await expect(fixed.execute({ id: index * 2 + 4, action: "open", url: booking })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(paths.filter(path => path === `GET ${booking}`)).toHaveLength(reads);
    }
    await fixed.close(); fixed = undefined;
    expect(paths.every(path => path.startsWith("GET "))).toBe(true);
    expect(foreign).toBe(0); expect(unleased).toBe(0); expect(active).toBe(0); expect(acquired).toBe(released); expect(maxGlobal).toBeLessThanOrEqual(2);
  } finally {
    cancellation.abort(); await host?.close(); await sourceBrowser?.close(); await fixed?.close(); await fixedBrowser?.close(); proxy?.mockRestore();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 90_000);
