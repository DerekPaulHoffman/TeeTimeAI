import { expect, it, vi } from "vitest";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import { matchesUScheduleOfficialShop } from "@/lib/course-discovery/uschedule-official-shop";
import { fetchUScheduleRecipeAvailability, inspectUScheduleRecipeConfiguration } from "./uschedule";

const bookingUrl = "https://clients.uschedule.com/exampleacademy/booking";
const serviceName = "Simulator Rental - One Hour";
const rental = { serviceId: "81", serviceName };
const controls = `<body class="exampleacademy"><select id="select_service"><option value="81" selected>${serviceName}</option>
  <option value="82">25 Minute Adult Golf Lesson</option><option value="83">Simulator rental - 2 Hours</option></select>`;
const input = { date: "2026-11-14", durationMinutes: 60, partySize: 1, requestedPlayers: 2, timeZone: "America/New_York",
  offering: { id: "o", courseId: "c", bookingUrl, providerFamilyKey: "USCHEDULE", active: true, publicAccessStatus: "PUBLIC" as const,
    providerMetadata: {}, maxPartySize: null, supportedDurationsMinutes: [60] } };

it("reads a named one-hour bay without posting a nonexistent duration control", async () => {
  const times = ["111420261000", "111520261000"];
  const listing = `${times.map(value =>
    `<div class="next_avail_results"><div class="next_avail_item" data-time="${value}" data-empid="0">${serviceName} - $45.00</div></div>`).join("")}
    <script>var chosenDate = new Date(2026,10,14); var lastAvailTime = '${times.at(-1)}';</script>`;
  let gets = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => init?.method === "POST" ? Response.json({ code: "refresh" }) :
    new Response(controls + (++gets === 2 ? listing : "") + "</body>", { headers: { "content-type": "text/html",
      ...(gets === 1 ? { "set-cookie": "ASP.NET_SessionId=OwnedAnonymous123; Secure" } : {}) } }));
  const session = createUSchedulePublicSession(bookingUrl, { fetch, requestLease: async (_family, work) => ({ acquired: true, value: await work() }) });
  try {
    expect(inspectUScheduleRecipeConfiguration(controls, bookingUrl)?.rentals.map(row => row.serviceId)).toEqual(["81", "83"]);
    const result = await fetchUScheduleRecipeAvailability(input, rental, session.read);
    expect(result.complete).toBe(true);
    expect(result.slots.map(slot => [slot.startsAt.toISOString(), slot.endsAt.toISOString()]))
      .toEqual([["2026-11-14T15:00:00.000Z", "2026-11-14T16:00:00.000Z"]]);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init?.body))
      .toEqual(['[{"Name":"start_date","Value":"11/14/2026"}]']);
  } finally { session.dispose(); }
});

it("rejects ambiguous fixed rentals and verifies the merchant's exact booking link and phone", () => {
  expect(inspectUScheduleRecipeConfiguration(controls.replace('value="82"', 'value="81"'), bookingUrl)).toBeUndefined();
  expect(inspectUScheduleRecipeConfiguration(controls + '<select id="select_group_size"></select>', bookingUrl)).toBeUndefined();
  const location = { business_name: "Example Golf Shop", phone: "+1 860-222-3333" };
  const cell = { content: { properties: { syncedLocation: location } } };
  const siteData = { snapshot: { properties: { title: "Example Golf Shop", contentAreas: {
    header: { content: { properties: { actionButton: { link: { link: { external: bookingUrl } } } } } },
  } } }, page: { properties: { contentAreas: { userContent: { content: { cells: [cell] } } } } } };
  const official = `<script>window.__BOOTSTRAP_STATE__ = ${JSON.stringify({ siteData })};</script>`;
  const source = { bookingUrl, venueName: "Example Virtual Golf" };
  expect(matchesUScheduleOfficialShop(official, source, "+18602223333")).toBe(true);
  expect(matchesUScheduleOfficialShop(official, source, "+18602223334")).toBe(false);
  expect(matchesUScheduleOfficialShop(official, { ...source, bookingUrl: bookingUrl.replace("exampleacademy", "different") }, "+18602223333")).toBe(false);
});
