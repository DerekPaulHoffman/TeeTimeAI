import { describe, expect, it } from "vitest";
import { getNotificationTitle, groupDashboardNotifications, notificationWindowEnded } from "./dashboard-notifications";

const preference = (id: string, name = id) => ({ course: { id, name } });
describe("individual course notifications", () => {
  it("identifies single courses and keeps legacy groups explicit", () => {
    expect(getNotificationTitle([preference("tashua", "Tashua Knolls")])).toBe("Tashua Knolls");
    expect(getNotificationTitle([preference("tashua"), preference("whitney")])).toBe("tashua + 1 other course");
  });
  it("counts only active courses while keeping paused slots and history separate", () => {
    const result = groupDashboardNotifications([
      { status: "ACTIVE", preferences: [preference("a")] },
      { status: "PAUSED", preferences: [preference("b")] },
      { status: "COMPLETED", preferences: [preference("old")] },
      { status: "CANCELLED", preferences: [preference("older")] }
    ]);
    expect(result.monitoredCourseCount).toBe(1);
    expect(result.slotsUsed).toBe(2);
    expect(result.paused).toHaveLength(1);
    expect(result.history).toHaveLength(2);
  });
  it("ends a group only after every course-local requested window ends", () => {
    const zones = ["America/New_York", "America/Los_Angeles"];
    expect(notificationWindowEnded("2026-10-03", "18:00", zones, new Date("2026-10-03T23:00:00Z"))).toBe(false);
    expect(notificationWindowEnded("2026-10-03", "18:00", zones, new Date("2026-10-04T01:00:00Z"))).toBe(true);
  });
});
