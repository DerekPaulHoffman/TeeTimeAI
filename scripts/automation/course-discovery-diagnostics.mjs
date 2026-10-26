import { createHash } from 'node:crypto';

const fields = new Set(['id', 'action', 'url', 'selector', 'target', 'option', 'text', 'direction']);
const codes = new Set(['invalid_type', 'invalid_value', 'invalid_format', 'unrecognized_keys', 'too_big', 'too_small', 'invalid_union', 'custom']);

// Only declared public/security parameter names are shown, case-folded. An
// arbitrary parameter name can itself contain a credential, so omit its bytes.
const queryNames = new Set(['version', 'product', 'parentname', 'date', 'players', 'courseid', 'teeofftimemin', 'teeofftimemax',
  'apikey', 'api_key', 'key', 'token', 'access_token', 'session', 'sessionid', 'sid', 'code', 'state', 'email', 'phone', 'nonce', 'signature', 'timestamp']);
const valueClasses = new Set(['EMPTY', 'BOOLEAN', 'INTEGER', 'DECIMAL', 'LOCAL_DATE', 'DOTTED_VERSION', 'URL_LIKE', 'OPAQUE_LIKE', 'TEXT', 'CONTROL', 'VALUE_LIMIT']);
const urlStages = new Set(['BROWSER_REQUEST_URL', 'PINNED_TRANSPORT_URL']);
const methods = new Set(['GET', 'HEAD', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE', 'OTHER']);
const resourceTypes = new Set(['document', 'script', 'stylesheet', 'xhr', 'fetch', 'other', 'image', 'font', 'media', 'manifest', 'eventsource', 'websocket', 'ping']);
function valueClass(value) {
  if (value.length > 512) return 'VALUE_LIMIT';
  if (/[\r\n\u0000-\u001f\u007f]/u.test(value)) return 'CONTROL';
  if (!value) return 'EMPTY';
  if (/^(?:true|false)$/iu.test(value)) return 'BOOLEAN';
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return 'LOCAL_DATE';
  if (/^\d+(?:\.\d+){2,7}$/u.test(value)) return 'DOTTED_VERSION';
  if (/^[+-]?\d+$/u.test(value)) return 'INTEGER';
  if (/^[+-]?\d+\.\d+$/u.test(value)) return 'DECIMAL';
  if (/^(?:https?:\/\/|\/|\.\.?\/)/iu.test(value)) return 'URL_LIKE';
  if (/^(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9_-]{12,}$/iu.test(value) ||
      /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u.test(value) ||
      /^[A-Za-z0-9+/_-]{16,}={1,2}$/u.test(value) ||
      value.length >= 19 && /^[A-Za-z0-9]+$/u.test(value) && /[A-Za-z]/u.test(value) && /\d/u.test(value)) return 'OPAQUE_LIKE';
  return 'TEXT';
}
/** Copy closed diagnostic facts only. They never authorize a URL or request. */
export function safePublicUrlRejectionDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.originalUrlSha256 !== 'string' ||
      typeof value.checkedUrlSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.originalUrlSha256) ||
      !/^[a-f0-9]{64}$/u.test(value.checkedUrlSha256) || !urlStages.has(value.stage) || value.validatorCategory !== 'PUBLIC_RECIPE_OR_STATIC_ASSET') return undefined;
  const evaluated = typeof value.queryFreeRecipeValid === 'boolean' && typeof value.queryFreeAssetValid === 'boolean';
  return { originalUrlSha256: value.originalUrlSha256, checkedUrlSha256: value.checkedUrlSha256,
    method: methods.has(value.method) ? value.method : 'OTHER', resourceType: resourceTypes.has(value.resourceType) ? value.resourceType : 'other',
    stage: value.stage, validatorCategory: 'PUBLIC_RECIPE_OR_STATIC_ASSET',
    queryParseStatus: ['PARSED', 'INVALID', 'LIMIT'].includes(value.queryParseStatus) ? value.queryParseStatus : 'INVALID',
    queryCount: Number.isSafeInteger(value.queryCount) && value.queryCount >= 0 && value.queryCount <= 4096 ? value.queryCount : null,
    queryKeys: (Array.isArray(value.queryKeys) ? value.queryKeys : []).slice(0, 16).map(entry => ({
      key: queryNames.has(entry?.key) ? entry.key : 'OTHER',
      occurrences: Number.isSafeInteger(entry?.occurrences) && entry.occurrences > 0 && entry.occurrences <= 4096 ? entry.occurrences : 1,
      valueClasses: [...new Set((Array.isArray(entry?.valueClasses) ? entry.valueClasses : []).slice(0, 12).filter(item => valueClasses.has(item)))].slice(0, 4),
    })), queryTruncated: value.queryTruncated === true || Array.isArray(value.queryKeys) && (value.queryKeys.length > 16 ||
      value.queryKeys.slice(0, 16).some(entry => Array.isArray(entry?.valueClasses) && entry.valueClasses.length > 4)),
    queryFreeValidation: evaluated ? value.queryFreeRecipeValid || value.queryFreeAssetValid ? 'PASSED' : 'REJECTED' : 'UNAVAILABLE',
    ...(evaluated ? { queryFreeRecipeValid: value.queryFreeRecipeValid, queryFreeAssetValid: value.queryFreeAssetValid } : {}) };
}
/** Bounded original-URL facts; never retains raw URL, key/value or fragment bytes.
 * Validators are trusted local functions, not serialized model configuration. */
export function describePublicUrlRejection(originalUrl, checkedUrl, method, resourceType, stage, validators) {
  const facts = { originalUrlSha256: createHash('sha256').update(originalUrl).digest('hex'),
    checkedUrlSha256: createHash('sha256').update(checkedUrl).digest('hex'), method, resourceType, stage,
    validatorCategory: 'PUBLIC_RECIPE_OR_STATIC_ASSET', queryParseStatus: originalUrl.length > 8192 ? 'LIMIT' : 'INVALID', queryCount: null, queryKeys: [], queryTruncated: originalUrl.length > 8192 };
  if (originalUrl.length <= 8192) try {
    const entries = [...new URL(originalUrl).searchParams], grouped = new Map(); facts.queryParseStatus = 'PARSED'; facts.queryCount = entries.length;
    for (const [rawKey, value] of entries) {
      const folded = rawKey.toLowerCase(), key = queryNames.has(folded) ? folded : 'OTHER';
      const entry = grouped.get(key) ?? { key, occurrences: 0, valueClasses: [] }; entry.occurrences++;
      if (!entry.valueClasses.includes(valueClass(value))) entry.valueClasses.push(valueClass(value)); grouped.set(key, entry);
    }
    facts.queryTruncated = grouped.size > 16 || [...grouped.values()].some(entry => entry.valueClasses.length > 4);
    facts.queryKeys = [...grouped.values()].slice(0, 16);
  } catch { /* Malformed URL bytes remain represented only by their digest. */ }
  if (checkedUrl.length <= 8192) try {
    const url = new URL(checkedUrl); url.search = ''; url.hash = '';
    facts.queryFreeRecipeValid = validators.recipe(url.href);
    facts.queryFreeAssetValid = validators.asset(url.href, resourceType, method);
  } catch { /* No validator result is inferred when parsing/evaluation fails. */ }
  return safePublicUrlRejectionDiagnostic(facts);
}

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
export const discoveryTurnErrorCategories = Object.freeze([...turnErrorCategories, ...structuredTurnErrors]);
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
