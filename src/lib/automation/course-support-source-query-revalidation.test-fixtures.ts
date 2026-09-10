import { createHash } from "node:crypto";

import { appendAutomationPlaybookEvent, AUTOMATION_PLAYBOOK_STAGES } from "./course-monitoring-playbook";
import type { getSourceQueryRevalidationProof } from "./course-support-source-query-revalidation";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";

/** Deidentified historical shapes: old NO_UNIQUE events have separate event and
 * ledger clocks, optional providerExecution, and a six-hour exhausted schedule.
 */
export function obsoleteSourceQueryFixture(retainedSource = false) {
  const confirmedAt = new Date("2026-09-07T20:00:00Z");
  const searchAt = new Date("2026-09-07T20:10:00Z");
  const closeoutAt = new Date("2026-09-07T20:12:00Z");
  const nextAttemptAt = new Date("2026-09-08T02:12:00Z");
  const cycle = retainedSource ? 9 : 3;
  const course = {
    id: "query-course", name: "Pine Ridge Golf Club", address: "100 Fairway Lane",
    city: "Mesa", stateCode: "AZ", timeZone: "America/Phoenix",
    isPublic: true, monitoringMode: "AUTOMATIC", detectedPlatform: "UNKNOWN",
    bookingMetadata: null, bookingAccessMode: "UNKNOWN", bookingMethod: "UNKNOWN", automationReason: "NONE",
    automationEligibility: "NEEDS_REVIEW", website: retainedSource ? "https://pine-ridge.example/" : null,
    detectedBookingUrl: null, providerFamilyKey: retainedSource ? "pine-ridge.example" : "SOURCE_MISSING",
    updatedAt: closeoutAt, layoutHoleCounts: [], layoutHolesVerifiedAt: null,
    monitoringStatus: { state: "ENGINEERING_VERIFICATION_NEEDED", nextAutomaticAttemptAt: nextAttemptAt,
      lastSuccessfulAt: null, revision: 4, stateChangedAt: closeoutAt },
    automationDiscoveries: [], probes: [], preferences: [], monitoringEvents: [],
  };
  let attemptLedger: unknown = null;
  for (const [index, stage] of AUTOMATION_PLAYBOOK_STAGES.entries()) {
    const readPath = stage === "OFFICIAL_HTTP_DISCOVERY" ? "OFFICIAL_HTTP" :
      stage === "RENDERED_BROWSER_DISCOVERY" ? "RENDERED_BROWSER" :
      ["TYPED_ADAPTER", "HTTP_ADAPTER_RETRY", "BROWSER_ADAPTER_RETRY"].includes(stage) ? "TYPED_PROVIDER_ADAPTER" : stage;
    attemptLedger = appendAutomationPlaybookEvent(attemptLedger, {
      cycle, stage, transition: stage === "INDEPENDENT_CONFIRMATION" ? "FAILED_TERMINAL" : "COMPLETED",
      evidenceKind: "TOOLING", readPath: readPath as "INDEPENDENT_CONFIRMATION",
      runtimeVersion: retainedSource ? "a".repeat(40) : "local",
      failureFingerprint: stage === "INDEPENDENT_CONFIRMATION" ? "SOURCE_MISSING:EXACT_SEARCH:NO_UNIQUE" : "SOURCE:MISSING",
      ...(stage === "INDEPENDENT_CONFIRMATION" ? { failureClass: "MISSING_SOURCE" as const } : {}),
      ...(retainedSource ? { providerExecution: false } : {}),
      observedAt: new Date(searchAt.getTime() - (8 - index) * 1000),
    });
  }
  const queryDigest = createHash("sha256")
    .update('"Pine Ridge Golf Club" "100 Fairway Lane" "Mesa, AZ" "official golf course"'.toLowerCase()).digest("hex");
  return {
    id: "query-incident", courseId: course.id, cycle, revision: 7, status: "NEEDS_HUMAN", kind: "NEEDS_ADAPTER",
    activeBatchId: null, nextAttemptAt, confirmedAt,
    // Some historical reopened cycles retain the original escalation timestamp.
    escalatedAt: retainedSource ? new Date("2026-09-01T00:00:00Z") : closeoutAt,
    humanReviewReason: "AUTOMATION_STALLED", failureClass: "MISSING_SOURCE", failureFingerprint: "SOURCE:MISSING",
    decisionActorId: null, decisionAt: null, decisionNote: null, decisionEvidenceUrl: null, decisionIdempotencyKey: null,
    resolution: null, resolvedAt: null, resolutionMessage: null, resolutionNotifiedAt: null,
    activeRealSearchCount: 0, engineeringOnly: true, attemptLedger, course,
    providerFamilyKey: course.providerFamilyKey, updatedAt: closeoutAt, createdAt: confirmedAt,
    firstSeenAt: confirmedAt, lastSeenAt: closeoutAt, lastAttemptAt: searchAt, batchIncidents: [],
    monitoringEvents: [
      { id: "exhausted-closeout", courseId: course.id, incidentId: "query-incident", eventType: "HUMAN_REVIEW_REQUESTED",
        operatorActorId: null, occurredAt: closeoutAt, source: "RECOVERY_CRON", audit: {
          cycle, customerState: "NEEDS_HUMAN_REVIEW", playbookExhausted: true, automaticRecheckHours: 6,
        } },
      { id: "negative-source-query", courseId: course.id, incidentId: "query-incident", eventType: "AUTOMATION_ATTEMPTED",
        source: "COURSE_SUPPORT_RESPONDER", readPath: "CODEX_EXACT_SOURCE_SEARCH", occurredAt: searchAt,
        evidenceUrl: null, operatorActorId: null, audit: { schemaVersion: 1, action: "OWNED_EXACT_SOURCE_SEARCH", result: "NO_UNIQUE",
          ...(retainedSource ? { sourceSearchMode: "RETAINED_SOURCE_IDENTITY_RESEARCH",
            providerSnapshotFingerprint: buildCourseSupportProviderSnapshotFingerprint(course as never) } : {}),
          incidentCycle: cycle, queryDigest, ownershipScopeDigest: "c".repeat(64), independentConfirmationRecorded: true } },
    ],
  } as unknown as Parameters<typeof getSourceQueryRevalidationProof>[0];
}
