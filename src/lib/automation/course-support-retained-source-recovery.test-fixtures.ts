import { buildBrowserDiscovery } from "./browser-discovery";
import { finalizeBrowserInvestigationEvidence, prepareBrowserPageEvidence } from "./browser-probe-evidence";
import { appendAutomationPlaybookEvent, type AutomationPlaybookEventInput } from "./course-monitoring-playbook";
import { buildBrowserPlaybookTransition } from "./course-monitoring-playbook-runtime";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import { type CourseSupportRetainedSourceRecoveryInput } from "./course-support-retained-source-recovery";

export const retainedSourceRecoveryNow = new Date("2026-09-07T20:00:00.000Z");
export const retainedSourceRecoveryRuntimeVersion = "a".repeat(40);
export const retainedSourceRecoveryAt = (seconds: number) => new Date(retainedSourceRecoveryNow.getTime() + seconds * 1000);
const now = retainedSourceRecoveryNow;
const runtimeVersion = retainedSourceRecoveryRuntimeVersion;
const at = retainedSourceRecoveryAt;

export function retainedSourceRecoveryFixture(options: { renderedStarted?: boolean } = {}) {
  const source = "https://retained-course.example/golf";
  const course = {
    isPublic: true, website: source, detectedBookingUrl: source,
    detectedPlatform: "UNKNOWN" as const, providerFamilyKey: "retained-course.example",
    bookingMetadata: null, bookingMethod: "PUBLIC_ONLINE" as const,
    automationEligibility: "NEEDS_REVIEW" as const, automationReason: "UNSUPPORTED_PLATFORM" as const,
    bookingAccessMode: "UNKNOWN", monitoringMode: "AUTOMATIC" as const,
  };
  const native = finalizeBrowserInvestigationEvidence({
    course: { courseId: "fixture", courseName: "Target Harbor Golf Club", sourceUrl: source,
      officialCourseWebsite: source, address: "100 Fairway Lane", city: "Mesa", stateCode: "AZ", googlePlaceIdPresent: true },
    mode: "RENDERED", auditContext: { incidentCycle: 2, runtimeVersion, observedAt: at(-30) }, retainedBookingUrl: source,
    pageVisits: ["golf", "rates", "contact"].map((path, index) => ({
      requestedUrl: `https://retained-course.example/${path}`, finalUrl: `https://retained-course.example/${path}`,
      label: "Course information", depth: index === 0 ? 0 : 1, parentUrl: index === 0 ? null : source, interactionBlocked: false,
      evidence: prepareBrowserPageEvidence({ anchors: [], accessControlDetected: false,
        managedProtectionTemplateDetected: false, managedProtectionDocumentDetected: false,
        structuredActionScripts: [], scripts: [], identityCandidates: ["Different Desert Golf Club"],
        localityCandidates: ["100 Fairway Lane Mesa AZ"], visibleText: "Different Desert Golf Club. Book tee times online.",
        linkCandidates: [{ url: source, label: "Book tee times" }] }),
    })), bookingDestinations: [],
  });
  const discovery = buildBrowserDiscovery(native);
  const browser = { ...native.browserInvestigation, providerSnapshotFingerprint: buildCourseSupportProviderSnapshotFingerprint(course) };
  const evidence = { ...discovery.evidence, browserInvestigation: browser };
  let ledger: unknown = null;
  const append = (event: Omit<AutomationPlaybookEventInput, "cycle" | "runtimeVersion" | "failureFingerprint">) => {
    ledger = appendAutomationPlaybookEvent(ledger, { ...event, cycle: 2, runtimeVersion,
      failureFingerprint: `PLAYBOOK:${event.stage}:${event.skipReason ?? event.transition}` });
  };
  append({ stage: "OFFICIAL_IDENTITY", transition: "COMPLETED", readPath: "OFFICIAL_IDENTITY", evidenceKind: "OFFICIAL_SOURCE", observedAt: at(-50), providerExecution: false });
  append({ stage: "TYPED_ADAPTER", transition: "NOT_APPLICABLE", readPath: "TYPED_PROVIDER_ADAPTER", evidenceKind: "TOOLING", skipReason: "NO_RUNNABLE_ADAPTER", observedAt: at(-45) });
  append({ stage: "OFFICIAL_HTTP_DISCOVERY", transition: "COMPLETED", readPath: "OFFICIAL_HTTP", evidenceKind: "OFFICIAL_SOURCE", observedAt: at(-43), providerExecution: true });
  append({ stage: "HTTP_ADAPTER_RETRY", transition: "NOT_APPLICABLE", readPath: "TYPED_PROVIDER_ADAPTER", evidenceKind: "TOOLING", skipReason: "NO_METADATA_CHANGE", observedAt: at(-40) });
  if (options.renderedStarted) append({ stage: "RENDERED_BROWSER_DISCOVERY", transition: "STARTED", readPath: "RENDERED_BROWSER", evidenceKind: "RENDERED_PAGE", observedAt: at(-35), providerExecution: false });
  append({ stage: "RENDERED_BROWSER_DISCOVERY", readPath: "RENDERED_BROWSER", observedAt: at(-25), providerExecution: true,
    ...buildBrowserPlaybookTransition({ stage: "RENDERED_BROWSER_DISCOVERY", technicalReason: null, localReaderTechnicalReason: null }) });
  append({ stage: "BROWSER_ADAPTER_RETRY", transition: "NOT_APPLICABLE", readPath: "TYPED_PROVIDER_ADAPTER", evidenceKind: "TOOLING", skipReason: "NO_RUNNABLE_ADAPTER", observedAt: at(-20) });
  append({ stage: "LOCAL_READER", transition: "NOT_APPLICABLE", readPath: "LOCAL_READER", evidenceKind: "TOOLING", skipReason: "NO_LOCAL_READER_CAPABILITY", observedAt: at(-15) });
  const input: CourseSupportRetainedSourceRecoveryInput = { course: { ...course, automationDiscoveries: [{
    status: discovery.status, detectedPlatform: discovery.detectedPlatform, apiMetadata: null,
    confidence: discovery.confidence, evidence, createdAt: at(-30),
  }] }, incident: { cycle: 2, confirmedAt: at(-60), firstSeenAt: at(-120), attemptLedger: ledger }, now };
  return { input, browser, evidence, native, append, getLedger: () => ledger };
}
