import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ batchFindFirst: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { courseSupportBatch: { findFirst: database.batchFindFirst } },
}));

import { appendAutomationPlaybookEvent } from "./course-monitoring-playbook";
import {
  getOwnedCourseSupportResearchContext,
  validateOwnedCourseSupportResearchContext,
} from "./course-support-research-context";
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
