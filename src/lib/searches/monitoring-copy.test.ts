import { describe, expect, it } from "vitest";

import { buildSearchSavedMessage } from "./monitoring-copy";

describe("buildSearchSavedMessage", () => {
  it("keeps the standard confirmation when every course can be monitored", () => {
    expect(buildSearchSavedMessage([{ name: "Timberlin Golf Course" }])).toContain(
      "We'll email you the moment a matching tee time opens up."
    );
  });

  it("names an official-site-only course without claiming it is monitored", () => {
    const message = buildSearchSavedMessage([
      { name: "Fairview Farm Golf Course", alertSupport: "OFFICIAL_SITE_ONLY" },
      { name: "Timberlin Golf Course" }
    ]);

    expect(message).toContain("We'll monitor supported courses");
    expect(message).toContain("Fairview Farm Golf Course is official-site only");
    expect(message).toContain("won't be checked automatically");
  });
});
