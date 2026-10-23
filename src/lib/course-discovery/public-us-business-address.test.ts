// @vitest-environment node
import { describe, expect, it } from "vitest";
import { completeUSAddress } from "./teeitup-official-identity";
import { normalizePublicUSState, parsePublicUSBusinessAddress, parsePublicUSBusinessAddressParts, publicUSStates } from "./public-us-business-address";

const parts = () => ({ address: "9101 International Drive, Ste 2410", city: "Orlando", state: "Florida", postalCode: "32819", country: "United States" });
const canonical = { street: "9101 international dr", locality: "orlando", region: "FL", postalCode: "32819", country: "US" };
describe("bounded public US business postal representation", () => {
  it("parses the actual split full-state Ste2410 shape without dropping its unit", () => {
    const parsed = parsePublicUSBusinessAddressParts(parts());
    expect(parsed).toEqual({ canonicalAddress: canonical, unit: { kind: "SUITE", identifier: "2410" } });
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed?.canonicalAddress)).toBe(true); expect(Object.isFrozen(parsed?.unit)).toBe(true);
  });
  it("keeps the global complete-address parser unchanged", () => {
    expect(completeUSAddress("9101 International Drive, Ste 2410, Orlando, FL 32819, US")).toBeNull();
    expect(parsePublicUSBusinessAddress("9101 International Drive, Ste 2410, Orlando, FL 32819, US")?.unit?.identifier).toBe("2410");
    expect(parsePublicUSBusinessAddress("9101 International Dr, Orlando, FL 32819, USA")).toEqual({ canonicalAddress: canonical, unit: null });
  });
  it.each(["Ste 2410", "Suite 2410", "STE. 2410", "suite. 2410", "Suite A1", "Ste 1A", "Suite A", "Ste AB12"])("retains only explicit bounded suite identifier %s", unit => {
    const parsed = parsePublicUSBusinessAddressParts({ ...parts(), address: `9101 International Dr, ${unit}` });
    expect(parsed?.unit).toEqual({ kind: "SUITE", identifier: unit.split(" ")[1].toUpperCase() });
    expect(parsed?.canonicalAddress).toEqual(canonical);
  });
  it("normalizes full state names in complete addresses using actual components", () => {
    expect(parsePublicUSBusinessAddress("9101 International Dr, Suite 2410, Orlando, Florida 32819, United States")).toEqual({ canonicalAddress: canonical, unit: { kind: "SUITE", identifier: "2410" } });
    expect(parsePublicUSBusinessAddress("9101 International Dr, Orlando, Florida 32819")).toEqual({ canonicalAddress: canonical, unit: null });
  });
  it("recognizes exactly fifty finite state names and their postal codes", () => {
    expect(Object.keys(publicUSStates)).toHaveLength(50); expect(new Set(Object.values(publicUSStates)).size).toBe(50);
    for (const [name, code] of Object.entries(publicUSStates)) {
      expect(normalizePublicUSState(name.toLowerCase())).toBe(code); expect(normalizePublicUSState(code.toLowerCase())).toBe(code);
    }
    for (const value of ["Florida extra", "ZZ", "District of Columbia", "PRIVATE_SENTINEL", null, 12]) expect(normalizePublicUSState(value)).toBeNull();
  });
  it.each(["Ste", "Suite", "Unit 2410", "#2410", "Floor 2", "Ste 24-10", "Suite PRIVATE", "Ste 123456789", "Suite A/B", "Ste 2410 extra",
    "Ste 2410, Suite 2411", "Ste 2410, Ste 2410", ", Ste 2410", "Ste 2410\nSuite 2411"])("rejects ambiguous, malformed or unproved unit format %s", unit => {
    expect(parsePublicUSBusinessAddressParts({ ...parts(), address: `9101 International Dr, ${unit}` })).toBeNull();
    expect(parsePublicUSBusinessAddress(`9101 International Dr, ${unit}, Orlando, FL 32819, US`)).toBeNull();
  });
  it.each([
    { address: "PO Box 2410" }, { address: "9101 International Dr, Suite 2410, other prose" },
    { address: "9101 International Dr additional prose" }, { city: "" }, { city: "Orlando 2410" }, { state: "Unknown" }, { state: "Canada" },
    { postalCode: "32819 unknown" }, { country: "Canada" }, { country: "" }, { country: undefined },
  ])("requires independently complete actual parts %j", extra => {
    expect(parsePublicUSBusinessAddressParts({ ...parts(), ...extra })).toBeNull();
  });
  it("never supplies any missing actual part from another address", () => {
    for (const key of Object.keys(parts())) {
      const incomplete: Record<string, unknown> = parts(); delete incomplete[key];
      expect(parsePublicUSBusinessAddressParts(incomplete as ReturnType<typeof parts>)).toBeNull();
    }
    const inherited = Object.assign(Object.create({ country: "US" }), parts()); delete inherited.country;
    expect(parsePublicUSBusinessAddressParts(inherited)).toBeNull();
  });
  it.each(["9101 International Dr, Suite 2410, Suite 2411, Orlando, FL 32819, US",
    "9101 International Dr, Suite 2410, Orlando, FL 32819, Canada", "9101 International Dr, Suite 2410, Orlando, Unknown 32819, US",
    "9101 International Dr, Ste 2410, Orlando, FL 32819, US, additional text"])("rejects extra lines/prose/country conflicts in complete strings %s", value => {
    expect(parsePublicUSBusinessAddress(value)).toBeNull();
  });
});
