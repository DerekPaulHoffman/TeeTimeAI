// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveTeeItUpFacilityIdentity } from "./teeitup-facility-identity";

const course = { name: "Spring Lake 9 Hole Golf Course", address: "4020 Hoctor Blvd, Omaha, NE 68107, USA", timeZone: "America/Chicago" };
const facility = { id: 13484, name: "Spring Lake GC", address: "4020 Hoctor Blvd. , Omaha, NE 68107, US", timeZone: "America/Chicago" };

describe("public facility identity reconciliation", () => {
  it("matches observed naming and address formatting differences without changing layout", () => {
    expect(resolveTeeItUpFacilityIdentity(course, [facility])).toEqual({ status: "MATCHED", facility });
    expect(course.name).toBe("Spring Lake 9 Hole Golf Course");
  });
  it("requires a unique matching facility", () => {
    expect(resolveTeeItUpFacilityIdentity(course, [facility, { ...facility, id: 13485 }]))
      .toEqual({ status: "UNRESOLVED", reason: "AMBIGUOUS" });
  });
  it.each([
    { name: "Spring Lake 18 Hole Golf Course" },
    { name: "Spring Lake North Golf Course" },
    { name: "Spring Lake Championship Golf Course" },
    { address: "4021 Hoctor Blvd, Omaha, NE 68107, US" },
    { address: "4020 Hoctor Blvd, Elsewhere, NE 68107, US" },
    { address: "4020 Hoctor Blvd, Omaha, NE 681070, US" },
    { timeZone: "America/New_York" },
  ])("rejects conflicting identity facts: %j", (change) => {
    expect(resolveTeeItUpFacilityIdentity(course, [{ ...facility, ...change }]))
      .toEqual({ status: "UNRESOLVED", reason: "NO_MATCH" });
  });
  it.each([null, {}, [{ ...facility, id: 0 }], [{ ...facility, id: 1.5 }],
    [{ ...facility, name: "" }], [{ ...facility, timeZone: "invalid" }],
    [facility, facility]])("rejects malformed or duplicated directory data: %j", (directory) => {
    expect(resolveTeeItUpFacilityIdentity(course, directory))
      .toEqual({ status: "UNRESOLVED", reason: "INVALID_INPUT" });
  });
});
