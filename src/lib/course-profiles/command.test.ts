import { beforeEach, describe, expect, it, vi } from "vitest";

const dbServiceMocks = vi.hoisted(() => ({
  recordCourseBookingWindowEvidence: vi.fn()
}));
const prismaMocks = vi.hoisted(() => ({
  course: {
    findMany: vi.fn(),
    findUnique: vi.fn()
  },
  $disconnect: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => dbServiceMocks);
vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import {
  executeCourseProfileCommand,
  parseCourseProfileCommand
} from "../../../scripts/automation/course-profile";

describe("automation:course-profile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("supports generic profile verification and dry-run profile updates", () => {
    expect(parseCourseProfileCommand(["verify-profiles", "--state", "ct"])).toEqual({
      action: "verify-profiles",
      stateCode: "CT"
    });
    expect(parseCourseProfileCommand(["alias", "--course-id", "course-1", "--slug", "retired-course-url"])).toEqual({
      action: "alias",
      courseId: "course-1",
      slug: "retired-course-url",
      apply: false
    });
    expect(parseCourseProfileCommand([
      "booking-window",
      "--course-id", "course-1",
      "--days-ahead", "7",
      "--release-time", "5:30am",
      "--evidence-url", "https://example.com/booking-policy"
    ])).toEqual({
      action: "booking-window",
      courseId: "course-1",
      daysAhead: 7,
      releaseTimeLocal: "05:30",
      evidenceUrl: "https://example.com/booking-policy",
      apply: false
    });
  });

  it("rejects invalid booking-window facts before touching the database", () => {
    expect(() => parseCourseProfileCommand([
      "booking-window",
      "--course-id", "course-1",
      "--days-ahead", "100",
      "--evidence-url", "https://example.com/policy"
    ])).toThrow("--days-ahead must be an integer");
    expect(() => parseCourseProfileCommand([
      "booking-window",
      "--course-id", "course-1",
      "--days-ahead", "7",
      "--release-time", "25:00",
      "--evidence-url", "https://example.com/policy"
    ])).toThrow("--release-time must be a valid course-local time");
  });

  it("requires a state for generic profile verification", () => {
    expect(() => parseCourseProfileCommand(["verify-profiles"])).toThrow(
      "verify-profiles requires a two-letter --state"
    );
  });

  it("applies booking-window facts through monitoring-aware persistence", async () => {
    const current = {
      id: "course-1",
      name: "Example Golf Course",
      bookingWindowDaysAhead: 7,
      bookingReleaseTimeLocal: "07:00",
      bookingWindowSource: "OFFICIAL_BOOKING_PAGE",
      bookingWindowConfidence: 0.8,
      bookingWindowEvidenceUrl: "https://example.com/old-policy",
      bookingWindowCheckedAt: new Date("2026-08-01T12:00:00.000Z"),
      bookingWindowObservedAt: new Date("2026-08-01T12:00:00.000Z")
    };
    const updated = {
      ...current,
      bookingWindowDaysAhead: 14,
      bookingReleaseTimeLocal: "06:30",
      bookingWindowConfidence: 1,
      bookingWindowEvidenceUrl: "https://example.com/booking-policy"
    };
    prismaMocks.course.findUnique.mockResolvedValue(current);
    dbServiceMocks.recordCourseBookingWindowEvidence.mockResolvedValue(updated);

    const result = await executeCourseProfileCommand(
      parseCourseProfileCommand([
        "booking-window",
        "--course-id", "course-1",
        "--days-ahead", "14",
        "--release-time", "06:30",
        "--evidence-url", "https://example.com/booking-policy",
        "--apply"
      ])
    );

    expect(result).toEqual({ apply: true, course: updated });
    expect(dbServiceMocks.recordCourseBookingWindowEvidence).toHaveBeenCalledWith({
      courseId: "course-1",
      evidence: {
        daysAhead: 14,
        releaseTimeLocal: "06:30",
        source: "OFFICIAL_BOOKING_PAGE",
        confidence: 1,
        evidenceUrl: "https://example.com/booking-policy"
      },
      observedAt: expect.any(Date),
      source: "OPERATOR_CLI"
    });
  });
});
