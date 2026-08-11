import { beforeEach, describe, expect, it, vi } from "vitest";

const monitoringMocks = vi.hoisted(() => ({
  recordCourseMonitoringPlaybookTransition: vi.fn()
}));
const dbMocks = vi.hoisted(() => ({
  getCourseMonitoringPlaybookContext: vi.fn()
}));

vi.mock("./course-monitoring", () => monitoringMocks);
vi.mock("./db-service", () => dbMocks);

import {
  appendAutomationPlaybookEvent,
  assessAutomationPlaybook,
  type AutomationPlaybookLedger
} from "./course-monitoring-playbook";
import {
  SEARCH_PLAYBOOK_FINGERPRINTS,
  buildSearchPlaybookIdempotencyKey,
  ensureSearchPlaybookOfficialIdentity,
  loadSearchPlaybookRuntime,
  normalizeSearchPlaybookRuntimeVersion,
  recordSearchPlaybookAttempt,
  recordSearchPlaybookAttemptResult,
  recordSearchPlaybookTransition
} from "./search-playbook-runtime";

describe("search playbook runtime", () => {
  let ledger: AutomationPlaybookLedger | null;

  beforeEach(() => {
    vi.clearAllMocks();
    ledger = null;
    monitoringMocks.recordCourseMonitoringPlaybookTransition.mockImplementation(
      async (input) => {
        ledger = appendAutomationPlaybookEvent(ledger, {
          cycle: 3,
          stage: input.stage,
          transition: input.transition,
          readPath: input.readPath,
          evidenceKind: input.evidenceKind,
          failureFingerprint: input.failureFingerprint,
          runtimeVersion: input.runtimeVersion,
          failureClass: input.failureClass,
          skipReason: input.skipReason,
          factualDisposition: input.factualDisposition,
          technicalReason: input.technicalReason,
          note: input.note,
          observedAt: new Date("2026-08-10T14:00:00.000Z")
        });
        return {
          replayed: false,
          incidentId: "incident-1",
          incidentRevision: ledger.events.length,
          ledger,
          assessment: assessAutomationPlaybook(ledger, 3)
        };
      }
    );
  });

  it("uses cycle-safe deterministic idempotency keys and safe runtime labels", () => {
    const input = {
      incidentId: "incident-1",
      cycle: 3,
      stage: "LOCAL_READER" as const,
      transition: "STARTED" as const,
      attemptOrdinal: 1
    };
    expect(buildSearchPlaybookIdempotencyKey(input)).toBe(
      buildSearchPlaybookIdempotencyKey(input)
    );
    expect(
      buildSearchPlaybookIdempotencyKey({ ...input, cycle: 4 })
    ).not.toBe(buildSearchPlaybookIdempotencyKey(input));
    expect(normalizeSearchPlaybookRuntimeVersion(" deploy sha/@bad ")).toBe(
      "deploy-sha-bad"
    );
  });

  it("records the current identity and closes the current cycle on typed success", async () => {
    let runtime = await loadSearchPlaybookRuntime({
      courseId: "course-1",
      runtimeVersion: "release-123",
      context: {
        id: "incident-1",
        cycle: 3,
        status: "AUTO_INVESTIGATING",
        attemptLedger: null
      }
    });
    expect(runtime).not.toBeNull();
    runtime = await ensureSearchPlaybookOfficialIdentity(runtime!);
    runtime = await recordSearchPlaybookAttempt(runtime, {
      stage: "TYPED_ADAPTER",
      transition: "SUCCEEDED",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureFingerprint:
        SEARCH_PLAYBOOK_FINGERPRINTS.TYPED_ADAPTER_ATTEMPT,
      note: "Typed check succeeded."
    });

    expect(runtime.assessment).toMatchObject({
      cycle: 3,
      conclusion: "MONITORING_RESTORED",
      nextStage: null
    });
    expect(ledger?.events.map((event) => [event.stage, event.transition])).toEqual(
      [
        ["OFFICIAL_IDENTITY", "STARTED"],
        ["OFFICIAL_IDENTITY", "COMPLETED"],
        ["TYPED_ADAPTER", "STARTED"],
        ["TYPED_ADAPTER", "SUCCEEDED"]
      ]
    );
  });

  it("reuses one active local-reader attempt and makes a terminal result non-pending", async () => {
    const completedBeforeReader = [
      ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY", "OFFICIAL_SOURCE"],
      ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER", "TOOLING"],
      ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP", "TOOLING"],
      ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "TOOLING"],
      ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER", "TOOLING"],
      ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "TOOLING"]
    ] as const;
    for (const [stage, readPath, evidenceKind] of completedBeforeReader) {
      ledger = appendAutomationPlaybookEvent(ledger, {
        cycle: 3,
        stage,
        transition: "NOT_APPLICABLE",
        readPath,
        evidenceKind,
        failureFingerprint: "PLAYBOOK_STAGE:NOT_APPLICABLE",
        runtimeVersion: "release-123",
        skipReason: "MONITORING_MODE_EXCLUDED",
        observedAt: new Date("2026-08-10T14:00:00.000Z")
      });
    }
    let runtime = await loadSearchPlaybookRuntime({
      courseId: "course-1",
      context: {
        id: "incident-1",
        cycle: 3,
        status: "AUTO_INVESTIGATING",
        attemptLedger: ledger
      }
    });
    runtime = await recordSearchPlaybookTransition(runtime!, {
      stage: "LOCAL_READER",
      transition: "STARTED",
      readPath: "LOCAL_READER",
      evidenceKind: "LOCAL_READER_RESULT",
      failureFingerprint:
        SEARCH_PLAYBOOK_FINGERPRINTS.LOCAL_READER_ATTEMPT
    });
    runtime = await recordSearchPlaybookAttemptResult(runtime, {
      stage: "LOCAL_READER",
      transition: "TECHNICAL_LIMITATION",
      readPath: "LOCAL_READER",
      evidenceKind: "LOCAL_READER_RESULT",
      failureFingerprint:
        SEARCH_PLAYBOOK_FINGERPRINTS.LOCAL_READER_CHALLENGE,
      technicalReason: "CAPTCHA_OR_QUEUE"
    });

    const readerEvents = ledger?.events.filter(
      (event) => event.stage === "LOCAL_READER"
    );
    expect(readerEvents?.map((event) => event.transition)).toEqual([
      "STARTED",
      "TECHNICAL_LIMITATION"
    ]);
    expect(runtime.assessment).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "INDEPENDENT_CONFIRMATION"
    });
  });
});
