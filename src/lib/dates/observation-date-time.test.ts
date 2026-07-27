import { describe, expect, it } from "vitest";

import { formatObservationDateTime } from "./observation-date-time";

describe("formatObservationDateTime", () => {
  it("formats a production observation in the golfer's time zone", () => {
    expect(
      formatObservationDateTime(
        "2026-07-27T17:39:51.167Z",
        "America/New_York"
      )
    ).toBe("Jul 27, 1:39 PM EDT");
  });

  it("uses the supplied golfer time zone instead of the server time zone", () => {
    expect(
      formatObservationDateTime(
        new Date("2026-07-27T17:39:51.167Z"),
        "America/Los_Angeles"
      )
    ).toBe("Jul 27, 10:39 AM PDT");
  });

  it("fails safely for invalid timestamps and time zones", () => {
    expect(
      formatObservationDateTime("not-a-date", "America/New_York")
    ).toBe("recently");
    expect(
      formatObservationDateTime(
        "2026-07-27T17:39:51.167Z",
        "not-a-time-zone"
      )
    ).toBe("Jul 27, 1:39 PM EDT");
  });
});
