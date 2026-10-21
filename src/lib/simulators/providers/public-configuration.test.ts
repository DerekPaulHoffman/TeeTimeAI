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
    ["unproven half-hour pool", (value: ReturnType<typeof pool>) => { value.rentals[0].durationMinutes = 90; }],
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
