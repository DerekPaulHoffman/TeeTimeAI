export const OPERATOR_EMAIL = "derekpaulhoffman@gmail.com";

export function normalizeOperatorEmail(email: string | null | undefined) {
  return email?.trim().toLowerCase() ?? "";
}

export function isOperatorEmail(email: string | null | undefined) {
  return normalizeOperatorEmail(email) === OPERATOR_EMAIL;
}
