import { describe, expect, it } from "vitest";
import { parseWhooshSimulatorSource, whooshSimulatorMetadataSchema } from "./whoosh-simulator-source";

describe("Whoosh public facility paths", () => {
  const path = "https://app.whoosh.io/patron/club/golfer's-lounge/agenda/simulators/2030-10-23";
  it.each([path, path.replace("'", "%27")])("keeps an observed apostrophe in the exact public club identity: %s", value => {
    expect(parseWhooshSimulatorSource(value)).toEqual({ clubSlug: "golfer's-lounge", facilitySlug: "simulators" });
    expect(whooshSimulatorMetadataSchema.shape.clubSlug.safeParse("golfer's-lounge").success).toBe(true);
  });
  it.each([path.replace("'", "%2527"), path.replace("'", "%2f"), path.replace("'", "%0d%0a"),
    path.replace("'", "%20"), path.replace("golfer's-lounge", "'lounge"), path.replace("golfer's-lounge", "lounge'"),
    path.split("/agenda/")[0], path+"?token=anything", path+"#calendar", path.replace("app.whoosh.io", "app.whoosh.io.evil.example")])(
    "does not admit another path or identity: %s", value => { expect(parseWhooshSimulatorSource(value)).toBeUndefined(); });
});
