import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  areCourseSupportCompletedAttemptsOrchestrationOnly,
  assessCourseSupportZeroExecutionHistory,
  buildCourseSupportExecutionEverSummary,
  countCourseSupportCompletedOrchestrationOnlyAttempts,
  getCourseSupportOrchestrationRetrySchedule,
  isCourseSupportAssignedAdapterOrchestrationMiss,
  readCourseSupportReleaseExecutionEvidence,
  type CourseSupportZeroExecutionBatchEvidence,
} from "./course-support-zero-execution";

const courseId = "course-1";
const courseRef = createHash("sha256")
  .update(courseId)
  .digest("hex")
  .slice(0, 24);
const oldRuntime = "a".repeat(40);
const currentRuntime = "b".repeat(40);
const membershipDigest = "c".repeat(64);

function entry(
  ordinal: number,
  overrides: Partial<CourseSupportZeroExecutionBatchEvidence> = {},
): CourseSupportZeroExecutionBatchEvidence {
  return {
    id: `entry-${ordinal}`,
    cycle: 4,
    result: ordinal === 1 ? "RETRY_SCHEDULED" : "NEEDS_HUMAN",
    batch: {
      baseSha: oldRuntime,
      releaseSha: oldRuntime,
      completedAt: new Date(`2026-08-20T12:0${ordinal}:00.000Z`),
      summary: {
        ...(ordinal === 1
          ? {
              campaign: {
                kind: "PARKED_COHORT",
                attempts: [
                  {
                    courseRef,
                    runId: "campaign-run-1",
                    membershipDigest,
                    cycle: 4,
                  },
                ],
              },
            }
          : {}),
        closeout: {
          remediationAttempts: [
            {
              courseRef,
              runtimeVersion: oldRuntime,
              consumed: false,
              executionEvidence: {
                deploymentRecorded: false,
                providerAttemptRecorded: false,
                playbookAttemptRecorded: false,
                terminalResultRecorded: false,
              },
              operationalRetry: {
                attemptsCompleted: ordinal,
                exhausted: ordinal === 2,
                reason:
                  ordinal === 2
                    ? "OPERATIONAL_RETRY_BUDGET_EXHAUSTED"
                    : "OPERATIONAL_RETRY_AVAILABLE",
              },
            },
          ],
        },
      },
    },
    verificationRequests:
      ordinal === 1
        ? [
            {
              id: "request-1",
              releaseSha: oldRuntime,
              status: "STALE",
              revision: 2,
              attemptCount: 0,
              workflowRunId: null,
              startedAt: null,
              outcome: null,
              failureClass: null,
              evidence: null,
            },
          ]
        : [],
    ...overrides,
  };
}

function assess(entries: CourseSupportZeroExecutionBatchEvidence[]) {
  return assessCourseSupportZeroExecutionHistory({
    courseId,
    cycle: 4,
    campaignRunId: "campaign-run-1",
    campaignMembershipDigest: membershipDigest,
    currentRuntimeVersion: currentRuntime,
    entries,
  });
}

describe("course-support zero-execution history", () => {
  it("retains exact-course provider and changed-release deployment evidence beyond bounded history", () => {
    const otherCourseRef = createHash("sha256")
      .update("course-2")
      .digest("hex")
      .slice(0, 24);
    let summary: unknown = {};
    for (let ordinal = 1; ordinal <= 21; ordinal += 1) {
      const releaseSha = ordinal.toString(16).padStart(40, "0");
      const executionEver = buildCourseSupportExecutionEverSummary({
        summary,
        baseSha: oldRuntime,
        previousReleaseSha: releaseSha,
        previousDeployedAt:
          ordinal === 1 ? new Date("2026-08-20T12:00:00.000Z") : null,
        previousIncidentVerifications: [
          {
            ordinal: 1,
            courseRef,
            providerExecutionRecorded: ordinal === 1,
            providerExecutionAttemptRecorded: ordinal === 1,
            terminalExecutionRecorded: false,
          },
          {
            ordinal: 2,
            courseRef: otherCourseRef,
            providerExecutionRecorded: false,
            providerExecutionAttemptRecorded: false,
            terminalExecutionRecorded: false,
          },
        ],
      });
      const history = Array.isArray(
        (summary as Record<string, unknown>).releaseHistory,
      )
        ? ((summary as Record<string, unknown>).releaseHistory as unknown[])
        : [];
      summary = {
        executionEver,
        releaseHistory: [
          ...history,
          {
            releaseSha,
            deployedAt: ordinal === 1 ? "2026-08-20T12:00:00.000Z" : null,
            incidentVerifications: [],
          },
        ].slice(-20),
      };
    }

    expect(
      readCourseSupportReleaseExecutionEvidence({
        summary,
        baseSha: oldRuntime,
        courseRef,
      }),
    ).toEqual({
      changedReleaseDeploymentEver: true,
      providerExecutionEverForCourse: true,
      providerExecutionAttemptEverForCourse: true,
      terminalExecutionEverForCourse: false,
    });
    expect(
      readCourseSupportReleaseExecutionEvidence({
        summary,
        baseSha: oldRuntime,
        courseRef: otherCourseRef,
      }),
    ).toEqual({
      changedReleaseDeploymentEver: true,
      providerExecutionEverForCourse: false,
      providerExecutionAttemptEverForCourse: false,
      terminalExecutionEverForCourse: false,
    });
  });

  it("reads only exact-runtime legacy course evidence and ignores an undeployed archived SHA", () => {
    const summary = {
      releaseHistory: [
        {
          releaseSha: oldRuntime,
          deployedAt: null,
          incidentVerifications: [
            {
              ordinal: 1,
              result: "RETRY_SCHEDULED",
              verifiedAt: "2026-08-20T12:05:00.000Z",
              proofSnapshot: {
                providerExecution: true,
                runtimeVersion: oldRuntime,
                observedAt: "2026-08-20T12:04:00.000Z",
              },
            },
            {
              ordinal: 2,
              result: "RESTORED",
              verifiedAt: "2026-08-20T12:05:00.000Z",
              proofSnapshot: {
                runtimeVersion: currentRuntime,
                observedAt: "2026-08-20T12:04:00.000Z",
              },
            },
          ],
        },
      ],
    };

    expect(
      readCourseSupportReleaseExecutionEvidence({
        summary,
        baseSha: oldRuntime,
        courseRef,
        legacyOrdinal: 1,
      }),
    ).toEqual({
      changedReleaseDeploymentEver: false,
      providerExecutionEverForCourse: true,
      providerExecutionAttemptEverForCourse: true,
      terminalExecutionEverForCourse: false,
    });
    expect(
      readCourseSupportReleaseExecutionEvidence({
        summary,
        baseSha: oldRuntime,
        courseRef,
        legacyOrdinal: 2,
      }),
    ).toEqual({
      changedReleaseDeploymentEver: false,
      providerExecutionEverForCourse: false,
      providerExecutionAttemptEverForCourse: false,
      terminalExecutionEverForCourse: false,
    });
  });

  it("keeps a wrong-runtime provider attempt sticky without promoting runnable proof", () => {
    const firstAdvance = buildCourseSupportExecutionEverSummary({
      summary: {},
      baseSha: oldRuntime,
      previousReleaseSha: oldRuntime,
      previousDeployedAt: new Date("2026-08-20T12:00:00.000Z"),
      previousIncidentVerifications: [
        {
          ordinal: 1,
          courseRef,
          providerExecutionRecorded: false,
          providerExecutionAttemptRecorded: true,
          terminalExecutionRecorded: false,
        },
      ],
    });
    const secondAdvance = buildCourseSupportExecutionEverSummary({
      summary: { executionEver: firstAdvance },
      baseSha: oldRuntime,
      previousReleaseSha: currentRuntime,
      previousDeployedAt: new Date("2026-08-20T13:00:00.000Z"),
      previousIncidentVerifications: [
        {
          ordinal: 1,
          courseRef,
          providerExecutionRecorded: false,
          providerExecutionAttemptRecorded: false,
          terminalExecutionRecorded: false,
        },
      ],
    });

    expect(
      readCourseSupportReleaseExecutionEvidence({
        summary: { executionEver: secondAdvance },
        baseSha: oldRuntime,
        courseRef,
      }),
    ).toEqual({
      changedReleaseDeploymentEver: true,
      providerExecutionEverForCourse: false,
      providerExecutionAttemptEverForCourse: true,
      terminalExecutionEverForCourse: false,
    });
  });

  it("accepts the exact legacy request-backed outage without treating missing scheduling as execution", () => {
    const result = assess([entry(2), entry(1)]);

    expect(result).toMatchObject({
      batchCount: 2,
      requestCount: 1,
      requestFences: [
        expect.objectContaining({
          id: "request-1",
          batchIncidentId: "entry-1",
        }),
      ],
      absentRequestFences: [
        { batchIncidentId: "entry-2", releaseSha: oldRuntime },
      ],
    });
    expect(result?.historyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(assess([entry(1), entry(2)])).toEqual(result);
  });

  it("accepts the canonical Workflow-start failure before PRE_EXECUTION", () => {
    const first = entry(1);
    Object.assign(first.verificationRequests[0]!, {
      status: "RETRYABLE_FAILED",
      outcome: "FETCH_FAILED",
      failureClass: "UNKNOWN",
      evidence: { providerExecution: false },
      lastError: "Workflow start failed before verification execution.",
    });

    expect(assess([first, entry(2)])).toMatchObject({
      batchCount: 2,
      requestCount: 1,
      requestFences: [
        expect.objectContaining({
          outcome: "FETCH_FAILED",
          failureClass: "UNKNOWN",
          lastError: "Workflow start failed before verification execution.",
        }),
      ],
    });
  });

  it.each([
    [
      "provider execution began",
      () => {
        const first = entry(1);
        first.verificationRequests[0]!.startedAt = new Date(
          "2026-08-20T12:00:30.000Z",
        );
        return [first, entry(2)];
      },
    ],
    [
      "provider evidence exists",
      () => {
        const second = entry(2);
        const summary = second.batch.summary as {
          closeout: {
            remediationAttempts: Array<{
              executionEvidence: { providerAttemptRecorded: boolean };
            }>;
          };
        };
        const attempt = summary.closeout.remediationAttempts[0]!;
        attempt.executionEvidence.providerAttemptRecorded = true;
        return [entry(1), second];
      },
    ],
    [
      "provider attempt evidence exists",
      () => {
        const second = entry(2);
        const summary = second.batch.summary as {
          closeout: {
            remediationAttempts: Array<{
              executionEvidence: { providerExecutionAttemptRecorded?: boolean };
            }>;
          };
        };
        summary.closeout.remediationAttempts[0]!.executionEvidence.providerExecutionAttemptRecorded = true;
        return [entry(1), second];
      },
    ],
    [
      "the old batch is already the current runtime",
      () => [
        entry(1, {
          batch: {
            ...entry(1).batch,
            baseSha: currentRuntime,
            releaseSha: currentRuntime,
            summary: {
              ...(entry(1).batch.summary as object),
              closeout: {
                remediationAttempts: [
                  {
                    courseRef,
                    runtimeVersion: currentRuntime,
                    consumed: false,
                    executionEvidence: {},
                    operationalRetry: {
                      attemptsCompleted: 1,
                      exhausted: false,
                      reason: "OPERATIONAL_RETRY_AVAILABLE",
                    },
                  },
                ],
              },
            },
          },
        }),
      ],
    ],
    [
      "no detached request proves the outage",
      () => [entry(1, { verificationRequests: [] }), entry(2)],
    ],
  ])("rejects recovery when %s", (_reason, makeEntries) => {
    expect(assess(makeEntries())).toBeNull();
  });

  it("counts only durable orchestration-only attempts in the current cycle", () => {
    const orchestrationSummary = {
      closeout: {
        orchestrationOnlyCourseRefs: [courseRef],
      },
    };
    expect(
      countCourseSupportCompletedOrchestrationOnlyAttempts({
        courseId,
        cycle: 4,
        entries: [
          { cycle: 4, batch: { summary: orchestrationSummary } },
          { cycle: 4, batch: { summary: { closeout: {} } } },
          { cycle: 3, batch: { summary: orchestrationSummary } },
        ],
      }),
    ).toBe(1);
  });

  it("counts an undeployed candidate release as orchestration-only and backs off the next miss", () => {
    const summary = {
      closeout: {
        remediationAttempts: [
          {
            courseRef,
            consumed: false,
            countsTowardOperationalNoProgress: false,
            executionEvidence: {
              newReleaseRecorded: true,
              deploymentRecorded: false,
              providerAttemptRecorded: false,
              playbookAttemptRecorded: false,
              terminalResultRecorded: false,
              providerExecutionStarted: false,
            },
          },
        ],
      },
    };
    const attemptCount = countCourseSupportCompletedOrchestrationOnlyAttempts({
      courseId,
      cycle: 4,
      entries: [
        { cycle: 4, batch: { summary } },
        { cycle: 4, batch: { summary } },
      ],
    });

    expect(attemptCount).toBe(2);
    expect(
      getCourseSupportOrchestrationRetrySchedule({
        now: new Date("2026-08-20T12:00:00.000Z"),
        priorAttemptCount: attemptCount,
      }),
    ).toMatchObject({
      attemptNumber: 3,
      delayMs: 60 * 60 * 1000,
    });
  });

  it("counts an assigned adapter request that never reached provider execution as orchestration-only", () => {
    const summary = {
      closeout: {
        remediationAttempts: [
          {
            courseRef,
            consumed: false,
            countsTowardOperationalNoProgress: false,
            approach: {
              workMode: "VERIFY_TRANSIENT",
              strategyAction: "RUN_TYPED_ADAPTER",
              playbookStage: "TYPED_ADAPTER",
            },
            executionEvidence: {
              claimedImplementationPaths: false,
              newReleaseRecorded: false,
              deploymentRecorded: false,
              postProbeRecorded: false,
              providerAttemptRecorded: false,
              providerExecutionAttemptRecorded: false,
              playbookAttemptRecorded: true,
              terminalResultRecorded: false,
              providerExecutionStarted: true,
            },
          },
        ],
      },
    };

    expect(
      countCourseSupportCompletedOrchestrationOnlyAttempts({
        courseId,
        cycle: 4,
        entries: [{ cycle: 4, batch: { summary } }],
      }),
    ).toBe(1);
  });

  it.each([
    "TYPED_ADAPTER",
    "HTTP_ADAPTER_RETRY",
    "BROWSER_ADAPTER_RETRY",
  ])("recognizes an exact zero-execution %s assignment", (playbookStage) => {
    expect(
      isCourseSupportAssignedAdapterOrchestrationMiss({
        approach: {
          workMode: "VERIFY_TRANSIENT",
          strategyAction: "RUN_TYPED_ADAPTER",
          playbookStage,
        },
        executionEvidence: {
          claimedImplementationPaths: false,
          newReleaseRecorded: false,
          deploymentRecorded: false,
          postProbeRecorded: false,
          providerAttemptRecorded: false,
          providerExecutionAttemptRecorded: false,
          playbookAttemptRecorded: true,
          terminalResultRecorded: false,
          providerExecutionStarted: true,
        },
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "an extra approach key",
      approachOverrides: { extra: true },
      evidenceOverrides: {},
    },
    {
      label: "an invalid work mode",
      approachOverrides: { workMode: "WAIT_FOR_MATERIAL_CHANGE" },
      evidenceOverrides: {},
    },
    {
      label: "a different strategy action",
      approachOverrides: { strategyAction: "RETRY_PROVIDER" },
      evidenceOverrides: {},
    },
    {
      label: "an extra evidence key",
      approachOverrides: {},
      evidenceOverrides: { extra: false },
    },
    {
      label: "provider execution evidence",
      approachOverrides: {},
      evidenceOverrides: { providerExecutionAttemptRecorded: true },
    },
    {
      label: "terminal evidence",
      approachOverrides: {},
      evidenceOverrides: { terminalResultRecorded: true },
    },
  ])("rejects $label", ({ approachOverrides, evidenceOverrides }) => {
    expect(
      isCourseSupportAssignedAdapterOrchestrationMiss({
        approach: {
          workMode: "VERIFY_TRANSIENT",
          strategyAction: "RUN_TYPED_ADAPTER",
          playbookStage: "TYPED_ADAPTER",
          ...approachOverrides,
        },
        executionEvidence: {
          claimedImplementationPaths: false,
          newReleaseRecorded: false,
          deploymentRecorded: false,
          postProbeRecorded: false,
          providerAttemptRecorded: false,
          providerExecutionAttemptRecorded: false,
          playbookAttemptRecorded: true,
          terminalResultRecorded: false,
          providerExecutionStarted: true,
          ...evidenceOverrides,
        },
      }),
    ).toBe(false);
  });

  it("does not let a later adapter miss erase prior same-cycle provider execution", () => {
    const operationalSummary = {
      closeout: {
        remediationAttempts: [
          {
            courseRef,
            consumed: true,
            countsTowardOperationalNoProgress: true,
            approach: {
              workMode: "VERIFY_TRANSIENT",
              strategyAction: "RUN_TYPED_ADAPTER",
              playbookStage: "TYPED_ADAPTER",
            },
            executionEvidence: {
              claimedImplementationPaths: false,
              newReleaseRecorded: false,
              deploymentRecorded: false,
              postProbeRecorded: false,
              providerAttemptRecorded: true,
              providerExecutionAttemptRecorded: true,
              playbookAttemptRecorded: true,
              terminalResultRecorded: false,
              providerExecutionStarted: true,
            },
          },
        ],
      },
    };

    expect(
      areCourseSupportCompletedAttemptsOrchestrationOnly({
        courseId,
        cycle: 4,
        entries: [{ cycle: 4, batch: { summary: operationalSummary } }],
      }),
    ).toBe(false);
  });

  it("backs orchestration retries off exponentially and caps them at six hours", () => {
    const scheduledAt = new Date("2026-08-20T12:00:00.000Z");
    expect(
      getCourseSupportOrchestrationRetrySchedule({
        now: scheduledAt,
        priorAttemptCount: 0,
      }),
    ).toEqual({
      attemptNumber: 1,
      delayMs: 15 * 60 * 1000,
      retryAt: new Date("2026-08-20T12:15:00.000Z"),
    });
    expect(
      getCourseSupportOrchestrationRetrySchedule({
        now: scheduledAt,
        priorAttemptCount: 20,
      }),
    ).toEqual({
      attemptNumber: 21,
      delayMs: 6 * 60 * 60 * 1000,
      retryAt: new Date("2026-08-20T18:00:00.000Z"),
    });
  });
});
