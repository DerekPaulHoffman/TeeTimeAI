import { describe, expect, it } from "vitest";

import { buildSearchSavedMessage } from "./monitoring-copy";

describe("buildSearchSavedMessage", () => {
  it("keeps the standard confirmation when every course can be monitored", () => {
    expect(buildSearchSavedMessage([
      { name: "Timberlin Golf Course", monitoringSupport: "AUTOMATIC" }
    ])).toContain(
      "We'll email you the moment a matching tee time opens up."
    );
  });

  it("does not promise alerts before monitoring has been confirmed", () => {
    const message = buildSearchSavedMessage([{ name: "Unreviewed Golf Course" }]);

    expect(message).toContain(
      "We'll email a monitoring verdict for Unreviewed Golf Course after the first check"
    );
    expect(message).toContain("capped at 30 minutes");
    expect(message).not.toContain("the moment a matching tee time opens up");
  });

  it("names a phone-only course without claiming it is monitored", () => {
    const message = buildSearchSavedMessage([
      { name: "Fairview Farm Golf Course", alertSupport: "PHONE_ONLY" },
      { name: "Timberlin Golf Course", monitoringSupport: "AUTOMATIC" }
    ]);

    expect(message).toContain("We'll monitor supported courses");
    expect(message).toContain(
      "Fairview Farm Golf Course takes tee-time requests by phone only"
    );
    expect(message).toContain("won't be checked automatically");
  });

  it("can describe multiple durable manual booking modes", () => {
    const message = buildSearchSavedMessage([
      { name: "Phone Course", alertSupport: "PHONE_ONLY" },
      { name: "Walk-in Course", alertSupport: "WALK_IN_ONLY" }
    ]);

    expect(message).toContain(
      "Phone Course takes tee-time requests by phone only"
    );
    expect(message).toContain("Walk-in Course handles tee times in person");
    expect(message).toContain("They won't be checked automatically");
  });

  it("explains staff-provisioned access as setup, not private membership", () => {
    const message = buildSearchSavedMessage([
      {
        name: "Public Resort Golf Course",
        alertSupport: "ACCOUNT_STAFF_PROVISIONED"
      }
    ]);

    expect(message).toContain(
      "Public Resort Golf Course requires first-time access setup by course staff"
    );
    expect(message).not.toContain("private");
    expect(message).toContain("won't be checked automatically");
  });

  it("tells golfers when online booking remains available without automatic monitoring", () => {
    const message = buildSearchSavedMessage([
      { name: "Yale University Golf Course", alertSupport: "DIRECT_ONLINE" }
    ]);

    expect(message).toContain(
      "Yale University Golf Course can be booked online directly"
    );
    expect(message).toContain("won't be checked automatically");
  });
});
