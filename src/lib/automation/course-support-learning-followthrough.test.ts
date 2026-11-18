import { describe, expect, it, vi } from "vitest";
import { projectOwnedFailedLearningProgress, readOwnedFailedLearningProgress } from "./course-support-learning-followthrough";

function fixture() {
  const link = { version: 1, kind: "LATE_ENGINEERING_RECOVERY", originalJobId: "original", jobId: "child",
    batchId: "batch", incidentId: "incident", ownerThreadId: "owner", cycle: 1, sourceFingerprint: "a".repeat(64),
    releaseSha: "b".repeat(40), runtimeVersion: "c".repeat(40), requestedAt: "2030-01-01T01:00:00.000Z",
    originalFirstPickedUpAt: "2030-01-01T00:00:00.000Z", originalDeadlineAt: "2030-01-01T00:15:00.000Z" };
  const request = { target: { kind: "OUTDOOR", courseId: "course" }, demand: { searchId: "search", alertGeneration: 2 } };
  const child: Parameters<typeof projectOwnedFailedLearningProgress>[0] = { id: "child", courseId: "course", offeringId: null,
    targetKey: "course:course", baseRecipeId: null, sourceFingerprint: link.sourceFingerprint, status: "FAILED", outcome: "TOOL_FAILURE",
    attempts: 2, firstPickedUpAt: new Date(link.requestedAt), deadlineAt: new Date("2030-01-01T01:15:00.000Z"),
    completedAt: new Date("2030-01-01T01:02:00.000Z"), request,
    result: { learningRecoveryOf: link, executionRuntimeVersion: link.runtimeVersion } };
  const parent = { ...child, id: "original", firstPickedUpAt: new Date(link.originalFirstPickedUpAt),
    deadlineAt: new Date(link.originalDeadlineAt), completedAt: new Date(link.originalDeadlineAt), result: { learningRecoveries: [link] } };
  const expected = { batchId: "batch", batchReference: "batch-reference", ownerThreadId: "owner", releaseSha: link.releaseSha,
    deployedAt: new Date("2030-01-01T00:59:00.000Z"), courseId: "course", incidentId: "incident", cycle: 1,
    sourceFingerprint: link.sourceFingerprint, searchRefs: [{ id: "search", alertGeneration: 2 }], now: new Date("2030-01-01T01:03:00.000Z") };
  return { child, parent, expected, link };
}

describe("source-bound terminal learning progress", () => {
  it("projects a stable bounded diagnostic key without changing jobs, attempt budgets or failed clocks", () => {
    const f = fixture(), before = structuredClone(f);
    const result = projectOwnedFailedLearningProgress(f.child, f.parent, f.expected);
    expect(result).toEqual({ version: 1, jobId: "child", completedAt: f.child.completedAt!.toISOString(), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(projectOwnedFailedLearningProgress(f.child, f.parent, f.expected)).toEqual(result);
    expect(f).toEqual(before);
  });
  it.each(["owner", "release", "incident", "cycle", "source", "demand", "generation", "invalid-clock", "not-deployed"])("rejects changed %s authority", scenario => {
    const f = fixture();
    if (scenario === "owner") f.expected.ownerThreadId = "other";
    if (scenario === "release") f.expected.releaseSha = "d".repeat(40);
    if (scenario === "incident") f.expected.incidentId = "other";
    if (scenario === "cycle") f.expected.cycle++;
    if (scenario === "source") f.expected.sourceFingerprint = "d".repeat(64);
    if (scenario === "demand") f.expected.searchRefs = [];
    if (scenario === "generation") f.expected.searchRefs[0].alertGeneration++;
    if (scenario === "invalid-clock") f.expected.now = new Date(NaN);
    if (scenario === "not-deployed") f.expected.deployedAt = new Date("2030-01-01T01:01:00.000Z");
    expect(projectOwnedFailedLearningProgress(f.child, f.parent, f.expected)).toBeNull();
  });
  it.each(["running", "success", "budget", "deadline", "future", "parent-clock", "missing-reciprocal", "runtime", "simulator", "target", "child-demand"])("rejects %s progress", scenario => {
    const f = fixture();
    if (scenario === "running") f.child.status = "RUNNING";
    if (scenario === "success") f.child.status = "SUCCEEDED";
    if (scenario === "budget") f.child.attempts = 3;
    if (scenario === "deadline") f.child.deadlineAt = new Date("2030-01-01T01:16:00.000Z");
    if (scenario === "future") f.child.completedAt = new Date("2030-01-01T01:04:00.000Z");
    if (scenario === "parent-clock") f.parent.firstPickedUpAt = new Date("2030-01-01T00:01:00.000Z");
    if (scenario === "missing-reciprocal") f.parent.result = { learningRecoveries: [] };
    if (scenario === "runtime") f.child.result = { learningRecoveryOf: f.link, executionRuntimeVersion: "d".repeat(40) };
    if (scenario === "simulator") f.child.offeringId = "offering";
    if (scenario === "target") f.child.targetKey = "course:other";
    if (scenario === "child-demand") f.child.request = { target: { kind: "OUTDOOR", courseId: "course" }, demand: { searchId: "other", alertGeneration: 2 } };
    expect(projectOwnedFailedLearningProgress(f.child, f.parent, f.expected)).toBeNull();
  });
  it("requires exactly one reciprocal failed child for the registered implementation and performs only bounded reads", async () => {
    const f = fixture();
    const reader = { courseDiscoveryJob: { findMany: vi.fn(async () => [f.child]), findUnique: vi.fn(async () => f.parent) } };
    const result = await readOwnedFailedLearningProgress(reader as unknown as Parameters<typeof readOwnedFailedLearningProgress>[0], f.expected);
    expect(result).toEqual(projectOwnedFailedLearningProgress(f.child, f.parent, f.expected));
    expect(reader.courseDiscoveryJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, where: expect.objectContaining({ courseId: "course", offeringId: null }) }));
    reader.courseDiscoveryJob.findMany.mockResolvedValue([f.child, { ...f.child, id: "ambiguous" }]);
    reader.courseDiscoveryJob.findUnique.mockClear();
    expect(await readOwnedFailedLearningProgress(reader as unknown as Parameters<typeof readOwnedFailedLearningProgress>[0], f.expected)).toBeNull();
    expect(reader.courseDiscoveryJob.findUnique).not.toHaveBeenCalled();
  });
});
