import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  targets: vi.fn(), finish: vi.fn(), observe: vi.fn(), load: vi.fn(), record: vi.fn(),
  begin: vi.fn(), renew: vi.fn(), retain: vi.fn(), launch: vi.fn(), project: vi.fn(), guard: vi.fn(),
}));
vi.mock("@playwright/test", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("@/lib/automation/runtime-version", () => ({ getAutomationRuntimeVersion: () => "a".repeat(40) }));
vi.mock("@/lib/automation/db-service", () => ({ startAutomationRun: async () => ({ id: "run" }),
  finishAutomationRun: mocks.finish, listBrowserProbeTargets: mocks.targets,
  applyBrowserDiscoveryToCourse: mocks.project, recordAndApplyOwnedBrowserDiscoveryToCourse: mocks.project,
  recordBrowserDiscovery: mocks.project }));
vi.mock("./official-source-jobs", () => ({ getOwnedOfficialSourceObservation: mocks.observe }));
vi.mock("@/lib/automation/course-monitoring-playbook-runtime", async original => ({
  ...await original<typeof import("@/lib/automation/course-monitoring-playbook-runtime")>(),
  loadCourseMonitoringPlaybookRuntime: mocks.load, recordRuntimePlaybookTransition: mocks.record,
}));
vi.mock("@/lib/automation/provider-execution-marker", async original => ({
  ...await original<typeof import("@/lib/automation/provider-execution-marker")>(),
  beginCourseProviderObservation: mocks.begin, renewCourseProviderObservationInTransaction: mocks.renew,
  markCourseProviderObservationUnreconciled: mocks.retain,
  startCourseProviderObservationHeartbeat: () => ({ stop: async () => undefined, assertOwned: () => undefined }),
}));
vi.mock("@/lib/automation/course-support-browser-stages", async original => ({
  ...await original<typeof import("@/lib/automation/course-support-browser-stages")>(),
  runGuardedCourseSupportBrowserMutation: mocks.guard,
}));
import { runBrowserProbe, type BrowserProbeOptions } from "../../../scripts/automation/browser-probe-needed-adapters";

const fingerprint = "b".repeat(64);
const course = { id: "knolls", name: "Knolls Golf Course", website: "https://parks.cityofomaha.org/golf",
  address: "11630 Sahler St, Omaha, NE", city: "Omaha", stateCode: "NE", timeZone: "America/Chicago",
  providerSnapshotFingerprint: fingerprint };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.targets.mockResolvedValue([{ course, probeUrl: course.website }]);
  mocks.observe.mockResolvedValue({ status: "READY", result: { pages: [{ status: "ACCESS_RESTRICTED" }] } });
  mocks.begin.mockResolvedValue({ courseId: course.id, leaseToken: "observation", observationStartedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 120_000), ttlMs: 120_000 });
  mocks.renew.mockResolvedValue(true); mocks.retain.mockResolvedValue(true);
  mocks.guard.mockImplementation(async input => input.mutate());
  mocks.record.mockImplementation(async (_runtime, input) => { await input.onBeforeSourceWrite({}); return { recorded: true }; });
});

describe("owned verifier consumes signed restrictions", () => {
  it.each(["RENDERED_BROWSER_DISCOVERY", "INDEPENDENT_CONFIRMATION"] as const)("records %s without another browser or course projection", async stage => {
    mocks.load.mockResolvedValue({ assessment: { nextStage: stage }, localReaderTechnicalReason: null });
    const fence = { courseId: course.id, batchId: "batch", ownerThreadId: "owner", incidentId: "incident", cycle: 3,
      leaseToken: "lease", releaseSha: "a".repeat(40), runtimeVersion: "a".repeat(40), deployedAt: new Date(0), stage };
    const result = await runBrowserProbe({ dryRun: false, courseId: course.id, limit: 1, persistenceFence: fence,
      deferTerminalCloseout: true, persistSearchProbe: false } as BrowserProbeOptions);
    expect(result).toEqual({ targetCount: 1, persistedCount: 1 });
    expect(mocks.launch).not.toHaveBeenCalled(); expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stage,
      expectedProviderSnapshotFingerprint: fingerprint, providerExecution: true,
      // Independent confirmation still requires the existing corroboration rule.
      transition: stage === "RENDERED_BROWSER_DISCOVERY" ? "TECHNICAL_LIMITATION" : "COMPLETED",
    }), fence);
    expect(mocks.renew).toHaveBeenCalledOnce(); expect(mocks.retain).toHaveBeenCalledOnce();
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ requireCurrentStage: true, courseId: course.id }));
  });
  it("fails closed if source ownership expired before consumption", async () => {
    mocks.load.mockResolvedValue({ assessment: { nextStage: "RENDERED_BROWSER_DISCOVERY" } });
    mocks.observe.mockRejectedValue(new Error("Source owner expired"));
    await expect(runBrowserProbe({ dryRun: false, limit: 1, persistenceFence: { runtimeVersion: "a".repeat(40),
      stage: "RENDERED_BROWSER_DISCOVERY" }, deferTerminalCloseout: true, persistSearchProbe: false } as BrowserProbeOptions))
      .rejects.toThrow("Source owner expired");
    expect(mocks.launch).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
});
