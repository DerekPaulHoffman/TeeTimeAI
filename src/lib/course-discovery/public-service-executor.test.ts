// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { executeAccessRecipe, type AccessExecutorDependencies } from "./executor";
import { parseAccessRecipe } from "./recipe";

const executablePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 3,
  durationMinutes: 60, startTime: "08:00", endTime: "12:00" };
const serviceSteps = [
  { action: "selectRentalService", selector: "#service", optionText: "Golf Simulator $30" },
  { action: "continueToAvailability", selector: "#next", mode: "SERVICE" },
  { action: "continueToAvailability", selector: "#skip", mode: "SKIP_PACKAGES" },
];
function recipe(steps = serviceSteps) {
  return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "PINNED_HTTP",
    target: { kind: "SIMULATOR", courseId: "service-fixture", offeringId: "rental-fixture" },
    source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/availability",
      venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
    pageUrl: "https://example.org/availability", steps,
    permittedRoutes: [{ origin: "https://example.org", path: "/availability", methods: ["GET"], queryKeys: ["date"] },
      { origin: "https://example.org", path: "/next", methods: ["GET"], queryKeys: [] }],
    availabilityResponse: { url: "https://example.org/availability?date={{date}}", method: "GET",
      date: { source: "QUERY", path: "date" }, success: { path: "ok", equals: true } },
    proof: { venue: { selector: "#venue" }, date: { selector: "#date" },
      complete: { availabilityResponse: true }, durationMinutes: { selector: "#duration" } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, endsAt: { selector: ".end" },
      scope: { selector: ".resource", label: { selector: "h2" }, expectedLabel: "Golf Simulator" } },
  });
}
const inventory = (duration: string) => `<h1 id="venue">Example Golf</h1><p id="date">2026-10-23</p>
  <p id="duration">${duration}</p><section class="resource"><h2>Golf Simulator</h2>
  <div class="slot"><span class="start">09:00</span><span class="end">10:00</span></div></section>`;
function fixture(options: { duration?: string; stale?: boolean } = {}) {
  const results = inventory(options.duration ?? "60");
  return `<!doctype html><html><body><main><div id="widget">
    <form id="service-form"><label for="service">Select Service</label><select id="service">
      <option value="">Select Service</option><option value="lesson">Golf Lessons $40</option>
      <option value="rental">Golf Simulator $30</option></select>
      <button id="next" type="button">Continue</button></form>
    <section id="packages" hidden><p>Golf Simulator $30</p><h2>Packages</h2>
      <p>You can purchase packages with this service.</p>
      <button id="skip" type="button">Skip packages and continue with the selected service $30.00 - $50.00</button></section>
    </div></main><a href="https://example.org/next" id="link">View availability</a><div id="results"></div><p id="prefetch" hidden>Ready</p>
    <script>
      document.querySelector('#next').onclick=()=>{document.querySelector('#next').hidden=true;document.querySelector('#packages').hidden=false;};
      document.querySelector('#skip').onclick=()=>{document.querySelector('#packages').hidden=true;${options.stale
        ? `document.querySelector('#results').innerHTML=${JSON.stringify(results)};`
        : `fetch('/availability?date=2026-10-23').then(r=>r.json()).then(r=>{if(r.ok)document.querySelector('#results').innerHTML=${JSON.stringify(results)};});`}};
      ${options.stale ? "fetch('/availability?date=2026-10-23').then(r=>r.json()).then(()=>{document.querySelector('#prefetch').hidden=false;});" : ""}
    </script></body></html>`;
}
function dependencies(html: string, timeoutMs = 15_000) {
  const reads: string[] = [];
  const now = new Date("2026-10-20T12:00:00Z");
  const deps: AccessExecutorDependencies = {
    now: () => now, deadlineAt: new Date(now.getTime() + timeoutMs),
    launchBrowser: () => chromium.launch({ executablePath, headless: true }),
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    fetch: (async value => {
      const url = String(value); reads.push(url);
      if (url === "https://example.org/availability?date=2026-10-23")
        return Response.json({ ok: true });
      if (url === "https://example.org/availability" || url === "https://example.org/next")
        return new Response(html, { headers: { "content-type": "text/html" } });
      throw new Error("UNEXPECTED_FIXTURE_REQUEST");
    }) as typeof fetch,
  };
  return { deps, reads };
}

describe.runIf(existsSync(executablePath))("public service recipe replay", () => {
  it("selects a public rental and skips optional packages before proving fresh inventory", async () => {
    const test = dependencies(fixture());
    const result = await executeAccessRecipe(recipe(), input, test.deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { durationVerified: true } });
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({ startsAt: "2026-10-23T13:00:00.000Z", endsAt: "2026-10-23T14:00:00.000Z",
      availableSpots: 1, capacity: null });
    expect(test.reads).toContain("https://example.org/availability?date=2026-10-23");
  }, 20_000);

  it("cannot continue from a selected-looking page without a verified selection in this execution", async () => {
    const test = dependencies(fixture());
    const result = await executeAccessRecipe(recipe(serviceSteps.slice(1)), input, test.deps);
    expect(result).toMatchObject({ status: "FAILED", complete: false, slots: [],
      evidence: { reason: "UNVERIFIED_RENTAL_SERVICE" } });
    expect(test.reads).toEqual(["https://example.org/availability"]);
  }, 20_000);

  it("does not infer the requested duration from successful service selection", async () => {
    const test = dependencies(fixture({ duration: "90" }));
    const result = await executeAccessRecipe(recipe(), input, test.deps);
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [],
      evidence: { reason: "DURATION_PROOF_MISMATCH" } });
  }, 20_000);

  it("clears service authority when a recipe navigates to another document", async () => {
    const test = dependencies(fixture());
    const steps = [serviceSteps[0], { action: "followLink", selector: "#link", text: "View availability" }, serviceSteps[1]];
    const result = await executeAccessRecipe(recipe(steps), input, test.deps);
    expect(result).toMatchObject({ status: "FAILED", complete: false, slots: [],
      evidence: { reason: "UNVERIFIED_RENTAL_SERVICE" } });
    expect(test.reads).toContain("https://example.org/next");
    expect(test.reads).not.toContain("https://example.org/availability?date=2026-10-23");
  }, 20_000);

  it("does not reuse an availability response that completed before the service changed", async () => {
    const test = dependencies(fixture({ stale: true }), 7_000);
    const steps = [{ action: "waitFor", selector: "#prefetch" }, ...serviceSteps];
    const result = await executeAccessRecipe(recipe(steps), input, test.deps);
    expect(result.complete).toBe(false);
    expect(result.slots).toEqual([]);
    expect(test.reads.filter(url => url.includes("?date="))).toHaveLength(1);
  }, 15_000);
});
