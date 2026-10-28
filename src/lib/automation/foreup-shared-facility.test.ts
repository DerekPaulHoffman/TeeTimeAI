import { describe, expect, it, vi } from "vitest";
import { hasCompleteForeupPublicScheduleScope, parseForeupPublicConfiguration, readForeupStandardPublicSchedule } from "./foreup-public-configuration";

// Exact two-sheet shape from the signed-out official facility catalog.
const rows = [
  { course_id: "21017", course_name: "Tashua Knolls Golf Course", title: "Tashua Glen Golf Course (9 Holes)", teesheet_id: "6463",
    booking_classes: [{ teesheet_id: "6463", booking_class_id: "14911", name: "Online Tee Times", active: "1", hidden: "0" }] },
  { course_id: "21017", course_name: "Tashua Knolls Golf Course", title: "Tashua Knolls Golf Course", teesheet_id: "6654",
    booking_classes: [{ teesheet_id: "6654", booking_class_id: "14910", name: "Online Tee Times", active: "1", hidden: "0" }] },
];
const url = "https://foreupsoftware.com/index.php/booking/21017#/teetimes";
const html = (value: unknown = rows) => `<script>SCHEDULES=${JSON.stringify(value)};</script>`;
const read = (courseName: string, scheduleId: number, bookingClassId: number, value: unknown = rows) =>
  readForeupStandardPublicSchedule({ bookingUrl: url, courseName, scheduleId, bookingClassId,
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(html(value), { headers: { "content-type": "text/html" } })) });

describe("separate physical courses at one public ForeUP facility", () => {
  it("verifies Knolls and Glen independently despite their identical course_name", async () => {
    await expect(read("Tashua Knolls Golf Course", 6654, 14910)).resolves.toMatchObject({ scheduleId: 6654, bookingClassId: 14910 });
    await expect(read("Tashua Glen Golf Course", 6463, 14911)).resolves.toMatchObject({ scheduleId: 6463, bookingClassId: 14911 });
    expect(hasCompleteForeupPublicScheduleScope({ html: html(), facilityId: 21017, scheduleId: 6654 })).toBe(false);
  });
  it("does not let a shared owner name authorize the other course's sheet or class", async () => {
    await expect(read("Tashua Knolls Golf Course", 6463, 14911)).resolves.toBeNull();
    await expect(read("Tashua Glen Golf Course", 6654, 14910)).resolves.toBeNull();
    await expect(read("Tashua Knolls Golf Course", 6654, 14911)).resolves.toBeNull();
    await expect(read("Unrelated Golf Course", 6654, 14910)).resolves.toBeNull();
  });
  it.each(["inactive", "hidden", "member", "foreign", "duplicate"])("rejects %s selected evidence", async mode => {
    const copy = structuredClone(rows);
    if (mode === "inactive") copy[1].booking_classes[0].active = "0";
    if (mode === "hidden") copy[1].booking_classes[0].hidden = "1";
    if (mode === "member") copy[1].booking_classes[0].name = "Members";
    if (mode === "foreign") copy[1].course_id = "99999";
    if (mode === "duplicate") copy.push(copy[1]);
    await expect(read("Tashua Knolls Golf Course", 6654, 14910, copy)).resolves.toBeNull();
  });
  it("keeps a facility-only identity ambiguous without a unique course title", () => {
    expect(parseForeupPublicConfiguration({ bookingUrl: url, courseName: "Shared Facility", html: html(rows.map(row => ({ ...row, course_name: "Shared Facility" }))) })).toBeNull();
  });
});
