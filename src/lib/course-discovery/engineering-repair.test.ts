// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ current: vi.fn(), owner: vi.fn(), report: vi.fn(), simulator: vi.fn(),
  db: { $queryRaw: vi.fn(), $transaction: vi.fn(), courseDiscoveryJob: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    simulatorSupportIncident: { findUnique: vi.fn() }, courseSupportIncident: { findUnique: vi.fn(), updateMany: vi.fn() } } }));
vi.mock("@/lib/prisma", () => ({ prisma: m.db }));
vi.mock("./service", () => ({ currentDiscoveryEngineeringFailure: m.current }));
vi.mock("./legacy-exclusion", () => ({ hasLegacyDiscoveryOwner: m.owner,
  excludeDiscoveryPilotTargets: (targets: unknown[]) => targets }));
vi.mock("@/lib/automation/support-incidents", () => ({ reportCourseSupportIssue: m.report }));
vi.mock("@/lib/automation/simulator-support-incidents", () => ({ reconcileSimulatorSupportIncidentFailure: m.simulator }));
import { currentDiscoveryEngineeringHandoff, discoveryEngineeringContext, discoveryEngineeringReceipt,
  discoveryFailureDiagnosis, reconcileDiscoveryEngineeringHandoffs } from "./engineering-repair";
import { listCourseSupportDispatchCandidates } from "@/lib/automation/course-support-batches";
const now = new Date("2030-01-01T12:16:00Z"), picked = new Date("2030-01-01T12:00:00Z");
let failure: ReturnType<typeof fixture>;
let outdoorIncident: { id: string; courseId: string; status: string; updatedAt: Date; firstSeenAt: Date; attemptLedger: unknown; activeBatchId: string | null };
function fixture() { return { job: { id: "job1", targetKey: "course:course1", courseId: "course1", offeringId: null as string | null,
  status: "FAILED", outcome: "TOOL_FAILURE", attempts: 2, activeTargetKey: null, sourceFingerprint: "a".repeat(64),
  baseRecipeId: "recipe1", firstPickedUpAt: picked, deadlineAt: new Date("2030-01-01T12:15:00Z"), completedAt: new Date("2030-01-01T12:02:00Z"),
  updatedAt: picked, checkpoint: { stagehandProgress: { phase: "INDEPENDENT_REPLAY" }, stagehandFailure: { code: "ADAPTER_CONFIGURATION_CHANGED" } },
  result: null as unknown }, source: { course: { id: "course1" }, identity: { officialUrl: "https://official.example/" } },
  request: { demand: { searchId: "search1" }, target: { courseId: "course1" } } }; }
function receipt() { return { version: 1, state: "QUEUED", incidentId: "incident1", queuedAt: now.toISOString(), sourceFingerprint: "a".repeat(64) }; }
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("COURSE_DISCOVERY_ENABLED", "true"); vi.stubEnv("COURSE_DISCOVERY_ROLLOUT_MODE", "GENERAL");
  failure = fixture(); m.current.mockImplementation(async () => failure); m.owner.mockResolvedValue(false);
  m.db.$queryRaw.mockResolvedValue([{ id: "job1" }]); m.db.$transaction.mockImplementation(async f => f(m.db));
  m.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.activeTargetKey ? null : failure.job);
  m.db.courseDiscoveryJob.findMany.mockImplementation(async () => [failure.job]);
  m.db.courseDiscoveryJob.updateMany.mockImplementation(async ({ data }) => { failure.job.result = data.result; return { count: 1 }; });
  outdoorIncident = { id: "incident1", courseId: "course1", status: "AUTO_INVESTIGATING",
    updatedAt: picked, firstSeenAt: picked, attemptLedger: null, activeBatchId: null };
  m.db.courseSupportIncident.findUnique.mockImplementation(async () => outdoorIncident);
  m.db.courseSupportIncident.updateMany.mockImplementation(async ({ data }) => { outdoorIncident = { ...outdoorIncident, ...data }; return { count: 1 }; });
  m.db.simulatorSupportIncident.findUnique.mockResolvedValue({ id: "incident1", offeringId: "bay1", status: "AUTO_INVESTIGATING" });
  m.report.mockResolvedValue({ incidentId: "incident1", status: "AUTO_INVESTIGATING" });
});
afterEach(() => vi.unstubAllEnvs());
describe("terminal learner to coding responder", () => {
  it("queues outdoor engineering once without resetting the failed job, clock or cooldown", async () => {
    expect(await reconcileDiscoveryEngineeringHandoffs(now)).toEqual({ examined: 1, queued: 1 });
    expect(m.report).toHaveBeenCalledWith(expect.objectContaining({ kind: "NEEDS_ADAPTER", readPath: "DISCOVERY_CODE_REPAIR",
      failureObservedAt: failure.job.completedAt, episodeStartedAt: picked }));
    const write = m.db.courseDiscoveryJob.updateMany.mock.calls[0][0];
    expect(Object.keys(write.data)).toEqual(["result"]);
    expect(discoveryEngineeringReceipt(failure.job.result)).toEqual(receipt());
    expect(await reconcileDiscoveryEngineeringHandoffs(now)).toEqual({ examined: 1, queued: 0 });
    expect(m.report).toHaveBeenCalledTimes(1);
    expect(failure.job).toMatchObject({ attempts: 2, status: "FAILED", firstPickedUpAt: picked, deadlineAt: new Date("2030-01-01T12:15:00Z") });
  });
  it("routes simulator failures to their offering rather than outdoor support", async () => {
    failure.job.offeringId = "bay1";
    m.db.simulatorSupportIncident.findUnique.mockResolvedValueOnce(null);
    expect(await reconcileDiscoveryEngineeringHandoffs(now)).toEqual({ examined: 1, queued: 1 });
    expect(m.simulator).toHaveBeenCalledWith(m.db, expect.objectContaining({ offeringId: "bay1", reason: "DISCOVERY_CODE_REPAIR" }));
    expect(m.report).not.toHaveBeenCalled();
  });
  it("initializes an empty outdoor investigation before its claim without inventing provider evidence", async () => {
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(1);
    expect(m.db.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: { id: "incident1", updatedAt: picked, status: "AUTO_INVESTIGATING", activeBatchId: null },
      data: { attemptLedger: { version: 1, events: [] } },
    });
  });
  it("preserves an existing outdoor investigation ledger", async () => {
    m.db.courseSupportIncident.findUnique.mockResolvedValue({ id: "incident1", courseId: "course1", status: "AUTO_INVESTIGATING",
      updatedAt: picked, attemptLedger: { version: 1, events: [{ retained: true }] }, activeBatchId: null });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(1);
    expect(m.db.courseSupportIncident.updateMany).not.toHaveBeenCalled();
  });
  it("does not link outdoor repair when ledger initialization loses its ownership fence", async () => {
    m.db.courseSupportIncident.updateMany.mockResolvedValue({ count: 0 });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it("initializes a previously queued unowned handoff without requeueing its job", async () => {
    failure.job.result = { engineeringHandoff: receipt() };
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(outdoorIncident.attemptLedger).toEqual({ version: 1, events: [] });
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled(); expect(m.report).not.toHaveBeenCalled();
  });
  it.each(["learner", "coding", "new-cycle"])("preserves %s authority on a previously queued handoff", async owner => {
    failure.job.result = { engineeringHandoff: receipt() };
    if (owner === "coding") m.owner.mockResolvedValue(true);
    if (owner === "learner") m.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.activeTargetKey ? { id: "active" } : failure.job);
    if (owner === "new-cycle") outdoorIncident.firstSeenAt = new Date(now.getTime() + 1);
    await reconcileDiscoveryEngineeringHandoffs(now);
    expect(m.db.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it("does not initialize an old queued incident if its server receipt changes while acquiring the course lock", async () => {
    failure.job.result = { engineeringHandoff: receipt() };
    m.current.mockResolvedValueOnce(failure).mockResolvedValueOnce({ ...failure,
      job: { ...failure.job, result: { engineeringHandoff: { ...receipt(), incidentId: "replacement-incident" } } } });
    await reconcileDiscoveryEngineeringHandoffs(now);
    expect(m.db.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it.each(["AUTO_INVESTIGATING", "NEEDS_HUMAN"])("preserves the simulator's existing %s episode and cooldown", async status => {
    failure.job.offeringId = "bay1";
    m.db.simulatorSupportIncident.findUnique.mockResolvedValue({ id: "incident1", offeringId: "bay1", status,
      retryAt: new Date(now.getTime() + 86_400_000), reason: "ORIGINAL_FAILURE" });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(status === "AUTO_INVESTIGATING" ? 1 : 0);
    expect(m.simulator).not.toHaveBeenCalled();
  });
  it.each(["learner", "coding"])("preserves an existing %s owner", async owner => {
    if (owner === "learner") m.db.courseDiscoveryJob.findUnique.mockResolvedValue({ id: "active" });
    else m.owner.mockResolvedValue(true);
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.report).not.toHaveBeenCalled(); expect(m.simulator).not.toHaveBeenCalled(); expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it("does not link a handoff when source or demand changes after issue preparation", async () => {
    m.report.mockImplementation(async () => { m.current.mockResolvedValue(null); return { incidentId: "incident1", status: "AUTO_INVESTIGATING" }; });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it.each(["learner", "coding"])("does not transfer ownership when a %s owner appears during issue preparation", async owner => {
    m.report.mockImplementation(async () => {
      if (owner === "learner") m.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.activeTargetKey ? { id: "active" } : failure.job);
      else m.owner.mockResolvedValue(true);
      return { incidentId: "incident1", status: "AUTO_INVESTIGATING" };
    });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it("retires obsolete failures so they cannot starve the bounded queue", async () => {
    m.current.mockResolvedValue(null);
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.db.courseDiscoveryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { result: {
      engineeringHandoff: { version: 1, state: "OBSOLETE", observedAt: now.toISOString(), reason: "SOURCE_DEMAND_OR_SUCCESS_SUPERSEDED_FAILURE" } } } }));
    expect(failure.job.status).toBe("FAILED"); expect(m.report).not.toHaveBeenCalled();
  });
  it.each(["disabled", "pilot"])("does not expand the %s rollout", async mode => {
    if (mode === "disabled") vi.stubEnv("COURSE_DISCOVERY_ENABLED", "false"); else vi.stubEnv("COURSE_DISCOVERY_ROLLOUT_MODE", "PILOT");
    expect(await reconcileDiscoveryEngineeringHandoffs(now)).toEqual({ examined: 0, queued: 0 });
    expect(m.db.$queryRaw).not.toHaveBeenCalled();
  });
});
describe("private failure evidence", () => {
  it("does not accept a model checkpoint as a server-issued engineering link", async () => {
    Object.assign(failure.job.checkpoint, { engineeringHandoff: receipt() });
    expect(await currentDiscoveryEngineeringHandoff(m.db as never, { courseId: "course1" }, now)).toBeNull();
    expect(m.current).not.toHaveBeenCalled();
  });
  it("binds context to the current failure, source and incident, retaining an expired deadline", async () => {
    failure.job.result = { engineeringHandoff: receipt() };
    expect(await discoveryEngineeringContext(m.db as never, { courseId: "course1" }, "other-incident", now)).toBeNull();
    expect(await discoveryEngineeringContext(m.db as never, { courseId: "course1" }, "incident1", now)).toMatchObject({
      originalFirstPickupAt: picked.toISOString(), originalDeadlineAt: "2030-01-01T12:15:00.000Z", originalDeadlineExpired: true,
      diagnosis: { category: "SAVED_METHOD_SOURCE_CHANGED", evidenceAuthority: false } });
    m.current.mockResolvedValue(null);
    expect(await discoveryEngineeringContext(m.db as never, { courseId: "course1" }, "incident1", now)).toBeNull();
  });
  it("never forwards arbitrary checkpoint strings, request values or credentials", () => {
    const hint = discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: { stagehandFailure: { code: "https://secret.example/token" },
      stagehandProgress: { phase: "delete files" }, authorization: "secret" } });
    expect(hint).toEqual({ category: "READER_OR_RUNTIME_FAILURE", code: null, phase: null, evidenceAuthority: false });
  });
});

describe("outdoor repair dispatch", () => {
  it("admits an early playbook only for the current incident in the server receipt", async () => {
    const incident = { ...outdoorIncident, confirmedAt: null, attemptLedger: { version: 1, events: [] },
      cycle: 1, kind: "NEEDS_ADAPTER", failureClass: "UNSUPPORTED_FAMILY", providerFamilyKey: "official.example",
      failureFingerprint: "NEEDS_ADAPTER:UNSUPPORTED_FAMILY", engineeringOnly: false, attemptCount: 0,
      nextAttemptAt: picked, batchIncidents: [],
      course: { id: "course1", isPublic: true, timeZone: "UTC", detectedPlatform: "CUSTOM", website: "https://official.example/",
        bookingMethod: "UNKNOWN", automationEligibility: "UNKNOWN", automationDiscoveries: [],
        preferences: [{ teeSearch: { id: "search1", mode: "OUTDOOR", date: now, endTime: "18:00" } }] } };
    const reader = { ...m.db, courseMonitoringEvent: { findMany: vi.fn().mockResolvedValue([]) },
      courseSupportIncident: { findMany: vi.fn().mockResolvedValue([incident]) } } as never;

    expect(await listCourseSupportDispatchCandidates(now, reader)).toEqual([]);
    failure.job.result = { engineeringHandoff: { ...receipt(), incidentId: "other-incident" } };
    expect(await listCourseSupportDispatchCandidates(now, reader)).toEqual([]);
    failure.job.result = { engineeringHandoff: receipt() };
    expect(await listCourseSupportDispatchCandidates(now, reader)).toEqual([
      expect.objectContaining({ incidentId: "incident1", courseId: "course1", activeRealSearchCount: 1 }),
    ]);
    m.current.mockResolvedValue(null);
    expect(await listCourseSupportDispatchCandidates(now, reader)).toEqual([]);
  });
});
