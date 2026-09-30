import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  batchFindFirst: vi.fn(),
  transaction: vi.fn(),
  transactionBatchFindFirst: vi.fn(),
  transactionBatchUpdateMany: vi.fn(),
  queryRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    courseSupportBatch: { findFirst: database.batchFindFirst },
    $transaction: database.transaction,
  },
}));

import { appendAutomationPlaybookEvent } from "./course-monitoring-playbook";
import {
  getOwnedCourseSupportResearchContext,
  registerOwnedCourseSupportResearchSpecialist,
  validateOwnedCourseSupportResearchContext,
} from "./course-support-research-context";
import {
  appendCourseSupportLineage,
  COURSE_SUPPORT_LINEAGE_EVENT_LIMIT,
  createCourseSupportLineage,
  readCourseSupportLineage,
} from "./course-support-lineage";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";

const now = new Date("2026-09-28T14:00:00.000Z");
const input = {
  batchId: "batch-mount-snow",
  leaseToken: "owned-lease",
  ownerThreadId: "owned-thread",
  ordinal: 1,
  now,
};

function fixture() {
  const failureFingerprint = "v1:UNSUPPORTED_FAMILY:QUICK18";
  const officialSite = "https://www.mountsnow.com/golf";
  const officialBooking = "https://mountsnow.quick18.com/teetimes/searchmatrix";
  const course = {
    id: "course-mount-snow",
    googlePlaceId: "place-mount-snow",
    name: "Mount Snow Golf Club",
    address: "100 Main Street",
    city: "West Dover",
    stateCode: "VT",
    latitude: 42.97,
    longitude: -72.9,
    timeZone: "America/New_York",
    website: officialSite,
    detectedBookingUrl: officialBooking,
    detectedPlatform: "CUSTOM",
    providerFamilyKey: "QUICK18",
    bookingMethod: "PUBLIC_ONLINE",
    bookingWindowDaysAhead: null,
    bookingWindowEvidenceUrl: null,
    bookingReleaseTimeLocal: null,
    bookingWindowSource: null,
    bookingWindowConfidence: null,
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "UNSUPPORTED_PLATFORM",
    monitoringMode: "AUTOMATIC",
    bookingAccessMode: "PUBLIC_SIGNED_OUT",
    isPublic: true,
    intelligenceVerifiedAt: null,
    intelligenceReviewAt: null,
    intelligenceConfidence: null,
    bookingMetadata: null,
    layoutHoleCounts: [],
    layoutHolesVerifiedAt: null,
    monitoringStatus: { state: "AUTO_INVESTIGATING", failureFingerprint },
    monitoringEvents: [{
      incidentId: "incident-mount-snow",
      eventType: "AUTOMATION_ATTEMPTED",
      outcome: "NEEDS_ADAPTER",
      readPath: "RENDERED_BROWSER",
      failureFingerprint,
      occurredAt: new Date("2026-09-28T13:40:00.000Z"),
    }],
    automationDiscoveries: [{
      status: "INSPECTED",
      sourceUrl: officialSite,
      bookingUrl: officialBooking,
      detectedPlatform: "CUSTOM",
      automationReason: "UNSUPPORTED_PLATFORM",
      apiMetadata: null as null | { provider: string; bookingBaseUrl: string },
      confidence: 0.85,
      createdAt: new Date("2026-09-28T13:45:00.000Z"),
      evidence: {
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_PROVIDER_LINK",
          officialWebsiteUrl: officialSite,
          officialPageUrl: officialSite,
          providerUrl: officialBooking,
          courseName: "Mount Snow Golf Club",
        },
        officialPage: { visibleText: "Welcome to the 2026 golf season" },
        browserInvestigation: {
          incidentCycle: 1,
          observedAt: "2026-09-28T13:45:00.000Z",
          providerSnapshotFingerprint: "",
          providerRequestObserved: true,
          networkContracts: [{
            origin: "https://mountsnow.quick18.com",
            method: "GET",
            pathPattern: "/api/availability",
            queryKeys: ["date", "players"],
            resourceType: "fetch",
            status: 200,
          }],
        },
      },
    }],
  };
  const snapshotFingerprint = buildCourseSupportProviderSnapshotFingerprint(
    course as Parameters<typeof buildCourseSupportProviderSnapshotFingerprint>[0],
  );
  course.automationDiscoveries[0].evidence.browserInvestigation.providerSnapshotFingerprint = snapshotFingerprint;
  const ledger = appendAutomationPlaybookEvent(null, {
    cycle: 1,
    stage: "OFFICIAL_IDENTITY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_IDENTITY",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "TEST:OFFICIAL_IDENTITY:COMPLETE",
    runtimeVersion: "test-runtime",
    observedAt: new Date("2026-09-28T13:15:00.000Z"),
  });
  const actionPlan = {
    schemaVersion: 1,
    primaryAction: "IMPLEMENT_REUSABLE_SUPPORT",
    allowedActions: ["IMPLEMENT_REUSABLE_SUPPORT", "INSPECT_PROVIDER_CONTRACT"],
    route: {
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      strategyAction: "REPAIR_PROVIDER_ADAPTER",
      playbookStage: "TYPED_ADAPTER",
    },
  };
  return {
    revision: 4,
    reference: "batch-reference",
    status: "IMPLEMENTING",
    providerFamilyKey: "QUICK18",
    failureFingerprint,
    createdAt: new Date("2026-09-28T13:30:00.000Z"),
    leaseExpiresAt: new Date("2026-09-28T14:10:00.000Z"),
    summary: {
      remediation: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "TYPED_ADAPTER",
        allowUnchangedRuntime: false,
        requiresImplementationPath: true,
        reason: "IMPLEMENTATION_REQUIRED",
        retryBudget: null,
        attempts: [{
          courseRef: createHash("sha256").update(course.id).digest("hex").slice(0, 24),
          providerSnapshotFingerprint: snapshotFingerprint,
          failureFingerprint,
          playbookEventCountAtClaim: 1,
          approach: actionPlan.route,
          actionPlan,
        }],
      },
    },
    incidents: [{
      id: "batch-entry-mount-snow",
      createdAt: new Date("2026-09-28T13:30:00.000Z"),
      cycle: 1,
      result: "PENDING",
      course,
      incident: {
        id: "incident-mount-snow",
        cycle: 1,
        status: "AUTO_INVESTIGATING",
        kind: "NEEDS_ADAPTER",
        providerFamilyKey: "QUICK18",
        failureFingerprint,
        activeBatchId: input.batchId,
        attemptLedger: ledger,
        firstSeenAt: new Date("2026-09-28T13:00:00.000Z"),
        confirmedAt: new Date("2026-09-28T13:00:00.000Z") as Date | null,
        resolution: null,
      },
    }],
  };
}

describe("owned course-support research context", () => {
  beforeEach(() => database.batchFindFirst.mockReset());

  it("gates exact identity and URLs by the active owner and emits candidate-only read evidence", async () => {
    database.batchFindFirst.mockResolvedValue(fixture());
    const result = await getOwnedCourseSupportResearchContext(input);
    expect(database.batchFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: input.batchId,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        leaseExpiresAt: { gt: now },
      }),
    }));
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    const context = result.researchContextV1;
    expect(context.schemaVersion).toBe(1);
    expect(context.identity).toMatchObject({ name: "Mount Snow Golf Club", city: "West Dover", stateCode: "VT" });
    expect(context.linkChain).toMatchObject({
      officialSiteUrl: "https://www.mountsnow.com/golf",
      officialBookingUrl: "https://mountsnow.quick18.com/teetimes/searchmatrix",
      status: "CURRENT_DISCOVERY_CORROBORATED",
      season: "2026 golf season",
    });
    expect(context.availabilityContract).toMatchObject({
      status: "CANDIDATE_ONLY",
      requestFieldMapping: { date: "DATE", players: "PLAYERS", course: null },
      responseFieldMapping: null,
      signedOutReadOnlyConfirmed: false,
    });
    expect(context.missingEvidence).toContain("AVAILABILITY_RESPONSE_FIELD_MAPPING");
    expect(context.missingEvidence).toContain("EXACT_RUNTIME_MATCH_OR_NO_MATCH_PROBE");
    expect(JSON.stringify(result)).not.toMatch(/rawResponse|cookie|recipient|screenshot/iu);
    const validated = await validateOwnedCourseSupportResearchContext({
      ...input, contextDigest: context.contextDigest,
    });
    expect(validated).toMatchObject({
      outcome: "valid",
      implementationMayProceedFromResearch: false,
      furtherBoundedInspectionRequired: true,
      monitoringProofRecorded: false,
    });
  });

  it("returns no private fields after ownership loss or stale claim snapshot", async () => {
    database.batchFindFirst.mockResolvedValueOnce(null);
    const lost = await getOwnedCourseSupportResearchContext(input);
    expect(lost).toMatchObject({ outcome: "recovery_required" });
    expect(JSON.stringify(lost)).not.toContain("Mount Snow");

    const batch = fixture();
    batch.incidents[0].course.website = "https://changed-course.example/";
    database.batchFindFirst.mockResolvedValueOnce(batch);
    const stale = await getOwnedCourseSupportResearchContext(input);
    expect(stale).toMatchObject({ outcome: "authority_drift", packetRefreshRequired: true });
    expect(JSON.stringify(stale)).not.toContain("Mount Snow");
  });

  it("rejects an old digest when the current evidence or link chain changes", async () => {
    const batch = fixture();
    database.batchFindFirst.mockResolvedValue(batch);
    const first = await getOwnedCourseSupportResearchContext(input);
    if (first.outcome !== "ready") throw new Error("Expected owned context");
    batch.incidents[0].course.automationDiscoveries[0].evidence.officialPage.visibleText =
      "The 2027 golf season has new instructions";
    const stale = await validateOwnedCourseSupportResearchContext({
      ...input, contextDigest: first.researchContextV1.contextDigest,
    });
    expect(stale).toMatchObject({
      outcome: "authority_drift",
      reasonCode: "RESEARCH_CONTEXT_CHANGED",
      packetRefreshRequired: true,
    });
  });

  it("fails closed for expired leases, changed cycles, and changed action plans", async () => {
    const expired = fixture();
    expired.leaseExpiresAt = now;
    database.batchFindFirst.mockResolvedValueOnce(expired);
    expect(await getOwnedCourseSupportResearchContext(input)).toMatchObject({ outcome: "recovery_required" });

    const cycleChanged = fixture();
    cycleChanged.incidents[0].incident.cycle = 2;
    database.batchFindFirst.mockResolvedValueOnce(cycleChanged);
    expect(await getOwnedCourseSupportResearchContext(input)).toMatchObject({ outcome: "authority_drift" });

    const planChanged = fixture();
    planChanged.summary.remediation.playbookStage = "OFFICIAL_HTTP_DISCOVERY";
    database.batchFindFirst.mockResolvedValueOnce(planChanged);
    expect(await getOwnedCourseSupportResearchContext(input)).toMatchObject({ outcome: "authority_drift" });
  });

  it.each([
    "https://mountsnow.quick18.com/teetimes/searchmatrix?email=golfer%40example.com",
    "https://mountsnow.quick18.com/teetimes/golfer%40example.com/searchmatrix",
    "https://mountsnow.quick18.com/teetimes/searchmatrix#golfer%2540example.com",
    "https://golfer@example.com@mountsnow.quick18.com/teetimes/searchmatrix",
  ])("does not return a URL carrying recipient or userinfo state: %s", async (unsafeUrl) => {
    const batch = fixture();
    const course = batch.incidents[0].course;
    course.detectedBookingUrl = unsafeUrl;
    const fingerprint = buildCourseSupportProviderSnapshotFingerprint(
      course as Parameters<typeof buildCourseSupportProviderSnapshotFingerprint>[0],
    );
    batch.summary.remediation.attempts[0].providerSnapshotFingerprint = fingerprint;
    course.automationDiscoveries[0].evidence.browserInvestigation.providerSnapshotFingerprint = fingerprint;
    database.batchFindFirst.mockResolvedValueOnce(batch);
    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.linkChain.officialBookingUrl).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/golfer(?:%25)?(?:%40|@)example\.com/iu);
  });

  it("excludes prior-cycle discovery even when the provider snapshot is unchanged", async () => {
    const batch = fixture();
    const entry = batch.incidents[0];
    entry.cycle = 2;
    entry.incident.cycle = 2;
    // A legacy reopen can move firstSeenAt without replacing confirmedAt.
    entry.incident.firstSeenAt = new Date("2026-09-28T13:50:00.000Z");
    entry.incident.attemptLedger = appendAutomationPlaybookEvent(null, {
      cycle: 2,
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "TEST:OFFICIAL_IDENTITY:COMPLETE",
      runtimeVersion: "test-runtime",
      observedAt: new Date("2026-09-28T13:52:00.000Z"),
    });
    database.batchFindFirst.mockResolvedValueOnce(batch);
    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.incidentCycle).toBe(2);
    expect(result.researchContextV1.recentDiscoveryObservations).toEqual([]);
    expect(result.researchContextV1.linkChain.status).toBe("SNAPSHOT_ONLY");
    expect(result.researchContextV1.availabilityContract.status).toBe("MISSING");
    expect(result.researchContextV1.missingEvidence).toContain("CURRENT_OFFICIAL_PAGE_TO_BOOKING_LINK");

    entry.incident.confirmedAt = null;
    database.batchFindFirst.mockResolvedValueOnce(batch);
    expect(await getOwnedCourseSupportResearchContext(input)).toMatchObject({
      outcome: "authority_drift", packetRefreshRequired: true,
    });
  });

  it("derives Quick18 response fields only from a current validated public matrix marker", async () => {
    const batch = fixture();
    const discovery = batch.incidents[0].course.automationDiscoveries[0];
    discovery.status = "LEARNED";
    discovery.automationReason = "NONE";
    discovery.apiMetadata = {
      provider: "QUICK18",
      bookingBaseUrl: "https://mountsnow.quick18.com/teetimes/searchmatrix",
    };
    Object.assign(discovery.evidence, {
      learnedFrom: "quick18-validated-public-matrix",
      finalUrl: "https://mountsnow.quick18.com/teetimes/searchmatrix?teedate=20261001",
    });
    database.batchFindFirst.mockResolvedValue(batch);

    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.availabilityContract).toMatchObject({
      status: "CONFIRMED_PUBLIC_READ",
      signedOutReadOnlyConfirmed: true,
      requestFieldMapping: { date: "TEEDATE", players: null, course: null },
      responseFieldMapping: {
        date: "SearchForm_Date.value",
        time: "mtrxTeeTimes",
        players: "matrixPlayers",
        publicRate: "Daily Rate",
        selectionUrl: "public-rate selection href",
      },
    });
    expect(result.researchContextV1.availabilityContract.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "GET", resourceType: "DOCUMENT", queryKeys: ["DATE"],
      }),
    ]));
    expect(result.researchContextV1.missingEvidence).not.toContain("AVAILABILITY_RESPONSE_FIELD_MAPPING");
    expect(result.researchContextV1.missingEvidence).toContain("EXACT_RUNTIME_MATCH_OR_NO_MATCH_PROBE");
    expect(result.researchContextV1.monitoringProofRecorded).toBe(false);
    expect(await validateOwnedCourseSupportResearchContext({
      ...input, contextDigest: result.researchContextV1.contextDigest,
    })).toMatchObject({
      outcome: "valid",
      implementationMayProceedFromResearch: true,
      furtherBoundedInspectionRequired: false,
      monitoringProofRecorded: false,
    });

    discovery.evidence.browserInvestigation.providerSnapshotFingerprint = "f".repeat(64);
    const drifted = await getOwnedCourseSupportResearchContext(input);
    if (drifted.outcome !== "ready") throw new Error("Expected drifted context");
    expect(drifted.researchContextV1.availabilityContract.signedOutReadOnlyConfirmed).toBe(false);
    expect(drifted.researchContextV1.availabilityContract.responseFieldMapping).toBeNull();
  });

  it("keeps implementation closed when a validated matrix has an inspection-only action plan", async () => {
    const batch = fixture();
    const discovery = batch.incidents[0].course.automationDiscoveries[0];
    discovery.status = "LEARNED";
    discovery.automationReason = "NONE";
    discovery.apiMetadata = {
      provider: "QUICK18",
      bookingBaseUrl: "https://mountsnow.quick18.com/teetimes/searchmatrix",
    };
    Object.assign(discovery.evidence, {
      learnedFrom: "quick18-validated-public-matrix",
      finalUrl: "https://mountsnow.quick18.com/teetimes/searchmatrix?teedate=20261001",
    });
    batch.summary.remediation.attempts[0].actionPlan.primaryAction = "INSPECT_PROVIDER_CONTRACT";
    batch.summary.remediation.attempts[0].actionPlan.allowedActions = ["INSPECT_PROVIDER_CONTRACT"];
    database.batchFindFirst.mockResolvedValue(batch);

    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.availabilityContract.status).toBe("CONFIRMED_PUBLIC_READ");
    expect(await validateOwnedCourseSupportResearchContext({
      ...input, contextDigest: result.researchContextV1.contextDigest,
    })).toMatchObject({
      outcome: "valid",
      implementationMayProceedFromResearch: false,
      furtherBoundedInspectionRequired: true,
      monitoringProofRecorded: false,
    });
  });

  it("marks conflicting official links and restricted reads as unsuitable for implementation", async () => {
    const batch = fixture();
    batch.incidents[0].course.automationDiscoveries[0].evidence.courseIdentityCorroboration.providerUrl =
      "https://other-course.example/teetimes";
    Object.assign(batch.incidents[0].course.automationDiscoveries[0].evidence.browserInvestigation,
      { restrictedNetworkObserved: true });
    database.batchFindFirst.mockResolvedValue(batch);
    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.conflicts).toContain("OFFICIAL_LINK_CHAIN_DIFFERS_FROM_CURRENT_COURSE");
    expect(result.researchContextV1.accessBarriers).toContain("RESTRICTED_NETWORK");
    expect(result.researchContextV1.availabilityContract.status).toBe("BARRIER");
    const validated = await validateOwnedCourseSupportResearchContext({
      ...input, contextDigest: result.researchContextV1.contextDigest,
    });
    expect(validated).toMatchObject({ outcome: "valid", implementationMayProceedFromResearch: false });
  });

  it("corroborates a dated Quick18 official link against the exact canonical tenant page", async () => {
    const batch = fixture();
    const discovery = batch.incidents[0].course.automationDiscoveries[0];
    const datedUrl = "https://mountsnow.quick18.com/teetimes/searchmatrix?teedate=20260929";
    Object.assign(discovery.evidence, { finalUrl: datedUrl });
    discovery.evidence.courseIdentityCorroboration.providerUrl = datedUrl;
    database.batchFindFirst.mockResolvedValueOnce(batch);
    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.linkChain).toMatchObject({
      officialBookingUrl: "https://mountsnow.quick18.com/teetimes/searchmatrix",
      status: "CURRENT_DISCOVERY_CORROBORATED",
    });
    expect(result.researchContextV1.recentDiscoveryObservations[0]).toMatchObject({
      bookingPage: "https://mountsnow.quick18.com/teetimes/searchmatrix",
      officialLinkCorroborated: true,
    });
    expect(result.researchContextV1.conflicts).toEqual([]);
  });

  it.each([
    "https://other-course.quick18.com/teetimes/searchmatrix?teedate=20260929",
    "https://mountsnow.quick18.com/teetimes/searchmatrix?teedate=20260929&players=2",
  ])("rejects an unbound Quick18 official link: %s", async (unboundUrl) => {
    const batch = fixture();
    const discovery = batch.incidents[0].course.automationDiscoveries[0];
    discovery.evidence.courseIdentityCorroboration.providerUrl = unboundUrl;
    database.batchFindFirst.mockResolvedValueOnce(batch);
    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.linkChain.status).toBe("SNAPSHOT_ONLY");
    expect(result.researchContextV1.conflicts).toContain("OFFICIAL_LINK_CHAIN_DIFFERS_FROM_CURRENT_COURSE");
    expect(result.researchContextV1.missingEvidence).toContain("CURRENT_OFFICIAL_PAGE_TO_BOOKING_LINK");
  });

  it("does not reuse an older official link after a newer discovery names a different booking page", async () => {
    const batch = fixture();
    const course = batch.incidents[0].course;
    const oldDiscovery = course.automationDiscoveries[0];
    course.automationDiscoveries.unshift({
      ...oldDiscovery,
      createdAt: new Date("2026-09-28T13:55:00.000Z"),
      bookingUrl: "https://other-course.quick18.com/teetimes/searchmatrix",
      evidence: {
        ...oldDiscovery.evidence,
        courseIdentityCorroboration: undefined,
        browserInvestigation: {
          ...oldDiscovery.evidence.browserInvestigation,
          observedAt: "2026-09-28T13:55:00.000Z",
        },
      },
    } as typeof oldDiscovery);
    database.batchFindFirst.mockResolvedValueOnce(batch);
    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.linkChain.status).toBe("SNAPSHOT_ONLY");
    expect(result.researchContextV1.conflicts).toContain(
      "DISCOVERY_BOOKING_LINK_DIFFERS_FROM_CURRENT_COURSE",
    );
    expect(result.researchContextV1.availabilityContract.signedOutReadOnlyConfirmed).toBe(false);
  });

  it("does not treat an older official link as current after a newer not-found observation", async () => {
    const batch = fixture();
    const previous = batch.incidents[0].course.automationDiscoveries[0];
    batch.incidents[0].course.automationDiscoveries.unshift({
      ...previous,
      createdAt: new Date("2026-09-28T13:55:00.000Z"),
      evidence: {
        ...previous.evidence,
        courseIdentityCorroboration: { ...previous.evidence.courseIdentityCorroboration,
          kind: "OFFICIAL_COURSE_NON_RUNNABLE_BOOKING_LINK" },
        browserInvestigation: { ...previous.evidence.browserInvestigation,
          networkContracts: [] },
        sourcePageAvailability: "SOFT_NOT_FOUND",
      },
    } as typeof previous);
    database.batchFindFirst.mockResolvedValue(batch);
    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.linkChain.status).toBe("SNAPSHOT_ONLY");
    expect(result.researchContextV1.accessBarriers).toContain("OFFICIAL_SOURCE_NOT_FOUND");
    expect(result.researchContextV1.missingEvidence).toContain("CURRENT_OFFICIAL_PAGE_TO_BOOKING_LINK");
  });

  it("lets a newer corroborated signed-out observation supersede an old 404 and restricted read", async () => {
    const batch = fixture();
    const course = batch.incidents[0].course;
    const oldObservation = course.automationDiscoveries[0];
    Object.assign(oldObservation.evidence, { sourcePageAvailability: "SOFT_NOT_FOUND" });
    Object.assign(oldObservation.evidence.browserInvestigation, { restrictedNetworkObserved: true });
    const currentObservation = {
      ...oldObservation,
      createdAt: new Date("2026-09-28T13:55:00.000Z"),
      evidence: {
        ...oldObservation.evidence,
        sourcePageAvailability: undefined,
        browserInvestigation: {
          ...oldObservation.evidence.browserInvestigation,
          observedAt: "2026-09-28T13:55:00.000Z",
          restrictedNetworkObserved: false,
        },
      },
    };
    oldObservation.evidence.browserInvestigation.providerSnapshotFingerprint = "f".repeat(64);
    // Deliberately present the rows out of order; the projection must order
    // by observation time instead of retaining a historical failure as current.
    course.automationDiscoveries.push(currentObservation as typeof oldObservation);
    database.batchFindFirst.mockResolvedValue(batch);

    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    const context = result.researchContextV1;
    expect(context.linkChain).toMatchObject({
      status: "CURRENT_DISCOVERY_CORROBORATED",
      observedAt: "2026-09-28T13:55:00.000Z",
    });
    expect(context.availabilityContract.status).toBe("CANDIDATE_ONLY");
    expect(context.conflicts).toEqual([]);
    expect(context.accessBarriers).not.toContain("OFFICIAL_SOURCE_NOT_FOUND");
    expect(context.accessBarriers).not.toContain("RESTRICTED_NETWORK");
    expect(context.recentDiscoveryObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        observedAt: "2026-09-28T13:45:00.000Z",
        sourcePageAvailability: "SOFT_NOT_FOUND",
        restrictedNetworkObserved: true,
        providerSnapshotBound: false,
      }),
    ]));
  });

  it("treats a newer public GET as a candidate when the access snapshot still says account required", async () => {
    const batch = fixture();
    const course = batch.incidents[0].course;
    course.bookingAccessMode = "ACCOUNT_REQUIRED";
    const fingerprint = buildCourseSupportProviderSnapshotFingerprint(
      course as Parameters<typeof buildCourseSupportProviderSnapshotFingerprint>[0],
    );
    batch.summary.remediation.attempts[0].providerSnapshotFingerprint = fingerprint;
    course.automationDiscoveries[0].evidence.browserInvestigation.providerSnapshotFingerprint = fingerprint;
    database.batchFindFirst.mockResolvedValue(batch);

    const result = await getOwnedCourseSupportResearchContext(input);
    if (result.outcome !== "ready") throw new Error("Expected owned context");
    expect(result.researchContextV1.availabilityContract.status).toBe("CANDIDATE_ONLY");
    expect(result.researchContextV1.accessBarriers).not.toContain("ACCOUNT_REQUIRED");
    expect(result.researchContextV1.missingEvidence).toContain("RECONCILE_STALE_ACCESS_CLASSIFICATION");
    expect(result.researchContextV1.availabilityContract.signedOutReadOnlyConfirmed).toBe(false);
  });
});

describe("owner-bound research specialist registration", () => {
  beforeEach(() => {
    Object.values(database).forEach((mock) => mock.mockReset());
    database.transaction.mockImplementation(async (operation) => operation({
      $queryRaw: database.queryRaw,
      $queryRawUnsafe: database.queryRawUnsafe,
      courseSupportBatch: {
        findFirst: database.transactionBatchFindFirst,
        updateMany: database.transactionBatchUpdateMany,
      },
    }));
    database.queryRaw.mockImplementation(async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes("clock_timestamp")) return [{ now }];
      if (query.sql.includes('FROM "CourseSupportBatchIncident"')) {
        return [{ id: "batch-entry-mount-snow" }];
      }
      return [{ id: query.values[0] }];
    });
    database.queryRawUnsafe.mockResolvedValue([{ locked: true }]);
    database.transactionBatchUpdateMany.mockResolvedValue({ count: 1 });
  });

  function ownedFixture() {
    const batch = fixture();
    return {
      ...batch,
      summary: {
        ...batch.summary,
        ownershipLineageV1: createCourseSupportLineage("owner-run", input.ownerThreadId, batch.createdAt),
      },
    };
  }

  function configureTransaction(batch: ReturnType<typeof ownedFixture>) {
    database.transactionBatchFindFirst.mockResolvedValueOnce({
      revision: batch.revision,
      incidents: batch.incidents.map((entry) => ({
        id: entry.id, courseId: entry.course.id, incidentId: entry.incident.id,
      })),
    }).mockResolvedValueOnce(batch);
  }

  async function registrationInput(batch: ReturnType<typeof ownedFixture>) {
    database.batchFindFirst.mockResolvedValueOnce(batch);
    const context = await getOwnedCourseSupportResearchContext(input);
    if (context.outcome !== "ready") throw new Error("Expected current owned research context");
    return {
      batchId: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      ordinal: input.ordinal,
      contextDigest: context.researchContextV1.contextDigest,
      specialistThreadId: "specialist-child",
    };
  }

  it("locks current source authority then appends one private assignment with no proof mutation", async () => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    configureTransaction(batch);
    const result = await registerOwnedCourseSupportResearchSpecialist(assignment);
    expect(result).toEqual({
      outcome: "registered", ordinal: "01", assignmentRecorded: true,
      childAuthenticationVerified: false, modelUsageVerified: false,
      playbookStageRecorded: false, monitoringProofRecorded: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/owned-thread|specialist-child|batch-mount-snow|Mount Snow|https:/u);
    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000,
    });
    const rawStatements = database.queryRaw.mock.calls.map(([query]) => query.sql);
    expect(rawStatements.slice(1, 6)).toEqual([
      expect.stringContaining('FROM "Course"'),
      expect.stringContaining('FROM "CourseSupportIncident"'),
      expect.stringContaining('FROM "CourseMonitoringStatus"'),
      expect.stringContaining('FROM "CourseSupportBatch"'),
      expect.stringContaining('FROM "CourseSupportBatchIncident"'),
    ]);
    expect(rawStatements.filter((statement) => statement.includes("clock_timestamp"))).toHaveLength(3);
    expect(database.queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"), "course-monitoring:course-mount-snow",
    );
    expect(database.queryRawUnsafe.mock.invocationCallOrder[0])
      .toBeLessThan(database.queryRaw.mock.invocationCallOrder[1]);
    const update = database.transactionBatchUpdateMany.mock.calls[0][0];
    expect(update.where).toEqual(expect.objectContaining({
      id: input.batchId, ownerThreadId: input.ownerThreadId, leaseToken: input.leaseToken,
      revision: batch.revision, leaseExpiresAt: { gt: now },
      status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
    }));
    expect(Object.keys(update.data).sort()).toEqual(["revision", "summary"]);
    expect(update.data.summary.remediation).toEqual(batch.summary.remediation);
    expect(readCourseSupportLineage(update.data.summary)?.events).toEqual([
      batch.summary.ownershipLineageV1.events[0],
      expect.objectContaining({
        kind: "RESEARCH_ASSIGNMENT", actorThreadId: input.ownerThreadId,
        ownerThreadId: input.ownerThreadId, specialistThreadId: assignment.specialistThreadId,
        ordinal: 1, incidentCycle: 1, contextDigest: assignment.contextDigest,
        ownerEpoch: 1, observedAt: now.toISOString(),
      }),
    ]);
  });

  it("acquires all monitoring advisory locks in sorted course order before any authority row lock", async () => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    database.transactionBatchFindFirst.mockResolvedValueOnce({
      revision: batch.revision,
      incidents: [
        { id: "entry-z", courseId: "course-z", incidentId: "incident-z" },
        { id: "entry-a", courseId: "course-a", incidentId: "incident-a" },
      ],
    });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "authority_drift" });
    expect(database.queryRawUnsafe.mock.calls.map(([, key]) => key)).toEqual([
      "course-monitoring:course-a", "course-monitoring:course-z",
    ]);
    const firstRowLock = database.queryRaw.mock.calls.findIndex(([query]) => query.sql.includes("FOR UPDATE"));
    expect(Math.max(...database.queryRawUnsafe.mock.invocationCallOrder))
      .toBeLessThan(database.queryRaw.mock.invocationCallOrder[firstRowLock]);
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps exact duplicate assignments idempotent without another revision write", async () => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    const summary = appendCourseSupportLineage(batch.summary, {
      kind: "RESEARCH_ASSIGNMENT", actorThreadId: input.ownerThreadId,
      ownerThreadId: input.ownerThreadId, specialistThreadId: assignment.specialistThreadId,
      ordinal: 1, incidentCycle: 1, contextDigest: assignment.contextDigest,
    }, now);
    configureTransaction({ ...batch, summary: summary as typeof batch.summary });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({
      outcome: "already_registered", assignmentRecorded: true,
    });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
  });

  it("records the returned canonical agent path without treating it as a verified child session identity", async () => {
    const batch = ownedFixture();
    const assignment = { ...await registrationInput(batch), specialistThreadId: "/root/course_identity_research" };
    configureTransaction(batch);
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({
      outcome: "registered", childAuthenticationVerified: false, modelUsageVerified: false,
    });
    const recorded = readCourseSupportLineage(database.transactionBatchUpdateMany.mock.calls[0][0].data.summary);
    expect(recorded?.events.at(-1)?.specialistThreadId).toBe("/root/course_identity_research");
  });

  it("rejects an unavailable owner, expired lease, and expiry while holding the locks", async () => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    database.transactionBatchFindFirst.mockResolvedValueOnce(null);
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "recovery_required" });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
    configureTransaction({ ...batch, leaseExpiresAt: now });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "recovery_required" });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
    configureTransaction(batch);
    let clockReads = 0;
    database.queryRaw.mockImplementation(async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes("clock_timestamp")) {
        clockReads += 1;
        return [{ now: clockReads === 3 ? batch.leaseExpiresAt : now }];
      }
      if (query.sql.includes('FROM "CourseSupportBatchIncident"')) return [{ id: batch.incidents[0].id }];
      return [{ id: query.values[0] }];
    });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "recovery_required" });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects overflowing member authority and unavailable database time without a local-clock fallback", async () => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    database.transactionBatchFindFirst.mockResolvedValueOnce({
      revision: batch.revision,
      incidents: Array.from({ length: 21 }, (_, index) => ({
        id: `entry-${index}`, courseId: `course-${index}`, incidentId: `incident-${index}`,
      })),
    });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "authority_drift" });
    expect(database.queryRaw).toHaveBeenCalledTimes(1);
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
    database.queryRaw.mockResolvedValueOnce([]);
    await expect(registerOwnedCourseSupportResearchSpecialist(assignment)).rejects.toThrow("database time is unavailable");
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
  });

  it.each(["source", "cycle", "action", "provider"] as const)("rejects stale %s bindings before any assignment write", async (drift) => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    if (drift === "source") batch.incidents[0].course.automationDiscoveries[0].evidence.officialPage.visibleText = "2027 golf season";
    if (drift === "cycle") batch.incidents[0].incident.cycle = 2;
    if (drift === "action") batch.summary.remediation.attempts[0].actionPlan.allowedActions = ["INSPECT_PROVIDER_CONTRACT"];
    if (drift === "provider") batch.incidents[0].course.detectedBookingUrl = "https://other.quick18.com/teetimes/searchmatrix";
    configureTransaction(batch);
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({
      outcome: "authority_drift", assignmentRecorded: false,
      packetRefreshRequired: true, monitoringProofRecorded: false,
    });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects membership changes and a losing ownership/revision compare-and-set", async () => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    configureTransaction(batch);
    database.queryRaw.mockImplementation(async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes("clock_timestamp")) return [{ now }];
      if (query.sql.includes('FROM "CourseSupportBatchIncident"')) return [{ id: "changed-entry" }];
      return [{ id: query.values[0] }];
    });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "authority_drift" });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
    database.transactionBatchFindFirst.mockReset();
    configureTransaction(batch);
    database.queryRaw.mockImplementation(async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes("clock_timestamp")) return [{ now }];
      if (query.sql.includes('FROM "CourseSupportBatchIncident"')) return [{ id: batch.incidents[0].id }];
      return [{ id: query.values[0] }];
    });
    database.transactionBatchUpdateMany.mockResolvedValueOnce({ count: 0 });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "authority_drift" });
  });

  it("preserves unavailable malformed or full history and never invents complete legacy provenance", async () => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    configureTransaction({ ...batch, summary: { ...batch.summary, ownershipLineageV1: null } as unknown as typeof batch.summary });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "lineage_unavailable" });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
    let summary: Record<string, unknown> = batch.summary;
    for (let index = 1; index < COURSE_SUPPORT_LINEAGE_EVENT_LIMIT; index += 1) {
      summary = appendCourseSupportLineage(summary, {
        kind: "RESEARCH_ASSIGNMENT", actorThreadId: input.ownerThreadId,
        ownerThreadId: input.ownerThreadId, specialistThreadId: `other-child-${index}`,
        ordinal: 1, incidentCycle: 1, contextDigest: assignment.contextDigest,
      }, now);
    }
    configureTransaction({ ...batch, summary: summary as typeof batch.summary });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "lineage_unavailable" });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
    const legacy = ownedFixture();
    Reflect.deleteProperty(legacy.summary, "ownershipLineageV1");
    configureTransaction(legacy);
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({ outcome: "registered" });
    const updatedSummary = database.transactionBatchUpdateMany.mock.calls[0][0].data.summary;
    expect(readCourseSupportLineage(updatedSummary)?.completeness).toBe("LEGACY_INCOMPLETE");
  });

  it("refuses invalid-event history before an otherwise identical assignment without rewriting its valid prefix", async () => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    const assigned = appendCourseSupportLineage(batch.summary, {
      kind: "RESEARCH_ASSIGNMENT", actorThreadId: input.ownerThreadId,
      ownerThreadId: input.ownerThreadId, specialistThreadId: assignment.specialistThreadId,
      ordinal: 1, incidentCycle: 1, contextDigest: assignment.contextDigest,
    }, now);
    const retained = readCourseSupportLineage(assigned);
    if (!retained) throw new Error("Expected valid assignment prefix");
    const invalidHistory = {
      ...retained, completeness: "INVALID_EVENT_INCOMPLETE" as const, omittedEventCount: 1,
    };
    configureTransaction({ ...batch, summary: { ...batch.summary, ownershipLineageV1: invalidHistory } });
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({
      outcome: "lineage_unavailable", assignmentRecorded: false,
      childAuthenticationVerified: false, modelUsageVerified: false,
    });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
    expect(invalidHistory.events).toEqual(retained.events);
  });

  it("does not claim registration when a new assignment candidate becomes an invalid-event marker", async () => {
    const batch = ownedFixture();
    batch.summary.ownershipLineageV1.events[0].observedAt = "2026-09-28T14:01:00.000Z";
    const assignment = await registrationInput(batch);
    configureTransaction(batch);
    expect(await registerOwnedCourseSupportResearchSpecialist(assignment)).toMatchObject({
      outcome: "lineage_unavailable", assignmentRecorded: false,
    });
    expect(database.transactionBatchUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects self assignment and URL-like references before database access", async () => {
    const batch = ownedFixture();
    const assignment = await registrationInput(batch);
    await expect(registerOwnedCourseSupportResearchSpecialist({
      ...assignment, specialistThreadId: input.ownerThreadId,
    })).rejects.toThrow("distinct bounded");
    await expect(registerOwnedCourseSupportResearchSpecialist({
      ...assignment, specialistThreadId: "https://other.example/session",
    })).rejects.toThrow("distinct bounded");
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
