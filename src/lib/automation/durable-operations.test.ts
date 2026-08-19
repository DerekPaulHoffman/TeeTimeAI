import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

import {
  COURSE_EVIDENCE_MATERIAL_SNAPSHOT_SELECT,
  assertSafeCourseEvidenceMetadataTransition,
  getCourseEvidenceBookingMetadataUpdate,
  getCourseEvidenceDiscoveryBookingMetadata,
  getCourseEvidencePolicyNoteHistory,
  parseCourseEvidence,
  requiresStructuredAutomationAudit
} from "../../../scripts/automation/durable-operations";
import { COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS } from "./course-provider-execution-evidence";

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

  it("preserves existing booking metadata when the field is omitted", () => {
    expect(getCourseEvidenceBookingMetadataUpdate({})).toEqual({});
  });

  it("requires an explicit instruction to clear booking metadata", () => {
    expect(
      getCourseEvidenceBookingMetadataUpdate({ clearBookingMetadata: true })
    ).toEqual({ bookingMetadata: Prisma.DbNull });
  });

  it("copies preserved metadata into append-only evidence before a later clear", () => {
    const currentMetadata = { scheduleId: 123, bookingBaseUrl: "https://booking.example" };
    const preservedHistory = getCourseEvidenceDiscoveryBookingMetadata(
      {},
      currentMetadata
    );

    expect(preservedHistory).toEqual(currentMetadata);
    expect(
      getCourseEvidenceDiscoveryBookingMetadata(
        { clearBookingMetadata: true },
        currentMetadata
      )
    ).toBe(Prisma.DbNull);
    expect(preservedHistory).toEqual(currentMetadata);
  });

  it("keeps bounded redacted prior and accepted policy notes in history", () => {
    expect(
      getCourseEvidencePolicyNoteHistory(
        "Prior note for golfer@example.com at https://course.example/private/path.",
        "Accepted key sk_abcdefghijklmnopqrst"
      )
    ).toEqual({
      priorPolicyNotes: "Prior note for [redacted-email] at https://course.example",
      acceptedPolicyNotes: "Accepted key [redacted]"
    });
  });

  it("rejects simultaneous booking metadata replacement and clearing", () => {
    expect(() =>
      parseCourseEvidence({
        ...validEvidence,
        clearBookingMetadata: true
      })
    ).toThrow("Choose bookingMetadata replacement or clearBookingMetadata, not both.");
  });

  it("rejects a provider change that silently carries old booking metadata", () => {
    const input = parseCourseEvidence({
      ...validEvidence,
      bookingMetadata: undefined,
      detectedPlatform: "TEEITUP",
      providerFamilyKey: "TEEITUP"
    });

    expect(() =>
      assertSafeCourseEvidenceMetadataTransition(
        {
          bookingMetadata: { scheduleId: 123 },
          detectedPlatform: "FOREUP",
          providerFamilyKey: "FOREUP",
          bookingMethod: "PUBLIC_ONLINE",
          detectedBookingUrl: validEvidence.bookingUrl
        },
        input
      )
    ).toThrow("Provider identity changed while booking metadata was omitted");
  });

  it("allows omitted metadata when provider identity is unchanged", () => {
    const input = parseCourseEvidence({
      ...validEvidence,
      bookingMetadata: undefined
    });

    expect(() =>
      assertSafeCourseEvidenceMetadataTransition(
        {
          bookingMetadata: { scheduleId: 123 },
          detectedPlatform: "FOREUP",
          providerFamilyKey: "FOREUP",
          bookingMethod: "PUBLIC_ONLINE",
          detectedBookingUrl: validEvidence.bookingUrl
        },
        input
      )
    ).not.toThrow();
  });

  it("reads every semantic provider field before comparing operator evidence", () => {
    expect(
      [...COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS].filter(
        (field) => !(field in COURSE_EVIDENCE_MATERIAL_SNAPSHOT_SELECT)
      )
    ).toEqual([]);
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
