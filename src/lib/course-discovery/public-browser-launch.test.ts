// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchPublicReadBrowser } from "./public-browser-launch";

afterEach(() => vi.restoreAllMocks());
describe("owned public browser profile", () => {
  it("disables preloading before launch and cleans the profile on idempotent close", async () => {
    let profile = "";
    const close = vi.fn(async () => {});
    const browser = { close, on: vi.fn() } as unknown as Browser;
    const launch = vi.spyOn(chromium, "launchPersistentContext").mockImplementation(async (directory, options) => {
      profile = directory;
      expect(JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8"))).toEqual({ net: { network_prediction_options: 2 } });
      expect(options).toMatchObject({ serviceWorkers: "block", acceptDownloads: false, headless: true });
      expect(options?.args).toEqual(["--disable-quic"]);
      return { browser: () => browser } as BrowserContext;
    });
    const opened = await launchPublicReadBrowser({ headless: true, args: ["--disable-quic"] });
    expect(opened).toBe(browser); expect(launch).toHaveBeenCalledOnce(); expect(existsSync(profile)).toBe(true);
    await Promise.all([opened.close(), opened.close()]);
    expect(close).toHaveBeenCalledOnce(); expect(existsSync(profile)).toBe(false);
  });

  it("removes only its new profile and preserves launch failure", async () => {
    let profile = "";
    const error = new Error("BROWSER_START_FAILED");
    vi.spyOn(chromium, "launchPersistentContext").mockImplementation(async directory => { profile = directory; throw error; });
    await expect(launchPublicReadBrowser({ headless: true })).rejects.toBe(error);
    expect(profile).toContain("tee-time-public-browser-"); expect(existsSync(profile)).toBe(false);
  });

  it("preserves a live profile and original close failure until actual disconnect", async () => {
    let profile = "";
    let disconnected: () => void = () => {};
    const error = new Error("BROWSER_CLOSE_FAILED");
    const browser = { close: async () => { throw error; }, on: vi.fn((_event, callback) => { disconnected = callback; }) } as unknown as Browser;
    vi.spyOn(chromium, "launchPersistentContext").mockImplementation(async directory => {
      profile = directory; return { browser: () => browser } as BrowserContext;
    });
    const opened = await launchPublicReadBrowser({ headless: true });
    await expect(opened.close()).rejects.toBe(error);
    expect(existsSync(profile)).toBe(true);
    disconnected();
    await vi.waitFor(() => expect(existsSync(profile)).toBe(false));
  });
});
