import { describe, expect, it } from "vitest";
import { PLAYBYPOINT_QUERY, parsePlaybyPointWidget, playbyPointReadInput, playbyPointResourceSelection,
  type PlaybyPointOptions } from "./playbypoint-public";
import { playbyPointRouteAllowed, playbyPointFailureCode } from "./playbypoint-reader";

it("retains the failed public-read phase without private browser error text", () => {
  const timeout = Object.assign(Error("PRIVATE_URL?token=PRIVATE"), { name: "TimeoutError" });
  expect(playbyPointFailureCode(timeout, "IDENTITY")).toBe("PLAYBYPOINT_IDENTITY_TIMEOUT");
  expect(playbyPointFailureCode(timeout, "DATE_CONTROL")).toBe("PLAYBYPOINT_DATE_CONTROL_TIMEOUT");
  expect(playbyPointFailureCode(timeout, "PRIVATE_URL")).toBe("PLAYBYPOINT_UNKNOWN_TIMEOUT");
  expect(playbyPointFailureCode(Error("PLAYBYPOINT_CLIENT_CHANGED"), "AVAILABILITY")).toBe("PLAYBYPOINT_CLIENT_CHANGED");
});

const facilityUuid = "13bb78da-12d1-6280-3b0e-0234297bb93d";
const body = (input: object = {}, query = PLAYBYPOINT_QUERY) => JSON.stringify({
  operationName: "GetPublicBookingOptions", variables: { input: {
    dateFrom: "2026-11-17", dateTo: "2026-11-30", date: "2026-11-19", sport: "SIMULATOR", ...input,
  } }, query,
});
function options(): PlaybyPointOptions {
  return { id: "463", bookingOptions: {
    timeZone: "America/New_York",
    schedule: { dateFrom: "2026-11-17", dateTo: "2026-11-30", openDates: ["2026-11-19"],
      date: "2026-11-19", suggestedDate: "2026-11-19", maximumDuration: 21600,
      startOptions: [{ hourStart: 36000, hourEnds: [39600] }] },
    location: { sports: [{ value: "SIMULATOR", text: "Simulator", available: true }],
      surfaces: [{ value: "simulator", text: "Simulator", sport: "SIMULATOR", available: true }],
      courts: { mode: "MANUAL", options: [{ id: "4642", name: "Golf Sim 1", surface: "simulator" },
        { id: "4643", name: "Golf Sim 2", surface: "simulator" }], candidateCourtId: null } },
    selection: { status: "INCOMPLETE", conflictingFields: [] },
  } };
}
const expected = { facilityId: "463", date: "2026-11-19", timeZone: "America/New_York", start: 36000, end: 39600 };
describe("PlaybyPoint public full-hour availability", () => {
  it("reads the exact public query and rejects mutations, added operations and unrelated inputs", () => {
    expect(playbyPointReadInput(body({ hourStart: 36000, hourEnd: 39600 }))).toMatchObject({ sport: "SIMULATOR", hourStart: 36000, hourEnd: 39600 });
    expect(playbyPointReadInput(body({}, PLAYBYPOINT_QUERY.replace("query ", "mutation ")))).toBeNull();
    expect(playbyPointReadInput(body({}, PLAYBYPOINT_QUERY + " query Another { users { id } }"))).toBeNull();
    expect(playbyPointReadInput(body({ courtId: "4642" }))).toBeNull();
    expect(playbyPointReadInput(body({ sport: "PADEL" }))).toBeNull();
    expect(playbyPointReadInput(body({ hourStart: 36000 }))).toBeNull();
  });
  it("keeps every available bay for the exact one-hour interval", () => {
    expect(playbyPointResourceSelection(options(), expected).map(resource => resource.id)).toEqual(["4642", "4643"]);
    const oneBay = options();
    oneBay.bookingOptions.location.courts.options.pop();
    expect(playbyPointResourceSelection(oneBay, expected).map(resource => resource.id)).toEqual(["4642"]);
  });
  it("never combines separate half-hour openings into a full-hour match", () => {
    const result = options();
    result.bookingOptions.schedule.startOptions = [{ hourStart: 36000, hourEnds: [37800] }, { hourStart: 37800, hourEnds: [39600] }];
    expect(() => playbyPointResourceSelection(result, expected)).toThrow("PLAYBYPOINT_DURATION_UNVERIFIED");
  });
  it.each(["facility", "date", "timeZone", "sport", "conflict", "duplicate"] as const)("rejects a changed %s before extracting any bay", field => {
    const value = options();
    if (field === "facility") value.id = "999";
    if (field === "date") value.bookingOptions.schedule.date = "2026-11-20";
    if (field === "timeZone") value.bookingOptions.timeZone = "America/Chicago";
    if (field === "sport") value.bookingOptions.location.surfaces[0].sport = "PADEL";
    if (field === "conflict") value.bookingOptions.selection.conflictingFields = ["hourEnd"];
    if (field === "duplicate") value.bookingOptions.location.courts.options.push(value.bookingOptions.location.courts.options[0]);
    expect(() => playbyPointResourceSelection(value, expected)).toThrow("PLAYBYPOINT_SCOPE_UNVERIFIED");
  });
  it("binds the widget to its one public facility and rejects additional query parameters", () => {
    const widget = "https://greenfield.playbypoint.com/booking/select?whiteLabelHost=true&whiteLabelFacilityUuid=" + facilityUuid;
    expect(parsePlaybyPointWidget(widget)?.facilityUuid).toBe(facilityUuid);
    expect(parsePlaybyPointWidget(widget + "&token=private")).toBeNull();
    expect(parsePlaybyPointWidget(widget.replace("greenfield.playbypoint.com", "other.example.org"))).toBeNull();
  });
  it("denies account calls, reservations, unrelated GraphQL and copied credentials", () => {
    const scope = { root: "https://book.sports.haus/", widget: "https://greenfield.playbypoint.com/booking/select?whiteLabelHost=true&whiteLabelFacilityUuid=" + facilityUuid,
      date: expected.date };
    const request = { url: "https://app.playbypoint.com/v1/" + facilityUuid + "/graphql", method: "POST", type: "fetch",
      body: body(), headers: { authorization: "Basic copied-credential", fooly: "cooly" } };
    expect(playbyPointRouteAllowed(request, scope)).toBe(false);
    expect(playbyPointRouteAllowed({ ...request, body: body({}, "mutation Reserve { reserveCourt { id } }") }, scope)).toBe(false);
    expect(playbyPointRouteAllowed({ ...request, url: "https://book.sports.haus/users/sign_in", method: "GET", type: "document", body: null, headers: {} }, scope)).toBe(false);
  });
});
