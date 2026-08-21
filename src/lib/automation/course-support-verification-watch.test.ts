import { describe, expect, it, vi } from "vitest";

import {
  assertCourseSupportVerificationWatchFlags,
  closeoutSettledCourseSupportVerification,
  runCourseSupportVerificationPass,
  runCourseSupportVerificationWatch,
  runWithBoundedCourseSupportHeartbeat,
  selectCourseSupportVerificationEndpointDeadline,
  selectCourseSupportVerificationStopMode
} from "@/lib/automation/course-support-verification-watch";
import { CourseSupportSearchExecutionFenceRetryError } from "@/lib/automation/course-support-search-execution-fence";

describe("assertCourseSupportVerificationWatchFlags", () => {
  it("requires the ownership-releasing closeout lane for every watch", () => {
    expect(() =>
      assertCourseSupportVerificationWatchFlags({ watch: true, closeout: false })
    ).toThrow("verify --watch requires --closeout");
    expect(() =>
      assertCourseSupportVerificationWatchFlags({ watch: false, closeout: true })
    ).toThrow("verify --closeout requires --watch");
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

  it("attempts all three owned browser stages before settled closeout", async () => {
    const pass = vi
      .fn()
      .mockResolvedValueOnce({
        browserStages: { eligibleCount: 3, persistedCount: 3 },
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
      closeout: { durableCloseoutRecorded: true }
    });
    expect(onStopped).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "error", passCount: 1 })
    );
  });

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
      closeout: async (humanReviewCount) => {
        events.push(`closeout:${humanReviewCount}`);
        return { durableCloseoutRecorded: true };
      },
    });

    expect(events).toEqual(["closeout:1"]);
    expect(result.humanReviewCount).toBe(1);
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
    ).resolves.toMatchObject({ humanReviewCount: 0 });
    expect(closeout).toHaveBeenCalledWith(0);
  });

  it("preflights every explicit human result before closeout", async () => {
    const closeout = vi.fn(async () => ({ durableCloseoutRecorded: true }));

    await expect(
      closeoutSettledCourseSupportVerification({
        courses: [
          {
            ordinal: "01",
            result: "NEEDS_HUMAN",
            playbookExhausted: true,
          },
          {
            ordinal: "02",
            result: "NEEDS_HUMAN",
            playbookExhausted: false,
          },
        ],
        closeout,
      }),
    ).rejects.toThrow("explicit human result before its playbook is exhausted");
    expect(closeout).not.toHaveBeenCalled();
  });
});
