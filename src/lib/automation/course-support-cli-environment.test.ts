import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildCourseSupportAcceptanceHistoryMachineRecord,
  buildCourseSupportCoverageMachineRecord,
  buildCourseSupportCommandFailure,
  buildCourseSupportVerificationWatchToolingFingerprint,
  assertCourseSupportPersistedReleaseFence,
  assertCourseSupportVerificationReleaseLane,
  assertCourseSupportVerifyReleaseOptions,
  classifyCourseSupportDeploymentWaitFailure,
  classifyCommandFailure,
  COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_RECORD_TYPE,
  COURSE_SUPPORT_COVERAGE_MACHINE_RECORD_TYPE,
  COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS,
  COURSE_SUPPORT_RELEASE_LINEAGE_FAILURE_CLASS,
  CourseSupportDatabaseEnvironmentError,
  CourseSupportReleaseLineageError,
  parseCourseSupportAcceptanceHistoryOptions,
  parseCourseSupportCoverageOptions,
  requireExplicitCourseSupportDatabaseUrl,
  runConfiguredCommand,
  runCourseSupportClaimWithImmediateReplan,
  runWithExplicitCourseSupportDatabaseUrl,
  serializeCourseSupportResult
} from "../../../scripts/automation/course-support";
import { CourseSupportClaimReplanRequired } from "./course-support-batches";

describe("course-support claim replanning", () => {
  it("replans one snapshot-drift failure immediately", async () => {
    const operation = vi
      .fn<() => Promise<{ outcome: string }>>()
      .mockRejectedValueOnce(
        new CourseSupportClaimReplanRequired(
          new Error(
            "Course-support incident ownership changed during locked claim; rerun selection.",
          ),
        ),
      )
      .mockResolvedValueOnce({ outcome: "ready" });
    const recordRepeatedChurn = vi.fn();

    await expect(
      runCourseSupportClaimWithImmediateReplan(
        operation,
        recordRepeatedChurn,
      ),
    ).resolves.toEqual({ outcome: "ready" });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(recordRepeatedChurn).not.toHaveBeenCalled();
  });

  it("does not retry invariant failures or retry more than once", async () => {
    const invariantFailure = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error("Malformed course-support evidence."));
    await expect(
      runCourseSupportClaimWithImmediateReplan(
        invariantFailure,
        vi.fn(),
      ),
    ).rejects.toThrow("Malformed course-support evidence.");
    expect(invariantFailure).toHaveBeenCalledOnce();

    const repeatedDrift = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(
        new CourseSupportClaimReplanRequired(
          new Error(
            "Course-support demand changed during claim; rerun selection.",
          ),
        ),
      );
    const recordRepeatedChurn = vi
      .fn<() => Promise<{ outcome: string }>>()
      .mockResolvedValue({ outcome: "deferred_busy" });
    await expect(
      runCourseSupportClaimWithImmediateReplan(
        repeatedDrift,
        recordRepeatedChurn,
      ),
    ).resolves.toEqual({ outcome: "deferred_busy" });
    expect(repeatedDrift).toHaveBeenCalledTimes(2);
    expect(recordRepeatedChurn).toHaveBeenCalledOnce();
  });
});

describe("course-support owner-bound release verification options", () => {
  it("rejects direct changed-release proof outside verify-release", () => {
    expect(() =>
      assertCourseSupportVerificationReleaseLane({
        currentRuntime: false,
        requestedReleaseSha: "a".repeat(40),
        deployedAt: new Date("2026-08-27T12:00:00.000Z")
      })
    ).toThrow("requires the owner-bound verify-release command");
    expect(() =>
      assertCourseSupportVerificationReleaseLane({
        currentRuntime: false,
        requestedReleaseSha: "a".repeat(40),
        deployedAt: new Date("2026-08-27T12:00:00.000Z"),
        allowOwnerBoundChangedReleaseProof: true
      })
    ).not.toThrow();
    expect(() =>
      assertCourseSupportVerificationReleaseLane({
        currentRuntime: true,
        requestedReleaseSha: null,
        deployedAt: new Date("2026-08-27T12:00:00.000Z")
      })
    ).not.toThrow();
  });

  it("requires verify-release to consume the exact pre-push release fence", () => {
    expect(() =>
      assertCourseSupportPersistedReleaseFence({
        persistedReleaseSha: null,
        requestedReleaseSha: "a".repeat(40)
      })
    ).toThrow("persisted by the pre-push heartbeat");
    expect(() =>
      assertCourseSupportPersistedReleaseFence({
        persistedReleaseSha: "b".repeat(40),
        requestedReleaseSha: "a".repeat(40)
      })
    ).toThrow("persisted by the pre-push heartbeat");
    expect(() =>
      assertCourseSupportPersistedReleaseFence({
        persistedReleaseSha: "a".repeat(40),
        requestedReleaseSha: "a".repeat(40)
      })
    ).not.toThrow();
  });

  it("accepts only the bounded owner and deployment wait options", () => {
    expect(() =>
      assertCourseSupportVerifyReleaseOptions([
        "--batch-ref",
        "private-reference",
        "--release-sha",
        "a".repeat(40),
        "--deployment-timeout-seconds",
        "900",
      ]),
    ).not.toThrow();
    expect(() =>
      assertCourseSupportVerifyReleaseOptions([
        "--batch-ref",
        "private-reference",
        "--deployed-at",
        "2026-08-27T12:00:00.000Z",
      ]),
    ).toThrow("accepts only batch, release, owner, and deployment timing");
  });

  it("maps deployment failures to bounded durable checkpoint reasons", () => {
    expect(
      classifyCourseSupportDeploymentWaitFailure(
        new Error("Timed out after 900s waiting for the Git deployment"),
      ),
    ).toBe("DEPLOYMENT_TIMEOUT");
    expect(
      classifyCourseSupportDeploymentWaitFailure(
        new Error("Git deployment for abcdef12 ended with ERROR"),
      ),
    ).toBe("DEPLOYMENT_FAILED");
    expect(
      classifyCourseSupportDeploymentWaitFailure(
        new Error("Vercel CLI command failed with exit code 1."),
      ),
    ).toBe("DEPLOYMENT_TOOLING_FAILED");
  });

  it("builds stable privacy-safe verification tooling fingerprints", () => {
    const fingerprint =
      buildCourseSupportVerificationWatchToolingFingerprint({
        failureCode: "BATCH_VERIFICATION_FAILED",
        runtimeVersion: "a".repeat(40)
      });

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      buildCourseSupportVerificationWatchToolingFingerprint({
        failureCode: "BATCH_VERIFICATION_FAILED",
        runtimeVersion: "a".repeat(40)
      })
    ).toBe(fingerprint);
    expect(
      buildCourseSupportVerificationWatchToolingFingerprint({
        failureCode: "BATCH_VERIFICATION_FAILED",
        runtimeVersion: "b".repeat(40)
      })
    ).not.toBe(fingerprint);
  });
});

describe("course-support CLI database environment guard", () => {
  it.each([
    ["unset", {}],
    ["empty", { DATABASE_URL: "" }],
    ["whitespace", { DATABASE_URL: " \r\n\t" }],
    ["BOM-only", { DATABASE_URL: "\uFEFF \r\n" }]
  ])("rejects an %s explicit database URL", (_label, environment) => {
    expect(() => requireExplicitCourseSupportDatabaseUrl(environment)).toThrow(
      CourseSupportDatabaseEnvironmentError
    );
  });

  it("accepts and normalizes an explicitly configured database URL", async () => {
    const operation = vi.fn(async () => "accepted");

    await expect(
      runWithExplicitCourseSupportDatabaseUrl(
        { DATABASE_URL: "\uFEFF postgresql://db.example/teetimespot " },
        operation
      )
    ).resolves.toBe("accepted");
    expect(
      requireExplicitCourseSupportDatabaseUrl({
        DATABASE_URL: "\uFEFF postgresql://db.example/teetimespot "
      })
    ).toBe("postgresql://db.example/teetimespot");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("stops before the Prisma-backed worker gate when configuration is absent", async () => {
    const prismaWorkerGate = vi.fn(async () => true);

    await expect(
      runWithExplicitCourseSupportDatabaseUrl({}, prismaWorkerGate)
    ).rejects.toBeInstanceOf(CourseSupportDatabaseEnvironmentError);
    expect(prismaWorkerGate).not.toHaveBeenCalled();
  });

  it("classifies the guard as an aggregate ENV blocker", () => {
    const error = new CourseSupportDatabaseEnvironmentError();
    const result = buildCourseSupportCommandFailure(error);

    expect(classifyCommandFailure(error.message)).toBe("blocked_env");
    expect(result).toMatchObject({
      outcome: "blocked_env",
      failureDomain: "ENV",
      failureClass: COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS,
      durableCloseoutRecorded: false,
      threadDisposition: "KEEP_VISIBLE"
    });
    expect(JSON.stringify(result)).not.toContain("postgresql://");
  });

  it("classifies unverified responder release lineage as a deployment failure", () => {
    const result = buildCourseSupportCommandFailure(
      new CourseSupportReleaseLineageError()
    );

    expect(result).toMatchObject({
      outcome: "command_failed",
      failureDomain: "DEPLOYMENT",
      failureClass: COURSE_SUPPORT_RELEASE_LINEAGE_FAILURE_CLASS,
      durableCloseoutRecorded: false,
      threadDisposition: "KEEP_VISIBLE"
    });
  });
});

describe("course-support coverage machine output", () => {
  it("emits one compact stable aggregate-only schema v3 record", () => {
    const categoryKeys = [
      "MONITORED",
      "SUPPORTED_READY",
      "SUPPORTED_DEGRADED",
      "TECHNICAL_CONSTRAINT",
      "PHONE_OR_WALK_IN",
      "UNSUPPORTED_FAMILY",
      "SOURCE_UNVERIFIED",
      "PRIVATE_OR_INVALID"
    ];
    const recommendedActionKeys = [
      "RUN_TYPED_ADAPTER",
      "DISCOVER_WITH_HTTP",
      "DISCOVER_WITH_BROWSER",
      "VERIFY_TECHNICAL_CONSTRAINT",
      "RETRY_PROVIDER",
      "REPAIR_PROVIDER_ADAPTER",
      "FINAL_TECHNICAL_CONSTRAINT",
      "FINAL_MANUAL_BOOKING",
      "FINAL_PRIVATE_OR_INVALID"
    ];
    const claimActionKeys = [
      "VERIFY_CURRENT_RUNTIME",
      "SEARCH_FOR_OFFICIAL_SOURCE",
      "INSPECT_PROVIDER_CONTRACT",
      "IMPLEMENT_REUSABLE_SUPPORT",
      "COMPLETE_CLASSIFICATION",
      "WAIT_FOR_MATERIAL_CHANGE"
    ];
    const canaries = [
      "PRIVATE_PROVIDER_NAME_CANARY",
      "PRIVATE_PROVIDER_FAMILY_CANARY",
      "Private Course Name Canary",
      "PRIVATE_COURSE_REFERENCE_CANARY",
      "private-course-id-canary",
      "https://private-provider.example/course?id=private-id-canary",
      "private-batch-reference-canary",
      "private-task-reference-canary",
      "private-database-host-canary.neon.tech",
      "PRIVATE_PAYLOAD_CANARY"
    ];
    const actionMetric = {
      selectedCount: 0,
      confirmedExecutedCount: 0,
      executionUnavailableCount: 1,
      zeroExecutionCount: 0,
      nonzeroExecutionCount: 0,
      zeroExecutionUnavailableCount: 1,
      executedCount: null,
      executionAvailability: "unavailable",
      zeroExecutionTotal: null,
      providerName: canaries[0],
      taskRef: canaries[7],
      payload: canaries[9]
    };
    const record = buildCourseSupportCoverageMachineRecord({
      outcome: "ready",
      coverage: {
        schemaVersion: 3,
        observedAt: "2026-08-26T17:00:00.000Z",
        totalCourseCount: 0,
        eligibleCourseCount: 0,
        effectiveMonitoredCourseCount: 0,
        effectiveCoveragePercent: 0,
        categories: Object.fromEntries(
          categoryKeys.map((category) => [category, 0])
        ),
        recommendedActions: Object.fromEntries(
          recommendedActionKeys.map((action) => [action, 0])
        ),
        sourceUnverifiedFinalCandidateCount: 0,
        actionTelemetry: {
          schemaVersion: 1,
          windowDays: 30,
          windowStartedAt: "2026-07-27T17:00:00.000Z",
          windowEndedAt: "2026-08-26T17:00:00.000Z",
          completedBatchCount: 0,
          completedEntryCount: 0,
          selectedActionCount: 0,
          selectedActionUnavailableCount: 1,
          confirmedExecutedActionCount: 0,
          executedActionCount: null,
          executionUnavailableCount: 1,
          zeroExecutionCount: 0,
          nonzeroExecutionCount: 0,
          zeroExecutionTotal: null,
          zeroExecutionUnavailableCount: 1,
          actions: Object.fromEntries(
            claimActionKeys.map((action) => [action, actionMetric])
          ),
          batchRef: canaries[6],
          databaseHost: canaries[8],
          payload: canaries[9]
        },
        providerGroupCount: 1,
        providerGroupLimit: 25,
        omittedProviderGroupCount: 0,
        providerGroups: [
          {
            providerFamilyKey: canaries[1],
            courseCount: 1
          }
        ],
        providerName: canaries[0],
        courseName: canaries[2],
        courseRef: canaries[3],
        courseId: canaries[4],
        id: "private-id-canary",
        url: canaries[5],
        batchRef: canaries[6],
        taskRef: canaries[7],
        databaseHost: canaries[8],
        payload: canaries[9]
      }
    });
    const output = serializeCourseSupportResult(record, { machine: true });
    const parsed = JSON.parse(output);

    expect(output.trim().split("\n")).toHaveLength(1);
    expect(Object.keys(parsed)).toEqual([
      "outcome",
      "recordType",
      "schemaVersion",
      "coverage",
      "failure"
    ]);
    expect(parsed).toMatchObject({
      outcome: "ready",
      recordType: COURSE_SUPPORT_COVERAGE_MACHINE_RECORD_TYPE,
      schemaVersion: 1,
      failure: null
    });
    expect(Object.keys(parsed.coverage)).toEqual([
      "schemaVersion",
      "observedAt",
      "totalCourseCount",
      "eligibleCourseCount",
      "effectiveMonitoredCourseCount",
      "effectiveCoveragePercent",
      "categories",
      "recommendedActions",
      "sourceUnverifiedFinalCandidateCount",
      "actionTelemetry",
      "providerGroupCount",
      "providerGroupLimit",
      "omittedProviderGroupCount"
    ]);
    expect(Object.keys(parsed.coverage.categories)).toEqual(categoryKeys);
    expect(Object.keys(parsed.coverage.recommendedActions)).toEqual(
      recommendedActionKeys
    );
    expect(Object.keys(parsed.coverage.actionTelemetry.actions)).toEqual(
      claimActionKeys
    );
    expect(
      Object.keys(
        parsed.coverage.actionTelemetry.actions.VERIFY_CURRENT_RUNTIME
      )
    ).toEqual([
      "selectedCount",
      "confirmedExecutedCount",
      "executionUnavailableCount",
      "zeroExecutionCount",
      "nonzeroExecutionCount",
      "zeroExecutionUnavailableCount",
      "executedCount",
      "executionAvailability",
      "zeroExecutionTotal"
    ]);
    expect(parsed.coverage).toMatchObject({
      totalCourseCount: 0,
      eligibleCourseCount: 0,
      effectiveMonitoredCourseCount: 0,
      effectiveCoveragePercent: 0,
      actionTelemetry: {
        completedBatchCount: 0,
        selectedActionCount: 0,
        executedActionCount: null,
        zeroExecutionTotal: null,
        actions: {
          VERIFY_CURRENT_RUNTIME: {
            selectedCount: 0,
            executedCount: null,
            executionAvailability: "unavailable",
            zeroExecutionTotal: null
          }
        }
      },
      providerGroupCount: 1,
      providerGroupLimit: 25,
      omittedProviderGroupCount: 0
    });
    for (const canary of canaries) {
      expect(output).not.toContain(canary);
    }
    expect(output).not.toContain("private-id-canary");
    expect(output).not.toContain("providerFamilyKey");
    expect(output).not.toContain("providerGroups");
    expect(output).not.toContain("courseRef");
  });

  it("keeps a stable envelope when coverage is unavailable", () => {
    expect(
      buildCourseSupportCoverageMachineRecord({
        outcome: "paused_by_control_plane"
      })
    ).toEqual({
      outcome: "paused_by_control_plane",
      recordType: COURSE_SUPPORT_COVERAGE_MACHINE_RECORD_TYPE,
      schemaVersion: 1,
      coverage: null,
      failure: null
    });
  });

  it("does not forward an unknown machine outcome", () => {
    const outcomeCanary = "PRIVATE_COURSE_NAME_OUTCOME_CANARY";
    const record = buildCourseSupportCoverageMachineRecord({
      outcome: outcomeCanary
    });

    expect(record.outcome).toBe("command_failed");
    expect(JSON.stringify(record)).not.toContain(outcomeCanary);
  });

  it("projects failures through a strict aggregate-only allowlist", () => {
    const canaries = [
      "PRIVATE_PROVIDER_FAMILY_CANARY",
      "PRIVATE_COURSE_REFERENCE_CANARY",
      "Private Course Name Canary",
      "private-course-id-canary",
      "https://private-provider.example/course?id=private-id-canary",
      "private-batch-reference-canary",
      "private-task-reference-canary",
      "private-database-host-canary.neon.tech"
    ];
    const record = buildCourseSupportCoverageMachineRecord({
      outcome: "blocked_env",
      failure: {
        outcome: "blocked_env",
        failureDomain: "ENV",
        failureClass: COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS,
        durableCloseoutRecorded: false,
        threadDisposition: "KEEP_VISIBLE",
        archiveReason: canaries.join(" "),
        error: canaries.join(" "),
        providerFamilyKey: canaries[0],
        courseRef: canaries[1],
        courseName: canaries[2],
        courseId: canaries[3],
        id: "private-id-canary",
        url: canaries[4],
        batchRef: canaries[5],
        taskRef: canaries[6],
        databaseHost: canaries[7],
        nested: { payload: canaries }
      }
    });
    const output = serializeCourseSupportResult(record, { machine: true });

    expect(JSON.parse(output).failure).toEqual({
      failureDomain: "ENV",
      failureClass: COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS,
      durableCloseoutRecorded: false,
      threadDisposition: "KEEP_VISIBLE"
    });
    for (const canary of canaries) {
      expect(output).not.toContain(canary);
    }
    expect(output).not.toContain("private-id-canary");
  });

  it("preserves the human-readable default and validates machine flags", () => {
    expect(parseCourseSupportCoverageOptions([])).toEqual({ machine: false });
    expect(parseCourseSupportCoverageOptions(["--machine"])).toEqual({
      machine: true
    });
    expect(() =>
      parseCourseSupportCoverageOptions(["--machine", "--machine"])
    ).toThrow("--machine may be provided only once");
    const unknownOptionCanary =
      "--PRIVATE_PROVIDER_FAMILY_CANARY-Private_Course_Name_Canary-" +
      "private-course-id-canary-https://private.example/private-" +
      "batch-task-database-canary";
    expect(() =>
      parseCourseSupportCoverageOptions([unknownOptionCanary])
    ).toThrow("Unknown coverage option. Only --machine is supported.");
    try {
      parseCourseSupportCoverageOptions([unknownOptionCanary]);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(unknownOptionCanary);
    }
    expect(serializeCourseSupportResult({ outcome: "ready" })).toContain(
      '\n  "outcome": "ready"\n'
    );
  });

  it("exports the acceptance-history machine contract through the CLI", () => {
    const releaseSha = "a".repeat(40);
    const deployedAt = "2026-08-31T12:00:00.000Z";
    const windowEndedAt = "2026-08-31T13:00:00.000Z";
    expect(
      parseCourseSupportAcceptanceHistoryOptions([
        "--machine",
        "--release-sha",
        releaseSha,
        "--deployed-at",
        deployedAt,
        "--window-started-at",
        deployedAt,
        "--window-ended-at",
        windowEndedAt
      ])
    ).toEqual({
      machine: true,
      releaseSha,
      deployedAt: new Date(deployedAt),
      windowStartedAt: new Date(deployedAt),
      windowEndedAt: new Date(windowEndedAt)
    });

    expect(
      buildCourseSupportAcceptanceHistoryMachineRecord({
        outcome: "paused_by_control_plane"
      })
    ).toEqual({
      outcome: "paused_by_control_plane",
      recordType: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_RECORD_TYPE,
      schemaVersion: 2,
      acceptanceHistory: null,
      failure: null
    });
  });

  it("dispatches acceptance-history machine output through the paused worker gate", async () => {
    const releaseSha = "a".repeat(40);
    const deployedAt = "2026-08-31T12:00:00.000Z";
    const output: string[] = [];

    await runConfiguredCommand({
      argv: [
        "acceptance-history",
        "--machine",
        "--release-sha",
        releaseSha,
        "--deployed-at",
        deployedAt,
        "--window-started-at",
        deployedAt,
        "--window-ended-at",
        "2026-08-31T13:00:00.000Z",
      ],
      isWorkerExecutionAllowed: async () => false,
      write: (value, options) => {
        output.push(serializeCourseSupportResult(value, options));
      },
    });

    expect(output).toHaveLength(1);
    expect(output[0]?.split(/\r?\n/u).filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({
      outcome: "paused_by_control_plane",
      recordType: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_RECORD_TYPE,
      schemaVersion: 2,
      acceptanceHistory: null,
      failure: null,
    });
  });

  it("serializes a direct-entry database fence as one privacy-safe machine record", () => {
    const child = spawnSync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("scripts/automation/course-support.ts"),
        "acceptance-history",
        "--machine",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: " ",
        },
      },
    );

    expect(child.status).toBe(1);
    expect(child.stdout.split(/\r?\n/u).filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(child.stdout)).toEqual({
      outcome: "blocked_env",
      recordType: COURSE_SUPPORT_ACCEPTANCE_HISTORY_MACHINE_RECORD_TYPE,
      schemaVersion: 2,
      acceptanceHistory: null,
      failure: {
        failureDomain: "ENV",
        failureClass: COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS,
        durableCloseoutRecorded: false,
        threadDisposition: "KEEP_VISIBLE",
      },
    });
  });
});
