/** Structural evidence for a public JSON response. This is a sampled schema,
 * never an availability result or a substitute for independent execution. */
type SchemaField = { path: string; type: string; examples?: Array<string | number | boolean>; arrayLengths?: number[] };
export type PublicResponseSchema = { kind: "SAMPLED_SCHEMA_ONLY"; fields: SchemaField[]; truncated: boolean; nodesVisited: number };
const privateKey = /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|contact|card|customer|user|person|attendee|member|profile|account|notes?|payment|query/iu;
const identityKey = /(?:^id$|ids$|Id$|_id$|uuid|identifier)/u;
const dateKey = /^(?:date|startDate|endDate|startTime|endTime|startsAt|endsAt|startAt|endAt|timestamp|datetime|time_iso|utc_datetime|real_datetime_of_slot)$/iu;
const numberKey = /^(?:duration|durationMinutes|players|capacity|maxPartySize|availableSpots|spots|spotsLeft|year|month|day)$/iu;
const flagKey = /^(?:available|isAvailable|hasNextPage|hasMore|complete|isComplete|success|is_held|is_requestable)$/iu;
const statusKey = /^(?:status|statusCode|httpStatus)$/iu;
const errorKey = /^(?:error|errorMessage)$/iu;
const successValue = /^(?:SUCCESS|success|Success|OK|ok|Ok)$/u;
const dateValue = /^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)$/iu;
function numericExample(key: string, value: number) {
  if (statusKey.test(key) && Number.isSafeInteger(value) && (value === 0 || value === 1 || value >= 100 && value <= 599)) return value;
  if (!Number.isSafeInteger(value) || !numberKey.test(key)) return undefined;
  const normalized = key.toLowerCase();
  const [minimum, maximum] = normalized === "year" ? [1900, 2200] : normalized === "month" ? [1, 12] : normalized === "day" ? [1, 31]
    : normalized.startsWith("duration") ? [15, 480] : normalized === "players" || normalized === "maxpartysize" ? [1, 20] : [0, 1000];
  return value >= minimum && value <= maximum ? value : undefined;
}

export function publicResponseSchema(value: unknown): PublicResponseSchema {
  const fields = new Map<string, SchemaField>();
  let nodesVisited = 0, truncated = false;
  function record(path: string, type: string, example?: string | number | boolean, length?: number) {
    const key = `${path}:${type}`;
    if (!fields.has(key)) {
      if (fields.size >= 120) { truncated = true; return; }
      fields.set(key, { path, type });
    }
    const field = fields.get(key)!;
    if (example !== undefined && !(field.examples ?? []).includes(example)) field.examples = [...(field.examples ?? []), example].slice(0, 3);
    if (length !== undefined && !(field.arrayLengths ?? []).includes(length)) field.arrayLengths = [...(field.arrayLengths ?? []), length].slice(0, 3);
  }
  function visit(item: unknown, path: string, key: string, depth: number) {
    if (nodesVisited >= 2000 || depth > 16 || path.length > 400) { truncated = true; return; }
    nodesVisited++;
    if (privateKey.test(key)) { record(path, "redacted"); return; }
    if (identityKey.test(key)) { record(path, "opaque-identifier"); return; }
    if (item === null) { record(path, "null"); return; }
    if (Array.isArray(item)) {
      record(path, "array", undefined, item.length);
      // Find at most three distinct immediate structures, within a bounded
      // prefix. Actual inventory validation always reads the original body.
      const shapes = new Set<string>();
      for (const child of item.slice(0, 32)) {
        const shape = child && typeof child === "object" && !Array.isArray(child)
          ? Object.keys(child).slice(0, 80).sort().join("|") : Array.isArray(child) ? "array" : child === null ? "null" : typeof child;
        if (shapes.has(shape)) continue;
        if (shapes.size >= 3) { truncated = true; break; }
        shapes.add(shape); visit(child, `${path}[]`, "", depth + 1);
      }
      if (item.length > shapes.size) truncated = true;
      return;
    }
    if (typeof item === "object") {
      record(path, "object");
      const entries = Object.entries(item);
      if (entries.length > 80) truncated = true;
      // Envelope scalars must remain visible when a large inventory exhausts
      // the sample. This changes evidence ordering, never inventory validation.
      const boundedEntries = entries.slice(0, 80).sort((left, right) =>
        Number(left[1] !== null && typeof left[1] === "object") - Number(right[1] !== null && typeof right[1] === "object"));
      for (const [name, child] of boundedEntries) {
        if (!/^(?:[A-Za-z_][A-Za-z0-9_]{0,79}|\d{4}-\d{2}-\d{2})$/u.test(name) || ["__proto__", "prototype", "constructor"].includes(name)) { truncated = true; continue; }
        visit(child, path === "$" ? name : `${path}.${name}`, name, depth + 1);
      }
      return;
    }
    if (typeof item === "string") {
      const example = errorKey.test(key) && item === "" ? item
        : statusKey.test(key) && successValue.test(item) ? item
        : item.length <= 80 && dateKey.test(key) && dateValue.test(item) ? item
        : key === "__typename" && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/u.test(item) ? item : undefined;
      record(path, "string", example); return;
    }
    if (typeof item === "number") { record(path, "number", numericExample(key, item)); return; }
    if (typeof item === "boolean") { record(path, "boolean", flagKey.test(key) ? item : undefined); return; }
    record(path, "unsupported");
  }
  visit(value, "$", "", 0);
  const result: PublicResponseSchema = { kind: "SAMPLED_SCHEMA_ONLY", fields: [], truncated, nodesVisited };
  for (const field of fields.values()) {
    result.fields.push(field);
    if (JSON.stringify(result).length > 12000) { result.fields.pop(); result.truncated = true; break; }
  }
  result.truncated ||= truncated;
  return result;
}
