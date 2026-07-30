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
});
