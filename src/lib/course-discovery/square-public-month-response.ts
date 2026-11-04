/** Validate the original whole public response, never the model's sampled or
 * redacted rows. This proves response completion only; DOM venue/date/resource,
 * selected public rental duration and the requested day fence remain required. */
export function isCompleteSquarePublicMonthResponse(value: unknown, requestBody: string | null | undefined, durationMinutes: number | undefined): boolean {
  const object = (node: unknown): node is Record<string, unknown> => Boolean(node && typeof node === "object" && !Array.isArray(node));
  const exact = (node: Record<string, unknown>, fields: string[]) => Object.keys(node).length === fields.length && fields.every(key => Object.hasOwn(node, key));
  const identifier = (node: unknown): node is string => typeof node === "string" && node.length > 0 && node.length <= 128;
  try {
    if (!durationMinutes || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480 || !requestBody ||
        !object(value) || !exact(value, ["staff_ids", "availability", "resources"]) ||
        !Array.isArray(value.staff_ids) || value.staff_ids.length < 1 || value.staff_ids.length > 16 ||
        !value.staff_ids.every(identifier) || new Set(value.staff_ids).size !== value.staff_ids.length ||
        !object(value.resources) || Object.keys(value.resources).length > 256 ||
        !Array.isArray(value.availability) || value.availability.length > 6000) return false;
    // The caller separately validates this entire public request and source.
    const range = JSON.parse(requestBody).search_availability_request.query.filter.start_at_range;
    const from = Date.parse(range.start_at) / 1000, until = Date.parse(range.end_at) / 1000;
    if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from || until - from > 40 * 86400) return false;
    const seen = new Set<string>();
    for (const row of value.availability) {
      if (!object(row) || !exact(row, ["start", "end", "available", "staff_id", "segments"]) ||
          !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || typeof row.available !== "boolean" ||
          !identifier(row.staff_id) || !value.staff_ids.includes(row.staff_id) ||
          !Array.isArray(row.segments) || row.segments.length !== 1) return false;
      const start = row.start as number, end = row.end as number, segment = row.segments[0];
      if (start < from || start > until || end - start !== durationMinutes * 60 ||
          !object(segment) || !exact(segment, ["start", "end", "resource_token", "employee_token"]) ||
          segment.start !== start || segment.end !== end ||
          ![segment.resource_token, segment.employee_token].every(value => value === null || identifier(value))) return false;
      const key = JSON.stringify([row.staff_id, start, end]);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  } catch { return false; }
}
