import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { optionalJsonRecord, parseSearchEmailPayload } from "@/lib/email/search-delivery-payload";
import { getCustomerCourseMonitoringStatus, type SearchStatusCourseReport } from "@/lib/email/search-status";
import { getProviderExecutionEvidenceObservedAt } from "./provider-execution-marker";
import { isSearchScheduleWorkflowStartReservation } from "./search-recheck-queue";

const READ_LIMIT = 256;
const ref = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 24);
const object = (value: unknown) => optionalJsonRecord(value) ?? {};

type Probe = {
  courseId: string; automationRunId: string | null; outcome: string;
  observedAt: Date; runtimeVersion: string | null; rawSummary: unknown;
};
export type CustomerRecoverySearch = {
  id: string; status: string; trafficClass: string; scheduleVersion: number;
  alertGeneration: number; alertEmail: string | null; additionalEmails: string[];
  user: { email: string }; workflowRunId: string | null; checkStatus: string;
  checkLeaseToken: string | null; checkLeaseExpiresAt: Date | null;
  nextCheckAt: Date | null; lastCheckedAt: Date | null;
  preferences: { courseId: string }[]; probes: Probe[];
  emailDeliveries: { alertGeneration: number; recipient: string; status: string; sentAt: Date | null; payload: unknown }[];
};

/** Deliberately excludes dry runs and invisible statusSnapshot courses. */
export function acceptedRecoveryCourseIds(delivery: CustomerRecoverySearch["emailDeliveries"][number]) {
  if (delivery.status !== "SENT" || !delivery.sentAt) return new Set<string>();
  const payload = parseSearchEmailPayload(delivery.payload);
  const report = object(payload?.statusReport);
  const matches = object(payload?.matchReport);
  return new Set([
    ...(Array.isArray(report.courses) ? report.courses : []).flatMap(value => {
      const course = object(value);
      return typeof course.courseId === "string" &&
        getCustomerCourseMonitoringStatus(course as SearchStatusCourseReport) === "MONITORED"
        ? [course.courseId] : [];
    }),
    ...(Array.isArray(matches.matches) ? matches.matches : []).flatMap(value => {
      const courseId = object(value).courseId;
      return typeof courseId === "string" ? [courseId] : [];
    }),
  ]);
}

export function assessCustomerRecovery(input: {
  searches: { dispatchedVersion: number; search: CustomerRecoverySearch | null }[];
  courseIds: string[]; releaseSha: string | null; evidenceSince: Date;
  notificationSince: Date; previous?: unknown; now: Date;
}) {
  const priorSearches = object(object(input.previous).searches);
  const searches: Record<string, { scheduleVersion: number; alertGeneration: number; evidenceSince: string }> = {};
  let affectedSearchCount = 0;
  let pendingProviderPairCount = 0;
  let pendingSchedulerCount = 0;
  let pendingRecipientCourseCount = 0;
  for (const { search, dispatchedVersion } of input.searches) {
    if (!search || search.status !== "ACTIVE" || ["TEST", "AUTOMATION"].includes(search.trafficClass)) continue;
    const courseIds = search.preferences.map(p => p.courseId).filter(id => input.courseIds.includes(id));
    if (!courseIds.length) continue;
    affectedSearchCount++;
    const searchRef = ref(search.id);
    const prior = object(priorSearches[searchRef]);
    const sameGeneration = prior.scheduleVersion === search.scheduleVersion && prior.alertGeneration === search.alertGeneration;
    const priorFloor = typeof prior.evidenceSince === "string" ? new Date(prior.evidenceSince) : null;
    // An owner edit must obtain fresh proof for the new request. Save the floor
    // once so ordinary checks do not keep moving the recovery goalposts.
    const floor = sameGeneration && priorFloor && Number.isFinite(priorFloor.getTime()) ? priorFloor
      : Object.keys(prior).length || search.scheduleVersion !== dispatchedVersion ? input.now : input.evidenceSince;
    searches[searchRef] = { scheduleVersion: search.scheduleVersion, alertGeneration: search.alertGeneration, evidenceSince: floor.toISOString() };
    const schedulerHealthy = Boolean(search.workflowRunId && !isSearchScheduleWorkflowStartReservation(search.workflowRunId) &&
      ((search.checkStatus === "WAITING" && search.nextCheckAt && search.nextCheckAt.getTime() >= input.now.getTime() - 120_000) ||
       (search.checkStatus === "CHECKING" && search.checkLeaseToken && search.checkLeaseExpiresAt && search.checkLeaseExpiresAt > input.now)));
    if (!schedulerHealthy) pendingSchedulerCount++;
    const recipients = [...new Set([search.alertEmail ?? search.user.email, ...search.additionalEmails].map(email => email.trim().toLowerCase()))];
    for (const courseId of new Set(courseIds)) {
      const observations = search.probes.filter(p => p.courseId === courseId).map(probe => ({
        probe, at: getProviderExecutionEvidenceObservedAt({ rawSummary: probe.rawSummary, probeObservedAt: probe.observedAt }),
      })).filter(p => p.at && p.at >= floor && p.at <= input.now).sort((a, b) => b.at!.getTime() - a.at!.getTime());
      const successes = observations.slice(0, 2).filter(p => ["NO_MATCH", "MATCH_FOUND"].includes(p.probe.outcome) && /^[a-f0-9]{40}$/.test(p.probe.runtimeVersion ?? ""));
      const newest = observations[0];
      const latestPersisted = search.probes.filter(p => p.courseId === courseId && p.observedAt >= floor)
        .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
      const newestIsSuccess = newest && ["NO_MATCH", "MATCH_FOUND"].includes(newest.probe.outcome) &&
        !observations.some(p => p.at!.getTime() === newest.at!.getTime() && !["NO_MATCH", "MATCH_FOUND"].includes(p.probe.outcome));
      const distinctRuns = new Set(successes.filter(p => p.probe.automationRunId).map(p => p.probe.automationRunId));
      const distinctTimes = new Set(successes.map(p => p.at!.getTime()));
      // RESTORED closeout already owns exact-release proof. Later customer
      // checks may run on a newer deployed release and must not be stranded.
      if (!newestIsSuccess || !latestPersisted || !["NO_MATCH", "MATCH_FOUND"].includes(latestPersisted.outcome) ||
          distinctRuns.size < 2 || distinctTimes.size < 2 || !input.releaseSha ||
          !search.lastCheckedAt || search.lastCheckedAt < newest.at!) pendingProviderPairCount++;
      for (const recipient of recipients) {
        if (!search.emailDeliveries.some(delivery => delivery.alertGeneration === search.alertGeneration &&
          delivery.recipient.trim().toLowerCase() === recipient && delivery.sentAt && delivery.sentAt >= input.notificationSince &&
          acceptedRecoveryCourseIds(delivery).has(courseId))) pendingRecipientCourseCount++;
      }
    }
  }
  const pending = pendingProviderPairCount + pendingSchedulerCount + pendingRecipientCourseCount > 0;
  return {
    schemaVersion: 1,
    status: affectedSearchCount === 0 ? "NO_ACTIVE_DEMAND" : pending ? "OPEN" : "COMPLETE",
    observedAt: input.now.toISOString(), affectedSearchCount, pendingProviderPairCount,
    pendingSchedulerCount, pendingRecipientCourseCount, searches,
    nextAction: pending ? "Verify the affected alert's provider checks, scheduled follow-up, and accepted recovery or matching email; repair the failing shared component without reclassifying a healthy course." : null,
  };
}

export async function readCustomerRecovery(
  client: Pick<Prisma.TransactionClient, "courseSupportBatchSearch">,
  batch: { id: string; createdAt: Date; releaseSha: string | null; deployedAt: Date | null; recheckDispatchStartedAt: Date | null; summary: unknown },
  courseIds: string[], now: Date,
) {
  if (object(batch.summary).customerRecoveryVersion !== 1) return null;
  const floor = new Date(Math.max(batch.createdAt.getTime(), batch.deployedAt?.getTime() ?? 0, batch.recheckDispatchStartedAt?.getTime() ?? 0));
  const dispatches = courseIds.length ? await client.courseSupportBatchSearch.findMany({
    where: { batchId: batch.id }, take: READ_LIMIT + 1,
    select: { scheduleVersion: true, teeSearch: { select: {
      id: true, status: true, trafficClass: true, scheduleVersion: true, alertGeneration: true,
      alertEmail: true, additionalEmails: true, user: { select: { email: true } },
      workflowRunId: true, checkStatus: true, checkLeaseToken: true, checkLeaseExpiresAt: true,
      nextCheckAt: true, lastCheckedAt: true, preferences: { select: { courseId: true } },
      probes: { where: { courseId: { in: courseIds }, observedAt: { gte: floor } }, take: 1281,
        orderBy: { observedAt: "desc" }, select: { courseId: true, automationRunId: true, outcome: true, observedAt: true, runtimeVersion: true, rawSummary: true } },
      emailDeliveries: { where: { status: "SENT", sentAt: { gte: batch.createdAt } }, take: 513,
        orderBy: { sentAt: "desc" }, select: { alertGeneration: true, recipient: true, status: true, sentAt: true, payload: true } },
    } } },
  }) : [];
  if (dispatches.length > READ_LIMIT || dispatches.some(d => d.teeSearch && (d.teeSearch.probes.length > 1280 || d.teeSearch.emailDeliveries.length > 512))) {
    throw new Error("Customer recovery evidence exceeds its bounded read limit; engineering review is required.");
  }
  return assessCustomerRecovery({ searches: dispatches.map(d => ({ dispatchedVersion: d.scheduleVersion, search: d.teeSearch })),
    courseIds, releaseSha: batch.releaseSha, evidenceSince: floor, notificationSince: batch.createdAt,
    previous: object(batch.summary).customerRecovery, now });
}

/** Closed provider batches retain their independent customer case until verified.
 * Read-only provider/customer evidence; the only writes are CAS updates to that case.
 */
export async function refreshPendingCustomerRecoveries(now = new Date()) {
  const batches = await prisma.courseSupportBatch.findMany({
    where: { completedAt: { not: null }, summary: { path: ["customerRecovery", "status"], equals: "OPEN" } },
    orderBy: [{ heartbeatAt: "asc" }, { id: "asc" }], take: 32,
    select: { id: true, reference: true, createdAt: true, releaseSha: true, deployedAt: true,
      recheckDispatchStartedAt: true, summary: true, revision: true,
      incidents: { where: { result: "RESTORED" }, select: { courseId: true } } },
  });
  let completedCount = 0;
  const openCases: { batchRef: string; pendingProviderPairCount: number; pendingSchedulerCount: number; pendingRecipientCourseCount: number }[] = [];
  for (const batch of batches) {
    await prisma.$transaction(async tx => {
      // Owner mutations and email finalization lock this same parent first.
      await tx.$queryRaw(Prisma.sql`SELECT search."id" FROM "TeeSearch" search
        JOIN "CourseSupportBatchSearch" dispatch ON dispatch."teeSearchId" = search."id"
        WHERE dispatch."batchId" = ${batch.id} ORDER BY search."id" FOR UPDATE OF search`);
      const recovery = await readCustomerRecovery(tx, batch, batch.incidents.map(i => i.courseId), now);
      if (!recovery) throw new Error("Customer recovery case lost its contract version.");
      const updated = await tx.courseSupportBatch.updateMany({ where: { id: batch.id, revision: batch.revision },
        data: { summary: { ...object(batch.summary), customerRecovery: recovery } as Prisma.InputJsonObject,
          heartbeatAt: now, revision: { increment: 1 } } });
      if (updated.count !== 1) throw new Error("Customer recovery case changed during verification; retry inspection.");
      if (recovery.status !== "OPEN") completedCount++;
      else openCases.push({ batchRef: batch.reference,
        pendingProviderPairCount: recovery.pendingProviderPairCount,
        pendingSchedulerCount: recovery.pendingSchedulerCount,
        pendingRecipientCourseCount: recovery.pendingRecipientCourseCount });
    }, { isolationLevel: "Serializable" });
  }
  const pendingCount = await prisma.courseSupportBatch.count({ where: {
    completedAt: { not: null }, summary: { path: ["customerRecovery", "status"], equals: "OPEN" },
  } });
  return { inspectedCount: batches.length, completedCount, pendingCount, openCases,
    nextAction: pendingCount ? "Customer recovery remains open. Inspect the saved customerRecovery counts and repair the provider, reader, scheduler, or delivery failure; provider resolution alone is not customer recovery." : null };
}
