import { createHash } from "node:crypto";

import { isCoherentManualDisposition } from "./policy";
import {
  AUTOMATION_PLAYBOOK_STAGES,
  assessAutomationPlaybook,
} from "./course-monitoring-playbook";
import { stableCourseProviderExecutionEvidenceValue } from "./course-provider-execution-evidence";
import { isCourseSupportFactualFinalProof } from "./course-support-verification";

const RELEASE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const MEMBERSHIP_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const EVENT_CAMPAIGN_PROVENANCE_KEYS = [
  "kind",
  "runId",
  "membershipDigest",
  "cycle",
] as const;
const BATCH_CAMPAIGN_PROVENANCE_KEYS = ["kind", "attempts"] as const;
const CAMPAIGN_ATTEMPT_PROVENANCE_KEYS = [
  "courseRef",
  "runId",
  "membershipDigest",
  "cycle",
] as const;

const VERIFIED_BROWSER_PRIVATE_POLICY_NOTES = new Map([
  [
    "official-private-course-profile",
    "The official course profile identifies this course as private. Tee Time Spot must not present public tee-time monitoring for member-controlled inventory.",
  ],
  [
    "official-private-club-access",
    "The course's official site identifies it as a private club and limits access to members and their guests. Tee Time Spot must not present automated public tee-time monitoring for this course.",
  ],
  [
    "official-resident-member-access",
    "The official site identifies this as a neighborhood social club for residents and says the golf course is a member amenity. Tee Time Spot must not present automated public tee-time monitoring for this course.",
  ],
]);

type LegacyTerminalResolution =
  "DIRECT_BOOKING_CLASSIFIED" | "IDENTITY_CLASSIFIED" | "SOURCE_UNVERIFIED";

type LegacyTerminalState =
  "FINAL_MANUAL" | "FINAL_IDENTITY" | "FINAL_TECHNICAL";

export type LegacyParkedCampaignTerminalEvent = {
  id: string;
  incidentId: string | null;
  courseId: string | null;
  eventType: string;
  source: string;
  fromState: string | null;
  toState: string | null;
  occurredAt: Date;
  runtimeVersion: string | null;
  deploymentSha: string | null;
  audit: unknown;
};

export type LegacyParkedCampaignTerminalIncident = {
  id: string;
  courseId: string;
  cycle: number;
  status: string;
  activeBatchId: string | null;
  confirmedAt: Date | null;
  firstSeenAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
  providerFamilyKey: string;
  failureClass: string;
  attemptCount: number;
  activeRealSearchCount: number;
  attemptLedger: unknown;
  monitoringState: string | null;
  monitoringStateChangedAt: Date | null;
};

export type LegacyParkedCampaignTerminalBatchEntry = {
  id: string;
  batchId: string;
  incidentId: string;
  courseId: string;
  cycle: number;
  result: string;
  proofSnapshot: unknown;
  verifiedAt: Date | null;
  verifiedIncidentUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  batch: {
    id: string;
    status: string;
    createdAt: Date;
    completedAt: Date | null;
    releaseSha: string | null;
    deployedAt: Date | null;
    recheckDispatchStartedAt: Date | null;
    summary: unknown;
  };
};

export type LegacyParkedCampaignTerminalReconciliation = {
  freshRuntimeProof: true;
  source: "LEGACY_COMPLETED_BATCH_REVALIDATION";
  proofKind: string;
  evidenceDigest: string;
};

/**
 * Read-only compatibility for the short-lived writer shape that persisted a
 * complete FINAL_DISPOSITION closeout but omitted `audit.freshRuntimeProof`
 * from its STATE_CHANGED event. This deliberately does not backfill or infer
 * the bit from resolved state. Every inspection revalidates the exact durable
 * batch proof and returns the same derived result without writing anything.
 */
export function reconcileLegacyParkedCampaignTerminalEvidence(input: {
  campaignRunId: string;
  campaignMembershipDigest: string;
  campaignCapturedAt: Date;
  member: { courseId: string; incidentId: string; cycle: number };
  incident: LegacyParkedCampaignTerminalIncident;
  event: LegacyParkedCampaignTerminalEvent;
  batchEntries: readonly LegacyParkedCampaignTerminalBatchEntry[];
}): LegacyParkedCampaignTerminalReconciliation | null {
  const eventAudit = asRecord(input.event.audit);
  const campaign = asRecord(eventAudit.campaign);
  const incident = input.incident;
  const event = input.event;
  if (
    !input.campaignRunId.trim() ||
    !MEMBERSHIP_DIGEST_PATTERN.test(input.campaignMembershipDigest) ||
    input.member.courseId !== incident.courseId ||
    input.member.incidentId !== incident.id ||
    incident.cycle <= input.member.cycle ||
    incident.status !== "RESOLVED" ||
    incident.activeBatchId !== null ||
    !incident.confirmedAt ||
    incident.confirmedAt.getTime() < input.campaignCapturedAt.getTime() ||
    !incident.resolvedAt ||
    incident.resolvedAt.getTime() !== event.occurredAt.getTime() ||
    !incident.monitoringStateChangedAt ||
    incident.monitoringStateChangedAt.getTime() !==
      event.occurredAt.getTime() ||
    event.incidentId !== incident.id ||
    event.courseId !== incident.courseId ||
    event.eventType !== "STATE_CHANGED" ||
    event.source !== "COURSE_SUPPORT_RESPONDER" ||
    event.fromState !== "AUTO_INVESTIGATING" ||
    event.occurredAt.getTime() < incident.confirmedAt.getTime() ||
    !event.runtimeVersion ||
    !RELEASE_SHA_PATTERN.test(event.runtimeVersion) ||
    event.deploymentSha !== event.runtimeVersion ||
    Object.prototype.hasOwnProperty.call(eventAudit, "freshRuntimeProof") ||
    eventAudit.automatedFinal !== true ||
    eventAudit.customerDataIncluded !== false ||
    eventAudit.cycle !== incident.cycle ||
    eventAudit.confirmedAt !== incident.confirmedAt.toISOString() ||
    !hasExactKeys(campaign, EVENT_CAMPAIGN_PROVENANCE_KEYS) ||
    campaign.kind !== "PARKED_COHORT" ||
    campaign.runId !== input.campaignRunId ||
    campaign.membershipDigest !== input.campaignMembershipDigest ||
    campaign.cycle !== incident.cycle
  ) {
    return null;
  }

  const exactCandidates = input.batchEntries.filter((entry) =>
    isExactCompletedLegacyTerminalBatchEntry({
      entry,
      event,
      incident,
      campaignRunId: input.campaignRunId,
      campaignMembershipDigest: input.campaignMembershipDigest,
    }),
  );
  if (exactCandidates.length !== 1) return null;
  const entry = exactCandidates[0]!;
  const terminal = getLegacyTerminalProofSemantics(entry.proofSnapshot);
  if (
    !terminal ||
    event.toState !== terminal.monitoringState ||
    incident.monitoringState !== terminal.monitoringState ||
    incident.resolution !== terminal.resolution ||
    eventAudit.finalKind !== terminal.finalKind ||
    !isDurableLegacyFinalDispositionProof({ entry, incident })
  ) {
    return null;
  }

  return {
    freshRuntimeProof: true,
    source: "LEGACY_COMPLETED_BATCH_REVALIDATION",
    proofKind: terminal.proofKind,
    evidenceDigest: createHash("sha256")
      .update(
        stableCourseProviderExecutionEvidenceValue({
          campaignRunId: input.campaignRunId,
          campaignMembershipDigest: input.campaignMembershipDigest,
          courseId: incident.courseId,
          incidentId: incident.id,
          cycle: incident.cycle,
          eventId: event.id,
          occurredAt: event.occurredAt.toISOString(),
          runtimeVersion: event.runtimeVersion,
          batchId: entry.batch.id,
          batchIncidentId: entry.id,
          verifiedAt: entry.verifiedAt?.toISOString() ?? null,
          proofSnapshot: entry.proofSnapshot,
        }),
      )
      .digest("hex"),
  };
}

function isExactCompletedLegacyTerminalBatchEntry(input: {
  entry: LegacyParkedCampaignTerminalBatchEntry;
  event: LegacyParkedCampaignTerminalEvent;
  incident: LegacyParkedCampaignTerminalIncident;
  campaignRunId: string;
  campaignMembershipDigest: string;
}) {
  const { entry, event, incident } = input;
  const batch = entry.batch;
  if (
    entry.batchId !== batch.id ||
    entry.incidentId !== incident.id ||
    entry.courseId !== incident.courseId ||
    entry.cycle !== incident.cycle ||
    entry.result !== "FINAL_DISPOSITION" ||
    !entry.verifiedAt ||
    !entry.verifiedIncidentUpdatedAt ||
    entry.createdAt.getTime() > entry.verifiedAt.getTime() ||
    entry.createdAt.getTime() > entry.updatedAt.getTime() ||
    entry.updatedAt.getTime() < entry.verifiedAt.getTime() ||
    entry.updatedAt.getTime() > event.occurredAt.getTime() ||
    entry.verifiedIncidentUpdatedAt.getTime() <
      incident.confirmedAt!.getTime() ||
    entry.verifiedIncidentUpdatedAt.getTime() > entry.verifiedAt.getTime() ||
    entry.verifiedAt.getTime() > event.occurredAt.getTime() ||
    (batch.status !== "SUCCEEDED" && batch.status !== "PARTIAL") ||
    !batch.completedAt ||
    batch.completedAt.getTime() !== event.occurredAt.getTime() ||
    batch.createdAt.getTime() > entry.verifiedAt.getTime() ||
    !batch.releaseSha ||
    batch.releaseSha !== event.runtimeVersion ||
    !RELEASE_SHA_PATTERN.test(batch.releaseSha) ||
    !batch.deployedAt ||
    batch.deployedAt.getTime() > entry.verifiedAt.getTime() ||
    (batch.recheckDispatchStartedAt !== null &&
      (batch.recheckDispatchStartedAt.getTime() < batch.deployedAt.getTime() ||
        batch.recheckDispatchStartedAt.getTime() > entry.verifiedAt.getTime()))
  ) {
    return false;
  }
  return hasExactCampaignAttempt({
    summary: batch.summary,
    courseId: incident.courseId,
    cycle: incident.cycle,
    campaignRunId: input.campaignRunId,
    campaignMembershipDigest: input.campaignMembershipDigest,
  });
}

function hasExactCampaignAttempt(input: {
  summary: unknown;
  courseId: string;
  cycle: number;
  campaignRunId: string;
  campaignMembershipDigest: string;
}) {
  const campaign = asRecord(asRecord(input.summary).campaign);
  if (
    !hasExactKeys(campaign, BATCH_CAMPAIGN_PROVENANCE_KEYS) ||
    campaign.kind !== "PARKED_COHORT" ||
    !Array.isArray(campaign.attempts)
  ) {
    return false;
  }
  const courseRef = createHash("sha256")
    .update(input.courseId)
    .digest("hex")
    .slice(0, 24);
  const attempts = campaign.attempts.map(asRecord);
  if (
    !attempts.every((attempt) =>
      hasExactKeys(attempt, CAMPAIGN_ATTEMPT_PROVENANCE_KEYS),
    )
  ) {
    return false;
  }
  const matchingAttempts = attempts.filter(
    (attempt) => attempt.courseRef === courseRef,
  );
  return (
    matchingAttempts.length === 1 &&
    matchingAttempts[0]?.runId === input.campaignRunId &&
    matchingAttempts[0]?.membershipDigest === input.campaignMembershipDigest &&
    matchingAttempts[0]?.cycle === input.cycle
  );
}

function isDurableLegacyFinalDispositionProof(input: {
  entry: LegacyParkedCampaignTerminalBatchEntry;
  incident: LegacyParkedCampaignTerminalIncident;
}) {
  const { entry, incident } = input;
  const proof = asRecord(entry.proofSnapshot);
  const verifiedAt = entry.verifiedAt!;
  const terminalEvidenceBoundary = incident.confirmedAt ?? incident.firstSeenAt;
  const batch = entry.batch;
  if (proof.kind === "PLAYBOOK_FACTUAL_FINAL") {
    return isCourseSupportFactualFinalProof({
      proof,
      attemptLedger: incident.attemptLedger,
      cycle: incident.cycle,
      firstSeenAt: terminalEvidenceBoundary,
      releaseSha: batch.releaseSha!,
      verifiedAt,
      notBefore: [
        batch.deployedAt!,
        ...(batch.recheckDispatchStartedAt
          ? [batch.recheckDispatchStartedAt]
          : []),
      ],
      now: verifiedAt,
    });
  }
  if (proof.kind === "SOURCE_UNVERIFIED_FINAL") {
    const firstSeenAt = parseExactDate(proof.firstSeenAt);
    const freshCycleStartedAt = parseExactDate(proof.freshCycleStartedAt);
    const proofVerifiedAt = parseExactDate(proof.verifiedAt);
    const playbook = assessAutomationPlaybook(
      incident.attemptLedger,
      incident.cycle,
    );
    return Boolean(
      proof.disposition === "SOURCE_UNVERIFIED" &&
      proof.providerFamilyKey === incident.providerFamilyKey &&
      proof.failureClass === incident.failureClass &&
      proof.attemptCount === incident.attemptCount &&
      proof.activeRealSearchCount === incident.activeRealSearchCount &&
      proof.cycle === incident.cycle &&
      proof.completedStageCount === AUTOMATION_PLAYBOOK_STAGES.length &&
      ((incident.providerFamilyKey === "SOURCE_MISSING" &&
        incident.failureClass === "MISSING_SOURCE") ||
        (incident.providerFamilyKey === "SOURCE_CONFLICT" &&
          incident.failureClass === "MISSING_METADATA")) &&
      firstSeenAt?.getTime() === incident.firstSeenAt.getTime() &&
      freshCycleStartedAt?.getTime() === incident.confirmedAt?.getTime() &&
      proofVerifiedAt?.getTime() === verifiedAt.getTime() &&
      proofVerifiedAt.getTime() >= freshCycleStartedAt!.getTime() &&
      playbook.valid &&
      playbook.cycle === incident.cycle &&
      playbook.conclusion === "UNRESOLVED_EXHAUSTED" &&
      playbook.completedStages.length === AUTOMATION_PLAYBOOK_STAGES.length &&
      hasDurableSourceUnverifiedPlaybookEvidence(
        playbook,
        freshCycleStartedAt!,
      ),
    );
  }
  if (proof.kind === "EXACT_PLACE_REVIEW") {
    const reviewUpdatedAt = parseExactDate(proof.reviewUpdatedAt);
    const reviewedAt = parseExactDate(proof.reviewedAt);
    return Boolean(
      (proof.disposition === "VERIFIED_PRIVATE" ||
        proof.disposition === "VERIFIED_NON_COURSE") &&
      typeof proof.classification === "string" &&
      proof.classification.trim() &&
      typeof proof.evidenceOrigin === "string" &&
      getSafeEvidenceOrigin(proof.evidenceOrigin) === proof.evidenceOrigin &&
      reviewedAt &&
      reviewUpdatedAt &&
      reviewUpdatedAt.getTime() >= terminalEvidenceBoundary.getTime() &&
      reviewUpdatedAt.getTime() <= verifiedAt.getTime() + 60_000 &&
      proof.automationEligibility === "BLOCKED" &&
      proof.automationReason === "OTHER",
    );
  }
  if (proof.kind === "BROWSER_PRIVATE_IDENTITY") {
    return isDurableBrowserPrivateIdentityProof({
      proof,
      terminalEvidenceBoundary,
      verifiedAt,
    });
  }
  if (proof.kind !== "FINAL_DISPOSITION") return false;
  // The shared writer converts account and access-challenge outcomes to
  // NEEDS_HUMAN before closeout. Only MANUAL_DIRECT could have produced the
  // persisted FINAL_DISPOSITION event being reconciled here.
  if (proof.disposition !== "MANUAL_DIRECT") return false;
  const discoveredAt = parseExactDate(proof.discoveryCreatedAt);
  return Boolean(
    typeof proof.evidenceOrigin === "string" &&
    getSafeEvidenceOrigin(proof.evidenceOrigin) === proof.evidenceOrigin &&
    discoveredAt &&
    discoveredAt.getTime() >= terminalEvidenceBoundary.getTime() &&
    discoveredAt.getTime() <= verifiedAt.getTime() + 60_000 &&
    typeof proof.confidence === "number" &&
    proof.confidence >= 0.7 &&
    isCoherentManualDisposition({
      bookingMethod:
        typeof proof.bookingMethod === "string" ? proof.bookingMethod : null,
      automationEligibility:
        typeof proof.automationEligibility === "string"
          ? proof.automationEligibility
          : null,
      automationReason:
        typeof proof.automationReason === "string"
          ? proof.automationReason
          : null,
    }) &&
    isCoherentManualDisposition({
      bookingMethod:
        typeof proof.discoveryBookingMethod === "string"
          ? proof.discoveryBookingMethod
          : null,
      automationEligibility:
        typeof proof.discoveryAutomationEligibility === "string"
          ? proof.discoveryAutomationEligibility
          : null,
      automationReason:
        typeof proof.discoveryAutomationReason === "string"
          ? proof.discoveryAutomationReason
          : null,
    }) &&
    proof.discoveryBookingMethod === proof.bookingMethod &&
    (proof.discoveryStatus === "VERIFIED" ||
      proof.discoveryStatus === "BLOCKED"),
  );
}

function getLegacyTerminalProofSemantics(proofValue: unknown): {
  proofKind: string;
  monitoringState: LegacyTerminalState;
  resolution: LegacyTerminalResolution;
  finalKind:
    | "manual_direct"
    | "identity"
    | "source_unverified"
    | "known_technical_limitation";
} | null {
  const proof = asRecord(proofValue);
  if (proof.kind === "PLAYBOOK_FACTUAL_FINAL") {
    if (proof.disposition === "IDENTITY_FINAL") {
      return {
        proofKind: proof.kind,
        monitoringState: "FINAL_IDENTITY",
        resolution: "IDENTITY_CLASSIFIED",
        finalKind: "identity",
      };
    }
    if (proof.disposition === "MANUAL_DIRECT") {
      return {
        proofKind: proof.kind,
        monitoringState: "FINAL_MANUAL",
        resolution: "DIRECT_BOOKING_CLASSIFIED",
        finalKind: "manual_direct",
      };
    }
    return null;
  }
  if (proof.kind === "SOURCE_UNVERIFIED_FINAL") {
    return proof.disposition === "SOURCE_UNVERIFIED"
      ? {
          proofKind: proof.kind,
          monitoringState: "FINAL_TECHNICAL",
          resolution: "SOURCE_UNVERIFIED",
          finalKind: "source_unverified",
        }
      : null;
  }
  if (
    proof.kind === "EXACT_PLACE_REVIEW" ||
    proof.kind === "BROWSER_PRIVATE_IDENTITY"
  ) {
    return {
      proofKind: proof.kind,
      monitoringState: "FINAL_IDENTITY",
      resolution: "IDENTITY_CLASSIFIED",
      finalKind: "identity",
    };
  }
  if (
    proof.kind === "FINAL_DISPOSITION" &&
    proof.disposition === "MANUAL_DIRECT"
  ) {
    return {
      proofKind: proof.kind,
      monitoringState: "FINAL_MANUAL",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      finalKind: "manual_direct",
    };
  }
  return null;
}

function hasDurableSourceUnverifiedPlaybookEvidence(
  playbook: ReturnType<typeof assessAutomationPlaybook>,
  freshCycleStartedAt: Date,
) {
  const officialIdentity = playbook.stages.find(
    (stage) => stage.stage === "OFFICIAL_IDENTITY",
  );
  const independentConfirmation = playbook.stages.find(
    (stage) => stage.stage === "INDEPENDENT_CONFIRMATION",
  );
  return Boolean(
    officialIdentity?.applicability === "APPLICABLE" &&
    officialIdentity.attemptCount > 0 &&
    officialIdentity.completedAt &&
    new Date(officialIdentity.completedAt).getTime() >=
      freshCycleStartedAt.getTime() &&
    independentConfirmation?.applicability === "APPLICABLE" &&
    independentConfirmation.attemptCount > 0 &&
    independentConfirmation.completedAt &&
    playbook.stages.every(
      (stage) =>
        stage.completedAt &&
        new Date(stage.completedAt).getTime() >=
          freshCycleStartedAt.getTime() &&
        (stage.applicability !== "APPLICABLE" || stage.attemptCount > 0),
    ),
  );
}

function isDurableBrowserPrivateIdentityProof(input: {
  proof: Record<string, unknown>;
  terminalEvidenceBoundary: Date;
  verifiedAt: Date;
}) {
  const { proof, terminalEvidenceBoundary, verifiedAt } = input;
  const discoveryCreatedAt = parseExactDate(proof.discoveryCreatedAt);
  const intelligenceVerifiedAt = parseExactDate(proof.intelligenceVerifiedAt);
  const intelligenceReviewAt = parseExactDate(proof.intelligenceReviewAt);
  const maximumEvidenceAt = verifiedAt.getTime() + 60_000;
  const maximumReviewAt = intelligenceVerifiedAt
    ? intelligenceVerifiedAt.getTime() + 181 * 24 * 60 * 60 * 1000
    : 0;
  const provenance =
    typeof proof.provenance === "string" ? proof.provenance : "";
  const [baseProvenance, ...provenanceMarkers] = provenance.split(":");
  const validProvenance =
    provenanceMarkers.length === 0 ||
    (provenanceMarkers.length === 1 &&
      provenanceMarkers[0] === "legacy-policy-reconciliation");
  const expectedPolicyNotes = validProvenance
    ? VERIFIED_BROWSER_PRIVATE_POLICY_NOTES.get(baseProvenance)
    : undefined;
  return Boolean(
    proof.disposition === "VERIFIED_PRIVATE" &&
    typeof proof.evidenceOrigin === "string" &&
    getSafeEvidenceOrigin(proof.evidenceOrigin) === proof.evidenceOrigin &&
    discoveryCreatedAt &&
    intelligenceVerifiedAt &&
    intelligenceReviewAt &&
    discoveryCreatedAt.getTime() >= terminalEvidenceBoundary.getTime() &&
    intelligenceVerifiedAt.getTime() >= terminalEvidenceBoundary.getTime() &&
    discoveryCreatedAt.getTime() <= maximumEvidenceAt &&
    intelligenceVerifiedAt.getTime() <= maximumEvidenceAt &&
    Math.abs(discoveryCreatedAt.getTime() - intelligenceVerifiedAt.getTime()) <=
      5 * 60 * 1000 &&
    intelligenceReviewAt.getTime() > intelligenceVerifiedAt.getTime() &&
    intelligenceReviewAt.getTime() > verifiedAt.getTime() &&
    intelligenceReviewAt.getTime() <= maximumReviewAt &&
    expectedPolicyNotes &&
    proof.policyNotes === expectedPolicyNotes &&
    proof.confidence === 0.98 &&
    proof.intelligenceConfidence === 0.98 &&
    proof.courseBookingMethod === "UNKNOWN" &&
    proof.courseAutomationEligibility === "BLOCKED" &&
    proof.courseAutomationReason === "OTHER" &&
    proof.discoveryStatus === "VERIFIED" &&
    proof.discoveryDetectedPlatform === "UNKNOWN" &&
    proof.discoveryBookingMethod === "UNKNOWN" &&
    proof.discoveryBookingPhone === null &&
    proof.discoveryAutomationEligibility === "BLOCKED" &&
    proof.discoveryAutomationReason === "OTHER" &&
    proof.discoveryApiEndpoint === null &&
    proof.discoveryApiMetadata === null,
  );
}

function parseExactDate(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : null;
}

function getSafeEvidenceOrigin(value: string) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
) {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  );
}
