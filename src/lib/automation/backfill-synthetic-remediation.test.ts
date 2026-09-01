import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  teeSearch: { findMany: vi.fn() },
  $disconnect: vi.fn(),
}));

const supportIncidentMocks = vi.hoisted(() => ({
  reportCourseSupportIssue: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/automation/support-incidents", () => supportIncidentMocks);

import { backfillSyntheticRemediation } from "../../../scripts/automation/backfill-synthetic-remediation";

describe("synthetic remediation backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:10:00.000Z"));
    supportIncidentMocks.reportCourseSupportIssue.mockResolvedValue({
      status: "AUTO_INVESTIGATING",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the selected probe source instead of backfill receipt time", async () => {
    const failureObservedAt = new Date("2026-07-15T12:00:00.000Z");
    const independentSuccessObservedAt = new Date("2026-07-15T12:05:00.000Z");
    const backfillReceiptAt = new Date("2026-07-15T12:10:00.000Z");
    prismaMocks.teeSearch.findMany.mockResolvedValue([
      {
        id: "search-1",
        preferences: [
          {
            course: {
              id: "course-1",
              name: "Public Course",
              timeZone: "America/New_York",
              detectedPlatform: "CUSTOM",
              detectedBookingUrl: "https://booking.example/tee-times",
              website: "https://course.example",
            },
          },
        ],
        probes: [
          {
            courseId: "course-1",
            outcome: "FETCH_FAILED",
            observedAt: failureObservedAt,
            message: "The provider read failed.",
          },
        ],
      },
    ]);

    await expect(
      backfillSyntheticRemediation({
        emailTag: "+causal-backfill-",
        apply: true,
      }),
    ).resolves.toMatchObject({
      mode: "apply",
      distinctCourses: 1,
      incidentStates: { AUTO_INVESTIGATING: 1 },
    });

    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        course: expect.objectContaining({ id: "course-1" }),
        failureObservedAt,
        now: backfillReceiptAt,
      }),
    );
    const issue =
      supportIncidentMocks.reportCourseSupportIssue.mock.calls.at(-1)?.[0];
    expect(issue).not.toHaveProperty("providerObservedAt");
    expect(failureObservedAt.getTime()).toBeLessThan(
      independentSuccessObservedAt.getTime(),
    );
    expect(independentSuccessObservedAt.getTime()).toBeLessThan(
      backfillReceiptAt.getTime(),
    );
  });
});
