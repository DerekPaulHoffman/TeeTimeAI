import { describe, expect, it } from "vitest";
import { getCourseSetupDeadline } from "./course-setup-deadline";

const search = {
  alertGeneration: 0,
  createdAt: new Date("2026-11-27T22:00:00Z"),
  statusEmailSnapshot: null,
  date: new Date("2026-11-28T00:00:00Z"),
  endTime: "18:00",
};

describe("course setup deadline", () => {
  it("starts from the saved demand and uses no worker timestamps", () => {
    expect(getCourseSetupDeadline(search, "America/New_York").toISOString()).toBe("2026-11-27T22:15:00.000Z");
  });

  it("uses the material request clock and falls back for migrated legacy rows", () => {
    const changed = { ...search, alertGeneration: 3, setupStartedAt: new Date("2026-11-27T22:03:00Z"),
      statusEmailSnapshot: { kind: "ALERT_GENERATION_START", alertGeneration: 3, generationStartedAt: "2026-11-27T22:13:00Z" } };
    expect(getCourseSetupDeadline(changed, "America/New_York").toISOString())
      .toBe("2026-11-27T22:18:00.000Z");
    expect(getCourseSetupDeadline({ ...changed, setupStartedAt: null }, "America/New_York").toISOString()).toBe("2026-11-27T22:15:00.000Z");
  });

  it("caps the clock at the selected course's local window, including midnight", () => {
    const finishing = { ...search, date: new Date("2026-11-27T00:00:00Z"), endTime: "17:08" };
    expect(getCourseSetupDeadline(finishing, "America/New_York").toISOString()).toBe("2026-11-27T22:08:00.000Z");
    expect(getCourseSetupDeadline(finishing, "America/Chicago").toISOString()).toBe("2026-11-27T22:15:00.000Z");
    expect(getCourseSetupDeadline({ ...finishing, endTime: "24:00", createdAt: new Date("2026-11-28T04:56:00Z") }, "America/New_York").toISOString())
      .toBe("2026-11-28T05:00:00.000Z");
  });
});
