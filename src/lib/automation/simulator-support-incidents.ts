import { Prisma } from "@prisma/client";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { createSimulatorSupportIntentDigest, isCurrentSimulatorSupportSource, isValidSimulatorSupportClaim, SIMULATOR_SUPPORT_SOURCE_SELECT } from "./simulator-support-policy";

const DISPATCH_PROMPT_VERSION = "course-support-course-dispatch-v1";

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
  return incidents.flatMap(incident => {
    const sources = preferences.filter(preference => preference.offeringId === incident.offeringId).flatMap(({ teeSearch }) => {
      const trafficClass = ["TEST", "AUTOMATION"].includes(teeSearch.trafficClass) ? "SYNTHETIC" as const : "REAL" as const;
      const ref = { id: teeSearch.id, scheduleVersion: teeSearch.scheduleVersion, alertGeneration: teeSearch.alertGeneration, intentDigest: createSimulatorSupportIntentDigest(teeSearch) };
      return isCurrentSimulatorSupportSource({ search: teeSearch, ref, offeringId: incident.offeringId, trafficClass, timeZone: incident.offering.course.timeZone, now }) ? [{ ...ref, trafficClass: teeSearch.trafficClass }] : [];
    }).sort((a, b) => Number(["TEST", "AUTOMATION"].includes(a.trafficClass)) - Number(["TEST", "AUTOMATION"].includes(b.trafficClass)) || a.id.localeCompare(b.id));
    if (!sources.length) return [];
    const sourceFingerprint = getSimulatorOfferingSourceFingerprint(incident.offering);
    return [{ incidentId: incident.id, courseId: incident.offering.courseId, offeringId: incident.offeringId,
      mode: "SIMULATOR" as const, cycle: 1, providerFamilyKey: incident.offering.providerFamilyKey ?? "SIMULATOR_SOURCE_PENDING",
      failureFingerprint: sourceFingerprint, offeringSourceFingerprint: sourceFingerprint, updatedAt: incident.updatedAt.toISOString(),
      activeRealSearchCount: sources.filter(source => !["TEST", "AUTOMATION"].includes(source.trafficClass)).length, sources }];
  });
}
