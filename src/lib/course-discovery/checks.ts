import type { ActiveAutomationSearch, SearchCheckLease } from "@/lib/automation/db-service";
import { commitCurrentCourseTeeTimeMatches, recordCourseProbe } from "@/lib/automation/db-service";
import { recordCourseMonitoringSuccess } from "@/lib/automation/course-monitoring";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import { getLocalReaderCourseKey } from "@/lib/local-reader/service";
import { RUNNABLE_SIMULATOR_PROVIDER_FAMILIES } from "@/lib/simulators/providers";
import { SimulatorAvailabilityError } from "@/lib/simulators/providers/types";
import type { SearchCheckCourseResult } from "@/lib/automation/search-check";
import { isDiscoveryPilotSearch } from "./config";
import { ensureDiscoveryJob, getActiveAccessRecipe, type DiscoveryTarget } from "./service";
import { assertRecipeObservationCurrent, getOrQueueRecipeExecution, recipeExecutionNeedsRepair, recipeFailureIsRetryable, recipeResultIsSuccessful } from "./runtime";
import { refreshMissingDiscoverySource } from "./sources";
import { prisma } from "@/lib/prisma";

type Preference = ActiveAutomationSearch["preferences"][number];
export function recipeRequestInput(search: ActiveAutomationSearch, preference: Preference) {
  return { date: search.date.toISOString().slice(0, 10), timeZone: preference.course.timeZone, players: search.players,
    startTime: search.startTime, endTime: search.endTime,
    ...(search.mode === "SIMULATOR" && search.durationMinutes ? { durationMinutes: search.durationMinutes } : {}) };
}
export async function getLearnedAvailability(search: ActiveAutomationSearch, preference: Preference) {
  if (!await isDiscoveryPilotSearch(search.id)) return null;
  if (search.mode === "OUTDOOR" && preference.course.isPublic === false) return null;
  if (search.mode === "SIMULATOR" && (!preference.offering || !preference.offering.active || preference.offering.publicAccessStatus === "NOT_PUBLIC" ||
      preference.offering.monitoringState === "FINAL_IDENTITY" || preference.offering.monitoringState === "FINAL_TECHNICAL" || preference.offering.automationEligibility === "BLOCKED")) return null;
  const target: DiscoveryTarget = { courseId: preference.courseId, ...(preference.offeringId ? { offeringId: preference.offeringId } : {}), kind: search.mode };
  const recipe = await getActiveAccessRecipe(target);
  if (!recipe) {
    // Preserve established supported paths; learning handles unknown/unconfigured sources.
    if (search.mode === "OUTDOOR" && (resolveProviderCapability(preference.course).isRunnable ||
        getLocalReaderCourseKey(preference.course.detectedBookingUrl ?? preference.course.website) !== null)) {
      const admitted = await prisma.courseDiscoveryJob.findUnique({ where: { activeTargetKey: `course:${preference.courseId}` }, select: { id: true } });
      if (!admitted) return null;
    }
    const offering = preference.offering;
    if (search.mode === "SIMULATOR" && offering?.kind === "SIMULATOR" && offering.active &&
        offering.publicAccessStatus === "PUBLIC" && offering.bookingUrl && offering.verifiedAt && offering.evidenceUrl &&
        search.durationMinutes && offering.supportedDurationsMinutes.includes(search.durationMinutes) &&
        RUNNABLE_SIMULATOR_PROVIDER_FAMILIES.some(family => family === offering.providerFamilyKey)) {
      const admitted = await prisma.courseDiscoveryJob.findUnique({ where: { activeTargetKey: `offering:${offering.id}` }, select: { id: true } });
      if (!admitted) return null;
    }
    await refreshMissingDiscoverySource(preference.courseId).catch(() => undefined);
    const job = await ensureDiscoveryJob({ ...target, searchId: search.id });
    if (job && ["FAILED", "TIMED_OUT", "CANCELLED"].includes(job.status)) return { state: "failed" as const, target, outcome: job.outcome };
    return { state: "pending" as const, target };
  }
  const execution = await getOrQueueRecipeExecution({ searchId: search.id, target, input: recipeRequestInput(search, preference) });
  if (execution?.state === "ready" && !recipeResultIsSuccessful(execution.result)) {
    if (!recipeExecutionNeedsRepair(execution.result)) return { state: "failed" as const, target, outcome: execution.result.evidence.reason ?? "LOCAL_CAPABILITY_UNAVAILABLE" };
    // A failed read supplies no availability evidence, but does not invalidate a verified
    // immutable method. Repair that exact version while normal fresh reads can
    // recover independently, including after the repair exhausts its attempts.
    const repair = await ensureDiscoveryJob({ ...target, searchId: search.id, failedRecipeId: execution.recipeId });
    return repair && ["FAILED", "TIMED_OUT", "CANCELLED"].includes(repair.status)
      ? { state: "failed" as const, target, outcome: repair.outcome }
      : { state: "pending" as const, target };
  }
  return execution ? { ...execution, target } : { state: "pending" as const, target };
}

/** A failed established method may enter the same bounded learning job. The
 * ordinary check supplies the failure; successful reads never call this path. */
export async function queueFailedOutdoorDiscovery(search: ActiveAutomationSearch, preference: Preference, outcome: SearchCheckCourseResult["outcome"]) {
  if (!["FETCH_FAILED", "NEEDS_ADAPTER"].includes(outcome) || search.mode !== "OUTDOOR" || preference.course.isPublic === false || !await isDiscoveryPilotSearch(search.id)) return false;
  const job = await ensureDiscoveryJob({ courseId: preference.courseId, searchId: search.id });
  return Boolean(job && ["QUEUED", "RUNNING"].includes(job.status));
}

/** Only an actual adapter failure can enter discovery. Lease contention and
 * provider throttling keep their ordinary retry path, without invoking AI. */
export async function queueFailedSimulatorDiscovery(search: ActiveAutomationSearch, preference: Preference,
  outcome: SearchCheckCourseResult["outcome"], providerFailure: unknown) {
  const offering = preference.offering;
  if (!providerFailure || providerFailure instanceof SimulatorAvailabilityError && providerFailure.httpStatus === 429 ||
      !["FETCH_FAILED", "NEEDS_ADAPTER"].includes(outcome) || search.mode !== "SIMULATOR" || !offering?.active ||
      offering.kind !== "SIMULATOR" || offering.publicAccessStatus === "NOT_PUBLIC" ||
      !await isDiscoveryPilotSearch(search.id)) return false;
  const job = await ensureDiscoveryJob({ courseId: preference.courseId, offeringId: offering.id, searchId: search.id });
  return Boolean(job && ["QUEUED", "RUNNING"].includes(job.status));
}

export async function checkLearnedOutdoor(search: ActiveAutomationSearch, preference: Preference, runId: string, lease: SearchCheckLease): Promise<SearchCheckCourseResult | null> {
  if (search.mode !== "OUTDOOR") return null;
  if (search.requestedLayoutHoles && preference.course.layoutHoleCounts.length && !preference.course.layoutHoleCounts.includes(search.requestedLayoutHoles)) return null;
  const learned = await getLearnedAvailability(search, preference);
  if (!learned) return null;
  const common = { courseId: preference.courseId, courseName: preference.course.name, timeZone: preference.course.timeZone,
    rank: preference.rank, availableMatches: 0, bookingUrl: preference.course.detectedBookingUrl ?? preference.course.website ?? undefined };
  if (learned.state === "failed") {
    const readerUnavailable = recipeFailureIsRetryable(learned.outcome ?? undefined);
    await recordCourseProbe({ searchId: search.id, courseId: preference.courseId, automationRunId: runId,
      runtimeVersion: getAutomationRuntimeVersion(), outcome: "FETCH_FAILED", rawSummary: { discoveryTerminal: !readerUnavailable, outcome: learned.outcome } });
    if (readerUnavailable) return { ...common, outcome: "CHECK_PENDING", message: "We couldn’t complete this check. We’ll try again shortly." };
    return { ...common, outcome: "FETCH_FAILED", message: "We could not verify this course’s availability. You can check its official site." };
  }
  if (learned.state !== "ready" || !recipeResultIsSuccessful(learned.result)) {
    await recordCourseProbe({ searchId: search.id, courseId: preference.courseId, automationRunId: runId,
      runtimeVersion: getAutomationRuntimeVersion(), outcome: "NEEDS_ADAPTER", rawSummary: { discoveryPending: true } });
    return { ...common, outcome: "CHECK_PENDING", message: "We’re checking this course’s official availability." };
  }
  const { result, recipeId, jobId } = learned;
  const observedAt = new Date(result.observedAt);
  const outcome = result.slots.length ? "MATCH_FOUND" as const : "NO_MATCH" as const;
  const observation = { jobId, recipeId, courseId: preference.courseId, searchId: search.id };
  const success = await recordCourseMonitoringSuccess({ courseId: preference.courseId, outcome, providerObservedAt: observedAt,
    runtimeVersion: getAutomationRuntimeVersion(), onBeforeSourceWrite: tx => assertRecipeObservationCurrent(tx, observation) });
  if (!success?.sourceEvidenceAccepted) return { ...common, outcome: "CHECK_PENDING" };
  const committed = await commitCurrentCourseTeeTimeMatches({ searchId: search.id, alertGeneration: search.alertGeneration,
    checkLeaseToken: lease.token, courseId: preference.courseId, date: search.date.toISOString().slice(0, 10),
    timeZone: preference.course.timeZone, providerObservedAt: observedAt, sourceKind: "SUCCESS", accessRecipeObservation: observation,
    matches: result.slots.map(slot => ({ sourceId: slot.sourceId, startsAt: new Date(slot.startsAt),
      endsAt: slot.endsAt ? new Date(slot.endsAt) : undefined, resourceId: slot.resourceId, productId: slot.productId, availableSpots: slot.availableSpots,
      bookingUrl: slot.bookingUrl, evidenceUrl: result.sourceUrl, holes: slot.holes })) });
  if (!committed.sourceEvidenceAccepted) return { ...common, outcome: "CHECK_PENDING" };
  await recordCourseProbe({ searchId: search.id, courseId: preference.courseId, automationRunId: runId,
    runtimeVersion: getAutomationRuntimeVersion(), outcome, observedAtOrAfter: observedAt,
    rawSummary: { recipeId, recipeHash: result.evidence.recipeHash, recipeExecutionId: jobId, observedAt: result.observedAt, complete: true } });
  return { ...common, outcome, monitoringDisposition: "ACTIONABLE", bookingUrl: result.sourceUrl, availableMatches: result.slots.length,
    matchingTimes: result.slots.map((slot, index) => ({ matchId: committed.persistedMatchStates[index]?.matchId,
      startsAt: slot.startsAt, availableSpots: slot.availableSpots, holes: slot.holes, isNew: committed.persistedMatchStates[index]?.isPending ?? false })) };
}
