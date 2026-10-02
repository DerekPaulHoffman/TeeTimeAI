import { describe, expect, it } from "vitest";
import { getNotificationTitle, groupDashboardNotifications, notificationWindowEnded } from "./dashboard-notifications";

const preference = (id: string, name = id) => ({ course: { id, name, timeZone: "America/New_York" } });
const settings = { date: new Date("2030-10-03T00:00:00Z"), endTime: "18:00" };
describe("individual course notifications", () => {
  it("identifies single courses and keeps legacy groups explicit", () => {
    expect(getNotificationTitle([preference("tashua", "Tashua Knolls")])).toBe("Tashua Knolls");
    expect(getNotificationTitle([preference("tashua"), preference("whitney")])).toBe("tashua + 1 other course");
  });
  it("counts only active courses while keeping paused slots and history separate", () => {
    const result = groupDashboardNotifications([
      { ...settings, status: "ACTIVE", preferences: [preference("a")] },
      { ...settings, status: "PAUSED", preferences: [preference("b")] },
      { ...settings, status: "COMPLETED", preferences: [preference("old")] },
      { ...settings, status: "CANCELLED", preferences: [preference("older")] }
    ]);
    expect(result.monitoredCourseCount).toBe(1);
    expect(result.slotsUsed).toBe(2);
    expect(result.paused).toHaveLength(1);
    expect(result.history).toHaveLength(3);
  });
  it("moves expired active alerts and every paused alert into history without changing saved status", () => {
    const expired = { ...settings, status: "ACTIVE", preferences: [preference("past")] };
    const paused = { ...settings, status: "PAUSED", preferences: [preference("paused")] };
    const result = groupDashboardNotifications([expired, paused], new Date("2030-10-04T01:00:00Z"));
    expect(result.active).toHaveLength(0);
    expect(result.history).toEqual([expired, paused]);
    expect(result.slotsUsed).toBe(2);
    expect(expired.status).toBe("ACTIVE");
  });
  it("ends a group only after every course-local requested window ends", () => {
    const zones = ["America/New_York", "America/Los_Angeles"];
    expect(notificationWindowEnded("2026-10-03", "18:00", zones, new Date("2026-10-03T23:00:00Z"))).toBe(false);
    expect(notificationWindowEnded("2026-10-03", "18:00", zones, new Date("2026-10-04T01:00:00Z"))).toBe(true);
  });
});
