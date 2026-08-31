import { describe, expect, it } from "vitest";

import type { AutomationPlaybookAssessment } from "./course-monitoring-playbook";
import {
  getCourseSupportRemediationDirective,
  isAssignedDetachedStageProgression,
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
  it.each([
    "DISCOVER_WITH_HTTP",
    "DISCOVER_WITH_BROWSER",
    "VERIFY_TECHNICAL_CONSTRAINT",
    "REPAIR_PROVIDER_ADAPTER",
  ] as const)(
    "recognizes exact pending, started, and retryable LOCAL_READER assignment for %s",
    (strategyAction) => {
      const remediationDirective = {
        workMode: "ADVANCE_DISCOVERY" as const,
        strategyAction,
        playbookStage: "LOCAL_READER" as const,
        allowUnchangedRuntime: true,
        requiresImplementationPath: false,
        retryBudget: null,
      };
      expect(
        isAssignedDetachedStageProgression({
          remediationDirective,
          playbookConclusion: "INCOMPLETE",
          nextPlaybookStage: "LOCAL_READER",
          nextPlaybookStageStatus: "PENDING",
          nextPlaybookStageAttemptCount: 0,
        }),
      ).toBe(true);
      expect(
        isAssignedDetachedStageProgression({
          remediationDirective: {
            ...remediationDirective,
            retryBudget: {
              maximumAttempts: 4,
              attemptsCompleted: 1,
              attemptsRemaining: 3,
              exhausted: false,
            },
          },
          playbookConclusion: "INCOMPLETE",
          nextPlaybookStage: "LOCAL_READER",
          nextPlaybookStageStatus: "FAILED_RETRYABLE",
          nextPlaybookStageAttemptCount: 1,
        }),
      ).toBe(true);
      expect(
        isAssignedDetachedStageProgression({
          remediationDirective: {
            ...remediationDirective,
            retryBudget: {
              maximumAttempts: 4,
              attemptsCompleted: 1,
              attemptsRemaining: 3,
              exhausted: false,
            },
          },
          playbookConclusion: "INCOMPLETE",
          nextPlaybookStage: "LOCAL_READER",
          nextPlaybookStageStatus: "STARTED",
          nextPlaybookStageAttemptCount: 1,
        }),
      ).toBe(true);
    },
  );

  it.each([
    ["missing budget", null],
    [
      "exhausted budget",
      {
        maximumAttempts: 4,
        attemptsCompleted: 4,
        attemptsRemaining: 0,
        exhausted: true,
      },
    ],
  ] as const)(
    "rejects retryable LOCAL_READER progression with %s",
    (_label, retryBudget) => {
      expect(
        isAssignedDetachedStageProgression({
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "REPAIR_PROVIDER_ADAPTER",
            playbookStage: "LOCAL_READER",
            allowUnchangedRuntime: true,
            requiresImplementationPath: false,
            retryBudget,
          },
          playbookConclusion: "INCOMPLETE",
          nextPlaybookStage: "LOCAL_READER",
          nextPlaybookStageStatus: "FAILED_RETRYABLE",
          nextPlaybookStageAttemptCount: 1,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["missing budget", null],
    [
      "exhausted budget",
      {
        maximumAttempts: 4,
        attemptsCompleted: 4,
        attemptsRemaining: 0,
        exhausted: true,
      },
    ],
  ] as const)(
    "rejects started LOCAL_READER progression with %s",
    (_label, retryBudget) => {
      expect(
        isAssignedDetachedStageProgression({
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "REPAIR_PROVIDER_ADAPTER",
            playbookStage: "LOCAL_READER",
            allowUnchangedRuntime: true,
            requiresImplementationPath: false,
            retryBudget,
          },
          playbookConclusion: "INCOMPLETE",
          nextPlaybookStage: "LOCAL_READER",
          nextPlaybookStageStatus: "STARTED",
          nextPlaybookStageAttemptCount: 1,
        }),
      ).toBe(false);
    },
  );

  it("recognizes an exact pending browser-adapter repair as detached progression", () => {
    expect(
      isAssignedDetachedStageProgression({
        remediationDirective: {
          workMode: "ADVANCE_DISCOVERY",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "BROWSER_ADAPTER_RETRY",
          allowUnchangedRuntime: true,
          requiresImplementationPath: false,
          retryBudget: null,
        },
        playbookConclusion: "INCOMPLETE",
        nextPlaybookStage: "BROWSER_ADAPTER_RETRY",
        nextPlaybookStageStatus: "PENDING",
        nextPlaybookStageAttemptCount: 0,
      }),
    ).toBe(true);
  });

  it("does not broaden started progression to the browser-adapter stage", () => {
    expect(
      isAssignedDetachedStageProgression({
        remediationDirective: {
          workMode: "ADVANCE_DISCOVERY",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "BROWSER_ADAPTER_RETRY",
          allowUnchangedRuntime: true,
          requiresImplementationPath: false,
          retryBudget: {
            maximumAttempts: 4,
            attemptsCompleted: 1,
            attemptsRemaining: 3,
            exhausted: false,
          },
        },
        playbookConclusion: "INCOMPLETE",
        nextPlaybookStage: "BROWSER_ADAPTER_RETRY",
        nextPlaybookStageStatus: "STARTED",
        nextPlaybookStageAttemptCount: 1,
      }),
    ).toBe(false);
  });

  it("does not reinterpret a browser-adapter implementation assignment as detached progression", () => {
    expect(
      isAssignedDetachedStageProgression({
        remediationDirective: {
          workMode: "IMPLEMENT_REUSABLE_SUPPORT",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "BROWSER_ADAPTER_RETRY",
          allowUnchangedRuntime: false,
          requiresImplementationPath: true,
          retryBudget: null,
        },
        playbookConclusion: "INCOMPLETE",
        nextPlaybookStage: "BROWSER_ADAPTER_RETRY",
        nextPlaybookStageStatus: "PENDING",
        nextPlaybookStageAttemptCount: 0,
      }),
    ).toBe(false);
  });

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
  ] as const)(
    "routes structural %s failures to reusable implementation",
    (failureClass, course) => {
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
    },
  );

  it("advances recognized TenFore work toward its reusable rendered reader", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "TENFORE",
      detectedBookingUrl: "https://fox.tenfore.golf/example",
      bookingMetadata: null,
      failureClass: "UNSUPPORTED_FAMILY",
      attemptCount: 1,
      playbookAssessment: incompletePlaybook("OFFICIAL_IDENTITY"),
    });

    expect(result).toMatchObject({
      workMode: "ADVANCE_DISCOVERY",
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      retryBudget: null,
      reason: "PLAYBOOK_STAGE_PENDING",
    });
  });

  it("keeps a non-runnable TenFore browser-adapter retry on the detached repair route", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "TENFORE",
      detectedBookingUrl: "https://fox.tenfore.golf/example",
      bookingMetadata: null,
      failureClass: "UNSUPPORTED_FAMILY",
      attemptCount: 1,
      playbookAssessment: incompletePlaybook("BROWSER_ADAPTER_RETRY"),
    });

    expect(result).toMatchObject({
      workMode: "ADVANCE_DISCOVERY",
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      reason: "PLAYBOOK_STAGE_PENDING",
      strategy: { action: "REPAIR_PROVIDER_ADAPTER" },
      attemptSignature: { playbookStage: "BROWSER_ADAPTER_RETRY" },
    });
    expect(
      isAssignedDetachedStageProgression({
        remediationDirective: {
          workMode: result.workMode,
          strategyAction: result.strategy.action,
          playbookStage: result.attemptSignature?.playbookStage,
          allowUnchangedRuntime: result.allowUnchangedRuntime,
          requiresImplementationPath: result.requiresImplementationPath,
          retryBudget: result.retryBudget,
        },
        playbookConclusion: "INCOMPLETE",
        nextPlaybookStage: "BROWSER_ADAPTER_RETRY",
        nextPlaybookStageStatus: "PENDING",
        nextPlaybookStageAttemptCount: 0,
      }),
    ).toBe(true);
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

  it("advances official identity before requiring implementation for a source-free course", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      detectedBookingUrl: null,
      website: null,
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "MISSING_SOURCE",
      playbookAssessment: incompletePlaybook("OFFICIAL_IDENTITY"),
    });

    expect(result).toMatchObject({
      workMode: "ADVANCE_DISCOVERY",
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      retryBudget: null,
      reason: "PLAYBOOK_STAGE_PENDING",
      strategy: {
        action: "REPAIR_PROVIDER_ADAPTER",
        reason: "UNSAFE_DISCOVERY_SOURCE",
      },
      attemptSignature: {
        playbookStage: "OFFICIAL_IDENTITY",
      },
    });
    expect(getCourseSupportRemediationDirective(result)).toEqual({
      workMode: "ADVANCE_DISCOVERY",
      strategyAction: "REPAIR_PROVIDER_ADAPTER",
      playbookStage: "OFFICIAL_IDENTITY",
    });
  });

  it.each([1, 4])(
    "keeps a source-free transient failure on discovery after %i provider attempts",
    (attemptCount) => {
      const result = routeCourseSupportRemediation({
        ...runnableCourse,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        detectedBookingUrl: null,
        website: null,
        bookingMetadata: null,
        automationEligibility: "NEEDS_REVIEW",
        failureClass: "NETWORK",
        attemptCount,
        playbookAssessment: incompletePlaybook("OFFICIAL_HTTP_DISCOVERY"),
      });

      expect(result).toMatchObject({
        workMode: "ADVANCE_DISCOVERY",
        allowUnchangedRuntime: true,
        requiresImplementationPath: false,
        retryBudget: null,
        reason: "PLAYBOOK_STAGE_PENDING",
        strategy: {
          action: "REPAIR_PROVIDER_ADAPTER",
          reason: "PROVIDER_ADAPTER_DEFECT",
        },
        attemptSignature: {
          playbookStage: "OFFICIAL_HTTP_DISCOVERY",
        },
      });
      expect(getCourseSupportRemediationDirective(result)).toEqual({
        workMode: "ADVANCE_DISCOVERY",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "OFFICIAL_HTTP_DISCOVERY",
      });
    },
  );

  it("keeps a source-conflict transient failure on the fail-closed implementation route", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_CONFLICT",
      detectedBookingUrl: null,
      website: null,
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "NETWORK",
      attemptCount: 1,
      playbookAssessment: incompletePlaybook("OFFICIAL_HTTP_DISCOVERY"),
    });

    expect(result).toMatchObject({
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      allowUnchangedRuntime: false,
      requiresImplementationPath: true,
      reason: "IMPLEMENTATION_REQUIRED",
    });
  });

  it("does not treat an unknown concrete provider as source-free", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "booking.vendor.example",
      detectedBookingUrl: null,
      website: null,
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "NETWORK",
      attemptCount: 1,
      playbookAssessment: incompletePlaybook("OFFICIAL_HTTP_DISCOVERY"),
    });

    expect(result).toMatchObject({
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      allowUnchangedRuntime: false,
      requiresImplementationPath: true,
      reason: "IMPLEMENTATION_REQUIRED",
    });
  });

  it.each([
    {
      label: "unsafe persisted source",
      website: "javascript:alert(1)",
      failureClass: "MISSING_SOURCE" as const,
      nextStage: "OFFICIAL_IDENTITY" as const,
    },
    {
      label: "post-render adapter retry",
      website: null,
      failureClass: "MISSING_SOURCE" as const,
      nextStage: "BROWSER_ADAPTER_RETRY" as const,
    },
    {
      label: "transient post-render adapter retry",
      website: null,
      failureClass: "NETWORK" as const,
      nextStage: "BROWSER_ADAPTER_RETRY" as const,
    },
    {
      label: "transient local-reader stage",
      website: null,
      failureClass: "NETWORK" as const,
      nextStage: "LOCAL_READER" as const,
    },
  ])("keeps $label on the fail-closed implementation route", ({
    website,
    failureClass,
    nextStage,
  }) => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      detectedBookingUrl: null,
      website,
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass,
      playbookAssessment: incompletePlaybook(nextStage),
    });

    expect(result).toMatchObject({
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      allowUnchangedRuntime: false,
      requiresImplementationPath: true,
      reason: "IMPLEMENTATION_REQUIRED",
      attemptSignature: { playbookStage: nextStage },
    });
  });

  it("advances an available local reader instead of repairing a stale platform snapshot", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "CPS",
      detectedBookingUrl:
        "https://public-course.cps.golf/onlineresweb/search-teetime",
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "HTTP_5XX",
      playbookAssessment: incompletePlaybook("LOCAL_READER"),
      priorUnchangedAttempt: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "LOCAL_READER",
      },
      materialChanges: { providerSnapshotChanged: true },
    });

    expect(result).toMatchObject({
      workMode: "ADVANCE_DISCOVERY",
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      reason: "MATERIAL_CHANGE_REOPENED",
      attemptSignature: {
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "LOCAL_READER",
      },
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

  it("keeps a provider-specific browser adapter retry on detached verification without contract evidence", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "booking.public-course.example",
      detectedBookingUrl: "https://booking.public-course.example/tee-times",
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "MISSING_METADATA",
      discoveryAttempt: "HTTP_INCONCLUSIVE",
      playbookAssessment: incompletePlaybook("BROWSER_ADAPTER_RETRY"),
      providerContractEvidenceAvailable: false,
    });

    expect(result).toMatchObject({
      workMode: "ADVANCE_DISCOVERY",
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      reason: "PLAYBOOK_STAGE_PENDING",
      strategy: {
        action: "REPAIR_PROVIDER_ADAPTER",
        reason: "MISSING_PROVIDER_METADATA",
        browserAllowed: false,
      },
      attemptSignature: {
        workMode: "ADVANCE_DISCOVERY",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "BROWSER_ADAPTER_RETRY",
      },
    });
    expect(
      isAssignedDetachedStageProgression({
        remediationDirective: {
          workMode: result.workMode,
          strategyAction: result.strategy.action,
          playbookStage: result.attemptSignature?.playbookStage,
          allowUnchangedRuntime: result.allowUnchangedRuntime,
          requiresImplementationPath: result.requiresImplementationPath,
          retryBudget: result.retryBudget,
        },
        playbookConclusion: "INCOMPLETE",
        nextPlaybookStage: "BROWSER_ADAPTER_RETRY",
        nextPlaybookStageStatus: "PENDING",
        nextPlaybookStageAttemptCount: 0,
      }),
    ).toBe(true);

    expect(
      routeCourseSupportRemediation({
        ...runnableCourse,
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "booking.public-course.example",
        detectedBookingUrl:
          "https://booking.public-course.example/tee-times",
        bookingMetadata: null,
        automationEligibility: "NEEDS_REVIEW",
        failureClass: "MISSING_METADATA",
        discoveryAttempt: "HTTP_INCONCLUSIVE",
        playbookAssessment: incompletePlaybook("BROWSER_ADAPTER_RETRY"),
        priorUnchangedAttempt: result.attemptSignature,
      }),
    ).toMatchObject({
      workMode: "WAIT_FOR_MATERIAL_CHANGE",
      resumeWorkMode: "ADVANCE_DISCOVERY",
      strategy: { action: "REPAIR_PROVIDER_ADAPTER" },
      attemptSignature: {
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "BROWSER_ADAPTER_RETRY",
      },
      reason: "UNCHANGED_ATTEMPT_ALREADY_RECORDED",
    });
  });

  it("promotes public stable provider-contract evidence to reusable implementation", () => {
    const result = routeCourseSupportRemediation({
      ...runnableCourse,
      detectedPlatform: "FOREUP",
      providerFamilyKey: "FOREUP",
      detectedBookingUrl:
        "https://www.foreupsoftware.com/index.php/booking/12345",
      bookingMetadata: null,
      automationEligibility: "NEEDS_REVIEW",
      failureClass: "MISSING_METADATA",
      discoveryAttempt: "HTTP_INCONCLUSIVE",
      playbookAssessment: incompletePlaybook("BROWSER_ADAPTER_RETRY"),
      providerContractEvidenceAvailable: true,
    });

    expect(result).toMatchObject({
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      allowUnchangedRuntime: false,
      requiresImplementationPath: true,
      reason: "IMPLEMENTATION_REQUIRED",
      strategy: {
        action: "REPAIR_PROVIDER_ADAPTER",
        providerFamilyKey: "FOREUP",
        browserAllowed: false,
      },
      attemptSignature: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "BROWSER_ADAPTER_RETRY",
      },
    });
  });

  it.each([
    {
      label: "private identity",
      overrides: {
        isPublic: false,
        now: new Date("2026-01-01T00:00:00.000Z"),
        intelligenceVerifiedAt: "2024-01-01T00:00:00.000Z",
        intelligenceReviewAt: "2025-01-01T00:00:00.000Z",
        intelligenceConfidence: 0.9,
      },
      expectedProviderFamilyKey: "FOREUP",
    },
    {
      label: "source-missing family",
      overrides: {
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        detectedBookingUrl: null,
        website: "https://official-course/",
        failureClass: "MISSING_SOURCE",
      },
      expectedProviderFamilyKey: "SOURCE_MISSING",
    },
    {
      label: "source-conflict family",
      overrides: {
        detectedPlatform: "FOREUP",
        providerFamilyKey: "SOURCE_CONFLICT",
        detectedBookingUrl: "https://booking.teeitup.com/tee-times",
        website: null,
      },
      expectedProviderFamilyKey: "SOURCE_CONFLICT",
    },
  ])(
    "does not promote provider-contract evidence for a $label",
    ({ overrides, expectedProviderFamilyKey }) => {
      const result = routeCourseSupportRemediation({
        ...runnableCourse,
        detectedPlatform: "FOREUP",
        providerFamilyKey: "FOREUP",
        detectedBookingUrl:
          "https://www.foreupsoftware.com/index.php/booking/12345",
        bookingMetadata: null,
        automationEligibility: "NEEDS_REVIEW",
        failureClass: "MISSING_METADATA",
        discoveryAttempt: "HTTP_INCONCLUSIVE",
        playbookAssessment: incompletePlaybook("BROWSER_ADAPTER_RETRY"),
        providerContractEvidenceAvailable: true,
        ...overrides,
      });

      expect(result).toMatchObject({
        workMode: "ADVANCE_DISCOVERY",
        allowUnchangedRuntime: true,
        requiresImplementationPath: false,
        strategy: {
          action: "REPAIR_PROVIDER_ADAPTER",
          providerFamilyKey: expectedProviderFamilyKey,
          browserAllowed: false,
        },
        attemptSignature: {
          workMode: "ADVANCE_DISCOVERY",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "BROWSER_ADAPTER_RETRY",
        },
      });
    },
  );

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
