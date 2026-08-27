import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  aggregateCourseSupportActionTelemetry,
  type CompletedCourseSupportActionTelemetryBatch,
} from "./course-support-action-telemetry";
import type { CourseSupportActionExecution } from "./course-support-action-execution";
import type { CourseSupportClaimAction } from "./course-support-action-plan";

const now = new Date("2026-08-26T16:00:00.000Z");

describe("course-support action telemetry", () => {
  it("compares selected actions with confirmed execution over only 30 days", () => {
    const batches: CompletedCourseSupportActionTelemetryBatch[] = [
      completedBatch([
        entry("verify-course", "VERIFY_CURRENT_RUNTIME", {
          consumed: false,
          countsTowardOperationalNoProgress: true,
          providerExecutionAttemptRecorded: true,
        }),
        entry("implementation-course", "IMPLEMENT_REUSABLE_SUPPORT"),
        entry("inspection-course", "INSPECT_PROVIDER_CONTRACT", {
          playbookAttemptRecorded: true,
          consumed: true,
          countsTowardOperationalNoProgress: true,
        }),
        entry("unknown-course", null, { includeCloseout: false }),
      ]),
      completedBatch(
        [entry("old-course", "VERIFY_CURRENT_RUNTIME")],
        new Date("2026-07-01T00:00:00.000Z"),
      ),
    ];

    const result = aggregateCourseSupportActionTelemetry({ now, batches });

    expect(result).toMatchObject({
      schemaVersion: 1,
      windowDays: 30,
      windowStartedAt: "2026-07-27T16:00:00.000Z",
      windowEndedAt: now.toISOString(),
      completedBatchCount: 1,
      completedEntryCount: 4,
      selectedActionCount: 3,
      selectedActionUnavailableCount: 1,
      confirmedExecutedActionCount: 1,
      executedActionCount: null,
      executionUnavailableCount: 2,
      zeroExecutionCount: 1,
      nonzeroExecutionCount: 2,
      zeroExecutionTotal: null,
      zeroExecutionUnavailableCount: 1,
    });
    expect(result.actions.VERIFY_CURRENT_RUNTIME).toMatchObject({
      selectedCount: 1,
      confirmedExecutedCount: 1,
      executedCount: 1,
      executionUnavailableCount: 0,
      executionAvailability: "available",
      zeroExecutionCount: 0,
      nonzeroExecutionCount: 1,
      zeroExecutionUnavailableCount: 0,
      zeroExecutionTotal: 0,
    });
    expect(result.actions.IMPLEMENT_REUSABLE_SUPPORT).toMatchObject({
      selectedCount: 1,
      confirmedExecutedCount: 0,
      executedCount: 0,
      executionUnavailableCount: 0,
      executionAvailability: "available",
      zeroExecutionCount: 1,
      zeroExecutionTotal: 1,
    });
    expect(result.actions.INSPECT_PROVIDER_CONTRACT).toMatchObject({
      selectedCount: 1,
      confirmedExecutedCount: 0,
      executedCount: null,
      executionUnavailableCount: 1,
      executionAvailability: "unavailable",
      zeroExecutionCount: 0,
      nonzeroExecutionCount: 1,
    });
    expect(result.actions.SEARCH_FOR_OFFICIAL_SOURCE).toMatchObject({
      selectedCount: 0,
      executedCount: 0,
      executionAvailability: "available",
      zeroExecutionCount: 0,
      zeroExecutionTotal: 0,
    });
    expect(JSON.stringify(result)).not.toContain("courseRef");
    expect(JSON.stringify(result)).not.toContain("verify-course");
  });

  it("keeps historical contract-inspection execution unavailable", () => {
    const result = aggregateCourseSupportActionTelemetry({
      now,
      batches: [
        completedBatch([
          entry("inspection-course", "INSPECT_PROVIDER_CONTRACT", {
            consumed: true,
            countsTowardOperationalNoProgress: true,
            providerAttemptRecorded: true,
            providerExecutionAttemptRecorded: true,
            playbookAttemptRecorded: true,
            terminalResultRecorded: true,
          }),
        ]),
      ],
    });

    expect(result.actions.INSPECT_PROVIDER_CONTRACT).toMatchObject({
      selectedCount: 1,
      confirmedExecutedCount: 0,
      executedCount: null,
      executionUnavailableCount: 1,
      executionAvailability: "unavailable",
    });
  });

  it("uses exact new-closeout execution markers before legacy inference", () => {
    const result = aggregateCourseSupportActionTelemetry({
      now,
      batches: [
        completedBatch([
          entry("implementation-course", "IMPLEMENT_REUSABLE_SUPPORT", {
            actionExecution: exactActionExecution(
              "IMPLEMENT_REUSABLE_SUPPORT",
              "EXECUTED",
              "STRICT_RUNTIME_RELEASE_DEPLOYMENT_PROOF",
            ),
          }),
          entry("superseded-course", "IMPLEMENT_REUSABLE_SUPPORT", {
            claimedImplementationPaths: true,
            newReleaseRecorded: true,
            deploymentRecorded: true,
            actionExecution: exactActionExecution(
              "IMPLEMENT_REUSABLE_SUPPORT",
              "NOT_EXECUTED",
              "SUPERSEDED_BY_AUTHORITATIVE_SUCCESS",
            ),
          }),
          entry("inspection-course", "INSPECT_PROVIDER_CONTRACT", {
            actionExecution: exactActionExecution(
              "INSPECT_PROVIDER_CONTRACT",
              "UNAVAILABLE",
              "EXACT_ACTION_MARKER_UNAVAILABLE",
            ),
          }),
        ]),
      ],
    });

    expect(result).toMatchObject({
      selectedActionCount: 3,
      confirmedExecutedActionCount: 1,
      executedActionCount: null,
      executionUnavailableCount: 1,
    });
    expect(result.actions.IMPLEMENT_REUSABLE_SUPPORT).toMatchObject({
      selectedCount: 2,
      confirmedExecutedCount: 1,
      executedCount: 1,
      executionUnavailableCount: 0,
      executionAvailability: "available",
    });
    expect(result.actions.INSPECT_PROVIDER_CONTRACT).toMatchObject({
      selectedCount: 1,
      confirmedExecutedCount: 0,
      executedCount: null,
      executionUnavailableCount: 1,
      executionAvailability: "unavailable",
    });
  });

  it("fails malformed new-closeout execution markers closed", () => {
    const batch = completedBatch([
      entry("implementation-course", "IMPLEMENT_REUSABLE_SUPPORT", {
        actionExecution: exactActionExecution(
          "IMPLEMENT_REUSABLE_SUPPORT",
          "EXECUTED",
          "STRICT_RUNTIME_RELEASE_DEPLOYMENT_PROOF",
        ),
      }),
    ]);
    const summary = batch.summary as {
      closeout: {
        remediationAttempts: Array<{ actionExecution: Record<string, unknown> }>;
      };
    };
    summary.closeout.remediationAttempts[0]!.actionExecution.reason =
      "SUPERSEDED_BY_AUTHORITATIVE_SUCCESS";

    const result = aggregateCourseSupportActionTelemetry({
      now,
      batches: [batch],
    });

    expect(result).toMatchObject({
      selectedActionCount: 1,
      confirmedExecutedActionCount: 0,
      executedActionCount: null,
      executionUnavailableCount: 1,
      zeroExecutionTotal: null,
      zeroExecutionUnavailableCount: 1,
    });
  });

  it("does not relabel generic playbook progress as exact source-search execution", () => {
    const result = aggregateCourseSupportActionTelemetry({
      now,
      batches: [
        completedBatch([
          entry("source-search-course", "SEARCH_FOR_OFFICIAL_SOURCE", {
            consumed: true,
            countsTowardOperationalNoProgress: true,
            playbookAttemptRecorded: true,
          }),
        ]),
      ],
    });

    expect(result).toMatchObject({
      confirmedExecutedActionCount: 0,
      executedActionCount: null,
      executionUnavailableCount: 1,
      zeroExecutionCount: 0,
      nonzeroExecutionCount: 1,
      zeroExecutionTotal: 0,
    });
    expect(result.actions.SEARCH_FOR_OFFICIAL_SOURCE).toMatchObject({
      selectedCount: 1,
      confirmedExecutedCount: 0,
      executedCount: null,
      executionUnavailableCount: 1,
      executionAvailability: "unavailable",
    });
  });

  it.each([
    {
      label: "malformed exact claim fields",
      mutate: (plannedAttempt: ReturnType<typeof entry>["plannedAttempt"]) => {
        plannedAttempt.providerSnapshotFingerprint = "not-a-fingerprint";
      },
    },
    {
      label: "a route-mismatched action plan",
      mutate: (plannedAttempt: ReturnType<typeof entry>["plannedAttempt"]) => {
        if (!plannedAttempt.actionPlan) {
          throw new Error("Expected a persisted action plan.");
        }
        plannedAttempt.actionPlan.route.workMode = "ADVANCE_DISCOVERY";
      },
    },
    {
      label: "a semantically impossible action for the exact route",
      mutate: (plannedAttempt: ReturnType<typeof entry>["plannedAttempt"]) => {
        if (!plannedAttempt.actionPlan) {
          throw new Error("Expected a persisted action plan.");
        }
        plannedAttempt.actionPlan.primaryAction =
          "IMPLEMENT_REUSABLE_SUPPORT";
        plannedAttempt.actionPlan.allowedActions = [
          "IMPLEMENT_REUSABLE_SUPPORT",
        ];
      },
    },
  ])("treats $label as selected-action unavailable", ({ mutate }) => {
    const telemetryEntry = entry(
      "invalid-claim-course",
      "VERIFY_CURRENT_RUNTIME",
    );
    mutate(telemetryEntry.plannedAttempt);

    const result = aggregateCourseSupportActionTelemetry({
      now,
      batches: [completedBatch([telemetryEntry])],
    });

    expect(result).toMatchObject({
      completedEntryCount: 1,
      selectedActionCount: 0,
      selectedActionUnavailableCount: 1,
      confirmedExecutedActionCount: 0,
      executedActionCount: null,
      executionUnavailableCount: 1,
    });
  });

  it("treats a duplicate planned-attempt cohort as selected-action unavailable", () => {
    const telemetryEntry = entry(
      "duplicate-claim-course",
      "VERIFY_CURRENT_RUNTIME",
    );
    const batch = completedBatch([telemetryEntry]);
    const summary = batch.summary as {
      remediation: { attempts: unknown[] };
    };
    summary.remediation.attempts.push(telemetryEntry.plannedAttempt);

    const result = aggregateCourseSupportActionTelemetry({
      now,
      batches: [batch],
    });

    expect(result).toMatchObject({
      completedEntryCount: 1,
      selectedActionCount: 0,
      selectedActionUnavailableCount: 1,
      confirmedExecutedActionCount: 0,
      executedActionCount: null,
      executionUnavailableCount: 1,
    });
  });

  it("reports malformed closeout evidence as unavailable instead of zero", () => {
    const malformed = completedBatch([
      entry("malformed-course", "VERIFY_CURRENT_RUNTIME"),
    ]);
    const summary = malformed.summary as {
      closeout: {
        remediationAttempts: Array<{
          executionEvidence: Record<string, boolean>;
        }>;
      };
    };
    delete summary.closeout.remediationAttempts[0]!.executionEvidence
      .providerExecutionStarted;

    const result = aggregateCourseSupportActionTelemetry({
      now,
      batches: [malformed],
    });

    expect(result).toMatchObject({
      zeroExecutionCount: 0,
      zeroExecutionTotal: null,
      zeroExecutionUnavailableCount: 1,
      executedActionCount: null,
      executionUnavailableCount: 1,
    });
  });
});

type EntryOptions = Partial<ExecutionEvidence> & {
  consumed?: boolean;
  countsTowardOperationalNoProgress?: boolean;
  includeCloseout?: boolean;
  actionExecution?: CourseSupportActionExecution;
};

type ExecutionEvidence = {
  claimedImplementationPaths: boolean;
  newReleaseRecorded: boolean;
  deploymentRecorded: boolean;
  postProbeRecorded: boolean;
  providerAttemptRecorded: boolean;
  providerExecutionAttemptRecorded: boolean;
  playbookAttemptRecorded: boolean;
  terminalResultRecorded: boolean;
  providerExecutionStarted: boolean;
};

function entry(
  courseId: string,
  action: CourseSupportClaimAction | null,
  options: EntryOptions = {},
) {
  const courseRef = createHash("sha256")
    .update(courseId)
    .digest("hex")
    .slice(0, 24);
  const executionEvidence: ExecutionEvidence = {
    claimedImplementationPaths: options.claimedImplementationPaths ?? false,
    newReleaseRecorded: options.newReleaseRecorded ?? false,
    deploymentRecorded: options.deploymentRecorded ?? false,
    postProbeRecorded: options.postProbeRecorded ?? false,
    providerAttemptRecorded: options.providerAttemptRecorded ?? false,
    providerExecutionAttemptRecorded:
      options.providerExecutionAttemptRecorded ?? false,
    playbookAttemptRecorded: options.playbookAttemptRecorded ?? false,
    terminalResultRecorded: options.terminalResultRecorded ?? false,
    providerExecutionStarted: options.providerExecutionStarted ?? false,
  };
  const approach = approachForAction(action);
  return {
    courseId,
    courseRef,
    plannedAttempt: {
      courseRef,
      providerSnapshotFingerprint: "a".repeat(64),
      failureFingerprint: "v1:telemetry-test",
      playbookEventCountAtClaim: 0,
      approach,
      ...(action
        ? {
            actionPlan: {
              schemaVersion: 1,
              primaryAction: action,
              allowedActions: [action],
              route: { ...approach },
            },
          }
        : {}),
    },
    closeoutAttempt:
      options.includeCloseout === false
        ? null
        : {
            courseRef,
            consumed: options.consumed ?? false,
            countsTowardOperationalNoProgress:
              options.countsTowardOperationalNoProgress ?? false,
            executionEvidence,
            ...(options.actionExecution
              ? { actionExecution: options.actionExecution }
              : {}),
          },
  };
}

function exactActionExecution(
  action: CourseSupportActionExecution["action"],
  state: CourseSupportActionExecution["state"],
  reason: CourseSupportActionExecution["reason"],
): CourseSupportActionExecution {
  return { schemaVersion: 1, action, state, reason };
}

function approachForAction(action: CourseSupportClaimAction | null) {
  switch (action) {
    case "SEARCH_FOR_OFFICIAL_SOURCE":
      return {
        workMode: "ADVANCE_DISCOVERY",
        strategyAction: "DISCOVER_WITH_BROWSER",
        playbookStage: "RENDERED_BROWSER_DISCOVERY",
      } as const;
    case "INSPECT_PROVIDER_CONTRACT":
      return {
        workMode: "ADVANCE_DISCOVERY",
        strategyAction: "RUN_TYPED_ADAPTER",
        playbookStage: "TYPED_ADAPTER",
      } as const;
    case "IMPLEMENT_REUSABLE_SUPPORT":
      return {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "TYPED_ADAPTER",
      } as const;
    case "COMPLETE_CLASSIFICATION":
      return {
        workMode: "COMPLETE_CLASSIFICATION",
        strategyAction: "FINAL_MANUAL_BOOKING",
        playbookStage: null,
      } as const;
    case "WAIT_FOR_MATERIAL_CHANGE":
      return {
        workMode: "WAIT_FOR_MATERIAL_CHANGE",
        strategyAction: "RETRY_PROVIDER",
        playbookStage: null,
      } as const;
    case "VERIFY_CURRENT_RUNTIME":
    case null:
      return {
        workMode: "VERIFY_TRANSIENT",
        strategyAction: "RETRY_PROVIDER",
        playbookStage: null,
      } as const;
  }
}

function completedBatch(
  entries: ReturnType<typeof entry>[],
  completedAt = new Date("2026-08-25T16:00:00.000Z"),
): CompletedCourseSupportActionTelemetryBatch {
  return {
    completedAt,
    incidents: entries.map(({ courseId }) => ({ courseId })),
    summary: {
      remediation: {
        attempts: entries.map(({ plannedAttempt }) => plannedAttempt),
      },
      closeout: {
        remediationAttempts: entries.flatMap(({ closeoutAttempt }) =>
          closeoutAttempt ? [closeoutAttempt] : [],
        ),
      },
    },
  };
}
