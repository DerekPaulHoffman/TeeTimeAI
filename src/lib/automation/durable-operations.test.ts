import { describe, expect, it } from "vitest";

import {
  parseCourseEvidence,
  requiresStructuredAutomationAudit
} from "../../../scripts/automation/durable-operations";

const validEvidence = {
  googlePlaceId: "ChIJ-example",
  sourceUrl: "https://course.example/evidence",
  bookingUrl: "https://booking.example/tee-times",
  detectedPlatform: "FOREUP",
  providerFamilyKey: "FOREUP",
  bookingMethod: "PUBLIC_ONLINE",
  bookingAccessMode: "PUBLIC_SIGNED_OUT",
  automationEligibility: "ALLOWED",
  automationReason: "NONE",
  bookingMetadata: { scheduleId: 123 },
  policyNotes: "Official course evidence confirms a public signed-out tee sheet.",
  confidence: 0.95
};

describe("durable course evidence validation", () => {
  it("accepts bounded provider evidence", () => {
    expect(parseCourseEvidence(validEvidence)).toMatchObject({
      googlePlaceId: "ChIJ-example",
      detectedPlatform: "FOREUP",
      automationEligibility: "ALLOWED"
    });
  });

  it("rejects credential-bearing and local URLs", () => {
    expect(() =>
      parseCourseEvidence({
        ...validEvidence,
        sourceUrl: "https://user:secret@course.example/evidence"
      })
    ).toThrow();
    expect(() =>
      parseCourseEvidence({
        ...validEvidence,
        bookingUrl: "http://localhost/tee-times"
      })
    ).toThrow();
  });

  it("requires structured audits only after the structured format contract", () => {
    expect(
      requiresStructuredAutomationAudit("tee-time-spot-improvement-loop-v15")
    ).toBe(true);
    expect(
      requiresStructuredAutomationAudit("tee-time-spot-hourly-improvement-v7")
    ).toBe(true);
    expect(
      requiresStructuredAutomationAudit("tee-time-spot-local-codex-loop-v1")
    ).toBe(false);
    expect(
      requiresStructuredAutomationAudit("tee-time-spot-improvement-loop-v6")
    ).toBe(false);
  });
});
