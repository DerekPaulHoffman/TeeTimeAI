export const COURSE_SUPPORT_RESPONDER_AUTOMATION_ID =
  "tee-time-spot-course-support-responder";
export const COURSE_SUPPORT_RESPONDER_PROMPT_VERSION =
  "tee-time-spot-course-support-responder-v2";

export const COURSE_SUPPORT_BATCH_DEFAULT_SIZE = 5;
export const COURSE_SUPPORT_BATCH_MAX_SIZE = 20;
export const COURSE_SUPPORT_BATCH_LEASE_MS = 15 * 60 * 1000;
export const COURSE_SUPPORT_SYNTHETIC_AGING_MS = 24 * 60 * 60 * 1000;
export const COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW = 3;
export const COURSE_SUPPORT_ENGINEERING_SWEEP_MINUTE_WINDOW = 10;

export type ResponderOutcome =
  | "ready"
  | "resume_owned_work"
  | "recovery_required"
  | "no_due_work"
  | "deferred_busy"
  | "deferred_engineering_cadence"
  | "success"
  | "classification_only"
  | "partial"
  | "retryable_failed"
  | "needs_human"
  | "blocked_auth"
  | "blocked_env"
  | "blocked_git"
  | "migration_failed"
  | "deploy_failed"
  | "production_verification_failed"
  | "privacy_incident"
  | "delivery_incident"
  | "unsafe_provider"
  | "repeated_sla_failure"
  | "command_failed";

export type ResponderFailureDomain =
  | "NONE"
  | "PRIVACY"
  | "DELIVERY"
  | "UNSAFE_PROVIDER"
  | "MIGRATION"
  | "DEPLOYMENT"
  | "PRODUCTION_VERIFICATION"
  | "AUTH"
  | "ENV"
  | "GIT"
  | "SLA";

export type ResponderThreadPolicy = {
  threadDisposition: "ARCHIVE" | "KEEP_VISIBLE";
  archiveReason: string;
};

const ALWAYS_VISIBLE_OUTCOMES = new Set<ResponderOutcome>([
  "ready",
  "resume_owned_work",
  "recovery_required",
  "needs_human",
  "blocked_auth",
  "blocked_env",
  "blocked_git",
  "migration_failed",
  "deploy_failed",
  "production_verification_failed",
  "privacy_incident",
  "delivery_incident",
  "unsafe_provider",
  "repeated_sla_failure",
  "command_failed"
]);

const ALWAYS_VISIBLE_DOMAINS = new Set<ResponderFailureDomain>([
  "PRIVACY",
  "DELIVERY",
  "UNSAFE_PROVIDER",
  "MIGRATION",
  "DEPLOYMENT",
  "PRODUCTION_VERIFICATION",
  "AUTH",
  "ENV",
  "GIT",
  "SLA"
]);

export function getResponderThreadPolicy(input: {
  outcome: ResponderOutcome;
  failureDomain?: ResponderFailureDomain;
  nextAttemptAt?: Date | string | null;
  now?: Date;
  requiresHuman?: boolean;
  repeatedSlaFailure?: boolean;
  durableCloseoutRecorded?: boolean;
}): ResponderThreadPolicy {
  if (input.durableCloseoutRecorded === false) {
    return {
      threadDisposition: "KEEP_VISIBLE",
      archiveReason: "Durable responder closeout was not recorded."
    };
  }

  if (
    input.requiresHuman ||
    input.repeatedSlaFailure ||
    ALWAYS_VISIBLE_OUTCOMES.has(input.outcome) ||
    ALWAYS_VISIBLE_DOMAINS.has(input.failureDomain ?? "NONE")
  ) {
    return {
      threadDisposition: "KEEP_VISIBLE",
      archiveReason: "The responder result requires owner visibility."
    };
  }

  if (
    input.outcome === "retryable_failed" &&
    !isValidFutureAttempt(input.nextAttemptAt, input.now)
  ) {
    return {
      threadDisposition: "KEEP_VISIBLE",
      archiveReason: "Retryable failure has no persisted future retry time."
    };
  }

  return {
    threadDisposition: "ARCHIVE",
    archiveReason:
      input.outcome === "no_due_work"
        ? "No course-support work is due."
        : input.outcome === "deferred_busy"
          ? "Another durable course-support writer owns the responder lane."
          : input.outcome === "deferred_engineering_cadence"
            ? "Only non-customer work is due, and the bounded engineering sweep is not due yet."
          : "The responder result is durably closed and needs no owner action."
  };
}

export function isCourseSupportEngineeringSweepDue(now = new Date()) {
  return now.getUTCMinutes() < COURSE_SUPPORT_ENGINEERING_SWEEP_MINUTE_WINDOW;
}

export function clampCourseSupportBatchSize(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return COURSE_SUPPORT_BATCH_DEFAULT_SIZE;
  }
  return Math.min(
    COURSE_SUPPORT_BATCH_MAX_SIZE,
    Math.max(1, Math.trunc(value ?? COURSE_SUPPORT_BATCH_DEFAULT_SIZE))
  );
}

export function sanitizeResponderText(value: string) {
  const redactUrl = (rawUrl: string) => {
    try {
      const parsed = new URL(rawUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return "[redacted-url]";
      }
      return parsed.origin;
    } catch {
      return "[redacted-url]";
    }
  };

  return value
    .replace(/\b(?:postgres(?:ql)?):\/\/[^\s<>'"]+/gi, "[redacted-database-url]")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, redactUrl)
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, separator, name) =>
      isSensitiveName(name)
        ? `${separator}${name}=[redacted]`
        : match
    )
    .replace(/(authorization:\s*)\S+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, "$1[redacted]")
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\b(?:sk|pk|rk|re)[_-][a-z0-9_-]{16,}\b/gi, "[redacted]")
    .replace(/\bAIza[a-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted-id]")
    .replace(/\bc[a-z0-9]{20,30}\b/gi, "[redacted-id]");
}

export function sanitizeResponderValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeResponderText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeResponderValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveName(key) || isForbiddenResponderKey(key)
          ? "[redacted]"
          : sanitizeResponderValue(entry)
      ])
    );
  }
  return value;
}

function isForbiddenResponderKey(name: string) {
  const normalized = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
  return (
    [
      "address",
      "affected_search_refs",
      "batch_id",
      "booking_url",
      "course_id",
      "email",
      "evidence_url",
      "incident_id",
      "owner_thread_id",
      "raw_response",
      "recipient",
      "search_id",
      "workflow_id",
      "workflow_run_id"
    ].includes(normalized) ||
    normalized.endsWith("_email") ||
    normalized.endsWith("_recipient") ||
    normalized.endsWith("_address")
  );
}

function isValidFutureAttempt(
  value: Date | string | null | undefined,
  now = new Date()
) {
  if (!value) {
    return false;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() > now.getTime();
}

function isSensitiveName(name: string) {
  const normalized = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
  return (
    [
      "access_token",
      "api_key",
      "auth",
      "authorization",
      "code",
      "cookie",
      "credential",
      "id_token",
      "jwt",
      "key",
      "password",
      "policy",
      "refresh_token",
      "secret",
      "session",
      "sig",
      "signature",
      "signed_stop_link",
      "token",
      "verification_code",
      "x_amz_credential",
      "x_amz_security_token",
      "x_amz_signature",
      "x_goog_credential",
      "x_goog_signature"
    ].includes(normalized) ||
    normalized.endsWith("_token") ||
    normalized.endsWith("_secret") ||
    normalized.endsWith("_signature") ||
    normalized.endsWith("_credential") ||
    normalized.endsWith("_password")
  );
}
