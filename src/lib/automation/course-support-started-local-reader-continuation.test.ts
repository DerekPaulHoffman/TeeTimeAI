import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  assessParkedCourseStartedLocalReaderContinuation,
  assessParkedCourseStartedLocalReaderReadiness,
  createParkedCourseCampaignAttemptLedgerFingerprint,
  createParkedCourseCampaignAudit,
  deriveParkedCourseCampaignHumanReviewCycles,
  isParkedCourseStartedLocalReaderContinuationReceipt,
  loadParkedCourseCampaignAdmissionMembers,
  loadParkedCourseCampaignMembers,
  readParkedCourseStartedLocalReaderReadiness,
  type ParkedCourseCampaignMemberSnapshot,
} from "./course-support-campaign";
import { assessAutomationPlaybook } from "./course-monitoring-playbook";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";

const oldRuntime = "a".repeat(40);
const currentRuntime = "b".repeat(40);
const capturedAt = new Date("2026-08-20T10:00:00.000Z");
const now = new Date("2026-09-08T17:00:00.000Z");
const batchAt = new Date("2026-08-22T10:00:00.000Z");
const completedAt = new Date("2026-08-22T10:20:00.000Z");
const parkedAt = new Date("2026-08-22T10:30:00.000Z");
const course = {
  name: "Standalone reader fixture", timeZone: "America/New_York", isPublic: true,
  website: "https://fixture.invalid", detectedBookingUrl: "https://fixture.cps.golf/onlineresweb/search-teetime",
  detectedPlatform: "CUSTOM" as const, providerFamilyKey: "CPS", bookingMethod: "PUBLIC_ONLINE" as const,
  bookingWindowDaysAhead: null, bookingReleaseTimeLocal: null, bookingWindowSource: null,
  bookingWindowConfidence: null, bookingWindowEvidenceUrl: null, automationEligibility: "ALLOWED" as const,
  automationReason: "NONE" as const, monitoringMode: "AUTOMATIC" as const, bookingAccessMode: "PUBLIC_SIGNED_OUT",
  intelligenceVerifiedAt: null, intelligenceReviewAt: null, intelligenceConfidence: null,
  bookingMetadata: { provider: "CPS", siteName: "fixture", bookingBaseUrl: "https://fixture.cps.golf/", courseIds: [1] }, layoutHoleCounts: [], layoutHolesVerifiedAt: null,
};
const agent = {
  deviceId: "fixture-device", readerVersion: "2.0.0", buildId: "fixture-build",
  capabilities: [{ key: "CPS_RENDERED", parserVersion: 1 }], lastSeenAt: now,
};

function fixture() {
  const cycle = 8;
  const stages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"], ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"], ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"], ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["LOCAL_READER", "LOCAL_READER"],
  ];
  const ledger = {
    version: 1,
    events: stages.map(([stage, readPath], index) => ({
      sequence: index + 1, cycle, stage, readPath,
      transition: index === 6 ? "STARTED" : "COMPLETED", evidenceKind: "TOOLING",
      observedAt: new Date(batchAt.getTime() + index * 1_000).toISOString(),
      failureFingerprint: "HTTP:FETCH_FAILED", runtimeVersion: oldRuntime,
    })),
  };
  const fingerprint = buildCourseSupportProviderSnapshotFingerprint(course);
  const current: ParkedCourseCampaignMemberSnapshot = {
    courseId: "fixture-course", incidentId: "fixture-incident", cycle, revision: 12,
    monitoringRevision: 16, monitoringFailureFingerprint: "HTTP:FETCH_FAILED",
    kind: "FETCH_FAILED", providerFamilyKey: "CPS", failureClass: "HTTP_5XX",
    failureFingerprint: "HTTP:FETCH_FAILED", providerSnapshotFingerprint: fingerprint,
    attemptLedgerFingerprint: createParkedCourseCampaignAttemptLedgerFingerprint(ledger),
    playbookConclusion: "INCOMPLETE", latestProbeAt: null, latestDiscoveryAt: null,
    activeRealSearchCount: 0, readerCourse: course,
    zeroExecutionEvidence: {
      attemptLedger: ledger, playbookAssessment: assessAutomationPlaybook(ledger, cycle),
      latestProbe: null, latestDiscovery: null, latestProbeTimestampRowCount: 0, latestDiscoveryTimestampRowCount: 0,
      monitoringHistoryCompleteSince: capturedAt,
      monitoringEvents: [{
        id: "fixture-endpoint", incidentId: "fixture-incident", eventType: "HUMAN_REVIEW_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER", failureFingerprint: "HTTP:FETCH_FAILED", readPath: null,
        occurredAt: parkedAt, audit: { cycle, automationStalled: true, parkedUntilMaterialChange: true, customerState: "NEEDS_HUMAN_REVIEW" },
      }],
      batchIncidents: [{
        id: "fixture-entry", batchId: "fixture-batch", incidentId: "fixture-incident", courseId: "fixture-course", cycle,
        result: "RETRY_SCHEDULED", preProbeId: null, postProbeId: null, proofSnapshot: null,
        verifiedIncidentUpdatedAt: completedAt, verifiedAt: completedAt, createdAt: new Date(batchAt.getTime() + 8_000), updatedAt: completedAt,
        batch: {
          id: "fixture-batch", _count: { incidents: 1 }, status: "RETRYABLE_FAILED", revision: 3,
          ownerAutomationRunId: null, ownerAutomationRun: null, baseSha: oldRuntime, releaseSha: oldRuntime,
          createdAt: batchAt, updatedAt: completedAt, completedAt, deployedAt: batchAt,
          recheckDispatchKey: null, recheckDispatchStartedAt: null, recheckDispatchedAt: null,
          summary: { remediation: { attempts: [{
            courseRef: createHash("sha256").update("fixture-course").digest("hex").slice(0, 24),
            providerSnapshotFingerprint: fingerprint, failureFingerprint: "HTTP:FETCH_FAILED", playbookEventCountAtClaim: 7,
            approach: { workMode: "VERIFY_TRANSIENT", strategyAction: "RUN_TYPED_ADAPTER", playbookStage: "LOCAL_READER" },
          }] } },
        },
        verificationRequests: [{
          id: "fixture-request", courseId: "fixture-course", releaseSha: oldRuntime,
          providerSnapshotFingerprint: fingerprint, providerSnapshotAt: batchAt,
          discoveryAttemptedAt: null, discoveryVerifiedAt: null,
          createdAt: new Date(batchAt.getTime() + 10_000), updatedAt: completedAt,
          status: "STALE", revision: 4, attemptCount: 1, workflowRunId: null,
          startedAt: new Date(batchAt.getTime() + 20_000), outcome: "FETCH_FAILED", failureClass: "HTTP_5XX",
          evidence: { providerExecution: false }, lastError: null,
        }],
      }],
    },
  };
  const captured = { ...current, cycle: 1, revision: 1, monitoringRevision: 1, playbookConclusion: "UNRESOLVED_EXHAUSTED" };
  return {
    captured, current, capturedAt, campaignRunId: "fixture-campaign", campaignMembershipDigest: "d".repeat(64),
    currentRuntimeVersion: currentRuntime, now, activeSearchCount: 0,
    readerReadiness: assessParkedCourseStartedLocalReaderReadiness({ course, agents: [agent], now }),
  };
}

function record(value: unknown) { return value as Record<string, unknown>; }
function latest(input: ReturnType<typeof fixture>) { return input.current.zeroExecutionEvidence.batchIncidents[0]!; }
function claim(input: ReturnType<typeof fixture>) {
  return (record(record(latest(input).batch.summary).remediation).attempts as Array<Record<string, unknown>>)[0]!;
}
function endpointAudit(input: ReturnType<typeof fixture>) { return record(input.current.zeroExecutionEvidence.monitoringEvents[0]!.audit); }
function addSettledEarlierEntry(input: ReturnType<typeof fixture>) {
  const earlier = structuredClone(latest(input));
  earlier.id = "fixture-earlier-entry"; earlier.batchId = "fixture-earlier-batch"; earlier.batch.id = earlier.batchId;
  earlier.batch.createdAt = new Date(batchAt.getTime() - 600_000);
  earlier.createdAt = new Date(batchAt.getTime() - 590_000);
  earlier.batch.completedAt = new Date(batchAt.getTime() - 500_000);
  const request = earlier.verificationRequests[0]!;
  request.id = "fixture-earlier-request";
  request.createdAt = new Date(batchAt.getTime() - 580_000);
  request.startedAt = new Date(batchAt.getTime() - 570_000);
  request.updatedAt = earlier.batch.completedAt;
  request.status = "RETRYABLE_FAILED";
  request.evidence = { providerExecution: true };
  input.current.zeroExecutionEvidence.batchIncidents.push(earlier);
  return earlier;
}
function changeLedger(input: ReturnType<typeof fixture>, change: (events: Array<Record<string, unknown>>) => void) {
  const ledger = record(input.current.zeroExecutionEvidence.attemptLedger);
  change(ledger.events as Array<Record<string, unknown>>);
  input.current.attemptLedgerFingerprint = createParkedCourseCampaignAttemptLedgerFingerprint(ledger);
  input.current.zeroExecutionEvidence.playbookAssessment = assessAutomationPlaybook(ledger, input.current.cycle);
}

function loaderFixture() {
  const input = fixture();
  const { zeroExecutionEvidence, activeRealSearchCount, readerCourse, ...captured } = input.captured;
  void zeroExecutionEvidence; void activeRealSearchCount; void readerCourse;
  const audit = createParkedCourseCampaignAudit({ expectedCount: 1, capturedAt, members: [captured] });
  const evidence = input.current.zeroExecutionEvidence;
  const row = {
    id: input.current.incidentId, courseId: input.current.courseId, cycle: input.current.cycle,
    revision: input.current.revision, kind: input.current.kind, providerFamilyKey: input.current.providerFamilyKey,
    failureClass: input.current.failureClass, failureFingerprint: input.current.failureFingerprint,
    attemptLedger: evidence.attemptLedger, status: "NEEDS_HUMAN", humanReviewReason: "AUTOMATION_STALLED",
    activeBatchId: null, nextAttemptAt: null, activeRealSearchCount: 0, escalatedAt: parkedAt,
    resolution: null, resolvedAt: null, resolutionMessage: null, resolutionNotifiedAt: null,
    decisionActorId: null, decisionAt: null, decisionNote: null, decisionEvidenceUrl: null, decisionIdempotencyKey: null,
    monitoringEvents: evidence.monitoringEvents, batchIncidents: evidence.batchIncidents,
    course: { ...course, preferences: [], probes: [], automationDiscoveries: [], monitoringStatus: {
      state: "ENGINEERING_VERIFICATION_NEEDED", revision: input.current.monitoringRevision,
      failureFingerprint: input.current.failureFingerprint, nextAutomaticAttemptAt: null, revalidationRequestedAt: null,
    } },
  };
  const database = {
    automationRun: {}, courseSupportBatchIncident: {},
    courseSupportIncident: { findMany: vi.fn().mockResolvedValue([row]) },
    teeSearch: { count: vi.fn().mockResolvedValue(0) },
    localReaderAgent: { findMany: vi.fn().mockResolvedValue([agent]) },
  };
  return { input, audit, row, database,
    load: () => loadParkedCourseCampaignAdmissionMembers(audit, database as unknown as Parameters<typeof loadParkedCourseCampaignAdmissionMembers>[1], input.campaignRunId, currentRuntime, now),
  };
}

describe("current started local-reader continuation", () => {
  it("authorizes one unchanged-source unfinished stage without reconstructing ancestor handoffs", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).toMatchObject({
      history: { batchCount: 1, requestCount: 1, startedRequestCount: 1 },
      latestBatchIncidentId: "fixture-entry", latestRequestId: "fixture-request", parkedEventId: "fixture-endpoint",
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each<[string, (input: ReturnType<typeof fixture>) => void]>([
    ["invalid current time", (x) => { x.now = new Date(Number.NaN); }],
    ["invalid capture time", (x) => { x.capturedAt = new Date(Number.NaN); }],
    ["different original course", (x) => { x.current.courseId = "another"; }],
    ["different original incident", (x) => { x.current.incidentId = "another"; }],
    ["different incident kind", (x) => { x.current.kind = "NEEDS_ADAPTER"; }],
    ["non-descendant cycle", (x) => { x.current.cycle = x.captured.cycle; }],
    ["incoherent monitoring fingerprint", (x) => { x.current.monitoringFailureFingerprint = "OTHER:FAILURE"; }],
    ["changed claim source", (x) => { claim(x).providerSnapshotFingerprint = "e".repeat(64); }],
    ["changed claim failure", (x) => { claim(x).failureFingerprint = "OTHER:FAILURE"; }],
    ["wrong selected stage", (x) => { record(claim(x).approach).playbookStage = "TYPED_ADAPTER"; }],
    ["unknown action plan", (x) => { claim(x).actionPlan = {}; }],
    ["missing claim prefix count", (x) => { delete claim(x).playbookEventCountAtClaim; }],
    ["claim prefix before local reader", (x) => { claim(x).playbookEventCountAtClaim = 5; }],
    ["claim prefix beyond stored ledger", (x) => { claim(x).playbookEventCountAtClaim = 8; }],
    ["unknown batch cardinality", (x) => { delete latest(x).batch._count; }],
    ["mismatched batch cardinality", (x) => { latest(x).batch._count!.incidents = 2; }],
    ["current producer runtime", (x) => { x.currentRuntimeVersion = oldRuntime; }],
    ["missing reader", (x) => { x.readerReadiness = null; }],
    ["old reader heartbeat", (x) => { x.readerReadiness!.lastSeenAt = new Date(now.getTime() - 300_001); }],
    ["future reader heartbeat", (x) => { x.readerReadiness!.lastSeenAt = new Date(now.getTime() + 1); }],
    ["wrong parser requirement", (x) => { x.readerReadiness!.requiredParserVersion = 2; }],
    ["wrong capability family", (x) => { x.readerReadiness!.requiredCapabilityKey = "OTHER"; }],
    ["private current course", (x) => { x.current.readerCourse = { ...course, isPublic: false }; }],
    ["known active real demand", (x) => { x.current.activeRealSearchCount = 1; }],
    ["active synthetic or real search", (x) => { x.activeSearchCount = 1; }],
    ["unknown search count", (x) => { x.activeSearchCount = Number.NaN; }],
    ["unsettled batch", (x) => { latest(x).batch.completedAt = null; }],
    ["active batch even with completion timestamp", (x) => { latest(x).batch.status = "VERIFYING"; }],
    ["unknown nonnull proof", (x) => { latest(x).proofSnapshot = { kind: "UNKNOWN" }; }],
    ["provider success proof", (x) => { latest(x).proofSnapshot = { kind: "PROVIDER_VERIFICATION", outcome: "MATCH_FOUND" }; }],
    ["factual final proof", (x) => { latest(x).proofSnapshot = { kind: "PLAYBOOK_FACTUAL_FINAL", disposition: "MANUAL_DIRECT" }; }],
    ["claim prefix recorded after claim", (x) => { latest(x).createdAt = batchAt; }],
    ["request started before request creation", (x) => { latest(x).verificationRequests[0]!.startedAt = batchAt; }],
    ["wrong batch identity", (x) => { latest(x).batch.id = "another"; }],
    ["wrong current-cycle entry", (x) => { latest(x).cycle -= 1; }],
    ["ambiguous latest batch time", (x) => { x.current.zeroExecutionEvidence.batchIncidents.push(structuredClone(latest(x))); }],
    ["multiple latest requests", (x) => { latest(x).verificationRequests.push(structuredClone(latest(x).verificationRequests[0]!)); }],
    ["no latest request", (x) => { latest(x).verificationRequests = []; }],
    ["unknown provider execution", (x) => { latest(x).verificationRequests[0]!.evidence = {}; }],
    ["nonzero provider execution", (x) => { latest(x).verificationRequests[0]!.evidence = { providerExecution: true }; }],
    ["malformed execution false", (x) => { latest(x).verificationRequests[0]!.evidence = { providerExecution: "false" }; }],
    ["queued latest request", (x) => { latest(x).verificationRequests[0]!.status = "QUEUED"; }],
    ["checking latest request", (x) => { latest(x).verificationRequests[0]!.status = "CHECKING"; }],
    ["retryable latest request", (x) => { latest(x).verificationRequests[0]!.status = "RETRYABLE_FAILED"; }],
    ["successful request", (x) => { latest(x).verificationRequests[0]!.outcome = "NO_MATCH"; }],
    ["changed request source", (x) => { latest(x).verificationRequests[0]!.providerSnapshotFingerprint = "e".repeat(64); }],
    ["cross-course request", (x) => { latest(x).verificationRequests[0]!.courseId = "another"; }],
    ["unstarted request", (x) => { latest(x).verificationRequests[0]!.startedAt = null; }],
    ["missing complete history", (x) => { delete x.current.zeroExecutionEvidence.monitoringHistoryCompleteSince; }],
    ["missing legacy parking flag", (x) => { delete endpointAudit(x).automationStalled; }],
    ["explicit exhausted endpoint", (x) => { endpointAudit(x).playbookExhausted = true; }],
    ["modern explicit incomplete endpoint", (x) => { endpointAudit(x).playbookExhausted = false; }],
    ["null exhaustion is not omission", (x) => { endpointAudit(x).playbookExhausted = null; }],
    ["operator parking", (x) => { x.current.zeroExecutionEvidence.monitoringEvents[0]!.source = "OPERATOR_ACTION"; }],
    ["duplicate endpoint", (x) => { x.current.zeroExecutionEvidence.monitoringEvents.push(structuredClone(x.current.zeroExecutionEvidence.monitoringEvents[0]!)); }],
    ["later current evidence", (x) => { x.current.zeroExecutionEvidence.monitoringEvents.push({ ...x.current.zeroExecutionEvidence.monitoringEvents[0]!, id: "later", eventType: "STATE_CHANGED", occurredAt: new Date(parkedAt.getTime() + 1) }); }],
    ["used continuation even when malformed", (x) => { endpointAudit(x).admissionMode = "STARTED_LOCAL_READER_CONTINUATION"; }],
    ["current ledger changed digest", (x) => { x.current.attemptLedgerFingerprint = "e".repeat(64); }],
    ["terminal local reader", (x) => { changeLedger(x, (events) => { events[6]!.transition = "COMPLETED"; }); }],
    ["exhausted ledger", (x) => { changeLedger(x, (events) => { events[6]!.transition = "COMPLETED"; events.push({ ...events[6]!, sequence: 8, stage: "INDEPENDENT_CONFIRMATION", readPath: "INDEPENDENT_CONFIRMATION" }); }); }],
    ["success ledger", (x) => { changeLedger(x, (events) => { events[6]!.transition = "SUCCEEDED"; events[6]!.evidenceKind = "LOCAL_READER_RESULT"; }); }],
    ["stage runtime not owned by a settled batch", (x) => { changeLedger(x, (events) => { events[6]!.runtimeVersion = "c".repeat(40); }); }],
    ["stage after parked endpoint", (x) => { changeLedger(x, (events) => { events[6]!.observedAt = new Date(parkedAt.getTime() + 1).toISOString(); }); }],
    ["a later ledger cycle already started", (x) => { changeLedger(x, (events) => { events.push({ ...events[6]!, sequence: 8, cycle: 9, stage: "OFFICIAL_IDENTITY", readPath: "OFFICIAL_IDENTITY" }); }); }],
  ])("rejects %s", (_label, change) => {
    const input = fixture(); change(input);
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).toBeNull();
  });

  it("does not treat heartbeat refresh as a changed continuation proof", () => {
    const input = fixture();
    const before = assessParkedCourseStartedLocalReaderContinuation(input)!.continuationDigest;
    input.readerReadiness!.lastSeenAt = new Date(now.getTime() - 1_000);
    expect(assessParkedCourseStartedLocalReaderContinuation(input)!.continuationDigest).toBe(before);
    input.readerReadiness!.buildId = "another-build";
    expect(assessParkedCourseStartedLocalReaderContinuation(input)!.continuationDigest).not.toBe(before);
  });

  it("binds actual total batch cardinality while selecting exactly the one matching claim", () => {
    const input = fixture();
    const original = claim(input);
    (record(record(latest(input).batch.summary).remediation).attempts as unknown[]).push({ ...original, courseRef: "e".repeat(24) });
    latest(input).batch._count!.incidents = 2;
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).not.toBeNull();
  });

  it("preserves a populated failed probe and recognized failure proof without calling them terminal", () => {
    const input = fixture();
    latest(input).postProbeId = "fixture-failed-probe";
    latest(input).proofSnapshot = { kind: "PROVIDER_VERIFICATION_FAILURE", outcome: "FETCH_FAILED", providerExecution: false };
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).not.toBeNull();
  });

  it("allows actual historical execution and a retryable request whose owning batch is settled", () => {
    const input = fixture(); addSettledEarlierEntry(input);
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).toMatchObject({ history: { batchCount: 2, requestCount: 2 } });
  });

  it("binds the native current-cycle claim event count without discarding prior-cycle ledger evidence", () => {
    const input = fixture();
    changeLedger(input, (events) => {
      const prior: Array<Record<string, unknown>> = events.map((event, index) => ({ ...event, cycle: 1, transition: "COMPLETED", observedAt: new Date(capturedAt.getTime() - 60_000 + index * 1_000).toISOString() }));
      prior.push({ ...prior[6]!, sequence: 8, stage: "INDEPENDENT_CONFIRMATION", readPath: "INDEPENDENT_CONFIRMATION", observedAt: new Date(capturedAt.getTime() - 52_000).toISOString() });
      const current = events.map((event) => ({ ...event, sequence: Number(event.sequence) + prior.length }));
      events.splice(0, events.length, ...prior, ...current);
    });
    const before = JSON.stringify(input.current.zeroExecutionEvidence.attemptLedger);
    expect(claim(input).playbookEventCountAtClaim).toBe(7);
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).not.toBeNull();
    expect(JSON.stringify(input.current.zeroExecutionEvidence.attemptLedger)).toBe(before);
    claim(input).playbookEventCountAtClaim = 8;
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).toBeNull();
  });

  it("rejects overlapping completed batch intervals instead of trusting their status labels", () => {
    const input = fixture(); const earlier = addSettledEarlierEntry(input);
    earlier.batch.completedAt = new Date(batchAt.getTime() + 1);
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).toBeNull();
  });

  it("rejects a historical active request even with a settled owning batch", () => {
    const input = fixture(); addSettledEarlierEntry(input).verificationRequests[0]!.status = "CHECKING";
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).toBeNull();
  });

  it("rejects a still-running owner record even if its batch says completed", () => {
    const input = fixture();
    latest(input).batch.ownerAutomationRunId = "fixture-owner";
    latest(input).batch.ownerAutomationRun = {
      id: "fixture-owner", promptVersion: "fixture", kind: "COURSE_SUPPORT", status: "RUNNING",
      runtimeVersion: oldRuntime, completedAt: null, outcome: null, notes: null,
    };
    expect(assessParkedCourseStartedLocalReaderContinuation(input)).toBeNull();
  });

  it("loads exact native legacy evidence and privately reads only the compatible reader and all ACTIVE count", async () => {
    const scenario = loaderFixture();
    const result = await scenario.load();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ admissionMode: "STARTED_LOCAL_READER_CONTINUATION", playbookNextStage: "LOCAL_READER", playbookCompletedStageCount: 6 });
    expect(result[0]).not.toHaveProperty("readerCourse");
    expect(result[0]).not.toHaveProperty("zeroExecutionEvidence");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(course.name);
    expect(serialized).not.toContain(course.website);
    expect(serialized).not.toContain(course.detectedBookingUrl);
    expect(scenario.database.teeSearch.count).toHaveBeenCalledWith({ where: { status: "ACTIVE", preferences: { some: { courseId: "fixture-course" } } } });
    const firstQuery = scenario.database.courseSupportIncident.findMany.mock.calls[0]![0];
    expect(firstQuery.where).toMatchObject({ activeBatchId: null, decisionAt: null, status: "NEEDS_HUMAN" });
    expect(firstQuery.select.batchIncidents.select.batch.select._count).toEqual({ select: { incidents: true } });
  });

  it("strips private course context from the immutable capture boundary", async () => {
    const scenario = loaderFixture();
    const members = await loadParkedCourseCampaignMembers(scenario.database as unknown as Parameters<typeof loadParkedCourseCampaignMembers>[0]);
    expect(() => createParkedCourseCampaignAudit({ expectedCount: 1, capturedAt, members })).not.toThrow();
    expect(JSON.stringify(members)).not.toContain(course.name);
    expect(JSON.stringify(members)).not.toContain(course.website);
    expect(JSON.stringify(members)).not.toContain(course.detectedBookingUrl);
  });

  it.each([1, Number.NaN])("does not load reader evidence for nonzero or unknown all-ACTIVE count", async (count) => {
    const scenario = loaderFixture(); scenario.database.teeSearch.count.mockResolvedValue(count);
    expect(await scenario.load()).toEqual([]);
    expect(scenario.database.localReaderAgent.findMany).not.toHaveBeenCalled();
  });

  it("fails closed if reader persistence is unavailable", async () => {
    expect(await readParkedCourseStartedLocalReaderReadiness({}, { course, now })).toBeNull();
  });

  it.each([
    { capabilities: [] }, { capabilities: [{ key: "CPS_RENDERED", parserVersion: 0 }] },
    { capabilities: [{ key: "TENFORE_RENDERED", parserVersion: 999 }] },
    { lastSeenAt: new Date(now.getTime() - 300_001) }, { lastSeenAt: new Date(now.getTime() + 1) },
  ])("rejects unavailable, incompatible or stale reader evidence %#", (change) => {
    expect(assessParkedCourseStartedLocalReaderReadiness({ course, agents: [{ ...agent, ...change }], now })).toBeNull();
  });

  it("does not mistake a runner version for a provider parser upgrade", () => {
    expect(assessParkedCourseStartedLocalReaderReadiness({ course, agents: [{ ...agent, readerVersion: "999.0.0", capabilities: [] }], now })).toBeNull();
  });

  it.each([
    { isPublic: false }, { detectedBookingUrl: "https://unrecognized.invalid" },
    { bookingMetadata: null },
    { bookingMethod: "PHONE_ONLY", automationEligibility: "BLOCKED", automationReason: "NO_ONLINE_BOOKING", intelligenceVerifiedAt: now, intelligenceReviewAt: new Date(now.getTime() + 86_400_000), intelligenceConfidence: 1 },
    { automationEligibility: "BLOCKED", automationReason: "ACCOUNT_REQUIRED", intelligenceVerifiedAt: now, intelligenceReviewAt: new Date(now.getTime() + 86_400_000), intelligenceConfidence: 1 },
  ])("preserves current identity/access/runnable gates %#", (change) => {
    expect(assessParkedCourseStartedLocalReaderReadiness({ course: { ...course, ...change }, agents: [agent], now })).toBeNull();
  });

  it("accepts only a full truthful same-cycle continuation receipt", () => {
    const event = { eventType: "REVALIDATION_REQUESTED", source: "COURSE_SUPPORT_RESPONDER", occurredAt: now, audit: {
      action: "parked_cohort_started_local_reader_continuation", admissionMode: "STARTED_LOCAL_READER_CONTINUATION",
      supersededEndpointId: "fixture-endpoint", supersededEndpointAt: parkedAt.toISOString(),
      cycle: 8, priorCycle: 8, campaignRunId: "fixture-campaign", campaignMembershipDigest: "d".repeat(64),
      campaign: { kind: "PARKED_COHORT", runId: "fixture-campaign", membershipDigest: "d".repeat(64), cycle: 8 },
      continuationDigest: "a".repeat(64), sameCycleRecoveryHistoryDigest: "b".repeat(64), providerSnapshotFingerprint: "c".repeat(64), attemptLedgerFingerprint: "e".repeat(64),
      playbookNextStage: "LOCAL_READER", playbookCompletedStageCount: 6, playbookStageStatus: "STARTED", sameCycleRecovery: true, oneShot: true,
      batchCount: 1, requestCount: 1, startedRequestCount: 1, preservesAttemptLedger: true, preservesAttemptCounts: true,
      preservesAttemptTimestamps: true, preservesOperatorEvidence: true, preservesImmutableCampaignAudit: true, customerDataIncluded: false,
    } };
    const input = { event, cycle: 8, campaignRunId: "fixture-campaign", campaignMembershipDigest: "d".repeat(64) };
    expect(isParkedCourseStartedLocalReaderContinuationReceipt(input)).toBe(true);
    for (const key of Object.keys(event.audit)) {
      const altered = structuredClone(input); delete record(altered.event.audit)[key];
      expect(isParkedCourseStartedLocalReaderContinuationReceipt(altered), key).toBe(false);
    }
    expect(isParkedCourseStartedLocalReaderContinuationReceipt({ ...input, cycle: 9 })).toBe(false);
    expect(isParkedCourseStartedLocalReaderContinuationReceipt({ ...input, event: { ...event, source: "OPERATOR_ACTION" } })).toBe(false);
    const endpoint = fixture().current.zeroExecutionEvidence.monitoringEvents[0]!;
    const metricInput = { events: [endpoint, event], campaignRunId: input.campaignRunId, campaignMembershipDigest: input.campaignMembershipDigest };
    expect(deriveParkedCourseCampaignHumanReviewCycles(metricInput)).toEqual([]);
    expect(deriveParkedCourseCampaignHumanReviewCycles({ ...metricInput, events: [...metricInput.events, { ...endpoint, id: "unrelated-endpoint" }] })).toEqual([8]);
    expect(deriveParkedCourseCampaignHumanReviewCycles({ ...metricInput, events: [...metricInput.events, { ...endpoint, id: "operator", source: "OPERATOR_CLI" }] })).toEqual([8]);
    expect(deriveParkedCourseCampaignHumanReviewCycles({ ...metricInput, events: [{ ...endpoint, occurredAt: new Date(parkedAt.getTime() + 1) }, event] })).toEqual([8]);
  });
});
