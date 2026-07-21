import { describe, expect, it } from "vitest";

import {
  clampCourseSupportBatchSize,
  getResponderThreadPolicy,
  sanitizeResponderValue
} from "./course-support-responder-policy";

describe("course-support responder thread policy", () => {
  it.each([
    "no_due_work",
    "deferred_busy",
    "success",
    "classification_only",
    "partial"
  ] as const)("archives routine %s closeouts", (outcome) => {
    expect(
      getResponderThreadPolicy({ outcome, durableCloseoutRecorded: true })
        .threadDisposition
    ).toBe("ARCHIVE");
  });

  it("archives retryable failures only when the next attempt is persisted", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    expect(
      getResponderThreadPolicy({
        outcome: "retryable_failed",
        nextAttemptAt: "2026-07-16T12:00:00.000Z",
        now,
        durableCloseoutRecorded: true
      }).threadDisposition
    ).toBe("ARCHIVE");
    expect(
      getResponderThreadPolicy({
        outcome: "retryable_failed",
        now,
        durableCloseoutRecorded: true
      }).threadDisposition
    ).toBe("KEEP_VISIBLE");
    expect(
      getResponderThreadPolicy({
        outcome: "retryable_failed",
        nextAttemptAt: "2026-07-15T11:59:59.000Z",
        now,
        durableCloseoutRecorded: true
      }).threadDisposition
    ).toBe("KEEP_VISIBLE");
  });

  it.each([
    "needs_human",
    "privacy_incident",
    "delivery_incident",
    "unsafe_provider",
    "migration_failed",
    "deploy_failed",
    "production_verification_failed",
    "blocked_auth",
    "blocked_env",
    "blocked_git",
    "repeated_sla_failure"
  ] as const)("keeps %s visible", (outcome) => {
    expect(
      getResponderThreadPolicy({ outcome, durableCloseoutRecorded: true })
        .threadDisposition
    ).toBe("KEEP_VISIBLE");
  });

  it("keeps same-task owned work visible for direct continuation", () => {
    expect(
      getResponderThreadPolicy({
        outcome: "resume_owned_work",
        durableCloseoutRecorded: true
      })
    ).toEqual({
      threadDisposition: "KEEP_VISIBLE",
      archiveReason: "The responder result requires owner visibility."
    });
  });

  it("never archives before durable closeout", () => {
    expect(
      getResponderThreadPolicy({
        outcome: "success",
        durableCloseoutRecorded: false
      }).threadDisposition
    ).toBe("KEEP_VISIBLE");
  });
});

describe("course-support responder safeguards", () => {
  it("clamps batch size to the rollout and hard limits", () => {
    expect(clampCourseSupportBatchSize(undefined)).toBe(5);
    expect(clampCourseSupportBatchSize(0)).toBe(1);
    expect(clampCourseSupportBatchSize(12.9)).toBe(12);
    expect(clampCourseSupportBatchSize(100)).toBe(20);
  });

  it("redacts structured secrets and sensitive URL parameters", () => {
    expect(
      sanitizeResponderValue({
        token: "private-token",
        leaseToken: "private-lease-token",
        evidence:
          "https://example.test/book?date=2026-07-20&signature=private-signature",
        nested: { authorization: "Bearer private-token" }
      })
    ).toEqual({
      token: "[redacted]",
        leaseToken: "[redacted]",
        evidence: "https://example.test",
        nested: { authorization: "[redacted]" }
      });
  });

  it("redacts forbidden identifiers, recipients, credentials, and URL paths", () => {
    expect(
      sanitizeResponderValue({
        batchId: "database-row-id",
        recipient: "golfer@example.test",
        bookingUrl: "https://user:pass@example.test/session/private?token=x",
        message:
          "email golfer@example.test at https://example.test/session/private or postgresql://user:pass@db.test/app"
      })
    ).toEqual({
      batchId: "[redacted]",
      recipient: "[redacted]",
      bookingUrl: "[redacted]",
      message:
        "email [redacted-email] at https://example.test or [redacted-database-url]"
    });
  });
});
