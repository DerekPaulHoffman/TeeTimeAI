import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Browser, LaunchOptions } from "@playwright/test";

/** Disable page preloading in a new owned profile before creating guarded
 * contexts. Existing user profiles are never read or modified. */
export async function launchPublicReadBrowser(options: LaunchOptions): Promise<Browser> {
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
    const context = await chromium.launchPersistentContext(profile, {
      ...options, serviceWorkers: "block", acceptDownloads: false,
    });
    const browser = context.browser();
    if (!browser) { await context.close(); throw new Error("PUBLIC_BROWSER_UNAVAILABLE"); }
    const originalClose = browser.close.bind(browser);
    let closing: Promise<void> | undefined, cleaning: Promise<void> | undefined;
    const cleanupOnce = () => cleaning ??= cleanup();
    browser.close = closeOptions => closing ??= (async () => {
      await originalClose(closeOptions);
      await cleanupOnce();
    })();
    // A failed close may leave Chrome alive. Preserve its profile until the
    // actual disconnect, and never replace the original close error.
    browser.on("disconnected", () => { void cleanupOnce().catch(() => {}); });
    return browser;
  } catch (error) { await cleanup().catch(() => {}); throw error; }
}
