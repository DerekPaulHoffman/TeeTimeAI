import { describe, expect, it } from "vitest";

import {
  hasSafePublicDiscoverySource,
  selectMonitoringStrategy,
  shouldStopBrowserDiscovery
} from "./monitoring-strategy";
import {
  getCourseSupportRemediationDirective,
  isAssignedDetachedStageProgression,
  routeCourseSupportRemediation,
} from "./course-support-remediation-routing";
import { buildCourseSupportClaimActionPlan } from "./course-support-action-plan";
import { canVerifyUnchangedCourseSupportRuntime } from "./course-support-batches";

const runnableCourse = {
  isPublic: true,
  detectedPlatform: "FOREUP",
  providerFamilyKey: "FOREUP",
  detectedBookingUrl:
    "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
  website: "https://public-course.example/",
  bookingMetadata: {
    scheduleId: 2,
    bookingBaseUrl:
      "https://foreupsoftware.com/index.php/booking/1/2#/teetimes"
  },
  bookingMethod: "PUBLIC_ONLINE",
  automationEligibility: "ALLOWED",
  automationReason: "NONE"
};

describe("dynamic monitoring strategy", () => {
  it("keeps the ordered missing-configuration path executable through the rendered reader", () => {
    const course = {
      ...runnableCourse, detectedPlatform: "CUSTOM", providerFamilyKey: "CPS",
      detectedBookingUrl: "https://jamesestewart.cps.golf/", bookingMetadata: null,
    };
    const stages = ["OFFICIAL_IDENTITY", "TYPED_ADAPTER", "OFFICIAL_HTTP_DISCOVERY", "HTTP_ADAPTER_RETRY", "RENDERED_BROWSER_DISCOVERY", "BROWSER_ADAPTER_RETRY", "LOCAL_READER"] as const;
    for (const [index, stage] of stages.entries()) {
      const route = routeCourseSupportRemediation({
        ...course, failureClass: "HTTP_5XX", attemptCount: 0,
        discoveryAttempt: index > 2 ? "HTTP_INCONCLUSIVE" : "NONE",
        playbookAssessment: { conclusion: "INCOMPLETE", nextStage: stage },
      });
      const plan = buildCourseSupportClaimActionPlan({
        route, course, incidentKind: "BLOCKED_TOOLING", incidentProviderFamilyKey: "CPS",
      });
      expect(plan.allowedActions).toEqual(["VERIFY_CURRENT_RUNTIME"]);
      expect(route.allowUnchangedRuntime).toBe(true);
      expect(route.requiresImplementationPath).toBe(false);
      if (stage === "BROWSER_ADAPTER_RETRY" || stage === "LOCAL_READER") {
        expect(isAssignedDetachedStageProgression({
          remediationDirective: {
            ...getCourseSupportRemediationDirective(route),
            allowUnchangedRuntime: route.allowUnchangedRuntime,
            requiresImplementationPath: route.requiresImplementationPath,
            retryBudget: route.retryBudget,
          },
          playbookConclusion: "INCOMPLETE", nextPlaybookStage: stage,
          nextPlaybookStageStatus: "PENDING", nextPlaybookStageAttemptCount: 0,
        })).toBe(true);
      }
    }
  });

  it.each(["HTTP_5XX", "NETWORK", "TIMEOUT", "RATE_LIMIT"] as const)(
    "discovers missing configuration through the normal verifier despite retained %s",
    (failureClass) => {
      const courses = [
        { ...runnableCourse, bookingMetadata: null },
        {
          ...runnableCourse,
          detectedPlatform: "CUSTOM",
          providerFamilyKey: "CPS",
          website: "http://www.okcgolf.com/golf/proto/okcgolf/stewart/stewart.htm",
          detectedBookingUrl: "https://jamesestewart.cps.golf/",
          bookingMetadata: null,
          automationEligibility: "NEEDS_REVIEW",
          automationReason: "CAPTCHA_OR_QUEUE",
        },
      ];
      for (const course of courses) {
        const route = routeCourseSupportRemediation({
          ...course,
          failureClass,
          attemptCount: 0,
          playbookAssessment: { conclusion: "INCOMPLETE", nextStage: "OFFICIAL_IDENTITY" },
        });
        const plan = buildCourseSupportClaimActionPlan({
          route, course, incidentKind: "BLOCKED_TOOLING",
          incidentProviderFamilyKey: course.providerFamilyKey,
        });
        expect(route).toMatchObject({
          workMode: "ADVANCE_DISCOVERY", requiresImplementationPath: false,
          strategy: { action: "DISCOVER_WITH_HTTP", reason: "MISSING_PROVIDER_METADATA" },
        });
        expect(plan.allowedActions).toEqual(["VERIFY_CURRENT_RUNTIME"]);
        expect(canVerifyUnchangedCourseSupportRuntime({
          allowUnchangedRuntime: plan.allowedActions.includes("VERIFY_CURRENT_RUNTIME"),
          remediationAllowsUnchangedRuntime: route.allowUnchangedRuntime,
          baseSha: "a".repeat(40), requestedReleaseSha: "a".repeat(40),
          persistedReleaseSha: null, plannedPaths: [],
        })).toBe(true);
        const exhausted = routeCourseSupportRemediation({
          ...course, failureClass, attemptCount: 4,
          playbookAssessment: { conclusion: "UNRESOLVED_EXHAUSTED", nextStage: null },
        });
        expect(exhausted.workMode).toBe("WAIT_FOR_MATERIAL_CHANGE");
        const repeated = routeCourseSupportRemediation({
          ...course, failureClass, attemptCount: 1,
          playbookAssessment: { conclusion: "INCOMPLETE", nextStage: "OFFICIAL_IDENTITY" },
          priorUnchangedAttempt: route.attemptSignature,
        });
        expect(repeated.workMode).toBe("WAIT_FOR_MATERIAL_CHANGE");
      }
    },
  );

  it("runs a typed adapter when current provider metadata is runnable", () => {
    expect(selectMonitoringStrategy(runnableCourse)).toMatchObject({
      action: "RUN_TYPED_ADAPTER",
      reason: "RUNNABLE_PROVIDER",
      providerFamilyKey: "FOREUP",
      browserAllowed: false
    });
  });

  it("retries only transient failures and routes schema failures to adapter repair", () => {
    expect(
      selectMonitoringStrategy({
        ...runnableCourse,
        failureClass: "RATE_LIMIT"
      }).action
    ).toBe("RETRY_PROVIDER");
    expect(
      selectMonitoringStrategy({
        ...runnableCourse,
        failureClass: "SCHEMA"
      }).action
    ).toBe("REPAIR_PROVIDER_ADAPTER");
  });

  it("uses direct HTTP before browser discovery for an unknown public source", () => {
    const unknownCourse = {
      isPublic: true,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      detectedBookingUrl: null,
      website: "https://public-course.example/tee-times",
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW"
    };
    expect(selectMonitoringStrategy(unknownCourse)).toMatchObject({
      action: "DISCOVER_WITH_HTTP",
      browserAllowed: false
    });
    expect(
      selectMonitoringStrategy({
        ...unknownCourse,
        failureClass: "UNKNOWN"
      })
    ).toMatchObject({
      action: "DISCOVER_WITH_HTTP",
      reason: "MISSING_PROVIDER_SOURCE",
      browserAllowed: false
    });
    expect(
      selectMonitoringStrategy({
        ...unknownCourse,
        failureClass: "UNKNOWN",
        discoveryAttempt: "HTTP_INCONCLUSIVE"
      })
    ).toMatchObject({
      action: "DISCOVER_WITH_BROWSER",
      reason: "MISSING_PROVIDER_SOURCE",
      browserAllowed: true
    });
  });

  it("does not repeatedly browser-probe a recognized unsupported family", () => {
    expect(
      selectMonitoringStrategy({
        isPublic: true,
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "TENFORE",
        detectedBookingUrl: "https://fox.tenfore.golf/example",
        website: "https://public-course.example/",
        bookingMetadata: null,
        automationEligibility: "NEEDS_REVIEW",
        failureClass: "UNSUPPORTED_FAMILY",
        discoveryAttempt: "HTTP_INCONCLUSIVE"
      })
    ).toMatchObject({
      action: "REPAIR_PROVIDER_ADAPTER",
      reason: "KNOWN_UNSUPPORTED_PROVIDER",
      browserAllowed: false
    });
  });

  it("verifies a new auth or challenge observation without treating it as bypassable", () => {
    expect(
      selectMonitoringStrategy({
        ...runnableCourse,
        failureClass: "CHALLENGE"
      })
    ).toMatchObject({
      action: "VERIFY_TECHNICAL_CONSTRAINT",
      browserAllowed: true
    });
  });

  it("keeps a current corroborated challenge as a final technical constraint", () => {
    const now = new Date("2026-07-23T16:00:00.000Z");
    expect(
      selectMonitoringStrategy({
        ...runnableCourse,
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        intelligenceVerifiedAt: new Date("2026-07-23T15:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-23T15:00:00.000Z"),
        intelligenceConfidence: 0.95,
        failureClass: "CHALLENGE",
        now
      })
    ).toMatchObject({
      action: "FINAL_TECHNICAL_CONSTRAINT",
      browserAllowed: false
    });
  });

  it("keeps manual booking and private identities out of browser discovery", () => {
    const now = new Date("2026-07-23T16:00:00.000Z");
    const currentEvidence = {
      intelligenceVerifiedAt: new Date("2026-07-23T15:00:00.000Z"),
      intelligenceReviewAt: new Date("2026-08-23T15:00:00.000Z"),
      intelligenceConfidence: 0.95,
      now
    };
    expect(
      selectMonitoringStrategy({
        ...runnableCourse,
        ...currentEvidence,
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING"
      }).action
    ).toBe("FINAL_MANUAL_BOOKING");
    expect(
      selectMonitoringStrategy({
        ...runnableCourse,
        ...currentEvidence,
        isPublic: false
      }).action
    ).toBe("FINAL_PRIVATE_OR_INVALID");
  });

  it("revalidates an overdue private-course identity with HTTP first", () => {
    expect(
      selectMonitoringStrategy({
        ...runnableCourse,
        isPublic: false,
        intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2025-06-01T00:00:00.000Z"),
        intelligenceConfidence: 0.9,
        now: new Date("2026-07-23T00:00:00.000Z")
      })
    ).toMatchObject({
      action: "DISCOVER_WITH_HTTP",
      reason: "PRIVATE_IDENTITY_RECHECK",
      browserAllowed: false
    });
  });

  it.each([
    "http://127.0.0.1:3000/",
    "http://10.0.0.5/",
    "http://172.16.0.5/",
    "http://192.168.1.5/",
    "http://[::1]/",
    "file:///tmp/course.html",
    "https://user:secret@public-course.example/"
  ])("rejects unsafe browser discovery source %s", (website) => {
    expect(
      hasSafePublicDiscoverySource({
        website,
        detectedBookingUrl: null
      })
    ).toBe(false);
  });

  it("stops browser discovery as soon as an access control is observed", () => {
    expect(
      shouldStopBrowserDiscovery({
        accessBarrierCount: 1,
        accessControlDetected: false
      })
    ).toBe(true);
    expect(
      shouldStopBrowserDiscovery({
        accessBarrierCount: 0,
        accessControlDetected: true
      })
    ).toBe(true);
    expect(
      shouldStopBrowserDiscovery({
        accessBarrierCount: 0,
        accessControlDetected: false
      })
    ).toBe(false);
  });
});
