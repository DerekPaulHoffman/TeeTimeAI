import { describe, expect, it } from "vitest";

import {
  ACTIVE_DEMAND_ESCALATION_MS,
  ACTIVE_HUMAN_RETRY_MS,
  ACTIVE_REMINDER_MS,
  FAILURE_CONFIRMATION_WINDOW_MS,
  INACTIVE_HUMAN_RETRY_MS,
  INACTIVE_INVESTIGATION_MS,
  INACTIVE_REMINDER_MS,
  decideMonitoringFailureState,
  getCourseMonitoringEscalationDeadline,
  getHumanReviewReminderAt,
  getHumanReviewRetryAt,
  inferHumanReviewReason,
  sanitizeEvidenceUrl,
  shouldSleepTechnicalFinalSearch
} from "./course-monitoring";

describe("course monitoring lifecycle", () => {
  it("keeps one failure degraded and confirms two independent paths", () => {
    expect(
      decideMonitoringFailureState([], {
        readPath: "TYPED_PROVIDER_ADAPTER",
        failureFingerprint: "FOREUP:CHALLENGE"
      })
    ).toMatchObject({
      confirmed: false,
      state: "DEGRADED_RETRYING",
      independentPathCount: 1,
      samePathCount: 1
    });

    expect(
      decideMonitoringFailureState(
        [
          {
            readPath: "TYPED_PROVIDER_ADAPTER",
            failureFingerprint: "FOREUP:CHALLENGE"
          }
        ],
        {
          readPath: "SIGNED_OUT_BROWSER",
          failureFingerprint: "FOREUP:CHALLENGE"
        }
      )
    ).toMatchObject({
      confirmed: true,
      state: "AUTO_INVESTIGATING",
      independentPathCount: 2
    });
  });

  it("requires three observations when every failure uses the same path", () => {
    const observation = {
      readPath: "TYPED_PROVIDER_ADAPTER",
      failureFingerprint: "CPS:CHALLENGE"
    };
    expect(decideMonitoringFailureState([observation], observation)).toMatchObject({
      confirmed: false,
      samePathCount: 2
    });
    expect(decideMonitoringFailureState([observation, observation], observation)).toMatchObject({
      confirmed: true,
      state: "AUTO_INVESTIGATING",
      samePathCount: 3
    });
  });

  it("uses the active and inactive escalation and reminder cadences", () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    expect(getCourseMonitoringEscalationDeadline(now, 1).getTime() - now.getTime()).toBe(
      ACTIVE_DEMAND_ESCALATION_MS
    );
    expect(getCourseMonitoringEscalationDeadline(now, 0).getTime() - now.getTime()).toBe(
      INACTIVE_INVESTIGATION_MS
    );
    expect(getHumanReviewRetryAt(now, 1).getTime() - now.getTime()).toBe(ACTIVE_HUMAN_RETRY_MS);
    expect(getHumanReviewRetryAt(now, 0).getTime() - now.getTime()).toBe(INACTIVE_HUMAN_RETRY_MS);
    expect(getHumanReviewReminderAt(now, 1).getTime() - now.getTime()).toBe(ACTIVE_REMINDER_MS);
    expect(getHumanReviewReminderAt(now, 0).getTime() - now.getTime()).toBe(INACTIVE_REMINDER_MS);
    expect(FAILURE_CONFIRMATION_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it("sleeps only when every course is in a final state without revalidation", () => {
    expect(
      shouldSleepTechnicalFinalSearch([
        {
          monitoringStatus: {
            state: "FINAL_TECHNICAL",
            revalidationRequestedAt: null
          }
        },
        {
          monitoringStatus: {
            state: "FINAL_MANUAL",
            revalidationRequestedAt: null
          }
        }
      ])
    ).toBe(true);
    expect(
      shouldSleepTechnicalFinalSearch([
        {
          monitoringStatus: {
            state: "REVALIDATING_FINAL",
            revalidationRequestedAt: new Date()
          }
        }
      ])
    ).toBe(false);
  });

  it("accepts only credential-free HTTPS evidence links", () => {
    expect(sanitizeEvidenceUrl("https://course.example/book#times")).toBe(
      "https://course.example/book"
    );
    expect(sanitizeEvidenceUrl("https://user:secret@course.example/book")).toBeNull();
    expect(sanitizeEvidenceUrl("http://course.example/book")).toBeNull();
  });

  it("maps precise human review reasons without policy classifications", () => {
    expect(
      inferHumanReviewReason({
        kind: "READER_CANDIDATE",
        failureClass: "READER_PARSER_MISSING"
      })
    ).toBe("READER_RELOAD_REQUIRED");
    expect(
      inferHumanReviewReason({
        kind: "FETCH_FAILED",
        failureClass: "CHALLENGE"
      })
    ).toBe("CAPTCHA_OR_QUEUE");
    expect(
      inferHumanReviewReason({
        kind: "NEEDS_ADAPTER",
        failureClass: "MISSING_SOURCE"
      })
    ).toBe("SOURCE_UNVERIFIED");
  });
});
