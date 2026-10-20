import { describe, expect, it } from "vitest";
import { isTeeItUpRecipeSlotLink, parseTeeItUpRecipeSource, resolveTeeItUpRecipeFacilities, teeItUpRecipeBookingUrl } from "./teeitup-recipe-source";

const source = { bookingUrl: "https://harbor.book.teeitup.com/?course=11,22&date=2030-10-22", venueName: "Harbor Golf Club",
  venueAddress: "10 Harbor Drive, Example, NY 12345, USA", timeZone: "America/New_York" };
const rows = [
  { id: 11, courseId: "north", name: "Harbor Golf Club - North", address: "10 Harbor Dr., Example, NY 12345, US", timeZone: source.timeZone },
  { id: 22, courseId: "south", name: "Harbor Golf Club - South", address: source.venueAddress, timeZone: source.timeZone },
];
describe("TeeItUp recipe source scope", () => {
  it("preserves an explicit multi-course scope only with matching parent name, full address and timezone", () => {
    expect(parseTeeItUpRecipeSource(source.bookingUrl)?.selectedIds).toEqual([11, 22]);
    expect(resolveTeeItUpRecipeFacilities(source, rows).map(row => row.id)).toEqual([11, 22]);
  });
  it.each([
    { name: "Other Club - South" }, { address: "11 Harbor Drive, Example, NY 12345, USA" },
    { timeZone: "America/Chicago" }, { isSimulator: true }, { courseId: "north" },
  ])("rejects conflicting selected facility facts %j", change => {
    expect(() => resolveTeeItUpRecipeFacilities(source, [rows[0], { ...rows[1], ...change }])).toThrow();
  });
  it("does not infer multiple facilities from a bare alias or silently drop an unknown selected ID", () => {
    expect(() => resolveTeeItUpRecipeFacilities({ ...source, bookingUrl: "https://harbor.book.teeitup.com/" }, rows)).toThrow();
    expect(() => resolveTeeItUpRecipeFacilities({ ...source, bookingUrl: "https://harbor.book.teeitup.com/?course=11,99" }, rows)).toThrow();
    expect(() => resolveTeeItUpRecipeFacilities({ ...source, venueAddress: undefined }, rows)).toThrow();
  });
  it("can identify one unique directory facility without model-supplied IDs", () => {
    expect(resolveTeeItUpRecipeFacilities({ ...source, bookingUrl: "https://harbor.book.teeitup.golf/" }, [rows[0]])[0].id).toBe(11);
  });
  it.each(["/", "/teetimes", "/teetimes/"])("binds observed public V2 %s to the same unique facility and edited-date link", path => {
    const bookingUrl = `https://public.book-v2.teeitup.golf${path}`, identity = { ...source, bookingUrl };
    expect(parseTeeItUpRecipeSource(bookingUrl)).toMatchObject({ alias: "public", origin: "https://public.book-v2.teeitup.golf" });
    expect(resolveTeeItUpRecipeFacilities(identity, [rows[0]])[0].id).toBe(11);
    const booking = teeItUpRecipeBookingUrl(bookingUrl, "2030-10-23", 11);
    expect(isTeeItUpRecipeSlotLink(bookingUrl, "2030-10-23", [11], { sourceId: "teeitup-11-provider-time", resourceId: "teeitup-facility:11", bookingUrl: booking })).toBe(true);
    expect(new URL(booking).pathname).toBe(path);
    expect(() => resolveTeeItUpRecipeFacilities(identity, [{ ...rows[0], address: "99 Other Rd, Example, NY 12345, US" }])).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("infers only one exact simulator identity and preserves outdoor exclusion by default", () => {
    const simulator = { ...rows[0], name: "Example Swing Studio", address: "100 Main Rd, Suite A, Example, NY 12345, US", isSimulator: true };
    const identity = { ...source, bookingUrl: "https://example.book.teeitup.com/", venueName: simulator.name,
      venueAddress: "100 Main Road Ste A, Example, NY 12345, USA" };
    expect(resolveTeeItUpRecipeFacilities(identity, [simulator], undefined, "AUTO")).toEqual([simulator]);
    expect(resolveTeeItUpRecipeFacilities(identity, [simulator], undefined, "SIMULATOR")).toEqual([simulator]);
    expect(() => resolveTeeItUpRecipeFacilities(identity, [simulator])).toThrow("ADAPTER_IDENTITY_MISMATCH");
    for (const changed of [{ ...simulator, isSimulator: false }, { ...simulator, name: "Example Swing Studio Golf" },
      { ...simulator, address: simulator.address.replace("Suite A", "Suite B") }, { ...simulator, timeZone: "America/Chicago" }])
      expect(() => resolveTeeItUpRecipeFacilities(identity, [changed], undefined, "SIMULATOR")).toThrow();
    expect(() => resolveTeeItUpRecipeFacilities({ ...identity, bookingUrl: `${identity.bookingUrl}?course=11` },
      [simulator, { ...simulator, id: 33, courseId: "duplicate" }], undefined, "SIMULATOR")).toThrow();
  });
  it("checks simulator resource and facility consistency in booking links", () => {
    const slot = { sourceId: "teeitup-11-simulator-88-duration-60-2030-10-23T15:00:00.000Z", resourceId: "teeitup-facility:11:simulator:88",
      bookingUrl: teeItUpRecipeBookingUrl(source.bookingUrl, "2030-10-23", 11) };
    expect(isTeeItUpRecipeSlotLink(source.bookingUrl, "2030-10-23", [11], slot)).toBe(true);
    expect(isTeeItUpRecipeSlotLink(source.bookingUrl, "2030-10-23", [11], { ...slot, resourceId: "teeitup-facility:11:simulator:89" })).toBe(false);
    expect(isTeeItUpRecipeSlotLink(source.bookingUrl, "2030-10-23", [11], { ...slot, resourceId: "teeitup-facility:22:simulator:88" })).toBe(false);
  });
  it("binds a changed-date link to its exact allowed resource and source ID", () => {
    const date = "2030-10-23";
    const slot = { sourceId: "teeitup-11-provider-11-time", resourceId: "teeitup-facility:11", bookingUrl: teeItUpRecipeBookingUrl(source.bookingUrl, date, 11) };
    expect(isTeeItUpRecipeSlotLink(source.bookingUrl, date, [11, 22], slot)).toBe(true);
    expect(new URL(slot.bookingUrl).searchParams.get("course")).toBe("11");
    for (const wrong of [
      { ...slot, resourceId: "teeitup-facility:22" }, { ...slot, sourceId: "teeitup-22-other" },
      { ...slot, bookingUrl: teeItUpRecipeBookingUrl(source.bookingUrl, "2030-10-22", 11) },
      { ...slot, bookingUrl: "https://harbor.book.teeitup.com/?course=99&date=2030-10-23" },
    ]) expect(isTeeItUpRecipeSlotLink(source.bookingUrl, date, [11, 22], wrong)).toBe(false);
    expect(isTeeItUpRecipeSlotLink(source.bookingUrl, date, [22], slot)).toBe(false);
  });
  it.each(["https://other.example/?course=11", "https://harbor.book.teeitup.com/account", "https://harbor.book.teeitup.com/?course=11,11",
    "https://harbor.book.teeitup.com/?course=11&course=22", "https://harbor.book.teeitup.com/?course=11&token=secret",
    "https://harbor.book.teeitup.com/?date=2030-02-30"]) ("rejects unbound public source %s", url => {
    expect(parseTeeItUpRecipeSource(url)).toBeNull();
  });
});
