import "./load-local-env";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const DEFAULT_LIMIT = 20;
const FINALITY_TARGET_MS = 10 * 60 * 1000;

function readLimit() {
  const index = process.argv.indexOf("--limit");
  const raw = index >= 0 ? Number(process.argv[index + 1]) : DEFAULT_LIMIT;
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : DEFAULT_LIMIT;
}

function readSetupCourseOutcomes(payload: Prisma.JsonValue) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const statusReport = (payload as Record<string, unknown>).statusReport;
  if (!statusReport || typeof statusReport !== "object" || Array.isArray(statusReport)) {
    return [];
  }
  const courses = (statusReport as Record<string, unknown>).courses;
  if (!Array.isArray(courses)) return [];
  return courses.flatMap((course) => {
    if (!course || typeof course !== "object" || Array.isArray(course)) return [];
    const outcome = (course as Record<string, unknown>).outcome;
    return typeof outcome === "string" ? [outcome] : [];
  });
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function main() {
  const generatedAt = new Date();
  const searches = await prisma.teeSearch.findMany({
    where: {
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false,
      preferences: { some: {} }
    },
    orderBy: { createdAt: "desc" },
    take: readLimit(),
    select: {
      createdAt: true,
      preferences: { select: { courseId: true } },
      probes: {
        orderBy: { observedAt: "asc" },
        select: { courseId: true, observedAt: true }
      },
      emailDeliveries: {
        where: { kind: "SETUP", isOwnerRecipient: true },
        orderBy: { createdAt: "desc" },
        select: { status: true, sentAt: true, payload: true }
      }
    }
  });

  const reports = searches.map((search) => {
    const delivery = search.emailDeliveries.find((candidate) => candidate.sentAt !== null);
    const outcomes = delivery ? readSetupCourseOutcomes(delivery.payload) : [];
    const finalCourseCount = outcomes.filter((outcome) => outcome !== "CHECK_PENDING").length;
    const selectedCourseCount = search.preferences.length;
    const deliveredInMs = delivery?.sentAt
      ? delivery.sentAt.getTime() - search.createdAt.getTime()
      : null;
    const complete =
      selectedCourseCount > 0 &&
      outcomes.length === selectedCourseCount &&
      finalCourseCount === selectedCourseCount;

    return {
      createdAt: search.createdAt,
      selectedCourseCount,
      firstCourseResultCount: new Set(search.probes.map((probe) => probe.courseId)).size,
      deliveredCourseCount: outcomes.length,
      finalCourseCount,
      setupDeliveryStatus: delivery?.status ?? null,
      deliveredSeconds: deliveredInMs === null ? null : Math.round(deliveredInMs / 100) / 10,
      complete,
      metTenMinuteTarget:
        complete && deliveredInMs !== null && deliveredInMs <= FINALITY_TARGET_MS,
      stuck:
        generatedAt.getTime() - search.createdAt.getTime() > FINALITY_TARGET_MS && !complete
    };
  });
  const completedDurations = reports.flatMap((report) =>
    report.complete && report.deliveredSeconds !== null ? [report.deliveredSeconds] : []
  );

  console.log(
    JSON.stringify(
      {
        generatedAt,
        targetSeconds: FINALITY_TARGET_MS / 1000,
        observedAlertCount: reports.length,
        completeAlertCount: reports.filter((report) => report.complete).length,
        tenMinuteSuccessCount: reports.filter((report) => report.metTenMinuteTarget).length,
        stuckAlertCount: reports.filter((report) => report.stuck).length,
        deliverySeconds: {
          p50: percentile(completedDurations, 0.5),
          p95: percentile(completedDurations, 0.95),
          maximum: completedDurations.length > 0 ? Math.max(...completedDurations) : null
        },
        alerts: reports
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Alert finality inspection failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
