import { describe, expect, it } from "vitest";

import { selectCourseDispatchTargets } from "./course-support-course-dispatch";

const source = (id: string) => [{ id, scheduleVersion: 1, alertGeneration: 1, trafficClass: "PUBLIC" }];

describe("course support course dispatch selection", () => {
  it("admits fifteen distinct courses from three active alerts and excludes a fourth cohort", () => {
    const candidates = Array.from({ length: 16 }, (_, index) => ({
      courseId: `course-${String(index).padStart(2, "0")}`,
      activeRealSearchCount: 1,
    }));
    const sourceSearchesByCourse = new Map(candidates.map((candidate, index) => [
      candidate.courseId,
      source(`alert-${Math.floor(index / 5)}`),
    ]));
    const result = selectCourseDispatchTargets({
      candidates,
      sourceSearchesByCourse,
      occupiedCourses: new Set(),
      priorSearchIds: new Set(),
      maxStarts: 15,
    });
    expect(result.selected).toHaveLength(15);
    expect(result.eligibleCount).toBe(15);
    expect(result.admittedSearchCount).toBe(3);
    expect(result.selected.map((entry) => entry.candidate.courseId)).not.toContain("course-15");
  });

  it("limits starts even when more courses from the same three alerts are eligible", () => {
    const candidates = Array.from({ length: 15 }, (_, index) => ({
      courseId: `course-${String(index).padStart(2, "0")}`,
      activeRealSearchCount: 1,
    }));
    const result = selectCourseDispatchTargets({
      candidates,
      sourceSearchesByCourse: new Map(candidates.map((candidate, index) => [
        candidate.courseId, source(`alert-${Math.floor(index / 5)}`),
      ])),
      occupiedCourses: new Set(),
      priorSearchIds: new Set(),
      maxStarts: 14,
    });
    expect(result.eligibleCount).toBe(15);
    expect(result.selected).toHaveLength(14);
  });

  it("deduplicates shared courses and respects already admitted alert cohorts", () => {
    const result = selectCourseDispatchTargets({
      candidates: [
        { courseId: "shared", activeRealSearchCount: 2 },
        { courseId: "shared", activeRealSearchCount: 2 },
        { courseId: "new", activeRealSearchCount: 1 },
        { courseId: "occupied", activeRealSearchCount: 1 },
      ],
      sourceSearchesByCourse: new Map([
        ["shared", source("alert-b")],
        ["new", source("alert-c")],
        ["occupied", source("alert-a")],
      ]),
      occupiedCourses: new Set(["occupied"]),
      priorSearchIds: new Set(["alert-a", "alert-b"]),
      maxStarts: 15,
    });
    expect(result.selected.map((entry) => entry.candidate.courseId).sort()).toEqual(["new", "shared"]);
    expect(result.admittedSearchCount).toBe(3);
  });

  it("does not dispatch an old engineering incident without an active source alert", () => {
    const result = selectCourseDispatchTargets({
      candidates: [{ courseId: "ended-alert-course", activeRealSearchCount: 0 }],
      sourceSearchesByCourse: new Map(),
      occupiedCourses: new Set(),
      priorSearchIds: new Set(),
      maxStarts: 15,
    });
    expect(result.selected).toEqual([]);
  });
});
