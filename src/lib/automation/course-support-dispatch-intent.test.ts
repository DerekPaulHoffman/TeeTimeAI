import { describe, expect, it } from "vitest";

import {
  createCourseDispatchIntentDigest,
  isCurrentCourseDispatchSource,
  type CourseDispatchSource,
} from "./course-support-dispatch-intent";

const now = new Date("2026-10-05T14:00:00.000Z");

function source(): CourseDispatchSource {
  return {
    id: "search-1", userId: "user-1",
    user: { id: "user-1", clerkUserId: "clerk-1", email: "owner@example.com", pendingEmail: null },
    alertEmail: "owner@example.com", additionalEmails: ["Second@example.com", "third@example.com"],
    date: new Date("2026-10-06T00:00:00.000Z"), startTime: "06:00", endTime: "20:00",
    userTimeZone: "America/New_York", players: 2, requestedLayoutHoles: null,
    cadenceMinutes: 15, trafficClass: "PUBLIC", syntheticMultiCycle: false,
    syntheticTestWindow: null, createdAt: new Date("2026-10-05T13:00:00.000Z"),
    status: "ACTIVE", scheduleVersion: 2, alertGeneration: 0,
    preferences: [{ courseId: "course-a", rank: 1 }, { courseId: "course-b", rank: 2 }],
  };
}

function current(search: CourseDispatchSource, ref = {
  id: search.id, scheduleVersion: 2, alertGeneration: 0,
  intentDigest: createCourseDispatchIntentDigest(source()),
}) {
  return isCurrentCourseDispatchSource({
    ref, search, trafficClass: "REAL", courseTimeZone: "America/New_York", now,
  });
}

describe("course dispatch source authority", () => {
  it("preserves a bound worker through a schedule-only retry and normalized recipient ordering", () => {
    const search = source();
    search.scheduleVersion = 4;
    search.additionalEmails = [" THIRD@example.com ", "second@example.com", "third@example.com"];
    expect(current(search)).toBe(true);
    expect(createCourseDispatchIntentDigest(search)).not.toContain("owner@example.com");
    search.scheduleVersion = 1;
    expect(current(search)).toBe(false);
  });

  it("keeps legacy assignments on their exact schedule until they finish", () => {
    const search = source();
    expect(current(search, { id: search.id, scheduleVersion: 2, alertGeneration: 0, intentDigest: undefined })).toBe(true);
    search.scheduleVersion = 4;
    expect(current(search, { id: search.id, scheduleVersion: 2, alertGeneration: 0, intentDigest: undefined })).toBe(false);
  });

  it.each([
    ["generation", (search: CourseDispatchSource) => { search.alertGeneration += 1; }],
    ["account owner", (search: CourseDispatchSource) => { search.userId = "user-2"; }],
    ["Clerk owner", (search: CourseDispatchSource) => { search.user.clerkUserId = "clerk-2"; }],
    ["account email", (search: CourseDispatchSource) => { search.user.email = "new@example.com"; }],
    ["pending email", (search: CourseDispatchSource) => { search.user.pendingEmail = "new@example.com"; }],
    ["alert email", (search: CourseDispatchSource) => { search.alertEmail = "new@example.com"; }],
    ["additional recipient", (search: CourseDispatchSource) => { search.additionalEmails.push("new@example.com"); }],
    ["date", (search: CourseDispatchSource) => { search.date = new Date("2026-10-07T00:00:00.000Z"); }],
    ["time window", (search: CourseDispatchSource) => { search.startTime = "07:00"; }],
    ["time zone", (search: CourseDispatchSource) => { search.userTimeZone = "America/Chicago"; }],
    ["players", (search: CourseDispatchSource) => { search.players = 3; }],
    ["layout", (search: CourseDispatchSource) => { search.requestedLayoutHoles = 9; }],
    ["cadence", (search: CourseDispatchSource) => { search.cadenceMinutes = 30; }],
    ["course rank", (search: CourseDispatchSource) => { search.preferences[0].rank = 2; }],
    ["course selection", (search: CourseDispatchSource) => { search.preferences[1].courseId = "course-c"; }],
    ["traffic class", (search: CourseDispatchSource) => { search.trafficClass = "TEST"; }],
  ] as const)("rejects changed %s even when schedule version only increases", (_name, mutate) => {
    const search = source();
    search.scheduleVersion = 4;
    mutate(search);
    expect(current(search)).toBe(false);
  });
});
