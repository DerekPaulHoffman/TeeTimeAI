import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  appendAutomationPlaybookEvent,
  assessAutomationPlaybook,
  type AutomationPlaybookEventInput,
  type AutomationPlaybookLedger,
} from "./course-monitoring-playbook";
import {
  persistOwnedCourseSupportBrowserPlaybookStages,
  runCourseSupportBrowserPersistenceWrite,
  runGuardedCourseSupportBrowserMutation,
  selectOwnedCourseSupportBrowserStageTargets,
  type CourseSupportBrowserStageBatch,
} from "./course-support-browser-stages";
import {
  getCourseSupportVerificationWatchFailureCode,
  runCourseSupportVerificationPass,
  runCourseSupportVerificationWatch,
} from "./course-support-verification-watch";

const runtimeVersion = "a".repeat(40);

function ledger(events: AutomationPlaybookEventInput[]) {
  let result: AutomationPlaybookLedger | null = null;
  for (const event of events) {
    result = appendAutomationPlaybookEvent(result, event);
  }
  return result;
}

function completedStage(
  stage: AutomationPlaybookEventInput["stage"],
  readPath: AutomationPlaybookEventInput["readPath"],
): AutomationPlaybookEventInput {
  return {
    cycle: 1,
    stage,
    transition: "COMPLETED",
    readPath,
    evidenceKind:
      stage === "RENDERED_BROWSER_DISCOVERY"
        ? "RENDERED_PAGE"
        : "OFFICIAL_SOURCE",
    failureFingerprint: `PLAYBOOK:${stage}:COMPLETED`,
    runtimeVersion,
  };
}

const throughHttpRetry = [
  completedStage("OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"),
  {
    ...completedStage("TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"),
    transition: "NOT_APPLICABLE" as const,
    evidenceKind: "TOOLING" as const,
    skipReason: "NO_RUNNABLE_ADAPTER" as const,
  },
  completedStage("OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"),
  {
    ...completedStage("HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"),
    transition: "NOT_APPLICABLE" as const,
    evidenceKind: "TOOLING" as const,
    skipReason: "NO_RUNNABLE_ADAPTER" as const,
  },
] satisfies AutomationPlaybookEventInput[];

function ownedBrowserBatch(
  overrides: Partial<CourseSupportBrowserStageBatch> = {},
): CourseSupportBrowserStageBatch {
  return {
    releaseSha: runtimeVersion,
    deployedAt: new Date("2026-07-21T11:50:00.000Z"),
    incidents: [
      {
        courseId: "course-1",
        cycle: 1,
        result: "PENDING",
        incident: {
          id: "incident-1",
          cycle: 1,
          status: "AUTO_INVESTIGATING",
          activeBatchId: "batch-1",
          attemptLedger: ledger(throughHttpRetry),
        },
      },
    ],
    ...overrides,
  };
}

function browserPersistenceFence() {
  return {
    batchId: "batch-1",
    leaseToken: "lease-1",
    ownerThreadId: "thread-1",
    releaseSha: runtimeVersion,
    deployedAt: new Date("2026-07-21T11:50:00.000Z"),
    runtimeVersion,
    incidentId: "incident-1",
    courseId: "course-1",
    cycle: 1,
    stage: "RENDERED_BROWSER_DISCOVERY" as const,
  };
}

function ownedBrowserPersistenceTransaction(result: string) {
  return {
    courseSupportIncident: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({
        cycle: 1,
        attemptLedger: ledger(throughHttpRetry),
      }),
    },
    courseSupportBatch: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    courseSupportBatchIncident: {
      findUnique: vi.fn().mockResolvedValue({
        courseId: "course-1",
        cycle: 1,
        result,
      }),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("selectOwnedCourseSupportBrowserStageTargets", () => {
  it.each(["PENDING", "STALE_EVIDENCE", "RETRY_SCHEDULED"])(
    "keeps an owned %s member eligible for its current browser stage",
    (result) => {
      expect(
        selectOwnedCourseSupportBrowserStageTargets({
          batchId: "batch-1",
          entries: [
            {
              courseId: "course-1",
              cycle: 1,
              result,
              incident: {
                id: "incident-1",
                cycle: 1,
                status: "AUTO_INVESTIGATING",
                activeBatchId: "batch-1",
                attemptLedger: ledger(throughHttpRetry),
              },
            },
          ],
        }),
      ).toEqual([
        {
          ordinal: 1,
          courseId: "course-1",
          stage: "RENDERED_BROWSER_DISCOVERY",
        },
      ]);
    },
  );

  it.each(["RESTORED", "FINAL_DISPOSITION", "NEEDS_HUMAN"])(
    "keeps terminal %s members out of owner-browser selection",
    (result) => {
      expect(
        selectOwnedCourseSupportBrowserStageTargets({
          batchId: "batch-1",
          entries: [
            {
              courseId: "course-1",
              cycle: 1,
              result,
              incident: {
                id: "incident-1",
                cycle: 1,
                status: "AUTO_INVESTIGATING",
                activeBatchId: "batch-1",
                attemptLedger: ledger(throughHttpRetry),
              },
            },
          ],
        }),
      ).toEqual([]);
    },
  );

  it("selects independent browser confirmation only after the reader is terminal", () => {
    const attemptLedger = ledger([
      ...throughHttpRetry,
      {
        cycle: 1,
        stage: "RENDERED_BROWSER_DISCOVERY",
        transition: "TECHNICAL_LIMITATION",
        readPath: "RENDERED_BROWSER",
        evidenceKind: "RENDERED_PAGE",
        technicalReason: "CAPTCHA_OR_QUEUE",
        failureFingerprint:
          "PLAYBOOK:RENDERED_BROWSER_DISCOVERY:CAPTCHA_OR_QUEUE",
        runtimeVersion,
      },
      {
        cycle: 1,
        stage: "BROWSER_ADAPTER_RETRY",
        transition: "FAILED_TERMINAL",
        readPath: "TYPED_PROVIDER_ADAPTER",
        evidenceKind: "PROVIDER_RESPONSE",
        failureClass: "CHALLENGE",
        failureFingerprint: "PLAYBOOK:BROWSER_ADAPTER_RETRY:CHALLENGE",
        runtimeVersion,
      },
      {
        cycle: 1,
        stage: "LOCAL_READER",
        transition: "TECHNICAL_LIMITATION",
        readPath: "LOCAL_READER",
        evidenceKind: "LOCAL_READER_RESULT",
        technicalReason: "CAPTCHA_OR_QUEUE",
        failureFingerprint: "PLAYBOOK:LOCAL_READER:CAPTCHA_OR_QUEUE",
        runtimeVersion: "reader-v1",
      },
    ]);

    expect(
      selectOwnedCourseSupportBrowserStageTargets({
        batchId: "batch-1",
        entries: [
          {
            courseId: "course-1",
            cycle: 1,
            result: "PENDING",
            incident: {
              id: "incident-1",
              cycle: 1,
              status: "AUTO_INVESTIGATING",
              activeBatchId: "batch-1",
              attemptLedger,
            },
          },
        ],
      }),
    ).toEqual([
      {
        ordinal: 1,
        courseId: "course-1",
        stage: "INDEPENDENT_CONFIRMATION",
      },
    ]);
  });

  it("rejects stale cycles, foreign ownership, and non-browser stages", () => {
    expect(
      selectOwnedCourseSupportBrowserStageTargets({
        batchId: "batch-1",
        entries: [
          {
            courseId: "foreign",
            cycle: 1,
            result: "PENDING",
            incident: {
              id: "incident-foreign",
              cycle: 1,
              status: "AUTO_INVESTIGATING",
              activeBatchId: "batch-2",
              attemptLedger: ledger(throughHttpRetry),
            },
          },
          {
            courseId: "stale",
            cycle: 1,
            result: "PENDING",
            incident: {
              id: "incident-stale",
              cycle: 2,
              status: "AUTO_INVESTIGATING",
              activeBatchId: "batch-1",
              attemptLedger: ledger(throughHttpRetry),
            },
          },
          {
            courseId: "not-ready",
            cycle: 1,
            result: "PENDING",
            incident: {
              id: "incident-not-ready",
              cycle: 1,
              status: "AUTO_INVESTIGATING",
              activeBatchId: "batch-1",
              attemptLedger: ledger([
                completedStage("OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"),
              ]),
            },
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("persistOwnedCourseSupportBrowserPlaybookStages", () => {
  const input = {
    batchId: "batch-1",
    leaseToken: "lease-1",
    ownerThreadId: "thread-1",
    requestedReleaseSha: runtimeVersion,
    requestedDeployedAt: new Date("2026-07-21T11:50:00.000Z"),
    now: new Date("2026-07-21T12:00:00.000Z"),
  };

  it("preserves the batch-load failure origin through the verification pass", async () => {
    const privateCanary = "must-not-persist-batch-load-cause";
    let thrown: unknown;

    try {
      await runCourseSupportVerificationPass({
        persistBrowserStages: () =>
          persistOwnedCourseSupportBrowserPlaybookStages(input, {
            loadBatch: vi.fn().mockRejectedValue(new Error(privateCanary)),
            runBrowserProbe: vi.fn()
          }),
        verifyBatch: vi.fn()
      });
    } catch (error) {
      thrown = error;
    }

    expect(getCourseSupportVerificationWatchFailureCode(thrown)).toBe(
      "BROWSER_STAGE_BATCH_LOAD_FAILED"
    );
    expect(JSON.stringify(thrown)).not.toContain(privateCanary);
  });

  it("preserves the release-provenance failure origin through the verification pass", async () => {
    const privateCanary = "must-not-persist-provenance-cause";
    const runBrowserProbe = vi.fn();
    let thrown: unknown;

    try {
      await runCourseSupportVerificationPass({
        persistBrowserStages: () =>
          persistOwnedCourseSupportBrowserPlaybookStages(input, {
            loadBatch: vi.fn().mockResolvedValue(ownedBrowserBatch()),
            validateReleaseFence: vi
              .fn()
              .mockRejectedValue(new Error(privateCanary)),
            runBrowserProbe
          }),
        verifyBatch: vi.fn()
      });
    } catch (error) {
      thrown = error;
    }

    expect(getCourseSupportVerificationWatchFailureCode(thrown)).toBe(
      "BROWSER_STAGE_PROVENANCE_FAILED"
    );
    expect(JSON.stringify(thrown)).not.toContain(privateCanary);
    expect(runBrowserProbe).not.toHaveBeenCalled();
  });

  it("runs every rendered stage in a three-entry depth-four owned batch", async () => {
    const current = ownedBrowserBatch({
      incidents: Array.from({ length: 3 }, (_, index) => ({
        courseId: `course-${index + 1}`,
        cycle: 1,
        result: "PENDING",
        incident: {
          id: `incident-${index + 1}`,
          cycle: 1,
          status: "AUTO_INVESTIGATING",
          activeBatchId: "batch-1",
          attemptLedger: ledger(throughHttpRetry),
        },
      })),
    });
    const runBrowserProbe = vi.fn(async () => ({ persistedCount: 1 }));

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi.fn().mockResolvedValue(current),
        runBrowserProbe,
      }),
    ).resolves.toMatchObject({
      releaseFenceReady: true,
      eligibleCount: 3,
      persistedCount: 3,
      renderedDiscoveryCount: 3,
      independentConfirmationCount: 0,
    });
    expect(runBrowserProbe).toHaveBeenCalledTimes(3);
    expect(runBrowserProbe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ courseId: "course-1", mode: "RENDERED" }),
    );
    expect(runBrowserProbe).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ courseId: "course-3", mode: "RENDERED" }),
    );
  });

  it("advances two browser successes without replacing newer runnable projections or re-probing settled members", async () => {
    const current = ownedBrowserBatch({
      incidents: Array.from({ length: 2 }, (_, index) => ({
        courseId: `course-${index + 1}`,
        cycle: 1,
        result: "PENDING",
        incident: {
          id: `incident-${index + 1}`,
          cycle: 1,
          status: "AUTO_INVESTIGATING",
          activeBatchId: "batch-1",
          attemptLedger: ledger(throughHttpRetry),
        },
      })),
    });
    const runnableCourseProjections = new Map(
      current.incidents.map((entry) => [
        entry.courseId,
        { automationEligibility: "ALLOWED", automationReason: "NONE" },
      ]),
    );
    const durableBrowserEvidence: Array<{
      courseId: string;
      cycle: number;
      runtimeVersion: string;
    }> = [];
    const loadBatch = vi.fn(async () => current);
    const runBrowserProbe = vi.fn(
      async ({ courseId, beforePersist, persistenceFence }) => {
        await beforePersist();
        const entry = current.incidents.find(
          (candidate) => candidate.courseId === courseId,
        );
        expect(entry).toBeDefined();
        expect(runnableCourseProjections.get(courseId)).toEqual({
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
        });

        durableBrowserEvidence.push({
          courseId,
          cycle: persistenceFence.cycle,
          runtimeVersion: persistenceFence.runtimeVersion,
        });
        entry!.incident.attemptLedger = appendAutomationPlaybookEvent(
          entry!.incident.attemptLedger,
          {
            cycle: persistenceFence.cycle,
            stage: "RENDERED_BROWSER_DISCOVERY",
            transition: "COMPLETED",
            readPath: "RENDERED_BROWSER",
            evidenceKind: "RENDERED_PAGE",
            failureFingerprint: "PLAYBOOK:RENDERED_BROWSER_DISCOVERY:COMPLETED",
            runtimeVersion: persistenceFence.runtimeVersion,
          },
        );
        entry!.result = "RETRY_SCHEDULED";
        return { persistedCount: 1 };
      },
    );

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch,
        runBrowserProbe,
      }),
    ).resolves.toMatchObject({
      eligibleCount: 2,
      persistedCount: 2,
      renderedDiscoveryCount: 2,
    });

    expect(durableBrowserEvidence).toEqual([
      { courseId: "course-1", cycle: 1, runtimeVersion },
      { courseId: "course-2", cycle: 1, runtimeVersion },
    ]);
    expect(
      current.incidents.map((entry) => ({
        result: entry.result,
        nextStage: assessAutomationPlaybook(
          entry.incident.attemptLedger,
          entry.cycle,
        ).nextStage,
      })),
    ).toEqual([
      { result: "RETRY_SCHEDULED", nextStage: "BROWSER_ADAPTER_RETRY" },
      { result: "RETRY_SCHEDULED", nextStage: "BROWSER_ADAPTER_RETRY" },
    ]);
    expect([...runnableCourseProjections.values()]).toEqual([
      { automationEligibility: "ALLOWED", automationReason: "NONE" },
      { automationEligibility: "ALLOWED", automationReason: "NONE" },
    ]);

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch,
        runBrowserProbe,
      }),
    ).resolves.toEqual({
      releaseFenceReady: true,
      eligibleCount: 0,
      persistedCount: 0,
      renderedDiscoveryCount: 0,
      independentConfirmationCount: 0,
    });
    expect(runBrowserProbe).toHaveBeenCalledTimes(2);
  });

  it("runs every active owner-stage result and excludes terminal members in a mixed batch", async () => {
    const results = [
      "PENDING",
      "STALE_EVIDENCE",
      "RETRY_SCHEDULED",
      "RESTORED",
      "FINAL_DISPOSITION",
      "NEEDS_HUMAN",
    ];
    const current = ownedBrowserBatch({
      incidents: results.map((result, index) => ({
        courseId: `course-${index + 1}`,
        cycle: 1,
        result,
        incident: {
          id: `incident-${index + 1}`,
          cycle: 1,
          status: "AUTO_INVESTIGATING",
          activeBatchId: "batch-1",
          attemptLedger: ledger(throughHttpRetry),
        },
      })),
    });
    const runBrowserProbe = vi.fn(async () => ({ persistedCount: 1 }));

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi.fn().mockResolvedValue(current),
        runBrowserProbe,
      }),
    ).resolves.toMatchObject({ eligibleCount: 3, persistedCount: 3 });

    expect(runBrowserProbe).toHaveBeenCalledTimes(3);
    expect(
      runBrowserProbe.mock.calls.map(([call]) => call.courseId),
    ).toEqual(["course-1", "course-2", "course-3"]);
  });

  it("advances a stale browser projection once and does not re-probe its completed stage", async () => {
    const current = ownedBrowserBatch({
      incidents: [
        {
          ...ownedBrowserBatch().incidents[0],
          result: "STALE_EVIDENCE",
        },
      ],
    });
    const runBrowserProbe = vi.fn(
      async ({ beforePersist, persistenceFence }) => {
        await beforePersist();
        current.incidents[0].incident.attemptLedger =
          appendAutomationPlaybookEvent(
            current.incidents[0].incident.attemptLedger,
            {
              cycle: persistenceFence.cycle,
              stage: "RENDERED_BROWSER_DISCOVERY",
              transition: "COMPLETED",
              readPath: "RENDERED_BROWSER",
              evidenceKind: "RENDERED_PAGE",
              failureFingerprint:
                "PLAYBOOK:RENDERED_BROWSER_DISCOVERY:COMPLETED",
              runtimeVersion: persistenceFence.runtimeVersion,
            },
          );
        return { persistedCount: 1 };
      },
    );

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi.fn(async () => current),
        runBrowserProbe,
      }),
    ).resolves.toMatchObject({ eligibleCount: 1, persistedCount: 1 });
    expect(
      assessAutomationPlaybook(
        current.incidents[0].incident.attemptLedger,
        1,
      ).nextStage,
    ).toBe("BROWSER_ADAPTER_RETRY");

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi.fn(async () => current),
        runBrowserProbe,
      }),
    ).resolves.toMatchObject({ eligibleCount: 0, persistedCount: 0 });
    expect(runBrowserProbe).toHaveBeenCalledOnce();
  });

  it("runs a detached retry's newly exposed browser stage in the same watched batch", async () => {
    const current = ownedBrowserBatch({
      incidents: [
        {
          ...ownedBrowserBatch().incidents[0],
          incident: {
            ...ownedBrowserBatch().incidents[0].incident,
            attemptLedger: ledger(throughHttpRetry.slice(0, -1)),
          },
        },
      ],
    });
    let verificationCount = 0;
    const observedBatchIds: string[] = [];
    const runBrowserProbe = vi.fn(
      async ({ beforePersist, persistenceFence }) => {
        observedBatchIds.push(persistenceFence.batchId);
        await beforePersist();
        current.incidents[0].incident.attemptLedger =
          appendAutomationPlaybookEvent(
            current.incidents[0].incident.attemptLedger,
            {
              cycle: persistenceFence.cycle,
              stage: "RENDERED_BROWSER_DISCOVERY",
              transition: "FACTUAL_FINAL",
              readPath: "RENDERED_BROWSER",
              evidenceKind: "RENDERED_PAGE",
              factualDisposition: "MANUAL_DIRECT",
              failureFingerprint: "BROWSER:MANUAL_DIRECT",
              runtimeVersion: persistenceFence.runtimeVersion,
            },
          );
        return { persistedCount: 1 };
      },
    );
    const pass = vi.fn(() =>
      runCourseSupportVerificationPass({
        persistBrowserStages: () =>
          persistOwnedCourseSupportBrowserPlaybookStages(input, {
            loadBatch: vi.fn(async () => current),
            runBrowserProbe,
          }),
        verifyBatch: async () => {
          verificationCount += 1;
          if (verificationCount === 1) {
            current.incidents[0].incident.attemptLedger =
              appendAutomationPlaybookEvent(
                current.incidents[0].incident.attemptLedger,
                throughHttpRetry[throughHttpRetry.length - 1],
              );
            current.incidents[0].result = "RETRY_SCHEDULED";
            return { detachedVerification: { rerunNeeded: true } };
          }
          if (verificationCount === 2) {
            current.incidents[0].result = "FINAL_DISPOSITION";
          }
          return { detachedVerification: { rerunNeeded: false } };
        },
      }),
    );
    const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    const result = await runCourseSupportVerificationWatch({
      pass,
      closeout,
      sleep: async () => undefined,
    });

    expect(result.passCount).toBe(4);
    expect(runBrowserProbe).toHaveBeenCalledOnce();
    expect(observedBatchIds).toEqual(["batch-1"]);
    expect(closeout).toHaveBeenCalledOnce();
    expect(
      assessAutomationPlaybook(
        current.incidents[0].incident.attemptLedger,
        1,
      ).nextStage,
    ).toBeNull();
    expect(current.incidents[0].result).toBe("FINAL_DISPOSITION");
  });

  it("does not invoke the persisted browser runner before the release fence exists", async () => {
    const runBrowserProbe = vi.fn();

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi
          .fn()
          .mockResolvedValue(
            ownedBrowserBatch({ releaseSha: null, deployedAt: null }),
          ),
        runBrowserProbe,
      }),
    ).resolves.toEqual({
      releaseFenceReady: false,
      eligibleCount: 0,
      persistedCount: 0,
      renderedDiscoveryCount: 0,
      independentConfirmationCount: 0,
    });
    expect(runBrowserProbe).not.toHaveBeenCalled();
  });

  it("fails closed when a persisted unchanged release lacks deployment proof", async () => {
    const runBrowserProbe = vi.fn();

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi
          .fn()
          .mockResolvedValue(ownedBrowserBatch({ deployedAt: null })),
        runBrowserProbe,
      }),
    ).rejects.toThrow("requires trusted deployment proof");
    expect(runBrowserProbe).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "release SHA",
      batch: ownedBrowserBatch({ releaseSha: "b".repeat(40) }),
      expected: "Release SHA does not match",
    },
    {
      name: "deployment time",
      batch: ownedBrowserBatch({
        deployedAt: new Date("2026-07-21T11:49:00.000Z"),
      }),
      expected: "Deployment time does not match",
    },
  ])(
    "does not invoke the browser runner for a mismatched $name fence",
    async ({ batch, expected }) => {
      const runBrowserProbe = vi.fn();

      await expect(
        persistOwnedCourseSupportBrowserPlaybookStages(input, {
          loadBatch: vi.fn().mockResolvedValue(batch),
          runBrowserProbe,
        }),
      ).rejects.toThrow(expected);
      expect(runBrowserProbe).not.toHaveBeenCalled();
    },
  );

  it("blocks downstream classification and probe writes when ownership changes after the stage transition", async () => {
    const current = ownedBrowserBatch();
    const changed = ownedBrowserBatch({
      incidents: [
        {
          ...current.incidents[0],
          incident: {
            ...current.incidents[0].incident,
            activeBatchId: null,
          },
        },
      ],
    });
    const loadBatch = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(changed);
    const downstreamMutation = vi.fn().mockResolvedValue(undefined);
    const runBrowserProbe = vi.fn(async ({ beforePersist }) => {
      await beforePersist();
      await runGuardedCourseSupportBrowserMutation({
        courseId: "course-1",
        requireCurrentStage: false,
        beforePersist: ({ requireCurrentStage }) =>
          beforePersist({ requireCurrentStage }),
        mutate: downstreamMutation,
      });
      return { persistedCount: 1 };
    });

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch,
        runBrowserProbe,
      }),
    ).rejects.toThrow("lost current course ownership");
    expect(runBrowserProbe).toHaveBeenCalledTimes(1);
    expect(downstreamMutation).not.toHaveBeenCalled();
  });

  it.each(["RESTORED", "FINAL_DISPOSITION", "NEEDS_HUMAN"])(
    "rejects a pre-persist result race to %s",
    async (result) => {
      const current = ownedBrowserBatch({
        incidents: [
          {
            ...ownedBrowserBatch().incidents[0],
            result: "RETRY_SCHEDULED",
          },
        ],
      });
      const terminal = ownedBrowserBatch({
        incidents: [{ ...current.incidents[0], result }],
      });
      const loadBatch = vi
        .fn()
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(terminal);
      const downstreamMutation = vi.fn();
      const runBrowserProbe = vi.fn(async ({ beforePersist }) => {
        await beforePersist();
        downstreamMutation();
        return { persistedCount: 1 };
      });

      await expect(
        persistOwnedCourseSupportBrowserPlaybookStages(input, {
          loadBatch,
          runBrowserProbe,
        }),
      ).rejects.toThrow("lost current course ownership");
      expect(downstreamMutation).not.toHaveBeenCalled();
    },
  );

  it("blocks discovery, course, and ledger writes after a handoff that follows the precheck", async () => {
    const current = ownedBrowserBatch();
    const discoveryWrite = vi.fn().mockResolvedValue(undefined);
    const courseWrite = vi.fn().mockResolvedValue(undefined);
    const ledgerWrite = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      courseSupportIncident: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      courseSupportBatch: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      courseSupportBatchIncident: {
        findUnique: vi.fn(),
      },
    } as unknown as Prisma.TransactionClient;
    const runBrowserProbe = vi.fn(
      async ({ beforePersist, persistenceFence }) => {
        await beforePersist();
        for (const mutate of [discoveryWrite, courseWrite, ledgerWrite]) {
          await expect(
            runCourseSupportBrowserPersistenceWrite({
              transaction,
              fence: persistenceFence,
              mutate,
            }),
          ).rejects.toThrow("lost current incident ownership");
        }
        return { persistedCount: 0 };
      },
    );

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi.fn().mockResolvedValue(current),
        runBrowserProbe,
      }),
    ).resolves.toMatchObject({ persistedCount: 0 });

    expect(runBrowserProbe).toHaveBeenCalledOnce();
    expect(discoveryWrite).not.toHaveBeenCalled();
    expect(courseWrite).not.toHaveBeenCalled();
    expect(ledgerWrite).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "STALE_EVIDENCE", "RETRY_SCHEDULED"])(
    "permits a transaction write for an active owned %s member",
    async (result) => {
      const mutate = vi.fn(async () => "persisted");
      const transaction = ownedBrowserPersistenceTransaction(result);

      await expect(
        runCourseSupportBrowserPersistenceWrite({
          transaction,
          fence: browserPersistenceFence(),
          mutate,
        }),
      ).resolves.toBe("persisted");
      expect(mutate).toHaveBeenCalledOnce();
    },
  );

  it.each(["RESTORED", "FINAL_DISPOSITION", "NEEDS_HUMAN"])(
    "rejects a transaction result race to %s",
    async (result) => {
      const mutate = vi.fn();
      const transaction = ownedBrowserPersistenceTransaction(result);

      await expect(
        runCourseSupportBrowserPersistenceWrite({
          transaction,
          fence: browserPersistenceFence(),
          mutate,
        }),
      ).rejects.toThrow("stage ownership changed inside persistence");
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it("defers factual closeout and search probes so a newer workflow success remains authoritative", async () => {
    const current = ownedBrowserBatch();
    const searchSuccess = vi.fn();
    const factualMutation = vi.fn();
    const staleSearchProbe = vi.fn();
    const runBrowserProbe = vi.fn(
      async ({ beforePersist, deferTerminalCloseout, persistSearchProbe }) => {
        await beforePersist();
        searchSuccess();
        if (!deferTerminalCloseout) {
          factualMutation();
        }
        if (persistSearchProbe) {
          staleSearchProbe();
        }
        return { persistedCount: 1 };
      },
    );

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi.fn().mockResolvedValue(current),
        runBrowserProbe,
      }),
    ).resolves.toMatchObject({ persistedCount: 1 });

    expect(runBrowserProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "course-1",
        mode: "RENDERED",
        deferTerminalCloseout: true,
        persistSearchProbe: false,
      }),
    );
    expect(searchSuccess).toHaveBeenCalledOnce();
    expect(factualMutation).not.toHaveBeenCalled();
    expect(staleSearchProbe).not.toHaveBeenCalled();
  });
});
