import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { appendAutomationPlaybookEvent } from "./course-monitoring-playbook";
import {
  reconcileLegacyParkedCampaignTerminalEvidence,
  type LegacyParkedCampaignTerminalBatchEntry,
  type LegacyParkedCampaignTerminalEvent,
  type LegacyParkedCampaignTerminalIncident,
} from "./course-support-campaign-terminal-reconciliation";

const campaignRunId = "campaign-run-1";
const membershipDigest = "c".repeat(64);
const releaseSha = "a".repeat(40);
const capturedAt = new Date("2026-08-20T12:00:00.000Z");
const confirmedAt = new Date("2026-08-20T12:01:00.000Z");
const deployedAt = new Date("2026-08-20T12:02:00.000Z");
const dispatchStartedAt = new Date("2026-08-20T12:03:00.000Z");
const verifiedAt = new Date("2026-08-20T12:06:00.000Z");
const closeoutAt = new Date("2026-08-20T12:07:00.000Z");
const courseRef = createHash("sha256")
  .update("course-1")
  .digest("hex")
  .slice(0, 24);

type TerminalSemantics = {
  monitoringState: "FINAL_MANUAL" | "FINAL_IDENTITY" | "FINAL_TECHNICAL";
  resolution:
    "DIRECT_BOOKING_CLASSIFIED" | "IDENTITY_CLASSIFIED" | "SOURCE_UNVERIFIED";
  finalKind:
    | "manual_direct"
    | "identity"
    | "source_unverified"
    | "known_technical_limitation";
};

function reconciliationFixture(input: {
  proofSnapshot: unknown;
  semantics?: TerminalSemantics;
  attemptLedger?: unknown;
  incident?: Partial<LegacyParkedCampaignTerminalIncident>;
  event?: Partial<LegacyParkedCampaignTerminalEvent>;
  entry?: Partial<LegacyParkedCampaignTerminalBatchEntry>;
  batch?: Partial<LegacyParkedCampaignTerminalBatchEntry["batch"]>;
}) {
  const semantics = input.semantics ?? {
    monitoringState: "FINAL_MANUAL",
    resolution: "DIRECT_BOOKING_CLASSIFIED",
    finalKind: "manual_direct",
  };
  const incident: LegacyParkedCampaignTerminalIncident = {
    id: "incident-1",
    courseId: "course-1",
    cycle: 4,
    status: "RESOLVED",
    activeBatchId: null,
    confirmedAt,
    firstSeenAt: new Date("2026-08-19T12:00:00.000Z"),
    resolvedAt: closeoutAt,
    resolution: semantics.resolution,
    providerFamilyKey: "CPS",
    failureClass: "MISSING_METADATA",
    attemptCount: 1,
    activeRealSearchCount: 0,
    attemptLedger: input.attemptLedger ?? null,
    monitoringState: semantics.monitoringState,
    monitoringStateChangedAt: closeoutAt,
    ...input.incident,
  };
  const event: LegacyParkedCampaignTerminalEvent = {
    id: "terminal-event-1",
    incidentId: incident.id,
    courseId: incident.courseId,
    eventType: "STATE_CHANGED",
    source: "COURSE_SUPPORT_RESPONDER",
    fromState: "AUTO_INVESTIGATING",
    toState: semantics.monitoringState,
    occurredAt: closeoutAt,
    runtimeVersion: releaseSha,
    deploymentSha: releaseSha,
    audit: {
      automatedFinal: true,
      finalKind: semantics.finalKind,
      customerDataIncluded: false,
      cycle: incident.cycle,
      confirmedAt: incident.confirmedAt?.toISOString() ?? null,
      campaign: {
        kind: "PARKED_COHORT",
        runId: campaignRunId,
        membershipDigest,
        cycle: incident.cycle,
      },
    },
    ...input.event,
  };
  const batch = {
    id: "batch-1",
    status: "SUCCEEDED",
    createdAt: new Date("2026-08-20T12:00:30.000Z"),
    completedAt: closeoutAt,
    releaseSha,
    deployedAt,
    recheckDispatchStartedAt: dispatchStartedAt,
    summary: {
      campaign: {
        kind: "PARKED_COHORT",
        attempts: [
          {
            courseRef,
            runId: campaignRunId,
            membershipDigest,
            cycle: incident.cycle,
          },
        ],
      },
    },
    ...input.batch,
  };
  const entry: LegacyParkedCampaignTerminalBatchEntry = {
    id: "batch-entry-1",
    batchId: batch.id,
    incidentId: incident.id,
    courseId: incident.courseId,
    cycle: incident.cycle,
    result: "FINAL_DISPOSITION",
    proofSnapshot: input.proofSnapshot,
    verifiedAt,
    verifiedIncidentUpdatedAt: new Date("2026-08-20T12:05:00.000Z"),
    createdAt: new Date("2026-08-20T12:00:30.000Z"),
    updatedAt: verifiedAt,
    batch,
    ...input.entry,
  };
  return {
    input: {
      campaignRunId,
      campaignMembershipDigest: membershipDigest,
      campaignCapturedAt: capturedAt,
      member: { courseId: "course-1", incidentId: "incident-1", cycle: 3 },
      incident,
      event,
      batchEntries: [entry],
    },
    incident,
    event,
    entry,
  };
}

function exactPlaceReviewProof() {
  return {
    kind: "EXACT_PLACE_REVIEW",
    disposition: "VERIFIED_NON_COURSE",
    classification: "PRIVATE_PRACTICE_GREEN",
    evidenceOrigin: "https://course.example",
    reviewedAt: "2026-08-20T00:00:00.000Z",
    reviewUpdatedAt: "2026-08-20T12:04:00.000Z",
    automationEligibility: "BLOCKED",
    automationReason: "OTHER",
  };
}

const browserPrivatePolicyNotes =
  "The official course profile identifies this course as private. Tee Time Spot must not present public tee-time monitoring for member-controlled inventory.";

function browserPrivateProof() {
  return {
    kind: "BROWSER_PRIVATE_IDENTITY",
    disposition: "VERIFIED_PRIVATE",
    discoveryCreatedAt: "2026-08-20T12:04:00.000Z",
    intelligenceVerifiedAt: "2026-08-20T12:04:30.000Z",
    intelligenceReviewAt: "2027-02-15T12:04:30.000Z",
    evidenceOrigin: "https://course.example",
    provenance: "official-private-course-profile",
    confidence: 0.98,
    intelligenceConfidence: 0.98,
    policyNotes: browserPrivatePolicyNotes,
    courseBookingMethod: "UNKNOWN",
    courseAutomationEligibility: "BLOCKED",
    courseAutomationReason: "OTHER",
    discoveryStatus: "VERIFIED",
    discoveryDetectedPlatform: "UNKNOWN",
    discoveryBookingMethod: "UNKNOWN",
    discoveryBookingPhone: null,
    discoveryAutomationEligibility: "BLOCKED",
    discoveryAutomationReason: "OTHER",
    discoveryApiEndpoint: null,
    discoveryApiMetadata: null,
  };
}

function manualDirectProof() {
  return {
    kind: "FINAL_DISPOSITION",
    disposition: "MANUAL_DIRECT",
    evidenceOrigin: "https://course.example",
    discoveryCreatedAt: "2026-08-20T12:04:00.000Z",
    confidence: 0.9,
    discoveryStatus: "VERIFIED",
    bookingMethod: "PHONE_ONLY",
    automationEligibility: "BLOCKED",
    automationReason: "NO_ONLINE_BOOKING",
    discoveryBookingMethod: "PHONE_ONLY",
    discoveryAutomationEligibility: "BLOCKED",
    discoveryAutomationReason: "NO_ONLINE_BOOKING",
  };
}

function factualFinalEvidence(disposition: "MANUAL_DIRECT" | "IDENTITY_FINAL") {
  let attemptLedger: unknown = null;
  const stages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY", "NO_PROVIDER_METADATA"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER", "NO_RUNNABLE_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP", "NO_PROVIDER_METADATA"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NO_METADATA_CHANGE"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER", "NO_BROWSER_ROUTE"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NO_METADATA_CHANGE"],
    ["LOCAL_READER", "LOCAL_READER", "NO_LOCAL_READER_CAPABILITY"],
  ] as const;
  for (const [stage, readPath, skipReason] of stages) {
    attemptLedger = appendAutomationPlaybookEvent(attemptLedger, {
      cycle: 4,
      stage,
      transition: "NOT_APPLICABLE",
      readPath,
      evidenceKind: "TOOLING",
      failureFingerprint: `PLAYBOOK:${stage}:${skipReason}`,
      runtimeVersion: releaseSha,
      skipReason,
      observedAt: new Date("2026-08-20T12:04:00.000Z"),
    });
  }
  attemptLedger = appendAutomationPlaybookEvent(attemptLedger, {
    cycle: 4,
    stage: "INDEPENDENT_CONFIRMATION",
    transition: "FACTUAL_FINAL",
    readPath: "INDEPENDENT_CONFIRMATION",
    evidenceKind: "RENDERED_PAGE",
    failureFingerprint: `PLAYBOOK:INDEPENDENT_CONFIRMATION:${disposition}`,
    runtimeVersion: releaseSha,
    factualDisposition: disposition,
    observedAt: new Date("2026-08-20T12:04:30.000Z"),
  });
  const event = (
    attemptLedger as { events: Array<Record<string, unknown>> }
  ).events.at(-1)!;
  return {
    attemptLedger,
    proofSnapshot: {
      schemaVersion: 1,
      kind: "PLAYBOOK_FACTUAL_FINAL",
      playbookVersion: 1,
      disposition,
      outcome: disposition,
      cycle: 4,
      stage: event.stage,
      sequence: event.sequence,
      readPath: event.readPath,
      evidenceKind: event.evidenceKind,
      failureFingerprint: event.failureFingerprint,
      observedAt: event.observedAt,
      completedAt: "2026-08-20T12:05:00.000Z",
      releaseSha,
      runtimeVersion: releaseSha,
      providerExecution: false,
    },
  };
}

function sourceUnverifiedEvidence() {
  let attemptLedger: unknown = null;
  const stages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY", "NO_PROVIDER_METADATA"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER", "NO_RUNNABLE_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP", "NO_PROVIDER_METADATA"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NO_METADATA_CHANGE"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER", "NO_BROWSER_ROUTE"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NO_METADATA_CHANGE"],
    ["LOCAL_READER", "LOCAL_READER", "NO_LOCAL_READER_CAPABILITY"],
  ] as const;
  for (const [stage, readPath, skipReason] of stages) {
    attemptLedger =
      stage === "OFFICIAL_IDENTITY"
        ? appendAutomationPlaybookEvent(attemptLedger, {
            cycle: 4,
            stage,
            transition: "FAILED_TERMINAL",
            readPath,
            evidenceKind: "OFFICIAL_SOURCE",
            failureFingerprint: `SOURCE_UNVERIFIED:${stage}`,
            runtimeVersion: releaseSha,
            failureClass: "MISSING_SOURCE",
            observedAt: new Date("2026-08-20T12:04:00.000Z"),
          })
        : appendAutomationPlaybookEvent(attemptLedger, {
            cycle: 4,
            stage,
            transition: "NOT_APPLICABLE",
            readPath,
            evidenceKind: "TOOLING",
            failureFingerprint: `SOURCE_UNVERIFIED:${stage}`,
            runtimeVersion: releaseSha,
            skipReason,
            observedAt: new Date("2026-08-20T12:04:00.000Z"),
          });
  }
  attemptLedger = appendAutomationPlaybookEvent(attemptLedger, {
    cycle: 4,
    stage: "INDEPENDENT_CONFIRMATION",
    transition: "FAILED_TERMINAL",
    readPath: "INDEPENDENT_CONFIRMATION",
    evidenceKind: "RENDERED_PAGE",
    failureFingerprint: "SOURCE_UNVERIFIED:INDEPENDENT_CONFIRMATION",
    runtimeVersion: releaseSha,
    failureClass: "MISSING_SOURCE",
    observedAt: new Date("2026-08-20T12:04:30.000Z"),
  });
  const firstSeenAt = new Date("2026-08-19T12:00:00.000Z");
  return {
    attemptLedger,
    proofSnapshot: {
      kind: "SOURCE_UNVERIFIED_FINAL",
      disposition: "SOURCE_UNVERIFIED",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      attemptCount: 1,
      activeRealSearchCount: 0,
      firstSeenAt: firstSeenAt.toISOString(),
      freshCycleStartedAt: confirmedAt.toISOString(),
      cycle: 4,
      completedStageCount: 8,
      verifiedAt: verifiedAt.toISOString(),
    },
    incident: {
      firstSeenAt,
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
    },
  };
}

describe("legacy parked-campaign terminal reconciliation", () => {
  it.each([
    ["exact place review", exactPlaceReviewProof()],
    ["browser private identity", browserPrivateProof()],
  ])("revalidates a completed %s identity proof", (_label, proofSnapshot) => {
    const fixture = reconciliationFixture({
      proofSnapshot,
      batch: { recheckDispatchStartedAt: null },
      semantics: {
        monitoringState: "FINAL_IDENTITY",
        resolution: "IDENTITY_CLASSIFIED",
        finalKind: "identity",
      },
    });

    expect(
      reconcileLegacyParkedCampaignTerminalEvidence(fixture.input),
    ).toMatchObject({
      freshRuntimeProof: true,
      source: "LEGACY_COMPLETED_BATCH_REVALIDATION",
    });
  });

  it.each(["MANUAL_DIRECT", "IDENTITY_FINAL"] as const)(
    "revalidates an exact-release PLAYBOOK_FACTUAL_FINAL %s proof",
    (disposition) => {
      const factual = factualFinalEvidence(disposition);
      const identity = disposition === "IDENTITY_FINAL";
      const fixture = reconciliationFixture({
        proofSnapshot: factual.proofSnapshot,
        attemptLedger: factual.attemptLedger,
        semantics: identity
          ? {
              monitoringState: "FINAL_IDENTITY",
              resolution: "IDENTITY_CLASSIFIED",
              finalKind: "identity",
            }
          : undefined,
      });

      expect(
        reconcileLegacyParkedCampaignTerminalEvidence(fixture.input),
      ).toMatchObject({
        freshRuntimeProof: true,
        proofKind: "PLAYBOOK_FACTUAL_FINAL",
      });
    },
  );

  it("revalidates a fresh complete SOURCE_UNVERIFIED_FINAL ladder", () => {
    const source = sourceUnverifiedEvidence();
    const fixture = reconciliationFixture({
      proofSnapshot: source.proofSnapshot,
      attemptLedger: source.attemptLedger,
      incident: source.incident,
      semantics: {
        monitoringState: "FINAL_TECHNICAL",
        resolution: "SOURCE_UNVERIFIED",
        finalKind: "source_unverified",
      },
    });

    expect(
      reconcileLegacyParkedCampaignTerminalEvidence(fixture.input),
    ).toMatchObject({
      freshRuntimeProof: true,
      proofKind: "SOURCE_UNVERIFIED_FINAL",
    });
  });

  it("revalidates coherent generic MANUAL_DIRECT evidence", () => {
    const fixture = reconciliationFixture({
      proofSnapshot: manualDirectProof(),
    });
    const first = reconcileLegacyParkedCampaignTerminalEvidence(fixture.input);
    const second = reconcileLegacyParkedCampaignTerminalEvidence(fixture.input);

    expect(first).toMatchObject({
      freshRuntimeProof: true,
      proofKind: "FINAL_DISPOSITION",
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(second).toEqual(first);
  });

  it.each(["ACCOUNT_REQUIRED", "CAPTCHA_OR_QUEUE"])(
    "rejects generic %s because the writer normalizes it to NEEDS_HUMAN",
    (disposition) => {
      const fixture = reconciliationFixture({
        proofSnapshot: {
          ...manualDirectProof(),
          disposition,
        },
        semantics: {
          monitoringState: "FINAL_TECHNICAL",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          finalKind: "known_technical_limitation",
        },
      });
      expect(
        reconcileLegacyParkedCampaignTerminalEvidence(fixture.input),
      ).toBeNull();
    },
  );

  it.each([
    {
      label: "event campaign provenance",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        const audit = fixture.event.audit as {
          campaign: Record<string, unknown>;
        };
        audit.campaign.unexpected = true;
      },
    },
    {
      label: "batch campaign provenance",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        const summary = fixture.entry.batch.summary as {
          campaign: Record<string, unknown>;
        };
        summary.campaign.unexpected = true;
      },
    },
    {
      label: "batch campaign-attempt provenance",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        const summary = fixture.entry.batch.summary as {
          campaign: { attempts: Array<Record<string, unknown>> };
        };
        summary.campaign.attempts[0]!.unexpected = true;
      },
    },
  ])("rejects an extra key in $label", ({ mutate }) => {
    const fixture = reconciliationFixture({
      proofSnapshot: manualDirectProof(),
    });
    mutate(fixture);
    expect(
      reconcileLegacyParkedCampaignTerminalEvidence(fixture.input),
    ).toBeNull();
  });

  it.each([
    {
      label: "the release differs",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        fixture.entry.batch.releaseSha = "b".repeat(40);
      },
    },
    {
      label: "deployment parity is absent",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        fixture.entry.batch.deployedAt = null;
      },
    },
    {
      label: "the completed batch timestamp differs",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        fixture.entry.batch.completedAt = new Date(
          closeoutAt.getTime() + 1_000,
        );
      },
    },
    {
      label: "the proof carrier changed after closeout",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        fixture.entry.updatedAt = new Date(closeoutAt.getTime() + 1_000);
      },
    },
    {
      label: "the incident cycle differs",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        fixture.entry.cycle += 1;
      },
    },
    {
      label: "the terminal event belongs to another course",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        fixture.event.courseId = "course-2";
      },
    },
    {
      label: "campaign provenance differs",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        const summary = fixture.entry.batch.summary as {
          campaign: { attempts: Array<{ membershipDigest: string }> };
        };
        summary.campaign.attempts[0]!.membershipDigest = "d".repeat(64);
      },
    },
    {
      label: "the proof snapshot is stale",
      mutate: (fixture: ReturnType<typeof reconciliationFixture>) => {
        fixture.entry.proofSnapshot = {
          ...exactPlaceReviewProof(),
          reviewUpdatedAt: "2026-08-20T12:00:30.000Z",
        };
      },
    },
  ])("leaves an engineering blocker when $label", ({ mutate }) => {
    const fixture = reconciliationFixture({
      proofSnapshot: exactPlaceReviewProof(),
      semantics: {
        monitoringState: "FINAL_IDENTITY",
        resolution: "IDENTITY_CLASSIFIED",
        finalKind: "identity",
      },
    });
    mutate(fixture);
    expect(
      reconcileLegacyParkedCampaignTerminalEvidence(fixture.input),
    ).toBeNull();
  });

  it("never overrides an explicit fresh-runtime value", () => {
    for (const freshRuntimeProof of [false, null]) {
      const fixture = reconciliationFixture({
        proofSnapshot: manualDirectProof(),
      });
      fixture.event.audit = {
        ...(fixture.event.audit as Record<string, unknown>),
        freshRuntimeProof,
      };
      expect(
        reconcileLegacyParkedCampaignTerminalEvidence(fixture.input),
      ).toBeNull();
    }
  });

  it("rejects ambiguous duplicate completed proof carriers", () => {
    const fixture = reconciliationFixture({
      proofSnapshot: manualDirectProof(),
    });
    fixture.input.batchEntries = [
      fixture.entry,
      {
        ...fixture.entry,
        id: "batch-entry-duplicate",
      },
    ];
    expect(
      reconcileLegacyParkedCampaignTerminalEvidence(fixture.input),
    ).toBeNull();
  });
});
