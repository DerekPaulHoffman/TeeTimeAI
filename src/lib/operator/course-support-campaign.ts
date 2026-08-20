import {
  inspectLatestParkedCourseCampaign,
  parseParkedCourseCampaignAudit
} from "@/lib/automation/course-support-campaign";
import { prisma } from "@/lib/prisma";

const ROLLING_HUMAN_REVIEW_DAYS = 30;
const HUMAN_REVIEW_TARGET_PERCENT = 5;
const AUTOMATIC_RESOLUTION_TARGET_PERCENT = 95;
const CAMPAIGN_RESOLUTION_DEADLINE_MS = 24 * 60 * 60 * 1000;
const FUTURE_UNFAMILIAR_COURSE_WINDOW_DAYS = 30;

type CampaignInspection = NonNullable<
  Awaited<ReturnType<typeof inspectLatestParkedCourseCampaign>>
>;

type RollingEndpointEvent = {
  incidentId: string | null;
  eventType: string;
  toState: string | null;
  source: string | null;
  operatorActorId: string | null;
  runtimeVersion: string | null;
  deploymentSha: string | null;
  occurredAt: Date | null;
  countsAsEndpoint: boolean;
  audit: unknown;
};

type FutureTerminalEvent = {
  eventType: string;
  toState: string | null;
  source: string;
  operatorActorId: string | null;
  runtimeVersion: string | null;
  deploymentSha: string | null;
  occurredAt: Date;
  audit: unknown;
};

type FutureUnfamiliarIncident = {
  id: string;
  courseId: string;
  cycle: number;
  status: string;
  resolution: string | null;
  confirmedAt: Date | null;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  decisionAt: Date | null;
  decisionActorId: string | null;
  terminalEvents: FutureTerminalEvent[];
};

type ImplementationBatch = {
  providerFamilyKey: string;
  failureFingerprint: string;
  baseSha: string;
  releaseSha: string | null;
  deployedAt: Date | null;
  summary: unknown;
};

export type OperatorRollingHumanReview = {
  windowDays: 30;
  humanReviewCount: number;
  endpointCount: number;
  ratePercent: number | null;
  targetPercent: 5;
  ambiguousEndpointCount: number;
  status: "PASS" | "FAIL" | "NO_DATA" | "UNKNOWN";
};

export type OperatorRepeatImplementations = {
  repeatImplementationCount: number;
  implementationBatchCount: number;
  implementationGroupCount: number;
  status: "PASS" | "FAIL" | "UNKNOWN";
};

export type OperatorFutureAutomaticResolution = {
  windowDays: 30;
  eligibleCount: number;
  automaticCount: number;
  nonAutomaticCount: number;
  pendingCount: number;
  unknownCount: number;
  ratePercent: number | null;
  targetPercent: 95;
  status: "PASS" | "FAIL" | "IN_PROGRESS" | "NO_DATA" | "UNKNOWN";
};

export type OperatorCourseSupportCampaign = {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  capturedAt: Date;
  expectedCount: number;
  progress: {
    terminalCount: number;
    totalCount: number;
    pendingCount: number;
    remainingGlobalParkedCount: number;
    status: "COMPLETE" | "IN_PROGRESS" | "UNKNOWN";
  };
  currentResults: {
    resultCount: number;
    accountedCount: number;
    totalCount: number;
    missingCount: number;
    monitoredCount: number;
    bookingNotOpenCount: number;
    factualLimitationCount: number;
    technicalLimitationCount: number;
    sourceUnverifiedCount: number;
    readyCount: number;
    activeCount: number;
    engineeringBlockerCount: number;
    campaignHumanReviewCount: number;
    bucketInvariantStatus: "PASS" | "UNKNOWN";
    status: "PASS" | "UNKNOWN";
  };
  automaticWithin24Hours: {
    automaticCount: number;
    totalCount: number;
    deadlineAt: Date;
    targetPercent: 95;
    status: "PASS" | "FAIL" | "IN_PROGRESS" | "UNKNOWN";
  };
  futureAutomaticWithin24Hours: OperatorFutureAutomaticResolution;
  rollingHumanReview: OperatorRollingHumanReview;
  repeatImplementations: OperatorRepeatImplementations;
};

type OperatorCourseSupportCampaignDependencies = {
  inspectLatestCampaign: () => Promise<CampaignInspection | null>;
  loadCampaignAudit: (runId: string) => Promise<unknown | null>;
  loadRollingEndpointEvents: (input: {
    since: Date;
    until: Date;
  }) => Promise<RollingEndpointEvent[]>;
  loadFutureUnfamiliarIncidents: (input: {
    since: Date;
    until: Date;
  }) => Promise<FutureUnfamiliarIncident[]>;
  loadImplementationBatches: (input: {
    capturedAt: Date;
    until: Date;
  }) => Promise<ImplementationBatch[]>;
};

export async function loadOperatorCourseSupportCampaign(
  input: { now?: Date } = {},
  dependencies: OperatorCourseSupportCampaignDependencies = defaultDependencies
): Promise<OperatorCourseSupportCampaign | null> {
  const now = input.now ?? new Date();
  const campaign = await dependencies.inspectLatestCampaign();
  if (!campaign) return null;

  const rollingSince = new Date(
    now.getTime() - ROLLING_HUMAN_REVIEW_DAYS * 24 * 60 * 60 * 1000
  );
  const [storedAudit, rollingEvents] = await Promise.all([
    dependencies.loadCampaignAudit(campaign.runId),
    dependencies.loadRollingEndpointEvents({ since: rollingSince, until: now })
  ]);
  const audit = parseParkedCourseCampaignAudit(storedAudit);
  const auditMatchesInspection = Boolean(
    audit &&
      audit.capturedAt === campaign.capturedAt &&
      audit.expectedCount === campaign.expectedCount &&
      audit.membershipDigest === campaign.membershipDigest
  );
  const campaignCapturedAt = new Date(campaign.capturedAt);
  const futureSince = new Date(
    Math.max(campaignCapturedAt.getTime(), rollingSince.getTime())
  );
  const [futureIncidents, implementationBatches] = await Promise.all([
    audit && auditMatchesInspection
      ? dependencies.loadFutureUnfamiliarIncidents({
          since: futureSince,
          until: now
        })
      : Promise.resolve(null),
    dependencies.loadImplementationBatches({ capturedAt: campaignCapturedAt, until: now })
  ]);
  const futureAutomaticWithin24Hours = futureIncidents
    ? summarizeFutureAutomaticResolution({
        campaignCapturedAt,
        campaignIncidentCycles:
          audit?.members.map((member) => ({
            incidentId: member.incidentId,
            cycle: member.cycle
          })) ?? [],
        incidents: futureIncidents,
        now
      })
    : unknownFutureAutomaticResolution();
  const repeatImplementations = summarizeRepeatProviderImplementations({
    batches: implementationBatches
  });

  return buildOperatorCourseSupportCampaignSummary({
    campaign,
    futureAutomaticWithin24Hours,
    now,
    repeatImplementations,
    rollingHumanReview: summarizeRollingHumanReview(rollingEvents)
  });
}

export function summarizeRollingHumanReview(
  events: readonly RollingEndpointEvent[]
): OperatorRollingHumanReview {
  const endpointsByIncident = new Map<
    string,
    Array<{
      countsAsEndpoint: boolean;
      cycle: number | null;
      kind: "AUTOMATIC" | "HUMAN" | "UNKNOWN";
    }>
  >();
  for (const event of events) {
    if (!event.incidentId) continue;
    const kind = getEndpointKind(event);
    if (!kind) continue;
    const incidentEndpoints = endpointsByIncident.get(event.incidentId) ?? [];
    incidentEndpoints.push({
      countsAsEndpoint: event.countsAsEndpoint,
      cycle: readPositiveCycle(event.audit),
      kind
    });
    endpointsByIncident.set(event.incidentId, incidentEndpoints);
  }

  const endpoints = new Map<string, "AUTOMATIC" | "HUMAN" | "UNKNOWN">();
  const ambiguousEndpointKeys = new Set<string>();
  for (const [incidentId, incidentEndpoints] of endpointsByIncident) {
    const inWindowEndpoints = incidentEndpoints.filter(
      (endpoint) => endpoint.countsAsEndpoint
    );
    if (inWindowEndpoints.length === 0) continue;
    if (inWindowEndpoints.some((endpoint) => endpoint.cycle === null)) {
      const key = `${incidentId}\u0000legacy`;
      ambiguousEndpointKeys.add(key);
      endpoints.set(
        key,
        incidentEndpoints.some((endpoint) => endpoint.kind === "HUMAN") ? "HUMAN" : "UNKNOWN"
      );
      continue;
    }
    const hasUnscopedCycleEvidence = incidentEndpoints.some(
      (endpoint) => endpoint.cycle === null
    );
    for (const cycle of new Set(inWindowEndpoints.map((endpoint) => endpoint.cycle))) {
      const cycleEndpoints = incidentEndpoints.filter(
        (endpoint) => endpoint.cycle === cycle
      );
      const key = `${incidentId}\u0000cycle:${cycle}`;
      if (hasUnscopedCycleEvidence) ambiguousEndpointKeys.add(key);
      endpoints.set(
        key,
        cycleEndpoints.some((endpoint) => endpoint.kind === "HUMAN")
          ? "HUMAN"
          : hasUnscopedCycleEvidence
            ? "UNKNOWN"
            : cycleEndpoints.some((endpoint) => endpoint.kind === "UNKNOWN")
              ? "UNKNOWN"
              : "AUTOMATIC"
      );
    }
  }

  const endpointCount = endpoints.size;
  const humanReviewCount = [...endpoints.values()].filter(
    (endpoint) => endpoint === "HUMAN"
  ).length;
  for (const [key, endpoint] of endpoints) {
    if (endpoint === "UNKNOWN") ambiguousEndpointKeys.add(key);
  }
  const ambiguousEndpointCount = ambiguousEndpointKeys.size;
  if (endpointCount === 0) {
    return {
      windowDays: ROLLING_HUMAN_REVIEW_DAYS,
      humanReviewCount: 0,
      endpointCount: 0,
      ratePercent: null,
      targetPercent: HUMAN_REVIEW_TARGET_PERCENT,
      ambiguousEndpointCount: 0,
      status: "NO_DATA"
    };
  }

  const exactRatePercent = (humanReviewCount / endpointCount) * 100;
  return {
    windowDays: ROLLING_HUMAN_REVIEW_DAYS,
    humanReviewCount,
    endpointCount,
    ratePercent:
      ambiguousEndpointCount > 0 ? null : Math.round(exactRatePercent * 10) / 10,
    targetPercent: HUMAN_REVIEW_TARGET_PERCENT,
    ambiguousEndpointCount,
    status:
      ambiguousEndpointCount > 0
        ? "UNKNOWN"
        : exactRatePercent <= HUMAN_REVIEW_TARGET_PERCENT
          ? "PASS"
          : "FAIL"
  };
}

export function summarizeFutureAutomaticResolution(input: {
  campaignCapturedAt: Date;
  campaignIncidentCycles: readonly { incidentId: string; cycle: number }[];
  incidents: readonly FutureUnfamiliarIncident[];
  now: Date;
}): OperatorFutureAutomaticResolution {
  const windowStart = new Date(
    Math.max(
      input.campaignCapturedAt.getTime(),
      input.now.getTime() - FUTURE_UNFAMILIAR_COURSE_WINDOW_DAYS * 24 * 60 * 60 * 1000
    )
  );
  const candidates = new Map<
    string,
    {
      confirmedAt: Date | null;
      confirmedAtConflict: boolean;
      cycle: number;
      currentIncident: FutureUnfamiliarIncident | null;
      events: FutureTerminalEvent[];
      incidentId: string;
    }
  >();
  const capturedIncidentCycleKeys = new Set(
    input.campaignIncidentCycles.map(({ incidentId, cycle }) =>
      // The immutable audit captures each member while it is parked at cycle N.
      // Campaign admission always reopens that incident into cycle N+1, so the
      // admission cycle—not the parked snapshot—must be excluded from the
      // rolling future denominator. Later material-change cycles remain eligible.
      futureIncidentCycleKey(incidentId, cycle + 1)
    )
  );
  const eligibleIncidents = input.incidents;

  for (const incident of eligibleIncidents) {
    for (const event of incident.terminalEvents) {
      const seedsCompletedCycle =
        event.eventType === "RECOVERED" ||
        (event.eventType === "STATE_CHANGED" &&
          isTerminalRollingEndpointState(event.toState)) ||
        (event.eventType === "HUMAN_DECISION" && isHumanCycleEvent(event));
      if (!seedsCompletedCycle) continue;
      const cycle = readPositiveCycle(event.audit);
      const confirmedAt = readAuditDate(event.audit, "confirmedAt");
      if (!cycle || !isFutureWindowDate(confirmedAt, input, windowStart)) continue;
      const key = futureIncidentCycleKey(incident.id, cycle);
      if (capturedIncidentCycleKeys.has(key)) continue;
      const existing = candidates.get(key);
      if (existing) {
        existing.confirmedAtConflict ||=
          existing.confirmedAt?.getTime() !== confirmedAt.getTime();
      } else {
        candidates.set(key, {
          confirmedAt,
          confirmedAtConflict: false,
          cycle,
          currentIncident: null,
          events: [],
          incidentId: incident.id
        });
      }
    }
  }

  for (const incident of eligibleIncidents) {
    for (const candidate of candidates.values()) {
      if (candidate.incidentId !== incident.id) continue;
      candidate.events.push(
        ...incident.terminalEvents.filter(
          (event) => readPositiveCycle(event.audit) === candidate.cycle
        )
      );
    }
    const confirmedAt = incident.confirmedAt;
    const confirmedAtIsEligible = isFutureWindowDate(confirmedAt, input, windowStart);
    const missingConfirmationRequiresAccounting =
      incident.status === "NEEDS_HUMAN" ||
      (incident.status === "RESOLVED" && incident.resolution !== "MONITORING_RESTORED");
    const missingConfirmationCouldBeFuture =
      !isValidDate(confirmedAt) &&
      missingConfirmationRequiresAccounting &&
      isValidDate(incident.lastSeenAt) &&
      incident.lastSeenAt.getTime() > input.campaignCapturedAt.getTime() &&
      incident.lastSeenAt.getTime() >= windowStart.getTime() &&
      incident.lastSeenAt.getTime() <= input.now.getTime();
    if (!confirmedAtIsEligible && !missingConfirmationCouldBeFuture) continue;
    const cycle = isPositiveInteger(incident.cycle) ? incident.cycle : 0;
    const key = futureIncidentCycleKey(incident.id, cycle || "unknown");
    if (capturedIncidentCycleKeys.has(key)) continue;
    const existing = candidates.get(key);
    if (existing) {
      existing.currentIncident = incident;
      existing.confirmedAtConflict ||=
        !isValidDate(confirmedAt) ||
        existing.confirmedAt?.getTime() !== confirmedAt.getTime();
    } else {
      candidates.set(key, {
        confirmedAt: confirmedAtIsEligible ? confirmedAt : null,
        confirmedAtConflict: false,
        cycle,
        currentIncident: incident,
        events: incident.terminalEvents.filter(
          (event) => readPositiveCycle(event.audit) === cycle
        ),
        incidentId: incident.id
      });
    }
  }

  if (candidates.size === 0) {
    return {
      windowDays: FUTURE_UNFAMILIAR_COURSE_WINDOW_DAYS,
      eligibleCount: 0,
      automaticCount: 0,
      nonAutomaticCount: 0,
      pendingCount: 0,
      unknownCount: 0,
      ratePercent: null,
      targetPercent: AUTOMATIC_RESOLUTION_TARGET_PERCENT,
      status: "NO_DATA"
    };
  }

  const counts = {
    AUTOMATIC: 0,
    NON_AUTOMATIC: 0,
    PENDING: 0,
    UNKNOWN: 0
  };
  for (const candidate of candidates.values()) {
    counts[classifyFutureUnfamiliarCycle(candidate, input.now)] += 1;
  }

  const eligibleCount = candidates.size;
  const ratePercent =
    counts.UNKNOWN > 0
      ? null
      : Math.round((counts.AUTOMATIC / eligibleCount) * 1000) / 10;
  const maximumPossibleAutomaticCount = counts.AUTOMATIC + counts.PENDING;
  const status =
    counts.UNKNOWN > 0
      ? ("UNKNOWN" as const)
      : counts.AUTOMATIC * 100 >=
          eligibleCount * AUTOMATIC_RESOLUTION_TARGET_PERCENT
        ? ("PASS" as const)
        : maximumPossibleAutomaticCount * 100 <
            eligibleCount * AUTOMATIC_RESOLUTION_TARGET_PERCENT
          ? ("FAIL" as const)
          : counts.PENDING > 0
            ? ("IN_PROGRESS" as const)
            : ("FAIL" as const);

  return {
    windowDays: FUTURE_UNFAMILIAR_COURSE_WINDOW_DAYS,
    eligibleCount,
    automaticCount: counts.AUTOMATIC,
    nonAutomaticCount: counts.NON_AUTOMATIC,
    pendingCount: counts.PENDING,
    unknownCount: counts.UNKNOWN,
    ratePercent,
    targetPercent: AUTOMATIC_RESOLUTION_TARGET_PERCENT,
    status
  };
}

function futureIncidentCycleKey(incidentId: string, cycle: number | "unknown") {
  return `${incidentId}\u0000cycle:${cycle}`;
}

function classifyFutureUnfamiliarCycle(
  candidate: {
    confirmedAt: Date | null;
    confirmedAtConflict: boolean;
    cycle: number;
    currentIncident: FutureUnfamiliarIncident | null;
    events: FutureTerminalEvent[];
    incidentId: string;
  },
  now: Date
): "AUTOMATIC" | "NON_AUTOMATIC" | "PENDING" | "UNKNOWN" {
  if (
    !isValidDate(candidate.confirmedAt) ||
    !isPositiveInteger(candidate.cycle) ||
    candidate.confirmedAtConflict
  ) {
    return "UNKNOWN";
  }
  const confirmedAt = candidate.confirmedAt;
  const elapsedMs = now.getTime() - confirmedAt.getTime();
  if (elapsedMs < 0) return "UNKNOWN";

  const incident = candidate.currentIncident;
  const humanFinal = Boolean(
    incident?.decisionAt ||
      incident?.decisionActorId ||
      incident?.resolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION" ||
      candidate.events.some((event) => isHumanCycleEvent(event))
  );
  if (humanFinal) return "NON_AUTOMATIC";

  const exactCycleEvents = candidate.events
    .filter(
      (event) =>
        (event.eventType === "RECOVERED" ||
          (event.eventType === "STATE_CHANGED" &&
            isTerminalRollingEndpointState(event.toState))) &&
        isValidDate(event.occurredAt) &&
        event.occurredAt.getTime() >= confirmedAt.getTime() &&
        event.occurredAt.getTime() <= now.getTime() &&
        readPositiveCycle(event.audit) === candidate.cycle &&
        readAuditDate(event.audit, "confirmedAt")?.getTime() === confirmedAt.getTime()
    )
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  const terminalEvent = exactCycleEvents[0];
  if (!terminalEvent) {
    if (incident && incident.status !== "RESOLVED") {
      return elapsedMs >= CAMPAIGN_RESOLUTION_DEADLINE_MS ? "NON_AUTOMATIC" : "PENDING";
    }
    return "UNKNOWN";
  }

  const automatedFinal = asRecord(terminalEvent.audit).automatedFinal;
  if (typeof automatedFinal !== "boolean") return "UNKNOWN";
  if (
    automatedFinal === false ||
    terminalEvent.operatorActorId ||
    isOperatorMonitoringSource(terminalEvent.source)
  ) {
    return "NON_AUTOMATIC";
  }
  if (!isAutomaticMonitoringSource(terminalEvent.source)) return "UNKNOWN";
  if (
    !isDeploymentSha(terminalEvent.runtimeVersion) ||
    !isDeploymentSha(terminalEvent.deploymentSha) ||
    terminalEvent.runtimeVersion.toLowerCase() !== terminalEvent.deploymentSha.toLowerCase()
  ) {
    return "UNKNOWN";
  }
  return terminalEvent.occurredAt.getTime() - confirmedAt.getTime() <=
    CAMPAIGN_RESOLUTION_DEADLINE_MS
    ? "AUTOMATIC"
    : "NON_AUTOMATIC";
}

function isFutureWindowDate(
  value: unknown,
  input: { campaignCapturedAt: Date; now: Date },
  windowStart: Date
): value is Date {
  return Boolean(
    isValidDate(value) &&
      value.getTime() > input.campaignCapturedAt.getTime() &&
      value.getTime() >= windowStart.getTime() &&
      value.getTime() <= input.now.getTime()
  );
}

function isHumanCycleEvent(event: FutureTerminalEvent) {
  const audit = asRecord(event.audit);
  return Boolean(
    event.eventType === "HUMAN_REVIEW_REQUESTED" ||
      event.eventType === "HUMAN_DECISION" ||
      audit.automatedFinal === false ||
      audit.resolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION" ||
      audit.decisionAt != null ||
      audit.decisionActorId != null ||
      event.operatorActorId ||
      isOperatorMonitoringSource(event.source)
  );
}

export function summarizeRepeatProviderImplementations(input: {
  batches: readonly ImplementationBatch[];
}): OperatorRepeatImplementations {
  const implementationCountsByGroup = new Map<string, number>();
  let implementationBatchCount = 0;
  let incompleteEvidence = false;

  for (const batch of input.batches) {
    if (!batch.deployedAt) continue;

    const summary = asRecord(batch.summary);
    const remediation = asRecord(summary.remediation);
    const requiresImplementationPath = remediation.requiresImplementationPath === true;
    const releaseChanged = Boolean(
      batch.releaseSha && batch.releaseSha !== batch.baseSha
    );

    if (!releaseChanged && !requiresImplementationPath) continue;
    if (
      !requiresImplementationPath ||
      !batch.releaseSha ||
      batch.releaseSha === batch.baseSha ||
      !hasValidImplementationProvenance(summary.releaseProvenance, batch.releaseSha)
    ) {
      incompleteEvidence = true;
      continue;
    }

    implementationBatchCount += 1;
    const groupKey = `${batch.providerFamilyKey}\u0000${batch.failureFingerprint}`;
    implementationCountsByGroup.set(
      groupKey,
      (implementationCountsByGroup.get(groupKey) ?? 0) + 1
    );
  }

  const repeatImplementationCount = [...implementationCountsByGroup.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0
  );
  return {
    repeatImplementationCount,
    implementationBatchCount,
    implementationGroupCount: implementationCountsByGroup.size,
    status:
      repeatImplementationCount > 0 ? "FAIL" : incompleteEvidence ? "UNKNOWN" : "PASS"
  };
}

export function buildOperatorCourseSupportCampaignSummary(input: {
  campaign: CampaignInspection;
  futureAutomaticWithin24Hours?: OperatorFutureAutomaticResolution;
  now: Date;
  repeatImplementations: OperatorRepeatImplementations;
  rollingHumanReview: OperatorRollingHumanReview;
}): OperatorCourseSupportCampaign {
  const campaign = input.campaign;
  const capturedAt = new Date(campaign.capturedAt);
  const deadlineAt = new Date(capturedAt.getTime() + CAMPAIGN_RESOLUTION_DEADLINE_MS);
  const totalCount = safeCount(campaign.totalCount);
  const expectedCount = safeCount(campaign.expectedCount);
  const terminalCount = safeCount(campaign.terminalCount);
  const pendingCount = safeCount(campaign.pendingCount);
  const readyCount = safeCount(campaign.readyCount);
  const activeCount = safeCount(campaign.activeCount);
  const monitoredCount = safeCount(campaign.monitoredCount);
  const bookingNotOpenCount = safeCount(campaign.bookingNotOpenCount);
  const factualLimitationCount = safeCount(campaign.factualLimitationCount);
  const technicalLimitationCount = safeCount(campaign.technicalLimitationCount);
  const sourceUnverifiedCount = safeCount(campaign.sourceUnverifiedCount);
  const engineeringBlockerCount = safeCount(campaign.engineeringBlockerCount);
  const missingCount = safeCount(campaign.currentResultMissingCount);
  const remainingGlobalParkedCount = safeCount(campaign.remainingGlobalParkedCount);
  const automaticCount = safeCount(campaign.automaticWithin24HoursCount);
  const terminalWithin24HoursCount = safeCount(campaign.terminalWithin24HoursCount);
  const currentResultCount = terminalCount + readyCount + activeCount + engineeringBlockerCount;
  const accountedCount = currentResultCount + missingCount;
  const allCountsAreValid =
    Number.isFinite(capturedAt.getTime()) &&
    [
      campaign.totalCount,
      campaign.expectedCount,
      campaign.terminalCount,
      campaign.pendingCount,
      campaign.readyCount,
      campaign.activeCount,
      campaign.monitoredCount,
      campaign.bookingNotOpenCount,
      campaign.factualLimitationCount,
      campaign.technicalLimitationCount,
      campaign.sourceUnverifiedCount,
      campaign.engineeringBlockerCount,
      campaign.currentResultMissingCount,
      campaign.humanReviewCount,
      campaign.terminalWithin24HoursCount,
      campaign.automaticWithin24HoursCount,
      campaign.remainingGlobalParkedCount
    ].every(isNonnegativeInteger);
  const bucketInvariantHolds =
    allCountsAreValid &&
    monitoredCount +
      bookingNotOpenCount +
      factualLimitationCount +
      technicalLimitationCount +
      sourceUnverifiedCount ===
      terminalCount &&
    accountedCount === totalCount;
  const countsAreCoherent =
    bucketInvariantHolds &&
    totalCount === expectedCount &&
    terminalCount + pendingCount === totalCount &&
    automaticCount <= terminalWithin24HoursCount &&
    terminalWithin24HoursCount <= terminalCount;

  return {
    status: campaign.status,
    capturedAt,
    expectedCount,
    progress: {
      terminalCount,
      totalCount,
      pendingCount,
      remainingGlobalParkedCount,
      status: !countsAreCoherent
        ? "UNKNOWN"
        : terminalCount === totalCount && remainingGlobalParkedCount === 0
          ? "COMPLETE"
          : "IN_PROGRESS"
    },
    currentResults: {
      resultCount: currentResultCount,
      accountedCount,
      totalCount,
      missingCount,
      monitoredCount,
      bookingNotOpenCount,
      factualLimitationCount,
      technicalLimitationCount,
      sourceUnverifiedCount,
      readyCount,
      activeCount,
      engineeringBlockerCount,
      campaignHumanReviewCount: safeCount(campaign.humanReviewCount),
      bucketInvariantStatus: bucketInvariantHolds ? "PASS" : "UNKNOWN",
      status: countsAreCoherent && missingCount === 0 ? "PASS" : "UNKNOWN"
    },
    automaticWithin24Hours: {
      automaticCount,
      totalCount,
      deadlineAt,
      targetPercent: AUTOMATIC_RESOLUTION_TARGET_PERCENT,
      status: getAutomaticWithin24HoursStatus({
        automaticCount,
        campaignStatus: campaign.status,
        countsAreCoherent,
        deadlineAt,
        now: input.now,
        terminalCount,
        totalCount
      })
    },
    futureAutomaticWithin24Hours:
      input.futureAutomaticWithin24Hours ?? unknownFutureAutomaticResolution(),
    rollingHumanReview: input.rollingHumanReview,
    repeatImplementations: input.repeatImplementations
  };
}

function getAutomaticWithin24HoursStatus(input: {
  automaticCount: number;
  campaignStatus: CampaignInspection["status"];
  countsAreCoherent: boolean;
  deadlineAt: Date;
  now: Date;
  terminalCount: number;
  totalCount: number;
}) {
  if (!input.countsAreCoherent || input.totalCount === 0) return "UNKNOWN" as const;
  if (
    input.automaticCount * 100 >=
    input.totalCount * AUTOMATIC_RESOLUTION_TARGET_PERCENT
  ) {
    return "PASS" as const;
  }
  const nonAutomaticTerminalCount = input.terminalCount - input.automaticCount;
  const maximumPossibleAutomaticCount = input.totalCount - nonAutomaticTerminalCount;
  if (
    input.campaignStatus === "FAILED" ||
    input.campaignStatus === "COMPLETED" ||
    maximumPossibleAutomaticCount * 100 <
      input.totalCount * AUTOMATIC_RESOLUTION_TARGET_PERCENT ||
    input.now.getTime() >= input.deadlineAt.getTime()
  ) {
    return "FAIL" as const;
  }
  return "IN_PROGRESS" as const;
}

function getEndpointKind(event: RollingEndpointEvent) {
  const audit = asRecord(event.audit);
  if (
    event.eventType === "STATE_CHANGED" &&
    !isTerminalRollingEndpointState(event.toState)
  ) {
    return null;
  }
  if (
    event.eventType === "HUMAN_REVIEW_REQUESTED" ||
    event.eventType === "HUMAN_DECISION" ||
    audit.automatedFinal === false ||
    audit.resolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION" ||
    audit.decisionAt != null ||
    audit.decisionActorId != null ||
    event.operatorActorId ||
    (event.source && isOperatorMonitoringSource(event.source))
  ) {
    return "HUMAN" as const;
  }
  if (event.eventType !== "RECOVERED" && event.eventType !== "STATE_CHANGED") return null;
  if (audit.automatedFinal !== true || !isAutomaticMonitoringSource(event.source)) {
    return "UNKNOWN" as const;
  }
  if (
    !isDeploymentSha(event.runtimeVersion) ||
    !isDeploymentSha(event.deploymentSha) ||
    event.runtimeVersion.toLowerCase() !== event.deploymentSha.toLowerCase()
  ) {
    return "UNKNOWN" as const;
  }
  return "AUTOMATIC" as const;
}

function readPositiveCycle(value: unknown) {
  const cycle = asRecord(value).cycle;
  return typeof cycle === "number" && Number.isInteger(cycle) && cycle > 0 ? cycle : null;
}

function readAuditDate(value: unknown, key: string) {
  const raw = asRecord(value)[key];
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw;
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function hasValidImplementationProvenance(value: unknown, releaseSha: string) {
  const provenance = asRecord(value);
  return Boolean(
    provenance.schemaVersion === 1 &&
      typeof provenance.fromSha === "string" &&
      provenance.fromSha.length > 0 &&
      provenance.toSha === releaseSha &&
      typeof provenance.branch === "string" &&
      provenance.branch.length > 0 &&
      provenance.descendantVerified === true &&
      Array.isArray(provenance.committedPaths) &&
      provenance.committedPaths.length > 0 &&
      provenance.committedPaths.every((path) => typeof path === "string") &&
      provenance.committedPaths.some(
        (path) => typeof path === "string" && isRuntimeBearingPath(path)
      )
  );
}

function isRuntimeBearingPath(value: string) {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
  if (!normalized) return false;
  const segments = normalized.split("/");
  const fileName = segments.at(-1) ?? "";
  return !(
    segments.some((segment) =>
      ["doc", "docs", "test", "tests", "__tests__", "note", "notes"].includes(segment)
    ) ||
    /(?:^|\.)(?:test|spec)\.[^.]+$/u.test(fileName) ||
    /\.(?:md|mdx|txt|rst|adoc)$/u.test(fileName) ||
    /^(?:readme|changelog|license)(?:\.|$)/u.test(fileName)
  );
}

function isOperatorMonitoringSource(value: string) {
  return value === "OPERATOR_DASHBOARD" || value === "OPERATOR_CLI" || value === "MAINTENANCE";
}

function isAutomaticMonitoringSource(value: string | null) {
  return (
    value === "SEARCH_WORKFLOW" ||
    value === "COURSE_SUPPORT_RESPONDER" ||
    value === "LOCAL_READER" ||
    value === "RECOVERY_CRON" ||
    value === "DEPLOYMENT"
  );
}

function isTerminalRollingEndpointState(value: string | null) {
  return (
    value === "FINAL_MANUAL" ||
    value === "FINAL_IDENTITY" ||
    value === "FINAL_TECHNICAL"
  );
}

function isDeploymentSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,40}$/iu.test(value);
}

function unknownFutureAutomaticResolution(): OperatorFutureAutomaticResolution {
  return {
    windowDays: FUTURE_UNFAMILIAR_COURSE_WINDOW_DAYS,
    eligibleCount: 0,
    automaticCount: 0,
    nonAutomaticCount: 0,
    pendingCount: 0,
    unknownCount: 0,
    ratePercent: null,
    targetPercent: AUTOMATIC_RESOLUTION_TARGET_PERCENT,
    status: "UNKNOWN"
  };
}

function safeCount(value: number) {
  return isNonnegativeInteger(value) ? value : 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const defaultDependencies: OperatorCourseSupportCampaignDependencies = {
  inspectLatestCampaign: inspectLatestParkedCourseCampaign,
  loadCampaignAudit: async (runId) => {
    const run = await prisma.automationRun.findUnique({
      where: { id: runId },
      select: { audit: true }
    });
    return run?.audit ?? null;
  },
  loadRollingEndpointEvents: async ({ since, until }) => {
    const endpointEvents = await prisma.courseMonitoringEvent.findMany({
      where: {
        incidentId: { not: null },
        occurredAt: { gte: since, lte: until },
        eventType: {
          in: ["HUMAN_REVIEW_REQUESTED", "HUMAN_DECISION", "RECOVERED", "STATE_CHANGED"]
        }
      },
      select: {
        incidentId: true
      }
    });
    const incidentIds = [
      ...new Set(
        endpointEvents
          .map((event) => event.incidentId)
          .filter((incidentId): incidentId is string => Boolean(incidentId))
      )
    ];
    if (incidentIds.length === 0) return [];
    const fullCycleEvidence = await prisma.courseMonitoringEvent.findMany({
      where: {
        incidentId: { in: incidentIds },
        occurredAt: { lte: until },
        eventType: {
          in: ["HUMAN_REVIEW_REQUESTED", "HUMAN_DECISION", "RECOVERED", "STATE_CHANGED"]
        }
      },
      select: {
        incidentId: true,
        eventType: true,
        toState: true,
        source: true,
        operatorActorId: true,
        runtimeVersion: true,
        deploymentSha: true,
        occurredAt: true,
        audit: true
      }
    });
    return fullCycleEvidence.map((event) => ({
      ...event,
      countsAsEndpoint: event.occurredAt.getTime() >= since.getTime()
    }));
  },
  loadFutureUnfamiliarIncidents: async ({ since, until }) => {
    const statuses = ["AUTO_INVESTIGATING", "NEEDS_HUMAN", "RESOLVED"] as const;
    const partitions = await Promise.all(
      statuses.map((status) =>
        prisma.courseSupportIncident.findMany({
          where: {
            status,
            lastSeenAt: { gte: since, lte: until }
          },
          select: {
            id: true,
            courseId: true,
            cycle: true,
            status: true,
            resolution: true,
            confirmedAt: true,
            lastSeenAt: true,
            resolvedAt: true,
            decisionAt: true,
            decisionActorId: true,
            monitoringEvents: {
              where: {
                occurredAt: { gte: since, lte: until },
                eventType: {
                  in: ["HUMAN_REVIEW_REQUESTED", "HUMAN_DECISION", "RECOVERED", "STATE_CHANGED"]
                }
              },
              select: {
                eventType: true,
                toState: true,
                source: true,
                operatorActorId: true,
                runtimeVersion: true,
                deploymentSha: true,
                occurredAt: true,
                audit: true
              }
            }
          }
        })
      )
    );
    return partitions.flat().map(({ monitoringEvents, ...incident }) => ({
      ...incident,
      terminalEvents: monitoringEvents
    }));
  },
  loadImplementationBatches: ({ capturedAt, until }) =>
    prisma.courseSupportBatch.findMany({
      where: {
        deployedAt: { gte: capturedAt, lte: until }
      },
      select: {
        providerFamilyKey: true,
        failureFingerprint: true,
        baseSha: true,
        releaseSha: true,
        deployedAt: true,
        summary: true
      }
    })
};
