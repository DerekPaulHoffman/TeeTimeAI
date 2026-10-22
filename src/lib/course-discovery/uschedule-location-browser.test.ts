// @vitest-environment node
// Actual isolated Chrome/CDP/CONNECT traffic terminates only in loopback TLS.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { Browser } from "@playwright/test";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import * as nativeBrowser from "./native-public-browser";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { deriveUScheduleOfficialLocation } from "@/lib/simulators/providers/uschedule-location-source";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { isSafeRecipeUrl, recipeSelectorSchema } from "./recipe";
import { isPublicAvailabilityNavigation } from "./public-navigation-control";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
vi.mock("@/lib/simulators/providers/uschedule-location-source", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/simulators/providers/uschedule-location-source")>();
  return { ...actual, USCHEDULE_LOCATION_CLIENT: { ...actual.USCHEDULE_LOCATION_CLIENT,
    sha256: createHash("sha256").update("synthetic reviewed public client").digest("hex") } };
});
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
// Reuse the existing throwaway offline certificate without duplicating key material.
const tlsFixture = readFileSync(new URL("./cps-browser-wiring.test.ts", import.meta.url), "utf8");
function tlsLiteral(name: string): string {
  const literal = new RegExp(`^const ${name} = (".*");$`, "m").exec(tlsFixture)?.[1];
  if (!literal) throw new Error("OFFLINE_TLS_FIXTURE_MISSING");
  return JSON.parse(literal);
}
describe.runIf(existsSync(chrome))("actual native official-location provenance", () => {
  it.each([true, false])("requires a page wrapper before following its public link and independently inspecting its official location: %s", async pageWrapper => {
    const officialUrl = "https://example.org/", finalUrl = "https://www.example.org/", bookingUrl = "https://clients.uschedule.com/examplegolf/booking";
    const entry = `${bookingUrl}?filter=loc[82]`, venueName = "Example Indoor Golf Club", venueAddress = "10 Main Street, Example, WA 98000, USA";
    expect(isSafeRecipeUrl(entry)).toBe(true); expect(isPublicAvailabilityNavigation(entry, "Tee Time")).toBe(true);
    const officialHtml = `<html><body><script>window.formValueReads=0;for(const type of [HTMLInputElement,HTMLSelectElement,HTMLTextAreaElement]){const p=Object.getOwnPropertyDescriptor(type.prototype,'value');Object.defineProperty(type.prototype,'value',{...p,get(){window.formValueReads++;return p.get.call(this)}})}</script><form id="Form" method="post" onsubmit="window.wrapperSubmitted=true;return false">
      <h1>${venueName}</h1><div><p>${venueAddress}</p></div><a id="public-link" href="${entry}" onclick="window.wrapperClicked=true;return false">Tee Time</a>
      <a id="account-link" href="https://example.org/account">Account</a><a id="checkout-link" href="https://example.org/checkout">Book 09:00</a>
      <a id="email-link" href="${entry}">Book by email</a><a id="time-link" href="${entry}">Book 10:30</a>
      <a id="hash-link" href="${entry}#availability">Book tee times</a><a id="download-link" download href="${entry}">Book tee times</a>
      <button type="submit"><a href="${entry}">Book tee times</a></button><a href="${entry}"><input type="hidden" value="private-anchor-sentinel">Book tee times</a>
      <a hidden href="${entry}">Book tee times</a>
      <${pageWrapper ? "footer" : "div"}><button id="send" type="submit">Send newsletter</button><button id="continue" type="submit">Continue</button><input type="email" value="private-sentinel@example.invalid"><input type="text" value="private-text-sentinel"><input type="hidden" value="private-hidden-sentinel">
      <select id="contact-date"><option value="1">1</option></select><textarea>private-textarea-sentinel</textarea>
      </${pageWrapper ? "footer" : "div"}></form><script>document.addEventListener('click',()=>{window.wrapperDelegated=true});</script></body></html>`;
    const catalog = `<html><body class="examplegolf"><div class="col-lg-4 order-1"><div id="location_section"><select id="select_location"><option value="82" selected>${venueName}</option></select></div>
      <div id="service_section"><select id="select_service"><option value="73" selected>Non-Member Hourly Rental</option></select></div><select id="select_length"><option value="60" selected>1 hour</option></select>
      <div id="res_section"><label class="choose_label" for="resource55">Simulators - Example</label><select class="resSelect" id="resource55"><option selected value="-1">Any Available</option><option value="91">Example - Bay 1</option></select></div>
      <div class="card my-3"><div class="card-body"><p>Simulators:</p><p>Additional Guest(s):</p><ul><li>Non-members may bring 1 guest for free.</li><li>You may add 2 additional guests if you wish. The charge is $25 per person/per hour. Max of 4 people in the bay.</li></ul></div></div></div>
      <div id="right_column"><div class="serv_only_desc"><div id="serv_desc_section"><p>Non-Member Tee Time Guidelines</p><ul><li>Non-members reservations include 1 guest, for free.</li></ul></div></div></div>
      <script src="/bundles/js/bookingBS5"></script></body></html>`;
    const paths: string[] = [];
    const server = createServer({ cert: tlsLiteral("fixtureCertificate"), key: tlsLiteral("fixtureKey") }, (request, response) => {
      const url = `https://${request.headers.host}${request.url}`; paths.push(`${request.method} ${url}`);
      if (url === officialUrl) { response.writeHead(302, { location: finalUrl }); response.end(); }
      else if (url === finalUrl) { response.writeHead(200, { "content-type": "text/html" }); response.end(officialHtml); }
      else if (url === entry) { response.writeHead(302, { location: bookingUrl }); response.end(); }
      else if (url === bookingUrl) { response.writeHead(200, { "content-type": "text/html" }); response.end(catalog); }
      else if (url === "https://clients.uschedule.com/bundles/js/bookingBS5") { response.writeHead(200, { "content-type": "application/javascript" }); response.end("/* inert local client */"); }
      else { response.writeHead(500); response.end("Unbound offline request"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port, realProxy = nativeBrowser.createNativePublicBrowserProxy;
    const proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(config => realProxy(config, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }], connect: () => connect(port, "127.0.0.1"),
    }));
    const fixedFetch = vi.fn<typeof fetch>(async (value, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      const client = String(value) === "https://clients.uschedule.com/bundles/js/bookingBS5";
      return new Response(client ? "synthetic reviewed public client" : catalog, { headers: { "content-type": client ? "application/javascript" : "text/html",
        ...(!client ? { "set-cookie": "ASP.NET_SessionId=SyntheticAnonymous123; Path=/; HttpOnly" } : {}) } });
    });
    let browser: Browser | undefined;
    const inspectAdapter = vi.fn(async (source, deps) => inspectExistingAdapter(source, { ...deps, fetch: fixedFetch }));
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 35_000), initialUrls: [officialUrl],
      venueOfficialUrl: officialUrl, venueName, venueAddress, timeZone: "America/Los_Angeles" }, { browserTransport: "NATIVE_CHROME", inspectAdapter,
      launchBrowser: async () => browser = await launchPublicReadBrowser({ executablePath: chrome, headless: true, args: ["--ignore-certificate-errors"] }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: "open", url: officialUrl });
      const link = initial.controls.find(control => control.name === "Tee Time");
      if (!pageWrapper) {
        expect(link).toBeUndefined(); expect(initial.controls).toEqual([]);
        await expect(session.execute({ id: 2, action: "inspect_adapter", url: entry })).rejects.toThrow("UNOBSERVED_NAVIGATION");
        expect(inspectAdapter).not.toHaveBeenCalled(); expect(fixedFetch).not.toHaveBeenCalled();
        return;
      }
      expect(link).toBeDefined(); expect(recipeSelectorSchema.safeParse(link!.selector).success).toBe(true);
      expect(initial.controls).toHaveLength(1);
      expect(initial.elements).toContainEqual(expect.objectContaining({ tag: "h1", text: venueName }));
      expect(JSON.stringify(initial)).not.toMatch(/private-(?:sentinel|text|hidden|textarea|anchor)/u);
      for (const url of ["https://example.org/account", "https://example.org/checkout"])
        await expect(session.execute({ id: 2, action: "open", url })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      const document = browser!.contexts().flatMap(context => context.pages()).find(page => page.url() === finalUrl)!;
      expect(await document.evaluate(() => ({ submitted: (window as unknown as { wrapperSubmitted?: boolean }).wrapperSubmitted,
        clicked: (window as unknown as { wrapperClicked?: boolean }).wrapperClicked, reads: (window as unknown as { formValueReads: number }).formValueReads }))).toEqual({ reads: 0 });
      const followed = await session.execute({ id: 3, action: "click", target: link!.target });
      expect(followed.url).toBe(bookingUrl); expect(paths.every(path => path.startsWith("GET "))).toBe(true);
      const inspected = await session.execute({ id: 4, action: "inspect_adapter", url: entry });
      expect(inspected.adapter).toMatchObject({ family: "USCHEDULE", publicLocationProof: { locationId: "82", includedPartySize: 2 } });
      expect(inspectAdapter).toHaveBeenCalledOnce(); expect(fixedFetch).toHaveBeenCalledTimes(2);
    } finally { await session.close(); proxy.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 40_000);
  it.each(["verified", "failed-refresh", "same-url-mutation", "direct-mutation", "foreign"] as const)("binds official identity to a fresh actual bare/www redirect: %s", async mode => {
    const officialUrl = "https://example.org/", finalUrl = "https://www.example.org/", bookingUrl = "https://clients.uschedule.com/examplegolf/booking";
    const entry = `${bookingUrl}?filter=loc[82]`, venueName = "Example Indoor Golf Club", venueAddress = "10 Main Street, Example, WA 98000, USA";
    const fixture = `<html><body><h1>${venueName}</h1><p>${venueAddress}</p><a href="${entry}">Book tee times</a></body></html>`;
    let documentStatus = 200, browser: Browser | undefined;
    const server = createServer({ cert: tlsLiteral("fixtureCertificate"), key: tlsLiteral("fixtureKey") }, (request, response) => {
      if (request.headers.host === "example.org") { response.writeHead(302, { location: mode === "foreign" ? "https://foreign.example.net/" : finalUrl }); response.end(); }
      else if (["www.example.org", "foreign.example.net"].includes(request.headers.host ?? "")) { response.writeHead(documentStatus, { "content-type": "text/html" }); response.end(fixture); }
      else { response.writeHead(500); response.end("Unbound offline request"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port, realProxy = nativeBrowser.createNativePublicBrowserProxy;
    const proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(config => realProxy(config, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }], connect: () => connect(port, "127.0.0.1"),
    }));
    const inspectAdapter = vi.fn(async (source, deps) => {
      const official = deriveUScheduleOfficialLocation(source, deps.officialIdentityPage ?? { url: "about:blank", html: "" });
      expect(official.officialPageUrl).toBe(finalUrl);
      return { adapter: { family: "USCHEDULE" as const, tenant: "examplegolf", serviceId: "73", serviceName: "Simulator Rental" } };
    });
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: [officialUrl],
      venueOfficialUrl: officialUrl, venueName, venueAddress, timeZone: "America/Los_Angeles" }, { browserTransport: "NATIVE_CHROME", inspectAdapter,
      launchBrowser: async () => browser = await launchPublicReadBrowser({ executablePath: chrome, headless: true, args: ["--ignore-certificate-errors"] }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      await session.execute({ id: 1, action: "open", url: officialUrl });
      if (mode === "failed-refresh") { documentStatus = 503; await session.execute({ id: 2, action: "open", url: finalUrl }); }
      if (mode === "same-url-mutation" || mode === "direct-mutation") {
        await browser!.contexts().flatMap(context => context.pages()).find(page => page.url() === finalUrl)!.evaluate(() => { history.pushState({}, "", "/other"); });
        if (mode === "same-url-mutation") await session.execute({ id: 3, action: "observe" });
      }
      const inspection = session.execute({ id: 4, action: "inspect_adapter", url: new URL(entry).href });
      if (mode === "verified") expect((await inspection).adapter).toMatchObject({ family: "USCHEDULE" });
      else await expect(inspection).rejects.toThrow("USCHEDULE_PUBLIC_LOCATION_UNVERIFIED");
      expect(inspectAdapter).toHaveBeenCalledOnce();
    } finally { await session.close(); proxy.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 35_000);
});
