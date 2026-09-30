import { describe, expect, it } from "vitest";

import {
  getDashboardAlertSummary,
  getDashboardCourseStatus,
  type DashboardCourseStatus
} from "./dashboard-alert-summary";
import type { DashboardMonitoringVerdictInput } from "./dashboard-monitoring-verdict";

const checkedAt = new Date("2026-09-30T06:30:00.000Z");
type Outcome = NonNullable<DashboardMonitoringVerdictInput["latestProbe"]>["outcome"];

function courseStatus(
  outcome?: Outcome,
  availability: Partial<Parameters<typeof getDashboardCourseStatus>[0]["availability"]> = {},
  monitoring: Partial<DashboardMonitoringVerdictInput> = {}
) {
  return getDashboardCourseStatus({
    availability: {
      alertStatus: "ACTIVE",
      outcome,
      qualifyingMatchCount: 0,
      players: 2,
      startTime: "10:00",
      endTime: "14:00",
      ...availability
    },
    monitoring: {
      alertStatus: availability.alertStatus ?? "ACTIVE",
      alertSupport: null,
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      latestProbe: outcome ? { outcome, observedAt: checkedAt } : undefined,
      upcomingBookingWindow: null,
      firstTimeLookup: false,
      ...monitoring
    }
  });
}

function summary(
  courseStatuses: DashboardCourseStatus[],
  qualifyingMatchCount = 0,
  alertStatus = "ACTIVE"
) {
  return getDashboardAlertSummary({ courseStatuses, qualifyingMatchCount, alertStatus });
}

describe("dashboard alert summary", () => {
  it("describes an observed public time before the saved window without implying a match", () => {
    const status = courseStatus("NO_MATCH", {
      rawSummary: {
        visibleSlotCount: 1,
        playerEligibleSlotCount: 1,
        closestBefore: "2026-10-01T07:50:00"
      }
    });
    const result = summary([status]);

    expect(result).toEqual({
      lifecycleLabel: "Active",
      headline: "Available outside your window",
      coverageNotice: null
    });
    expect(status.detail).toContain("none fall between 10:00 AM and 2:00 PM");
    expect(status.detail).toContain("7:50 AM");
    expect(result.headline).not.toMatch(/matching time|found in the latest check/);
  });

  it("distinguishes public inventory without enough spots for the saved group", () => {
    const status = courseStatus("NO_MATCH", {
      rawSummary: { visibleSlotCount: 3, playerEligibleSlotCount: 0 }
    });

    expect(summary([status]).headline).toBe("No tee times fit your group");
    expect(status.detail).toContain("none currently fit 2 golfers");
  });

  it("retains a successful empty tee sheet as an observed zero result", () => {
    expect(summary([courseStatus("NO_MATCH", {
      rawSummary: { visibleSlotCount: 0, playerEligibleSlotCount: 0 }
    })]).headline).toBe("No public times listed");
  });

  it("shows the direct-action disposition even when the latest probe is unsupported", () => {
    const status = courseStatus("NEEDS_ADAPTER", {}, {
      alertSupport: "DIRECT_ONLINE",
      monitoringState: "FINAL_MANUAL"
    });

    expect(summary([status])).toEqual({
      lifecycleLabel: "Active",
      headline: "Check the official booking page",
      coverageNotice: null
    });
    expect(status.detail).not.toMatch(/keep trying|no matching times|checked successfully/i);
  });

  it.each(["NEEDS_ADAPTER", "FETCH_FAILED", "BLOCKED_TOOLING"] as const)(
    "does not describe %s as an empty successful check or trust its slot counters",
    (outcome) => {
      const status = courseStatus(outcome, {
        rawSummary: { visibleSlotCount: 9, playerEligibleSlotCount: 9 }
      }, { monitoringState: "HEALTHY" });

      expect(summary([status]).headline).toBe("Automatic checks are still retrying");
      expect(status.hasCurrentPublicInventory).toBe(false);
      expect(summary([status]).lifecycleLabel).toBe("Active");
      expect(summary([status]).headline).not.toMatch(/no matching times|outside your window/i);
    }
  );

  it("keeps proven manual review distinct from retrying or successful emptiness", () => {
    const status = courseStatus("NEEDS_ADAPTER", {}, {
      supportIncidentStatus: "NEEDS_HUMAN",
      automationPlaybookExhausted: true
    });

    expect(summary([status]).headline).toBe("Manual review needed");
  });

  it("keeps a future booking release distinct from a completed availability check", () => {
    const status = courseStatus("NO_MATCH", {
      bookingOpensLabel: "tomorrow at 7 AM"
    }, { upcomingBookingWindow: { opensAt: "later" } });

    expect(summary([status]).headline).toBe("Checks start when booking opens");
    expect(status.tone).toBe("scheduled");
  });

  it("keeps confirmed matches first while disclosing partial unavailable and pending coverage", () => {
    const matched = courseStatus("MATCH_FOUND", { qualifyingMatchCount: 2 });
    const failed = courseStatus("FETCH_FAILED");
    const pending = courseStatus();
    const result = summary([matched, failed, pending], 2);

    expect(result.headline).toBe("2 matching times now");
    expect(result.coverageNotice).toContain("Availability not confirmed for 1 course");
    expect(result.coverageNotice).toContain("1 course awaiting a check");
  });

  it("does not turn one healthy no-match result into complete multi-course coverage", () => {
    const empty = courseStatus("NO_MATCH");
    const failed = courseStatus("NEEDS_ADAPTER");
    const pending = courseStatus();
    const result = summary([empty, failed, pending]);

    expect(result.headline).toBe("Some course availability is not confirmed");
    expect(result.coverageNotice).toContain("Availability not confirmed for 1 course");
    expect(result.coverageNotice).toContain("1 course awaiting a check");
    expect(result.headline).not.toContain("No matching times");
  });

  it("keeps multi-course public inventory separate from qualifying matches", () => {
    const outside = courseStatus("NO_MATCH", {
      rawSummary: { visibleSlotCount: 1, playerEligibleSlotCount: 1 }
    });
    expect(summary([outside, courseStatus("NO_MATCH")]).headline)
      .toBe("Other tee times listed; none match your request");
  });

  it("does not promote historical match evidence or malformed counters to current inventory", () => {
    const historical = courseStatus("MATCH_FOUND", {
      rawSummary: { visibleSlotCount: 4, playerEligibleSlotCount: 4 }
    });
    const malformed = courseStatus("NO_MATCH", {
      rawSummary: { visibleSlotCount: 4 }
    });

    expect(historical.hasCurrentPublicInventory).toBe(false);
    expect(malformed.hasCurrentPublicInventory).toBe(false);
    expect(summary([historical, malformed]).headline).toBe("No current matches confirmed");
  });

  it("explains pending and scheduled portions of multi-course coverage", () => {
    const scheduled = courseStatus(undefined, {
      bookingOpensLabel: "tomorrow at 7 AM"
    }, { upcomingBookingWindow: { opensAt: "later" } });
    const result = summary([courseStatus(), scheduled]);

    expect(result.headline).toBe("Some course availability is not confirmed");
    expect(result.coverageNotice).toContain("1 course awaiting a check");
    expect(result.coverageNotice).toContain("1 course open for booking later");
    expect(summary([scheduled, scheduled]).headline).toBe("Booking not open yet");
    expect(summary([courseStatus("NO_MATCH"), scheduled]).headline)
      .toBe("No matching times; some courses open later");
  });

  it.each(["PAUSED", "COMPLETED", "CANCELLED"])(
    "retains emailed match history on a %s alert without calling it current availability",
    (alertStatus) => {
      const matched = courseStatus("MATCH_FOUND", {
        alertStatus,
        qualifyingMatchCount: 1
      });
      const result = summary([matched], 1, alertStatus);

      expect(result.lifecycleLabel).toBe(alertStatus);
      expect(result.headline).toBe("1 matching time at last check");
      expect(result.coverageNotice).toBeNull();
      expect(matched.label).toBe("1 matching time at last check");
      expect(matched.detail).toContain("At the last check");
      expect(matched.detail).toContain("Current availability has not been rechecked");
      expect(matched.detail).not.toMatch(/remains active|keep checking|fits your/);
    }
  );

  it.each(["PAUSED", "COMPLETED", "CANCELLED"])(
    "does not promise pending checks for an inactive %s alert",
    (alertStatus) => {
      const failed = courseStatus("FETCH_FAILED", { alertStatus });
      const result = summary([failed], 0, alertStatus);

      expect(result.headline).toBe("No current check for these settings");
      expect(result.coverageNotice).toBeNull();
      expect(result.headline).not.toMatch(/now|waiting|watching|retrying/i);
    }
  );
});
