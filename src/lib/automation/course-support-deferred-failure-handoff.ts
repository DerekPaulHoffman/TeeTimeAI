import { createHash } from "node:crypto";

export const DEFERRED_FAILURE_HANDOFF_KIND =
  "FAILURE_ONLY_COOLDOWN_EXHAUSTED_CONFIRMATION" as const;

export type DeferredFailureHandoffState = "AVAILABLE" | "CONSUMED";

export type DeferredFailureHandoffSignal = {
  schemaVersion: 1;
  kind: typeof DEFERRED_FAILURE_HANDOFF_KIND;
  state: DeferredFailureHandoffState;
  signalDigest: string;
  recordDigest: string;
  sourceBatchIncidentDigest: string;
  sourceProofDigest: string;
  providerFamilyKey: string;
  canonicalFailureFingerprint: string;
  observedFailureFingerprint: string;
  claimedProviderSnapshotFingerprint: string;
  observedProviderSnapshotFingerprint: string;
  runtimeVersion: string;
  cooldownExpiresAt: string;
  providerNotBeforeAt: string | null;
  eligibleAt: string;
  sourceVerificationWatchMode: "WATCH_SETTLED";
  sourceResult: "RETRY_SCHEDULED" | "NEEDS_HUMAN";
  sourceAttemptConsumed: true;
  confirmationStarted: boolean;
  customerDataIncluded: false;
};

export type DeferredFailureHandoffAdmission = {
  schemaVersion: 1;
  kind: "DEFERRED_FAILURE_HANDOFF_ADMISSION";
  signalDigest: string;
  sourceRecordDigest: string;
  sourceBatchIncidentDigest: string;
  admittedAt: string;
  customerDataIncluded: false;
};

type CreateDeferredFailureHandoffSignalInput = Omit<
  DeferredFailureHandoffSignal,
  | "schemaVersion"
  | "kind"
  | "signalDigest"
  | "recordDigest"
  | "customerDataIncluded"
>;

const HEX_64 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const PROVIDER_FAMILY_KEY = /^[A-Za-z0-9._:-]{1,253}$/u;
const SIGNAL_KEYS = new Set([
  "schemaVersion",
  "kind",
  "state",
  "signalDigest",
  "recordDigest",
  "sourceBatchIncidentDigest",
  "sourceProofDigest",
  "providerFamilyKey",
  "canonicalFailureFingerprint",
  "observedFailureFingerprint",
  "claimedProviderSnapshotFingerprint",
  "observedProviderSnapshotFingerprint",
  "runtimeVersion",
  "cooldownExpiresAt",
  "providerNotBeforeAt",
  "eligibleAt",
  "sourceVerificationWatchMode",
  "sourceResult",
  "sourceAttemptConsumed",
  "confirmationStarted",
  "customerDataIncluded",
]);
const ADMISSION_KEYS = new Set([
  "schemaVersion",
  "kind",
  "signalDigest",
  "sourceRecordDigest",
  "sourceBatchIncidentDigest",
  "admittedAt",
  "customerDataIncluded",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strictIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(record: Record<string, unknown>, keys: Set<string>) {
  const actual = Object.keys(record);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

export function createDeferredFailureHandoffSourceProofDigest(input: {
  kind: string;
  status: string;
  outcome: string;
  failureClass: string;
  observedAt: string;
  runtimeVersion: string;
  providerExecution: boolean;
  providerSnapshotFingerprint: string;
  completedAt: string | null;
  nextAttemptAt: string | null;
  providerRetryNotBeforeAt: string | null;
}) {
  return sha256(
    JSON.stringify({
      kind: input.kind,
      status: input.status,
      outcome: input.outcome,
      failureClass: input.failureClass,
      observedAt: input.observedAt,
      runtimeVersion: input.runtimeVersion,
      providerExecution: input.providerExecution,
      providerSnapshotFingerprint: input.providerSnapshotFingerprint,
      completedAt: input.completedAt,
      nextAttemptAt: input.nextAttemptAt,
      providerRetryNotBeforeAt: input.providerRetryNotBeforeAt,
    }),
  );
}

function createSignalDigest(
  input: Omit<
    CreateDeferredFailureHandoffSignalInput,
    "state" | "confirmationStarted" | "eligibleAt"
  >,
) {
  return sha256(
    JSON.stringify({
      kind: DEFERRED_FAILURE_HANDOFF_KIND,
      sourceProofDigest: input.sourceProofDigest,
      providerFamilyKey: input.providerFamilyKey,
      canonicalFailureFingerprint: input.canonicalFailureFingerprint,
      observedFailureFingerprint: input.observedFailureFingerprint,
      claimedProviderSnapshotFingerprint:
        input.claimedProviderSnapshotFingerprint,
      observedProviderSnapshotFingerprint:
        input.observedProviderSnapshotFingerprint,
      runtimeVersion: input.runtimeVersion,
      cooldownExpiresAt: input.cooldownExpiresAt,
      providerNotBeforeAt: input.providerNotBeforeAt,
      sourceVerificationWatchMode: input.sourceVerificationWatchMode,
      sourceResult: input.sourceResult,
      sourceAttemptConsumed: input.sourceAttemptConsumed,
    }),
  );
}

function createRecordDigest(
  input: Omit<DeferredFailureHandoffSignal, "recordDigest">,
) {
  return sha256(JSON.stringify(input));
}

export function createDeferredFailureHandoffSignal(
  input: CreateDeferredFailureHandoffSignalInput,
): DeferredFailureHandoffSignal {
  const base = {
    schemaVersion: 1 as const,
    kind: DEFERRED_FAILURE_HANDOFF_KIND,
    state: input.state,
    signalDigest: createSignalDigest(input),
    sourceBatchIncidentDigest: input.sourceBatchIncidentDigest,
    sourceProofDigest: input.sourceProofDigest,
    providerFamilyKey: input.providerFamilyKey,
    canonicalFailureFingerprint: input.canonicalFailureFingerprint,
    observedFailureFingerprint: input.observedFailureFingerprint,
    claimedProviderSnapshotFingerprint:
      input.claimedProviderSnapshotFingerprint,
    observedProviderSnapshotFingerprint:
      input.observedProviderSnapshotFingerprint,
    runtimeVersion: input.runtimeVersion,
    cooldownExpiresAt: input.cooldownExpiresAt,
    providerNotBeforeAt: input.providerNotBeforeAt,
    eligibleAt: input.eligibleAt,
    sourceVerificationWatchMode: input.sourceVerificationWatchMode,
    sourceResult: input.sourceResult,
    sourceAttemptConsumed: input.sourceAttemptConsumed,
    confirmationStarted: input.confirmationStarted,
    customerDataIncluded: false as const,
  };
  return { ...base, recordDigest: createRecordDigest(base) };
}

export function parseDeferredFailureHandoffSignal(
  value: unknown,
): DeferredFailureHandoffSignal | null {
  const record = asRecord(value);
  const cooldownExpiresAt = strictIso(record.cooldownExpiresAt);
  const providerNotBeforeAt =
    record.providerNotBeforeAt === null
      ? null
      : strictIso(record.providerNotBeforeAt);
  const eligibleAt = strictIso(record.eligibleAt);
  if (
    !hasExactKeys(record, SIGNAL_KEYS) ||
    record.schemaVersion !== 1 ||
    record.kind !== DEFERRED_FAILURE_HANDOFF_KIND ||
    (record.state !== "AVAILABLE" && record.state !== "CONSUMED") ||
    typeof record.signalDigest !== "string" ||
    !HEX_64.test(record.signalDigest) ||
    typeof record.recordDigest !== "string" ||
    !HEX_64.test(record.recordDigest) ||
    typeof record.sourceBatchIncidentDigest !== "string" ||
    !HEX_64.test(record.sourceBatchIncidentDigest) ||
    typeof record.sourceProofDigest !== "string" ||
    !HEX_64.test(record.sourceProofDigest) ||
    typeof record.providerFamilyKey !== "string" ||
    !PROVIDER_FAMILY_KEY.test(record.providerFamilyKey) ||
    typeof record.canonicalFailureFingerprint !== "string" ||
    !HEX_64.test(record.canonicalFailureFingerprint) ||
    typeof record.observedFailureFingerprint !== "string" ||
    !HEX_64.test(record.observedFailureFingerprint) ||
    record.canonicalFailureFingerprint === record.observedFailureFingerprint ||
    typeof record.claimedProviderSnapshotFingerprint !== "string" ||
    !HEX_64.test(record.claimedProviderSnapshotFingerprint) ||
    typeof record.observedProviderSnapshotFingerprint !== "string" ||
    !HEX_64.test(record.observedProviderSnapshotFingerprint) ||
    record.claimedProviderSnapshotFingerprint !==
      record.observedProviderSnapshotFingerprint ||
    typeof record.runtimeVersion !== "string" ||
    !GIT_SHA.test(record.runtimeVersion) ||
    !cooldownExpiresAt ||
    (record.providerNotBeforeAt !== null && !providerNotBeforeAt) ||
    !eligibleAt ||
    new Date(eligibleAt).getTime() < new Date(cooldownExpiresAt).getTime() ||
    (providerNotBeforeAt !== null &&
      new Date(eligibleAt).getTime() < new Date(providerNotBeforeAt).getTime()) ||
    record.sourceVerificationWatchMode !== "WATCH_SETTLED" ||
    (record.sourceResult !== "RETRY_SCHEDULED" &&
      record.sourceResult !== "NEEDS_HUMAN") ||
    record.sourceAttemptConsumed !== true ||
    typeof record.confirmationStarted !== "boolean" ||
    record.customerDataIncluded !== false
  ) {
    return null;
  }
  const parsed = record as DeferredFailureHandoffSignal;
  const expected = createDeferredFailureHandoffSignal({
    state: parsed.state,
    sourceBatchIncidentDigest: parsed.sourceBatchIncidentDigest,
    sourceProofDigest: parsed.sourceProofDigest,
    providerFamilyKey: parsed.providerFamilyKey,
    canonicalFailureFingerprint: parsed.canonicalFailureFingerprint,
    observedFailureFingerprint: parsed.observedFailureFingerprint,
    claimedProviderSnapshotFingerprint:
      parsed.claimedProviderSnapshotFingerprint,
    observedProviderSnapshotFingerprint:
      parsed.observedProviderSnapshotFingerprint,
    runtimeVersion: parsed.runtimeVersion,
    cooldownExpiresAt: parsed.cooldownExpiresAt,
    providerNotBeforeAt: parsed.providerNotBeforeAt,
    eligibleAt: parsed.eligibleAt,
    sourceVerificationWatchMode: "WATCH_SETTLED",
    sourceResult: parsed.sourceResult,
    sourceAttemptConsumed: true,
    confirmationStarted: parsed.confirmationStarted,
  });
  return expected.signalDigest === parsed.signalDigest &&
    expected.recordDigest === parsed.recordDigest
    ? parsed
    : null;
}

export function createDeferredFailureHandoffAdmission(input: {
  signal: DeferredFailureHandoffSignal;
  admittedAt: Date;
}): DeferredFailureHandoffAdmission {
  return {
    schemaVersion: 1,
    kind: "DEFERRED_FAILURE_HANDOFF_ADMISSION",
    signalDigest: input.signal.signalDigest,
    sourceRecordDigest: input.signal.recordDigest,
    sourceBatchIncidentDigest: input.signal.sourceBatchIncidentDigest,
    admittedAt: input.admittedAt.toISOString(),
    customerDataIncluded: false,
  };
}

export function parseDeferredFailureHandoffAdmission(
  value: unknown,
): DeferredFailureHandoffAdmission | null {
  const record = asRecord(value);
  return hasExactKeys(record, ADMISSION_KEYS) &&
    record.schemaVersion === 1 &&
    record.kind === "DEFERRED_FAILURE_HANDOFF_ADMISSION" &&
    typeof record.signalDigest === "string" &&
    HEX_64.test(record.signalDigest) &&
    typeof record.sourceRecordDigest === "string" &&
    HEX_64.test(record.sourceRecordDigest) &&
    typeof record.sourceBatchIncidentDigest === "string" &&
    HEX_64.test(record.sourceBatchIncidentDigest) &&
    strictIso(record.admittedAt) !== null &&
    record.customerDataIncluded === false
    ? (record as DeferredFailureHandoffAdmission)
    : null;
}

export function createDeferredFailureHandoffBatchIncidentDigest(id: string) {
  return sha256(`course-support-batch-incident:${id}`);
}

export function createDeferredFailureHandoffLegacySourceRecordDigest(input: {
  sourceBatchIncidentDigest: string;
  sourceProofDigest: string;
  courseRef: string;
  providerFamilyKey: string;
  canonicalFailureFingerprint: string;
  observedFailureFingerprint: string;
  providerSnapshotFingerprint: string;
  runtimeVersion: string;
  cooldownExpiresAt: string;
  providerNotBeforeAt: string | null;
  sourceVerificationWatchMode: "WATCH_SETTLED";
  sourceResult: "RETRY_SCHEDULED" | "NEEDS_HUMAN";
  sourceBatchStatus: "RETRYABLE_FAILED" | "PARTIAL";
  sourceDerivedOutcome: "retryable_failed" | "needs_human";
  sourceAttemptConsumed: true;
}) {
  return sha256(
    JSON.stringify({
      kind: "LEGACY_FAILURE_ONLY_COOLDOWN_SOURCE",
      sourceBatchIncidentDigest: input.sourceBatchIncidentDigest,
      sourceProofDigest: input.sourceProofDigest,
      courseRef: input.courseRef,
      providerFamilyKey: input.providerFamilyKey,
      canonicalFailureFingerprint: input.canonicalFailureFingerprint,
      observedFailureFingerprint: input.observedFailureFingerprint,
      providerSnapshotFingerprint: input.providerSnapshotFingerprint,
      runtimeVersion: input.runtimeVersion,
      cooldownExpiresAt: input.cooldownExpiresAt,
      providerNotBeforeAt: input.providerNotBeforeAt,
      sourceVerificationWatchMode: input.sourceVerificationWatchMode,
      sourceResult: input.sourceResult,
      sourceBatchStatus: input.sourceBatchStatus,
      sourceDerivedOutcome: input.sourceDerivedOutcome,
      sourceAttemptConsumed: input.sourceAttemptConsumed,
    }),
  );
}
