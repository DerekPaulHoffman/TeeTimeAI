// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
describe.skipIf(!executablePath)("guarded official-to-provider iframe source chain", () => {
  const official = "https://venue.example/", provider = "https://booking.example/club/12", widget = "https://booking.example/club/12/widget";
  const identity = { venueOfficialUrl: official, venueName: "Harbour Pointe Golf Club", venueAddress: "11817 Harbour Pointe Blvd, Mukilteo, WA 98275, USA" };
  const providerHtml = (wrong = false) => `<html><body><h1>${wrong ? "Another Golf Club" : identity.venueName}</h1><a href="https://maps.example/">11817 Harbour Pointe Blvd, Mukilteo, Washington, 98275</a><iframe title="Profile Page Booking Widget" src="${widget}" style="width:480px;height:700px"></iframe></body></html>`;
  async function fixture(wrong = false) {
    const fetcher = vi.fn(async value => new Response(String(value) === official
      ? `<h1>Official golf</h1><a href="${provider}">Book tee times</a>` : String(value) === widget ? "<h1>Public widget</h1>" : providerHtml(wrong),
    { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official, provider], deadlineAt: new Date(Date.now() + 25_000), ...identity }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    return { session, fetcher };
  }
  it("promotes only a visible provider iframe after the real official link and canonical visible identity, without executing the frame", async () => {
    const { session, fetcher } = await fixture();
    try {
      const first = await session.execute({ id: 1, action: "open", url: official });
      const link = first.controls.find(control => control.name === "Book tee times")!;
      const landing = await session.execute({ id: 2, action: "click", target: link.target });
      expect(landing.url).toBe(provider); expect(landing.navigationStatus).toBe(200);
      expect(landing.frames).toContainEqual({ url: widget, source: "OFFICIAL_IFRAME_SRC" });
      expect(fetcher.mock.calls.map(args => String(args[0]))).toEqual([official, provider]);
      const standalone = await session.execute({ id: 3, action: "open", url: widget });
      expect(standalone.text).toContain("Public widget"); expect(fetcher).toHaveBeenCalledTimes(3);
    } finally { await session.close(); }
  }, 30_000);
  it.each([false, true])("does not make a provider URL a parent from initial admission or a wrong identity (%s)", async wrong => {
    const { session, fetcher } = await fixture(wrong);
    try {
      if (wrong) await session.execute({ id: 1, action: "open", url: official });
      const landing = await session.execute({ id: 2, action: "open", url: provider });
      expect(landing.frames).not.toContainEqual(expect.objectContaining({ url: widget, source: "OFFICIAL_IFRAME_SRC" }));
      await expect(session.execute({ id: 3, action: "open", url: widget })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(fetcher.mock.calls.map(args => String(args[0]))).not.toContain(widget);
    } finally { await session.close(); }
  }, 30_000);
});
