import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithProviderRequestLease } from "./provider-request-lease";

afterEach(() => {
  vi.useRealTimers();
});

describe("provider request lease", () => {
  it("runs provider I/O only after a cross-search slot is claimed", async () => {
    const lease = {
      providerFamilyKey: "FOREUP",
      globalSlot: 1,
      leaseToken: "opaque"
    };
    const dependencies = {
      claim: vi.fn().mockResolvedValue(lease),
      renew: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn()
    };
    const worker = vi.fn().mockResolvedValue("ok");

    await expect(
      runWithProviderRequestLease("foreup", worker, dependencies)
    ).resolves.toEqual({ acquired: true, value: "ok" });
    expect(worker).toHaveBeenCalledOnce();
    expect(dependencies.renew).not.toHaveBeenCalled();
    expect(dependencies.release).toHaveBeenCalledWith(lease);
  });

  it("renews both distributed ownership tokens while a long provider worker runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const lease = {
      providerFamilyKey: "CPS",
      globalSlot: 0,
      leaseToken: "opaque-long-worker"
    };
    let simulatedLeaseExpiresAt = Date.now() + 2 * 60 * 1000;
    const dependencies = {
      claim: vi.fn().mockResolvedValue(lease),
      renew: vi.fn(async (renewedLease: typeof lease) => {
        expect(renewedLease).toEqual(lease);
        simulatedLeaseExpiresAt = Date.now() + 2 * 60 * 1000;
        return true;
      }),
      release: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn()
    };
    const worker = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
      expect(simulatedLeaseExpiresAt).toBeGreaterThan(Date.now());
      return "long-worker-complete";
    });

    const execution = runWithProviderRequestLease("CPS", worker, dependencies);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await expect(execution).resolves.toEqual({
      acquired: true,
      value: "long-worker-complete"
    });
    expect(dependencies.renew.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(dependencies.release).toHaveBeenCalledWith(lease);
  });

  it("discards a worker result when token-fenced renewal reports lost ownership", async () => {
    vi.useFakeTimers();
    const lease = {
      providerFamilyKey: "FOREUP",
      globalSlot: 1,
      leaseToken: "expired"
    };
    const dependencies = {
      claim: vi.fn().mockResolvedValue(lease),
      renew: vi.fn().mockResolvedValue(false),
      release: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn()
    };
    const worker = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 31 * 1000));
      return "unsafe-result";
    });

    const execution = runWithProviderRequestLease("FOREUP", worker, dependencies);
    const rejection = expect(execution).rejects.toThrow("Provider request lease expired");
    await vi.advanceTimersByTimeAsync(31 * 1000);

    await rejection;
    expect(dependencies.release).toHaveBeenCalledWith(lease);
  });

  it("defers without provider I/O when the family mutex or both global slots stay busy", async () => {
    const dependencies = {
      claim: vi.fn().mockResolvedValue(null),
      renew: vi.fn(),
      release: vi.fn(),
      wait: vi.fn().mockResolvedValue(undefined)
    };
    const worker = vi.fn();

    await expect(
      runWithProviderRequestLease("FOREUP", worker, dependencies)
    ).resolves.toEqual({ acquired: false });
    expect(dependencies.claim).toHaveBeenCalledTimes(8);
    expect(dependencies.wait).toHaveBeenCalledTimes(7);
    expect(worker).not.toHaveBeenCalled();
  });
});
