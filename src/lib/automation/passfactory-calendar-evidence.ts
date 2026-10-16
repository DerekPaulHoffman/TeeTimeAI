import { z } from "zod";

const code = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u);
const label = z.string().trim().min(1).max(160).regex(/^[^<>\r\n\u0000-\u001f]+$/u);
const day = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u);
const amount = z.number().int().min(0).max(10_080);
const nullableAmount = amount.nullable().optional();
const interval = z.object({
  table_id: code, table_title: label, table_type_id: code.optional(), table_type_name: label.optional(),
  start_date: day, end_date: day, start_time: time, end_time: time,
  max_end_date: day.optional(), max_end_time: time.optional(), original_end_time: time.optional(),
  slot_duration: amount, max_duration: nullableAmount, advance: nullableAmount,
  availability_type: z.union([code, amount]).optional(), table_min_book_count: nullableAmount, table_max_book_count: nullableAmount,
});
const rule = z.object({
  code, name: label, settings_for: code, availability_ticket_type: code,
  multi_booking_enabled: z.boolean(), minutes_per_booking: nullableAmount,
  min_people_count: nullableAmount, max_people_count: nullableAmount,
  // Only completeness of these restriction lists, never member/account IDs.
  member_group_ids: z.array(z.unknown()).max(100).nullable().optional(),
  pass_package_plan_ids: z.array(z.unknown()).max(100).nullable().optional(),
  league_plan_ids: z.array(z.unknown()).max(100).nullable().optional(),
  availabilities: z.array(interval).max(400),
});
const facility = z.object({
  code, name: label, time_zone: z.string().max(80).refine(value => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
  }), min_people_count: amount, max_people_count: amount, slot_step: amount, duration_step: amount,
  halls: z.array(z.object({ code, name: label })).min(1).max(40),
});
const hall = z.object({ code, name: label, rule_times: z.array(rule).max(12) })
  .refine(value => value.rule_times.reduce((sum, item) => sum + item.availabilities.length, 0) <= 200);
const restrictions = (value: unknown[] | null | undefined) => value === undefined ? "MISSING" as const
  : value === null ? "NULL" as const : value.length ? "PRESENT" as const : "EMPTY" as const;

/** Closed projection of already-admitted anonymous display responses. Source
 * field names/units are retained as observed, not converted into availability
 * or public-access permission. It never authorizes a request or configuration.
 */
export function projectPassfactoryCalendarEvidence(requestUrl: string, requestBody: string, response: unknown) {
  let url: URL, input: Record<string, unknown>;
  try { url = new URL(requestUrl); input = JSON.parse(requestBody); } catch { return; }
  if (url.origin !== "https://api.passfactory.io" || url.search || url.hash || !input || typeof input !== "object") return;
  const body = z.object({ code: z.literal(200), payload: z.unknown() }).safeParse(response);
  if (!body.success) return;
  if (url.pathname === "/api/v1/availability-widget/facility-widget") {
    const parsed = facility.safeParse(body.data.payload);
    if (!parsed.success || parsed.data.code !== input.facility_code) return;
    return { authority: "EVIDENCE_ONLY" as const, kind: "FACILITY" as const, ...parsed.data };
  }
  if (url.pathname !== "/api/v1/availability-widget/hall-widget") return;
  const parsed = hall.safeParse(body.data.payload);
  if (!parsed.success || parsed.data.code !== input.hall_code) return;
  return { authority: "EVIDENCE_ONLY" as const, kind: "HALL" as const, ...parsed.data,
    rule_times: parsed.data.rule_times.map(({ member_group_ids, pass_package_plan_ids, league_plan_ids, ...item }) => ({
      ...item, restrictionLists: { memberGroups: restrictions(member_group_ids), passPackages: restrictions(pass_package_plan_ids), leagues: restrictions(league_plan_ids) },
    })) };
}

export type PassfactoryCalendarEvidence = NonNullable<ReturnType<typeof projectPassfactoryCalendarEvidence>>;
