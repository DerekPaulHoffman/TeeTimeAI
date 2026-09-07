import { sanitizeBrowserAuditUrl } from "./browser-probe-evidence";
import { assessAutomationPlaybook, parseAutomationPlaybookLedger } from "./course-monitoring-playbook";
import {
  getCourseSupportRetainedSourceRecovery,
  isNeutralCourseSupportRetainedSourceObservation,
  type CourseSupportRetainedSourceRecoveryInput,
} from "./course-support-retained-source-recovery";

export type CourseSupportSourceResearchOutcomeInput = CourseSupportRetainedSourceRecoveryInput & {
  course: CourseSupportRetainedSourceRecoveryInput["course"] & {
    monitoringStatus?: { state: string } | null;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function emptyOptionalArray(value: unknown) {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function emptyOptionalRecord(value: unknown) {
  const valueRecord = record(value);
  return value === undefined || (valueRecord !== null && Object.keys(valueRecord).length === 0);
}

/** Proven unsuccessful research is engineering work, never a factual final disposition.
 * False is absence of this particular proof, not permission to implement or search again.
 */
export function hasUnresolvedCourseSupportSourceResearch(
  input: CourseSupportSourceResearchOutcomeInput,
): boolean {
  const { course, incident } = input;
  const now = input.now ?? new Date();
  const cycleStartedAt = incident.confirmedAt ?? (incident.cycle === 1 ? incident.firstSeenAt : null);
  if (!Number.isFinite(now.getTime()) || !cycleStartedAt || !Number.isFinite(cycleStartedAt.getTime()) ||
    ["HEALTHY", "FINAL_MANUAL", "FINAL_IDENTITY"].includes(course.monitoringStatus?.state ?? "")) return false;
  const ledger = parseAutomationPlaybookLedger(incident.attemptLedger);
  const assessment = assessAutomationPlaybook(ledger, incident.cycle);
  if (!ledger || !assessment.valid || assessment.cycle !== incident.cycle ||
    assessment.conclusion !== "UNRESOLVED_EXHAUSTED" || assessment.nextStage !== null ||
    ledger.events.at(-1)?.cycle !== incident.cycle) return false;
  const currentEvents = ledger.events.filter((event) => event.cycle === incident.cycle);
  if (currentEvents.some((event) => new Date(event.observedAt) < cycleStartedAt ||
    new Date(event.observedAt) > now || ["SUCCEEDED", "FACTUAL_FINAL", "TECHNICAL_LIMITATION"].includes(event.transition) ||
    event.failureClass === "AUTH" || event.failureClass === "CHALLENGE")) return false;
  const independent = currentEvents.filter((event) => event.stage === "INDEPENDENT_CONFIRMATION");
  const first = independent[0];
  const completed = independent.at(-1);
  if (!first || !completed || !/^[a-f0-9]{40}$/u.test(completed.runtimeVersion)) return false;

  // Reconstruct an actual append-only prefix solely to verify the prior rejected
  // source. The full exhausted ledger remains authoritative and is never reset.
  const prefix = { ...ledger, events: ledger.events.filter((event) => event.sequence < first.sequence) };
  const discoveries = course.automationDiscoveries;
  if (!discoveries?.length || discoveries.some((row) => !Number.isFinite(row.createdAt.getTime()) || row.createdAt > now)) return false;

  if (independent.length === 1 && completed.transition === "FAILED_TERMINAL" &&
    completed.readPath === "INDEPENDENT_CONFIRMATION" && completed.evidenceKind === "TOOLING" &&
    completed.providerExecution === false && completed.failureClass === "MISSING_SOURCE") {
    const rejection = getCourseSupportRetainedSourceRecovery({
      ...input, now, incident: { ...incident, attemptLedger: prefix },
    });
    return rejection !== null && completed.failureFingerprint ===
      `RETAINED_SOURCE:EXACT_SEARCH:NO_UNIQUE:${rejection.providerSnapshotFingerprint.toUpperCase()}`;
  }

  const started = independent.length === 2 ? first : null;
  if ((independent.length !== 1 && independent.length !== 2) || completed.transition !== "COMPLETED" ||
    completed.readPath !== "INDEPENDENT_CONFIRMATION" || completed.evidenceKind !== "RENDERED_PAGE" ||
    completed.providerExecution !== true || (started && (
      started.transition !== "STARTED" || started.readPath !== "INDEPENDENT_CONFIRMATION" ||
      started.evidenceKind !== "RENDERED_PAGE" || started.providerExecution !== false ||
      started.runtimeVersion !== completed.runtimeVersion
    ))) return false;
  // The native browser runner writes COMPLETED directly. An explicit STARTED,
  // where present, strengthens the bound; otherwise the preceding stage does.
  const independentNotBefore = new Date(started?.observedAt ?? prefix.events.at(-1)!.observedAt);
  const independentDiscoveries = discoveries.filter((row) =>
    record(record(row.evidence)?.browserInvestigation)?.mode === "INDEPENDENT");
  const latestAt = Math.max(...independentDiscoveries.map((row) => row.createdAt.getTime()));
  const newest = independentDiscoveries.filter((row) => row.createdAt.getTime() === latestAt);
  if (newest.length !== 1) return false;
  const discovery = newest[0];
  // Later neutral HTTP findings cannot erase stronger completed browser research.
  // New browser, unknown, access, factual or provider evidence remains a fence.
  if (discoveries.some((row) => row !== discovery && row.createdAt >= discovery.createdAt && (
    row.createdAt.getTime() === discovery.createdAt.getTime() ||
    !isNeutralCourseSupportRetainedSourceObservation(row)
  ))) return false;
  const evidence = record(discovery.evidence);
  const browser = record(evidence?.browserInvestigation);
  const authority = record(browser?.identityAuthority);
  const retained = record(browser?.retainedInputs);
  const observedAt = typeof browser?.observedAt === "string" ? new Date(browser.observedAt) : null;
  const source = typeof retained?.sourceUrl === "string" ? sanitizeBrowserAuditUrl(retained.sourceUrl) : null;
  const pages = browser?.sameOriginPages;
  if (discovery.status !== "INSPECTED" || discovery.detectedPlatform !== "UNKNOWN" ||
    (discovery.apiMetadata !== undefined && discovery.apiMetadata !== null) ||
    !Number.isFinite(discovery.confidence) || discovery.confidence < 0 || discovery.confidence >= 0.8 ||
    (discovery.automationReason != null && !["NONE", "UNSUPPORTED_PLATFORM"].includes(discovery.automationReason)) ||
    !evidence || !browser || !authority || !retained || !observedAt || !Number.isFinite(observedAt.getTime()) ||
    observedAt < independentNotBefore || observedAt > new Date(completed.observedAt) ||
    Math.abs(discovery.createdAt.getTime() - observedAt.getTime()) > 1000 ||
    browser.mode !== "INDEPENDENT" || browser.incidentCycle !== incident.cycle ||
    browser.runtimeVersion !== completed.runtimeVersion || browser.providerRequestObserved !== true ||
    authority.source !== "UNPROJECTED_OWNER_SOURCE_CANDIDATE" ||
    authority.localityEvidencePresent !== true || authority.placeEvidencePresent !== true ||
    !Array.isArray(authority.renderedSignals) || authority.renderedSignals.length !== 3 ||
    new Set(authority.renderedSignals).size !== 3 ||
    !authority.renderedSignals.every((signal) => ["TITLE", "H1", "URL_PATH"].includes(String(signal))) ||
    !source || source !== retained.sourceUrl || retained.officialWebsite !== source || retained.bookingUrl !== null ||
    evidence.learnedFrom !== "unprojected-source-candidate-identity-unverified" ||
    (evidence.bookingCallToAction !== undefined && typeof evidence.bookingCallToAction !== "boolean") ||
    !emptyOptionalRecord(evidence.courseIdentityCorroboration) || !emptyOptionalRecord(evidence.retainedBookingTarget) ||
    !emptyOptionalArray(evidence.accessBarriers) || !emptyOptionalArray(evidence.renderedAccessControls) ||
    !emptyOptionalArray(evidence.successfulProviderUrls) || evidence.factualDisposition !== undefined || evidence.technicalReason !== undefined ||
    !Array.isArray(browser.bookingDestinations) || browser.bookingDestinations.length !== 0 ||
    !Array.isArray(browser.networkContracts) || browser.networkContracts.length !== 0 ||
    !Array.isArray(pages) || pages.length === 0 || pages.length > 12 ||
    pages.some((value) => {
      const page = record(value);
      return !page || !["MATCH", "CONFLICT", "UNKNOWN"].includes(String(page.identityStatus)) ||
        page.trustedForCourse !== false || page.interactionBlocked !== false ||
        typeof page.localityCorroborated !== "boolean" || !Number.isInteger(page.depth) || Number(page.depth) < 0 || Number(page.depth) > 2 ||
        typeof page.purpose !== "string" || typeof page.requestedUrl !== "string" || typeof page.finalUrl !== "string" ||
        sanitizeBrowserAuditUrl(page.requestedUrl) !== page.requestedUrl || sanitizeBrowserAuditUrl(page.finalUrl) !== page.finalUrl;
    }) || !pages.some((value) => record(value)?.depth === 0 && record(value)?.requestedUrl === source)) return false;
  const rejection = getCourseSupportRetainedSourceRecovery({
    ...input, now,
    course: { ...course, automationDiscoveries: discoveries.filter((row) => row !== discovery) },
    incident: { ...incident, attemptLedger: prefix },
  });
  return rejection !== null && browser.providerSnapshotFingerprint === rejection.providerSnapshotFingerprint;
}
