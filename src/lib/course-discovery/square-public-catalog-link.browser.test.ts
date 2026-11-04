import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import { launchPublicReadBrowser } from "./public-browser-launch";
import * as nativeBrowser from "./native-public-browser";
import * as controls from "./square-public-entry-control";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const catalog = "https://book.squareup.com/appointments/example12345678/location/LOC1234567890/services";
const source = catalog + "?color=054032&buttonTextColor=ffffff&locale=en&referrer=so";
const variant = catalog + "/M7X4A9B2C6D8E3F5G1H0J2K4";

describe.runIf(existsSync(executablePath))("native public Square catalog links", () => {
  it.each(["valid", "tsx", "spa-open", "spa-click", "hidden", "foreign", "dated", "form", "lesson", "duplicate", "unsafe-path", "query", "disabled"])("opens only a visible undated public rental variant: %s", async mode => {
    const material = readFileSync("src/lib/course-discovery/cps-browser-wiring.test.ts", "utf8");
    const tls = (name: string) => JSON.parse(new RegExp(`^const ${name} = (".*");$`, "m").exec(material)![1]) as string;
    const href = mode === "foreign" ? variant.replace("book.squareup.com", "foreign.example") : variant + (mode === "unsafe-path" ? "/checkout" : mode === "query" ? "?slot_id=selected" : "");
    const raw = new URL(href).origin === new URL(catalog).origin ? new URL(href).pathname + new URL(href).search : href;
    const name = mode === "dated" ? "Golf Simulator Rental 9:00 AM" : mode === "lesson" ? "Golf Simulator Lesson" : "Golf Simulator Rental";
    const card = `<market-row class="service-row" interactive transient href="${raw}" ${mode === "hidden" ? 'hidden' : ""} ${mode === "disabled" ? "disabled" : ""}><label slot="label">${name}</label><div slot="subtext">${"Public rental description. ".repeat(40)} Price varies ・ 55 min+</div></market-row>`;
    const section = `<section aria-label="Main content"><h2>Services</h2>${card}${mode === "duplicate" ? card : ""}</section>`;
    const spa = mode.startsWith("spa-") ? `this.shadowRoot.querySelector('a').addEventListener('click',e=>{e.preventDefault();history.pushState({},'',this.getAttribute('href'));document.body.innerHTML='<h1>Public rental options</h1>'})` : "";
    const html = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><h1>Harbor Indoor Golf</h1>${mode === "form" ? `<form>${section}</form>` : section}<script>customElements.define('market-row',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<a href="'+this.getAttribute('href')+'"><slot name="label"></slot><slot name="subtext"></slot></a>';${spa}}})</script></body></html>`;
    const reads: string[] = [];
    const server = createServer({ key: tls("fixtureKey"), cert: tls("fixtureCertificate") }, (request, response) => {
      reads.push(request.url!); response.writeHead(200, { "content-type": "text/html" }).end(request.url === new URL(source).pathname + new URL(source).search ? html : '<h1>Public rental options</h1>');
    });
    const originalProxy = nativeBrowser.createNativePublicBrowserProxy;
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
    let proxy: ReturnType<typeof vi.spyOn> | undefined, runtime: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (mode === "tsx") {
        const serialized = execFileSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "-e", 'import {inspectSquarePublicCatalogLinkElement as f} from "./src/lib/course-discovery/square-public-entry-control.ts"; process.stdout.write(f.toString())'], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000, windowsHide: true });
        runtime = vi.spyOn(controls, "inspectSquarePublicCatalogLinkElement").mockImplementation(new Function(`return (${serialized})`)());
        Object.defineProperty(runtime, "toString", { value: () => serialized });
      }
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
      proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(input => originalProxy({ ...input, requireHostAdmission: true }, {
        resolveAddresses: async hostname => { if (hostname !== "book.squareup.com") throw Error("UNOWNED_FIXTURE_HOST"); return [{ address: "93.184.216.34", family: 4 }]; },
        connect: () => connect({ host: "127.0.0.1", port }),
      }));
      session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], venueOfficialUrl: "https://harbor.example/", venueName: "Harbor Indoor Golf", deadlineAt: new Date(Date.now() + 25_000) }, {
        browserTransport: "NATIVE_CHROME", requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
        launchBrowser: () => launchPublicReadBrowser({ executablePath, headless: true, args: ["--ignore-certificate-errors"] }),
      });
      const initial = await session.execute({ id: 1, action: "open", url: source });
      const rental = initial.controls.find(control => control.name === "Golf Simulator Rental");
      if (mode === "valid" || mode === "tsx" || mode.startsWith("spa-")) {
        expect(rental).toMatchObject({ kind: "link", name: "Golf Simulator Rental", href: variant });
        expect(rental!.selector).toContain("market-row:nth-of-type(");
        expect(initial.controls.filter(control => control.href === variant)).toHaveLength(1);
        const result = await session.execute(mode === "spa-click" ? { id: 2, action: "click", target: rental!.target } : { id: 2, action: "open", url: rental!.href! });
        expect(result.url).toBe(variant); expect(result.navigationStatus).toBe(200);
        expect(reads).toEqual([new URL(source).pathname + new URL(source).search, ...(mode.startsWith("spa-") ? [] : [new URL(variant).pathname])]);
        if (mode.startsWith("spa-")) expect(result.requestCount).toBe(initial.requestCount);
      } else { expect(rental).toBeUndefined(); expect(reads).toEqual([new URL(source).pathname + new URL(source).search]); }
    } finally { await session?.close(); runtime?.mockRestore(); proxy?.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 35_000);
});
