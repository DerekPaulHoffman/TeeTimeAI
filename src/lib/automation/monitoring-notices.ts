import { createHash } from "node:crypto";

import type { CourseMonitoringState } from "@prisma/client";

import type { SearchStatusCourseReport } from "@/lib/email/search-status";

const CONFIRMED_OUTAGE_STATES = new Set<CourseMonitoringState>([
  "AUTO_INVESTIGATING",
  "ENGINEERING_VERIFICATION_NEEDED"
]);

type MonitoringStateSnapshot = {
  state: CourseMonitoringState;
  firstDegradedAt: Date | null;
  failureFingerprint: string | null;
} | null;

export type MonitoringNoticeCandidate = {
  providerFamilyKey: string;
  result: SearchStatusCourseReport;
  previous: MonitoringStateSnapshot;
  current: MonitoringStateSnapshot;
};

export type ReachedMonitoringOutage = {
  courseId: string;
  recipient: string;
  sentAt: Date;
};

export type MonitoringNoticePlan = {
  outageCourses: SearchStatusCourseReport[];
  recoveryCourses: SearchStatusCourseReport[];
  recoveryRecipients: string[];
};

export function planMonitoringNotices(input: {
  candidates: MonitoringNoticeCandidate[];
  reachedOutages: ReachedMonitoringOutage[];
  ownerRecipient: string;
  corroboratedFailureKeys?: string[];
}): MonitoringNoticePlan {
  const normalizedOwner = normalizeRecipient(input.ownerRecipient);
  const corroboratedFailures = new Set([
    ...getCorroboratedProviderFailures(input.candidates),
    ...(input.corroboratedFailureKeys ?? [])
  ]);
  const reachedByCourse = new Map<string, ReachedMonitoringOutage[]>();
  for (const reached of input.reachedOutages) {
    const rows = reachedByCourse.get(reached.courseId) ?? [];
    rows.push(reached);
    reachedByCourse.set(reached.courseId, rows);
  }

  const outageCourses = input.candidates.flatMap((candidate) => {
    const degradedAt = candidate.current?.firstDegradedAt;
    const corroborationKey = getFailureCorroborationKey(candidate);
    const confirmed =
      candidate.current !== null &&
      (CONFIRMED_OUTAGE_STATES.has(candidate.current.state) ||
        (corroborationKey !== null && corroboratedFailures.has(corroborationKey)));
    if (
      candidate.result.outcome !== "FETCH_FAILED" ||
      !degradedAt ||
      !confirmed ||
      hasReachedOutageSince(reachedByCourse.get(candidate.result.courseId), degradedAt)
    ) {
      return [];
    }
    return [candidate.result];
  });

  const recoveryRecipients = new Set<string>();
  const recoveryCourses = input.candidates.flatMap((candidate) => {
    const degradedAt = candidate.previous?.firstDegradedAt;
    if (
      !degradedAt ||
      candidate.previous?.state === "HEALTHY" ||
      (candidate.result.outcome !== "MATCH_FOUND" &&
        candidate.result.outcome !== "NO_MATCH")
    ) {
      return [];
    }
    const reached = (reachedByCourse.get(candidate.result.courseId) ?? []).filter(
      (notice) => notice.sentAt >= degradedAt
    );
    if (reached.length === 0) {
      return [];
    }
    for (const notice of reached) {
      recoveryRecipients.add(normalizeRecipient(notice.recipient));
    }
    return [candidate.result];
  });

  if (!recoveryRecipients.has(normalizedOwner)) {
    recoveryRecipients.clear();
    recoveryCourses.length = 0;
  }

  return {
    outageCourses,
    recoveryCourses,
    recoveryRecipients: [...recoveryRecipients].filter(Boolean).sort()
  };
}

export function buildMonitoringNoticeGroupKey(
  kind: "outage" | "recovery",
  candidates: MonitoringNoticeCandidate[],
  courseIds: string[]
) {
  const selected = new Set(courseIds);
  const episodes = candidates
    .filter((candidate) => selected.has(candidate.result.courseId))
    .map((candidate) => ({
      courseId: candidate.result.courseId,
      providerFamilyKey: candidate.providerFamilyKey,
      startedAt:
        (kind === "recovery"
          ? candidate.previous?.firstDegradedAt
          : candidate.current?.firstDegradedAt
        )?.toISOString() ?? "unknown"
    }))
    .sort((left, right) => left.courseId.localeCompare(right.courseId));
  const digest = createHash("sha256")
    .update(JSON.stringify({ kind, episodes }))
    .digest("hex")
    .slice(0, 24);
  return `monitoring-${kind}-${digest}`;
}

export function getMonitoringProviderLabel(
  candidates: MonitoringNoticeCandidate[],
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

export function getMonitoringFailureCorroborationCandidates(
  candidates: MonitoringNoticeCandidate[]
) {
  return [
    ...new Map(
      candidates.flatMap((candidate) => {
        const key = getFailureCorroborationKey(candidate);
        return key && candidate.current?.failureFingerprint
          ? [
              [
                key,
                {
                  providerFamilyKey: candidate.providerFamilyKey,
                  failureFingerprint: candidate.current.failureFingerprint
                }
              ] as const
            ]
          : [];
      })
    ).values()
  ];
}

function getCorroboratedProviderFailures(candidates: MonitoringNoticeCandidate[]) {
  const counts = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = getFailureCorroborationKey(candidate);
    if (candidate.result.outcome !== "FETCH_FAILED" || !key) {
      continue;
    }
    const courseIds = counts.get(key) ?? new Set<string>();
    courseIds.add(candidate.result.courseId);
    counts.set(key, courseIds);
  }
  return new Set(
    [...counts.entries()]
      .filter(([, courseIds]) => courseIds.size >= 2)
      .map(([key]) => key)
  );
}

function getFailureCorroborationKey(candidate: MonitoringNoticeCandidate) {
  if (
    !candidate.current?.firstDegradedAt ||
    !candidate.current.failureFingerprint
  ) {
    return null;
  }
  return `${candidate.providerFamilyKey}:${candidate.current.failureFingerprint}`;
}

function hasReachedOutageSince(
  reached: ReachedMonitoringOutage[] | undefined,
  degradedAt: Date
) {
  return Boolean(reached?.some((notice) => notice.sentAt >= degradedAt));
}

function getCustomerProviderLabel(providerFamilyKey: string) {
  const labels: Record<string, string> = {
    CHRONOGOLF: "Chronogolf",
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
