import { describe, expect, it } from "vitest";
import { simulatorPublicConfigurationSchema } from "./public-configuration";

function pool() {
  return { family: "ACUITY", ownerKey: "pool1234", businessId: "345", timeZone: "America/New_York", maxPartySize: null,
    rentals: [{ id: "101", durationMinutes: 60, calendarIds: ["any"], calendarKind: "OPAQUE_POOLED" }],
    resources: [{ id: "any", timeZone: "America/New_York" }] };
}

describe("typed Acuity public calendar identity", () => {
  it("represents an any-only pool explicitly without claiming named or numeric resources", () => {
    expect(simulatorPublicConfigurationSchema.parse(pool())).toEqual(pool());
  });
  it.each([30, 90, 150, 210])("represents a provider-verified %i-minute any-only rental within the general duration contract", durationMinutes => {
    const value = pool(); value.rentals[0].durationMinutes = durationMinutes;
    expect(simulatorPublicConfigurationSchema.parse(value)).toEqual(value);
  });
  it.each([0, 15, 45, 75, 250, 270, 300])("rejects %i minutes outside the thirty-minute-step rental contract", durationMinutes => {
    const value = pool(); value.rentals[0].durationMinutes = durationMinutes;
    expect(simulatorPublicConfigurationSchema.safeParse(value).success).toBe(false);
  });
  it("does not let a half-hour increment relax mixed resources or the numeric aggregate contract", () => {
    const mixed = pool(); mixed.rentals[0].durationMinutes = 90; mixed.resources.push({ id: "123", timeZone: mixed.timeZone });
    expect(simulatorPublicConfigurationSchema.safeParse(mixed).success).toBe(false);
    const aggregate = pool(); aggregate.rentals[0].durationMinutes = 90; aggregate.rentals[0].calendarKind = "OPAQUE_AGGREGATE";
    aggregate.rentals[0].calendarIds = ["123"]; aggregate.resources[0].id = "123";
    expect(simulatorPublicConfigurationSchema.safeParse(aggregate).success).toBe(false);
  });
  it.each([
    ["missing pooled kind", (value: ReturnType<typeof pool>) => { delete (value.rentals[0] as Partial<{ calendarKind: string }>).calendarKind; }],
    ["numeric aggregate kind", (value: ReturnType<typeof pool>) => { value.rentals[0].calendarKind = "OPAQUE_AGGREGATE"; }],
    ["numeric pooled calendar", (value: ReturnType<typeof pool>) => { value.rentals[0].calendarIds = ["123"]; value.resources[0].id = "123"; }],
    ["mixed pooled resources", (value: ReturnType<typeof pool>) => { value.resources.push({ id: "123", timeZone: value.timeZone }); }],
    ["mixed pooled references", (value: ReturnType<typeof pool>) => { value.rentals[0].calendarIds.push("123"); value.resources.push({ id: "123", timeZone: value.timeZone }); }],
    ["duplicate pool", (value: ReturnType<typeof pool>) => { value.resources.push({ ...value.resources[0] }); }],
    ["duplicate product", (value: ReturnType<typeof pool>) => { value.rentals.push({ ...value.rentals[0] }); }],
    ["resource timezone mismatch", (value: ReturnType<typeof pool>) => { value.resources[0].timeZone = "America/Chicago"; }],
    ["empty projected timezone", (value: ReturnType<typeof pool>) => { value.resources[0].timeZone = ""; }],
    ["invalid business timezone", (value: ReturnType<typeof pool>) => { value.timeZone = "Invalid/Zone"; }],
    ["invalid quarter-hour pool", (value: ReturnType<typeof pool>) => { value.rentals[0].durationMinutes = 45; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const value = pool(); mutate(value);
    expect(simulatorPublicConfigurationSchema.safeParse(value).success).toBe(false);
  });
  it.each([undefined, "OPAQUE_AGGREGATE"])("preserves existing numeric calendar kind %s", calendarKind => {
    const value = pool();
    value.rentals[0].calendarIds = ["123"]; value.resources[0].id = "123";
    Object.assign(value.rentals[0], { calendarKind });
    expect(simulatorPublicConfigurationSchema.safeParse(value).success).toBe(true);
  });
});
