import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { hasDurableWaitForMaterialChangeProof } from "@/lib/customer-monitoring-status";
import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import { stableCourseProviderExecutionEvidenceValue } from "./course-provider-execution-evidence";
import { withPostgresAdvisoryTextLease } from "./lease";
import { assessAutomationPlaybook } from "./course-monitoring-playbook";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import { getAutomationRuntimeVersion } from "./runtime-version";
import { COURSE_SUPPORT_WRITER_LANE } from "./writer-lanes";

export const PARKED_COURSE_CAMPAIGN_PROMPT_VERSION =
  "tee-time-spot-course-support-parked-cohort-v1";
export const PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION = 2 as const;
export const PARKED_COURSE_CAMPAIGN_MAX_ADMISSION = 5;
export const PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT = 112;

const campaignMemberSchema = z
  .object({
    courseId: z.string().min(1),
    incidentId: z.string().min(1),
    cycle: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    monitoringRevision: z.number().int().nonnegative(),
    monitoringFailureFingerprint: z.string().min(1).nullable(),
    kind: z.string().min(1),
    providerFamilyKey: z.string().min(1),
    failureClass: z.string().min(1),
    failureFingerprint: z.string().min(1),
    providerSnapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    attemptLedgerFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    playbookConclusion: z.string().min(1),
    latestProbeAt: z.string().datetime().nullable(),
    latestDiscoveryAt: z.string().datetime().nullable()
  })
  .strict();

const campaignEvidenceCategoryCountsSchema = z
  .object({
    sourceMissingCount: z.number().int().nonnegative(),
    sourceConflictCount: z.number().int().nonnegative(),
    providerSpecificCount: z.number().int().nonnegative(),
    priorProbeCount: z.number().int().nonnegative(),
    priorDiscoveryCount: z.number().int().nonnegative(),
    noPriorEvidenceCount: z.number().int().nonnegative()
  })
  .strict();

const parkedCourseCampaignAuditSchema = z
  .object({
    schemaVersion: z.literal(PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION),
    campaignKind: z.literal("PARKED_COHORT"),
    expectedCount: z.number().int().positive(),
    capturedAt: z.string().datetime(),
    membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    aggregateEvidenceCategories: campaignEvidenceCategoryCountsSchema,
    members: z.array(campaignMemberSchema).min(1),
    customerDataIncluded: z.literal(false)
  })
  .strict()
  .superRefine((audit, context) => {
    if (audit.members.length !== audit.expectedCount) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "The parked-course campaign count does not match its immutable membership."
      });
    }
    const sortedCourseIds = audit.members.map((member) => member.courseId).sort();
    if (
      sortedCourseIds.some((courseId, index) => courseId !== audit.members[index]?.courseId) ||
      new Set(sortedCourseIds).size !== sortedCourseIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "The parked-course campaign membership must be unique and sorted."
      });
    }
    if (createParkedCourseCampaignMembershipDigest(audit.members) !== audit.membershipDigest) {
      context.addIssue({
        code: "custom",
        path: ["membershipDigest"],
        message: "The parked-course campaign membership digest is invalid."
      });
    }
    if (
      JSON.stringify(audit.aggregateEvidenceCategories) !==
      JSON.stringify(summarizeCampaignEvidenceCategories(audit.members))
    ) {
      context.addIssue({
        code: "custom",
        path: ["aggregateEvidenceCategories"],
        message: "The parked-course campaign aggregate evidence categories are invalid."
      });
    }
  });

export type ParkedCourseCampaignMember = z.infer<typeof campaignMemberSchema>;
export type ParkedCourseCampaignAudit = z.infer<typeof parkedCourseCampaignAuditSchema>;

export type ParkedCourseCampaignAdmissionMember = ParkedCourseCampaignMember & {
  activeRealSearchCount: number;
  capturedRevision: number;
  capturedMonitoringRevision: number;
};

export type ParkedCourseCampaignTerminalKind =
  | "MONITORED"
  | "BOOKING_NOT_OPEN"
  | "FACTUAL_LIMITATION"
  | "TECHNICAL_LIMITATION"
  | "SOURCE_UNVERIFIED";

export type ParkedCourseCampaignMemberObservation = {
  courseId: string;
  incidentId: string | null;
  cycle: number | null;
  status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED" | null;
  activeBatchId: string | null;
  confirmedAt: Date | null;
  resolution:
    | "MONITORING_RESTORED"
    | "DIRECT_BOOKING_CLASSIFIED"
    | "IDENTITY_CLASSIFIED"
    | "TECHNICAL_LIMITATION_CLASSIFIED"
    | "SOURCE_UNVERIFIED"
    | "HUMAN_VERIFIED_TECHNICAL_LIMITATION"
    | null;
  resolvedAt: Date | null;
  decisionAt: Date | null;
  monitoringState: string | null;
  monitoringStateChangedAt: Date | null;
  latestProbe: {
    outcome: string;
    observedAt: Date;
    runtimeVersion: string | null;
    rawSummary: unknown;
  } | null;
  campaignTerminalEvidenceAt: Date | null;
  campaignTerminalRuntimeVersion: string | null;
  campaignTerminalAutomatedFinal: boolean | null;
  currentlyParked: boolean;
  humanReviewCycles: number[];
};

export type ParkedCourseCampaignProgress = {
  capturedAt: string;
  expectedCount: number;
  totalCount: number;
  terminalCount: number;
  pendingCount: number;
  readyCount: number;
  activeCount: number;
  monitoredCount: number;
  bookingNotOpenCount: number;
  factualLimitationCount: number;
  technicalLimitationCount: number;
  sourceUnverifiedCount: number;
  engineeringBlockerCount: number;
  currentResultMissingCount: number;
  humanReviewCount: number;
  terminalWithin24HoursCount: number;
  automaticWithin24HoursCount: number;
  remainingGlobalParkedCount: number;
  membershipDigest: string;
};

type StoredCampaignRun = {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  completedAt: Date | null;
  outcome: string | null;
  audit: Prisma.JsonValue | null;
};

type ParkedCourseCampaignDependencies = {
  loadLatestCampaign: () => Promise<StoredCampaignRun | null>;
  loadActiveCampaign: () => Promise<StoredCampaignRun | null>;
  loadParkedMembers: () => Promise<ParkedCourseCampaignMember[]>;
  loadAllParkedMembers?: () => Promise<ParkedCourseCampaignMember[]>;
  loadGlobalParkedCount?: () => Promise<number>;
  loadMemberObservations: (
    audit: ParkedCourseCampaignAudit,
    parkedCourseIds: ReadonlySet<string>,
    campaignRunId: string
  ) => Promise<ParkedCourseCampaignMemberObservation[]>;
  createCampaign: (audit: ParkedCourseCampaignAudit) => Promise<StoredCampaignRun>;
  completeCampaign: (
    runId: string,
    audit: ParkedCourseCampaignAudit,
    progress: ParkedCourseCampaignProgress
  ) => Promise<boolean>;
  withTransitionLease: <T>(
    worker: () => Promise<T>
  ) => Promise<{ acquired: true; value: T } | { acquired: false }>;
};

type ParkedCourseCampaignDatabase = Pick<
  Prisma.TransactionClient,
  "automationRun" | "courseSupportIncident"
>;

export function parseParkedCourseCampaignAudit(value: unknown) {
  const parsed = parkedCourseCampaignAuditSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createParkedCourseCampaignMembershipDigest(
  members: readonly ParkedCourseCampaignMember[]
) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...members]
          .sort((left, right) => left.courseId.localeCompare(right.courseId))
          .map((member) => ({
            courseId: member.courseId,
            incidentId: member.incidentId,
            cycle: member.cycle,
            revision: member.revision,
            monitoringRevision: member.monitoringRevision,
            monitoringFailureFingerprint: member.monitoringFailureFingerprint,
            kind: member.kind,
            providerFamilyKey: member.providerFamilyKey,
            failureClass: member.failureClass,
            failureFingerprint: member.failureFingerprint,
            providerSnapshotFingerprint: member.providerSnapshotFingerprint,
            attemptLedgerFingerprint: member.attemptLedgerFingerprint,
            playbookConclusion: member.playbookConclusion,
            latestProbeAt: member.latestProbeAt,
            latestDiscoveryAt: member.latestDiscoveryAt
          }))
      )
    )
    .digest("hex");
}

export function summarizeCampaignEvidenceCategories(
  members: readonly ParkedCourseCampaignMember[]
) {
  return members.reduce(
    (counts, member) => {
      if (member.providerFamilyKey === "SOURCE_MISSING") {
        counts.sourceMissingCount += 1;
      } else if (member.providerFamilyKey === "SOURCE_CONFLICT") {
        counts.sourceConflictCount += 1;
      } else {
        counts.providerSpecificCount += 1;
      }
      if (member.latestProbeAt) counts.priorProbeCount += 1;
      if (member.latestDiscoveryAt) counts.priorDiscoveryCount += 1;
      if (!member.latestProbeAt && !member.latestDiscoveryAt) {
        counts.noPriorEvidenceCount += 1;
      }
      return counts;
    },
    {
      sourceMissingCount: 0,
      sourceConflictCount: 0,
      providerSpecificCount: 0,
      priorProbeCount: 0,
      priorDiscoveryCount: 0,
      noPriorEvidenceCount: 0
    }
  );
}

export function createParkedCourseCampaignAudit(input: {
  expectedCount: number;
  capturedAt: Date;
  members: readonly ParkedCourseCampaignMember[];
}): ParkedCourseCampaignAudit {
  const members = [...input.members].sort((left, right) =>
    left.courseId.localeCompare(right.courseId)
  );
  return parkedCourseCampaignAuditSchema.parse({
    schemaVersion: PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION,
    campaignKind: "PARKED_COHORT",
    expectedCount: input.expectedCount,
    capturedAt: input.capturedAt.toISOString(),
    membershipDigest: createParkedCourseCampaignMembershipDigest(members),
    aggregateEvidenceCategories: summarizeCampaignEvidenceCategories(members),
    members,
    customerDataIncluded: false
  });
}

export function summarizeParkedCourseCampaignProgress(input: {
  audit: ParkedCourseCampaignAudit;
  observations: readonly ParkedCourseCampaignMemberObservation[];
  remainingGlobalParkedCount: number;
}): ParkedCourseCampaignProgress {
  const capturedAt = new Date(input.audit.capturedAt);
  const observationByCourseId = new Map(
    input.observations.map((observation) => [observation.courseId, observation])
  );
  const counts = {
    terminalCount: 0,
    readyCount: 0,
    activeCount: 0,
    monitoredCount: 0,
    bookingNotOpenCount: 0,
    factualLimitationCount: 0,
    technicalLimitationCount: 0,
    sourceUnverifiedCount: 0,
    engineeringBlockerCount: 0,
    currentResultMissingCount: 0,
    humanReviewCount: 0,
    terminalWithin24HoursCount: 0,
    automaticWithin24HoursCount: 0
  };
  const humanReviewKeys = new Set<string>();

  for (const member of input.audit.members) {
    const observation = observationByCourseId.get(member.courseId);
    const terminalKind = observation ? getFreshTerminalKind(member, observation, capturedAt) : null;
    if (terminalKind) {
      counts.terminalCount += 1;
      if (
        observation?.campaignTerminalEvidenceAt &&
        observation.campaignTerminalEvidenceAt.getTime() <=
          capturedAt.getTime() + 24 * 60 * 60 * 1000
      ) {
        counts.terminalWithin24HoursCount += 1;
        if (
          observation.resolution !== "HUMAN_VERIFIED_TECHNICAL_LIMITATION" &&
          observation.decisionAt === null &&
          !observation.humanReviewCycles.includes(observation.cycle ?? -1) &&
          observation.campaignTerminalAutomatedFinal === true
        ) {
          counts.automaticWithin24HoursCount += 1;
        }
      }
      if (
        observation?.incidentId &&
        observation.cycle !== null &&
        observation.campaignTerminalAutomatedFinal === false
      ) {
        humanReviewKeys.add(`${observation.incidentId}\u0000${observation.cycle}`);
      }
      if (terminalKind === "MONITORED") counts.monitoredCount += 1;
      if (terminalKind === "BOOKING_NOT_OPEN") counts.bookingNotOpenCount += 1;
      if (terminalKind === "FACTUAL_LIMITATION") counts.factualLimitationCount += 1;
      if (terminalKind === "TECHNICAL_LIMITATION") counts.technicalLimitationCount += 1;
      if (terminalKind === "SOURCE_UNVERIFIED") counts.sourceUnverifiedCount += 1;
      continue;
    }
    if (observation?.currentlyParked) {
      counts.readyCount += 1;
      continue;
    }
    if (
      observation?.incidentId === member.incidentId &&
      observation.cycle !== null &&
      observation.cycle > member.cycle &&
      observation.status === "AUTO_INVESTIGATING"
    ) {
      counts.activeCount += 1;
      continue;
    }
    if (
      !observation ||
      observation.incidentId !== member.incidentId ||
      observation.status === "NEEDS_HUMAN" ||
      observation.status === "RESOLVED"
    ) {
      counts.engineeringBlockerCount += 1;
      continue;
    }
    counts.currentResultMissingCount += 1;
  }

  for (const observation of input.observations) {
    if (!observation.incidentId) continue;
    for (const cycle of observation.humanReviewCycles) {
      humanReviewKeys.add(`${observation.incidentId}\u0000${cycle}`);
    }
  }
  counts.humanReviewCount = humanReviewKeys.size;

  return {
    capturedAt: input.audit.capturedAt,
    expectedCount: input.audit.expectedCount,
    totalCount: input.audit.members.length,
    ...counts,
    pendingCount: input.audit.members.length - counts.terminalCount,
    remainingGlobalParkedCount: input.remainingGlobalParkedCount,
    membershipDigest: input.audit.membershipDigest
  };
}

export async function runParkedCourseCampaignCommand(
  input: {
    apply: boolean;
    expectedCount: number;
    expectedDigest?: string | null;
    now?: Date;
  },
  dependencies: ParkedCourseCampaignDependencies = defaultDependencies
) {
  const now = input.now ?? new Date();
  assertExpectedCampaignCount(input.expectedCount);
  assertExpectedCampaignDigest(input.expectedDigest);

  const existing = await dependencies.loadLatestCampaign();
  if (existing) {
    return buildExistingCampaignResult(
      existing,
      input.expectedCount,
      input.apply ? "apply" : "dry-run",
      dependencies
    );
  }

  const previewMembers = await dependencies.loadParkedMembers();
  const previewDigest = createParkedCourseCampaignMembershipDigest(previewMembers);
  if (!input.apply) {
    return {
      scope: "parked-cohort" as const,
      mode: "dry-run" as const,
      campaignState: "PREVIEW" as const,
      expectedCount: input.expectedCount,
      capturedCount: previewMembers.length,
      countMatches: previewMembers.length === input.expectedCount,
      membershipDigest: previewDigest,
      aggregateEvidenceCategories: summarizeCampaignEvidenceCategories(previewMembers),
      resumed: false
    };
  }
  if (!input.expectedDigest) {
    throw new Error(
      "--expect-digest from a current parked-cohort dry run is required with --apply."
    );
  }

  const transition = await dependencies.withTransitionLease(async () => {
    const resumed = await dependencies.loadLatestCampaign();
    if (resumed) {
      return { run: resumed, resumed: true };
    }
    const members = await dependencies.loadParkedMembers();
    if (members.length !== input.expectedCount) {
      throw new Error(
        `Parked-course cohort changed: expected ${input.expectedCount}, observed ${members.length}.`
      );
    }
    const audit = createParkedCourseCampaignAudit({
      expectedCount: input.expectedCount,
      capturedAt: now,
      members
    });
    assertCampaignSnapshotMatchesExpectation(audit, input.expectedCount, input.expectedDigest!);
    return { run: await dependencies.createCampaign(audit), resumed: false };
  });
  if (!transition.acquired) {
    throw new Error("The course-support writer is busy; rerun the parked-cohort command.");
  }
  const result = await buildExistingCampaignResult(
    transition.value.run,
    input.expectedCount,
    "apply",
    dependencies
  );
  return {
    ...result,
    mode: "apply" as const,
    resumed: transition.value.resumed
  };
}

export async function inspectActiveParkedCourseCampaign(
  input?: { completeIfDone?: boolean },
  dependencies: ParkedCourseCampaignDependencies = defaultDependencies
) {
  const run = await dependencies.loadActiveCampaign();
  if (!run) return null;
  const audit = requireCampaignAudit(run);
  const progress = await loadCampaignProgress(run.id, audit, dependencies);
  let status = run.status;
  if (
    input?.completeIfDone &&
    progress.terminalCount === progress.totalCount &&
    progress.remainingGlobalParkedCount === 0
  ) {
    const completed = await dependencies.completeCampaign(run.id, audit, progress);
    if (completed) status = "COMPLETED";
  }
  return { runId: run.id, status, ...progress };
}

export async function inspectLatestParkedCourseCampaign() {
  const run = await defaultDependencies.loadLatestCampaign();
  if (!run) return null;
  const audit = requireCampaignAudit(run);
  return {
    runId: run.id,
    status: run.status,
    ...(await loadCampaignProgress(run.id, audit, defaultDependencies))
  };
}

export async function planNextParkedCourseCampaignCohort(input: {
  now: Date;
  maxCourses: number;
  hasDueRealDemand: boolean;
  activeProviderGroups: ReadonlySet<string>;
}): Promise<{
  members: ParkedCourseCampaignAdmissionMember[];
  campaignRunId: string | null;
  membershipDigest: string | null;
}> {
  const run = await defaultDependencies.loadActiveCampaign();
  if (!run) {
    return {
      members: [],
      campaignRunId: null,
      membershipDigest: null
    };
  }
  const audit = requireCampaignAudit(run);
  const memberByCourseId = new Map(audit.members.map((member) => [member.courseId, member]));
  const admissionMembers = (await loadParkedCourseCampaignAdmissionMembers(audit)).filter(
    (member) => {
      const captured = memberByCourseId.get(member.courseId);
      return captured ? isSameCampaignMemberMaterialSnapshot(captured, member) : false;
    }
  );
  const eligibleMembers = input.hasDueRealDemand
    ? admissionMembers.filter((member) => member.activeRealSearchCount > 0)
    : admissionMembers;
  const groups = new Map<string, ParkedCourseCampaignAdmissionMember[]>();
  for (const member of eligibleMembers) {
    const key = `${member.providerFamilyKey}\u0000${member.failureFingerprint}`;
    if (input.activeProviderGroups.has(key)) continue;
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  const selected = [...groups.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        Number(right.some((member) => member.activeRealSearchCount > 0)) -
          Number(left.some((member) => member.activeRealSearchCount > 0)) ||
        leftKey.localeCompare(rightKey)
    )[0]?.[1]
    ?.sort((left, right) => left.courseId.localeCompare(right.courseId))
    .slice(0, Math.min(PARKED_COURSE_CAMPAIGN_MAX_ADMISSION, Math.max(1, input.maxCourses)));
  if (!selected?.length) {
    return {
      members: [],
      campaignRunId: run.id,
      membershipDigest: audit.membershipDigest
    };
  }

  return {
    members: selected,
    campaignRunId: run.id,
    membershipDigest: audit.membershipDigest
  };
}

function getFreshTerminalKind(
  member: ParkedCourseCampaignMember,
  observation: ParkedCourseCampaignMemberObservation,
  capturedAt: Date
): ParkedCourseCampaignTerminalKind | null {
  const evidenceNotBefore = observation.confirmedAt;
  if (
    observation.incidentId !== member.incidentId ||
    observation.cycle === null ||
    observation.cycle <= member.cycle ||
    observation.status !== "RESOLVED" ||
    observation.activeBatchId !== null ||
    !evidenceNotBefore ||
    evidenceNotBefore < capturedAt ||
    !observation.resolvedAt ||
    observation.resolvedAt < evidenceNotBefore ||
    !observation.monitoringStateChangedAt ||
    observation.monitoringStateChangedAt < evidenceNotBefore ||
    !observation.campaignTerminalEvidenceAt ||
    observation.campaignTerminalEvidenceAt < evidenceNotBefore ||
    !observation.campaignTerminalRuntimeVersion ||
    observation.campaignTerminalAutomatedFinal === null
  ) {
    return null;
  }
  if (observation.resolution === "MONITORING_RESTORED") {
    if (
      observation.monitoringState !== "HEALTHY" ||
      !isFreshSuccessfulProbe(observation.latestProbe, evidenceNotBefore) ||
      observation.latestProbe?.runtimeVersion !== observation.campaignTerminalRuntimeVersion
    ) {
      return null;
    }
    return isFreshBookingNotOpenProbe(observation.latestProbe, evidenceNotBefore)
      ? "BOOKING_NOT_OPEN"
      : "MONITORED";
  }
  if (observation.resolution === "DIRECT_BOOKING_CLASSIFIED") {
    return observation.monitoringState === "FINAL_MANUAL" ? "FACTUAL_LIMITATION" : null;
  }
  if (observation.resolution === "IDENTITY_CLASSIFIED") {
    return observation.monitoringState === "FINAL_IDENTITY" ? "FACTUAL_LIMITATION" : null;
  }
  if (observation.resolution === "SOURCE_UNVERIFIED") {
    return observation.monitoringState === "FINAL_TECHNICAL" ? "SOURCE_UNVERIFIED" : null;
  }
  if (
    (observation.resolution === "TECHNICAL_LIMITATION_CLASSIFIED" ||
      observation.resolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION") &&
    observation.monitoringState === "FINAL_TECHNICAL"
  ) {
    return "TECHNICAL_LIMITATION";
  }
  return null;
}

function isFreshSuccessfulProbe(
  probe: ParkedCourseCampaignMemberObservation["latestProbe"],
  capturedAt: Date
) {
  return Boolean(
    probe &&
      (probe.outcome === "MATCH_FOUND" || probe.outcome === "NO_MATCH") &&
      probe.runtimeVersion &&
      probe.observedAt >= capturedAt
  );
}

function isFreshBookingNotOpenProbe(
  probe: ParkedCourseCampaignMemberObservation["latestProbe"],
  capturedAt: Date
) {
  if (!isFreshSuccessfulProbe(probe, capturedAt) || !probe?.rawSummary) {
    return false;
  }
  if (typeof probe.rawSummary !== "object" || Array.isArray(probe.rawSummary)) {
    return false;
  }
  const summary = probe.rawSummary as Record<string, unknown>;
  return summary.targetDateStatus === "NOT_OPEN" || Boolean(summary.bookingWindow);
}

async function buildExistingCampaignResult(
  run: StoredCampaignRun,
  expectedCount: number,
  mode: "apply" | "dry-run",
  dependencies: ParkedCourseCampaignDependencies
) {
  const audit = requireCampaignAudit(run);
  if (audit.expectedCount !== expectedCount) {
    throw new Error(
      `The existing parked-course campaign expects ${audit.expectedCount} courses, not ${expectedCount}.`
    );
  }
  const progress = await loadCampaignProgress(run.id, audit, dependencies);
  return {
    scope: "parked-cohort" as const,
    mode,
    campaignState: run.status === "RUNNING" ? ("ACTIVE" as const) : run.status,
    expectedCount,
    capturedCount: audit.members.length,
    countMatches: audit.members.length === expectedCount,
    membershipDigest: audit.membershipDigest,
    aggregateEvidenceCategories: audit.aggregateEvidenceCategories,
    resumed: true,
    progress
  };
}

async function loadCampaignProgress(
  campaignRunId: string,
  audit: ParkedCourseCampaignAudit,
  dependencies: ParkedCourseCampaignDependencies
) {
  const parkedMembers = await (dependencies.loadAllParkedMembers?.() ??
    dependencies.loadParkedMembers());
  const remainingGlobalParkedCount = dependencies.loadGlobalParkedCount
    ? await dependencies.loadGlobalParkedCount()
    : parkedMembers.length;
  const memberByCourseId = new Map(audit.members.map((member) => [member.courseId, member]));
  const parkedCourseIds = new Set(
    parkedMembers.flatMap((member) => {
      const captured = memberByCourseId.get(member.courseId);
      return captured && isSameCampaignMemberMaterialSnapshot(captured, member)
        ? [member.courseId]
        : [];
    })
  );
  return summarizeParkedCourseCampaignProgress({
    audit,
    observations: await dependencies.loadMemberObservations(
      audit,
      parkedCourseIds,
      campaignRunId
    ),
    remainingGlobalParkedCount
  });
}

function isSameCampaignMemberMaterialSnapshot(
  captured: ParkedCourseCampaignMember,
  current: ParkedCourseCampaignMember
) {
  return (
    captured.courseId === current.courseId &&
    captured.incidentId === current.incidentId &&
    captured.cycle === current.cycle &&
    captured.kind === current.kind &&
    captured.monitoringFailureFingerprint === current.monitoringFailureFingerprint &&
    captured.providerFamilyKey === current.providerFamilyKey &&
    captured.failureClass === current.failureClass &&
    captured.failureFingerprint === current.failureFingerprint &&
    captured.providerSnapshotFingerprint === current.providerSnapshotFingerprint &&
    captured.attemptLedgerFingerprint === current.attemptLedgerFingerprint &&
    captured.playbookConclusion === current.playbookConclusion &&
    captured.latestProbeAt === current.latestProbeAt &&
    captured.latestDiscoveryAt === current.latestDiscoveryAt
  );
}

function requireCampaignAudit(run: StoredCampaignRun) {
  const audit = parseParkedCourseCampaignAudit(run.audit);
  if (!audit) {
    throw new Error("The parked-course campaign audit is missing or invalid.");
  }
  return audit;
}

function assertExpectedCampaignCount(value: number) {
  if (value !== PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT) {
    throw new Error(
      `--expect-count must equal the immutable baseline of ${PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT}.`
    );
  }
}

function assertExpectedCampaignDigest(value: string | null | undefined) {
  if (value !== undefined && value !== null && !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("--expect-digest must be a lowercase SHA-256 digest.");
  }
}

function assertCampaignSnapshotMatchesExpectation(
  audit: ParkedCourseCampaignAudit,
  expectedCount: number,
  expectedDigest: string
) {
  if (audit.members.length !== expectedCount) {
    throw new Error(
      `Parked-course cohort changed: expected ${expectedCount}, observed ${audit.members.length}.`
    );
  }
  if (audit.membershipDigest !== expectedDigest) {
    throw new Error("Parked-course cohort changed after dry run; rerun without --apply.");
  }
}

export async function loadParkedCourseCampaignMembers(
  database: ParkedCourseCampaignDatabase = prisma
) {
  const snapshots = await loadParkedCourseCampaignMemberSnapshots(database, {
    requireZeroDemand: true
  });
  return snapshots.map(({ activeRealSearchCount, ...member }) => {
    if (activeRealSearchCount !== 0) {
      throw new Error("The immutable parked-course campaign cannot capture active demand.");
    }
    return member;
  });
}

async function loadAllParkedCourseCampaignMembers(
  database: ParkedCourseCampaignDatabase = prisma
) {
  return loadParkedCourseCampaignMemberSnapshots(database, {
    requireZeroDemand: false
  });
}

async function loadGlobalParkedCourseCampaignCount(
  database: ParkedCourseCampaignDatabase = prisma
) {
  return database.courseSupportIncident.count({
    where: {
      status: "NEEDS_HUMAN",
      humanReviewReason: "AUTOMATION_STALLED",
      activeBatchId: null,
      nextAttemptAt: null
    }
  });
}

async function loadParkedCourseCampaignAdmissionMembers(
  audit: ParkedCourseCampaignAudit,
  database: ParkedCourseCampaignDatabase = prisma
): Promise<ParkedCourseCampaignAdmissionMember[]> {
  const capturedByIncidentId = new Map(
    audit.members.map((member) => [member.incidentId, member])
  );
  const currentMembers = await loadParkedCourseCampaignMemberSnapshots(database, {
    requireZeroDemand: false,
    incidentIds: audit.members.map((member) => member.incidentId)
  });
  return currentMembers.flatMap((current) => {
    const captured = capturedByIncidentId.get(current.incidentId);
    if (!captured || !isSameCampaignMemberMaterialSnapshot(captured, current)) {
      return [];
    }
    return [
      {
        ...current,
        capturedRevision: captured.revision,
        capturedMonitoringRevision: captured.monitoringRevision
      }
    ];
  });
}

async function loadParkedCourseCampaignMemberSnapshots(
  database: ParkedCourseCampaignDatabase,
  input: {
    requireZeroDemand: boolean;
    incidentIds?: readonly string[];
  }
): Promise<Array<ParkedCourseCampaignMember & { activeRealSearchCount: number }>> {
  const incidents = await database.courseSupportIncident.findMany({
    where: {
      ...(input.incidentIds?.length ? { id: { in: [...input.incidentIds] } } : {}),
      status: "NEEDS_HUMAN",
      humanReviewReason: "AUTOMATION_STALLED",
      ...(input.requireZeroDemand ? { activeRealSearchCount: 0 } : {}),
      activeBatchId: null,
      nextAttemptAt: null,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      course: {
        ...(input.requireZeroDemand
          ? {
              preferences: {
                none: {
                  teeSearch: {
                    status: "ACTIVE",
                    trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] }
                  }
                }
              }
            }
          : {}),
        monitoringStatus: {
          is: {
            state: "ENGINEERING_VERIFICATION_NEEDED",
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null
          }
        }
      }
    },
    orderBy: { courseId: "asc" },
    select: {
      id: true,
      courseId: true,
      cycle: true,
      revision: true,
      kind: true,
      providerFamilyKey: true,
      failureClass: true,
      failureFingerprint: true,
      attemptLedger: true,
      humanReviewReason: true,
      status: true,
      activeRealSearchCount: true,
      escalatedAt: true,
      resolution: true,
      resolvedAt: true,
      resolutionMessage: true,
      resolutionNotifiedAt: true,
      decisionActorId: true,
      decisionAt: true,
      decisionNote: true,
      decisionEvidenceUrl: true,
      decisionIdempotencyKey: true,
      monitoringEvents: {
        where: { eventType: "HUMAN_REVIEW_REQUESTED" },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 10,
        select: {
          incidentId: true,
          eventType: true,
          failureFingerprint: true,
          occurredAt: true,
          audit: true
        }
      },
      course: {
        select: {
          timeZone: true,
          isPublic: true,
          website: true,
          detectedBookingUrl: true,
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
          preferences: {
            where: {
              teeSearch: {
                status: "ACTIVE",
                trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] }
              }
            },
            select: { id: true }
          },
          monitoringStatus: {
            select: {
              state: true,
              revision: true,
              failureFingerprint: true,
              nextAutomaticAttemptAt: true,
              revalidationRequestedAt: true
            }
          },
          probes: {
            orderBy: [{ observedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { observedAt: true }
          },
          automationDiscoveries: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { createdAt: true }
          }
        }
      }
    }
  });
  return incidents.flatMap((incident) => {
    const monitoringStatus = incident.course.monitoringStatus;
    if (
      !monitoringStatus ||
      incident.resolution !== null ||
      incident.resolvedAt !== null ||
      incident.resolutionMessage !== null ||
      incident.resolutionNotifiedAt !== null ||
      incident.decisionActorId !== null ||
      incident.decisionAt !== null ||
      incident.decisionNote !== null ||
      incident.decisionEvidenceUrl !== null ||
      incident.decisionIdempotencyKey !== null ||
      !hasDurableWaitForMaterialChangeProof({
        incidentId: incident.id,
        incidentCycle: incident.cycle,
        incidentStatus: incident.status,
        humanReviewReason: incident.humanReviewReason,
        incidentEscalatedAt: incident.escalatedAt,
        monitoringState: monitoringStatus.state,
        endpointEvents: incident.monitoringEvents.filter(
          (event) => event.failureFingerprint === incident.failureFingerprint
        )
      })
    ) {
      return [];
    }
    return [
      {
        courseId: incident.courseId,
        incidentId: incident.id,
        cycle: incident.cycle,
        revision: incident.revision,
        monitoringRevision: monitoringStatus.revision,
        monitoringFailureFingerprint: monitoringStatus.failureFingerprint,
        kind: incident.kind,
        providerFamilyKey: incident.providerFamilyKey,
        failureClass: incident.failureClass,
        failureFingerprint: incident.failureFingerprint,
        providerSnapshotFingerprint:
          buildCourseSupportProviderSnapshotFingerprint(incident.course),
        attemptLedgerFingerprint: createParkedCourseCampaignAttemptLedgerFingerprint(
          incident.attemptLedger
        ),
        playbookConclusion: assessAutomationPlaybook(
          incident.attemptLedger,
          incident.cycle
        ).conclusion,
        latestProbeAt: incident.course.probes[0]?.observedAt.toISOString() ?? null,
        latestDiscoveryAt:
          incident.course.automationDiscoveries[0]?.createdAt.toISOString() ?? null,
        activeRealSearchCount: Math.max(
          incident.activeRealSearchCount,
          incident.course.preferences.length
        )
      }
    ];
  });
}

export function createParkedCourseCampaignAttemptLedgerFingerprint(value: unknown) {
  return createHash("sha256")
    .update(stableCourseProviderExecutionEvidenceValue(value ?? null))
    .digest("hex");
}

async function loadCampaignMemberObservations(
  audit: ParkedCourseCampaignAudit,
  parkedCourseIds: ReadonlySet<string>,
  campaignRunId: string,
  database: ParkedCourseCampaignDatabase = prisma
) {
  const capturedAt = new Date(audit.capturedAt);
  const incidents = await database.courseSupportIncident.findMany({
    where: { id: { in: audit.members.map((member) => member.incidentId) } },
    select: {
      id: true,
      courseId: true,
      cycle: true,
      status: true,
      activeBatchId: true,
      confirmedAt: true,
      resolution: true,
      resolvedAt: true,
      decisionAt: true,
      monitoringEvents: {
        where: {
          occurredAt: { gte: capturedAt },
          OR: [
            {
              eventType: {
                in: [
                  "HUMAN_REVIEW_REQUESTED",
                  "HUMAN_DECISION",
                  "RECOVERED",
                  "STATE_CHANGED"
                ]
              }
            },
            { source: { in: ["OPERATOR_DASHBOARD", "OPERATOR_CLI"] } }
          ]
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        select: {
          eventType: true,
          source: true,
          occurredAt: true,
          runtimeVersion: true,
          audit: true
        }
      },
      course: {
        select: {
          monitoringStatus: { select: { state: true, stateChangedAt: true } },
          probes: {
            where: { observedAt: { gte: capturedAt } },
            orderBy: [{ observedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              outcome: true,
              observedAt: true,
              runtimeVersion: true,
              rawSummary: true
            }
          }
        }
      }
    }
  });
  return incidents.map((incident) => {
    const terminalEvidence = [...incident.monitoringEvents].reverse().find((event) => {
      if (event.eventType !== "RECOVERED" && event.eventType !== "STATE_CHANGED") {
        return false;
      }
      const eventAudit = asCampaignRecord(event.audit);
      const campaign = asCampaignRecord(eventAudit.campaign);
      return (
        campaign.kind === "PARKED_COHORT" &&
        campaign.runId === campaignRunId &&
        campaign.membershipDigest === audit.membershipDigest &&
        campaign.cycle === incident.cycle
      );
    });
    return {
      courseId: incident.courseId,
      incidentId: incident.id,
      cycle: incident.cycle,
      status: incident.status,
      activeBatchId: incident.activeBatchId,
      confirmedAt: incident.confirmedAt,
      resolution: incident.resolution,
      resolvedAt: incident.resolvedAt,
      decisionAt: incident.decisionAt,
      monitoringState: incident.course.monitoringStatus?.state ?? null,
      monitoringStateChangedAt: incident.course.monitoringStatus?.stateChangedAt ?? null,
      latestProbe: incident.course.probes[0] ?? null,
      campaignTerminalEvidenceAt: terminalEvidence?.occurredAt ?? null,
      campaignTerminalRuntimeVersion: terminalEvidence?.runtimeVersion ?? null,
      campaignTerminalAutomatedFinal:
        typeof asCampaignRecord(terminalEvidence?.audit).automatedFinal === "boolean"
          ? (asCampaignRecord(terminalEvidence?.audit).automatedFinal as boolean)
          : null,
      currentlyParked: parkedCourseIds.has(incident.courseId),
      humanReviewCycles: [
        ...new Set(
          incident.monitoringEvents.flatMap((event) => {
            if (
              event.eventType !== "HUMAN_REVIEW_REQUESTED" &&
              event.eventType !== "HUMAN_DECISION" &&
              event.source !== "OPERATOR_DASHBOARD" &&
              event.source !== "OPERATOR_CLI"
            ) {
              return [];
            }
            const eventAudit = asCampaignRecord(event.audit);
            return Number.isInteger(eventAudit.cycle) ? [eventAudit.cycle as number] : [];
          })
        )
      ]
    };
  });
}

async function loadCampaignProgressFromDatabase(
  campaignRunId: string,
  audit: ParkedCourseCampaignAudit,
  database: ParkedCourseCampaignDatabase
) {
  const parkedMembers = await loadAllParkedCourseCampaignMembers(database);
  const remainingGlobalParkedCount = await loadGlobalParkedCourseCampaignCount(database);
  const memberByCourseId = new Map(audit.members.map((member) => [member.courseId, member]));
  const parkedCourseIds = new Set(
    parkedMembers.flatMap((member) => {
      const captured = memberByCourseId.get(member.courseId);
      return captured && isSameCampaignMemberMaterialSnapshot(captured, member)
        ? [member.courseId]
        : [];
    })
  );
  return summarizeParkedCourseCampaignProgress({
    audit,
    observations: await loadCampaignMemberObservations(
      audit,
      parkedCourseIds,
      campaignRunId,
      database
    ),
    remainingGlobalParkedCount
  });
}

async function acquireCampaignMemberMonitoringLocks(
  transaction: Prisma.TransactionClient,
  members: readonly ParkedCourseCampaignMember[]
) {
  const query = (
    transaction as Prisma.TransactionClient & {
      $queryRawUnsafe?: <T = unknown>(sql: string, ...values: unknown[]) => Promise<T>;
    }
  ).$queryRawUnsafe;
  if (!query) return;
  for (const courseId of members.map((member) => member.courseId).sort()) {
    await query.call(
      transaction,
      `WITH acquired AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))
       )
       SELECT true AS locked FROM acquired`,
      `course-monitoring:${courseId}`
    );
  }
  const incidentIds = members.map((member) => member.incidentId).sort();
  const courseIds = members.map((member) => member.courseId).sort();
  await transaction.$queryRaw(
    Prisma.sql`SELECT id
               FROM "Course"
               WHERE id IN (${Prisma.join(courseIds)})
               ORDER BY id
               FOR UPDATE`
  );
  await transaction.$queryRaw(
    Prisma.sql`SELECT id
               FROM "CourseSupportIncident"
               WHERE id IN (${Prisma.join(incidentIds)})
               ORDER BY id
               FOR UPDATE`
  );
  await transaction.$queryRaw(
    Prisma.sql`SELECT "courseId"
               FROM "CourseMonitoringStatus"
               WHERE "courseId" IN (${Prisma.join(courseIds)})
               ORDER BY "courseId"
               FOR UPDATE`
  );
}

function isRetryableCampaignCompletionError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (["P2028", "P2034"].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /deadlock|serialize access|transaction.*closed|write conflict/iu.test(message);
}

function asCampaignRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const defaultDependencies: ParkedCourseCampaignDependencies = {
  loadLatestCampaign: () =>
    prisma.automationRun.findFirst({
      where: { promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        completedAt: true,
        outcome: true,
        audit: true
      }
    }),
  loadActiveCampaign: () =>
    prisma.automationRun.findFirst({
      where: {
        promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
        status: "RUNNING",
        completedAt: null
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        completedAt: true,
        outcome: true,
        audit: true
      }
    }),
  loadParkedMembers: loadParkedCourseCampaignMembers,
  loadAllParkedMembers: loadAllParkedCourseCampaignMembers,
  loadGlobalParkedCount: loadGlobalParkedCourseCampaignCount,
  loadMemberObservations: loadCampaignMemberObservations,
  createCampaign: (audit) =>
    prisma.automationRun.create({
      data: {
        promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
        kind: "COURSE_SUPPORT",
        status: "RUNNING",
        runtimeVersion: getAutomationRuntimeVersion(),
        ownerThreadId: process.env.CODEX_THREAD_ID?.trim() || null,
        heartbeatAt: new Date(audit.capturedAt),
        auditSchemaVersion: PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION,
        audit: audit as unknown as Prisma.InputJsonValue,
        notes: JSON.stringify({
          schemaVersion: PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION,
          lifecycle: "active",
          campaignKind: audit.campaignKind,
          expectedCount: audit.expectedCount,
          membershipDigest: audit.membershipDigest,
          aggregateEvidenceCategories: audit.aggregateEvidenceCategories,
          customerDataIncluded: false
        })
      },
      select: {
        id: true,
        status: true,
        completedAt: true,
        outcome: true,
        audit: true
      }
    }),
  completeCampaign: async (runId, audit, expectedProgress) => {
    if (
      expectedProgress.membershipDigest !== audit.membershipDigest ||
      expectedProgress.totalCount !== audit.members.length
    ) {
      return false;
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await prisma.$transaction(
          async (transaction) => {
            await acquireCampaignMemberMonitoringLocks(transaction, audit.members);
            const progress = await loadCampaignProgressFromDatabase(runId, audit, transaction);
            if (
              progress.membershipDigest !== audit.membershipDigest ||
              progress.totalCount !== audit.members.length ||
              progress.terminalCount !== progress.totalCount ||
              progress.remainingGlobalParkedCount !== 0
            ) {
              return false;
            }
            const completedAt = new Date();
            const updated = await transaction.automationRun.updateMany({
              where: { id: runId, status: "RUNNING", completedAt: null },
              data: {
                status: "COMPLETED",
                completedAt,
                heartbeatAt: completedAt,
                outcome: "completed",
                notes: JSON.stringify({
                  schemaVersion: PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION,
                  lifecycle: "closeout",
                  outcome: "completed",
                  progress,
                  customerDataIncluded: false
                })
              }
            });
            return updated.count === 1;
          },
          {
            // A future unfamiliar course can become durably parked while this
            // closeout is checking the global zero invariant. Serializable
            // isolation makes that concurrent predicate change retry instead
            // of allowing the immutable cohort to close against stale state.
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 60_000
          }
        );
      } catch (error) {
        lastError = error;
        if (!isRetryableCampaignCompletionError(error) || attempt === 3) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
      }
    }
    throw lastError;
  },
  withTransitionLease: (worker) =>
    withPostgresAdvisoryTextLease(prisma, COURSE_SUPPORT_WRITER_LANE, worker)
};
