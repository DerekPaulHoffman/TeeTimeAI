import type {
  Course,
  CourseMonitoringEvent,
  CourseMonitoringStatus,
  CourseSupportIncident,
  Prisma,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRawUnsafe: vi.fn(),
  course: { findUnique: vi.fn() },
  courseSupportIncident: {
    findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(),
  },
  courseMonitoringStatus: {
    upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn(),
  },
  courseMonitoringEvent: {
    findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(),
  },
  courseSupportBatchIncident: { findMany: vi.fn() },
  providerRequestLease: { findUnique: vi.fn(), deleteMany: vi.fn() },
  localReaderJob: { findMany: vi.fn(), updateMany: vi.fn() },
  teeTimeMatch: { updateMany: vi.fn() },
  teeSearch: { updateMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: database }));

import { recordCourseMonitoringFinalClassification } from "./course-monitoring";
import {
  createParkedCourseCampaignAudit,
  loadCampaignMemberObservations,
  summarizeParkedCourseCampaignProgress,
  type ParkedCourseCampaignAudit,
} from "./course-support-campaign";
import {
  loadSearchPlaybookRuntime,
  recordSearchPlaybookTransition,
  SEARCH_PLAYBOOK_FINGERPRINTS,
} from "./search-playbook-runtime";
import { getAutomationPlaybookFactualFinalEvidence } from "./course-monitoring-playbook";
import { evaluateMonitoringGate } from "./policy";

const capturedAt = new Date("2026-09-05T20:00:00.000Z");
const confirmedAt = new Date("2026-09-05T21:00:00.000Z");
const sourceAt = new Date("2026-09-05T21:05:00.000Z");
const classifiedAt = new Date("2026-09-05T21:06:00.000Z");
const runtimeVersion = "a".repeat(40);
const courseId = "acceptance-course";
const incidentId = "acceptance-incident";
const campaignId = "acceptance-campaign";
const clone = <T,>(value: T): T => structuredClone(value);

type FixtureCourse = Pick<Course,
  "id" | "isPublic" | "website" | "detectedBookingUrl" | "monitoringMode" |
  "bookingMethod" | "automationEligibility" | "automationReason" |
  "policyNotes" | "intelligenceVerifiedAt" | "intelligenceReviewAt" |
  "intelligenceConfidence"
>;
type FixtureIncident = Pick<CourseSupportIncident,
  "id" | "courseId" | "cycle" | "revision" | "status" | "confirmedAt" |
  "firstSeenAt" | "lastSeenAt" | "activeBatchId" | "resolution" |
  "resolutionMessage" | "resolvedAt" | "decisionAt" | "providerFamilyKey" |
  "decisionActorId" | "decisionNote" | "decisionEvidenceUrl" | "decisionIdempotencyKey" |
  "failureClass" | "attemptCount" | "activeRealSearchCount" | "attemptLedger" |
  "nextAttemptAt" | "nextReminderAt" | "nextAction"
>;
type FixtureMonitoring = Pick<CourseMonitoringStatus,
  "courseId" | "state" | "revision" | "stateChangedAt" | "lastSuccessfulAt" |
  "lastFailureAt" | "consecutiveFailures" | "failureFingerprint" |
  "firstDegradedAt" | "nextAutomaticAttemptAt" | "revalidationRequestedAt"
>;
type FixtureEvent = Pick<CourseMonitoringEvent,
  "id" | "courseId" | "incidentId" | "eventType" | "source" | "occurredAt" |
  "runtimeVersion" | "deploymentSha" | "outcome" | "idempotencyKey"
> & { audit: unknown };
type FixtureState = {
  audit: ParkedCourseCampaignAudit;
  course: FixtureCourse;
  incident: FixtureIncident;
  monitoring: FixtureMonitoring;
  events: FixtureEvent[];
};
type Query = { where: Record<string, unknown>; data?: Record<string, unknown> };
let state: FixtureState;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

// Narrow stateful Prisma seam: execute the predicates used by the real writers
// and readers, including revision/cycle/ownership CAS. Unknown operators fail.
function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Date) {
    return actual instanceof Date && actual.getTime() === expected.getTime();
  }
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    return actual === expected;
  }
  const filter = record(expected);
  if (Array.isArray(filter.path)) {
    const nested = filter.path.reduce<unknown>(
      (value, key) => record(value)[String(key)], actual,
    );
    return matchesValue(nested, filter.equals);
  }
  return Object.entries(filter).every(([operator, operand]) => {
    if (operator === "not") return !matchesValue(actual, operand);
    if (operator === "equals") return matchesValue(actual, operand);
    if (operator === "in" && Array.isArray(operand)) {
      return operand.some((value) => matchesValue(actual, value));
    }
    if (actual instanceof Date && operand instanceof Date) {
      if (operator === "gte") return actual >= operand;
      if (operator === "lte") return actual <= operand;
      if (operator === "gt") return actual > operand;
      if (operator === "lt") return actual < operand;
    }
    throw new Error(`Unsupported fixture filter: ${operator}`);
  });
}

function matchesWhere(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND" || key === "OR") {
      const filters = Array.isArray(expected) ? expected : [expected];
      return key === "AND"
        ? filters.every((filter) => matchesWhere(row, record(filter)))
        : filters.some((filter) => matchesWhere(row, record(filter)));
    }
    return matchesValue(record(row)[key], expected);
  });
}

function applyData(target: object, data: Record<string, unknown>) {
  const fields = record(target);
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!(key in fields)) throw new Error(`Unknown fixture write: ${key}`);
    const increment = record(value).increment;
    if (increment !== undefined) {
      if (typeof fields[key] !== "number" || typeof increment !== "number") {
        throw new Error("Invalid fixture increment");
      }
      fields[key] += increment;
    } else {
      fields[key] = clone(value);
    }
  }
}

function setup(input: {
  owned?: boolean;
  alreadyFinal?: boolean;
  campaignAdmission?: boolean;
  descendant?: boolean;
} = {}) {
  const audit = createParkedCourseCampaignAudit({
    expectedCount: 1,
    capturedAt,
    members: [{
      courseId, incidentId, cycle: 1, revision: 1, monitoringRevision: 1,
      monitoringFailureFingerprint: "SOURCE:MISSING", kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING", failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      providerSnapshotFingerprint: "b".repeat(64),
      attemptLedgerFingerprint: "c".repeat(64),
      playbookConclusion: "UNRESOLVED_EXHAUSTED",
      latestProbeAt: null, latestDiscoveryAt: null,
    }],
  });
  const cycle = input.descendant === false ? 1 : 2;
  state = {
    audit,
    course: {
      id: courseId, isPublic: true,
      website: "https://official.example/",
      detectedBookingUrl: "https://official.example/contact",
      monitoringMode: "CONTACT_ONLY", bookingMethod: "PHONE_ONLY",
      automationEligibility: "BLOCKED", automationReason: "NO_ONLINE_BOOKING",
      policyNotes: "The official course provides telephone booking only.",
      intelligenceVerifiedAt: sourceAt,
      intelligenceReviewAt: new Date("2026-12-01T00:00:00.000Z"),
      intelligenceConfidence: 1,
    },
    incident: {
      id: incidentId, courseId, cycle, revision: 2,
      status: "AUTO_INVESTIGATING", confirmedAt, firstSeenAt: capturedAt,
      lastSeenAt: confirmedAt,
      activeBatchId: input.owned ? "acceptance-owned-batch" : null,
      resolution: null, resolutionMessage: null, resolvedAt: null,
      decisionAt: null, decisionActorId: null, decisionNote: null,
      decisionEvidenceUrl: null, decisionIdempotencyKey: null,
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE", attemptCount: 0,
      activeRealSearchCount: 1, attemptLedger: null,
      nextAttemptAt: classifiedAt, nextReminderAt: null, nextAction: null,
    },
    monitoring: {
      courseId, state: input.alreadyFinal ? "FINAL_MANUAL" : "AUTO_INVESTIGATING",
      revision: 2, stateChangedAt: input.alreadyFinal ? sourceAt : confirmedAt,
      lastSuccessfulAt: null, lastFailureAt: confirmedAt,
      consecutiveFailures: input.alreadyFinal ? 0 : 1,
      failureFingerprint: input.alreadyFinal ? null : "SOURCE:MISSING",
      firstDegradedAt: input.alreadyFinal ? null : confirmedAt,
      nextAutomaticAttemptAt: input.alreadyFinal ? null : classifiedAt,
      revalidationRequestedAt: null,
    },
    events: input.campaignAdmission === false ? [] : [{
      id: "acceptance-admission-event", courseId, incidentId,
      eventType: "REVALIDATION_REQUESTED", source: "COURSE_SUPPORT_RESPONDER",
      occurredAt: confirmedAt, runtimeVersion: null, deploymentSha: null,
      outcome: null, idempotencyKey: null,
      audit: {
        action: "parked_cohort_admission", cycle,
        campaignRunId: campaignId, campaignMembershipDigest: audit.membershipDigest,
      },
    }],
  };
  database.course.findUnique.mockImplementation(async ({ where }: Query) =>
    matchesWhere(state.course, where) ? clone(state.course) : null);
  database.courseSupportIncident.findUnique.mockImplementation(async ({ where }: Query) =>
    matchesWhere(state.incident, where) ? clone(state.incident) : null);
  database.courseSupportIncident.findMany.mockImplementation(async ({ where }: Query) =>
    matchesWhere(state.incident, where) ? [{
      ...clone(state.incident),
      monitoringEvents: clone(state.events.filter((event) =>
        event.occurredAt >= capturedAt && [
          "HUMAN_REVIEW_REQUESTED", "HUMAN_DECISION", "REVALIDATION_REQUESTED",
          "RECOVERED", "STATE_CHANGED",
        ].includes(event.eventType))),
      course: { monitoringStatus: clone(state.monitoring), probes: [] },
    }] : []);
  database.courseSupportIncident.updateMany.mockImplementation(async ({ where, data }: Query) => {
    if (!matchesWhere(state.incident, where)) return { count: 0 };
    applyData(state.incident, data ?? {});
    return { count: 1 };
  });
  database.courseMonitoringStatus.upsert.mockImplementation(async () => clone(state.monitoring));
  database.courseMonitoringStatus.findUnique.mockImplementation(async ({ where }: Query) =>
    matchesWhere(state.monitoring, where) ? clone(state.monitoring) : null);
  database.courseMonitoringStatus.update.mockImplementation(async ({ where, data }: Query) => {
    if (!matchesWhere(state.monitoring, where)) throw new Error("FIXTURE_CAS_MISMATCH");
    applyData(state.monitoring, data ?? {});
    return clone(state.monitoring);
  });
  database.courseMonitoringEvent.findFirst.mockImplementation(async ({ where }: Query) =>
    clone(state.events.find((event) => matchesWhere(event, where)) ?? null));
  database.courseMonitoringEvent.findUnique.mockImplementation(async ({ where }: Query) =>
    clone(state.events.find((event) => matchesWhere(event, where)) ?? null));
  database.courseMonitoringEvent.create.mockImplementation(async ({ data }: {
    data: Prisma.CourseMonitoringEventUncheckedCreateInput;
  }) => {
    const event: FixtureEvent = {
      id: data.id ?? `acceptance-event-${state.events.length}`,
      courseId: data.courseId, incidentId: data.incidentId ?? null,
      eventType: data.eventType, source: data.source,
      occurredAt: data.occurredAt instanceof Date
        ? data.occurredAt : new Date(String(data.occurredAt)),
      runtimeVersion: data.runtimeVersion ?? null,
      deploymentSha: data.deploymentSha ?? null,
      outcome: data.outcome ?? null, idempotencyKey: data.idempotencyKey ?? null,
      audit: clone(data.audit),
    };
    if (event.idempotencyKey && state.events.some((prior) =>
      prior.idempotencyKey === event.idempotencyKey)) {
      throw new Error("FIXTURE_DUPLICATE_EVENT");
    }
    state.events.push(event);
    return clone(event);
  });
}

async function recordOfficialContactOnlyFinalStage(
  sourceRuntime: string | null = runtimeVersion,
  observedAt = sourceAt,
) {
  expect(evaluateMonitoringGate({ ...state.course, now: classifiedAt }))
    .toMatchObject({ disposition: "MANUAL_FINAL", currentEvidence: true });
  expect(new URL(state.course.website!).origin)
    .toBe(new URL(state.course.detectedBookingUrl!).origin);
  const runtime = await loadSearchPlaybookRuntime({
    courseId, runtimeVersion: sourceRuntime, context: clone(state.incident),
  });
  expect(runtime?.assessment.nextStage).toBe("OFFICIAL_IDENTITY");
  if (!runtime) throw new Error("Missing fixture playbook runtime");
  await recordSearchPlaybookTransition(runtime, {
    stage: "OFFICIAL_IDENTITY", transition: "FACTUAL_FINAL",
    readPath: "OFFICIAL_IDENTITY", evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_IDENTITY_MANUAL_FINAL,
    factualDisposition: "MANUAL_DIRECT", observedAt,
    note: "Current authoritative course facts support a direct final action.",
  });
  expect(runtime.assessment).toMatchObject({
    conclusion: "FACTUAL_FINAL", factualDisposition: "MANUAL_DIRECT", nextStage: null,
  });
}

async function classify(input: {
  kind?: "PLAYBOOK_FACTUAL_FINAL" | "COURSE_INTELLIGENCE";
  source?: "SEARCH_WORKFLOW" | "OPERATOR_CLI";
  runtime?: string | null;
} = {}) {
  const evidence = input.kind === "COURSE_INTELLIGENCE"
    ? { kind: "COURSE_INTELLIGENCE" as const, observedAt: state.course.intelligenceVerifiedAt! }
    : {
        kind: "PLAYBOOK_FACTUAL_FINAL" as const, cycle: state.incident.cycle,
        observedAt: getAutomationPlaybookFactualFinalEvidence(
          state.incident.attemptLedger, state.incident.cycle,
        )!.observedAt,
      };
  return recordCourseMonitoringFinalClassification({
    courseId, state: "FINAL_MANUAL", outcome: "MANUAL_DIRECT", evidence,
    message: "Current official contact-only evidence confirms direct booking.",
    runtimeVersion: input.runtime === undefined ? runtimeVersion : input.runtime,
    source: input.source, now: classifiedAt,
  });
}

async function strictRead() {
  // Only the external Prisma boundary is substituted. All evidence generation,
  // campaign attachment, strict loading, and acceptance classification are real.
  const observations = await loadCampaignMemberObservations(
    state.audit, new Set(), campaignId,
    database as unknown as Prisma.TransactionClient,
  );
  const progress = summarizeParkedCourseCampaignProgress({
    audit: state.audit, observations, remainingGlobalParkedCount: 0,
  });
  return { observations, progress };
}

function terminalEvents() {
  return state.events.filter((event) =>
    event.eventType === "STATE_CHANGED" || event.eventType === "RECOVERED");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", runtimeVersion);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }));
  database.$transaction.mockImplementation(async (
    worker: (transaction: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    const before = clone(state);
    try {
      return await worker(database as unknown as Prisma.TransactionClient);
    } catch (error) {
      state = before;
      throw error;
    }
  });
  database.$queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (!sql.includes("pg_advisory_xact_lock")) throw new Error("UNEXPECTED_FIXTURE_SQL");
    return [{ locked: true }];
  });
  database.providerRequestLease.findUnique.mockResolvedValue(null);
  database.localReaderJob.findMany.mockResolvedValue([]);
  database.courseSupportBatchIncident.findMany.mockResolvedValue([]);
  database.teeTimeMatch.updateMany.mockResolvedValue({ count: 0 });
  database.teeSearch.updateMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("automatic factual classification to strict campaign acceptance", () => {
  it.each(["PLAYBOOK_FACTUAL_FINAL", "COURSE_INTELLIGENCE"] as const)(
    "accepts a fresh same-runtime unowned contact-only outcome through %s",
    async (kind) => {
      setup();
      await recordOfficialContactOnlyFinalStage();
      await expect(classify({ kind })).resolves.toMatchObject({
        state: "FINAL_MANUAL", sourceEvidenceAccepted: true,
      });
      expect(state.incident).toMatchObject({
        status: "RESOLVED", resolution: "DIRECT_BOOKING_CLASSIFIED",
        activeBatchId: null, nextAttemptAt: null, nextReminderAt: null,
      });
      const { observations, progress } = await strictRead();
      expect(observations[0]).toMatchObject({
        campaignTerminalEvidenceAt: sourceAt,
        campaignTerminalRuntimeVersion: runtimeVersion,
        campaignTerminalDeploymentSha: runtimeVersion,
        campaignTerminalAutomatedFinal: true,
        campaignTerminalFreshRuntimeProof: true,
      });
      expect(progress).toMatchObject({
        terminalCount: 1, factualLimitationCount: 1, engineeringBlockerCount: 0,
      });
    },
  );

  it("receipts a newly resolved factual incident when the monitoring state is already final", async () => {
    setup({ alreadyFinal: true });
    const originalStateChangedAt = clone(state.monitoring.stateChangedAt);
    await recordOfficialContactOnlyFinalStage();
    await expect(classify()).resolves.toMatchObject({ sourceEvidenceAccepted: true });
    expect(state.incident.status).toBe("RESOLVED");
    expect(state.monitoring.stateChangedAt).toEqual(originalStateChangedAt);
    expect(terminalEvents()).toHaveLength(1);
    expect((await strictRead()).progress).toMatchObject({
      terminalCount: 1, factualLimitationCount: 1, engineeringBlockerCount: 0,
    });
  });

  it("does not rewrite an older final-state timestamp to make a new receipt pass acceptance", async () => {
    setup({ alreadyFinal: true });
    const originalStateChangedAt = new Date(confirmedAt.getTime() - 60_000);
    state.monitoring.stateChangedAt = originalStateChangedAt;
    await recordOfficialContactOnlyFinalStage();
    await classify();
    expect(state.incident.status).toBe("RESOLVED");
    expect(state.monitoring.stateChangedAt).toEqual(originalStateChangedAt);
    expect(terminalEvents()).toHaveLength(1);
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
  });

  it("preserves active batch ownership and leaves strict acceptance incomplete", async () => {
    setup({ owned: true });
    await recordOfficialContactOnlyFinalStage();
    await expect(classify()).resolves.toMatchObject({ sourceEvidenceAccepted: true });
    expect(state.incident).toMatchObject({
      status: "AUTO_INVESTIGATING", activeBatchId: "acceptance-owned-batch", resolution: null,
    });
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 0, activeCount: 1 });
  });

  it("rejects factual classification when stronger newer monitoring evidence exists", async () => {
    setup();
    await recordOfficialContactOnlyFinalStage();
    state.monitoring.lastSuccessfulAt = new Date(sourceAt.getTime() + 1_000);
    await expect(classify()).resolves.toMatchObject({ sourceEvidenceAccepted: false });
    expect(state.incident.status).toBe("AUTO_INVESTIGATING");
    expect(terminalEvents()).toHaveLength(0);
  });

  it.each(["b".repeat(40), null, "UNKNOWN", "a".repeat(39)])(
    "does not mint fresh runtime proof from source runtime %s",
    async (sourceRuntime) => {
      setup();
      await recordOfficialContactOnlyFinalStage(sourceRuntime);
      await expect(classify()).resolves.toMatchObject({ sourceEvidenceAccepted: true });
      expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
      expect(terminalEvents().some((event) => record(event.audit).freshRuntimeProof === true))
        .toBe(false);
    },
  );

  it.each([null, "UNKNOWN", "a".repeat(39), "b".repeat(40)])(
    "does not trust the supplied writer runtime %s without deployed identity equality",
    async (runtime) => {
      setup();
      await recordOfficialContactOnlyFinalStage();
      await classify({ runtime });
      expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
    },
  );

  it("requires actual current-cycle factual playbook proof for the intelligence branch", async () => {
    setup();
    expect(state.incident.attemptLedger).toBeNull();
    await expect(classify({ kind: "COURSE_INTELLIGENCE" }))
      .resolves.toMatchObject({ sourceEvidenceAccepted: true });
    expect(state.incident.status).toBe("RESOLVED");
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
  });

  it("does not relabel earlier intelligence with a later factual-stage timestamp", async () => {
    setup();
    await recordOfficialContactOnlyFinalStage(
      runtimeVersion, new Date(sourceAt.getTime() + 1_000),
    );
    await expect(classify({ kind: "COURSE_INTELLIGENCE" }))
      .resolves.toMatchObject({ sourceEvidenceAccepted: true });
    expect(state.incident.lastSeenAt).toEqual(sourceAt);
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
  });

  it.each([undefined, "UNKNOWN", "a".repeat(39)])(
    "requires trustworthy deployment identity rather than environment value %s",
    async (deployedRuntime) => {
      setup();
      await recordOfficialContactOnlyFinalStage();
      vi.stubEnv("VERCEL_GIT_COMMIT_SHA", deployedRuntime);
      await classify();
      expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
    },
  );

  it("does not turn an operator classification into automatic runtime proof", async () => {
    setup();
    await recordOfficialContactOnlyFinalStage();
    await classify({ source: "OPERATOR_CLI" });
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
    expect(terminalEvents().some((event) => record(event.audit).freshRuntimeProof === true))
      .toBe(false);
  });

  it("preserves an explicit operator decision when its timestamp is unavailable", async () => {
    setup();
    await recordOfficialContactOnlyFinalStage();
    state.incident.decisionNote = "Existing operator evidence requires review.";
    await classify();
    expect(state.incident.decisionNote).toBe("Existing operator evidence requires review.");
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
  });

  it("does not accept an unattributed same-cycle event as campaign completion", async () => {
    setup({ campaignAdmission: false, descendant: false });
    await recordOfficialContactOnlyFinalStage();
    await classify();
    expect((await strictRead()).observations[0]).toMatchObject({
      campaignTerminalEvidenceAt: null, campaignTerminalFreshRuntimeProof: false,
    });
  });

  it("retains the existing strict descendant acceptance path without campaign attachment", async () => {
    setup({ campaignAdmission: false });
    await recordOfficialContactOnlyFinalStage();
    await classify();
    expect(terminalEvents().some((event) => record(event.audit).campaign !== undefined)).toBe(false);
    expect((await strictRead()).progress).toMatchObject({
      terminalCount: 1, factualLimitationCount: 1,
    });
  });

  it("does not duplicate the factual terminal receipt on repeated classification", async () => {
    setup();
    await recordOfficialContactOnlyFinalStage();
    await classify();
    const firstEvents = clone(terminalEvents());
    expect(firstEvents).toHaveLength(1);
    await classify();
    expect(terminalEvents()).toEqual(firstEvents);
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 1 });
  });

  it("does not refresh or reopen an already resolved historical manual outcome", async () => {
    setup({ alreadyFinal: true });
    await recordOfficialContactOnlyFinalStage();
    Object.assign(state.incident, {
      status: "RESOLVED", resolution: "DIRECT_BOOKING_CLASSIFIED",
      resolvedAt: capturedAt, nextAttemptAt: null,
    });
    database.courseSupportIncident.updateMany.mockClear();
    await classify();
    expect(database.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(state.incident).toMatchObject({ status: "RESOLVED", resolvedAt: capturedAt });
    expect(terminalEvents()).toHaveLength(0);
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
  });

  it("does not attribute an old-cycle receipt after resolution CAS loses to a new cycle", async () => {
    setup();
    await recordOfficialContactOnlyFinalStage();
    database.courseSupportIncident.updateMany.mockImplementationOnce(async () => {
      state.incident.cycle += 1;
      state.incident.revision += 1;
      state.incident.confirmedAt = new Date(sourceAt.getTime() + 1_000);
      state.incident.lastSeenAt = state.incident.confirmedAt;
      state.incident.attemptLedger = null;
      return { count: 0 };
    });
    await classify();
    expect(state.incident).toMatchObject({ cycle: 3, status: "AUTO_INVESTIGATING" });
    expect(terminalEvents().some((event) => record(event.audit).freshRuntimeProof === true))
      .toBe(false);
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
  });

  it.each([
    {
      label: "a newer source observation",
      mutate: () => { state.incident.lastSeenAt = new Date(sourceAt.getTime() + 1_000); },
    },
    {
      label: "a replaced source ledger",
      mutate: () => { state.incident.attemptLedger = null; },
    },
    {
      label: "new operator evidence",
      mutate: () => { state.incident.decisionNote = "A concurrent operator supplied new evidence."; },
    },
    {
      label: "a newly acquired batch owner",
      mutate: () => { state.incident.activeBatchId = "new-acceptance-owner"; },
    },
  ])("does not reuse accepted facts after resolution CAS loses to $label", async ({ mutate }) => {
    setup();
    await recordOfficialContactOnlyFinalStage();
    database.courseSupportIncident.updateMany.mockImplementationOnce(async () => {
      state.incident.revision += 1;
      mutate();
      return { count: 0 };
    });
    await classify();
    expect(state.incident.status).toBe("AUTO_INVESTIGATING");
    expect(terminalEvents().some((event) => record(event.audit).freshRuntimeProof === true))
      .toBe(false);
    expect((await strictRead()).progress).toMatchObject({ terminalCount: 0 });
  });

  it("accepts a revision-only resolution retry when all source and ownership facts still match", async () => {
    setup();
    await recordOfficialContactOnlyFinalStage();
    database.courseSupportIncident.updateMany.mockImplementationOnce(async () => {
      state.incident.revision += 1;
      return { count: 0 };
    });
    await classify();
    expect(state.incident).toMatchObject({
      status: "RESOLVED", resolution: "DIRECT_BOOKING_CLASSIFIED", activeBatchId: null,
    });
    expect(terminalEvents()).toHaveLength(1);
    expect((await strictRead()).progress).toMatchObject({
      terminalCount: 1, factualLimitationCount: 1,
    });
  });
});
