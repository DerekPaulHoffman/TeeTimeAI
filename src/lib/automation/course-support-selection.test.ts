import { describe, expect, it } from "vitest";

import {
  selectCourseSupportBatch,
  type CourseSupportCandidate,
} from "./course-support-selection";

const now = new Date("2026-08-18T16:00:00.000Z");

function candidate(
  id: string,
  overrides: Partial<CourseSupportCandidate> = {},
): CourseSupportCandidate {
  return {
    id,
    courseId: `course-${id}`,
    cycle: 1,
    kind: "NEEDS_ADAPTER",
    providerFamilyKey: "TENFORE",
    failureClass: "UNSUPPORTED_FAMILY",
    failureFingerprint: "fingerprint",
    humanReviewReason: null,
    engineeringOnly: false,
    activeRealSearchCount: 0,
    earliestTargetDate: null,
    escalationDeadlineAt: null,
    endpointHumanReviewProven: false,
    firstSeenAt: new Date("2026-08-18T14:00:00.000Z"),
    lastSeenAt: new Date("2026-08-18T15:00:00.000Z"),
    lastAttemptAt: null,
    nextAttemptAt: null,
    attemptCount: 1,
    updatedAt: new Date("2026-08-18T15:00:00.000Z"),
    ...overrides,
  };
}

function campaign(
  overrides: Partial<NonNullable<CourseSupportCandidate["campaign"]>> = {},
): NonNullable<CourseSupportCandidate["campaign"]> {
  return {
    runId: "campaign-run",
    membershipDigest: "a".repeat(64),
    priorCycle: 1,
    priorRevision: 1,
    priorMonitoringRevision: 1,
    capturedRevision: 1,
    capturedMonitoringRevision: 1,
    capturedCycle: 1,
    capturedKind: "NEEDS_ADAPTER",
    capturedProviderFamilyKey: "TENFORE",
    campaignCapturedAt: "2026-08-18T13:00:00.000Z",
    admissionMode: "FRESH_CYCLE",
    zeroExecutionHistoryDigest: null,
    sameCycleRecoveryHistoryDigest: null,
    playbookNextStage: "OFFICIAL_IDENTITY",
    playbookCompletedStageCount: 0,
    expectedMonitoringFailureFingerprint: null,
    expectedKind: "NEEDS_ADAPTER",
    expectedFailureClass: "UNSUPPORTED_FAMILY",
    expectedProviderSnapshotFingerprint: "b".repeat(64),
    expectedAttemptLedgerFingerprint: "c".repeat(64),
    expectedPlaybookConclusion: "INCOMPLETE",
    expectedLatestProbeAt: null,
    expectedLatestDiscoveryAt: null,
    ...overrides,
  };
}

describe("course-support remediation-aware selection", () => {
  it("does not mix different work modes in one provider batch", () => {
    const implementationDirective = {
      workMode: "IMPLEMENT_REUSABLE_SUPPORT" as const,
      strategyAction: "REPAIR_PROVIDER_ADAPTER" as const,
      playbookStage: "TYPED_ADAPTER" as const,
    };
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate("implementation", {
          kind: "FETCH_FAILED",
          activeRealSearchCount: 1,
          earliestTargetDate: new Date("2026-08-19T00:00:00.000Z"),
          remediationDirective: implementationDirective,
        }),
        candidate("discovery", {
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "DISCOVER_WITH_HTTP",
            playbookStage: "OFFICIAL_HTTP_DISCOVERY",
          },
        }),
      ],
      maxCourses: 5,
      now,
    });

    expect(selected?.incidents.map((incident) => incident.id)).toEqual([
      "implementation",
    ]);
    expect(selected?.remediationDirective).toEqual(implementationDirective);
  });

  it("does not mix different strategy actions or playbook stages", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate("http", {
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "DISCOVER_WITH_HTTP",
            playbookStage: "OFFICIAL_HTTP_DISCOVERY",
          },
        }),
        candidate("browser-action", {
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "DISCOVER_WITH_BROWSER",
            playbookStage: "OFFICIAL_HTTP_DISCOVERY",
          },
        }),
        candidate("browser-stage", {
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "DISCOVER_WITH_HTTP",
            playbookStage: "RENDERED_BROWSER_DISCOVERY",
          },
        }),
      ],
      maxCourses: 5,
      now,
    });

    expect(selected?.incidents).toHaveLength(1);
  });

  it("keeps matching directives together", () => {
    const remediationDirective = {
      workMode: "IMPLEMENT_REUSABLE_SUPPORT" as const,
      strategyAction: "REPAIR_PROVIDER_ADAPTER" as const,
      playbookStage: "TYPED_ADAPTER" as const,
    };
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate("first", { remediationDirective }),
        candidate("second", { remediationDirective }),
      ],
      maxCourses: 5,
      now,
    });

    expect(selected?.incidents).toHaveLength(2);
    expect(selected?.remediationDirective).toEqual(remediationDirective);
  });

  it("does not mix different per-entry action contracts", () => {
    const remediationDirective = {
      workMode: "ADVANCE_DISCOVERY" as const,
      strategyAction: "DISCOVER_WITH_HTTP" as const,
      playbookStage: "OFFICIAL_HTTP_DISCOVERY" as const
    };
    const route = {
      workMode: remediationDirective.workMode,
      strategyAction: remediationDirective.strategyAction,
      playbookStage: remediationDirective.playbookStage
    };
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate("inspection", {
          remediationDirective,
          actionPlan: {
            schemaVersion: 1,
            primaryAction: "INSPECT_PROVIDER_CONTRACT",
            allowedActions: ["INSPECT_PROVIDER_CONTRACT", "VERIFY_CURRENT_RUNTIME"],
            route
          }
        }),
        candidate("verification", {
          remediationDirective,
          actionPlan: {
            schemaVersion: 1,
            primaryAction: "VERIFY_CURRENT_RUNTIME",
            allowedActions: ["VERIFY_CURRENT_RUNTIME"],
            route
          }
        })
      ],
      maxCourses: 5,
      now
    });

    expect(selected?.incidents).toHaveLength(1);
  });

  it("preserves legacy family and fingerprint grouping without a directive", () => {
    const selected = selectCourseSupportBatch({
      candidates: [candidate("first"), candidate("second")],
      maxCourses: 5,
      now,
    });

    expect(selected?.incidents).toHaveLength(2);
    expect(selected?.remediationDirective).toBeUndefined();
  });

  it("finishes a progressed requestless campaign playbook before admitting an untouched member", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate("untouched", {
          providerFamilyKey: "UNTOUCHED",
          failureFingerprint: "untouched-fingerprint",
          engineeringOnly: true,
          attemptCount: 0,
          campaign: campaign(),
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "DISCOVER_WITH_HTTP",
            playbookStage: "OFFICIAL_IDENTITY",
          },
        }),
        candidate("progressed", {
          providerFamilyKey: "PROGRESSED",
          failureFingerprint: "progressed-fingerprint",
          engineeringOnly: true,
          attemptCount: 4,
          firstSeenAt: new Date("2026-08-18T15:30:00.000Z"),
          campaign: campaign({
            admissionMode: "INCOMPLETE_PLAYBOOK_RECOVERY",
            playbookNextStage: "BROWSER_ADAPTER_RETRY",
            playbookCompletedStageCount: 5,
          }),
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "DISCOVER_WITH_BROWSER",
            playbookStage: "BROWSER_ADAPTER_RETRY",
          },
        }),
      ],
      maxCourses: 5,
      now,
    });

    expect(selected?.incidents.map((incident) => incident.id)).toEqual([
      "progressed",
    ]);
  });

  it("keeps active customer demand ahead of a progressed requestless campaign", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate("customer", {
          kind: "FETCH_FAILED",
          providerFamilyKey: "CUSTOMER",
          failureClass: "NETWORK",
          failureFingerprint: "customer-fingerprint",
          activeRealSearchCount: 1,
          earliestTargetDate: new Date("2026-08-20T12:00:00.000Z"),
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "DISCOVER_WITH_HTTP",
            playbookStage: "OFFICIAL_IDENTITY",
          },
        }),
        candidate("campaign", {
          providerFamilyKey: "CAMPAIGN",
          failureFingerprint: "campaign-fingerprint",
          engineeringOnly: true,
          campaign: campaign({
            admissionMode: "INCOMPLETE_PLAYBOOK_RECOVERY",
            playbookNextStage: "INDEPENDENT_CONFIRMATION",
            playbookCompletedStageCount: 7,
          }),
          remediationDirective: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "DISCOVER_WITH_BROWSER",
            playbookStage: "INDEPENDENT_CONFIRMATION",
          },
        }),
      ],
      maxCourses: 5,
      now,
    });

    expect(selected?.incidents.map((incident) => incident.id)).toEqual([
      "customer",
    ]);
  });
});
