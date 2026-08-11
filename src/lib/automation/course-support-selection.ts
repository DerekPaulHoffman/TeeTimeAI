import type {
  CourseHumanReviewReason,
  CourseSupportFailureClass,
  CourseSupportIncidentKind
} from "@prisma/client";

import {
  COURSE_SUPPORT_SYNTHETIC_AGING_MS,
  COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
  clampCourseSupportBatchSize
} from "./course-support-responder-policy";

const NEAR_DATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type CourseSupportCandidate = {
  id: string;
  courseId: string;
  cycle: number;
  kind: CourseSupportIncidentKind;
  providerFamilyKey: string;
  failureClass: CourseSupportFailureClass;
  failureFingerprint: string;
  humanReviewReason: CourseHumanReviewReason | null;
  engineeringOnly: boolean;
  activeRealSearchCount: number;
  earliestTargetDate: Date | null;
  escalationDeadlineAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  attemptCount: number;
  updatedAt: Date;
};

export type RecentBatchFairnessEvidence = {
  includedEngineeringOnly: boolean;
  includedCriticalRealDemand: boolean;
};

export type SelectedCourseSupportBatch = {
  providerFamilyKey: string;
  failureFingerprint: string;
  incidents: CourseSupportCandidate[];
  fairnessReason: "PRIORITY" | "AGED_SYNTHETIC_RESERVATION" | "TARGETED_RETRY";
  containsCriticalRealDemand: boolean;
};

export type CourseSupportGroupPriority = {
  activeRealDemandCount: number;
  earliestEscalationDeadlineAt: Date | null;
};

export function selectCourseSupportBatch(input: {
  candidates: CourseSupportCandidate[];
  recentBatches?: RecentBatchFairnessEvidence[];
  maxCourses?: number;
  now?: Date;
}): SelectedCourseSupportBatch | null {
  const now = input.now ?? new Date();
  const maxCourses = clampCourseSupportBatchSize(input.maxCourses);
  const groups = new Map<string, CourseSupportCandidate[]>();

  for (const candidate of input.candidates) {
    const key = `${candidate.providerFamilyKey}\u0000${candidate.failureFingerprint}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const rankedGroups = [...groups.values()]
    .map((incidents) =>
      incidents.sort((left, right) => compareCourseSupportCandidates(left, right, now))
    )
    .sort((left, right) => compareCourseSupportGroups(left, right, now));
  if (rankedGroups.length === 0) {
    return null;
  }

  const criticalGroups = rankedGroups.filter((group) =>
    group.some((candidate) => isCriticalRealDemand(candidate, now))
  );
  const recentFairnessWindow = (input.recentBatches ?? []).slice(
    0,
    COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW
  );
  const syntheticReservationDue =
    criticalGroups.length === 0 &&
    recentFairnessWindow.length >= COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW &&
    recentFairnessWindow.every(
      (batch) => !batch.includedEngineeringOnly && !batch.includedCriticalRealDemand
    );
  const agedSyntheticGroup = rankedGroups
    .filter((group) =>
      group.some(
        (candidate) =>
          candidate.engineeringOnly &&
          now.getTime() - candidate.firstSeenAt.getTime() >=
            COURSE_SUPPORT_SYNTHETIC_AGING_MS
      )
    )
    .sort((left, right) => oldestSeenAt(left) - oldestSeenAt(right))[0];

  const selectedGroup =
    criticalGroups[0] ??
    (syntheticReservationDue ? agedSyntheticGroup : undefined) ??
    rankedGroups[0];
  const fairnessReason =
    selectedGroup === agedSyntheticGroup && syntheticReservationDue
      ? "AGED_SYNTHETIC_RESERVATION"
      : "PRIORITY";
  const containsCriticalRealDemand = selectedGroup.some((candidate) =>
    isCriticalRealDemand(candidate, now)
  );
  const selectedIncidents = containsCriticalRealDemand
    ? selectedGroup.slice(0, maxCourses)
    : reserveAgedSyntheticSlots(selectedGroup, maxCourses, now);

  return {
    providerFamilyKey: selectedGroup[0].providerFamilyKey,
    failureFingerprint: selectedGroup[0].failureFingerprint,
    incidents: selectedIncidents,
    fairnessReason,
    containsCriticalRealDemand
  };
}

export function compareCourseSupportCandidates(
  left: CourseSupportCandidate,
  right: CourseSupportCandidate,
  now: Date
) {
  const groupPriority = compareCourseSupportGroupPriority(
    candidateGroupPriority([left]),
    candidateGroupPriority([right])
  );
  if (groupPriority !== 0) {
    return groupPriority;
  }
  const priority = candidatePriority(left, now) - candidatePriority(right, now);
  if (priority !== 0) {
    return priority;
  }
  const target =
    (left.earliestTargetDate?.getTime() ?? Number.MAX_SAFE_INTEGER) -
    (right.earliestTargetDate?.getTime() ?? Number.MAX_SAFE_INTEGER);
  if (target !== 0) {
    return target;
  }
  const attempts = left.attemptCount - right.attemptCount;
  if (attempts !== 0) {
    return attempts;
  }
  return left.firstSeenAt.getTime() - right.firstSeenAt.getTime();
}

export function isCriticalRealDemand(candidate: CourseSupportCandidate, now: Date) {
  return Boolean(
    candidate.activeRealSearchCount > 0 &&
    candidate.kind === "FETCH_FAILED" &&
    candidate.earliestTargetDate &&
    candidate.earliestTargetDate.getTime() <= now.getTime() + NEAR_DATE_WINDOW_MS
  );
}

function reserveAgedSyntheticSlots(
  incidents: CourseSupportCandidate[],
  maxCourses: number,
  now: Date
) {
  const real = incidents.filter((candidate) => !candidate.engineeringOnly);
  const agedSynthetic = incidents.filter(
    (candidate) =>
      candidate.engineeringOnly &&
      now.getTime() - candidate.firstSeenAt.getTime() >= COURSE_SUPPORT_SYNTHETIC_AGING_MS
  );
  if (real.length === 0 || agedSynthetic.length === 0 || maxCourses < 4) {
    return incidents.slice(0, maxCourses);
  }
  const reservedSyntheticSlots = Math.max(1, Math.floor(maxCourses / 4));
  const selected = [
    ...real.slice(0, maxCourses - reservedSyntheticSlots),
    ...agedSynthetic.slice(0, reservedSyntheticSlots)
  ];
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  for (const candidate of incidents) {
    if (selected.length >= maxCourses) {
      break;
    }
    if (!selectedIds.has(candidate.id)) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  }
  return selected.sort((left, right) =>
    compareCourseSupportCandidates(left, right, now)
  );
}

function compareCourseSupportGroups(
  left: CourseSupportCandidate[],
  right: CourseSupportCandidate[],
  now: Date
) {
  const groupPriority = compareCourseSupportGroupPriority(
    candidateGroupPriority(left),
    candidateGroupPriority(right)
  );
  if (groupPriority !== 0) {
    return groupPriority;
  }
  const leadComparison = compareCourseSupportCandidates(left[0], right[0], now);
  if (leadComparison !== 0) {
    return leadComparison;
  }
  const leftDemand = left.reduce(
    (sum, candidate) => sum + candidate.activeRealSearchCount,
    0
  );
  const rightDemand = right.reduce(
    (sum, candidate) => sum + candidate.activeRealSearchCount,
    0
  );
  return rightDemand - leftDemand || oldestSeenAt(left) - oldestSeenAt(right);
}

export function compareCourseSupportGroupPriority(
  left: CourseSupportGroupPriority,
  right: CourseSupportGroupPriority
) {
  const leftHasRealDemand = left.activeRealDemandCount > 0;
  const rightHasRealDemand = right.activeRealDemandCount > 0;
  if (leftHasRealDemand !== rightHasRealDemand) {
    return leftHasRealDemand ? -1 : 1;
  }
  if (leftHasRealDemand) {
    const deadlineOrder =
      (left.earliestEscalationDeadlineAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (right.earliestEscalationDeadlineAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
    if (deadlineOrder !== 0) {
      return deadlineOrder;
    }
    const demandOrder = right.activeRealDemandCount - left.activeRealDemandCount;
    if (demandOrder !== 0) {
      return demandOrder;
    }
  }
  return 0;
}

function candidateGroupPriority(
  candidates: readonly CourseSupportCandidate[]
): CourseSupportGroupPriority {
  const activeRealCandidates = candidates.filter(
    (candidate) => candidate.activeRealSearchCount > 0
  );
  const deadlines = activeRealCandidates.flatMap((candidate) =>
    candidate.escalationDeadlineAt ? [candidate.escalationDeadlineAt.getTime()] : []
  );
  return {
    activeRealDemandCount: activeRealCandidates.reduce(
      (sum, candidate) => sum + candidate.activeRealSearchCount,
      0
    ),
    earliestEscalationDeadlineAt:
      deadlines.length > 0 ? new Date(Math.min(...deadlines)) : null
  };
}

function candidatePriority(candidate: CourseSupportCandidate, now: Date) {
  if (isCriticalRealDemand(candidate, now)) {
    return 0;
  }
  if (candidate.activeRealSearchCount > 0 && candidate.kind === "FETCH_FAILED") {
    return 1;
  }
  if (candidate.activeRealSearchCount > 0) {
    return 2;
  }
  if (!candidate.engineeringOnly) {
    return 3;
  }
  return 4;
}

function oldestSeenAt(candidates: CourseSupportCandidate[]) {
  return Math.min(...candidates.map((candidate) => candidate.firstSeenAt.getTime()));
}
