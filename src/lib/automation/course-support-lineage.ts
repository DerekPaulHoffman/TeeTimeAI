/** Private mutation provenance, never monitoring proof or native usage authority. */
export const COURSE_SUPPORT_LINEAGE_EVENT_LIMIT = 128;

type LineageKind =
  | "CLAIM"
  | "RECOVERY_TRANSFER"
  | "RECOVERY_FENCE_ADOPTION"
  | "RECOVERY_CLOSEOUT"
  | "OWNER_CLOSEOUT"
  | "SYSTEM_CLOSEOUT"
  | "RESEARCH_ASSIGNMENT";

export type CourseSupportLineageEventInput = {
  kind: LineageKind;
  actorThreadId: string | null;
  ownerThreadId: string | null;
  previousOwnerThreadId?: string | null;
  specialistThreadId?: string;
  ordinal?: number;
  incidentCycle?: number;
  contextDigest?: string;
};

export type CourseSupportLineageEvent = CourseSupportLineageEventInput & {
  sequence: number;
  ownerEpoch: number;
  observedAt: string;
};

export type CourseSupportOwnershipLineageV1 = {
  schemaVersion: 1;
  completeness:
    | "COMPLETE_FROM_CLAIM"
    | "LEGACY_INCOMPLETE"
    | "INVALID_EVENT_INCOMPLETE"
    | "OVERFLOW_INCOMPLETE";
  originalAutomationRunId: string | null;
  omittedEventCount: number;
  events: CourseSupportLineageEvent[];
};

const eventKeys = new Set([
  "kind", "actorThreadId", "ownerThreadId", "previousOwnerThreadId",
  "specialistThreadId", "ordinal", "incidentCycle", "contextDigest",
  "sequence", "ownerEpoch", "observedAt"
]);
const lineageKeys = new Set(["schemaVersion", "completeness", "originalAutomationRunId", "omittedEventCount", "events"]);
const kinds = new Set<LineageKind>([
  "CLAIM", "RECOVERY_TRANSFER", "RECOVERY_FENCE_ADOPTION",
  "RECOVERY_CLOSEOUT", "OWNER_CLOSEOUT", "SYSTEM_CLOSEOUT", "RESEARCH_ASSIGNMENT"
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isCourseSupportLineageThreadRef(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && (
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value) ||
    /^\/root(?:\/[a-z0-9_]+){1,8}$/.test(value)
  );
}

const validRef = isCourseSupportLineageThreadRef;

function validEvent(value: unknown): value is CourseSupportLineageEvent {
  const event = record(value);
  if (!event || Object.keys(event).some(key => !eventKeys.has(key)) ||
      !kinds.has(event.kind as LineageKind) || !(event.ownerThreadId === null || validRef(event.ownerThreadId)) ||
      !(event.actorThreadId === null || validRef(event.actorThreadId)) ||
      !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1 ||
      !Number.isSafeInteger(event.ownerEpoch) || Number(event.ownerEpoch) < 0 ||
      typeof event.observedAt !== "string" ||
      !Number.isFinite(Date.parse(event.observedAt)) ||
      new Date(event.observedAt).toISOString() !== event.observedAt) return false;
  if (event.kind === "SYSTEM_CLOSEOUT" ? event.actorThreadId !== null : event.actorThreadId === null) return false;
  if (["CLAIM", "OWNER_CLOSEOUT", "RECOVERY_TRANSFER", "RESEARCH_ASSIGNMENT"].includes(String(event.kind)) &&
      event.actorThreadId !== event.ownerThreadId) return false;
  if (event.kind === "RECOVERY_TRANSFER") {
    if (!(event.previousOwnerThreadId === null || validRef(event.previousOwnerThreadId))) return false;
  } else if (event.previousOwnerThreadId !== undefined) return false;
  if (event.kind === "RESEARCH_ASSIGNMENT") {
    if (!validRef(event.specialistThreadId) || event.specialistThreadId === event.ownerThreadId ||
        !Number.isSafeInteger(event.ordinal) || Number(event.ordinal) < 1 || Number(event.ordinal) > 20 ||
        !Number.isSafeInteger(event.incidentCycle) || Number(event.incidentCycle) < 1 ||
        typeof event.contextDigest !== "string" || !/^[a-f0-9]{64}$/.test(event.contextDigest)) return false;
  } else if (["specialistThreadId", "ordinal", "incidentCycle", "contextDigest"].some(key => event[key] !== undefined)) return false;
  return true;
}

/** Malformed history stays unavailable; missing history must never be backfilled as complete. */
export function readCourseSupportLineage(summary: unknown): CourseSupportOwnershipLineageV1 | null {
  const lineage = record(record(summary)?.ownershipLineageV1);
  if (!lineage || Object.keys(lineage).some(key => !lineageKeys.has(key)) || lineage.schemaVersion !== 1 ||
      !["COMPLETE_FROM_CLAIM", "LEGACY_INCOMPLETE", "INVALID_EVENT_INCOMPLETE", "OVERFLOW_INCOMPLETE"].includes(String(lineage.completeness)) ||
      !(lineage.originalAutomationRunId === null || validRef(lineage.originalAutomationRunId)) ||
      !Number.isSafeInteger(lineage.omittedEventCount) || Number(lineage.omittedEventCount) < 0 ||
      !Array.isArray(lineage.events) || lineage.events.length > COURSE_SUPPORT_LINEAGE_EVENT_LIMIT ||
      !lineage.events.every(validEvent)) return null;
  const events = lineage.events as CourseSupportLineageEvent[];
  if (lineage.completeness === "INVALID_EVENT_INCOMPLETE") {
    if (Number(lineage.omittedEventCount) < 1) return null;
    if (events.length === 0) return lineage as unknown as CourseSupportOwnershipLineageV1;
  } else if (events.length === 0) return null;
  const first = events[0];
  if (first.kind === "CLAIM" ?
      first.ownerEpoch !== 1 || !validRef(lineage.originalAutomationRunId) :
      lineage.originalAutomationRunId !== null) return null;
  if (lineage.completeness === "COMPLETE_FROM_CLAIM" &&
      (first.kind !== "CLAIM" || first.ownerEpoch !== 1 || !validRef(lineage.originalAutomationRunId) || lineage.omittedEventCount !== 0)) return null;
  if (lineage.completeness === "LEGACY_INCOMPLETE" &&
      (first.kind === "CLAIM" || lineage.originalAutomationRunId !== null || lineage.omittedEventCount !== 0)) return null;
  if (lineage.completeness === "OVERFLOW_INCOMPLETE" &&
      (events.length !== COURSE_SUPPORT_LINEAGE_EVENT_LIMIT || Number(lineage.omittedEventCount) < 1)) return null;
  let owner = first.kind === "RECOVERY_TRANSFER" ? first.previousOwnerThreadId : first.ownerThreadId;
  let epoch = first.kind === "CLAIM" ? 1 : 0;
  let closed = false;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || (index > 0 && event.kind === "CLAIM") || closed ||
        (index > 0 && event.observedAt < events[index - 1].observedAt)) return null;
    if (event.kind === "RECOVERY_TRANSFER") {
      if (event.previousOwnerThreadId !== owner) return null;
      epoch += 1;
      owner = event.ownerThreadId;
    }
    if (event.ownerThreadId !== owner || event.ownerEpoch !== epoch) return null;
    closed = ["OWNER_CLOSEOUT", "SYSTEM_CLOSEOUT", "RECOVERY_CLOSEOUT"].includes(event.kind);
  }
  return lineage as unknown as CourseSupportOwnershipLineageV1;
}

export function createCourseSupportLineage(originalAutomationRunId: string, ownerThreadId: string, now: Date): CourseSupportOwnershipLineageV1 {
  if (!validRef(originalAutomationRunId) || !validRef(ownerThreadId) || !Number.isFinite(now.getTime())) return {
    schemaVersion: 1, completeness: "INVALID_EVENT_INCOMPLETE",
    originalAutomationRunId: validRef(originalAutomationRunId) ? originalAutomationRunId : null,
    omittedEventCount: 1, events: [],
  };
  return {
    schemaVersion: 1,
    completeness: "COMPLETE_FROM_CLAIM",
    originalAutomationRunId,
    omittedEventCount: 0,
    events: [{ kind: "CLAIM", actorThreadId: ownerThreadId, ownerThreadId,
      sequence: 1, ownerEpoch: 1, observedAt: now.toISOString() }]
  };
}

/** Called inside the existing successful mutation CAS/transaction, never as a separate write. */
export function appendCourseSupportLineage(summary: Record<string, unknown>, input: CourseSupportLineageEventInput, now: Date): Record<string, unknown> {
  const previous = readCourseSupportLineage(summary);
  // Preserve malformed evidence verbatim instead of erasing it or inventing a valid history.
  if (!previous && summary.ownershipLineageV1 !== undefined) return { ...summary };
  const lineage: CourseSupportOwnershipLineageV1 = previous ?? {
    schemaVersion: 1, completeness: "LEGACY_INCOMPLETE",
    originalAutomationRunId: null, omittedEventCount: 0, events: []
  };
  const invalidEvent = () => ({
    ...summary,
    ownershipLineageV1: {
      ...lineage, completeness: "INVALID_EVENT_INCOMPLETE",
      omittedEventCount: lineage.omittedEventCount + 1,
    },
  });
  // Keep every known valid event and mark the gap; never preserve COMPLETE after
  // dropping an actual mutation, and never retain invalid input in the history.
  if (lineage.completeness === "INVALID_EVENT_INCOMPLETE" || !Number.isFinite(now.getTime())) return invalidEvent();
  if (lineage.events.length === COURSE_SUPPORT_LINEAGE_EVENT_LIMIT) return {
    ...summary,
    ownershipLineageV1: { ...lineage, completeness: "OVERFLOW_INCOMPLETE", omittedEventCount: lineage.omittedEventCount + 1 }
  };
  const last = lineage.events.at(-1);
  const next = {
    ...lineage,
    events: [...lineage.events, { ...input, sequence: lineage.events.length + 1,
      ownerEpoch: (last?.ownerEpoch ?? 0) + (input.kind === "RECOVERY_TRANSFER" ? 1 : 0),
      observedAt: now.toISOString() }]
  };
  const candidate = { ...summary, ownershipLineageV1: next };
  return readCourseSupportLineage(candidate) ? candidate : invalidEvent();
}
