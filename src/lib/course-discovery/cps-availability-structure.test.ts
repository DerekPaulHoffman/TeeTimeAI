// @vitest-environment node
import { expect, it } from "vitest";
import { captureCpsAvailabilityStructure, parseCpsAvailabilityStructure, readPrivateCpsAvailabilityStructure } from "./cps-availability-structure";
import { safePrivateCpsAvailabilityStructure } from "../../../scripts/automation/course-discovery-worker.mjs";
import { stagehandDataHash } from "../../../scripts/automation/course-discovery-stagehand-source.mjs";
const at = "2030-01-01T12:01:00.000Z";
const capture = () => captureCpsAvailabilityStructure({ teeTimes: [{ teeSheetId: 987654, startTime: "PRIVATE_DATE", bookingUrl: "https://private.example/", token: "PRIVATE_SECRET" }], total: 1 }, at)!;
it("captures the missing object structure without scalar values or a guessed response mapping", () => {
  const value = capture();
  expect(value.nodes).toContainEqual({ path: ["teeTimes"], type: "ARRAY", count: 1 });
  expect(value.nodes).toContainEqual({ path: ["teeTimes", 0, "teeSheetId"], type: "NUMBER" });
  expect(value.nodes).toContainEqual({ path: ["teeTimes", 0, "token"], type: "STRING" });
  expect(value.truncated).toBe(false);
  expect(parseCpsAvailabilityStructure(value)).toEqual(value);
  expect(safePrivateCpsAvailabilityStructure(value)).toEqual(value);
  expect(JSON.stringify(value)).not.toMatch(/PRIVATE|987654|https:/u);
});
it("bounds depth, fields, nodes, samples and unrepresentable keys explicitly", () => {
  const content = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String.fromCharCode(65 + i), { child: { nested: { deepest: { value: 1 } } } }]));
  const large = captureCpsAvailabilityStructure(content, at)!;
  expect(large.nodes.length).toBeLessThanOrEqual(96); expect(large.truncated).toBe(true);
  expect(safePrivateCpsAvailabilityStructure(large)).toEqual(large);
  const rows = captureCpsAvailabilityStructure({ rows: Array.from({ length: 501 }, () => ({ value: "PRIVATE" })), "unsafe@example.com": "PRIVATE" }, at)!;
  expect(rows.nodes).toContainEqual({ path: ["rows"], type: "ARRAY", count: "OVER_LIMIT" });
  expect(rows.truncated).toBe(true); expect(JSON.stringify(rows)).not.toMatch(/unsafe|PRIVATE|example/u);
  expect(captureCpsAvailabilityStructure([])).toBeUndefined();
});
it.each(["unknown", "value", "unsafe-key", "depth", "duplicate", "orphan", "count", "primitive-count", "overflow", "time", "empty-array-child"])("rejects invalid private structures in both runtimes: %s", scenario => {
  const value = structuredClone(capture()) as Record<string, unknown>;
  const nodes = value.nodes as { path: (string | number)[]; type: string; count?: unknown; value?: string }[];
  if (scenario === "unknown") value.raw = "PRIVATE";
  if (scenario === "value") nodes[0].value = "PRIVATE";
  if (scenario === "unsafe-key") nodes[1].path = ["https://private.example/"];
  if (scenario === "depth") nodes[1].path = ["a", "b", "c", "d", "e"];
  if (scenario === "duplicate") nodes.push(nodes[0]);
  if (scenario === "orphan") nodes[1].path = ["missing", "child"];
  if (scenario === "count") delete nodes[0].count;
  if (scenario === "primitive-count") nodes.find(node => node.type === "STRING")!.count = 1;
  if (scenario === "overflow") nodes[0].count = 501;
  if (scenario === "time") value.observedAt = "PRIVATE";
  if (scenario === "empty-array-child") nodes[1].count = 0;
  expect(parseCpsAvailabilityStructure(value)).toBeUndefined(); expect(safePrivateCpsAvailabilityStructure(value)).toBeUndefined();
});
it.each(["valid", "job", "source", "request", "clock", "early", "late", "phase", "code", "digest", "omitted", "attempt"])("binds private structure to its actual failed attempt: %s", scenario => {
  const evidence = capture();
  const entry = { attempt: 1, phase: "REPLAY", code: "DISCOVERY_REPLAY_INCOMPLETE", replayFailureCode: "CPS_AVAILABILITY_INCOMPLETE", observedAt: at,
    privateCpsAvailabilityStructure: evidence as unknown, privateCpsAvailabilityStructureSha256: stagehandDataHash(evidence) };
  const job = { id: "job", sourceFingerprint: "a".repeat(64), request: { fixture: true }, attempts: 1,
    firstPickedUpAt: new Date("2030-01-01T12:00:00Z"), deadlineAt: new Date("2030-01-01T12:15:00Z"), completedAt: new Date("2030-01-01T12:02:00Z"),
    checkpoint: { stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", jobId: "job", sourceFingerprint: "a".repeat(64),
      requestSha256: stagehandDataHash({ fixture: true }), firstPickedUpAt: "2030-01-01T12:00:00.000Z", deadlineAt: "2030-01-01T12:15:00.000Z", entries: [entry] } } };
  const failure = job.checkpoint.stagehandFailure;
  if (scenario === "job") failure.jobId = "other";
  if (scenario === "source") failure.sourceFingerprint = "b".repeat(64);
  if (scenario === "request") failure.requestSha256 = "b".repeat(64);
  if (scenario === "clock") failure.deadlineAt = at;
  if (scenario === "early") evidence.observedAt = "2030-01-01T11:59:00.000Z";
  if (scenario === "late") entry.observedAt = "2030-01-01T12:03:00.000Z";
  if (scenario === "phase") entry.phase = "FIXED_INSPECTION";
  if (scenario === "code") entry.replayFailureCode = "OTHER";
  if (scenario === "digest") entry.privateCpsAvailabilityStructureSha256 = "b".repeat(64);
  if (scenario === "omitted") entry.privateCpsAvailabilityStructure = undefined;
  if (scenario === "attempt") entry.attempt = 2;
  expect(readPrivateCpsAvailabilityStructure(job, new Date("2030-01-01T12:16:00Z"))).toEqual(scenario === "valid" ? evidence : undefined);
});
