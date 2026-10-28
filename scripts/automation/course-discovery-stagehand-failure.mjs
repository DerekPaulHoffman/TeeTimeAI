import { discoveryError } from "./course-discovery-client.mjs";
import { canonicalStagehandData as canonical, stagehandDataHash as hash, createStagehandSourceCheckpoint } from "./course-discovery-stagehand-source.mjs";
import { projectSourceDiagnostic, sourceTransportCodes, safeNativeRouterFailure } from "./stagehand/source-diagnostic.mjs";
import { safeTeeItUpDelegationDiagnostic, safeFixedAdapterReadDiagnostic, safeFixedInspectionSourceDiagnostic } from "./course-discovery-worker.mjs";
import { currentStagehandInspectionDiagnostic, safeInspectionReadability } from "./course-discovery-stagehand-inspection.mjs";

const LIMIT = 32000, KIND = "OWN_STAGEHAND_FAILURE_DIAGNOSTIC";
const phases = new Set(["SOURCE_RESUME", "SOURCE_DISCOVERY", "SOURCE_VALIDATION", "FIXED_INSPECTION", "RECIPE_VALIDATION", "REPLAY", "ACTIVATION", "UNKNOWN"]);
const codes = new Set([...sourceTransportCodes, "OFFICIAL_DELEGATED_SOURCE_UNVERIFIED", "OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED", "FOREUP_OFFICIAL_ROUTE_UNVERIFIED", "UNSUPPORTED_ADAPTER_SOURCE", "CPS_PUBLIC_BUILD_UNSUPPORTED", "ADAPTER_CONFIGURATION_UNVERIFIED", "STAGEHAND_WORKER_FAILED", "STAGEHAND_SOURCE_DISCOVERY_FAILED", "STAGEHAND_SOURCE_OUTPUT_INVALID",
  "ADAPTER_TRANSPORT_FAILED", "ADAPTER_CONFIGURATION_CHANGED", "ADAPTER_IDENTITY_MISMATCH", "INVALID_ADAPTER_SOURCE", "USCHEDULE_PUBLIC_LOCATION_UNVERIFIED", "USCHEDULE_PUBLIC_PARTY_UNVERIFIED", "OFFICIAL_POSTAL_SOURCE_UNVERIFIED",
  "OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED", "OFFICIAL_STREET_TYPE_OMITTED_CHANGED",
  "OFFICIAL_CONTACT_SOURCE_UNVERIFIED", "OFFICIAL_CONTACT_READER_UNAVAILABLE", "OFFICIAL_CONTACT_ROOT_READ_UNVERIFIED",
  "OFFICIAL_CONTACT_ROOT_LINK_UNVERIFIED", "OFFICIAL_CONTACT_PAGE_READ_UNVERIFIED", "OFFICIAL_CONTACT_DOCUMENT_UNVERIFIED",
  "OFFICIAL_CONTACT_DEADLINE_EXCEEDED", "OFFICIAL_CONTACT_CHAIN_READ_UNVERIFIED",
  "OFFICIAL_CONTACT_DIRECTORY_BIND_UNVERIFIED", "OFFICIAL_CONTACT_DIRECTORY_READ_UNVERIFIED",
  "STAGEHAND_SOURCE_CLEANUP_UNCONFIRMED", "STAGEHAND_SOURCE_UNRESOLVED", "STAGEHAND_SOURCE_REPORT_INVALID", "STAGEHAND_SOURCE_CLOCK_INVALID", "STAGEHAND_SOURCE_NOT_OBSERVED",
  "STAGEHAND_SOURCE_PROPOSAL_INVALID", "STAGEHAND_SOURCE_GRAPH_LIMIT", "STAGEHAND_SOURCE_CHECKPOINT_LIMIT", "STAGEHAND_SOURCE_RESUME_INVALID",
  "STAGEHAND_SOURCE_RESUME_DEADLINE", "DISCOVERY_WORK_DEADLINE", "DISCOVERY_RECIPE_INVALID", "DISCOVERY_REPLAY_INCOMPLETE", "DISCOVERY_CHALLENGE_INVALID",
  "DISCOVERY_LEASE_REJECTED", "DISCOVERY_LEASE_EXPIRED", "DISCOVERY_CANCELLED", "FRAMEWORK_INSPECTION_DEADLINE", "FRAMEWORK_INSPECTION_CANCELLED",
  "FRAMEWORK_INSPECTION_SOURCE_UNREADABLE", "FRAMEWORK_INSPECTION_PATH_STALE", "FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED", "FRAMEWORK_INSPECTION_METADATA_INVALID",
  "FRAMEWORK_INSPECTION_METADATA_CONFLICT", "FRAMEWORK_INSPECTION_PROOF_NOT_BOUND", "FRAMEWORK_INSPECTION_OBSERVATION_INVALID", "FRAMEWORK_INSPECTION_CLOSE_FAILED",
  "FRAMEWORK_INSPECTION_CONTEXT_CHANGED", "FRAMEWORK_INSPECTION_LANDING_CHANGED", "STAGEHAND_FIXED_INSPECTION_FAILED"]);
const plain = value => value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const count = (value, maximum = 1_000_000_000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
const fact = value => typeof value === "boolean" ? value : null;
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const size = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const binding = job => ({ jobId: job.id, sourceFingerprint: job.sourceFingerprint, requestSha256: hash(job.request), firstPickedUpAt: job.firstPickedUpAt, deadlineAt: job.deadlineAt });

function validEntry(value, job, now) {
  if (!plain(value) || ![1, 2].includes(value.attempt) || !phases.has(value.phase) || !codes.has(value.code) || !iso(value.observedAt) ||
      Date.parse(value.observedAt) < Date.parse(job.firstPickedUpAt) - 5000 || Date.parse(value.observedAt) > Math.min(Date.parse(job.deadlineAt), now + 5000) ||
      !plain(value.counts) || !plain(value.cleanup) || typeof value.sourceResumed !== "boolean") return false;
  const projected = { attempt: value.attempt, observedAt: value.observedAt, phase: value.phase, code: value.code,
    counts: Object.fromEntries(["completedModelCalls", "sourceElapsedMs", "workerElapsedMs", "completedReplays"].map(key => [key, count(value.counts[key], key.endsWith("Ms") ? 900000 : 1000000)])),
    tokenUsage: Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"].map(key => [key, count(value.tokenUsage?.[key])])),
    cleanup: { sourceBrowserClosed: fact(value.cleanup.sourceBrowserClosed), sourceModelClosed: fact(value.cleanup.sourceModelClosed), inspectionBrowserClosed: fact(value.cleanup.inspectionBrowserClosed) },
    sourceResumed: value.sourceResumed };
  if (value.diagnostic !== undefined) {
    const diagnostic = projectSourceDiagnostic(value.diagnostic);
    if (!diagnostic || value.diagnosticSha256 !== hash(diagnostic)) return false;
    projected.diagnostic = diagnostic; projected.diagnosticSha256 = value.diagnosticSha256;
  } else if (value.diagnosticSha256 !== undefined) {
    if (!sha(value.diagnosticSha256) || value.diagnosticOmittedForBudget !== true) return false;
    projected.diagnosticSha256 = value.diagnosticSha256; projected.diagnosticOmittedForBudget = true;
  }
  if (value.fixedInspectionDiagnostic !== undefined) {
    const teeItUpDelegation = safeTeeItUpDelegationDiagnostic(value.fixedInspectionDiagnostic?.teeItUpDelegation);
    const adapterRead = safeFixedAdapterReadDiagnostic(value.fixedInspectionDiagnostic?.adapterRead);
    const readability = safeInspectionReadability(value.fixedInspectionDiagnostic?.readability);
    const nativeRouterFailure = safeNativeRouterFailure(value.fixedInspectionDiagnostic?.nativeRouterFailure);
    const fixedSource = safeFixedInspectionSourceDiagnostic(value.fixedInspectionDiagnostic);
    const diagnostic = teeItUpDelegation || adapterRead || readability || nativeRouterFailure || fixedSource ? {
      ...(teeItUpDelegation ? { teeItUpDelegation } : {}), ...(adapterRead ? { adapterRead } : {}),
      ...(readability ? { readability } : {}),
      ...(nativeRouterFailure ? { nativeRouterFailure } : {}),
      ...(fixedSource ?? {}),
    } : undefined;
    if (value.phase !== "FIXED_INSPECTION" || !diagnostic || canonical(diagnostic) !== canonical(value.fixedInspectionDiagnostic) ||
        value.fixedInspectionDiagnosticSha256 !== hash(diagnostic)) return false;
    projected.fixedInspectionDiagnostic = diagnostic; projected.fixedInspectionDiagnosticSha256 = value.fixedInspectionDiagnosticSha256;
  } else if (value.fixedInspectionDiagnosticSha256 !== undefined) {
    if (value.phase !== "FIXED_INSPECTION" || !sha(value.fixedInspectionDiagnosticSha256) || value.fixedInspectionDiagnosticOmittedForBudget !== true) return false;
    projected.fixedInspectionDiagnosticSha256 = value.fixedInspectionDiagnosticSha256; projected.fixedInspectionDiagnosticOmittedForBudget = true;
  }
  return canonical(projected) === canonical(value);
}

/** Diagnostics only. This shape is deliberately not a source-reference shape. */
export function readStagehandFailure(job, now = Date.now()) {
  const value = job.checkpoint?.stagehandFailure;
  if (!plain(value) || value.schemaVersion !== 1 || value.kind !== KIND || !Array.isArray(value.entries) || value.entries.length > 2 || !value.entries.length ||
      Object.keys(value).sort().join(",") !== "deadlineAt,entries,firstPickedUpAt,jobId,kind,requestSha256,schemaVersion,sourceFingerprint" ||
      Object.entries(binding(job)).some(([key, item]) => value[key] !== item) ||
      new Set(value.entries.map(entry => entry.attempt)).size !== value.entries.length ||
      !value.entries.every(entry => entry.attempt <= job.attempts && validEntry(entry, job, now)) || size(value) > LIMIT) return undefined;
  return structuredClone(value);
}

/** Keep the valid exact source reference. Optional diagnostics/progress can be
 * omitted with their digest; they are never a substitute for source authority. */
export function packStagehandCheckpoint({ reference, failure, progress }) {
  const value = { ...(reference ? { stagehandSource: structuredClone(reference) } : {}), ...(progress ? { stagehandProgress: structuredClone(progress) } : {}),
    ...(failure ? { stagehandFailure: structuredClone(failure) } : {}) };
  if (size(value) > LIMIT && value.stagehandProgress?.replay?.result?.diagnostic) {
    const result = value.stagehandProgress.replay.result;
    result.diagnosticSha256 = hash(result.diagnostic); result.diagnosticOmittedForBudget = true; delete result.diagnostic;
  }
  if (size(value) > LIMIT && value.stagehandFailure) for (const entry of value.stagehandFailure.entries) {
    if (entry.diagnostic) { delete entry.diagnostic; entry.diagnosticOmittedForBudget = true; }
    if (entry.fixedInspectionDiagnostic) { delete entry.fixedInspectionDiagnostic; entry.fixedInspectionDiagnosticOmittedForBudget = true; }
  }
  if (size(value) > LIMIT && value.stagehandProgress?.replay) value.stagehandProgress = {
    phase: value.stagehandProgress.phase, replayOmittedForBudget: true, replaySha256: hash(value.stagehandProgress.replay) };
  if (size(value) > LIMIT) throw discoveryError("STAGEHAND_SOURCE_CHECKPOINT_LIMIT");
  return value;
}

export function createStagehandFailureCheckpoint({ job, report, error, phase, metrics, reference, progress, previous, now = Date.now(), startedAt }) {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(job?.id ?? "") || !sha(job.sourceFingerprint) || ![1, 2].includes(job.attempts) ||
      !iso(job.firstPickedUpAt) || !iso(job.deadlineAt) || Date.parse(job.deadlineAt) - Date.parse(job.firstPickedUpAt) !== 900000) throw discoveryError("STAGEHAND_SOURCE_SCOPE_INVALID");
  if (reference) {
    const reconstructed = createStagehandSourceCheckpoint({ ...job, attempts: reference.attempt }, reference.report);
    if (canonical(reconstructed) !== canonical(reference)) throw discoveryError("STAGEHAND_SOURCE_RESUME_INVALID");
  }
  const diagnostic = projectSourceDiagnostic(report?.sourceDiagnostic ?? error?.sourceDiagnostic);
  const fixedInspectionDiagnostic = phase === "FIXED_INSPECTION" ? currentStagehandInspectionDiagnostic(error, job, startedAt, now) : undefined;
  const code = [error?.code, error?.message].find(value => codes.has(value)) ?? "STAGEHAND_WORKER_FAILED";
  const entry = { attempt: job.attempts, observedAt: new Date(now).toISOString(), phase: phases.has(phase) ? phase : "UNKNOWN", code,
    counts: { completedModelCalls: count(metrics?.modelCalls, 1000000), sourceElapsedMs: count(metrics?.sourceElapsedMs, 900000),
      workerElapsedMs: count(Math.max(0, now - startedAt), 900000), completedReplays: count(metrics?.replayDurationsMs?.length, 2) },
    tokenUsage: Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"].map(key => [key, count(metrics?.tokenUsage?.[key])])),
    cleanup: { sourceBrowserClosed: fact(report?.browserClosed), sourceModelClosed: fact(report?.modelClosed), inspectionBrowserClosed: fact(metrics?.inspection?.browserClosed) },
    sourceResumed: metrics?.sourceResumed === true,
    ...(diagnostic ? { diagnostic, diagnosticSha256: hash(diagnostic) } : {}),
    ...(fixedInspectionDiagnostic ? { fixedInspectionDiagnostic, fixedInspectionDiagnosticSha256: hash(fixedInspectionDiagnostic) } : {}) };
  if (!validEntry(entry, job, now)) throw discoveryError("STAGEHAND_SOURCE_SCOPE_INVALID");
  const prior = readStagehandFailure({ ...job, checkpoint: { stagehandFailure: previous } }, now);
  const entries = [...(prior?.entries ?? []).filter(value => value.attempt < job.attempts), entry].slice(-2);
  const failure = { schemaVersion: 1, kind: KIND, ...binding(job), entries };
  return packStagehandCheckpoint({ reference, failure, progress: progress ?? { phase: "FAILED" } });
}
