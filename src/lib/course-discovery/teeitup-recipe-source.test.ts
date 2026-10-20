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
