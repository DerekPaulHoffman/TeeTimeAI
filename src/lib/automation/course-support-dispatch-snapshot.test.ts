// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createCourseDispatchIncidentFingerprint, isCourseDispatchIncidentSnapshotCurrent } from "./course-support-dispatch-snapshot";

const source = "a".repeat(64);
const time = new Date("2026-10-29T20:35:00Z");
const incident = () => ({
  id: "incident", courseId: "course", cycle: 1, status: "AUTO_INVESTIGATING" as const,
  kind: "FETCH_FAILED" as const, providerFamilyKey: "PUBLIC_SOURCE", failureClass: "HTTP_5XX" as const,
  failureFingerprint: "same-failure", humanReviewReason: null, engineeringOnly: true,
  attemptLedger: { version: 1, events: [] }, confirmedAt: time, escalatedAt: null,
  lastAttemptAt: null, attemptCount: 0, activeBatchId: null, updatedAt: time,
});

describe("course dispatch material incident snapshot", () => {
  it("accepts observation-clock and due-time refreshes without renewing the original proof", () => {
    const original = incident();
    const target = { updatedAt: time.toISOString(), incidentFingerprint: createCourseDispatchIncidentFingerprint(original, source)! };
    const refreshed = { ...original, updatedAt: new Date("2026-10-29T20:55:00Z"), revision: 14, occurrenceCount: 20,
      lastSeenAt: new Date("2026-10-29T20:51:00Z"), nextAttemptAt: new Date("2026-10-29T20:55:00Z") };
    expect(isCourseDispatchIncidentSnapshotCurrent(target, refreshed, source)).toBe(true);
    expect(createCourseDispatchIncidentFingerprint(refreshed, source)).toBe(target.incidentFingerprint);
  });
  it.each([
    ["id", "another"], ["courseId", "another"], ["cycle", 2], ["status", "NEEDS_HUMAN"],
    ["kind", "NEEDS_ADAPTER"], ["providerFamilyKey", "another"], ["failureClass", "UNKNOWN"],
    ["failureFingerprint", "another"], ["humanReviewReason", "TECHNICAL_ACCESS"], ["engineeringOnly", false],
    ["attemptLedger", { version: 1, events: [{ attempted: true }] }], ["confirmedAt", new Date(0)],
    ["escalatedAt", time], ["lastAttemptAt", time], ["attemptCount", 1], ["activeBatchId", "another-owner"],
  ])("rejects changed %s even if updatedAt is unchanged", (key, value) => {
    const original = incident();
    const target = { updatedAt: time.toISOString(), incidentFingerprint: createCourseDispatchIncidentFingerprint(original, source)! };
    expect(isCourseDispatchIncidentSnapshotCurrent(target, { ...original, [key]: value }, source)).toBe(false);
  });
  it("rejects changed source proof, incomplete snapshots and malformed proof", () => {
    const original = incident();
    const target = { updatedAt: time.toISOString(), incidentFingerprint: createCourseDispatchIncidentFingerprint(original, source)! };
    expect(isCourseDispatchIncidentSnapshotCurrent(target, original, "b".repeat(64))).toBe(false);
    expect(isCourseDispatchIncidentSnapshotCurrent(target, { ...original, activeBatchId: undefined } as never, source)).toBe(false);
    expect(isCourseDispatchIncidentSnapshotCurrent({ ...target, incidentFingerprint: "invalid" }, original, source)).toBe(false);
    expect(createCourseDispatchIncidentFingerprint(original, "unavailable")).toBeUndefined();
  });
  it("retains strict timestamp validation for legacy assignments", () => {
    expect(isCourseDispatchIncidentSnapshotCurrent({ updatedAt: time.toISOString() }, incident(), source)).toBe(true);
    expect(isCourseDispatchIncidentSnapshotCurrent({ updatedAt: new Date(0).toISOString() }, incident(), source)).toBe(false);
  });
  it("compares ledger objects independently of JSON key order", () => {
    const first = { ...incident(), attemptLedger: { version: 1, events: [], proof: { a: 1, b: 2 } } };
    const second = { ...first, attemptLedger: { proof: { b: 2, a: 1 }, events: [], version: 1 } };
    expect(createCourseDispatchIncidentFingerprint(first, source)).toBe(createCourseDispatchIncidentFingerprint(second, source));
  });
});
