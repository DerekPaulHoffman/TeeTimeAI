import { describe, expect, it } from "vitest";
import {
  appendCourseSupportLineage, createCourseSupportLineage,
  readCourseSupportLineage, COURSE_SUPPORT_LINEAGE_EVENT_LIMIT, isCourseSupportLineageThreadRef,
} from "./course-support-lineage";

const now = new Date("2026-09-30T09:00:00.000Z");
const later = new Date("2026-09-30T09:01:00.000Z");
const claim = () => ({ ownershipLineageV1: createCourseSupportLineage("original-run", "owner-1", now) });

describe("private course support mutation lineage", () => {
  it("starts only the new claim with its original run and owner", () => {
    expect(readCourseSupportLineage(claim())).toMatchObject({
      completeness: "COMPLETE_FROM_CLAIM", originalAutomationRunId: "original-run", omittedEventCount: 0,
      events: [{ sequence: 1, ownerEpoch: 1, kind: "CLAIM", actorThreadId: "owner-1", ownerThreadId: "owner-1", observedAt: now.toISOString() }],
    });
  });

  it("retains every transferred owner including same-owner recovery", () => {
    let summary: Record<string, unknown> = claim();
    for (const [previousOwnerThreadId, ownerThreadId] of [["owner-1", "owner-2"], ["owner-2", "owner-2"], ["owner-2", "owner-3"]]) {
      summary = appendCourseSupportLineage(summary, { kind: "RECOVERY_TRANSFER", actorThreadId: ownerThreadId, previousOwnerThreadId, ownerThreadId }, later);
    }
    expect(readCourseSupportLineage(summary)?.events.map(event => [event.ownerEpoch, event.ownerThreadId])).toEqual([[1, "owner-1"], [2, "owner-2"], [3, "owner-2"], [4, "owner-3"]]);
    expect(summary).toMatchObject({ ownershipLineageV1: { originalAutomationRunId: "original-run", completeness: "COMPLETE_FROM_CLAIM" } });
  });

  it.each(["RECOVERY_FENCE_ADOPTION", "RECOVERY_CLOSEOUT"] as const)("records the %s actor without inventing an ownership transfer", kind => {
    const lineage = readCourseSupportLineage(appendCourseSupportLineage(claim(), { kind, actorThreadId: "recoverer", ownerThreadId: "owner-1" }, later));
    expect(lineage?.events.at(-1)).toMatchObject({ actorThreadId: "recoverer", ownerThreadId: "owner-1", ownerEpoch: 1, sequence: 2 });
  });

  it.each(["OWNER_CLOSEOUT", "SYSTEM_CLOSEOUT"] as const)("records %s and rejects a later mutation as complete history", kind => {
    const summary = appendCourseSupportLineage(claim(), { kind, actorThreadId: kind === "SYSTEM_CLOSEOUT" ? null : "owner-1", ownerThreadId: "owner-1" }, later);
    expect(readCourseSupportLineage(summary)?.events.at(-1)?.actorThreadId).toBe(kind === "SYSTEM_CLOSEOUT" ? null : "owner-1");
    expect(readCourseSupportLineage(appendCourseSupportLineage(summary, { kind: "RECOVERY_FENCE_ADOPTION", actorThreadId: "recoverer", ownerThreadId: "owner-1" }, later))).toMatchObject({ completeness: "INVALID_EVENT_INCOMPLETE", omittedEventCount: 1 });
  });

  it("binds a declared specialist to its owner epoch and owned packet without accepting usage or proof", () => {
    const summary = appendCourseSupportLineage({ ...claim(), selectionLane: { schemaVersion: 1, lane: "ACTIVE_ALERT" } }, {
      kind: "RESEARCH_ASSIGNMENT", actorThreadId: "owner-1", ownerThreadId: "owner-1", specialistThreadId: "child-1",
      ordinal: 2, incidentCycle: 3, contextDigest: "a".repeat(64),
    }, later);
    const lineage = readCourseSupportLineage(summary);
    expect(lineage?.events.at(-1)).toMatchObject({ ownerEpoch: 1, specialistThreadId: "child-1", ordinal: 2, incidentCycle: 3, contextDigest: "a".repeat(64) });
    expect(Object.keys(summary).sort()).toEqual(["ownershipLineageV1", "selectionLane"]);
    expect(JSON.stringify(summary)).not.toMatch(/model|token|probe|monitoring|stage|credential/i);
  });

  it("accepts returned canonical agent references while rejecting URLs and unbounded paths", () => {
    expect(isCourseSupportLineageThreadRef("/root/research_child")).toBe(true);
    expect(isCourseSupportLineageThreadRef("/root/research_child/nested_2")).toBe(true);
    expect(isCourseSupportLineageThreadRef("https://example.test/research")).toBe(false);
    expect(isCourseSupportLineageThreadRef("/root/../another")).toBe(false);
    expect(isCourseSupportLineageThreadRef("/root" + "/child".repeat(9))).toBe(false);
    expect(isCourseSupportLineageThreadRef("/root/" + "a".repeat(129))).toBe(false);
  });

  it("retains a null legacy owner rather than inventing a native session", () => {
    expect(readCourseSupportLineage(appendCourseSupportLineage({}, {
      kind: "SYSTEM_CLOSEOUT", actorThreadId: null, ownerThreadId: null,
    }, later))).toMatchObject({ completeness: "LEGACY_INCOMPLETE", events: [{ ownerThreadId: null, actorThreadId: null }] });
  });

  it("records new legacy recovery facts while leaving missing history incomplete", () => {
    const summary = appendCourseSupportLineage({ closeout: { untouched: true } }, {
      kind: "RECOVERY_TRANSFER", actorThreadId: "owner-2", ownerThreadId: "owner-2", previousOwnerThreadId: "owner-1",
    }, later);
    expect(readCourseSupportLineage(summary)).toMatchObject({ completeness: "LEGACY_INCOMPLETE", originalAutomationRunId: null,
      events: [{ sequence: 1, ownerEpoch: 1, previousOwnerThreadId: "owner-1", ownerThreadId: "owner-2" }] });
    expect(summary.closeout).toEqual({ untouched: true });
  });

  it("never erases malformed history or repairs it into a complete claim", () => {
    const summary = { ownershipLineageV1: { schemaVersion: 99, events: ["unknown"] }, unrelated: true };
    const appended = appendCourseSupportLineage(summary, { kind: "RECOVERY_FENCE_ADOPTION", actorThreadId: "recoverer", ownerThreadId: "owner-1" }, later);
    expect(appended).toEqual(summary);
    expect(readCourseSupportLineage(appended)).toBeNull();
  });

  it("caps retained events without truncating its prefix and marks usage incomplete", () => {
    let summary: Record<string, unknown> = claim();
    for (let index = 1; index < COURSE_SUPPORT_LINEAGE_EVENT_LIMIT + 2; index++) summary = appendCourseSupportLineage(summary, {
      kind: "RECOVERY_FENCE_ADOPTION", actorThreadId: "recoverer", ownerThreadId: "owner-1",
    }, later);
    const lineage = readCourseSupportLineage(summary);
    expect(lineage).toMatchObject({ completeness: "OVERFLOW_INCOMPLETE", omittedEventCount: 2 });
    expect(lineage?.events).toHaveLength(COURSE_SUPPORT_LINEAGE_EVENT_LIMIT);
    expect(lineage?.events[0]).toEqual(claim().ownershipLineageV1.events[0]);
  });

  it.each([
    { kind: "RECOVERY_TRANSFER", actorThreadId: "owner-2", ownerThreadId: "owner-2", previousOwnerThreadId: "wrong-owner" },
    { kind: "OWNER_CLOSEOUT", actorThreadId: "wrong-owner", ownerThreadId: "owner-1" },
    { kind: "SYSTEM_CLOSEOUT", actorThreadId: "invented-system-actor", ownerThreadId: "owner-1" },
    { kind: "RESEARCH_ASSIGNMENT", actorThreadId: "owner-1", ownerThreadId: "owner-1", specialistThreadId: "owner-1", ordinal: 1, incidentCycle: 1, contextDigest: "a".repeat(64) },
  ] as const)("rejects incoherent $kind authority as attribution evidence", input => {
    expect(readCourseSupportLineage(appendCourseSupportLineage(claim(), input, later))).toMatchObject({ completeness: "INVALID_EVENT_INCOMPLETE", omittedEventCount: 1, events: claim().ownershipLineageV1.events });
  });

  it("keeps a valid prefix with an explicit permanent gap for invalid recovery input", () => {
    const invalid = appendCourseSupportLineage(claim(), {
      kind: "RECOVERY_TRANSFER", actorThreadId: "not-an-email@example.test", ownerThreadId: "not-an-email@example.test", previousOwnerThreadId: "owner-1",
    }, later);
    expect(readCourseSupportLineage(invalid)).toMatchObject({ completeness: "INVALID_EVENT_INCOMPLETE", omittedEventCount: 1, events: claim().ownershipLineageV1.events });
    expect(JSON.stringify(invalid)).not.toContain("example.test");
    const after = appendCourseSupportLineage(invalid, { kind: "OWNER_CLOSEOUT", actorThreadId: "owner-1", ownerThreadId: "owner-1" }, later);
    expect(readCourseSupportLineage(after)).toMatchObject({ completeness: "INVALID_EVENT_INCOMPLETE", omittedEventCount: 2, events: claim().ownershipLineageV1.events });
  });

  it("marks invalid initial claim or absent history without storing raw invalid fields", () => {
    const invalidClaim = createCourseSupportLineage("bad run", "bad owner", now);
    expect(readCourseSupportLineage({ ownershipLineageV1: invalidClaim })).toMatchObject({ completeness: "INVALID_EVENT_INCOMPLETE", originalAutomationRunId: null, events: [], omittedEventCount: 1 });
    expect(readCourseSupportLineage(appendCourseSupportLineage({}, { kind: "OWNER_CLOSEOUT", actorThreadId: "bad owner", ownerThreadId: "bad owner" }, later))).toMatchObject({ completeness: "INVALID_EVENT_INCOMPLETE", events: [], omittedEventCount: 1 });
    expect(readCourseSupportLineage(appendCourseSupportLineage(claim(), { kind: "OWNER_CLOSEOUT", actorThreadId: "owner-1", ownerThreadId: "owner-1" }, new Date("invalid")))).toMatchObject({ completeness: "INVALID_EVENT_INCOMPLETE", omittedEventCount: 1 });
  });

  it("rejects counter/model/raw fields and backward clock evidence", () => {
    const summary = claim();
    Object.assign(summary.ownershipLineageV1.events[0], { inputTokens: 42 });
    expect(readCourseSupportLineage(summary)).toBeNull();
    expect(readCourseSupportLineage(appendCourseSupportLineage(claim(), { kind: "RECOVERY_FENCE_ADOPTION", actorThreadId: "recoverer", ownerThreadId: "owner-1" }, new Date(now.getTime() - 1)))).toMatchObject({ completeness: "INVALID_EVENT_INCOMPLETE", events: claim().ownershipLineageV1.events });
  });
});
