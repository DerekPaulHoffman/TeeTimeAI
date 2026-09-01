import { beforeEach, describe, expect, it, vi } from "vitest";

const dbServiceMocks = vi.hoisted(() => ({
  recordCourseBookingWindowEvidence: vi.fn(),
  recordCoursePhysicalLayoutEvidence: vi.fn()
}));
const prismaMocks = vi.hoisted(() => ({
  course: {
    findMany: vi.fn(),
    findUnique: vi.fn()
  },
  $disconnect: vi.fn()
}));
const providerObservationMocks = vi.hoisted(() => ({
  beginCourseProviderObservation: vi.fn(),
  markCourseProviderObservationUnreconciled: vi.fn(),
  releaseCourseProviderObservation: vi.fn(),
  startCourseProviderObservationHeartbeat: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => dbServiceMocks);
vi.mock(
  "@/lib/automation/provider-execution-marker",
  () => providerObservationMocks
);
vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import {
  executeCourseProfileCommand,
  parseCourseProfileCommand
} from "../../../scripts/automation/course-profile";

describe("automation:course-profile", () => {
  const providerObservation = {
    courseId: "aguila",
    leaseToken: "physical-layout-observation",
    observationStartedAt: new Date("2026-08-18T15:00:00.000Z"),
    leaseExpiresAt: new Date("2026-08-18T15:20:00.000Z"),
    ttlMs: 20 * 60_000,
    supersededUnresolvedObservationStartedAt: null
  };
  const heartbeat = {
    assertOwned: vi.fn(),
    stop: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    providerObservationMocks.beginCourseProviderObservation.mockResolvedValue(
      providerObservation
    );
    providerObservationMocks.markCourseProviderObservationUnreconciled.mockResolvedValue(
      true
    );
    providerObservationMocks.releaseCourseProviderObservation.mockResolvedValue(
      undefined
    );
    providerObservationMocks.startCourseProviderObservationHeartbeat.mockReturnValue(
      heartbeat
    );
    heartbeat.stop.mockResolvedValue(undefined);
  });

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
    expect(parseCourseProfileCommand([
      "physical-layout",
      "--course-id", "course-1",
      "--holes", "18",
      "--evidence-url", "https://parks.example/aguila-golf-course.html",
      "--verified-at", "2026-08-18"
    ])).toEqual({
      action: "physical-layout",
      courseId: "course-1",
      holeCounts: [18],
      evidenceUrl: "https://parks.example/aguila-golf-course.html",
      verifiedAt: new Date("2026-08-18T00:00:00.000Z"),
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

  it("rejects invalid physical-layout evidence before touching the database", () => {
    expect(() => parseCourseProfileCommand([
      "physical-layout",
      "--course-id", "course-1",
      "--holes", "9,27",
      "--evidence-url", "https://parks.example/aguila",
      "--verified-at", "2026-08-18"
    ])).toThrow("--holes must contain unique 9 and/or 18 values");
    expect(() => parseCourseProfileCommand([
      "physical-layout",
      "--course-id", "course-1",
      "--holes", "18",
      "--evidence-url", "https://user:secret@parks.example/aguila",
      "--verified-at", "2026-08-18"
    ])).toThrow("--evidence-url must be an HTTP(S) URL");
    expect(() => parseCourseProfileCommand([
      "physical-layout",
      "--course-id", "course-1",
      "--holes", "18",
      "--evidence-url", "https://parks.example/aguila",
      "--verified-at", "2026-02-30"
    ])).toThrow("--verified-at must be a calendar date");
    expect(() => parseCourseProfileCommand([
      "physical-layout",
      "--course-id", "course-1",
      "--holes", "18",
      "--evidence-url", "https://parks.example/aguila",
      "--verified-at", "2999-01-01"
    ])).toThrow("--verified-at cannot be in the future");
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

  it("applies physical-layout facts through serialized monitoring-aware persistence", async () => {
    const expectedUpdatedAt = new Date("2026-08-18T14:00:00.000Z");
    const current = {
      id: "aguila",
      name: "Aguila Golf Course",
      layoutHoleCounts: [],
      layoutHolesEvidenceUrl: null,
      layoutHolesVerifiedAt: null,
      updatedAt: expectedUpdatedAt
    };
    const updated = {
      ...current,
      layoutHoleCounts: [18],
      layoutHolesEvidenceUrl:
        "https://www.phoenix.gov/parks/golf/aguila-golf-course.html",
      layoutHolesVerifiedAt: new Date("2026-08-18T00:00:00.000Z")
    };
    prismaMocks.course.findUnique.mockResolvedValue(current);
    dbServiceMocks.recordCoursePhysicalLayoutEvidence.mockResolvedValue(updated);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        "<html><title>Aguila 18 Golf Course | Phoenix Golf Courses</title><h1>Aguila 18 Golf Course</h1></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      )
    );

    const result = await executeCourseProfileCommand(
      parseCourseProfileCommand([
        "physical-layout",
        "--course-id", "aguila",
        "--holes", "18",
        "--evidence-url",
        "https://www.phoenix.gov/parks/golf/aguila-golf-course.html",
        "--verified-at", "2026-08-18",
        "--apply"
      ]),
      process.stdin,
      fetchImpl as typeof fetch
    );

    expect(result).toEqual({
      apply: true,
      course: {
        id: updated.id,
        name: updated.name,
        layoutHoleCounts: updated.layoutHoleCounts,
        layoutHolesEvidenceUrl: updated.layoutHolesEvidenceUrl,
        layoutHolesVerifiedAt: updated.layoutHolesVerifiedAt
      }
    });
    expect(dbServiceMocks.recordCoursePhysicalLayoutEvidence).toHaveBeenCalledWith({
      courseId: "aguila",
      holeCounts: [18],
      evidenceUrl:
        "https://www.phoenix.gov/parks/golf/aguila-golf-course.html",
      verifiedAt: new Date("2026-08-18T00:00:00.000Z"),
      expectedUpdatedAt,
      expectedName: "Aguila Golf Course",
      providerObservation,
      source: "OPERATOR_CLI"
    });
    expect(providerObservationMocks.beginCourseProviderObservation).toHaveBeenCalledWith({
      courseId: "aguila"
    });
    expect(heartbeat.assertOwned).toHaveBeenCalledOnce();
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled
    ).toHaveBeenCalledWith(
      providerObservation
    );
    expect(providerObservationMocks.releaseCourseProviderObservation).not.toHaveBeenCalled();
  });

  it("does not fetch physical-layout evidence while another provider observation owns the course", async () => {
    const expectedUpdatedAt = new Date("2026-08-18T14:00:00.000Z");
    prismaMocks.course.findUnique.mockResolvedValue({
      id: "aguila",
      name: "Aguila Golf Course",
      layoutHoleCounts: [],
      layoutHolesEvidenceUrl: null,
      layoutHolesVerifiedAt: null,
      updatedAt: expectedUpdatedAt
    });
    providerObservationMocks.beginCourseProviderObservation.mockResolvedValue(null);
    const fetchImpl = vi.fn();

    await expect(
      executeCourseProfileCommand(
        parseCourseProfileCommand([
          "physical-layout",
          "--course-id", "aguila",
          "--holes", "18",
          "--evidence-url", "https://parks.example/aguila-golf-course.html",
          "--verified-at", "2026-08-18",
          "--apply"
        ]),
        process.stdin,
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("Another provider observation is already in progress");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbServiceMocks.recordCoursePhysicalLayoutEvidence).not.toHaveBeenCalled();
  });

  it("retains the provider observation when fetched physical-layout evidence is not reconciled", async () => {
    const expectedUpdatedAt = new Date("2026-08-18T14:00:00.000Z");
    prismaMocks.course.findUnique.mockResolvedValue({
      id: "aguila",
      name: "Aguila Golf Course",
      layoutHoleCounts: [],
      layoutHolesEvidenceUrl: null,
      layoutHolesVerifiedAt: null,
      updatedAt: expectedUpdatedAt
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        "<html><title>A Different Course</title><h1>A Different Course</h1></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      )
    );

    await expect(
      executeCourseProfileCommand(
        parseCourseProfileCommand([
          "physical-layout",
          "--course-id", "aguila",
          "--holes", "18",
          "--evidence-url", "https://parks.example/aguila-golf-course.html",
          "--verified-at", "2026-08-18",
          "--apply"
        ]),
        process.stdin,
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("does not corroborate the exact course");

    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled
    ).toHaveBeenCalledWith(providerObservation);
    expect(providerObservationMocks.releaseCourseProviderObservation).not.toHaveBeenCalled();
    expect(dbServiceMocks.recordCoursePhysicalLayoutEvidence).not.toHaveBeenCalled();
  });

  it("requires exact page-local course and layout corroboration even for dry-run", async () => {
    prismaMocks.course.findUnique.mockResolvedValue({
      id: "aguila",
      name: "Aguila Golf Course",
      layoutHoleCounts: [],
      layoutHolesEvidenceUrl: null,
      layoutHolesVerifiedAt: null
    });
    const siblingFetch = vi.fn().mockResolvedValue(
      new Response(
        "<html><title>Aguila 18 Golf Course | Aguila 9</title><h1>Aguila 18 Golf Course</h1></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      )
    );

    await expect(
      executeCourseProfileCommand(
        parseCourseProfileCommand([
          "physical-layout",
          "--course-id", "aguila",
          "--holes", "18",
          "--evidence-url", "https://parks.example/aguila-golf-course.html",
          "--verified-at", "2026-08-18"
        ]),
        process.stdin,
        siblingFetch as typeof fetch
      )
    ).rejects.toThrow("does not corroborate the exact course");
    expect(dbServiceMocks.recordCoursePhysicalLayoutEvidence).not.toHaveBeenCalled();
    expect(providerObservationMocks.beginCourseProviderObservation).not.toHaveBeenCalled();
  });

  it("never follows a physical-layout evidence redirect to an account route", async () => {
    prismaMocks.course.findUnique.mockResolvedValue({
      id: "aguila",
      name: "Aguila Golf Course",
      layoutHoleCounts: [],
      layoutHolesEvidenceUrl: null,
      layoutHolesVerifiedAt: null
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://accounts.example/sign-in" }
      })
    );

    await expect(
      executeCourseProfileCommand(
        parseCourseProfileCommand([
          "physical-layout",
          "--course-id", "aguila",
          "--holes", "18",
          "--evidence-url", "https://parks.example/aguila-golf-course.html",
          "--verified-at", "2026-08-18"
        ]),
        process.stdin,
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("--evidence-url must be an HTTP(S) URL");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
