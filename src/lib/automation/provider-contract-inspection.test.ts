import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  batchFindFirst: vi.fn(),
  courseCreate: vi.fn(),
  courseUpdate: vi.fn(),
  courseUpdateMany: vi.fn(),
  courseUpsert: vi.fn(),
  batchUpdate: vi.fn(),
  batchUpdateMany: vi.fn(),
  batchIncidentUpdate: vi.fn(),
  batchIncidentUpdateMany: vi.fn(),
  incidentCreate: vi.fn(),
  incidentUpdate: vi.fn(),
  incidentUpdateMany: vi.fn(),
  discoveryCreate: vi.fn(),
  discoveryUpdate: vi.fn(),
  discoveryUpdateMany: vi.fn(),
  probeCreate: vi.fn(),
  probeUpdate: vi.fn(),
  eventCreate: vi.fn(),
  monitoringStatusCreate: vi.fn(),
  monitoringStatusUpdate: vi.fn(),
  monitoringStatusUpdateMany: vi.fn(),
  automationRunCreate: vi.fn(),
  automationRunUpdate: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    course: {
      create: prismaMocks.courseCreate,
      update: prismaMocks.courseUpdate,
      updateMany: prismaMocks.courseUpdateMany,
      upsert: prismaMocks.courseUpsert,
    },
    courseSupportBatch: {
      findFirst: prismaMocks.batchFindFirst,
      update: prismaMocks.batchUpdate,
      updateMany: prismaMocks.batchUpdateMany,
    },
    courseSupportIncident: {
      create: prismaMocks.incidentCreate,
      update: prismaMocks.incidentUpdate,
      updateMany: prismaMocks.incidentUpdateMany,
    },
    courseSupportBatchIncident: {
      update: prismaMocks.batchIncidentUpdate,
      updateMany: prismaMocks.batchIncidentUpdateMany,
    },
    courseAutomationDiscovery: {
      create: prismaMocks.discoveryCreate,
      update: prismaMocks.discoveryUpdate,
      updateMany: prismaMocks.discoveryUpdateMany,
    },
    courseProbe: {
      create: prismaMocks.probeCreate,
      update: prismaMocks.probeUpdate,
    },
    courseMonitoringEvent: { create: prismaMocks.eventCreate },
    courseMonitoringStatus: {
      create: prismaMocks.monitoringStatusCreate,
      update: prismaMocks.monitoringStatusUpdate,
      updateMany: prismaMocks.monitoringStatusUpdateMany,
    },
    automationRun: {
      create: prismaMocks.automationRunCreate,
      update: prismaMocks.automationRunUpdate,
    },
    $queryRaw: prismaMocks.queryRaw,
    $transaction: prismaMocks.transaction,
  },
}));

import {
  createProviderContractPinnedFetch,
  extractContractFingerprintsFromScript,
  inspectOneTrustedScript as inspectOneTrustedScriptImplementation,
  inspectOwnedCourseSupportProviderContract,
  loadOwnedProviderContractContext,
  loadOwnedProviderContractContextResult,
  PROVIDER_CONTRACT_MAX_DOCUMENT_BYTES,
  PROVIDER_CONTRACT_REQUIRED_LEASE_HEADROOM_MS,
  sanitizeContractPath,
} from "./provider-contract-inspection";
import { selectCurrentBrowserProviderContractEvidence } from "./course-support-provider-contract-evidence";
import { appendAutomationPlaybookEvent } from "./course-monitoring-playbook";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import { bindBrowserDiscoveryToProviderSnapshot } from "./db-service";

const now = new Date("2026-08-22T14:00:00.000Z");
const ownerInput = {
  batchId: "batch-private-canary",
  leaseToken: "lease-private-canary",
  ownerThreadId: "thread-private-canary",
  ordinal: 1,
};

function ownedContext(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "ready" as const,
    authorityDigest: "a".repeat(64),
    evidenceDigest: "e".repeat(64),
    providerFamilyKey: "CUSTOM",
    officialUrl: "https://private-course-canary.example/landing",
    bookingUrl: null,
    browserContracts: [],
    restrictionDetected: false,
    ...overrides,
  };
}

function response(
  body: string,
  contentType: string,
  status = 200,
  headers = {},
) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, ...headers },
  });
}

function inspectOneTrustedScript(
  input: Omit<
    Parameters<typeof inspectOneTrustedScriptImplementation>[0],
    "providerFamilyKey"
  >,
) {
  return inspectOneTrustedScriptImplementation({
    ...input,
    providerFamilyKey: "CUSTOM",
  });
}

function ownedDatabaseBatch(input?: {
  remediationStage?: string;
  browserCycle?: number;
  queryKeys?: string[];
  providerFamilyKey?: string;
  detectedPlatform?: string;
  website?: string;
  detectedBookingUrl?: string | null;
}) {
  const providerFamilyKey = input?.providerFamilyKey ?? "CUSTOM";
  const detectedPlatform = input?.detectedPlatform ?? "CUSTOM";
  const failureFingerprint = "v1:UNSUPPORTED_FAMILY:METADATA";
  const attemptLedger = appendAutomationPlaybookEvent(null, {
    cycle: 1,
    stage: "OFFICIAL_IDENTITY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_IDENTITY",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "TEST:OFFICIAL_IDENTITY:COMPLETE",
    runtimeVersion: "test-runtime",
    observedAt: now,
  });
  const remediation = {
    workMode: "IMPLEMENT_REUSABLE_SUPPORT",
    strategyAction: "REPAIR_PROVIDER_ADAPTER",
    playbookStage: input?.remediationStage ?? "TYPED_ADAPTER",
    allowUnchangedRuntime: false,
    requiresImplementationPath: true,
    reason: "IMPLEMENTATION_REQUIRED",
    retryBudget: null,
  };
  const course = {
    id: "course-private-canary",
    name: "Private Course Canary",
    website: input?.website ?? "https://private-course-canary.example/",
    detectedBookingUrl: input?.detectedBookingUrl ?? null,
    timeZone: "America/New_York",
    isPublic: true,
    detectedPlatform,
    providerFamilyKey,
    bookingMethod: "UNKNOWN",
    bookingWindowDaysAhead: null,
    bookingReleaseTimeLocal: null,
    bookingWindowSource: null,
    bookingWindowConfidence: null,
    bookingWindowEvidenceUrl: null,
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "UNSUPPORTED_PLATFORM",
    monitoringMode: "AUTOMATIC",
    bookingAccessMode: "UNKNOWN",
    intelligenceVerifiedAt: null,
    intelligenceReviewAt: null,
    intelligenceConfidence: null,
    bookingMetadata: null,
    layoutHoleCounts: [] as number[],
    layoutHolesVerifiedAt: null,
    updatedAt: now,
    monitoringStatus: {
      state: "AUTO_INVESTIGATING",
      failureFingerprint,
      updatedAt: now,
    },
    monitoringEvents: [] as Array<{
      eventType: string;
      outcome: string | null;
      failureFingerprint: string | null;
      occurredAt: Date;
    }>,
    automationDiscoveries: [
      {
        evidence: {
          browserInvestigation: {
            incidentCycle: input?.browserCycle ?? 1,
            observedAt: "2026-08-22T14:01:00.000Z",
            providerSnapshotFingerprint: "",
            networkContracts: [
              {
                origin: "https://private-course-canary.example",
                method: "GET",
                pathPattern: "/api/availability",
                queryKeys: input?.queryKeys ?? ["date"],
                resourceType: "fetch",
                status: 200,
              },
            ],
          },
        },
        automationReason: "UNSUPPORTED_PLATFORM",
        detectedPlatform,
        bookingUrl: null,
        apiMetadata: null,
        confidence: 0.8,
        createdAt: new Date("2026-08-22T14:01:00.000Z"),
      },
    ],
  };
  const providerSnapshotFingerprint =
    buildCourseSupportProviderSnapshotFingerprint(course);
  course.automationDiscoveries[0].evidence.browserInvestigation.providerSnapshotFingerprint =
    providerSnapshotFingerprint;
  return {
    summary: {
      remediation: {
        ...remediation,
        attempts: [
          {
            courseRef: createHash("sha256")
              .update(course.id)
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint,
            failureFingerprint,
            runtimeVersion: "a".repeat(40),
            activeRealSearchCount: 1,
            playbookEventCountAtClaim: 1,
            reason: "IMPLEMENTATION_REQUIRED",
            retryBudget: null,
            approach: {
              workMode: remediation.workMode,
              strategyAction: remediation.strategyAction,
              playbookStage: remediation.playbookStage,
            },
            actionPlan: {
              schemaVersion: 1,
              primaryAction: "IMPLEMENT_REUSABLE_SUPPORT",
              allowedActions: ["IMPLEMENT_REUSABLE_SUPPORT", "INSPECT_PROVIDER_CONTRACT"],
              route: {
                workMode: remediation.workMode,
                strategyAction: remediation.strategyAction,
                playbookStage: remediation.playbookStage
              }
            }
          },
        ],
      },
    },
    createdAt: now,
    status: "IMPLEMENTING",
    baseSha: "a".repeat(40),
    releaseSha: null,
    deployedAt: null,
    revision: 7,
    leaseExpiresAt: new Date("2026-08-22T15:00:00.000Z"),
    heartbeatAt: now,
    providerFamilyKey,
    failureFingerprint,
    incidents: [
      {
        id: "batch-entry-1",
        createdAt: now,
        updatedAt: now,
        cycle: 1,
        result: "PENDING",
        course,
        incident: {
          id: "incident-1",
          cycle: 1,
          status: "AUTO_INVESTIGATING",
          kind: "NEEDS_ADAPTER",
          providerFamilyKey,
          failureFingerprint,
          activeBatchId: ownerInput.batchId,
          activeRealSearchCount: 1,
          attemptLedger,
          firstSeenAt: new Date("2026-08-22T13:00:00.000Z"),
          resolution: null,
          updatedAt: now,
        },
      },
    ],
  };
}

function advanceOwnedBatchToOfficialHttpRetry(
  batch: ReturnType<typeof ownedDatabaseBatch>,
) {
  batch.incidents.forEach((entry, index) => {
    let ledger = appendAutomationPlaybookEvent(entry.incident.attemptLedger, {
      cycle: 1,
      stage: "TYPED_ADAPTER",
      transition: "NOT_APPLICABLE",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "TOOLING",
      failureFingerprint: "TEST:TYPED_ADAPTER:SKIPPED",
      runtimeVersion: "test-runtime",
      skipReason: "NO_RUNNABLE_ADAPTER",
      observedAt: new Date(now.getTime() + 1),
    });
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "STARTED",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "TEST:OFFICIAL_HTTP:NETWORK",
      runtimeVersion: "test-runtime",
      observedAt: new Date(now.getTime() + 2),
    });
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "FAILED_RETRYABLE",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureClass: "NETWORK",
      failureFingerprint: "TEST:OFFICIAL_HTTP:NETWORK",
      runtimeVersion: "test-runtime",
      observedAt: new Date(now.getTime() + 3),
    });
    entry.incident.attemptLedger = ledger;
    batch.summary.remediation.attempts[index].playbookEventCountAtClaim =
      ledger.events.length;
  });
  return batch;
}

function ownedBrowserRetryContractEvidenceBatch() {
  const bookingUrl =
    "https://booking.provider-contract-canary.example/tee-times";
  const providerFamilyKey = "booking.provider-contract-canary.example";
  const batch = ownedDatabaseBatch({
    remediationStage: "BROWSER_ADAPTER_RETRY",
    providerFamilyKey,
    detectedPlatform: "UNKNOWN",
    website: "https://official-provider-contract-canary.example/",
    detectedBookingUrl: bookingUrl,
  });
  const entry = batch.incidents[0];
  const course = entry.course;
  const discovery = course.automationDiscoveries[0];
  discovery.detectedPlatform = "UNKNOWN";
  discovery.bookingUrl = bookingUrl;
  discovery.evidence.browserInvestigation.networkContracts[0].origin =
    "https://booking.provider-contract-canary.example";

  let ledger: unknown = entry.incident.attemptLedger;
  for (const event of [
    {
      stage: "TYPED_ADAPTER" as const,
      transition: "NOT_APPLICABLE" as const,
      readPath: "TYPED_PROVIDER_ADAPTER" as const,
      evidenceKind: "TOOLING" as const,
      failureFingerprint: "TEST:TYPED_ADAPTER:SKIPPED",
      skipReason: "NO_RUNNABLE_ADAPTER" as const,
    },
    {
      stage: "OFFICIAL_HTTP_DISCOVERY" as const,
      transition: "COMPLETED" as const,
      readPath: "OFFICIAL_HTTP" as const,
      evidenceKind: "OFFICIAL_SOURCE" as const,
      failureFingerprint: "TEST:OFFICIAL_HTTP:COMPLETE",
    },
    {
      stage: "HTTP_ADAPTER_RETRY" as const,
      transition: "NOT_APPLICABLE" as const,
      readPath: "TYPED_PROVIDER_ADAPTER" as const,
      evidenceKind: "TOOLING" as const,
      failureFingerprint: "TEST:HTTP_ADAPTER_RETRY:SKIPPED",
      skipReason: "NO_RUNNABLE_ADAPTER" as const,
    },
    {
      stage: "RENDERED_BROWSER_DISCOVERY" as const,
      transition: "COMPLETED" as const,
      readPath: "RENDERED_BROWSER" as const,
      evidenceKind: "RENDERED_PAGE" as const,
      failureFingerprint: "TEST:RENDERED_BROWSER:COMPLETE",
    },
  ]) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      runtimeVersion: "test-runtime",
      observedAt: now,
      ...event,
    });
  }
  entry.incident.attemptLedger = ledger;

  const providerSnapshotFingerprint =
    buildCourseSupportProviderSnapshotFingerprint(course);
  discovery.evidence.browserInvestigation.providerSnapshotFingerprint =
    providerSnapshotFingerprint;
  const attempt = batch.summary.remediation.attempts[0];
  attempt.providerSnapshotFingerprint = providerSnapshotFingerprint;
  attempt.playbookEventCountAtClaim = (
    ledger as { events: unknown[] }
  ).events.length;
  const marker = selectCurrentBrowserProviderContractEvidence({
    discoveries: course.automationDiscoveries,
    incidentCycle: entry.cycle,
    incidentFirstSeenAt: entry.incident.firstSeenAt,
    providerFamilyKey,
    providerSnapshotFingerprint,
    officialUrl: bookingUrl,
    bookingUrl,
  })?.marker;
  if (!marker) {
    throw new Error("The provider-contract canary marker was unavailable.");
  }
  Object.assign(attempt, { providerContractEvidence: marker });
  return batch;
}

function addSecondOwnedBatchMember(
  batch: ReturnType<typeof ownedDatabaseBatch>,
  input: { name?: string; ordinal?: number } = {},
) {
  const ordinal = input.ordinal ?? 2;
  const second = ownedDatabaseBatch({
    remediationStage: batch.summary.remediation.playbookStage,
  });
  const entry = second.incidents[0];
  entry.id = `batch-entry-${ordinal}`;
  entry.course.id = `course-member-${ordinal}`;
  entry.course.name = input.name ?? `Course ${ordinal}`;
  entry.course.website = `https://course-${ordinal}.example/`;
  entry.course.automationDiscoveries = [];
  entry.incident.id = `incident-${ordinal}`;
  const providerSnapshotFingerprint =
    buildCourseSupportProviderSnapshotFingerprint(entry.course);
  const attempt = {
    ...second.summary.remediation.attempts[0],
    courseRef: createHash("sha256")
      .update(entry.course.id)
      .digest("hex")
      .slice(0, 24),
    providerSnapshotFingerprint,
  };
  batch.incidents.push(entry);
  batch.summary.remediation.attempts.push(attempt);
  return { entry, attempt };
}

async function expectControlWithoutProviderIo(
  batch: ReturnType<typeof ownedDatabaseBatch>,
  outcome: "route_ineligible" | "authority_drift" = "authority_drift",
  label?: string,
) {
  const fetch = vi.fn();
  const runWithProviderLease = vi.fn();
  prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);
  const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
    fetch: fetch as typeof globalThis.fetch,
    runWithProviderLease,
  });
  expect(result, label).toMatchObject({
    outcome,
    contracts: [],
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(runWithProviderLease).not.toHaveBeenCalled();
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.queryRaw.mockResolvedValue([{ now, leaseExpiresAt: new Date("2026-08-22T15:00:00.000Z") }]);
});

describe("owner-bound provider-contract inspection", () => {
  it("returns current-cycle browser contracts without provider lease or network I/O", async () => {
    const fetch = vi.fn();
    const runWithProviderLease = vi.fn();
    const loadContext = vi.fn().mockResolvedValue(
      ownedContext({
        browserContracts: [
          {
            origin: "https://private-course-canary.example",
            method: "GET",
            pathPattern:
              "/api/courses/Very-Private-Course-Canary/tee-times/123456",
            queryKeys: ["date", "mysteryKey", "courseName"],
            resourceType: "xhr",
            status: 200,
          },
        ],
      }),
    );

    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext,
      fetch,
      runWithProviderLease,
    });

    expect(result).toMatchObject({
      outcome: "ready",
      evidenceSource: "PERSISTED_BROWSER",
      reasonCodes: ["EXISTING_BROWSER_CONTRACTS"],
      aggregate: {
        contractCount: 1,
        rawBodyRetained: false,
        domainEvidenceMutated: false,
        playbookStageSatisfied: false,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(runWithProviderLease).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result);
    for (const canary of [
      "private-course-canary",
      "Very-Private-Course-Canary",
      "123456",
      "mysteryKey",
      "courseName",
      "https://",
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).toContain("/api/courses/{segment}/tee-times/{segment}");
  });

  it("falls through document/static-only browser evidence to the bounded fallback", async () => {
    const loadContext = vi.fn().mockResolvedValue(
      ownedContext({
        browserContracts: [
          {
            origin: "https://private-course-canary.example",
            method: "GET",
            pathPattern: "/",
            queryKeys: [],
            resourceType: "document",
            status: 200,
          },
          {
            origin: "https://private-course-canary.example",
            method: "GET",
            pathPattern: "/assets/{segment}",
            queryKeys: [],
            resourceType: "script",
            status: 200,
          },
        ],
      }),
    );
    const fetch = vi
      .fn()
      .mockResolvedValue(response("<html></html>", "text/html"));
    const runWithProviderLease = vi.fn(async (_family, worker) => ({
      acquired: true as const,
      value: await worker(),
    }));

    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext,
      fetch: fetch as typeof globalThis.fetch,
      runWithProviderLease,
    });

    expect(result).toMatchObject({
      evidenceSource: "NONE",
      reasonCodes: expect.arrayContaining([
        "NO_CURRENT_BROWSER_CONTRACTS",
        "NO_TRUSTED_SCRIPT",
      ]),
      contracts: [],
    });
    expect(runWithProviderLease).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns only actionable XHR/FETCH contracts from mixed persisted traffic", async () => {
    const runWithProviderLease = vi.fn();
    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext: vi.fn().mockResolvedValue(
        ownedContext({
          browserContracts: [
            {
              origin: "https://private-course-canary.example",
              method: "GET",
              pathPattern: "/",
              queryKeys: [],
              resourceType: "document",
              status: 200,
            },
            {
              origin: "https://private-course-canary.example",
              method: "GET",
              pathPattern: "/api/availability",
              queryKeys: ["date"],
              resourceType: "xhr",
              status: 200,
            },
          ],
        }),
      ),
      runWithProviderLease,
    });

    expect(result).toMatchObject({
      evidenceSource: "PERSISTED_BROWSER",
      aggregate: { contractCount: 1 },
      contracts: [expect.objectContaining({ resourceType: "XHR" })],
    });
    expect(runWithProviderLease).not.toHaveBeenCalled();
  });

  it("uses same-authority evidence persisted before provider I/O", async () => {
    const initial = ownedContext();
    const newlyPersisted = ownedContext({
      evidenceDigest: "f".repeat(64),
      browserContracts: [
        {
          origin: "https://private-course-canary.example",
          method: "GET",
          pathPattern: "/api/availability",
          queryKeys: ["date"],
          resourceType: "xhr",
          status: 200,
        },
      ],
    });
    const fetch = vi.fn();
    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(newlyPersisted),
      fetch: fetch as typeof globalThis.fetch,
      runWithProviderLease: vi.fn(async (_family, worker) => ({
        acquired: true as const,
        value: await worker(),
      })),
    });

    expect(result).toMatchObject({
      evidenceSource: "PERSISTED_BROWSER",
      reasonCodes: ["EXISTING_BROWSER_CONTRACTS"],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "actionable contract",
      {
        browserContracts: [
          {
            origin: "https://private-course-canary.example",
            method: "GET",
            pathPattern: "/api/availability",
            queryKeys: ["date"],
            resourceType: "xhr",
            status: 200,
          },
        ],
      },
    ],
    ["restriction", { restrictionDetected: true }],
  ])(
    "rejects retargeted pre-I/O %s before consuming evidence",
    async (_label, evidence) => {
      const initial = ownedContext();
      const retargeted = ownedContext({
        ...evidence,
        authorityDigest: "b".repeat(64),
        evidenceDigest: "f".repeat(64),
      });
      const fetch = vi.fn();
      const result = await inspectOwnedCourseSupportProviderContract(
        ownerInput,
        {
          loadContext: vi
            .fn()
            .mockResolvedValueOnce(initial)
            .mockResolvedValueOnce(retargeted),
          fetch: fetch as typeof globalThis.fetch,
          runWithProviderLease: vi.fn(async (_family, worker) => ({
            acquired: true as const,
            value: await worker(),
          })),
        },
      );

      expect(result).toMatchObject({
      outcome: "authority_drift",
      reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED",
      contracts: [],
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("never serializes a raw provider target from an authorization or transport error", async () => {
    const privateCanary =
      "https://private-course-canary.example/assets/app.js?token=secret";
    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext: vi.fn().mockRejectedValue(new Error(privateCanary)),
    });
    expect(result).toMatchObject({
      evidenceSource: "NONE",
      reasonCodes: ["AUTHORIZATION_UNAVAILABLE"],
      contracts: [],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-course-canary|https:\/\/|token|secret/iu,
    );
  });

  it("revalidates the exact scope after landing discovery and before script I/O", async () => {
    const initial = ownedContext();
    const changed = ownedContext({ authorityDigest: "b".repeat(64) });
    const loadContext = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed)
      .mockResolvedValue(changed);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('<script src="/assets/app.js"></script>', "text/html"),
      );
    const runWithProviderLease = vi.fn(async (_family, worker) => ({
      acquired: true as const,
      value: await worker(),
    }));

    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext,
      fetch: fetch as typeof globalThis.fetch,
      runWithProviderLease,
    });

    expect(result).toMatchObject({
      outcome: "authority_drift",
      reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED",
      contracts: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an authorization-read failure from ownership drift without I/O", async () => {
    const initial = ownedContext();
    const loadContext = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("private authorization canary"))
      .mockResolvedValue(initial);
    const fetch = vi.fn();
    const runWithProviderLease = vi.fn(async (_family, worker) => ({
      acquired: true as const,
      value: await worker(),
    }));

    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext,
      fetch: fetch as typeof globalThis.fetch,
      runWithProviderLease,
    });

    expect(result).toMatchObject({
      evidenceSource: "NONE",
      reasonCodes: expect.arrayContaining(["AUTHORIZATION_UNAVAILABLE"]),
      contracts: [],
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(
      "private authorization canary",
    );
  });

  it("stops a landing redirect when the owned ordinal snapshot drifts", async () => {
    const initial = ownedContext();
    const changed = ownedContext({ authorityDigest: "c".repeat(64) });
    const loadContext = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed)
      .mockResolvedValue(changed);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response("", "text/html", 302, { location: "/redirected-landing" }),
      );
    const runWithProviderLease = vi.fn(async (_family, worker) => ({
      acquired: true as const,
      value: await worker(),
    }));

    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext,
      fetch: fetch as typeof globalThis.fetch,
      runWithProviderLease,
    });

    expect(result).toMatchObject({
      outcome: "authority_drift",
      reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED",
      contracts: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses one same-origin non-executed script and emits only bounded templates", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          '<script src="/assets/app.js?build=private-canary"></script>',
          "text/html",
        ),
      )
      .mockResolvedValueOnce(
        response(
          [
            "fetch('/api/private-course-name/tee-times?date=SECRET_DATE&mysteryKey=SECRET_VALUE')",
            "fetch('/api/update', {method: 'POST', body: secretPayload})",
            "'password checkout create account'",
          ].join(";"),
          "application/javascript",
        ),
      );
    const runWithProviderLease = vi.fn(async (_family, worker) => ({
      acquired: true as const,
      value: await worker(),
    }));
    const loadContext = vi.fn().mockResolvedValue(ownedContext());

    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext,
      fetch: fetch as typeof globalThis.fetch,
      runWithProviderLease,
    });

    expect(result).toMatchObject({
      evidenceSource: "PINNED_SCRIPT",
      reasonCodes: ["NO_CURRENT_BROWSER_CONTRACTS", "PINNED_SCRIPT_CONTRACTS"],
      aggregate: { contractCount: 1 },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(loadContext).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredLeaseHeadroomMs: PROVIDER_CONTRACT_REQUIRED_LEASE_HEADROOM_MS,
      }),
    );
    for (const call of fetch.mock.calls) {
      expect(call[1]).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "manual",
      });
      expect(JSON.stringify(call[1])).not.toMatch(
        /authorization|cookie|body/iu,
      );
    }
    const serialized = JSON.stringify(result);
    for (const canary of [
      "private-course-name",
      "private-course-canary",
      "SECRET_DATE",
      "SECRET_VALUE",
      "secretPayload",
      "https://",
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).toContain("/api/{segment}/tee-times");
    expect(serialized).toContain("DATE");
    expect(serialized).toContain("OTHER");
  });

  it("spends the one asset budget on the ranked app bundle, not runtime", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          [
            '<script src="/assets/runtime.js"></script>',
            '<script src="/assets/vendor.js"></script>',
            '<script src="/assets/booking-app.js"></script>',
          ].join(""),
          "text/html",
        ),
      )
      .mockResolvedValueOnce(
        response("fetch('/api/availability?date=x')", "text/javascript"),
      );
    const result = await inspectOneTrustedScript({
      landingUrl: "https://public.example/",
      bookingUrl: null,
      fetch: fetch as typeof globalThis.fetch,
      authorizeProviderRequest: async () => true,
    });
    expect(result.contracts).toHaveLength(1);
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      "https://public.example/assets/booking-app.js",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    '<!-- <script src="/booking-app.js"></script> --><script src="/runtime.js"></script>',
    '<script data-src="/booking-app.js"></script><script src="/runtime.js"></script>',
    '<script>const fake = \'<script src="/booking-app.js">\';</script><script src="/runtime.js"></script>',
    '<template><script src="/booking-app.js"></script></template><script src="/runtime.js"></script>',
    '<svg><script src="/booking-app.js"></script></svg><script src="/runtime.js"></script>',
  ])("selects only real executable script[src] DOM elements", async (html) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(html, "text/html"))
      .mockResolvedValueOnce(
        response("fetch('/api/availability')", "text/javascript"),
      );

    const result = await inspectOneTrustedScript({
      landingUrl: "https://public.example/",
      bookingUrl: null,
      fetch: fetch as typeof globalThis.fetch,
      authorizeProviderRequest: async () => true,
    });
    expect(result.contracts).toHaveLength(1);
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      "https://public.example/runtime.js",
    );
  });

  it("uses the effective safe base URL for the real script asset", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          '<base href="/assets/"><script src="app.js"></script>',
          "text/html",
        ),
      )
      .mockResolvedValueOnce(
        response("fetch('/api/availability')", "text/javascript"),
      );

    const result = await inspectOneTrustedScript({
      landingUrl: "https://public.example/landing",
      bookingUrl: null,
      fetch: fetch as typeof globalThis.fetch,
      authorizeProviderRequest: async () => true,
    });
    expect(result.contracts).toHaveLength(1);
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      "https://public.example/assets/app.js",
    );
  });

  it("fails closed for challenge landing state and checkout read calls", async () => {
    const challengeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          '<title>Waiting room</title><div class="g-recaptcha"></div>',
          "text/html",
        ),
      );
    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: challengeFetch as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      }),
    ).resolves.toEqual({
      reasonCodes: ["RESTRICTED_SURFACE_DETECTED"],
      contracts: [],
    });

    const checkoutFetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('<script src="/app.js"></script>', "text/html"),
      )
      .mockResolvedValueOnce(
        response("fetch('/checkout?date=value')", "text/javascript"),
      );
    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: checkoutFetch as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      }),
    ).resolves.toEqual({
      reasonCodes: ["RESTRICTED_SURFACE_DETECTED"],
      contracts: [],
    });
  });

  it.each([
    [
      "unquoted password",
      '<input type=password><script src="/app.js"></script>',
    ],
    [
      "hex-entity password",
      '<input type=pass&#x77;ord><script src="/app.js"></script>',
    ],
    [
      "decimal-entity password",
      '<input type=pass&#119;ord><script src="/app.js"></script>',
    ],
    [
      "entity-encoded sign-in title",
      '<title>Sign&#x20;in</title><script src="/app.js"></script>',
    ],
    [
      "entity-encoded checkout title",
      '<title>Public golf information &#x43;heckout</title><script src="/app.js"></script>',
    ],
    [
      "long restricted title",
      `<title>${"ordinary public golf ".repeat(8)}Sign in</title><script src="/app.js"></script>`,
    ],
    [
      "entity-encoded recaptcha class",
      '<div class=g&#x2d;recaptcha></div><script src="/app.js"></script>',
    ],
    [
      "entity-encoded waiting-room text",
      '<div>Waiting&#32;room</div><script src="/app.js"></script>',
    ],
    [
      "entity-encoded queue class",
      '<div id=queue&#x2d;it></div><script src="/app.js"></script>',
    ],
    [
      "entity-encoded waiting-room title",
      '<title>Waiting&#32;room</title><script src="/app.js"></script>',
    ],
    [
      "entity-encoded queue title",
      '<title>Queue&#x2d;it</title><script src="/app.js"></script>',
    ],
    [
      "unquoted login form",
      '<form action=/login><script src="/app.js"></script>',
    ],
    ["sign-in form", '<form action="/sign-in"><script src="/app.js"></script>'],
    [
      "oauth form",
      '<form action=/oauth/callback><script src="/app.js"></script>',
    ],
    ["sso form", '<form action=/sso><script src="/app.js"></script>'],
    [
      "challenge form",
      '<form action=/challenge><script src="/app.js"></script>',
    ],
    [
      "waiting-room form",
      '<form action=/waiting-room><script src="/app.js"></script>',
    ],
    ["account form", '<form action=/account><script src="/app.js"></script>'],
    ["checkout form", '<form action=/checkout><script src="/app.js"></script>'],
    ["payment form", '<form action=/payment><script src="/app.js"></script>'],
    [
      "encoded sign-in form",
      '<form action=/%73ign-in><script src="/app.js"></script>',
    ],
    [
      "HTML-entity sign-in form",
      '<form action=/sign&#x2d;in><script src="/app.js"></script>',
    ],
    [
      "named-entity login form",
      '<form action=&sol;login><script src="/app.js"></script>',
    ],
    [
      "tab-normalized sign-in form",
      '<form action=/sign&Tab;-in><script src="/app.js"></script>',
    ],
    [
      "newline-normalized script form",
      '<form action=java&NewLine;script:alert(1)><script src="/app.js"></script>',
    ],
    [
      "quoted decoy with real login action",
      '<form title=" action=/booking" action=/login><script src="/app.js"></script>',
    ],
    [
      "over-limit password input",
      `<input data-x="${"a".repeat(2_050)}" type=password><script src="/app.js"></script>`,
    ],
    [
      "over-limit login form",
      `<form data-x="${"a".repeat(4_050)}" action=/login><script src="/app.js"></script>`,
    ],
    [
      "unterminated password input",
      `<input data-x="${"a".repeat(2_050)} type=password`,
    ],
    [
      "base-relative sign-in form",
      "<base href=/signin/><form action=continue><script src=/app.js></script>",
    ],
    [
      "restricted submitter form action",
      "<form action=/booking><button formaction=/checkout>Continue</button></form><script src=/app.js></script>",
    ],
    [
      "restricted meta refresh",
      '<meta http-equiv=refresh content="0; url=/oauth"><script src=/app.js></script>',
    ],
    [
      "security challenge title",
      "<title>Security challenge</title><script src=/app.js></script>",
    ],
    [
      "captcha required title",
      "<title>Captcha required</title><script src=/app.js></script>",
    ],
    [
      "create account message",
      "<main>Create account</main><script src=/app.js></script>",
    ],
    ["register message", "<main>Register</main><script src=/app.js></script>"],
    [
      "authentication required message",
      "<main>Auth required</main><script src=/app.js></script>",
    ],
    [
      "identity verification message",
      "<main>Verify identity</main><script src=/app.js></script>",
    ],
    [
      "turnstile element",
      "<div class=cf-turnstile></div><script src=/app.js></script>",
    ],
    [
      "Arkose asset",
      '<script src="https://client-api.arkoselabs.com/fc/api/"></script><script src=/app.js></script>',
    ],
    [
      "Funcaptcha asset",
      '<script src="https://example.com/funcaptcha.js"></script><script src=/app.js></script>',
    ],
    [
      "challenge frame",
      "<iframe src=/challenge></iframe><script src=/app.js></script>",
    ],
  ])("fails closed for %s landing HTML", async (_label, html) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(html, "text/html"))
      .mockResolvedValueOnce(
        response("fetch('/api/availability')", "text/javascript"),
      );

    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: fetch as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      }),
    ).resolves.toEqual({
      reasonCodes: ["RESTRICTED_SURFACE_DETECTED"],
      contracts: [],
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    '<input data-type=password><script src="/app.js"></script>',
    '<input data-type=pass&#x77;ord><script src="/app.js"></script>',
    '<form data-action=/login action=/booking><script src="/app.js"></script>',
    '<form formaction=/login action=/booking><script src="/app.js"></script>',
    '<form action=/booking action=/login><script src="/app.js"></script>',
    '<script>const decoy = "<input type=password>"</script><script src="/app.js"></script>',
    '<!-- <form action=/login> --><script src="/app.js"></script>',
  ])(
    "does not treat inert data attributes as restricted HTML",
    async (html) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(response(html, "text/html"))
        .mockResolvedValueOnce(
          response("fetch('/api/availability')", "text/javascript"),
        );
      const result = await inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: fetch as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      });
      expect(result.contracts).toHaveLength(1);
    },
  );

  it.each([
    "fetch('/signin')",
    "fetch('/sign-in')",
    "fetch('/oauth')",
    "fetch('/sso')",
    "fetch('/challenge')",
    "fetch('/waiting-room')",
    "fetch('/api/availability?token=private-canary')",
    "fetch(`/api/availability?${authKey}=private-canary`)",
    'fetch("/log\\x69n")',
    'fetch("/sign\\u002din")',
    'fetch("\\u002flogin")',
    "fetch('/signin', { headers: authHeaders })",
    "axios.get('/api/availability?token=private-canary', requestConfig)",
  ])(
    "makes mixed static evidence restricted for %s",
    async (restrictedCall) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          response('<script src="/app.js"></script>', "text/html"),
        )
        .mockResolvedValueOnce(
          response(
            `${restrictedCall}; fetch('/api/availability?date=x')`,
            "text/javascript",
          ),
        );

      const result = await inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: fetch as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      });
      expect(result).toEqual({
        reasonCodes: ["RESTRICTED_SURFACE_DETECTED"],
        contracts: [],
      });
      expect(JSON.stringify(result)).not.toMatch(/private-canary|authKey/iu);
    },
  );

  it("invalidates the whole static result when any fetch URL exceeds the proof bound", async () => {
    const oversized = `/login?pad=${"x".repeat(400)}`;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('<script src="/app.js"></script>', "text/html"),
      )
      .mockResolvedValueOnce(
        response(
          `fetch(${JSON.stringify(oversized)}); fetch('/api/availability')`,
          "text/javascript",
        ),
      );

    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: fetch as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      }),
    ).resolves.toEqual({
      reasonCodes: ["NO_SAFE_CONTRACT_SIGNAL"],
      contracts: [],
    });
  });

  it("invalidates the whole static result when the proven read-call cap is exceeded", async () => {
    const source = [
      ...Array.from(
        { length: 100 },
        (_value, index) => `fetch('/api/availability?page=${index}')`,
      ),
      "fetch('/login')",
    ].join(";");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('<script src="/app.js"></script>', "text/html"),
      )
      .mockResolvedValueOnce(response(source, "text/javascript"));

    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: fetch as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      }),
    ).resolves.toEqual({
      reasonCodes: ["NO_SAFE_CONTRACT_SIGNAL"],
      contracts: [],
    });
  });

  it("rejects unsafe redirect, content type, oversize, and provider lease contention", async () => {
    const redirected = vi.fn().mockResolvedValueOnce(
      response("", "text/html", 302, {
        location: "https://untrusted-private-canary.example/app",
      }),
    );
    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: redirected as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      }),
    ).resolves.toEqual({ reasonCodes: ["UNSAFE_REDIRECT"], contracts: [] });

    const badType = vi
      .fn()
      .mockResolvedValueOnce(response("{}", "application/json"));
    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: badType as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      }),
    ).resolves.toEqual({ reasonCodes: ["BAD_CONTENT_TYPE"], contracts: [] });

    const oversized = vi.fn().mockResolvedValueOnce(
      response("x", "text/html", 200, {
        "content-length": String(PROVIDER_CONTRACT_MAX_DOCUMENT_BYTES + 1),
      }),
    );
    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: oversized as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      }),
    ).resolves.toEqual({ reasonCodes: ["OVERSIZE_RESPONSE"], contracts: [] });

    const fetch = vi.fn();
    const result = await inspectOwnedCourseSupportProviderContract(ownerInput, {
      loadContext: vi.fn().mockResolvedValue(ownedContext()),
      fetch,
      runWithProviderLease: vi.fn().mockResolvedValue({ acquired: false }),
    });
    expect(result).toMatchObject({
      reasonCodes: ["NO_CURRENT_BROWSER_CONTRACTS", "PROVIDER_LEASE_BUSY"],
      contracts: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])(
    "rejects landing HTTP status %i without script inspection",
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(response("rejected", "text/html", status));
      await expect(
        inspectOneTrustedScript({
          landingUrl: "https://public.example/",
          bookingUrl: null,
          fetch: fetch as typeof globalThis.fetch,
          authorizeProviderRequest: async () => true,
        }),
      ).resolves.toEqual({
        reasonCodes: ["HTTP_STATUS_REJECTED"],
        contracts: [],
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("enforces one total deadline across landing and script work", async () => {
    const monotonicNow = vi.fn().mockReturnValueOnce(0).mockReturnValue(10_001);
    const fetch = vi.fn();
    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: fetch as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
        monotonicNow,
      }),
    ).resolves.toEqual({
      reasonCodes: ["REQUEST_BUDGET_EXCEEDED"],
      contracts: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes a transport timeout without returning its target", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(
        new DOMException(
          "Timed out at https://private-timeout-canary.example/app.js",
          "TimeoutError",
        ),
      );
    const result = await inspectOneTrustedScript({
      landingUrl: "https://public.example/",
      bookingUrl: null,
      fetch: fetch as typeof globalThis.fetch,
      authorizeProviderRequest: async () => true,
    });
    expect(result).toEqual({
      reasonCodes: ["REQUEST_BUDGET_EXCEEDED"],
      contracts: [],
    });
    expect(JSON.stringify(result)).not.toContain("private-timeout-canary");
  });

  it("fails closed when the landing exceeds the script-candidate budget", async () => {
    const html = Array.from(
      { length: 25 },
      (_value, index) => `<script src="/asset-${index}.js"></script>`,
    ).join("");
    const fetch = vi.fn().mockResolvedValueOnce(response(html, "text/html"));
    await expect(
      inspectOneTrustedScript({
        landingUrl: "https://public.example/",
        bookingUrl: null,
        fetch: fetch as typeof globalThis.fetch,
        authorizeProviderRequest: async () => true,
      }),
    ).resolves.toEqual({
      reasonCodes: ["ASSET_BUDGET_EXCEEDED"],
      contracts: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["absent", {}],
    ["lying", { "content-length": "1" }],
  ])(
    "counts redirect bodies against the per-resource budget with %s content length",
    async (_label, redirectHeaders) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          response("r".repeat(180_000), "text/plain", 302, {
            location: "/landing",
            ...redirectHeaders,
          }),
        )
        .mockResolvedValueOnce(response("f".repeat(80_001), "text/html"));
      await expect(
        inspectOneTrustedScript({
          landingUrl: "https://public.example/",
          bookingUrl: null,
          fetch: fetch as typeof globalThis.fetch,
          authorizeProviderRequest: async () => true,
        }),
      ).resolves.toEqual({
        reasonCodes: ["OVERSIZE_RESPONSE"],
        contracts: [],
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["absent", {}],
    ["lying", { "content-length": "1" }],
  ])(
    "charges a rejected final response body against shared bytes with %s content length",
    async (_label, finalHeaders) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          response('<script src="/app.js"></script>', "text/html"),
        )
        .mockResolvedValueOnce(
          response("r".repeat(384_000), "text/plain", 302, {
            location: "/app-final.js",
          }),
        )
        .mockResolvedValueOnce(
          response("f".repeat(384_000), "text/plain", 500, finalHeaders),
        );

      await expect(
        inspectOneTrustedScript({
          landingUrl: "https://public.example/",
          bookingUrl: null,
          fetch: fetch as typeof globalThis.fetch,
          authorizeProviderRequest: async () => true,
        }),
      ).resolves.toEqual({
        reasonCodes: ["OVERSIZE_RESPONSE"],
        contracts: [],
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it("applies the exact owner/lease/active/fresh DB read and has no domain writes", async () => {
    prismaMocks.batchFindFirst.mockResolvedValueOnce(null);
    await expect(
      loadOwnedProviderContractContext(ownerInput),
    ).resolves.toBeNull();
    expect(prismaMocks.batchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: ownerInput.batchId,
          leaseToken: ownerInput.leaseToken,
          ownerThreadId: ownerInput.ownerThreadId,
          status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
        },
      }),
    );
    expect(prismaMocks.queryRaw).not.toHaveBeenCalled();
    for (const mutation of [
      prismaMocks.courseCreate,
      prismaMocks.courseUpdate,
      prismaMocks.courseUpdateMany,
      prismaMocks.courseUpsert,
      prismaMocks.batchUpdate,
      prismaMocks.batchUpdateMany,
      prismaMocks.batchIncidentUpdate,
      prismaMocks.batchIncidentUpdateMany,
      prismaMocks.incidentCreate,
      prismaMocks.incidentUpdate,
      prismaMocks.incidentUpdateMany,
      prismaMocks.discoveryCreate,
      prismaMocks.discoveryUpdate,
      prismaMocks.discoveryUpdateMany,
      prismaMocks.probeCreate,
      prismaMocks.probeUpdate,
      prismaMocks.eventCreate,
      prismaMocks.monitoringStatusCreate,
      prismaMocks.monitoringStatusUpdate,
      prismaMocks.monitoringStatusUpdateMany,
      prismaMocks.automationRunCreate,
      prismaMocks.automationRunUpdate,
      prismaMocks.transaction,
    ]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it("accepts only the current-cycle browser evidence and rejects an ineligible route", async () => {
    prismaMocks.batchFindFirst.mockResolvedValueOnce(ownedDatabaseBatch());
    const current = await loadOwnedProviderContractContext(ownerInput);
    expect(current?.browserContracts).toHaveLength(1);

    prismaMocks.batchFindFirst.mockResolvedValueOnce(
      ownedDatabaseBatch({ queryKeys: ["date", "accessToken"] }),
    );
    const credentialed = await loadOwnedProviderContractContext(ownerInput);
    expect(credentialed?.restrictionDetected).toBe(true);

    prismaMocks.batchFindFirst.mockResolvedValueOnce(
      ownedDatabaseBatch({ browserCycle: 2 }),
    );
    const wrongCycle = await loadOwnedProviderContractContext(ownerInput);
    expect(wrongCycle?.browserContracts).toEqual([]);

    prismaMocks.batchFindFirst.mockResolvedValueOnce(
      ownedDatabaseBatch({ remediationStage: "OFFICIAL_IDENTITY" }),
    );
    await expect(
      loadOwnedProviderContractContext(ownerInput),
    ).resolves.toBeNull();
    prismaMocks.batchFindFirst.mockResolvedValueOnce(ownedDatabaseBatch());
    await expect(
      loadOwnedProviderContractContext({ ...ownerInput, ordinal: 2 }),
    ).resolves.toBeNull();
  });

  it("reauthorizes an exact claimed provider-contract marker and rejects current-evidence drift", async () => {
    const exact = ownedBrowserRetryContractEvidenceBatch();
    prismaMocks.batchFindFirst.mockResolvedValueOnce(exact);

    await expect(
      loadOwnedProviderContractContextResult(ownerInput),
    ).resolves.toMatchObject({
      outcome: "ready",
      restrictionDetected: false,
      browserContracts: [
        expect.objectContaining({
          pathPattern: "/api/availability",
          statusBand: "SUCCESS",
        }),
      ],
    });

    const drifted = ownedBrowserRetryContractEvidenceBatch();
    const browser = drifted.incidents[0].course.automationDiscoveries[0]
      .evidence.browserInvestigation;
    browser.observedAt = "2026-08-22T14:02:00.000Z";
    drifted.incidents[0].course.automationDiscoveries[0].createdAt = new Date(
      browser.observedAt,
    );
    prismaMocks.batchFindFirst.mockResolvedValueOnce(drifted);

    await expect(
      loadOwnedProviderContractContextResult(ownerInput),
    ).resolves.toMatchObject({
      outcome: "authority_drift",
      reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED",
    });
  });

  it("prefers a family-consistent public booking landing over the official CMS", async () => {
    const bookingLanding =
      "https://foreupsoftware.com/index.php/booking/21017#/teetimes";
    prismaMocks.batchFindFirst.mockResolvedValueOnce(
      ownedDatabaseBatch({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        website: "https://official-course-site.com/golf",
        detectedBookingUrl: bookingLanding,
        browserCycle: 2,
      }),
    );
    const context = await loadOwnedProviderContractContext(ownerInput);
    expect(context).toMatchObject({
      officialUrl: "https://foreupsoftware.com/index.php/booking/21017",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/21017",
      browserContracts: [],
    });

    for (const unsafeBookingUrl of [
      "https://login.foreupsoftware.com/account",
      "https://foreupsoftware.com/checkout",
      "https://foreupsoftware.com/index.php/booking/21017?token=private-canary",
    ]) {
      prismaMocks.batchFindFirst.mockResolvedValueOnce(
        ownedDatabaseBatch({
          providerFamilyKey: "FOREUP",
          detectedPlatform: "FOREUP",
          website: "https://official-course-site.com/golf",
          detectedBookingUrl: unsafeBookingUrl,
          browserCycle: 2,
        }),
      );
      const rejected = await loadOwnedProviderContractContext(ownerInput);
      expect(rejected).toMatchObject({
        officialUrl: "https://official-course-site.com/golf",
        bookingUrl: null,
      });
    }
  });

  it("requires batch, course, and incident family/fingerprint homogeneity", async () => {
    const familyMismatch = ownedDatabaseBatch();
    familyMismatch.providerFamilyKey = "FOREUP";
    prismaMocks.batchFindFirst.mockResolvedValueOnce(familyMismatch);
    await expect(
      loadOwnedProviderContractContext(ownerInput),
    ).resolves.toBeNull();

    const fingerprintMismatch = ownedDatabaseBatch();
    fingerprintMismatch.incidents[0].incident.failureFingerprint =
      "v1:DIFFERENT:METADATA";
    prismaMocks.batchFindFirst.mockResolvedValueOnce(fingerprintMismatch);
    await expect(
      loadOwnedProviderContractContext(ownerInput),
    ).resolves.toBeNull();
  });

  it("uses the claimed incident family while a snapshot-bound course projection remains source-missing", async () => {
    const batch = advanceOwnedBatchToOfficialHttpRetry(
      ownedDatabaseBatch({
        remediationStage: "OFFICIAL_HTTP_DISCOVERY",
      }),
    );
    const course = batch.incidents[0].course;
    course.providerFamilyKey = "SOURCE_MISSING";
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(course);
    batch.summary.remediation.attempts[0].providerSnapshotFingerprint =
      providerSnapshotFingerprint;
    course.automationDiscoveries[0].evidence.browserInvestigation.providerSnapshotFingerprint =
      providerSnapshotFingerprint;
    prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);

    await expect(
      loadOwnedProviderContractContext(ownerInput),
    ).resolves.toMatchObject({
      providerFamilyKey: "CUSTOM",
      browserContracts: [
        expect.objectContaining({
          method: "GET",
          pathPattern: "/api/availability",
        }),
      ],
    });
  });

  it("authorizes every tooling-blocked source-missing projection in a four-member claimed cohort", async () => {
    const batch = ownedDatabaseBatch({
      remediationStage: "OFFICIAL_HTTP_DISCOVERY",
    });
    for (const ordinal of [2, 3, 4]) {
      addSecondOwnedBatchMember(batch, {
        ordinal,
        name: `Zulu Course ${ordinal}`,
      });
    }
    batch.incidents.forEach((entry, index) => {
      entry.incident.kind = "BLOCKED_TOOLING";
      entry.course.providerFamilyKey = "SOURCE_MISSING";
      const providerSnapshotFingerprint =
        buildCourseSupportProviderSnapshotFingerprint(entry.course);
      batch.summary.remediation.attempts[index].providerSnapshotFingerprint =
        providerSnapshotFingerprint;
      const browserInvestigation =
        entry.course.automationDiscoveries[0]?.evidence.browserInvestigation;
      if (browserInvestigation) {
        browserInvestigation.providerSnapshotFingerprint =
          providerSnapshotFingerprint;
      }
    });
    advanceOwnedBatchToOfficialHttpRetry(batch);
    prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);

    await expect(
      loadOwnedProviderContractContext(ownerInput),
    ).resolves.toMatchObject({
      providerFamilyKey: "CUSTOM",
      browserContracts: [
        expect.objectContaining({
          method: "GET",
          pathPattern: "/api/availability",
        }),
      ],
    });
  });

  it.each(["BLOCKED_AUTH", "READER_CANDIDATE"] as const)(
    "keeps %s incidents outside provider-contract inspection without provider I/O",
    async (kind) => {
      const batch = advanceOwnedBatchToOfficialHttpRetry(
        ownedDatabaseBatch({
          remediationStage: "OFFICIAL_HTTP_DISCOVERY",
        }),
      );
      batch.incidents[0].incident.kind = kind;

      const result = await expectControlWithoutProviderIo(batch, "authority_drift");
      expect(result).toMatchObject({
        reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED",
        packetRefreshRequired: true
      });
    }
  );

  it("treats current resolved-family drift after an allowing claim as authority drift", async () => {
    const batch = ownedDatabaseBatch();
    const course = batch.incidents[0].course;
    course.detectedPlatform = "FOREUP";
    const providerSnapshotFingerprint = buildCourseSupportProviderSnapshotFingerprint(course);
    batch.summary.remediation.attempts[0].providerSnapshotFingerprint = providerSnapshotFingerprint;
    course.automationDiscoveries[0].evidence.browserInvestigation.providerSnapshotFingerprint =
      providerSnapshotFingerprint;

    const result = await expectControlWithoutProviderIo(batch);
    expect(result).toMatchObject({
      reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED",
      packetRefreshRequired: true
    });
  });

  it("returns route_ineligible for a fresh typed-adapter verification plan", async () => {
    const batch = ownedDatabaseBatch();
    Object.assign(batch.summary.remediation, {
      workMode: "VERIFY_TRANSIENT",
      strategyAction: "RUN_TYPED_ADAPTER",
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      reason: "EXISTING_SUPPORT_READY"
    });
    Object.assign(batch.summary.remediation.attempts[0], {
      approach: {
        workMode: "VERIFY_TRANSIENT",
        strategyAction: "RUN_TYPED_ADAPTER",
        playbookStage: "TYPED_ADAPTER"
      },
      actionPlan: {
        schemaVersion: 1,
        primaryAction: "VERIFY_CURRENT_RUNTIME",
        allowedActions: ["VERIFY_CURRENT_RUNTIME"],
        route: {
          workMode: "VERIFY_TRANSIENT",
          strategyAction: "RUN_TYPED_ADAPTER",
          playbookStage: "TYPED_ADAPTER"
        }
      }
    });

    const result = await expectControlWithoutProviderIo(batch, "route_ineligible");
    expect(result).toMatchObject({
      reasonCode: "ACTION_PLAN_DISALLOWS_PROVIDER_CONTRACT",
      assignedAction: "VERIFY_CURRENT_RUNTIME"
    });
    },
  );

  it("rejects an otherwise eligible tooling-blocked cohort when one member is auth-blocked", async () => {
    const batch = ownedDatabaseBatch();
    const second = addSecondOwnedBatchMember(batch);
    batch.incidents[0].incident.kind = "BLOCKED_TOOLING";
    second.entry.incident.kind = "BLOCKED_AUTH";

    const result = await expectControlWithoutProviderIo(batch);
    expect(result).toMatchObject({
      reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED",
      packetRefreshRequired: true
    });
  });

  it("keeps an eligible pre-action-plan batch inspectable while its lease remains owned", async () => {
    const batch = ownedDatabaseBatch();
    delete batch.summary.remediation.attempts[0].actionPlan;
    prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);

    await expect(loadOwnedProviderContractContext(ownerInput)).resolves.toMatchObject({
      providerFamilyKey: "CUSTOM",
      browserContracts: [
        expect.objectContaining({
          method: "GET",
          pathPattern: "/api/availability"
        })
      ]
    });
  });

  it.each(["SOURCE_CONFLICT", "FOREUP"])(
    "rejects a snapshot-bound %s course projection that conflicts with the claimed family",
    async (providerFamilyKey) => {
      const batch = advanceOwnedBatchToOfficialHttpRetry(
        ownedDatabaseBatch({
          remediationStage: "OFFICIAL_HTTP_DISCOVERY",
        }),
      );
      const course = batch.incidents[0].course;
      course.providerFamilyKey = providerFamilyKey;
      const providerSnapshotFingerprint =
        buildCourseSupportProviderSnapshotFingerprint(course);
      batch.summary.remediation.attempts[0].providerSnapshotFingerprint =
        providerSnapshotFingerprint;
      course.automationDiscoveries[0].evidence.browserInvestigation.providerSnapshotFingerprint =
        providerSnapshotFingerprint;
      prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);

      await expect(
        loadOwnedProviderContractContext(ownerInput),
      ).resolves.toBeNull();
    },
  );

  it("requires exact snapshot-bound browser evidence while retaining stale restrictions", async () => {
    const snapshotMismatch = ownedDatabaseBatch();
    snapshotMismatch.incidents[0].course.automationDiscoveries[0].evidence.browserInvestigation.providerSnapshotFingerprint =
      "f".repeat(64);
    prismaMocks.batchFindFirst.mockResolvedValueOnce(snapshotMismatch);
    const mismatched = await loadOwnedProviderContractContext(ownerInput);
    expect(mismatched).toMatchObject({
      browserContracts: [],
      restrictionDetected: false,
    });

    const legacy = ownedDatabaseBatch();
    delete (
      legacy.incidents[0].course.automationDiscoveries[0].evidence
        .browserInvestigation as {
        providerSnapshotFingerprint?: string;
      }
    ).providerSnapshotFingerprint;
    prismaMocks.batchFindFirst.mockResolvedValueOnce(legacy);
    const missing = await loadOwnedProviderContractContext(ownerInput);
    expect(missing).toMatchObject({
      browserContracts: [],
      restrictionDetected: false,
    });

    const staleRestricted = ownedDatabaseBatch();
    staleRestricted.incidents[0].course.automationDiscoveries[0].evidence.browserInvestigation.providerSnapshotFingerprint =
      "e".repeat(64);
    staleRestricted.incidents[0].course.automationDiscoveries[0].automationReason =
      "ACCOUNT_REQUIRED";
    prismaMocks.batchFindFirst.mockResolvedValueOnce(staleRestricted);
    const restricted = await loadOwnedProviderContractContext(ownerInput);
    expect(restricted).toMatchObject({
      browserContracts: [],
      restrictionDetected: true,
    });

    const mixedRestricted = ownedDatabaseBatch();
    mixedRestricted.incidents[0].course.automationDiscoveries[0].evidence.browserInvestigation.restrictedNetworkObserved = true;
    prismaMocks.batchFindFirst.mockResolvedValueOnce(mixedRestricted);
    const coarseRestriction =
      await loadOwnedProviderContractContext(ownerInput);
    expect(coarseRestriction).toMatchObject({
      restrictionDetected: true,
    });
  });

  it.each([
    ["signin path", { pathPattern: "/signin" }],
    ["hyphenated sign-in path", { pathPattern: "/sign-in" }],
    ["oauth callback path", { pathPattern: "/oauth/callback" }],
    ["sso login path", { pathPattern: "/sso/login" }],
    ["challenge path", { pathPattern: "/challenge" }],
    ["waiting-room path", { pathPattern: "/waiting-room" }],
    ["client secret key", { queryKeys: ["client_secret"] }],
    ["refresh token key", { queryKeys: ["refresh_token"] }],
    ["csrf key", { queryKeys: ["csrf"] }],
    ["nonce key", { queryKeys: ["nonce"] }],
    ["authorization key", { queryKeys: ["authorization"] }],
    ["redirect URI key", { queryKeys: ["redirect_uri"] }],
    ["code challenge key", { queryKeys: ["code_challenge"] }],
    ["SAML response key", { queryKeys: ["samlresponse"] }],
    ["payment intent key", { queryKeys: ["paymentintent"] }],
    ["auth code key", { queryKeys: ["auth_code"] }],
    ["POST method", { method: "POST" }],
    ["PUT method", { method: "PUT" }],
    ["PATCH method", { method: "PATCH" }],
    ["DELETE method", { method: "DELETE" }],
    ["localhost origin", { origin: "http://localhost" }],
    ["loopback origin", { origin: "http://127.0.0.1" }],
    [
      "credentialed origin",
      { origin: "https://user:password@private-course-canary.example" },
    ],
    ["file origin", { origin: "file:///private-course-canary" }],
  ])(
    "fails closed without provider I/O for legacy persisted %s",
    async (_label, override) => {
      const batch = ownedDatabaseBatch();
      const browser = batch.incidents[0].course.automationDiscoveries[0]
        .evidence.browserInvestigation as {
        restrictedNetworkObserved?: boolean;
        networkContracts: Array<Record<string, unknown>>;
      };
      delete browser.restrictedNetworkObserved;
      Object.assign(browser.networkContracts[0], override);
      const fetch = vi.fn();
      const runWithProviderLease = vi.fn();
      prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);

      await expect(
        inspectOwnedCourseSupportProviderContract(ownerInput, {
          fetch: fetch as typeof globalThis.fetch,
          runWithProviderLease,
        }),
      ).resolves.toMatchObject({
        outcome: "ready",
        evidenceSource: "NONE",
        reasonCodes: ["RESTRICTED_SURFACE_DETECTED"],
        contracts: [],
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(runWithProviderLease).not.toHaveBeenCalled();
    },
  );

  it("keeps a legacy public read contract eligible", async () => {
    const batch = ownedDatabaseBatch({ queryKeys: ["date", "players"] });
    delete batch.incidents[0].course.automationDiscoveries[0].evidence
      .browserInvestigation.restrictedNetworkObserved;
    prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);

    await expect(
      loadOwnedProviderContractContext(ownerInput),
    ).resolves.toMatchObject({
      restrictionDetected: false,
      browserContracts: [
        expect.objectContaining({
          method: "GET",
          pathPattern: "/api/availability",
        }),
      ],
    });
  });

  it("reads the writer's exact snapshot stamp and ignores it after a later re-claimed snapshot", async () => {
    const batch = ownedDatabaseBatch();
    const course = batch.incidents[0].course;
    const originalFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(course);
    const stamped = bindBrowserDiscoveryToProviderSnapshot(
      {
        courseId: course.id,
        status: "INSPECTED",
        detectedPlatform: course.detectedPlatform,
        sourceUrl: course.website,
        bookingUrl: course.detectedBookingUrl,
        confidence: 0.8,
        evidence: {
          learnedFrom: "rendered-browser",
          observedUrls: [],
          browserInvestigation:
            course.automationDiscoveries[0].evidence.browserInvestigation,
        } as never,
      },
      originalFingerprint,
    );
    batch.incidents[0].course.automationDiscoveries[0].evidence =
      stamped.evidence as never;
    prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);
    const exact = await loadOwnedProviderContractContext(ownerInput);
    expect(exact?.browserContracts).toHaveLength(1);

    course.bookingMethod = "PUBLIC_ONLINE";
    course.bookingAccessMode = "PUBLIC_SIGNED_OUT";
    const resultingFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(course);
    batch.summary.remediation.attempts[0].providerSnapshotFingerprint =
      resultingFingerprint;
    prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);
    const stale = await loadOwnedProviderContractContext(ownerInput);
    expect(stale).toMatchObject({
      browserContracts: [],
      restrictionDetected: false,
    });
  });

  it("rejects every selected-attempt and current-monitoring authority drift before I/O", async () => {
    const cases: Array<
      [string, (batch: ReturnType<typeof ownedDatabaseBatch>) => void]
    > = [
      [
        "provider snapshot",
        (batch) => {
          batch.incidents[0].course.detectedBookingUrl =
            "https://private-course-canary.example/new-booking";
        },
      ],
      [
        "attempt failure",
        (batch) => {
          batch.summary.remediation.attempts[0].failureFingerprint =
            "v1:DIFFERENT:FAILURE";
        },
      ],
      [
        "monitoring failure",
        (batch) => {
          batch.incidents[0].course.monitoringStatus.failureFingerprint =
            "v1:DIFFERENT:FAILURE";
        },
      ],
      [
        "incident status",
        (batch) => {
          batch.incidents[0].incident.status = "RESOLVED";
        },
      ],
      [
        "healthy monitoring state",
        (batch) => {
          batch.incidents[0].course.monitoringStatus.state = "HEALTHY";
          batch.incidents[0].course.monitoringStatus.failureFingerprint = null;
        },
      ],
      [
        "new monitoring event",
        (batch) => {
          batch.incidents[0].course.monitoringEvents.push({
            eventType: "CHECK_FAILED",
            outcome: "FETCH_FAILED",
            failureFingerprint: "v1:DIFFERENT:FAILURE",
            occurredAt: new Date(now.getTime() + 1),
          });
        },
      ],
      [
        "approach",
        (batch) => {
          batch.summary.remediation.attempts[0].approach.strategyAction =
            "RUN_TYPED_ADAPTER";
        },
      ],
      [
        "missing attempt",
        (batch) => {
          batch.summary.remediation.attempts = [];
        },
      ],
      [
        "duplicate attempt",
        (batch) => {
          batch.summary.remediation.attempts.push({
            ...batch.summary.remediation.attempts[0],
          });
        },
      ],
    ];

    for (const [, mutate] of cases) {
      const batch = ownedDatabaseBatch();
      mutate(batch);
      await expectControlWithoutProviderIo(batch);
    }
  });

  it("rejects playbook progress after claim even when the next-stage label is unchanged", async () => {
    const batch = ownedDatabaseBatch();
    batch.incidents[0].incident.attemptLedger = appendAutomationPlaybookEvent(
      batch.incidents[0].incident.attemptLedger,
      {
        cycle: 1,
        stage: "TYPED_ADAPTER",
        transition: "STARTED",
        readPath: "TYPED_PROVIDER_ADAPTER",
        evidenceKind: "TOOLING",
        failureFingerprint: "TEST:TYPED:STARTED",
        runtimeVersion: "test-runtime",
        observedAt: new Date(now.getTime() + 1),
      },
    );
    await expectControlWithoutProviderIo(batch);
  });

  it("binds ordinal selection to exactly one claimed course attempt", async () => {
    const batch = ownedDatabaseBatch();
    const second = ownedDatabaseBatch();
    const secondEntry = second.incidents[0];
    secondEntry.id = "batch-entry-2";
    secondEntry.course.id = "course-alpha";
    secondEntry.course.name = "Alpha Course";
    secondEntry.course.website = "https://alpha-public.example/";
    secondEntry.course.automationDiscoveries = [];
    const secondSnapshot = buildCourseSupportProviderSnapshotFingerprint(
      secondEntry.course,
    );
    const secondAttempt = {
      ...second.summary.remediation.attempts[0],
      courseRef: createHash("sha256")
        .update(secondEntry.course.id)
        .digest("hex")
        .slice(0, 24),
      providerSnapshotFingerprint: secondSnapshot,
    };
    batch.incidents.push(secondEntry);
    batch.summary.remediation.attempts.push(secondAttempt);

    prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);
    const firstOrdinal = await loadOwnedProviderContractContext(ownerInput);
    expect(firstOrdinal?.officialUrl).toBe("https://alpha-public.example/");

    batch.summary.remediation.attempts[1].providerSnapshotFingerprint =
      batch.summary.remediation.attempts[0].providerSnapshotFingerprint;
    prismaMocks.batchFindFirst.mockResolvedValueOnce(batch);
    await expect(
      loadOwnedProviderContractContext(ownerInput),
    ).resolves.toBeNull();
  });

  it("rejects technical authority drift in every nonselected batch member", async () => {
    const mutations: Array<
      [
        string,
        (
          batch: ReturnType<typeof ownedDatabaseBatch>,
          second: ReturnType<typeof addSecondOwnedBatchMember>,
        ) => void,
      ]
    > = [
      [
        "course family",
        (_batch, second) => {
          second.entry.course.providerFamilyKey = "FOREIGN";
        },
      ],
      [
        "incident fingerprint",
        (_batch, second) => {
          second.entry.incident.failureFingerprint = "v1:DIFFERENT:FAILURE";
        },
      ],
      [
        "batch-entry result",
        (_batch, second) => {
          second.entry.result = "RESTORED";
        },
      ],
      [
        "active batch membership",
        (_batch, second) => {
          second.entry.incident.activeBatchId = "other-batch";
        },
      ],
      [
        "claimed snapshot",
        (_batch, second) => {
          second.attempt.providerSnapshotFingerprint = "f".repeat(64);
        },
      ],
      [
        "claimed approach",
        (_batch, second) => {
          second.attempt.approach.strategyAction = "RUN_TYPED_ADAPTER";
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      const batch = ownedDatabaseBatch();
      const second = addSecondOwnedBatchMember(batch);
      mutate(batch, second);
      await expectControlWithoutProviderIo(batch, "authority_drift", label);
    }
  });

  it("binds nonselected technical identity while ignoring its demand-only drift", async () => {
    const initialBatch = ownedDatabaseBatch();
    addSecondOwnedBatchMember(initialBatch);
    const changedTechnicalBatch = ownedDatabaseBatch();
    const changedTechnical = addSecondOwnedBatchMember(changedTechnicalBatch);
    changedTechnical.entry.incident.kind = "FETCH_FAILED";
    const demandOnlyBatch = ownedDatabaseBatch();
    const demandOnly = addSecondOwnedBatchMember(demandOnlyBatch);
    demandOnly.entry.incident.activeRealSearchCount = 12;
    demandOnly.entry.incident.updatedAt = new Date(now.getTime() + 60_000);
    prismaMocks.batchFindFirst
      .mockResolvedValueOnce(initialBatch)
      .mockResolvedValueOnce(changedTechnicalBatch)
      .mockResolvedValueOnce(demandOnlyBatch);

    const initial = await loadOwnedProviderContractContext(ownerInput);
    const changed = await loadOwnedProviderContractContext(ownerInput);
    const demandOnlyChanged =
      await loadOwnedProviderContractContext(ownerInput);
    expect(initial?.authorityDigest).not.toBe(changed?.authorityDigest);
    expect(initial?.authorityDigest).toBe(demandOnlyChanged?.authorityDigest);
  });

  it("uses authoritative DB time and rejects an exact-expiry lease despite local skew", async () => {
    const localClock = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date("2026-08-21T00:00:00.000Z").getTime());
    prismaMocks.batchFindFirst.mockResolvedValueOnce(ownedDatabaseBatch());
    prismaMocks.queryRaw.mockResolvedValueOnce([{ now, leaseExpiresAt: now }]);

    await expect(loadOwnedProviderContractContextResult(ownerInput),
    ).resolves.toMatchObject({
      outcome: "recovery_required",
      reasonCode: "OWNERSHIP_OR_LEASE_LOST"
    });
    const sql = prismaMocks.queryRaw.mock.calls[0]?.[0] as {
      strings: readonly string[];
      values: unknown[];
    };
    expect(sql.strings.join("?")).toContain('"leaseExpiresAt" AS "leaseExpiresAt"');
    expect(sql.values).toEqual(
      expect.arrayContaining([
        ownerInput.batchId,
        ownerInput.leaseToken,
        ownerInput.ownerThreadId]),
    );
    localClock.mockRestore();
  });

  it.each([
    [
      "database clock",
      {
        now: new Date("invalid"),
        leaseExpiresAt: new Date("2026-08-22T15:00:00.000Z")
      }
    ],
    ["lease timestamp", { now, leaseExpiresAt: new Date("invalid") }]
  ])("treats a malformed %s authorization row as unavailable", async (_label, row) => {
    prismaMocks.batchFindFirst.mockResolvedValueOnce(ownedDatabaseBatch());
    prismaMocks.queryRaw.mockResolvedValueOnce([row]);

    await expect(inspectOwnedCourseSupportProviderContract(ownerInput)).resolves.toMatchObject({
      evidenceSource: "NONE",
      reasonCodes: ["AUTHORIZATION_UNAVAILABLE"],
      contracts: []
    });
  });

  it("returns recovery only when the exact database authorization row is absent", async () => {
    prismaMocks.batchFindFirst.mockResolvedValueOnce(ownedDatabaseBatch());
    prismaMocks.queryRaw.mockResolvedValueOnce([]);

    await expect(inspectOwnedCourseSupportProviderContract(ownerInput)).resolves.toMatchObject({
      outcome: "recovery_required",
      reasonCode: "OWNERSHIP_OR_LEASE_LOST",
      contracts: []
    });
    });

  it("requires the full I/O deadline plus release margin as lease headroom", async () => {
    prismaMocks.batchFindFirst.mockResolvedValueOnce(ownedDatabaseBatch());
    prismaMocks.queryRaw.mockResolvedValueOnce([
      {
        now,
        leaseExpiresAt: new Date(now.getTime() + PROVIDER_CONTRACT_REQUIRED_LEASE_HEADROOM_MS)
      }
    ]);

    await expect(
      loadOwnedProviderContractContextResult({
        ...ownerInput,
        requiredLeaseHeadroomMs: PROVIDER_CONTRACT_REQUIRED_LEASE_HEADROOM_MS
      })
    ).resolves.toMatchObject({
      outcome: "lease_headroom_insufficient",
      reasonCode: "LEASE_HEADROOM_INSUFFICIENT"
    });
  });

  it("validates lease headroom against live DB time after a delayed ownership read", async () => {
    const callOrder: string[] = [];
    prismaMocks.batchFindFirst.mockImplementationOnce(async () => {
      callOrder.push("batch");
      return ownedDatabaseBatch();
    });
    prismaMocks.queryRaw.mockImplementationOnce(async () => {
      callOrder.push("live-clock");
      return [];
    });

    await expect(
      loadOwnedProviderContractContext({
        ...ownerInput,
        requiredLeaseHeadroomMs: PROVIDER_CONTRACT_REQUIRED_LEASE_HEADROOM_MS,
      }),
    ).resolves.toBeNull();
    expect(callOrder).toEqual(["batch", "live-clock"]);
  });

  it("treats same-owner lease extension as freshness, not scope-identity drift", async () => {
    const initialBatch = ownedDatabaseBatch();
    const extendedBatch = ownedDatabaseBatch();
    extendedBatch.leaseExpiresAt = new Date(
      initialBatch.leaseExpiresAt.getTime() + 60_000,
    );
    extendedBatch.heartbeatAt = new Date(
      initialBatch.leaseExpiresAt.getTime() - 30_000,
    );
    extendedBatch.revision += 1;
    prismaMocks.batchFindFirst
      .mockResolvedValueOnce(initialBatch)
      .mockResolvedValueOnce(extendedBatch);

    const initial = await loadOwnedProviderContractContext(ownerInput);
    const extended = await loadOwnedProviderContractContext(ownerInput);
    expect(initial?.authorityDigest).toBe(extended?.authorityDigest);
  });

  it("keeps demand-only incident synchronization out of technical authority identity", async () => {
    const initialBatch = ownedDatabaseBatch();
    const demandSynchronizedBatch = ownedDatabaseBatch();
    demandSynchronizedBatch.incidents[0].incident.activeRealSearchCount = 9;
    demandSynchronizedBatch.incidents[0].incident.updatedAt = new Date(
      initialBatch.incidents[0].incident.updatedAt.getTime() + 30_000,
    );
    prismaMocks.batchFindFirst
      .mockResolvedValueOnce(initialBatch)
      .mockResolvedValueOnce(demandSynchronizedBatch);

    const initial = await loadOwnedProviderContractContext(ownerInput);
    const synchronized = await loadOwnedProviderContractContext(ownerInput);
    expect(initial?.authorityDigest).toBe(synchronized?.authorityDigest);
  });

  it("binds an eligible technical incident-kind change into the scope identity", async () => {
    const initialBatch = ownedDatabaseBatch();
    prismaMocks.batchFindFirst.mockResolvedValueOnce(initialBatch);
    const initial = await loadOwnedProviderContractContext(ownerInput);

    const changedKindBatch = ownedDatabaseBatch();
    changedKindBatch.incidents[0].incident.kind = "FETCH_FAILED";
    prismaMocks.batchFindFirst.mockResolvedValueOnce(changedKindBatch);
    const changed = await loadOwnedProviderContractContext(ownerInput);

    expect(initial?.authorityDigest).not.toBe(changed?.authorityDigest);
  });

  it("separates same-authority browser evidence changes from route identity", async () => {
    prismaMocks.batchFindFirst
      .mockResolvedValueOnce(ownedDatabaseBatch({ queryKeys: ["date"] }))
      .mockResolvedValueOnce(
        ownedDatabaseBatch({ queryKeys: ["date", "players"] }),
      );

    const initial = await loadOwnedProviderContractContext(ownerInput);
    const changedEvidence = await loadOwnedProviderContractContext(ownerInput);
    expect(initial?.authorityDigest).toBe(changedEvidence?.authorityDigest);
    expect(initial?.evidenceDigest).not.toBe(changedEvidence?.evidenceDigest);
  });
});

describe("provider-contract privacy projection", () => {
  it("never retains arbitrary path literals or arbitrary query names", () => {
    expect(
      sanitizeContractPath(
        "/api/Private-Course-Canary/facilities/839283/tee-times/customer@example.com",
      ),
    ).toBe("/api/{segment}/facilities/{segment}/tee-times/{segment}");
    const contracts = extractContractFingerprintsFromScript({
      source:
        "fetch('/api/Private-Course-Canary/availability?date=secret&mysteryKey=x')",
      officialOrigin: "https://public.example",
      bookingOrigin: null,
      providerFamilyKey: "CUSTOM",
    });
    expect(contracts).toHaveLength(1);
    expect(JSON.stringify(contracts)).not.toMatch(
      /Private-Course-Canary|mysteryKey|secret|public\.example/iu,
    );
  });

  it("rejects dynamic methods and unrelated absolute API-looking origins", () => {
    expect(
      extractContractFingerprintsFromScript({
        source: "fetch('/api/availability', { method: selectedMethod })",
        officialOrigin: "https://public.example",
        bookingOrigin: null,
        providerFamilyKey: "CUSTOM",
      }),
    ).toEqual([]);
    expect(
      extractContractFingerprintsFromScript({
        source: "axios.get('https://unrelated.example/api/availability')",
        officialOrigin: "https://public.example",
        bookingOrigin: null,
        providerFamilyKey: "FOREUP",
      }),
    ).toEqual([]);
  });

  it("rejects protocol-relative and template-synthesized authorities", () => {
    for (const source of [
      'axios.get("//unrelated.example/api/availability?date=x")',
      'fetch("//unrelated.example/api/availability?date=x")',
      'fetch("///unrelated.example/api/availability?date=x")',
      "fetch(`/${prefix}/api/availability?date=x`)",
      "fetch(`https://${host}.foreupsoftware.com/api/availability?date=x`)",
      "fetch(`https://foreupsoftware.${tld}/api/availability?date=x`)",
      'fetch("/%2f%2funrelated.example/api/availability?date=x")',
    ]) {
      expect(
        extractContractFingerprintsFromScript({
          source,
          officialOrigin: "https://public.example",
          bookingOrigin: null,
          providerFamilyKey: "FOREUP",
        }),
      ).toEqual([]);
    }

    expect(
      extractContractFingerprintsFromScript({
        source: "fetch(`/api/${courseId}/availability?date=${day}`)",
        officialOrigin: "https://public.example",
        bookingOrigin: null,
        providerFamilyKey: "CUSTOM",
      }),
    ).toEqual([
      expect.objectContaining({
        pathPattern: "/api/{segment}/availability",
        queryKeys: ["DATE"],
        providerSignal: "TRUSTED_SCRIPT_RELATIVE",
      }),
    ]);
    expect(
      extractContractFingerprintsFromScript({
        source:
          "fetch(`https://foreupsoftware.com/api/${courseId}/availability?date=${day}`)",
        officialOrigin: "https://public.example",
        bookingOrigin: null,
        providerFamilyKey: "FOREUP",
      }),
    ).toEqual([
      expect.objectContaining({
        pathPattern: "/api/{segment}/availability",
        providerSignal: "KNOWN_PROVIDER_INFRASTRUCTURE",
      }),
    ]);
  });

  it("rejects unproven fetch and axios request configuration", () => {
    for (const source of [
      'fetch("/api/availability", { headers: authHeaders })',
      'fetch("/api/availability", { ...requestOptions })',
      'fetch("/api/availability", { method: selectedMethod })',
      'fetch("/api/availability", { method: "GET", credentials: "include" })',
      'axios.get("/api/availability", { headers: { Authorization: token } })',
      'axios.get("/api/availability", { withCredentials: true })',
      'axios.get("/api/availability", requestConfig)',
      'client.axios.get("/api/availability")',
      'client.fetch("/api/availability")',
      'authenticatedClient . fetch("/api/availability")',
      'client?.fetch("/api/availability")',
      '$fetch("/api/availability")',
      'client. /* private wrapper */ fetch("/api/availability")',
      'client. // private wrapper\n fetch("/api/availability")',
      'client. /* private wrapper */ axios.get("/api/availability")',
      'client. // private wrapper\n axios.get("/api/availability")',
      `client./*${"x".repeat(600)}*/fetch("/api/availability")`,
      `client.//${"x".repeat(600)}\nfetch("/api/availability")`,
      `client.${" ".repeat(600)}fetch("/api/availability")`,
      `client.${Array.from({ length: 30 }, () => "/**/").join("")}fetch("/api/availability")`,
      'this.#fetch("/api/availability")',
      'client.#fetch("/api/availability")',
      'const fetch = authenticatedClient.fetch.bind(authenticatedClient); fetch("/api/availability")',
      'function fetch() { return client.post(); } fetch("/api/availability")',
      'function run(fetch) { return fetch("/api/availability"); }',
      'import fetch from "private-fetch"; fetch("/api/availability")',
      'fetch = authenticatedClient.fetch; fetch("/api/availability")',
      'const axios = authenticatedClient; axios.get("/api/availability")',
      'function run(axios) { return axios.get("/api/availability"); }',
      'import axios from "private-axios"; axios.get("/api/availability")',
      'function/**/fetch(){} fetch("/api/availability")',
      'class/**/fetch{} fetch("/api/availability")',
      'let/**/fetch; fetch("/api/availability")',
      'fetch/* assignment trivia */=authenticatedClient.fetch; fetch("/api/availability")',
      '({fetch: fetch}=authenticatedClient); fetch("/api/availability")',
      '((fetch))=authenticatedClient.fetch; fetch("/api/availability")',
      '((axios))=authenticatedClient; axios.get("/api/availability")',
      'const g=globalThis; g.fetch=authenticatedClient.fetch; fetch("/api/availability")',
      'const g=globalThis; Object.assign(g, dynamicConfiguration); fetch("/api/availability")',
      'Object.defineProperty(globalThis, dynamicKey, descriptor); fetch("/api/availability")',
      'Reflect.set(globalThis, dynamicKey, authenticatedClient.fetch); fetch("/api/availability")',
      'globalThis[dynamicKey]=authenticatedClient.fetch; fetch("/api/availability")',
      'const g=globalThis.globalThis; g[dynamicKey]=replacement; fetch("/api/availability")',
      'Object.assign(globalThis.globalThis,dynamicConfiguration); fetch("/api/availability")',
      '(0, eval)("globalThis.fetch=evil"); fetch("/api/availability")',
      'const g=this; g[dynamicKey]=replacement; fetch("/api/availability")',
      'fetch("/post",{method:"POST", body=evil()}); fetch("/api/availability")',
      'fetch("/post",{method:"POST", #x: 1}); fetch("/api/availability")',
      'fetch("/post",{method:"POST", __proto__: a, __proto__: b}); fetch("/api/availability")',
      '"use strict"; fetch("/post",{method:"POST", yield}); fetch("/api/availability")',
      'axios.get=authenticatedClient.get; fetch("/api/availability")',
      'axios.defaults.headers.common.Authorization=token; fetch("/api/availability")',
      'axios.interceptors.request.use(addAuthorization); fetch("/api/availability")',
      `import { ${Array.from({ length: 300 }, (_, index) => `a${index}`).join(", ")}, fetch } from "private-fetch"; fetch("/api/availability")`,
      `function run(${Array.from({ length: 300 }, (_, index) => `a${index}`).join(", ")}, fetch) { return fetch("/api/availability"); }`,
    ]) {
      expect(
        extractContractFingerprintsFromScript({
          source,
          officialOrigin: "https://public.example",
          bookingOrigin: null,
          providerFamilyKey: "CUSTOM",
        }),
      ).toEqual([]);
    }

    const safe = extractContractFingerprintsFromScript({
      source:
        'fetch("/api/availability", { method: "GET" }); axios.get("/api/slots")',
      officialOrigin: "https://public.example",
      bookingOrigin: null,
      providerFamilyKey: "CUSTOM",
    });
    expect(safe).toEqual([]);

    const leadingTrivia = extractContractFingerprintsFromScript({
      source: `/*${"x".repeat(600)}*/ fetch("/api/availability")`,
      officialOrigin: "https://public.example",
      bookingOrigin: null,
      providerFamilyKey: "CUSTOM",
    });
    expect(leadingTrivia).toHaveLength(1);

    const inertBindingText = extractContractFingerprintsFromScript({
      source:
        '/* const fetch = privateFetch */ "const axios = privateAxios"; fetch("/api/availability")',
      officialOrigin: "https://public.example",
      bookingOrigin: null,
      providerFamilyKey: "CUSTOM",
    });
    expect(inertBindingText).toHaveLength(1);

    const propertyNames = extractContractFingerprintsFromScript({
      source:
        'class Reader { fetch() {} } const helpers = { axios() {} }; fetch("/api/availability"); axios.get("/api/slots")',
      officialOrigin: "https://public.example",
      bookingOrigin: null,
      providerFamilyKey: "CUSTOM",
    });
    expect(propertyNames).toEqual([]);
  });

  it("rejects dynamic and credential-shaped query keys without leaking values", () => {
    for (const source of [
      "fetch(`/api/availability?${authKey}=x`)",
      'fetch("/api/availability?token=private-canary")',
      'axios.get("/api/availability?client_secret=private-canary")',
    ]) {
      const contracts = extractContractFingerprintsFromScript({
        source,
        officialOrigin: "https://public.example",
        bookingOrigin: null,
        providerFamilyKey: "CUSTOM",
      });
      expect(contracts).toEqual([]);
      expect(JSON.stringify(contracts)).not.toMatch(/private-canary|authKey/iu);
    }
  });

  it("accepts an absolute read only when its known family matches", () => {
    const contracts = extractContractFingerprintsFromScript({
      source: "fetch('https://foreupsoftware.com/api/availability?date=x')",
      officialOrigin: "https://public.example",
      bookingOrigin: null,
      providerFamilyKey: "FOREUP",
    });
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      providerSignal: "KNOWN_PROVIDER_INFRASTRUCTURE",
      pathPattern: "/api/availability",
      queryKeys: ["DATE"],
    });
    expect(JSON.stringify(contracts)).not.toContain("foreupsoftware.com");
  });
});

describe("provider-contract DNS-pinned transport", () => {
  it("rejects mixed/private DNS before a request and re-resolves every call", async () => {
    const resolveAddresses = vi.fn().mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 as const },
      { address: "10.0.0.5", family: 4 as const },
    ]);
    const requestPinned = vi.fn();
    const pinnedFetch = createProviderContractPinnedFetch({
      resolveAddresses,
      requestPinned,
    });
    await expect(
      pinnedFetch("https://public-course.com/app.js"),
    ).rejects.toThrow("non-public network address");
    expect(requestPinned).not.toHaveBeenCalled();

    resolveAddresses
      .mockReset()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 as const }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 as const }]);
    requestPinned.mockResolvedValue(response("ok", "application/javascript"));
    await expect(
      pinnedFetch("https://public-course.com/app.js"),
    ).resolves.toBeDefined();
    await expect(
      pinnedFetch("https://public-course.com/app.js"),
    ).rejects.toThrow("non-public network address");
    expect(resolveAddresses).toHaveBeenCalledTimes(2);
    expect(requestPinned).toHaveBeenCalledTimes(1);
  });

  it("rejects non-read and credentialed requests before DNS resolution", async () => {
    const resolveAddresses = vi.fn();
    const pinnedFetch = createProviderContractPinnedFetch({ resolveAddresses });
    await expect(
      pinnedFetch("https://public-course.com/app.js", { method: "POST" }),
    ).rejects.toThrow("only safe read requests");
    await expect(
      pinnedFetch("https://public-course.com/app.js", {
        headers: { authorization: "private-canary" },
      }),
    ).rejects.toThrow("cannot include credentials");
    expect(resolveAddresses).not.toHaveBeenCalled();
  });
});
