import { RUNNABLE_SIMULATOR_PROVIDER_FAMILIES } from "@/lib/simulators/providers";
import { knownSimulatorPublicConfigurationFamily } from "@/lib/simulators/providers/public-configuration";
import type { CourseDispatchAudit } from "./course-support-course-dispatch";
import { isValidSimulatorSupportClaim } from "./simulator-support-policy";
import { readSimulatorResearchFailureMemory, readSimulatorResearchState } from "./simulator-support-research-policy";

const OLD_GENERIC_COLLECTORS = new Set([
  "public-calendar-resource-local-v3",
  "public-calendar-passive-method-shapes-v4",
]);
const MAX_RECEIPT_AGE_MS = 30 * 60_000;

/** A new structural reader may advance one old research-only cooldown. It does not
 * authorize a read, an implementation, or a deployment; normal claim checks remain.
 */
export function simulatorCapabilityWakeupReceipt(input: {
  audit: CourseDispatchAudit;
  incidentId: string;
  courseId: string;
  offeringId: string;
  sourceFingerprint: string;
  completedAt: Date;
  now: Date;
}): { sourceUrl: string; requestId: string } | null {
  const { audit, incidentId, courseId, offeringId, sourceFingerprint, completedAt, now } = input;
  const claim = audit.simulatorClaim;
  if (audit.state !== "CONSUMED" || audit.target.mode !== "SIMULATOR" ||
      audit.target.incidentId !== incidentId || audit.target.courseId !== courseId ||
      audit.target.offeringId !== offeringId || audit.target.offeringSourceFingerprint !== sourceFingerprint ||
      !claim || !isValidSimulatorSupportClaim(claim) || claim.phase !== "CLAIMED" ||
      claim.originalSourceFingerprint !== sourceFingerprint || claim.sourceFingerprint !== sourceFingerprint ||
      claim.claimedAt !== audit.consumedAt || claim.plannedPaths.length !== 0 || claim.releaseSha !== null ||
      claim.deployment !== null || claim.recheckQueuedAt !== null ||
      (audit as CourseDispatchAudit & { simulatorRepairPending?: unknown }).simulatorRepairPending ||
      (audit as CourseDispatchAudit & { simulatorEngineeringVerification?: unknown }).simulatorEngineeringVerification ||
      !audit.ownerThreadId || !audit.childThreadId || !audit.assignmentRef ||
      !audit.reservedAt || !audit.launchStartedAt || !audit.boundAt || !audit.consumedAt ||
      !Number.isFinite(completedAt.getTime()) || completedAt > now ||
      !audit.target.searchRefs.length || audit.target.searchRefs.some(ref => !ref.intentDigest)) return null;
  const claimedAt = Date.parse(claim.claimedAt);
  const chronology = [audit.reservedAt, audit.launchStartedAt, audit.boundAt, audit.consumedAt]
    .map(value => Date.parse(value!));
  if (!Number.isFinite(claimedAt) || claimedAt > completedAt.getTime() ||
      chronology.some(value => !Number.isFinite(value) || value > completedAt.getTime()) ||
      chronology.some((value, index) => index > 0 && value < chronology[index - 1])) return null;
  try {
    const research = readSimulatorResearchState(audit.simulatorResearch, sourceFingerprint);
    if (research.sourceFingerprint !== sourceFingerprint || research.inFlight || research.readCount < 1 ||
        research.readCount >= 6 || research.history.length !== research.readCount) return null;
    const observedTimes = research.history.map(entry => Date.parse(entry.observedAt));
    const requestIds = research.history.map(entry => entry.requestId).filter((id): id is string => Boolean(id));
    if (observedTimes.some(time => !Number.isFinite(time) || time < claimedAt || time > completedAt.getTime()) ||
        observedTimes.some((time, index) => index > 0 && time < observedTimes[index - 1]) ||
        new Set(requestIds).size !== requestIds.length) return null;
    const memory = readSimulatorResearchFailureMemory(audit.simulatorResearchPriorFailures);
    if (memory && (memory.sourceFingerprint !== sourceFingerprint || memory.routes.some(route =>
      route.failure || [401, 403, 404].includes(route.httpStatus) || (route.accessControls?.length ?? 0) > 0))) return null;
    const receiptIndex = research.history.map((_, index) => index).reverse().find(index => {
      const entry = research.history[index];
      return !entry.rendered && OLD_GENERIC_COLLECTORS.has(entry.researchImplementationVersion ?? "") &&
        Boolean(knownSimulatorPublicConfigurationFamily(entry.sourceUrl));
    }) ?? -1;
    const latest = research.history[receiptIndex];
    if (!latest || latest.outcome !== "READ" || latest.rendered || latest.httpStatus < 200 || latest.httpStatus >= 300 ||
        !latest.requestId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(latest.requestId) ||
        latest.sourceFingerprint !== sourceFingerprint || latest.publicReadEvidence?.sourceFingerprint !== sourceFingerprint ||
        latest.publicReadEvidence.method !== "HTTP" || latest.publicReadEvidence.accessControlsObserved !== true ||
        latest.publicReadEvidence.accessControls.length !== 0 || latest.failure ||
        !OLD_GENERIC_COLLECTORS.has(latest.researchImplementationVersion ?? "")) return null;
    const observedAt = Date.parse(latest.observedAt);
    if (!Number.isFinite(observedAt) || observedAt < claimedAt || observedAt > completedAt.getTime() ||
        observedAt > now.getTime() || now.getTime() - observedAt > MAX_RECEIPT_AGE_MS) return null;
    // A protected result anywhere in the owned episode remains evidence of an
    // access or hard failure. A benign later partial read does not erase it.
    if (research.history.some(entry => entry.outcome !== "READ" ||
      [401, 403, 404].includes(entry.httpStatus) ||
      (entry.publicReadEvidence?.accessControls.length ?? 0) > 0)) return null;
    if (research.history.slice(receiptIndex + 1).some(entry =>
      entry.requestedUrl === latest.requestedUrl &&
      (entry.researchImplementationVersion === "public-calendar-known-readers-passive-method-shapes-v3" ||
        entry.rendered === latest.rendered &&
        (entry.outcome === "HARD_FAILED" || [401, 403, 404].includes(entry.httpStatus) ||
        (entry.publicReadEvidence?.accessControls.length ?? 0) > 0 ||
        entry.researchImplementationVersion !== latest.researchImplementationVersion)))) return null;
    const family = knownSimulatorPublicConfigurationFamily(latest.sourceUrl);
    if (!family || !RUNNABLE_SIMULATOR_PROVIDER_FAMILIES.some(key => key === family)) return null;
    if (latest.source === "link") {
      // The owned `link` reservation passed the original handoff guard. Final
      // links/roles are mutable and may have been replaced by this child page.
      const parent = research.history.slice(0, receiptIndex).find(entry =>
        entry.sourceUrl !== latest.sourceUrl && entry.requestId !== latest.requestId &&
        entry.sourceFingerprint === sourceFingerprint && entry.publicReadEvidence?.sourceFingerprint === sourceFingerprint &&
        entry.publicReadEvidence.accessControlsObserved === true && !entry.publicReadEvidence.accessControls.length &&
        entry.outcome === "READ" && entry.httpStatus >= 200 && entry.httpStatus < 300 && entry.requestId &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(entry.requestId) &&
        Date.parse(entry.observedAt) <= observedAt && Date.parse(entry.observedAt) >= observedAt - MAX_RECEIPT_AGE_MS);
      if (!parent) return null;
    } else if (latest.source !== "booking" && latest.source !== "booking-root") return null;
    return { sourceUrl: latest.sourceUrl, requestId: latest.requestId };
  } catch {
    return null;
  }
}
