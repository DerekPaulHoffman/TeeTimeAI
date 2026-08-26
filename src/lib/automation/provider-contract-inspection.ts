import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { Prisma } from "@prisma/client";
import { parse as parseEcmaScript } from "acorn";
import {
  parseFragment,
  type DefaultTreeAdapterMap,
  type ParserError,
} from "parse5";
import ts from "typescript";

import {
  createAddressPinnedPublicFetchTransport,
  type AddressPinnedPublicFetchDependencies,
} from "./address-pinned-public-fetch";
import { isSafeManualEvidenceUrl } from "./browser-discovery";
import { classifyBrowserNetworkContractRestriction } from "./browser-probe-evidence";
import {
  assessAutomationPlaybook,
  parseAutomationPlaybookLedger
} from "./course-monitoring-playbook";
import {
  orderCourseSupportBatchIncidents,
  readCourseSupportRemediationClaimAttempt,
  readCourseSupportRemediationDirective,
} from "./course-support-batches";
import {
  courseSupportActionPlanAllows,
  isCourseSupportProviderContractActionEligible,
  type CourseSupportClaimAction
} from "./course-support-action-plan";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import {
  getKnownProviderFamilyForHostname,
  isProviderInfrastructureUrl,
  isProviderPublicBookingLandingUrl,
  normalizeProviderFamilyKey,
  resolveProviderCapability,
  resolveProviderDiscoveryIdentity,
  SOURCE_MISSING_PROVIDER_FAMILY,
} from "./provider-capabilities";
import { runWithProviderRequestLease } from "./provider-request-lease";
import { prisma } from "../prisma";

export const PROVIDER_CONTRACT_MAX_DOCUMENT_BYTES = 256_000;
export const PROVIDER_CONTRACT_MAX_SCRIPT_BYTES = 384_000;
export const PROVIDER_CONTRACT_MAX_REQUESTS = 4;
export const PROVIDER_CONTRACT_MAX_REDIRECTS = 1;
export const PROVIDER_CONTRACT_MAX_SCRIPT_CANDIDATES = 24;
export const PROVIDER_CONTRACT_MAX_CONTRACTS = 24;
export const PROVIDER_CONTRACT_TIMEOUT_MS = 8_000;
export const PROVIDER_CONTRACT_TOTAL_TIMEOUT_MS = 10_000;
export const PROVIDER_CONTRACT_LEASE_RELEASE_MARGIN_MS = 1_000;
export const PROVIDER_CONTRACT_REQUIRED_LEASE_HEADROOM_MS =
  PROVIDER_CONTRACT_TOTAL_TIMEOUT_MS +
  PROVIDER_CONTRACT_LEASE_RELEASE_MARGIN_MS;
export const PROVIDER_CONTRACT_MAX_TOTAL_BYTES =
  PROVIDER_CONTRACT_MAX_DOCUMENT_BYTES + PROVIDER_CONTRACT_MAX_SCRIPT_BYTES;

const SAFE_PATH_SEGMENTS = new Map<string, string>([
  ["api", "api"],
  ["v1", "v1"],
  ["v2", "v2"],
  ["v3", "v3"],
  ["availability", "availability"],
  ["available", "available"],
  ["booking", "booking"],
  ["bookings", "bookings"],
  ["calendar", "calendar"],
  ["course", "course"],
  ["courses", "courses"],
  ["facility", "facility"],
  ["facilities", "facilities"],
  ["inventory", "inventory"],
  ["location", "location"],
  ["locations", "locations"],
  ["public", "public"],
  ["search", "search"],
  ["slot", "slot"],
  ["slots", "slots"],
  ["tee-time", "tee-time"],
  ["tee-times", "tee-times"],
  ["teetime", "tee-time"],
  ["teetimes", "tee-times"],
  ["time", "time"],
  ["times", "times"],
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"] as const);
const SCRIPT_CONTENT_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "text/ecmascript",
  "text/javascript",
]);
export type ProviderContractReasonCode =
  | "EXISTING_BROWSER_CONTRACTS"
  | "PINNED_SCRIPT_CONTRACTS"
  | "NO_CURRENT_BROWSER_CONTRACTS"
  | "NO_TRUSTED_LANDING_PAGE"
  | "NO_TRUSTED_SCRIPT"
  | "NO_SAFE_CONTRACT_SIGNAL"
  | "PROVIDER_LEASE_BUSY"
  | "AUTHORIZATION_UNAVAILABLE"
  | "OWNERSHIP_OR_ROUTE_CHANGED"
  | "UNSAFE_NETWORK_TARGET"
  | "UNSAFE_REDIRECT"
  | "HTTP_STATUS_REJECTED"
  | "BAD_CONTENT_TYPE"
  | "OVERSIZE_RESPONSE"
  | "REQUEST_BUDGET_EXCEEDED"
  | "ASSET_BUDGET_EXCEEDED"
  | "RESTRICTED_SURFACE_DETECTED";

export type ProviderContractMethod = "GET" | "HEAD" | "OPTIONS";
export type ProviderContractResourceType =
  "DOCUMENT" | "FETCH" | "XHR" | "SCRIPT" | "OTHER";
export type ProviderContractStatusBand =
  "SUCCESS" | "REDIRECT" | "CLIENT_ERROR" | "SERVER_ERROR" | "UNKNOWN";
export type ProviderContractQueryKey =
  | "COURSE_ID"
  | "DATE"
  | "END_DATE"
  | "FACILITY_ID"
  | "HOLES"
  | "LIMIT"
  | "LOCATION_ID"
  | "OFFSET"
  | "PAGE"
  | "PLAYERS"
  | "START_DATE"
  | "TIMEZONE"
  | "OTHER";
export type ProviderContractSignal =
  | "OFFICIAL_ORIGIN"
  | "BOOKING_ORIGIN"
  | "KNOWN_PROVIDER_INFRASTRUCTURE"
  | "TRUSTED_BROWSER_ORIGIN"
  | "TRUSTED_SCRIPT_RELATIVE";

export type SanitizedProviderContract = {
  method: ProviderContractMethod;
  resourceType: ProviderContractResourceType;
  statusBand: ProviderContractStatusBand;
  pathPattern: string;
  queryKeys: ProviderContractQueryKey[];
  providerSignal: ProviderContractSignal;
  digest: string;
};

type RawBrowserContract = {
  origin: string;
  method: string;
  pathPattern: string;
  queryKeys: string[];
  resourceType: string;
  status: number | null;
};

type OwnedProviderContractContext = {
  outcome: "ready";
  authorityDigest: string;
  evidenceDigest: string;
  providerFamilyKey: string;
  officialUrl: string | null;
  bookingUrl: string | null;
  browserContracts: RawBrowserContract[];
  restrictionDetected: boolean;
};

type OwnedProviderContractContextResult =
  | OwnedProviderContractContext
  | {
      outcome: "recovery_required";
      reasonCode: "OWNERSHIP_OR_LEASE_LOST";
    }
  | {
      outcome: "route_ineligible";
      reasonCode: "ACTION_PLAN_DISALLOWS_PROVIDER_CONTRACT" | "PROVIDER_CONTRACT_ROUTE_INELIGIBLE";
      assignedAction: CourseSupportClaimAction | null;
    }
  | {
      outcome: "authority_drift";
      reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED";
    }
  | {
      outcome: "lease_headroom_insufficient";
      reasonCode: "LEASE_HEADROOM_INSUFFICIENT";
    };

type ProviderContractInspectionDependencies = {
  loadContext?: typeof loadOwnedProviderContractContextResult;
  fetch?: typeof fetch;
  runWithProviderLease?: typeof runWithProviderRequestLease;
};

const providerContractBatchSelect = {
  summary: true,
  createdAt: true,
  status: true,
  baseSha: true,
  releaseSha: true,
  deployedAt: true,
  leaseExpiresAt: true,
  providerFamilyKey: true,
  failureFingerprint: true,
  incidents: {
    orderBy: [{ course: { name: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      cycle: true,
      result: true,
      course: {
        select: {
          id: true,
          name: true,
          website: true,
          detectedBookingUrl: true,
          timeZone: true,
          isPublic: true,
          detectedPlatform: true,
          providerFamilyKey: true,
          bookingMethod: true,
          bookingWindowDaysAhead: true,
          bookingReleaseTimeLocal: true,
          bookingWindowSource: true,
          bookingWindowConfidence: true,
          bookingWindowEvidenceUrl: true,
          automationEligibility: true,
          automationReason: true,
          monitoringMode: true,
          bookingAccessMode: true,
          intelligenceVerifiedAt: true,
          intelligenceReviewAt: true,
          intelligenceConfidence: true,
          bookingMetadata: true,
          layoutHoleCounts: true,
          layoutHolesVerifiedAt: true,
          updatedAt: true,
          monitoringStatus: {
            select: {
              state: true,
              failureFingerprint: true,
              updatedAt: true,
            },
          },
          monitoringEvents: {
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            take: 8,
            select: {
              eventType: true,
              outcome: true,
              failureFingerprint: true,
              occurredAt: true,
            },
          },
          automationDiscoveries: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 12,
            select: {
              evidence: true,
              automationReason: true,
              detectedPlatform: true,
              bookingUrl: true,
              apiMetadata: true,
              confidence: true,
              createdAt: true,
            },
          },
        },
      },
      incident: {
        select: {
          id: true,
          cycle: true,
          status: true,
          kind: true,
          providerFamilyKey: true,
          failureFingerprint: true,
          activeBatchId: true,
          activeRealSearchCount: true,
          attemptLedger: true,
          firstSeenAt: true,
          resolution: true,
          updatedAt: true,
        },
      },
    },
  },
} satisfies Prisma.CourseSupportBatchSelect;

type ProviderContractBatch = Prisma.CourseSupportBatchGetPayload<{
  select: typeof providerContractBatchSelect;
}>;

export async function inspectOwnedCourseSupportProviderContract(
  input: {
    batchId: string;
    leaseToken: string;
    ownerThreadId: string;
    ordinal: number;
  },
  dependencies: ProviderContractInspectionDependencies = {},
) {
  try {
    return await inspectOwnedCourseSupportProviderContractInternal(
      input,
      dependencies,
    );
  } catch (error) {
    if (error instanceof ProviderContractInspectionError) {
      return inspectionResult(input.ordinal, "NONE", [error.reasonCode], []);
    }
    throw new Error(
      "Provider-contract inspection failed closed before evidence could be returned.",
    );
  }
}

async function inspectOwnedCourseSupportProviderContractInternal(
  input: {
    batchId: string;
    leaseToken: string;
    ownerThreadId: string;
    ordinal: number;
  },
  dependencies: ProviderContractInspectionDependencies,
) {
  validateProviderContractOrdinal(input.ordinal);
  const loadContext =
    dependencies.loadContext ?? loadOwnedProviderContractContextResult;
  const loadAuthorizedContext = async (
    request: Parameters<typeof loadContext>[0],
  ): Promise<OwnedProviderContractContextResult> => {
    try {
      const loaded = await loadContext(request);
      if (!loaded) {
        throw new ProviderContractInspectionError("AUTHORIZATION_UNAVAILABLE");
      }
      return loaded;
    } catch {
      throw new ProviderContractInspectionError("AUTHORIZATION_UNAVAILABLE");
    }
  };
  const initial = await loadAuthorizedContext(input);
  if (initial.outcome !== "ready") {
    return providerContractControlResult(input.ordinal, initial);
  }
  if (initial.restrictionDetected) {
    return inspectionResult(
      input.ordinal,
      "NONE",
      ["RESTRICTED_SURFACE_DETECTED"],
      [],
    );
  }
  const existing = projectBrowserContracts(initial);
  if (existing.length > 0) {
    return inspectionResult(
      input.ordinal,
      "PERSISTED_BROWSER",
      ["EXISTING_BROWSER_CONTRACTS"],
      existing,
    );
  }
  if (!initial.officialUrl) {
    return inspectionResult(
      input.ordinal,
      "NONE",
      ["NO_CURRENT_BROWSER_CONTRACTS", "NO_TRUSTED_LANDING_PAGE"],
      [],
    );
  }

  const runWithProviderLease =
    dependencies.runWithProviderLease ?? runWithProviderRequestLease;
  const pinnedFetch = dependencies.fetch ?? createProviderContractPinnedFetch();
  const execution = await runWithProviderLease(
    initial.providerFamilyKey,
    async () => {
      const beforeFetch = await loadAuthorizedContext({
        ...input,
        requiredLeaseHeadroomMs: PROVIDER_CONTRACT_REQUIRED_LEASE_HEADROOM_MS,
      });
      if (beforeFetch.outcome !== "ready") {
        return providerContractControlResult(input.ordinal, beforeFetch);
      }
      if (
        beforeFetch.authorityDigest !== initial.authorityDigest ||
        beforeFetch.officialUrl !== initial.officialUrl
      ) {
        return authorityDriftResult(input.ordinal);
      }
      if (beforeFetch.restrictionDetected) {
        return inspectionResult(
          input.ordinal,
          "NONE",
          ["RESTRICTED_SURFACE_DETECTED"],
          [],
        );
      }
      const newlyPersisted = projectBrowserContracts(beforeFetch);
      if (newlyPersisted.length > 0) {
        return inspectionResult(
          input.ordinal,
          "PERSISTED_BROWSER",
          ["EXISTING_BROWSER_CONTRACTS"],
          newlyPersisted,
        );
      }
      const landingUrl = beforeFetch.officialUrl;
      if (!landingUrl) {
        return authorityDriftResult(input.ordinal);
      }
      const authorizeProviderRequest = async () => {
        const current = await loadAuthorizedContext({
          ...input,
          requiredLeaseHeadroomMs: PROVIDER_CONTRACT_REQUIRED_LEASE_HEADROOM_MS,
        });
        return Boolean(
          current.outcome === "ready" &&
          current.authorityDigest === beforeFetch.authorityDigest &&
          current.officialUrl === landingUrl &&
          !current.restrictionDetected &&
          projectBrowserContracts(current).length === 0,
        );
      };
      const inspected = await inspectOneTrustedScript({
        landingUrl,
        bookingUrl: beforeFetch.bookingUrl,
        providerFamilyKey: beforeFetch.providerFamilyKey,
        fetch: pinnedFetch,
        authorizeProviderRequest,
      });
      const afterFetch = await loadAuthorizedContext(input);
      if (
        afterFetch.outcome !== "ready" ||
        afterFetch.authorityDigest !== beforeFetch.authorityDigest ||
        afterFetch.officialUrl !== beforeFetch.officialUrl
      ) {
        return afterFetch.outcome === "ready"
          ? authorityDriftResult(input.ordinal)
          : providerContractControlResult(input.ordinal, afterFetch);
      }
      if (afterFetch.restrictionDetected) {
        return inspectionResult(
          input.ordinal,
          "NONE",
          ["RESTRICTED_SURFACE_DETECTED"],
          [],
        );
      }
      const afterFetchContracts = projectBrowserContracts(afterFetch);
      if (afterFetchContracts.length > 0) {
        return inspectionResult(
          input.ordinal,
          "PERSISTED_BROWSER",
          ["EXISTING_BROWSER_CONTRACTS"],
          afterFetchContracts,
        );
      }
      return inspectionResult(
        input.ordinal,
        inspected.contracts.length > 0 ? "PINNED_SCRIPT" : "NONE",
        ["NO_CURRENT_BROWSER_CONTRACTS", ...inspected.reasonCodes],
        inspected.contracts,
      );
    },
  );
  return execution.acquired
    ? execution.value
    : inspectionResult(
        input.ordinal,
        "NONE",
        ["NO_CURRENT_BROWSER_CONTRACTS", "PROVIDER_LEASE_BUSY"],
        [],
      );
}

export async function loadOwnedProviderContractContext(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  ordinal: number;
  requiredLeaseHeadroomMs?: number;
}): Promise<OwnedProviderContractContext | null> {
  const resolved = await loadOwnedProviderContractContextResult(input);
  return resolved.outcome === "ready" ? resolved : null;
}

export async function loadOwnedProviderContractContextResult(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  ordinal: number;
  requiredLeaseHeadroomMs?: number;
}): Promise<OwnedProviderContractContextResult> {
  validateProviderContractOrdinal(input.ordinal);
  const requiredLeaseHeadroomMs = Math.max(
    0,
    Math.floor(input.requiredLeaseHeadroomMs ?? 0),
  );
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
    },
    select: providerContractBatchSelect,
  });
  if (!batch) {
    return ownershipOrLeaseLostContext();
  }
  const [authorization] = await prisma.$queryRaw<
    Array<{ now: Date; leaseExpiresAt: Date }>
  >(Prisma.sql`
      SELECT
        clock_timestamp() AS "now",
        "leaseExpiresAt" AS "leaseExpiresAt"
      FROM "CourseSupportBatch"
      WHERE "id" = ${input.batchId}
        AND "leaseToken" = ${input.leaseToken}
        AND "ownerThreadId" = ${input.ownerThreadId}
        AND "status"::text IN ('CLAIMED', 'IMPLEMENTING', 'VERIFYING')
      LIMIT 1
    `);
  if (!authorization) {
    return ownershipOrLeaseLostContext();
  }
  if (
    !authorization.now ||
    !Number.isFinite(authorization.now.getTime()) ||
    !authorization.leaseExpiresAt ||
    !Number.isFinite(authorization.leaseExpiresAt.getTime())
  ) {
    throw new ProviderContractInspectionError("AUTHORIZATION_UNAVAILABLE");
  }
  if (authorization.leaseExpiresAt.getTime() <= authorization.now.getTime()) {
    return ownershipOrLeaseLostContext();
  }
  if (
    authorization.leaseExpiresAt.getTime() <=
    authorization.now.getTime() + requiredLeaseHeadroomMs
  ) {
    return {
      outcome: "lease_headroom_insufficient",
      reasonCode: "LEASE_HEADROOM_INSUFFICIENT",
    };
  }
  return resolveOwnedProviderContractContext(
    input.batchId,
    batch,
    input.ordinal,
  );
}

function resolveOwnedProviderContractContext(
  batchId: string,
  batch: ProviderContractBatch,
  ordinal: number,
): OwnedProviderContractContextResult {
  const remediation = readCourseSupportRemediationDirective(batch.summary);
  if (!remediation) {
    return authorityDriftContext();
  }
  const orderedEntries = orderCourseSupportBatchIncidents(batch.incidents);
  const selectedEntry = orderedEntries[ordinal - 1];
  if (!selectedEntry) {
    return routeIneligibleContext("PROVIDER_CONTRACT_ROUTE_INELIGIBLE", null);
  }
  const selectedAttempt = readCourseSupportRemediationClaimAttempt({
    summary: batch.summary,
    courseId: selectedEntry.course.id,
    expectedAttemptCount: orderedEntries.length,
  });
  if (!selectedAttempt) {
    return authorityDriftContext();
  }
  if (
    selectedAttempt.actionPlan &&
    !courseSupportActionPlanAllows(
      selectedAttempt.actionPlan,
      "INSPECT_PROVIDER_CONTRACT",
    )
  ) {
    return routeIneligibleContext(
      "ACTION_PLAN_DISALLOWS_PROVIDER_CONTRACT",
      selectedAttempt.actionPlan.primaryAction,
    );
  }
  const providerContractTechnicallyEligible =
    isCourseSupportProviderContractActionEligible({
      workMode: remediation.workMode,
      playbookStage: remediation.playbookStage,
      allowUnchangedRuntime: remediation.allowUnchangedRuntime,
      requiresImplementationPath: remediation.requiresImplementationPath,
      incidentKind: selectedEntry.incident.kind,
      incidentProviderFamilyKey: selectedEntry.incident.providerFamilyKey,
      courseProviderFamilyKey: selectedEntry.course.providerFamilyKey,
      resolvedProviderFamilyKey: resolveProviderCapability({
        ...selectedEntry.course,
        providerFamilyKey: selectedEntry.incident.providerFamilyKey,
      }).providerFamilyKey,
    });
  if (!providerContractTechnicallyEligible) {
    return selectedAttempt.actionPlan
      ? authorityDriftContext()
      : routeIneligibleContext("PROVIDER_CONTRACT_ROUTE_INELIGIBLE", null);
  }
  const batchProviderFamily = normalizeProviderContractAuthorityFamily(batch.providerFamilyKey);
  const memberAuthorities = orderedEntries.map((candidate, index) =>
    resolveProviderContractBatchMemberAuthority({
      batchId,
      batch,
      batchProviderFamily,
      entry: candidate,
      ordinal: index + 1,
      remediation,
    }),
  );
  if (memberAuthorities.some((candidate) => candidate === null)) {
    return authorityDriftContext();
  }
  const authorizedMembers = memberAuthorities as Array<
    NonNullable<(typeof memberAuthorities)[number]>
  >;
  const selected = authorizedMembers[ordinal - 1];
  if (!selected) {
    return routeIneligibleContext("PROVIDER_CONTRACT_ROUTE_INELIGIBLE", null);
  }
  const { entry, currentProviderSnapshotFingerprint } = selected;

  const browserEvidence = selectCurrentBrowserEvidence(
    entry.course.automationDiscoveries,
    entry.cycle,
    entry.incident.firstSeenAt,
    batch.providerFamilyKey,
    currentProviderSnapshotFingerprint,
  );
  const bookingUrl = selectTrustedBookingLandingUrl(
    entry.course.detectedBookingUrl,
    batch.providerFamilyKey,
  );
  const officialUrl =
    bookingUrl ?? selectTrustedLandingUrl([entry.course.website]);
  const authorityDigest = createHash("sha256")
    .update(
      JSON.stringify({
        batchStatus: batch.status,
        batchBaseSha: batch.baseSha,
        batchReleaseSha: batch.releaseSha,
        batchDeployedAt: batch.deployedAt?.toISOString() ?? null,
        batchProviderFamilyKey: batch.providerFamilyKey,
        batchFailureFingerprint: batch.failureFingerprint,
        selectedOrdinal: ordinal,
        members: authorizedMembers.map((candidate) => candidate.identity),
        remediationWorkMode: remediation.workMode,
        remediationStrategyAction: remediation.strategyAction,
        remediationStage: remediation.playbookStage,
        officialUrl,
      }),
    )
    .digest("hex");
  const evidenceDigest = createHash("sha256")
    .update(
      JSON.stringify({
        createdAt: browserEvidence?.createdAt.toISOString() ?? null,
        contracts: browserEvidence?.contracts ?? [],
        restrictionDetected: browserEvidence?.restrictionDetected ?? false,
      }),
    )
    .digest("hex");
  return {
    outcome: "ready",
    authorityDigest,
    evidenceDigest,
    providerFamilyKey: batch.providerFamilyKey,
    officialUrl,
    bookingUrl,
    browserContracts: browserEvidence?.contracts ?? [],
    restrictionDetected: browserEvidence?.restrictionDetected ?? false,
  };
}

function resolveProviderContractBatchMemberAuthority(input: {
  batchId: string;
  batch: ProviderContractBatch;
  batchProviderFamily: string;
  entry: ProviderContractBatch["incidents"][number];
  ordinal: number;
  remediation: NonNullable<
    ReturnType<typeof readCourseSupportRemediationDirective>
  >;
}) {
  const { batch, entry, remediation } = input;
  const claimedAttempt = readCourseSupportRemediationClaimAttempt({
    summary: batch.summary,
    courseId: entry.course.id,
    expectedAttemptCount: batch.incidents.length,
  });
  const playbook = assessAutomationPlaybook(
    entry.incident.attemptLedger,
    entry.cycle,
  );
  const playbookLedger = parseAutomationPlaybookLedger(
    entry.incident.attemptLedger,
  );
  const currentCyclePlaybookEventCount =
    playbookLedger?.events.filter((event) => event.cycle === entry.cycle)
      .length ?? -1;
  const currentStage = playbook.stages.find(
    (stage) => stage.stage === remediation.playbookStage,
  );
  const monitoringStatus = entry.course.monitoringStatus;
  const currentProviderSnapshotFingerprint =
    buildCourseSupportProviderSnapshotFingerprint(entry.course);
  const courseProviderFamily = normalizeProviderContractAuthorityFamily(
    entry.course.providerFamilyKey,
  );
  const incidentProviderFamily = normalizeProviderContractAuthorityFamily(
    entry.incident.providerFamilyKey,
  );
  const providerContractTechnicallyEligible =
    isCourseSupportProviderContractActionEligible({
      workMode: remediation.workMode,
      playbookStage: remediation.playbookStage,
      allowUnchangedRuntime: remediation.allowUnchangedRuntime,
      requiresImplementationPath: remediation.requiresImplementationPath,
      incidentKind: entry.incident.kind,
      incidentProviderFamilyKey: entry.incident.providerFamilyKey,
      courseProviderFamilyKey: entry.course.providerFamilyKey,
      resolvedProviderFamilyKey: resolveProviderCapability({
        ...entry.course,
        providerFamilyKey: entry.incident.providerFamilyKey,
      }).providerFamilyKey,
    });
  const authoritativeMonitoringDrift = entry.course.monitoringEvents.some(
    (event) =>
      event.occurredAt.getTime() >= batch.createdAt.getTime() &&
      (event.eventType === "CHECK_SUCCEEDED" ||
        event.eventType === "RECOVERED" ||
        event.outcome === "MATCH_FOUND" ||
        event.outcome === "NO_MATCH" ||
        (event.failureFingerprint !== null &&
          event.failureFingerprint !== batch.failureFingerprint)),
  );
  if (
    entry.result !== "PENDING" ||
    entry.cycle !== entry.incident.cycle ||
    entry.incident.status !== "AUTO_INVESTIGATING" ||
    entry.incident.activeBatchId !== input.batchId ||
    entry.incident.resolution !== null ||
    !providerContractTechnicallyEligible ||
    input.batchProviderFamily !== incidentProviderFamily ||
    batch.failureFingerprint !== entry.incident.failureFingerprint ||
    !claimedAttempt ||
    (claimedAttempt.actionPlan !== null &&
      !courseSupportActionPlanAllows(
        claimedAttempt.actionPlan,
        "INSPECT_PROVIDER_CONTRACT",
      )) ||
    claimedAttempt.providerSnapshotFingerprint !==
      currentProviderSnapshotFingerprint ||
    claimedAttempt.failureFingerprint !== batch.failureFingerprint ||
    claimedAttempt.approach.workMode !== remediation.workMode ||
    claimedAttempt.approach.strategyAction !== remediation.strategyAction ||
    claimedAttempt.approach.playbookStage !== remediation.playbookStage ||
    claimedAttempt.playbookEventCountAtClaim !==
      currentCyclePlaybookEventCount ||
    !currentStage ||
    currentStage.status === "STARTED" ||
    monitoringStatus?.state !== "AUTO_INVESTIGATING" ||
    monitoringStatus.failureFingerprint !== batch.failureFingerprint ||
    authoritativeMonitoringDrift ||
    !playbook.valid ||
    playbook.cycle !== entry.cycle ||
    remediation.playbookStage !== playbook.nextStage
  ) {
    return null;
  }
  return {
    entry,
    currentProviderSnapshotFingerprint,
    identity: {
      ordinal: input.ordinal,
      batchEntryId: entry.id,
      batchEntryCreatedAt: entry.createdAt.toISOString(),
      batchEntryCycle: entry.cycle,
      batchEntryResult: entry.result,
      courseId: entry.course.id,
      incidentId: entry.incident.id,
      incidentCycle: entry.incident.cycle,
      incidentStatus: entry.incident.status,
      incidentKind: entry.incident.kind,
      incidentActiveBatchId: entry.incident.activeBatchId,
      incidentResolution: entry.incident.resolution,
      courseProviderFamily,
      incidentProviderFamily,
      incidentFailureFingerprint: entry.incident.failureFingerprint,
      providerSnapshotFingerprint: currentProviderSnapshotFingerprint,
      claimedProviderSnapshotFingerprint:
        claimedAttempt.providerSnapshotFingerprint,
      claimedFailureFingerprint: claimedAttempt.failureFingerprint,
      claimedPlaybookEventCount: claimedAttempt.playbookEventCountAtClaim,
      claimedApproach: claimedAttempt.approach,
      claimedActionPlan: claimedAttempt.actionPlan,
      playbookCycle: playbook.cycle,
      playbookNextStage: playbook.nextStage,
      playbookCurrentStageStatus: currentStage.status,
      monitoringState: monitoringStatus.state,
      monitoringFailureFingerprint: monitoringStatus.failureFingerprint,
    },
  };
}

function normalizeProviderContractAuthorityFamily(value: string) {
  const normalized = normalizeProviderFamilyKey(value);
  if (normalized !== SOURCE_MISSING_PROVIDER_FAMILY) return normalized;
  const bounded = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_-]{1,63}$/u.test(bounded)
    ? bounded
    : SOURCE_MISSING_PROVIDER_FAMILY;
}

function selectCurrentBrowserEvidence(
  discoveries: ProviderContractBatch["incidents"][number]["course"]["automationDiscoveries"],
  incidentCycle: number,
  incidentFirstSeenAt: Date,
  providerFamilyKey: string,
  providerSnapshotFingerprint: string,
) {
  for (const discovery of discoveries) {
    const evidence = asRecord(discovery.evidence);
    const browser = asRecord(evidence.browserInvestigation);
    const observedAt =
      typeof browser.observedAt === "string"
        ? new Date(browser.observedAt)
        : null;
    if (
      browser.incidentCycle !== incidentCycle ||
      !observedAt ||
      !Number.isFinite(observedAt.getTime()) ||
      observedAt.getTime() < incidentFirstSeenAt.getTime()
    ) {
      continue;
    }
    const rawContracts = Array.isArray(browser.networkContracts)
      ? browser.networkContracts.flatMap(readRawBrowserContract)
      : [];
    const barriers = Array.isArray(evidence.accessBarriers)
      ? evidence.accessBarriers
      : [];
    const restrictionDetected =
      browser.restrictedNetworkObserved === true ||
      discovery.automationReason === "ACCOUNT_REQUIRED" ||
      discovery.automationReason === "CAPTCHA_OR_QUEUE" ||
      barriers.length > 0 ||
      rawContracts.some(isRestrictedPersistedBrowserContract);
    // Restrictions remain safety evidence even when an older writer omitted the
    // snapshot fingerprint or the provider projection later changed. Only a
    // newer, exactly snapshot-bound nonrestricted observation can supersede it.
    if (restrictionDetected) {
      return {
        createdAt: discovery.createdAt,
        contracts: [],
        restrictionDetected: true,
      };
    }
    const discoveryProvider = resolveProviderDiscoveryIdentity({
      detectedPlatform: discovery.detectedPlatform,
      bookingUrl: discovery.bookingUrl,
      apiMetadata: discovery.apiMetadata,
      confidence: discovery.confidence,
    });
    if (
      browser.providerSnapshotFingerprint !== providerSnapshotFingerprint ||
      (discoveryProvider &&
        normalizeProviderFamilyKey(discoveryProvider.providerFamilyKey) !==
          normalizeProviderFamilyKey(providerFamilyKey))
    ) {
      continue;
    }
    return {
      createdAt: discovery.createdAt,
      contracts: rawContracts,
      restrictionDetected,
    };
  }
  return null;
}

function isRestrictedPersistedBrowserContract(contract: RawBrowserContract) {
  const classification = classifyBrowserNetworkContractRestriction(contract);
  if (
    contract.status === 401 ||
    contract.status === 403 ||
    contract.status === 429
  ) {
    return true;
  }
  return classification.unsafeMethod || classification.unsafeUrlState;
}

function readRawBrowserContract(value: unknown): RawBrowserContract[] {
  const record = asRecord(value);
  if (
    typeof record.origin !== "string" ||
    typeof record.method !== "string" ||
    typeof record.pathPattern !== "string" ||
    !Array.isArray(record.queryKeys) ||
    !record.queryKeys.every((key) => typeof key === "string") ||
    typeof record.resourceType !== "string" ||
    !(
      record.status === null ||
      (typeof record.status === "number" && Number.isInteger(record.status))
    )
  ) {
    return [];
  }
  return [
    {
      origin: record.origin,
      method: record.method,
      pathPattern: record.pathPattern,
      queryKeys: record.queryKeys as string[],
      resourceType: record.resourceType,
      status: record.status as number | null,
    },
  ];
}

function projectBrowserContracts(context: OwnedProviderContractContext) {
  const officialOrigin = safeOrigin(context.officialUrl);
  const bookingOrigin = safeOrigin(context.bookingUrl);
  return deduplicateContracts(
    context.browserContracts.flatMap((contract) => {
      const method = normalizeReadMethod(contract.method);
      const resourceType = normalizeResourceType(contract.resourceType);
      if (!method || !contractMatchesProviderFamily(contract, context)) {
        return [];
      }
      // Document and static-asset traffic proves only that a page rendered. It is
      // not an actionable provider read contract and must not suppress the
      // bounded script-inspection fallback.
      if (resourceType !== "FETCH" && resourceType !== "XHR") {
        return [];
      }
      const providerSignal = classifyBrowserProviderSignal(
        contract.origin,
        officialOrigin,
        bookingOrigin,
      );
      return [
        buildSanitizedContract({
          method,
          resourceType,
          statusBand: normalizeStatusBand(contract.status),
          pathPattern: contract.pathPattern,
          queryKeys: contract.queryKeys,
          providerSignal,
        }),
      ];
    }),
  );
}

function contractMatchesProviderFamily(
  contract: RawBrowserContract,
  context: OwnedProviderContractContext,
) {
  try {
    const origin = parseProviderContractUrl(contract.origin).origin;
    if (
      origin === safeOrigin(context.officialUrl) ||
      origin === safeOrigin(context.bookingUrl)
    ) {
      return true;
    }
    const family = getKnownProviderFamilyForHostname(new URL(origin).hostname);
    return Boolean(
      family &&
      normalizeProviderFamilyKey(family) ===
        normalizeProviderFamilyKey(context.providerFamilyKey),
    );
  } catch {
    return false;
  }
}

function inspectionResult(
  ordinal: number,
  evidenceSource: "PERSISTED_BROWSER" | "PINNED_SCRIPT" | "NONE",
  reasonCodes: ProviderContractReasonCode[],
  contracts: SanitizedProviderContract[],
) {
  const uniqueReasons = [...new Set(reasonCodes)].slice(0, 8);
  const boundedContracts = deduplicateContracts(contracts);
  return {
    outcome: "ready" as const,
    ordinal: String(ordinal).padStart(2, "0"),
    evidenceSource,
    reasonCodes: uniqueReasons,
    aggregate: {
      contractCount: boundedContracts.length,
      methodCounts: countEnums(
        boundedContracts.map((contract) => contract.method),
      ),
      providerSignalCounts: countEnums(
        boundedContracts.map((contract) => contract.providerSignal),
      ),
      queryKeyCount: boundedContracts.reduce(
        (count, contract) => count + contract.queryKeys.length,
        0,
      ),
      requestBudget: PROVIDER_CONTRACT_MAX_REQUESTS,
      scriptAssetBudget: 1 as const,
      rawBodyRetained: false as const,
      domainEvidenceMutated: false as const,
      playbookStageSatisfied: false as const,
    },
    contracts: boundedContracts,
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason:
      "Provider-contract inspection is diagnostic and does not complete responder work.",
  };
}

function recoveryRequiredResult() {
  return {
    outcome: "recovery_required" as const,
    reasonCode: "OWNERSHIP_OR_LEASE_LOST" as const,
    contracts: [] as SanitizedProviderContract[],
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "Responder batch ownership or lease freshness was lost.",
  };
}

function authorityDriftResult(ordinal: number) {
  return {
    outcome: "authority_drift" as const,
    ordinal: String(ordinal).padStart(2, "0"),
    reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED" as const,
    contracts: [] as SanitizedProviderContract[],
    packetRefreshRequired: true as const,
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason:
      "The claimed technical action changed; refresh the owned packet before acting.",
  };
}

function providerContractControlResult(
  ordinal: number,
  result: Exclude<
    OwnedProviderContractContextResult,
    OwnedProviderContractContext
  >,
) {
  switch (result.outcome) {
    case "recovery_required":
      return recoveryRequiredResult();
    case "route_ineligible":
      return {
        outcome: "route_ineligible" as const,
        ordinal: String(ordinal).padStart(2, "0"),
        reasonCode: result.reasonCode,
        assignedAction: result.assignedAction,
        contracts: [] as SanitizedProviderContract[],
        packetRefreshRequired: false as const,
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason:
          "Provider-contract inspection is not part of the claimed action plan.",
      };
    case "authority_drift":
      return authorityDriftResult(ordinal);
    case "lease_headroom_insufficient":
      return {
        outcome: "lease_headroom_insufficient" as const,
        ordinal: String(ordinal).padStart(2, "0"),
        reasonCode: result.reasonCode,
        contracts: [] as SanitizedProviderContract[],
        leaseRenewalRequired: true as const,
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason:
          "Renew the current batch lease before bounded provider-contract inspection.",
      };
  }
}

function ownershipOrLeaseLostContext(): OwnedProviderContractContextResult {
  return {
    outcome: "recovery_required",
    reasonCode: "OWNERSHIP_OR_LEASE_LOST",
  };
}

function routeIneligibleContext(
  reasonCode:
    | "ACTION_PLAN_DISALLOWS_PROVIDER_CONTRACT"
    | "PROVIDER_CONTRACT_ROUTE_INELIGIBLE",
  assignedAction: CourseSupportClaimAction | null,
): OwnedProviderContractContextResult {
  return {
    outcome: "route_ineligible",
    reasonCode,
    assignedAction,
  };
}

function authorityDriftContext(): OwnedProviderContractContextResult {
  return {
    outcome: "authority_drift",
    reasonCode: "CLAIMED_TECHNICAL_AUTHORITY_CHANGED",
  };
}

export function validateProviderContractOrdinal(ordinal: number) {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 20) {
    throw new Error(
      "inspect-provider-contract requires --ordinal from 01 through 20.",
    );
  }
}

export function createProviderContractPinnedFetch(
  dependencies: AddressPinnedPublicFetchDependencies = {},
) {
  return createAddressPinnedPublicFetchTransport(
    {
      parseUrl: parseProviderContractUrl,
      maxResponseBytes: PROVIDER_CONTRACT_MAX_SCRIPT_BYTES,
      redirectLimit: 0,
      timeoutMs: PROVIDER_CONTRACT_TIMEOUT_MS,
    },
    dependencies,
  );
}

export async function inspectOneTrustedScript(input: {
  landingUrl: string;
  bookingUrl: string | null;
  providerFamilyKey: string;
  fetch: typeof fetch;
  authorizeProviderRequest: () => Promise<boolean>;
  monotonicNow?: () => number;
}) {
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const budget = {
    requests: 0,
    bytes: 0,
    deadlineAt: monotonicNow() + PROVIDER_CONTRACT_TOTAL_TIMEOUT_MS,
    monotonicNow,
  };
  try {
    const landing = await fetchWithTrustedRedirects({
      fetch: input.fetch,
      initialUrl: parseProviderContractUrl(input.landingUrl),
      expectedContentTypes: new Set(["text/html"]),
      maxBytes: PROVIDER_CONTRACT_MAX_DOCUMENT_BYTES,
      budget,
      authorizeRequest: input.authorizeProviderRequest,
    });
    const landingDocument = analyzeProviderLandingDocument(
      landing.body,
      landing.finalUrl,
    );
    if (landingDocument.restricted) {
      return noScriptContracts("RESTRICTED_SURFACE_DETECTED");
    }
    if (landingDocument.exceeded) {
      return noScriptContracts("ASSET_BUDGET_EXCEEDED");
    }
    const scriptUrl = landingDocument.urls[0];
    if (!scriptUrl) {
      return noScriptContracts("NO_TRUSTED_SCRIPT");
    }
    const script = await fetchWithTrustedRedirects({
      fetch: input.fetch,
      initialUrl: scriptUrl,
      expectedContentTypes: SCRIPT_CONTENT_TYPES,
      maxBytes: PROVIDER_CONTRACT_MAX_SCRIPT_BYTES,
      budget,
      requiredOrigin: landing.finalUrl.origin,
      authorizeRequest: input.authorizeProviderRequest,
    });
    const analysis = analyzeContractFingerprintsFromScript({
      source: script.body,
      officialOrigin: landing.finalUrl.origin,
      bookingOrigin: safeOrigin(input.bookingUrl),
      providerFamilyKey: input.providerFamilyKey,
    });
    if (analysis.restrictionDetected) {
      return noScriptContracts("RESTRICTED_SURFACE_DETECTED");
    }
    return analysis.contracts.length > 0
      ? {
          reasonCodes: [
            "PINNED_SCRIPT_CONTRACTS",
          ] as ProviderContractReasonCode[],
          contracts: analysis.contracts,
        }
      : noScriptContracts("NO_SAFE_CONTRACT_SIGNAL");
  } catch (error) {
    return noScriptContracts(classifyInspectionFailure(error));
  }
}

type TrustedFetchResult = {
  finalUrl: URL;
  body: string;
};

async function fetchWithTrustedRedirects(input: {
  fetch: typeof fetch;
  initialUrl: URL;
  expectedContentTypes: ReadonlySet<string>;
  maxBytes: number;
  budget: {
    requests: number;
    bytes: number;
    deadlineAt: number;
    monotonicNow: () => number;
  };
  requiredOrigin?: string;
  authorizeRequest?: () => Promise<boolean>;
}): Promise<TrustedFetchResult> {
  let currentUrl = input.initialUrl;
  const originalUrl = input.initialUrl;
  let resourceBytes = 0;
  const readBudgetedBody = async (response: Response) => {
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (
      !Number.isFinite(contentLength) ||
      contentLength < 0 ||
      contentLength > input.maxBytes - resourceBytes ||
      contentLength > PROVIDER_CONTRACT_MAX_TOTAL_BYTES - input.budget.bytes
    ) {
      throw new ProviderContractInspectionError("OVERSIZE_RESPONSE");
    }
    const body = await response.text();
    const bodyBytes = Buffer.byteLength(body, "utf8");
    resourceBytes += bodyBytes;
    input.budget.bytes += bodyBytes;
    if (
      resourceBytes > input.maxBytes ||
      input.budget.bytes > PROVIDER_CONTRACT_MAX_TOTAL_BYTES
    ) {
      throw new ProviderContractInspectionError("OVERSIZE_RESPONSE");
    }
    if (input.budget.monotonicNow() > input.budget.deadlineAt) {
      throw new ProviderContractInspectionError("REQUEST_BUDGET_EXCEEDED");
    }
    return body;
  };
  for (
    let redirectCount = 0;
    redirectCount <= PROVIDER_CONTRACT_MAX_REDIRECTS;
    redirectCount += 1
  ) {
    if (input.requiredOrigin && currentUrl.origin !== input.requiredOrigin) {
      throw new ProviderContractInspectionError("UNSAFE_REDIRECT");
    }
    if (input.authorizeRequest && !(await input.authorizeRequest())) {
      throw new ProviderContractInspectionError("OWNERSHIP_OR_ROUTE_CHANGED");
    }
    const remainingMs = Math.floor(
      input.budget.deadlineAt - input.budget.monotonicNow(),
    );
    if (remainingMs < 1) {
      throw new ProviderContractInspectionError("REQUEST_BUDGET_EXCEEDED");
    }
    input.budget.requests += 1;
    if (input.budget.requests > PROVIDER_CONTRACT_MAX_REQUESTS) {
      throw new ProviderContractInspectionError("REQUEST_BUDGET_EXCEEDED");
    }
    const response = await input.fetch(currentUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: {
        accept: [...input.expectedContentTypes].join(", "),
      },
      signal: AbortSignal.timeout(remainingMs),
    });
    // Every response consumes the same per-resource and aggregate byte budget,
    // including redirects and rejected final statuses/content types.
    const body = await readBudgetedBody(response);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount >= PROVIDER_CONTRACT_MAX_REDIRECTS) {
        throw new ProviderContractInspectionError("UNSAFE_REDIRECT");
      }
      let redirected: URL;
      try {
        redirected = parseProviderContractUrl(
          new URL(location, currentUrl).toString(),
        );
      } catch {
        throw new ProviderContractInspectionError("UNSAFE_REDIRECT");
      }
      if (!isTrustedRedirect(originalUrl, currentUrl, redirected)) {
        throw new ProviderContractInspectionError("UNSAFE_REDIRECT");
      }
      currentUrl = redirected;
      continue;
    }
    if (response.status !== 200) {
      throw new ProviderContractInspectionError("HTTP_STATUS_REJECTED");
    }
    const contentType = normalizeContentType(
      response.headers.get("content-type"),
    );
    if (!contentType || !input.expectedContentTypes.has(contentType)) {
      throw new ProviderContractInspectionError("BAD_CONTENT_TYPE");
    }
    return { finalUrl: currentUrl, body };
  }
  throw new ProviderContractInspectionError("UNSAFE_REDIRECT");
}

function scoreScriptCandidate(url: URL) {
  const pathname = url.pathname.toLocaleLowerCase("en-US");
  const preferred =
    /(?:^|[./_-])(?:app|booking|course|index|main|page|tee)(?:[./_-]|$)/u.test(
      pathname,
    );
  const infrastructure =
    /(?:^|[./_-])(?:framework|polyfills?|runtime|vendor|webpack)(?:[./_-]|$)/u.test(
      pathname,
    );
  return (preferred ? 100 : 0) - (infrastructure ? 100 : 0);
}

export function extractContractFingerprintsFromScript(input: {
  source: string;
  officialOrigin: string;
  bookingOrigin: string | null;
  providerFamilyKey: string;
}) {
  return analyzeContractFingerprintsFromScript(input).contracts;
}

function analyzeContractFingerprintsFromScript(input: {
  source: string;
  officialOrigin: string;
  bookingOrigin: string | null;
  providerFamilyKey: string;
}) {
  const boundedSource = input.source.slice(
    0,
    PROVIDER_CONTRACT_MAX_SCRIPT_BYTES,
  );
  const staticReads = collectProvenStaticReadCandidates(boundedSource);
  const recognizedReadUrls = staticReads.recognizedReadUrls;
  let restrictionDetected = recognizedReadUrls.some((raw) =>
    isRestrictedStaticContractCandidate(raw, input),
  );
  const contracts = staticReads.candidates.flatMap((candidate) => {
    const relative = readSafeStaticRelativePath(candidate.raw);
    if (
      (candidate.raw.startsWith("/") && !relative) ||
      hasDynamicStaticAuthority(candidate.raw)
    ) {
      return [];
    }
    const dynamicQueryKey = hasDynamicStaticQueryKey(candidate.raw);
    const raw = candidate.raw.replace(/\$\{[^}]*\}/gu, "value");
    const parsed = parseStaticContractUrl(raw, input.officialOrigin);
    if (!parsed) {
      return [];
    }
    const providerSignal = classifyScriptProviderSignal(
      parsed,
      input.officialOrigin,
      input.bookingOrigin,
      relative,
      input.providerFamilyKey,
    );
    if (!providerSignal) {
      return [];
    }
    if (dynamicQueryKey || !isSafeManualEvidenceUrl(parsed)) {
      restrictionDetected = true;
      return [];
    }
    const method = normalizeReadMethod(candidate.method);
    if (!method) {
      return [];
    }
    return [
      buildSanitizedContract({
        method,
        resourceType: normalizeResourceType(candidate.resourceType),
        statusBand: "UNKNOWN",
        pathPattern: parsed.pathname,
        queryKeys: [...parsed.searchParams.keys()],
        providerSignal,
      }),
    ];
  });
  return { contracts: deduplicateContracts(contracts), restrictionDetected };
}

function isRestrictedStaticContractCandidate(
  rawCandidate: string,
  input: {
    officialOrigin: string;
    bookingOrigin: string | null;
    providerFamilyKey: string;
  },
) {
  const relative = readSafeStaticRelativePath(rawCandidate);
  if (
    (rawCandidate.startsWith("/") && !relative) ||
    hasDynamicStaticAuthority(rawCandidate)
  ) {
    return false;
  }
  const parsed = parseStaticContractUrl(
    rawCandidate.replace(/\$\{[^}]*\}/gu, "value"),
    input.officialOrigin,
  );
  if (
    !parsed ||
    !classifyScriptProviderSignal(
      parsed,
      input.officialOrigin,
      input.bookingOrigin,
      relative,
      input.providerFamilyKey,
    )
  ) {
    return false;
  }
  return hasDynamicStaticQueryKey(rawCandidate) || !isSafeManualEvidenceUrl(parsed);
}

type StaticReadCandidate = {
  raw: string;
  method: ProviderContractMethod;
  resourceType: "FETCH";
};

function collectProvenStaticReadCandidates(source: string) {
  try {
    parseEcmaScript(source, {
      ecmaVersion: "latest",
      sourceType: "script",
    });
  } catch {
    return {
      recognizedReadUrls: [] as string[],
      candidates: [] as StaticReadCandidate[],
    };
  }
  const sourceFile = ts.createSourceFile(
    "provider-contract.js",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  if (parseDiagnostics?.length) {
    return {
      recognizedReadUrls: [] as string[],
      candidates: [] as StaticReadCandidate[],
    };
  }

  const provenProgram = sourceFile.statements.every((statement) =>
    isProvenStaticReadProgramStatement(statement),
  );
  const recognizedReadUrls: string[] = [];
  const candidates: StaticReadCandidate[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && !node.questionDotToken) {
      const fetchCall =
        ts.isIdentifier(node.expression) && node.expression.text === "fetch";
      const axiosMethod = readStaticAxiosMethod(node.expression);
      if (fetchCall || axiosMethod) {
        const raw = readStaticUrlArgument(node.arguments[0]);
        if (raw) {
          recognizedReadUrls.push(raw);
          if (fetchCall && provenProgram) {
            const method = readHarmlessFetchOptions(node.arguments);
            if (method) {
              candidates.push({ raw, method, resourceType: "FETCH" });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (recognizedReadUrls.length > 100 || candidates.length > 100) {
    return {
      recognizedReadUrls: [] as string[],
      candidates: [] as StaticReadCandidate[],
    };
  }
  return {
    recognizedReadUrls,
    candidates,
  };
}

function isProvenStaticReadProgramStatement(statement: ts.Statement) {
  if (ts.isEmptyStatement(statement)) return true;
  if (!ts.isExpressionStatement(statement)) return false;
  if (ts.isStringLiteralLike(statement.expression)) return true;
  if (
    !ts.isCallExpression(statement.expression) ||
    statement.expression.questionDotToken ||
    !ts.isIdentifier(statement.expression.expression) ||
    statement.expression.expression.text !== "fetch" ||
    !readStaticUrlArgument(statement.expression.arguments[0])
  ) {
    return false;
  }
  return Boolean(
    readHarmlessFetchOptions(statement.expression.arguments) ||
    hasExplicitStaticNonReadFetchOptions(statement.expression.arguments),
  );
}

function hasExplicitStaticNonReadFetchOptions(
  args: ts.NodeArray<ts.Expression>,
) {
  if (args.length !== 2 || !ts.isObjectLiteralExpression(args[1])) {
    return false;
  }
  const method = args[1].properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      isStaticPropertyName(property.name, "method"),
  );
  return Boolean(
    method &&
    ts.isStringLiteral(method.initializer) &&
    ["POST", "PUT", "PATCH", "DELETE"].includes(
      method.initializer.text.toUpperCase(),
    ) &&
    isSideEffectFreeStaticObjectLiteral(args[1]),
  );
}

function isSideEffectFreeStaticObjectLiteral(
  value: ts.ObjectLiteralExpression,
) {
  const names = new Set<string>();
  for (const property of value.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      ts.isComputedPropertyName(property.name) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
    ) {
      return false;
    }
    const name = property.name.text;
    if (name === "__proto__" || names.has(name)) {
      return false;
    }
    names.add(name);
    if (!isSideEffectFreeStaticValue(property.initializer)) {
      return false;
    }
  }
  return true;
}

function isSideEffectFreeStaticValue(value: ts.Expression): boolean {
  if (
    ts.isIdentifier(value) ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every(
      (element) =>
        !ts.isSpreadElement(element) && isSideEffectFreeStaticValue(element),
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return isSideEffectFreeStaticObjectLiteral(value);
  }
  return false;
}

function readStaticAxiosMethod(expression: ts.LeftHandSideExpression) {
  if (
    !ts.isPropertyAccessExpression(expression) ||
    expression.questionDotToken ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "axios"
  ) {
    return null;
  }
  return normalizeReadMethod(expression.name.text);
}

function readStaticUrlArgument(argument: ts.Expression | undefined) {
  if (!argument) return null;
  let cooked: string;
  if (
    ts.isStringLiteral(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument)
  ) {
    cooked = argument.text;
  } else if (
    ts.isTemplateExpression(argument) &&
    argument.templateSpans.every((span) => ts.isIdentifier(span.expression))
  ) {
    cooked = argument.head.text;
    for (const span of argument.templateSpans) {
      cooked += `\${value}${span.literal.text}`;
    }
  } else {
    return null;
  }
  return Buffer.byteLength(cooked, "utf8") <= 300 &&
    /^(?:https?:\/\/|\/)[^"'`\s\\]{1,300}$/iu.test(cooked)
    ? cooked
    : null;
}

function readHarmlessFetchOptions(
  args: ts.NodeArray<ts.Expression>,
): ProviderContractMethod | null {
  if (args.length === 1) return "GET";
  if (args.length !== 2 || !ts.isObjectLiteralExpression(args[1])) return null;
  const properties = args[1].properties;
  if (properties.length === 0) return "GET";
  if (properties.length !== 1 || !ts.isPropertyAssignment(properties[0])) {
    return null;
  }
  const property = properties[0];
  if (
    property.name === undefined ||
    !isStaticPropertyName(property.name, "method") ||
    !ts.isStringLiteral(property.initializer)
  ) {
    return null;
  }
  return normalizeReadMethod(property.initializer.text);
}

function isStaticPropertyName(name: ts.PropertyName, expected: string) {
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
    name.text === expected;
}

function readSafeStaticRelativePath(raw: string) {
  if (!/^\/(?!\/)/u.test(raw)) {
    return false;
  }
  const firstSegment = raw.slice(1).split(/[/?#]/u, 1)[0] ?? "";
  return Boolean(
    firstSegment &&
    !firstSegment.includes("${") &&
    !/%(?:2f|5c)/iu.test(firstSegment),
  );
}

function hasDynamicStaticAuthority(raw: string) {
  const authority = raw.match(/^https?:\/\/([^/?#]*)/iu)?.[1];
  return Boolean(authority?.includes("${"));
}

function hasDynamicStaticQueryKey(raw: string) {
  const queryStart = raw.indexOf("?");
  if (queryStart < 0) return false;
  return raw
    .slice(queryStart + 1)
    .split("#", 1)[0]
    .split("&")
    .some((part) => part.split("=", 1)[0]?.includes("${"));
}

type ParsedLandingElement = DefaultTreeAdapterMap["element"];

function analyzeProviderLandingDocument(html: string, finalUrl: URL) {
  const bounded = html.slice(0, PROVIDER_CONTRACT_MAX_DOCUMENT_BYTES);
  const parseErrors: ParserError[] = [];
  let fragment: DefaultTreeAdapterMap["documentFragment"];
  try {
    fragment = parseFragment(bounded, {
      sourceCodeLocationInfo: true,
      onParseError: (error) => parseErrors.push(error),
    });
  } catch {
    return restrictedLandingDocument();
  }
  const elements: ParsedLandingElement[] = [];
  const titleText: string[] = [];
  const visibleText: string[] = [];
  const attributeSignals: string[] = [];
  let titleTextLength = 0;
  let visibleTextLength = 0;
  let attributeSignalLength = 0;
  const visit = (
    node: DefaultTreeAdapterMap["node"],
    insideTitle = false,
    inertText = false,
  ) => {
    if (node.nodeName === "#text") {
      const value = (node as DefaultTreeAdapterMap["textNode"]).value;
      if (insideTitle) {
        titleTextLength += value.length;
        if (titleTextLength > 4_000) {
          throw new Error("oversize landing title");
        }
        titleText.push(value);
      } else if (!inertText && value.trim()) {
        visibleTextLength += value.length;
        if (visibleTextLength > 128_000) {
          throw new Error("oversize landing text");
        }
        visibleText.push(value);
      }
      return;
    }
    let childInsideTitle = insideTitle;
    let childInertText = inertText;
    if ("tagName" in node) {
      childInsideTitle = insideTitle || node.tagName === "title";
      childInertText =
        inertText ||
        ["script", "style", "template", "noscript"].includes(node.tagName);
      if (!inertText) {
        elements.push(node);
      }
      if (
        !inertText &&
        [
          "base",
          "button",
          "form",
          "frame",
          "iframe",
          "input",
          "meta",
          "script",
        ].includes(node.tagName)
      ) {
        const location = node.sourceCodeLocation?.startTag;
        const maxChars = ["base", "input"].includes(node.tagName)
          ? 2_000
          : 4_000;
        if (!location || location.endOffset - location.startOffset > maxChars) {
          throw new Error("invalid bounded landing element");
        }
      }
      for (const attribute of node.attrs) {
        if (!["class", "id", "src"].includes(attribute.name)) continue;
        const maxChars = attribute.name === "src" ? 2_000 : 4_000;
        if (attribute.value.length > maxChars) {
          throw new Error("oversize landing signal attribute");
        }
        attributeSignalLength += attribute.value.length;
        if (attributeSignalLength > 64_000) {
          throw new Error("oversize landing signal attributes");
        }
        attributeSignals.push(attribute.value);
      }
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        visit(child, childInsideTitle, childInertText);
      }
    }
    if ("content" in node) visit(node.content, false, true);
  };
  try {
    visit(fragment);
  } catch {
    return restrictedLandingDocument();
  }
  if (parseErrors.some((error) => error.code === "eof-in-tag")) {
    return restrictedLandingDocument();
  }

  let effectiveBaseUrl = finalUrl;
  const baseElement = elements.find(
    (element) =>
      isHtmlLandingElement(element) &&
      element.tagName === "base" &&
      readParsedHtmlAttribute(element, "href") !== null,
  );
  if (baseElement) {
    const resolved = resolveSafeLandingTarget(
      readParsedHtmlAttribute(baseElement, "href"),
      finalUrl,
    );
    if (!resolved) return restrictedLandingDocument();
    effectiveBaseUrl = resolved;
  }

  const challengeSignal = [
    ...titleText,
    ...visibleText,
    ...attributeSignals,
  ].join(" ");
  if (
    /(?:cf[-_]?chl|(?:g[-_])?recaptcha|h[-_]?captcha|captcha|challenge|turnstile|queue[-_\s]?it|waiting[-_\s]+room|arkose|funcaptcha|challenges\.cloudflare\.com)/iu.test(
      challengeSignal,
    ) ||
    /\b(?:challenge(?:\s+required)?|captcha(?:\s+required)?|create\s+(?:an?\s+)?account|register|auth(?:entication)?\s+required|verify\s+(?:your\s+)?identity|checkout|payment|sign\s*in|log\s*in|waiting\s+room)\b/iu.test(
      [...titleText, ...visibleText].join(" "),
    )
  ) {
    return restrictedLandingDocument();
  }

  for (const element of elements) {
    if (!isHtmlLandingElement(element)) continue;
    if (
      element.tagName === "input" &&
      readParsedHtmlAttribute(element, "type")?.toLowerCase() === "password"
    ) {
      return restrictedLandingDocument();
    }
    const actionAttribute =
      element.tagName === "form"
        ? "action"
        : element.tagName === "button" || element.tagName === "input"
          ? "formaction"
          : null;
    if (actionAttribute) {
      const action = readParsedHtmlAttribute(element, actionAttribute);
      if (
        action !== null &&
        !resolveSafeLandingTarget(action, effectiveBaseUrl)
      ) {
        return restrictedLandingDocument();
      }
    }
    if (
      ["frame", "iframe", "script"].includes(element.tagName) &&
      readParsedHtmlAttribute(element, "src") !== null &&
      !resolveSafeLandingTarget(
        readParsedHtmlAttribute(element, "src"),
        effectiveBaseUrl,
      )
    ) {
      return restrictedLandingDocument();
    }
    if (
      element.tagName === "meta" &&
      readParsedHtmlAttribute(element, "http-equiv")?.toLowerCase() ===
        "refresh"
    ) {
      return restrictedLandingDocument();
    }
  }

  const executableScripts = elements.filter(
    (element) =>
      isHtmlLandingElement(element) &&
      element.tagName === "script" &&
      readParsedHtmlAttribute(element, "src") !== null &&
      isExecutableLandingScriptType(readParsedHtmlAttribute(element, "type")),
  );
  const exceeded =
    executableScripts.length > PROVIDER_CONTRACT_MAX_SCRIPT_CANDIDATES;
  const seen = new Set<string>();
  const urls = executableScripts
    .slice(0, PROVIDER_CONTRACT_MAX_SCRIPT_CANDIDATES)
    .flatMap((element, index) => {
      const resolved = resolveSafeLandingTarget(
        readParsedHtmlAttribute(element, "src"),
        effectiveBaseUrl,
      );
      if (
        !resolved ||
        resolved.origin !== finalUrl.origin ||
        !/\.(?:js|mjs)$/iu.test(resolved.pathname) ||
        /\.map$/iu.test(resolved.pathname) ||
        seen.has(resolved.toString())
      ) {
        return [];
      }
      seen.add(resolved.toString());
      return [{ url: resolved, index, score: scoreScriptCandidate(resolved) }];
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((candidate) => candidate.url);
  return { restricted: false, exceeded, urls };
}

function readParsedHtmlAttribute(
  element: ParsedLandingElement,
  attribute: string,
) {
  return element.attrs.find((candidate) => candidate.name === attribute)?.value ??
    null;
}

function isHtmlLandingElement(element: ParsedLandingElement) {
  return element.namespaceURI === "http://www.w3.org/1999/xhtml";
}

function resolveSafeLandingTarget(value: string | null, baseUrl: URL) {
  if (value === null) return null;
  try {
    const resolved = new URL(value, baseUrl);
    if (!isSafeManualEvidenceUrl(resolved)) return null;
    resolved.hash = "";
    return resolved;
  } catch {
    return null;
  }
}

function isExecutableLandingScriptType(value: string | null) {
  if (!value) return true;
  return [
    "application/ecmascript",
    "application/javascript",
    "module",
    "text/ecmascript",
    "text/javascript",
  ].includes(value.trim().toLowerCase());
}

function restrictedLandingDocument() {
  return { restricted: true, exceeded: false, urls: [] as URL[] };
}

function parseStaticContractUrl(raw: string, officialOrigin: string) {
  try {
    return new URL(raw, officialOrigin);
  } catch {
    return null;
  }
}

function buildSanitizedContract(
  input: Omit<
    SanitizedProviderContract,
    "digest" | "pathPattern" | "queryKeys"
  > & {
    pathPattern: string;
    queryKeys: string[];
  },
): SanitizedProviderContract {
  const contract = {
    method: input.method,
    resourceType: input.resourceType,
    statusBand: input.statusBand,
    pathPattern: sanitizeContractPath(input.pathPattern),
    queryKeys: normalizeQueryKeys(input.queryKeys),
    providerSignal: input.providerSignal,
  };
  return {
    ...contract,
    digest: createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
  };
}

export function sanitizeContractPath(value: string) {
  let pathname = value;
  try {
    pathname = new URL(value, "https://contract.invalid").pathname;
  } catch {
    pathname = "/";
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 12)
    .map((segment) => {
      const decoded = safeDecode(segment)
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/[_\s]+/gu, "-")
        .replace(/[^a-z0-9-]/gu, "");
      if (!decoded) {
        return "{segment}";
      }
      if (/^v\d{1,2}$/u.test(decoded)) {
        return decoded;
      }
      return SAFE_PATH_SEGMENTS.get(decoded) ?? "{segment}";
    })
    .filter(
      (segment, index, values) =>
        segment !== "{segment}" || values[index - 1] !== "{segment}",
    );
  return `/${segments.join("/")}`.slice(0, 160) || "/";
}

function normalizeQueryKeys(keys: string[]) {
  return [
    ...new Set(
      keys.slice(0, 30).map((key): ProviderContractQueryKey => {
        const normalized = key
          .normalize("NFKC")
          .toLocaleLowerCase("en-US")
          .replace(/[^a-z0-9]/gu, "");
        if (["date", "day", "playdate"].includes(normalized)) return "DATE";
        if (["startdate", "fromdate", "begindate"].includes(normalized))
          return "START_DATE";
        if (["enddate", "todate"].includes(normalized)) return "END_DATE";
        if (
          ["players", "playercount", "party", "partysize"].includes(normalized)
        )
          return "PLAYERS";
        if (["holes", "holecount"].includes(normalized)) return "HOLES";
        if (["courseid", "course"].includes(normalized)) return "COURSE_ID";
        if (["facilityid", "facility"].includes(normalized))
          return "FACILITY_ID";
        if (["locationid", "location"].includes(normalized))
          return "LOCATION_ID";
        if (["timezone", "tz"].includes(normalized)) return "TIMEZONE";
        if (["limit", "pagesize"].includes(normalized)) return "LIMIT";
        if (["offset", "skip"].includes(normalized)) return "OFFSET";
        if (["page", "pagenumber"].includes(normalized)) return "PAGE";
        return "OTHER";
      }),
    ),
  ].sort();
}

function classifyBrowserProviderSignal(
  origin: string,
  officialOrigin: string | null,
  bookingOrigin: string | null,
): ProviderContractSignal {
  if (origin === officialOrigin) return "OFFICIAL_ORIGIN";
  if (origin === bookingOrigin) return "BOOKING_ORIGIN";
  try {
    if (isProviderInfrastructureUrl(origin)) {
      return "KNOWN_PROVIDER_INFRASTRUCTURE";
    }
  } catch {
    // The persisted browser contract already passed its own URL sanitizer.
  }
  return "TRUSTED_BROWSER_ORIGIN";
}

function classifyScriptProviderSignal(
  url: URL,
  officialOrigin: string,
  bookingOrigin: string | null,
  relative: boolean,
  providerFamilyKey: string,
): ProviderContractSignal | null {
  if (relative && url.origin === officialOrigin) {
    return "TRUSTED_SCRIPT_RELATIVE";
  }
  if (url.origin === officialOrigin) return "OFFICIAL_ORIGIN";
  if (url.origin === bookingOrigin) return "BOOKING_ORIGIN";
  const candidateFamily = getKnownProviderFamilyForHostname(url.hostname);
  return candidateFamily &&
    normalizeProviderFamilyKey(candidateFamily) ===
      normalizeProviderFamilyKey(providerFamilyKey)
    ? "KNOWN_PROVIDER_INFRASTRUCTURE"
    : null;
}

function selectTrustedLandingUrl(values: Array<string | null>) {
  for (const value of values) {
    if (!value) continue;
    try {
      const url = parseProviderContractUrl(value);
      url.hash = "";
      return url.toString();
    } catch {
      // Continue to the next server-derived candidate.
    }
  }
  return null;
}

function selectTrustedBookingLandingUrl(
  value: string | null,
  providerFamilyKey: string,
) {
  if (!value) return null;
  try {
    const url = parseProviderContractUrl(value);
    const expectedFamily = normalizeProviderFamilyKey(providerFamilyKey);
    const knownFamily = getKnownProviderFamilyForHostname(url.hostname);
    const familyMatches = knownFamily
      ? normalizeProviderFamilyKey(knownFamily) === expectedFamily
      : normalizeProviderFamilyKey(url.hostname) === expectedFamily;
    if (
      !familyMatches ||
      (knownFamily
        ? !isProviderPublicBookingLandingUrl(url)
        : url.protocol !== "https:" || isProviderInfrastructureUrl(url))
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseProviderContractUrl(value: string) {
  const url = new URL(value);
  if (!isSafeManualEvidenceUrl(url)) {
    throw new ProviderContractInspectionError("UNSAFE_NETWORK_TARGET");
  }
  return url;
}

function isTrustedRedirect(original: URL, current: URL, redirected: URL) {
  return (
    redirected.hostname === original.hostname &&
    redirected.hostname === current.hostname &&
    redirected.port === original.port &&
    !(current.protocol === "https:" && redirected.protocol !== "https:")
  );
}

function safeOrigin(value: string | null) {
  if (!value) return null;
  try {
    return parseProviderContractUrl(value).origin;
  } catch {
    return null;
  }
}

function normalizeReadMethod(value: string): ProviderContractMethod | null {
  const normalized = value.toUpperCase();
  return READ_METHODS.has(normalized as ProviderContractMethod)
    ? (normalized as ProviderContractMethod)
    : null;
}

function normalizeResourceType(value: string): ProviderContractResourceType {
  const normalized = value.toUpperCase();
  if (["DOCUMENT", "FETCH", "XHR", "SCRIPT"].includes(normalized)) {
    return normalized as ProviderContractResourceType;
  }
  return "OTHER";
}

function normalizeStatusBand(
  status: number | null,
): ProviderContractStatusBand {
  if (!status) return "UNKNOWN";
  if (status >= 200 && status < 300) return "SUCCESS";
  if (status >= 300 && status < 400) return "REDIRECT";
  if (status >= 400 && status < 500) return "CLIENT_ERROR";
  if (status >= 500 && status < 600) return "SERVER_ERROR";
  return "UNKNOWN";
}

function normalizeContentType(value: string | null) {
  return value?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? null;
}

function deduplicateContracts(contracts: SanitizedProviderContract[]) {
  return [
    ...new Map(
      contracts.map((contract) => [contract.digest, contract]),
    ).values(),
  ]
    .sort((left, right) => left.digest.localeCompare(right.digest))
    .slice(0, PROVIDER_CONTRACT_MAX_CONTRACTS);
}

function noScriptContracts(reasonCode: ProviderContractReasonCode) {
  return {
    reasonCodes: [reasonCode],
    contracts: [] as SanitizedProviderContract[],
  };
}

function classifyInspectionFailure(error: unknown): ProviderContractReasonCode {
  if (error instanceof ProviderContractInspectionError) {
    return error.reasonCode;
  }
  const errorRecord = asRecord(error);
  const errorName =
    error instanceof Error
      ? error.name
      : typeof errorRecord.name === "string"
        ? errorRecord.name
        : "";
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof errorRecord.message === "string"
        ? errorRecord.message.toLowerCase()
        : "";
  if (
    errorName === "AbortError" ||
    errorName === "TimeoutError" ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return "REQUEST_BUDGET_EXCEEDED";
  }
  if (
    message.includes("non-public network") ||
    message.includes("safe public")
  ) {
    return "UNSAFE_NETWORK_TARGET";
  }
  if (message.includes("too large")) return "OVERSIZE_RESPONSE";
  if (message.includes("redirect")) return "UNSAFE_REDIRECT";
  return "UNSAFE_NETWORK_TARGET";
}

class ProviderContractInspectionError extends Error {
  constructor(readonly reasonCode: ProviderContractReasonCode) {
    super(reasonCode);
    this.name = "ProviderContractInspectionError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function countEnums(values: string[]) {
  return Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((value) => [
        value,
        values.filter((candidate) => candidate === value).length,
      ]),
  );
}
