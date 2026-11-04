import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import { launchPublicReadBrowser } from "./public-browser-launch";
import * as nativeBrowser from "./native-public-browser";
import * as entryControls from "./square-public-entry-control";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const source = "https://square-entry-course.example/s/appointments";
const catalog = "https://book.squareup.com/appointments/example12345678/location/LOC1234567890/services";

describe.runIf(existsSync(executablePath))("native public Square calendar entry", () => {
  it.each(["valid", "budget", "gateway", "window-open", "linked", "root-redirect", "role-button", "role-button-unrelated", "tsx", "presentation", "foreign", "transaction", "hidden", "duplicate", "form", "associated-form", "slot", "outside-slot", "changed"] as const)(
    "binds the public widget and admits only one undated native catalog GET: %s", async mode => {
      const material = readFileSync("src/lib/course-discovery/cps-browser-wiring.test.ts", "utf8");
      const tls = (name: string) => JSON.parse(new RegExp(`^const ${name} = (".*");$`, "m").exec(material)![1]) as string;
      const destination = mode === "foreign" ? "https://unobserved.example/services" : mode === "presentation" ? catalog + "?color=ffffff&locale=en-US&referrer=so" : mode === "gateway" ? "https://app.squareup.com/appointments/book/LOC1234567890/start" : catalog;
      const currentSource = mode === "root-redirect" ? source.replace("square-entry-course.example", "www.square-entry-course.example") : source;
      const linked = ["linked", "root-redirect", "role-button", "role-button-unrelated"].includes(mode);
      const official = linked ? "https://square-entry-course.example/" : source;
      const initialReads = [...(mode === "root-redirect" ? [{ method: "GET", path: "/" }, { method: "GET", path: "/" }] : linked ? [{ method: "GET", path: "/" }] : []), { method: "GET", path: "/s/appointments" }];
      const button = `<div class="w-wrapper button book-button"><button id="entry" class="w-button" type="submit" ${mode === "associated-form" ? 'form="external"' : ""}>Book</button></div>`;
      const widget = `<div class="w-container row" ${mode === "hidden" ? 'style="display:none"' : ""}><h2>Book a tee time</h2><div>${button}</div><button type="button">My bookings</button>${mode === "slot" ? '<div data-slot-id="selected">Selected time</div>' : ""}</div>`;
      const action = mode === "transaction" ? `const f=document.createElement('form');f.method='POST';f.action=${JSON.stringify(destination)};document.body.append(f);f.submit()` : mode === "window-open" || mode === "gateway" ? `window.open(${JSON.stringify(destination)},'_self')` : `location.assign(${JSON.stringify(destination)})`;
      const html = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><h1>Harbor Indoor Golf</h1>${mode === "form" ? `<form>${widget}</form>` : widget}${mode === "duplicate" ? widget : ""}${mode === "associated-form" ? '<form id="external"></form>' : ""}${mode === "outside-slot" ? '<div data-slot-id="selected">Selected time</div>' : ""}<script>document.querySelector('#entry').addEventListener('click',e=>{e.preventDefault();${action}})</script></body></html>`;
      const reads: Array<{ method: string; path: string }> = [];
      const server = createServer({ key: tls("fixtureKey"), cert: tls("fixtureCertificate") }, (request, response) => {
        reads.push({ method: request.method!, path: request.url! });
        if (request.url?.startsWith("/static/public-")) { response.writeHead(200, { "content-type": "text/javascript" }).end("window.fixturePublicAsset=true;"); return; }
        if (mode === "gateway" && request.headers.host === "app.squareup.com") { response.writeHead(302, { location: catalog }).end(); return; }
        if (request.url === "/") {
          if (mode === "root-redirect" && request.headers.host === "square-entry-course.example") {
            response.writeHead(301, { location: "https://www.square-entry-course.example/" }).end(); return;
          }
          response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body><h1>Harbor Indoor Golf</h1><a href="${currentSource}" ${mode.startsWith("role-button") ? 'role="button"' : ""}>${mode === "role-button-unrelated" ? "GOLF COURSE" : "Book a tee time"}</a></body></html>`); return;
        }
        const assets = mode === "budget" ? Array.from({ length: 200 }, (_, i) => `<script defer src="/static/public-${i}.js"></script>`).join("") : "";
        response.writeHead(200, { "content-type": "text/html" }).end(request.url === "/s/appointments" ? html : `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><h1>Public rental services</h1>${assets}</body></html>`);
      });
      const originalProxy = nativeBrowser.createNativePublicBrowserProxy;
      let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
      let browser: Awaited<ReturnType<typeof launchPublicReadBrowser>> | undefined;
      let proxy: ReturnType<typeof vi.spyOn> | undefined;
      let runtimeControl: ReturnType<typeof vi.spyOn> | undefined;
      try {
        if (mode === "tsx") {
          const serialized = execFileSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "-e",
            'import {inspectSquarePublicEntryElement as f} from "./src/lib/course-discovery/square-public-entry-control.ts"; process.stdout.write(f.toString())'],
            { cwd: process.cwd(), encoding: "utf8", timeout: 15_000, windowsHide: true });
          const compiled = new Function(`return (${serialized})`)() as typeof entryControls.inspectSquarePublicEntryElement;
          runtimeControl = vi.spyOn(entryControls, "inspectSquarePublicEntryElement").mockImplementation(compiled);
          // Playwright serializes the function. Send the worker-compiled body,
          // without Vitest's server-side call-tracking wrapper.
          Object.defineProperty(runtimeControl, "toString", { value: () => serialized });
        }
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
        proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(input => originalProxy({ ...input, requireHostAdmission: true }, {
          resolveAddresses: async hostname => {
            if (!["square-entry-course.example", "www.square-entry-course.example", "book.squareup.com", "app.squareup.com", "unobserved.example"].includes(hostname)) throw Error("UNOWNED_FIXTURE_HOST");
            return [{ address: "93.184.216.34", family: 4 }];
          }, connect: () => connect({ host: "127.0.0.1", port }),
        }));
        session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], venueOfficialUrl: official,
          venueName: "Harbor Indoor Golf", deadlineAt: new Date(Date.now() + 40_000) }, {
          browserTransport: "NATIVE_CHROME", requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
          launchBrowser: async () => browser = await launchPublicReadBrowser({ executablePath, headless: true, args: ["--ignore-certificate-errors"] }),
        });
        expect(session.diagnostics().requestLimit).toBe(192);
        let initial = await session.execute({ id: 1, action: "open", url: official });
        if (linked) {
          expect(initial.controls.find(control => control.href === currentSource)).toBeDefined();
          initial = await session.execute({ id: 10, action: "open", url: currentSource });
        }
        const entry = initial.controls.find(control => control.kind === "public-calendar-entry");
        if (["hidden", "duplicate", "form", "associated-form", "slot", "outside-slot"].includes(mode)) {
          expect(entry).toBeUndefined(); expect(reads).toEqual(initialReads); return;
        }
        expect(entry).toBeDefined(); expect(entry!.href).toBeUndefined();
        if (mode === "role-button-unrelated") {
          await expect(session.execute({ id: 2, action: "click", target: entry!.target })).rejects.toThrow("STALE_OR_UNKNOWN_CONTROL");
          expect(session.diagnostics().staleControlReason).toBe("PUBLIC_ENTRY_SOURCE_UNVERIFIED");
          expect(session.diagnostics().requestLimit).toBe(192);
          expect(reads).toEqual(initialReads);
        } else if (mode === "changed") {
          const page = browser!.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === source)!;
          await page.locator("#entry").evaluate(element => element.setAttribute("form", "changed"));
          await expect(session.execute({ id: 2, action: "click", target: entry!.target })).rejects.toThrow("STALE_OR_UNKNOWN_CONTROL");
        } else if (mode === "transaction") {
          await expect(session.execute({ id: 2, action: "click", target: entry!.target })).rejects.toThrow();
        } else if (mode === "foreign") {
          const result = await session.execute({ id: 2, action: "click", target: entry!.target });
          expect(result.navigationStatus).not.toBe(200); expect(result.controls).toEqual([]);
        } else {
          const trace: unknown[] = [];
          if (mode === "window-open") {
            const page = browser!.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === currentSource)!;
            const observer = await page.context().newCDPSession(page);
            observer.on("Page.windowOpen", event => trace.push({ event: "window", name: event.windowName, userGesture: event.userGesture }));
            observer.on("Page.frameRequestedNavigation", event => trace.push({ event: "intent", reason: event.reason, disposition: event.disposition }));
            observer.on("Network.requestWillBeSent", event => { if (event.type === "Document") trace.push({ event: "network", userGesture: event.hasUserGesture, initiator: event.initiator.type }); });
            await observer.send("Page.enable"); await observer.send("Network.enable");
          }
          let result = await session.execute({ id: 2, action: "click", target: entry!.target });
          if (mode === "budget") await vi.waitFor(async () => {
            expect(reads.filter(read => read.path.startsWith("/static/public-"))).toHaveLength(200);
            result = await session!.execute({ id: 20, action: "observe" }); expect(result.loading).toBe(false);
          }, { timeout: 20_000, interval: 100 });
          if (mode === "window-open") {
            expect(trace).toContainEqual({ event: "intent", reason: "other", disposition: "currentTab" });
            expect(trace).toContainEqual({ event: "network", userGesture: true, initiator: "script" });
          }
          expect(result.url).toBe(mode === "gateway" ? catalog : destination); expect(result.navigationStatus).toBe(200);
          expect(result.nativeGestureCompletion).toBeUndefined(); // A button never fabricates anchor provenance.
          expect(session.diagnostics().requestLimit).toBe(512);
          if (mode === "budget") {
            expect(result.requestCount).toBeGreaterThan(192);
            expect(reads.filter(read => read.path.startsWith("/static/public-"))).toHaveLength(200);
          } else expect(reads).toEqual([...initialReads, { method: "GET", path: new URL(destination).pathname + new URL(destination).search }, ...(mode === "gateway" ? [{ method: "GET", path: new URL(catalog).pathname }] : [])]);
        }
        if (["changed", "foreign", "transaction"].includes(mode)) { expect(reads).toEqual(initialReads); expect(session.diagnostics().requestLimit).toBe(192); }
      } finally { await session?.close(); runtimeControl?.mockRestore(); proxy?.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }, 55_000);
});
