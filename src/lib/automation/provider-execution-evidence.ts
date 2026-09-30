export const PROVIDER_EXECUTION_MARKERS = [
  "RUNNABLE_PROVIDER_CHECK",
  "LOCAL_BROWSER_READER",
] as const;

export type ProviderExecutionMarker =
  (typeof PROVIDER_EXECUTION_MARKERS)[number];

export const PROVIDER_EXECUTION_EVIDENCE_MAX_LAG_MS = 20 * 60_000;

const providerExecutionMarkers = new Set<string>(PROVIDER_EXECUTION_MARKERS);

export function isProviderExecutionMarker(
  value: unknown,
): value is ProviderExecutionMarker {
  return typeof value === "string" && providerExecutionMarkers.has(value);
}

export function getProviderExecutionEvidenceObservedAt(input: {
  rawSummary: unknown;
  probeObservedAt: Date;
}) {
  if (
    !(input.probeObservedAt instanceof Date) ||
    !Number.isFinite(input.probeObservedAt.getTime())
  ) {
    return null;
  }
  const summary = asRecord(input.rawSummary);
  if (!isProviderExecutionMarker(summary.providerExecution)) {
    return null;
  }
  const providerObservedAt = parseCanonicalTimestamp(
    summary.providerObservedAt,
  );
  if (!providerObservedAt) return null;
  const persistenceLagMs =
    input.probeObservedAt.getTime() - providerObservedAt.getTime();
  return persistenceLagMs >= 0 &&
    persistenceLagMs <= PROVIDER_EXECUTION_EVIDENCE_MAX_LAG_MS
    ? providerObservedAt
    : null;
}

function parseCanonicalTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
