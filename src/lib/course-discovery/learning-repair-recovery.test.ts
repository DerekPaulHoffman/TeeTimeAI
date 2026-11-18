import { describe, expect, it } from "vitest";
import { hasLearningRepairRecoveryMarker, hasReciprocalLearningRepairLink,
  readLearningRepairRecoveries, readLearningRepairRecoveryOf } from "./learning-repair-recovery";

const link = { version: 1, kind: "LATE_ENGINEERING_RECOVERY", originalJobId: "original",
  jobId: "recovery", batchId: "batch", incidentId: "incident", ownerThreadId: "original-native-owner", cycle: 1,
  sourceFingerprint: "a".repeat(64), releaseSha: "b".repeat(40), runtimeVersion: "b".repeat(40), requestedAt: "2026-11-18T12:00:00.000Z",
  originalFirstPickedUpAt: "2026-11-18T11:00:00.000Z", originalDeadlineAt: "2026-11-18T11:15:00.000Z" } as const;

describe("late repaired-learning audit links", () => {
  it("requires an exact reciprocal server-persisted link", () => {
    const child = readLearningRepairRecoveryOf({ learningRecoveryOf: link });
    expect(child).toEqual(link);
    expect(hasReciprocalLearningRepairLink({ learningRecoveries: [link] }, child!)).toBe(true);
    expect(hasReciprocalLearningRepairLink({ checkpoint: { learningRecoveries: [link] } }, child!)).toBe(false);
    expect(hasReciprocalLearningRepairLink({ learningRecoveries: [{ ...link, releaseSha: "c".repeat(40) }] }, child!)).toBe(false);
  });
  it.each([{ jobId: "original" }, { cycle: 0 }, { releaseSha: "unknown" },
    { sourceFingerprint: "unknown" }, { requestedAt: "yesterday" }, { kind: "ACCEPTANCE_PASS" },
    { credential: "not-allowed" }, { originalDeadlineAt: "2026-11-18T11:16:00.000Z" }])("rejects a malformed or broadened link %j", change => {
    expect(readLearningRepairRecoveryOf({ learningRecoveryOf: { ...link, ...change } })).toBeNull();
    expect(hasLearningRepairRecoveryMarker({ learningRecoveryOf: { ...link, ...change } })).toBe(true);
  });
  it("distinguishes absent history from corrupt history and duplicate release/job links", () => {
    expect(readLearningRepairRecoveries(null)).toEqual([]);
    expect(readLearningRepairRecoveries({ other: true })).toEqual([]);
    expect(readLearningRepairRecoveries({ learningRecoveries: null })).toBeNull();
    expect(readLearningRepairRecoveries({ learningRecoveries: [link, link] })).toBeNull();
    expect(readLearningRepairRecoveries({ learningRecoveries: [link, { ...link, jobId: "another" }] })).toBeNull();
    expect(readLearningRepairRecoveries({ learningRecoveries: [link, { ...link, releaseSha: "c".repeat(40) }] })).toBeNull();
    expect(readLearningRepairRecoveries({ learningRecoveries: Array.from({ length: 17 }, (_, n) =>
      ({ ...link, jobId: `child-${n}`, releaseSha: n.toString(16).padStart(40, "0") })) })).toBeNull();
  });
});
