import { describe, expect, it } from "vitest";
import { projectPassfactoryCalendarEvidence } from "./passfactory-calendar-evidence";

const origin = "https://api.passfactory.io/api/v1/availability-widget/";
const request = (key: string, value: string) => JSON.stringify({ [key]: value, start_date: "2026-10-16", end_date: "2026-10-31", type: 2 });
const interval = () => ({ table_id: "table-public", table_title: "Golf simulator", table_type_id: "simulator", table_type_name: "Simulator",
  start_date: "2026-10-16", end_date: "2026-10-17", start_time: "17:00:00", end_time: "00:00:00",
  max_end_date: "2026-10-17", max_end_time: "00:00:00", original_end_time: "00:00:00",
  slot_duration: 60, max_duration: 360, advance: 30, availability_type: 2, table_min_book_count: 1, table_max_book_count: 6,
  account_token: "private-account-token" });
const hall = () => ({ code: 200, payload: { code: "hall-public", name: "Public hall", user_id: "private-user", member_prices: ["private-price"],
  rule_times: [{ code: "rule-public", name: "Evening", settings_for: "public", availability_ticket_type: "GENERAL_TABLE",
    multi_booking_enabled: false, minutes_per_booking: null, min_people_count: null, max_people_count: null,
    member_group_ids: null, pass_package_plan_ids: [], league_plan_ids: ["private-plan"], availabilities: [interval()] }] } });
const project = (value = hall()) => projectPassfactoryCalendarEvidence(origin + "hall-widget", request("hall_code", "hall-public"), value);

describe("source-bound public calendar evidence", () => {
  it("preserves resource identity, cross-midnight intervals and explicit duration fields without inferring semantics", () => {
    const result = project();
    expect(result).toMatchObject({ authority: "EVIDENCE_ONLY", kind: "HALL", code: "hall-public", rule_times: [{
      minutes_per_booking: null, restrictionLists: { memberGroups: "NULL", passPackages: "EMPTY", leagues: "PRESENT" },
      availabilities: [{ table_id: "table-public", table_title: "Golf simulator", end_date: "2026-10-17", end_time: "00:00:00", slot_duration: 60, max_duration: 360 }],
    }] });
    expect(JSON.stringify(result)).not.toMatch(/private-|account_token|user_id|member_prices/);
    expect(result).not.toHaveProperty("publicAccessStatus");
    expect(result).not.toHaveProperty("slots");
  });

  it("retains only validated facility fields, including the provider's duration step", () => {
    const result = projectPassfactoryCalendarEvidence(origin + "facility-widget", request("facility_code", "facility-public"), {
      code: 200, payload: { code: "facility-public", name: "Public facility", time_zone: "America/New_York", min_people_count: 1,
        max_people_count: 6, slot_step: 30, duration_step: 60, halls: [{ code: "hall-public", name: "Public hall", privateField: "secret" }],
        location: "private-address", user_id: "private-user" },
    });
    expect(result).toEqual({ authority: "EVIDENCE_ONLY", kind: "FACILITY", code: "facility-public", name: "Public facility", time_zone: "America/New_York",
      min_people_count: 1, max_people_count: 6, slot_step: 30, duration_step: 60, halls: [{ code: "hall-public", name: "Public hall" }] });
  });

  it("rejects different resources, unknown endpoints, unsuccessful envelopes and invalid fields", () => {
    expect(projectPassfactoryCalendarEvidence(origin + "hall-widget", request("hall_code", "other-hall"), hall())).toBeUndefined();
    expect(projectPassfactoryCalendarEvidence(origin + "reserve", request("hall_code", "hall-public"), hall())).toBeUndefined();
    expect(projectPassfactoryCalendarEvidence("https://foreign.example.test/hall-widget", request("hall_code", "hall-public"), hall())).toBeUndefined();
    expect(project({ ...hall(), code: 403 })).toBeUndefined();
    const invalid = hall(); invalid.payload.rule_times[0].availabilities[0].start_date = "2026-02-30";
    expect(project(invalid)).toBeUndefined();
    const invalidDuration = hall(); invalidDuration.payload.rule_times[0].availabilities[0].slot_duration = -1;
    expect(project(invalidDuration)).toBeUndefined();
  });

  it("keeps missing restrictions unknown and rejects oversized evidence instead of silently truncating it", () => {
    const missing = hall(); delete (missing.payload.rule_times[0] as Partial<typeof missing.payload.rule_times[0]>).member_group_ids;
    expect(project(missing)).toMatchObject({ rule_times: [{ restrictionLists: { memberGroups: "MISSING" } }] });
    const oversized = hall(); oversized.payload.rule_times[0].availabilities = Array.from({ length: 201 }, interval);
    expect(project(oversized)).toBeUndefined();
  });
});
