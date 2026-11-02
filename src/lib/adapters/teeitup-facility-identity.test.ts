// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveTeeItUpFacilityIdentity } from "./teeitup-facility-identity";

const course = { name: "Spring Lake 9 Hole Golf Course", address: "4020 Hoctor Blvd, Omaha, NE 68107, USA", timeZone: "America/Chicago" };
const facility = { id: 13484, name: "Spring Lake GC", address: "4020 Hoctor Blvd. , Omaha, NE 68107, US", timeZone: "America/Chicago" };

describe("public facility identity reconciliation", () => {
  it("matches a terminal legal suffix only while preserving complete course identity", () => {
    const expected = { name: "Example Country Club LLC", address: "100 North Street, Exampletown, CT 06248, USA", timeZone: "America/New_York" };
    const observed = { id: 12, name: "Example Country Club", address: "100 North St, Exampletown, CT 06248, US", timeZone: expected.timeZone };
    expect(resolveTeeItUpFacilityIdentity(expected, [observed]).status).toBe("MATCHED");
    for (const change of [{name:"Other Country Club"},{name:"Example Country Club North"},{address:"101 North St, Exampletown, CT 06248, US"},
      {address:"100 North St, Elsewhere, CT 06248, US"},{timeZone:"America/Chicago"}])
      expect(resolveTeeItUpFacilityIdentity(expected, [{...observed,...change}]).status).toBe("UNRESOLVED");
  });
  it("matches observed naming and address formatting differences without changing layout", () => {
    expect(resolveTeeItUpFacilityIdentity(course, [facility])).toEqual({ status: "MATCHED", facility });
    expect(course.name).toBe("Spring Lake 9 Hole Golf Course");
  });
  it("requires a unique matching facility", () => {
    expect(resolveTeeItUpFacilityIdentity(course, [facility, { ...facility, id: 13485 }]))
      .toEqual({ status: "UNRESOLVED", reason: "AMBIGUOUS" });
  });
  it("normalizes Suite and Ste without discarding the unit identity", () => {
    const venue = { ...course, address: "100 Main Road Ste: A, Example, NY 12345, USA" };
    const row = { ...facility, address: "100 Main Rd, Suite A, Example, NY 12345, US" };
    expect(resolveTeeItUpFacilityIdentity(venue, [row]).status).toBe("MATCHED");
    for (const address of ["100 Main Rd, Suite B, Example, NY 12345, US", "100 Main Rd, Example, NY 12345, US"])
      expect(resolveTeeItUpFacilityIdentity(venue, [{ ...row, address }]).status).toBe("UNRESOLVED");
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
