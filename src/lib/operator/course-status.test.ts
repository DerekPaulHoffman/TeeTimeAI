import { describe, expect, it } from "vitest";

import {
  buildCourseInventory,
  filterCourseInventory,
  summarizeCourseInventory,
  type CourseStatusInput
} from "./course-status";

const NOW = new Date("2026-07-24T18:00:00.000Z");

describe("operator course inventory", () => {
  it("puts active real-demand failures before healthy courses", () => {
    const inventory = buildCourseInventory(
      [
        course({
          id: "working",
          name: "Working Municipal",
          coverageCategory: "MONITORED",
          latestProbe: probe("NO_MATCH", "2026-07-24T17:30:00.000Z")
        }),
        course({
          id: "broken",
          name: "Broken Links Golf",
          activeAlertCount: 2,
          incident: {
            id: "incident-1",
            status: "AUTO_INVESTIGATING",
            kind: "FETCH_FAILED",
            activeRealSearchCount: 2,
            firstSeenAt: new Date("2026-07-24T12:00:00.000Z"),
            latestMessage: "The booking page returned 404.",
            nextAction: "Repair the exact booking link.",
            failureClass: "NOT_FOUND"
          }
        })
      ],
      NOW
    );

    expect(inventory.map((item) => item.id)).toEqual(["broken", "working"]);
    expect(inventory[0]).toMatchObject({
      statusKey: "SITE_FAILED",
      priorityGroup: "ACTION",
      recommendedAction: "Repair the exact booking link."
    });
    expect(inventory[1]).toMatchObject({
      statusKey: "WORKING_NO_MATCH",
      priorityGroup: "WORKING"
    });
  });

  it("explains that no match is a successful monitor result", () => {
    const [result] = buildCourseInventory(
      [
        course({
          coverageCategory: "MONITORED",
          latestProbe: probe("NO_MATCH", "2026-07-24T17:30:00.000Z")
        })
      ],
      NOW
    );

    expect(result.statusLabel).toBe("Working · no match");
    expect(result.statusMeaning).toContain("successfully read the course");
  });

  it("marks successful active monitoring stale after 24 hours", () => {
    const [result] = buildCourseInventory(
      [
        course({
          activeAlertCount: 1,
          coverageCategory: "MONITORED",
          latestProbe: probe("MATCH_FOUND", "2026-07-23T16:00:00.000Z")
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusKey: "STALE",
      priorityGroup: "ACTION",
      tone: "critical"
    });
  });

  it("treats legacy policy-only blocks as review work", () => {
    const [result] = buildCourseInventory(
      [
        course({
          coverageCategory: "SUPPORTED_DEGRADED",
          latestProbe: probe("BLOCKED_POLICY", "2026-07-24T17:30:00.000Z")
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusKey: "REVIEW_REQUIRED",
      priorityGroup: "WATCH"
    });
  });

  it("filters by operational group and searchable course facts", () => {
    const inventory = buildCourseInventory(
      [
        course({
          id: "foreup",
          name: "Pine Valley Municipal",
          providerFamilyKey: "FOREUP",
          coverageCategory: "MONITORED",
          latestProbe: probe("NO_MATCH", "2026-07-24T17:30:00.000Z")
        }),
        course({
          id: "missing",
          name: "Unknown Links",
          providerFamilyKey: "SOURCE_MISSING",
          coverageCategory: "SOURCE_UNVERIFIED",
          detectedBookingUrl: null
        })
      ],
      NOW
    );

    expect(
      filterCourseInventory(inventory, {
        view: "working",
        query: "foreup"
      }).map((item) => item.id)
    ).toEqual(["foreup"]);
    expect(summarizeCourseInventory(inventory)).toMatchObject({
      watch: 1,
      working: 1
    });
  });

  it("uses canonical coverage evidence for restored and final courses", () => {
    const inventory = buildCourseInventory(
      [
        course({
          id: "restored",
          coverageCategory: "MONITORED",
          latestProbe: probe("FETCH_FAILED", "2026-07-24T17:30:00.000Z")
        }),
        course({
          id: "manual",
          coverageCategory: "PHONE_OR_WALK_IN",
          bookingMethod: "CONTACT_COURSE"
        }),
        course({
          id: "private",
          coverageCategory: "PRIVATE_OR_INVALID"
        })
      ],
      NOW
    );

    expect(summarizeCourseInventory(inventory)).toMatchObject({
      limitations: 2,
      working: 1
    });
    expect(inventory.find((item) => item.id === "restored")).toMatchObject({
      statusKey: "MONITORING_RESTORED",
      priorityGroup: "WORKING"
    });
  });
});

function course(
  overrides: Partial<CourseStatusInput> = {}
): CourseStatusInput {
  return {
    id: "course-1",
    name: "Example Golf Course",
    providerFamilyKey: "FOREUP",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    bookingAccessMode: "PUBLIC_SIGNED_OUT",
    bookingMethod: "PUBLIC_ONLINE",
    detectedBookingUrl: "https://book.example.com/",
    website: "https://example.com/",
    activeAlertCount: 0,
    selectionCount: 0,
    incident: null,
    latestProbe: null,
    profileSlug: null,
    coverageCategory: "SUPPORTED_READY",
    ...overrides
  };
}

function probe(outcome: string, observedAt: string) {
  return {
    outcome,
    observedAt: new Date(observedAt),
    message: null,
    evidenceUrl: null
  };
}
