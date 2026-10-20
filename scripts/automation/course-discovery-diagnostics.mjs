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
