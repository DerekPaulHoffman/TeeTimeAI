// @vitest-environment node
// Owned DOM and injected HTTP only: no provider, model, database or backend.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";

const official = "https://public-studio.example/", booking = "https://clients.uschedule.com/public-studio/booking";
const caption = "CLICK HERE TO CHECK AVAILABILITY, REGISTER & BOOK NOW";
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
it("collects mixed public availability navigation while role=button alone is not a registration action", async () => {
  const reads: string[] = [];
  const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], venueOfficialUrl: official, venueName: "Public Studio", deadlineAt: new Date(Date.now() + 15000) }, {
    browserTransport: "PINNED_HTTP", launchBrowser: () => chromium.launch(existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true }),
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    fetch: (async value => { const url = String(value);reads.push(url);
      if (url === official) return new Response(`<h1>Public Studio</h1><a id="plain" role="button" href="${booking}">BOOK NOW</a><a id="mixed" role="button" href="${booking}" onclick="globalThis.unexpectedRegistrationHandler=true;return false">${caption}</a>
        <form><a href="${booking}">${caption}</a></form><form><input type="password"><a href="${booking}">${caption}</a></form>
        <a hidden href="${booking}">${caption}</a><a download href="${booking}">${caption}</a><button>${caption}</button>`, { headers: { "content-type": "text/html" } });
      if (url === booking) return new Response("<h1>Public availability</h1>", { headers: { "content-type": "text/html" } });
      throw Error("UNEXPECTED_OWNED_FIXTURE_READ");
    }) as typeof fetch,
  });
  try {
    const snapshot = await session.execute({ id: "open", action: "open", url: official });
    expect(snapshot.controls.some(row => row.href === booking && row.name === "BOOK NOW")).toBe(true);
    expect(snapshot.controls.some(row => row.href === booking && row.name === caption)).toBe(true);
    expect(snapshot.controls.filter(row => row.href === booking && row.name === caption)).toHaveLength(1);
    const target = snapshot.controls.find(row => row.href === booking && row.name === caption)!;
    const result = await session.execute({ id: "navigate", action: "click", target: target.target });
    expect(result.url).toBe(booking);expect(reads).toContain(booking);
  } finally { await session.close(); }
}, 25000);
it("rejects a registered mixed link after it moves into a form, before navigating", async () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const reads: string[] = [];
  const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], venueOfficialUrl: official, deadlineAt: new Date(Date.now() + 15000) }, {
    browserTransport: "PINNED_HTTP", launchBrowser: async () => browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true }),
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    fetch: (async value => { reads.push(String(value));if (String(value) !== official) throw Error("STALE_LINK_MUST_NOT_NAVIGATE");
      return new Response(`<h1>Public Studio</h1><a id="mixed" href="${booking}">${caption}</a>`, { headers: { "content-type": "text/html" } });
    }) as typeof fetch,
  });
  try {
    const before = await session.execute({ id: "open", action: "open", url: official });
    const target = before.controls.find(row => row.href === booking)!;expect(target).toBeDefined();
    const page = browser!.contexts()[0].pages()[0];
    await page.evaluate(() => { const form = document.createElement("form");document.body.append(form);form.append(document.querySelector("#mixed")!); });
    await expect(session.execute({ id: "stale", action: "click", target: target.target })).rejects.toThrow("STALE_OR_UNKNOWN_CONTROL");
    expect(reads.every(url => url === official)).toBe(true);
  } finally { await session.close(); }
}, 25000);
