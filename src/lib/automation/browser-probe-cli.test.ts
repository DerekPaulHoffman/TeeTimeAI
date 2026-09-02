import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginPersistedBrowserProviderObservation,
  classifyPersistableBrowserStageFailure,
  closeBrowserProbeResourceOnAbort,
  createBrowserProbeResourceCloser,
  finishBrowserProbeAutomationRunAfterFailure,
  getPersistableBrowserOperationFailure,
  getFreshRenderedCorroborationEvidence,
  prepareBrowserProbeTargetResources,
  recordOwnedBrowserStageAfterCourseProjection,
  resolveBrowserInvestigationMode,
  resolveBrowserProbeRuntimeVersion,
  resolveBrowserProbeTargetSelection,
  runAbortAwareBrowserOperation,
  runBrowserProbeCli,
  runPersistableBrowserOperation
} from "../../../scripts/automation/browser-probe-needed-adapters";
import { getAutomationRuntimeVersion } from "./runtime-version";
import { runWithProviderRequestLease } from "./provider-request-lease";

const releaseSha = "a".repeat(40);
const persistenceFence = {
  batchId: "batch-1",
  leaseToken: "lease-1",
  ownerThreadId: "thread-1",
  releaseSha,
  deployedAt: new Date("2026-07-21T11:50:00.000Z"),
  runtimeVersion: releaseSha,
  incidentId: "incident-1",
  courseId: "course-1",
  cycle: 1,
  stage: "RENDERED_BROWSER_DISCOVERY" as const,
};

const providerObservationLease = {
  courseId: "course-1",
  leaseToken: "provider-observation-1",
  observationStartedAt: new Date("2026-08-20T12:00:00.000Z"),
  leaseExpiresAt: new Date("2026-08-20T12:20:00.000Z"),
  ttlMs: 20 * 60_000,
  supersededUnresolvedObservationStartedAt: null,
};

describe("browser probe direct entry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a mutating direct invocation before the browser runner can write", async () => {
    const runner = vi.fn();

    await expect(
      runBrowserProbeCli(["--course-id", "course-1"], runner),
    ).rejects.toThrow("diagnostic-only");

    expect(runner).not.toHaveBeenCalled();
  });

  it("allows only diagnostic dry runs with terminal and search writes disabled", async () => {
    const runner = vi.fn().mockResolvedValue({
      targetCount: 1,
      persistedCount: 0,
    });

    await expect(
      runBrowserProbeCli(
        ["--dry-run", "--course-id", "course-1", "--limit", "1"],
        runner,
      ),
    ).resolves.toEqual({ targetCount: 1, persistedCount: 0 });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        deferTerminalCloseout: true,
        persistSearchProbe: false,
      }),
    );
  });

  it("uses the owned release SHA when local dispatch has no Vercel runtime identity", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");

    expect(getAutomationRuntimeVersion()).toBe("local");
    expect(
      resolveBrowserProbeRuntimeVersion(
        getAutomationRuntimeVersion(),
        persistenceFence,
      ),
    ).toBe(releaseSha);
  });

  it("rejects an explicit real runtime that conflicts with the owned release", () => {
    expect(() =>
      resolveBrowserProbeRuntimeVersion("b".repeat(40), persistenceFence),
    ).toThrow("does not match the owned batch release");
  });

  it("uses distinct rendered and independent investigation modes from the ordered stage", () => {
    expect(resolveBrowserInvestigationMode({ persistenceFence })).toBe(
      "RENDERED",
    );
    expect(
      resolveBrowserInvestigationMode({
        persistenceFence: {
          ...persistenceFence,
          stage: "INDEPENDENT_CONFIRMATION",
        },
      }),
    ).toBe("INDEPENDENT");
  });

  it("retains a rendered provider source when execution finishes before canonical apply", async () => {
    const markUnreconciled = vi.fn(async () => true);
    const release = vi.fn(async () => undefined);
    const observation = await beginPersistedBrowserProviderObservation(
      "course-1",
      {
        begin: vi.fn(async () => ({ ...providerObservationLease })),
        markUnreconciled,
        release,
        renewInTransaction: vi.fn(async () => true),
        startHeartbeat: vi.fn(() => ({
          assertOwned: vi.fn(),
          stop: vi.fn(async () => undefined),
        })),
      }
    );

    observation!.markProviderExecutionStarted();
    await observation!.settle();

    expect(markUnreconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        observationStartedAt: providerObservationLease.observationStartedAt,
      })
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("retains a rendered source after snapshot-bound metadata persistence until availability is reconciled", async () => {
    const markUnreconciled = vi.fn(async () => true);
    const release = vi.fn(async () => undefined);
    const observation = await beginPersistedBrowserProviderObservation(
      "course-1",
      {
        begin: vi.fn(async () => ({ ...providerObservationLease })),
        markUnreconciled,
        release,
        renewInTransaction: vi.fn(async () => true),
        startHeartbeat: vi.fn(() => ({
          assertOwned: vi.fn(),
          stop: vi.fn(async () => undefined),
        })),
      },
    );

    observation!.markProviderExecutionStarted();
    observation!.assertObservationOwned();
    // A snapshot-bound course/discovery write is metadata persistence. It does
    // not reconcile the rendered availability source into monitoring/matches.
    await observation!.settle();

    expect(markUnreconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        observationStartedAt: providerObservationLease.observationStartedAt,
      }),
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("rejects persistence when a successor takes the rendered observation lease after the heartbeat check", async () => {
    const assertOwned = vi.fn();
    const renewInTransaction = vi.fn(async () => false);
    const observation = await beginPersistedBrowserProviderObservation(
      "course-1",
      {
        begin: vi.fn(async () => ({ ...providerObservationLease })),
        markUnreconciled: vi.fn(async () => true),
        release: vi.fn(async () => undefined),
        renewInTransaction,
        startHeartbeat: vi.fn(() => ({
          assertOwned,
          stop: vi.fn(async () => undefined),
        })),
      },
    );

    observation!.markProviderExecutionStarted();
    await expect(
      observation!.assertObservationOwnedInTransaction({} as never),
    ).rejects.toThrow(
      "Rendered provider observation ownership expired before persistence completed",
    );

    expect(assertOwned).toHaveBeenCalledOnce();
    expect(renewInTransaction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ leaseToken: "provider-observation-1" }),
    );
    await observation!.settle();
  });

  it("preserves a superseded unresolved source when the browser provider never starts", async () => {
    const supersededAt = new Date("2026-08-20T11:55:00.000Z");
    const markUnreconciled = vi.fn(async () => true);
    const release = vi.fn(async () => undefined);
    const observation = await beginPersistedBrowserProviderObservation(
      "course-1",
      {
        begin: vi.fn(async () => ({
          ...providerObservationLease,
          supersededUnresolvedObservationStartedAt: supersededAt,
        })),
        markUnreconciled,
        release,
        renewInTransaction: vi.fn(async () => true),
        startHeartbeat: vi.fn(() => ({
          assertOwned: vi.fn(),
          stop: vi.fn(async () => undefined),
        })),
      }
    );

    await observation!.settle();

    expect(markUnreconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        supersededUnresolvedObservationStartedAt: supersededAt,
      }),
      { preserveSupersededSource: true }
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("passes the exact owned persistence fence into target selection", () => {
    expect(
      resolveBrowserProbeTargetSelection({
        limit: 1,
        courseName: undefined,
        courseId: "course-1",
        persistenceFence,
      }),
    ).toEqual({
      limit: 1,
      courseName: undefined,
      courseId: "course-1",
      persistenceFence,
    });
  });

  it("records the owned browser attempt while preserving a newer runnable course projection", async () => {
    const recordTransition = vi.fn().mockResolvedValue({ recorded: true });

    await expect(
      recordOwnedBrowserStageAfterCourseProjection({
        courseProjectionApplied: false,
        currentCourseRunnable: true,
        recordTransition,
      }),
    ).resolves.toEqual({
      newerRunnableCourseProjectionPreserved: true,
      playbookResult: { recorded: true },
    });

    expect(recordTransition).toHaveBeenCalledOnce();
  });

  it("classifies only identified Playwright and network failures as browser-stage attempts", () => {
    const playwrightTimeout = Object.assign(new Error("page.goto: Timeout 20000ms exceeded."), {
      name: "TimeoutError",
      stack:
        "TimeoutError: page.goto: Timeout 20000ms exceeded.\n    at node_modules/playwright-core/lib/client/frame.js:1:1"
    });
    const playwrightNetwork = new Error(
      "page.goto: net::ERR_NAME_NOT_RESOLVED at https://public.example/"
    );
    const nodeNetwork = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" }
    });

    expect(classifyPersistableBrowserStageFailure(playwrightTimeout)).toBe("TIMEOUT");
    expect(classifyPersistableBrowserStageFailure(playwrightNetwork)).toBe("NETWORK");
    expect(classifyPersistableBrowserStageFailure(nodeNetwork)).toBe("NETWORK");
    expect(classifyPersistableBrowserStageFailure(nodeNetwork, false)).toBeNull();
  });

  it.each([
    [
      Object.assign(
        new Error("browserType.launch: Timeout 20000ms exceeded."),
        { name: "TimeoutError" },
      ),
      "TIMEOUT",
    ],
    [new Error("browserType.launch: socket hang up"), "NETWORK"],
  ] as const)(
    "tags recognized transient browser launch failures as %s",
    async (launchError, expectedFailureClass) => {
      let caught: unknown;

      try {
        await runPersistableBrowserOperation(async () => {
          throw launchError;
        });
      } catch (error) {
        caught = error;
      }

      expect(getPersistableBrowserOperationFailure(caught)).toBe(
        expectedFailureClass,
      );
    },
  );

  it.each([
    new Error(
      "browserType.launch: Executable doesn't exist at C:\\playwright\\chromium.exe",
    ),
    new Error("browserType.launch: Failed to launch chromium"),
  ])("leaves deterministic or generic browser launch failures untyped", async (launchError) => {
    let caught: unknown;

    try {
      await runPersistableBrowserOperation(async () => {
        throw launchError;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(launchError);
    expect(getPersistableBrowserOperationFailure(caught)).toBeNull();
  });

  it.each([
    new SyntaxError("Unexpected string"),
    Object.assign(new SyntaxError("Unexpected string"), {
      cause: { code: "ECONNRESET" }
    }),
    new TypeError("Cannot read properties of undefined"),
    new Error("Course-support browser progression lost current ownership."),
    new Error("Course-support browser persistence violated an invariant."),
    Object.assign(new Error("Operation exceeded its deadline."), {
      name: "TimeoutError"
    }),
    new Error("page.goto: provider response violated an invariant"),
    "unknown browser failure"
  ])("does not turn programming or control-plane errors into progress", (error) => {
    expect(classifyPersistableBrowserStageFailure(error)).toBeNull();
  });

  it("does not turn provider-lease persistence network errors into browser progress", async () => {
    const persistenceError = Object.assign(new Error("Provider lease release failed"), {
      cause: { code: "ECONNRESET" }
    });
    const browserWorker = vi.fn(async () => "browser evidence");
    let caught: unknown;

    try {
      await runWithProviderRequestLease(
        "provider-family",
        () => runPersistableBrowserOperation(browserWorker),
        {
          claim: vi.fn(async () => ({
            providerFamilyKey: "provider-family",
            globalSlot: 0,
            leaseToken: "lease-token"
          })),
          renew: vi.fn(async () => true),
          release: vi.fn(async () => {
            throw persistenceError;
          }),
          wait: vi.fn(async () => undefined)
        }
      );
    } catch (error) {
      caught = error;
    }

    expect(browserWorker).toHaveBeenCalledOnce();
    expect(caught).toBe(persistenceError);
    expect(getPersistableBrowserOperationFailure(caught)).toBeNull();
  });

  it("tags a transient failure only when it comes from the browser worker", async () => {
    const browserFailure = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" }
    });
    let caught: unknown;

    try {
      await runWithProviderRequestLease(
        "provider-family",
        () =>
          runPersistableBrowserOperation(async () => {
            throw browserFailure;
          }),
        {
          claim: vi.fn(async () => ({
            providerFamilyKey: "provider-family",
            globalSlot: 0,
            leaseToken: "lease-token"
          })),
          renew: vi.fn(async () => true),
          release: vi.fn(async () => undefined),
          wait: vi.fn(async () => undefined)
        }
      );
    } catch (error) {
      caught = error;
    }

    expect(getPersistableBrowserOperationFailure(caught)).toBe("NETWORK");
  });

  it("acquires the persisted observation before opening target browser resources", async () => {
    const order: string[] = [];
    const page = {} as never;
    const context = {
      newPage: vi.fn(async () => {
        order.push("page");
        return page;
      }),
    };
    const observation = {
      lease: providerObservationLease,
      observationStartedAt: providerObservationLease.observationStartedAt,
      markProviderExecutionStarted: vi.fn(),
      assertObservationOwned: vi.fn(),
      assertObservationOwnedInTransaction: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
    };

    const result = await prepareBrowserProbeTargetResources({
      courseId: "course-1",
      dryRun: false,
      beginObservation: vi.fn(async () => {
        order.push("observation");
        return observation;
      }),
      createContext: vi.fn(async () => {
        order.push("context");
        return context;
      }),
    });

    expect(result).toMatchObject({
      outcome: "ready",
      providerObservation: observation,
      context,
      page,
      error: null,
    });
    expect(order).toEqual(["observation", "context", "page"]);
  });

  it("retains the observation fence when target resource creation fails", async () => {
    const browserFailure = Object.assign(
      new Error("browserContext.newPage: Target page, context or browser has been closed"),
      {
        stack:
          "Error: browserContext.newPage: Target page, context or browser has been closed\n    at node_modules/playwright-core/lib/client/browserContext.js:1:1",
      },
    );
    const observation = {
      lease: providerObservationLease,
      observationStartedAt: providerObservationLease.observationStartedAt,
      markProviderExecutionStarted: vi.fn(),
      assertObservationOwned: vi.fn(),
      assertObservationOwnedInTransaction: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
    };

    const result = await prepareBrowserProbeTargetResources({
      courseId: "course-1",
      dryRun: false,
      beginObservation: vi.fn(async () => observation),
      createContext: vi.fn(async () => ({
        newPage: vi.fn(async () => {
          throw browserFailure;
        }),
      })),
    });

    expect(result.outcome).toBe("failed");
    expect(result.providerObservation).toBe(observation);
    expect(getPersistableBrowserOperationFailure(result.error)).toBe("NETWORK");
    expect(observation.markProviderExecutionStarted).not.toHaveBeenCalled();
  });

  it("defers before creating browser resources when another observation owns the course", async () => {
    const createContext = vi.fn();

    await expect(
      prepareBrowserProbeTargetResources({
        courseId: "course-1",
        dryRun: false,
        beginObservation: vi.fn(async () => null),
        createContext,
      }),
    ).resolves.toMatchObject({
      outcome: "deferred",
      providerObservation: null,
      context: null,
      page: null,
      error: null,
    });

    expect(createContext).not.toHaveBeenCalled();
  });

  it("closes browser resources exactly once while abort cleanup is repeated", async () => {
    const browser = { close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined) };
    const closeBrowser = createBrowserProbeResourceCloser(browser);
    const closeContext = createBrowserProbeResourceCloser(context);

    await Promise.all([closeContext(), closeContext(), closeBrowser(), closeBrowser()]);

    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("rethrows an unknown browser close failure without retrying the close", async () => {
    const closeError = new Error("browser close invariant failed");
    const browser = {
      close: vi.fn(async () => {
        throw closeError;
      })
    };
    const closeBrowser = createBrowserProbeResourceCloser(browser);

    await expect(closeBrowser()).rejects.toBe(closeError);
    await expect(closeBrowser()).rejects.toBe(closeError);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("checks the abort signal both before and after a browser operation", async () => {
    const controller = new AbortController();
    const abortReason = new Error("verification deadline reached");
    const operation = vi.fn(async () => {
      controller.abort(abortReason);
      return "partial browser result";
    });

    await expect(runAbortAwareBrowserOperation(operation, controller.signal)).rejects.toBe(
      abortReason
    );
    expect(operation).toHaveBeenCalledOnce();

    const skippedOperation = vi.fn();
    await expect(runAbortAwareBrowserOperation(skippedOperation, controller.signal)).rejects.toBe(
      abortReason
    );
    expect(skippedOperation).not.toHaveBeenCalled();
  });

  it("stops a pending browser operation and closes its resource once on abort", async () => {
    const controller = new AbortController();
    const abortReason = new Error("verification watch stopped");
    const resource = { close: vi.fn(async () => undefined) };
    const closeResource = createBrowserProbeResourceCloser(resource);
    const removeAbortCleanup = closeBrowserProbeResourceOnAbort(controller.signal, closeResource);
    const pendingOperation = runAbortAwareBrowserOperation(
      () => new Promise<never>(() => undefined),
      controller.signal
    );

    controller.abort(abortReason);
    await expect(pendingOperation).rejects.toBe(abortReason);
    await closeResource();
    removeAbortCleanup();

    expect(resource.close).toHaveBeenCalledOnce();
  });

  it("terminalizes an aborted browser run with a bounded system failure", async () => {
    const controller = new AbortController();
    const abortReason = new Error("verification ownership was cancelled");
    const finishRun = vi.fn(async () => true);
    controller.abort(abortReason);

    await expect(
      finishBrowserProbeAutomationRunAfterFailure(
        {
          runId: "run-1",
          error: abortReason,
          signal: controller.signal
        },
        finishRun
      )
    ).resolves.toBe(true);

    expect(finishRun).toHaveBeenCalledOnce();
    expect(finishRun).toHaveBeenCalledWith("run-1", {
      outcome: "failed",
      errors: {
        name: "AbortError",
        message: "Browser probe stopped after responder ownership cancellation."
      },
      notes:
        "Browser probe stopped after responder ownership cancellation; no course or playbook writes were permitted after cancellation."
    });
  });

  it("accepts corroboration only from a fresh rendered observation in the same cycle and runtime", () => {
    const confirmedAt = new Date("2026-08-20T12:00:00.000Z");
    const evidence = {
      accessBarriers: [
        { url: "https://provider.example/public", status: 403 },
      ],
      browserInvestigation: {
        mode: "RENDERED",
        incidentCycle: 3,
        runtimeVersion: releaseSha,
        observedAt: "2026-08-20T12:01:00.000Z",
      },
    };
    const discovery = {
      createdAt: new Date("2026-08-20T12:01:01.000Z"),
      evidence,
    };
    const context = {
      incidentCycle: 3,
      runtimeVersion: releaseSha,
      confirmedAt,
    };

    expect(getFreshRenderedCorroborationEvidence(discovery, context)).toBe(
      evidence,
    );
    expect(
      getFreshRenderedCorroborationEvidence(
        {
          ...discovery,
          evidence: {
            ...evidence,
            browserInvestigation: {
              ...evidence.browserInvestigation,
              mode: "INDEPENDENT",
            },
          },
        },
        context,
      ),
    ).toBeNull();
    expect(
      getFreshRenderedCorroborationEvidence(discovery, {
        ...context,
        incidentCycle: 4,
      }),
    ).toBeNull();
    expect(
      getFreshRenderedCorroborationEvidence(discovery, {
        ...context,
        runtimeVersion: "b".repeat(40),
      }),
    ).toBeNull();
    expect(
      getFreshRenderedCorroborationEvidence(
        {
          createdAt: new Date("2026-08-20T11:59:59.000Z"),
          evidence,
        },
        context,
      ),
    ).toBeNull();
    expect(
      getFreshRenderedCorroborationEvidence(
        {
          ...discovery,
          evidence: {
            ...evidence,
            browserInvestigation: {
              ...evidence.browserInvestigation,
              observedAt: "2026-08-20T11:59:59.000Z",
            },
          },
        },
        context,
      ),
    ).toBeNull();
  });
});
