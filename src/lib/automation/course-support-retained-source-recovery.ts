import { createHash } from "node:crypto";
import { AutomationEligibility, AutomationReason, BookingMethod, DetectedPlatform } from "@prisma/client";

import { sanitizeBrowserAuditUrl } from "./browser-probe-evidence";
import { assessAutomationPlaybook, parseAutomationPlaybookLedger } from "./course-monitoring-playbook";
import { selectProviderContractTrustedLandingUrl } from "./course-support-provider-contract-evidence";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import { resolveProviderCapability, type ProviderCourseInput } from "./provider-capabilities";

type ProviderSnapshot = Parameters<typeof buildCourseSupportProviderSnapshotFingerprint>[0];
export type CourseSupportRetainedSourceRecoveryInput = {
  course: Partial<Omit<ProviderSnapshot, "detectedPlatform">> & ProviderCourseInput & {
    monitoringStatus?: { state: string } | null;
    automationDiscoveries?: readonly {
      status: string;
      detectedPlatform: string;
      apiMetadata?: unknown;
      automationReason?: string | null;
      confidence: number;
      evidence: unknown;
      createdAt: Date;
    }[];
  };
  incident: { cycle: number; confirmedAt: Date | null; firstSeenAt: Date; attemptLedger: unknown };
  now?: Date;
};
export type CourseSupportRetainedSourceRecovery = {
  mode: "RETAINED_SOURCE_IDENTITY_RESEARCH";
  rejectionEvidenceDigest: string;
  providerSnapshotFingerprint: string;
  renderedObservedAt: string;
  runtimeVersion: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
function emptyOptionalArray(value: unknown) {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}
function emptyOptionalRecord(value: unknown) {
  return value === undefined || (record(value) !== null && Object.keys(record(value)!).length === 0);
}

function hasNoConclusiveDiscoveryEvidence(
  discovery: NonNullable<CourseSupportRetainedSourceRecoveryInput["course"]["automationDiscoveries"]>[number],
) {
  const evidence = record(discovery.evidence);
  return discovery.status === "INSPECTED" && discovery.detectedPlatform === "UNKNOWN" &&
    (discovery.apiMetadata === undefined || discovery.apiMetadata === null) &&
    Number.isFinite(discovery.confidence) && discovery.confidence >= 0 && discovery.confidence < 0.8 &&
    (discovery.automationReason == null || ["NONE", "UNSUPPORTED_PLATFORM"].includes(discovery.automationReason)) &&
    evidence !== null && emptyOptionalRecord(evidence.courseIdentityCorroboration) &&
    emptyOptionalRecord(evidence.retainedBookingTarget) && emptyOptionalArray(evidence.accessBarriers) &&
    emptyOptionalArray(evidence.renderedAccessControls) && emptyOptionalArray(evidence.successfulProviderUrls) &&
    evidence.factualDisposition === undefined && evidence.technicalReason === undefined;
}

/** Only this known weak HTTP evidence may follow, but never erase, browser rejection. */
export function isNeutralCourseSupportRetainedSourceObservation(
  discovery: NonNullable<CourseSupportRetainedSourceRecoveryInput["course"]["automationDiscoveries"]>[number],
) {
  return hasNoConclusiveDiscoveryEvidence(discovery) &&
    record(discovery.evidence)?.browserInvestigation === undefined &&
    ["browser-visible-links", "official-site-fetch-failed"].includes(String(record(discovery.evidence)?.learnedFrom));
}

/** Read-only admission evidence; ownership, one-search budget and projection remain caller fences. */
export function getCourseSupportRetainedSourceRecovery(
  input: CourseSupportRetainedSourceRecoveryInput,
): CourseSupportRetainedSourceRecovery | null {
  const { course, incident } = input;
  const now = input.now ?? new Date();
  const cycleStartedAt = incident.confirmedAt ?? (incident.cycle === 1 ? incident.firstSeenAt : null);
  if (!validDate(now) || !validDate(cycleStartedAt) || cycleStartedAt > now ||
    !Number.isSafeInteger(incident.cycle) || incident.cycle < 1 || course.isPublic !== true ||
    !Object.values(DetectedPlatform).includes(course.detectedPlatform as DetectedPlatform) ||
    !Object.values(BookingMethod).includes(course.bookingMethod as BookingMethod) ||
    !Object.values(AutomationEligibility).includes(course.automationEligibility as AutomationEligibility) ||
    !Object.values(AutomationReason).includes(course.automationReason as AutomationReason) ||
    ["HEALTHY", "FINAL_MANUAL", "FINAL_IDENTITY", "FINAL_TECHNICAL"].includes(course.monitoringStatus?.state ?? "") ||
    ["LOCAL_READER_ONLY", "CONTACT_ONLY"].includes(course.monitoringMode ?? "") ||
    ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(course.bookingMethod ?? "") ||
    ["ACCOUNT_REQUIRED", "ACCOUNT_SELF_SERVICE", "ACCOUNT_STAFF_PROVISIONED", "CAPTCHA_OR_QUEUE", "PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(course.bookingAccessMode ?? "") ||
    ["NO_ONLINE_BOOKING", "ACCOUNT_REQUIRED", "CAPTCHA_OR_QUEUE"].includes(course.automationReason ?? "") ||
    !selectProviderContractTrustedLandingUrl([course.website ?? null, course.detectedBookingUrl ?? null]) ||
    resolveProviderCapability(course).isRunnable) return null;

  const ledger = parseAutomationPlaybookLedger(incident.attemptLedger);
  const assessment = assessAutomationPlaybook(ledger, incident.cycle);
  const events = ledger?.events.filter((event) => event.cycle === incident.cycle) ?? [];
  if (!ledger || !assessment.valid || assessment.cycle !== incident.cycle ||
    assessment.conclusion !== "INCOMPLETE" || assessment.nextStage !== "INDEPENDENT_CONFIRMATION" ||
    ledger.events.at(-1)?.cycle !== incident.cycle ||
    events.some((event) => event.stage === "INDEPENDENT_CONFIRMATION" ||
      ["SUCCEEDED", "FACTUAL_FINAL", "TECHNICAL_LIMITATION"].includes(event.transition) ||
      event.failureClass === "AUTH" || event.failureClass === "CHALLENGE" ||
      new Date(event.observedAt) < cycleStartedAt || new Date(event.observedAt) > now)) return null;
  const renderedIndex = events.findIndex((event) => event.stage === "RENDERED_BROWSER_DISCOVERY" && event.transition === "COMPLETED");
  const rendered = events[renderedIndex];
  const renderedStarted = events.filter((event) => event.stage === "RENDERED_BROWSER_DISCOVERY" && event.transition === "STARTED").at(-1);
  const renderedObservationFloor = renderedStarted ?? events[renderedIndex - 1];
  // The native browser runner records a provider-bearing completion directly.
  // STARTED is optional; the prior ordered event bounds that observation instead.
  if (!rendered || !renderedObservationFloor || (renderedStarted && renderedStarted.runtimeVersion !== rendered.runtimeVersion) ||
    rendered.evidenceKind !== "RENDERED_PAGE" || rendered.providerExecution !== true ||
    !/^[a-f0-9]{40}$/u.test(rendered.runtimeVersion)) return null;

  const discoveries = course.automationDiscoveries;
  if (!discoveries?.length || discoveries.some((row) => !validDate(row.createdAt) || row.createdAt > now)) return null;
  const renderedDiscoveries = discoveries.filter((row) => record(record(row.evidence)?.browserInvestigation)?.mode === "RENDERED");
  const newestAt = Math.max(...renderedDiscoveries.map((row) => row.createdAt.getTime()));
  const latest = renderedDiscoveries.filter((row) => row.createdAt.getTime() === newestAt);
  if (latest.length !== 1) return null;
  const discovery = latest[0];
  // A later weak HTTP observation cannot erase durable browser identity rejection.
  // Unknown, browser, access, factual or provider-bearing observations remain a fence.
  if (discoveries.some((row) => row !== discovery && row.createdAt >= discovery.createdAt && (
    row.createdAt.getTime() === discovery.createdAt.getTime() ||
    !isNeutralCourseSupportRetainedSourceObservation(row)
  ))) return null;
  const evidence = record(discovery.evidence), browser = record(evidence?.browserInvestigation);
  const authority = record(browser?.identityAuthority), retained = record(browser?.retainedInputs);
  const pages = browser?.sameOriginPages;
  const snapshot: ProviderSnapshot = {
    ...course,
    detectedPlatform: course.detectedPlatform as DetectedPlatform,
    bookingMethod: course.bookingMethod!,
    automationEligibility: course.automationEligibility!,
    automationReason: course.automationReason!,
  };
  const providerSnapshotFingerprint = buildCourseSupportProviderSnapshotFingerprint(snapshot);
  const observedAt = typeof browser?.observedAt === "string" ? new Date(browser.observedAt) : null;
  const website = course.website ? sanitizeBrowserAuditUrl(course.website) : null;
  const booking = course.detectedBookingUrl ? sanitizeBrowserAuditUrl(course.detectedBookingUrl) : null;
  if (discovery.status !== "INSPECTED" || discovery.detectedPlatform !== "UNKNOWN" ||
    (discovery.apiMetadata !== undefined && discovery.apiMetadata !== null) ||
    !Number.isFinite(discovery.confidence) || discovery.confidence < 0 || discovery.confidence >= 0.8 ||
    (discovery.automationReason != null && !["NONE", "UNSUPPORTED_PLATFORM"].includes(discovery.automationReason)) ||
    !evidence || !browser || !authority || !retained || !validDate(observedAt) ||
    observedAt < cycleStartedAt || observedAt > now ||
    Math.abs(discovery.createdAt.getTime() - observedAt.getTime()) > 1000 ||
    observedAt < new Date(renderedObservationFloor.observedAt) || observedAt > new Date(rendered.observedAt) ||
    browser.mode !== "RENDERED" || browser.incidentCycle !== incident.cycle ||
    browser.runtimeVersion !== rendered.runtimeVersion || browser.providerSnapshotFingerprint !== providerSnapshotFingerprint ||
    !["browser-visible-links", "provider-target-scope-unconfirmed", "teeitup-target-scope-unconfirmed"].includes(String(evidence.learnedFrom)) ||
    (evidence.bookingCallToAction !== undefined && typeof evidence.bookingCallToAction !== "boolean") ||
    !emptyOptionalRecord(evidence.courseIdentityCorroboration) || !emptyOptionalRecord(evidence.retainedBookingTarget) ||
    !emptyOptionalArray(evidence.accessBarriers) || !emptyOptionalArray(evidence.renderedAccessControls) ||
    !emptyOptionalArray(evidence.successfulProviderUrls) || evidence.factualDisposition !== undefined || evidence.technicalReason !== undefined ||
    !["RETAINED_OFFICIAL_WEBSITE", "RETAINED_COURSE_SOURCE"].includes(String(authority.source)) ||
    authority.localityEvidencePresent !== true || authority.placeEvidencePresent !== true ||
    !Array.isArray(authority.renderedSignals) || authority.renderedSignals.length !== 3 ||
    !["TITLE", "H1", "URL_PATH"].every((signal) => (authority.renderedSignals as unknown[]).includes(signal)) ||
    retained.officialWebsite !== website || retained.bookingUrl !== booking ||
    typeof retained.sourceUrl !== "string" || ![website, booking].includes(retained.sourceUrl) ||
    !Array.isArray(pages) || pages.length === 0 || pages.length > 12 ||
    pages.some((value) => {
      const page = record(value);
      return !page || page.identityStatus !== "CONFLICT" || page.trustedForCourse !== false || page.interactionBlocked !== false ||
        typeof page.localityCorroborated !== "boolean" || !Number.isInteger(page.depth) || Number(page.depth) < 0 || Number(page.depth) > 2 ||
        typeof page.purpose !== "string" || typeof page.requestedUrl !== "string" || typeof page.finalUrl !== "string" ||
        sanitizeBrowserAuditUrl(page.requestedUrl) !== page.requestedUrl || sanitizeBrowserAuditUrl(page.finalUrl) !== page.finalUrl;
    }) || !Array.isArray(browser.bookingDestinations) || browser.bookingDestinations.length !== 0 ||
    !Array.isArray(browser.networkContracts) || browser.networkContracts.length !== 0 ||
    typeof browser.providerRequestObserved !== "boolean" ||
    (browser.restrictedNetworkObserved !== undefined && typeof browser.restrictedNetworkObserved !== "boolean")) return null;

  const renderedObservedAt = observedAt.toISOString();
  return {
    mode: "RETAINED_SOURCE_IDENTITY_RESEARCH",
    providerSnapshotFingerprint,
    renderedObservedAt,
    runtimeVersion: rendered.runtimeVersion,
    rejectionEvidenceDigest: createHash("sha256").update(JSON.stringify({
      version: 1, cycle: incident.cycle, providerSnapshotFingerprint,
      renderedObservedAt, runtimeVersion: rendered.runtimeVersion,
      authority: { source: authority.source, renderedSignals: ["TITLE", "H1", "URL_PATH"],
        localityEvidencePresent: true, placeEvidencePresent: true },
      retained: { officialWebsite: website, bookingUrl: booking, sourceUrl: retained.sourceUrl },
      pages: pages.map((value) => { const page = record(value)!; return {
        requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, depth: page.depth, purpose: page.purpose,
        identityStatus: page.identityStatus, localityCorroborated: page.localityCorroborated,
        trustedForCourse: false, interactionBlocked: false,
      }; }), bookingCallToAction: evidence.bookingCallToAction ?? false,
    })).digest("hex"),
  };
}
