import { describe, expect, it } from "vitest";

import {
  getOperatorCourseEvidenceReviewAt,
  OPERATOR_COURSE_EVIDENCE_REVIEW_MS
} from "./operator-evidence-lifecycle";

describe("operator course evidence lifecycle", () => {
  it("schedules fresh validated evidence for review in 30 days", () => {
    const observedAt = new Date("2026-08-01T16:00:00.000Z");

    expect(getOperatorCourseEvidenceReviewAt(observedAt)).toEqual(
      new Date(observedAt.getTime() + OPERATOR_COURSE_EVIDENCE_REVIEW_MS)
    );
    expect(observedAt).toEqual(new Date("2026-08-01T16:00:00.000Z"));
  });
});
