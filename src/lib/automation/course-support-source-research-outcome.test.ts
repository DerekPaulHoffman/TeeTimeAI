import { describe, expect, it, vi } from "vitest";
const persistence = vi.hoisted(() => ({ transaction: vi.fn(), lock: vi.fn(), findIncident: vi.fn(), updateIncident: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  $transaction: persistence.transaction, courseMonitoringStatus: {}, courseMonitoringEvent: {},
} }));
import { buildBrowserDiscovery } from "./browser-discovery";
import { finalizeBrowserInvestigationEvidence, prepareBrowserPageEvidence } from "./browser-probe-evidence";
import { appendAutomationPlaybookEvent, assessAutomationPlaybook, parseAutomationPlaybookLedger } from "./course-monitoring-playbook";
import { buildBrowserPlaybookTransition, recordRuntimePlaybookTransition, type CourseMonitoringPlaybookRuntime } from "./course-monitoring-playbook-runtime";
import { getCourseSupportRetainedSourceRecovery } from "./course-support-retained-source-recovery";
import {
  retainedSourceRecoveryFixture,
  retainedSourceRecoveryAt as at,
  retainedSourceRecoveryRuntimeVersion as runtimeVersion,
} from "./course-support-retained-source-recovery.test-fixtures";
import { hasUnresolvedCourseSupportSourceResearch } from "./course-support-source-research-outcome";

function noUniqueFixture() {
  const { input } = retainedSourceRecoveryFixture();
  const rejection = getCourseSupportRetainedSourceRecovery(input)!;
  expect(rejection).not.toBeNull();
  input.incident.attemptLedger = appendAutomationPlaybookEvent(input.incident.attemptLedger, {
    cycle: input.incident.cycle, stage: "INDEPENDENT_CONFIRMATION", transition: "FAILED_TERMINAL",
    readPath: "INDEPENDENT_CONFIRMATION", evidenceKind: "TOOLING", failureClass: "MISSING_SOURCE",
    failureFingerprint: `RETAINED_SOURCE:EXACT_SEARCH:NO_UNIQUE:${rejection.providerSnapshotFingerprint.toUpperCase()}`,
    providerExecution: false, runtimeVersion, observedAt: at(-5),
  });
  return input;
}

function failedCandidateFixture(withStartedEvent = true) {
  const { input } = retainedSourceRecoveryFixture();
  const rejection = getCourseSupportRetainedSourceRecovery(input)!;
  expect(rejection).not.toBeNull();
  const source = "https://candidate-course.example/golf";
  const native = finalizeBrowserInvestigationEvidence({
    course: { courseId: "fixture", courseName: "Target Harbor Golf Club", sourceUrl: source,
      officialCourseWebsite: source, address: "100 Fairway Lane", city: "Mesa", stateCode: "AZ", googlePlaceIdPresent: true },
    mode: "INDEPENDENT", unprojectedSourceCandidate: true,
    auditContext: { incidentCycle: input.incident.cycle, runtimeVersion, observedAt: at(-7) },
    retainedBookingUrl: null, providerRequestObserved: true,
    pageVisits: [{
      requestedUrl: source, finalUrl: source, label: "Candidate website", depth: 0, parentUrl: null, interactionBlocked: false,
      evidence: prepareBrowserPageEvidence({ anchors: [], accessControlDetected: false,
        managedProtectionTemplateDetected: false, managedProtectionDocumentDetected: false,
        structuredActionScripts: [], scripts: [], identityCandidates: ["Different Desert Golf Club"],
        localityCandidates: ["100 Fairway Lane Mesa AZ"], visibleText: "Different Desert Golf Club. Book tee times online.",
        linkCandidates: [{ url: source, label: "Book tee times" }] }),
    }], bookingDestinations: [],
  });
  const discovery = buildBrowserDiscovery(native);
  const browser = { ...native.browserInvestigation, providerSnapshotFingerprint: rejection.providerSnapshotFingerprint };
  const evidence = { ...discovery.evidence, browserInvestigation: browser };
  input.course.automationDiscoveries = [{
    status: discovery.status, detectedPlatform: discovery.detectedPlatform, apiMetadata: null,
    automationReason: discovery.automationReason, confidence: discovery.confidence,
    evidence, createdAt: at(-7),
  }, ...input.course.automationDiscoveries!];
  for (const transition of ["STARTED", "COMPLETED"] as const) {
    if (transition === "STARTED" && !withStartedEvent) continue;
    input.incident.attemptLedger = appendAutomationPlaybookEvent(input.incident.attemptLedger, {
      cycle: input.incident.cycle, stage: "INDEPENDENT_CONFIRMATION", transition,
      readPath: "INDEPENDENT_CONFIRMATION", evidenceKind: "RENDERED_PAGE",
      failureFingerprint: `PLAYBOOK:INDEPENDENT_CONFIRMATION:${transition}`,
      providerExecution: transition === "COMPLETED", runtimeVersion,
      observedAt: transition === "STARTED" ? at(-10) : at(-5),
    });
  }
  return { input, browser, evidence, discovery };
}

describe("hasUnresolvedCourseSupportSourceResearch", () => {
  it("recognizes snapshot-bound no-unique research without inventing provider execution or a final disposition", () => {
    const input = noUniqueFixture();
    const original = structuredClone(input);
    expect(hasUnresolvedCourseSupportSourceResearch(input)).toBe(true);
    expect(assessAutomationPlaybook(input.incident.attemptLedger, input.incident.cycle).conclusion).toBe("UNRESOLVED_EXHAUSTED");
    expect(input).toEqual(original);
  });

  it("recognizes actual unprojected candidate browsing that fails course identity", () => {
    const { input, browser } = failedCandidateFixture();
    expect(browser.identityAuthority.source).toBe("UNPROJECTED_OWNER_SOURCE_CANDIDATE");
    expect(browser.sameOriginPages.every((page) => page.trustedForCourse === false)).toBe(true);
    const original = structuredClone(input);
    expect(hasUnresolvedCourseSupportSourceResearch(input)).toBe(true);
    expect(input).toEqual(original);
  });

  it("recognizes the native runtime writer's direct browser completion without a synthetic start", async () => {
    const { input } = failedCandidateFixture(false);
    const complete = parseAutomationPlaybookLedger(input.incident.attemptLedger)!;
    const incident = {
      id: "fixture-incident", cycle: input.incident.cycle, revision: 1, status: "AUTO_INVESTIGATING",
      attemptLedger: { ...complete, events: complete.events.slice(0, -1) } as unknown,
    };
    persistence.findIncident.mockImplementation(async () => ({ ...incident }));
    persistence.updateIncident.mockImplementation(async ({ where, data }) => {
      expect(where).toMatchObject({ id: incident.id, cycle: incident.cycle, revision: incident.revision });
      incident.attemptLedger = data.attemptLedger;
      incident.revision += 1;
      return { count: 1 };
    });
    persistence.event.mockResolvedValue({});
    persistence.lock.mockResolvedValue([{ locked: true }]);
    persistence.transaction.mockImplementation(async (worker) => worker({
      $queryRawUnsafe: persistence.lock,
      courseSupportIncident: { findUnique: persistence.findIncident, updateMany: persistence.updateIncident },
      courseMonitoringEvent: { create: persistence.event },
    }));
    const runtime: CourseMonitoringPlaybookRuntime = { courseId: "fixture-course", incidentId: incident.id,
      cycle: incident.cycle, assessment: assessAutomationPlaybook(incident.attemptLedger, incident.cycle), localReaderTechnicalReason: null };
    expect(await recordRuntimePlaybookTransition(runtime, {
      stage: "INDEPENDENT_CONFIRMATION", readPath: "INDEPENDENT_CONFIRMATION", runtimeVersion, providerExecution: true,
      source: "COURSE_SUPPORT_RESPONDER", now: at(-5),
      ...buildBrowserPlaybookTransition({ stage: "INDEPENDENT_CONFIRMATION", technicalReason: null, localReaderTechnicalReason: null, factualDisposition: null }),
    })).toMatchObject({ recorded: true });
    input.incident.attemptLedger = incident.attemptLedger;
    const independent = parseAutomationPlaybookLedger(incident.attemptLedger)!.events.filter((event) => event.stage === "INDEPENDENT_CONFIRMATION");
    expect(independent).toHaveLength(1);
    expect(independent[0]).toMatchObject({ transition: "COMPLETED", providerExecution: true, evidenceKind: "RENDERED_PAGE", runtimeVersion });
    expect(hasUnresolvedCourseSupportSourceResearch(input)).toBe(true);
  });

  it("treats native identity signal order as a set", () => {
    const { input, browser } = failedCandidateFixture();
    browser.identityAuthority.renderedSignals.reverse();
    expect(hasUnresolvedCourseSupportSourceResearch(input)).toBe(true);
  });

  it.each(["no unique", "candidate"])("preserves completed %s research through a later neutral HTTP observation", (mode) => {
    const input = mode === "candidate" ? failedCandidateFixture(false).input : noUniqueFixture();
    input.course.automationDiscoveries = [{
      status: "INSPECTED", detectedPlatform: "UNKNOWN", apiMetadata: null, confidence: 0.2,
      createdAt: at(-2), evidence: { learnedFrom: "browser-visible-links", bookingCallToAction: true },
    }, ...input.course.automationDiscoveries!];
    expect(hasUnresolvedCourseSupportSourceResearch(input)).toBe(true);
  });

  it.each([-16, -4])("rejects a direct-completion observation outside the actual stage interval (%s)", (seconds) => {
    const { input, browser } = failedCandidateFixture(false);
    browser.observedAt = at(seconds).toISOString();
    input.course.automationDiscoveries![0].createdAt = at(seconds);
    expect(hasUnresolvedCourseSupportSourceResearch(input)).toBe(false);
  });

  it.each(["missing hash", "different hash", "provider execution", "prior cycle", "stale time", "missing rendered source"])(
    "does not infer current no-unique evidence from %s", (change) => {
      const input = noUniqueFixture();
      const ledger = parseAutomationPlaybookLedger(input.incident.attemptLedger)!;
      const event = ledger.events.at(-1)!;
      if (change === "missing hash") event.failureFingerprint = "RETAINED_SOURCE:EXACT_SEARCH:NO_UNIQUE";
      if (change === "different hash") event.failureFingerprint = `RETAINED_SOURCE:EXACT_SEARCH:NO_UNIQUE:${"B".repeat(64)}`;
      if (change === "provider execution") event.providerExecution = true;
      if (change === "prior cycle") input.incident.cycle += 1;
      if (change === "stale time") input.incident.confirmedAt = at(-3);
      if (change === "missing rendered source") input.course.automationDiscoveries = [];
      input.incident.attemptLedger = ledger;
      expect(hasUnresolvedCourseSupportSourceResearch(input)).toBe(false);
    },
  );

  it.each(["HEALTHY", "FINAL_MANUAL", "FINAL_IDENTITY"])("does not override a current %s winner", (state) => {
    const input = noUniqueFixture();
    expect(hasUnresolvedCourseSupportSourceResearch({ ...input, course: { ...input.course, monitoringStatus: { state } } })).toBe(false);
  });

  it.each(["changed source", "changed snapshot", "mismatched runtime", "mismatched start", "newer evidence", "ambiguous timestamp", "trusted page", "contract", "access barrier", "corroboration", "malformed pages", "different authority"])(
    "does not infer unsuccessful candidate research with %s", (change) => {
      const { input, browser, evidence } = failedCandidateFixture();
      if (change === "changed source") input.course.website = "https://replacement-course.example/";
      if (change === "changed snapshot") browser.providerSnapshotFingerprint = "b".repeat(64);
      if (change === "mismatched runtime") browser.runtimeVersion = "b".repeat(40);
      if (change === "mismatched start") {
        const ledger = parseAutomationPlaybookLedger(input.incident.attemptLedger)!;
        ledger.events.at(-2)!.runtimeVersion = "b".repeat(40);
        input.incident.attemptLedger = ledger;
      }
      if (change === "newer evidence") input.course.automationDiscoveries = [{ ...input.course.automationDiscoveries![0], evidence: {}, createdAt: at(-2) }, ...input.course.automationDiscoveries!];
      if (change === "ambiguous timestamp") input.course.automationDiscoveries = [input.course.automationDiscoveries![0], ...input.course.automationDiscoveries!];
      if (change === "trusted page") browser.sameOriginPages[0].trustedForCourse = true;
      if (change === "contract") Object.assign(browser, { networkContracts: [{}] });
      if (change === "access barrier") Object.assign(evidence, { accessBarriers: [{ reason: "ACCOUNT_REQUIRED" }] });
      if (change === "corroboration") Object.assign(evidence, { courseIdentityCorroboration: { verified: true } });
      if (change === "malformed pages") Object.assign(browser, { sameOriginPages: [null] });
      if (change === "different authority") browser.identityAuthority.source = "RETAINED_OFFICIAL_WEBSITE";
      expect(hasUnresolvedCourseSupportSourceResearch(input)).toBe(false);
    },
  );

  it("does not turn an unattempted independent stage into exhausted research", () => {
    expect(hasUnresolvedCourseSupportSourceResearch(retainedSourceRecoveryFixture().input)).toBe(false);
  });
});
