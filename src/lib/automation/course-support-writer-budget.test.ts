import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCourseSupportWriterCommitHeadroom, assertCourseSupportWriterTransactionStart, courseSupportWriterTransactionOptions } from "./course-support-writer-budget";

describe("course-support writer transition budget", () => {
  afterEach(() => vi.useRealTimers());

  it("refuses a callback after admission and pool waits leave less than one safe transaction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const context = { deadlineAt: new Date(60_000), timeoutMs: 60_000 };
    vi.setSystemTime(38_001);
    expect(() => courseSupportWriterTransactionOptions(context)).toThrow("before the transition could start");
  });

  it("reserves independent pool, transaction, and commit time on each attempt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const context = { deadlineAt: new Date(60_000), timeoutMs: 60_000 };
    expect(courseSupportWriterTransactionOptions(context)).toEqual({ maxWait: 2_000, timeout: 15_000 });
    vi.setSystemTime(38_000);
    expect(courseSupportWriterTransactionOptions(context)).toEqual({ maxWait: 2_000, timeout: 15_000 });
    vi.setSystemTime(40_001);
    expect(() => assertCourseSupportWriterTransactionStart(context)).toThrow("waiting for the transition connection");
  });

  it("stops before commit if work consumes the reserved headroom", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const context = { deadlineAt: new Date(60_000), timeoutMs: 60_000 };
    vi.setSystemTime(54_999);
    expect(() => assertCourseSupportWriterCommitHeadroom(context)).not.toThrow();
    vi.setSystemTime(55_001);
    expect(() => assertCourseSupportWriterCommitHeadroom(context)).toThrow("before transition commit");
  });
});
