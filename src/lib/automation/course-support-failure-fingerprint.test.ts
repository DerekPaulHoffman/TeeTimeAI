import { describe, expect, it } from "vitest";

import {
  courseSupportFailureFingerprintsMatch,
  normalizeCourseSupportFailureFingerprint,
} from "./course-support-failure-fingerprint";

describe("course support failure fingerprints", () => {
  it("keeps SHA-256 fingerprints in the lowercase digest contract", () => {
    const lowercase = "a1".repeat(32);

    expect(normalizeCourseSupportFailureFingerprint(lowercase.toUpperCase())).toBe(
      lowercase,
    );
    expect(
      courseSupportFailureFingerprintsMatch(lowercase, lowercase.toUpperCase()),
    ).toBe(true);
  });

  it("keeps named monitoring fingerprints in the existing uppercase contract", () => {
    expect(normalizeCourseSupportFailureFingerprint(" provider:read error ")).toBe(
      "PROVIDER:READ_ERROR",
    );
  });
});
