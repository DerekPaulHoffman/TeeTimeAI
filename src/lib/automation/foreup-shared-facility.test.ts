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
  it("automatically discovers the independent public members without a facility plan", async () => {
    const result = await read("Tashua Knolls Golf Course", 6654, 14910);
    expect(result?.detectedFacility).toMatchObject({ method: "FOREUP_PUBLIC_CATALOG", primaryKey: "6654", courses: [
      { name: "Tashua Glen Golf Course", key: "6463", publicAccess: "PUBLIC", foreup: { scheduleId: 6463, bookingClassId: 14911 } },
      { name: "Tashua Knolls Golf Course", key: "6654", publicAccess: "PUBLIC" },
    ] });
    expect(JSON.stringify(result?.detectedFacility)).not.toContain("layoutHoleCounts");
  });
  it.each(["private-class", "inactive", "foreign-owner", "foreign-facility", "rate", "duplicate"])("does not register %s as another public physical course", async mode => {
    const copy = structuredClone(rows);
    if (mode === "private-class") copy[0].booking_classes[0].name = "Members";
    if (mode === "inactive") copy[0].booking_classes[0].active = "0";
    if (mode === "foreign-owner") copy[0].course_name = "Unrelated Golf Course";
    if (mode === "foreign-facility") copy[0].course_id = "88888";
    if (mode === "rate") copy[0].title = "Tashua Senior Rate";
    if (mode === "duplicate") copy.push(copy[0]);
    const result = await read("Tashua Knolls Golf Course", 6654, 14910, copy);
    expect(result?.detectedFacility?.courses.some(row => row.key === "6463") ?? false).toBe(false);
  });
  it("detects a three-course facility in another market with no Tashua strings or ids", async () => {
    const catalog = ["Desert East Golf Course", "Desert West Golf Course", "Desert Valley Golf Course"].map((title, index) => ({
      course_id: "44550", course_name: "Desert East Golf Course", title, teesheet_id: String(8200 + index),
      booking_classes: [{ teesheet_id: String(8200 + index), booking_class_id: String(9500 + index), name: "Public", active: "1", hidden: "0" }],
    }));
    const result = await readForeupStandardPublicSchedule({ bookingUrl: "https://foreupsoftware.com/index.php/booking/44550#/teetimes",
      courseName: catalog[0].title, scheduleId: 8200, bookingClassId: 9500,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(html(catalog), { headers: { "content-type": "text/html" } })) });
    expect(result?.detectedFacility?.courses.map(row => row.foreup?.scheduleId)).toEqual([8200, 8201, 8202]);
  });
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
