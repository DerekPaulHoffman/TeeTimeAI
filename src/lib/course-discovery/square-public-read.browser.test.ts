// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const executablePath = [chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const source = "https://book.squareup.com/appointments/example12345678/location/LOC1234567890/availability";
const endpoint = "https://app.squareup.com/appointments/api/buyer/availability";

describe.skipIf(!executablePath)("guarded public Square calendar transport", () => {
  it("replays a source-bound availability POST independently of discovery", async () => {
    const body = { search_availability_request: { query: { filter: { location_id: "LOC1234567890",
      start_at_range: { start_at: "2030-01-04T00:00:00.000Z", end_at: "2030-01-05T00:00:00.000Z" },
      segment_filters: [{ service_variation_id: "A".repeat(24), team_member_id_filter: { any: ["public-team-1234"] } }],
    } } } };
    const html = `<html><body><h1 id="venue">Public simulator fixture</h1><p id="date">2030-01-04</p><p>Duration: <span id="duration">55</span> minutes</p><section class="resource"><h2 class="resource-name">Golf Simulator Room</h2><p id="empty">false</p><div id="slots"></div></section><script>
      fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(r=>r.json()).then(()=>{
        document.getElementById('slots').innerHTML='<div class="slot"><span class="start">2030-01-04T10:00:00.000Z</span><span class="end">2030-01-04T10:55:00.000Z</span><span class="spots">1</span></div><p id="loaded">true</p>';
      }).catch(()=>{});
    </script></body></html>`;
    const fetcher = vi.fn(async value => new Response(String(value) === source ? html : '{"available":true}', { headers: {
      "content-type": String(value) === source ? "text/html" : "application/json",
      "access-control-allow-origin": "https://book.squareup.com", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type",
    } })) as unknown as typeof fetch;
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", target: { kind: "SIMULATOR", courseId: "course-1", offeringId: "offering-1" },
      source: { venueName: "Public simulator fixture", officialUrl: source, bookingUrl: source, timeZone: "UTC", providerFamily: "SQUARE" }, pageUrl: source,
      availabilityResponse: { url: endpoint, method: "POST", date: { source: "JSON_BODY", path: "search_availability_request.query.filter.start_at_range.start_at", format: "SQUARE_PUBLIC_MONTH_RANGE" },
        endDatePath: "search_availability_request.query.filter.start_at_range.end_at" },
      permittedRoutes: [{ origin: "https://book.squareup.com", path: new URL(source).pathname, methods: ["GET"], queryKeys: [] },
        { origin: "https://app.squareup.com", path: "/appointments/api/buyer/availability", methods: ["POST"], queryKeys: [] }],
      steps: [{ action: "waitFor", selector: "#loaded" }], proof: { venue: { selector: "#venue" }, date: { selector: "#date" },
        durationMinutes: { selector: "#duration", format: "INTEGER" }, complete: { selector: "#loaded" }, empty: { selector: "#empty" } },
      slots: { scope: { selector: ".resource", label: { selector: ".resource-name" }, expectedLabel: "Golf Simulator Room" },
        collection: { selector: ".slot" }, startsAt: { selector: ".start" }, endsAt: { selector: ".end" }, availableSpots: { selector: ".spots" } } });
    const result = await executeAccessRecipe(recipe, { date: "2030-01-04", timeZone: "UTC", players: 2, durationMinutes: 55, startTime: "09:00", endTime: "18:00" }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(args => String(args[0]) === endpoint)).toHaveLength(1);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ startsAt: "2030-01-04T10:00:00.000Z", endsAt: "2030-01-04T10:55:00.000Z" }] });
  }, 75_000);
  it.each([false, true])("admits current-location availability and rejects a foreign location: %s", async foreign => {
    const body = { search_availability_request: { query: { filter: {
      location_id: foreign ? "OTH1234567890" : "LOC1234567890",
      start_at_range: { start_at: "2030-01-04T00:00:00.000-05:00", end_at: "2030-02-05T22:59:59.999-05:00" },
      segment_filters: [{ service_variation_id: "A".repeat(24), team_member_id_filter: { any: ["public-team-1234"] } }],
    } } } };
    const html = `<html><body><h1>Public simulator fixture</h1><button id="next">Next day</button><p id="status">Waiting</p><script>
      document.getElementById('next').onclick=()=>fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}})
        .then(r=>r.json()).then(()=>document.getElementById('status').textContent='Public slots loaded').catch(()=>{});
    </script></body></html>`;
    const fetcher = vi.fn(async value => new Response(String(value) === source ? html : '{"available":true}', { headers: {
      "content-type": String(value) === source ? "text/html" : "application/json",
      "access-control-allow-origin": "https://book.squareup.com", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type",
    } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now() + 60_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const first = await session.execute({ id: 1, action: "open", url: source });
      const next = first.controls.find(control => control.name === "Next day")!;
      const after = await session.execute({ id: 2, action: "click", target: next.target }).catch(() => null);
      const calls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(args => String(args[0]) === endpoint);
      if (foreign) { expect(calls).toHaveLength(0); expect(after?.text ?? "").not.toContain("Public slots loaded"); }
      else { expect(calls).toHaveLength(1); expect(after?.text).toContain("Public slots loaded"); }
    } finally { await session.close(); }
  }, 75_000);
});
