import { createHash } from "node:crypto";

import type { CustomerMonitoringStatus } from "@/lib/customer-monitoring-status";
import type { SearchStatusCourseReport } from "@/lib/email/search-status";

export const MONITORING_STATUS_CONSOLIDATION_MS = 30 * 60 * 1000;

export type MonitoringStatusNoticeCandidate = {
  providerFamilyKey: string;
  result: SearchStatusCourseReport;
  previousStatus: CustomerMonitoringStatus;
  currentStatus: CustomerMonitoringStatus;
  episodeStartedAt: Date | null;
};

export type ReachedMonitoringOutage = {
  courseId: string;
  recipient: string;
  sentAt: Date;
  customerStatus: "RETRYING_AUTOMATICALLY" | "NEEDS_HUMAN_REVIEW";
};

export type ReachedMonitoringFinal = {
  courseId: string;
  recipient: string;
  sentAt: Date;
};

export function planMonitoringStatusNotices(input: {
  candidates: MonitoringStatusNoticeCandidate[];
  reachedOutages: ReachedMonitoringOutage[];
  reachedFinals?: ReachedMonitoringFinal[];
  ownerRecipient: string;
  now?: Date;
}): {
  outageCourses: SearchStatusCourseReport[];
  recoveryCourses: SearchStatusCourseReport[];
  finalCourses: SearchStatusCourseReport[];
  recoveryRecipients: string[];
  nextConsolidationAt: Date | null;
} {
  const now = input.now ?? new Date();
  const ownerRecipient = normalizeRecipient(input.ownerRecipient);
  const reachedByCourse = new Map<string, ReachedMonitoringOutage[]>();
  for (const reached of input.reachedOutages) {
    const rows = reachedByCourse.get(reached.courseId) ?? [];
    rows.push(reached);
    reachedByCourse.set(reached.courseId, rows);
  }
  const reachedFinalsByCourse = new Map<string, ReachedMonitoringFinal[]>();
  for (const reached of input.reachedFinals ?? []) {
    const rows = reachedFinalsByCourse.get(reached.courseId) ?? [];
    rows.push(reached);
    reachedFinalsByCourse.set(reached.courseId, rows);
  }

  let nextConsolidationAt: Date | null = null;
  const outageCourses = input.candidates.flatMap((candidate) => {
    if (!isUnavailableCustomerStatus(candidate.currentStatus)) {
      return [];
    }
    const episodeStartedAt = candidate.episodeStartedAt;
    if (!episodeStartedAt) {
      return [];
    }
    if (
      hasReachedOutageSince(
        reachedByCourse.get(candidate.result.courseId),
        episodeStartedAt,
        candidate.currentStatus
      )
    ) {
      return [];
    }
    const eligibleAt = new Date(
      episodeStartedAt.getTime() + MONITORING_STATUS_CONSOLIDATION_MS
    );
    if (eligibleAt > now) {
      if (!nextConsolidationAt || eligibleAt < nextConsolidationAt) {
        nextConsolidationAt = eligibleAt;
      }
      return [];
    }
    return [candidate.result];
  });

  const recoveryRecipients = new Set<string>();
  const recoveryCourses = input.candidates.flatMap((candidate) => {
    if (
      candidate.currentStatus !== "MONITORED" ||
      !isUnavailableCustomerStatus(candidate.previousStatus) ||
      !candidate.episodeStartedAt
    ) {
      return [];
    }
    const reached = (
      reachedByCourse.get(candidate.result.courseId) ?? []
    ).filter((notice) => notice.sentAt >= candidate.episodeStartedAt!);
    if (reached.length === 0) {
      return [];
    }
    for (const notice of reached) {
      recoveryRecipients.add(normalizeRecipient(notice.recipient));
    }
    return [candidate.result];
  });

  if (!recoveryRecipients.has(ownerRecipient)) {
    recoveryRecipients.clear();
    recoveryCourses.length = 0;
  }

  const finalCoursesById = new Map<string, SearchStatusCourseReport>();
  for (const candidate of input.candidates) {
    if (
      candidate.currentStatus !== "FINAL_DIRECT_ACTION" ||
      !candidate.episodeStartedAt ||
      hasReachedRecipientStatusSince(
        reachedFinalsByCourse.get(candidate.result.courseId),
        ownerRecipient,
        candidate.episodeStartedAt
      )
    ) {
      continue;
    }
    const eligibleAt = new Date(
      candidate.episodeStartedAt.getTime() + MONITORING_STATUS_CONSOLIDATION_MS
    );
    if (eligibleAt > now) {
      if (!nextConsolidationAt || eligibleAt < nextConsolidationAt) {
        nextConsolidationAt = eligibleAt;
      }
      continue;
    }
    finalCoursesById.set(candidate.result.courseId, candidate.result);
  }

  return {
    outageCourses,
    recoveryCourses,
    finalCourses: [...finalCoursesById.values()],
    recoveryRecipients: [...recoveryRecipients].filter(Boolean).sort(),
    nextConsolidationAt
  };
}

export function buildMonitoringStatusNoticeGroupKey(
  kind: "outage" | "recovery" | "status-update",
  candidates: MonitoringStatusNoticeCandidate[],
  courseIds: string[]
) {
  const selected = new Set(courseIds);
  const episodes = candidates
    .filter((candidate) => selected.has(candidate.result.courseId))
    .map((candidate) => ({
      courseId: candidate.result.courseId,
      providerFamilyKey: candidate.providerFamilyKey,
      customerStatus: candidate.currentStatus,
      episodeStartedAt:
        candidate.episodeStartedAt?.toISOString() ?? "unknown"
    }))
    .sort((left, right) => left.courseId.localeCompare(right.courseId));
  const digest = createHash("sha256")
    .update(JSON.stringify({ kind, episodes }))
    .digest("hex")
    .slice(0, 24);
  return `monitoring-${kind}-${digest}`;
}

export function getMonitoringStatusProviderLabel(
  candidates: MonitoringStatusNoticeCandidate[],
  courseIds: string[]
) {
  const selected = new Set(courseIds);
  const labels = [
    ...new Set(
      candidates
        .filter((candidate) => selected.has(candidate.result.courseId))
        .map((candidate) => getCustomerProviderLabel(candidate.providerFamilyKey))
        .filter((label): label is string => Boolean(label))
    )
  ];
  return labels.length === 1 ? labels[0] : undefined;
}

function isUnavailableCustomerStatus(status: CustomerMonitoringStatus) {
  return (
    status === "RETRYING_AUTOMATICALLY" ||
    status === "NEEDS_HUMAN_REVIEW"
  );
}

function hasReachedOutageSince(
  reached: ReachedMonitoringOutage[] | undefined,
  episodeStartedAt: Date,
  customerStatus: CustomerMonitoringStatus
) {
  return Boolean(
    reached?.some(
      (notice) =>
        notice.customerStatus === customerStatus &&
        notice.sentAt >= episodeStartedAt
    )
  );
}

function hasReachedRecipientStatusSince(
  reached: Array<{ recipient: string; sentAt: Date }> | undefined,
  recipient: string,
  episodeStartedAt: Date
) {
  return Boolean(
    reached?.some(
      (notice) =>
        normalizeRecipient(notice.recipient) === recipient &&
        notice.sentAt >= episodeStartedAt
    )
  );
}

function getCustomerProviderLabel(providerFamilyKey: string) {
  const labels: Record<string, string> = {
    CHRONOGOLF: "Chronogolf",
    CPS: "CPS",
    EZLINKS: "EZLinks",
    FOREUP: "ForeUp",
    GOLFNOW: "GolfNow",
    TEEITUP: "TeeItUp",
    CLUB_CADDIE: "Club Caddie",
    TEESNAP: "TeeSnap",
    GOLFBACK: "GolfBack",
    WEBTRAC: "WebTrac",
    CHELSEA: "Chelsea"
  };
  return labels[providerFamilyKey];
}

function normalizeRecipient(recipient: string) {
  return recipient.trim().toLowerCase();
}
