import { Prisma, type CourseProbe, type CourseSetupOutcome } from "@prisma/client";

import { evaluateMonitoringGate } from "@/lib/automation/policy";
import { getSyntheticMultiCycleExpiresAt } from "@/lib/automation/synthetic-test-window";
import { getBookingWindowForTargetDate, shouldRefreshBookingWindow } from "@/lib/courses/booking-window";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { prisma } from "@/lib/prisma";
import { courseMonitoringPreferenceTarget, legacyOutdoorOfferingId } from "@/lib/searches/course-monitoring-target";
import { getCourseSetupDeadline, readCourseSetupStartedAt } from "@/lib/searches/course-setup-deadline";
import { classifyCourseSetupProbe } from "@/lib/searches/course-setup-proof";
import { simulatorDurationsForSearch } from "@/lib/searches/simulator-duration";
import { getSimulatorBookingOpening } from "@/lib/simulators/booking-window";

const LEGACY_SEARCH_LIMIT = 20;
const DEADLINE_SWEEP_LIMIT = 100;

export const courseSetupSearchSelect = {
  id: true, mode: true, status: true, createdAt: true, setupStartedAt: true,
  trafficClass: true, syntheticMultiCycle: true, syntheticTestWindow: true, alertGeneration: true,
  date: true, startTime: true, endTime: true, players: true, durationMinutes: true, requestedLayoutHoles: true,
  preferences: { select: { id: true, courseId: true, offeringId: true, course: { select: {
    timeZone: true, isPublic: true, website: true, bookingMethod: true, automationEligibility: true, automationReason: true,
    intelligenceVerifiedAt: true, intelligenceReviewAt: true, intelligenceConfidence: true,
    bookingWindowObservedAt: true, bookingWindowSource: true, bookingWindowConfidence: true, bookingWindowEvidenceUrl: true,
    bookingWindowDaysAhead: true, bookingReleaseTimeLocal: true,
  } }, offering: { select: {
    kind: true, active: true, publicAccessStatus: true, monitoringState: true, automationEligibility: true,
    supportedDurationsMinutes: true, bookingUrl: true, verifiedAt: true, evidenceUrl: true,
    bookingWindowDaysAhead: true, bookingReleaseTimeLocal: true,
  } } } },
} satisfies Prisma.TeeSearchSelect;

type SetupSearch = Prisma.TeeSearchGetPayload<{ select: typeof courseSetupSearchSelect }>;
type SetupProbe = Pick<CourseProbe, "id" | "teeSearchId" | "courseId" | "offeringId" | "outcome" | "observedAt" | "rawSummary">;

export async function readSavedCourseSetupDeadline(transaction: Prisma.TransactionClient, input: {
  searchId: string; courseId: string; offeringId: string | null; startedAt: Date;
}) {
  const preference = { teeSearchId: input.searchId, ...courseMonitoringPreferenceTarget(input) };
  const offeringIds = input.offeringId === null ? [null, legacyOutdoorOfferingId(input.courseId)] : [input.offeringId];
  const receipt = await transaction.courseSetupReceipt.findFirst({
    where: { courseId: input.courseId, startedAt: input.startedAt,
      OR: offeringIds.map(offeringId => ({ offeringId, preference: { ...preference, offeringId } })) },
    select: { deadlineAt: true },
  });
  return receipt?.deadlineAt;
}

function readVerifiedFactsAtSave(search: SetupSearch, preference: SetupSearch["preferences"][number], startedAt: Date) {
  const { course, offering } = preference;
  if (search.mode === "SIMULATOR") {
    if (!offering?.active || offering.kind !== "SIMULATOR" || offering.publicAccessStatus !== "PUBLIC" ||
        offering.automationEligibility === "BLOCKED" || ["FINAL_IDENTITY", "FINAL_TECHNICAL"].includes(offering.monitoringState) ||
        !offering.verifiedAt || offering.verifiedAt > startedAt || !getSafeCustomerBookingUrl(offering.bookingUrl) ||
        !simulatorDurationsForSearch(search.durationMinutes, offering.supportedDurationsMinutes).length) return undefined;
    const evidenceUrl = getSafeCustomerBookingUrl(offering.evidenceUrl);
    const opensAt = getSimulatorBookingOpening(search.date.toISOString().slice(0, 10), offering, course.timeZone);
    return evidenceUrl && opensAt && opensAt > startedAt ? {
      outcome: "BOOKING_NOT_OPEN" as const, evidenceAt: offering.verifiedAt,
      facts: { kind: "VERIFIED_SIMULATOR_BOOKING_WINDOW", opensAt: opensAt.toISOString(), evidenceUrl },
    } : undefined;
  }
  if (course.isPublic !== true) return undefined;
  const gate = evaluateMonitoringGate({ ...course, now: startedAt });
  if (gate.currentEvidence && course.intelligenceVerifiedAt && course.intelligenceVerifiedAt <= startedAt &&
      (gate.disposition === "MANUAL_FINAL" || gate.disposition === "TECHNICAL_FINAL")) {
    return { outcome: "DIRECT_ACTION" as const, evidenceAt: course.intelligenceVerifiedAt,
      facts: { kind: "VERIFIED_OUTDOOR_BOOKING_ACCESS", disposition: gate.disposition,
        bookingMethod: course.bookingMethod, reason: course.automationReason, officialUrl: getSafeCustomerBookingUrl(course.website) ?? null } };
  }
  if (gate.requiresRevalidation || !course.bookingWindowObservedAt || course.bookingWindowObservedAt > startedAt ||
      shouldRefreshBookingWindow(course.bookingWindowObservedAt, startedAt) || !course.bookingWindowSource ||
      (course.bookingWindowConfidence ?? 0) < 0.8) return undefined;
  const evidenceUrl = getSafeCustomerBookingUrl(course.bookingWindowEvidenceUrl);
  const window = getBookingWindowForTargetDate(search.date, course);
  return evidenceUrl && window && window.opensAt > startedAt ? {
    outcome: "BOOKING_NOT_OPEN" as const, evidenceAt: course.bookingWindowObservedAt,
    facts: { kind: "VERIFIED_OUTDOOR_BOOKING_WINDOW", source: course.bookingWindowSource,
      opensAt: window.opensAt.toISOString(), evidenceUrl },
  } : undefined;
}

/** Called in the same transaction that saves or replaces the requested criteria. */
export async function registerCourseSetupReceipts(
  transaction: Prisma.TransactionClient,
  search: SetupSearch,
  options: { legacy?: boolean; supersedes?: boolean } = {},
) {
  if (search.status !== "ACTIVE" && search.status !== "PAUSED") return 0;
  const startedAt = readCourseSetupStartedAt(search);
  if (options.supersedes) {
    await transaction.$executeRaw`
      UPDATE "CourseSetupReceipt" AS receipt
      SET "closedAt" = statement_timestamp() AT TIME ZONE 'UTC',
          outcome = CASE
            WHEN receipt."deadlineAt" > ${startedAt} THEN 'SUPERSEDED'::"CourseSetupOutcome"
            WHEN receipt.legacy THEN 'LEGACY_UNVERIFIED'::"CourseSetupOutcome"
            ELSE 'UNCONFIRMED'::"CourseSetupOutcome"
          END
      FROM "CoursePreference" AS preference
      WHERE preference."teeSearchId" = ${search.id} AND receipt."preferenceId" = preference.id
        AND receipt."startedAt" < ${startedAt} AND receipt.outcome IS NULL
    `;
  }
  const expiry = getSyntheticMultiCycleExpiresAt(search);
  const targetDate = search.date.toISOString().slice(0, 10);
  const { count } = await transaction.courseSetupReceipt.createMany({
    data: search.preferences.map(preference => {
      const timeZone = preference.course.timeZone;
      const deadline = getCourseSetupDeadline(search, timeZone);
      const deadlineAt = expiry && expiry < deadline ? expiry : deadline;
      const proof = !options.legacy && search.status === "ACTIVE" && deadlineAt > startedAt
        ? readVerifiedFactsAtSave(search, preference, startedAt) : undefined;
      return {
        preferenceId: preference.id, courseId: preference.courseId, offeringId: preference.offeringId,
        request: { mode: search.mode, targetDate, timeZone, startTime: search.startTime, endTime: search.endTime,
          players: search.players, durationMinutes: search.durationMinutes, requestedLayoutHoles: search.requestedLayoutHoles,
          ...(proof ? { factsAtSave: proof.facts } : {}) },
        startedAt, deadlineAt, legacy: options.legacy ?? false,
        ...(proof ? { outcome: proof.outcome, evidenceObservedAt: proof.evidenceAt, closedAt: startedAt } : {}),
      };
    }),
    skipDuplicates: true,
  });
  return count;
}

/** Only called by writers that already hold the current search/check fence. */
export async function recordCourseSetupProbe(transaction: Prisma.TransactionClient, probe: SetupProbe) {
  const [receipt] = await transaction.$queryRaw<Array<{
    id: string; startedAt: Date; recordedAt: Date; targetDate: string; mode: "OUTDOOR" | "SIMULATOR";
  }>>`
    SELECT receipt.id, receipt."startedAt", receipt.request->>'targetDate' AS "targetDate",
           search.mode, statement_timestamp() AT TIME ZONE 'UTC' AS "recordedAt"
    FROM "CoursePreference" AS preference
    JOIN "TeeSearch" AS search ON search.id = preference."teeSearchId"
    JOIN "CourseSetupReceipt" AS receipt ON receipt."preferenceId" = preference.id
    LEFT JOIN "CourseOffering" AS offering ON offering.id = preference."offeringId" AND offering."courseId" = preference."courseId"
    WHERE search.id = ${probe.teeSearchId} AND search.status = 'ACTIVE'::"SearchStatus"
      AND preference."courseId" = ${probe.courseId} AND receipt."courseId" = preference."courseId"
      AND receipt."offeringId" IS NOT DISTINCT FROM preference."offeringId"
      AND (preference."offeringId" IS NULL OR offering.kind = search.mode)
      AND (preference."offeringId" = ${probe.offeringId}::text OR (
        search.mode = 'OUTDOOR'::"SearchMode" AND ${probe.offeringId}::text IS NULL
        AND (preference."offeringId" IS NULL OR preference."offeringId" = ${legacyOutdoorOfferingId(probe.courseId)})
      ))
      AND receipt."startedAt" = COALESCE(search."setupStartedAt", search."createdAt")
      AND receipt.outcome IS NULL AND receipt."deadlineAt" >= statement_timestamp() AT TIME ZONE 'UTC'
  `;
  if (!receipt) return;
  const proof = classifyCourseSetupProbe({
    mode: receipt.mode, targetDate: receipt.targetDate, setupStartedAt: receipt.startedAt,
    recordedAt: receipt.recordedAt, probe,
  });
  if (!proof && (probe.observedAt < receipt.startedAt || probe.observedAt > receipt.recordedAt)) return;
  // Compare again at the write. A watchdog closeout and a check cannot both
  // settle the same receipt, even when the provider's timestamp was earlier.
  await transaction.$executeRaw`
    UPDATE "CourseSetupReceipt"
    SET outcome = ${proof?.outcome ?? null}::"CourseSetupOutcome", "evidenceProbeId" = ${probe.id},
        "evidenceObservedAt" = ${proof?.evidenceAt ?? probe.observedAt},
        "closedAt" = CASE WHEN ${Boolean(proof)} THEN statement_timestamp() AT TIME ZONE 'UTC' END
    WHERE id = ${receipt.id} AND outcome IS NULL AND "deadlineAt" >= statement_timestamp() AT TIME ZONE 'UTC'
  `;
}

export async function recoverDueCourseSetupReceipts() {
  const registeredLegacy = await prisma.$transaction(async transaction => {
    // Lock only surviving saved demand. This registers evidence boundaries
    // without changing a search status or scheduling any provider work.
    const missing = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT search.id FROM "TeeSearch" AS search
      WHERE search.status IN ('ACTIVE'::"SearchStatus", 'PAUSED'::"SearchStatus")
        AND EXISTS (
          SELECT 1 FROM "CoursePreference" AS preference
          WHERE preference."teeSearchId" = search.id AND NOT EXISTS (
            SELECT 1 FROM "CourseSetupReceipt" AS receipt
            WHERE receipt."preferenceId" = preference.id
              AND receipt."startedAt" = COALESCE(search."setupStartedAt", search."createdAt")
          )
        )
      ORDER BY search."createdAt", search.id
      LIMIT ${LEGACY_SEARCH_LIMIT} FOR UPDATE OF search SKIP LOCKED
    `;
    if (!missing.length) return 0;
    const searches = await transaction.teeSearch.findMany({
      where: { id: { in: missing.map(search => search.id) } }, select: courseSetupSearchSelect,
    });
    let count = 0;
    for (const search of searches) count += await registerCourseSetupReceipts(transaction, search, { legacy: true });
    return count;
  });
  const closed = await prisma.$queryRaw<Array<{ outcome: CourseSetupOutcome }>>`
    WITH due AS (
      SELECT id FROM "CourseSetupReceipt"
      WHERE outcome IS NULL AND "deadlineAt" <= statement_timestamp() AT TIME ZONE 'UTC'
      ORDER BY "deadlineAt", id LIMIT ${DEADLINE_SWEEP_LIMIT} FOR UPDATE SKIP LOCKED
    )
    UPDATE "CourseSetupReceipt" AS receipt
    SET outcome = CASE WHEN receipt.legacy THEN 'LEGACY_UNVERIFIED'::"CourseSetupOutcome"
        ELSE 'UNCONFIRMED'::"CourseSetupOutcome" END,
        "closedAt" = statement_timestamp() AT TIME ZONE 'UTC'
    FROM due WHERE receipt.id = due.id AND receipt.outcome IS NULL
    RETURNING receipt.outcome
  `;
  const legacyUnverified = closed.filter(receipt => receipt.outcome === "LEGACY_UNVERIFIED").length;
  return { registeredLegacy, unconfirmed: closed.length - legacyUnverified, legacyUnverified };
}
