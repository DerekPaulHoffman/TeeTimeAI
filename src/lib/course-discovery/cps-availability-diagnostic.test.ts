// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./cps-executor", () => ({ executeCps: mocked.execute, inspectCps: vi.fn() }));
const { normalizeCpsAvailability } = await vi.importActual<typeof import("./cps-executor")>("./cps-executor");
import { cpsAvailabilityDiagnosticSchema, failCpsAvailability, getCpsAvailabilityDiagnostic } from "./cps-availability-diagnostic";
import { executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { accessExecutionDiagnosticSchema } from "./recipe";
import type { ExistingAdapterRecipe } from "./existing-adapter-schema";
import { discoveryReplayDetails, safeCpsAvailabilityDiagnostic, verifyDiscoveryCandidate } from "../../../scripts/automation/course-discovery-worker.mjs";
import { createStagehandFailureCheckpoint, readStagehandFailure } from "../../../scripts/automation/course-discovery-stagehand-failure.mjs";

const transaction = "00000000-0000-4000-8000-000000000001";
const source = { officialUrl: "https://official.example/", bookingUrl: "https://harbor.cps.golf/", venueName: "Harbor Pointe Golf Course",
  venueAddress: "10 Harbor Dr, Example, NY 12345, USA", timeZone: "UTC", providerFamily: "CPS" };
const input = { date: "2030-01-03", startTime: "08:00", endTime: "18:00", players: 2, timeZone: "UTC" };
const metadata = { family: "CPS" as const, tenant: "harbor", courseIds: [1], catalogHash: "a".repeat(64) };
const now = new Date("2030-01-02T00:00:00.000Z");
const row = () => ({ teeSheetId: 7, courseId: 1, startTime: "2030-01-03T10:30:00", availableParticipantNo: [1, 2, 3, 4], minPlayer: 1, holes: 18, defaultHoles: 0 });
const envelope = () => ({ isSuccess: true, transactionId: transaction, content: [row()] });
function reject(value: unknown, id = transaction) {
  let failure: unknown;
  try { normalizeCpsAvailability(value, id, metadata, source, input, now); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("CPS_AVAILABILITY_INCOMPLETE");
  return { error: failure, diagnostic: getCpsAvailabilityDiagnostic(failure)! };
}
afterEach(() => vi.resetAllMocks());

it.each(["transaction", "envelope", "success", "echo", "content", "row-shape", "participants", "duplicate", "course", "date", "round"])(
  "retains the actual rejected parser boundary without changing its failure: %s", change => {
    let value: unknown = envelope();
    const record = value as ReturnType<typeof envelope>;
    if (change === "envelope") Object.assign(record, { PRIVATE_FIELD_NAME: "PRIVATE_RESPONSE_VALUE" });
    if (change === "success") record.isSuccess = false;
    if (change === "echo") record.transactionId = "00000000-0000-4000-8000-000000000002";
    if (change === "content") value = { ...record, content: null };
    if (change === "row-shape") value = { ...record, content: [{ ...row(), teeSheetId: "PRIVATE_ID_VALUE" }] };
    if (change === "participants") value = { ...record, content: [{ ...row(), availableParticipantNo: [2, 2] }] };
    if (change === "duplicate") record.content.push(row());
    if (change === "course") record.content[0].courseId = 999;
    if (change === "date") record.content[0].startTime = "2030-01-04T10:30:00";
    if (change === "round") value = { ...record, content: [{ ...row(), holes: null, defaultHoles: 0 }] };
    const { error, diagnostic } = reject(value, change === "transaction" ? "PRIVATE_BAD_TRANSACTION" : transaction);
    expect(diagnostic).toMatchObject({ stage: change === "transaction" ? "TRANSACTION_ID" : change === "duplicate" ? "DUPLICATE_ID" :
      change === "course" ? "COURSE_ID" : change === "date" ? "DATE" : change === "round" ? "ROUND_LENGTH" : "SCHEMA" });
    if (change === "envelope") expect(diagnostic.issues).toContainEqual({ field: "ENVELOPE", kind: "UNRECOGNIZED_KEYS", valueType: "OBJECT", extraKeyCount: 1 });
    if (change === "row-shape") expect(diagnostic.issues).toContainEqual({ field: "TEE_SHEET_ID", kind: "INVALID_TYPE", valueType: "STRING" });
    if (change === "round") expect(diagnostic.roundLength).toEqual({ holes: "NULL", defaultHoles: "ZERO" });
    expect(cpsAvailabilityDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(safeCpsAvailabilityDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE|2030|https:|harbor|00000000/u);
    expect(JSON.stringify(error)).toBe("{}");
    expect(getCpsAvailabilityDiagnostic({ ...(error as Error) })).toBeUndefined();
  });

it("keeps literal transaction matching and reports case relation without accepting it", () => {
  const expected = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const { diagnostic } = reject({ ...envelope(), transactionId: expected.toUpperCase() }, expected);
  expect(diagnostic).toMatchObject({ transactionMatches: false, transactionMatchesIgnoringCase: true, stage: "SCHEMA" });
});

it("preserves valid empty and matching responses and never manufactures completion", () => {
  expect(normalizeCpsAvailability({ ...envelope(), content: [] }, transaction, metadata, source, input, now)).toEqual([]);
  expect(normalizeCpsAvailability(envelope(), transaction, metadata, source, input, now)).toHaveLength(1);
});

it("bounds oversized responses and issue lists without retaining rejected data", () => {
  const oversized = reject({ ...envelope(), content: Array.from({ length: 501 }, row) }).diagnostic;
  expect(oversized).toMatchObject({ stage: "SCHEMA", rowCount: "OVER_LIMIT" });
  const many = reject({ ...envelope(), content: Array.from({ length: 13 }, () => ({ ...row(), teeSheetId: "PRIVATE" })) }).diagnostic;
  expect(many.issues).toHaveLength(12); expect(many.issuesOmitted).toBe(true);
  expect(safeCpsAvailabilityDiagnostic(many)).toEqual(many);
  expect(JSON.stringify(many)).not.toContain("PRIVATE");
  const unsafeId = reject({ ...envelope(), content: [{ ...row(), teeSheetId: Number.MAX_SAFE_INTEGER + 1 }] }).diagnostic;
  expect(unsafeId.issues).toContainEqual({ field: "TEE_SHEET_ID", kind: "TOO_BIG", valueType: "NUMBER", safePositiveInteger: false });
});

it.each(["unknown-stage", "raw-field", "unknown-issue", "raw-issue", "oversize", "wrong-round", "wrong-number-context", "round-array", "issue-limit"])("drops malformed closed diagnostics in both schema and actual worker: %s", change => {
  const value = structuredClone(reject({ ...envelope(), content: null }).diagnostic) as unknown as Record<string, unknown>;
  if (change === "unknown-stage") value.stage = "PRIVATE";
  if (change === "raw-field") value.response = "PRIVATE";
  if (change === "unknown-issue") value.issues = [{ field: "PRIVATE", kind: "INVALID_TYPE", valueType: "NULL" }];
  if (change === "raw-issue") value.issues = [{ field: "CONTENT", kind: "INVALID_TYPE", valueType: "NULL", message: "PRIVATE" }];
  if (change === "oversize") value.rowCount = 501;
  if (change === "wrong-round") value.roundLength = { holes: "NINE", defaultHoles: "ZERO" };
  if (change === "wrong-number-context") value.issues = [{ field: "CONTENT", kind: "INVALID_TYPE", valueType: "NULL", safePositiveInteger: true }];
  if (change === "round-array") Object.assign(value, { stage: "ROUND_LENGTH", issues: [], roundLength: Object.assign([], { holes: "NINE", defaultHoles: "ZERO" }) });
  if (change === "issue-limit") value.issues = Array.from({ length: 13 }, () => ({ field: "CONTENT", kind: "INVALID_TYPE", valueType: "NULL" }));
  expect(cpsAvailabilityDiagnosticSchema.safeParse(value).success).toBe(false);
  expect(safeCpsAvailabilityDiagnostic(value)).toBeUndefined();
});

it("carries the actual parser rejection through adapter execution, replay feedback and its checkpoint without activation", async () => {
  const { error, diagnostic } = reject({ ...envelope(), PRIVATE_FIELD: "PRIVATE_RESPONSE" });
  mocked.execute.mockRejectedValue(error);
  const recipe: ExistingAdapterRecipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course1", kind: "OUTDOOR" }, source, adapter: metadata };
  const fetch = vi.fn(async () => { throw Error("UNEXPECTED_PROVIDER_READ"); });
  const result = await executeExistingAdapterRecipe(recipe, input, { now: () => now, recipeHash: "a".repeat(64), fetch,
    venueMatches: (expected, actual) => expected === actual, toInstant: value => new Date(String(value) + "Z") });
  expect(mocked.execute).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "CPS_AVAILABILITY_INCOMPLETE",
    venueVerified: false, completeVerified: false, diagnostic: { code: "CPS_AVAILABILITY_INCOMPLETE", cpsAvailability: diagnostic } } });
  expect(discoveryReplayDetails(result)).toMatchObject({ complete: false, diagnostic: { cpsAvailability: diagnostic } });
  expect(accessExecutionDiagnosticSchema.safeParse({ code: "OTHER", cpsAvailability: diagnostic }).success).toBe(false);
  expect(discoveryReplayDetails({ ...result, evidence: { diagnostic: { code: "OTHER", cpsAvailability: diagnostic } } }).diagnostic).not.toHaveProperty("cpsAvailability");
  const client = { candidate: vi.fn(async () => ({ recipeHash: "a".repeat(64), challenges: [1, 2].map(id => ({ id: String(id), recipeHash: "a".repeat(64), input })) })),
    verification: vi.fn(), activate: vi.fn() };
  const job = { id: "owned-job", leaseToken: "owned-test-token", sourceFingerprint: "a".repeat(64), attempts: 1,
    request: { target: recipe.target, input }, firstPickedUpAt: now.toISOString(), deadlineAt: new Date(now.getTime() + 900000).toISOString() };
  const replays: unknown[] = [];
  const failure = await verifyDiscoveryCandidate({ job, client, recipe, executeRecipe: async () => result, onReplay: value => replays.push(value) }).catch(error => error);
  expect(failure.code).toBe("DISCOVERY_REPLAY_INCOMPLETE");
  expect(client.verification).not.toHaveBeenCalled(); expect(client.activate).not.toHaveBeenCalled();
  const saved = createStagehandFailureCheckpoint({ job, error: failure, phase: "REPLAY", metrics: { replayDurationsMs: [1] },
    progress: { phase: "INDEPENDENT_REPLAY", replay: replays[0] }, startedAt: now.getTime(), now: now.getTime() + 1000 });
  expect(readStagehandFailure({ ...job, checkpoint: saved }, now.getTime() + 1000)).toEqual(saved.stagehandFailure);
  expect(saved.stagehandProgress.replay.result.diagnostic.cpsAvailability).toEqual(diagnostic);
  expect(JSON.stringify(saved)).not.toMatch(/PRIVATE_RESPONSE|PRIVATE_FIELD/u);
});

it("does not replace the parser rejection when optional diagnostic access fails", () => {
  const value = Object.defineProperty({}, "transactionId", { get() { throw Error("PRIVATE"); } });
  let failure: unknown;
  try { failCpsAvailability("TRANSACTION_ID", value, transaction); } catch (error) { failure = error; }
  expect((failure as Error).message).toBe("CPS_AVAILABILITY_INCOMPLETE");
  expect(getCpsAvailabilityDiagnostic(failure)).toBeUndefined();
});
