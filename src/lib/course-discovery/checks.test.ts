import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveAutomationSearch } from "@/lib/automation/db-service";
import { getLearnedAvailability, queueFailedOutdoorDiscovery, queueFailedSimulatorDiscovery } from "./checks";
import { SimulatorAvailabilityError } from "@/lib/simulators/providers/types";

const mocked = vi.hoisted(() => ({ pilot: vi.fn(), activeRecipe: vi.fn(), activeJob: vi.fn(), ensure: vi.fn(), refresh: vi.fn(),
  runnable: vi.fn(), readerKey: vi.fn(), execution: vi.fn(), success: vi.fn(), needsRepair: vi.fn(), degrade: vi.fn() }));
vi.mock("./config", () => ({ isDiscoveryPilotSearch: mocked.pilot }));
vi.mock("./service", () => ({ getActiveAccessRecipe: mocked.activeRecipe, ensureDiscoveryJob: mocked.ensure, degradeRecipe: mocked.degrade }));
vi.mock("./sources", () => ({ refreshMissingDiscoverySource: mocked.refresh }));
vi.mock("@/lib/prisma", () => ({ prisma: { courseDiscoveryJob: { findUnique: mocked.activeJob } } }));
vi.mock("@/lib/automation/provider-capabilities", () => ({ resolveProviderCapability: mocked.runnable }));
vi.mock("@/lib/local-reader/service", () => ({ getLocalReaderCourseKey: mocked.readerKey }));
vi.mock("./runtime", () => ({ getOrQueueRecipeExecution: mocked.execution, recipeResultIsSuccessful: mocked.success, recipeExecutionNeedsRepair: mocked.needsRepair, assertRecipeObservationCurrent: vi.fn() }));
vi.mock("@/lib/automation/db-service", () => ({ commitCurrentCourseTeeTimeMatches: vi.fn(), recordCourseProbe: vi.fn() }));
vi.mock("@/lib/automation/course-monitoring", () => ({ recordCourseMonitoringSuccess: vi.fn() }));
vi.mock("@/lib/automation/runtime-version", () => ({ getAutomationRuntimeVersion: () => "test" }));

const search = { id: "search-1", mode: "OUTDOOR", preferences: [{ courseId: "course-1", offeringId: null,
  course: { id: "course-1", isPublic: true, detectedBookingUrl: "https://example.org/times", website: "https://example.org" } }] } as unknown as ActiveAutomationSearch;
const simulator = { ...search, mode: "SIMULATOR", durationMinutes: 60, preferences: [{ ...search.preferences[0], offeringId: "offering-1",
  offering: { id: "offering-1", kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC", bookingUrl: "https://example.as.me/schedule/owner123",
    verifiedAt: new Date(), evidenceUrl: "https://example.org/", supportedDurationsMinutes: [60], providerFamilyKey: "ACUITY" } }] } as unknown as ActiveAutomationSearch;

beforeEach(() => {
  vi.clearAllMocks(); mocked.pilot.mockResolvedValue(true); mocked.activeRecipe.mockResolvedValue(null);
  mocked.activeJob.mockResolvedValue(null); mocked.ensure.mockResolvedValue({ id: "job-1", status: "QUEUED" });
  mocked.refresh.mockResolvedValue(undefined); mocked.runnable.mockReturnValue({ isRunnable: true }); mocked.readerKey.mockReturnValue(null);
});
describe("failed established public-method learning", () => {
  it("retains the same method for a fresh success after its bounded repair fails", async () => {
    const demand = { ...simulator, date: new Date("2030-01-02T00:00:00Z"), players: 2, startTime: "10:00", endTime: "20:00" };
    mocked.activeRecipe.mockResolvedValue({ record: { id: "recipe-1", hash: "same-hash" } });
    const failure = { state: "ready", jobId: "execution-1", recipeId: "recipe-1", result: { status: "INCOMPLETE", complete: false,
      slots: [], evidence: { reason: "INVALID_SOURCE", recipeHash: "same-hash" } } };
    mocked.execution.mockResolvedValue(failure); mocked.success.mockReturnValue(false); mocked.needsRepair.mockReturnValue(true);
    expect(await getLearnedAvailability(demand, demand.preferences[0])).toMatchObject({ state: "pending" });
    expect(mocked.ensure).toHaveBeenCalledWith({ courseId: "course-1", offeringId: "offering-1", kind: "SIMULATOR", searchId: "search-1", failedRecipeId: "recipe-1" });
    mocked.ensure.mockResolvedValue({ id: "job-1", status: "FAILED", attempts: 2, outcome: "TOOL_FAILURE" });
    expect(await getLearnedAvailability(demand, demand.preferences[0])).toMatchObject({ state: "failed", outcome: "TOOL_FAILURE" });
    const fresh = { ...failure, jobId: "execution-2", result: { status: "AVAILABLE", complete: true, slots: [{}], evidence: { recipeHash: "same-hash" } } };
    mocked.execution.mockResolvedValue(fresh); mocked.success.mockReturnValue(true);
    expect(await getLearnedAvailability(demand, demand.preferences[0])).toMatchObject({ ...fresh, target: { offeringId: "offering-1" } });
    expect(mocked.ensure).toHaveBeenCalledTimes(2);
    expect(mocked.degrade).not.toHaveBeenCalled();
  });
  it("leaves a supported method on its established path before any actual failure", async () => {
    expect(await getLearnedAvailability(search, search.preferences[0])).toBeNull();
    expect(mocked.ensure).not.toHaveBeenCalled();
  });
  it("admits the concrete failed method then joins its bounded pending job", async () => {
    expect(await queueFailedOutdoorDiscovery(search, search.preferences[0], "FETCH_FAILED")).toBe(true);
    expect(mocked.ensure).toHaveBeenCalledWith({ courseId: "course-1", searchId: "search-1" });
    mocked.activeJob.mockResolvedValue({ id: "job-1" });
    mocked.ensure.mockResolvedValue({ id: "job-1", status: "RUNNING" });
    expect(await getLearnedAvailability(search, search.preferences[0])).toMatchObject({ state: "pending" });
  });
  it("joins a failed local-reader method only after a discovery job was admitted", async () => {
    mocked.runnable.mockReturnValue({ isRunnable: false }); mocked.readerKey.mockReturnValue("known-reader-key");
    expect(await getLearnedAvailability(search, search.preferences[0])).toBeNull();
    mocked.activeJob.mockResolvedValue({ id: "job-1" });
    expect(await getLearnedAvailability(search, search.preferences[0])).toMatchObject({ state: "pending" });
  });
  it("does not reopen exhausted jobs or enroll a non-pilot", async () => {
    mocked.ensure.mockResolvedValue({ id: "job-1", status: "FAILED" });
    expect(await queueFailedOutdoorDiscovery(search, search.preferences[0], "FETCH_FAILED")).toBe(false);
    mocked.pilot.mockResolvedValue(false); mocked.ensure.mockClear();
    expect(await queueFailedOutdoorDiscovery(search, search.preferences[0], "FETCH_FAILED")).toBe(false);
    expect(mocked.ensure).not.toHaveBeenCalled();
  });
  it.each(["NO_MATCH", "MATCH_FOUND", "CHECK_PENDING"] as const)("does not admit discovery for an established %s result", async outcome => {
    expect(await queueFailedOutdoorDiscovery(search, search.preferences[0], outcome)).toBe(false);
    expect(mocked.ensure).not.toHaveBeenCalled();
  });
  it("keeps an established simulator on its normal adapter until a failure", async () => {
    expect(await getLearnedAvailability(simulator, simulator.preferences[0])).toBeNull();
    expect(mocked.activeJob).toHaveBeenCalledWith({ where: { activeTargetKey: "offering:offering-1" }, select: { id: true } });
    expect(mocked.ensure).not.toHaveBeenCalled();
  });
  it("joins a simulator's admitted job instead of racing its prior adapter", async () => {
    mocked.activeJob.mockResolvedValue({ id: "job-1" });
    expect(await getLearnedAvailability(simulator, simulator.preferences[0])).toMatchObject({ state: "pending" });
    expect(mocked.ensure).toHaveBeenCalledWith({ courseId: "course-1", offeringId: "offering-1", kind: "SIMULATOR", searchId: "search-1" });
  });
  it.each([{ publicAccessStatus: "UNVERIFIED" }, { verifiedAt: null }, { evidenceUrl: null }, { providerFamilyKey: null }, { supportedDurationsMinutes: [] }])(
    "admits a fresh simulator without a complete established method", async change => {
      const preference = { ...simulator.preferences[0], offering: { ...simulator.preferences[0].offering!, ...change } } as typeof simulator.preferences[number];
      expect(await getLearnedAvailability(simulator, preference)).toMatchObject({ state: "pending" });
      expect(mocked.ensure).toHaveBeenCalled();
    });
  it("admits a genuine failed simulator read with its exact offering", async () => {
    expect(await queueFailedSimulatorDiscovery(simulator, simulator.preferences[0], "FETCH_FAILED", new Error("schema mismatch"))).toBe(true);
    expect(mocked.ensure).toHaveBeenCalledWith({ courseId: "course-1", offeringId: "offering-1", searchId: "search-1" });
  });
  it.each([null, new SimulatorAvailabilityError("HTTP_ERROR", "throttled", true, 429)])("does not invoke discovery for contention or throttling", async failure => {
    expect(await queueFailedSimulatorDiscovery(simulator, simulator.preferences[0], "FETCH_FAILED", failure)).toBe(false);
    expect(mocked.ensure).not.toHaveBeenCalled();
  });
  it("preserves terminal and non-pilot simulator ownership", async () => {
    mocked.ensure.mockResolvedValue({ status: "FAILED" });
    expect(await queueFailedSimulatorDiscovery(simulator, simulator.preferences[0], "FETCH_FAILED", new Error("failed"))).toBe(false);
    mocked.pilot.mockResolvedValue(false); mocked.ensure.mockClear();
    expect(await queueFailedSimulatorDiscovery(simulator, simulator.preferences[0], "FETCH_FAILED", new Error("failed"))).toBe(false);
    expect(mocked.ensure).not.toHaveBeenCalled();
  });
});
