export function normalizeOperatorEmail(email: string | null | undefined) {
  return email?.trim().toLowerCase() ?? "";
}

export function getOperatorDashboardEmails(
  configured = process.env.OPERATOR_DASHBOARD_EMAILS
) {
  const entries = (configured ?? "")
    .split(",")
    .map(normalizeOperatorEmail)
    .filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
  ) {
    return new Set<string>();
  }
  return new Set(entries);
}

export function isOperatorEmail(
  email: string | null | undefined,
  configured = process.env.OPERATOR_DASHBOARD_EMAILS
) {
  const normalized = normalizeOperatorEmail(email);
  return Boolean(
    normalized && getOperatorDashboardEmails(configured).has(normalized)
  );
}
