import { describe, expect, it } from "vitest";

import {
  buildAlertGenerationStartMarker,
  isAlertGenerationStartMarker,
  preserveAlertGenerationClockInStatusSnapshot,
  readAlertGenerationStartedAt,
  unwrapAlertGenerationStatusSnapshot,
} from "./generation-clock";

describe("alert generation clock", () => {
  it("anchors the first generation to search creation", () => {
    const createdAt = new Date("2026-08-11T20:07:26.000Z");

    expect(
      readAlertGenerationStartedAt({
        alertGeneration: 0,
        createdAt,
        statusEmailSnapshot: null,
      }),
    ).toEqual(createdAt);
  });

  it("reads a later generation only from its matching durable marker", () => {
    const generationStartedAt = new Date("2026-08-11T21:00:00.000Z");
    const marker = buildAlertGenerationStartMarker({
      alertGeneration: 3,
      generationStartedAt,
    });

    expect(isAlertGenerationStartMarker(marker)).toBe(true);
    expect(
      readAlertGenerationStartedAt({
        alertGeneration: 3,
        createdAt: new Date("2026-08-01T12:00:00.000Z"),
        statusEmailSnapshot: marker,
      }),
    ).toEqual(generationStartedAt);
    expect(
      readAlertGenerationStartedAt({
        alertGeneration: 4,
        createdAt: new Date("2026-08-01T12:00:00.000Z"),
        statusEmailSnapshot: marker,
      }),
    ).toBeNull();
  });

  it("does not invent a later-generation boundary from a legacy snapshot", () => {
    expect(
      readAlertGenerationStartedAt({
        alertGeneration: 2,
        createdAt: new Date("2026-08-01T12:00:00.000Z"),
        statusEmailSnapshot: [
          { courseId: "course-1", courseName: "Course", state: "checking" },
        ],
      }),
    ).toBeNull();
  });

  it("retains a later-generation clock when setup stores the course snapshot", () => {
    const generationStartedAt = new Date("2026-08-11T21:00:00.000Z");
    const courseSnapshot = [
      { courseId: "course-1", courseName: "Course", state: "checking" },
    ];
    const persisted = preserveAlertGenerationClockInStatusSnapshot({
      alertGeneration: 3,
      currentStatusEmailSnapshot: buildAlertGenerationStartMarker({
        alertGeneration: 3,
        generationStartedAt,
      }),
      courseSnapshot,
    });

    expect(isAlertGenerationStartMarker(persisted)).toBe(true);
    expect(
      readAlertGenerationStartedAt({
        alertGeneration: 3,
        createdAt: new Date("2026-08-01T12:00:00.000Z"),
        statusEmailSnapshot: persisted,
      }),
    ).toEqual(generationStartedAt);
    expect(unwrapAlertGenerationStatusSnapshot(persisted)).toEqual(
      courseSnapshot,
    );
  });

  it("keeps generation zero snapshots in the legacy array shape", () => {
    const courseSnapshot = [
      { courseId: "course-1", courseName: "Course", state: "checking" },
    ];

    expect(
      preserveAlertGenerationClockInStatusSnapshot({
        alertGeneration: 0,
        currentStatusEmailSnapshot: null,
        courseSnapshot,
      }),
    ).toBe(courseSnapshot);
  });
});
