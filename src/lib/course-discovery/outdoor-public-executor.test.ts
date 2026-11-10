import { describe, expect, it } from "vitest";
import { executeOutdoorPublic, inspectOutdoorPublic } from "./outdoor-public-executor";
import { recipeTimeToInstant, venueProofMatches } from "./executor";
import { parseAccessRecipe } from "./recipe";
import { inspectOfficialAdapter, isOfficialAdapterJob } from "../../../scripts/automation/course-discovery-official-adapter.mjs";

const date = "2026-11-12";
const input = { date, startTime: "08:00", endTime: "18:00", players: 2, timeZone: "America/New_York" };
const now = () => new Date("2026-11-10T21:00:00.000Z");
const easton = { officialUrl: "https://www.eastoncountryclub.com/", bookingUrl: "https://www.eastoncountryclub.com/teetimes",
  venueName: "Easton Country Club", venueAddress: "265 Purchase St, South Easton, MA 02375", timeZone: input.timeZone };
const farm = { officialUrl: "https://www.farmneck.net/", bookingUrl: "https://www.farmneck.net/public-tee-times",
  venueName: "Farm Neck Golf Club", venueAddress: "1 Farm Neck Way, Oak Bluffs, MA 02557", timeZone: input.timeZone };
const publicPage = '<iframe src="https://bookateetime.teequest.com/course/116"></iframe>';
const teeQuestPage = `<h2>Easton Country Club</h2>
  <input id="course_116_1" type="radio" name="selectedCourse" value="116-1" checked>
  <label for="course_116_1">Easton Country Club</label>
  <input name="selectedHoles" value="9"><input name="selectedHoles" value="18">`;
const farmPage = `<title>Public Tee Times - Farm Neck Golf Club</title>
  <script>var SiteId = '4747'; var PathToREST = 'https://www.farmneck.net/a_master/net/netcaddy/api';</script>
  <a id="htngGolfActionUpdate">Search</a>`;

function setup(change: (url: URL, body: string) => string = (_url, body) => body) {
  const reads: string[] = [];
  const deps = {
    now, toInstant: recipeTimeToInstant, venueMatches: venueProofMatches,
    requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }),
    fetch: async (raw: Parameters<typeof fetch>[0], options?: RequestInit) => {
      const url = new URL(String(raw));
      expect(options?.method).toBe("GET");
      expect(options?.credentials).toBe("omit");
      expect(options?.body).toBeUndefined();
      reads.push(url.href);
      let body: string;
      let contentType = "text/html";
      if (url.href === easton.bookingUrl) body = publicPage;
      else if (url.href === "https://bookateetime.teequest.com/course/116") body = teeQuestPage;
      else if (/^\/search\/116-1\/2026-11-(?:12|13)$/u.test(url.pathname)) {
        const selectedDate = url.pathname.split("/").at(-1)!;
        const [year, month, day] = selectedDate.split("-");
        body = `<div id="search" data-initial-players="${url.searchParams.get("selectedPlayers")}">
          <input id="teeDate" value="${month}/${day}/${year}">
          <input name="selectedCourse" value="116-1" checked>
          <input name="selectedHoles" value="${url.searchParams.get("selectedHoles")}" checked></div>
          <div id="teeTimes"><div class="tee-time" data-date-time="${year}${month}${day}0917" data-available="2"></div>
          <div class="tee-time" data-date-time="${year}${month}${day}0926" data-available="1"></div></div>`;
      } else if (url.href === farm.bookingUrl) body = farmPage;
      else if (url.pathname === "/a_master/net/netcaddy/api/teetimes/Available") {
        contentType = "application/json";
        expect(url.searchParams.get("courseId")).toBe("GOLFCOURSE-1");
        expect(url.searchParams.get("date")).toBe(url.searchParams.get("enddate"));
        for (const discount of ["rCode", "pCode", "gCode", "cCode", "market", "submarket"])
          expect(url.searchParams.get(discount)).toBe("");
        const players = Number(url.searchParams.get("min"));
        expect(url.searchParams.get("max")).toBe(String(players));
        const [month, day, year] = url.searchParams.get("date")!.split("/");
        body = JSON.stringify({ ServerTimeUTC: now().toISOString(), Results: [{
          ID: 0, SiteID: 4747, CourseId: 1, status: 0, holes: 18,
          startTime: `${year}-${month}-${day}T09:10:00`,
          Golfers: Array.from({ length: players }, () => ({ MemberId: null, FirstName: null, LastName: null })),
        }] });
      } else throw Error("UNEXPECTED_OR_TRANSACTION_REQUEST");
      return new Response(change(url, body), { status: 200, headers: { "content-type": contentType } });
    },
  };
  return { deps, reads };
}

describe("recorded Easton and Farm Neck public search failures", () => {
  it("discovers the embedded compound course key and independently replays changed dates", async () => {
    const { deps, reads } = setup();
    const inspected = await inspectOutdoorPublic(easton, deps);
    expect(inspected.adapter).toEqual({ family: "TEEQUEST", courseKey: "116-1", rounds: [9, 18] });
    expect(inspected.observation.publicRequests).toBe(2);
    for (const requestedDate of [date, "2026-11-13"]) {
      const slots = await executeOutdoorPublic(easton, inspected.adapter, { ...input, date: requestedDate }, deps);
      expect(slots).toHaveLength(2);
      expect(slots.every(slot => slot.startsAt === requestedDate + "T14:17:00.000Z" && slot.availableSpots === 2)).toBe(true);
      expect(slots.map(slot => slot.holes)).toEqual([9, 18]);
    }
    expect(reads).toHaveLength(14);
    expect(reads.every(url => !/\/teetime\/|cart|checkout|SetMember/iu.test(url))).toBe(true);
  });

  it.each(["frame", "label", "date", "players", "missing result"])("rejects changed Easton %s evidence", async failure => {
    const normal = setup();
    const { adapter } = await inspectOutdoorPublic(easton, normal.deps);
    const altered = setup((url, body) => {
      if (failure === "frame") return body.replace("/course/116", "/course/117");
      if (failure === "label") return body.replaceAll("Easton Country Club", "Different Country Club");
      if (!url.pathname.startsWith("/search/")) return body;
      if (failure === "date") return body.replace('value="11/12/2026"', 'value="11/13/2026"');
      if (failure === "players") return body.replace('data-initial-players="2"', 'data-initial-players="1"');
      return body.replace('id="teeTimes"', 'id="unloaded"');
    });
    await expect(executeOutdoorPublic(easton, adapter, input, altered.deps)).rejects.toThrow();
  });

  it("saves Farm Neck public configuration and parameterizes the anonymous availability GET", async () => {
    const { deps } = setup();
    const { adapter } = await inspectOutdoorPublic(farm, deps);
    expect(adapter).toEqual({ family: "CLUBESSENTIAL", siteId: 4747, courseId: 1 });
    for (const players of [2, 3]) {
      const slots = await executeOutdoorPublic(farm, adapter, { ...input, date: "2026-11-13", players }, deps);
      expect(slots).toMatchObject([{ startsAt: "2026-11-13T14:10:00.000Z", availableSpots: players, holes: 18 }]);
    }
  });

  it.each(["wrong venue", "wrong site", "wrong date", "missing player", "incomplete response"])("rejects Farm Neck %s", async failure => {
    const { adapter } = await inspectOutdoorPublic(farm, setup().deps);
    const altered = setup((url, body) => {
      if (failure === "wrong venue") return body.replaceAll("Farm Neck Golf Club", "Other Golf Club");
      if (failure === "wrong site") return body.replaceAll("4747", "4748");
      if (!url.pathname.endsWith("/Available")) return body;
      if (failure === "incomplete response") return "{}";
      const result = JSON.parse(body);
      if (failure === "wrong date") result.Results[0].startTime = "2026-11-13T09:10:00";
      if (failure === "missing player") result.Results[0].Golfers.pop();
      return JSON.stringify(result);
    });
    await expect(executeOutdoorPublic(farm, adapter, input, altered.deps)).rejects.toThrow();
  });

  it("requires a published booking window before accepting an empty Farm Neck result", async () => {
    const { adapter } = await inspectOutdoorPublic(farm, setup().deps);
    const empty = setup((url, body) => url.pathname.endsWith("/Available") ?
      JSON.stringify({ ServerTimeUTC: now().toISOString(), Results: [] }) : body);
    await expect(executeOutdoorPublic(farm, adapter, input, empty.deps)).resolves.toEqual([]);
    await expect(executeOutdoorPublic(farm, adapter, { ...input, date: "2026-11-14" }, empty.deps)).rejects.toThrow("PUBLIC_OUTDOOR_DATE_NOT_OPEN");
  });

  it.each([easton, farm])("admits ordinary outdoor demand and validates saved recipe metadata for $venueName", async source => {
    const { adapter } = await inspectOutdoorPublic(source, setup().deps);
    const target = { courseId: "new-course", kind: "OUTDOOR" };
    expect(isOfficialAdapterJob({ request: { target, identity: { ...source, name: source.venueName,
      address: source.venueAddress, bookingUrl: undefined }, input } })).toBe(true);
    const recipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target,
      source: { ...source, providerFamily: adapter.family }, adapter };
    expect(parseAccessRecipe(recipe).adapter).toEqual(adapter);
    expect(() => parseAccessRecipe({ ...recipe, source: { ...recipe.source, bookingUrl: "https://other.example.org/" } })).toThrow();
  });

  it.each([easton, farm])("binds $venueName through the normal private helper", async source => {
    const { adapter, observation } = await inspectOutdoorPublic(source, setup().deps);
    const first = Date.now();
    const job = { id: "public-outdoor-job", leaseToken: "synthetic-test-lease", attempts: 1,
      firstPickedUpAt: new Date(first).toISOString(), deadlineAt: new Date(first + 900_000).toISOString(),
      request: { target: { kind: "OUTDOOR", courseId: "new-course" }, input,
        identity: { officialUrl: source.officialUrl, name: source.venueName, address: source.venueAddress, timeZone: input.timeZone } } };
    let closed = false;
    const prepared = await inspectOfficialAdapter({ job, cwd: process.cwd(), deadlineAt: job.deadlineAt,
      processFactory: () => ({
        request: async (value: { source: { bookingUrl: string } }) => {
          expect(value.source.bookingUrl).toBe(source.bookingUrl);
          return { adapter, observation: { transport: "FIXED_PUBLIC_ROOT", ...observation } };
        },
        close: async () => { closed = true; },
      }) });
    expect(closed).toBe(true);
    expect(parseAccessRecipe(prepared.recipe).source).toMatchObject({ bookingUrl: source.bookingUrl, providerFamily: adapter.family });
    expect(prepared.sourceEvidence).toEqual({ officialUrl: source.officialUrl, observedBookingUrl: source.bookingUrl });
    expect(prepared.receipt).toMatchObject({ modelCalls: 0, helperClosed: true, outcome: "INSPECTED" });
  });
});
