import { describe, expect, it, vi } from "vitest";
import { matchesPublicVenueGreeting } from "./public-venue-greeting";

const venue = "Example Golf Club";
const strict = (canonical: string, observed: unknown) => canonical === observed;
const engine = (name = venue, apostrophe = "'") => `Welcome to ${name}${apostrophe}s online tee time engine.`;
const copy = (name = venue, you = "") => ` You are guaranteed to receive the best online rates for ${name} when you book direct with us. We look forward to seeing ${you}on the golf course.`;

describe("bounded explicit public venue greetings", () => {
  it.each([
    `Welcome to ${venue}.`, `Welcome to the ${venue}.`, engine(), engine(`the ${venue}`), engine(venue, "’"),
    engine() + copy(), engine() + copy(venue, "you "), engine(`the ${venue}`, "’") + copy(`the ${venue}`),
    ` \nWelcome to ${venue}.\t`, engine().toLowerCase().replace(venue.toLowerCase(), venue),
  ])("accepts only a complete supported identity claim: %s", value => {
    expect(matchesPublicVenueGreeting(venue, value, strict)).toBe(true);
  });
  it("tries each complete capture strictly before stripping only one grammatical leading article", () => {
    const matcher = vi.fn(strict);
    expect(matchesPublicVenueGreeting(venue, engine(`the ${venue}`) + copy(`the ${venue}`), matcher)).toBe(true);
    expect(matcher.mock.calls.map(([, observed]) => observed)).toEqual([`the ${venue}`, venue, `the ${venue}`, venue]);
    expect(matchesPublicVenueGreeting(venue, engine(`the the ${venue}`), strict)).toBe(false);
    expect(matchesPublicVenueGreeting("The Golf Club", engine("The Golf Club"), strict)).toBe(true);
  });
  it.each([
    null, undefined, 3, {}, [venue], "", venue,
    `Other text. Welcome to ${venue}.`, `Hello, welcome to ${venue}.`, `Welcome to nearby ${venue}.`, `Welcome to formerly ${venue}.`,
    `Welcome to Other Golf Club.`, `Welcome to ${venue}. Arbitrary extra copy.`, `Welcome to ${venue}. -.`,
    `Welcome to Other Golf Club. Welcome to ${venue}.`, `Welcome to ${venue}. Welcome to Other Golf Club.`,
    `Welcome to ${venue}?`, `Welcome to ${venue}..`, `Welcome to ${venue}!`, `Welcome to ${venue}`,
    engine().replace("'s", "s"), engine().replace("'s", "`s"), engine().replace("engine.", "website."), engine().slice(0, -1),
    engine() + " Extra copy.", engine() + copy("Other Golf Club"), engine("Other Golf Club") + copy(),
    engine() + copy().replace("when you book direct with us.", "when you book with another venue."),
    engine() + copy().replace("golf course.", "club."), engine() + copy().replace("We look forward to seeing on the golf course.", ""),
    `Welcome to ${venue} for $40.`, `Welcome to ${venue} at 10:00AM.`, `Welcome to ${venue} for 4 players.`,
    `Welcome to ${venue}. `.repeat(20), " ".repeat(501) + `Welcome to ${venue}.`,
  ])("rejects malformed, conflicting, incomplete or buried claims %#", value => {
    expect(matchesPublicVenueGreeting(venue, value, strict)).toBe(false);
  });
  it("caps both complete text and individual names before calling the strict matcher", () => {
    const matcher = vi.fn(() => true), longName = "A".repeat(201);
    expect(matchesPublicVenueGreeting(venue, `Welcome to ${longName}.`, matcher)).toBe(false);
    expect(matchesPublicVenueGreeting(venue, engine(longName), matcher)).toBe(false);
    expect(matchesPublicVenueGreeting(venue, engine() + copy(longName), matcher)).toBe(false);
    expect(matchesPublicVenueGreeting(venue, engine("A".repeat(200)) + copy("A".repeat(200)), matcher)).toBe(false);
    expect(matcher).not.toHaveBeenCalled();
  });
  it("does not let punctuation normalization swallow a second sentence", () => {
    const compact = (name: unknown) => String(name).replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
    const punctuationTolerant = (canonical: string, observed: unknown) => compact(canonical) === compact(observed);
    expect(matchesPublicVenueGreeting(venue, `Welcome to ${venue}. -.`, punctuationTolerant)).toBe(false);
    expect(matchesPublicVenueGreeting(venue, `Welcome to ${venue}..`, punctuationTolerant)).toBe(false);
  });
});
