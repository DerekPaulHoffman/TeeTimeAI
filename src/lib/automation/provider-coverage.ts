import { prisma } from "@/lib/prisma";

import { evaluateMonitoringGate } from "./policy";
import {
  type CourseSupportFailureClass,
  resolveProviderCapability,
  SOURCE_CONFLICT_PROVIDER_FAMILY,
  SOURCE_MISSING_PROVIDER_FAMILY
} from "./provider-capabilities";
import {
  MONITORING_STRATEGY_ACTIONS,
  selectMonitoringStrategy,
  type MonitoringStrategyAction
} from "./monitoring-strategy";

export type ProviderCoverageCategory =
  | "MONITORED"
  | "SUPPORTED_READY"
  | "SUPPORTED_DEGRADED"
  | "TECHNICAL_CONSTRAINT"
  | "PHONE_OR_WALK_IN"
  | "UNSUPPORTED_FAMILY"
  | "SOURCE_UNVERIFIED"
  | "PRIVATE_OR_INVALID";

type CoverageCourse = {
  isPublic: boolean;
  website: string | null;
  detectedBookingUrl: string | null;
  detectedPlatform: string;
  providerFamilyKey: string;
  bookingMethod: string;
  automationEligibility: string;
  automationReason: string;
  bookingMetadata: unknown;
  intelligenceVerifiedAt: Date | null;
  intelligenceReviewAt: Date | null;
  intelligenceConfidence: number | null;
  probes: Array<{ outcome: string; observedAt: Date }>;
  supportIncident: {
    status: string;
    resolvedAt: Date | null;
    resolution: string | null;
    activeRealSearchCount: number;
    engineeringOnly: boolean;
    failureClass: CourseSupportFailureClass;
    attemptCount: number;
    firstSeenAt: Date;
  } | null;
};

export function classifyProviderCoverage(
  course: CoverageCourse,
  now = new Date()
): ProviderCoverageCategory {
  const gate = evaluateMonitoringGate({ ...course, now });
  if (gate.disposition === "IDENTITY_FINAL") {
    return "PRIVATE_OR_INVALID";
  }
  if (gate.disposition === "IDENTITY_RECHECK") {
    return "SOURCE_UNVERIFIED";
  }
  if (gate.disposition === "MANUAL_FINAL") {
    return "PHONE_OR_WALK_IN";
  }
  if (gate.disposition === "TECHNICAL_FINAL") {
    return "TECHNICAL_CONSTRAINT";
  }

  const provider = resolveProviderCapability(course);
  if (
    provider.providerFamilyKey === SOURCE_MISSING_PROVIDER_FAMILY ||
    provider.providerFamilyKey === SOURCE_CONFLICT_PROVIDER_FAMILY
  ) {
    return "SOURCE_UNVERIFIED";
  }
  if (!provider.isRunnable) {
    return "UNSUPPORTED_FAMILY";
  }

  const latestOutcome = course.probes[0]?.outcome;
  const latestObservedAt = course.probes[0]?.observedAt;
  const hasCurrentOpenIncident = Boolean(
    course.supportIncident && course.supportIncident.status !== "RESOLVED"
  );
  if (hasCurrentOpenIncident) {
    return "SUPPORTED_DEGRADED";
  }
  if (latestOutcome === "MATCH_FOUND" || latestOutcome === "NO_MATCH") {
    return "MONITORED";
  }
  if (
    course.supportIncident?.resolution === "MONITORING_RESTORED" &&
    course.supportIncident.resolvedAt &&
    (!latestObservedAt || course.supportIncident.resolvedAt >= latestObservedAt)
  ) {
    return "MONITORED";
  }
  return latestOutcome ? "SUPPORTED_DEGRADED" : "SUPPORTED_READY";
}

export function recommendProviderCoverageAction(
  course: CoverageCourse,
  now = new Date()
): MonitoringStrategyAction {
  const currentFailureClass =
    course.supportIncident?.status !== "RESOLVED"
      ? course.supportIncident?.failureClass
      : null;
  return selectMonitoringStrategy({
    ...course,
    failureClass: currentFailureClass,
    now
  }).action;
}

export async function getProviderCoverageDashboard(input?: { now?: Date }) {
  const now = input?.now ?? new Date();
  const courses = await prisma.course.findMany({
    select: {
      isPublic: true,
      website: true,
      detectedBookingUrl: true,
      detectedPlatform: true,
      providerFamilyKey: true,
      bookingMethod: true,
      automationEligibility: true,
      automationReason: true,
      bookingMetadata: true,
      intelligenceVerifiedAt: true,
      intelligenceReviewAt: true,
      intelligenceConfidence: true,
      probes: {
        orderBy: { observedAt: "desc" },
        take: 1,
        select: { outcome: true, observedAt: true }
      },
      supportIncident: {
        select: {
          status: true,
          resolvedAt: true,
          resolution: true,
          activeRealSearchCount: true,
          engineeringOnly: true,
          failureClass: true,
          attemptCount: true,
          firstSeenAt: true
        }
      }
    }
  });

  const categoryCounts = new Map<ProviderCoverageCategory, number>();
  const strategyCounts = new Map<MonitoringStrategyAction, number>();
  const familyCounts = new Map<
    string,
    {
      courseCount: number;
      monitoredCount: number;
      readyCount: number;
      degradedCount: number;
      openIncidentCount: number;
      activeRealDemandIncidentCount: number;
      engineeringIncidentCount: number;
    }
  >();
  let sourceUnverifiedFinalCandidateCount = 0;

  for (const course of courses as CoverageCourse[]) {
    const category = classifyProviderCoverage(course, now);
    const strategy = recommendProviderCoverageAction(course, now);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    strategyCounts.set(strategy, (strategyCounts.get(strategy) ?? 0) + 1);
    const family = resolveProviderCapability(course).providerFamilyKey;
    const current = familyCounts.get(family) ?? {
      courseCount: 0,
      monitoredCount: 0,
      readyCount: 0,
      degradedCount: 0,
      openIncidentCount: 0,
      activeRealDemandIncidentCount: 0,
      engineeringIncidentCount: 0
    };
    current.courseCount += 1;
    current.monitoredCount += Number(category === "MONITORED");
    current.readyCount += Number(category === "SUPPORTED_READY");
    current.degradedCount += Number(category === "SUPPORTED_DEGRADED");
    if (
      course.supportIncident?.status !== undefined &&
      course.supportIncident.status !== "RESOLVED"
    ) {
      current.openIncidentCount += 1;
      current.activeRealDemandIncidentCount += Number(
        course.supportIncident.activeRealSearchCount > 0
      );
      current.engineeringIncidentCount += Number(
        course.supportIncident.engineeringOnly &&
          course.supportIncident.activeRealSearchCount === 0
      );
      sourceUnverifiedFinalCandidateCount += Number(
        course.supportIncident.activeRealSearchCount === 0 &&
          course.supportIncident.attemptCount >= 4 &&
          now.getTime() - course.supportIncident.firstSeenAt.getTime() >=
            24 * 60 * 60 * 1000 &&
          ((family === SOURCE_MISSING_PROVIDER_FAMILY &&
            course.supportIncident.failureClass === "MISSING_SOURCE") ||
            (family === SOURCE_CONFLICT_PROVIDER_FAMILY &&
              course.supportIncident.failureClass === "MISSING_METADATA"))
      );
    }
    familyCounts.set(family, current);
  }

  const categoryOrder: ProviderCoverageCategory[] = [
    "MONITORED",
    "SUPPORTED_READY",
    "SUPPORTED_DEGRADED",
    "TECHNICAL_CONSTRAINT",
    "PHONE_OR_WALK_IN",
    "UNSUPPORTED_FAMILY",
    "SOURCE_UNVERIFIED",
    "PRIVATE_OR_INVALID"
  ];
  const monitoredCount = categoryCounts.get("MONITORED") ?? 0;
  const eligibleCount = courses.length - (categoryCounts.get("PRIVATE_OR_INVALID") ?? 0);

  return {
    schemaVersion: 2,
    observedAt: now.toISOString(),
    totalCourseCount: courses.length,
    eligibleCourseCount: eligibleCount,
    effectiveMonitoredCourseCount: monitoredCount,
    effectiveCoveragePercent:
      eligibleCount === 0 ? 0 : Math.round((monitoredCount / eligibleCount) * 1000) / 10,
    categories: Object.fromEntries(
      categoryOrder.map((category) => [category, categoryCounts.get(category) ?? 0])
    ),
    recommendedActions: Object.fromEntries(
      MONITORING_STRATEGY_ACTIONS.map((action) => [
        action,
        strategyCounts.get(action) ?? 0
      ])
    ),
    sourceUnverifiedFinalCandidateCount,
    providerGroups: [...familyCounts.entries()]
      .map(([providerFamilyKey, counts]) => ({ providerFamilyKey, ...counts }))
      .sort(
        (left, right) =>
          right.activeRealDemandIncidentCount - left.activeRealDemandIncidentCount ||
          right.openIncidentCount - left.openIncidentCount ||
          right.courseCount - left.courseCount ||
          left.providerFamilyKey.localeCompare(right.providerFamilyKey)
      )
  };
}
