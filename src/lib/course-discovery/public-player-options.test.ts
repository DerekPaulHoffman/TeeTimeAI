import { describe, expect, it } from "vitest";
import { parsePublicPlayerOptions } from "./public-player-options";

describe("closed public party-size choices", () => {
  it.each([
    ["1 player", [1]],
    ["4 players", [4]],
    ["100 players", [100]],
    ["1 to 4 players", [1, 2, 3, 4]],
    ["2 to 5 players", [2, 3, 4, 5]],
    ["1 to 1 players", [1]],
    ["99 to 100 players", [99, 100]],
    ["1 or 2 players", [1, 2]],
    ["1 or 4 players", [1, 4]],
    ["4 or 1 players", [1, 4]],
    ["2 or 100 players", [2, 100]],
    [" \t1\n OR\t 4\u00a0PLAYERS\r\n", [1, 4]],
  ] as const)("parses the entire labelled statement %s", (text, expected) => {
    expect(parsePublicPlayerOptions(text)).toEqual({ allowedPlayers: [...expected], minPlayers: expected[0], maxPlayers: expected[expected.length - 1] });
  });

  it("preserves exact membership rather than converting options into an available-count interval", () => {
    const gap = parsePublicPlayerOptions("1 or 4 players")!;
    expect(gap.minPlayers).toBe(1); expect(gap.maxPlayers).toBe(4);
    expect(gap.allowedPlayers.includes(2)).toBe(false); expect(gap.allowedPlayers.includes(3)).toBe(false);
    expect(parsePublicPlayerOptions("4 players")?.allowedPlayers).toEqual([4]);
    expect(parsePublicPlayerOptions("4")).toBeUndefined();
  });

  it("bounds a full closed range to exactly 100 distinct choices", () => {
    const all = parsePublicPlayerOptions("1 to 100 players")!;
    expect(all.allowedPlayers).toEqual(Array.from({ length: 100 }, (_value, index) => index + 1));
    expect(new Set(all.allowedPlayers).size).toBe(100);
    expect(all).toMatchObject({ minPlayers: 1, maxPlayers: 100 });
  });

  it.each([
    "", "1", "4", "1 to 4", "1 or 2", "players", "player 1", "players 1 to 4",
    "0 players", "0 to 4 players", "1 or 0 players", "101 players", "1 to 101 players", "1 or 101 players", "999 players",
    "-1 player", "+1 player", "1.0 player", "1.5 players", "1 to 2.5 players", "01 player", "1 to 04 players",
    "4 to 1 players", "2 or 2 players", "1 or 2 or 4 players", "1 to 2 or 4 players", "1-4 players", "1–4 players", "1/4 players",
    "$4 players", "4 players $20", "$20 for 1 player", "1:00 player", "1 to 4 PM players", "10/23/2026 players", "2026 players",
    "1 to 4 holes", "1 to 4 bays", "1 to 4 minutes", "1 to 4 golfers", "1 to 4 guests", "1 or 2 people",
    "Available 1 player", "1 player available", "1 to 4 players remaining", "1 player, 4 spots", "1 to 4 players per bay",
    "Book 1 player", "1 player Select", "1 player.", "(1 player)", "1 player; 2 players", "1 to 4 players or call",
    "1to4 players", "1 or2 players", "1 player\u200b", "１ player", "١ player", "1\u0000player", "1" + " ".repeat(257) + "player",
  ])("rejects unlabelled, malformed, ambiguous or mixed text %s", text => {
    expect(parsePublicPlayerOptions(text)).toBeUndefined();
  });

  it.each([undefined, null, 1, 4, true, [], {}, { text: "1 to 4 players" }])("does not coerce non-string input %s", value => {
    expect(parsePublicPlayerOptions(value)).toBeUndefined();
  });

  it("returns independent sets on each call", () => {
    const first = parsePublicPlayerOptions("1 or 4 players")!;
    first.allowedPlayers.push(2);
    expect(parsePublicPlayerOptions("1 or 4 players")?.allowedPlayers).toEqual([1, 4]);
  });
});
