// @vitest-environment node
// Local Chrome plus an injected in-memory transport only; no provider/DB/model.
import { existsSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://example.reservewithrex.com", entry = `${origin}/package?venue=Example&date=2026-10-23&guests=1`;
const venueId = "11111111-2222-3333-4444-555555555555", packageId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const publicCatalog = { id: venueId, name: "Example", packages: [{ id: packageId, name: "Golf Simulator", status: true,
  isHidden: false, contactOnly: false, isMemberOnlyPackage: false, numberOfLanes: 1, minGuests: 1, maxGuests: 8 }] };
const html = `<html><body><h1>Example</h1><div class="package-list-v2-gap">
  <article id="rental" class="package-card-v2 package-card-v2--package"><div class="package-card-v2-inside" data-testid="package-cards">
    <div class="package-card__content-v2"><p class="package-card__title-v2">Golf Simulator</p><p>Ultra immersive curved golf simulator</p>
    <div class="package-card__actions-v2"><div>1–8 Guests</div><div>1–5 Hours</div><div class="package-card__actions-right"><button><svg></svg></button></div></div></div>
  </div></article></div><script>
  const body={venueId:'${venueId}',date:'2026-10-23',guests:1,duration:2};
  fetch('/api/venue/get',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    .then(()=>{window.catalogReady=true;});
  document.querySelector('#rental').onclick=async()=>{
    await fetch('/api/venue/get-venue-with-package',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,packageId:'${packageId}'})});
    const url=new URL(location.href);url.searchParams.set('currentPackage','Golf Simulator');history.replaceState({},'',url);window.tileOpened=true;
  };</script></body></html>`;

describe.runIf(existsSync(chrome))("actual public catalog tile controller", () => {
  it("exposes the evidenced nonsemantic article and opens only its public package filter", async () => {
    let browser: Browser | undefined;
    const posts: string[] = [];
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [entry], venueOfficialUrl: entry, venueName: "Example",
      deadlineAt: new Date(Date.now() + 20_000), timeZone: "America/Los_Angeles" }, {
      browserTransport: "PINNED_HTTP", launchBrowser: async () => browser = await chromium.launch({ executablePath: chrome, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      fetch: async (url, init) => {
        const target = new URL(String(url));
        if (target.origin !== origin) throw new Error("UNEXPECTED_FIXTURE_ORIGIN");
        if (init?.method === "POST") { expect(["/api/venue/get", "/api/venue/get-venue-with-package"]).toContain(target.pathname); posts.push(target.pathname); }
        return new Response(target.pathname === "/package" ? html : JSON.stringify(publicCatalog), { status: 200,
          headers: { "content-type": target.pathname === "/package" ? "text/html" : "application/json" } });
      },
    });
    try {
      await session.execute({ id: 1, action: "open", url: entry });
      await browser!.contexts()[0].pages()[0].waitForFunction(() => Boolean((window as Window & { catalogReady?: boolean }).catalogReady));
      const snapshot = await session.execute({ id: 2, action: "observe" });
      const tile = snapshot.controls.find(control => control.name === "Golf Simulator" && control.kind === "filter");
      expect(tile).toBeDefined();
      await session.execute({ id: 3, action: "click", target: tile!.target });
      expect(new URL(browser!.contexts()[0].pages()[0].url()).searchParams.get("currentPackage")).toBe("Golf Simulator");
      expect(posts).toEqual(["/api/venue/get", "/api/venue/get-venue-with-package"]);
    } finally { await session.close(); }
  }, 25_000);

  it.each(["2026-10-23", "2026-10-24"])("replays the shared tile, separate duration and requested date independently (%s)", async date => {
    const result = await replay(date);
    expect(result.status, JSON.stringify(result.evidence)).toBe("AVAILABLE"); expect(result.complete).toBe(true);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].startsAt).toBe(`${date}T17:00:00.000Z`);
    expect(result.slots[0].endsAt).toBe(`${date}T18:00:00.000Z`);
  }, 25_000);
  it.each(["lost-package", "wrong-duration", "application-error"] as const)("never accepts an unrelated final proof (%s)", async mode => {
    const result = await replay("2026-10-23", mode);
    expect(result.status, JSON.stringify(result.evidence)).toBe("INCOMPLETE"); expect(result.complete).toBe(false); expect(result.slots).toEqual([]);
  }, 25_000);
});

async function replay(date: string, mode = "valid") {
  const pageUrl = `${origin}/package?venue=Example`;
  const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "PINNED_HTTP",
    target: { courseId: "course-1", offeringId: "rental-1", kind: "SIMULATOR" },
    source: { officialUrl: pageUrl, bookingUrl: pageUrl, venueName: "Example", providerFamily: "REX", timeZone: "America/Los_Angeles" }, pageUrl,
    permittedRoutes: [{ origin, path: "/package", methods: ["GET"], queryKeys: ["venue", "date", "guests", "currentPackage"] },
      { origin, path: "/api/venue/get", methods: ["POST"], queryKeys: [] },
      { origin, path: "/api/venue/get-venue-with-package", methods: ["POST"], queryKeys: [] }],
    availabilityResponse: { url: `${origin}/api/venue/get-venue-with-package`, method: "POST", date: { source: "JSON_BODY", path: "date" },
      success: { path: "name", equals: "Example" } },
    steps: [{ action: "waitFor", selector: "#catalog-ready" }, { action: "clickFilter", selector: "#rental", text: "Golf Simulator", purpose: "OPEN_FILTER" },
      { action: "select", selector: "#duration", value: "{{durationMinutes}}", purpose: "DURATION" },
      { action: "fill", selector: "#date", value: "{{date}}", purpose: "DATE" }],
    proof: { venue: { selector: "h1" }, date: { selector: "#date", attribute: "value" }, complete: { availabilityResponse: true },
      durationMinutes: { selector: "#duration", attribute: "value", format: "INTEGER" } },
    slots: { scope: { selector: "#inventory", label: { selector: "h2" }, expectedLabel: "Golf Simulator" },
      collection: { selector: ".slot" }, startsAt: { selector: ".start" }, endsAt: { derive: "ADD_REQUESTED_DURATION" } },
  });
  const extra = `<input id="date" type="date" value="2026-10-22"><label for="duration">Duration</label>
    <select id="duration"><option value="30">30 minutes</option><option value="60">1 hour</option><option value="90">90 minutes</option></select>
    <section id="inventory"><h2>Golf Simulator</h2><div class="slot"><span class="start">10:00</span></div></section>`;
  const fixture = html.slice(0, html.indexOf("<script>")) + extra + `<script>
    let selected;
    const data=()=>({venueId:'${venueId}',date:document.querySelector('#date').value,guests:1,duration:Number(document.querySelector('#duration').value)/30,
      ...(selected&& !('${mode}'==='lost-package'&&document.querySelector('#date').value==='2026-10-23')?{packageId:selected}:{})});
    async function load(path){await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data())});
      const url=new URL(location.href);url.searchParams.set('date',document.querySelector('#date').value);if(selected)url.searchParams.set('currentPackage','Golf Simulator');history.replaceState({},'',url);}
    load('/api/venue/get').then(()=>{const ready=document.createElement('p');ready.id='catalog-ready';ready.textContent='Catalog ready';document.body.append(ready);});
    document.querySelector('#rental').onclick=()=>{selected='${packageId}';load('/api/venue/get-venue-with-package');};
    document.querySelector('#duration').onchange=()=>{if('${mode}'==='wrong-duration')document.querySelector('#duration').value='30';load('/api/venue/get-venue-with-package');};
    document.querySelector('#date').onchange=()=>load('/api/venue/get-venue-with-package');
  </script></body></html>`;
  const posts: Array<{ date: string; packageId?: string }> = [];
  const result = await executeAccessRecipe(recipe, { date, timeZone: "America/Los_Angeles", players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" }, {
    now: () => new Date("2026-10-22T14:00:00Z"), launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }),
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      expect(new URL(String(url)).origin).toBe(origin);
      if (init?.method === "POST") {
        expect(["/api/venue/get", "/api/venue/get-venue-with-package"]).toContain(path);
        const body = JSON.parse(String(init.body)); posts.push(body);
        return new Response(JSON.stringify(mode === "application-error" && body.date === date ? { error: "fixture failure" } : publicCatalog),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(fixture, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  expect(posts[0].packageId).toBeUndefined();
  if (mode === "valid") expect(posts.at(-1)).toMatchObject({ date, packageId });
  return result;
}
