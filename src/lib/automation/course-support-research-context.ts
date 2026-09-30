import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { isQuick18Metadata, isQuick18PublicSearchUrl } from "../adapters/quick18";
import { isSafeManualEvidenceUrl } from "./browser-discovery";
import { assessAutomationPlaybook, parseAutomationPlaybookLedger } from "./course-monitoring-playbook";
import { acquireCourseMonitoringWriteLockInTransaction } from "./course-monitoring";
import {
  orderCourseSupportBatchIncidents,
  readCourseSupportRemediationClaimAttempt,
  readCourseSupportRemediationDirective,
} from "./course-support-batches";
import { courseSupportActionPlanMatchesRoute } from "./course-support-action-plan";
import { courseSupportFailureFingerprintsMatch } from "./course-support-failure-fingerprint";
import {
  appendCourseSupportLineage,
  COURSE_SUPPORT_LINEAGE_EVENT_LIMIT,
  isCourseSupportLineageThreadRef,
  readCourseSupportLineage,
} from "./course-support-lineage";
import {
  buildSanitizedProviderContract,
  selectCurrentBrowserProviderContractEvidence,
  type SanitizedProviderContract,
} from "./course-support-provider-contract-evidence";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import { prisma } from "../prisma";

const RESEARCH_CONTEXT_VERSION = 1;
const ACTIVE_BATCH_STATUSES = ["CLAIMED", "IMPLEMENTING", "VERIFYING"] as const;
const MAX_RESEARCH_ORDINAL = 20;

const researchBatchSelect = {
  revision: true,
  reference: true,
  status: true,
  providerFamilyKey: true,
  failureFingerprint: true,
  summary: true,
  createdAt: true,
  leaseExpiresAt: true,
  incidents: {
    orderBy: [{ course: { name: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
      cycle: true,
      result: true,
      course: {
        select: {
          id: true,
          googlePlaceId: true,
          name: true,
          address: true,
          city: true,
          stateCode: true,
          latitude: true,
          longitude: true,
          timeZone: true,
          website: true,
          detectedBookingUrl: true,
          detectedPlatform: true,
          providerFamilyKey: true,
          bookingMethod: true,
          bookingWindowDaysAhead: true,
          bookingWindowEvidenceUrl: true,
          bookingReleaseTimeLocal: true,
          bookingWindowSource: true,
          bookingWindowConfidence: true,
          automationEligibility: true,
          automationReason: true,
          monitoringMode: true,
          bookingAccessMode: true,
          isPublic: true,
          intelligenceVerifiedAt: true,
          intelligenceReviewAt: true,
          intelligenceConfidence: true,
          bookingMetadata: true,
          layoutHoleCounts: true,
          layoutHolesVerifiedAt: true,
          monitoringStatus: {
            select: { state: true, failureFingerprint: true },
          },
          monitoringEvents: {
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            take: 8,
            select: {
              incidentId: true,
              eventType: true,
              outcome: true,
              readPath: true,
              failureFingerprint: true,
              occurredAt: true,
            },
          },
          automationDiscoveries: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 12,
            select: {
              status: true,
              sourceUrl: true,
              bookingUrl: true,
              detectedPlatform: true,
              automationReason: true,
              apiMetadata: true,
              confidence: true,
              evidence: true,
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
          attemptLedger: true,
          firstSeenAt: true,
          confirmedAt: true,
          resolution: true,
        },
      },
    },
  },
} satisfies Prisma.CourseSupportBatchSelect;

type ResearchBatch = Prisma.CourseSupportBatchGetPayload<{
  select: typeof researchBatchSelect;
}>;

export type OwnedResearchContextInput = {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  ordinal: number;
  now?: Date;
};

/** A private, read-only projection. Never copy privateContext into aggregate notes. */
export async function getOwnedCourseSupportResearchContext(
  input: OwnedResearchContextInput,
) {
  validateOrdinal(input.ordinal);
  const now = input.now ?? new Date();
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: [...ACTIVE_BATCH_STATUSES] },
      leaseExpiresAt: { gt: now },
    },
    select: researchBatchSelect,
  });
  if (!batch) return controlResult("recovery_required", input.ordinal);
  return buildOwnedCourseSupportResearchContext(input, batch, now);
}

export async function validateOwnedCourseSupportResearchContext(
  input: OwnedResearchContextInput & { contextDigest: string },
) {
  if (!/^[a-f0-9]{64}$/u.test(input.contextDigest)) {
    throw new Error("Research context digest must be a 64-character lowercase SHA-256 digest.");
  }
  const current = await getOwnedCourseSupportResearchContext(input);
  if (current.outcome !== "ready") return current;
  if (current.researchContextV1.contextDigest !== input.contextDigest) {
    return {
      ...controlResult("authority_drift", input.ordinal),
      reasonCode: "RESEARCH_CONTEXT_CHANGED" as const,
      packetRefreshRequired: true as const,
    };
  }
  return {
    outcome: "valid" as const,
    ordinal: String(input.ordinal).padStart(2, "0"),
    contextDigest: input.contextDigest,
    // Only a snapshot-bound, validated matrix read supplies enough response
    // fields to start implementation. This is never a runtime monitoring probe.
    implementationMayProceedFromResearch:
      current.researchContextV1.actionPlan.allowedActions.includes("IMPLEMENT_REUSABLE_SUPPORT") &&
      current.researchContextV1.availabilityContract.status === "CONFIRMED_PUBLIC_READ" &&
      current.researchContextV1.linkChain.status === "CURRENT_DISCOVERY_CORROBORATED",
    furtherBoundedInspectionRequired:
      !current.researchContextV1.actionPlan.allowedActions.includes("IMPLEMENT_REUSABLE_SUPPORT") ||
      current.researchContextV1.availabilityContract.status !== "CONFIRMED_PUBLIC_READ" ||
      current.researchContextV1.linkChain.status !== "CURRENT_DISCOVERY_CORROBORATED",
    monitoringProofRecorded: false as const,
  };
}

export type OwnedResearchSpecialistInput = Omit<OwnedResearchContextInput, "now"> & {
  contextDigest: string;
  specialistThreadId: string;
};

/**
 * Records an owner's bounded research assignment, never child authentication,
 * token usage, an executed playbook stage, or provider monitoring proof.
 */
export async function registerOwnedCourseSupportResearchSpecialist(
  input: OwnedResearchSpecialistInput,
) {
  validateOrdinal(input.ordinal);
  if (!/^[a-f0-9]{64}$/u.test(input.contextDigest)) {
    throw new Error("Research context digest must be a 64-character lowercase SHA-256 digest.");
  }
  if (!isCourseSupportLineageThreadRef(input.specialistThreadId) ||
      input.specialistThreadId === input.ownerThreadId) {
    throw new Error("Research specialist must be a distinct bounded native thread reference.");
  }

  return prisma.$transaction(async (transaction) => {
    const initialNow = await getResearchDatabaseNow(transaction);
    const authority = await transaction.courseSupportBatch.findFirst({
      where: ownedResearchBatchWhere(input, initialNow),
      select: {
        revision: true,
        incidents: {
          take: MAX_RESEARCH_ORDINAL + 1,
          orderBy: { id: "asc" },
          select: { id: true, courseId: true, incidentId: true },
        },
      },
    });
    if (!authority) return researchAssignmentControl("recovery_required", input.ordinal);
    if (authority.incidents.length === 0 || authority.incidents.length > MAX_RESEARCH_ORDINAL) {
      return researchAssignmentControl("authority_drift", input.ordinal);
    }

    const courseIds = [...new Set(authority.incidents.map((entry) => entry.courseId))].sort();
    // Share the monitoring writer's advisory lock before taking any parent row
    // lock, so telemetry cannot invert its existing incident/batch/course order.
    for (const courseId of courseIds) {
      await acquireCourseMonitoringWriteLockInTransaction(transaction, courseId);
    }
    // Lock parents before rebuilding the packet. Course FOR UPDATE also fences
    // append-only discovery and monitoring inserts through their foreign keys.
    // READ COMMITTED deliberately observes rows committed during any lock wait;
    // an earlier repeatable snapshot must not authorize stale source evidence.
    for (const courseId of courseIds) {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "Course" WHERE "id" = ${courseId} FOR UPDATE
      `);
      if (rows.length !== 1) return researchAssignmentControl("authority_drift", input.ordinal);
    }
    for (const incidentId of [...new Set(authority.incidents.map((entry) => entry.incidentId))].sort()) {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "CourseSupportIncident" WHERE "id" = ${incidentId} FOR UPDATE
      `);
      if (rows.length !== 1) return researchAssignmentControl("authority_drift", input.ordinal);
    }
    // An existing status update need not acquire a Course foreign-key lock.
    for (const courseId of courseIds) {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "courseId" FROM "CourseMonitoringStatus" WHERE "courseId" = ${courseId} FOR UPDATE
      `);
    }
    const lockedBatch = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "CourseSupportBatch"
      WHERE "id" = ${input.batchId} AND "revision" = ${authority.revision}
      FOR UPDATE
    `);
    if (lockedBatch.length !== 1) return researchAssignmentControl("authority_drift", input.ordinal);
    const lockedMembers = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "CourseSupportBatchIncident"
      WHERE "batchId" = ${input.batchId}
      ORDER BY "id" LIMIT ${MAX_RESEARCH_ORDINAL + 1} FOR UPDATE
    `);
    if (lockedMembers.length !== authority.incidents.length ||
        lockedMembers.some((entry, index) => entry.id !== authority.incidents[index]?.id)) {
      return researchAssignmentControl("authority_drift", input.ordinal);
    }

    const now = await getResearchDatabaseNow(transaction);
    const batch = await transaction.courseSupportBatch.findFirst({
      where: { ...ownedResearchBatchWhere(input, now), revision: authority.revision },
      select: researchBatchSelect,
    });
    if (!batch) return researchAssignmentControl("recovery_required", input.ordinal);
    const current = buildOwnedCourseSupportResearchContext(input, batch, now);
    if (current.outcome !== "ready") return researchAssignmentControl(current.outcome, input.ordinal);
    if (current.researchContextV1.contextDigest !== input.contextDigest) {
      return researchAssignmentControl("authority_drift", input.ordinal);
    }

    const retainedSummary = record(batch.summary);
    const lineage = readCourseSupportLineage(retainedSummary);
    if (!lineage && retainedSummary.ownershipLineageV1 !== undefined) {
      return researchAssignmentControl("lineage_unavailable", input.ordinal);
    }
    if (lineage && (lineage.events.length >= COURSE_SUPPORT_LINEAGE_EVENT_LIMIT ||
        lineage.completeness === "OVERFLOW_INCOMPLETE")) {
      return researchAssignmentControl("lineage_unavailable", input.ordinal);
    }
    const latestOwnerEpoch = lineage?.events.at(-1)?.ownerEpoch;
    const duplicate = lineage?.events.some((event) =>
      event.kind === "RESEARCH_ASSIGNMENT" && event.ownerEpoch === latestOwnerEpoch &&
      event.actorThreadId === input.ownerThreadId && event.ownerThreadId === input.ownerThreadId &&
      event.specialistThreadId === input.specialistThreadId && event.ordinal === input.ordinal &&
      event.incidentCycle === current.researchContextV1.incidentCycle &&
      event.contextDigest === input.contextDigest);
    if (duplicate) return researchAssignmentResult("already_registered", input.ordinal);
    const summary = appendCourseSupportLineage(retainedSummary, {
      kind: "RESEARCH_ASSIGNMENT",
      actorThreadId: input.ownerThreadId,
      ownerThreadId: input.ownerThreadId,
      specialistThreadId: input.specialistThreadId,
      ordinal: input.ordinal,
      incidentCycle: current.researchContextV1.incidentCycle,
      contextDigest: input.contextDigest,
    }, now);
    if (!readCourseSupportLineage(summary)) {
      return researchAssignmentControl("lineage_unavailable", input.ordinal);
    }
    const commitNow = await getResearchDatabaseNow(transaction);
    if (batch.leaseExpiresAt <= commitNow) {
      return researchAssignmentControl("recovery_required", input.ordinal);
    }
    const updated = await transaction.courseSupportBatch.updateMany({
      where: { ...ownedResearchBatchWhere(input, commitNow), revision: authority.revision },
      data: { summary: summary as Prisma.InputJsonObject, revision: { increment: 1 } },
    });
    if (updated.count !== 1) return researchAssignmentControl("authority_drift", input.ordinal);
    return researchAssignmentResult("registered", input.ordinal);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 5_000,
    timeout: 10_000,
  });
}

function ownedResearchBatchWhere(input: OwnedResearchContextInput, now: Date) {
  return {
    id: input.batchId,
    ownerThreadId: input.ownerThreadId,
    leaseToken: input.leaseToken,
    status: { in: [...ACTIVE_BATCH_STATUSES] },
    leaseExpiresAt: { gt: now },
  } satisfies Prisma.CourseSupportBatchWhereInput;
}

async function getResearchDatabaseNow(transaction: Prisma.TransactionClient) {
  const [row] = await transaction.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS "now"`,
  );
  if (!row?.now || !Number.isFinite(row.now.getTime())) {
    throw new Error("Course-support research database time is unavailable.");
  }
  return row.now;
}

function researchAssignmentControl(
  outcome: "recovery_required" | "route_ineligible" | "authority_drift" | "lineage_unavailable",
  ordinal: number,
) {
  return {
    ...researchAssignmentResult(outcome, ordinal),
    packetRefreshRequired: outcome === "authority_drift",
    threadDisposition: "KEEP_VISIBLE" as const,
  };
}

function researchAssignmentResult(
  outcome: "registered" | "already_registered" | "recovery_required" |
    "route_ineligible" | "authority_drift" | "lineage_unavailable",
  ordinal: number,
) {
  return {
    outcome,
    ordinal: String(ordinal).padStart(2, "0"),
    assignmentRecorded: outcome === "registered" || outcome === "already_registered",
    childAuthenticationVerified: false as const,
    modelUsageVerified: false as const,
    playbookStageRecorded: false as const,
    monitoringProofRecorded: false as const,
  };
}

export function buildOwnedCourseSupportResearchContext(
  input: OwnedResearchContextInput,
  batch: ResearchBatch,
  now: Date,
) {
  if (batch.leaseExpiresAt <= now) return controlResult("recovery_required", input.ordinal);
  const ordered = orderCourseSupportBatchIncidents(batch.incidents);
  const entry = ordered[input.ordinal - 1];
  if (!entry) return controlResult("route_ineligible", input.ordinal);

  const remediation = readCourseSupportRemediationDirective(batch.summary);
  const claim = readCourseSupportRemediationClaimAttempt({
    summary: batch.summary,
    courseId: entry.course.id,
    expectedAttemptCount: ordered.length,
  });
  const snapshotFingerprint = buildCourseSupportProviderSnapshotFingerprint(entry.course);
  const playbook = assessAutomationPlaybook(entry.incident.attemptLedger, entry.cycle);
  const playbookEventCount = parseAutomationPlaybookLedger(entry.incident.attemptLedger)
    ?.events.filter((event) => event.cycle === entry.cycle).length ?? -1;
  const monitoringDrift = entry.course.monitoringEvents.some((event) =>
    event.occurredAt >= batch.createdAt &&
    (event.eventType === "CHECK_SUCCEEDED" || event.eventType === "RECOVERED" ||
      event.outcome === "MATCH_FOUND" || event.outcome === "NO_MATCH" ||
      (event.failureFingerprint !== null &&
        !courseSupportFailureFingerprintsMatch(event.failureFingerprint, batch.failureFingerprint))));
  if (!remediation || !claim?.actionPlan ||
      claim.actionPlan.primaryAction === "WAIT_FOR_MATERIAL_CHANGE" ||
      !courseSupportActionPlanMatchesRoute({
        plan: claim.actionPlan,
        workMode: remediation.workMode,
        strategyAction: remediation.strategyAction,
        playbookStage: remediation.playbookStage,
      }) ||
      entry.result !== "PENDING" || entry.cycle !== entry.incident.cycle ||
      entry.incident.status !== "AUTO_INVESTIGATING" ||
      entry.incident.activeBatchId !== input.batchId ||
      entry.incident.resolution !== null ||
      entry.incident.providerFamilyKey !== batch.providerFamilyKey ||
      entry.incident.failureFingerprint !== batch.failureFingerprint ||
      claim.failureFingerprint !== batch.failureFingerprint ||
      claim.providerSnapshotFingerprint !== snapshotFingerprint ||
      claim.playbookEventCountAtClaim !== playbookEventCount ||
      !playbook.valid || playbook.cycle !== entry.cycle ||
      entry.course.monitoringStatus?.state !== "AUTO_INVESTIGATING" ||
      !entry.course.monitoringStatus.failureFingerprint ||
      !courseSupportFailureFingerprintsMatch(
        entry.course.monitoringStatus.failureFingerprint,
        batch.failureFingerprint,
      ) || monitoringDrift) {
    return controlResult("authority_drift", input.ordinal);
  }

  const course = entry.course;
  // A fresh cycle normally refreshes confirmedAt. Some existing reopen paths
  // retain the earlier confirmation while moving firstSeenAt to the new cycle.
  // The later bound excludes evidence from either prior-cycle shape.
  const confirmedAt = entry.incident.confirmedAt ??
    (entry.cycle === 1 ? entry.incident.firstSeenAt : null);
  const cycleStartedAt = confirmedAt && confirmedAt > entry.incident.firstSeenAt
    ? confirmedAt : confirmedAt ? entry.incident.firstSeenAt : null;
  if (!cycleStartedAt || cycleStartedAt > now) {
    return controlResult("authority_drift", input.ordinal);
  }
  const officialSiteUrl = safeResearchUrl(course.website);
  const officialBookingUrl = safeResearchUrl(course.detectedBookingUrl);
  const currentDiscoveries = course.automationDiscoveries
    .filter((discovery) =>
      discovery.createdAt >= cycleStartedAt && discovery.createdAt <= now)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const conflicts: string[] = [];
  const barriers = new Set<string>();
  const observations = currentDiscoveries.map((discovery, index) => {
    const evidence = record(discovery.evidence);
    const browser = record(evidence.browserInvestigation);
    const corroboration = record(evidence.courseIdentityCorroboration);
    const browserObservedAt = canonicalObservedAt(browser.observedAt, now);
    const browserCycleMatches = browser.incidentCycle === entry.cycle &&
      browserObservedAt !== null && new Date(browserObservedAt) >= cycleStartedAt;
    const browserSnapshotMatches = browser.providerSnapshotFingerprint === snapshotFingerprint;
    if (index === 0 && browserCycleMatches && browser.providerSnapshotFingerprint && !browserSnapshotMatches) {
      conflicts.push("PROVIDER_SNAPSHOT_CHANGED_SINCE_BROWSER_READ");
    }
    if (index === 0 && corroboration.kind === "OFFICIAL_COURSE_PROVIDER_LINK" &&
        (safeResearchUrl(corroboration.officialWebsiteUrl) !== officialSiteUrl ||
          !bookingLinkMatchesSnapshot(
            corroboration.providerUrl, officialBookingUrl, batch.providerFamilyKey,
          ))) {
      conflicts.push("OFFICIAL_LINK_CHAIN_DIFFERS_FROM_CURRENT_COURSE");
    }
    if (index === 0 && safeResearchUrl(discovery.bookingUrl) &&
        !bookingLinkMatchesSnapshot(
          discovery.bookingUrl, officialBookingUrl, batch.providerFamilyKey,
        )) {
      conflicts.push("DISCOVERY_BOOKING_LINK_DIFFERS_FROM_CURRENT_COURSE");
    }
    if (index === 0 && evidence.sourcePageAvailability === "SOFT_NOT_FOUND") {
      barriers.add("OFFICIAL_SOURCE_NOT_FOUND");
    }
    if (index === 0) {
      for (const accessBarrier of array(evidence.accessBarriers).slice(0, 8)) {
        const status = record(accessBarrier).status;
        if (status === 401 || status === 403) barriers.add(`HTTP_${status}`);
      }
    }
    return {
      observedAt: discovery.createdAt.toISOString(),
      status: discovery.status,
      sourcePage: safeResearchUrl(discovery.sourceUrl),
      bookingPage: safeResearchUrl(discovery.bookingUrl),
      sourcePageAvailability: evidence.sourcePageAvailability === "SOFT_NOT_FOUND"
        ? "SOFT_NOT_FOUND" as const : null,
      restrictedNetworkObserved: browser.restrictedNetworkObserved === true,
      corroboratedOfficialPage: corroboration.kind === "OFFICIAL_COURSE_PROVIDER_LINK"
        ? safeResearchUrl(corroboration.officialPageUrl) : null,
      browserObservedAt: browserCycleMatches && browserSnapshotMatches
        ? browserObservedAt : null,
      providerSnapshotBound: browserCycleMatches && browserSnapshotMatches,
      officialLinkCorroborated: corroboration.kind === "OFFICIAL_COURSE_PROVIDER_LINK" &&
        safeResearchUrl(corroboration.officialWebsiteUrl) === officialSiteUrl &&
        bookingLinkMatchesSnapshot(
          corroboration.providerUrl, officialBookingUrl, batch.providerFamilyKey,
        ),
    };
  });
  const snapshotBoundBrowserDiscoveries = currentDiscoveries.filter((discovery) => {
    const browser = record(record(discovery.evidence).browserInvestigation);
    const observedAt = canonicalObservedAt(browser.observedAt, now);
    return browser.incidentCycle === entry.cycle &&
      browser.providerSnapshotFingerprint === snapshotFingerprint &&
      observedAt !== null && new Date(observedAt) >= cycleStartedAt;
  });
  const browserEvidence = selectCurrentBrowserProviderContractEvidence({
    discoveries: snapshotBoundBrowserDiscoveries,
    incidentCycle: entry.cycle,
    incidentFirstSeenAt: entry.incident.firstSeenAt,
    providerFamilyKey: batch.providerFamilyKey,
    providerSnapshotFingerprint: snapshotFingerprint,
    officialUrl: officialSiteUrl,
    bookingUrl: officialBookingUrl,
  });
  if (browserEvidence?.restrictionDetected) barriers.add("RESTRICTED_NETWORK");
  const quick18MatrixEvidence = selectValidatedQuick18MatrixEvidence({
    discoveries: snapshotBoundBrowserDiscoveries,
    providerFamilyKey: batch.providerFamilyKey,
    providerSnapshotFingerprint: snapshotFingerprint,
    officialBookingUrl,
    incidentCycle: entry.cycle,
    cycleStartedAt,
    now,
  });
  const browserContracts = browserEvidence?.restrictionDetected ? [] : browserEvidence?.contracts ?? [];
  const contracts = quick18MatrixEvidence && !browserEvidence?.restrictionDetected
    ? [quick18MatrixEvidence.contract, ...browserContracts]
    : browserContracts;
  const actionableContracts = contracts.filter((contract) =>
    contract.method === "GET" && contract.statusBand === "SUCCESS" &&
    (contract.resourceType === "FETCH" || contract.resourceType === "XHR"));
  const selectedContract = actionableContracts[0] ?? null;
  const confirmedQuick18Matrix = quick18MatrixEvidence !== null &&
    !browserEvidence?.restrictionDetected;
  const snapshotAccessRestricted = [
    "ACCOUNT_REQUIRED", "ACCOUNT_SELF_SERVICE", "ACCOUNT_STAFF_PROVISIONED", "CAPTCHA_OR_QUEUE",
  ].includes(course.bookingAccessMode);
  if (snapshotAccessRestricted && !selectedContract && !confirmedQuick18Matrix) {
    barriers.add(course.bookingAccessMode);
  }
  const corroborated = barriers.has("OFFICIAL_SOURCE_NOT_FOUND") ||
    conflicts.includes("DISCOVERY_BOOKING_LINK_DIFFERS_FROM_CURRENT_COURSE")
    ? undefined
    : observations.find((observation) => observation.officialLinkCorroborated);
  const missingEvidence: string[] = [];
  if (!officialSiteUrl) missingEvidence.push("SAFE_OFFICIAL_PAGE");
  if (!officialBookingUrl) missingEvidence.push("SAFE_OFFICIAL_BOOKING_PAGE");
  if (!corroborated) missingEvidence.push("CURRENT_OFFICIAL_PAGE_TO_BOOKING_LINK");
  if (!selectedContract && !confirmedQuick18Matrix) missingEvidence.push("SIGNED_OUT_AVAILABILITY_GET");
  if (!confirmedQuick18Matrix &&
      !selectedContract?.queryKeys.some((key) => ["DATE", "START_DATE"].includes(key))) {
    missingEvidence.push("COURSE_LOCAL_DATE_FIELD");
  }
  if (!confirmedQuick18Matrix && !selectedContract?.queryKeys.includes("PLAYERS")) {
    missingEvidence.push("PLAYER_COUNT_FIELD");
  }
  if (snapshotAccessRestricted && (selectedContract || confirmedQuick18Matrix)) {
    missingEvidence.push("RECONCILE_STALE_ACCESS_CLASSIFICATION");
  }
  if (!confirmedQuick18Matrix) missingEvidence.push("AVAILABILITY_RESPONSE_FIELD_MAPPING");
  missingEvidence.push("EXACT_RUNTIME_MATCH_OR_NO_MATCH_PROBE");
  if (conflicts.length > 0) missingEvidence.push("RESOLVE_CONFLICTING_EVIDENCE");

  const actionPlanDigest = digest(claim.actionPlan);
  const researchContext = {
    schemaVersion: RESEARCH_CONTEXT_VERSION,
    ordinal: String(input.ordinal).padStart(2, "0"),
    incidentCycle: entry.cycle,
    actionPlanDigest,
    actionPlan: claim.actionPlan,
    providerSnapshot: {
      fingerprint: snapshotFingerprint,
      family: batch.providerFamilyKey,
      platform: course.detectedPlatform,
      bookingMethod: course.bookingMethod,
      bookingAccessMode: course.bookingAccessMode,
      automationEligibility: course.automationEligibility,
      automationReason: course.automationReason,
      monitoringMode: course.monitoringMode,
      timeZone: course.timeZone,
    },
    identity: {
      name: course.name,
      googlePlaceId: course.googlePlaceId,
      address: course.address,
      city: course.city,
      stateCode: course.stateCode,
      latitude: course.latitude,
      longitude: course.longitude,
    },
    linkChain: {
      officialSiteUrl,
      officialPageUrl: corroborated?.corroboratedOfficialPage ?? officialSiteUrl,
      officialBookingUrl,
      status: corroborated ? "CURRENT_DISCOVERY_CORROBORATED" as const : "SNAPSHOT_ONLY" as const,
      observedAt: corroborated?.observedAt ?? null,
      season: extractObservedSeason(currentDiscoveries, corroborated?.observedAt ?? null),
    },
    availabilityContract: {
      status: barriers.size > 0 ? "BARRIER" as const :
        conflicts.length > 0 ? "CONFLICTING" as const :
          confirmedQuick18Matrix && corroborated ? "CONFIRMED_PUBLIC_READ" as const :
          selectedContract ? "CANDIDATE_ONLY" as const : "MISSING" as const,
      observedAt: quick18MatrixEvidence?.observedAt ?? browserEvidence?.createdAt.toISOString() ?? null,
      evidenceDigest: quick18MatrixEvidence?.evidenceDigest ?? browserEvidence?.marker?.evidenceDigest ?? null,
      contracts: contracts.map(projectContract),
      requestFieldMapping: {
        date: confirmedQuick18Matrix ? "TEEDATE" as const :
          selectedContract?.queryKeys.find((key) => key === "DATE" || key === "START_DATE") ?? null,
        players: confirmedQuick18Matrix ? null :
          selectedContract?.queryKeys.includes("PLAYERS") ? "PLAYERS" as const : null,
        course: confirmedQuick18Matrix ? null :
          selectedContract?.queryKeys.find((key) => ["COURSE_ID", "FACILITY_ID", "LOCATION_ID"].includes(key)) ?? null,
      },
      responseFieldMapping: confirmedQuick18Matrix ? {
        date: "SearchForm_Date.value",
        time: "mtrxTeeTimes",
        players: "matrixPlayers",
        publicRate: "Daily Rate",
        selectionUrl: "public-rate selection href",
      } as const : null,
      signedOutReadOnlyConfirmed: confirmedQuick18Matrix &&
        barriers.size === 0 && conflicts.length === 0 && Boolean(corroborated),
    },
    accessBarriers: [...barriers].sort(),
    conflicts: [...new Set(conflicts)].sort(),
    missingEvidence: [...new Set(missingEvidence)],
    monitoringProofRecorded: false as const,
    recentDiscoveryObservations: observations.slice(0, 8),
    recentMonitoringObservations: course.monitoringEvents
      .filter((event) => event.incidentId === entry.incident.id)
      .map((event) => ({
        occurredAt: event.occurredAt.toISOString(),
        eventType: event.eventType,
        outcome: event.outcome,
        readPath: event.readPath,
      })),
  };
  const contextDigest = digest({
    batchId: input.batchId,
    ownerThreadId: input.ownerThreadId,
    leaseToken: input.leaseToken,
    batchReference: batch.reference,
    batchStatus: batch.status,
    batchCreatedAt: batch.createdAt.toISOString(),
    batchFailureFingerprint: batch.failureFingerprint,
    orderedMembers: ordered.map((member) => ({
      batchEntryId: member.id,
      batchEntryCycle: member.cycle,
      batchEntryResult: member.result,
      incidentId: member.incident.id,
      incidentCycle: member.incident.cycle,
      incidentStatus: member.incident.status,
      incidentActiveBatchId: member.incident.activeBatchId,
      providerSnapshotFingerprint: buildCourseSupportProviderSnapshotFingerprint(member.course),
    })),
    incidentId: entry.incident.id,
    incidentCycle: entry.cycle,
    cycleStartedAt: cycleStartedAt.toISOString(),
    playbookEventCount,
    researchContext,
  });
  return {
    outcome: "ready" as const,
    ordinal: String(input.ordinal).padStart(2, "0"),
    researchContextV1: { ...researchContext, contextDigest },
    privateContext: true as const,
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "Owner-bound read-only research does not complete a playbook stage.",
  };
}

function projectContract(contract: SanitizedProviderContract) {
  return {
    method: contract.method,
    resourceType: contract.resourceType,
    statusBand: contract.statusBand,
    pathPattern: contract.pathPattern,
    queryKeys: contract.queryKeys,
    providerSignal: contract.providerSignal,
    digest: contract.digest,
  };
}

function selectValidatedQuick18MatrixEvidence(input: {
  discoveries: ResearchBatch["incidents"][number]["course"]["automationDiscoveries"];
  providerFamilyKey: string;
  providerSnapshotFingerprint: string;
  officialBookingUrl: string | null;
  incidentCycle: number;
  cycleStartedAt: Date;
  now: Date;
}) {
  if (input.providerFamilyKey !== "QUICK18" || !input.officialBookingUrl ||
      !isQuick18PublicSearchUrl(input.officialBookingUrl)) return null;
  const officialBooking = new URL(input.officialBookingUrl);
  if (officialBooking.search || officialBooking.hash) return null;

  for (const discovery of input.discoveries) {
    const evidence = record(discovery.evidence);
    const browser = record(evidence.browserInvestigation);
    const observedAt = canonicalObservedAt(browser.observedAt, input.now);
    const finalUrl = safeResearchUrl(evidence.finalUrl);
    if (discovery.status !== "LEARNED" || discovery.automationReason !== "NONE" ||
        evidence.learnedFrom !== "quick18-validated-public-matrix" ||
        discovery.bookingUrl !== input.officialBookingUrl ||
        !isQuick18Metadata(discovery.apiMetadata) ||
        discovery.apiMetadata.bookingBaseUrl !== input.officialBookingUrl ||
        browser.incidentCycle !== input.incidentCycle ||
        browser.providerSnapshotFingerprint !== input.providerSnapshotFingerprint ||
        !observedAt || new Date(observedAt) < input.cycleStartedAt ||
        browser.restrictedNetworkObserved === true ||
        !finalUrl || !isQuick18PublicSearchUrl(finalUrl)) continue;
    const observedUrl = new URL(finalUrl);
    if (observedUrl.origin !== officialBooking.origin ||
        !observedUrl.searchParams.has("teedate")) continue;

    // The marker is persisted only after the adapter's signed-out GET parses a
    // selectable public matrix. Its static fields are the validated adapter
    // contract, not a copied response body or monitoring result.
    const contract = buildSanitizedProviderContract({
      method: "GET",
      resourceType: "DOCUMENT",
      statusBand: "SUCCESS",
      pathPattern: "/teetimes/searchmatrix",
      queryKeys: ["date"],
      providerSignal: "BOOKING_ORIGIN",
    });
    const persistedAt = discovery.createdAt.toISOString();
    return {
      observedAt: persistedAt,
      contract,
      evidenceDigest: digest({
        marker: evidence.learnedFrom,
        incidentCycle: input.incidentCycle,
        providerSnapshotFingerprint: input.providerSnapshotFingerprint,
        browserObservedAt: observedAt,
        persistedAt,
        validatedDate: observedUrl.searchParams.get("teedate"),
        contractDigest: contract.digest,
      }),
    };
  }
  return null;
}

function extractObservedSeason(
  discoveries: ResearchBatch["incidents"][number]["course"]["automationDiscoveries"],
  observedAt: string | null,
) {
  if (!observedAt) return null;
  const discovery = discoveries.find((candidate) => candidate.createdAt.toISOString() === observedAt);
  const visibleText = record(record(discovery?.evidence).officialPage).visibleText;
  if (typeof visibleText !== "string") return null;
  const match = visibleText.slice(0, 20_000).match(/\b(20\d{2})\s+(?:golf|summer)\s+season\b/iu);
  return match ? `${match[1]} golf season` : null;
}

function safeResearchUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (value.length > 2_048 || url.username || url.password || !isSafeManualEvidenceUrl(url) ||
        hasRecipientLikeUrlState(url.pathname) || hasRecipientLikeUrlState(url.hash)) return null;
    const privateQueryState = [...url.searchParams].some(([key, queryValue]) =>
      /(?:email|recipient|address|account|user)/iu.test(key) ||
      hasRecipientLikeUrlState(key) ||
      hasRecipientLikeUrlState(queryValue));
    return privateQueryState ? null : url.toString();
  } catch {
    return null;
  }
}

function bookingLinkMatchesSnapshot(
  observedValue: unknown,
  snapshotUrl: string | null,
  providerFamilyKey: string,
) {
  const observedUrl = safeResearchUrl(observedValue);
  if (!observedUrl || !snapshotUrl) return false;
  if (providerFamilyKey !== "QUICK18") return observedUrl === snapshotUrl;
  if (!isQuick18PublicSearchUrl(snapshotUrl) ||
      !isQuick18PublicSearchUrl(observedUrl)) return false;
  const snapshot = new URL(snapshotUrl);
  const observed = new URL(observedUrl);
  return snapshot.origin === observed.origin &&
    snapshot.pathname === observed.pathname;
}

function hasRecipientLikeUrlState(value: string) {
  let decoded = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(decoded)) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return false;
      decoded = next;
    } catch {
      return true;
    }
  }
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(decoded);
}

function canonicalObservedAt(value: unknown, now: Date) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value && parsed <= now
    ? value : null;
}

function controlResult(outcome: "recovery_required" | "route_ineligible" | "authority_drift", ordinal: number) {
  return {
    outcome,
    ordinal: String(ordinal).padStart(2, "0"),
    packetRefreshRequired: outcome === "authority_drift",
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "Research requires a current owned batch, exact ordinal, and unchanged claim evidence.",
  };
}

function validateOrdinal(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RESEARCH_ORDINAL) {
    throw new Error("Research ordinal must be from 01 through 20.");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
