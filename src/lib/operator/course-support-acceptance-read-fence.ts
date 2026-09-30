export const ACCEPTANCE_READ_BOUNDARIES = Object.freeze([
  "QUERY_OPERATIONS", "TOP_LEVEL_ROWS", "INCIDENT_HISTORY_ROWS", "INCIDENT_HISTORY_GROUPS",
  "NESTED_PREFERENCE_ROWS", "VERIFICATION_REQUEST_ROWS", "IDENTITY_PLAN_DEPTH_OR_CYCLE",
  "IDENTITY_VALUE_BYTES", "IDENTITY_PRECOUNT_ITEMS", "IDENTITY_RESULT_ITEMS", "WHOLE_ROW_BYTES", "SELECTED_EVIDENCE_BYTES",
  "TRANSFER_DEPTH", "TRANSFER_ARRAY_ITEMS", "TRANSFER_BYTES", "COMBINED_FUTURE_ROWS", "OUTPUT_BYTES",
] as const);
export type AcceptanceReadBoundary = (typeof ACCEPTANCE_READ_BOUNDARIES)[number];

export const ACCEPTANCE_READ_PHASES = Object.freeze([
  "CAMPAIGN_INSPECTION", "LATEST_CAMPAIGN_RECORD", "FLEET", "FUTURE_CYCLES", "ROLLING_ENDPOINTS",
  "IMPLEMENTATION_HISTORY", "GLOBAL_PARKED_COUNT", "REPORT_CONSTRUCTION",
] as const);
export type AcceptanceReadPhase = (typeof ACCEPTANCE_READ_PHASES)[number];
export type AcceptanceReadFenceDetails = {
  readonly phase: AcceptanceReadPhase;
  readonly boundary: AcceptanceReadBoundary;
};

/** Only two fixed, own data fields are eligible for aggregate output. */
export function parseAcceptanceReadFenceDetails(value: unknown): AcceptanceReadFenceDetails | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("phase") || !keys.includes("boundary")) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    const phase: unknown = fields.phase.value;
    const boundary: unknown = fields.boundary.value;
    if (typeof phase !== "string" || !(ACCEPTANCE_READ_PHASES as readonly string[]).includes(phase) ||
        typeof boundary !== "string" || !(ACCEPTANCE_READ_BOUNDARIES as readonly string[]).includes(boundary)) return null;
    return Object.freeze({ phase: phase as AcceptanceReadPhase, boundary: boundary as AcceptanceReadBoundary });
  } catch {
    return null;
  }
}
