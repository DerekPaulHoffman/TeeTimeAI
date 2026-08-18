import { describe, expect, it } from "vitest";

import type { AutomationPlaybookAssessment } from "./course-monitoring-playbook";
import {
  getCourseSupportRemediationDirective,
  isStructuralCourseSupportFailure,
  isTransientCourseSupportFailure,
  routeCourseSupportRemediation,
  type CourseSupportRemediationRoutingInput,
} from "./course-support-remediation-routing";

const incompletePlaybook = (
  nextStage: AutomationPlaybookAssessment["nextStage"] = "TYPED_ADAPTER",
) => ({
  conclusion: "INCOMPLETE" as const,
  nextStage,
});

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
      "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
  },
  bookingMethod: "PUBLIC_ONLINE",
  automationEligibility: "ALLOWED",
  automationReason: "NONE",
  attemptCount: 0,
  playbookAssessment: incompletePlaybook(),
} satisfies CourseSupportRemediationRoutingInput;

describe("course-support remediation routing", () => {
  it("permits only a finite unchanged-runtime budget for transient failures", () => {
    const available = routeCourseSupportRemediation({
      ...runnableCourse,
      failureClass: "RATE_LIMIT",
      attemptCount: 3,
    });
    expect(available).toMatchObject({
      workMode: "VERIFY_TRANSIENT",
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      reason: "TRANSIENT_RETRY_AVAILABLE",
      retryBudget: {
        maximumAttempts: 4,
        attemptsCompleted: 3,
        attemptsRemaining: 1,
        exhausted: false,
      },
    });

    const exhausted = routeCourseSupportRemediation({
      ...runnableCourse,
      failureClass: "RATE_LIMIT",
      attemptCount: 4,
    });
    expect(exhausted).toMatchObject({
      workMode: "WAIT_FOR_MATERIAL_CHANGE",
      resumeWorkMode: "VERIFY_TRANSIENT",
      allowUnchangedRuntime: false,
      reason: "TRANSIENT_RETRY_BUDGET_EXHAUSTED",
      retryBudget: { exhausted: true, attemptsRemaining: 0 },
    });
  });

  it.each([
    ["SCHEMA", runnableCourse],
    ["NOT_FOUND", runnableCourse],
    ["READER_PARSER_MISSING", runnableCourse],
    [
      "UNSUPPORTED_FAMILY",
      {
        ...runnableCourse,
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "TENFORE",
        detectedBookingUrl: "https://tenant.tenfore.golf/tee-times",
        bookingMetadata: null,
      },
    ],
  ] as const)("routes structural %s failures to reusable implementation", (failureClass, course) => {
    const result = routeCourseSupportRemediation({
      ...course,
      failureClass,
      attemptCount: 1,
      playbookAssessment: incompletePlaybook(),
    });

    expect(result).toMatchObject({
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      allowUnchangedRuntime: false,
      requiresImplementationPath: true,
      retryBudget: null,
      reason: "IMPLEMENTATION_REQUIRED",
    });
  });

  it("advances one current discovery stage without calling it a transient retry", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      detectedBookingUrl: null,
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "MISSING_SOURCE",
      playbookAssessment: incompletePlaybook("OFFICIAL_HTTP_DISCOVERY"),
    });

    expect(result).toMatchObject({
      workMode: "ADVANCE_DISCOVERY",
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      retryBudget: null,
      reason: "PLAYBOOK_STAGE_PENDING",
      attemptSignature: {
        playbookStage: "OFFICIAL_HTTP_DISCOVERY",
      },
    });
    expect(getCourseSupportRemediationDirective(result)).toEqual({
      workMode: "ADVANCE_DISCOVERY",
      strategyAction: "DISCOVER_WITH_HTTP",
      playbookStage: "OFFICIAL_HTTP_DISCOVERY",
    });
  });

  it("reuses newly runnable support for a sibling with a stale unsupported failure", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      failureClass: "UNSUPPORTED_FAMILY",
      attemptCount: 2,
    });

    expect(result).toMatchObject({
      workMode: "VERIFY_TRANSIENT",
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      reason: "EXISTING_SUPPORT_READY",
      strategy: { action: "RUN_TYPED_ADAPTER" },
    });
  });

  it("lets an unknown unsupported family advance discovery before implementation", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "booking.public-course.example",
      detectedBookingUrl: "https://booking.public-course.example/tee-times",
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "UNSUPPORTED_FAMILY",
      playbookAssessment: incompletePlaybook("OFFICIAL_HTTP_DISCOVERY"),
    });

    expect(result).toMatchObject({
      workMode: "ADVANCE_DISCOVERY",
      strategy: {
        action: "DISCOVER_WITH_HTTP",
        reason: "UNKNOWN_PROVIDER_FAMILY",
      },
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
    });
  });

  it("parks an identical non-transient attempt until a material change occurs", () => {
    const priorUnchangedAttempt = {
      workMode: "ADVANCE_DISCOVERY" as const,
      strategyAction: "DISCOVER_WITH_HTTP" as const,
      playbookStage: "OFFICIAL_HTTP_DISCOVERY" as const,
    };
    const input = {
      ...runnableCourse,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      detectedBookingUrl: null,
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "MISSING_SOURCE" as const,
      playbookAssessment: incompletePlaybook("OFFICIAL_HTTP_DISCOVERY"),
      priorUnchangedAttempt,
    };

    expect(routeCourseSupportRemediation(input)).toMatchObject({
      workMode: "WAIT_FOR_MATERIAL_CHANGE",
      resumeWorkMode: "ADVANCE_DISCOVERY",
      allowUnchangedRuntime: false,
      reason: "UNCHANGED_ATTEMPT_ALREADY_RECORDED",
    });

    expect(
      routeCourseSupportRemediation({
        ...input,
        materialChanges: { providerSnapshotChanged: true },
      }),
    ).toMatchObject({
      workMode: "ADVANCE_DISCOVERY",
      allowUnchangedRuntime: true,
      materialChangeDetected: true,
      reason: "MATERIAL_CHANGE_REOPENED",
    });
  });

  it("allows a different playbook stage after an earlier unchanged discovery attempt", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      detectedBookingUrl: null,
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "MISSING_SOURCE",
      discoveryAttempt: "HTTP_INCONCLUSIVE",
      playbookAssessment: incompletePlaybook("RENDERED_BROWSER_DISCOVERY"),
      priorUnchangedAttempt: {
        workMode: "ADVANCE_DISCOVERY",
        strategyAction: "DISCOVER_WITH_HTTP",
        playbookStage: "OFFICIAL_HTTP_DISCOVERY",
      },
    });

    expect(result).toMatchObject({
      workMode: "ADVANCE_DISCOVERY",
      strategy: { action: "DISCOVER_WITH_BROWSER" },
      attemptSignature: { playbookStage: "RENDERED_BROWSER_DISCOVERY" },
    });
  });

  it("parks an exhausted unresolved playbook and reopens it only for material change", () => {
    const input = {
      ...runnableCourse,
      failureClass: "MISSING_METADATA" as const,
      playbookAssessment: {
        conclusion: "UNRESOLVED_EXHAUSTED" as const,
        nextStage: null,
      },
    };

    expect(routeCourseSupportRemediation(input)).toMatchObject({
      workMode: "WAIT_FOR_MATERIAL_CHANGE",
      allowUnchangedRuntime: false,
      reason: "PLAYBOOK_EXHAUSTED",
    });
    expect(
      routeCourseSupportRemediation({
        ...input,
        materialChanges: { operatorRequested: true },
      }),
    ).toMatchObject({
      workMode: "VERIFY_TRANSIENT",
      reason: "MATERIAL_CHANGE_REOPENED",
    });
  });

  it.each(["FACTUAL_FINAL", "TECHNICAL_FINAL", "MONITORING_RESTORED"] as const)(
    "completes a terminal %s playbook instead of retrying it",
    (conclusion) => {
      expect(
        routeCourseSupportRemediation({
          ...runnableCourse,
          failureClass: "SCHEMA",
          playbookAssessment: { conclusion, nextStage: null },
        }),
      ).toMatchObject({
        workMode: "COMPLETE_CLASSIFICATION",
        allowUnchangedRuntime: true,
        requiresImplementationPath: false,
        reason: "CLASSIFICATION_READY",
      });
    },
  );

  it("does not repeat an unchanged implementation attempt", () => {
    const input = {
      ...runnableCourse,
      failureClass: "SCHEMA" as const,
      priorUnchangedAttempt: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT" as const,
        strategyAction: "REPAIR_PROVIDER_ADAPTER" as const,
        playbookStage: "TYPED_ADAPTER" as const,
      },
    };
    expect(routeCourseSupportRemediation(input)).toMatchObject({
      workMode: "WAIT_FOR_MATERIAL_CHANGE",
      resumeWorkMode: "IMPLEMENT_REUSABLE_SUPPORT",
      reason: "UNCHANGED_ATTEMPT_ALREADY_RECORDED",
    });
    expect(
      routeCourseSupportRemediation({
        ...input,
        materialChanges: { relevantRuntimeChanged: true },
      }),
    ).toMatchObject({
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      reason: "MATERIAL_CHANGE_REOPENED",
    });
  });

  it("classifies transient and structural failure sets without overlap", () => {
    expect(isTransientCourseSupportFailure("NETWORK")).toBe(true);
    expect(isStructuralCourseSupportFailure("NETWORK")).toBe(false);
    expect(isStructuralCourseSupportFailure("UNSUPPORTED_FAMILY")).toBe(true);
    expect(isTransientCourseSupportFailure("UNSUPPORTED_FAMILY")).toBe(false);
  });

  it("rejects invalid attempt and retry budgets", () => {
    expect(() =>
      routeCourseSupportRemediation({ ...runnableCourse, attemptCount: -1 }),
    ).toThrow("attemptCount must be a nonnegative integer");
    expect(() =>
      routeCourseSupportRemediation({
        ...runnableCourse,
        transientRetryBudget: 0,
      }),
    ).toThrow("transientRetryBudget must be a positive integer");
  });
});
