import { describe, expect, it, vi } from "vitest";
const persistence = vi.hoisted(() => ({ transaction: vi.fn(), lock: vi.fn(), findIncident: vi.fn(), updateIncident: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  $transaction: persistence.transaction, courseMonitoringStatus: {}, courseMonitoringEvent: {},
} }));
import { assessAutomationPlaybook, parseAutomationPlaybookLedger } from "./course-monitoring-playbook";
import { recordRuntimePlaybookTransition, type CourseMonitoringPlaybookRuntime } from "./course-monitoring-playbook-runtime";
import { getCourseSupportRetainedSourceRecovery } from "./course-support-retained-source-recovery";
import { retainedSourceRecoveryFixture as fixture, retainedSourceRecoveryRuntimeVersion as runtimeVersion, retainedSourceRecoveryAt as at } from "./course-support-retained-source-recovery.test-fixtures";

describe("retained source identity research admission", () => {
  it("admits the real runtime wrapper and transactional ledger writer's completed rendered proof", async () => {
    const { input } = fixture();
    const intended = parseAutomationPlaybookLedger(input.incident.attemptLedger)!;
    const incident = { ...input.incident, id: "fixture-incident", revision: 1, status: "AUTO_INVESTIGATING", attemptLedger: null as unknown };
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
      cycle: incident.cycle, assessment: assessAutomationPlaybook(null, incident.cycle), localReaderTechnicalReason: null };
    for (const event of intended.events) {
      expect(await recordRuntimePlaybookTransition(runtime, { ...event, now: new Date(event.observedAt) })).toMatchObject({ recorded: true });
    }
    input.incident.attemptLedger = incident.attemptLedger;
    const persisted = parseAutomationPlaybookLedger(incident.attemptLedger)!;
    const rendered = persisted.events.find((event) => event.stage === "RENDERED_BROWSER_DISCOVERY")!;
    expect(persisted.events.some((event) => event.transition === "STARTED")).toBe(false);
    expect(rendered).toMatchObject({ stage: "RENDERED_BROWSER_DISCOVERY", transition: "COMPLETED", evidenceKind: "RENDERED_PAGE",
      providerExecution: true, failureFingerprint: "PLAYBOOK:RENDERED_BROWSER_DISCOVERY:COMPLETED", runtimeVersion });
    expect(persistence.event).toHaveBeenCalledTimes(7);
    expect(getCourseSupportRetainedSourceRecovery(input)).not.toBeNull();
  });

  it("also accepts explicit rendered STARTED proof without requiring it from the native direct-completion runner", () => {
    const { input, browser } = fixture({ renderedStarted: true });
    expect(getCourseSupportRetainedSourceRecovery(input)).not.toBeNull();
    browser.observedAt = at(-36).toISOString();
    input.course.automationDiscoveries![0].createdAt = at(-36);
    expect(getCourseSupportRetainedSourceRecovery(input)).toBeNull();
  });

  it("retains rejection through a newer weak HTTP observation and canonicalizes signal order", () => {
    const { input, browser } = fixture();
    const expected = getCourseSupportRetainedSourceRecovery(input);
    input.course.automationDiscoveries = [{ ...input.course.automationDiscoveries![0], createdAt: at(-10),
      evidence: { learnedFrom: "browser-visible-links", bookingCallToAction: true } }, ...input.course.automationDiscoveries!];
    browser.identityAuthority.renderedSignals.reverse();
    expect(getCourseSupportRetainedSourceRecovery(input)).toEqual(expected);
  });

  it.each(["HEALTHY", "FINAL_MANUAL", "FINAL_IDENTITY", "FINAL_TECHNICAL"])("preserves current %s evidence", (state) => {
    const { input } = fixture();
    input.course.monitoringStatus = { state };
    expect(getCourseSupportRetainedSourceRecovery(input)).toBeNull();
  });

  it("uses the native rejected-page producer, retains an unconfirmed CTA and produces claim-independent proof", () => {
    const { input, browser, evidence } = fixture();
    expect(browser.sameOriginPages.every((page) => page.identityStatus === "CONFLICT" && !page.trustedForCourse)).toBe(true);
    expect(evidence.bookingCallToAction).toBe(true);
    const before = structuredClone(input);
    const recovery = getCourseSupportRetainedSourceRecovery(input);
    expect(recovery).toEqual({ mode: "RETAINED_SOURCE_IDENTITY_RESEARCH", rejectionEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      providerSnapshotFingerprint: browser.providerSnapshotFingerprint, renderedObservedAt: at(-30).toISOString(), runtimeVersion });
    expect(getCourseSupportRetainedSourceRecovery({ ...input, now: at(60) })).toEqual(recovery);
    expect(input).toEqual(before);
  });

  it.each([undefined, false, true])("does not use restrictedNetworkObserved=%s as source research authority", (restrictedNetworkObserved) => {
    const { input, browser } = fixture();
    Object.assign(browser, { restrictedNetworkObserved });
    expect(getCourseSupportRetainedSourceRecovery(input)).not.toBeNull();
  });

  it.each([
    "legacy course", "source missing", "private course", "local reader only", "contact only", "phone only", "account", "challenge", "runnable",
    "no ledger", "old cycle", "missing confirmation", "stale prefix", "future prefix", "rendered zero execution", "rendered unavailable execution",
    "missing discoveries", "missing browser", "wrong cycle", "wrong snapshot", "unknown runtime", "wrong runtime", "stale observation", "future observation",
    "outside attempt", "detached creation time", "trusted page", "unknown identity", "empty pages", "blocked page", "missing page trust",
    "booking destination", "network contract", "access barrier", "rendered control", "factual corroboration", "factual reason", "high confidence",
    "malformed access evidence", "missing contracts", "unprojected source", "missing locality", "retained source drift", "newer trusted observation", "ambiguous latest observation",
  ])("fails closed for %s", (scenario) => {
    const { input, browser, evidence } = fixture();
    const rows = input.course.automationDiscoveries!;
    const row = rows[0];
    const ledger = input.incident.attemptLedger as { events: Array<Record<string, unknown>> };
    switch (scenario) {
      case "legacy course": delete input.course.bookingMethod; break;
      case "source missing": input.course.website = null; input.course.detectedBookingUrl = null; break;
      case "private course": input.course.isPublic = false; break;
      case "local reader only": input.course.monitoringMode = "LOCAL_READER_ONLY"; break;
      case "contact only": input.course.monitoringMode = "CONTACT_ONLY"; break;
      case "phone only": input.course.bookingMethod = "PHONE_ONLY"; break;
      case "account": input.course.bookingAccessMode = "ACCOUNT_REQUIRED"; break;
      case "challenge": input.course.automationReason = "CAPTCHA_OR_QUEUE"; break;
      case "runnable": Object.assign(input.course, { detectedPlatform: "FOREUP", providerFamilyKey: "FOREUP", detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/12345", bookingMetadata: { scheduleId: 12345 } }); break;
      case "no ledger": input.incident.attemptLedger = null; break;
      case "old cycle": input.incident.cycle = 3; break;
      case "missing confirmation": input.incident.confirmedAt = null; break;
      case "stale prefix": input.incident.confirmedAt = at(-40); break;
      case "future prefix": ledger.events.at(-1)!.observedAt = at(1).toISOString(); break;
      case "rendered zero execution": ledger.events.find((event) => event.stage === "RENDERED_BROWSER_DISCOVERY")!.providerExecution = false; break;
      case "rendered unavailable execution": delete ledger.events.find((event) => event.stage === "RENDERED_BROWSER_DISCOVERY")!.providerExecution; break;
      case "missing discoveries": input.course.automationDiscoveries = []; break;
      case "missing browser": Object.assign(evidence, { browserInvestigation: undefined }); break;
      case "wrong cycle": browser.incidentCycle = 3; break;
      case "wrong snapshot": browser.providerSnapshotFingerprint = "b".repeat(64); break;
      case "unknown runtime": browser.runtimeVersion = "UNKNOWN"; break;
      case "wrong runtime": browser.runtimeVersion = "b".repeat(40); break;
      case "stale observation": browser.observedAt = at(-61).toISOString(); row.createdAt = at(-61); break;
      case "future observation": browser.observedAt = at(1).toISOString(); row.createdAt = at(1); break;
      case "outside attempt": browser.observedAt = at(-41).toISOString(); row.createdAt = at(-41); break;
      case "detached creation time": row.createdAt = at(-20); break;
      case "trusted page": browser.sameOriginPages[0].trustedForCourse = true; break;
      case "unknown identity": browser.sameOriginPages[0].identityStatus = "UNKNOWN"; break;
      case "empty pages": browser.sameOriginPages = []; break;
      case "blocked page": browser.sameOriginPages[0].interactionBlocked = true; break;
      case "missing page trust": Object.assign(browser.sameOriginPages[0], { trustedForCourse: undefined }); break;
      case "booking destination": Object.assign(browser, { bookingDestinations: [{ courseScoped: true }] }); break;
      case "network contract": Object.assign(browser, { networkContracts: [{ method: "GET" }] }); break;
      case "access barrier": Object.assign(evidence, { accessBarriers: [{ status: 403 }] }); break;
      case "rendered control": Object.assign(evidence, { renderedAccessControls: [{ kind: "MANAGED_PROTECTION_DOCUMENT" }] }); break;
      case "factual corroboration": Object.assign(evidence, { courseIdentityCorroboration: { kind: "OFFICIAL_COURSE_PROVIDER_LINK" } }); break;
      case "factual reason": row.automationReason = "NO_ONLINE_BOOKING"; break;
      case "high confidence": row.confidence = 0.95; break;
      case "malformed access evidence": Object.assign(evidence, { accessBarriers: null }); break;
      case "missing contracts": Object.assign(browser, { networkContracts: undefined }); break;
      case "unprojected source": browser.identityAuthority.source = "UNPROJECTED_OWNER_SOURCE_CANDIDATE"; break;
      case "missing locality": browser.identityAuthority.localityEvidencePresent = false; break;
      case "retained source drift": browser.retainedInputs.sourceUrl = "https://other-course.example/"; break;
      case "newer trusted observation": input.course.automationDiscoveries = [{ ...row, createdAt: at(-10), evidence: { learnedFrom: "official-source" } }, row]; break;
      case "ambiguous latest observation": input.course.automationDiscoveries = [row, structuredClone(row)]; break;
    }
    expect(getCourseSupportRetainedSourceRecovery(input)).toBeNull();
  });

  it.each(["STARTED", "COMPLETED"] as const)("never admits independent confirmation after %s", (transition) => {
    const { input, append, getLedger } = fixture();
    append({ stage: "INDEPENDENT_CONFIRMATION", transition, readPath: "INDEPENDENT_CONFIRMATION", evidenceKind: "RENDERED_PAGE", observedAt: at(-10), providerExecution: transition === "COMPLETED" });
    input.incident.attemptLedger = getLedger();
    expect(getCourseSupportRetainedSourceRecovery(input)).toBeNull();
  });
});
