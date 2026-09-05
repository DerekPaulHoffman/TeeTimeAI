import { describe, expect, it } from "vitest";

import {
  CourseSupportEvidenceRefreshRequiredError,
  getCourseSupportEvidenceRefreshReason,
  isCourseSupportEvidenceRefreshReason,
} from "./course-support-closeout-errors";

describe("course-support evidence refresh authority", () => {
  it("accepts only the typed allowlisted guard, not a copied message or shape", () => {
    const guard = new CourseSupportEvidenceRefreshRequiredError(
      "INCIDENT_VERIFICATION_STALE",
    );
    expect(getCourseSupportEvidenceRefreshReason(guard)).toBe(
      "INCIDENT_VERIFICATION_STALE",
    );
    expect(getCourseSupportEvidenceRefreshReason(new Error(guard.message))).toBeNull();
    expect(getCourseSupportEvidenceRefreshReason({ ...guard })).toBeNull();
    expect(isCourseSupportEvidenceRefreshReason("constructor")).toBe(false);
    expect(isCourseSupportEvidenceRefreshReason("private error text")).toBe(false);
    Object.assign(guard, { reason: "private error text" });
    expect(getCourseSupportEvidenceRefreshReason(guard)).toBeNull();
  });
});
