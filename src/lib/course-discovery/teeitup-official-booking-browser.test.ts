// @vitest-environment node
// Only local TLS/CONNECT traffic; public-looking names never reach a public host.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { Browser } from "@playwright/test";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import * as nativeBrowser from "./native-public-browser";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { inspectExistingAdapter } from "./existing-adapter-executor";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const tlsFixture = readFileSync(new URL("./cps-browser-wiring.test.ts", import.meta.url), "utf8");
function tlsLiteral(name: string): string {
  const literal = new RegExp(`^const ${name} = (".*");$`, "m").exec(tlsFixture)?.[1];
  if (!literal) throw new Error("OFFLINE_TLS_FIXTURE_MISSING"); return JSON.parse(literal);
}
describe.runIf(existsSync(chrome))("actual official booking source controller lineage", () => {
  it.each(["complete", "history-before-inspect", "history-after-inspect", "hidden-iframe"] as const)("certifies only the complete current rendered chain: %s", async mode => {
    const official = "https://example.org/", normal = "https://www.example.org/", bookingPage = `${normal}tee-times/`;
    const play = "https://example-course.play.teeitup.com/", book = "https://example-course.book.teeitup.com/";
    const venueName = "Example Ridge Golf Club", venueAddress = "565 Competition Road, Example, NC 27603, USA";
    const home = `<html><body><h2>Welcome to ${venueName}</h2><a id="tee-link" href="${bookingPage}">Tee Times</a><footer><p>${venueAddress}</p></footer></body></html>`;
    const embed = `<html><body><main${mode === "hidden-iframe" ? ' style="display:none"' : ""}><iframe src="${play}" width="800" height="600"></iframe></main></body></html>`;
    const paths: string[] = [];
    const server = createServer({ cert: tlsLiteral("fixtureCertificate"), key: tlsLiteral("fixtureKey") }, (request, response) => {
      const url = `https://${request.headers.host}${request.url}`; paths.push(`${request.method} ${url}`);
      if (url === official) { response.writeHead(302, { location: normal }); response.end(); }
      else if (url === normal) { response.writeHead(200, { "content-type": "text/html" }); response.end(home); }
      else if (url === bookingPage) { response.writeHead(200, { "content-type": "text/html" }); response.end(embed); }
      else if (url === play) { response.writeHead(302, { location: book }); response.end(); }
      else if (url === book) { response.writeHead(200, { "content-type": "text/html" }); response.end("<html><body>Public tee times</body></html>"); }
      else { response.writeHead(500); response.end("Unbound local request"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port, realProxy = nativeBrowser.createNativePublicBrowserProxy;
    const proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(config => realProxy(config, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }], connect: () => connect(port, "127.0.0.1"),
    }));
    const fixedFetch = vi.fn<typeof fetch>(async (value, init) => {
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
      const url = String(value);
      if (url === official) return new Response("", { status: 302, headers: { location: normal } });
      if (url === normal) return new Response(home, { headers: { "content-type": "text/html" } });
      if (url === bookingPage) return new Response(embed, { headers: { "content-type": "text/html" } });
      if (url === play) return new Response("", { status: 302, headers: { location: book } });
      if (url === book) return new Response("<html><body>Public tee times</body></html>", { headers: { "content-type": "text/html" } });
      if (url === "https://phx-api-be-east-1b.kenna.io/alias/example-course/facilities") return Response.json([{ id: 31, courseId: "public-course-31", name: venueName,
        address: "601 Competition Rd, Example, NC 27603, US", timeZone: "America/New_York", isSimulator: false }]);
      throw new Error("UNBOUND_FIXED_READER");
    });
    let browser: Browser | undefined;
    const inspectAdapter = vi.fn(async (source, deps) => {
      const result = await inspectExistingAdapter(source, { ...deps, fetch: fixedFetch });
      if (mode === "history-after-inspect") {
        const document = browser!.contexts().flatMap(context => context.pages()).find(page => page.url() === book)!;
        await document.evaluate(() => { history.pushState({}, "", "/different"); history.pushState({}, "", "/"); });
      }
      return result;
    });
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 45_000), initialUrls: [official],
      venueOfficialUrl: official, venueName, venueAddress, timeZone: "America/New_York" }, { browserTransport: "NATIVE_CHROME", inspectAdapter,
      launchBrowser: async () => browser = await launchPublicReadBrowser({ executablePath: chrome, headless: true, args: ["--ignore-certificate-errors"] }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: "open", url: official });
      expect(initial.nativeFirstFatal).toBeUndefined();
      const link = initial.controls.find(control => control.name === "Tee Times"); expect(link).toBeDefined();
      const page = await session.execute({ id: 2, action: "click", target: link!.target });
      expect(page.url).toBe(bookingPage); expect(page.nativeFirstFatal).toBeUndefined();
      if (mode === "hidden-iframe") {
        expect(page.frames.some(frame => frame.source === "OFFICIAL_IFRAME_SRC")).toBe(false);
        await expect(session.execute({ id: 3, action: "open", url: play })).rejects.toThrow("UNOBSERVED_NAVIGATION");
        expect(inspectAdapter).not.toHaveBeenCalled(); return;
      }
      expect(page.frames).toContainEqual({ url: play, source: "OFFICIAL_IFRAME_SRC" });
      const final = await session.execute({ id: 3, action: "open", url: play });
      expect(final.url).toBe(book); expect(final.navigationStatus).toBe(200); expect(final.nativeFirstFatal).toBeUndefined();
      if (mode === "history-before-inspect") {
        const document = browser!.contexts().flatMap(context => context.pages()).find(page => page.url() === book)!;
        await document.evaluate(() => { history.pushState({}, "", "/different"); history.pushState({}, "", "/"); });
      }
      const result = session.execute({ id: 4, action: "inspect_adapter", url: book });
      // A fresh native witness may re-attest the same completed document after
      // history changes; a change during inspection still invalidates its token.
      if (mode === "complete" || mode === "history-before-inspect") {
        expect((await result).adapter).toMatchObject({ family: "TEEITUP", alias: "example-course", facilityIds: [31], officialBookingSourceProof: {
          kind: "OFFICIAL_BOOKING_SOURCE", officialUrl: official, officialDocumentUrl: normal, bookingPageUrl: bookingPage, iframeEntryUrl: play,
          bookingSourceUrl: book, canonicalAddress: venueAddress, providerAddress: "601 Competition Rd, Example, NC 27603, US", providerAddressVerified: false,
          facilityId: 31, courseId: "public-course-31" } });
        expect(fixedFetch).toHaveBeenCalledTimes(6);
      } else await expect(result).rejects.toThrow(mode === "history-before-inspect" ? "OFFICIAL_IDENTITY_UNVERIFIED" : "OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
      expect(paths.every(path => path.startsWith("GET "))).toBe(true);
    } finally { await session.close(); proxy.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 50_000);
});
