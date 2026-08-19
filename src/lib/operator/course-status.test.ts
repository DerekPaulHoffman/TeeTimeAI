import { describe, expect, it } from "vitest";

import {
  buildCourseInventory,
  filterCourseInventory,
  getCourseSummaryCopy,
  listCourseStates,
  parseCourseDiagnosticFilter,
  parseCourseInventoryView,
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

  it("shows a discovered account-required booking path instead of stale source-missing copy", () => {
    const [result] = buildCourseInventory(
      [
        course({
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null,
          coverageCategory: "SOURCE_UNVERIFIED",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: {
            id: "incident-account",
            status: "NEEDS_HUMAN",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-22T01:00:00.000Z"),
            latestMessage: "No public booking surface is currently available.",
            nextAction: "Check the official course website again.",
            failureClass: "UNSUPPORTED_FAMILY",
            attemptCount: 2
          },
          latestDiscovery: discovery({
            status: "VERIFIED",
            detectedPlatform: "CUSTOM",
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "BLOCKED",
            automationReason: "ACCOUNT_REQUIRED",
            bookingAccessMode: "ACCOUNT_SELF_SERVICE",
            bookingCandidateRecorded: true,
            officialLinkCorroborated: true,
            providerLandingFound: true
          })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusLabel: "Engineering verification needed",
      discoveryProviderLabel: "Account-required booking page",
      discoveryStatusLabel: "Account sign-in required",
      problemSummary:
        "The official course site links to an online booking page, but viewing tee times requires a golfer account or sign-in."
    });
    expect(result.recommendedAction).toContain(
      "Confirm the account-required technical limitation"
    );
    expect(result.problemSummary).not.toContain("No verified public");
  });

  it("shows a durable automation-stalled endpoint as waiting without queued AI work", () => {
    const escalatedAt = new Date("2026-07-24T17:45:00.000Z");
    const [result] = buildCourseInventory(
      [
        course({
          id: "waiting-for-evidence",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: automationStalledIncident({ escalatedAt })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      priorityGroup: "PARKED",
      statusLabel: "Waiting for new evidence",
      automationQueueState: null
    });
    expect(result.statusMeaning).toContain("no recheck is queued");
    expect(result.statusMeaning).toContain("relevant deployment");
    expect(result.recommendedAction).toContain("new information");
    expect(
      filterCourseInventory([result], { view: "parked" }).map((item) => item.id)
    ).toEqual(["waiting-for-evidence"]);
    expect(filterCourseInventory([result], { view: "attention" })).toEqual([]);
    expect(summarizeCourseInventory([result])).toMatchObject({
      parked: 1,
      action: 0,
      watch: 0,
      needsHuman: 0
    });
    expect(parseCourseInventoryView("parked")).toBe("parked");
  });

  it("keeps stalled rows in human action until demand, ownership, and schedules are cleared", () => {
    const escalatedAt = new Date("2026-07-24T17:45:00.000Z");
    const variants = buildCourseInventory(
      [
        course({
          id: "real-demand",
          activeAlertCount: 1,
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: automationStalledIncident({
            escalatedAt,
            activeRealSearchCount: 1
          })
        }),
        course({
          id: "incident-scheduled",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: automationStalledIncident({
            escalatedAt,
            nextAttemptAt: new Date("2026-07-24T19:00:00.000Z")
          })
        }),
        course({
          id: "status-scheduled",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED", {
            nextAutomaticAttemptAt: new Date("2026-07-24T19:00:00.000Z")
          }),
          incident: automationStalledIncident({ escalatedAt })
        }),
        course({
          id: "recheck-requested",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED", {
            revalidationRequestedAt: new Date("2026-07-24T17:55:00.000Z")
          }),
          incident: automationStalledIncident({ escalatedAt })
        }),
        course({
          id: "owned",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: automationStalledIncident({
            escalatedAt,
            activeBatchId: "batch-active"
          })
        })
      ],
      NOW
    );

    expect(variants).toHaveLength(5);
    expect(variants.every((item) => item.priorityGroup === "ACTION")).toBe(true);
    expect(variants.every((item) => item.automationQueueState === "NEEDS_HUMAN")).toBe(true);
  });

  it("does not park account-required or unproven human decisions", () => {
    const escalatedAt = new Date("2026-07-24T17:45:00.000Z");
    const [accountRequired, wrongCycle] = buildCourseInventory(
      [
        course({
          id: "account-required",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: {
            ...automationStalledIncident({ escalatedAt }),
            humanReviewReason: "ACCOUNT_REQUIRED"
          }
        }),
        course({
          id: "wrong-cycle",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: {
            ...automationStalledIncident({ escalatedAt }),
            cycle: 4
          }
        })
      ],
      NOW
    );

    expect(accountRequired.priorityGroup).toBe("ACTION");
    expect(accountRequired.statusLabel).toBe("Engineering verification needed");
    expect(wrongCycle.priorityGroup).toBe("ACTION");
  });

  it("keeps text-only account guidance as an uncorroborated candidate", () => {
    const [result] = buildCourseInventory(
      [
        course({
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null,
          coverageCategory: "SOURCE_UNVERIFIED",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: {
            id: "incident-account-guidance",
            status: "NEEDS_HUMAN",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-22T01:00:00.000Z"),
            latestMessage: "No public booking surface is currently available.",
            nextAction: "Check the official course website again.",
            failureClass: "UNSUPPORTED_FAMILY",
            attemptCount: 2
          },
          latestDiscovery: discovery({
            status: "VERIFIED",
            detectedPlatform: "CUSTOM",
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "BLOCKED",
            automationReason: "ACCOUNT_REQUIRED",
            bookingAccessMode: "ACCOUNT_SELF_SERVICE",
            bookingCandidateRecorded: true,
            officialLinkCorroborated: false,
            providerLandingFound: true
          })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      discoveryProviderLabel: "Account-required candidate recorded",
      discoveryStatusLabel: "Official link unconfirmed",
      problemSummary:
        "The latest investigation recorded an account-required booking candidate, but did not corroborate it as this course's official booking path."
    });
    expect(result.problemSummary).not.toContain("official course site links");
  });

  it("shows a TeeItUp scope finding instead of a generic unsupported-family result", () => {
    const [result] = buildCourseInventory(
      [
        course({
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null,
          coverageCategory: "SOURCE_UNVERIFIED",
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: {
            id: "incident-teeitup",
            status: "NEEDS_HUMAN",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-22T01:00:00.000Z"),
            latestMessage: "No public booking surface is currently available.",
            nextAction: "Check the official course website again.",
            failureClass: "UNSUPPORTED_FAMILY",
            attemptCount: 2
          },
          latestDiscovery: discovery({
            status: "INSPECTED",
            detectedPlatform: "TEEITUP",
            bookingCandidateRecorded: true
          })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      discoveryProviderLabel: "TeeItUp candidate recorded",
      discoveryStatusLabel: "Course scope unconfirmed",
      problemSummary:
        "The latest investigation recorded a TeeItUp candidate, but did not prove an official booking link or confirm the exact course scope."
    });
    expect(result.recommendedAction).toContain("save the TeeItUp provider metadata");
  });

  it("uses corroborated provider evidence from the current incident episode", () => {
    const [result] = buildCourseInventory(
      [
        course({
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null,
          coverageCategory: "SOURCE_UNVERIFIED",
          incident: {
            id: "incident-corroborated",
            status: "NEEDS_HUMAN",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage: "Provider scope still needs a fresh check.",
            nextAction: "Review provider evidence.",
            failureClass: "UNSUPPORTED_FAMILY"
          },
          latestDiscovery: discovery({
            status: "LEARNED",
            detectedPlatform: "TEEITUP",
            bookingCandidateRecorded: true,
            officialLinkCorroborated: true,
            providerLandingFound: true
          })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      discoveryProviderLabel: "TeeItUp official link found",
      discoveryStatusLabel: "Provider link corroborated",
      problemSummary:
        "The official course site links to TeeItUp, but the saved course record has not yet been confirmed by a fresh monitoring check."
    });
  });

  it("does not call an ambiguous official provider link runnable", () => {
    const [result] = buildCourseInventory(
      [
        course({
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null,
          coverageCategory: "SOURCE_UNVERIFIED",
          incident: {
            id: "incident-ambiguous-official-link",
            status: "NEEDS_HUMAN",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage: "Provider scope still needs a fresh check.",
            nextAction: "Review provider evidence.",
            failureClass: "UNSUPPORTED_FAMILY"
          },
          latestDiscovery: discovery({
            status: "INSPECTED",
            detectedPlatform: "TEEITUP",
            bookingCandidateRecorded: true,
            officialLinkCorroborated: true,
            providerLandingFound: true
          })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      discoveryProviderLabel: "TeeItUp official link found",
      discoveryStatusLabel: "Course scope unconfirmed",
      problemSummary:
        "The official course site links to TeeItUp, but the exact course or facility scope is still ambiguous."
    });
    expect(result.recommendedAction).toContain("before applying provider metadata");
    expect(result.recommendedAction).not.toContain("request one fresh monitoring check before");
  });

  it("does not reuse discovery proof from before the current incident episode", () => {
    const [result] = buildCourseInventory(
      [
        course({
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null,
          coverageCategory: "SOURCE_UNVERIFIED",
          incident: {
            id: "incident-new-cycle",
            status: "NEEDS_HUMAN",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-24T17:55:00.000Z"),
            latestMessage: "No public booking surface is currently available.",
            nextAction: "Check the official course website again.",
            failureClass: "UNSUPPORTED_FAMILY"
          },
          latestDiscovery: discovery({
            observedAt: new Date("2026-07-24T17:50:00.000Z"),
            status: "LEARNED",
            detectedPlatform: "TEEITUP",
            bookingCandidateRecorded: true,
            officialLinkCorroborated: true,
            providerLandingFound: true
          })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      discoveryProviderLabel: null,
      discoveryStatusLabel: null,
      problemSummary:
        "No verified public read-only tee-time source has been found for this booking provider."
    });
  });

  it("lets an absolute latest failure supersede older successful discovery copy", () => {
    const [result] = buildCourseInventory(
      [
        course({
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null,
          coverageCategory: "SOURCE_UNVERIFIED",
          incident: {
            id: "incident-latest-failed",
            status: "NEEDS_HUMAN",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage: "The latest official-site discovery attempt failed.",
            nextAction: "Retry from the official course surface.",
            failureClass: "HTTP_5XX"
          },
          latestDiscovery: discovery({
            status: "FAILED",
            observedAt: new Date("2026-07-24T17:59:00.000Z"),
            detectedPlatform: "TEEITUP",
            bookingCandidateRecorded: false,
            officialLinkCorroborated: false,
            providerLandingFound: false
          })
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      discoveryProviderLabel: null,
      discoveryStatusLabel: null,
      problemSummary:
        "The monitoring or verification path returned a server error before it could confirm a course result."
    });
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

  it("keeps an unsupported local-reader parser with engineering instead of human review", () => {
    const [result] = buildCourseInventory(
      [
        course({
          localReaderSupported: false,
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: {
            id: "incident-reader-parser",
            status: "NEEDS_HUMAN",
            kind: "READER_CANDIDATE",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-30T18:00:00.000Z"),
            latestMessage: "Use the local tee-time reader for this course.",
            nextAction: "Implement a compatible reader parser.",
            failureClass: "READER_PARSER_MISSING"
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusLabel: "Engineering verification needed",
      automationQueueState: "ENGINEERING_NEEDED",
      priorityGroup: "ACTION"
    });
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

  it("keeps a final manual operator decision out of the investigation queue", () => {
    const [result] = buildCourseInventory(
      [
        course({
          monitoringStatus: monitoringStatus("FINAL_MANUAL"),
          coverageCategory: "UNSUPPORTED_FAMILY",
          bookingAccessMode: "PHONE_ONLY",
          incident: {
            id: "incident-final-manual",
            status: "RESOLVED",
            resolution: "DIRECT_BOOKING_CLASSIFIED",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-22T01:00:00.000Z"),
            latestMessage: "Tee times require a manual course process.",
            nextAction: "Review the old provider investigation.",
            failureClass: "UNSUPPORTED_FAMILY"
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusKey: "DIRECT_SITE_ONLY",
      diagnosticKey: "NO_PUBLIC_ONLINE",
      statusLabel: "Phone or manual booking",
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
      label: "Investigation backlog",
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

  it("shows a final identity lifecycle as a known private or invalid limitation", () => {
    const [result] = buildCourseInventory(
      [
        course({
          monitoringStatus: monitoringStatus("FINAL_IDENTITY"),
          incident: {
            id: "incident-final-identity",
            status: "RESOLVED",
            resolution: "IDENTITY_CLASSIFIED",
            kind: "NEEDS_ADAPTER",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-24T12:00:00.000Z"),
            latestMessage: "Exact identity review confirmed a non-course listing.",
            nextAction: null,
            failureClass: "UNSUPPORTED_FAMILY"
          }
        })
      ],
      NOW
    );

    expect(result).toMatchObject({
      statusKey: "PRIVATE_OR_INVALID",
      statusLabel: "Private or invalid course record",
      priorityGroup: "LIMITATION",
      automationQueueState: null
    });
  });

  it("uses the durable monitoring success when the newest probe is an older failure", () => {
    const [result] = buildCourseInventory(
      [
        course({
          coverageCategory: "UNSUPPORTED_FAMILY",
          latestProbe: probe("FETCH_FAILED", "2026-07-24T17:30:00.000Z"),
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
      statusKey: "MONITORING_RESTORED",
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
          incident: {
            id: "incident-progress",
            status: "AUTO_INVESTIGATING",
            kind: "FETCH_FAILED",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage: "Verification is running.",
            nextAction: "Wait for exact runtime proof.",
            failureClass: "UNKNOWN",
            activeBatchId: "batch-live",
            activeBatch: {
              status: "VERIFYING",
              leaseExpiresAt: new Date("2026-07-24T18:15:00.000Z")
            }
          }
        }),
        course({
          id: "recovery",
          incident: {
            id: "incident-recovery",
            status: "AUTO_INVESTIGATING",
            kind: "FETCH_FAILED",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage: "Verification ownership expired.",
            nextAction: "Recover the sealed verification batch.",
            failureClass: "UNKNOWN",
            activeBatchId: "batch-expired",
            activeBatch: {
              status: "VERIFYING",
              leaseExpiresAt: new Date("2026-07-24T17:45:00.000Z")
            }
          }
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
        }),
        course({
          id: "engineering",
          localReaderSupported: false,
          monitoringStatus: monitoringStatus("ENGINEERING_VERIFICATION_NEEDED"),
          incident: {
            id: "incident-engineering",
            status: "NEEDS_HUMAN",
            kind: "READER_CANDIDATE",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage: "Reader parser missing.",
            nextAction: "Implement the parser.",
            failureClass: "READER_PARSER_MISSING"
          }
        })
      ],
      NOW
    );

    expect(summarizeCourseInventory(inventory)).toMatchObject({
      dueNow: 1,
      inProgress: 1,
      recoveryRequired: 1,
      scheduledRetry: 1,
      engineeringNeeded: 1,
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

  it("shows when an operator-requested AI recheck is waiting for worker capacity", () => {
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
      statusLabel: "Waiting for AI capacity",
      statusMeaning:
        "Your note is saved and this course is eligible for a fresh verification, but no worker owns it yet.",
      automationQueueState: "DUE_NOW"
    });
    expect(result.recommendedAction).toContain("a verification slot opens");
  });

  it("distinguishes a running operator recheck from a scheduled retry", () => {
    const sharedMonitoringStatus = monitoringStatus("AUTO_INVESTIGATING", {
      revalidationRequestedAt: new Date("2026-07-24T17:50:00.000Z")
    });
    const [running, scheduled] = buildCourseInventory(
      [
        course({
          id: "running",
          monitoringStatus: sharedMonitoringStatus,
          incident: {
            id: "incident-running",
            status: "AUTO_INVESTIGATING",
            kind: "FETCH_FAILED",
            activeRealSearchCount: 0,
            firstSeenAt: new Date("2026-07-24T17:00:00.000Z"),
            latestMessage: "Verification is running.",
            nextAction: null,
            failureClass: "UNKNOWN",
            activeBatchId: "batch-live",
            activeBatch: {
              status: "VERIFYING",
              leaseExpiresAt: new Date("2026-07-24T18:15:00.000Z")
            }
          }
        }),
        course({
          id: "scheduled",
          monitoringStatus: {
            ...sharedMonitoringStatus,
            nextAutomaticAttemptAt: new Date("2026-07-24T18:30:00.000Z")
          }
        })
      ],
      NOW
    );

    expect(running).toMatchObject({
      statusLabel: "AI recheck running",
      automationQueueState: "IN_PROGRESS"
    });
    expect(scheduled).toMatchObject({
      statusLabel: "AI retry scheduled",
      automationQueueState: "SCHEDULED_RETRY"
    });
    expect(scheduled.statusMeaning).toContain("not checking this course right now");
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
        parked: 11,
        limitations: 66,
        unchecked: 2,
        working: 127
      })
    ).toEqual({
      lifecycle:
        "228 courses appear once by current state. Courses waiting for new evidence have no AI recheck queued, and known limitations are finished decisions.",
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
    latestDiscovery: null,
    profileSlug: null,
    coverageCategory: "SUPPORTED_READY",
    ...overrides
  };
}

function discovery(
  overrides: Partial<NonNullable<CourseStatusInput["latestDiscovery"]>> = {}
) {
  return {
    status: "LEARNED",
    detectedPlatform: "UNKNOWN",
    bookingMethod: "UNKNOWN",
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "NONE",
    bookingAccessMode: "UNKNOWN",
    bookingCandidateRecorded: false,
    officialLinkCorroborated: false,
    providerLandingFound: false,
    confidence: 0.8,
    observedAt: new Date("2026-07-24T17:50:00.000Z"),
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

function automationStalledIncident(
  overrides: Partial<NonNullable<CourseStatusInput["incident"]>> & { escalatedAt: Date }
): NonNullable<CourseStatusInput["incident"]> {
  const { escalatedAt, ...incidentOverrides } = overrides;
  const escalationDeadlineAt = new Date(escalatedAt.getTime() - 15 * 60 * 1000);
  return {
    id: "incident-stalled",
    status: "NEEDS_HUMAN",
    kind: "NEEDS_ADAPTER",
    activeRealSearchCount: 0,
    cycle: 3,
    firstSeenAt: new Date("2026-07-24T16:00:00.000Z"),
    latestMessage: "The bounded automation playbook reached its endpoint.",
    nextAction: "Wait for material evidence.",
    failureClass: "UNSUPPORTED_FAMILY",
    humanReviewReason: "AUTOMATION_STALLED",
    escalatedAt,
    escalationDeadlineAt,
    nextAttemptAt: null,
    activeBatchId: null,
    monitoringEvents: [
      {
        incidentId: "incident-stalled",
        eventType: "HUMAN_REVIEW_REQUESTED",
        occurredAt: escalatedAt,
        audit: {
          cycle: 3,
          customerState: "NEEDS_HUMAN_REVIEW",
          automationStalled: true,
          playbookExhausted: false,
          parkedUntilMaterialChange: true,
          escalationDeadlineAt: escalationDeadlineAt.toISOString()
        }
      }
    ],
    ...incidentOverrides
  };
}
