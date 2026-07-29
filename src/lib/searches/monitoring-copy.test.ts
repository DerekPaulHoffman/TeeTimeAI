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
    const message = buildSearchSavedMessage([
      { name: "Unreviewed Golf Course", firstTimeLookup: true }
    ]);

    expect(message).toContain("We haven't checked Unreviewed Golf Course before");
    expect(message).toContain("usually within 10 minutes");
    expect(message).toContain("whether alerts are available");
    expect(message).not.toContain("the moment a matching tee time opens up");
  });

  it("gives a ten-minute expectation without calling a reused course a first lookup", () => {
    const message = buildSearchSavedMessage([{ name: "Pending Golf Course" }]);

    expect(message).toContain(
      "We'll email whether alerts are available for Pending Golf Course after the first check, usually within 10 minutes"
    );
    expect(message).not.toContain("haven't checked");
  });

  it("names a phone-only course without claiming it is monitored", () => {
    const message = buildSearchSavedMessage([
      { name: "Fairview Farm Golf Course", alertSupport: "PHONE_ONLY" },
      { name: "Timberlin Golf Course", monitoringSupport: "AUTOMATIC" }
    ]);

    expect(message).toContain("We'll check courses where alerts are available");
    expect(message).toContain(
      "Call Fairview Farm Golf Course for tee-time availability"
    );
    expect(message).toContain("Tee Time Spot won't send automatic alerts for this course");
  });

  it("can describe multiple durable manual booking modes", () => {
    const message = buildSearchSavedMessage([
      { name: "Phone Course", alertSupport: "PHONE_ONLY" },
      { name: "Walk-in Course", alertSupport: "WALK_IN_ONLY" }
    ]);

    expect(message).toContain(
      "Call Phone Course for tee-time availability"
    );
    expect(message).toContain("Walk-in Course handles tee times in person");
    expect(message).toContain("Tee Time Spot won't send automatic alerts for these courses");
  });

  it("explains staff-provisioned access as setup, not private membership", () => {
    const message = buildSearchSavedMessage([
      {
        name: "Public Resort Golf Course",
        alertSupport: "ACCOUNT_STAFF_PROVISIONED"
      }
    ]);

    expect(message).toContain(
      "Contact Public Resort Golf Course before booking online"
    );
    expect(message).not.toContain("private");
    expect(message).toContain("Tee Time Spot won't send automatic alerts for this course");
  });

  it("tells golfers when online booking remains available without automatic monitoring", () => {
    const message = buildSearchSavedMessage([
      { name: "Yale University Golf Course", alertSupport: "DIRECT_ONLINE" }
    ]);

    expect(message).toContain(
      "Check and book Yale University Golf Course on its official website"
    );
    expect(message).toContain("Tee Time Spot won't send automatic alerts for this course");
  });
});
