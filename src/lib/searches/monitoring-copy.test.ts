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
      "We'll confirm whether we can check Unreviewed Golf Course automatically when your alert starts."
    );
    expect(message).not.toContain("the moment a matching tee time opens up");
  });

  it("names a phone-only course without claiming it is monitored", () => {
    const message = buildSearchSavedMessage([
      { name: "Fairview Farm Golf Course", alertSupport: "PHONE_ONLY" },
      { name: "Timberlin Golf Course", monitoringSupport: "AUTOMATIC" }
    ]);

    expect(message).toContain("We'll check supported courses");
    expect(message).toContain(
      "Call Fairview Farm Golf Course for tee-time availability"
    );
    expect(message).toContain("Tee Time Spot won't check this course automatically");
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
    expect(message).toContain("Tee Time Spot won't check these courses automatically");
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
    expect(message).toContain("Tee Time Spot won't check this course automatically");
  });

  it("tells golfers when online booking remains available without automatic monitoring", () => {
    const message = buildSearchSavedMessage([
      { name: "Yale University Golf Course", alertSupport: "DIRECT_ONLINE" }
    ]);

    expect(message).toContain(
      "Check and book Yale University Golf Course on its official website"
    );
    expect(message).toContain("Tee Time Spot won't check this course automatically");
  });
});
