import { describe, expect, it } from "vitest";

import {
  buildCourseInventory,
  filterCourseInventory,
  getCourseSummaryCopy,
  listCourseStates,
  parseCourseDiagnosticFilter,
  parseCourseStateFilter,
  summarizeCourseDiagnostics,
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

  it("puts active-alert investigations before inactive engineering review", () => {
    const inventory = buildCourseInventory(
      [
        course({
          id: "human-review",
          name: "A Human Review Course",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED")
        }),
        course({
          id: "live-investigation",
          name: "Z Live Investigation Course",
          activeAlertCount: 1,
          monitoringStatus: monitoringStatus("AUTO_INVESTIGATING")
        })
      ],
      NOW
    );

    expect(inventory.map((item) => item.id)).toEqual(["live-investigation", "human-review"]);
  });

  it("puts real demand first and live synthetic journey failures next", () => {
    const inventory = buildCourseInventory(
      [
        course({
          id: "inactive-review",
          name: "A Inactive Review",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED")
        }),
        course({
          id: "synthetic-live",
          name: "B Synthetic Live",
          activeSyntheticAlertCount: 1,
          incident: {
            id: "incident-synthetic",
            status: "AUTO_INVESTIGATING",
            kind: "FETCH_FAILED",
            activeRealSearchCount: 0,
            engineeringOnly: true,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage:
              "The first-failure verification window ended without enough independent observations.",
            nextAction: "Repair the verification path and retry.",
            failureClass: "HTTP_5XX"
          }
        }),
        course({
          id: "real-live",
          name: "C Real Live",
          activeAlertCount: 1,
          incident: {
            id: "incident-real",
            status: "AUTO_INVESTIGATING",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 1,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage: "No public booking surface is currently available.",
            nextAction: "Find a public read-only source.",
            failureClass: "UNSUPPORTED_FAMILY"
          }
        })
      ],
      NOW
    );

    expect(inventory.map((item) => item.id)).toEqual([
      "real-live",
      "synthetic-live",
      "inactive-review"
    ]);
    expect(inventory[1]).toMatchObject({
      priorityGroup: "ACTION",
      problemSummary:
        "The verification run did not collect enough independent checks to confirm whether monitoring works."
    });
  });

  it("turns durable provider evidence into a concise operator problem", () => {
    const [result] = buildCourseInventory(
      [
        course({
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: {
            id: "incident-lake",
            status: "NEEDS_HUMAN",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            engineeringOnly: true,
            firstSeenAt: new Date("2026-07-22T01:00:00.000Z"),
            latestMessage:
              "A bounded signed-out attempt confirmed the provider landing returned HTTP 403 and exposed no trustworthy public availability contract.",
            nextAction: "Review a signed-out public capture.",
            failureClass: "UNSUPPORTED_FAMILY",
            attemptCount: 3
          }
        })
      ],
      NOW
    );

    expect(result.problemSummary).toBe(
      "The official booking page returned HTTP 403, and no verified public tee-time feed was found."
    );
    expect(result.recommendedAction).toContain("check the official course surface again");
  });

  it("uses a needs-human incident over a stale auto-investigating lifecycle row", () => {
    const [result] = buildCourseInventory(
      [
        course({
          monitoringStatus: monitoringStatus("AUTO_INVESTIGATING"),
          incident: {
            id: "incident-human",
            status: "NEEDS_HUMAN",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-22T01:00:00.000Z"),
            latestMessage: "The bounded automated investigation finished.",
            nextAction: "Automation will keep investigating this course.",
            failureClass: "UNSUPPORTED_FAMILY"
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusLabel: "Engineering verification needed",
      automationQueueState: "NEEDS_HUMAN",
      priorityGroup: "ACTION"
    });
    expect(result.recommendedAction).not.toContain("keep investigating");
  });

  it("uses a restored incident over a stale auto-investigating lifecycle row", () => {
    const [result] = buildCourseInventory(
      [
        course({
          monitoringStatus: monitoringStatus("AUTO_INVESTIGATING"),
          incident: {
            id: "incident-restored",
            status: "RESOLVED",
            resolution: "MONITORING_RESTORED",
            kind: "FETCH_FAILED",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-22T01:00:00.000Z"),
            latestMessage: "Fresh runtime verification succeeded.",
            nextAction: null,
            failureClass: "HTTP_5XX"
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusKey: "MONITORING_RESTORED",
      priorityGroup: "WORKING",
      automationQueueState: null
    });
  });

  it("shows a resolved direct-course outcome as a known limitation", () => {
    const [result] = buildCourseInventory(
      [
        course({
          monitoringStatus: monitoringStatus("AUTO_INVESTIGATING"),
          incident: {
            id: "incident-manual",
            status: "RESOLVED",
            resolution: "DIRECT_BOOKING_CLASSIFIED",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-22T01:00:00.000Z"),
            latestMessage: "The course accepts direct contact only.",
            nextAction: null,
            failureClass: "MISSING_SOURCE"
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusKey: "DIRECT_SITE_ONLY",
      statusLabel: "Known direct-booking limitation",
      priorityGroup: "LIMITATION",
      automationQueueState: null
    });
  });

  it("shows an operator-classified private course as a final identity", () => {
    const [result] = buildCourseInventory(
      [
        course({
          monitoringStatus: monitoringStatus("AUTO_INVESTIGATING"),
          incident: {
            id: "incident-private",
            status: "RESOLVED",
            resolution: "IDENTITY_CLASSIFIED",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-22T01:00:00.000Z"),
            latestMessage: "This is a private course.",
            nextAction: null,
            failureClass: "MISSING_SOURCE"
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusKey: "PRIVATE_OR_INVALID",
      statusLabel: "Private course",
      priorityGroup: "LIMITATION",
      automationQueueState: null
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

  it("filters fix-now and investigate separately by state, address, and issue", () => {
    const inventory = buildCourseInventory(
      [
        course({
          id: "urgent",
          name: "Urgent Municipal",
          address: "10 Main Street, Hartford, CT 06103",
          city: "Hartford",
          stateCode: "CT",
          activeAlertCount: 2,
          coverageCategory: "SOURCE_UNVERIFIED",
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null
        }),
        course({
          id: "investigate",
          name: "Research Links",
          address: "20 Ocean Avenue, Warwick, RI 02889",
          city: "Warwick",
          stateCode: "RI",
          coverageCategory: "UNSUPPORTED_FAMILY",
          automationReason: "UNSUPPORTED_PLATFORM"
        }),
        course({
          id: "limitation",
          name: "Phone Only Golf",
          address: "30 Shore Road, Warwick, RI 02889",
          city: "Warwick",
          stateCode: "RI",
          coverageCategory: "PHONE_OR_WALK_IN",
          bookingMethod: "PHONE_ONLY",
          detectedBookingUrl: null
        })
      ],
      NOW
    );

    expect(
      filterCourseInventory(inventory, {
        view: "fix-now",
        state: "ct",
        diagnostic: "source_missing",
        query: "main street"
      }).map((item) => item.id)
    ).toEqual(["urgent"]);
    expect(
      filterCourseInventory(inventory, {
        view: "investigate",
        state: "RI"
      }).map((item) => item.id)
    ).toEqual(["investigate"]);
    expect(
      filterCourseInventory(inventory, {
        view: "limitations",
        diagnostic: "NO_PUBLIC_ONLINE"
      }).map((item) => item.id)
    ).toEqual(["limitation"]);
  });

  it("ranks issue subcategories by size and lists state totals", () => {
    const inventory = buildCourseInventory(
      [
        course({
          id: "missing-1",
          stateCode: "CT",
          coverageCategory: "SOURCE_UNVERIFIED",
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null
        }),
        course({
          id: "missing-2",
          stateCode: "CT",
          coverageCategory: "SOURCE_UNVERIFIED",
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null
        }),
        course({
          id: "adapter",
          stateCode: "RI",
          coverageCategory: "UNSUPPORTED_FAMILY"
        })
      ],
      NOW
    );

    const investigate = summarizeCourseDiagnostics(inventory).find(
      (group) => group.key === "WATCH"
    );
    expect(investigate).toMatchObject({
      label: "Investigate next",
      count: 3,
      subcategories: [
        { key: "SOURCE_MISSING", count: 2 },
        { key: "NEEDS_ADAPTER", count: 1 }
      ]
    });
    expect(listCourseStates(inventory)).toEqual([
      { stateCode: "CT", count: 2 },
      { stateCode: "RI", count: 1 }
    ]);
    expect(parseCourseStateFilter("Connecticut")).toBe("all");
    expect(parseCourseDiagnosticFilter("not-a-status")).toBe("all");
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

  it("separates reader-ready, reader-verified, and reader-candidate courses", () => {
    const inventory = buildCourseInventory(
      [
        course({
          id: "ready",
          coverageCategory: "TECHNICAL_CONSTRAINT",
          bookingAccessMode: "CAPTCHA_OR_QUEUE",
          localReaderSupported: true
        }),
        course({
          id: "verified",
          coverageCategory: "TECHNICAL_CONSTRAINT",
          bookingAccessMode: "CAPTCHA_OR_QUEUE",
          localReaderSupported: true,
          localReaderVerifiedAt: new Date("2026-07-24T17:45:00.000Z"),
          localReaderVersion: "chronogolf-rendered-v1"
        }),
        course({
          id: "candidate",
          coverageCategory: "TECHNICAL_CONSTRAINT",
          bookingAccessMode: "CAPTCHA_OR_QUEUE",
          localReaderCandidate: true
        })
      ],
      NOW
    );

    expect(inventory.find((item) => item.id === "ready")).toMatchObject({
      statusKey: "LOCAL_READER_READY",
      priorityGroup: "UNCHECKED"
    });
    expect(inventory.find((item) => item.id === "verified")).toMatchObject({
      statusKey: "LOCAL_READER_VERIFIED",
      priorityGroup: "WORKING"
    });
    expect(inventory.find((item) => item.id === "candidate")).toMatchObject({
      statusKey: "READER_CANDIDATE",
      priorityGroup: "WATCH"
    });
  });

  it("lets newer successful reader evidence supersede stale investigating state", () => {
    const [result] = buildCourseInventory(
      [
        course({
          coverageCategory: "TECHNICAL_CONSTRAINT",
          localReaderSupported: true,
          localReaderVerifiedAt: new Date("2026-07-24T17:45:00.000Z"),
          monitoringStatus: {
            reference: "MON-1",
            state: "AUTO_INVESTIGATING",
            lastSuccessfulAt: null,
            lastFailureAt: new Date("2026-07-24T17:30:00.000Z"),
            nextAutomaticAttemptAt: new Date("2026-07-24T18:15:00.000Z"),
            revalidationRequestedAt: null
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusKey: "LOCAL_READER_VERIFIED",
      priorityGroup: "WORKING",
      automationQueueState: null
    });
  });

  it("keeps healthy reader-verified courses working ahead of stale provider coverage", () => {
    const [result] = buildCourseInventory(
      [
        course({
          coverageCategory: "UNSUPPORTED_FAMILY",
          activeAlertCount: 1,
          localReaderSupported: true,
          localReaderVerifiedAt: new Date("2026-07-24T17:45:00.000Z"),
          localReaderVersion: "cps-rendered-v1",
          monitoringStatus: {
            reference: "MON-1",
            state: "HEALTHY",
            lastSuccessfulAt: new Date("2026-07-24T17:45:00.000Z"),
            lastFailureAt: new Date("2026-07-24T17:30:00.000Z"),
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusKey: "LOCAL_READER_VERIFIED",
      priorityGroup: "WORKING",
      automationQueueState: null
    });
  });

  it("keeps a newer failure actionable after an older successful reader result", () => {
    const [result] = buildCourseInventory(
      [
        course({
          coverageCategory: "TECHNICAL_CONSTRAINT",
          localReaderSupported: true,
          localReaderVerifiedAt: new Date("2026-07-24T17:30:00.000Z"),
          monitoringStatus: {
            reference: "MON-1",
            state: "AUTO_INVESTIGATING",
            lastSuccessfulAt: new Date("2026-07-24T17:30:00.000Z"),
            lastFailureAt: new Date("2026-07-24T17:45:00.000Z"),
            nextAutomaticAttemptAt: new Date("2026-07-24T18:15:00.000Z"),
            revalidationRequestedAt: null
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      priorityGroup: "WATCH",
      automationQueueState: "SCHEDULED_RETRY"
    });
  });

  it("separates current automation work from scheduled and human work", () => {
    const inventory = buildCourseInventory(
      [
        course({
          id: "due",
          monitoringStatus: monitoringStatus("AUTO_INVESTIGATING", {
            nextAutomaticAttemptAt: new Date("2026-07-24T17:55:00.000Z")
          })
        }),
        course({
          id: "progress",
          monitoringStatus: monitoringStatus("DEGRADED_RETRYING")
        }),
        course({
          id: "scheduled",
          monitoringStatus: monitoringStatus("AUTO_INVESTIGATING", {
            nextAutomaticAttemptAt: new Date("2026-07-24T18:30:00.000Z")
          })
        }),
        course({
          id: "human",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED")
        })
      ],
      NOW
    );

    expect(summarizeCourseInventory(inventory)).toMatchObject({
      dueNow: 1,
      inProgress: 1,
      scheduledRetry: 1,
      needsHuman: 1
    });
  });

  it("explains a temporary course website outage and the scheduled follow-up", () => {
    const [result] = buildCourseInventory(
      [
        course({
          automationEligibility: "NEEDS_REVIEW",
          automationReason: "TEMPORARILY_UNAVAILABLE",
          activeAlertCount: 1,
          incident: {
            id: "incident-temporary",
            status: "AUTO_INVESTIGATING",
            kind: "FETCH_FAILED",
            activeRealSearchCount: 1,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage: "The course website is currently not working correctly.",
            nextAction: "Check the official course website again.",
            failureClass: "UNKNOWN"
          },
          monitoringStatus: monitoringStatus("DEGRADED_RETRYING", {
            nextAutomaticAttemptAt: new Date("2026-07-25T00:00:00.000Z")
          })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusLabel: "Course website temporarily unavailable",
      statusMeaning:
        "An operator confirmed that the course website is not working correctly, so Tee Time Spot cannot currently view its tee times.",
      automationQueueState: "IN_PROGRESS"
    });
    expect(result.recommendedAction).toContain("will be emailed when tee-time checks resume");
  });

  it("distinguishes an operator-requested AI recheck from generic investigation", () => {
    const [result] = buildCourseInventory(
      [
        course({
          monitoringStatus: monitoringStatus("AUTO_INVESTIGATING", {
            revalidationRequestedAt: new Date("2026-07-24T17:50:00.000Z"),
            nextAutomaticAttemptAt: new Date("2026-07-24T17:55:00.000Z")
          })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusLabel: "AI recheck queued",
      statusMeaning: "Your note is saved and waiting for AI to run a fresh course verification.",
      automationQueueState: "DUE_NOW"
    });
    expect(result.recommendedAction).toContain(
      "move to Engineering verification needed only if you must confirm"
    );
  });

  it("explains that engineering verification is waiting on the operator", () => {
    const [result] = buildCourseInventory(
      [
        course({
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED")
        })
      ],
      NOW
    );

    expect(result.statusMeaning).toContain(
      "needs you to confirm the course works or provide more course information"
    );
    expect(result.recommendedAction).toContain("request another AI recheck");
  });

  it("explains that lifecycle courses are regrouped by next owner", () => {
    expect(
      getCourseSummaryCopy({
        action: 17,
        watch: 5,
        limitations: 66,
        unchecked: 2,
        working: 127
      })
    ).toEqual({
      lifecycle:
        "217 courses appear once by current state. Known limitations are finished decisions, not active failures.",
      execution:
        "The same 22 attention courses appear again here exactly once under automation or a person. " +
        "These are not additional issues."
    });
  });

  it("assigns watch-only investigation work to a person when automation has no claim", () => {
    const [result] = buildCourseInventory(
      [
        course({
          coverageCategory: "SOURCE_UNVERIFIED",
          detectedBookingUrl: null
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      priorityGroup: "WATCH",
      automationQueueState: "NEEDS_HUMAN"
    });
  });
});

function course(overrides: Partial<CourseStatusInput> = {}): CourseStatusInput {
  return {
    id: "course-1",
    name: "Example Golf Course",
    address: "1 Fairway Drive, Example, CT 06000",
    city: "Example",
    stateCode: "CT",
    providerFamilyKey: "FOREUP",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    bookingAccessMode: "PUBLIC_SIGNED_OUT",
    bookingMethod: "PUBLIC_ONLINE",
    detectedBookingUrl: "https://book.example.com/",
    website: "https://example.com/",
    localReaderSupported: false,
    localReaderCandidate: false,
    localReaderVerifiedAt: null,
    localReaderVersion: null,
    activeAlertCount: 0,
    activeSyntheticAlertCount: 0,
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

function monitoringStatus(
  state: string,
  overrides: Partial<NonNullable<CourseStatusInput["monitoringStatus"]>> = {}
) {
  return {
    reference: "MON-1",
    state,
    lastSuccessfulAt: null,
    lastFailureAt: new Date("2026-07-24T17:45:00.000Z"),
    nextAutomaticAttemptAt: null,
    revalidationRequestedAt: null,
    ...overrides
  };
}
