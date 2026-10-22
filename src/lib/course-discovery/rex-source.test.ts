import { describe, expect, it } from "vitest";
import { parseRexAvailability, parseRexConfiguration, parseRexSource, rexMetadataSchema, selectRexVenue, validateRexIdentity, type RexSource } from "./rex-source";

const venueId = "11111111-2222-3333-4444-555555555555", packageId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const source: RexSource = { officialUrl: "https://example-golf.test/", bookingUrl: "https://example.reservewithrex.com/package?venue=Example%20Golf%20Studio",
  venueName: "Example Golf Studio", venueAddress: "100 Example Dr Ste 2, Exampletown, CA 90001, USA", timeZone: "America/Los_Angeles" };
function fixture() {
  const directory = [{ id: venueId, name: source.venueName, address: "100 Example Drive Suite 2", timeZone: source.timeZone, closed: false, isComingSoon: false }];
  const product = { id: packageId, name: "Golf Simulator", status: true, isHidden: false, contactOnly: false, isMemberOnlyPackage: false,
    numberOfLanes: 1, minGuests: 1, maxGuests: 8, method: "Per Lane", countLanesByGuest: false, flexibleByResource: false,
    allowAdditionalGuests: false, enableDurationChoice: true, duration: 1, durationInSlots: "2,3,4,5,6", isTimeSlotsInPackage: false,
    enableAssignDuration: false, fillToEndOfDay: false, shiftingForReservationStart: 0, preBufferTimeForReservation: 0,
    bufferTimeForReservation: 1, ageGroups: [] as unknown[], hasActivities: false };
  const catalog = { id: venueId, name: source.venueName, address: "100 Example Drive", address2: "Suite 2", city: "Exampletown", state: "CA", zipCode: "90001",
    timeZone: source.timeZone, closed: false, isComingSoon: false, timeSlotDuration: 30, timeSlotShifting: ["0", "0", "0", "0", "0", "0", "0"], packages: [product], timeSlots: [] as unknown[] };
  return { directory, catalog, product };
}
describe("strict Rex public source and catalog", () => {
  it("binds exact public tenant, whole venue, complete postal address and IANA", () => {
    const { directory, catalog } = fixture(), result = parseRexConfiguration(directory, catalog, source);
    expect(result.metadata).toMatchObject({ family: "REX", tenant: "example", venueId, packageId });
    expect(result.durationUnits).toEqual([2, 3, 4, 5, 6]); expect(result.selected.maxGuests).toBe(8);
  });
  it.each(["http://example.reservewithrex.com/package?venue=Example", "https://reservewithrex.com/package?venue=Example",
    "https://example-.reservewithrex.com/package?venue=Example", "https://a.b.reservewithrex.com/package?venue=Example",
    "https://example.reservewithrex.com/api/venue", "https://user:pass@example.reservewithrex.com/package?venue=Example",
    "https://example.reservewithrex.com:444/package?venue=Example", "https://example.reservewithrex.com:443/package?venue=Example", "https://example.reservewithrex.com/package?venue=Example&token=x",
    "https://example.reservewithrex.com/package?venue=Example&venue=Other", "https://example.reservewithrex.com/package?venue=Example#login",
    "https://example.reservewithrex.com/package?venue=Example&date=2026-02-30", "https://example.reservewithrex.com/package?venue=Example&guests=0"])("rejects unsafe/private/ambiguous entry %s", value => {
    expect(parseRexSource(value)).toBeUndefined();
  });
  it.each(["venueAddress", "officialUrl", "venueName", "timeZone"])("requires full trusted identity context %s", key => {
    expect(() => validateRexIdentity({ ...source, [key]: "" })).toThrow("ADAPTER_IDENTITY_MISSING");
  });
  it.each(["date=2026-10-23", "guests=2", "currentPackage=Golf%20Simulator"])("requires the actually observed neutral landing instead of stale %s", query => {
    expect(() => validateRexIdentity({ ...source, bookingUrl: `${source.bookingUrl}&${query}` })).toThrow("REX_STATIC_SOURCE_REQUIRED");
  });
  it.each([{ address: "101 Example Drive" }, { address2: "Suite 3" }, { city: "Other Town" }, { zipCode: "90002" },
    { address: "100 East Example Drive" }, { address: "100 Example Street" }, { state: "WA" }, { timeZone: "America/New_York" },
    { name: "Example Golf Studio Annex" }, { name: "The Example Golf Studio" }, { id: "123" }])("rejects public identity component drift %j", changed => {
    const { directory, catalog } = fixture(); expect(() => parseRexConfiguration(directory, { ...catalog, ...changed }, source)).toThrow();
  });
  it("rejects duplicate and ambiguous directory identities", () => {
    const { directory } = fixture(); expect(() => selectRexVenue([...directory, directory[0]], source)).toThrow();
    expect(() => selectRexVenue([...directory, { ...directory[0], id: "123" }], source)).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each([{ contactOnly: true }, { isMemberOnlyPackage: true }, { status: false }, { isHidden: true }, { numberOfLanes: 2 },
    { method: "Per Person" }, { countLanesByGuest: true }, { flexibleByResource: true }, { enableAssignDuration: true }, { fillToEndOfDay: true },
    { ageGroups: [{}] }, { hasActivities: true }, { shiftingForReservationStart: 1 }, { allowAdditionalGuests: true }])("never infers eligible whole-bay semantics from %j", changed => {
    const { directory, catalog, product } = fixture(); catalog.packages = [{ ...product, ...changed }];
    expect(() => parseRexConfiguration(directory, catalog, source)).toThrow("REX_PUBLIC_RENTAL_UNVERIFIED");
  });
  it("rejects additional plausible public golf inventory with unknown semantics", () => {
    const { directory, catalog, product } = fixture(); catalog.packages.push({ ...product, id: "123", name: "Public Golf Bay Rental", flexibleByResource: true });
    expect(() => parseRexConfiguration(directory, catalog, source)).toThrow("REX_PUBLIC_RENTAL_UNVERIFIED");
  });
  it.each(["Golf Simulator + Bowling", "Golf Simulator Fitting", "Golf Simulator and Multi-Sport"])("rejects mixed or non-rental package %s", name => {
    const { directory, catalog, product } = fixture();
    expect(() => parseRexConfiguration(directory, { ...catalog, packages: [{ ...product, name }] }, source)).toThrow("REX_PUBLIC_RENTAL_UNVERIFIED");
  });
  it("permits explicit non-single-bay party offerings without claiming their stock", () => {
    const { directory, catalog, product } = fixture(); catalog.packages.push({ ...product, id: "123", name: "Golf Party", numberOfLanes: 2, minGuests: 9, maxGuests: 16 });
    expect(parseRexConfiguration(directory, catalog, source).metadata.packageId).toBe(packageId);
  });
  it("hashes identity/eligibility only, excluding inventory/date/price/payment fields", () => {
    const { directory, catalog } = fixture(); const original = parseRexConfiguration(directory, catalog, source).metadata;
    const changed = { ...catalog, timeSlots: [{ id: "20", time: 20 }], price: "25.00", date: "2026-10-24", sessionKey: "DiagnosticExample" };
    expect(parseRexConfiguration(directory, changed, source).metadata).toEqual(original);
    expect(JSON.stringify(original)).not.toMatch(/DiagnosticExample|price|date|session/iu);
    expect(() => rexMetadataSchema.parse({ ...original, credential: "DiagnosticExample" })).toThrow();
  });
  it("requires observed 30-minute, zero-shift units and an exact duration list", () => {
    const { directory, catalog, product } = fixture(); expect(() => parseRexConfiguration(directory, { ...catalog, timeSlotDuration: 15 }, source)).toThrow();
    expect(() => parseRexConfiguration(directory, { ...catalog, timeSlotShifting: ["0", "0", "0", "0", "30", "0", "0"] }, source)).toThrow();
    expect(() => parseRexConfiguration(directory, { ...catalog, packages: [{ ...product, durationInSlots: "2,2" }] }, source)).toThrow("REX_DURATION_UNSUPPORTED");
    expect(() => parseRexConfiguration(directory, { ...catalog, isStartTimeOnly: true, filterTimeSlots: [20] }, source)).toThrow("REX_PUBLIC_RENTAL_UNVERIFIED");
  });
  it("requires every slot row valid even when disabled or outside the request window", () => {
    const { directory, catalog } = fixture(), config = parseRexConfiguration(directory, catalog, source);
    for (const timeSlots of [[{ id: "20", time: 20 }, { id: "bad", time: 21, isDisabled: true }], [{ id: "20", time: 20, isDisabled: "false" }], [{ id: "20", time: 20 }, { id: "20", time: 20 }]])
      expect(() => parseRexAvailability({ ...catalog, timeSlots }, config, source)).toThrow("REX_SLOT_INVALID");
  });
  it("never treats an error, missing array, pagination or partial envelope as empty", () => {
    const { directory, catalog } = fixture(), config = parseRexConfiguration(directory, catalog, source);
    for (const value of [{ error: "DiagnosticExample" }, { ...catalog, timeSlots: undefined }, { ...catalog, hasMore: false }, { ...catalog, next_cursor: null }, { ...catalog, packages: [] }])
      expect(() => parseRexAvailability(value, config, source)).toThrow();
    expect(parseRexAvailability(catalog, config, source)).toEqual([]);
  });
});
