import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe, recipeTimeToInstant, venueProofMatches } from "./executor";
import { parseAccessRecipe } from "./recipe";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { executeChelseaPublic, inspectChelseaPublic } from "./chelsea-public-executor";
import { chelseaPublicAvailability, chelseaPublicMetadata, parseChelseaPublicSource, readChelseaPublicForm } from "./chelsea-public-source";
import { createDiscoveryAdapterObservation, bindDiscoveryRecipeIdentity, inspectedAdapterSourceEvidence } from "../../../scripts/automation/course-discovery-worker.mjs";

const url = "https://public-course.chelseareservations.com/golf/bookingadmin.aspx";
const source = { officialUrl: "https://official-course.example/", bookingUrl: url, venueName: "Example Municipal Golf Course",
  venueAddress: "10 Public Road, Example, CT 06001, USA", timeZone: "America/New_York", providerFamily: "CHELSEA" };
const input = { date: "2030-11-05", timeZone: source.timeZone, players: 2, startTime: "09:00", endTime: "18:00" };
const metadata = { family: "CHELSEA" as const, protocol: "PUBLIC_BOOKING_ADMIN_V1" as const, courseCode: 7, courseLabel: "Example Municipal", roundHoleCounts: [9, 18] as Array<9 | 18> };
const option = (value: string, label: string, selected: string) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`;
function document({ players = 0, holes = 18, day = 0, state = "fresh-public-state", empty = false } = {}) {
  const label = day === 6 ? "Wednesday - November 06, 2030" : "Tuesday - November 05, 2030";
  return `<html><body><form method="post" action="./bookingadmin.aspx">
    <input type="hidden" name="__VIEWSTATE" value="${state}"><input type="hidden" name="__VIEWSTATEGENERATOR" value="public-generator">
    <input type="hidden" name="__EVENTVALIDATION" value="current-public-event-validation">
    <span id="lblCourseSelection">Course</span><span id="lblQuantity"># of Golfers</span><span id="lblHoleSelection"># of Holes</span>
    <select name="ddlCourse1">${option("7", "Example Municipal", "7")}</select>
    <select name="ddlTime">${option("05:00", "05:00 am", "05:00")}${option("09:00", "09:00 am", "05:00")}</select>
    <select name="ddlQuantity">${[0, 1, 2, 3, 4].map(v => option(String(v), v === 0 ? "Select One" : `${v} ${v === 1 ? "Golfer" : "Golfers"}`, String(players))).join("")}</select>
    <select name="ddlHoleSelection">${option("NA", "Select One", String(holes))}${[9, 18].map(v => option(String(v), `${v} Holes`, String(holes))).join("")}</select>
    <select name="ddlMonth">${option("11", "November", "11")}${option("12", "December", "11")}</select>
    <select name="ddlYear">${option("2030", "2030", "2030")}${option("2031", "2031", "2030")}</select>
    <span id="lblCalendar"><table><tr><td>November - 2030</td></tr><tr>${[5, 6].map(d => `<td><a href="javascript:__doPostBack('Day${d}','')">${d}</a></td>`).join("")}</tr></table></span>
    ${day ? `<span id="lblSelection">The date selected is ${label}</span><span id="lblTimes"><table>
      <tr><td>Tee Times for Example Municipal on ${label}</td></tr>${empty ? "" : `<tr>${["09:10", "10:20"].map(time => {
        const id = `Compare${day}${time.replace(":", "")}01`;
        return `<td><a id="${id}" href="javascript:__doPostBack('${id}','')">${time} am Hole-01</a> Booked - X</td>`;
      }).join("")}</tr><tr></tr>`}</table></span>` : ""}
    </form></body></html>`;
}
function publicFetch(change: (html: string) => string = value => value, bootstrapLocation = "/logingp.aspx") {
  let phase = 0, state = "fresh-public-state", posts = 0;
  return vi.fn<typeof fetch>(async (raw, init) => {
    const current = String(raw), method = init?.method ?? "GET", headers = new Headers(init?.headers);
    expect(headers.has("cookie")).toBe(false); expect(headers.has("authorization")).toBe(false);
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("manual");
    if (method === "GET") {
      if (phase === 0) { phase = 1; expect(current).toBe(url); return new Response("public redirect", { status: 302,
        headers: { "content-type": "text/html", location: bootstrapLocation, "set-cookie": "ASP.NET_SessionId=abcdefghijklmnopqrstuvwx; path=/; HttpOnly" } }); }
      if (phase === 1) { phase = 2; expect(current).toBe(new URL("/logingp.aspx", url).href); return new Response("public redirect", { status: 302, headers: { "content-type": "text/html", location: "/golf/bookingadmin.aspx" } }); }
      expect(current).toBe(url); return new Response(document(), { headers: { "content-type": "text/html" } });
    }
    expect(current).toBe(url); expect(method).toBe("POST"); expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const fields = new URLSearchParams(String(init?.body));
    expect([...fields.keys()].sort()).toEqual(["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION", "__EVENTTARGET", "__EVENTARGUMENT",
      "ddlCourse1", "ddlTime", "ddlQuantity", "ddlHoleSelection", "ddlMonth", "ddlYear"].sort());
    expect(fields.get("__VIEWSTATE")).toBe(state); expect(fields.get("__EVENTARGUMENT")).toBe("");
    expect(fields.get("ddlCourse1")).toBe("7"); expect(fields.get("ddlTime")).toBe("05:00");
    expect(fields.get("__EVENTTARGET")).toMatch(/^Day[56]$/u);
    expect(String(init?.body)).not.toMatch(/Compare|btnLogin|password|bookingId/u);
    state = `next-public-state-${++posts}`;
    return new Response(change(document({ players: Number(fields.get("ddlQuantity")), holes: Number(fields.get("ddlHoleSelection")),
      day: Number(fields.get("__EVENTTARGET")!.slice(3)), state })), { headers: { "content-type": "text/html" } });
  });
}
const deps = { venueMatches: venueProofMatches, toInstant: recipeTimeToInstant,
  requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };

describe("public Chelsea WebForms availability", () => {
  it("binds the fixed inspector's Chelsea metadata to the same job and ordinary input", () => {
    const job = { id: "chelsea-development-job", request: { identity: { name: source.venueName, address: source.venueAddress,
      officialUrl: source.officialUrl, timeZone: source.timeZone }, target: { courseId: "owned-course", kind: "OUTDOOR" }, input } };
    const observation = createDiscoveryAdapterObservation(job, url, metadata, source.officialUrl);
    expect(observation).toBeDefined();
    const candidate = bindDiscoveryRecipeIdentity({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source, adapter: metadata }, job, observation, source.officialUrl);
    expect(candidate.adapter).toEqual(metadata);
    expect(inspectedAdapterSourceEvidence(candidate, job, observation, true, source.officialUrl))
      .toEqual({ officialUrl: source.officialUrl, observedBookingUrl: url });
    expect(inspectedAdapterSourceEvidence(candidate, { ...job, id: "other-job" }, observation, true, source.officialUrl)).toBeUndefined();
    expect(inspectedAdapterSourceEvidence(candidate, { ...job, request: { ...job.request, input: { ...input, players: 3 } } }, observation, true, source.officialUrl)).toBeUndefined();
  });
  it("discovers current course/round identifiers with a new anonymous GET session", async () => {
    const fetch = publicFetch();
    expect(await inspectExistingAdapter(source, { ...deps, fetch })).toEqual({ adapter: metadata });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(metadata)).not.toMatch(/SessionId|VIEWSTATE|abcdefghijkl/u);
  });
  it("replays both public round products with changed dates/party sizes and no model or booking submission", async () => {
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", kind: "OUTDOOR" }, source, adapter: metadata });
    for (const change of [{}, { date: "2030-11-06", players: 3 }]) {
      const fetch = publicFetch(), request = { ...input, ...change };
      const result = await executeAccessRecipe(recipe, request, { ...deps, fetch, now: () => new Date("2030-11-02T12:00:00Z") });
      expect(result.evidence.reason).toBeUndefined();
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true,
        evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, completeVerified: true } });
      expect(result.slots[0]).toMatchObject({ availableSpots: request.players, startsAt: `${request.date}T14:10:00.000Z` });
      expect(result.slots).toHaveLength(4); expect(new Set(result.slots.map(s => s.holes))).toEqual(new Set([9, 18]));
      expect(fetch).toHaveBeenCalledTimes(5);
    }
  });
  it("rejects an unoffered day before any date-filter POST", async () => {
    const fetch = publicFetch();
    await expect(executeChelseaPublic(source, metadata, { ...input, date: "2030-11-07" }, { ...deps, fetch })).rejects.toThrow("CHELSEA_PUBLIC_DATE_NOT_OPEN");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each(["https://foreign.example/logingp.aspx", "/login.aspx", "/logingp.aspx?account=1", "/golf/checkout.aspx"])(
    "never follows an unrecognized anonymous bootstrap redirect %s", async location => {
      const fetch = publicFetch(undefined, location);
      await expect(inspectChelseaPublic(source, { ...deps, fetch })).rejects.toThrow("CHELSEA_PUBLIC_BOOTSTRAP_UNVERIFIED");
      expect(fetch).toHaveBeenCalledOnce();
    });
  it.each([
    ["wrong party echo", (html: string) => html.replace('value="2" selected', 'value="2"').replace('value="3">3 Golfers', 'value="3" selected>3 Golfers')],
    ["truncated time filter", (html: string) => html.replace('value="05:00" selected', 'value="05:00"').replace('value="09:00">', 'value="09:00" selected>')],
    ["wrong date", (html: string) => html.replaceAll("November 05, 2030", "November 06, 2030")],
    ["missing completion", (html: string) => html.replaceAll('id="lblTimes"', 'id="unconfirmed"')],
    ["truncated document", (html: string) => html.replace("</html>", "")],
    ["loading row", (html: string) => html.replace(/<tr><td><a id="Compare[\s\S]*?<\/tr>/u, "<tr><td>Loading availability</td></tr>")],
    ["pagination", (html: string) => html.replace("</table></span>", '<tr><td><a href="?page=2">Next</a></td></tr></table></span>')],
  ] as const)("keeps %s incomplete instead of no availability", async (_label, change) => {
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", kind: "OUTDOOR" }, source, adapter: metadata });
    expect(await executeAccessRecipe(recipe, input, { ...deps, fetch: publicFetch(change), now: () => new Date("2030-11-02T12:00:00Z") }))
      .toMatchObject({ complete: false, slots: [], evidence: { completeVerified: false } });
  });
  it("accepts only an entire dated, filter-confirmed empty server sheet as empty", () => {
    const form = readChelseaPublicForm(document({ players: 2, holes: 18, day: 5, empty: true }), url);
    expect(chelseaPublicAvailability(form, metadata, input, 18)).toEqual([]);
    expect(() => chelseaPublicAvailability({ ...form, sheet: null }, metadata, input, 18)).toThrow("CHELSEA_PUBLIC_FILTER_UNVERIFIED");
  });
  it("refuses ambiguous courses, substituted identifiers and changed public round options", async () => {
    const form = readChelseaPublicForm(document(), url);
    expect(() => chelseaPublicMetadata(form, "Different Municipal Golf Course", venueProofMatches)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    form.choices.ddlCourse1.push({ value: "8", label: "Example Municipal", selected: false });
    expect(() => chelseaPublicMetadata(form, source.venueName, venueProofMatches)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    await expect(executeChelseaPublic(source, { ...metadata, courseCode: 8 }, input, { ...deps, fetch: publicFetch() })).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
  });
  it.each(["ASP.NET_SessionId=rotatedanonymoussession", "AccountSession=unrelatedvalue"])("rejects changed or unrelated session cookies %s", async cookie => {
    const base = publicFetch();
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const response = await base(url, init);
      if (base.mock.calls.length === 2) response.headers.set("set-cookie", cookie);
      return response;
    };
    await expect(inspectChelseaPublic(source, { ...deps, fetch })).rejects.toThrow("ANONYMOUS_SESSION_CHANGED");
    expect(base).toHaveBeenCalledTimes(2);
  });
  it("rejects session changes on public POST and never retries them", async () => {
    const base = publicFetch();
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const response = await base(url, init);
      if (init?.method === "POST") response.headers.set("set-cookie", "ASP.NET_SessionId=abcdefghijklmnopqrstuvwx");
      return response;
    };
    await expect(executeChelseaPublic(source, metadata, input, { ...deps, fetch })).rejects.toThrow("ANONYMOUS_SESSION_CHANGED");
    expect(base).toHaveBeenCalledTimes(4);
  });
  it("retains the provider request lease fence", async () => {
    const fetch = publicFetch();
    await expect(inspectChelseaPublic(source, { ...deps, fetch, deadlineAt: new Date(Date.now() + 50), requestLease: async () => ({ acquired: false }) })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([url + "?slot=1", url + "#booking", url.replace("https:", "http:"), url.replace("public-course.", "person@public-course."),
    url.replace(".com/", ".com.evil.example/"), url.replace("bookingadmin.aspx", "booking1.aspx"), url.replace("public-course.", "admin.")])(
    "never derives a reader from credential, transaction or unrelated source %s", value => expect(parseChelseaPublicSource(value)).toBeUndefined());
});
