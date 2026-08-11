import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  appendAutomationPlaybookEvent,
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

describe("selectOwnedCourseSupportBrowserStageTargets", () => {
  it("keeps an owned automation-stalled customer course eligible for its browser stage", () => {
    expect(
      selectOwnedCourseSupportBrowserStageTargets({
        batchId: "batch-1",
        entries: [
          {
            courseId: "course-1",
            cycle: 1,
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
  });

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

  it("does not invoke the persisted browser runner before the release fence exists", async () => {
    const runBrowserProbe = vi.fn();

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi.fn().mockResolvedValue(
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
  ])("does not invoke the browser runner for a mismatched $name fence", async ({
    batch,
    expected,
  }) => {
    const runBrowserProbe = vi.fn();

    await expect(
      persistOwnedCourseSupportBrowserPlaybookStages(input, {
        loadBatch: vi.fn().mockResolvedValue(batch),
        runBrowserProbe,
      }),
    ).rejects.toThrow(expected);
    expect(runBrowserProbe).not.toHaveBeenCalled();
  });

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
        deferTerminalCloseout: true,
        persistSearchProbe: false,
      }),
    );
    expect(searchSuccess).toHaveBeenCalledOnce();
    expect(factualMutation).not.toHaveBeenCalled();
    expect(staleSearchProbe).not.toHaveBeenCalled();
  });
});
