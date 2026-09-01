import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  incidentFindUnique: vi.fn(),
}));

const monitoringMocks = vi.hoisted(() => ({
  recordCourseMonitoringPlaybookTransition: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    courseSupportIncident: {
      findUnique: prismaMocks.incidentFindUnique,
    },
  },
}));
vi.mock("./course-monitoring", () => monitoringMocks);

import {
  buildBrowserPlaybookTransition,
  canResolveAutomaticBrowserTechnicalFinal,
  getBrowserFactualFinality,
  loadCourseMonitoringPlaybookRuntime,
  recordRuntimePlaybookTransition,
} from "./course-monitoring-playbook-runtime";
import {
  appendAutomationPlaybookEvent,
  assessAutomationPlaybook,
  type AutomationPlaybookLedger,
  type AutomationPlaybookStage,
} from "./course-monitoring-playbook";

const runtimeVersion = "a".repeat(40);
const readPathByStage = {
  OFFICIAL_IDENTITY: "OFFICIAL_IDENTITY",
  TYPED_ADAPTER: "TYPED_PROVIDER_ADAPTER",
  OFFICIAL_HTTP_DISCOVERY: "OFFICIAL_HTTP",
  HTTP_ADAPTER_RETRY: "TYPED_PROVIDER_ADAPTER",
  RENDERED_BROWSER_DISCOVERY: "RENDERED_BROWSER",
  BROWSER_ADAPTER_RETRY: "TYPED_PROVIDER_ADAPTER",
  LOCAL_READER: "LOCAL_READER",
  INDEPENDENT_CONFIRMATION: "INDEPENDENT_CONFIRMATION",
} as const;

describe("course monitoring playbook runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.incidentFindUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 1,
      status: "AUTO_INVESTIGATING",
      attemptLedger: null,
    });
  });

  it("enforces the exact eight-stage order while recording bounded proof", async () => {
    let ledger: AutomationPlaybookLedger | null = null;
    monitoringMocks.recordCourseMonitoringPlaybookTransition.mockImplementation(
      async (input) => {
        ledger = appendAutomationPlaybookEvent(ledger, {
          cycle: 1,
          stage: input.stage,
          transition: input.transition,
          readPath: input.readPath,
          evidenceKind: input.evidenceKind,
          failureFingerprint: input.failureFingerprint,
          runtimeVersion: input.runtimeVersion,
          providerExecution: input.providerExecution,
          skipReason: input.skipReason,
          observedAt: input.now ?? new Date("2026-08-10T12:00:00.000Z"),
          note: input.note,
        });
        return {
          replayed: false,
          incidentId: "incident-1",
          incidentRevision: 2,
          ledger,
          assessment: assessAutomationPlaybook(ledger, 1),
        };
      },
    );

    const runtime = await loadCourseMonitoringPlaybookRuntime("course-1");
    expect(runtime?.assessment.nextStage).toBe("OFFICIAL_IDENTITY");
    if (!runtime) throw new Error("Expected a current incident runtime.");

    const stages: AutomationPlaybookStage[] = [
      "OFFICIAL_IDENTITY",
      "TYPED_ADAPTER",
      "OFFICIAL_HTTP_DISCOVERY",
      "HTTP_ADAPTER_RETRY",
      "RENDERED_BROWSER_DISCOVERY",
      "BROWSER_ADAPTER_RETRY",
      "LOCAL_READER",
      "INDEPENDENT_CONFIRMATION",
    ];
    for (const stage of stages) {
      await expect(
        recordRuntimePlaybookTransition(runtime, {
          stage,
          transition: "NOT_APPLICABLE",
          readPath: readPathByStage[stage],
          evidenceKind: "TOOLING",
          runtimeVersion,
          expectedProviderSnapshotFingerprint:
            stage === "RENDERED_BROWSER_DISCOVERY" ? "b".repeat(64) : undefined,
          providerExecution:
            stage === "RENDERED_BROWSER_DISCOVERY" ? false : undefined,
          skipReason:
            stage === "LOCAL_READER"
              ? "NO_LOCAL_READER_CAPABILITY"
              : stage === "INDEPENDENT_CONFIRMATION"
                ? "NO_INDEPENDENT_CONFIRMATION"
                : "MONITORING_MODE_EXCLUDED",
        }),
      ).resolves.toMatchObject({ recorded: true });
    }

    expect(runtime.assessment.conclusion).toBe("UNRESOLVED_EXHAUSTED");
    expect(
      monitoringMocks.recordCourseMonitoringPlaybookTransition.mock.calls.map(
        ([call]) => call.stage,
      ),
    ).toEqual(stages);
    for (const [call] of monitoringMocks
      .recordCourseMonitoringPlaybookTransition.mock.calls) {
      expect(call.failureFingerprint).toMatch(/^PLAYBOOK:[A-Z_]+:[A-Z_]+$/u);
      expect(call.note).not.toMatch(/https?:|course-1|incident-1/u);
    }
    expect(
      monitoringMocks.recordCourseMonitoringPlaybookTransition.mock.calls.find(
        ([call]) => call.stage === "RENDERED_BROWSER_DISCOVERY",
      )?.[0],
    ).toMatchObject({ expectedProviderSnapshotFingerprint: "b".repeat(64) });
    expect(
      monitoringMocks.recordCourseMonitoringPlaybookTransition.mock.calls.find(
        ([call]) => call.stage === "RENDERED_BROWSER_DISCOVERY",
      )?.[0],
    ).toMatchObject({ providerExecution: false });
  });

  it("refuses to invent omitted prior-stage proof", async () => {
    const runtime = await loadCourseMonitoringPlaybookRuntime("course-1");
    if (!runtime) throw new Error("Expected a current incident runtime.");

    await expect(
      recordRuntimePlaybookTransition(runtime, {
        stage: "RENDERED_BROWSER_DISCOVERY",
        transition: "COMPLETED",
        readPath: "RENDERED_BROWSER",
        evidenceKind: "RENDERED_PAGE",
        runtimeVersion,
      }),
    ).resolves.toEqual({ recorded: false, reason: "OUT_OF_ORDER" });
    expect(
      monitoringMocks.recordCourseMonitoringPlaybookTransition,
    ).not.toHaveBeenCalled();
  });

  it("requires an independent browser observation to match the terminal reader reason", () => {
    expect(
      buildBrowserPlaybookTransition({
        stage: "INDEPENDENT_CONFIRMATION",
        technicalReason: "ACCOUNT_REQUIRED",
        localReaderTechnicalReason: "CAPTCHA_OR_QUEUE",
      }),
    ).toEqual({
      transition: "COMPLETED",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: undefined,
      factualDisposition: undefined,
    });
    expect(
      buildBrowserPlaybookTransition({
        stage: "INDEPENDENT_CONFIRMATION",
        technicalReason: "CAPTCHA_OR_QUEUE",
        localReaderTechnicalReason: "CAPTCHA_OR_QUEUE",
      }),
    ).toEqual({
      transition: "TECHNICAL_LIMITATION",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: "CAPTCHA_OR_QUEUE",
      factualDisposition: undefined,
    });
  });

  it("records authoritative rendered facts as factual finals", () => {
    expect(
      buildBrowserPlaybookTransition({
        stage: "RENDERED_BROWSER_DISCOVERY",
        factualDisposition: "MANUAL_DIRECT",
        technicalReason: null,
        localReaderTechnicalReason: null,
      }),
    ).toEqual({
      transition: "FACTUAL_FINAL",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: undefined,
      factualDisposition: "MANUAL_DIRECT",
    });
    expect(
      buildBrowserPlaybookTransition({
        stage: "INDEPENDENT_CONFIRMATION",
        factualDisposition: "IDENTITY_FINAL",
        technicalReason: null,
        localReaderTechnicalReason: null,
      }),
    ).toEqual({
      transition: "FACTUAL_FINAL",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: undefined,
      factualDisposition: "IDENTITY_FINAL",
    });
    expect(getBrowserFactualFinality("IDENTITY_FINAL")).toEqual({
      state: "FINAL_IDENTITY",
      outcome: "IDENTITY_FINAL",
      resolution: "IDENTITY_CLASSIFIED",
    });
    expect(getBrowserFactualFinality("MANUAL_DIRECT")).toEqual({
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
    });
  });

  it("keeps one browser challenge append-only until guarded technical finality", () => {
    expect(
      canResolveAutomaticBrowserTechnicalFinal({
        playbookConclusion: "TECHNICAL_FINAL",
        monitoringState: "REVALIDATING_FINAL",
      }),
    ).toBe(false);
    expect(
      canResolveAutomaticBrowserTechnicalFinal({
        playbookConclusion: "INCOMPLETE",
        monitoringState: "FINAL_TECHNICAL",
      }),
    ).toBe(false);
    expect(
      canResolveAutomaticBrowserTechnicalFinal({
        playbookConclusion: "TECHNICAL_FINAL",
        monitoringState: "FINAL_TECHNICAL",
      }),
    ).toBe(true);
  });
});
