const fields = new Set(['id', 'action', 'url', 'selector', 'target', 'option', 'text', 'direction']);
const codes = new Set(['invalid_type', 'invalid_value', 'invalid_format', 'unrecognized_keys', 'too_big', 'too_small', 'invalid_union', 'custom']);

/** Only schema structure is evidence; rejected argument values may be private. */
export function safeBrowserActionIssues(value) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 8).map(issue => ({
    path: (Array.isArray(issue?.path) ? issue.path : typeof issue?.path === 'string' && issue.path ? issue.path.split('.') : []).slice(0, 4)
      .map(part => fields.has(String(part)) ? String(part) : 'field').join('.'),
    code: codes.has(issue?.code) ? issue.code : 'invalid_value',
    ...(Array.isArray(issue?.keys) ? { keys: issue.keys.slice(0, 8).map(key => fields.has(key) ? key : 'field') } : {}),
  }));
}

// Scalar categories from the pinned Codex 0.160 app-server protocol. Provider
// messages/additionalDetails can contain request data and must never escape.
const turnErrorCategories = new Set(['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded',
  'flexUnavailable', 'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'internalServerError',
  'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other']);
const structuredTurnErrors = new Set(['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
  'responseTooManyFailedAttempts', 'activeTurnNotSteerable']);
export function safeDiscoveryTurnFailure(turn) {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn) || typeof turn.status !== 'string' ||
      !['failed', 'interrupted', 'inProgress'].includes(turn.status)) return undefined;
  const result = { turnStatus: turn.status };
  const info = turn.error && typeof turn.error === 'object' && !Array.isArray(turn.error) ? turn.error.codexErrorInfo : undefined;
  if (typeof info === 'string' && turnErrorCategories.has(info)) result.errorCategory = info;
  else if (info && typeof info === 'object' && !Array.isArray(info)) {
    const keys = Object.keys(info);
    if (keys.length === 1 && structuredTurnErrors.has(keys[0])) {
      const category = keys[0], details = info[category];
      if (details && typeof details === 'object' && !Array.isArray(details)) {
        result.errorCategory = category;
        if (category !== 'activeTurnNotSteerable' && Number.isInteger(details.httpStatusCode) &&
            details.httpStatusCode >= 100 && details.httpStatusCode <= 599) result.httpStatusCode = details.httpStatusCode;
      }
    }
  }
  return result;
}
