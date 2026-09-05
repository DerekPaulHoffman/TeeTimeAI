const EVIDENCE_REFRESH_MESSAGES = {
  INCIDENT_VERIFICATION_STALE:
    "A course-support incident changed after verification.",
  DETACHED_REQUEST_ACTIVE:
    "Detached provider verification is still active; rerun verification before closeout.",
  DETACHED_REQUEST_PENDING:
    "Detached provider verification is still pending; rerun verification before closeout.",
  DETACHED_CONTINUATION_PENDING:
    "Detached provider verification continuation is still pending; rerun verification before closeout.",
  DETACHED_SUCCESS_UNCONSUMED:
    "Detached provider verification completed after the last evidence read; rerun verification before closeout.",
  DETACHED_FAILURE_UNCONSUMED:
    "Detached provider failure changed after the last evidence read; rerun verification before closeout.",
  DETACHED_COOLDOWN_UNCONSUMED:
    "Detached provider cooldown evidence has not been recorded; rerun verification before closeout.",
} as const;

export type CourseSupportEvidenceRefreshReason =
  keyof typeof EVIDENCE_REFRESH_MESSAGES;

export function isCourseSupportEvidenceRefreshReason(
  value: unknown,
): value is CourseSupportEvidenceRefreshReason {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(EVIDENCE_REFRESH_MESSAGES, value)
  );
}

// Only an explicit freshness guard may request another verification pass.
// Similar-looking error messages, invalid evidence, and ownership failures
// must not acquire retry authority through text classification.
export class CourseSupportEvidenceRefreshRequiredError extends Error {
  readonly reason: CourseSupportEvidenceRefreshReason;

  constructor(reason: CourseSupportEvidenceRefreshReason) {
    super(EVIDENCE_REFRESH_MESSAGES[reason]);
    this.name = "CourseSupportEvidenceRefreshRequiredError";
    this.reason = reason;
  }
}

export function getCourseSupportEvidenceRefreshReason(
  error: unknown,
): CourseSupportEvidenceRefreshReason | null {
  return error instanceof CourseSupportEvidenceRefreshRequiredError &&
    isCourseSupportEvidenceRefreshReason(error.reason)
    ? error.reason
    : null;
}
