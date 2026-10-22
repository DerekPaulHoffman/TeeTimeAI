// @vitest-environment node
// Actual isolated Chrome/CDP/CONNECT traffic terminates only in loopback TLS.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { Browser } from "@playwright/test";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import * as nativeBrowser from "./native-public-browser";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { deriveUScheduleOfficialLocation } from "@/lib/simulators/providers/uschedule-location-source";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
// Reuse the existing throwaway offline certificate without duplicating key material.
const tlsFixture = readFileSync(new URL("./cps-browser-wiring.test.ts", import.meta.url), "utf8");
function tlsLiteral(name: string): string {
  const literal = new RegExp(`^const ${name} = (".*");$`, "m").exec(tlsFixture)?.[1];
  if (!literal) throw new Error("OFFLINE_TLS_FIXTURE_MISSING");
  return JSON.parse(literal);
}
describe.runIf(existsSync(chrome))("actual native official-location provenance", () => {
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
