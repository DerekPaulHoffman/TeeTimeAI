import { describe, expect, it } from "vitest";

import {
  buildCourseSupportClaimActionPlan,
  courseSupportActionPlanAllows,
  courseSupportActionPlanMatchesRoute,
  parseCourseSupportClaimActionPlan,
} from "./course-support-action-plan";
import type { CourseSupportRemediationRoute } from "./course-support-remediation-routing";

function course(overrides: Record<string, unknown> = {}) {
  return {
    providerFamilyKey: "SOURCE_MISSING",
    website: null,
    detectedBookingUrl: null,
    bookingMetadata: null,
    monitoringMode: "AUTOMATIC",
    ...overrides,
  };
}

function route(
  overrides: Partial<CourseSupportRemediationRoute> = {},
): CourseSupportRemediationRoute {
  return {
    workMode: "ADVANCE_DISCOVERY",
    resumeWorkMode: "ADVANCE_DISCOVERY",
    allowUnchangedRuntime: true,
    requiresImplementationPath: false,
    retryBudget: null,
    reason: "PLAYBOOK_STAGE_PENDING",
    strategy: {
      action: "DISCOVER_WITH_BROWSER",
      reason: "MISSING_PROVIDER_SOURCE",
      providerFamilyKey: "SOURCE_MISSING",
      browserAllowed: true,
    },
    materialChangeDetected: false,
    attemptSignature: {
      workMode: "ADVANCE_DISCOVERY",
      strategyAction: "DISCOVER_WITH_BROWSER",
      playbookStage: "RENDERED_BROWSER_DISCOVERY",
    },
    ...overrides,
  };
}

describe("course-support claimed action plans", () => {
  it("makes exact source search authoritative for a source-free rendered stage", () => {
    const plan = buildCourseSupportClaimActionPlan({
      route: route(),
      incidentKind: "NEEDS_ADAPTER",
      incidentProviderFamilyKey: "SOURCE_MISSING",
      course: course(),
    });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      primaryAction: "SEARCH_FOR_OFFICIAL_SOURCE",
      allowedActions: ["SEARCH_FOR_OFFICIAL_SOURCE"],
    });
    expect(
      courseSupportActionPlanAllows(plan, "INSPECT_PROVIDER_CONTRACT"),
    ).toBe(false);
  });

  it("keeps provider-contract inspection diagnostic beside implementation", () => {
    const implementationRoute = route({
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      resumeWorkMode: "IMPLEMENT_REUSABLE_SUPPORT",
      allowUnchangedRuntime: false,
      requiresImplementationPath: true,
      attemptSignature: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "OFFICIAL_HTTP_DISCOVERY",
      },
      strategy: {
        action: "REPAIR_PROVIDER_ADAPTER",
        reason: "UNKNOWN_PROVIDER_FAMILY",
        providerFamilyKey: "CUSTOM",
        browserAllowed: false,
      },
    });
    const plan = buildCourseSupportClaimActionPlan({
      route: implementationRoute,
      incidentKind: "NEEDS_ADAPTER",
      incidentProviderFamilyKey: "CUSTOM",
      course: course({
        providerFamilyKey: "CUSTOM",
        website: "https://example.test/",
      }),
    });

    expect(plan.primaryAction).toBe("IMPLEMENT_REUSABLE_SUPPORT");
    expect(
      courseSupportActionPlanAllows(plan, "INSPECT_PROVIDER_CONTRACT"),
    ).toBe(true);
  });

  it("does not authorize inspection when the current resolved family differs from the claim", () => {
    const implementationRoute = route({
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      resumeWorkMode: "IMPLEMENT_REUSABLE_SUPPORT",
      allowUnchangedRuntime: false,
      requiresImplementationPath: true,
      attemptSignature: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "OFFICIAL_HTTP_DISCOVERY",
      },
      strategy: {
        action: "REPAIR_PROVIDER_ADAPTER",
        reason: "UNKNOWN_PROVIDER_FAMILY",
        providerFamilyKey: "FOREUP",
        browserAllowed: false,
      },
    });
    const plan = buildCourseSupportClaimActionPlan({
      route: implementationRoute,
      incidentKind: "NEEDS_ADAPTER",
      incidentProviderFamilyKey: "CUSTOM",
      course: course({ providerFamilyKey: "CUSTOM" }),
    });

    expect(plan.allowedActions).toEqual(["IMPLEMENT_REUSABLE_SUPPORT"]);
    expect(
      courseSupportActionPlanAllows(plan, "INSPECT_PROVIDER_CONTRACT"),
    ).toBe(false);
  });

  it("allows a concrete claim to inspect an explicit source-missing course projection", () => {
    const implementationRoute = route({
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      resumeWorkMode: "IMPLEMENT_REUSABLE_SUPPORT",
      allowUnchangedRuntime: false,
      requiresImplementationPath: true,
      attemptSignature: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "OFFICIAL_HTTP_DISCOVERY",
      },
      strategy: {
        action: "REPAIR_PROVIDER_ADAPTER",
        reason: "UNKNOWN_PROVIDER_FAMILY",
        providerFamilyKey: "CUSTOM",
        browserAllowed: false,
      },
    });
    const plan = buildCourseSupportClaimActionPlan({
      route: implementationRoute,
      incidentKind: "BLOCKED_TOOLING",
      incidentProviderFamilyKey: "CUSTOM",
      course: course({
        providerFamilyKey: "SOURCE_MISSING",
        website: "https://example.test/",
      }),
    });

    expect(
      courseSupportActionPlanAllows(plan, "INSPECT_PROVIDER_CONTRACT"),
    ).toBe(true);
  });

  it("does not reinterpret a typed-adapter verification as provider inspection", () => {
    const verificationRoute = route({
      workMode: "VERIFY_TRANSIENT",
      resumeWorkMode: "VERIFY_TRANSIENT",
      attemptSignature: {
        workMode: "VERIFY_TRANSIENT",
        strategyAction: "RUN_TYPED_ADAPTER",
        playbookStage: "TYPED_ADAPTER",
      },
      strategy: {
        action: "RUN_TYPED_ADAPTER",
        reason: "RUNNABLE_PROVIDER",
        providerFamilyKey: "CUSTOM",
        browserAllowed: false,
      },
    });
    const plan = buildCourseSupportClaimActionPlan({
      route: verificationRoute,
      incidentKind: "FETCH_FAILED",
      incidentProviderFamilyKey: "CUSTOM",
      course: course({
        providerFamilyKey: "CUSTOM",
        website: "https://example.test/",
      }),
    });

    expect(plan.allowedActions).toEqual(["VERIFY_CURRENT_RUNTIME"]);
    expect(
      courseSupportActionPlanAllows(plan, "INSPECT_PROVIDER_CONTRACT"),
    ).toBe(false);
  });

  it("round-trips only a plan whose route remains exact", () => {
    const plan = buildCourseSupportClaimActionPlan({
      route: route(),
      incidentKind: "NEEDS_ADAPTER",
      incidentProviderFamilyKey: "SOURCE_MISSING",
      course: course(),
    });

    expect(parseCourseSupportClaimActionPlan(plan)).toEqual(plan);
    expect(
      courseSupportActionPlanMatchesRoute({
        plan,
        workMode: "ADVANCE_DISCOVERY",
        strategyAction: "DISCOVER_WITH_BROWSER",
        playbookStage: "RENDERED_BROWSER_DISCOVERY",
      }),
    ).toBe(true);
    expect(
      parseCourseSupportClaimActionPlan({
        ...plan,
        allowedActions: ["INSPECT_PROVIDER_CONTRACT"],
      }),
    ).toBeNull();
  });

  it.each([
    [
      "a newly retained official URL",
      course({ website: "https://official.example.test/" }),
    ],
    [
      "a concrete current provider projection",
      course({ providerFamilyKey: "FOREUP" }),
    ],
    [
      "a current local-reader projection",
      course({ monitoringMode: "LOCAL_READER_ONLY" }),
    ],
  ])("does not assign source search for %s", (_label, currentCourse) => {
    const plan = buildCourseSupportClaimActionPlan({
      route: route(),
      incidentKind: "NEEDS_ADAPTER",
      incidentProviderFamilyKey: "SOURCE_MISSING",
      course: currentCourse,
    });

    expect(plan.allowedActions).toEqual(["VERIFY_CURRENT_RUNTIME"]);
    expect(
      courseSupportActionPlanAllows(plan, "SEARCH_FOR_OFFICIAL_SOURCE"),
    ).toBe(false);
    expect(
      courseSupportActionPlanAllows(plan, "INSPECT_PROVIDER_CONTRACT"),
    ).toBe(false);
  });

  it.each(["BLOCKED_AUTH", "READER_CANDIDATE"] as const)(
    "does not authorize provider inspection for a %s incident",
    (incidentKind) => {
      const plan = buildCourseSupportClaimActionPlan({
        route: route(),
        incidentKind,
        incidentProviderFamilyKey: "CUSTOM",
        course: course({ providerFamilyKey: "CUSTOM" }),
      });

      expect(plan.allowedActions).toEqual(["VERIFY_CURRENT_RUNTIME"]);
      expect(
        courseSupportActionPlanAllows(plan, "INSPECT_PROVIDER_CONTRACT"),
      ).toBe(false);
    },
  );

  it("projects only allowlisted fields from persisted plans", () => {
    const parsed = parseCourseSupportClaimActionPlan({
      schemaVersion: 1,
      primaryAction: "VERIFY_CURRENT_RUNTIME",
      allowedActions: ["VERIFY_CURRENT_RUNTIME"],
      privateToken: "private-token-canary",
      route: {
        workMode: "VERIFY_TRANSIENT",
        strategyAction: "RUN_TYPED_ADAPTER",
        playbookStage: "TYPED_ADAPTER",
        privateUrl: "https://private-url-canary.example.test/",
      },
    });

    expect(parsed).toEqual({
      schemaVersion: 1,
      primaryAction: "VERIFY_CURRENT_RUNTIME",
      allowedActions: ["VERIFY_CURRENT_RUNTIME"],
      route: {
        workMode: "VERIFY_TRANSIENT",
        strategyAction: "RUN_TYPED_ADAPTER",
        playbookStage: "TYPED_ADAPTER",
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("private-token-canary");
    expect(JSON.stringify(parsed)).not.toContain("private-url-canary");
  });
});
