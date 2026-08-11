import type { Prisma } from "@prisma/client";

const ALERT_GENERATION_START_KIND = "ALERT_GENERATION_START";
const ALERT_GENERATION_STATUS_KIND = "ALERT_GENERATION_STATUS";
const ALERT_GENERATION_START_SCHEMA_VERSION = 1;

type AlertGenerationClock = {
  schemaVersion: typeof ALERT_GENERATION_START_SCHEMA_VERSION;
  alertGeneration: number;
  generationStartedAt: string;
};

type AlertGenerationStartMarker = AlertGenerationClock & {
  kind: typeof ALERT_GENERATION_START_KIND;
};

type AlertGenerationStatusEnvelope = AlertGenerationClock & {
  kind: typeof ALERT_GENERATION_STATUS_KIND;
  courseSnapshot: unknown;
};

export function buildAlertGenerationStartMarker(input: {
  alertGeneration: number;
  generationStartedAt?: Date;
}): Prisma.InputJsonObject {
  return {
    schemaVersion: ALERT_GENERATION_START_SCHEMA_VERSION,
    kind: ALERT_GENERATION_START_KIND,
    alertGeneration: input.alertGeneration,
    generationStartedAt: (
      input.generationStartedAt ?? new Date()
    ).toISOString(),
  };
}

export function readAlertGenerationStartedAt(input: {
  alertGeneration: number;
  createdAt: Date;
  statusEmailSnapshot: unknown;
}) {
  if (input.alertGeneration === 0) {
    return isValidDate(input.createdAt) ? input.createdAt : null;
  }

  const marker = parseAlertGenerationStartMarker(input.statusEmailSnapshot);
  if (!marker || marker.alertGeneration !== input.alertGeneration) {
    return null;
  }
  const startedAt = new Date(marker.generationStartedAt);
  return isValidDate(startedAt) ? startedAt : null;
}

export function preserveAlertGenerationClockInStatusSnapshot(input: {
  alertGeneration: number;
  currentStatusEmailSnapshot: unknown;
  courseSnapshot: Prisma.InputJsonValue;
}): Prisma.InputJsonValue {
  if (input.alertGeneration === 0) {
    return input.courseSnapshot;
  }
  const marker = parseAlertGenerationStartMarker(
    input.currentStatusEmailSnapshot,
  );
  if (!marker || marker.alertGeneration !== input.alertGeneration) {
    return input.courseSnapshot;
  }
  return {
    schemaVersion: ALERT_GENERATION_START_SCHEMA_VERSION,
    kind: ALERT_GENERATION_STATUS_KIND,
    alertGeneration: marker.alertGeneration,
    generationStartedAt: marker.generationStartedAt,
    courseSnapshot: input.courseSnapshot,
  };
}

export function unwrapAlertGenerationStatusSnapshot(value: unknown): unknown {
  const envelope = parseAlertGenerationStatusEnvelope(value);
  if (envelope) {
    return envelope.courseSnapshot;
  }
  return isStandaloneAlertGenerationStartMarker(value) ? null : value;
}

export function isAlertGenerationStartMarker(value: unknown) {
  return parseAlertGenerationStartMarker(value) !== null;
}

function parseAlertGenerationStartMarker(
  value: unknown,
): AlertGenerationStartMarker | null {
  const envelope = parseAlertGenerationStatusEnvelope(value);
  if (envelope) {
    return {
      schemaVersion: envelope.schemaVersion,
      kind: ALERT_GENERATION_START_KIND,
      alertGeneration: envelope.alertGeneration,
      generationStartedAt: envelope.generationStartedAt,
    };
  }
  return isStandaloneAlertGenerationStartMarker(value)
    ? (value as AlertGenerationStartMarker)
    : null;
}

function isStandaloneAlertGenerationStartMarker(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  return marker.schemaVersion === ALERT_GENERATION_START_SCHEMA_VERSION &&
    marker.kind === ALERT_GENERATION_START_KIND &&
    typeof marker.alertGeneration === "number" &&
    Number.isInteger(marker.alertGeneration) &&
    marker.alertGeneration > 0 &&
    typeof marker.generationStartedAt === "string"
    ? true
    : false;
}

function parseAlertGenerationStatusEnvelope(
  value: unknown,
): AlertGenerationStatusEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  return envelope.schemaVersion === ALERT_GENERATION_START_SCHEMA_VERSION &&
    envelope.kind === ALERT_GENERATION_STATUS_KIND &&
    typeof envelope.alertGeneration === "number" &&
    Number.isInteger(envelope.alertGeneration) &&
    envelope.alertGeneration > 0 &&
    typeof envelope.generationStartedAt === "string" &&
    Object.prototype.hasOwnProperty.call(envelope, "courseSnapshot")
    ? (envelope as AlertGenerationStatusEnvelope)
    : null;
}

function isValidDate(value: Date) {
  return Number.isFinite(value.getTime());
}
