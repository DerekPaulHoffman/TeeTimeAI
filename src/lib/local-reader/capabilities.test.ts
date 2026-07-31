import { describe, expect, it } from "vitest";

import {
  getRequiredLocalReaderCapability,
  parseLocalReaderCapabilities,
  readerSupportsCapability,
  serializeLocalReaderCapabilities
} from "./capabilities";

describe("local reader capabilities", () => {
  it("round-trips the signed reader capability handshake", () => {
    const capabilities = [
      { key: "CPS_RENDERED" as const, parserVersion: 2 },
      { key: "CHRONOGOLF_RENDERED" as const, parserVersion: 1 }
    ];

    expect(parseLocalReaderCapabilities(serializeLocalReaderCapabilities(capabilities))).toEqual(
      capabilities
    );
  });

  it("requires a compatible parser version before leasing work", () => {
    const available = [{ key: "CHRONOGOLF_RENDERED" as const, parserVersion: 1 }];

    expect(readerSupportsCapability(available, "CHRONOGOLF_RENDERED", 1)).toBe(true);
    expect(readerSupportsCapability(available, "CHRONOGOLF_RENDERED", 2)).toBe(false);
    expect(readerSupportsCapability(available, "CPS_RENDERED", 1)).toBe(false);
  });

  it("routes generic public Chronogolf profiles to the rendered parser", () => {
    expect(
      getRequiredLocalReaderCapability("chronogolf:future-public-course", "Future Public Course")
    ).toEqual({
      key: "CHRONOGOLF_RENDERED",
      parserVersion: 1
    });
  });

  it("routes safe EZLinks tenants to the rendered parser", () => {
    expect(
      getRequiredLocalReaderCapability(
        "ezlinks:ballysapi.ezlinksgolf.com",
        "Bally's Golf Links at Ferry Point"
      )
    ).toEqual({
      key: "EZLINKS_RENDERED",
      parserVersion: 1
    });
  });

  it("routes safe MyVSCloud WebTrac tenants to the rendered parser", () => {
    expect(
      getRequiredLocalReaderCapability(
        "webtrac:ctguilfordweb.myvscloud.com",
        "Guilford Lakes Golf Course"
      )
    ).toEqual({
      key: "WEBTRAC_RENDERED",
      parserVersion: 1
    });
  });

  it("requires the corrected Prophet redirect parser for both supported courses", () => {
    expect(getRequiredLocalReaderCapability("frear-park")).toEqual({
      key: "PROPHET_FREAR_RENDERED",
      parserVersion: 4
    });
    expect(getRequiredLocalReaderCapability("simsbury-farms")).toEqual({
      key: "PROPHET_FREAR_RENDERED",
      parserVersion: 4
    });
  });
});
