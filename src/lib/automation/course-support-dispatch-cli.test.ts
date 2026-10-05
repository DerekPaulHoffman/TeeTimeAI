import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/automation/course-support-course-dispatch", () => ({
  beginCourseSupportCourseDispatch: vi.fn(),
  bindCourseSupportCourseDispatch: vi.fn(),
  cancelCourseSupportCourseDispatch: vi.fn(),
  getCourseSupportCourseDispatchAssignment: vi.fn(),
  planCourseSupportCourseDispatch: vi.fn(),
}));

import { readDispatchArguments } from "../../../scripts/automation/course-support-dispatch";

describe("course dispatcher command authority", () => {
  it("bounds a scheduled launch without accepting an assignment selector", () => {
    expect(readDispatchArguments(["plan", "--scheduled-cycle", "--max-starts", "15"])).toMatchObject({
      command: "plan", maxStarts: 15, scheduledCycle: true,
    });
    for (const value of ["0", "16", "1.5", "NaN", "Infinity"]) {
      expect(() => readDispatchArguments(["plan", "--max-starts", value])).toThrow();
    }
    expect(() => readDispatchArguments(["plan", "--assignment-ref", "opaque-ref"])).toThrow();
    expect(() => readDispatchArguments(["plan", "--scheduled-cycle", "--scheduled-cycle"])).toThrow();
  });

  it("requires a real child binding selector only for the binding command", () => {
    expect(readDispatchArguments(["bind", "--assignment-ref", "opaque-ref", "--child-thread", "native-child"])).toMatchObject({
      command: "bind", assignmentRef: "opaque-ref", childThreadId: "native-child",
    });
    expect(() => readDispatchArguments(["bind", "--assignment-ref", "opaque-ref"])).toThrow();
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--child-thread", "native-child"])).toThrow();
    expect(() => readDispatchArguments(["bind", "--assignment-ref", "opaque-ref", "--child-thread", "native-child", "--child-thread", "other-child"])).toThrow();
  });

  it("requires explicit evidence of no native start before cancellation", () => {
    expect(() => readDispatchArguments(["cancel", "--assignment-ref", "opaque-ref"])).toThrow();
    expect(readDispatchArguments(["cancel", "--assignment-ref", "opaque-ref", "--confirmed-not-started"])).toMatchObject({ command: "cancel" });
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--confirmed-not-started"])).toThrow();
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--scheduled-cycle"])).toThrow();
  });

  it("rejects unknown flags and missing assignment references before any operation", () => {
    for (const command of ["start", "bind", "assignment", "cancel"]) {
      expect(() => readDispatchArguments([command])).toThrow();
    }
    expect(() => readDispatchArguments(["start", "--assignment-ref"])).toThrow();
    expect(() => readDispatchArguments(["start", "--assignment-ref", "opaque-ref", "--apply"])).toThrow();
  });
});
