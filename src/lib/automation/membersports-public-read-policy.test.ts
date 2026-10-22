import { describe, expect, it } from "vitest";
import { isMemberSportsPublicTeeSheetPost } from "./membersports-public-read-policy";

const endpoint = "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes";
const documentUrl = "https://app.membersports.com/tee-times/12679/15654/0";
const input = { configurationTypeId: 0, date: "2026-10-23", golfClubGroupId: 0, golfClubId: 12679, golfCourseId: 15654, groupSheetTypeId: 0 };
const headers = () => new Headers({ origin: "https://app.membersports.com", "content-type": "application/json" });
const allows = (value: unknown = input, source = documentUrl, url = endpoint, h = headers()) =>
  isMemberSportsPublicTeeSheetPost(new URL(url), h, JSON.stringify(value), source);

describe("published MemberSports anonymous public tee-sheet read", () => {
  it("accepts the six-field date read bound to its current public document", () => {
    expect(allows()).toBe(true);
    expect(allows({ ...input, date: "2026-10-24" })).toBe(true);
    expect(allows({ ...input, date: "2028-02-29" })).toBe(true);
    expect(allows({ ...input, date: "2027-01-01" })).toBe(true);
  });
  it("allows ordinary JSON order/whitespace and does not infer player or booking actions", () => {
    const body = JSON.stringify(Object.fromEntries(Object.entries(input).reverse()), null, 2);
    expect(isMemberSportsPublicTeeSheetPost(new URL(endpoint), headers(), body, documentUrl)).toBe(true);
    expect(allows({ ...input, players: 2 })).toBe(false);
  });
  it.each([0, null, 1, "0", false])("rejects every explicit member profile, including %j", memberProfileId => {
    expect(allows({ ...input, memberProfileId })).toBe(false);
  });
  it.each(["reservationId", "bookingId", "teeTimeId", "selectedTime", "customerId", "email", "payment", "token", "headers", "dateTo"])("rejects extra %s", key => {
    expect(allows({ ...input, [key]: "unapproved" })).toBe(false);
  });
  it.each([
    { configurationTypeId: 1 }, { golfClubGroupId: 1 }, { groupSheetTypeId: 1 },
    { golfClubId: 12680 }, { golfCourseId: 15655 }, { golfClubId: "12679" },
    { golfCourseId: 0 }, { configurationTypeId: null }, { date: "10/23/2026" },
    { date: "2026-10-3" }, { date: "2027-2-03" }, { date: "2027-02-29" },
    { date: "2028-02-30" }, { date: "2026-13-01" }, { date: "2026-10-23T10:00:00Z" },
    { date: "2026-00-01" }, { date: "2026-01-00" }, { date: "2026-04-31" },
    { date: "026-10-23" }, { date: "2026/10/23" }, { date: "2026-10-23 " },
  ])("denies a changed identity, group, configuration or invalid source date %j", delta => {
    expect(allows({ ...input, ...delta })).toBe(false);
  });
  it.each([
    "https://app.membersports.com/tee-times/12680/15654/0",
    "https://app.membersports.com/tee-times/12679/15655/0",
    "https://app.membersports.com/tee-times/12679/15654/1",
    "https://app.membersports.com/club-tee-times/12679/15654/0",
    "https://app.membersports.com/tee-times/012679/15654/0",
    "https://app.membersports.com/tee-times/12679/15654/0/",
    "https://app.membersports.com/tee-times/12679/15654/0?profile=0",
    "https://app.membersports.com/tee-times/12679/15654/0#date",
    "http://app.membersports.com/tee-times/12679/15654/0",
    "https://app.membersports.com:444/tee-times/12679/15654/0",
    "https://other.example/tee-times/12679/15654/0",
  ])("denies unbound or noncanonical public document %s", source => expect(allows(input, source)).toBe(false));
  it.each([
    "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes/",
    "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes?profile=0",
    "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes#data",
    "https://api.membersports.com/api/v1/teesheets/lockTeeTimes",
    "https://api.membersports.com/api/v1/golfclubs/clubTeeTimes",
    "https://api.membersports.com:444/api/v1/golfclubs/onlineBookingTeeTimes",
    "https://user@api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes",
    "http://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes",
    "https://api.membersports.com.other.example/api/v1/golfclubs/onlineBookingTeeTimes",
  ])("denies every other route %s", url => expect(allows(input, documentUrl, url)).toBe(false));
  it("requires JSON and exact anonymous public origin while delegating key publicity", () => {
    const attested = headers(); attested.set("x-api-key", "public-test-literal"); attested.set("authorization", "Bearer null");
    attested.set("x-ms-request-id", "00000000-0000-4000-8000-000000000001");
    expect(allows(input, documentUrl, endpoint, attested)).toBe(true);
    const cookieOwnedElsewhere = headers(); cookieOwnedElsewhere.set("cookie", "");
    expect(allows(input, documentUrl, endpoint, cookieOwnedElsewhere)).toBe(true);
    for (const delta of [{ origin: "https://other.example" }, { origin: "https://app.membersports.com/" }, { "content-type": "text/plain" }]) {
      const h = headers(); for (const [key, value] of Object.entries(delta)) h.set(key, value);
      expect(allows(input, documentUrl, endpoint, h)).toBe(false);
    }
    const missing = headers(); missing.delete("origin"); expect(allows(input, documentUrl, endpoint, missing)).toBe(false);
    const charset = headers(); charset.set("content-type", "application/json; charset=utf-8"); expect(allows(input, documentUrl, endpoint, charset)).toBe(true);
  });
  it.each(["proxy-authorization", "next-action", "x-auth-token", "x-session-id", "x-csrf-token", "x-http-method-override"])("denies sensitive companion %s", key => {
    const h = headers(); h.set(key, "unapproved"); expect(allows(input, documentUrl, endpoint, h)).toBe(false);
  });
  it("rejects real/non-null authorization even though actual key proof remains independent", () => {
    for (const value of ["Bearer test-value", "Bearer undefined", "Basic test-value", ""]) {
      const h = headers(); h.set("authorization", value); expect(allows(input, documentUrl, endpoint, h)).toBe(false);
    }
  });
  it("rejects duplicate, escaped, nested, missing and noncanonical numeric body forms", () => {
    const valid = JSON.stringify(input);
    for (const body of [
      valid.replace('"configurationTypeId":0', '"configurationTypeId":0,"configurationTypeId":0'),
      valid.replace('"date"', '"\\u0064ate"'),
      valid.replace('"configurationTypeId":0', '"configurationTypeId":-0'),
      valid.replace('"configurationTypeId":0', '"configurationTypeId":0e0'),
      valid.replace('"golfClubId":12679', '"golfClubId":12679.0'),
      "[]", "null", "{", "{}", JSON.stringify({ ...input, date: { value: input.date } }),
      JSON.stringify({ ...input, configurationTypeId: undefined }), " ".repeat(2049) + valid,
    ]) expect(isMemberSportsPublicTeeSheetPost(new URL(endpoint), headers(), body, documentUrl)).toBe(false);
  });
});
