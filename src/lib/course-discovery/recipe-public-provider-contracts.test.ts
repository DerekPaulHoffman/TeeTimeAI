import { describe, expect, it } from "vitest";
import { parseAccessRecipe } from "./recipe";

const catalogHash = "a".repeat(64);
const source = { officialUrl: "https://examplegolf.com/", venueName: "Example Golf",
  venueAddress: "100 Main St, Example, NY 12345", timeZone: "America/New_York" };
const rex = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "SIMULATOR", courseId: "course", offeringId: "offering" },
  source: { ...source, providerFamily: "REX", bookingUrl: "https://example.reservewithrex.com/package?venue=Example%20Golf" },
  adapter: { family: "REX", tenant: "example", venueId: "11111111-2222-4333-8444-555555555555",
    packageId: "66666666-7777-4888-8999-aaaaaaaaaaaa", catalogHash } };
const cps = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "OUTDOOR", courseId: "course" },
  source: { ...source, providerFamily: "CPS", bookingUrl: "https://example.cps.golf/" },
  adapter: { family: "CPS", tenant: "example", courseIds: [1], catalogHash } };

describe("public provider recipe boundaries", () => {
  it.each([rex, cps])("admits stable public $adapter.family identity data", recipe => {
    expect(parseAccessRecipe(recipe)).toEqual(recipe);
  });
  it.each([rex, cps])("requires canonical address context for $adapter.family", recipe => {
    expect(() => parseAccessRecipe({ ...recipe, source: { ...recipe.source, venueAddress: undefined } })).toThrow();
  });
  it.each([rex, cps])("rejects a different source family for $adapter.family", recipe => {
    expect(() => parseAccessRecipe({ ...recipe, source: { ...recipe.source, providerFamily: "OTHER" } })).toThrow();
  });
  it("keeps the Rex whole-bay reader on simulator offerings", () => {
    expect(() => parseAccessRecipe({ ...rex, target: cps.target })).toThrow();
    expect(() => parseAccessRecipe({ ...rex, target: { kind: "SIMULATOR", courseId: "course" } })).toThrow();
  });
  it("keeps the CPS tee-sheet reader on outdoor courses", () => {
    expect(() => parseAccessRecipe({ ...cps, target: rex.target })).toThrow();
  });
  it.each(["apiKey", "transactionId", "cookie", "javascript"])("never persists %s in either provider's metadata", key => {
    for (const recipe of [rex, cps]) {
      expect(() => parseAccessRecipe({ ...recipe, adapter: { ...recipe.adapter, [key]: "private-value" } })).toThrow();
    }
  });
});
