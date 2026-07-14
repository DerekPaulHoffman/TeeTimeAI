import { MAX_ADDITIONAL_ALERT_EMAILS } from "@/lib/validation/search";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isAdditionalAlertEmailValid(value: string) {
  const normalized = value.trim();
  return normalized.length === 0 || EMAIL_PATTERN.test(normalized);
}

export function normalizeAdditionalAlertEmails(
  values: readonly string[],
  primaryEmail = ""
) {
  const normalizedPrimary = primaryEmail.trim().toLowerCase();
  return [
    ...new Set(
      values
        .map((email) => email.trim().toLowerCase())
        .filter(
          (email) =>
            email.length > 0 &&
            email !== normalizedPrimary &&
            isAdditionalAlertEmailValid(email)
        )
    )
  ].slice(0, MAX_ADDITIONAL_ALERT_EMAILS);
}
