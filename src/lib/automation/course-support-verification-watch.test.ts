import { describe, expect, it, vi } from "vitest";

import {
  assertCourseSupportVerificationWatchFlags,
  closeoutSettledCourseSupportVerification,
  getCourseSupportVerificationWatchFailureCode,
  isCourseSupportVerificationWatchShortRetryEligible,
  runCourseSupportVerificationPass,
  runCourseSupportVerificationWatch,
  runWithBoundedCourseSupportHeartbeat,
  selectCourseSupportVerificationEndpointDeadline,
  selectCourseSupportVerificationStopMode,
  tagCourseSupportBrowserStageControlFailure
} from "@/lib/automation/course-support-verification-watch";
import { CourseSupportSearchExecutionFenceRetryError } from "@/lib/automation/course-support-search-execution-fence";

describe("assertCourseSupportVerificationWatchFlags", () => {
  it("requires the owner-bound watch and closeout lane for every persisted verification", () => {
    for (const flags of [
      { watch: false, closeout: false },
      { watch: true, closeout: false },
      { watch: false, closeout: true }
    ]) {
      expect(() => assertCourseSupportVerificationWatchFlags(flags)
    ).toThrow(
        "verify --watch --closeout"
      );
    }
    expect(() =>
      assertCourseSupportVerificationWatchFlags({ watch: true, closeout: true })
    ).not.toThrow();
  });
});

function cleanPass() {
  return {
    browserStages: { eligibleCount: 0, persistedCount: 0 },
    verification: { detachedVerification: { rerunNeeded: false } }
  };
}

describe("runCourseSupportVerificationPass", () => {
  it("persists browser stages before verifying the batch", async () => {
    const order: string[] = [];
    const result = await runCourseSupportVerificationPass({
      persistBrowserStages: async () => {
        order.push("browser");
        return { eligibleCount: 1, persistedCount: 1 };
      },
      verifyBatch: async () => {
        order.push("verify");
        return { detachedVerification: { rerunNeeded: true } };
      }
    });

    expect(order).toEqual(["browser", "verify"]);
    expect(result.browserStages.persistedCount).toBe(1);
  });

  it("passes the ownership signal into batch verification", async () => {
    const controller = new AbortController();
    const verifyBatch = vi.fn(async (signal?: AbortSignal) => ({
      signal,
      detachedVerification: { rerunNeeded: false },
    }));

    const result = await runCourseSupportVerificationPass({
      signal: controller.signal,
      persistBrowserStages: async () => ({
        eligibleCount: 0,
        persistedCount: 0,
      }),
      verifyBatch,
    });

    expect(verifyBatch).toHaveBeenCalledWith(controller.signal);
    expect(result.verification.signal).toBe(controller.signal);
  });

  it.each([
    ["browser persistence", "BROWSER_STAGE_PERSIST_FAILED" as const],
    ["batch verification", "BATCH_VERIFICATION_FAILED" as const],
  ])("tags %s failures at their origin", async (origin, expectedCode) => {
    const privateCanary = "https://private.invalid/provider?payload=secret";
    let thrown: unknown;
    try {
      await runCourseSupportVerificationPass({
        persistBrowserStages: async () => {
          if (origin === "browser persistence") {
            throw new Error(privateCanary);
          }
          return { eligibleCount: 0, persistedCount: 0 };
        },
        verifyBatch: async () => {
          if (origin === "batch verification") {
            throw new Error(privateCanary);
          }
          return { detachedVerification: { rerunNeeded: false } };
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(getCourseSupportVerificationWatchFailureCode(thrown)).toBe(
      expectedCode,
    );
    expect(JSON.stringify(thrown)).not.toContain(privateCanary);
  });

  it.each([
    ["NETWORK" as const, "BROWSER_STAGE_NETWORK_FAILED" as const],
    ["TIMEOUT" as const, "BROWSER_STAGE_TIMEOUT" as const],
  ])(
    "maps a browser-origin %s failure to the exact short-retry code",
    async (transientKind, expectedCode) => {
      const privateCanary = "https://private.invalid/provider?payload=secret";
      const rawError = new Error(privateCanary);
      const classifyBrowserStageFailure = vi.fn(() => transientKind);
      let thrown: unknown;

      try {
        await runCourseSupportVerificationPass({
          persistBrowserStages: async () => {
            throw rawError;
          },
          classifyBrowserStageFailure,
          verifyBatch: async () => ({
            detachedVerification: { rerunNeeded: false },
          }),
        });
      } catch (error) {
        thrown = error;
      }

      expect(classifyBrowserStageFailure).toHaveBeenCalledOnce();
      expect(classifyBrowserStageFailure).toHaveBeenCalledWith(rawError);
      expect(getCourseSupportVerificationWatchFailureCode(thrown)).toBe(
        expectedCode,
      );
      expect(
        isCourseSupportVerificationWatchShortRetryEligible(expectedCode),
      ).toBe(true);
      expect(JSON.stringify(thrown)).not.toContain(privateCanary);
    },
  );

  it.each([
    "BROWSER_STAGE_PERSIST_FAILED",
    "BROWSER_STAGE_BATCH_LOAD_FAILED",
    "BROWSER_STAGE_RELEASE_FENCE_FAILED",
    "BROWSER_STAGE_TARGET_SELECTION_FAILED",
    "BROWSER_STAGE_PROVENANCE_FAILED",
    "BROWSER_STAGE_CURRENT_TARGET_FAILED",
    "BROWSER_STAGE_PROBE_SETUP_FAILED",
    "BROWSER_STAGE_RUN_CREATE_FAILED",
    "BATCH_VERIFICATION_FAILED",
    "BATCH_VERIFICATION_RECOVERY_REQUIRED",
    "ASSIGNED_STAGE_ORCHESTRATION_GAP",
    "SETTLED_CLOSEOUT_FAILED",
  ] as const)("does not short-retry the generic %s failure", (failureCode) => {
    expect(isCourseSupportVerificationWatchShortRetryEligible(failureCode)).toBe(
      false,
    );
  });

  it.each([
    "BROWSER_STAGE_BATCH_LOAD_FAILED",
    "BROWSER_STAGE_RELEASE_FENCE_FAILED",
    "BROWSER_STAGE_TARGET_SELECTION_FAILED",
    "BROWSER_STAGE_PROVENANCE_FAILED",
    "BROWSER_STAGE_CURRENT_TARGET_FAILED",
    "BROWSER_STAGE_PROBE_SETUP_FAILED",
    "BROWSER_STAGE_RUN_CREATE_FAILED"
  ] as const)(
    "preserves the privacy-safe %s control-plane origin",
    async (failureCode) => {
      const privateCanary = "https://private.invalid/provider?payload=secret";
      let thrown: unknown;

      try {
        await runCourseSupportVerificationPass({
          persistBrowserStages: async () => {
            throw tagCourseSupportBrowserStageControlFailure(
              failureCode,
              new Error(privateCanary)
            );
          },
          verifyBatch: async () => ({
            detachedVerification: { rerunNeeded: false }
          })
        });
      } catch (error) {
        thrown = error;
      }

      expect(getCourseSupportVerificationWatchFailureCode(thrown)).toBe(
        failureCode
      );
      expect(JSON.stringify(thrown)).not.toContain(privateCanary);
    }
  );
});

describe("runCourseSupportVerificationWatch", () => {
  function fastDeadlineTimer(advance: (milliseconds: number) => void) {
    return {
      setTimer: (callback: () => void, milliseconds: number) =>
        setTimeout(() => {
          advance(milliseconds);
          callback();
        }, 0),
      clearTimer: (handle: unknown) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>)
    };
  }

  it("refuses a watch window that can overrun the customer endpoint", async () => {
    await expect(
      runCourseSupportVerificationWatch({
        maxMinutes: 19,
        pass: async () => cleanPass()
      })
    ).rejects.toThrow("integer from 1 through 18");
  });

  it.each(["endpoint", "max"] as const)(
    "reports a null failure code when the %s deadline stops the watch",
    async (reason) => {
      let nowCallCount = 0;
      const onStopped = vi.fn(async () => ({ durableCloseoutRecorded: true }));

      const result = await runCourseSupportVerificationWatch({
        maxMinutes: 1,
        ...(reason === "endpoint" ? { deadlineAt: 0 } : {}),
        now: () => {
          const value = nowCallCount === 0 ? 0 : 60_000;
          nowCallCount += 1;
          return value;
        },
        pass: async () => cleanPass(),
        onStopped,
      });

      expect(result).toMatchObject({
        outcome: "verification_watch_closed",
        stoppedReason: reason,
        failureCode: null,
      });
      expect(onStopped).toHaveBeenCalledWith(
        expect.objectContaining({ reason, failureCode: null }),
      );
    },
  );

  it("waits while detached verification is pending", async () => {
    const pass = vi
      .fn()
      .mockResolvedValueOnce({
        browserStages: { eligibleCount: 0, persistedCount: 0 },
        verification: { detachedVerification: { rerunNeeded: true } }
      })
      .mockResolvedValueOnce(cleanPass())
      .mockResolvedValueOnce(cleanPass());
    const sleep = vi.fn(async () => undefined);

    const result = await runCourseSupportVerificationWatch({ pass, sleep });

    expect(result.passCount).toBe(3);
    expect(pass).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("cannot settle on clean scans while a zero-execution continuation remains pending", async () => {
    const pendingContinuation = {
      browserStages: { eligibleCount: 0, persistedCount: 0 },
      verification: {
        detachedVerification: { pendingCount: 1, rerunNeeded: true },
      },
    };
    const pass = vi
      .fn()
      .mockResolvedValueOnce(pendingContinuation)
      .mockResolvedValueOnce(pendingContinuation)
      .mockResolvedValueOnce(pendingContinuation)
      .mockResolvedValueOnce(cleanPass())
      .mockResolvedValueOnce(cleanPass());
    const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));
    const sleep = vi.fn(async () => undefined);

    const result = await runCourseSupportVerificationWatch({
      pass,
      closeout,
      sleep,
    });

    expect(result.passCount).toBe(5);
    expect(pass).toHaveBeenCalledTimes(5);
    expect(closeout).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("attempts all three owned browser stages before settled closeout", async () => {
    const pass = vi
      .fn()
      .mockResolvedValueOnce({
        browserStages: {
          eligibleCount: 3,
          persistedCount: 3,
          renderedDiscoveryCount: 2,
          independentConfirmationCount: 1,
        },
        verification: { detachedVerification: { rerunNeeded: false } }
      })
      .mockResolvedValueOnce(cleanPass())
      .mockResolvedValueOnce(cleanPass());
    const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    const result = await runCourseSupportVerificationWatch({
      pass,
      closeout,
      sleep: async () => undefined
    });

    expect(result.passCount).toBe(3);
    expect(pass).toHaveBeenCalledTimes(3);
    expect(closeout).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      browserStages: { eligibleCount: 0, persistedCount: 0 },
      browserStageTotals: {
        passCountWithEligibleStages: 1,
        passCountWithPersistedStages: 1,
        eligibleCount: 3,
        persistedCount: 3,
        renderedDiscoveryCount: 2,
        independentConfirmationCount: 1,
      },
    });
  });

  it("retains completed-pass browser telemetry when an endpoint stops the watch", async () => {
    let currentTime = 0;
    const pass = vi
      .fn()
      .mockResolvedValueOnce({
        browserStages: {
          eligibleCount: 1,
          persistedCount: 1,
          renderedDiscoveryCount: 1,
          independentConfirmationCount: 0,
        },
        verification: { detachedVerification: { rerunNeeded: true } },
      })
      .mockImplementationOnce(async () => {
        currentTime = 60_000;
        return cleanPass();
      });

    const result = await runCourseSupportVerificationWatch({
      maxMinutes: 1,
      deadlineAt: 60_000,
      now: () => currentTime,
      pass,
      sleep: async () => undefined,
      onStopped: async () => ({ durableCloseoutRecorded: true }),
    });

    expect(result).toMatchObject({
      outcome: "verification_watch_closed",
      passCount: 2,
      stoppedReason: "endpoint",
      browserStageTotals: {
        passCountWithEligibleStages: 1,
        passCountWithPersistedStages: 1,
        eligibleCount: 1,
        persistedCount: 1,
        renderedDiscoveryCount: 1,
        independentConfirmationCount: 0,
      },
    });
  });

  it("releases an expired zero-pass browser watch as an automatic retry", async () => {
    const pass = vi.fn(async () => cleanPass());
    const onStopped = vi.fn(
      async ({ reason, passCount }: { reason: "endpoint"; passCount: number }) => ({
        mode: selectCourseSupportVerificationStopMode({
          reason,
          passCount,
          endpointDeadlineAt: 1_000,
          now: 1_000
        })
      })
    );

    const result = await runCourseSupportVerificationWatch({
      deadlineAt: 1_000,
      now: () => 1_000,
      pass,
      onStopped
    });

    expect(pass).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      stoppedReason: "endpoint",
      browserStageTotals: {
        passCountWithEligibleStages: 0,
        passCountWithPersistedStages: 0,
        eligibleCount: 0,
        persistedCount: 0,
        renderedDiscoveryCount: 0,
        independentConfirmationCount: 0,
      },
      closeout: { mode: "EARLY_RETRY" }
    });
  });

  it("runs verification passes after mixed peer endpoints are refreshed into the future", async () => {
    const startedAt = 1_000;
    const refreshedDeadlineAt = startedAt + 28 * 60_000;
    const deadlineAt = selectCourseSupportVerificationEndpointDeadline([
      {
        result: "PENDING",
        escalationDeadlineAt: new Date(refreshedDeadlineAt).toISOString(),
        terminalProofDurable: false,
      },
      {
        result: "PENDING",
        escalationDeadlineAt: new Date(
          startedAt + 30 * 60_000,
        ).toISOString(),
        terminalProofDurable: false,
      },
    ]);
    const pass = vi.fn(async () => cleanPass());
    const sleep = vi.fn(async () => undefined);
    const onStopped = vi.fn(async () => ({ mode: "EARLY_RETRY" }));

    const result = await runCourseSupportVerificationWatch({
      maxMinutes: 1,
      deadlineAt,
      now: () => startedAt,
      pass,
      sleep,
      onStopped,
    });

    expect(deadlineAt).toBe(refreshedDeadlineAt);
    expect(result).toMatchObject({
      outcome: "verification_watch_settled",
      passCount: 2,
    });
    expect(pass).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(onStopped).not.toHaveBeenCalled();
  });

  it("requires an extra clean pass after browser work", async () => {
    const pass = vi
      .fn()
      .mockResolvedValueOnce({
        browserStages: { eligibleCount: 1, persistedCount: 0 },
        verification: { detachedVerification: { rerunNeeded: false } }
      })
      .mockResolvedValueOnce(cleanPass())
      .mockResolvedValueOnce(cleanPass());

    const result = await runCourseSupportVerificationWatch({
      pass,
      sleep: async () => undefined
    });

    expect(result.passCount).toBe(3);
    expect(pass).toHaveBeenCalledTimes(3);
  });

  it("rescans after detached verification exposes a browser-owned stage", async () => {
    const pass = vi
      .fn()
      // The detached result applied by this apparently clean pass advances the
      // ledger into independent confirmation after its browser-stage scan.
      .mockResolvedValueOnce(cleanPass())
      .mockResolvedValueOnce({
        browserStages: { eligibleCount: 1, persistedCount: 1 },
        verification: { detachedVerification: { rerunNeeded: false } }
      })
      .mockResolvedValueOnce(cleanPass())
      .mockResolvedValueOnce(cleanPass());
    const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    const result = await runCourseSupportVerificationWatch({
      pass,
      closeout,
      sleep: async () => undefined
    });

    expect(result.passCount).toBe(4);
    expect(pass).toHaveBeenCalledTimes(4);
    expect(closeout).toHaveBeenCalledOnce();
  });

  it("runs another two clean passes when closeout observes a changed search fence", async () => {
    const pass = vi.fn(async () => cleanPass());
    const closeout = vi
      .fn()
      .mockRejectedValueOnce(new CourseSupportSearchExecutionFenceRetryError())
      .mockResolvedValueOnce({ durableCloseoutRecorded: true });
    const sleep = vi.fn(async () => undefined);

    const result = await runCourseSupportVerificationWatch({
      pass,
      closeout,
      sleep,
    });

    expect(result.passCount).toBe(4);
    expect(pass).toHaveBeenCalledTimes(4);
    expect(closeout).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does not call closeout while the search execution fence is unsettled", async () => {
    const pass = vi
      .fn()
      .mockResolvedValueOnce({
        ...cleanPass(),
        verification: {
          ...cleanPass().verification,
          searchExecutionFence: { rerunNeeded: true },
        },
      })
      .mockResolvedValueOnce(cleanPass())
      .mockResolvedValueOnce(cleanPass());
    const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    const result = await runCourseSupportVerificationWatch({
      pass,
      closeout,
      sleep: async () => undefined,
    });

    expect(result.passCount).toBe(3);
    expect(closeout).toHaveBeenCalledOnce();
  });

  it("uses a provisional restored course deadline for endpoint closeout", async () => {
    const endpointDeadline = selectCourseSupportVerificationEndpointDeadline([
      {
        result: "FINAL_DISPOSITION",
        escalationDeadlineAt: new Date(10_000).toISOString(),
        terminalProofDurable: true
      },
      {
        result: "RESTORED",
        escalationDeadlineAt: new Date(30_000).toISOString(),
        terminalProofDurable: true
      },
      {
        result: "PENDING",
        escalationDeadlineAt: new Date(50_000).toISOString(),
        terminalProofDurable: false
      }
    ]);
    let currentTime = 0;
    const onStopped = vi.fn(async ({ reason }: { reason: string }) => ({
      mode: reason === "endpoint" ? "ENDPOINT" : "EARLY_RETRY"
    }));

    const result = await runCourseSupportVerificationWatch({
      maxMinutes: 1,
      pollMs: 20_000,
      deadlineAt: endpointDeadline,
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
      pass: async () => ({
        browserStages: { eligibleCount: 0, persistedCount: 0 },
        verification: { detachedVerification: { rerunNeeded: true } }
      }),
      onStopped
    });

    expect(endpointDeadline).toBe(30_000);
    expect(result).toMatchObject({
      stoppedReason: "endpoint",
      closeout: { mode: "ENDPOINT" }
    });
    expect(onStopped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "endpoint" })
    );
  });

  it("fails closed at the deadline and never closes out", async () => {
    let now = 0;
    const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    await expect(
      runCourseSupportVerificationWatch({
        maxMinutes: 1,
        pollMs: 60_000,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        pass: async () => ({
          browserStages: { eligibleCount: 0, persistedCount: 0 },
          verification: { detachedVerification: { rerunNeeded: true } }
        }),
        closeout
      })
    ).rejects.toThrow("timed out before a final clean pass");
    expect(closeout).not.toHaveBeenCalled();
  });

  it("propagates ownership failures without closeout", async () => {
    const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    await expect(
      runCourseSupportVerificationWatch({
        pass: async () => {
          throw new Error("lost durable batch ownership");
        },
        closeout
      })
    ).rejects.toThrow("lost durable batch ownership");
    expect(closeout).not.toHaveBeenCalled();
  });

  it("propagates a parent abort through the verification pass without stopped closeout", async () => {
    const controller = new AbortController();
    const ownershipFailure = new Error(
      "Course-support verification watch ownership was lost.",
    );
    const onStopped = vi.fn(async () => ({ durableCloseoutRecorded: true }));
    let browserStageStarted = false;

    const running = runCourseSupportVerificationWatch({
      signal: controller.signal,
      pass: (signal) =>
        runCourseSupportVerificationPass({
          signal,
          persistBrowserStages: () =>
            new Promise<never>((_resolve, reject) => {
              browserStageStarted = true;
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
          classifyBrowserStageFailure: () => "NETWORK",
          verifyBatch: async () => ({
            detachedVerification: { rerunNeeded: false },
          }),
        }),
      onStopped,
    });

    await vi.waitFor(() => expect(browserStageStarted).toBe(true));
    controller.abort(ownershipFailure);

    await expect(running).rejects.toThrow(ownershipFailure.message);
    expect(onStopped).not.toHaveBeenCalled();
  });

  it("releases a tagged pass failure without exposing its raw cause", async () => {
    const privateCanary = "https://private.invalid/provider?payload=secret";
    const onStopped = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    const result = await runCourseSupportVerificationWatch({
      pass: () =>
        runCourseSupportVerificationPass({
          persistBrowserStages: async () => ({
            eligibleCount: 0,
            persistedCount: 0,
          }),
          verifyBatch: async () => {
            throw new Error(privateCanary);
          },
        }),
      onStopped,
    });

    expect(result).toMatchObject({
      outcome: "verification_watch_closed",
      stoppedReason: "error",
      failureCode: "BATCH_VERIFICATION_FAILED",
    });
    expect(JSON.stringify(result)).not.toContain(privateCanary);
    expect(onStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "error",
        failureCode: "BATCH_VERIFICATION_FAILED",
      }),
    );
    expect(onStopped.mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("treats a recovery-required pass as lost ownership", async () => {
    const onStopped = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    await expect(
      runCourseSupportVerificationWatch({
        pass: async () => ({
          browserStages: { eligibleCount: 0, persistedCount: 0 },
          verification: {
            outcome: "recovery_required",
            verified: false
          }
        }),
        onStopped
      })
    ).resolves.toMatchObject({
      outcome: "verification_watch_closed",
      stoppedReason: "error",
      failureCode: "BATCH_VERIFICATION_RECOVERY_REQUIRED",
      closeout: { durableCloseoutRecorded: true }
    });
    expect(onStopped).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "error",
        passCount: 1,
        failureCode: "BATCH_VERIFICATION_RECOVERY_REQUIRED",
      })
    );
  });

  it.each([
    [
      "ineligible",
      {
        rerunNeeded: true,
        assignedStageOrchestrationGapCount: 1,
        schedulerIneligibleReasonCounts: { monitoring_not_actionable: 1 },
        schedulerDispatchError: false
      }
    ],
    [
      "errored",
      {
        rerunNeeded: true,
        assignedStageOrchestrationGapCount: 1,
        schedulerIneligibleReasonCounts: {},
        schedulerDispatchError: true
      }
    ],
    [
      "eligible but left as an unstarted stale duplicate",
      {
        rerunNeeded: true,
        assignedStageOrchestrationGapCount: 1,
        schedulerIneligibleReasonCounts: {},
        schedulerDispatchError: false
      }
    ]
  ])(
    "releases through the error lane when assigned-stage scheduling is %s",
    async (_reason, detachedVerification) => {
      const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));
      const onStopped = vi.fn(async () => ({
        durableCloseoutRecorded: true
      }));

      await expect(
        runCourseSupportVerificationWatch({
          pass: async () => ({
            browserStages: { eligibleCount: 0, persistedCount: 0 },
            verification: { detachedVerification }
          }),
          closeout,
          onStopped
        })
      ).resolves.toMatchObject({
        outcome: "verification_watch_closed",
        stoppedReason: "error",
        failureCode: "ASSIGNED_STAGE_ORCHESTRATION_GAP",
        passCount: 1,
        closeout: { durableCloseoutRecorded: true }
      });
      expect(closeout).not.toHaveBeenCalled();
      expect(onStopped).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "error",
          passCount: 1,
          failureCode: "ASSIGNED_STAGE_ORCHESTRATION_GAP",
        })
      );
    }
  );

  it("attempts the release lane once when clean-pass closeout fails", async () => {
    const onStopped = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    await expect(
      runCourseSupportVerificationWatch({
        pass: async () => cleanPass(),
        sleep: async () => undefined,
        closeout: async () => {
          throw new Error("closeout compare-and-set changed");
        },
        onStopped
      })
    ).resolves.toMatchObject({
      outcome: "verification_watch_closed",
      stoppedReason: "error",
      failureCode: "SETTLED_CLOSEOUT_FAILED",
      closeout: { durableCloseoutRecorded: true }
    });
    expect(onStopped).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "error", passCount: 2 })
    );
  });

  it("aborts a never-resolving pass at the endpoint and releases once", async () => {
    let currentTime = 0;
    let passSignal: AbortSignal | undefined;
    const onStopped = vi.fn(async () => ({ durableCloseoutRecorded: true }));
    const timer = fastDeadlineTimer((milliseconds) => {
      currentTime += milliseconds;
    });

    const result = await runCourseSupportVerificationWatch({
      maxMinutes: 1,
      deadlineAt: 10_000,
      now: () => currentTime,
      pass: (signal) => {
        passSignal = signal;
        return new Promise(() => undefined);
      },
      onStopped,
      ...timer
    });

    expect(result).toMatchObject({
      outcome: "verification_watch_closed",
      stoppedReason: "endpoint",
      passCount: 0
    });
    expect(passSignal?.aborted).toBe(true);
    expect(onStopped).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "endpoint",
        passCount: 0,
        lastPass: null
      })
    );
  });

  it("aborts a never-resolving settled closeout and releases once", async () => {
    let currentTime = 0;
    let closeoutSignal: AbortSignal | undefined;
    const onStopped = vi.fn(async () => ({ durableCloseoutRecorded: true }));
    const timer = fastDeadlineTimer((milliseconds) => {
      currentTime += milliseconds;
    });

    const result = await runCourseSupportVerificationWatch({
      maxMinutes: 1,
      deadlineAt: 10_000,
      now: () => currentTime,
      pass: async () => cleanPass(),
      sleep: async () => undefined,
      closeout: ({ signal }) => {
        closeoutSignal = signal;
        return new Promise(() => undefined);
      },
      onStopped,
      ...timer
    });

    expect(result).toMatchObject({
      outcome: "verification_watch_closed",
      stoppedReason: "endpoint",
      passCount: 2
    });
    expect(closeoutSignal?.aborted).toBe(true);
    expect(onStopped).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "endpoint", passCount: 2 })
    );
  });

  it("stops lease renewal when release cleanup never resolves", async () => {
    let currentTime = 0;
    let releaseSignal: AbortSignal | undefined;
    let watchUnwound = false;
    const pass = vi.fn(async () => cleanPass());
    const onStopped = vi.fn(
      ({ signal }: { signal: AbortSignal }) => {
        releaseSignal = signal;
        return new Promise<never>(() => undefined);
      }
    );
    const timer = fastDeadlineTimer((milliseconds) => {
      currentTime += milliseconds;
    });

    const watchedOperation = (async () => {
      try {
        return await runCourseSupportVerificationWatch({
          maxMinutes: 1,
          deadlineAt: 0,
          releaseCleanupMs: 5_000,
          now: () => currentTime,
          pass,
          onStopped,
          ...timer
        });
      } finally {
        watchUnwound = true;
      }
    })();

    await expect(watchedOperation).rejects.toThrow(
      "release cleanup exceeded its finite budget"
    );
    expect(currentTime).toBe(5_000);
    expect(pass).not.toHaveBeenCalled();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(releaseSignal?.aborted).toBe(true);
    expect(watchUnwound).toBe(true);
  });

  it("derives closeout only after the final clean pass", async () => {
    const events: string[] = [];
    const result = await runCourseSupportVerificationWatch({
      pass: async () => {
        events.push("pass");
        return cleanPass();
      },
      sleep: async () => undefined,
      closeout: async ({ passCount }) => {
        events.push("closeout");
        return { durableCloseoutRecorded: true, passCount };
      }
    });

    expect(events).toEqual(["pass", "pass", "closeout"]);
    expect(result.closeout).toEqual({
      durableCloseoutRecorded: true,
      passCount: 2
    });
  });
});

describe("runWithBoundedCourseSupportHeartbeat", () => {
  function immediateTimer() {
    return {
      setTimer: (callback: () => void) => setTimeout(callback, 0),
      clearTimer: (handle: unknown) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>)
    };
  }

  it("fails before the operation when the initial renewal never resolves", async () => {
    let renewalSignal: AbortSignal | undefined;
    const operation = vi.fn(async () => ({ durableCloseoutRecorded: false }));
    const setIntervalTimer = vi.fn();

    await expect(
      runWithBoundedCourseSupportHeartbeat({
        renew: (signal) => {
          renewalSignal = signal;
          return new Promise<never>(() => undefined);
        },
        operation,
        intervalMs: 1_000,
        renewalTimeoutMs: 5,
        setIntervalTimer,
        ...immediateTimer()
      })
    ).rejects.toThrow("renewal timed out; ownership is unconfirmed");

    expect(renewalSignal?.aborted).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    expect(setIntervalTimer).not.toHaveBeenCalled();
  });

  it("bounds the final renewal drain and preserves durable closeout", async () => {
    let intervalCallback: (() => void) | undefined;
    let inFlightSignal: AbortSignal | undefined;
    let resolveOperation:
      ((value: { durableCloseoutRecorded: true }) => void)
      | undefined;
    const intervalHandle = { unref: vi.fn() };
    const clearIntervalTimer = vi.fn();
    const renew = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce((signal) => {
        inFlightSignal = signal;
        return new Promise<never>(() => undefined);
      });
    const operation = vi.fn(
      () =>
        new Promise<{ durableCloseoutRecorded: true }>((resolve) => {
          resolveOperation = resolve;
        })
    );

    const running = runWithBoundedCourseSupportHeartbeat({
      renew,
      operation,
      intervalMs: 1_000,
      renewalTimeoutMs: 5,
      allowDurableCloseout: true,
      setIntervalTimer: (callback) => {
        intervalCallback = callback;
        return intervalHandle;
      },
      clearIntervalTimer,
      ...immediateTimer()
    });

    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    intervalCallback?.();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2));
    resolveOperation?.({ durableCloseoutRecorded: true });

    await expect(running).resolves.toEqual({
      durableCloseoutRecorded: true
    });
    expect(inFlightSignal?.aborted).toBe(true);
    expect(clearIntervalTimer).toHaveBeenCalledOnce();
    expect(clearIntervalTimer).toHaveBeenCalledWith(intervalHandle);
  });

  it("does not treat a timed-out renewal as success without closeout proof", async () => {
    let intervalCallback: (() => void) | undefined;
    let resolveOperation:
      ((value: { durableCloseoutRecorded: false }) => void)
      | undefined;
    const renew = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<never>(() => undefined));
    const running = runWithBoundedCourseSupportHeartbeat({
      renew,
      operation: () =>
        new Promise<{ durableCloseoutRecorded: false }>((resolve) => {
          resolveOperation = resolve;
        }),
      intervalMs: 1_000,
      renewalTimeoutMs: 5,
      allowDurableCloseout: true,
      setIntervalTimer: (callback) => {
        intervalCallback = callback;
        return 1;
      },
      clearIntervalTimer: vi.fn(),
      ...immediateTimer()
    });

    await vi.waitFor(() => expect(intervalCallback).toBeTypeOf("function"));
    intervalCallback?.();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2));
    resolveOperation?.({ durableCloseoutRecorded: false });

    await expect(running).rejects.toThrow(
      "renewal timed out; ownership is unconfirmed"
    );
  });

  it("aborts an in-flight operation when ownership renewal fails", async () => {
    let intervalCallback: (() => void) | undefined;
    let operationSignal: AbortSignal | undefined;
    const ownershipFailure = new Error(
      "Course-support operation heartbeat lost durable batch ownership."
    );
    const renew = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(ownershipFailure);

    const running = runWithBoundedCourseSupportHeartbeat({
      renew,
      operation: (signal) =>
        new Promise<never>((_resolve, reject) => {
          operationSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        }),
      intervalMs: 1_000,
      setIntervalTimer: (callback) => {
        intervalCallback = callback;
        return 1;
      },
      clearIntervalTimer: vi.fn()
    });

    await vi.waitFor(() => expect(operationSignal).toBeDefined());
    intervalCallback?.();

    await expect(running).rejects.toThrow(ownershipFailure.message);
    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toBe(ownershipFailure);
  });

  it("aborts the verification watch without closeout when ownership renewal fails", async () => {
    let intervalCallback: (() => void) | undefined;
    let passSignal: AbortSignal | undefined;
    const ownershipFailure = new Error(
      "Course-support operation heartbeat lost durable batch ownership."
    );
    const renew = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(ownershipFailure);
    const closeout = vi.fn();
    const onStopped = vi.fn();
    const pass = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          passSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        })
    );

    const running = runWithBoundedCourseSupportHeartbeat({
      renew,
      operation: (signal) =>
        runCourseSupportVerificationWatch({
          signal,
          pass,
          closeout,
          onStopped,
          maxMinutes: 1,
          pollMs: 5_000
        }),
      intervalMs: 1_000,
      setIntervalTimer: (callback) => {
        intervalCallback = callback;
        return 1;
      },
      clearIntervalTimer: vi.fn()
    });

    await vi.waitFor(() => expect(passSignal).toBeDefined());
    intervalCallback?.();

    await expect(running).rejects.toThrow(ownershipFailure.message);
    expect(passSignal?.aborted).toBe(true);
    expect(closeout).not.toHaveBeenCalled();
    expect(onStopped).not.toHaveBeenCalled();
  });
});

describe("closeoutSettledCourseSupportVerification", () => {
  it("sends retry and pending results straight to derived closeout", async () => {
    const events: string[] = [];
    const result = await closeoutSettledCourseSupportVerification({
      courses: [
        { ordinal: "01", result: "RESTORED", playbookExhausted: false },
        { ordinal: "02", result: "STALE_EVIDENCE", playbookExhausted: true },
        { ordinal: "03", result: "FINAL_DISPOSITION", playbookExhausted: false },
        { ordinal: "04", result: "RETRY_SCHEDULED", playbookExhausted: true },
        { ordinal: "05", result: "NEEDS_HUMAN", playbookExhausted: true }
      ],
      closeout: async (preCloseoutExplicitHumanCount) => {
        events.push(`closeout:${preCloseoutExplicitHumanCount}`);
        return { durableCloseoutRecorded: true };
      },
    });

    expect(events).toEqual(["closeout:1"]);
    expect(result.preCloseoutExplicitHumanCount).toBe(1);
  });

  it("allows an ordinary unexhausted retry to release ownership", async () => {
    const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    await expect(
      closeoutSettledCourseSupportVerification({
        courses: [
          {
            ordinal: "01",
            result: "RETRY_SCHEDULED",
            playbookExhausted: false,
          },
        ],
        closeout,
      }),
    ).resolves.toMatchObject({ preCloseoutExplicitHumanCount: 0 });
    expect(closeout).toHaveBeenCalledWith(0);
  });

  it.each([false, null])(
    "preflights an explicit human result with %s exhaustion proof before closeout",
    async (playbookExhausted) => {
      const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));

      await expect(
        closeoutSettledCourseSupportVerification({
          courses: [
            {
              ordinal: "01",
              result: "NEEDS_HUMAN",
              playbookExhausted,
            },
          ],
          closeout,
        }),
      ).rejects.toThrow(
        "explicit human result before its playbook is exhausted",
      );
      expect(closeout).not.toHaveBeenCalled();
    },
  );
});
