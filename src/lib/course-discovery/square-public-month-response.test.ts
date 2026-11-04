import { describe, expect, it } from "vitest";
import { isCompleteSquarePublicMonthResponse } from "./square-public-month-response";
const start = Date.parse("2030-01-11T10:00:00Z") / 1000;
const request = JSON.stringify({ search_availability_request: { query: { filter: { start_at_range: { start_at: "2030-01-06T00:00:00Z", end_at: "2030-02-05T00:00:00Z" } } } } });
const reply = () => ({ staff_ids: ["public-staff"], resources: {}, availability: [{ start, end: start + 3300, available: true, staff_id: "public-staff", segments: [{ start, end: start + 3300, resource_token: null, employee_token: "ephemeral-private-value" }] }] });
describe("original Square public month completion", () => {
  it("accepts complete available, unavailable and empty lists, without projecting private values", () => {
    expect(isCompleteSquarePublicMonthResponse(reply(), request, 55)).toBe(true);
    const unavailable = reply(); unavailable.availability[0].available = false;
    expect(isCompleteSquarePublicMonthResponse(unavailable, request, 55)).toBe(true);
    expect(isCompleteSquarePublicMonthResponse({ ...reply(), availability: [] }, request, 55)).toBe(true);
  });
  it.each(["error", "pagination", "missing", "duplicate", "duration", "outside", "segment", "staff", "private-action", "truncated-tail"])("rejects incomplete or inconsistent %s evidence", kind => {
    const original = reply(); let value: unknown = original;
    if (kind === "error") value = { ...original, errors: [{ code: "FAILED" }] };
    if (kind === "pagination") value = { ...original, has_more: true };
    if (kind === "missing") value = { staff_ids: original.staff_ids, resources: {} };
    if (kind === "duplicate") original.availability.push(structuredClone(original.availability[0]));
    if (kind === "duration") original.availability[0].end++;
    if (kind === "outside") original.availability[0].start = 1;
    if (kind === "segment") original.availability[0].segments[0].end++;
    if (kind === "staff") original.availability[0].staff_id = "unrequested-staff";
    if (kind === "private-action") Object.assign(original.availability[0], { customer: {} });
    if (kind === "truncated-tail") value = { ...original, availability: [...Array.from({ length: 500 }, (_, i) => { const row = structuredClone(original.availability[0]); row.start += i * 3600; row.end += i * 3600; row.segments[0].start = row.start; row.segments[0].end = row.end; return row; }), { start: 1 }] };
    expect(isCompleteSquarePublicMonthResponse(value, request, 55)).toBe(false);
  });
  it("requires the selected duration and bounded valid original range", () => {
    expect(isCompleteSquarePublicMonthResponse(reply(), request, 60)).toBe(false);
    expect(isCompleteSquarePublicMonthResponse(reply(), null, 55)).toBe(false);
    expect(isCompleteSquarePublicMonthResponse(reply(), "{}", 55)).toBe(false);
    expect(isCompleteSquarePublicMonthResponse(reply(), request, undefined)).toBe(false);
  });
});
