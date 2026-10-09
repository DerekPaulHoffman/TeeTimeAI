import { Prisma } from "@prisma/client";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { createSimulatorSupportIntentDigest, isCurrentSimulatorSupportSource, isValidSimulatorEngineeringAuthority, isValidSimulatorSupportClaim, SIMULATOR_SUPPORT_SOURCE_SELECT, type SimulatorEngineeringAuthority } from "./simulator-support-policy";
import type { CourseDispatchAudit } from "./course-support-course-dispatch";
import { simulatorCapabilityWakeupReceipt } from "./simulator-capability-wakeup";

const DISPATCH_PROMPT_VERSION = "course-support-course-dispatch-v1";
const ENGINEERING_HISTORY_LIMIT = 64;
const ENGINEERING_CLOSEOUTS = new Set(["simulator_retryable_failed", "simulator_research_failed", "simulator_source_withdrawn", "simulator_source_changed", "simulator_monitoring_restored", "simulator_engineering_customer_priority", "simulator_engineering_monitoring_verified"]);

function consumedEngineeringProvenance(row: { kind: string; status: string; outcome: string | null; completedAt: Date | null }, audit: CourseDispatchAudit | null, now: Date) {
  if (!audit || row.kind !== "OTHER" || row.status !== "COMPLETED" || !row.completedAt || row.completedAt > now ||
      !ENGINEERING_CLOSEOUTS.has(row.outcome ?? "") || audit.state !== "CONSUMED" || audit.target.mode !== "SIMULATOR" ||
      audit.target.trafficClass !== "SYNTHETIC" || typeof audit.childThreadId !== "string" || !audit.childThreadId || !audit.consumedAt || !audit.launchStartedAt || !audit.boundAt ||
      !audit.simulatorClaim || !isValidSimulatorSupportClaim(audit.simulatorClaim) ||
      audit.simulatorClaim.originalSourceFingerprint !== audit.target.offeringSourceFingerprint ||
      audit.simulatorClaim.claimedAt !== audit.consumedAt ||
      !audit.target.searchRefs.length || audit.target.searchRefs.some(ref => !ref.intentDigest)) return false;
  const times = [audit.reservedAt, audit.launchStartedAt, audit.boundAt, audit.consumedAt].map(Date.parse);
  return times.every(time => Number.isFinite(time) && time <= row.completedAt!.getTime()) &&
    times.every((time, index) => index === 0 || time >= times[index - 1]);
}

/** Recheck immutable, positively consumed provenance before every engineering operation. */
export async function validateSimulatorEngineeringAuthority(tx: Pick<Prisma.TransactionClient, "automationRun">,
  authority: SimulatorEngineeringAuthority, target: Pick<CourseDispatchAudit["target"], "incidentId" | "courseId" | "offeringId" | "offeringSourceFingerprint">, now: Date) {
  if (!isValidSimulatorEngineeringAuthority(authority) || authority.sourceFingerprint !== target.offeringSourceFingerprint) throw new Error("Simulator engineering authority is malformed or belongs to another source.");
  const rows = await tx.automationRun.findMany({ where: { id: { in: [...new Set([authority.originRunId, authority.lineageRunId])] }, promptVersion: DISPATCH_PROMPT_VERSION },
    select: { id: true, kind: true, status: true, outcome: true, completedAt: true, audit: true }, take: 3 });
  const { parseCourseDispatchAudit } = await import("./course-support-course-dispatch");
  if (rows.some(row => JSON.stringify(row.audit).length > 256 * 1024)) throw new Error("Simulator engineering provenance exceeds its audit size bound.");
  const origin = rows.find(row => row.id === authority.originRunId), lineage = rows.find(row => row.id === authority.lineageRunId);
  const originAudit = parseCourseDispatchAudit(origin?.audit), lineageAudit = parseCourseDispatchAudit(lineage?.audit);
  if (!origin || !lineage || !consumedEngineeringProvenance(origin, originAudit, now) || !consumedEngineeringProvenance(lineage, lineageAudit, now) ||
      !originAudit || !lineageAudit || originAudit.target.engineeringAuthority ||
      originAudit.assignmentRef !== authority.originAssignmentRef || lineageAudit.assignmentRef !== authority.lineageAssignmentRef ||
      originAudit.simulatorClaim!.originalSourceFingerprint !== authority.originSourceFingerprint ||
      lineageAudit.simulatorClaim!.sourceFingerprint !== authority.sourceFingerprint ||
      [originAudit, lineageAudit].some(audit => audit.target.incidentId !== target.incidentId || audit.target.courseId !== target.courseId || audit.target.offeringId !== target.offeringId) ||
      (lineage.id !== origin.id && (!lineageAudit.target.engineeringAuthority ||
        lineageAudit.target.engineeringAuthority.originRunId !== authority.originRunId ||
        lineageAudit.target.engineeringAuthority.originAssignmentRef !== authority.originAssignmentRef ||
        lineageAudit.target.engineeringAuthority.originSourceFingerprint !== authority.originSourceFingerprint))) {
    throw new Error("Simulator engineering authority lacks the original consumed synthetic claim and current source lineage.");
  }
  return { originAudit, lineageAudit };
}

async function findSimulatorEngineeringAuthority(tx: Prisma.TransactionClient, target: Pick<CourseDispatchAudit["target"], "incidentId" | "courseId" | "offeringId" | "offeringSourceFingerprint">, now: Date) {
  const rows = await tx.automationRun.findMany({ where: { promptVersion: DISPATCH_PROMPT_VERSION, status: "COMPLETED",
    audit: { path: ["target", "offeringId"], equals: target.offeringId } },
    select: { id: true, kind: true, status: true, outcome: true, completedAt: true, audit: true }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: ENGINEERING_HISTORY_LIMIT });
  const { parseCourseDispatchAudit } = await import("./course-support-course-dispatch");
  for (const row of rows) {
    const audit = parseCourseDispatchAudit(row.audit);
    if (!consumedEngineeringProvenance(row, audit, now) || !audit || audit.target.incidentId !== target.incidentId ||
        audit.simulatorClaim!.sourceFingerprint !== target.offeringSourceFingerprint) continue;
    const prior = audit.target.engineeringAuthority;
    const authority: SimulatorEngineeringAuthority = { schemaVersion: 1,
      originRunId: prior?.originRunId ?? row.id, originAssignmentRef: prior?.originAssignmentRef ?? audit.assignmentRef,
      originSourceFingerprint: prior?.originSourceFingerprint ?? audit.simulatorClaim!.originalSourceFingerprint,
      lineageRunId: row.id, lineageAssignmentRef: audit.assignmentRef, sourceFingerprint: target.offeringSourceFingerprint! };
    const proof = await validateSimulatorEngineeringAuthority(tx, authority, target, now);
    return { authority, searchRefs: proof.originAudit.target.searchRefs };
  }
  if (rows.length === ENGINEERING_HISTORY_LIMIT) throw new Error("Simulator engineering provenance reached its bounded read limit without authoritative current lineage.");
  return null;
}

export async function hasSimulatorSupportOwnership(tx: Prisma.TransactionClient, offeringId: string) {
  const runs = await tx.automationRun.findMany({
    where: { promptVersion: DISPATCH_PROMPT_VERSION, status: "RUNNING", audit: { path: ["target", "offeringId"], equals: offeringId } },
    select: { audit: true }, take: 16,
  });
  if (runs.length === 16) throw new Error("Simulator ownership read reached its bound.");
  return runs.some(run => {
    const audit = run.audit as Record<string, unknown> | null;
    if (!audit || typeof audit !== "object" || !["RESERVED", "STARTING", "BOUND", "CONSUMED"].includes(String(audit.state))) throw new Error("Simulator ownership is malformed.");
    if (audit.state === "CONSUMED" && !isValidSimulatorSupportClaim(audit.simulatorClaim)) throw new Error("Simulator claim is malformed.");
    return true;
  });
}

// Called by the search workflow while its search/offering locks are held.
// Repeated checks do not reset a responder's episode, cooldown or ownership.
export async function reconcileSimulatorSupportIncidentFailure(tx: Prisma.TransactionClient, input: {
  offeringId: string; reason: string; evidenceUrl?: string | null; now: Date; eligible: boolean;
}) {
  if (!input.eligible) return;
  const offering = await tx.courseOffering.findUnique({ where: { id: input.offeringId }, select: { active: true, publicAccessStatus: true, monitoringState: true, automationEligibility: true } });
  if (!offering || !offering.active || offering.publicAccessStatus === "NOT_PUBLIC" ||
      ["FINAL_TECHNICAL", "FINAL_IDENTITY"].includes(offering.monitoringState) || offering.automationEligibility === "BLOCKED") return;
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SimulatorSupportIncident" WHERE "offeringId" = ${input.offeringId} FOR UPDATE`);
  const current = await tx.simulatorSupportIncident.findUnique({ where: { offeringId: input.offeringId } });
  if (!current) {
    await tx.simulatorSupportIncident.create({ data: { offeringId: input.offeringId, reason: input.reason, evidenceUrl: input.evidenceUrl, retryAt: input.now, firstSeenAt: input.now } });
    return;
  }
  if (await hasSimulatorSupportOwnership(tx, input.offeringId)) return;
  if (current.status !== "RESOLVED" && current.reason === input.reason && current.evidenceUrl === (input.evidenceUrl ?? null)) return;
  await tx.simulatorSupportIncident.update({ where: { id: current.id }, data: {
    status: "AUTO_INVESTIGATING", reason: input.reason, evidenceUrl: input.evidenceUrl ?? null, resolvedAt: null,
    retryAt: current.status === "RESOLVED" ? input.now : (current.retryAt && current.retryAt < input.now ? current.retryAt : input.now),
  } });
}

export async function resolveUnownedSimulatorSupportIncident(tx: Prisma.TransactionClient, input: { offeringId: string; now: Date }) {
  if (await hasSimulatorSupportOwnership(tx, input.offeringId)) return;
  const offering = await tx.courseOffering.findUnique({ where: { id: input.offeringId } });
  const latest = await tx.courseProbe.findFirst({ where: { offeringId: input.offeringId }, orderBy: [{ observedAt: "desc" }, { id: "desc" }] });
  const summary = latest?.rawSummary as Record<string, unknown> | null;
  if (!offering || offering.kind !== "SIMULATOR" || !offering.active || offering.publicAccessStatus !== "PUBLIC" ||
      offering.monitoringState !== "HEALTHY" || offering.automationEligibility !== "ALLOWED" || !offering.monitoringVerifiedAt || offering.monitoringVerifiedAt < input.now ||
      !latest || !["MATCH_FOUND", "NO_MATCH"].includes(latest.outcome) || !latest.runtimeVersion || latest.observedAt < input.now ||
      summary?.mode !== "SIMULATOR" || summary.sourceFingerprint !== getSimulatorOfferingSourceFingerprint(offering) ||
      typeof summary.providerObservedAt !== "string" || !Number.isFinite(Date.parse(summary.providerObservedAt)) || new Date(summary.providerObservedAt) < input.now) return;
  await tx.simulatorSupportIncident.updateMany({ where: { offeringId: input.offeringId, status: { not: "RESOLVED" } }, data: { status: "RESOLVED", resolvedAt: input.now, retryAt: null } });
}

export async function listSimulatorSupportDispatchCandidates(now: Date, tx: Prisma.TransactionClient) {
  const incidents = await tx.simulatorSupportIncident.findMany({
    where: { status: "AUTO_INVESTIGATING", OR: [{ retryAt: null }, { retryAt: { lte: now } }], offering: { kind: "SIMULATOR", active: true, publicAccessStatus: { not: "NOT_PUBLIC" } } },
    include: { offering: { include: { course: { select: { timeZone: true } } } } },
    orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }], take: 128,
  });
  if (incidents.length === 128) throw new Error("Simulator support queue reached its bounded read limit.");
  if (incidents.length === 0) return [];
  const preferences = await tx.coursePreference.findMany({
    where: { offeringId: { in: incidents.map(incident => incident.offeringId) }, teeSearch: { mode: "SIMULATOR", status: "ACTIVE", OR: [{ trafficClass: { notIn: ["TEST", "AUTOMATION"] } }, { trafficClass: { in: ["TEST", "AUTOMATION"] }, syntheticMultiCycle: true }] } },
    select: { offeringId: true, teeSearch: { select: SIMULATOR_SUPPORT_SOURCE_SELECT } }, take: 1024,
  });
  if (preferences.length === 1024) throw new Error("Simulator support source read reached its bound.");
  const candidates = [];
  for (const incident of incidents) {
    const sources = preferences.filter(preference => preference.offeringId === incident.offeringId).flatMap(({ teeSearch }) => {
      const trafficClass = ["TEST", "AUTOMATION"].includes(teeSearch.trafficClass) ? "SYNTHETIC" as const : "REAL" as const;
      const ref = { id: teeSearch.id, scheduleVersion: teeSearch.scheduleVersion, alertGeneration: teeSearch.alertGeneration, intentDigest: createSimulatorSupportIntentDigest(teeSearch) };
      return isCurrentSimulatorSupportSource({ search: teeSearch, ref, offeringId: incident.offeringId, trafficClass, timeZone: incident.offering.course.timeZone, now }) ? [{ ...ref, trafficClass: teeSearch.trafficClass }] : [];
    }).sort((a, b) => Number(["TEST", "AUTOMATION"].includes(a.trafficClass)) - Number(["TEST", "AUTOMATION"].includes(b.trafficClass)) || a.id.localeCompare(b.id));
    const sourceFingerprint = getSimulatorOfferingSourceFingerprint(incident.offering);
    const engineering = sources.length ? null : await findSimulatorEngineeringAuthority(tx, { incidentId: incident.id, courseId: incident.offering.courseId,
      offeringId: incident.offeringId, offeringSourceFingerprint: sourceFingerprint }, now);
    if (!sources.length && !engineering) continue;
    candidates.push({ incidentId: incident.id, courseId: incident.offering.courseId, offeringId: incident.offeringId,
      mode: "SIMULATOR" as const, cycle: 1, providerFamilyKey: incident.offering.providerFamilyKey ?? "SIMULATOR_SOURCE_PENDING",
      failureFingerprint: sourceFingerprint, offeringSourceFingerprint: sourceFingerprint, updatedAt: incident.updatedAt.toISOString(),
      activeRealSearchCount: sources.filter(source => !["TEST", "AUTOMATION"].includes(source.trafficClass)).length, sources,
      ...(engineering ? { engineeringAuthority: engineering.authority, engineeringSearchRefs: engineering.searchRefs } : {}) });
  }
  return candidates;
}

/** Inspect a small, separate future-retry window after the ordinary due read.
 * The existing planner and claim paths still own admission and all capacity.
 */
export async function reconcileSimulatorCapabilityWakeups(now: Date, tx: Prisma.TransactionClient) {
  const future = await tx.simulatorSupportIncident.findMany({
    where: { status: "AUTO_INVESTIGATING", retryAt: { gt: now }, offering: {
      kind: "SIMULATOR", active: true, publicAccessStatus: { not: "NOT_PUBLIC" },
      monitoringState: { notIn: ["FINAL_TECHNICAL", "FINAL_IDENTITY"] }, automationEligibility: { not: "BLOCKED" },
    } },
    include: { offering: { include: { course: { select: { timeZone: true } } } } },
    orderBy: [{ retryAt: "asc" }, { id: "asc" }], take: 32,
  });
  let advanced = 0;
  const { parseCourseDispatchAudit } = await import("./course-support-course-dispatch");
  for (const incident of future) {
    const fingerprint = getSimulatorOfferingSourceFingerprint(incident.offering);
    // A newer completed attempt, including one using the current reader, supersedes
    // an older generic receipt. Never search backwards for a favorable observation.
    const latest = await tx.automationRun.findFirst({ where: {
      promptVersion: DISPATCH_PROMPT_VERSION,
      audit: { path: ["target", "offeringId"], equals: incident.offeringId },
    }, orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { kind: true, status: true, outcome: true, startedAt: true, completedAt: true, audit: true } });
    if (!latest || latest.kind !== "OTHER" || latest.status !== "COMPLETED" || latest.outcome !== "simulator_retryable_failed" ||
        !latest.completedAt || latest.startedAt > latest.completedAt ||
        JSON.stringify(latest.audit).length > 256 * 1024) continue;
    const audit = parseCourseDispatchAudit(latest.audit);
    if (!audit || !simulatorCapabilityWakeupReceipt({ audit, incidentId: incident.id,
      courseId: incident.offering.courseId, offeringId: incident.offeringId,
      sourceFingerprint: fingerprint, completedAt: latest.completedAt, now })) continue;
    if (await hasSimulatorSupportOwnership(tx, incident.offeringId)) continue;
    const refs = audit.target.searchRefs;
    const searches = await tx.teeSearch.findMany({ where: { id: { in: refs.map(ref => ref.id) } }, select: SIMULATOR_SUPPORT_SOURCE_SELECT });
    const hasCurrentRealDemand = searches.some(search => {
      const ref = refs.find(candidate => candidate.id === search.id);
      return ref && isCurrentSimulatorSupportSource({ search, ref, offeringId: incident.offeringId,
        trafficClass: "REAL", timeZone: incident.offering.course.timeZone, now });
    });
    if (!hasCurrentRealDemand) {
      // Only the existing original consumed synthetic lineage can outlive demand.
      if (audit.target.trafficClass !== "SYNTHETIC") continue;
      const engineering = await findSimulatorEngineeringAuthority(tx, { incidentId: incident.id,
        courseId: incident.offering.courseId, offeringId: incident.offeringId,
        offeringSourceFingerprint: fingerprint }, now);
      if (!engineering) continue;
    }
    const result = await tx.simulatorSupportIncident.updateMany({ where: {
      id: incident.id, status: "AUTO_INVESTIGATING", updatedAt: incident.updatedAt, retryAt: incident.retryAt,
    }, data: { retryAt: now } });
    advanced += result.count;
  }
  return advanced;
}
