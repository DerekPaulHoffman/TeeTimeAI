import { describe, expect, it } from "vitest";

import {
  createDeferredFailureHandoffAdmission,
  createDeferredFailureHandoffLegacySourceRecordDigest,
  createDeferredFailureHandoffSignal,
  parseDeferredFailureHandoffAdmission,
  parseDeferredFailureHandoffSignal,
} from "./course-support-deferred-failure-handoff";

const canonicalFailureFingerprint = "1".repeat(64);
const observedFailureFingerprint = "2".repeat(64);
const providerSnapshotFingerprint = "3".repeat(64);
const sourceBatchIncidentDigest = "4".repeat(64);
const sourceProofDigest = "5".repeat(64);
const courseRef = "6".repeat(64);
const runtimeVersion = "a".repeat(40);
const cooldownExpiresAt = "2026-08-21T14:30:00.000Z";
const providerNotBeforeAt = "2026-08-21T14:35:00.000Z";
const eligibleAt = providerNotBeforeAt;

const validSignalInput = {
  state: "AVAILABLE",
  sourceBatchIncidentDigest,
  sourceProofDigest,
  providerFamilyKey: "CHRONOGOLF",
  canonicalFailureFingerprint,
  observedFailureFingerprint,
  claimedProviderSnapshotFingerprint: providerSnapshotFingerprint,
  observedProviderSnapshotFingerprint: providerSnapshotFingerprint,
  runtimeVersion,
  cooldownExpiresAt,
  providerNotBeforeAt,
  eligibleAt,
  sourceVerificationWatchMode: "WATCH_SETTLED",
  sourceResult: "RETRY_SCHEDULED",
  sourceAttemptConsumed: true,
  confirmationStarted: false,
} as const satisfies Parameters<
  typeof createDeferredFailureHandoffSignal
>[0];

function createSignal(
  overrides: Partial<Parameters<typeof createDeferredFailureHandoffSignal>[0]> =
    {},
) {
  return createDeferredFailureHandoffSignal({
    ...validSignalInput,
    ...overrides,
  });
}

describe("deferred failure handoff signal", () => {
  it("round-trips a valid signal and its bound admission record", () => {
    const signal = createSignal();
    const admission = createDeferredFailureHandoffAdmission({
      signal,
      admittedAt: new Date(eligibleAt),
    });

    expect(parseDeferredFailureHandoffSignal(signal)).toEqual(signal);
    expect(parseDeferredFailureHandoffAdmission(admission)).toEqual(admission);
    expect(admission).toMatchObject({
      signalDigest: signal.signalDigest,
      sourceRecordDigest: signal.recordDigest,
      sourceBatchIncidentDigest: signal.sourceBatchIncidentDigest,
      admittedAt: eligibleAt,
      customerDataIncluded: false,
    });
  });

  it.each([
    ["signal digest", { signalDigest: "0".repeat(64) }],
    ["record digest", { recordDigest: "0".repeat(64) }],
  ])("rejects a tampered %s", (_label, tamper) => {
    expect(
      parseDeferredFailureHandoffSignal({ ...createSignal(), ...tamper }),
    ).toBeNull();
  });

  it.each([
    [
      "malformed SHA-256 provenance",
      { sourceProofDigest: "not-a-sha256" },
    ],
    ["malformed runtime SHA", { runtimeVersion: "A".repeat(40) }],
    [
      "non-canonical ISO timestamp",
      { cooldownExpiresAt: "2026-08-21T14:30:00Z" },
    ],
    [
      "identical canonical and observed failures",
      { observedFailureFingerprint: canonicalFailureFingerprint },
    ],
    [
      "provider snapshot drift",
      { observedProviderSnapshotFingerprint: "7".repeat(64) },
    ],
    [
      "eligibility before cooldown expiry",
      {
        providerNotBeforeAt: null,
        eligibleAt: "2026-08-21T14:29:59.999Z",
      },
    ],
    [
      "eligibility before the provider floor",
      { eligibleAt: "2026-08-21T14:34:59.999Z" },
    ],
  ] satisfies Array<
    [
      string,
      Partial<Parameters<typeof createDeferredFailureHandoffSignal>[0]>,
    ]
  >)("rejects %s even when its record digest is self-consistent", (_label, overrides) => {
    expect(parseDeferredFailureHandoffSignal(createSignal(overrides))).toBeNull();
  });

  it("strictly rejects malformed admission hashes and timestamps", () => {
    const signal = createSignal();
    const admission = createDeferredFailureHandoffAdmission({
      signal,
      admittedAt: new Date(eligibleAt),
    });

    expect(
      parseDeferredFailureHandoffAdmission({
        ...admission,
        sourceRecordDigest: "not-a-sha256",
      }),
    ).toBeNull();
    expect(
      parseDeferredFailureHandoffAdmission({
        ...admission,
        admittedAt: "2026-08-21T14:35:00Z",
      }),
    ).toBeNull();
  });

  it("rejects unknown or privacy-unsafe provenance fields", () => {
    const signal = createSignal();
    const admission = createDeferredFailureHandoffAdmission({
      signal,
      admittedAt: new Date(eligibleAt),
    });

    expect(
      parseDeferredFailureHandoffSignal({
        ...signal,
        rawCourseId: "course-123",
      }),
    ).toBeNull();
    expect(
      parseDeferredFailureHandoffSignal(
        createSignal({ providerFamilyKey: "https://provider.example/course" }),
      ),
    ).toBeNull();
    expect(
      parseDeferredFailureHandoffAdmission({
        ...admission,
        rawBatchIncidentId: "entry-1",
      }),
    ).toBeNull();
  });
});

describe("legacy deferred failure source record digest", () => {
  const privacySafeInput = {
    sourceBatchIncidentDigest,
    sourceProofDigest,
    courseRef,
    providerFamilyKey: "CHRONOGOLF",
    canonicalFailureFingerprint,
    observedFailureFingerprint,
    providerSnapshotFingerprint,
    runtimeVersion,
    cooldownExpiresAt,
    providerNotBeforeAt,
    sourceVerificationWatchMode: "WATCH_SETTLED",
    sourceResult: "RETRY_SCHEDULED",
    sourceBatchStatus: "RETRYABLE_FAILED",
    sourceDerivedOutcome: "retryable_failed",
    sourceAttemptConsumed: true,
  } as const satisfies Parameters<
    typeof createDeferredFailureHandoffLegacySourceRecordDigest
  >[0];

  it("is deterministic for the stable privacy-safe provenance projection", () => {
    const first = createDeferredFailureHandoffLegacySourceRecordDigest(
      privacySafeInput,
    );
    const second = createDeferredFailureHandoffLegacySourceRecordDigest({
      ...privacySafeInput,
    });

    expect(first).toBe(
      "d19fb785c4164a2bef34f6594948d4664ce02bebe58e45ffd3896281ba6586c9",
    );
    expect(second).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("changes when provenance changes and exposes no raw identity or URL", () => {
    const digest = createDeferredFailureHandoffLegacySourceRecordDigest(
      privacySafeInput,
    );
    const changed = createDeferredFailureHandoffLegacySourceRecordDigest({
      ...privacySafeInput,
      courseRef: "7".repeat(64),
    });
    const persistedProjection = JSON.stringify({
      recordDigest: digest,
      courseRef: privacySafeInput.courseRef,
      customerDataIncluded: false,
    });

    expect(changed).not.toBe(digest);
    expect(persistedProjection).not.toContain("course-123");
    expect(persistedProjection).not.toContain("https://");
    expect(persistedProjection).toContain('"customerDataIncluded":false');
  });
});
