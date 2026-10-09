import { describe, expect, it, vi } from "vitest";
import { retryCourseSupportWriterAdmission } from "./course-support-writer-admission";
import { courseSupportWriterTransactionOptions } from "./course-support-writer-budget";

describe("course-support writer admission", () => {
  it("retries two definite refusals, then runs the transition once", async () => {
    let clock = 0;
    const callback = vi.fn(async () => "saved");
    const lease = vi.fn(async () => lease.mock.calls.length < 3
      ? { acquired: false as const } : { acquired: true as const, value: await callback() });
    const result = await retryCourseSupportWriterAdmission(lease, {
      now: () => clock, sleep: async milliseconds => { clock += milliseconds; },
    });
    expect(result).toEqual({ acquired: true, value: "saved" });
    expect(lease).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(lease.mock.calls.map(call => call[0])).toEqual([60_000, 59_925, 59_775]);
  });

  it("serializes three distinct venue transitions without repeating any callback", async () => {
    let occupied = false;
    const saved: string[] = [];
    const callbacks = ["one", "two", "three"].map(venue => vi.fn(async () => {
      if (venue === "one") await new Promise(resolve => setTimeout(resolve, 20));
      saved.push(venue);
      return venue;
    }));
    const transitions = callbacks.map(callback => retryCourseSupportWriterAdmission(async () => {
      if (occupied) return { acquired: false as const };
      occupied = true;
      try { return { acquired: true as const, value: await callback() }; }
      finally { occupied = false; }
    }));
    expect(await Promise.all(transitions)).toEqual(["one", "two", "three"].map(value => ({ acquired: true, value })));
    expect(saved).toEqual(["one", "two", "three"]);
    callbacks.forEach(callback => expect(callback).toHaveBeenCalledTimes(1));
  });

  it("stops after the admission deadline, including time consumed by the lease", async () => {
    let clock = 0;
    const lease = vi.fn(async () => { clock = 60_000; return { acquired: false as const }; });
    expect(await retryCourseSupportWriterAdmission(lease, { now: () => clock,
      sleep: async () => { throw new Error("must not sleep"); } })).toEqual({ acquired: false });
    expect(lease).toHaveBeenCalledTimes(1);
  });

  it("waits through brief contention but stops within the admission window", async () => {
    let clock = 0;
    const lease = vi.fn(async () => ({ acquired: false as const }));
    expect(await retryCourseSupportWriterAdmission(lease, { now: () => clock,
      sleep: async milliseconds => { clock += milliseconds; } })).toEqual({ acquired: false });
    expect(lease.mock.calls.length).toBeGreaterThan(8);
    expect(lease.mock.calls.length).toBeLessThanOrEqual(32);
    expect(clock).toBeGreaterThanOrEqual(14_000);
    expect(clock).toBeLessThan(15_000);
  });

  it("keeps waiting when a held writer releases after three seconds", async () => {
    let clock = 0;
    const transition = vi.fn(async () => clock < 3_300
      ? { acquired: false as const } : { acquired: true as const, value: "saved" });
    expect(await retryCourseSupportWriterAdmission(transition, { now: () => clock,
      sleep: async milliseconds => { clock += milliseconds; } })).toEqual({ acquired: true, value: "saved" });
    expect(clock).toBeGreaterThanOrEqual(3_300);
    expect(transition.mock.calls.length).toBeGreaterThan(8);
  });

  it("does not enter a late acquired callback when pool wait leaves too little commit budget", async () => {
    let clock = 0;
    const callback = vi.fn();
    const lease = vi.fn(async (timeout: number) => {
      const admittedAt = clock;
      clock += 39_000;
      vi.setSystemTime(clock);
      courseSupportWriterTransactionOptions({ deadlineAt: new Date(admittedAt + timeout), timeoutMs: timeout });
      return { acquired: true as const, value: callback() };
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const readClock = () => clock;
      await expect(retryCourseSupportWriterAdmission(lease, { now: readClock })).rejects.toThrow("before the transition could start");
      expect(callback).not.toHaveBeenCalled();
      expect(lease).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("propagates callback errors and rejects ambiguous results without another attempt", async () => {
    const denied = vi.fn(async () => { throw new Error("stale owner or source"); });
    await expect(retryCourseSupportWriterAdmission(denied)).rejects.toThrow("stale owner or source");
    expect(denied).toHaveBeenCalledTimes(1);
    for (const unexpected of [null, {}, { acquired: true }, { acquired: true, value: "maybe", extra: true }, { acquired: false, value: "maybe" }]) {
      const lease = vi.fn(async () => unexpected as never);
      await expect(retryCourseSupportWriterAdmission(lease)).rejects.toThrow("ambiguous result");
      expect(lease).toHaveBeenCalledTimes(1);
    }
  });

  it("retries only the final database settlement after a completed public read", async () => {
    let clock = 0;
    const read = vi.fn(async () => "public evidence");
    const evidence = await read();
    const settle = vi.fn(async () => evidence);
    const lease = vi.fn(async () => lease.mock.calls.length === 1
      ? { acquired: false as const } : { acquired: true as const, value: await settle() });
    expect(await retryCourseSupportWriterAdmission(lease, { now: () => clock,
      sleep: async milliseconds => { clock += milliseconds; } })).toEqual({ acquired: true, value: evidence });
    expect(read).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
