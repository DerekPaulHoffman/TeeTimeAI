import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import type { Browser, LaunchOptions } from "@playwright/test";

const ownedLocalCdp = new WeakMap<Browser, string>();
/** Private controller seam; never include the result in model/tool/report data. */
export function ownedPublicBrowserCdp(browser: Browser) {
  const value = ownedLocalCdp.get(browser);
  if (!value || !browser.isConnected()) throw new Error("OWNED_PUBLIC_CDP_UNAVAILABLE");
  return value;
}

/** Disable page preloading in a new owned profile before creating guarded
 * contexts. Existing user profiles are never read or modified. */
export async function launchPublicReadBrowser(options: LaunchOptions, privateOptions: { localCdp?: boolean; extensionOrigin?: string } = {}): Promise<Browser> {
  if (privateOptions.extensionOrigin && (!privateOptions.localCdp || !/^chrome-extension:\/\/[a-p]{32}$/u.test(privateOptions.extensionOrigin))) throw new Error("OWNED_PUBLIC_CDP_UNAVAILABLE");
  const parent = resolve(tmpdir());
  const profile = await mkdtemp(join(parent, "tee-time-public-browser-"));
  const cleanup = async () => {
    if (dirname(profile) !== parent || !basename(profile).startsWith("tee-time-public-browser-")) throw new Error("UNSAFE_BROWSER_PROFILE_PATH");
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    await mkdir(join(profile, "Default"));
    await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({ net: { network_prediction_options: 2 } }));
    const { chromium } = await import("@playwright/test");
    let cdpPort: number | undefined;
    if (privateOptions.localCdp) {
      const reservation = createServer();
      await new Promise<void>((done, fail) => { reservation.once("error", fail); reservation.listen(0, "127.0.0.1", done); });
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("OWNED_PUBLIC_CDP_UNAVAILABLE");
      cdpPort = address.port;
      await new Promise<void>((done, fail) => reservation.close(error => error ? fail(error) : done()));
    }
    const context = await chromium.launchPersistentContext(profile, {
      ...options, serviceWorkers: "block", acceptDownloads: false,
      ...(privateOptions.localCdp ? {
        ...(options.proxy ? { proxy: { ...options.proxy, bypass: `127.0.0.1:${cdpPort}` } } : {}),
        args: [...(options.args ?? []), "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${cdpPort}`,
          // Playwright appends <-loopback> after its supplied bypass rules.
          // Chromium evaluates subtraction in order, so place our sole exact
          // private endpoint AFTER that subtraction in the final argument.
          ...(options.proxy ? [`--proxy-bypass-list=<-loopback>;127.0.0.1:${cdpPort}`] : []),
          ...(privateOptions.extensionOrigin ? [`--remote-allow-origins=${privateOptions.extensionOrigin}`] : [])],
      } : {}),
    });
    const browser = context.browser();
    if (!browser) { await context.close(); throw new Error("PUBLIC_BROWSER_UNAVAILABLE"); }
    if (privateOptions.localCdp) {
      let endpoint: string | undefined;
      try {
        const readOwned = async (route: string) => {
          const response = await fetch(`http://127.0.0.1:${cdpPort}${route}`, { signal: AbortSignal.timeout(3000), redirect: "error" });
          const text = await response.text();
          if (response.status !== 200 || text.length > 65536) throw new Error("OWNED_PUBLIC_CDP_UNAVAILABLE");
          return JSON.parse(text);
        };
        const descriptor = await readOwned("/json/version"), pages = await readOwned("/json/list");
        const control = await browser.newBrowserCDPSession();
        try {
          const owned = (await control.send("Target.getTargets")).targetInfos.filter(info => info.type === "page");
          // A port reservation race must never attach another local browser.
          // Compare unguessable target IDs obtained over our launch-owned pipe.
          if (!owned.length || !Array.isArray(pages) || !owned.every(target => pages.some(value => value.id === target.targetId))) throw new Error("OWNED_PUBLIC_CDP_UNAVAILABLE");
        } finally { await control.detach(); }
        const value = descriptor.webSocketDebuggerUrl;
        if (typeof value === "string" && new RegExp(`^ws://127\\.0\\.0\\.1:${cdpPort}/devtools/browser/[a-f0-9-]{20,80}$`, "u").test(value)) endpoint = value;
      } catch { /* Only the owned profile may describe this private endpoint. */ }
      if (!endpoint) { await browser.close(); throw new Error("OWNED_PUBLIC_CDP_UNAVAILABLE"); }
      ownedLocalCdp.set(browser, endpoint);
    }
    const originalClose = browser.close.bind(browser);
    let closing: Promise<void> | undefined, cleaning: Promise<void> | undefined;
    const cleanupOnce = () => cleaning ??= cleanup();
    browser.close = closeOptions => closing ??= (async () => {
      ownedLocalCdp.delete(browser);
      await originalClose(closeOptions);
      await cleanupOnce();
    })();
    // A failed close may leave Chrome alive. Preserve its profile until the
    // actual disconnect, and never replace the original close error.
    browser.on("disconnected", () => { void cleanupOnce().catch(() => {}); });
    return browser;
  } catch (error) { await cleanup().catch(() => {}); throw error; }
}
