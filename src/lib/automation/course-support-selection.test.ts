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

  it("preserves legacy family and fingerprint grouping without a directive", () => {
    const selected = selectCourseSupportBatch({
      candidates: [candidate("first"), candidate("second")],
      maxCourses: 5,
      now,
    });

    expect(selected?.incidents).toHaveLength(2);
    expect(selected?.remediationDirective).toBeUndefined();
  });
});
