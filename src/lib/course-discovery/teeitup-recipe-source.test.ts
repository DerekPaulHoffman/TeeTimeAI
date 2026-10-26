// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { isTeeItUpRecipeSlotLink, parseTeeItUpRecipeSource, resolveTeeItUpRecipeFacilities, teeItUpRecipeBookingUrl } from "./teeitup-recipe-source";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { recipeTimeToInstant, venueProofMatches } from "./executor";

const source = { bookingUrl: "https://harbor.book.teeitup.com/?course=11,22&date=2030-10-22", venueName: "Harbor Golf Club",
  venueAddress: "10 Harbor Drive, Example, NY 12345, USA", timeZone: "America/New_York" };
const rows = [
  { id: 11, courseId: "north", name: "Harbor Golf Club - North", address: "10 Harbor Dr., Example, NY 12345, US", timeZone: source.timeZone },
  { id: 22, courseId: "south", name: "Harbor Golf Club - South", address: source.venueAddress, timeZone: source.timeZone },
];
const selectedSource = { ...source, officialUrl: "https://harbor.example/", providerFamily: "TEEITUP", bookingUrl: "https://harbor.book.teeitup.com/?course=11" };
const qualified = { ...rows[0], name: "Harbor Golf Club, NY", country: "US", region: "NY" };
describe("selected US state-qualified outdoor identity", () => {
  it("strips only the exact matching terminal state for comparison, preserving original directory facts", () => {
    const result = resolveTeeItUpRecipeFacilities(selectedSource, [qualified]);
    expect(result).toHaveLength(1); expect(result[0].name).toBe(qualified.name); expect(result[0].address).toBe(qualified.address);
    expect(resolveTeeItUpRecipeFacilities(selectedSource, [rows[0]])[0].id).toBe(11);
    expect(resolveTeeItUpRecipeFacilities(selectedSource, [{ ...rows[0], name: "Harbor Golf Club - NY" }])[0].id).toBe(11);
  });
  it.each([
    { name: "Harbor Golf Club, NJ" }, { country: "CA" }, { country: "USA" }, { country: undefined }, { region: "NJ" },
    { name: "Harbor Golf Club, New York" }, { name: "Harbor Golf Club, ny" }, { name: "Harbor Golf Club, NY, US" },
    { name: "Harbor Golf Club, NY Extra" }, { name: "Harbor Golf Club (NY)" },
    { name: "Harbor Golf Club Annex, NY" }, { name: "Harbor East Golf Club, NY" }, { name: "Harbor Golf Club 9 Holes, NY" },
    { name: "Harbor\u0000 Golf Club, NY" }, { name: "Other Golf Club, NY" },
    { address: "11 Harbor Dr., Example, NY 12345, US" }, { address: "10 W Harbor Dr., Example, NY 12345, US" },
    { address: "10 Harbor Road, Example, NY 12345, US" }, { address: "10 Harbor Dr., Other, NY 12345, US" },
    { address: "10 Harbor Dr., Example, NJ 12345, US" }, { address: "10 Harbor Dr., Example, NY 12346, US" },
    { address: "10 Harbor Dr., Example, NY 12345-6789, US" }, { timeZone: "America/Chicago" }, { isSimulator: true },
  ])("rejects contradictory, foreign or nonterminal facts %j", change => {
    expect(() => resolveTeeItUpRecipeFacilities(selectedSource, [{ ...qualified, ...change }])).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("requires recognized US region and both complete physical addresses, without generalizing bare/multiple selection", () => {
    const unknown = { ...qualified, name: "Harbor Golf Club, ZZ", region: "ZZ", address: qualified.address.replace("NY", "ZZ") };
    expect(() => resolveTeeItUpRecipeFacilities({ ...selectedSource, venueAddress: source.venueAddress.replace("NY", "ZZ") }, [unknown])).toThrow();
    for (const change of [{ venueAddress: "Example, NY 12345, US" }, { venueAddress: source.venueAddress.replace("NY", "NJ") },
      { venueName: "Harbor\nGolf Club" }, { bookingUrl: "https://harbor.book.teeitup.com/" },
      { bookingUrl: "https://harbor.book.teeitup.com/?course=99" }, { bookingUrl: source.bookingUrl }])
      expect(() => resolveTeeItUpRecipeFacilities({ ...selectedSource, ...change }, [qualified])).toThrow();
    expect(() => resolveTeeItUpRecipeFacilities(selectedSource, [qualified, qualified])).toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
    expect(() => resolveTeeItUpRecipeFacilities(selectedSource, [qualified, { ...qualified, id: 22 }])).toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
    expect(() => resolveTeeItUpRecipeFacilities({ ...selectedSource, bookingUrl: source.bookingUrl }, [qualified, { ...qualified, id: 22, courseId: "south" }])).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("rederives the same full physical state-qualified identity on both fresh dates and rejects warm changes", async () => {
    const lease = async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() });
    const fetchFor = (directory: unknown = [qualified]) => vi.fn<typeof fetch>(async value => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/facilities")) return Response.json(directory);
      expect(url.pathname).toBe("/v2/tee-times"); expect(url.searchParams.get("facilityIds")).toBe("11");
      return Response.json([{ courseId: "north", teetimes: [{ courseId: "north", teetime: `${url.searchParams.get("date")}T15:00:00Z`, rates: [{ allowedPlayers: [2, 3, 4], holes: 18 }] }] }]);
    });
    const deps = { requestLease: lease, venueMatches: venueProofMatches }, inspected = await inspectExistingAdapter(selectedSource, { ...deps, fetch: fetchFor() });
    const recipe = { schemaVersion: 1 as const, engine: "EXISTING_ADAPTER" as const, target: { courseId: "example", kind: "OUTDOOR" as const }, source: selectedSource, adapter: inspected.adapter };
    const run = (date: string, fetch: typeof globalThis.fetch) => executeExistingAdapterRecipe(recipe,
      { date, players: 2, startTime: "08:00", endTime: "18:00", timeZone: source.timeZone },
      { ...deps, fetch, recipeHash: "a".repeat(64), toInstant: recipeTimeToInstant, now: () => new Date("2030-10-26T00:00:00Z") });
    for (const date of ["2030-10-27", "2030-10-28"]) {
      const result = await run(date, fetchFor()); expect(result.evidence.reason).toBeUndefined();
      expect(result).toMatchObject({ complete: true, status: "AVAILABLE", evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
    }
    for (const change of [{ country: "CA" }, { name: "Harbor Golf Club, NJ" }, { address: "99 Harbor Dr., Example, NY 12345, US" }, { timeZone: "America/Chicago" }]) {
      const fetch = fetchFor([{ ...qualified, ...change }]), result = await run("2030-10-28", fetch);
      expect(result.complete).toBe(false); expect(result.evidence.reason).toBe("ADAPTER_IDENTITY_MISMATCH"); expect(fetch).toHaveBeenCalledOnce();
    }
  });
});
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
